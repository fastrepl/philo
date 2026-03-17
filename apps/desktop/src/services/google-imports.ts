import { join, } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile, } from "@tauri-apps/plugin-fs";
import { generateObject, } from "ai";
import { z, } from "zod";
import { json2md, md2json, parseJsonContent, } from "../lib/markdown";
import { getToday, } from "../types/note";
import { getAiSdkModel, tauriStreamFetch, } from "./ai-sdk";
import { getGoogleAccessToken, } from "./google";
import {
  createDateMention,
  createGmailMention,
  createGoogleCalendarMention,
  getMentionChipAccountEmail,
  getMentionChipRevision,
  getMentionChipSourceId,
  renderMentionMarkdown,
} from "./mentions";
import { getBaseDir, } from "./paths";
import { type ActiveAiConfig, loadSettings, resolveActiveAiConfig, } from "./settings";
import { getOrCreateDailyNote, saveDailyNote, } from "./storage";

const GOOGLE_IMPORT_STATE_FILE = "google-import-state.json";
const GOOGLE_IMPORT_STATE_VERSION = 2;
const GOOGLE_BLOCK_HEADING = "# Google";
const GOOGLE_EMAIL_HEADING = "## Email";
const GOOGLE_CALENDAR_HEADING = "## Calendar";
const GOOGLE_EMAIL_READ_HEADING = "### Read";
const GOOGLE_EMAIL_REPLY_HEADING = "### Reply";
const GOOGLE_CALENDAR_THIS_WEEK_HEADING = "### This Week";
const GOOGLE_CALENDAR_ACTION_HEADING = "### Action Needed";
const GOOGLE_CALENDAR_LOOKAHEAD_DAYS = 7;
const GMAIL_HISTORY_PAGE_SIZE = 500;
const GMAIL_INITIAL_SCAN_MAX_THREADS = 40;
const GMAIL_INITIAL_SCAN_QUERY = "newer_than:30d";
const GMAIL_THREAD_METADATA_HEADERS = ["Subject", "From", "Date", "Message-ID",];
const WIKI_LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
const TASK_LINE_RE = /^[-*] \[( |x|X)\] (.+)$/;
const BULLET_LINE_RE = /^[-*] (.+)$/;

type GoogleImportKind = "gmail" | "google_calendar";
type GoogleImportSection =
  | "email_read"
  | "email_reply"
  | "calendar_this_week"
  | "calendar_action_needed";

interface GoogleImportState {
  version: number;
  gmailHistoryIds: Record<string, string>;
  lastRenderedByDate: Record<string, GoogleRenderedItemSnapshot[]>;
  records: Record<string, GoogleImportRecord>;
}

interface GoogleImportRecord {
  active: boolean;
  accountEmail: string;
  classification: null | {
    section: GoogleImportSection;
    revision: string;
    text: string;
    visible: boolean;
  };
  completedRevision: string | null;
  current: {
    calendarUid: string | null;
    dueDate: string | null;
    fallbackSection: GoogleImportSection;
    fallbackText: string;
    href: string;
    messageId: string | null;
    renderAsTask: boolean;
    revision: string;
    sortKey: string;
    sourceChipLabel: string;
    timeText: string | null;
  };
  dismissedRevision: string | null;
  kind: GoogleImportKind;
  sourceId: string;
}

interface GoogleRenderedItemSnapshot {
  key: string;
  renderAsTask: boolean;
  revision: string;
  section: GoogleImportSection;
}

interface ParsedGoogleLine extends GoogleRenderedItemSnapshot {
  checked: boolean;
}

interface GmailProfileResponse {
  historyId?: string;
}

interface GmailHistoryResponse {
  history?: GmailHistoryItem[];
  nextPageToken?: string;
}

interface GmailThreadListResponse {
  nextPageToken?: string;
  threads?: GmailMessageRef[];
}

interface GmailHistoryItem {
  labelsAdded?: Array<{ message?: GmailMessageRef | null; }>;
  labelsRemoved?: Array<{ message?: GmailMessageRef | null; }>;
  messages?: GmailMessageRef[];
  messagesAdded?: Array<{ message?: GmailMessageRef | null; }>;
}

interface GmailMessageRef {
  id?: string;
  threadId?: string;
}

interface GmailThreadResponse {
  historyId?: string;
  id?: string;
  messages?: GmailThreadMessage[];
  snippet?: string;
}

interface GmailThreadMessage {
  id?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{
      name?: string;
      value?: string;
    }>;
  };
  threadId?: string;
}

interface CalendarEventsResponse {
  items?: GoogleCalendarEvent[];
}

interface GoogleCalendarEvent {
  etag?: string;
  eventType?: string;
  htmlLink?: string;
  id?: string;
  iCalUID?: string;
  location?: string;
  organizer?: {
    email?: string;
    displayName?: string;
  };
  start?: {
    date?: string;
    dateTime?: string;
  };
  status?: string;
  summary?: string;
  updated?: string;
}

interface GmailCandidate {
  accountEmail: string;
  fallbackSection: GoogleImportSection;
  fallbackText: string;
  from: string;
  href: string;
  kind: "gmail";
  latestSenderIsUser: boolean;
  messageId: string | null;
  revision: string;
  snippet: string;
  sortKey: string;
  sourceId: string;
  sourceChipLabel: string;
  subject: string;
  unread: boolean;
}

interface CalendarCandidate {
  accountEmail: string;
  calendarUid: string | null;
  dueDate: string;
  fallbackText: string;
  href: string;
  kind: "google_calendar";
  revision: string;
  sortKey: string;
  sourceChipLabel: string;
  sourceId: string;
  summary: string;
  timeText: string | null;
}

