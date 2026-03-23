import { invoke, } from "@tauri-apps/api/core";
import { readDir, } from "@tauri-apps/plugin-fs";
import { getToday, } from "../types/note";
import { buildPageLinkTarget, getPagesDir, isExplicitPageLinkTarget, parsePageTitleFromLinkTarget, } from "./paths";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY_RE =
  /^(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:,\s*(\d{4}))?$/i;
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/;
const LEGACY_DATE_TARGET_RE = /^date_(\d{4}-\d{2}-\d{2})$/;
const LEGACY_RECURRING_TARGET_RE = /^recurring_(daily|weekly|monthly|(\d+)(days?|weeks?|months?))$/i;
const CANONICAL_DUE_TARGET_RE = /^(\d{4}-\d{2}-\d{2})\(due date\)$/i;
const CANONICAL_RECURRING_TARGET_RE = /^(\d{4}-\d{2}-\d{2})\(start date\),\s*(\d+)\((day|days)\)$/i;
const GMAIL_TARGET_RE = /^gmail_([A-Za-z0-9_-]+)$/;
const GOOGLE_CALENDAR_TARGET_RE = /^google_calendar_([A-Za-z0-9_-]+)$/;
const RECURRING_ID_RE = /^recurring_(\d{4}-\d{2}-\d{2})_(\d+)$/;
const DATE_ID_RE = /^date_(\d{4}-\d{2}-\d{2})$/;
const LEGACY_DATE_LINK_RE = /\[\[(date_\d{4}-\d{2}-\d{2})(?:\|[^[\]]+)?\]\]/i;
const LEGACY_RECURRING_LINK_RE =
  /\[\[(recurring_(?:daily|weekly|monthly|(?:\d+)(?:days?|weeks?|months?)))(?:\|[^[\]]+)?\]\]/i;
const LEGACY_RECURRING_PAIR_RE = new RegExp(
  `${LEGACY_DATE_LINK_RE.source}\\s+${LEGACY_RECURRING_LINK_RE.source}`,
  "gi",
);

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export type MentionKind = "date" | "recurring" | "tag" | "page" | "gmail" | "google_calendar";
export type MentionGroup = "action" | "page" | "date" | "recurring";
const PAGE_SUGGESTION_LIMIT = 20;

interface MarkdownSearchResult {
  path: string;
  relativePath: string;
  title: string;
  snippet: string;
}

export interface MentionChipData {
  id: string;
  label: string;
  kind: MentionKind;
}

export interface MentionSuggestion extends MentionChipData {
  group: MentionGroup;
  action?: "open_date_picker" | "show_more_pages";
}

export interface MentionChipExternalPayload {
  version: 1;
  accountEmail: string;
  href: string;
  calendarUid?: string;
  messageId?: string;
  revision: string;
  sourceId: string;
}

