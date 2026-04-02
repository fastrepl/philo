export type HostDocumentKind = "daily_note" | "page";
export type SyncStatusKind = "idle" | "syncing" | "offline" | "error";

export interface HostDocumentDescriptor {
  id: string;
  kind: HostDocumentKind;
  path: string;
  title: string;
  referenceDate: string | null;
  content: string;
  updatedAt: string | null;
}

export interface EditorHostLoadDocumentInput {
  kind: HostDocumentKind;
  path?: string;
  date?: string;
  title?: string;
}

export interface EditorHostSaveDocumentInput {
  document: HostDocumentDescriptor;
}

export interface EditorHostSaveDocumentResult {
  document: HostDocumentDescriptor;
  syncQueued: boolean;
}

export interface HostPickedAsset {
  name: string;
  mimeType: string;
  path: string;
}

export interface SyncStatusSnapshot {
  state: SyncStatusKind;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  pendingUploads: number;
  pendingDownloads: number;
}

export interface WidgetRuntimeBridge {
  runWidgetQuery(
    widgetPath: string,
    widgetId: string,
    queryName: string,
    params?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>>;
  runWidgetMutation(
    widgetPath: string,
    widgetId: string,
    mutationName: string,
    params?: Record<string, unknown>,
  ): Promise<number>;
}

export interface EditorHostBridge extends WidgetRuntimeBridge {
  loadDocument(input: EditorHostLoadDocumentInput,): Promise<HostDocumentDescriptor | null>;
  saveDocument(input: EditorHostSaveDocumentInput,): Promise<EditorHostSaveDocumentResult>;
  openNote(date: string,): Promise<void>;
  openPage(title: string,): Promise<void>;
  resolveAssetUrl(path: string,): Promise<string>;
  pickImage(): Promise<HostPickedAsset | null>;
  openExternalUrl(url: string,): Promise<void>;
  reportSyncState(state: SyncStatusSnapshot,): Promise<void>;
}

export type EditorHostOutboundMessage =
  | { type: "bridge_ready"; }
  | { type: "load_document"; input: EditorHostLoadDocumentInput; }
  | { type: "save_document"; input: EditorHostSaveDocumentInput; }
  | { type: "open_note"; date: string; }
  | { type: "open_page"; title: string; }
  | { type: "resolve_asset_url"; path: string; requestId: string; }
  | { type: "pick_image"; requestId: string; }
  | {
    type: "run_widget_query";
    queryName: string;
    params?: Record<string, unknown>;
    requestId: string;
    widgetId: string;
    widgetPath: string;
  }
  | {
    type: "run_widget_mutation";
    mutationName: string;
    params?: Record<string, unknown>;
    requestId: string;
    widgetId: string;
    widgetPath: string;
  }
  | { type: "open_external_url"; url: string; }
  | { type: "report_sync_state"; state: SyncStatusSnapshot; };

export type EditorHostInboundMessage =
  | { type: "document_loaded"; document: HostDocumentDescriptor | null; }
  | { type: "document_saved"; result: EditorHostSaveDocumentResult; }
  | { type: "asset_url_resolved"; path: string; requestId: string; url: string; }
  | { type: "image_picked"; asset: HostPickedAsset | null; requestId: string; }
  | { type: "widget_query_result"; requestId: string; rows: Array<Record<string, unknown>>; }
  | { type: "widget_mutation_result"; changedRows: number; requestId: string; }
  | { type: "sync_state"; state: SyncStatusSnapshot; }
  | { type: "bridge_error"; message: string; requestId?: string; };

function isRecord(value: unknown,): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown,): value is string | null | undefined {
  return typeof value === "string" || value === null || value === undefined;
}

function isHostDocumentKind(value: unknown,): value is HostDocumentKind {
  return value === "daily_note" || value === "page";
}

function isHostDocumentDescriptor(value: unknown,): value is HostDocumentDescriptor {
  if (!isRecord(value,)) return false;

  return (
    typeof value.id === "string"
    && isHostDocumentKind(value.kind,)
    && typeof value.path === "string"
    && typeof value.title === "string"
    && isOptionalString(value.referenceDate,)
    && typeof value.content === "string"
    && isOptionalString(value.updatedAt,)
  );
}

function isEditorHostSaveDocumentResult(value: unknown,): value is EditorHostSaveDocumentResult {
  if (!isRecord(value,)) return false;
  return isHostDocumentDescriptor(value.document,) && typeof value.syncQueued === "boolean";
}

function isSyncStatusSnapshot(value: unknown,): value is SyncStatusSnapshot {
  if (!isRecord(value,)) return false;

  return (
    (value.state === "idle" || value.state === "syncing" || value.state === "offline" || value.state === "error")
    && isOptionalString(value.lastSyncedAt,)
    && isOptionalString(value.errorMessage,)
    && typeof value.pendingUploads === "number"
    && typeof value.pendingDownloads === "number"
  );
}

function isPlainObjectArray(value: unknown,): value is Array<Record<string, unknown>> {
  return Array.isArray(value,) && value.every((entry,) => isRecord(entry,));
}

function maybeParseJson(value: unknown,) {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value,);
  } catch {
    return null;
  }
}

