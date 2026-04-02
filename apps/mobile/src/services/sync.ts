import {
  buildConflictCopyPath,
  classifySyncPath,
  type EditorHostLoadDocumentInput,
  getSyncStorageType,
  hashContent,
  type HostDocumentDescriptor,
  normalizeSyncPath,
  resolveSyncWrite,
  type SyncDocument,
  type SyncKind,
  type SyncStatusSnapshot,
} from "@philo/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient, } from "@supabase/supabase-js";
import * as FileSystem from "expo-file-system/legacy";
import * as SecureStore from "expo-secure-store";

const SYNC_TABLE = "sync_documents";
const SYNC_BUCKET = "sync-blobs";
const SETTINGS_KEY = "philo.mobile.sync.settings.v1";
const SESSION_KEY = "philo.mobile.sync.session.v1";
const MANIFEST_FILE = "manifest.json";
const DOCUMENTS_DIR = "documents";
const INVALID_PAGE_TITLE_RE = /[<>:"/\\|?*\u0000-\u001F]/g;

export const MOBILE_SYNC_REDIRECT_URL = "philo-mobile://sync-auth";

type SyncDocumentRow = {
  blob_key: string | null;
  content_hash: string;
  deleted_at: string | null;
  kind: SyncKind;
  path: string;
  revision: number;
  text_content: string | null;
  updated_at: string;
  updated_by_device_id: string;
  user_id: string;
};

interface MobileSessionRecord {
  accessToken: string;
  email: string;
  refreshToken: string;
  userId: string;
}

interface MobileManifestDocument extends SyncDocument {
  dirty: boolean;
  localUri: string;
  referenceDate: string | null;
  title: string;
}

interface MobileSyncManifest {
  documents: Record<string, MobileManifestDocument>;
  version: 1;
}

export interface MobileSyncSettings {
  syncDeviceId: string;
  syncEmail: string;
  syncEnabled: boolean;
  syncError: string;
  syncLastSyncedAt: string;
}

const DEFAULT_SETTINGS: MobileSyncSettings = {
  syncDeviceId: "",
  syncEmail: "",
  syncEnabled: false,
  syncError: "",
  syncLastSyncedAt: "",
};

let activeSyncPromise: Promise<boolean> | null = null;

function getSupabaseEnv() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() || "";
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() || "";
  return url && anonKey ? { anonKey, url, } : null;
}

function createSyncClient() {
  const env = getSupabaseEnv();
  if (!env) return null;

  return createClient(env.url, env.anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "implicit",
      persistSession: false,
    },
  },);
}

function getCacheRootUri() {
  const root = FileSystem.documentDirectory;
  if (!root) {
    throw new Error("Expo document directory is unavailable.",);
  }

  return `${root}philo-sync/`;
}

function getDocumentsRootUri() {
  return `${getCacheRootUri()}${DOCUMENTS_DIR}/`;
}

function getManifestUri() {
  return `${getCacheRootUri()}${MANIFEST_FILE}`;
}

function getParentUri(uri: string,) {
  const normalized = uri.endsWith("/",) ? uri.slice(0, -1,) : uri;
  const index = normalized.lastIndexOf("/",);
  return index === -1 ? normalized : `${normalized.slice(0, index,)}/`;
}

function getLocalDocumentUri(path: string,) {
  return `${getDocumentsRootUri()}${normalizeSyncPath(path,)}`;
}

function sanitizePageTitle(title: string,) {
  return title
    .replace(INVALID_PAGE_TITLE_RE, " ",)
    .replace(/\s+/g, " ",)
    .replace(/^\.+|\.+$/g, "",)
    .trim();
}

