import { invoke, } from "@tauri-apps/api/core";
import { dirname, join, } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, remove, rename, } from "@tauri-apps/plugin-fs";
import { EMPTY_DOC, json2md, md2json, parseJsonContent, } from "../lib/markdown";
import {
  AttachedPage,
  DailyNote,
  getDaysAgo,
  getToday,
  type GitHubCommitLinkData,
  type GitHubIssueLinkData,
  type GitHubPrLinkData,
  type LinkData,
  type LinkKind,
  type MeetingSessionKind,
  type PageFrontmatter,
  type PageNote,
  type PageType,
} from "../types/note";
import { resolveExcalidrawEmbeds, } from "./excalidraw";
import {
  resolveMarkdownAssetLinks,
  resolveMarkdownImages,
  unresolveMarkdownAssetLinks,
  unresolveMarkdownImages,
} from "./images";
import { convertAtMentionsToWikiLinks, replaceMentionWikiLinksWithChips, } from "./mentions";
import {
  buildPageLinkTarget,
  buildPageMarkdownHref,
  getJournalDir,
  getNoteLinkTarget,
  getNotePath,
  getPagePath,
  getPagesDir,
  isExplicitPageLinkTarget,
  parseDateFromNoteLinkTarget,
  parsePageTitleFromLinkTarget,
  parsePageTitleFromPath,
  replacePageTitleBasename,
  sanitizePageTitle,
} from "./paths";
import {
  DEFAULT_FILENAME_PATTERN,
  getDailyLogsFolderSetting,
  getFilenamePattern,
  getVaultDirSetting,
} from "./settings";
import { resolveWidgetEmbeds, } from "./widget-files";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const CANONICAL_DUE_LINK_RE = /\[\[(\d{4}-\d{2}-\d{2})\(due date\)\]\]/g;
const WIKI_LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s"]+)(?:\s+"([^"]*)")?\)/g;
const PAGE_FRONTMATTER_KEYS = new Set([
  "type",
  "attached_to",
  "event_id",
  "started_at",
  "ended_at",
  "participants",
  "location",
  "executive_summary",
  "session_kind",
  "agenda",
  "action_items",
  "source",
  "link_title",
  "summary_updated_at",
  "follow_up_questions",
  "link_kind",
  "link_data",
],);

type FrontmatterValue = unknown;
type FrontmatterRecord = Record<string, FrontmatterValue>;
interface MarkdownSearchResult {
  path: string;
  relativePath: string;
  title: string;
  snippet: string;
}

function mapMarkdownOutsideCode(markdown: string, transform: (value: string,) => string,): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g,)
    .map((part, index,) => (index % 2 === 1 ? part : transform(part,)))
    .join("",);
}

async function rewriteDateMentionLinksToNoteLinks(markdown: string,): Promise<string> {
  const replacements = new Map<string, string>();
  for (const match of markdown.matchAll(CANONICAL_DUE_LINK_RE,)) {
    const date = match[1];
    if (!date || replacements.has(date,)) continue;
    replacements.set(date, `[[${await getNoteLinkTarget(date,)}]]`,);
  }

  if (replacements.size === 0) return markdown;

  return mapMarkdownOutsideCode(
    markdown,
    (part,) => part.replace(CANONICAL_DUE_LINK_RE, (_full, date: string,) => replacements.get(date,) ?? _full,),
  );
}

async function rewriteNoteLinksToDateMentionLinks(markdown: string,): Promise<string> {
  const pattern = await getFilenamePattern().catch(() => DEFAULT_FILENAME_PATTERN);
  const dailyLogsFolder = await getDailyLogsFolderSetting().catch(() => "");

  return mapMarkdownOutsideCode(
    markdown,
    (part,) =>
      part.replace(WIKI_LINK_RE, (full, target: string, label: string | undefined, offset: number, source: string,) => {
        if (offset > 0 && source[offset - 1] === "!") return full;

        const date = parseDateFromNoteLinkTarget(target, pattern, dailyLogsFolder,);
        if (!date) return full;

        return label ? `[[${date}(due date)|${label}]]` : `[[${date}(due date)]]`;
      },),
  );
}

