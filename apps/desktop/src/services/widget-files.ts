import { dirname, join, } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile, writeTextFile, } from "@tauri-apps/plugin-fs";
import { getJournalDir, getWidgetsDir, } from "./paths";
import { getVaultDirSetting, } from "./settings";

const OBSIDIAN_EMBED_RE = /!\[\[([^[\]]+)\]\]/g;
const WIDGET_SUFFIX = ".widget.md";

export interface WidgetFileRecord {
  id: string;
  title: string;
  prompt: string;
  saved: boolean;
  spec: string;
  libraryItemId?: string | null;
  componentId?: string | null;
  file: string;
  path: string;
}

interface WidgetFileInput {
  title: string;
  prompt: string;
  spec: string;
  saved?: boolean;
  libraryItemId?: string | null;
  componentId?: string | null;
}

function escapeAttr(s: string,): string {
  return s
    .replace(/&/g, "&amp;",)
    .replace(/"/g, "&quot;",)
    .replace(/</g, "&lt;",)
    .replace(/>/g, "&gt;",);
}

function frontmatterValue(raw: string,): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed,);
    return typeof parsed === "string" ? parsed : String(parsed,);
  } catch {
    return trimmed;
  }
}

function normalizeTitle(raw: string,): string {
  const value = raw.trim();
  return value || "Widget";
}

function normalizeSlug(raw: string,): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-",).replace(/^-+|-+$/g, "",);
  return slug || "widget";
}

function normalizeWidgetEmbedTarget(target: string,): string {
  const [pathOnly,] = target.split("|", 1,);
  const trimmed = pathOnly.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower.endsWith(WIDGET_SUFFIX,)) return trimmed;
  if (lower.endsWith(".widget",)) return `${trimmed}.md`;
  return `${trimmed}${WIDGET_SUFFIX}`;
}

function isWidgetEmbed(target: string,): boolean {
  const [pathOnly,] = target.split("|", 1,);
  const normalized = pathOnly.trim().toLowerCase();
  return normalized.endsWith(WIDGET_SUFFIX,) || normalized.endsWith(".widget",);
}

function parseWidgetMarkdown(raw: string, file: string, path: string,): WidgetFileRecord | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/,);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n",)) {
    const separator = line.indexOf(":",);
    if (separator < 0) continue;
    const key = line.slice(0, separator,).trim();
    if (!key) continue;
    meta[key] = frontmatterValue(line.slice(separator + 1,),);
  }

  const specMatch = match[2].match(/```(?:json|jsonc|jsonui|json-render)?\n([\s\S]*?)```/,);
  const spec = specMatch?.[1]?.trim();
  if (!meta.id || !meta.prompt || !spec) return null;

  return {
    id: meta.id,
    title: meta.title || "Widget",
    prompt: meta.prompt,
    saved: meta.saved === "true",
    libraryItemId: meta.libraryItemId || meta.componentId || null,
    spec,
    componentId: meta.componentId || null,
    file,
    path,
  };
}

function serializeWidgetMarkdown(record: WidgetFileRecord,): string {
  return [
    "---",
    `id: ${JSON.stringify(record.id,)}`,
    `title: ${JSON.stringify(record.title,)}`,
    `prompt: ${JSON.stringify(record.prompt,)}`,
    `saved: ${record.saved ? "true" : "false"}`,
    ...(record.libraryItemId ? [`libraryItemId: ${JSON.stringify(record.libraryItemId,)}`,] : []),
    ...(record.componentId ? [`componentId: ${JSON.stringify(record.componentId,)}`,] : []),
    "---",
    "",
    "```json",
    (() => {
      try {
        return JSON.stringify(JSON.parse(record.spec,), null, 2,);
      } catch {
        return record.spec.trim();
      }
    })(),
    "```",
    "",
  ].join("\n",);
}

function toWidgetHtml(record: WidgetFileRecord,): string {
  const attrs = ['data-widget=""',];
  attrs.push(`data-id="${escapeAttr(record.id,)}"`,);
  attrs.push(`data-file="${escapeAttr(record.file,)}"`,);
  attrs.push(`data-path="${escapeAttr(record.path,)}"`,);
  attrs.push(`data-prompt="${escapeAttr(record.prompt,)}"`,);
  attrs.push(`data-spec="${escapeAttr(record.spec,)}"`,);
  if (record.saved) attrs.push('data-saved="true"',);
  if (record.libraryItemId) {
    attrs.push(`data-library-item-id="${escapeAttr(record.libraryItemId,)}"`,);
  }
  if (record.componentId) {
    attrs.push(`data-component-id="${escapeAttr(record.componentId,)}"`,);
  }
  return `<div ${attrs.join(" ",)}></div>`;
}