function extractHeading(markdown: string,) {
  for (const line of markdown.split(/\r?\n/,)) {
    const match = line.match(/^#\s+(.+?)\s*$/u,);
    if (match?.[1]) return match[1].trim();
  }

  return "";
}

function parseReferenceDate(path: string, kind: SyncKind,) {
  if (kind !== "daily_note_markdown") return null;
  const match = normalizeSyncPath(path,).match(/(\d{4}-\d{2}-\d{2})\.md$/u,);
  return match?.[1] ?? null;
}

function inferTitle(path: string, kind: SyncKind, textContent: string | null,) {
  const heading = textContent ? extractHeading(textContent,) : "";
  if (heading) return heading;

  if (kind === "daily_note_markdown") {
    return parseReferenceDate(path, kind,) ?? normalizeSyncPath(path,);
  }

  const normalized = normalizeSyncPath(path,);
  const basename = normalized.split("/",).pop() ?? normalized;
  return basename.replace(/\.md$/iu, "",).replace(/\.widget$/iu, "",);
}

function buildSyncStatusSnapshot(
  settings: MobileSyncSettings,
  state?: SyncStatusSnapshot["state"],
): SyncStatusSnapshot {
  return {
    state: state ?? (
      settings.syncError.trim()
        ? "error"
        : settings.syncEnabled
        ? "idle"
        : "offline"
    ),
    lastSyncedAt: settings.syncLastSyncedAt || null,
    errorMessage: settings.syncError || null,
    pendingDownloads: 0,
    pendingUploads: 0,
  };
}

async function ensureDirectory(uri: string,) {
  const info = await FileSystem.getInfoAsync(uri,);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true, },);
  }
}

async function ensureCacheDirectories() {
  await ensureDirectory(getCacheRootUri(),);
  await ensureDirectory(getDocumentsRootUri(),);
}

async function ensureParentDirectory(uri: string,) {
  await ensureDirectory(getParentUri(uri,),);
}

async function readJsonFile<T,>(uri: string, fallback: T,): Promise<T> {
  const info = await FileSystem.getInfoAsync(uri,);
  if (!info.exists) return fallback;

  try {
    const content = await FileSystem.readAsStringAsync(uri,);
    return JSON.parse(content,) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(uri: string, value: unknown,) {
  await ensureParentDirectory(uri,);
  await FileSystem.writeAsStringAsync(uri, `${JSON.stringify(value, null, 2,)}\n`,);
}

async function readTextIfExists(uri: string,) {
  const info = await FileSystem.getInfoAsync(uri,);
  if (!info.exists) return null;
  return await FileSystem.readAsStringAsync(uri,);
}

async function removeIfExists(uri: string,) {
  const info = await FileSystem.getInfoAsync(uri,);
  if (!info.exists) return;
  await FileSystem.deleteAsync(uri, { idempotent: true, },);
}

async function loadManifest(): Promise<MobileSyncManifest> {
  await ensureCacheDirectories();
  return await readJsonFile<MobileSyncManifest>(getManifestUri(), {
    version: 1,
    documents: {},
  },);
}

async function saveManifest(manifest: MobileSyncManifest,) {
  await writeJsonFile(getManifestUri(), manifest,);
}

async function loadSessionRecord() {
  const raw = await SecureStore.getItemAsync(SESSION_KEY,);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw,) as Partial<MobileSessionRecord>;
    if (
      typeof parsed.accessToken !== "string"
      || typeof parsed.refreshToken !== "string"
      || typeof parsed.userId !== "string"
      || typeof parsed.email !== "string"
    ) {
      return null;
    }

    return parsed as MobileSessionRecord;
  } catch {
    return null;
  }
}

async function saveSessionRecord(session: MobileSessionRecord,) {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session,),);
}

async function removeSessionRecord() {
  await SecureStore.deleteItemAsync(SESSION_KEY,);
}

function parseAuthPayload(url: string,) {
  const parsed = new URL(url,);
  const params = parsed.hash.startsWith("#",)
    ? new URLSearchParams(parsed.hash.slice(1,),)
    : parsed.searchParams;

  const accessToken = params.get("access_token",)?.trim() ?? "";
  const refreshToken = params.get("refresh_token",)?.trim() ?? "";
  return accessToken && refreshToken ? { accessToken, refreshToken, } : null;
}