function rewriteWikiPageLinksToMarkdownLinks(markdown: string,): string {
  return mapMarkdownOutsideCode(
    markdown,
    (part,) =>
      part.replace(WIKI_LINK_RE, (full, target: string, label: string | undefined, offset: number, source: string,) => {
        if (offset > 0 && source[offset - 1] === "!") return full;
        if (target.includes("(due date)",)) return full;

        const title = parsePageTitleFromLinkTarget(target,);
        if (!title) return full;

        return `[${label?.trim() || title}](${buildPageMarkdownHref(title,)})`;
      },),
  );
}

function rewriteMarkdownPageLinksToCanonicalWikiLinks(markdown: string,): string {
  return mapMarkdownOutsideCode(
    markdown,
    (part,) =>
      part.replace(
        MARKDOWN_LINK_RE,
        (full, label: string, target: string, titleAttr: string | undefined, offset: number, source: string,) => {
          if (offset > 0 && source[offset - 1] === "!") return full;
          if (titleAttr) return full;

          const pageTitle = parsePageTitleFromLinkTarget(target,);
          if (!pageTitle) return full;
          if (!isExplicitPageLinkTarget(target,) && label.trim() !== pageTitle) return full;

          const canonicalTarget = buildPageLinkTarget(pageTitle,);
          const trimmedLabel = label.trim();
          return trimmedLabel && trimmedLabel !== pageTitle
            ? `[[${canonicalTarget}|${trimmedLabel}]]`
            : `[[${canonicalTarget}]]`;
        },
      ),
  );
}

function parseFrontmatterValue(raw: string,): FrontmatterValue {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  try {
    return JSON.parse(trimmed,);
  } catch {
    return trimmed;
  }
}

function serializeFrontmatterScalar(value: FrontmatterValue,): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value,);
  }
  if (value === null) {
    return "null";
  }
  return JSON.stringify(value ?? "",);
}

function parseMarkdownFrontmatter(raw: string,): {
  frontmatter: FrontmatterRecord;
  body: string;
  hasFrontmatter: boolean;
} {
  const match = raw.match(FRONTMATTER_RE,);
  if (!match) return { frontmatter: {}, body: raw, hasFrontmatter: false, };

  const frontmatter: FrontmatterRecord = {};
  const lines = match[1].split("\n",);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/,);
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const inlineValue = keyMatch[2] ?? "";
    if (inlineValue.trim()) {
      frontmatter[key] = parseFrontmatterValue(inlineValue,);
      continue;
    }

    const items: FrontmatterValue[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const itemMatch = lines[nextIndex].match(/^\s*-\s+(.*)$/,);
      if (!itemMatch) break;
      items.push(parseFrontmatterValue(itemMatch[1],),);
      nextIndex += 1;
    }

    if (items.length > 0) {
      frontmatter[key] = items;
      index = nextIndex - 1;
      continue;
    }

    frontmatter[key] = "";
  }

  return {
    frontmatter,
    body: raw.slice(match[0].length,),
    hasFrontmatter: true,
  };
}

function buildMarkdownFrontmatter(frontmatter: FrontmatterRecord, body: string,): string {
  const entries = Object.entries(frontmatter,).filter(([, value,],) => value !== undefined);
  if (entries.length === 0) return body;

  const lines = entries.flatMap(([key, value,],) => {
    if (Array.isArray(value,)) {
      if (value.length === 0) return [`${key}: []`,];
      return [`${key}:`, ...value.map((item,) => `  - ${serializeFrontmatterScalar(item,)}`),];
    }

    return [`${key}: ${serializeFrontmatterScalar(value,)}`,];
  },);

  return `---\n${lines.join("\n",)}\n---\n${body}`;
}

function parseFrontmatter(raw: string,): { city: string | null; body: string; } {
  const { frontmatter, body, } = parseMarkdownFrontmatter(raw,);
  const city = typeof frontmatter.city === "string" ? frontmatter.city.trim() : "";
  return { city: city || null, body, };
}

function buildFrontmatter(city: string | null | undefined, body: string,): string {
  if (!city) return body;
  return buildMarkdownFrontmatter({ city, }, body,);
}

function isPageType(value: unknown,): value is PageType {
  return value === "page" || value === "meeting";
}

function toOptionalString(value: unknown,): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toStringArray(value: unknown,): string[] {
  if (!Array.isArray(value,)) return [];
  return value
    .filter((entry,): entry is string => typeof entry === "string")
    .map((entry,) => entry.trim())
    .filter(Boolean,);
}