const EmailClassificationSchema = z.object({
  items: z.array(z.object({
    section: z.enum(["ignore", "read", "reply",],),
    sourceId: z.string(),
    text: z.string(),
  },),),
},);

const CalendarActionSchema = z.object({
  items: z.array(z.object({
    actionable: z.boolean(),
    sourceId: z.string(),
    text: z.string(),
  },),),
},);

const DEFAULT_GOOGLE_IMPORT_STATE: GoogleImportState = {
  version: GOOGLE_IMPORT_STATE_VERSION,
  gmailHistoryIds: {},
  lastRenderedByDate: {},
  records: {},
};

function normalizeEmail(value: string,) {
  return value.trim().toLowerCase();
}

function buildRecordKey(kind: GoogleImportKind, accountEmail: string, sourceId: string,) {
  return `${kind}:${normalizeEmail(accountEmail,)}:${sourceId.trim()}`;
}

function toLocalIsoDate(value: Date,) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1,).padStart(2, "0",)}-${
    String(value.getDate(),).padStart(2, "0",)
  }`;
}

function addDays(date: Date, days: number,) {
  const next = new Date(date,);
  next.setDate(next.getDate() + days,);
  return next;
}

function normalizeGoogleImportState(value: unknown,): GoogleImportState {
  if (!value || typeof value !== "object") return { ...DEFAULT_GOOGLE_IMPORT_STATE, };

  const candidate = value as Partial<GoogleImportState>;
  if (candidate.version !== GOOGLE_IMPORT_STATE_VERSION) {
    return { ...DEFAULT_GOOGLE_IMPORT_STATE, };
  }

  return {
    version: GOOGLE_IMPORT_STATE_VERSION,
    gmailHistoryIds: candidate.gmailHistoryIds && typeof candidate.gmailHistoryIds === "object"
      ? Object.fromEntries(
        Object.entries(candidate.gmailHistoryIds,)
          .filter(([, historyId,],) => typeof historyId === "string" && historyId.trim()),
      )
      : {},
    lastRenderedByDate: candidate.lastRenderedByDate && typeof candidate.lastRenderedByDate === "object"
      ? Object.fromEntries(
        Object.entries(candidate.lastRenderedByDate,)
          .map(([date, items,],) => [
            date,
            Array.isArray(items,)
              ? items.filter((item,): item is GoogleRenderedItemSnapshot => {
                if (!item || typeof item !== "object") return false;
                const entry = item as Partial<GoogleRenderedItemSnapshot>;
                return (
                  typeof entry.key === "string"
                  && typeof entry.renderAsTask === "boolean"
                  && typeof entry.revision === "string"
                  && (
                    entry.section === "email_read"
                    || entry.section === "email_reply"
                    || entry.section === "calendar_this_week"
                    || entry.section === "calendar_action_needed"
                  )
                );
              },)
              : [],
          ]),
      )
      : {},
    records: candidate.records && typeof candidate.records === "object"
      ? Object.fromEntries(
        Object.entries(candidate.records,)
          .filter(([, record,],) => record && typeof record === "object")
          .map(([key, record,],) => {
            const entry = record as Partial<GoogleImportRecord>;
            const current = entry.current;

            if (
              !current
              || (entry.kind !== "gmail" && entry.kind !== "google_calendar")
              || typeof entry.accountEmail !== "string"
              || typeof entry.sourceId !== "string"
              || typeof current.fallbackText !== "string"
              || typeof current.href !== "string"
              || typeof current.renderAsTask !== "boolean"
              || typeof current.revision !== "string"
              || typeof current.sortKey !== "string"
              || typeof current.sourceChipLabel !== "string"
            ) {
              return null;
            }

            return [
              key,
              {
                active: entry.active === true,
                accountEmail: entry.accountEmail,
                classification: entry.classification
                    && typeof entry.classification === "object"
                    && typeof entry.classification.section === "string"
                    && typeof entry.classification.revision === "string"
                    && typeof entry.classification.text === "string"
                    && typeof entry.classification.visible === "boolean"
                  ? {
                    section: entry.classification.section as GoogleImportSection,
                    revision: entry.classification.revision,
                    text: entry.classification.text,
                    visible: entry.classification.visible,
                  }
                  : null,
                completedRevision: typeof entry.completedRevision === "string" ? entry.completedRevision : null,
                current: {
                  calendarUid: typeof current.calendarUid === "string" ? current.calendarUid : null,
                  dueDate: typeof current.dueDate === "string" ? current.dueDate : null,
                  fallbackSection: (
                      current.fallbackSection === "email_read"
                      || current.fallbackSection === "email_reply"
                      || current.fallbackSection === "calendar_this_week"
                      || current.fallbackSection === "calendar_action_needed"
                    )
                    ? current.fallbackSection
                    : "email_reply",
                  fallbackText: current.fallbackText,
                  href: current.href,
                  messageId: typeof current.messageId === "string" ? current.messageId : null,
                  renderAsTask: current.renderAsTask,
                  revision: current.revision,
                  sortKey: current.sortKey,
                  sourceChipLabel: current.sourceChipLabel,
                  timeText: typeof current.timeText === "string" ? current.timeText : null,
                },
                dismissedRevision: typeof entry.dismissedRevision === "string" ? entry.dismissedRevision : null,
                kind: entry.kind,
                sourceId: entry.sourceId,
              } satisfies GoogleImportRecord,
            ] as const;
          },)
          .filter((entry,): entry is readonly [string, GoogleImportRecord,] => entry !== null),
      )
      : {},
  };
}

async function getStatePath() {
  const baseDir = await getBaseDir();
  if (!(await exists(baseDir,))) {
    await mkdir(baseDir, { recursive: true, },);
  }
  return await join(baseDir, GOOGLE_IMPORT_STATE_FILE,);
}

async function loadGoogleImportState() {
  const path = await getStatePath();
  if (!(await exists(path,))) {
    return { ...DEFAULT_GOOGLE_IMPORT_STATE, };
  }

  try {
    return normalizeGoogleImportState(JSON.parse(await readTextFile(path,),),);
  } catch {
    return { ...DEFAULT_GOOGLE_IMPORT_STATE, };
  }
}

async function saveGoogleImportState(state: GoogleImportState,) {
  const path = await getStatePath();
  await writeTextFile(path, JSON.stringify(state, null, 2,),);
}

async function fetchGoogleJson<T,>(accessToken: string, url: URL | string,) {
  const response = await tauriStreamFetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  },);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Google request failed with status ${response.status}.`,);
  }

  return await response.json() as T;
}