async function ensureSession(client: SupabaseClient,) {
  const sessionRecord = await loadSessionRecord();
  if (!sessionRecord) return null;

  const { data, error, } = await client.auth.setSession({
    access_token: sessionRecord.accessToken,
    refresh_token: sessionRecord.refreshToken,
  },);
  if (error || !data.session) {
    return null;
  }

  await saveSessionRecord({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId: data.session.user.id,
    email: data.session.user.email?.trim().toLowerCase() ?? sessionRecord.email,
  },);
  return data.session;
}

async function fetchRemoteDocuments(client: SupabaseClient, userId: string,) {
  const { data, error, } = await client
    .from(SYNC_TABLE,)
    .select(
      "user_id, path, kind, revision, content_hash, text_content, blob_key, deleted_at, updated_at, updated_by_device_id",
    )
    .eq("user_id", userId,)
    .order("path", { ascending: true, },);

  if (error) {
    throw error;
  }

  return (data ?? []) as SyncDocumentRow[];
}

async function ensureDeviceId(settings: MobileSyncSettings,) {
  if (settings.syncDeviceId.trim()) {
    return settings.syncDeviceId.trim();
  }

  const nextSettings = {
    ...settings,
    syncDeviceId: globalThis.crypto?.randomUUID?.() ?? `mobile-${Date.now()}`,
  };
  await saveMobileSyncSettings(nextSettings,);
  return nextSettings.syncDeviceId;
}

function createManifestEntry(
  path: string,
  kind: SyncKind,
  localUri: string,
  textContent: string | null,
  base?: Partial<MobileManifestDocument>,
): MobileManifestDocument {
  const referenceDate = parseReferenceDate(path, kind,);
  return {
    path,
    kind,
    revision: base?.revision ?? 0,
    contentHash: textContent === null ? base?.contentHash ?? "" : hashContent(textContent,),
    textContent,
    blobKey: base?.blobKey ?? null,
    deletedAt: base?.deletedAt ?? null,
    updatedAt: base?.updatedAt ?? new Date().toISOString(),
    updatedByDeviceId: base?.updatedByDeviceId ?? "",
    dirty: base?.dirty ?? false,
    localUri,
    referenceDate,
    title: base?.title ?? inferTitle(path, kind, textContent,),
  };
}

async function writeTextEntry(
  manifest: MobileSyncManifest,
  path: string,
  kind: SyncKind,
  textContent: string,
  base?: Partial<MobileManifestDocument>,
) {
  const localUri = getLocalDocumentUri(path,);
  await ensureParentDirectory(localUri,);
  await FileSystem.writeAsStringAsync(localUri, textContent,);
  manifest.documents[path] = createManifestEntry(path, kind, localUri, textContent, base,);
  return manifest.documents[path];
}

async function cloneDirtyConflict(
  manifest: MobileSyncManifest,
  entry: MobileManifestDocument,
  deviceId: string,
  timestamp: string,
) {
  if (entry.textContent === null) return null;

  const conflictPath = buildConflictCopyPath(entry.path, deviceId, timestamp,);
  const conflictUri = getLocalDocumentUri(conflictPath,);
  await ensureParentDirectory(conflictUri,);
  await FileSystem.writeAsStringAsync(conflictUri, entry.textContent,);
  manifest.documents[conflictPath] = {
    ...entry,
    path: conflictPath,
    revision: 0,
    dirty: true,
    localUri: conflictUri,
    updatedAt: timestamp,
    updatedByDeviceId: deviceId,
    title: `${entry.title} (Conflict)`,
  };
  return conflictPath;
}

