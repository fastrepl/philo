import { dirname, join, } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile, writeTextFile, } from "@tauri-apps/plugin-fs";
import type { SharedStorageSchema, } from "./library";
import { getJournalDir, getWidgetsDir, } from "./paths";
import { getVaultDirSetting, } from "./settings";
import { compactWidgetSpec, encodeWidgetDataAttr, escapeWidgetHtmlAttr, } from "./widget-attrs";
import { ensureWidgetStorage, parseStorageSchema, stringifyStorageSchema, } from "./widget-storage";

const OBSIDIAN_EMBED_RE = /!\[\[([^[\]]+)\]\]/g;
const WIDGET_SUFFIX = ".widget.md";
const WIDGET_HISTORY_INFO = "json widget-history";
const WIDGET_STORAGE_INFO = "json widget-storage";
const WIDGET_SOURCE_INFO = "tsx widget";
const CODE_BLOCK_RE = /```([^\n]*)\n([\s\S]*?)```/g;

export type WidgetRuntimeKind = "json" | "code";

export interface WidgetRevisionRecord {
  id: string;
  createdAt: string;
  prompt: string;
  spec: string;
}

export interface WidgetFileRecord {
  id: string;
  title: string;
  prompt: string;
  runtime: WidgetRuntimeKind;
  favorite: boolean;
  saved: boolean;
  spec: string;
  source: string;
  currentRevisionId: string;
  revisions: WidgetRevisionRecord[];
  libraryItemId?: string | null;
  componentId?: string | null;
  storageSchema?: SharedStorageSchema | null;
  file: string;
  path: string;
}

interface WidgetFileInput {
  title: string;
  prompt: string;
  spec: string;
  runtime?: WidgetRuntimeKind;
  source?: string;
  favorite?: boolean;
  saved?: boolean;
  currentRevisionId?: string;
  revisions?: WidgetRevisionRecord[];
  libraryItemId?: string | null;
  componentId?: string | null;
  storageSchema?: SharedStorageSchema | null;
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

function createWidgetRevision(prompt: string, spec: string,): WidgetRevisionRecord {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    prompt,
    spec,
  };
}

function getWidgetPrimaryContent(record: Pick<WidgetFileRecord, "runtime" | "spec" | "source">,): string {
  return record.runtime === "code" ? record.source : record.spec;
}

function normalizeSpecForComparison(spec: string,): string {
  try {
    return JSON.stringify(JSON.parse(spec,),);
  } catch {
    return spec.trim();
  }
}

function buildLegacyHistory(prompt: string, spec: string,): {
  currentRevisionId: string;
  revisions: WidgetRevisionRecord[];
} {
  const revision = createWidgetRevision(prompt, spec,);
  return {
    currentRevisionId: revision.id,
    revisions: [revision,],
  };
}

function parseHistoryBlock(raw: string,): {
  currentRevisionId: string;
  revisions: WidgetRevisionRecord[];
} | null {
  try {
    const parsed = JSON.parse(raw,) as {
      currentRevisionId?: string;
      revisions?: Array<Partial<WidgetRevisionRecord>>;
    };
    if (!parsed || typeof parsed !== "object") return null;

    const revisions = Array.isArray(parsed.revisions,)
      ? parsed.revisions.flatMap((revision,) => {
        if (!revision || typeof revision !== "object") return [];
        if (typeof revision.id !== "string" || !revision.id.trim()) return [];
        if (typeof revision.createdAt !== "string" || !revision.createdAt.trim()) return [];
        if (typeof revision.prompt !== "string") return [];
        if (typeof revision.spec !== "string") return [];
        return [{
          id: revision.id,
          createdAt: revision.createdAt,
          prompt: revision.prompt,
          spec: revision.spec,
        },];
      },)
      : [];

    if (!revisions.length) return null;

    const currentRevisionId = typeof parsed.currentRevisionId === "string"
        && revisions.some((revision,) => revision.id === parsed.currentRevisionId)
      ? parsed.currentRevisionId
      : revisions[revisions.length - 1]?.id;

    if (!currentRevisionId) return null;
    return { currentRevisionId, revisions, };
  } catch {
    return null;
  }
}

function parseStorageBlock(raw: string,): SharedStorageSchema | null {
  return parseStorageSchema(raw,);
}

