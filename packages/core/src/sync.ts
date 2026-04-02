const DAILY_NOTE_RE = /^(?:.+\/)?\d{4}-\d{2}-\d{2}\.md$/;
const PAGE_RE = /^pages\/.+\.md$/;
const WIDGET_MARKDOWN_RE = /^widgets\/.+\.widget\.md$/;
const WIDGET_STORAGE_RE = /^widgets\/.+\.widget\.sqlite3$/;
const EXCALIDRAW_RE = /\.(?:excalidraw)$/i;
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|svg|heic|heif|bmp|avif)$/i;

export type SyncKind =
  | "daily_note_markdown"
  | "page_markdown"
  | "widget_markdown"
  | "widget_storage_blob"
  | "asset_blob"
  | "excalidraw_blob";

export type SyncStorageType = "text" | "blob";
export type SyncWriteResult = "applied" | "conflict" | "noop";

export interface SyncDocument {
  path: string;
  kind: SyncKind;
  revision: number;
  contentHash: string;
  textContent: string | null;
  blobKey: string | null;
  deletedAt: string | null;
  updatedAt: string;
  updatedByDeviceId: string;
}

export interface SyncConflict {
  path: string;
  kind: SyncKind;
  baseRevision: number;
  remoteRevision: number;
  localHash: string;
  remoteHash: string;
  conflictPath: string;
  detectedAt: string;
}

export interface ResolveSyncWriteInput {
  path: string;
  kind: SyncKind;
  baseRevision: number | null;
  remoteRevision: number | null;
  localHash: string;
  remoteHash: string | null;
  deviceId: string;
  now?: string;
}

export interface ResolveSyncWriteResult {
  status: SyncWriteResult;
  nextRevision: number | null;
  conflict: SyncConflict | null;
}

export function normalizeSyncPath(path: string,): string {
  return path
    .replace(/\\/g, "/",)
    .replace(/^\.?\//, "",)
    .replace(/\/{2,}/g, "/",)
    .replace(/^\/+/, "",)
    .trim();
}

export function classifySyncPath(path: string,): SyncKind | null {
  const normalized = normalizeSyncPath(path,);
  if (!normalized) return null;
  if (WIDGET_STORAGE_RE.test(normalized,)) return "widget_storage_blob";
  if (WIDGET_MARKDOWN_RE.test(normalized,)) return "widget_markdown";
  if (PAGE_RE.test(normalized,)) return "page_markdown";
  if (DAILY_NOTE_RE.test(normalized,)) return "daily_note_markdown";
  if (EXCALIDRAW_RE.test(normalized,)) return "excalidraw_blob";
  if (IMAGE_RE.test(normalized,)) return "asset_blob";
  return null;
}

export function isTextSyncKind(kind: SyncKind,): boolean {
  return kind === "daily_note_markdown" || kind === "page_markdown" || kind === "widget_markdown";
}

export function getSyncStorageType(kind: SyncKind,): SyncStorageType {
  return isTextSyncKind(kind,) ? "text" : "blob";
}

export function hashContent(content: string | Uint8Array,): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content,) : content;
  let hash = 0x811c9dc5;

  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193,);
  }

  return `fnv1a:${(hash >>> 0).toString(16,).padStart(8, "0",)}`;
}

export function createNextRevision(currentRevision: number | null | undefined,): number {
  return (currentRevision ?? 0) + 1;
}

export function buildConflictCopyPath(
  path: string,
  deviceId: string,
  timestamp: string,
): string {
  const normalized = normalizeSyncPath(path,);
  const safeDeviceId = deviceId.trim().replace(/[^a-zA-Z0-9_-]+/g, "-",) || "device";
  const safeTimestamp = timestamp.replace(/[:.]/g, "-",);
  const extensionIndex = normalized.lastIndexOf(".",);

  if (extensionIndex === -1) {
    return `${normalized}.conflict-${safeDeviceId}-${safeTimestamp}`;
  }

  return `${normalized.slice(0, extensionIndex,)}.conflict-${safeDeviceId}-${safeTimestamp}${
    normalized.slice(extensionIndex,)
  }`;
}

export function resolveSyncWrite(input: ResolveSyncWriteInput,): ResolveSyncWriteResult {
  const remoteRevision = input.remoteRevision ?? 0;
  const baseRevision = input.baseRevision ?? 0;
  const now = input.now ?? new Date().toISOString();

  if (input.remoteHash && input.remoteHash === input.localHash) {
    return {
      status: "noop",
      nextRevision: remoteRevision,
      conflict: null,
    };
  }

  if (baseRevision !== remoteRevision) {
    return {
      status: "conflict",
      nextRevision: null,
      conflict: {
        path: normalizeSyncPath(input.path,),
        kind: input.kind,
        baseRevision,
        remoteRevision,
        localHash: input.localHash,
        remoteHash: input.remoteHash ?? "",
        conflictPath: buildConflictCopyPath(input.path, input.deviceId, now,),
        detectedAt: now,
      },
    };
  }

  return {
    status: "applied",
    nextRevision: createNextRevision(remoteRevision,),
    conflict: null,
  };
}
