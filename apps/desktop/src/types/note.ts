export interface DailyNote {
  date: string; // ISO date string (YYYY-MM-DD)
  content: string; // TipTap JSON string (in-memory), markdown on disk
  city?: string | null;
}

export type PageType = "page" | "meeting";

export interface PageFrontmatter {
  type?: string;
  attached_to?: string;
  event_id?: string;
  started_at?: string;
  ended_at?: string;
  participants?: unknown;
  source?: string;
  [key: string]: unknown;
}

export interface PageNote {
  title: string;
  path: string;
  content: string; // TipTap JSON string (in-memory), markdown on disk
  type: PageType;
  attachedTo: string | null;
  eventId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  participants: string[];
  source: string | null;
  frontmatter: PageFrontmatter;
  hasFrontmatter: boolean;
}

export interface AttachedPage {
  title: string;
  path: string;
  type: PageType;
  attachedTo: string | null;
}

function toLocalDateString(d: Date,): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1,).padStart(2, "0",)}-${String(d.getDate(),).padStart(2, "0",)}`;
}

export function getToday(): string {
  return toLocalDateString(new Date(),);
}

export function getDaysFromNow(days: number,): string {
  const date = new Date();
  date.setDate(date.getDate() + days,);
  return toLocalDateString(date,);
}

function ordinalSuffix(day: number,): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

export function formatDate(dateStr: string,): string {
  const date = new Date(dateStr + "T00:00:00",);
  const month = date.toLocaleDateString("en-US", { month: "long", },);
  const day = date.getDate();
  return `${month} ${day}${ordinalSuffix(day,)}`;
}

export function isToday(dateStr: string,): boolean {
  return dateStr === getToday();
}

export function formatDateLong(dateStr: string,): string {
  const date = new Date(dateStr + "T00:00:00",);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  },);
}

export function getDaysAgo(days: number,): string {
  const date = new Date();
  date.setDate(date.getDate() - days,);
  return toLocalDateString(date,);
}