function toOptionalNumber(value: unknown,) {
  if (typeof value !== "number" || !Number.isFinite(value,)) return null;
  return value;
}

function toOptionalObject(value: unknown,) {
  if (!value || typeof value !== "object" || Array.isArray(value,)) return null;
  return value as Record<string, unknown>;
}

function isMeetingSessionKind(value: unknown,): value is MeetingSessionKind {
  return value === "decision_making" || value === "informative";
}

function isLinkKind(value: unknown,): value is LinkKind {
  return value === "generic" || value === "github_pr" || value === "github_issue" || value === "github_commit";
}

function toLinkKind(frontmatter: PageFrontmatter,): LinkKind | null {
  if (isLinkKind(frontmatter.link_kind,)) return frontmatter.link_kind;

  const hasLegacyUrlSummaryMetadata = typeof frontmatter.link_title === "string"
    || typeof frontmatter.summary_updated_at === "string"
    || Array.isArray(frontmatter.follow_up_questions,);
  return hasLegacyUrlSummaryMetadata ? "generic" : null;
}

function toGitHubPrLinkData(value: unknown,): GitHubPrLinkData | null {
  const record = toOptionalObject(value,);
  const owner = toOptionalString(record?.owner,);
  const repo = toOptionalString(record?.repo,);
  const number = toOptionalNumber(record?.number,);
  const title = toOptionalString(record?.title,);
  const state = toOptionalString(record?.state,);
  if (!owner || !repo || number === null || !title || !state) return null;

  return {
    owner,
    repo,
    number,
    title,
    state,
    isDraft: record?.is_draft === true,
    isMerged: record?.is_merged === true,
    author: toOptionalString(record?.author,),
    baseBranch: toOptionalString(record?.base_branch,),
    headBranch: toOptionalString(record?.head_branch,),
    labels: toStringArray(record?.labels,),
    assignees: toStringArray(record?.assignees,),
    reviewers: toStringArray(record?.reviewers,),
    changedFilesCount: toOptionalNumber(record?.changed_files_count,),
    commitsCount: toOptionalNumber(record?.commits_count,),
    additions: toOptionalNumber(record?.additions,),
    deletions: toOptionalNumber(record?.deletions,),
    changedFiles: toStringArray(record?.changed_files,),
  };
}

function toGitHubIssueLinkData(value: unknown,): GitHubIssueLinkData | null {
  const record = toOptionalObject(value,);
  const owner = toOptionalString(record?.owner,);
  const repo = toOptionalString(record?.repo,);
  const number = toOptionalNumber(record?.number,);
  const title = toOptionalString(record?.title,);
  const state = toOptionalString(record?.state,);
  if (!owner || !repo || number === null || !title || !state) return null;

  return {
    owner,
    repo,
    number,
    title,
    state,
    author: toOptionalString(record?.author,),
    labels: toStringArray(record?.labels,),
    assignees: toStringArray(record?.assignees,),
    openedAt: toOptionalString(record?.opened_at,),
    closedAt: toOptionalString(record?.closed_at,),
  };
}

function toGitHubCommitLinkData(value: unknown,): GitHubCommitLinkData | null {
  const record = toOptionalObject(value,);
  const owner = toOptionalString(record?.owner,);
  const repo = toOptionalString(record?.repo,);
  const sha = toOptionalString(record?.sha,);
  const shortSha = toOptionalString(record?.short_sha,);
  const title = toOptionalString(record?.title,);
  if (!owner || !repo || !sha || !shortSha || !title) return null;

  return {
    owner,
    repo,
    sha,
    shortSha,
    title,
    author: toOptionalString(record?.author,),
    committedAt: toOptionalString(record?.committed_at,),
    changedFilesCount: toOptionalNumber(record?.changed_files_count,),
    additions: toOptionalNumber(record?.additions,),
    deletions: toOptionalNumber(record?.deletions,),
    changedFiles: toStringArray(record?.changed_files,),
  };
}

function toLinkData(kind: LinkKind | null, value: unknown,): LinkData | null {
  if (!kind || kind === "generic") return null;
  if (kind === "github_pr") return toGitHubPrLinkData(value,);
  if (kind === "github_issue") return toGitHubIssueLinkData(value,);
  return toGitHubCommitLinkData(value,);
}