export function parseEditorHostOutboundMessage(value: unknown,): EditorHostOutboundMessage | null {
  const parsed = maybeParseJson(value,);
  if (!isRecord(parsed,) || typeof parsed.type !== "string") return null;

  switch (parsed.type) {
    case "bridge_ready":
      return { type: "bridge_ready", };
    case "load_document":
      if (!isRecord(parsed.input,) || !isHostDocumentKind(parsed.input.kind,)) return null;
      if (
        !isOptionalString(parsed.input.path,) || !isOptionalString(parsed.input.date,)
        || !isOptionalString(parsed.input.title,)
      ) {
        return null;
      }
      return {
        type: "load_document",
        input: {
          kind: parsed.input.kind,
          path: typeof parsed.input.path === "string" ? parsed.input.path : undefined,
          date: typeof parsed.input.date === "string" ? parsed.input.date : undefined,
          title: typeof parsed.input.title === "string" ? parsed.input.title : undefined,
        },
      };
    case "save_document":
      if (!isRecord(parsed.input,) || !isHostDocumentDescriptor(parsed.input.document,)) return null;
      return {
        type: "save_document",
        input: {
          document: parsed.input.document,
        },
      };
    case "open_note":
      return typeof parsed.date === "string" ? { type: "open_note", date: parsed.date, } : null;
    case "open_page":
      return typeof parsed.title === "string" ? { type: "open_page", title: parsed.title, } : null;
    case "resolve_asset_url":
      return typeof parsed.path === "string" && typeof parsed.requestId === "string"
        ? { type: "resolve_asset_url", path: parsed.path, requestId: parsed.requestId, }
        : null;
    case "pick_image":
      return typeof parsed.requestId === "string" ? { type: "pick_image", requestId: parsed.requestId, } : null;
    case "run_widget_query":
      if (
        typeof parsed.widgetPath !== "string"
        || typeof parsed.widgetId !== "string"
        || typeof parsed.queryName !== "string"
        || typeof parsed.requestId !== "string"
      ) {
        return null;
      }
      return {
        type: "run_widget_query",
        widgetPath: parsed.widgetPath,
        widgetId: parsed.widgetId,
        queryName: parsed.queryName,
        requestId: parsed.requestId,
        params: isRecord(parsed.params,) ? parsed.params : undefined,
      };
    case "run_widget_mutation":
      if (
        typeof parsed.widgetPath !== "string"
        || typeof parsed.widgetId !== "string"
        || typeof parsed.mutationName !== "string"
        || typeof parsed.requestId !== "string"
      ) {
        return null;
      }
      return {
        type: "run_widget_mutation",
        widgetPath: parsed.widgetPath,
        widgetId: parsed.widgetId,
        mutationName: parsed.mutationName,
        requestId: parsed.requestId,
        params: isRecord(parsed.params,) ? parsed.params : undefined,
      };
    case "open_external_url":
      return typeof parsed.url === "string" ? { type: "open_external_url", url: parsed.url, } : null;
    case "report_sync_state":
      return isSyncStatusSnapshot(parsed.state,) ? { type: "report_sync_state", state: parsed.state, } : null;
    default:
      return null;
  }
}

export function parseEditorHostInboundMessage(value: unknown,): EditorHostInboundMessage | null {
  const parsed = maybeParseJson(value,);
  if (!isRecord(parsed,) || typeof parsed.type !== "string") return null;

  switch (parsed.type) {
    case "document_loaded":
      return parsed.document === null || isHostDocumentDescriptor(parsed.document,)
        ? { type: "document_loaded", document: parsed.document, }
        : null;
    case "document_saved":
      return isEditorHostSaveDocumentResult(parsed.result,)
        ? { type: "document_saved", result: parsed.result, }
        : null;
    case "asset_url_resolved":
      return typeof parsed.path === "string" && typeof parsed.requestId === "string" && typeof parsed.url === "string"
        ? { type: "asset_url_resolved", path: parsed.path, requestId: parsed.requestId, url: parsed.url, }
        : null;
    case "image_picked":
      if (parsed.asset === null) {
        return { type: "image_picked", asset: null, requestId: String(parsed.requestId ?? "",), };
      }
      if (
        typeof parsed.requestId === "string"
        && isRecord(parsed.asset,)
        && typeof parsed.asset.name === "string"
        && typeof parsed.asset.mimeType === "string"
        && typeof parsed.asset.path === "string"
      ) {
        return {
          type: "image_picked",
          requestId: parsed.requestId,
          asset: {
            name: parsed.asset.name,
            mimeType: parsed.asset.mimeType,
            path: parsed.asset.path,
          },
        };
      }
      return null;
    case "widget_query_result":
      return typeof parsed.requestId === "string" && isPlainObjectArray(parsed.rows,)
        ? { type: "widget_query_result", requestId: parsed.requestId, rows: parsed.rows, }
        : null;
    case "widget_mutation_result":
      return typeof parsed.requestId === "string" && typeof parsed.changedRows === "number"
        ? { type: "widget_mutation_result", requestId: parsed.requestId, changedRows: parsed.changedRows, }
        : null;
    case "sync_state":
      return isSyncStatusSnapshot(parsed.state,) ? { type: "sync_state", state: parsed.state, } : null;
    case "bridge_error":
      return typeof parsed.message === "string" && isOptionalString(parsed.requestId,)
        ? {
          type: "bridge_error",
          message: parsed.message,
          requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
        }
        : null;
    default:
      return null;
  }
}