async function applyRemoteRow(
  client: SupabaseClient,
  manifest: MobileSyncManifest,
  row: SyncDocumentRow,
) {
  const localUri = getLocalDocumentUri(row.path,);

  if (row.deleted_at) {
    await removeIfExists(localUri,);
    delete manifest.documents[row.path];
    return;
  }

  if (getSyncStorageType(row.kind,) === "text") {
    const textContent = row.text_content ?? "";
    await writeTextEntry(manifest, row.path, row.kind, textContent, {
      revision: row.revision,
      blobKey: row.blob_key,
      deletedAt: row.deleted_at,
      dirty: false,
      updatedAt: row.updated_at,
      updatedByDeviceId: row.updated_by_device_id,
      title: inferTitle(row.path, row.kind, textContent,),
    },);
    return;
  }

  if (!row.blob_key) {
    throw new Error(`Missing blob key for ${row.path}.`,);
  }

  const { data, error, } = await client.storage.from(SYNC_BUCKET,).createSignedUrl(row.blob_key, 60,);
  if (error || !data?.signedUrl) {
    throw error ?? new Error(`Could not download ${row.path}.`,);
  }

  await ensureParentDirectory(localUri,);
  await FileSystem.downloadAsync(data.signedUrl, localUri,);
  manifest.documents[row.path] = {
    path: row.path,
    kind: row.kind,
    revision: row.revision,
    contentHash: row.content_hash,
    textContent: null,
    blobKey: row.blob_key,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    updatedByDeviceId: row.updated_by_device_id,
    dirty: false,
    localUri,
    referenceDate: parseReferenceDate(row.path, row.kind,),
    title: inferTitle(row.path, row.kind, null,),
  };
}

async function pushTextEntry(
  client: SupabaseClient,
  userId: string,
  deviceId: string,
  entry: MobileManifestDocument,
  nextRevision: number,
) {
  const payload: SyncDocumentRow = {
    user_id: userId,
    path: entry.path,
    kind: entry.kind,
    revision: nextRevision,
    content_hash: entry.contentHash,
    text_content: entry.textContent,
    blob_key: null,
    deleted_at: null,
    updated_at: new Date().toISOString(),
    updated_by_device_id: deviceId,
  };

  const { data, error, } = await client
    .from(SYNC_TABLE,)
    .upsert(payload, { onConflict: "user_id,path", },)
    .select(
      "user_id, path, kind, revision, content_hash, text_content, blob_key, deleted_at, updated_at, updated_by_device_id",
    )
    .single();

  if (error) {
    throw error;
  }

  return data as SyncDocumentRow;
}

function toHostDocumentDescriptor(entry: MobileManifestDocument,): HostDocumentDescriptor {
  return {
    id: entry.path,
    kind: entry.kind === "daily_note_markdown" ? "daily_note" : "page",
    path: entry.path,
    title: entry.title,
    referenceDate: entry.referenceDate,
    content: entry.textContent ?? "",
    updatedAt: entry.updatedAt,
  };
}

async function listTextDocumentsFromManifest(manifest: MobileSyncManifest,) {
  const entries = Object.values(manifest.documents,).filter((entry,) => (
    !entry.deletedAt
    && (entry.kind === "daily_note_markdown" || entry.kind === "page_markdown")
  ));

  for (const entry of entries) {
    if (entry.textContent !== null) continue;
    entry.textContent = await readTextIfExists(entry.localUri,);
    if (entry.textContent !== null) {
      entry.title = inferTitle(entry.path, entry.kind, entry.textContent,);
    }
  }

  return entries
    .map((entry,) => toHostDocumentDescriptor(entry,))
    .sort((left, right,) => {
      const leftTime = left.updatedAt ? new Date(left.updatedAt,).getTime() : 0;
      const rightTime = right.updatedAt ? new Date(right.updatedAt,).getTime() : 0;
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return left.title.localeCompare(right.title,);
    },);
}

function buildDailyNotePath(date: string,) {
  return `${date}.md`;
}

function buildPagePath(title: string,) {
  return `pages/${sanitizePageTitle(title,)}.md`;
}