function buildLinkDataFrontmatter(kind: LinkKind | null, value: LinkData | null,) {
  if (!kind || !value || kind === "generic") return undefined;

  if (kind === "github_pr") {
    const data = value as GitHubPrLinkData;
    return {
      owner: data.owner,
      repo: data.repo,
      number: data.number,
      title: data.title,
      state: data.state,
      is_draft: data.isDraft,
      is_merged: data.isMerged,
      author: data.author ?? undefined,
      base_branch: data.baseBranch ?? undefined,
      head_branch: data.headBranch ?? undefined,
      labels: data.labels,
      assignees: data.assignees,
      reviewers: data.reviewers,
      changed_files_count: data.changedFilesCount ?? undefined,
      commits_count: data.commitsCount ?? undefined,
      additions: data.additions ?? undefined,
      deletions: data.deletions ?? undefined,
      changed_files: data.changedFiles,
    };
  }

  if (kind === "github_issue") {
    const data = value as GitHubIssueLinkData;
    return {
      owner: data.owner,
      repo: data.repo,
      number: data.number,
      title: data.title,
      state: data.state,
      author: data.author ?? undefined,
      labels: data.labels,
      assignees: data.assignees,
      opened_at: data.openedAt ?? undefined,
      closed_at: data.closedAt ?? undefined,
    };
  }

  const data = value as GitHubCommitLinkData;
  return {
    owner: data.owner,
    repo: data.repo,
    sha: data.sha,
    short_sha: data.shortSha,
    title: data.title,
    author: data.author ?? undefined,
    committed_at: data.committedAt ?? undefined,
    changed_files_count: data.changedFilesCount ?? undefined,
    additions: data.additions ?? undefined,
    deletions: data.deletions ?? undefined,
    changed_files: data.changedFiles,
  };
}

function buildPageNote(
  title: string,
  path: string,
  content: string,
  frontmatter: PageFrontmatter,
  hasFrontmatter: boolean,
  attachedTo: string | null,
): PageNote {
  const linkKind = toLinkKind(frontmatter,);
  return {
    title,
    path,
    content,
    type: isPageType(frontmatter.type,) ? frontmatter.type : "page",
    attachedTo,
    eventId: toOptionalString(frontmatter.event_id,),
    startedAt: toOptionalString(frontmatter.started_at,),
    endedAt: toOptionalString(frontmatter.ended_at,),
    participants: toStringArray(frontmatter.participants,),
    location: toOptionalString(frontmatter.location,),
    executiveSummary: toOptionalString(frontmatter.executive_summary,),
    sessionKind: isMeetingSessionKind(frontmatter.session_kind,) ? frontmatter.session_kind : null,
    agenda: toStringArray(frontmatter.agenda,),
    actionItems: toStringArray(frontmatter.action_items,),
    source: toOptionalString(frontmatter.source,),
    linkTitle: toOptionalString(frontmatter.link_title,),
    summaryUpdatedAt: toOptionalString(frontmatter.summary_updated_at,),
    followUpQuestions: toStringArray(frontmatter.follow_up_questions,),
    linkKind,
    linkData: toLinkData(linkKind, frontmatter.link_data,),
    frontmatter,
    hasFrontmatter,
  };
}

