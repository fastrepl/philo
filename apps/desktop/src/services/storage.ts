import { invoke, } from "@tauri-apps/api/core";
import { EMPTY_DOC, json2md, md2json, parseJsonContent, } from "../lib/markdown";
import { DailyNote, getDaysAgo, } from "../types/note";
import { resolveExcalidrawEmbeds, } from "./excalidraw";
import { resolveMarkdownImages, unresolveMarkdownImages, } from "./images";
import { convertAtMentionsToWikiLinks, replaceMentionWikiLinksWithChips, } from "./mentions";
import { getNoteLinkTarget, getNotePath, parseDateFromNoteLinkTarget, } from "./paths";
import {
  DEFAULT_FILENAME_PATTERN,
  getDailyLogsFolderSetting,
  getFilenamePattern,
  getVaultDirSetting,
} from "./settings";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const CANONICAL_DUE_LINK_RE = /\[\[(\d{4}-\d{2}-\d{2})\(due date\)\]\]/g;
const WIKI_LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;

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

function parseFrontmatter(raw: string,): { city: string | null; body: string; } {
  const match = raw.match(FRONTMATTER_RE,);
  if (!match) return { city: null, body: raw, };
  const cityMatch = match[1].match(/^city:\s*(.+)$/m,);
  return {
    city: cityMatch ? cityMatch[1].trim() : null,
    body: raw.slice(match[0].length,),
  };
}

function buildFrontmatter(city: string | null | undefined, body: string,): string {
  if (!city) return body;
  return `---\ncity: ${city}\n---\n${body}`;
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
  body = convertAtMentionsToWikiLinks(body, note.date,);
  body = await rewriteDateMentionLinksToNoteLinks(body,);
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
  const withMentionChips = replaceMentionWikiLinksWithChips(withEmbeds, date,);
  const resolved = await resolveMarkdownImages(withMentionChips,);
  const indentation = await getMarkdownIndentation();
  const content = JSON.stringify(md2json(resolved, { indentation, },),);
  return { date, content, city, };
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
