import { invoke, } from "@tauri-apps/api/core";
import { appDataDir, dirname, homeDir, join, } from "@tauri-apps/api/path";
import {
  getAssetsFolderSetting,
  getDailyLogsFolderSetting,
  getExcalidrawFolderSetting,
  getFilenamePattern,
  getJournalDirSetting,
  getVaultDirSetting,
} from "./settings";

let resolvedBaseDir: string | null = null;
let resolvedJournalDir: string | null = null;
function normalizePathSegment(segment: string,): string {
  return segment.replace(/^\.?\//, "",).replace(/\/$/, "",);
}

function isAbsolutePath(path: string,): boolean {
  return path.startsWith("/",) || /^[A-Za-z]:[\\/]/.test(path,);
}

/**
 * Base directory for all app data.
 * - Dev:  ~/Library/Application Support/com.philo.dev/
 * - Prod: ~/Library/Application Support/philo/ (Tauri AppData)
 */
export async function getBaseDir(): Promise<string> {
  if (resolvedBaseDir) return resolvedBaseDir;

  if (import.meta.env.DEV) {
    const home = await homeDir();
    resolvedBaseDir = await join(home, "Library", "Application Support", "com.philo.dev",);
  } else {
    resolvedBaseDir = await appDataDir();
  }
  return resolvedBaseDir;
}

/**
 * Returns the journal directory. Uses the custom path from settings if set,
 * otherwise falls back to `{baseDir}/journal/`.
 */
export async function getJournalDir(): Promise<string> {
  if (resolvedJournalDir) return resolvedJournalDir;

  const customDir = await getJournalDirSetting();
  if (customDir) {
    resolvedJournalDir = customDir;
  } else {
    const vaultDir = await getVaultDirSetting();
    const dailyLogsFolder = normalizePathSegment(await getDailyLogsFolderSetting(),);
    if (vaultDir) {
      resolvedJournalDir = dailyLogsFolder ? await join(vaultDir, dailyLogsFolder,) : vaultDir;
    } else {
      const base = await getBaseDir();
      resolvedJournalDir = await join(base, "journal",);
    }
  }
  return resolvedJournalDir;
}

/**
 * Clear cached journal dir so it's re-read from settings on next access.
 * Also extends the FS & asset protocol scopes for the new path.
 */
export async function resetJournalDir(newDir?: string,): Promise<void> {
  resolvedJournalDir = null;
  if (newDir) {
    await invoke("extend_fs_scope", { path: newDir, },);
  }
}

/**
 * Extend FS scope for the current journal dir on app startup.
 * Call once from the app root.
 */
export async function initJournalScope(): Promise<void> {
  const paths = new Set<string>();
  const customDir = await getJournalDirSetting();
  const journalDir = await getJournalDir();
  const vaultDir = await getVaultDirSetting();
  const pagesDir = await getPagesDir();
  const excalidrawDir = await getExcalidrawDir();
  const assetsDir = await getAssetsDir();
  const widgetsDir = await getWidgetsDir();

  if (customDir) paths.add(customDir,);
  if (journalDir) paths.add(journalDir,);
  if (vaultDir) paths.add(vaultDir,);
  if (pagesDir) paths.add(pagesDir,);
  if (excalidrawDir) paths.add(excalidrawDir,);
  if (assetsDir) paths.add(assetsDir,);
  if (widgetsDir) paths.add(widgetsDir,);

  for (const path of paths) {
    await invoke("extend_fs_scope", { path, },);
  }
}

export async function getAssetsDir(): Promise<string> {
  const configured = normalizePathSegment(await getAssetsFolderSetting(),);
  if (!configured) {
    const journal = await getJournalDir();
    return await join(journal, "assets",);
  }
  if (isAbsolutePath(configured,)) return configured;
  const vaultDir = await getVaultDirSetting();
  if (vaultDir) return await join(vaultDir, configured,);
  const journal = await getJournalDir();
  return await join(journal, configured,);
}

export async function getExcalidrawDir(): Promise<string | null> {
  const configured = normalizePathSegment(await getExcalidrawFolderSetting(),);
  if (!configured) return null;
  if (isAbsolutePath(configured,)) return configured;
  const vaultDir = await getVaultDirSetting();
  if (vaultDir) return await join(vaultDir, configured,);
  const journal = await getJournalDir();
  return await join(journal, configured,);
}

export async function getWidgetsDir(): Promise<string> {
  const vaultDir = await getVaultDirSetting();
  if (vaultDir) return await join(vaultDir, "widgets",);
  const journal = await getJournalDir();
  return await join(journal, "widgets",);
}

export async function getChatsDir(): Promise<string> {
  const vaultDir = await getVaultDirSetting();
  if (vaultDir) return await join(vaultDir, "chats",);
  const journal = await getJournalDir();
  return await join(journal, "chats",);
}

export async function getPagesDir(): Promise<string> {
  const vaultDir = await getVaultDirSetting();
  if (vaultDir) return await join(vaultDir, "pages",);

  const journalDir = await getJournalDir();
  const parentDir = await dirname(journalDir,);
  return await join(parentDir, "pages",);
}

/**
 * Apply a filename pattern to a date string (YYYY-MM-DD).
 * Supported tokens: {YYYY}, {MM}, {DD}
 * Example: "{YYYY}/{YYYY}-{MM}-{DD}" → "2026/2026-02-16"
 */
export function applyFilenamePattern(pattern: string, date: string,): string {
  const [yyyy, mm, dd,] = date.split("-",);
  return pattern
    .replace(/\{YYYY\}/g, yyyy,)
    .replace(/\{MM\}/g, mm,)
    .replace(/\{DD\}/g, dd,);
}

function escapeRegex(value: string,): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&",);
}

