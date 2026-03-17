import { invoke, } from "@tauri-apps/api/core";
import { join, } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile, remove, writeTextFile, } from "@tauri-apps/plugin-fs";
import { getBaseDir as getAppBaseDir, getJournalDir, } from "./paths";
import { getVaultDirSetting, } from "./settings";
import { markWidgetLibraryReferenceRemoved, } from "./widget-files";

export interface SharedStorageColumn {
  name: string;
  type: string;
  notNull?: boolean;
  primaryKey?: boolean;
}

export interface SharedStorageIndex {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface SharedStorageFilter {
  column: string;
  operator?: "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
  parameter: string;
}

export interface SharedStorageQuery {
  name: string;
  table: string;
  columns: string[];
  filters: SharedStorageFilter[];
  orderBy?: string;
  orderDesc?: boolean;
  limit?: number;
}

export interface SharedStorageMutation {
  name: string;
  table: string;
  kind: "insert" | "update" | "delete";
  setColumns: string[];
  filters: SharedStorageFilter[];
}

export interface SharedStorageSchema {
  tables: Array<{
    name: string;
    columns: SharedStorageColumn[];
    indexes?: SharedStorageIndex[];
  }>;
  namedQueries: SharedStorageQuery[];
  namedMutations: SharedStorageMutation[];
}

export interface SharedComponentManifest {
  id: string;
  title: string;
  description: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  uiSpec: unknown;
  storageKind: "sqlite";
  storageSchema: SharedStorageSchema;
  schemaVersion: number;
}

export interface LibraryItem {
  id: string;
  title: string;
  description: string;
  html: string;
  prompt: string;
  savedAt: string;
  componentId?: string;
  storageKind?: "sqlite";
  storageSchema?: SharedStorageSchema;
  schemaVersion?: number;
  uiSpec?: unknown;
}

export interface AddToLibraryInput {
  title: string;
  description: string;
  prompt: string;
  html: string;
}

export interface AddSharedComponentInput extends AddToLibraryInput {
  uiSpec: string;
  storageSchema: SharedStorageSchema;
}

const LIBRARY_FILE = "library.json";
const COMPONENT_SUFFIX = ".component.md";
export const SHARED_COMPONENTS_UPDATED_EVENT = "philo:shared-components-updated";

function isSharedItem(item: LibraryItem, id: string, componentId?: string,): boolean {
  return item.id === id || (!!componentId && item.componentId === componentId);
}

function normalizeLegacyId(raw: string,): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-",).replace(/^-+|-+$/g, "",);
}