function isHistoryResetError(error: unknown,) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("404",) || error.message.includes("startHistoryId",);
}

function getHeaderValue(
  headers: Array<{ name?: string; value?: string; }> | undefined,
  name: string,
) {
  const target = name.trim().toLowerCase();
  return headers?.find((header,) => header.name?.trim().toLowerCase() === target)?.value?.trim() ?? "";
}

function buildGmailThreadHref(accountEmail: string, threadId: string,) {
  const url = new URL("https://mail.google.com/mail/",);
  url.searchParams.set("authuser", accountEmail.trim(),);
  url.hash = `#inbox/${threadId}`;
  return url.toString();
}

function cleanTaskText(value: string,) {
  return value.replace(/\s+/g, " ",).trim().replace(/[.?!]+$/g, "",);
}

function extractEmailAddress(value: string,) {
  const bracketMatch = value.match(/<([^>]+)>/,);
  if (bracketMatch?.[1]) {
    return normalizeEmail(bracketMatch[1],);
  }

  const inlineMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,);
  return inlineMatch?.[0] ? normalizeEmail(inlineMatch[0],) : "";
}

function isFromCurrentAccount(from: string, accountEmail: string,) {
  return extractEmailAddress(from,) === normalizeEmail(accountEmail,);
}

function buildEmailReadFallbackText(subject: string, from: string, snippet: string,) {
  const base = cleanTaskText(subject || snippet || from || "New email",);
  if (!base) return "Check email";
  return `Read email: ${base}`;
}

function buildEmailReplyFallbackText(subject: string, from: string, snippet: string,) {
  const base = cleanTaskText(subject || from || snippet || "email",);
  if (!base) return "Reply to email";
  return `Reply: ${base}`;
}

function buildCalendarActionFallbackText(summary: string, timeText: string | null,) {
  const base = cleanTaskText(summary || "event",);
  return timeText ? `Attend ${base} at ${timeText}` : `Attend ${base}`;
}

function buildCalendarOverviewText(summary: string, dueDate: string, timeText: string | null,) {
  const date = new Date(`${dueDate}T00:00:00`,);
  const dayLabel = Number.isNaN(date.getTime(),)
    ? dueDate
    : date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    },);
  const when = timeText ? `${dayLabel} · ${timeText}` : `${dayLabel} · All day`;
  const base = cleanTaskText(summary || "Event",);
  return `${when} ${base}`.trim();
}

function formatCalendarTime(value: GoogleCalendarEvent["start"],) {
  if (value?.date) return null;
  if (!value?.dateTime) return null;
  const date = new Date(value.dateTime,);
  if (Number.isNaN(date.getTime(),)) return null;
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  },);
}

function getCalendarDueDate(value: GoogleCalendarEvent["start"],) {
  if (value?.date) return value.date;
  if (!value?.dateTime) return null;
  const date = new Date(value.dateTime,);
  if (Number.isNaN(date.getTime(),)) return null;
  return toLocalIsoDate(date,);
}

