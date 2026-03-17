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
const GOOGLE_IMPORT_STATE_VERSION = 1;
const GOOGLE_BLOCK_HEADING = "# Google";
const GOOGLE_EMAIL_HEADING = "## Email";
const GOOGLE_CALENDAR_HEADING = "## Calendar";
const GOOGLE_CALENDAR_LOOKAHEAD_DAYS = 7;
const GMAIL_HISTORY_PAGE_SIZE = 500;
const GMAIL_THREAD_METADATA_HEADERS = ["Subject", "From", "Date",];
const WIKI_LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
const TASK_LINE_RE = /^[-*] \[( |x|X)\] (.+)$/;

type GoogleImportKind = "gmail" | "google_calendar";
type GoogleImportSection = "email" | "calendar";

interface GoogleImportState {
  version: number;
  gmailHistoryIds: Record<string, string>;
  lastRenderedByDate: Record<string, GoogleRenderedTaskSnapshot[]>;
  records: Record<string, GoogleImportRecord>;
}

interface GoogleImportRecord {
  active: boolean;
  accountEmail: string;
  classification: null | {
    actionable: boolean;
    revision: string;
    taskText: string;
  };
  completedRevision: string | null;
  current: {
    dueDate: string | null;
    fallbackTaskText: string;
    href: string;
    revision: string;
    sortKey: string;
    sourceChipLabel: string;
    timeText: string | null;
  };
  dismissedRevision: string | null;
  kind: GoogleImportKind;
  sourceId: string;
}

interface GoogleRenderedTaskSnapshot {
  key: string;
  revision: string;
  section: GoogleImportSection;
}

interface ParsedGoogleTaskLine extends GoogleRenderedTaskSnapshot {
  checked: boolean;
}

interface GmailProfileResponse {
  historyId?: string;
}

interface GmailHistoryResponse {
  history?: GmailHistoryItem[];
  nextPageToken?: string;
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
  fallbackTaskText: string;
  href: string;
  kind: "gmail";
  revision: string;
  sortKey: string;
  sourceId: string;
  sourceChipLabel: string;
  summary: string;
}

interface CalendarCandidate {
  accountEmail: string;
  dueDate: string;
  fallbackTaskText: string;
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
    actionable: z.boolean(),
    sourceId: z.string(),
    taskText: z.string(),
  },),),
},);