function buildPageFrontmatter(page: PageNote,): FrontmatterRecord {
  const frontmatter: FrontmatterRecord = {};

  const hasKnownMetadata = page.hasFrontmatter
    || page.type !== "page"
    || !!page.eventId
    || !!page.startedAt
    || !!page.endedAt
    || page.participants.length > 0
    || !!page.location
    || !!page.executiveSummary
    || !!page.sessionKind
    || page.agenda.length > 0
    || page.actionItems.length > 0
    || !!page.source
    || !!page.linkTitle
    || !!page.summaryUpdatedAt
    || page.followUpQuestions.length > 0
    || !!page.linkKind
    || !!page.linkData;

  if (hasKnownMetadata) {
    frontmatter.type = page.type;
    if (page.eventId) frontmatter.event_id = page.eventId;
    if (page.startedAt) frontmatter.started_at = page.startedAt;
    if (page.endedAt) frontmatter.ended_at = page.endedAt;
    if (page.participants.length > 0) frontmatter.participants = page.participants;
    if (page.location) frontmatter.location = page.location;
    if (page.executiveSummary) frontmatter.executive_summary = page.executiveSummary;
    if (page.sessionKind) frontmatter.session_kind = page.sessionKind;
    if (page.agenda.length > 0) frontmatter.agenda = page.agenda;
    if (page.actionItems.length > 0) frontmatter.action_items = page.actionItems;
    if (page.source) frontmatter.source = page.source;
    if (page.linkTitle) frontmatter.link_title = page.linkTitle;
    if (page.summaryUpdatedAt) frontmatter.summary_updated_at = page.summaryUpdatedAt;
    if (page.followUpQuestions.length > 0) frontmatter.follow_up_questions = page.followUpQuestions;
    if (page.linkKind) frontmatter.link_kind = page.linkKind;
    const linkData = buildLinkDataFrontmatter(page.linkKind, page.linkData,);
    if (linkData) frontmatter.link_data = linkData;
  }

  for (const [key, value,] of Object.entries(page.frontmatter,)) {
    if (PAGE_FRONTMATTER_KEYS.has(key,) || value === undefined) continue;
    frontmatter[key] = value;
  }

  return frontmatter;
}

async function serializePageBody(page: PageNote,) {
  const json = parseJsonContent(page.content,);
  const indentation = await getMarkdownIndentation();
  let body = unresolveMarkdownImages(json2md(json, { indentation, },),);
  body = unresolveMarkdownAssetLinks(body,);
  body = convertAtMentionsToWikiLinks(body, page.attachedTo ?? getToday(),);
  body = await rewriteDateMentionLinksToNoteLinks(body,);
  return rewriteMarkdownPageLinksToCanonicalWikiLinks(body,);
}

function rewritePageLinksInMarkdown(markdown: string, currentTitle: string, nextTitle: string,) {
  const normalizedCurrentTitle = sanitizePageTitle(currentTitle,);
  const normalizedNextTitle = sanitizePageTitle(nextTitle,);
  if (
    !normalizedCurrentTitle
    || !normalizedNextTitle
    || normalizedCurrentTitle === normalizedNextTitle
  ) {
    return markdown;
  }

  return mapMarkdownOutsideCode(
    markdown,
    (part,) => {
      const withWikiLinks = part.replace(
        WIKI_LINK_RE,
        (full, target: string, label: string | undefined, offset: number, source: string,) => {
          if (offset > 0 && source[offset - 1] === "!") return full;
          if (target.includes("(due date)",)) return full;

          const linkedTitle = parsePageTitleFromLinkTarget(target,);
          if (linkedTitle !== normalizedCurrentTitle) return full;

          const nextTarget = buildPageLinkTarget(normalizedNextTitle,);
          const trimmedLabel = label?.trim();
          return trimmedLabel && trimmedLabel !== normalizedCurrentTitle
            ? `[[${nextTarget}|${trimmedLabel}]]`
            : `[[${nextTarget}]]`;
        },
      );

      return withWikiLinks.replace(
        MARKDOWN_LINK_RE,
        (full, label: string, target: string, titleAttr: string | undefined, offset: number, source: string,) => {
          if (offset > 0 && source[offset - 1] === "!") return full;

          const linkedTitle = parsePageTitleFromLinkTarget(target,);
          if (linkedTitle !== normalizedCurrentTitle) return full;

          const trimmedLabel = label.trim();
          const nextLabel = !trimmedLabel || trimmedLabel === normalizedCurrentTitle
            ? normalizedNextTitle
            : label;
          const nextTarget = buildPageMarkdownHref(normalizedNextTitle,);
          return titleAttr ? `[${nextLabel}](${nextTarget} "${titleAttr}")` : `[${nextLabel}](${nextTarget})`;
        },
      );
    },
  );
}

async function listMarkdownFiles(rootDir: string,): Promise<string[]> {
  const entries = await readDir(rootDir,);
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.name) continue;

    const path = await join(rootDir, entry.name,);
    if (entry.isDirectory) {
      files.push(...await listMarkdownFiles(path,),);
      continue;
    }

    if (entry.isFile && entry.name.toLowerCase().endsWith(".md",)) {
      files.push(path,);
    }
  }

  return files;
}