function truncateForPrompt(value: string, maxLength = 320,) {
  const normalized = value.replace(/\s+/g, " ",).trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3,).trim()}...`;
}

async function classifyEmails(
  candidates: GmailCandidate[],
  config: ActiveAiConfig,
): Promise<Map<string, { section: GoogleImportSection; text: string; visible: boolean; }>> {
  if (candidates.length === 0) {
    return new Map<string, { section: GoogleImportSection; text: string; visible: boolean; }>();
  }

  try {
    const result = await generateObject({
      model: getAiSdkModel(config, "assistant",),
      schema: EmailClassificationSchema,
      system:
        "You triage inbox threads. Put each thread into one bucket: read, reply, or ignore. Use read for unread email worth opening. Use reply when a response is likely owed. Ignore newsletters, receipts, routine notifications, and FYI threads that do not need attention.",
      prompt: JSON.stringify(
        {
          items: candidates.map((candidate,) => ({
            accountEmail: candidate.accountEmail,
            from: candidate.from,
            latestSenderIsUser: candidate.latestSenderIsUser,
            messageId: candidate.messageId,
            snippet: candidate.snippet,
            sourceId: candidate.sourceId,
            subject: candidate.subject,
            unread: candidate.unread,
          })),
          instructions: {
            readStyle: "If section=read, text should be an imperative read/open task under 80 characters.",
            replyStyle: "If section=reply, text should be an imperative reply/follow-up task under 80 characters.",
            ignoreStyle: "If section=ignore, return an empty text string.",
          },
        },
        null,
        2,
      ),
    },);

    return new Map<string, { section: GoogleImportSection; text: string; visible: boolean; }>(
      result.object.items.map((item,) => [
        item.sourceId,
        item.section === "ignore"
          ? {
            section: "email_read" as const,
            text: "",
            visible: false,
          }
          : {
            section: item.section === "reply" ? "email_reply" : "email_read" as const,
            text: cleanTaskText(item.text,),
            visible: true,
          },
      ]),
    );
  } catch {
    return new Map<string, { section: GoogleImportSection; text: string; visible: boolean; }>();
  }
}

async function classifyCalendarActionItems(
  candidates: CalendarCandidate[],
  config: ActiveAiConfig,
): Promise<Map<string, { text: string; visible: boolean; }>> {
  if (candidates.length === 0) return new Map<string, { text: string; visible: boolean; }>();

  try {
    const result = await generateObject({
      model: getAiSdkModel(config, "assistant",),
      schema: CalendarActionSchema,
      system:
        "You identify calendar events that need action. Keep meetings, appointments, and events that require attendance or preparation. Hide routine/personal/default events like gym, commute blockers, or passive reminders.",
      prompt: JSON.stringify(
        {
          items: candidates.map((candidate,) => ({
            accountEmail: candidate.accountEmail,
            sourceId: candidate.sourceId,
            suggestedFallback: candidate.fallbackText,
            summary: candidate.summary,
            timeText: candidate.timeText,
          })),
          instructions: {
            actionableTaskStyle: "If actionable=true, return imperative task text under 80 characters.",
            whenNotActionable: "If actionable=false, return an empty text string.",
          },
        },
        null,
        2,
      ),
    },);

    return new Map(
      result.object.items.map((item,) => [
        item.sourceId,
        {
          text: cleanTaskText(item.text,),
          visible: item.actionable,
        },
      ]),
    );
  } catch {
    return new Map<string, { text: string; visible: boolean; }>();
  }
}

async function fetchGmailProfile(accessToken: string,) {
  return await fetchGoogleJson<GmailProfileResponse>(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  );
}

async function fetchGmailHistory(accessToken: string, startHistoryId: string,) {
  const history: GmailHistoryItem[] = [];
  let nextPageToken = "";

  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history",);
    url.searchParams.set("historyTypes", "labelAdded",);
    url.searchParams.append("historyTypes", "labelRemoved",);
    url.searchParams.append("historyTypes", "messageAdded",);
    url.searchParams.set("maxResults", String(GMAIL_HISTORY_PAGE_SIZE,),);
    url.searchParams.set("startHistoryId", startHistoryId,);
    if (nextPageToken) {
      url.searchParams.set("pageToken", nextPageToken,);
    }

    const response = await fetchGoogleJson<GmailHistoryResponse>(accessToken, url,);
    history.push(...(response.history ?? []),);
    nextPageToken = response.nextPageToken ?? "";
  } while (nextPageToken);

  return history;
}

async function fetchInitialGmailThreadIds(accessToken: string,) {
  const threadIds = new Set<string>();
  let nextPageToken = "";

  while (threadIds.size < GMAIL_INITIAL_SCAN_MAX_THREADS) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads",);
    url.searchParams.set("labelIds", "INBOX",);
    url.searchParams.set("maxResults", String(Math.min(100, GMAIL_INITIAL_SCAN_MAX_THREADS - threadIds.size,),),);
    url.searchParams.set("q", GMAIL_INITIAL_SCAN_QUERY,);
    if (nextPageToken) {
      url.searchParams.set("pageToken", nextPageToken,);
    }

    const response = await fetchGoogleJson<GmailThreadListResponse>(accessToken, url,);
    (response.threads ?? []).forEach((thread,) => {
      if (thread.id?.trim()) {
        threadIds.add(thread.id.trim(),);
      }
    },);

    if (!response.nextPageToken) {
      break;
    }
    nextPageToken = response.nextPageToken;
  }

  return [...threadIds,];
}

async function fetchGmailThread(accessToken: string, threadId: string,) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`,);
  url.searchParams.set("format", "metadata",);
  GMAIL_THREAD_METADATA_HEADERS.forEach((header,) => url.searchParams.append("metadataHeaders", header,));
  return await fetchGoogleJson<GmailThreadResponse>(accessToken, url,);
}

function getThreadIdsFromHistory(items: GmailHistoryItem[],) {
  const threadIds = new Set<string>();

  const addMessage = (message?: GmailMessageRef | null,) => {
    if (message?.threadId) {
      threadIds.add(message.threadId,);
    }
  };

  items.forEach((item,) => {
    item.messages?.forEach(addMessage,);
    item.messagesAdded?.forEach((entry,) => addMessage(entry.message,));
    item.labelsAdded?.forEach((entry,) => addMessage(entry.message,));
    item.labelsRemoved?.forEach((entry,) => addMessage(entry.message,));
  },);

  return [...threadIds,];
}