export async function loadMobileSyncSettings() {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY,);
  if (!raw) return DEFAULT_SETTINGS;

  try {
    const parsed = JSON.parse(raw,) as Partial<MobileSyncSettings>;
    return {
      syncDeviceId: typeof parsed.syncDeviceId === "string" ? parsed.syncDeviceId : "",
      syncEmail: typeof parsed.syncEmail === "string" ? parsed.syncEmail : "",
      syncEnabled: parsed.syncEnabled === true,
      syncError: typeof parsed.syncError === "string" ? parsed.syncError : "",
      syncLastSyncedAt: typeof parsed.syncLastSyncedAt === "string" ? parsed.syncLastSyncedAt : "",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveMobileSyncSettings(settings: MobileSyncSettings,) {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings,),);
  return settings;
}

export async function updateMobileSyncSettings(patch: Partial<MobileSyncSettings>,) {
  const current = await loadMobileSyncSettings();
  const next = { ...current, ...patch, };
  await saveMobileSyncSettings(next,);
  return next;
}

export async function getMobileSyncCapability(settings?: MobileSyncSettings,) {
  const current = settings ?? await loadMobileSyncSettings();
  const session = await loadSessionRecord();

  return {
    authenticated: Boolean(session?.accessToken && session.refreshToken,),
    configured: Boolean(getSupabaseEnv(),),
    enabled: current.syncEnabled === true,
    hasPendingError: Boolean(current.syncError.trim(),),
    status: buildSyncStatusSnapshot(current,),
  };
}

export async function requestMobileSyncMagicLink(email: string,) {
  const client = createSyncClient();
  if (!client) {
    throw new Error("Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY before enabling sync.",);
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Enter an email address first.",);
  }

  const { error, } = await client.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: MOBILE_SYNC_REDIRECT_URL,
      shouldCreateUser: true,
    },
  },);
  if (error) {
    throw error;
  }

  await updateMobileSyncSettings({
    syncEmail: normalizedEmail,
    syncError: "",
  },);
}

export async function consumeMobileSyncAuthCallback(url: string,) {
  const client = createSyncClient();
  if (!client) {
    throw new Error("Missing Supabase sync configuration.",);
  }

  const auth = parseAuthPayload(url,);
  if (!auth) {
    throw new Error("Sync link did not include a valid session.",);
  }

  const { data, error, } = await client.auth.setSession({
    access_token: auth.accessToken,
    refresh_token: auth.refreshToken,
  },);
  if (error || !data.session) {
    throw error ?? new Error("Could not start sync session.",);
  }

  await saveSessionRecord({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId: data.session.user.id,
    email: data.session.user.email?.trim().toLowerCase() ?? "",
  },);

  await updateMobileSyncSettings({
    syncEmail: data.session.user.email?.trim().toLowerCase() ?? "",
    syncEnabled: true,
    syncError: "",
    syncLastSyncedAt: "",
  },);

  return data.session;
}

export async function clearMobileSyncSession() {
  await removeSessionRecord();
  const settings = await loadMobileSyncSettings();
  await saveMobileSyncSettings({
    ...settings,
    syncError: "",
  },);
}

export async function listCachedDocuments() {
  const manifest = await loadManifest();
  return await listTextDocumentsFromManifest(manifest,);
}