function escapeAttr(value: string,): string {
  return value
    .replace(/&/g, "&amp;",)
    .replace(/"/g, "&quot;",)
    .replace(/</g, "&lt;",)
    .replace(/>/g, "&gt;",);
}

function escapeHtml(value: string,): string {
  return escapeAttr(value,).replace(/'/g, "&#39;",);
}

function toIsoDate(date: Date,): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1,).padStart(2, "0",)}-${
    String(date.getDate(),).padStart(2, "0",)
  }`;
}

function fromIsoDate(date: string,): Date {
  return new Date(`${date}T00:00:00`,);
}

function addDays(date: Date, days: number,): Date {
  const next = new Date(date,);
  next.setDate(next.getDate() + days,);
  return next;
}

function startOfWeek(date: Date,): Date {
  const next = new Date(date,);
  next.setHours(0, 0, 0, 0,);
  next.setDate(next.getDate() - next.getDay(),);
  return next;
}

function addDaysToIsoDate(date: string, days: number,): string {
  return toIsoDate(addDays(fromIsoDate(date,), days,),);
}

function diffDays(start: string, end: string,): number {
  return Math.round((fromIsoDate(end,).getTime() - fromIsoDate(start,).getTime()) / 86_400_000,);
}

function parseReferenceDate(referenceDate: string | undefined,): Date {
  if (referenceDate && ISO_DATE_RE.test(referenceDate,)) {
    return fromIsoDate(referenceDate,);
  }
  return new Date();
}

function getRelativeDateReference(): Date {
  return fromIsoDate(getToday(),);
}

function formatDisplayDate(date: string,): string {
  return fromIsoDate(date,).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  },);
}

function formatDisplayDateWithYear(date: string, referenceDate: string,): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };

  if (date.slice(0, 4,) !== referenceDate.slice(0, 4,)) {
    options.year = "numeric";
  }

  return fromIsoDate(date,).toLocaleDateString("en-US", options,);
}

function formatRelativeChipDate(date: string, referenceDate: string,): string {
  const daysUntil = diffDays(referenceDate, date,);
  if (daysUntil === 0) return "Today";
  if (daysUntil === -1) return "Yesterday";
  if (daysUntil === 1) return "Tomorrow";
  if (daysUntil >= 2 && daysUntil <= 6) return `${daysUntil} days later`;
  if (daysUntil <= -2 && daysUntil >= -6) return `${Math.abs(daysUntil,)} days ago`;
  return formatDisplayDateWithYear(date, referenceDate,);
}

function getDateChipState(
  date: string,
  referenceDate: string,
): "past" | "today" | "this_week" | "future" {
  if (date < referenceDate) return "past";
  if (date === referenceDate) return "today";

  const nextWeekStart = toIsoDate(addDays(startOfWeek(fromIsoDate(referenceDate,),), 7,),);
  return date < nextWeekStart ? "this_week" : "future";
}

function normalizeToken(token: string,): string {
  return token.trim().toLowerCase().replace(/\s+/g, " ",);
}

function toTitleCase(value: string,): string {
  return value.replace(/\b\w/g, (match,) => match.toUpperCase(),);
}

function toBase64Url(value: string,) {
  if (typeof TextEncoder === "undefined" || typeof btoa === "undefined") {
    return "";
  }

  let binary = "";
  for (const byte of new TextEncoder().encode(value,)) {
    binary += String.fromCharCode(byte,);
  }

  return btoa(binary,).replace(/\+/g, "-",).replace(/\//g, "_",).replace(/=+$/g, "",);
}

function fromBase64Url(value: string,) {
  if (!value || typeof atob === "undefined") return null;

  const normalized = value.replace(/-/g, "+",).replace(/_/g, "/",);
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4,);

  try {
    return atob(padded,);
  } catch {
    return null;
  }
}

function normalizeExternalChipPayload(value: unknown,): MentionChipExternalPayload | null {
  if (!value || typeof value !== "object") return null;

  const payload = value as Partial<MentionChipExternalPayload>;
  if (
    payload.version !== 1
    || typeof payload.accountEmail !== "string"
    || typeof payload.href !== "string"
    || typeof payload.revision !== "string"
    || typeof payload.sourceId !== "string"
  ) {
    return null;
  }

  const accountEmail = payload.accountEmail.trim();
  const href = payload.href.trim();
  const revision = payload.revision.trim();
  const sourceId = payload.sourceId.trim();
  if (!accountEmail || !href || !revision || !sourceId) return null;
  const messageId = typeof payload.messageId === "string" && payload.messageId.trim()
    ? payload.messageId.trim()
    : undefined;
  const calendarUid = typeof payload.calendarUid === "string" && payload.calendarUid.trim()
    ? payload.calendarUid.trim()
    : undefined;

  return {
    version: 1,
    accountEmail,
    ...(calendarUid ? { calendarUid, } : {}),
    href,
    ...(messageId ? { messageId, } : {}),
    revision,
    sourceId,
  };
}

function encodeExternalChipPayload(payload: MentionChipExternalPayload,) {
  return toBase64Url(JSON.stringify(payload,),);
}

function decodeExternalChipPayload(encoded: string,) {
  const decoded = fromBase64Url(encoded,);
  if (!decoded) return null;

  try {
    return normalizeExternalChipPayload(JSON.parse(decoded,),);
  } catch {
    return null;
  }
}

function monthIndex(input: string,): number {
  const normalized = input.toLowerCase();
  return MONTHS.findIndex((month,) => month.startsWith(normalized,));
}

function recurrenceTokenToIntervalDays(token: string,): number | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === "daily") return 1;
  if (normalized === "weekly") return 7;
  if (normalized === "monthly") return 30;

  const match = normalized.match(/^(\d+)(days?|weeks?|months?)$/i,);
  if (!match) return null;

  const count = Number(match[1],);
  if (match[2].startsWith("day",)) return count;
  if (match[2].startsWith("week",)) return count * 7;
  if (match[2].startsWith("month",)) return count * 30;
  return null;
}

function buildDateId(date: string,): string {
  return `date_${date}`;
}

function buildRecurringId(startDate: string, intervalDays: number,): string {
  return `recurring_${startDate}_${intervalDays}`;
}

function buildGmailId(payload: MentionChipExternalPayload,) {
  return `gmail_${encodeExternalChipPayload(payload,)}`;
}

function buildGoogleCalendarId(payload: MentionChipExternalPayload,) {
  return `google_calendar_${encodeExternalChipPayload(payload,)}`;
}

function formatRecurringInterval(intervalDays: number,): string {
  return `${intervalDays}(${intervalDays === 1 ? "day" : "days"})`;
}

function formatDueTarget(date: string,): string {
  return `${date}(due date)`;
}

function formatRecurringTarget(startDate: string, intervalDays: number,): string {
  return `${startDate}(start date),${formatRecurringInterval(intervalDays,)}`;
}

function getRecurringDisplayDate(startDate: string, intervalDays: number, referenceDate: string,): string {
  if (startDate >= referenceDate) return startDate;

  const elapsedDays = diffDays(startDate, referenceDate,);
  const cycles = Math.ceil(elapsedDays / intervalDays,);
  return addDaysToIsoDate(startDate, cycles * intervalDays,);
}

function parseMentionId(
  id: string,
): { kind: "date"; date: string; } | { kind: "recurring"; startDate: string; intervalDays: number; } | null {
  const dateMatch = DATE_ID_RE.exec(id,);
  if (dateMatch) {
    return { kind: "date", date: dateMatch[1], };
  }

  const recurringMatch = RECURRING_ID_RE.exec(id,);
  if (!recurringMatch) return null;

  return {
    kind: "recurring",
    startDate: recurringMatch[1],
    intervalDays: Number(recurringMatch[2],),
  };
}

function buildExternalChipLabel(kind: "gmail" | "google_calendar", label?: string,) {
  const normalized = label?.trim();
  if (normalized) return normalized;
  return kind === "gmail" ? "Gmail" : "Google Calendar";
}

function parseExternalChipId(
  id: string,
): { kind: "gmail" | "google_calendar"; payload: MentionChipExternalPayload; } | null {
  const gmailMatch = GMAIL_TARGET_RE.exec(id,);
  if (gmailMatch) {
    const payload = decodeExternalChipPayload(gmailMatch[1],);
    return payload ? { kind: "gmail", payload, } : null;
  }

  const googleCalendarMatch = GOOGLE_CALENDAR_TARGET_RE.exec(id,);
  if (!googleCalendarMatch) return null;
  const payload = decodeExternalChipPayload(googleCalendarMatch[1],);
  return payload ? { kind: "google_calendar", payload, } : null;
}

function buildDateSuggestion(date: string, label: string,): MentionSuggestion {
  return {
    id: buildDateId(date,),
    label,
    kind: "date",
    group: "date",
  };
}

function buildRecurringSuggestion(startDate: string, intervalDays: number, label: string,): MentionSuggestion {
  return {
    id: buildRecurringId(startDate, intervalDays,),
    label,
    kind: "recurring",
    group: "recurring",
  };
}

function buildDatePickerSuggestion(): MentionSuggestion {
  return {
    id: "action_open_date_picker",
    label: "Select date",
    kind: "date",
    group: "action",
    action: "open_date_picker",
  };
}

function buildPageSuggestion(title: string,): MentionSuggestion {
  return {
    id: buildPageLinkTarget(title,),
    label: title,
    kind: "page",
    group: "page",
  };
}

async function getDefaultPageSuggestions(): Promise<MentionSuggestion[]> {
  const pagesDir = await getPagesDir();

  try {
    const entries = await readDir(pagesDir,);
    return entries
      .filter((entry,) => entry.isFile && typeof entry.name === "string" && entry.name.toLowerCase().endsWith(".md",))
      .map((entry,) => parsePageTitleFromLinkTarget(entry.name ?? "",))
      .filter((title,): title is string => Boolean(title,))
      .sort((left, right,) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true, },))
      .slice(0, PAGE_SUGGESTION_LIMIT,)
      .map((title,) => buildPageSuggestion(title,));
  } catch {
    return [];
  }
}

function resolveWeekdayDate(query: string, reference: Date,): MentionSuggestion | null {
  const normalized = normalizeToken(query,);
  const nextMatch = normalized.match(/^next\s+([a-z]+)$/i,);
  const weekdayInput = nextMatch ? nextMatch[1] : normalized;
  const weekdayIndex = WEEKDAYS.findIndex((day,) => day.startsWith(weekdayInput,));
  if (weekdayIndex === -1) return null;

  const todayIndex = reference.getDay();
  let offset = (weekdayIndex - todayIndex + 7) % 7;
  if (nextMatch) {
    offset = offset === 0 ? 7 : offset;
  }

  const date = toIsoDate(addDays(reference, offset,),);
  const label = nextMatch ? `Next ${toTitleCase(WEEKDAYS[weekdayIndex],)}` : toTitleCase(WEEKDAYS[weekdayIndex],);
  return buildDateSuggestion(date, label,);
}

function resolveMonthDayDate(query: string, reference: Date,): MentionSuggestion | null {
  const normalized = normalizeToken(query,);
  const monthDay = normalized.match(MONTH_DAY_RE,);
  if (monthDay) {
    const month = monthIndex(monthDay[1],);
    if (month === -1) return null;
    const day = Number(monthDay[2],);
    const explicitYear = monthDay[3] ? Number(monthDay[3],) : null;
    let year = explicitYear ?? reference.getFullYear();
    let candidate = new Date(year, month, day,);

    if (!explicitYear && toIsoDate(candidate,) < toIsoDate(reference,)) {
      year += 1;
      candidate = new Date(year, month, day,);
    }

    if (candidate.getMonth() !== month || candidate.getDate() !== day) return null;
    const date = toIsoDate(candidate,);
    const label = candidate.toLocaleDateString(
      "en-US",
      explicitYear
        ? { month: "long", day: "numeric", year: "numeric", }
        : { month: "long", day: "numeric", },
    );
    return buildDateSuggestion(date, label,);
  }

  const slashDate = normalized.match(SLASH_DATE_RE,);
  if (!slashDate) return null;

  const month = Number(slashDate[1],) - 1;
  const day = Number(slashDate[2],);
  if (month < 0 || month > 11) return null;

  let year = slashDate[3] ? Number(slashDate[3],) : reference.getFullYear();
  if (slashDate[3] && year < 100) year += 2000;
  let candidate = new Date(year, month, day,);

  if (!slashDate[3] && toIsoDate(candidate,) < toIsoDate(reference,)) {
    candidate = new Date(year + 1, month, day,);
  }

  if (candidate.getMonth() !== month || candidate.getDate() !== day) return null;
  return buildDateSuggestion(toIsoDate(candidate,), formatDisplayDate(toIsoDate(candidate,),),);
}

function resolveDateQuery(query: string, reference: Date,): MentionSuggestion | null {
  const normalized = normalizeToken(query,);
  if (!normalized) return null;

  if (normalized === "today") return buildDateSuggestion(toIsoDate(reference,), "Today",);
  if (normalized === "tomorrow" || normalized === "tmrw") {
    return buildDateSuggestion(toIsoDate(addDays(reference, 1,),), "Tomorrow",);
  }
  if (normalized === "yesterday") {
    return buildDateSuggestion(toIsoDate(addDays(reference, -1,),), "Yesterday",);
  }
  if (ISO_DATE_RE.test(normalized,)) {
    return buildDateSuggestion(normalized, formatDisplayDate(normalized,),);
  }

  return resolveWeekdayDate(normalized, reference,) ?? resolveMonthDayDate(normalized, reference,);
}

function buildDefaultDateSuggestions(reference: Date,): MentionSuggestion[] {
  const tomorrow = addDays(reference, 1,);
  const referenceWeekStart = startOfWeek(reference,).getTime();
  const upcomingWorkdays = [1, 5,]
    .map((weekdayIndex,) => {
      let offset = (weekdayIndex - reference.getDay() + 7) % 7;
      while (offset <= 1) {
        offset += 7;
      }

      const candidate = addDays(reference, offset,);
      const weekLabel = startOfWeek(candidate,).getTime() === referenceWeekStart ? "This" : "Next";
      return buildDateSuggestion(toIsoDate(candidate,), `${weekLabel} ${toTitleCase(WEEKDAYS[weekdayIndex],)}`,);
    },)
    .sort((left, right,) => left.id.localeCompare(right.id,));

  return [
    buildDateSuggestion(toIsoDate(reference,), "Today",),
    buildDateSuggestion(toIsoDate(tomorrow,), "Tomorrow",),
    ...upcomingWorkdays,
  ].filter((item,): item is MentionSuggestion => item !== null);
}

function buildRecurringSuggestions(query: string, referenceDate: string,): MentionSuggestion[] {
  const tokens = [
    { token: "daily", label: "Daily", },
    { token: "weekly", label: "Weekly", },
    { token: "monthly", label: "Monthly", },
  ];
  const normalized = normalizeToken(query,);

  return tokens
    .filter((item,) => !normalized || item.token.startsWith(normalized,))
    .map((item,) => buildRecurringSuggestion(referenceDate, recurrenceTokenToIntervalDays(item.token,)!, item.label,));
}

function dedupeSuggestions(items: MentionSuggestion[],): MentionSuggestion[] {
  const seen = new Set<string>();
  return items.filter((item,) => {
    if (seen.has(item.id,)) return false;
    seen.add(item.id,);
    return true;
  },);
}

async function getPageSuggestions(query: string,): Promise<MentionSuggestion[]> {
  const normalized = normalizeToken(query,);
  if (!normalized) return [];

  const pagesDir = await getPagesDir();
  const results = await invoke<MarkdownSearchResult[]>("search_markdown_files", {
    rootDir: pagesDir,
    query: normalized,
    limit: PAGE_SUGGESTION_LIMIT,
  },);

  return dedupeSuggestions(
    results
      .map((result,) =>
        parsePageTitleFromLinkTarget(result.relativePath,) ?? parsePageTitleFromLinkTarget(result.title,)
      )
      .filter((title,): title is string => Boolean(title,))
      .map((title,) => buildPageSuggestion(title,)),
  );
}

function parseMentionTarget(
  target: string,
  label?: string | null,
  fallbackRecurringStartDate?: string,
): MentionChipData | null {
  const external = parseExternalChipId(target,);
  if (external) {
    return {
      id: target,
      kind: external.kind,
      label: buildExternalChipLabel(external.kind, label ?? undefined,),
    };
  }

  const canonicalDueMatch = CANONICAL_DUE_TARGET_RE.exec(target,);
  if (canonicalDueMatch) {
    return {
      id: buildDateId(canonicalDueMatch[1],),
      kind: "date",
      label: label?.trim() || "",
    };
  }

  const canonicalRecurringMatch = CANONICAL_RECURRING_TARGET_RE.exec(target,);
  if (canonicalRecurringMatch) {
    return {
      id: buildRecurringId(canonicalRecurringMatch[1], Number(canonicalRecurringMatch[2],),),
      kind: "recurring",
      label: label?.trim() || "",
    };
  }

  const legacyDateMatch = LEGACY_DATE_TARGET_RE.exec(target,);
  if (legacyDateMatch) {
    return {
      id: buildDateId(legacyDateMatch[1],),
      kind: "date",
      label: label?.trim() || "",
    };
  }

  const legacyRecurringMatch = LEGACY_RECURRING_TARGET_RE.exec(target,);
  if (legacyRecurringMatch) {
    const intervalDays = recurrenceTokenToIntervalDays(legacyRecurringMatch[1],);
    if (!intervalDays) return null;
    if (fallbackRecurringStartDate) {
      return {
        id: buildRecurringId(fallbackRecurringStartDate, intervalDays,),
        kind: "recurring",
        label: label?.trim() || "",
      };
    }

    return {
      id: target,
      kind: "recurring",
      label: label?.trim() || target.slice("recurring_".length,).replace(/_/g, " ",),
    };
  }

  if (target.startsWith("tag_",)) {
    const token = target.slice("tag_".length,);
    if (!token) return null;
    return {
      id: target,
      kind: "tag",
      label: label?.trim() || token.replace(/_/g, " ",),
    };
  }

  if (isExplicitPageLinkTarget(target,)) {
    const pageTitle = parsePageTitleFromLinkTarget(target,);
    if (!pageTitle) return null;
    return {
      id: buildPageLinkTarget(pageTitle,),
      kind: "page",
      label: label?.trim() || pageTitle,
    };
  }

  return null;
}

function toMentionChipHtml(data: MentionChipData, referenceDate?: string,): string {
  const label = getMentionChipLabel(data, referenceDate,);
  return `<span data-mention-chip="" data-id="${escapeAttr(data.id,)}" data-kind="${
    escapeAttr(data.kind,)
  }" data-label="${escapeAttr(label,)}">${escapeHtml(label,)}</span>`;
}