async function syncGmailAccount(
  accountEmail: string,
  state: GoogleImportState,
  aiConfig: ActiveAiConfig | null,
) {
  const normalizedEmail = normalizeEmail(accountEmail,);
  const accessToken = await getGoogleAccessToken(accountEmail,);
  const profile = await fetchGmailProfile(accessToken,);
  const latestHistoryId = profile.historyId?.trim();
  if (!latestHistoryId) {
    return;
  }

  const baselineHistoryId = state.gmailHistoryIds[normalizedEmail];
  let threadIds: string[] = [];
  let fullInboxScan = false;

  if (!baselineHistoryId) {
    fullInboxScan = true;
    threadIds = await fetchInitialGmailThreadIds(accessToken,);
    state.gmailHistoryIds[normalizedEmail] = latestHistoryId;
  } else {
    let history: GmailHistoryItem[] = [];
    try {
      history = await fetchGmailHistory(accessToken, baselineHistoryId,);
    } catch (error) {
      if (isHistoryResetError(error,)) {
        fullInboxScan = true;
        threadIds = await fetchInitialGmailThreadIds(accessToken,);
        state.gmailHistoryIds[normalizedEmail] = latestHistoryId;
      } else {
        throw error;
      }
    }

    if (!fullInboxScan) {
      state.gmailHistoryIds[normalizedEmail] = latestHistoryId;
      threadIds = getThreadIdsFromHistory(history,);
    }
  }

  if (threadIds.length === 0) {
    return;
  }

  if (fullInboxScan) {
    Object.entries(state.records,).forEach(([key, record,],) => {
      if (record.kind === "gmail" && normalizeEmail(record.accountEmail,) === normalizedEmail) {
        state.records[key] = { ...record, active: false, };
      }
    },);
  }

  const emailCandidates: GmailCandidate[] = [];
  const seenKeys = new Set<string>();

  await Promise.all(
    threadIds.map(async (threadId,) => {
      const thread = await fetchGmailThread(accessToken, threadId,);
      const sourceId = thread.id?.trim() || threadId;
      const key = buildRecordKey("gmail", accountEmail, sourceId,);
      seenKeys.add(key,);
      const sortedMessages = [...(thread.messages ?? []),].sort((left, right,) =>
        Number(left.internalDate ?? 0,) - Number(right.internalDate ?? 0,)
      );
      const latestMessage = sortedMessages[sortedMessages.length - 1];

      const isInbox = latestMessage?.labelIds?.includes("INBOX",) ?? false;
      const unread = latestMessage?.labelIds?.includes("UNREAD",) ?? false;
      const revision = thread.historyId?.trim() || latestHistoryId;
      const subject = getHeaderValue(latestMessage?.payload?.headers, "Subject",);
      const from = getHeaderValue(latestMessage?.payload?.headers, "From",);
      const messageId = getHeaderValue(latestMessage?.payload?.headers, "Message-ID",) || null;
      const latestSenderIsUser = isFromCurrentAccount(from, accountEmail,);
      const snippet = thread.snippet?.trim() ?? "";
      const fallbackSection = unread && !latestSenderIsUser
        ? "email_read"
        : !latestSenderIsUser
        ? "email_reply"
        : null;
      const fallbackText = fallbackSection === "email_reply"
        ? buildEmailReplyFallbackText(subject, from, snippet,)
        : buildEmailReadFallbackText(subject, from, snippet,);

      const nextRecord: GoogleImportRecord = {
        active: isInbox && (aiConfig !== null || fallbackSection !== null),
        accountEmail,
        classification: state.records[key]?.classification?.revision === revision
          ? state.records[key]?.classification ?? null
          : null,
        completedRevision: state.records[key]?.completedRevision ?? null,
        current: {
          calendarUid: null,
          dueDate: null,
          fallbackSection: fallbackSection ?? "email_read",
          fallbackText,
          href: buildGmailThreadHref(accountEmail, sourceId,),
          messageId,
          renderAsTask: true,
          revision,
          sortKey: latestMessage?.internalDate?.trim() || new Date().toISOString(),
          sourceChipLabel: "Gmail",
          timeText: null,
        },
        dismissedRevision: state.records[key]?.dismissedRevision ?? null,
        kind: "gmail",
        sourceId,
      };

      state.records[key] = nextRecord;

      if (!isInbox) {
        return;
      }

      if (aiConfig) {
        emailCandidates.push({
          accountEmail,
          fallbackSection: fallbackSection ?? "email_read",
          fallbackText,
          from,
          href: nextRecord.current.href,
          kind: "gmail",
          latestSenderIsUser,
          messageId,
          revision,
          snippet: truncateForPrompt(snippet,),
          sortKey: nextRecord.current.sortKey,
          sourceChipLabel: nextRecord.current.sourceChipLabel,
          sourceId,
          subject: truncateForPrompt(subject,),
          unread,
        },);
      }
    },),
  );

  if (fullInboxScan) {
    Object.entries(state.records,).forEach(([key, record,],) => {
      if (
        record.kind === "gmail"
        && normalizeEmail(record.accountEmail,) === normalizedEmail
        && !seenKeys.has(key,)
      ) {
        state.records[key] = { ...record, active: false, };
      }
    },);
  }

  if (!aiConfig) {
    return;
  }

  const toClassify = emailCandidates.filter((candidate,) => {
    const key = buildRecordKey("gmail", candidate.accountEmail, candidate.sourceId,);
    return state.records[key]?.classification?.revision !== candidate.revision;
  },);
  const classified = await classifyEmails(toClassify, aiConfig,);
  toClassify.forEach((candidate,) => {
    const key = buildRecordKey("gmail", candidate.accountEmail, candidate.sourceId,);
    const decision = classified.get(candidate.sourceId,);
    state.records[key] = {
      ...state.records[key]!,
      classification: decision
        ? {
          section: decision.section,
          revision: candidate.revision,
          text: decision.text,
          visible: decision.visible,
        }
        : null,
    };
  },);
}

async function fetchCalendarEvents(accessToken: string,) {
  const now = new Date();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events",);
  url.searchParams.set("eventTypes", "default",);
  url.searchParams.set("orderBy", "startTime",);
  url.searchParams.set("showDeleted", "true",);
  url.searchParams.set("singleEvents", "true",);
  url.searchParams.set("timeMax", addDays(now, GOOGLE_CALENDAR_LOOKAHEAD_DAYS,).toISOString(),);
  url.searchParams.set("timeMin", now.toISOString(),);
  return await fetchGoogleJson<CalendarEventsResponse>(accessToken, url,);
}

