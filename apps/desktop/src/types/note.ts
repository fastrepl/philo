export interface DailyNote {
  date: string; // ISO date string (YYYY-MM-DD)
  content: string; // TipTap JSON string (in-memory), markdown on disk
  city?: string | null;
}

export type PageType = "page" | "meeting";
export type MeetingSessionKind = "decision_making" | "informative";
export type LinkKind = "generic" | "github_pr" | "github_issue" | "github_commit";

export interface GitHubPrLinkData {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  isMerged: boolean;
  author: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  changedFilesCount: number | null;
  commitsCount: number | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: string[];
}

export interface GitHubIssueLinkData {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string | null;
  labels: string[];
  assignees: string[];
  openedAt: string | null;
  closedAt: string | null;
}

export interface GitHubCommitLinkData {
  owner: string;
  repo: string;
  sha: string;
  shortSha: string;
  title: string;
  author: string | null;
  committedAt: string | null;
  changedFilesCount: number | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: string[];
}

export type LinkData = GitHubPrLinkData | GitHubIssueLinkData | GitHubCommitLinkData;

export interface PageFrontmatter {
  type?: string;
  event_id?: string;
  started_at?: string;
  ended_at?: string;
  participants?: unknown;
  location?: string;
  executive_summary?: string;
  session_kind?: string;
  agenda?: unknown;
  action_items?: unknown;
  source?: string;
  link_title?: string;
  summary_updated_at?: string;
  follow_up_questions?: unknown;
  link_kind?: string;
  link_data?: unknown;
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
  location: string | null;
  executiveSummary: string | null;
  sessionKind: MeetingSessionKind | null;
  agenda: string[];
  actionItems: string[];
  source: string | null;
  linkTitle: string | null;
  summaryUpdatedAt: string | null;
  followUpQuestions: string[];
  linkKind: LinkKind | null;
  linkData: LinkData | null;
  frontmatter: PageFrontmatter;
  hasFrontmatter: boolean;
}

export interface AttachedPage {
  title: string;
  path: string;
  type: PageType;
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