function stripMdExtension(target: string,): string {
  return target.replace(/\.md$/i, "",);
}

const INVALID_PAGE_TITLE_RE = /[\/\\\u0000-\u001F]+/g;

export function sanitizePageTitle(title: string,): string {
  return title
    .replace(INVALID_PAGE_TITLE_RE, " ",)
    .replace(/\s+/g, " ",)
    .replace(/^\.+|\.+$/g, "",)
    .trim();
}

function joinNoteLinkSegments(parts: string[],): string {
  return parts
    .map((part,) => part.trim().replace(/^\/+|\/+$/g, "",))
    .filter(Boolean,)
    .join("/",);
}

export function buildNoteLinkTarget(
  date: string,
  pattern: string,
  dailyLogsFolder = "",
  includeDailyLogsFolder = false,
): string {
  const relativePath = applyFilenamePattern(pattern, date,);
  if (!includeDailyLogsFolder) return relativePath;

  const normalizedDailyLogsFolder = normalizePathSegment(dailyLogsFolder,);
  if (!normalizedDailyLogsFolder || normalizedDailyLogsFolder === ".") {
    return relativePath;
  }

  return joinNoteLinkSegments([normalizedDailyLogsFolder, relativePath,],);
}

export function parseDateFromNoteLinkTarget(
  target: string,
  pattern: string,
  dailyLogsFolder = "",
): string | null {
  const normalizedTarget = stripMdExtension(target.trim().replace(/^\/+|\/+$/g, "",),);
  if (!normalizedTarget) return null;

  const normalizedDailyLogsFolder = normalizePathSegment(dailyLogsFolder,);
  const candidates = new Set<string>([normalizedTarget,],);

  if (normalizedDailyLogsFolder && normalizedDailyLogsFolder !== ".") {
    const prefix = `${normalizedDailyLogsFolder}/`;
    if (normalizedTarget.startsWith(prefix,)) {
      candidates.add(normalizedTarget.slice(prefix.length,),);
    } else {
      candidates.add(joinNoteLinkSegments([normalizedDailyLogsFolder, normalizedTarget,],),);
    }
  }

  let regexSource = "";
  const tokenOrder: Array<"YYYY" | "MM" | "DD"> = [];
  let cursor = 0;

  for (const match of pattern.matchAll(/\{YYYY\}|\{MM\}|\{DD\}/g,)) {
    const index = match.index ?? 0;
    regexSource += escapeRegex(pattern.slice(cursor, index,),);
    const token = match[0].slice(1, -1,) as "YYYY" | "MM" | "DD";
    tokenOrder.push(token,);
    if (token === "YYYY") regexSource += "(\\d{4})";
    if (token === "MM") regexSource += "(\\d{2})";
    if (token === "DD") regexSource += "(\\d{2})";
    cursor = index + match[0].length;
  }

  regexSource += escapeRegex(pattern.slice(cursor,),);
  const regex = new RegExp(`^${regexSource}$`,);

  for (const candidate of candidates) {
    const match = regex.exec(candidate,);
    if (!match) continue;

    let yyyy = "";
    let mm = "";
    let dd = "";

    tokenOrder.forEach((token, index,) => {
      const value = match[index + 1] ?? "";
      if (token === "YYYY") {
        if (!yyyy) yyyy = value;
      } else if (token === "MM") {
        if (!mm) mm = value;
      } else if (token === "DD") {
        if (!dd) dd = value;
      }
    },);

    if (yyyy && mm && dd) return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

export async function getNoteLinkTarget(date: string,): Promise<string> {
  const pattern = await getFilenamePattern();
  return buildNoteLinkTarget(date, pattern, "", false,);
}

/**
 * Get the full file path for a daily note, applying the filename pattern.
 */
export async function getNotePath(date: string,): Promise<string> {
  const journalDir = await getJournalDir();
  const pattern = await getFilenamePattern();
  const relativePath = applyFilenamePattern(pattern, date,) + ".md";
  return await join(journalDir, relativePath,);
}

export async function getPagePath(title: string,): Promise<string> {
  const normalizedTitle = sanitizePageTitle(title,);
  if (!normalizedTitle) {
    throw new Error("Page title is required.",);
  }

  const pagesDir = await getPagesDir();
  return await join(pagesDir, `${normalizedTitle}.md`,);
}

export function parsePageTitleFromPath(path: string,): string | null {
  const filename = path.split(/[\\/]/).pop();
  if (!filename?.toLowerCase().endsWith(".md",)) return null;
  return filename.slice(0, -3,);
}

/**
 * Get the parent directory of a note path (for ensuring subdirectories exist).
 */
export async function getNoteDir(date: string,): Promise<string> {
  const notePath = await getNotePath(date,);
  return await dirname(notePath,);
}