async function syncCalendarAccount(
  accountEmail: string,
  state: GoogleImportState,
  aiConfig: ActiveAiConfig | null,
) {
  const accessToken = await getGoogleAccessToken(accountEmail,);
  const response = await fetchCalendarEvents(accessToken,);
  const calendarCandidates: CalendarCandidate[] = [];
  const seenKeys = new Set<string>();

  Object.entries(state.records,).forEach(([key, record,],) => {
    if (record.kind === "google_calendar" && normalizeEmail(record.accountEmail,) === normalizeEmail(accountEmail,)) {
      state.records[key] = { ...record, active: false, };
    }
  },);

  (response.items ?? []).forEach((event,) => {
    const eventId = event.id?.trim();
    const href = event.htmlLink?.trim();
    if (!eventId || !href) return;

    const overviewSourceId = `${eventId}:overview`;
    const actionSourceId = `${eventId}:action`;
    const overviewKey = buildRecordKey("google_calendar", accountEmail, overviewSourceId,);
    const actionKey = buildRecordKey("google_calendar", accountEmail, actionSourceId,);
    seenKeys.add(overviewKey,);
    if (aiConfig) {
      seenKeys.add(actionKey,);
    }

    if (event.status === "cancelled") {
      const existingOverview = state.records[overviewKey];
      const existingAction = state.records[actionKey];
      if (existingOverview) {
        state.records[overviewKey] = { ...existingOverview, active: false, };
      }
      if (existingAction) {
        state.records[actionKey] = { ...existingAction, active: false, };
      }
      return;
    }

    const dueDate = getCalendarDueDate(event.start,);
    if (!dueDate) return;

    const calendarUid = event.iCalUID?.trim() || null;
    const timeText = formatCalendarTime(event.start,);
    const summary = truncateForPrompt(
      `${event.summary ?? ""} ${event.location ?? ""} ${event.organizer?.displayName ?? event.organizer?.email ?? ""}`,
    );
    const revision = event.updated?.trim() || event.etag?.trim() || `${eventId}:${dueDate}`;
    const overviewRecord: GoogleImportRecord = {
      active: true,
      accountEmail,
      classification: null,
      completedRevision: state.records[overviewKey]?.completedRevision ?? null,
      current: {
        calendarUid,
        dueDate,
        fallbackSection: "calendar_this_week",
        fallbackText: buildCalendarOverviewText(event.summary?.trim() ?? "", dueDate, timeText,),
        href,
        messageId: null,
        renderAsTask: false,
        revision,
        sortKey: `${dueDate}:${timeText ?? "all-day"}:${eventId}:overview`,
        sourceChipLabel: "Google Calendar",
        timeText,
      },
      dismissedRevision: state.records[overviewKey]?.dismissedRevision ?? null,
      kind: "google_calendar",
      sourceId: overviewSourceId,
    };

    state.records[overviewKey] = overviewRecord;

    if (!aiConfig) {
      return;
    }

    const actionRecord: GoogleImportRecord = {
      active: true,
      accountEmail,
      classification: state.records[actionKey]?.classification?.revision === revision
        ? state.records[actionKey]?.classification ?? null
        : null,
      completedRevision: state.records[actionKey]?.completedRevision ?? null,
      current: {
        calendarUid,
        dueDate,
        fallbackSection: "calendar_action_needed",
        fallbackText: buildCalendarActionFallbackText(event.summary?.trim() ?? "", timeText,),
        href,
        messageId: null,
        renderAsTask: true,
        revision,
        sortKey: `${dueDate}:${timeText ?? "all-day"}:${eventId}:action`,
        sourceChipLabel: "Google Calendar",
        timeText,
      },
      dismissedRevision: state.records[actionKey]?.dismissedRevision ?? null,
      kind: "google_calendar",
      sourceId: actionSourceId,
    };

    state.records[actionKey] = actionRecord;
    calendarCandidates.push({
      accountEmail,
      calendarUid,
      dueDate,
      fallbackText: actionRecord.current.fallbackText,
      href,
      kind: "google_calendar",
      revision,
      sortKey: actionRecord.current.sortKey,
      sourceChipLabel: actionRecord.current.sourceChipLabel,
      sourceId: actionSourceId,
      summary,
      timeText,
    },);
  },);

  Object.entries(state.records,).forEach(([key, record,],) => {
    if (
      record.kind === "google_calendar"
      && normalizeEmail(record.accountEmail,) === normalizeEmail(accountEmail,)
      && !seenKeys.has(key,)
    ) {
      state.records[key] = { ...record, active: false, };
    }
  },);

  if (!aiConfig) {
    return;
  }

  const toClassify = calendarCandidates.filter((candidate,) => {
    const key = buildRecordKey("google_calendar", candidate.accountEmail, candidate.sourceId,);
    return state.records[key]?.classification?.revision !== candidate.revision;
  },);
  const classified = await classifyCalendarActionItems(toClassify, aiConfig,);
  toClassify.forEach((candidate,) => {
    const key = buildRecordKey("google_calendar", candidate.accountEmail, candidate.sourceId,);
    const decision = classified.get(candidate.sourceId,);
    state.records[key] = {
      ...state.records[key]!,
      classification: decision
        ? {
          section: "calendar_action_needed",
          revision: candidate.revision,
          text: decision.text,
          visible: decision.visible,
        }
        : null,
    };
  },);
}

