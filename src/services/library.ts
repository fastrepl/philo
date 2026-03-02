import { join, } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile, remove, writeTextFile, } from "@tauri-apps/plugin-fs";
import { getBaseDir, getJournalDir, } from "./paths";
import { getVaultDirSetting, } from "./settings";

export interface LibraryItem {
  id: string;
  title: string;
  description: string;
  html: string;
  prompt: string;
  savedAt: string;
}

const LIBRARY_FILE = "library.json";
const COMPONENT_SUFFIX = ".component.md";

function slugify(input: string,): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-",).replace(/^-+|-+$/g, "",);
  return slug || "component";
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

  const specMatch = match[2].match(/```(?:json|jsonc|json-render|jsonui)?\n([\s\S]*?)```/,);
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
  const spec = (() => {
    try {
      return JSON.stringify(JSON.parse(item.html,), null, 2,);
    } catch {
      return item.html.trim();
    }
  })();
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
    spec,
    "```",
    "",
  ].join("\n",);
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

async function getLibraryPath(): Promise<string> {
  const base = await getBaseDir();
  return await join(base, LIBRARY_FILE,);
}

async function writeComponentFile(item: LibraryItem,): Promise<void> {
  const libraryDir = await ensureLibraryDir();
  const filename = `${slugify(item.title,)}-${item.id}${COMPONENT_SUFFIX}`;
  const path = await join(libraryDir, filename,);
  await writeTextFile(path, serializeComponentMarkdown(item,),);
}

async function listComponentItems(): Promise<LibraryItem[]> {
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
  const path = await getLibraryPath();
  if (!(await exists(path,))) return [];

  try {
    const raw = await readTextFile(path,);
    const parsed = JSON.parse(raw,) as LibraryItem[];
    if (!Array.isArray(parsed,) || parsed.length === 0) return [];
    const migrated = parsed
      .map((item,) => {
        if (!item || typeof item !== "object") return null;
        const id = typeof item.id === "string" && item.id ? item.id : crypto.randomUUID();
        const savedAt = typeof item.savedAt === "string" && item.savedAt ? item.savedAt : new Date().toISOString();
        const title = typeof item.title === "string" ? item.title : "Component";
        const description = typeof item.description === "string" ? item.description : "";
        const prompt = typeof item.prompt === "string" ? item.prompt : "";
        const html = typeof item.html === "string" ? item.html : "";
        if (!prompt || !html) return null;
        return { id, title, description, prompt, html, savedAt, };
      },)
      .filter((item,): item is LibraryItem => item !== null);
    await Promise.all(migrated.map((item,) => writeComponentFile(item,)),);
    return migrated;
  } catch {
    return [];
  }
}

export async function loadLibrary(): Promise<LibraryItem[]> {
  let items = await listComponentItems();
  if (items.length === 0) {
    items = await migrateLegacyLibraryJson();
  }
  return items.sort((a, b,) => b.savedAt.localeCompare(a.savedAt,));
}

export async function addToLibrary(item: Omit<LibraryItem, "id" | "savedAt">,): Promise<LibraryItem> {
  const newItem: LibraryItem = {
    ...item,
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
  };
  await writeComponentFile(newItem,);
  return newItem;
}

export async function removeFromLibrary(id: string,): Promise<void> {
  const libraryDir = await ensureLibraryDir();
  const entries = await readDir(libraryDir,);
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.toLowerCase().endsWith(COMPONENT_SUFFIX,)) continue;
    const path = await join(libraryDir, entry.name,);
    try {
      const raw = await readTextFile(path,);
      const item = parseComponentMarkdown(raw,);
      if (item?.id === id) {
        await remove(path,);
        return;
      }
    } catch {
      continue;
    }
  }
}