function ensureWidgetHistory(
  record: Pick<WidgetFileRecord, "prompt" | "runtime" | "spec" | "source" | "currentRevisionId" | "revisions">,
): {
  currentRevisionId: string;
  revisions: WidgetRevisionRecord[];
} {
  if (!record.revisions.length) {
    return buildLegacyHistory(record.prompt, getWidgetPrimaryContent(record,),);
  }

  const currentRevisionId = record.revisions.some((revision,) => revision.id === record.currentRevisionId)
    ? record.currentRevisionId
    : record.revisions[record.revisions.length - 1]!.id;

  return {
    currentRevisionId,
    revisions: record.revisions,
  };
}

export function appendWidgetRevision(
  record: Pick<WidgetFileRecord, "prompt" | "runtime" | "spec" | "source" | "currentRevisionId" | "revisions">,
  nextPrompt: string,
  nextSpec: string,
): {
  currentRevisionId: string;
  revisions: WidgetRevisionRecord[];
} {
  const history = ensureWidgetHistory(record,);
  const currentRevision = history.revisions.find((revision,) => revision.id === history.currentRevisionId)
    ?? history.revisions[history.revisions.length - 1];

  if (
    currentRevision
    && currentRevision.prompt === nextPrompt
    && normalizeSpecForComparison(currentRevision.spec,) === normalizeSpecForComparison(nextSpec,)
  ) {
    return history;
  }

  const nextRevision = createWidgetRevision(nextPrompt, nextSpec,);
  return {
    currentRevisionId: nextRevision.id,
    revisions: [...history.revisions, nextRevision,],
  };
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

  const runtime = meta.runtime === "code" ? "code" : "json";
  let spec: string | null = null;
  let source = "";
  let historyBlock: { currentRevisionId: string; revisions: WidgetRevisionRecord[]; } | null = null;
  let storageSchema: SharedStorageSchema | null = null;

  for (const block of match[2].matchAll(CODE_BLOCK_RE,)) {
    const info = block[1].trim().toLowerCase();
    const content = block[2].trim();
    if (!content) continue;

    if (info === WIDGET_HISTORY_INFO) {
      historyBlock = parseHistoryBlock(content,);
      continue;
    }

    if (info === WIDGET_STORAGE_INFO) {
      storageSchema = parseStorageBlock(content,);
      continue;
    }

    if (info === WIDGET_SOURCE_INFO) {
      source = content;
      continue;
    }

    if (!spec && runtime !== "code") {
      spec = content;
    }
  }

  if (!meta.id || !meta.prompt || (runtime === "json" && !spec) || (runtime === "code" && !source)) return null;

  const history = historyBlock ?? buildLegacyHistory(meta.prompt, runtime === "code" ? source : spec!,);

  return {
    id: meta.id,
    title: meta.title || "Widget",
    prompt: meta.prompt,
    runtime,
    favorite: meta.favorite === "true",
    saved: meta.saved === "true",
    currentRevisionId: history.currentRevisionId,
    revisions: history.revisions,
    libraryItemId: meta.libraryItemId || meta.componentId || null,
    spec: spec ?? "",
    source,
    componentId: meta.componentId || null,
    storageSchema,
    file,
    path,
  };
}

function serializeWidgetMarkdown(record: WidgetFileRecord,): string {
  const history = ensureWidgetHistory(record,);
  return [
    "---",
    `id: ${JSON.stringify(record.id,)}`,
    `title: ${JSON.stringify(record.title,)}`,
    `prompt: ${JSON.stringify(record.prompt,)}`,
    `runtime: ${JSON.stringify(record.runtime,)}`,
    `favorite: ${record.favorite ? "true" : "false"}`,
    `saved: ${record.saved ? "true" : "false"}`,
    ...(record.libraryItemId ? [`libraryItemId: ${JSON.stringify(record.libraryItemId,)}`,] : []),
    ...(record.componentId ? [`componentId: ${JSON.stringify(record.componentId,)}`,] : []),
    "---",
    "",
    ...(record.runtime === "code"
      ? [
        `\`\`\`${WIDGET_SOURCE_INFO}`,
        record.source.trim(),
        "```",
        "",
      ]
      : [
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
      ]),
    ...(record.storageSchema
      ? [
        `\`\`\`${WIDGET_STORAGE_INFO}`,
        JSON.stringify(record.storageSchema, null, 2,),
        "```",
        "",
      ]
      : []),
    `\`\`\`${WIDGET_HISTORY_INFO}`,
    JSON.stringify(history, null, 2,),
    "```",
    "",
  ].join("\n",);
}

