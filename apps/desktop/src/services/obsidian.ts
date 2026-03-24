import { invoke, } from "@tauri-apps/api/core";
import { dirname, join, } from "@tauri-apps/api/path";
import { exists, readTextFile, } from "@tauri-apps/plugin-fs";

interface FolderDetection {
  dailyLogsFolder: string;
  excalidrawFolder: string;
  assetsFolder: string;
  filenamePattern: string;
}

interface BackendFolderDetection {
  dailyLogsFolder?: string;
  excalidrawFolder?: string;
  assetsFolder?: string;
  filenamePattern?: string;
}

interface VaultBootstrapOptions {
  dailyLogsFolder: string;
  excalidrawFolder?: string;
  assetsFolder?: string;
}

const DEFAULT_OBSIDIAN_MARKDOWN_INDENTATION = { style: "space", size: 4, } as const;

function asRecord(value: unknown,): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown,): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown,): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asPositiveInteger(value: unknown,): number | null {
  return typeof value === "number" && Number.isInteger(value,) && value > 0 ? value : null;
}

function normalizeFolder(value: string | null,): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "/" || trimmed === "./" || trimmed === ".") return ".";
  return trimmed.replace(/^\.?\//, "",).replace(/\/+$/, "",);
}

async function readJson(path: string,): Promise<Record<string, unknown> | null> {
  const fileExists = await exists(path,);
  if (!fileExists) return null;
  try {
    const raw = await readTextFile(path,);
    const parsed = JSON.parse(raw,);
    return asRecord(parsed,);
  } catch {
    return null;
  }
}

function detectDailyLogsFolder(
  dailyNotesConfig: Record<string, unknown> | null,
  periodicNotesConfig: Record<string, unknown> | null,
): string {
  const fromDailyNotes = asString(dailyNotesConfig?.folder,);
  if (fromDailyNotes) return normalizeFolder(fromDailyNotes,);

  const periodicDaily = asRecord(periodicNotesConfig?.daily,);
  const fromPeriodicNotes = asString(periodicDaily?.folder,);
  if (fromPeriodicNotes) return normalizeFolder(fromPeriodicNotes,);

  return "";
}

function mapObsidianDateFormatToFilenamePattern(format: string | null,): string {
  if (!format) return "";

  const source = format.trim().replace(/\[([^\]]*)\]/g, "$1",);
  if (!source) return "";

  let output = "";
  let last = 0;

  for (const match of source.matchAll(/[YyMDd]+/g,)) {
    const token = match[0];
    const index = match.index ?? 0;
    output += source.slice(last, index,);

    if (/^[Yy]{4}$/.test(token,)) {
      output += "{YYYY}";
    } else if (/^M{2}$/.test(token,)) {
      output += "{MM}";
    } else if (/^[Dd]{2}$/.test(token,)) {
      output += "{DD}";
    } else {
      return "";
    }

    last = index + token.length;
  }

  output += source.slice(last,);
  if (!output.includes("{YYYY}",) || !output.includes("{MM}",) || !output.includes("{DD}",)) {
    return "";
  }
  return output;
}

function detectFilenamePattern(
  dailyNotesConfig: Record<string, unknown> | null,
  periodicNotesConfig: Record<string, unknown> | null,
): string {
  const fromDailyNotes = mapObsidianDateFormatToFilenamePattern(asString(dailyNotesConfig?.format,),);
  if (fromDailyNotes) return fromDailyNotes;

  const periodicDaily = asRecord(periodicNotesConfig?.daily,);
  const fromPeriodicNotes = mapObsidianDateFormatToFilenamePattern(asString(periodicDaily?.format,),);
  if (fromPeriodicNotes) return fromPeriodicNotes;

  return "";
}

function detectAssetsFolder(appConfig: Record<string, unknown> | null,): string {
  return normalizeFolder(asString(appConfig?.attachmentFolderPath,),);
}

function detectMarkdownIndentation(
  appConfig: Record<string, unknown> | null,
): { style: "space" | "tab"; size: number; } {
  if (!appConfig) return { ...DEFAULT_OBSIDIAN_MARKDOWN_INDENTATION, };

  const useTab = asBoolean(appConfig.useTab,);
  const tabSize = asPositiveInteger(appConfig.tabSize,) ?? DEFAULT_OBSIDIAN_MARKDOWN_INDENTATION.size;

  return {
    style: useTab ? "tab" : "space",
    size: tabSize,
  };
}