function replaceLegacyRecurringPairs(markdown: string, referenceDate?: string,): string {
  return markdown.replace(
    LEGACY_RECURRING_PAIR_RE,
    (full, dateTarget: string, recurringTarget: string,) => {
      const dateMatch = LEGACY_DATE_TARGET_RE.exec(dateTarget,);
      const recurringMatch = LEGACY_RECURRING_TARGET_RE.exec(recurringTarget,);
      if (!dateMatch || !recurringMatch) return full;

      const intervalDays = recurrenceTokenToIntervalDays(recurringMatch[1],);
      if (!intervalDays) return full;

      return toMentionChipHtml({
        id: buildRecurringId(dateMatch[1], intervalDays,),
        kind: "recurring",
        label: "",
      }, referenceDate,);
    },
  );
}

export function getMentionChipLabel(
  data: Pick<MentionChipData, "id" | "kind" | "label">,
  referenceDate: string = getToday(),
): string {
  const external = parseExternalChipId(data.id,);
  if (external) {
    return data.label || buildExternalChipLabel(external.kind, data.label,);
  }

  const parsed = parseMentionId(data.id,);
  if (!parsed) {
    if (data.kind === "page" || isExplicitPageLinkTarget(data.id,)) {
      return data.label || parsePageTitleFromLinkTarget(data.id,) || String(data.id ?? "",);
    }
    return data.label || String(data.id ?? "",);
  }

  if (parsed.kind === "date") {
    return formatRelativeChipDate(parsed.date, referenceDate,);
  }

  const displayDate = getRecurringDisplayDate(parsed.startDate, parsed.intervalDays, referenceDate,);
  return formatRelativeChipDate(displayDate, referenceDate,);
}