function toWidgetHtml(record: WidgetFileRecord,): string {
  const attrs = ['data-widget=""',];
  attrs.push(`data-id="${escapeWidgetHtmlAttr(crypto.randomUUID(),)}"`,);
  attrs.push(`data-storage-id="${escapeWidgetHtmlAttr(record.id,)}"`,);
  attrs.push(`data-file="${escapeWidgetHtmlAttr(record.file,)}"`,);
  attrs.push(`data-path="${escapeWidgetHtmlAttr(record.path,)}"`,);
  attrs.push(`data-prompt="${encodeWidgetDataAttr(record.prompt,)}"`,);
  attrs.push(`data-runtime="${escapeWidgetHtmlAttr(record.runtime,)}"`,);
  if (record.spec) {
    attrs.push(`data-spec="${encodeWidgetDataAttr(compactWidgetSpec(record.spec,),)}"`,);
  }
  if (record.source) {
    attrs.push(`data-source="${encodeWidgetDataAttr(record.source,)}"`,);
  }
  if (record.saved) attrs.push('data-saved="true"',);
  if (record.libraryItemId) {
    attrs.push(`data-library-item-id="${escapeWidgetHtmlAttr(record.libraryItemId,)}"`,);
  }
  if (record.componentId) {
    attrs.push(`data-component-id="${escapeWidgetHtmlAttr(record.componentId,)}"`,);
  }
  if (record.storageSchema) {
    attrs.push(`data-storage-schema="${encodeWidgetDataAttr(stringifyStorageSchema(record.storageSchema,),)}"`,);
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
    runtime: input.runtime ?? "code",
    favorite: input.favorite ?? false,
    saved: input.saved ?? false,
    spec: input.spec,
    source: input.source ?? "",
    currentRevisionId: input.currentRevisionId ?? "",
    revisions: input.revisions ?? [],
    libraryItemId: input.libraryItemId ?? null,
    componentId: input.componentId ?? null,
    storageSchema: input.storageSchema ?? null,
    file,
    path,
  };
  const history = ensureWidgetHistory(record,);
  record.currentRevisionId = history.currentRevisionId;
  record.revisions = history.revisions;
  await writeTextFile(path, serializeWidgetMarkdown(record,),);
  await ensureWidgetStorage(path, id, record.storageSchema,);
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
  const history = ensureWidgetHistory(record,);
  record.currentRevisionId = history.currentRevisionId;
  record.revisions = history.revisions;
  await ensureParentDir(path,);
  await writeTextFile(path, serializeWidgetMarkdown(record,),);
  await ensureWidgetStorage(path, record.id, record.storageSchema,);
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

function matchesLibraryReference(record: WidgetFileRecord, libraryItemId: string,) {
  return record.libraryItemId === libraryItemId || record.componentId === libraryItemId;
}

export function getWidgetSavedAt(record: Pick<WidgetFileRecord, "currentRevisionId" | "revisions">,): string {
  return record.revisions.find((revision,) => revision.id === record.currentRevisionId)?.createdAt
    ?? record.revisions[record.revisions.length - 1]?.createdAt
    ?? "";
}

export async function listSavedWidgetFiles(): Promise<WidgetFileRecord[]> {
  const widgetsDir = await getWidgetsDir();
  if (!(await exists(widgetsDir,))) {
    return [];
  }

  const paths = await listWidgetFilePaths(widgetsDir,);
  const records = await Promise.all(paths.map(async (path,) => {
    const file = path.startsWith(`${widgetsDir}/`,) ? `widgets/${path.slice(widgetsDir.length + 1,)}` : path;
    return await readWidgetFile(path, file,);
  },),);

  return records.filter((record,): record is WidgetFileRecord =>
    record !== null && record.saved && !!(record.libraryItemId || record.componentId)
  );
}

export async function setWidgetLibraryFavorite(libraryItemId: string, favorite: boolean,): Promise<void> {
  const widgetsDir = await getWidgetsDir();
  if (!(await exists(widgetsDir,))) {
    return;
  }

  const paths = await listWidgetFilePaths(widgetsDir,);
  await Promise.all(paths.map(async (path,) => {
    const file = path.startsWith(`${widgetsDir}/`,) ? `widgets/${path.slice(widgetsDir.length + 1,)}` : path;
    const record = await readWidgetFile(path, file,);
    if (!record || !matchesLibraryReference(record, libraryItemId,)) return;

    await updateWidgetFile(path, file, {
      ...record,
      favorite,
    },);
  },),);
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
    if (!matchesLibraryReference(record, libraryItemId,)) {
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