function detectExcalidrawFolder(excalidrawConfig: Record<string, unknown> | null,): string {
  if (!excalidrawConfig) return "";

  const explicit = [
    asString(excalidrawConfig.folder,),
    asString(excalidrawConfig.excalidrawFolder,),
    asString(excalidrawConfig.drawingFolder,),
    asString(excalidrawConfig.drawingFolderPath,),
    asString(excalidrawConfig.folderPath,),
  ].find((value,) => !!value);

  if (explicit) return normalizeFolder(explicit,);

  for (const [key, value,] of Object.entries(excalidrawConfig,)) {
    const asText = asString(value,);
    if (!asText) continue;
    if (!/folder|path|dir/i.test(key,)) continue;
    if (/excalidraw/i.test(key,) || /excalidraw/i.test(asText,)) {
      return normalizeFolder(asText,);
    }
  }

  return "";
}

function normalizeDetectionFromBackend(value: BackendFolderDetection | null | undefined,): FolderDetection {
  return {
    dailyLogsFolder: normalizeFolder(asString(value?.dailyLogsFolder ?? "",),),
    excalidrawFolder: normalizeFolder(asString(value?.excalidrawFolder ?? "",),),
    assetsFolder: normalizeFolder(asString(value?.assetsFolder ?? "",),),
    filenamePattern: asString(value?.filenamePattern ?? "",) ?? "",
  };
}

export async function detectObsidianFolders(vaultDir: string,): Promise<FolderDetection> {
  const normalizedVaultDir = vaultDir.trim();
  if (!normalizedVaultDir) {
    return { dailyLogsFolder: "", excalidrawFolder: "", assetsFolder: "", filenamePattern: "", };
  }

  const detectedFromBackend = await invoke<BackendFolderDetection>("detect_obsidian_settings", {
    vaultDir: normalizedVaultDir,
  },).then(normalizeDetectionFromBackend,).catch(() => null);

  if (detectedFromBackend) {
    const hasDetectedValue = Object.values(detectedFromBackend,).some((value,) => value.trim().length > 0);
    if (hasDetectedValue) return detectedFromBackend;
  }

  await invoke("extend_fs_scope", { path: normalizedVaultDir, },).catch(() => undefined);

  const obsidianDir = await join(normalizedVaultDir, ".obsidian",);
  const [dailyNotesConfig, periodicNotesConfig, appConfig, excalidrawConfig,] = await Promise.all([
    readJson(await join(obsidianDir, "daily-notes.json",),),
    readJson(await join(obsidianDir, "plugins", "periodic-notes", "data.json",),),
    readJson(await join(obsidianDir, "app.json",),),
    readJson(await join(obsidianDir, "plugins", "obsidian-excalidraw-plugin", "data.json",),),
  ],);

  return {
    dailyLogsFolder: detectDailyLogsFolder(dailyNotesConfig, periodicNotesConfig,),
    excalidrawFolder: detectExcalidrawFolder(excalidrawConfig,),
    assetsFolder: detectAssetsFolder(appConfig,),
    filenamePattern: detectFilenamePattern(dailyNotesConfig, periodicNotesConfig,),
  };
}

export async function isWithinObsidianVault(path: string,): Promise<boolean> {
  let currentPath = path.trim();
  if (!currentPath) return false;

  while (true) {
    const obsidianDir = await join(currentPath, ".obsidian",);
    if (await exists(obsidianDir,)) {
      return true;
    }

    const parentPath = await dirname(currentPath,);
    if (!parentPath || parentPath === currentPath) {
      return false;
    }

    currentPath = parentPath;
  }
}

export async function loadObsidianMarkdownIndentation(
  vaultDir: string,
): Promise<{ style: "space" | "tab"; size: number; } | null> {
  const normalizedVaultDir = vaultDir.trim();
  if (!normalizedVaultDir) return null;

  await invoke("extend_fs_scope", { path: normalizedVaultDir, },).catch(() => undefined);

  const appConfig = await readJson(await join(normalizedVaultDir, ".obsidian", "app.json",),);
  return detectMarkdownIndentation(appConfig,);
}

export async function ensureObsidianVaultStructure(
  vaultDir: string,
  options: VaultBootstrapOptions,
): Promise<void> {
  const normalizedVaultDir = vaultDir.trim();
  if (!normalizedVaultDir) return;

  await invoke("bootstrap_obsidian_vault", {
    vaultDir: normalizedVaultDir,
    dailyLogsFolder: options.dailyLogsFolder,
    excalidrawFolder: options.excalidrawFolder ?? "",
    assetsFolder: options.assetsFolder ?? "",
  },);
}