const CalendarClassificationSchema = z.object({
  items: z.array(z.object({
    actionable: z.boolean(),
    sourceId: z.string(),
    taskText: z.string(),
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
              ? items.filter((item,): item is GoogleRenderedTaskSnapshot => {
                if (!item || typeof item !== "object") return false;
                const entry = item as Partial<GoogleRenderedTaskSnapshot>;
                return (
                  typeof entry.key === "string"
                  && typeof entry.revision === "string"
                  && (entry.section === "email" || entry.section === "calendar")
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
              || typeof current.fallbackTaskText !== "string"
              || typeof current.href !== "string"
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
                    && typeof entry.classification.revision === "string"
                    && typeof entry.classification.taskText === "string"
                    && typeof entry.classification.actionable === "boolean"
                  ? {
                    actionable: entry.classification.actionable,
                    revision: entry.classification.revision,
                    taskText: entry.classification.taskText,
                  }
                  : null,
                completedRevision: typeof entry.completedRevision === "string" ? entry.completedRevision : null,
                current: {
                  dueDate: typeof current.dueDate === "string" ? current.dueDate : null,
                  fallbackTaskText: current.fallbackTaskText,
                  href: current.href,
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

function buildEmailFallbackTask(subject: string, from: string, snippet: string,) {
  const base = cleanTaskText(subject || snippet || from || "New email",);
  if (!base) return "Check email";
  return `Check email: ${base}`;
}

function buildCalendarFallbackTask(summary: string, timeText: string | null,) {
  const base = cleanTaskText(summary || "event",);
  return timeText ? `Attend ${base} at ${timeText}` : `Attend ${base}`;
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
) {
  if (candidates.length === 0) return new Map<string, { actionable: boolean; taskText: string; }>();

  try {
    const result = await generateObject({
      model: getAiSdkModel(config, "assistant",),
      schema: EmailClassificationSchema,
      system:
        "You turn inbox threads into concise task text. Keep only email that requires a reply, follow-up, decision, or deliberate review. Hide newsletters, receipts, routine notifications, and FYI updates.",
      prompt: JSON.stringify(
        {
          items: candidates.map((candidate,) => ({
            accountEmail: candidate.accountEmail,
            from: candidate.summary,
            href: candidate.href,
            sourceId: candidate.sourceId,
            subject: candidate.summary,
            suggestedFallback: candidate.fallbackTaskText,
          })),
          instructions: {
            actionableTaskStyle: "Return imperative task text under 80 characters.",
            whenNotActionable: "Set actionable=false and taskText to an empty string.",
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
          actionable: item.actionable,
          taskText: cleanTaskText(item.taskText,),
        },
      ]),
    );
  } catch {
    return new Map<string, { actionable: boolean; taskText: string; }>();
  }
}

async function classifyCalendarEvents(
  candidates: CalendarCandidate[],
  config: ActiveAiConfig,
) {
  if (candidates.length === 0) return new Map<string, { actionable: boolean; taskText: string; }>();

  try {
    const result = await generateObject({
      model: getAiSdkModel(config, "assistant",),
      schema: CalendarClassificationSchema,
      system:
        "You turn calendar events into concise task text. Keep meetings, appointments, and events that require attendance or preparation. Hide routine/personal/default events like gym, commute blockers, or passive reminders.",
      prompt: JSON.stringify(
        {
          items: candidates.map((candidate,) => ({
            accountEmail: candidate.accountEmail,
            sourceId: candidate.sourceId,
            suggestedFallback: candidate.fallbackTaskText,
            summary: candidate.summary,
            timeText: candidate.timeText,
          })),
          instructions: {
            actionableTaskStyle: "Return imperative task text under 80 characters.",
            whenNotActionable: "Set actionable=false and taskText to an empty string.",
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
          actionable: item.actionable,
          taskText: cleanTaskText(item.taskText,),
        },
      ]),
    );
  } catch {
    return new Map<string, { actionable: boolean; taskText: string; }>();
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
  if (!baselineHistoryId) {
    state.gmailHistoryIds[normalizedEmail] = latestHistoryId;
    return;
  }

  let history: GmailHistoryItem[] = [];
  try {
    history = await fetchGmailHistory(accessToken, baselineHistoryId,);
  } catch (error) {
    if (isHistoryResetError(error,)) {
      state.gmailHistoryIds[normalizedEmail] = latestHistoryId;
      return;
    }
    throw error;
  }

  state.gmailHistoryIds[normalizedEmail] = latestHistoryId;
  const threadIds = getThreadIdsFromHistory(history,);
  if (threadIds.length === 0) {
    return;
  }

  const emailCandidates: GmailCandidate[] = [];

  await Promise.all(
    threadIds.map(async (threadId,) => {
      const thread = await fetchGmailThread(accessToken, threadId,);
      const sourceId = thread.id?.trim() || threadId;
      const key = buildRecordKey("gmail", accountEmail, sourceId,);
      const sortedMessages = [...(thread.messages ?? []),].sort((left, right,) =>
        Number(left.internalDate ?? 0,) - Number(right.internalDate ?? 0,)
      );
      const latestMessage = sortedMessages[sortedMessages.length - 1];

      const isInbox = latestMessage?.labelIds?.includes("INBOX",) ?? false;
      const revision = thread.historyId?.trim() || latestHistoryId;
      const subject = getHeaderValue(latestMessage?.payload?.headers, "Subject",);
      const from = getHeaderValue(latestMessage?.payload?.headers, "From",);
      const snippet = thread.snippet?.trim() ?? "";
      const fallbackTaskText = buildEmailFallbackTask(subject, from, snippet,);

      const nextRecord: GoogleImportRecord = {
        active: isInbox,
        accountEmail,
        classification: state.records[key]?.classification?.revision === revision
          ? state.records[key]?.classification ?? null
          : null,
        completedRevision: state.records[key]?.completedRevision ?? null,
        current: {
          dueDate: null,
          fallbackTaskText,
          href: buildGmailThreadHref(accountEmail, sourceId,),
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

      emailCandidates.push({
        accountEmail,
        fallbackTaskText,
        href: nextRecord.current.href,
        kind: "gmail",
        revision,
        sortKey: nextRecord.current.sortKey,
        sourceChipLabel: nextRecord.current.sourceChipLabel,
        sourceId,
        summary: truncateForPrompt(`${subject} ${from} ${snippet}`,),
      },);
    },),
  );

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
          actionable: decision.actionable,
          revision: candidate.revision,
          taskText: decision.taskText,
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
    const sourceId = event.id?.trim();
    const href = event.htmlLink?.trim();
    if (!sourceId || !href) return;

    const key = buildRecordKey("google_calendar", accountEmail, sourceId,);
    seenKeys.add(key,);

    if (event.status === "cancelled") {
      const existing = state.records[key];
      if (existing) {
        state.records[key] = { ...existing, active: false, };
      }
      return;
    }

    const dueDate = getCalendarDueDate(event.start,);
    if (!dueDate) return;

    const timeText = formatCalendarTime(event.start,);
    const summary = truncateForPrompt(
      `${event.summary ?? ""} ${event.location ?? ""} ${event.organizer?.displayName ?? event.organizer?.email ?? ""}`,
    );
    const revision = event.updated?.trim() || event.etag?.trim() || `${sourceId}:${dueDate}`;
    const fallbackTaskText = buildCalendarFallbackTask(event.summary?.trim() ?? "", timeText,);
    const nextRecord: GoogleImportRecord = {
      active: true,
      accountEmail,
      classification: state.records[key]?.classification?.revision === revision
        ? state.records[key]?.classification ?? null
        : null,
      completedRevision: state.records[key]?.completedRevision ?? null,
      current: {
        dueDate,
        fallbackTaskText,
        href,
        revision,
        sortKey: `${dueDate}:${timeText ?? "all-day"}:${sourceId}`,
        sourceChipLabel: "Google Calendar",
        timeText,
      },
      dismissedRevision: state.records[key]?.dismissedRevision ?? null,
      kind: "google_calendar",
      sourceId,
    };

    state.records[key] = nextRecord;
    calendarCandidates.push({
      accountEmail,
      dueDate,
      fallbackTaskText,
      href,
      kind: "google_calendar",
      revision,
      sortKey: nextRecord.current.sortKey,
      sourceChipLabel: nextRecord.current.sourceChipLabel,
      sourceId,
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
  const classified = await classifyCalendarEvents(toClassify, aiConfig,);
  toClassify.forEach((candidate,) => {
    const key = buildRecordKey("google_calendar", candidate.accountEmail, candidate.sourceId,);
    const decision = classified.get(candidate.sourceId,);
    state.records[key] = {
      ...state.records[key]!,
      classification: decision
        ? {
          actionable: decision.actionable,
          revision: candidate.revision,
          taskText: decision.taskText,
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

function parseGoogleBlockTasks(markdown: string,) {
  const { block, } = extractGoogleBlock(markdown,);
  if (!block) return [];

  let section: GoogleImportSection | null = null;
  return block
    .split("\n",)
    .flatMap((line,) => {
      const trimmed = line.trim();
      if (trimmed === GOOGLE_EMAIL_HEADING) {
        section = "email";
        return [];
      }
      if (trimmed === GOOGLE_CALENDAR_HEADING) {
        section = "calendar";
        return [];
      }

      const match = TASK_LINE_RE.exec(trimmed,);
      if (!match || !section) return [];
      const target = extractTaskTarget(trimmed,);
      if (!target) return [];

      return [
        {
          checked: match[1].toLowerCase() === "x",
          key: target.key,
          revision: target.revision,
          section,
        } satisfies ParsedGoogleTaskLine,
      ];
    },);
}

function reconcileLocalActions(state: GoogleImportState, date: string, markdown: string,) {
  const currentTasks = parseGoogleBlockTasks(markdown,);
  const currentKeys = new Set(currentTasks.map((task,) => `${task.key}:${task.revision}`),);
  const previousTasks = state.lastRenderedByDate[date] ?? [];

  currentTasks.forEach((task,) => {
    if (!task.checked) return;
    const record = state.records[task.key];
    if (!record) return;
    state.records[task.key] = {
      ...record,
      completedRevision: task.revision,
    };
  },);

  previousTasks.forEach((task,) => {
    const record = state.records[task.key];
    if (!record) return;

    const compositeKey = `${task.key}:${task.revision}`;
    if (currentKeys.has(compositeKey,)) return;
    if (record.completedRevision === task.revision) return;

    state.records[task.key] = {
      ...record,
      dismissedRevision: task.revision,
    };
  },);
}

function getRenderableRecords(state: GoogleImportState,) {
  return Object.entries(state.records,)
    .filter(([, record,],) => {
      if (!record.active) return false;

      const currentRevision = record.current.revision;
      if (record.completedRevision === currentRevision || record.dismissedRevision === currentRevision) {
        return false;
      }

      if (record.classification && record.classification.revision === currentRevision) {
        return record.classification.actionable;
      }

      return true;
    },)
    .map(([key, record,],) => ({ key, record, }));
}

function renderRecordTaskMarkdown(record: GoogleImportRecord, multipleAccounts: boolean,) {
  const taskText = cleanTaskText(
    record.classification?.revision === record.current.revision
      ? record.classification.taskText
      : record.current.fallbackTaskText,
  ) || cleanTaskText(record.current.fallbackTaskText,) || "Open item";

  const chips: string[] = [];
  if (record.kind === "google_calendar" && record.current.dueDate) {
    chips.push(renderMentionMarkdown(createDateMention(record.current.dueDate,),),);
  }

  const sourceChip = record.kind === "gmail"
    ? createGmailMention({
      accountEmail: record.accountEmail,
      href: record.current.href,
      revision: record.current.revision,
      sourceId: record.sourceId,
    }, record.current.sourceChipLabel,)
    : createGoogleCalendarMention({
      accountEmail: record.accountEmail,
      href: record.current.href,
      revision: record.current.revision,
      sourceId: record.sourceId,
    }, record.current.sourceChipLabel,);
  chips.push(renderMentionMarkdown(sourceChip,),);

  const parts = [
    taskText,
    multipleAccounts ? `(${record.accountEmail})` : "",
    ...chips,
  ].filter(Boolean,);

  return `- [ ] ${parts.join(" ",)}`;
}

function buildGoogleBlock(state: GoogleImportState, settingsGoogleAccountCount: number,) {
  const records = getRenderableRecords(state,)
    .sort((left, right,) => left.record.current.sortKey.localeCompare(right.record.current.sortKey,))
    .map(({ key, record, },) => ({
      key,
      markdown: renderRecordTaskMarkdown(record, settingsGoogleAccountCount > 1,),
      record,
      section: record.kind === "gmail" ? "email" : "calendar" as GoogleImportSection,
    }));

  const emailLines = records.filter((entry,) => entry.section === "email");
  const calendarLines = records.filter((entry,) => entry.section === "calendar");

  if (emailLines.length === 0 && calendarLines.length === 0) {
    return {
      markdown: "",
      snapshot: [] as GoogleRenderedTaskSnapshot[],
    };
  }

  const parts = [GOOGLE_BLOCK_HEADING,];
  const snapshot: GoogleRenderedTaskSnapshot[] = [];

  if (emailLines.length > 0) {
    parts.push("", GOOGLE_EMAIL_HEADING, ...emailLines.map((entry,) => entry.markdown),);
    snapshot.push(
      ...emailLines.map((entry,) => ({
        key: entry.key,
        revision: entry.record.current.revision,
        section: "email" as const,
      })),
    );
  }

  if (calendarLines.length > 0) {
    parts.push("", GOOGLE_CALENDAR_HEADING, ...calendarLines.map((entry,) => entry.markdown),);
    snapshot.push(
      ...calendarLines.map((entry,) => ({
        key: entry.key,
        revision: entry.record.current.revision,
        section: "calendar" as const,
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