function normalizeComparablePath(path: string,) {
  return path.replace(/\\/g, "/",).toLowerCase();
}

async function rewritePageLinksInFiles(
  currentTitle: string,
  nextTitle: string,
  ignoredPaths: Set<string>,
) {
  if (sanitizePageTitle(currentTitle,) === sanitizePageTitle(nextTitle,)) {
    return;
  }

  const roots = new Set<string>([await getJournalDir(), await getPagesDir(),],);
  const candidatePaths = new Set<string>();

  for (const root of roots) {
    for (const path of await listMarkdownFiles(root,)) {
      candidatePaths.add(path,);
    }
  }

  for (const path of candidatePaths) {
    if (ignoredPaths.has(normalizeComparablePath(path,),)) {
      continue;
    }

    const raw = await invoke<string | null>("read_markdown_file", { path, },);
    if (!raw) continue;

    const { frontmatter, body, } = parseMarkdownFrontmatter(raw,);
    const nextBody = rewritePageLinksInMarkdown(body, currentTitle, nextTitle,);
    if (nextBody === body) continue;

    await invoke("write_markdown_file", {
      path,
      content: buildMarkdownFrontmatter(frontmatter, nextBody,),
    },);
  }
}

function extractLinkedPageTitles(markdown: string,): string[] {
  const titles = new Set<string>();

  mapMarkdownOutsideCode(markdown, (part,) => {
    part.replace(WIKI_LINK_RE, (full, target: string, _label: string | undefined, offset: number, source: string,) => {
      if (offset > 0 && source[offset - 1] === "!") return full;
      if (target.includes("(due date)",)) return full;
      const title = parsePageTitleFromLinkTarget(target,);
      if (title) titles.add(title,);
      return full;
    },);

    part.replace(
      MARKDOWN_LINK_RE,
      (full, _label: string, target: string, _titleAttr: string | undefined, offset: number, source: string,) => {
        if (offset > 0 && source[offset - 1] === "!") return full;
        const title = parsePageTitleFromLinkTarget(target,);
        if (title) titles.add(title,);
        return full;
      },
    );

    return part;
  },);

  return [...titles,];
}

async function findDateLinkingToPage(title: string,): Promise<string | null> {
  const normalizedTitle = sanitizePageTitle(title,);
  if (!normalizedTitle) return null;

  const journalDir = await getJournalDir();
  const results = await invoke<MarkdownSearchResult[]>("search_markdown_files", {
    rootDir: journalDir,
    query: normalizedTitle,
    limit: 200,
  },);

  const pattern = await getFilenamePattern().catch(() => DEFAULT_FILENAME_PATTERN);
  const dailyLogsFolder = await getDailyLogsFolderSetting().catch(() => "");
  const linkedDates = new Set<string>();

  for (const result of results) {
    const date = parseDateFromNoteLinkTarget(result.relativePath, pattern, dailyLogsFolder,);
    if (!date || linkedDates.has(date,)) continue;

    const raw = await invoke<string | null>("read_markdown_file", { path: result.path, },);
    if (!raw) continue;

    const { body, } = parseFrontmatter(raw,);
    if (!extractLinkedPageTitles(body,).includes(normalizedTitle,)) continue;

    linkedDates.add(date,);
  }

  const sortedDates = [...linkedDates,].sort();
  return sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : null;
}

async function getMarkdownIndentation() {
  const vaultDir = (await getVaultDirSetting()).trim();
  if (!vaultDir) return undefined;
  return { style: "tab", size: 1, } as const;
}

export async function saveDailyNote(note: DailyNote,): Promise<void> {
  const filepath = await getNotePath(note.date,);
  const json = parseJsonContent(note.content,);
  const indentation = await getMarkdownIndentation();
  let body = unresolveMarkdownImages(json2md(json, { indentation, },),);
  body = unresolveMarkdownAssetLinks(body,);
  body = convertAtMentionsToWikiLinks(body, note.date,);
  body = await rewriteDateMentionLinksToNoteLinks(body,);
  body = rewriteMarkdownPageLinksToCanonicalWikiLinks(body,);
  await invoke("write_markdown_file", {
    path: filepath,
    content: buildFrontmatter(note.city, body,),
  },);
}