export function getMentionChipDate(
  data: Pick<MentionChipData, "id" | "kind">,
  referenceDate: string = getToday(),
): string | null {
  if (parseExternalChipId(data.id,)) return null;

  const parsed = parseMentionId(data.id,);
  if (!parsed) return null;

  if (parsed.kind === "date") {
    return parsed.date;
  }

  return getRecurringDisplayDate(parsed.startDate, parsed.intervalDays, referenceDate,);
}

export function getMentionChipState(
  data: Pick<MentionChipData, "id" | "kind">,
  referenceDate: string = getToday(),
): "past" | "today" | "this_week" | "future" | null {
  if (parseExternalChipId(data.id,)) return null;

  const parsed = parseMentionId(data.id,);
  if (!parsed) return null;

  if (parsed.kind === "date") {
    return getDateChipState(parsed.date, referenceDate,);
  }

  const displayDate = getRecurringDisplayDate(parsed.startDate, parsed.intervalDays, referenceDate,);
  return getDateChipState(displayDate, referenceDate,);
}

export function renderMentionMarkdown(
  data: Pick<MentionChipData, "id" | "kind" | "label">,
): string {
  if (data.kind === "page" || isExplicitPageLinkTarget(data.id,)) {
    const pageTitle = parsePageTitleFromLinkTarget(String(data.id ?? "",),);
    if (!pageTitle) return "";

    const target = buildPageLinkTarget(pageTitle,);
    const label = String(data.label ?? "",).trim();
    return !label || label === pageTitle ? `[[${target}]]` : `[[${target}|${label}]]`;
  }

  if (parseExternalChipId(data.id,)) {
    const id = String(data.id ?? "",);
    const label = String(data.label ?? "",);
    if (!id) return "";
    if (!label || label === id) return `[[${id}]]`;
    return `[[${id}|${label}]]`;
  }

  const parsed = parseMentionId(data.id,);

  if (parsed?.kind === "date") {
    return `[[${formatDueTarget(parsed.date,)}]]`;
  }

  if (parsed?.kind === "recurring") {
    return `[[${formatRecurringTarget(parsed.startDate, parsed.intervalDays,)}]]`;
  }

  const id = String(data.id ?? "",);
  const label = String(data.label ?? "",);
  if (!id) return "";
  if (!label || label === id) return `[[${id}]]`;
  return `[[${id}|${label}]]`;
}