export async function loadMobileDocument(input: EditorHostLoadDocumentInput,): Promise<HostDocumentDescriptor | null> {
  const manifest = await loadManifest();

  if (input.kind === "daily_note") {
    const existing = Object.values(manifest.documents,).find((entry,) => (
      entry.kind === "daily_note_markdown"
      && (
        (input.path && entry.path === normalizeSyncPath(input.path,))
        || (input.date && entry.referenceDate === input.date)
      )
    ));

    if (existing) {
      if (existing.textContent === null) {
        existing.textContent = await readTextIfExists(existing.localUri,) ?? "";
      }
      return toHostDocumentDescriptor(existing,);
    }

    const date = input.date?.trim();
    if (!date) return null;

    return {
      id: buildDailyNotePath(date,),
      kind: "daily_note",
      path: buildDailyNotePath(date,),
      title: date,
      referenceDate: date,
      content: "",
      updatedAt: null,
    };
  }

  const normalizedPath = input.path ? normalizeSyncPath(input.path,) : "";
  const title = sanitizePageTitle(input.title ?? normalizedPath.replace(/^pages\//u, "",).replace(/\.md$/u, "",),);
  if (!title && !normalizedPath) return null;

  const path = normalizedPath || buildPagePath(title,);
  const existing = manifest.documents[path];
  if (existing) {
    if (existing.textContent === null) {
      existing.textContent = await readTextIfExists(existing.localUri,) ?? "";
    }
    return toHostDocumentDescriptor(existing,);
  }

  return {
    id: path,
    kind: "page",
    path,
    title,
    referenceDate: null,
    content: "",
    updatedAt: null,
  };
}

export async function saveMobileDocument(document: HostDocumentDescriptor,): Promise<{
  document: HostDocumentDescriptor;
  syncQueued: boolean;
}> {
  const manifest = await loadManifest();
  const settings = await loadMobileSyncSettings();
  const deviceId = await ensureDeviceId(settings,);
  const kind: SyncKind = document.kind === "daily_note" ? "daily_note_markdown" : "page_markdown";
  const path = normalizeSyncPath(
    document.path || (
      document.kind === "daily_note"
        ? buildDailyNotePath(document.referenceDate ?? document.title,)
        : buildPagePath(document.title,)
    ),
  );
  const now = new Date().toISOString();
  const title = document.title.trim() || inferTitle(path, kind, document.content,);

  await writeTextEntry(manifest, path, kind, document.content, {
    ...(manifest.documents[path] ?? {}),
    dirty: true,
    revision: manifest.documents[path]?.revision ?? 0,
    updatedAt: now,
    updatedByDeviceId: deviceId,
    title,
  },);
  await saveManifest(manifest,);

  return {
    document: {
      ...document,
      id: path,
      path,
      title,
      updatedAt: now,
      referenceDate: document.kind === "daily_note"
        ? (document.referenceDate ?? parseReferenceDate(path, kind,))
        : null,
    },
    syncQueued: settings.syncEnabled,
  };
}

export async function resolveMobileAssetUrl(path: string,) {
  const normalized = normalizeSyncPath(path,);
  const manifest = await loadManifest();
  const entry = manifest.documents[normalized] ?? manifest.documents[`assets/${normalized}`];
  if (!entry) return path;

  const info = await FileSystem.getInfoAsync(entry.localUri,);
  return info.exists ? entry.localUri : path;
}

export async function syncMobileNow() {
  if (activeSyncPromise) {
    return await activeSyncPromise;
  }

  const task = (async () => {
    let settings = await loadMobileSyncSettings();
    if (!settings.syncEnabled) {
      return false;
    }

    const client = createSyncClient();
    if (!client) {
      await updateMobileSyncSettings({
        syncError: "Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY.",
      },);
      return false;
    }

    const deviceId = await ensureDeviceId(settings,);
    settings = await loadMobileSyncSettings();

    const session = await ensureSession(client,);
    if (!session) {
      await updateMobileSyncSettings({
        syncError: "Sync sign-in expired. Request a new magic link.",
      },);
      return false;
    }

    const manifest = await loadManifest();
    const remoteRows = await fetchRemoteDocuments(client, session.user.id,);
    const remoteMap = new Map(remoteRows.map((row,) => [row.path, row,] as const),);
    const errors: string[] = [];

    for (const row of remoteRows) {
      const localEntry = manifest.documents[row.path];
      if (localEntry?.dirty && localEntry.textContent !== null && getSyncStorageType(localEntry.kind,) === "text") {
        const decision = resolveSyncWrite({
          path: row.path,
          kind: localEntry.kind,
          baseRevision: localEntry.revision,
          remoteRevision: row.revision,
          localHash: localEntry.contentHash,
          remoteHash: row.content_hash,
          deviceId,
        },);

        if (decision.status === "conflict") {
          const conflictPath = await cloneDirtyConflict(manifest, localEntry, deviceId, row.updated_at,);
          if (conflictPath) {
            errors.push(`Created conflict copy for ${row.path} at ${conflictPath}.`,);
          }
        }
      }

      const localRevision = manifest.documents[row.path]?.revision ?? null;
      const localHash = manifest.documents[row.path]?.contentHash ?? "";
      if (
        manifest.documents[row.path]
        && manifest.documents[row.path].dirty
        && localRevision === row.revision
        && localHash === row.content_hash
      ) {
        continue;
      }

      try {
        await applyRemoteRow(client, manifest, row,);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Failed to pull ${row.path}.`,);
      }
    }

    for (const entry of Object.values(manifest.documents,)) {
      if (!entry.dirty || entry.textContent === null) continue;

      const remote = remoteMap.get(entry.path,);
      const decision = resolveSyncWrite({
        path: entry.path,
        kind: entry.kind,
        baseRevision: entry.revision,
        remoteRevision: remote?.revision ?? null,
        localHash: entry.contentHash,
        remoteHash: remote?.content_hash ?? null,
        deviceId,
      },);

      if (decision.status === "noop") {
        entry.dirty = false;
        entry.revision = remote?.revision ?? entry.revision;
        continue;
      }

      if (decision.status === "conflict") {
        errors.push(`Skipped uploading ${entry.path} because the remote revision changed.`,);
        continue;
      }

      try {
        const saved = await pushTextEntry(client, session.user.id, deviceId, entry, decision.nextRevision ?? 1,);
        remoteMap.set(saved.path, saved,);
        manifest.documents[entry.path] = {
          ...entry,
          revision: saved.revision,
          dirty: false,
          blobKey: saved.blob_key,
          contentHash: saved.content_hash,
          textContent: saved.text_content,
          deletedAt: saved.deleted_at,
          updatedAt: saved.updated_at,
          updatedByDeviceId: saved.updated_by_device_id,
          title: inferTitle(saved.path, saved.kind, saved.text_content,),
        };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Failed to upload ${entry.path}.`,);
      }
    }

    await saveManifest(manifest,);
    const syncedAt = new Date().toISOString();
    await updateMobileSyncSettings({
      syncError: errors.join(" ",).trim(),
      syncLastSyncedAt: syncedAt,
    },);

    return true;
  })();

  activeSyncPromise = task.finally(() => {
    activeSyncPromise = null;
  },);

  return await activeSyncPromise;
}

export function describeMobileSyncSession(settings: MobileSyncSettings,) {
  if (!getSupabaseEnv()) {
    return "Supabase env vars are missing.";
  }
  return settings.syncEmail.trim() || "Not connected";
}

export function formatMobileSyncTimestamp(value: string,) {
  const trimmed = value.trim();
  if (!trimmed) return "Never";

  const parsed = new Date(trimmed,);
  if (Number.isNaN(parsed.getTime(),)) {
    return "Never";
  }

  return parsed.toLocaleString();
}

export function formatMobileSyncError(value: string,) {
  return value.trim() || "No sync errors.";
}

export function createMobileSyncStatusSnapshot(settings: MobileSyncSettings, syncing = false,) {
  return buildSyncStatusSnapshot(settings, syncing ? "syncing" : undefined,);
}

export async function openOrCreateTodayNote(date: string,): Promise<HostDocumentDescriptor | null> {
  return await loadMobileDocument({
    kind: "daily_note",
    date,
  },);
}

export async function openOrCreatePage(title: string,): Promise<HostDocumentDescriptor | null> {
  return await loadMobileDocument({
    kind: "page",
    title,
  },);
}

export function canEditDocument(document: HostDocumentDescriptor,) {
  const classified = classifySyncPath(document.path,);
  return classified === "daily_note_markdown" || classified === "page_markdown";
}