export async function loadDailyNote(date: string,): Promise<DailyNote | null> {
  const filepath = await getNotePath(date,);
  const raw = await invoke<string | null>("read_markdown_file", { path: filepath, },);
  if (!raw) {
    return null;
  }
  const { city, body, } = parseFrontmatter(raw,);
  const withDateMentionLinks = await rewriteNoteLinksToDateMentionLinks(body,);
  const withEmbeds = await resolveExcalidrawEmbeds(withDateMentionLinks,);
  const withWidgets = await resolveWidgetEmbeds(withEmbeds,);
  const withMentionChips = replaceMentionWikiLinksWithChips(withWidgets, date,);
  const withPageLinks = rewriteWikiPageLinksToMarkdownLinks(withMentionChips,);
  const withAssetLinks = await resolveMarkdownAssetLinks(withPageLinks,);
  const resolved = await resolveMarkdownImages(withAssetLinks,);
  const indentation = await getMarkdownIndentation();
  const content = JSON.stringify(md2json(resolved, { indentation, },),);
  return { date, content, city, };
}

export async function loadPage(title: string,): Promise<PageNote | null> {
  const filepath = await getPagePath(title,);
  const raw = await invoke<string | null>("read_markdown_file", { path: filepath, },);
  if (!raw) {
    return null;
  }

  const { frontmatter, body, hasFrontmatter, } = parseMarkdownFrontmatter(raw,);
  const attachedTo = await findDateLinkingToPage(title,) ?? toOptionalString(frontmatter.attached_to,);
  const referenceDate = attachedTo ?? getToday();
  const withDateMentionLinks = await rewriteNoteLinksToDateMentionLinks(body,);
  const withEmbeds = await resolveExcalidrawEmbeds(withDateMentionLinks,);
  const withWidgets = await resolveWidgetEmbeds(withEmbeds,);
  const withMentionChips = replaceMentionWikiLinksWithChips(withWidgets, referenceDate,);
  const withPageLinks = rewriteWikiPageLinksToMarkdownLinks(withMentionChips,);
  const withAssetLinks = await resolveMarkdownAssetLinks(withPageLinks,);
  const resolved = await resolveMarkdownImages(withAssetLinks,);
  const indentation = await getMarkdownIndentation();
  const content = JSON.stringify(md2json(resolved, { indentation, },),);

  return buildPageNote(
    sanitizePageTitle(title,),
    filepath,
    content,
    frontmatter as PageFrontmatter,
    hasFrontmatter,
    attachedTo,
  );
}

export async function loadPageByPath(path: string,): Promise<PageNote | null> {
  const pagesDir = await getPagesDir().catch(() => null);
  const normalizedPath = path.replace(/\\/g, "/",);
  const normalizedPagesDir = pagesDir?.replace(/\\/g, "/",).replace(/\/+$/, "",);
  const relativePath = normalizedPagesDir && normalizedPath.startsWith(`${normalizedPagesDir}/`,)
    ? normalizedPath.slice(normalizedPagesDir.length + 1,)
    : null;
  const title = relativePath
    ? parsePageTitleFromLinkTarget(relativePath,)
    : parsePageTitleFromPath(path,);
  if (!title) return null;
  return await loadPage(title,);
}

export async function savePage(page: PageNote,): Promise<void> {
  const filepath = page.path || await getPagePath(page.title,);
  await invoke("write_markdown_file", {
    path: filepath,
    content: buildMarkdownFrontmatter(buildPageFrontmatter(page,), await serializePageBody(page,),),
  },);
}

export async function deletePage(title: string,): Promise<void> {
  const path = await getPagePath(title,);
  if (await exists(path,)) {
    await remove(path,);
  }
}