export async function getMentionSuggestions(query: string, referenceDate?: string,): Promise<MentionSuggestion[]> {
  const reference = parseReferenceDate(referenceDate,);
  const relativeReference = getRelativeDateReference();
  const today = toIsoDate(reference,);
  const normalized = normalizeToken(query,);

  if (!normalized) {
    const pageSuggestions = await getDefaultPageSuggestions();
    return [
      buildDatePickerSuggestion(),
      ...pageSuggestions,
      ...buildDefaultDateSuggestions(relativeReference,),
      ...buildRecurringSuggestions("", today,),
    ];
  }

  const pageSuggestions = await getPageSuggestions(normalized,);
  const items: MentionSuggestion[] = [];
  const resolvedDate = resolveDateQuery(normalized, relativeReference,);
  if (resolvedDate) items.push(resolvedDate,);

  for (const preset of buildDefaultDateSuggestions(relativeReference,)) {
    if (preset.label.toLowerCase().startsWith(normalized,)) {
      items.push(preset,);
    }
  }

  items.push(...buildRecurringSuggestions(normalized, today,),);
  return [buildDatePickerSuggestion(), ...pageSuggestions, ...dedupeSuggestions(items,).slice(0, 6,),];
}

export function createDateMention(date: string, label?: string,): MentionSuggestion {
  return buildDateSuggestion(date, label ?? formatDisplayDate(date,),);
}

