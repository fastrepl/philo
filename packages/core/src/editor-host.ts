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
