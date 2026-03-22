import { invoke, } from "@tauri-apps/api/core";
import { exists, } from "@tauri-apps/plugin-fs";
import { EMPTY_DOC, json2md, md2json, parseJsonContent, } from "../lib/markdown";
import {
  AttachedPage,
  DailyNote,
  getDaysAgo,
  getToday,
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
  isExplicitPageLinkTarget,
  parseDateFromNoteLinkTarget,
  parsePageTitleFromLinkTarget,
  parsePageTitleFromPath,
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
  "source",
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

function buildPageNote(
  title: string,
  path: string,
  content: string,
  frontmatter: PageFrontmatter,
  hasFrontmatter: boolean,
  attachedTo: string | null,
): PageNote {
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
    source: toOptionalString(frontmatter.source,),
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
    || !!page.source;

  if (hasKnownMetadata) {
    frontmatter.type = page.type;
    if (page.eventId) frontmatter.event_id = page.eventId;
    if (page.startedAt) frontmatter.started_at = page.startedAt;
    if (page.endedAt) frontmatter.ended_at = page.endedAt;
    if (page.participants.length > 0) frontmatter.participants = page.participants;
    if (page.source) frontmatter.source = page.source;
  }

  for (const [key, value,] of Object.entries(page.frontmatter,)) {
    if (PAGE_FRONTMATTER_KEYS.has(key,) || value === undefined) continue;
    frontmatter[key] = value;
  }

  return frontmatter;
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
  const title = parsePageTitleFromPath(path,);
  if (!title) return null;
  return await loadPage(title,);
}

export async function savePage(page: PageNote,): Promise<void> {
  const filepath = page.path || await getPagePath(page.title,);
  const json = parseJsonContent(page.content,);
  const indentation = await getMarkdownIndentation();
  let body = unresolveMarkdownImages(json2md(json, { indentation, },),);
  body = unresolveMarkdownAssetLinks(body,);
  body = convertAtMentionsToWikiLinks(body, page.attachedTo ?? getToday(),);
  body = await rewriteDateMentionLinksToNoteLinks(body,);
  body = rewriteMarkdownPageLinksToCanonicalWikiLinks(body,);
  await invoke("write_markdown_file", {
    path: filepath,
    content: buildMarkdownFrontmatter(buildPageFrontmatter(page,), body,),
  },);
}

export async function createAttachedPage({
  title,
}: {
  title: string;
},): Promise<PageNote> {
  const normalizedTitle = sanitizePageTitle(title.replace(/\.md$/i, "",),);
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