export function createRecurringMention(
  startDate: string,
  recurrence: string | number,
  label?: string,
): MentionSuggestion {
  const intervalDays = typeof recurrence === "number" ? recurrence : recurrenceTokenToIntervalDays(recurrence,);
  if (!intervalDays) {
    throw new Error(`Invalid recurrence: ${String(recurrence,)}`,);
  }

  return buildRecurringSuggestion(startDate, intervalDays, label ?? formatDisplayDate(startDate,),);
}

export function createGmailMention(
  input: {
    accountEmail: string;
    href: string;
    messageId?: string | null;
    revision: string;
    sourceId: string;
  },
  label = "Gmail",
): MentionChipData {
  return {
    id: buildGmailId({
      version: 1,
      accountEmail: input.accountEmail.trim(),
      href: input.href.trim(),
      ...(input.messageId?.trim() ? { messageId: input.messageId.trim(), } : {}),
      revision: input.revision.trim(),
      sourceId: input.sourceId.trim(),
    },),
    kind: "gmail",
    label: buildExternalChipLabel("gmail", label,),
  };
}

export function createGoogleCalendarMention(
  input: {
    accountEmail: string;
    calendarUid?: string | null;
    href: string;
    revision: string;
    sourceId: string;
  },
  label = "Google Calendar",
): MentionChipData {
  return {
    id: buildGoogleCalendarId({
      version: 1,
      accountEmail: input.accountEmail.trim(),
      ...(input.calendarUid?.trim() ? { calendarUid: input.calendarUid.trim(), } : {}),
      href: input.href.trim(),
      revision: input.revision.trim(),
      sourceId: input.sourceId.trim(),
    },),
    kind: "google_calendar",
    label: buildExternalChipLabel("google_calendar", label,),
  };
}

