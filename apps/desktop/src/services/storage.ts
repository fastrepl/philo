import { invoke, } from "@tauri-apps/api/core";
import { EMPTY_DOC, json2md, md2json, parseJsonContent, } from "../lib/markdown";
import { DailyNote, getDaysAgo, } from "../types/note";
import { resolveExcalidrawEmbeds, } from "./excalidraw";
import { resolveMarkdownImages, unresolveMarkdownImages, } from "./images";
import { convertAtMentionsToWikiLinks, } from "./mentions";
import { getNotePath, } from "./paths";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

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

export async function saveDailyNote(note: DailyNote,): Promise<void> {
  const filepath = await getNotePath(note.date,);
  const json = parseJsonContent(note.content,);
  let body = unresolveMarkdownImages(json2md(json,),);
  body = convertAtMentionsToWikiLinks(body, note.date,);
  if (!body.endsWith("\n",)) body += "\n";
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
  const withEmbeds = await resolveExcalidrawEmbeds(body,);
  const resolved = await resolveMarkdownImages(withEmbeds,);
  const content = JSON.stringify(md2json(resolved,),);
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