function extractGoogleBlock(markdown: string,) {
  const lines = markdown.split("\n",);
  const start = lines.findIndex((line,) => line.trim() === GOOGLE_BLOCK_HEADING);
  if (start === -1) {
    return {
      after: markdown.trim(),
      block: "",
      before: "",
    };
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#\s+/.test(lines[index],)) {
      end = index;
      break;
    }
  }

  return {
    after: lines.slice(end,).join("\n",).trim(),
    block: lines.slice(start, end,).join("\n",).trim(),
    before: lines.slice(0, start,).join("\n",).trim(),
  };
}

function extractTaskTarget(line: string,) {
  for (const match of line.matchAll(WIKI_LINK_RE,)) {
    const target = match[1]?.trim();
    if (!target || (!target.startsWith("gmail_",) && !target.startsWith("google_calendar_",))) {
      continue;
    }

    const kind: GoogleImportKind = target.startsWith("gmail_",) ? "gmail" : "google_calendar";
    const sourceId = getMentionChipSourceId({ id: target, kind, },);
    const accountEmail = getMentionChipAccountEmail({ id: target, kind, },);
    const revision = getMentionChipRevision({ id: target, kind, },);
    if (!sourceId || !accountEmail || !revision) {
      continue;
    }

    return {
      key: buildRecordKey(kind, accountEmail, sourceId,),
      revision,
    };
  }

  return null;
}

function parseGoogleBlockItems(markdown: string,) {
  const { block, } = extractGoogleBlock(markdown,);
  if (!block) return [];

  let section: GoogleImportSection | null = null;
  return block
    .split("\n",)
    .flatMap((line,) => {
      const trimmed = line.trim();
      if (trimmed === GOOGLE_EMAIL_HEADING) {
        section = null;
        return [];
      }
      if (trimmed === GOOGLE_CALENDAR_HEADING) {
        section = null;
        return [];
      }
      if (trimmed === GOOGLE_EMAIL_READ_HEADING) {
        section = "email_read";
        return [];
      }
      if (trimmed === GOOGLE_EMAIL_REPLY_HEADING) {
        section = "email_reply";
        return [];
      }
      if (trimmed === GOOGLE_CALENDAR_THIS_WEEK_HEADING) {
        section = "calendar_this_week";
        return [];
      }
      if (trimmed === GOOGLE_CALENDAR_ACTION_HEADING) {
        section = "calendar_action_needed";
        return [];
      }

      const taskMatch = TASK_LINE_RE.exec(trimmed,);
      const bulletMatch = taskMatch ? null : BULLET_LINE_RE.exec(trimmed,);
      if ((!taskMatch && !bulletMatch) || !section) return [];
      const target = extractTaskTarget(trimmed,);
      if (!target) return [];

      return [
        {
          checked: taskMatch ? taskMatch[1].toLowerCase() === "x" : false,
          key: target.key,
          renderAsTask: Boolean(taskMatch,),
          revision: target.revision,
          section,
        } satisfies ParsedGoogleLine,
      ];
    },);
}

function reconcileLocalActions(state: GoogleImportState, date: string, markdown: string,) {
  const currentItems = parseGoogleBlockItems(markdown,);
  const currentKeys = new Set(currentItems.map((item,) => `${item.key}:${item.revision}`),);
  const previousItems = state.lastRenderedByDate[date] ?? [];

  currentItems.forEach((item,) => {
    if (!item.checked) return;
    const record = state.records[item.key];
    if (!record) return;
    state.records[item.key] = {
      ...record,
      completedRevision: item.revision,
    };
  },);

  previousItems.forEach((item,) => {
    const record = state.records[item.key];
    if (!record) return;

    const compositeKey = `${item.key}:${item.revision}`;
    if (currentKeys.has(compositeKey,)) return;
    if (record.completedRevision === item.revision) return;

    state.records[item.key] = {
      ...record,
      dismissedRevision: item.revision,
    };
  },);
}

function getRenderableRecords(state: GoogleImportState,) {
  return Object.entries(state.records,)
    .flatMap(([key, record,],) => {
      if (!record.active) return [];

      const currentRevision = record.current.revision;
      if (record.completedRevision === currentRevision || record.dismissedRevision === currentRevision) {
        return [];
      }

      if (record.classification && record.classification.revision === currentRevision) {
        if (!record.classification.visible) {
          return [];
        }

        return [{
          key,
          record,
          renderAsTask: record.current.renderAsTask,
          section: record.classification.section,
          text: cleanTaskText(record.classification.text,) || cleanTaskText(record.current.fallbackText,)
            || "Open item",
        },];
      }

      return [{
        key,
        record,
        renderAsTask: record.current.renderAsTask,
        section: record.current.fallbackSection,
        text: cleanTaskText(record.current.fallbackText,) || "Open item",
      },];
    },);
}

function renderRecordMarkdown(
  record: GoogleImportRecord,
  multipleAccounts: boolean,
  text: string,
  renderAsTask: boolean,
  section: GoogleImportSection,
) {
  const chips: string[] = [];
  if (section === "calendar_action_needed" && record.current.dueDate) {
    chips.push(renderMentionMarkdown(createDateMention(record.current.dueDate,),),);
  }

  const sourceChip = record.kind === "gmail"
    ? createGmailMention({
      accountEmail: record.accountEmail,
      href: record.current.href,
      messageId: record.current.messageId,
      revision: record.current.revision,
      sourceId: record.sourceId,
    }, record.current.sourceChipLabel,)
    : createGoogleCalendarMention({
      accountEmail: record.accountEmail,
      calendarUid: record.current.calendarUid,
      href: record.current.href,
      revision: record.current.revision,
      sourceId: record.sourceId,
    }, record.current.sourceChipLabel,);
  chips.push(renderMentionMarkdown(sourceChip,),);

  const parts = [
    text,
    multipleAccounts ? `(${record.accountEmail})` : "",
    ...chips,
  ].filter(Boolean,);

  return renderAsTask ? `- [ ] ${parts.join(" ",)}` : `- ${parts.join(" ",)}`;
}