export function getMentionChipHref(
  data: Pick<MentionChipData, "id" | "kind">,
): string | null {
  return parseExternalChipId(data.id,)?.payload.href ?? null;
}

export function getMentionChipExternalPayload(
  data: Pick<MentionChipData, "id" | "kind">,
): ({ kind: "gmail" | "google_calendar"; } & MentionChipExternalPayload) | null {
  const parsed = parseExternalChipId(data.id,);
  if (!parsed) return null;
  return {
    kind: parsed.kind,
    ...parsed.payload,
  };
}

export function getMentionChipAccountEmail(
  data: Pick<MentionChipData, "id" | "kind">,
): string | null {
  return parseExternalChipId(data.id,)?.payload.accountEmail ?? null;
}

export function getMentionChipRevision(
  data: Pick<MentionChipData, "id" | "kind">,
): string | null {
  return parseExternalChipId(data.id,)?.payload.revision ?? null;
}

export function getMentionChipSourceId(
  data: Pick<MentionChipData, "id" | "kind">,
): string | null {
  return parseExternalChipId(data.id,)?.payload.sourceId ?? null;
}

export function convertAtMentionsToWikiLinks(markdown: string, referenceDate?: string,): string {
  void referenceDate;
  return markdown;
}

export function replaceMentionWikiLinksWithChips(markdown: string, referenceDate?: string,): string {
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g,);

  return parts
    .map((part, index,) => {
      if (index % 2 === 1) return part;
      return replaceLegacyRecurringPairs(part, referenceDate,).replace(
        /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g,
        (full, target: string, label: string | undefined, offset: number, source: string,) => {
          if (offset > 0 && source[offset - 1] === "!") return full;
          const data = parseMentionTarget(target.trim(), label, referenceDate,);
          return data ? toMentionChipHtml(data, referenceDate,) : full;
        },
      );
    },)
    .join("",);
}
