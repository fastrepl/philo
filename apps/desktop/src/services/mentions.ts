const RECURRENCE_TOKEN_RE = /^(daily|weekly|monthly|(\d+)(days?|weeks?|months?))$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AT_MENTION_RE = /(^|[\s([{])@([a-zA-Z0-9][\w-]*)\b/g;
const MONTH_DAY_RE =
  /^(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:,\s*(\d{4}))?$/i;
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/;

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

export type MentionKind = "date" | "recurring" | "tag";

export interface MentionChipData {
  id: string;
  label: string;
  kind: MentionKind;
}

export interface MentionSuggestion extends MentionChipData {
  group: "date" | "recurring";
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

function parseReferenceDate(referenceDate: string | undefined,): Date {
  if (referenceDate && ISO_DATE_RE.test(referenceDate,)) {
    return fromIsoDate(referenceDate,);
  }
  return new Date();
}

function formatDisplayDate(date: string,): string {
  return fromIsoDate(date,).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  },);
}

function normalizeToken(token: string,): string {
  return token.trim().toLowerCase().replace(/\s+/g, " ",);
}

function sanitizeToken(token: string,): string {
  return token.toLowerCase().replace(/[^a-z0-9]+/g, "_",).replace(/^_+|_+$/g, "",);
}

function monthIndex(input: string,): number {
  const normalized = input.toLowerCase();
  return MONTHS.findIndex((month,) => month.startsWith(normalized,));
}

function buildDateSuggestion(date: string, label: string,): MentionSuggestion {
  return {
    id: `date_${date}`,
    label,
    kind: "date",
    group: "date",
  };
}

function buildRecurringSuggestion(token: string, label: string = token,): MentionSuggestion {
  return {
    id: `recurring_${token.toLowerCase()}`,
    label,
    kind: "recurring",
    group: "recurring",
  };
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
  const label = nextMatch ? `next ${WEEKDAYS[weekdayIndex]}` : WEEKDAYS[weekdayIndex];
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

  if (normalized === "today") return buildDateSuggestion(toIsoDate(reference,), "today",);
  if (normalized === "tomorrow" || normalized === "tmrw") {
    return buildDateSuggestion(toIsoDate(addDays(reference, 1,),), "tmrw",);
  }
  if (normalized === "yesterday") {
    return buildDateSuggestion(toIsoDate(addDays(reference, -1,),), "yesterday",);
  }
  if (ISO_DATE_RE.test(normalized,)) {
    return buildDateSuggestion(normalized, formatDisplayDate(normalized,),);
  }

  return resolveWeekdayDate(normalized, reference,) ?? resolveMonthDayDate(normalized, reference,);
}

function buildDefaultDateSuggestions(reference: Date,): MentionSuggestion[] {
  return [
    buildDateSuggestion(toIsoDate(reference,), "today",),
    buildDateSuggestion(toIsoDate(addDays(reference, 1,),), "tmrw",),
    resolveWeekdayDate("next monday", reference,),
    resolveWeekdayDate("next friday", reference,),
  ].filter((item,): item is MentionSuggestion => item !== null);
}

function buildRecurringSuggestions(query: string,): MentionSuggestion[] {
  const tokens = ["daily", "weekly", "monthly",];
  const normalized = normalizeToken(query,);
  return tokens
    .filter((token,) => !normalized || token.startsWith(normalized,))
    .map((token,) => buildRecurringSuggestion(token,));
}

function dedupeSuggestions(items: MentionSuggestion[],): MentionSuggestion[] {
  const seen = new Set<string>();
  return items.filter((item,) => {
    if (seen.has(item.id,)) return false;
    seen.add(item.id,);
    return true;
  },);
}

function parseMentionTarget(target: string, label?: string | null,): MentionChipData | null {
  if (target.startsWith("date_",)) {
    const date = target.slice("date_".length,);
    if (!ISO_DATE_RE.test(date,)) return null;
    return {
      id: target,
      kind: "date",
      label: label?.trim() || formatDisplayDate(date,),
    };
  }

  if (target.startsWith("recurring_",)) {
    const token = target.slice("recurring_".length,);
    if (!RECURRENCE_TOKEN_RE.test(token,)) return null;
    return {
      id: target,
      kind: "recurring",
      label: label?.trim() || token.replace(/_/g, " ",),
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

  return null;
}

function toMentionChipHtml(data: MentionChipData,): string {
  return `<span data-mention-chip="" data-id="${escapeAttr(data.id,)}" data-kind="${
    escapeAttr(data.kind,)
  }" data-label="${escapeAttr(data.label,)}">${escapeHtml(data.label,)}</span>`;
}

export function getMentionSuggestions(query: string, referenceDate?: string,): MentionSuggestion[] {
  const reference = parseReferenceDate(referenceDate,);
  const normalized = normalizeToken(query,);

  if (!normalized) {
    return [
      ...buildDefaultDateSuggestions(reference,),
      ...buildRecurringSuggestions("",),
    ];
  }

  const items: MentionSuggestion[] = [];
  const resolvedDate = resolveDateQuery(normalized, reference,);
  if (resolvedDate) items.push(resolvedDate,);

  for (const preset of buildDefaultDateSuggestions(reference,)) {
    if (preset.label.startsWith(normalized,)) {
      items.push(preset,);
    }
  }

  items.push(...buildRecurringSuggestions(normalized,),);
  return dedupeSuggestions(items,).slice(0, 6,);
}

export function convertAtMentionsToWikiLinks(markdown: string, referenceDate?: string,): string {
  const reference = parseReferenceDate(referenceDate,);
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g,);

  return parts
    .map((part, i,) => {
      if (i % 2 === 1) return part;
      return part.replace(AT_MENTION_RE, (full, prefix: string, token: string,) => {
        const normalized = normalizeToken(token,);
        const date = resolveDateQuery(normalized, reference,);
        if (date) return `${prefix}[[${date.id}|${date.label}]]`;

        if (RECURRENCE_TOKEN_RE.test(normalized,)) {
          return `${prefix}[[recurring_${normalized}|${normalized}]]`;
        }

        const cleaned = sanitizeToken(token,);
        if (!cleaned) return full;
        return `${prefix}[[tag_${cleaned}|${token}]]`;
      },);
    },)
    .join("",);
}

export function replaceMentionWikiLinksWithChips(markdown: string,): string {
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g,);

  return parts
    .map((part, index,) => {
      if (index % 2 === 1) return part;
      return part.replace(
        /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g,
        (full, target: string, label: string | undefined, offset: number, source: string,) => {
          if (offset > 0 && source[offset - 1] === "!") return full;
          const data = parseMentionTarget(target.trim(), label,);
          return data ? toMentionChipHtml(data,) : full;
        },
      );
    },)
    .join("",);
}