function emitSharedComponentsUpdated(componentId?: string,): void {
  window.dispatchEvent(
    new CustomEvent(SHARED_COMPONENTS_UPDATED_EVENT, {
      detail: { componentId: componentId ?? null, },
    },),
  );
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

function parseComponentMarkdown(raw: string,): LibraryItem | null {
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
  if (!meta.id || !meta.title || !meta.prompt || !meta.savedAt || !spec) return null;

  return {
    id: meta.id,
    title: meta.title,
    description: meta.description ?? meta.prompt,
    html: spec,
    prompt: meta.prompt,
    savedAt: meta.savedAt,
  };
}

function serializeComponentMarkdown(item: LibraryItem,): string {
  return [
    "---",
    `id: ${JSON.stringify(item.id,)}`,
    `title: ${JSON.stringify(item.title,)}`,
    `description: ${JSON.stringify(item.description,)}`,
    `prompt: ${JSON.stringify(item.prompt,)}`,
    `savedAt: ${JSON.stringify(item.savedAt,)}`,
    "---",
    "",
    "```json",
    (() => {
      try {
        return JSON.stringify(JSON.parse(item.html,), null, 2,);
      } catch {
        return item.html.trim();
      }
    })(),
    "```",
    "",
  ].join("\n",);
}

function toLibraryFromManifest(manifest: SharedComponentManifest,): LibraryItem {
  const spec = typeof manifest.uiSpec === "string"
    ? manifest.uiSpec
    : JSON.stringify(manifest.uiSpec, null, 2,);
  return {
    id: manifest.id,
    title: manifest.title,
    description: manifest.description,
    html: spec,
    prompt: manifest.prompt,
    savedAt: manifest.updatedAt,
    componentId: manifest.id,
    storageKind: manifest.storageKind,
    storageSchema: manifest.storageSchema,
    schemaVersion: manifest.schemaVersion,
    uiSpec: manifest.uiSpec,
  };
}

function parseJsonOrString(input: string, fallback: unknown = "",): unknown {
  try {
    return JSON.parse(input,);
  } catch {
    return fallback;
  }
}

function normalizeStorageSchema(schema: SharedStorageSchema,): SharedStorageSchema {
  return {
    tables: schema.tables.map((table,) => ({
      ...table,
      columns: table.columns.map((column,) => ({
        ...column,
        name: column.name.trim(),
        type: column.type.toLowerCase(),
      })).filter((column,) => column.name),
      indexes: table.indexes
        ? table.indexes.map((index,) => ({
          ...index,
          columns: index.columns.map((column,) => column.trim()).filter((column,) => column),
        }))
        : [],
    })),
    namedQueries: schema.namedQueries.map((query,) => ({
      ...query,
      columns: query.columns.map((column,) => column.trim()).filter((column,) => column),
      filters: query.filters ?? [],
      orderBy: query.orderBy?.trim() || undefined,
      orderDesc: query.orderDesc ?? false,
      limit: query.limit,
    })),
    namedMutations: schema.namedMutations.map((mutation,) => ({
      ...mutation,
      setColumns: mutation.setColumns?.map((column,) => column.trim()).filter((column,) => column) ?? [],
      filters: mutation.filters ?? [],
    })),
  };
}

async function getLibraryDir(): Promise<string> {
  const vaultDir = (await getVaultDirSetting()).trim();
  if (vaultDir) return await join(vaultDir, "library",);
  const journalDir = await getJournalDir();
  return await join(journalDir, "library",);
}

async function ensureLibraryDir(): Promise<string> {
  const dir = await getLibraryDir();
  if (!(await exists(dir,))) {
    await mkdir(dir, { recursive: true, },);
  }
  return dir;
}

async function listLegacyItems(): Promise<LibraryItem[]> {
  const libraryDir = await ensureLibraryDir();
  const entries = await readDir(libraryDir,);
  const items = await Promise.all(
    entries
      .filter((entry,) => entry.isFile && entry.name.toLowerCase().endsWith(COMPONENT_SUFFIX,))
      .map(async (entry,) => {
        const path = await join(libraryDir, entry.name,);
        try {
          const raw = await readTextFile(path,);
          return parseComponentMarkdown(raw,);
        } catch {
          return null;
        }
      },),
  );
  return items.filter((item,): item is LibraryItem => item !== null);
}

async function migrateLegacyLibraryJson(): Promise<LibraryItem[]> {
  const dir = await getLibraryDir();
  const base = await getAppBaseDirectory();
  const path = await join(base, LIBRARY_FILE,);
  if (!(await exists(path,))) return [];

  try {
    const raw = await readTextFile(path,);
    const parsed = JSON.parse(raw,) as Array<{
      id?: string;
      title?: string;
      description?: string;
      prompt?: string;
      html?: string;
      savedAt?: string;
    }>;
    if (!Array.isArray(parsed,) || parsed.length === 0) return [];

    const normalized = parsed
      .map((item,) => {
        if (!item || typeof item !== "object") return null;
        const id = typeof item.id === "string" && item.id ? item.id : crypto.randomUUID();
        const savedAt = typeof item.savedAt === "string" && item.savedAt ? item.savedAt : new Date().toISOString();
        const title = typeof item.title === "string" ? item.title : "Component";
        const description = typeof item.description === "string" ? item.description : "";
        const prompt = typeof item.prompt === "string" ? item.prompt : "";
        const html = typeof item.html === "string" ? item.html : "";
        if (!prompt || !html) return null;
        return {
          id,
          title,
          description,
          html,
          prompt,
          savedAt,
        };
      },)
      .filter((item,): item is LibraryItem => item !== null);

    for (const item of normalized) {
      const filename = `${normalizeLegacyId(item.title,)}-${item.id}${COMPONENT_SUFFIX}`;
      const fullPath = await join(dir, filename,);
      const existsLegacy = await exists(fullPath,);
      if (!existsLegacy) {
        await writeTextFile(fullPath, serializeComponentMarkdown(item,),);
      }
    }
    return normalized;
  } catch {
    return [];
  }
}

async function getAppBaseDirectory(): Promise<string> {
  const base = await getAppBaseDir();
  if (base.trim()) return base;
  return "/";
}

function libraryDirArgs(baseDir: string, overrides: Record<string, unknown> = {},): Record<string, unknown> {
  return {
    libraryDir: baseDir,
    library_dir: baseDir,
    ...overrides,
  };
}

function libraryInputArgs(baseDir: string, overrides: Record<string, unknown> = {},): Record<string, unknown> {
  return {
    input: {
      libraryDir: baseDir,
      library_dir: baseDir,
      ...overrides,
    },
  };
}

export async function listSharedComponents(): Promise<SharedComponentManifest[]> {
  const libraryDir = await getLibraryDir();
  return await invoke<SharedComponentManifest[]>("list_shared_components", {
    ...libraryDirArgs(libraryDir,),
  },);
}

export async function getSharedComponent(id: string,): Promise<SharedComponentManifest | null> {
  try {
    const libraryDir = await getLibraryDir();
    return await invoke<SharedComponentManifest>("get_shared_component", {
      ...libraryDirArgs(libraryDir, { id, },),
    },);
  } catch {
    return null;
  }
}

export async function removeSharedComponent(id: string,): Promise<void> {
  const libraryDir = await getLibraryDir();
  await invoke("delete_shared_component", libraryDirArgs(libraryDir, { id, },),);
  emitSharedComponentsUpdated(id,);
}

export async function runSharedComponentQuery(
  componentId: string,
  queryName: string,
  params: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const libraryDir = await getLibraryDir();
  const result = await invoke<{ rows: Array<Record<string, unknown>>; }>(
    "run_shared_component_query",
    libraryInputArgs(libraryDir, {
      componentId,
      component_id: componentId,
      queryName,
      query_name: queryName,
      params,
    },),
  );
  return result.rows;
}

export async function runSharedComponentMutation(
  componentId: string,
  mutationName: string,
  params: Record<string, unknown> = {},
): Promise<number> {
  const libraryDir = await getLibraryDir();
  const result = await invoke<{ changedRows: number; }>(
    "run_shared_component_mutation",
    libraryInputArgs(libraryDir, {
      componentId,
      component_id: componentId,
      mutationName,
      mutation_name: mutationName,
      params,
    },),
  );
  return result.changedRows;
}

export async function updateSharedComponent(
  id: string,
  uiSpec: unknown,
  prompt: string,
): Promise<SharedComponentManifest> {
  const libraryDir = await getLibraryDir();
  const manifest = await invoke<SharedComponentManifest>(
    "update_shared_component",
    libraryInputArgs(libraryDir, {
      id,
      uiSpec,
      ui_spec: uiSpec,
      prompt,
    },),
  );
  emitSharedComponentsUpdated(id,);
  return manifest;
}

export async function loadLibrary(): Promise<LibraryItem[]> {
  let shared: LibraryItem[] = [];
  let items = await listLegacyItems();

  try {
    const manifestItems = await listSharedComponents();
    shared = manifestItems.map(toLibraryFromManifest,).sort((a, b,) => b.savedAt.localeCompare(a.savedAt,));
    if (!items.length) {
      const migrated = await migrateLegacyLibraryJson();
      if (migrated.length > 0) {
        items = migrated;
      }
    }
  } catch {
    if (!items.length) {
      items = await migrateLegacyLibraryJson();
    }
  }

  const seen = new Set<string>();
  const merged = [...shared, ...items,].filter((item,) => {
    const key = item.componentId ?? item.id;
    if (seen.has(key,)) return false;
    seen.add(key,);
    return true;
  },);
  return merged.sort((a, b,) => b.savedAt.localeCompare(a.savedAt,));
}

export async function addToLibrary(
  item: AddToLibraryInput | AddSharedComponentInput,
): Promise<LibraryItem> {
  if ("uiSpec" in item && "storageSchema" in item) {
    const libraryDir = await getLibraryDir();
    const id = crypto.randomUUID();
    const parsed = parseJsonOrString(item.uiSpec, null,);
    if (!parsed) {
      throw new Error("Invalid shared component spec. Must be valid JSON.",);
    }
    const manifest = await invoke<SharedComponentManifest>(
      "create_shared_component",
      libraryInputArgs(libraryDir, {
        id,
        title: item.title,
        description: item.description,
        prompt: item.prompt,
        uiSpec: parsed,
        ui_spec: parsed,
        storageSchema: normalizeStorageSchema(item.storageSchema,),
        storage_schema: normalizeStorageSchema(item.storageSchema,),
      },),
    );
    emitSharedComponentsUpdated(manifest.id,);
    return toLibraryFromManifest(manifest,);
  }

  const libraryDir = await ensureLibraryDir();
  const normalizedTitle = item.title.trim();
  const id = crypto.randomUUID();
  const newItem: LibraryItem = {
    id,
    title: normalizedTitle,
    description: item.description,
    html: item.html,
    prompt: item.prompt,
    savedAt: new Date().toISOString(),
  };
  const filename = `${normalizeLegacyId(newItem.title,)}-${newItem.id}${COMPONENT_SUFFIX}`;
  const path = await join(libraryDir, filename,);
  await writeTextFile(path, serializeComponentMarkdown(newItem,),);
  return newItem;
}

export async function removeFromLibrary(id: string,): Promise<void> {
  const libraryDir = await getLibraryDir();
  await removeSharedComponent(id,);
  const items = await readDir(libraryDir,);
  await Promise.all(
    items
      .filter((entry,) => entry.isFile && entry.name.toLowerCase().endsWith(COMPONENT_SUFFIX,))
      .map(async (entry,) => {
        const path = await join(libraryDir, entry.name,);
        try {
          const raw = await readTextFile(path,);
          const item = parseComponentMarkdown(raw,);
          if (!item || !isSharedItem(item, id, undefined,)) return;
          await remove(path,);
        } catch {
          return;
        }
      },),
  );
  await markWidgetLibraryReferenceRemoved(id,);
}

export async function addLegacyFallbackToLibrary(item: AddToLibraryInput,): Promise<LibraryItem> {
  return addToLibrary(item,);
}