export async function renamePage(page: PageNote, nextTitle: string,): Promise<PageNote> {
  const currentTitle = sanitizePageTitle(page.title,);
  const normalizedNextTitle = replacePageTitleBasename(currentTitle, nextTitle,);
  if (!normalizedNextTitle) {
    throw new Error("Page title is required.",);
  }

  if (normalizedNextTitle === currentTitle) {
    return page;
  }

  const currentPath = page.path || await getPagePath(currentTitle,);
  const nextPath = await getPagePath(normalizedNextTitle,);
  const isCaseOnlyRename = currentTitle.toLowerCase() === normalizedNextTitle.toLowerCase();

  if (currentPath !== nextPath && !isCaseOnlyRename && await exists(nextPath,)) {
    throw new Error("A page with this title already exists.",);
  }

  if (currentPath !== nextPath && await exists(currentPath,)) {
    const nextDir = await dirname(nextPath,);
    if (!await exists(nextDir,)) {
      await mkdir(nextDir, { recursive: true, },);
    }
    await rename(currentPath, nextPath,);
  }

  const nextPage = {
    ...page,
    title: normalizedNextTitle,
    path: nextPath,
  };

  await invoke("write_markdown_file", {
    path: nextPath,
    content: buildMarkdownFrontmatter(
      buildPageFrontmatter(nextPage,),
      rewritePageLinksInMarkdown(await serializePageBody(nextPage,), currentTitle, normalizedNextTitle,),
    ),
  },);

  await rewritePageLinksInFiles(
    currentTitle,
    normalizedNextTitle,
    new Set([
      normalizeComparablePath(currentPath,),
      normalizeComparablePath(nextPath,),
    ],),
  );

  const reloaded = await loadPage(normalizedNextTitle,);
  if (!reloaded) {
    throw new Error("Could not load renamed page.",);
  }

  return reloaded;
}

export async function createAttachedPage({
  title,
}: {
  title: string;
},): Promise<PageNote> {
  const normalizedTitle = parsePageTitleFromLinkTarget(title,) ?? sanitizePageTitle(title.replace(/\.md$/i, "",),);
  if (!normalizedTitle) {
    throw new Error("Page title is required.",);
  }

  const path = await getPagePath(normalizedTitle,);
  const existing = await invoke<string | null>("read_markdown_file", { path, },);
  if (existing) {
    const page = await loadPage(normalizedTitle,);
    if (!page) {
      throw new Error("Could not load existing page.",);
    }
    return page;
  }

  const page = buildPageNote(
    normalizedTitle,
    path,
    JSON.stringify(EMPTY_DOC,),
    {
      type: "page",
    },
    true,
    null,
  );
  await savePage(page,);
  return page;
}

export async function createUntitledAttachedPage(): Promise<PageNote> {
  const baseTitle = "Untitled";
  let candidate = baseTitle;
  let suffix = 2;

  while (await exists(await getPagePath(candidate,),)) {
    candidate = `${baseTitle} ${suffix}`;
    suffix += 1;
  }

  return await createAttachedPage({ title: candidate, },);
}

export async function listPagesAttachedTo(date: string,): Promise<AttachedPage[]> {
  const raw = await invoke<string | null>("read_markdown_file", { path: await getNotePath(date,), },);
  if (!raw) return [];

  const { body, } = parseFrontmatter(raw,);
  const titles = extractLinkedPageTitles(body,);
  const pages = await Promise.all(
    titles.map(async (title,) => {
      const path = await getPagePath(title,);
      const pageRaw = await invoke<string | null>("read_markdown_file", { path, },);
      if (!pageRaw) return null;
      const { frontmatter, } = parseMarkdownFrontmatter(pageRaw,);

      return {
        title,
        path,
        type: isPageType(frontmatter.type,) ? frontmatter.type : "page",
      } satisfies AttachedPage;
    },),
  );

  return pages.filter((page,): page is AttachedPage => page !== null);
}

export async function createEmptyDailyNote(date: string,): Promise<DailyNote> {
  const note: DailyNote = {
    date,
    content: JSON.stringify(EMPTY_DOC,),
  };

  await saveDailyNote(note,);
  return note;
}

export async function getOrCreateDailyNote(date: string,): Promise<DailyNote> {
  const existing = await loadDailyNote(date,);
  if (existing) {
    return existing;
  }
  return createEmptyDailyNote(date,);
}

/**
 * Load existing past notes (does NOT create missing ones).
 * Checks the past `days` days and returns only notes that exist on disk.
 */
export async function loadPastNotes(days: number = 30,): Promise<DailyNote[]> {
  const results = await Promise.all(
    Array.from({ length: days, }, (_, i,) => loadDailyNote(getDaysAgo(i + 1,),),),
  );
  return results.filter((note,): note is DailyNote => note !== null);
}
