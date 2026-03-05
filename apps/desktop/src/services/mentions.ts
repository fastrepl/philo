const RECURRENCE_TOKEN_RE = /^(daily|weekly|monthly|(\d+)(days?|weeks?|months?))$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AT_MENTION_RE = /(^|[\s([{])@([a-zA-Z0-9][\w-]*)\b/g;

function toIsoDate(date: Date,): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1,).padStart(2, "0",)}-${
    String(date.getDate(),).padStart(2, "0",)
  }`;
}

function addDays(date: Date, days: number,): Date {
  const next = new Date(date,);
  next.setDate(next.getDate() + days,);
  return next;
}

function parseReferenceDate(referenceDate: string | undefined,): Date {
  if (referenceDate && ISO_DATE_RE.test(referenceDate,)) {
    return new Date(`${referenceDate}T00:00:00`,);
  }
  return new Date();
}

function resolveDateToken(token: string, reference: Date,): string | null {
  const lower = token.toLowerCase();
  if (lower === "today") return toIsoDate(reference,);
  if (lower === "tomorrow") return toIsoDate(addDays(reference, 1,),);
  if (lower === "yesterday") return toIsoDate(addDays(reference, -1,),);
  if (ISO_DATE_RE.test(lower,)) return lower;
  return null;
}

function sanitizeToken(token: string,): string {
  return token.toLowerCase().replace(/[^a-z0-9]+/g, "_",).replace(/^_+|_+$/g, "",);
}

function mentionTarget(token: string, reference: Date,): string | null {
  const date = resolveDateToken(token, reference,);
  if (date) return `date_${date}`;

  if (RECURRENCE_TOKEN_RE.test(token,)) {
    return `recurring_${token.toLowerCase()}`;
  }

  const cleaned = sanitizeToken(token,);
  if (!cleaned) return null;
  return `tag_${cleaned}`;
}

export function convertAtMentionsToWikiLinks(markdown: string, referenceDate?: string,): string {
  const reference = parseReferenceDate(referenceDate,);
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g,);

  return parts
    .map((part, i,) => {
      if (i % 2 === 1) return part;
      return part.replace(AT_MENTION_RE, (full, prefix: string, token: string,) => {
        const target = mentionTarget(token, reference,);
        if (!target) return full;
        return `${prefix}[[${target}]]`;
      },);
    },)
    .join("",);
}
