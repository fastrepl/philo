import { convertFileSrc, } from "@tauri-apps/api/core";
import { join, } from "@tauri-apps/api/path";
import { exists, mkdir, writeFile, } from "@tauri-apps/plugin-fs";
import { getAssetsDir, getJournalDir, } from "./paths";
import { getAssetsFolderSetting, } from "./settings";

let imageIndex = 0;

function generateFilename(ext: string,): string {
  const ts = Date.now();
  const index = imageIndex++;
  return `image_${ts}_${index}.${ext.toLowerCase()}`;
}

function normalizePathSegment(segment: string,): string {
  return segment.replace(/^\.?\//, "",).replace(/\/$/, "",);
}

async function getAssetsRelativeRoot(): Promise<string> {
  const configured = normalizePathSegment(await getAssetsFolderSetting(),);
  return configured || "assets";
}

function normalizeRelativeAssetPath(path: string,): string {
  return path.replace(/^(?:\.\.?\/)+/, "",);
}

function getAssetSuffix(
  relativePath: string,
  assetsRelativeRoot: string,
): string | null {
  const normalized = normalizeRelativeAssetPath(relativePath,);
  if (!normalized) return null;
  const prefix = `${assetsRelativeRoot}/`;
  if (normalized === assetsRelativeRoot) {
    return "";
  }
  if (normalized.startsWith(prefix,)) {
    return normalized.slice(prefix.length,);
  }
  if (!normalized.includes("/",)) {
    return normalized;
  }
  return null;
}

async function resolveAssetAbsolutePath(relativePath: string,): Promise<string> {
  const assetsRelativeRoot = await getAssetsRelativeRoot();
  const assetSuffix = getAssetSuffix(relativePath, assetsRelativeRoot,);
  if (assetSuffix !== null) {
    const assetsDir = await getAssetsDir();
    return assetSuffix ? await join(assetsDir, assetSuffix,) : assetsDir;
  }

  const journalDir = await getJournalDir();
  return await join(journalDir, normalizeRelativeAssetPath(relativePath,),);
}

export async function saveAsset(file: File,): Promise<string> {
  const assetsDir = await getAssetsDir();
  const dirExists = await exists(assetsDir,);
  if (!dirExists) {
    await mkdir(assetsDir, { recursive: true, },);
  }

  const ext = file.name.split(".",).pop() || "bin";
  const filename = generateFilename(ext,);
  const fullPath = await join(assetsDir, filename,);

  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer,);

  await writeFile(fullPath, uint8Array,);

  return filename;
}

export async function saveImage(file: File,): Promise<string> {
  return await saveAsset(file,);
}

export async function resolveAssetUrl(relativePath: string,): Promise<string> {
  const absolutePath = await resolveAssetAbsolutePath(relativePath,);
  return convertFileSrc(absolutePath,);
}

function isNonAssetUrl(path: string,): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(path,)
    || /^[a-z]+:/i.test(path,)
    || path.startsWith("/",)
    || path.startsWith("#",);
}

export async function resolveMarkdownImages(markdown: string,): Promise<string> {
  const imagePattern = /!\[([^\]]*)\]\(([^)\s"]+)(?:\s+"([^"]*)")?\)/g;
  const matches = [...markdown.matchAll(imagePattern,),];
  if (matches.length === 0) return markdown;

  let result = markdown;

  for (const match of matches) {
    const [full, alt, path, title,] = match;
    if (isNonAssetUrl(path,)) continue;

    const relativePath = normalizeRelativeAssetPath(path,);
    const absolutePath = await resolveAssetAbsolutePath(relativePath,);
    if (!(await exists(absolutePath,))) continue;

    const assetUrl = convertFileSrc(absolutePath,);
    const replacement = title
      ? `![${alt}](${assetUrl} "${title}")`
      : `![${alt}](${assetUrl})`;
    result = result.replace(full, replacement,);
  }

  return result;
}

export function unresolveMarkdownImages(markdown: string,): string {
  const assetUrlPattern =
    /!\[([^\]]*)\]\(((?:http:\/\/asset\.localhost|asset:\/\/localhost)[^)\s"]+)(?:\s+"([^"]*)")?\)/g;

  return markdown.replace(assetUrlPattern, (_full, alt, url, title,) => {
    let filename = "";
    try {
      const parsed = new URL(url,);
      const segments = decodeURIComponent(parsed.pathname,).split("/",).filter(Boolean,);
      filename = segments[segments.length - 1] || "";
    } catch {
      const match = String(url,).match(/\/([^/]+)$/,);
      filename = match ? match[1] : "";
    }
    if (!filename) {
      return title
        ? `![${alt}](${url} "${title}")`
        : `![${alt}](${url})`;
    }
    return title
      ? `![${alt}](${filename} "${title}")`
      : `![${alt}](${filename})`;
  },);
}

export async function resolveMarkdownAssetLinks(markdown: string,): Promise<string> {
  const linkPattern = /\[([^\]]+)\]\(([^)\s"]+)(?:\s+"([^"]*)")?\)/g;
  const matches = [...markdown.matchAll(linkPattern,),];
  if (matches.length === 0) return markdown;

  let result = markdown;

  for (const match of matches) {
    const [full, label, path, title,] = match;
    if (isNonAssetUrl(path,)) continue;

    const relativePath = normalizeRelativeAssetPath(path,);
    const absolutePath = await resolveAssetAbsolutePath(relativePath,);
    if (!(await exists(absolutePath,))) continue;

    const assetUrl = convertFileSrc(absolutePath,);
    const replacement = title
      ? `[${label}](${assetUrl} "${title}")`
      : `[${label}](${assetUrl})`;
    result = result.replace(full, replacement,);
  }

  return result;
}

export function unresolveMarkdownAssetLinks(markdown: string,): string {
  const assetUrlPattern =
    /\[([^\]]+)\]\(((?:http:\/\/asset\.localhost|asset:\/\/localhost)[^)\s"]+)(?:\s+"([^"]*)")?\)/g;

  return markdown.replace(assetUrlPattern, (_full, label, url, title,) => {
    let filename = "";
    try {
      const parsed = new URL(url,);
      const segments = decodeURIComponent(parsed.pathname,).split("/",).filter(Boolean,);
      filename = segments[segments.length - 1] || "";
    } catch {
      const match = String(url,).match(/\/([^/]+)$/,);
      filename = match ? match[1] : "";
    }
    if (!filename) {
      return title
        ? `[${label}](${url} "${title}")`
        : `[${label}](${url})`;
    }
    return title
      ? `[${label}](${filename} "${title}")`
      : `[${label}](${filename})`;
  },);
}