function buildGoogleBlock(state: GoogleImportState, settingsGoogleAccountCount: number,) {
  const records = getRenderableRecords(state,)
    .sort((left, right,) => left.record.current.sortKey.localeCompare(right.record.current.sortKey,))
    .map((item,) => ({
      key: item.key,
      markdown: renderRecordMarkdown(
        item.record,
        settingsGoogleAccountCount > 1,
        item.text,
        item.renderAsTask,
        item.section,
      ),
      record: item.record,
      renderAsTask: item.renderAsTask,
      section: item.section,
    }));

  const emailReadLines = records.filter((entry,) => entry.section === "email_read");
  const emailReplyLines = records.filter((entry,) => entry.section === "email_reply");
  const calendarWeekLines = records.filter((entry,) => entry.section === "calendar_this_week");
  const calendarActionLines = records.filter((entry,) => entry.section === "calendar_action_needed");

  if (
    emailReadLines.length === 0
    && emailReplyLines.length === 0
    && calendarWeekLines.length === 0
    && calendarActionLines.length === 0
  ) {
    return {
      markdown: "",
      snapshot: [] as GoogleRenderedItemSnapshot[],
    };
  }

  const parts = [GOOGLE_BLOCK_HEADING,];
  const snapshot: GoogleRenderedItemSnapshot[] = [];

  if (emailReadLines.length > 0 || emailReplyLines.length > 0) {
    parts.push("", GOOGLE_EMAIL_HEADING,);
    if (emailReadLines.length > 0) {
      parts.push("", GOOGLE_EMAIL_READ_HEADING, ...emailReadLines.map((entry,) => entry.markdown),);
    }
    if (emailReplyLines.length > 0) {
      parts.push("", GOOGLE_EMAIL_REPLY_HEADING, ...emailReplyLines.map((entry,) => entry.markdown),);
    }

    snapshot.push(
      ...[...emailReadLines, ...emailReplyLines,].map((entry,) => ({
        key: entry.key,
        renderAsTask: entry.renderAsTask,
        revision: entry.record.current.revision,
        section: entry.section,
      })),
    );
  }

  if (calendarWeekLines.length > 0 || calendarActionLines.length > 0) {
    parts.push("", GOOGLE_CALENDAR_HEADING,);
    if (calendarWeekLines.length > 0) {
      parts.push("", GOOGLE_CALENDAR_THIS_WEEK_HEADING, ...calendarWeekLines.map((entry,) => entry.markdown),);
    }
    if (calendarActionLines.length > 0) {
      parts.push("", GOOGLE_CALENDAR_ACTION_HEADING, ...calendarActionLines.map((entry,) => entry.markdown),);
    }

    snapshot.push(
      ...[...calendarWeekLines, ...calendarActionLines,].map((entry,) => ({
        key: entry.key,
        renderAsTask: entry.renderAsTask,
        revision: entry.record.current.revision,
        section: entry.section,
      })),
    );
  }

  return {
    markdown: parts.join("\n",).trim(),
    snapshot,
  };
}

function replaceGoogleBlock(markdown: string, nextBlock: string,) {
  const { before, after, } = extractGoogleBlock(markdown,);
  const remainder = [before, after,].filter(Boolean,).join("\n\n",).trim();
  if (!nextBlock.trim()) return remainder;
  if (!remainder) return nextBlock.trim();
  return `${nextBlock.trim()}\n\n${remainder}`;
}

export async function syncGoogleImports(): Promise<boolean> {
  const settings = await loadSettings();
  const today = getToday();
  const todayNote = await getOrCreateDailyNote(today,);
  const originalMarkdown = json2md(parseJsonContent(todayNote.content,),);
  const state = await loadGoogleImportState();

  reconcileLocalActions(state, today, originalMarkdown,);

  const googleAccounts = [...settings.googleAccounts,];
  if (googleAccounts.length === 0) {
    delete state.lastRenderedByDate[today];
    const nextMarkdown = replaceGoogleBlock(originalMarkdown, "",);
    if (nextMarkdown.trim() !== originalMarkdown.trim()) {
      await saveDailyNote({
        ...todayNote,
        content: JSON.stringify(md2json(nextMarkdown,),),
      },);
      await saveGoogleImportState(state,);
      return true;
    }

    await saveGoogleImportState(state,);
    return false;
  }

  const aiConfig = resolveActiveAiConfig(settings,);

  await Promise.all(
    googleAccounts.map(async (account,) => {
      await syncGmailAccount(account.email, state, aiConfig,);
      await syncCalendarAccount(account.email, state, aiConfig,);
    },),
  );

  const { markdown: nextGoogleBlock, snapshot, } = buildGoogleBlock(state, googleAccounts.length,);
  state.lastRenderedByDate[today] = snapshot;

  const nextMarkdown = replaceGoogleBlock(originalMarkdown, nextGoogleBlock,);
  await saveGoogleImportState(state,);

  if (nextMarkdown.trim() === originalMarkdown.trim()) {
    return false;
  }

  await saveDailyNote({
    ...todayNote,
    content: JSON.stringify(md2json(nextMarkdown,),),
  },);
  return true;
}