async function resolveWidgetPathCandidates(target: string,): Promise<string[]> {
  const widgetsDir = await getWidgetsDir();
  const journalDir = await getJournalDir();
  const vaultDir = (await getVaultDirSetting()).trim();
  const basename = target.split("/",).filter(Boolean,).pop() ?? target;
  const candidates = new Set<string>();

  if (target.startsWith("/",) || /^[A-Za-z]:[\\/]/.test(target,)) {
    candidates.add(target,);
    return [...candidates,];
  }

  if (target.includes("/",)) {
    if (vaultDir) candidates.add(await join(vaultDir, target,),);
    candidates.add(await join(journalDir, target,),);
    candidates.add(await join(widgetsDir, basename,),);
    return [...candidates,];
  }

  candidates.add(await join(widgetsDir, basename,),);
  if (vaultDir) candidates.add(await join(vaultDir, basename,),);
  candidates.add(await join(journalDir, basename,),);
  return [...candidates,];
}

export async function resolveWidgetEmbedPath(target: string,): Promise<string | null> {
  const normalizedTarget = normalizeWidgetEmbedTarget(target,);
  if (!normalizedTarget) return null;

  for (const candidate of await resolveWidgetPathCandidates(normalizedTarget,)) {
    if (await exists(candidate,)) return candidate;
  }
  return null;
}

export async function readWidgetFile(path: string, file: string,): Promise<WidgetFileRecord | null> {
  try {
    const raw = await readTextFile(path,);
    return parseWidgetMarkdown(raw, file, path,);
  } catch {
    return null;
  }
}

export async function resolveWidgetEmbeds(markdown: string,): Promise<string> {
  let output = "";
  let lastIndex = 0;

  for (const match of markdown.matchAll(OBSIDIAN_EMBED_RE,)) {
    const fullMatch = match[0];
    const rawTarget = match[1];
    const matchIndex = match.index ?? 0;

    output += markdown.slice(lastIndex, matchIndex,);
    lastIndex = matchIndex + fullMatch.length;

    if (!isWidgetEmbed(rawTarget,)) {
      output += fullMatch;
      continue;
    }

    const normalizedTarget = normalizeWidgetEmbedTarget(rawTarget,);
    const resolvedPath = await resolveWidgetEmbedPath(normalizedTarget,);
    if (!resolvedPath) {
      output += fullMatch;
      continue;
    }

    const record = await readWidgetFile(resolvedPath, normalizedTarget,);
    output += record ? toWidgetHtml(record,) : fullMatch;
  }

  output += markdown.slice(lastIndex,);
  return output;
}

async function ensureParentDir(path: string,): Promise<void> {
  const parent = await dirname(path,);
  if (!(await exists(parent,))) {
    await mkdir(parent, { recursive: true, },);
  }
}

export async function createWidgetFile(input: WidgetFileInput,): Promise<WidgetFileRecord> {
  const widgetsDir = await getWidgetsDir();
  if (!(await exists(widgetsDir,))) {
    await mkdir(widgetsDir, { recursive: true, },);
  }

  const id = crypto.randomUUID();
  const title = normalizeTitle(input.title,);
  const filename = `${normalizeSlug(title,)}-${id}${WIDGET_SUFFIX}`;
  const file = `widgets/${filename}`;
  const path = await join(widgetsDir, filename,);
  const record: WidgetFileRecord = {
    id,
    title,
    prompt: input.prompt,
    saved: input.saved ?? false,
    spec: input.spec,
    libraryItemId: input.libraryItemId ?? null,
    componentId: input.componentId ?? null,
    file,
    path,
  };
  await writeTextFile(path, serializeWidgetMarkdown(record,),);
  return record;
}

export async function updateWidgetFile(
  path: string,
  file: string,
  input: Omit<WidgetFileRecord, "path" | "file">,
): Promise<WidgetFileRecord> {
  const record: WidgetFileRecord = {
    ...input,
    file,
    path,
  };
  await ensureParentDir(path,);
  await writeTextFile(path, serializeWidgetMarkdown(record,),);
  return record;
}

async function listWidgetFilePaths(dir: string,): Promise<string[]> {
  const entries = await readDir(dir,);
  const nested = await Promise.all(
    entries.map(async (entry: { isDirectory?: boolean; isFile?: boolean; name: string; },) => {
      if (entry.isDirectory) {
        const childDir = await join(dir, entry.name,);
        return await listWidgetFilePaths(childDir,);
      }

      if (!entry.isFile || !entry.name.toLowerCase().endsWith(WIDGET_SUFFIX,)) {
        return [];
      }

      return [await join(dir, entry.name,),];
    },),
  );

  return nested.flat();
}

export async function markWidgetLibraryReferenceRemoved(libraryItemId: string,): Promise<void> {
  const widgetsDir = await getWidgetsDir();
  if (!(await exists(widgetsDir,))) {
    return;
  }

  const paths = await listWidgetFilePaths(widgetsDir,);
  await Promise.all(paths.map(async (path,) => {
    const file = path.startsWith(`${widgetsDir}/`,) ? `widgets/${path.slice(widgetsDir.length + 1,)}` : path;
    const record = await readWidgetFile(path, file,);
    if (!record) return;
    if (record.libraryItemId !== libraryItemId && record.componentId !== libraryItemId) {
      return;
    }

    await updateWidgetFile(path, file, {
      ...record,
      saved: false,
      libraryItemId: null,
      componentId: record.componentId === libraryItemId ? null : record.componentId,
    },);
  },),);
}
