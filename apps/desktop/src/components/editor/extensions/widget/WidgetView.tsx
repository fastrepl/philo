import { NodeViewWrapper, } from "@tiptap/react";
import type { NodeViewProps, } from "@tiptap/react";
import { Archive, History, PencilLine, RefreshCw, Trash2, } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, } from "react";
import { getAiConfigurationMessage, isAiKeyMissingError, } from "../../../../services/ai";
import { generateWidgetWithStorage, } from "../../../../services/generate";
import {
  addToLibrary,
  getSharedComponent,
  loadLibrary,
  resolveStoredWidgetSource,
  runSharedComponentMutation,
  runSharedComponentQuery,
  SHARED_COMPONENTS_UPDATED_EVENT,
  type SharedComponentManifest,
  type SharedStorageSchema,
  updateSharedComponent,
} from "../../../../services/library";
import { SETTINGS_UPDATED_EVENT, } from "../../../../services/settings";
import {
  appendWidgetRevision,
  createWidgetFile,
  readWidgetFile,
  updateWidgetFile,
  type WidgetRuntimeKind,
} from "../../../../services/widget-files";
import {
  ensureWidgetGitHistoryBaseline,
  getWidgetGitDiff,
  isWidgetGitHistoryEnabled,
  listWidgetGitHistory,
  recordWidgetGitRevision,
  restoreWidgetGitRevision,
  type WidgetGitDiff,
  type WidgetGitHistoryEntry,
  type WidgetGitReason,
} from "../../../../services/widget-git-history";
import {
  hasPersistentStorage,
  parseStorageSchema,
  runWidgetStorageMutation,
  runWidgetStorageQuery,
  stringifyStorageSchema,
} from "../../../../services/widget-storage";
import { CodeWidgetRenderer, } from "./code/Renderer";
import {
  WIDGET_BUILD_STATE_EVENT,
  WIDGET_EDIT_REQUEST_EVENT,
  WIDGET_EDIT_STATE_EVENT,
  WIDGET_EDIT_SUBMIT_EVENT,
  type WidgetBuildStateDetail,
  type WidgetEditStateDetail,
  type WidgetEditSubmitDetail,
} from "./events";
import { waitForNextPaint, } from "./loading";
import type { SharedWidgetRuntimeApi, } from "./runtime";
import { WidgetHistoryPanel, } from "./WidgetHistoryPanel";

const EMPTY_STORAGE_SCHEMA: SharedStorageSchema = {
  tables: [],
  namedQueries: [],
  namedMutations: [],
};

function cloneSchema(value: SharedStorageSchema,): SharedStorageSchema {
  return {
    tables: value.tables
      .slice()
      .sort((a, b,) => a.name.localeCompare(b.name,))
      .map((table,) => ({
        ...table,
        columns: table.columns
          .slice()
          .sort((a, b,) => a.name.localeCompare(b.name,)),
        indexes: (table.indexes ?? []).slice().sort((a, b,) => a.name.localeCompare(b.name,)),
      })),
    namedQueries: value.namedQueries
      .slice()
      .sort((a, b,) => a.name.localeCompare(b.name,))
      .map((query,) => ({
        ...query,
        columns: query.columns.slice().sort(),
        filters: query.filters.slice().sort((a, b,) => {
          const byColumn = a.column.localeCompare(b.column,);
          if (byColumn !== 0) return byColumn;
          return a.parameter.localeCompare(b.parameter,);
        },),
      })),
    namedMutations: value.namedMutations
      .slice()
      .sort((a, b,) => a.name.localeCompare(b.name,))
      .map((mutation,) => ({
        ...mutation,
        filters: mutation.filters.slice().sort((a, b,) => {
          const byColumn = a.column.localeCompare(b.column,);
          if (byColumn !== 0) return byColumn;
          return a.parameter.localeCompare(b.parameter,);
        },),
        setColumns: mutation.setColumns.slice().sort(),
      })),
  };
}

function storageSchemaMatch(a: SharedStorageSchema, b: SharedStorageSchema,): boolean {
  return JSON.stringify(cloneSchema(a,),) === JSON.stringify(cloneSchema(b,),);
}

function prettyPrintLegacyContent(candidate: unknown,): string {
  if (!candidate) return "";
  if (typeof candidate === "string") {
    try {
      return JSON.stringify(JSON.parse(candidate,), null, 2,);
    } catch {
      return candidate.trim();
    }
  }

  try {
    return JSON.stringify(candidate, null, 2,);
  } catch {
    return "";
  }
}

function buildWidgetGenerationPrompt(
  prompt: string,
  current: { runtime: WidgetRuntimeKind; content: string; } | null,
  instruction?: string,
): string {
  const basePrompt = prompt.trim();
  if (!current?.content.trim()) {
    return instruction ? `${basePrompt}\n\nChange request: ${instruction}` : basePrompt;
  }

  const parts = [
    basePrompt,
    "",
    current.runtime === "code"
      ? "Current widget TSX:"
      : "Legacy widget JSON to preserve while rewriting it as a TSX widget:",
    current.content,
  ];

  if (instruction) {
    parts.push("", `Apply this change to the current widget: ${instruction}`,);
  } else if (current.runtime === "code") {
    parts.push(
      "",
      "Rebuild this widget from the current TSX. Preserve its behavior and storage contract unless a small fix is clearly needed.",
    );
  } else {
    parts.push(
      "",
      "Rewrite this legacy JSON widget as a TSX code widget. Preserve its behavior and storage contract unless a small fix is clearly needed.",
    );
  }

  return parts.join("\n",);
}

function deriveTitle(prompt: string,): string {
  const firstSentence = prompt.split(/[.!?\n]/,)[0].trim();
  if (!firstSentence) return "Widget";
  if (firstSentence.length <= 40) return firstSentence;
  return `${firstSentence.slice(0, 37,)}...`;
}

function formatToolbarTitle(prompt: string,): string {
  const title = deriveTitle(prompt,);
  if (!title) return "Widget";
  return title.charAt(0,).toUpperCase() + title.slice(1,);
}

export function WidgetView({ node, updateAttributes, deleteNode, selected, }: NodeViewProps,) {
  const {
    id,
    storageId: storageIdAttr,
    spec: specStr,
    source: sourceStr,
    saved,
    prompt,
    loading,
    error,
    componentId,
    libraryItemId,
    file,
    path,
    storageSchema: storageSchemaStr,
  } = node.attrs as {
    id: string;
    storageId?: string;
    runtime?: WidgetRuntimeKind;
    spec: string;
    source?: string;
    saved: boolean;
    prompt: string;
    loading: boolean;
    error: string;
    componentId?: string | null;
    libraryItemId?: string | null;
    file?: string;
    path?: string;
    storageSchema?: string;
  };
  const [missingComponent, setMissingComponent,] = useState(false,);
  const [sharedLoading, setSharedLoading,] = useState(false,);
  const [manifest, setManifest,] = useState<SharedComponentManifest | null>(null,);
  const [sharedLoadError, setSharedLoadError,] = useState<string | null>(null,);
  const [runtimeRefreshToken, setRuntimeRefreshToken,] = useState(0,);
  const [isEditingInChat, setIsEditingInChat,] = useState(false,);
  const [historyEnabled, setHistoryEnabled,] = useState(true,);
  const [historyOpen, setHistoryOpen,] = useState(false,);
  const [historyEntries, setHistoryEntries,] = useState<WidgetGitHistoryEntry[]>([],);
  const [historyLoading, setHistoryLoading,] = useState(false,);
  const [historyError, setHistoryError,] = useState("",);
  const [selectedHistoryCommitId, setSelectedHistoryCommitId,] = useState<string | null>(null,);
  const [historyDiff, setHistoryDiff,] = useState<WidgetGitDiff | null>(null,);
  const [historyRestoring, setHistoryRestoring,] = useState(false,);
  const effectiveLibraryItemId = libraryItemId ?? componentId ?? null;
  const storageId = storageIdAttr || id;
  const storageSchema = useMemo(() => parseStorageSchema(storageSchemaStr,), [storageSchemaStr,],);
  const isShared = Boolean(componentId,);
  const localSource = (sourceStr ?? "").trim();
  const sharedSource = useMemo(() => resolveStoredWidgetSource(manifest?.uiSpec,), [manifest?.uiSpec,],);
  const currentSource = useMemo(
    () => (isShared ? sharedSource || localSource : localSource),
    [isShared, localSource, sharedSource,],
  );
  const legacyContent = useMemo(
    () => prettyPrintLegacyContent(isShared ? manifest?.uiSpec ?? specStr : specStr,),
    [isShared, manifest?.uiSpec, specStr,],
  );
  const generationContext = useMemo(
    () =>
      currentSource
        ? { runtime: "code" as const, content: currentSource, }
        : legacyContent
        ? { runtime: "json" as const, content: legacyContent, }
        : null,
    [currentSource, legacyContent,],
  );

  const loadManifest = useCallback(async () => {
    if (!componentId) {
      setManifest(null,);
      setMissingComponent(false,);
      setSharedLoadError(null,);
      return;
    }

    setSharedLoading(true,);
    setSharedLoadError(null,);
    try {
      const value = await getSharedComponent(componentId,);
      if (!value) {
        setManifest(null,);
        setMissingComponent(true,);
        return;
      }
      setManifest(value,);
      setMissingComponent(false,);
    } catch (err) {
      setSharedLoadError(err instanceof Error ? err.message : "Could not load shared component.",);
      setManifest(null,);
      setMissingComponent(true,);
    } finally {
      setSharedLoading(false,);
    }
  }, [componentId,],);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest,],);

  useEffect(() => {
    let cancelled = false;

    const refreshHistoryEnabled = async () => {
      const enabled = await isWidgetGitHistoryEnabled().catch(() => true);
      if (cancelled) return;
      setHistoryEnabled(enabled,);
      if (!enabled) {
        setHistoryOpen(false,);
      }
    };

    void refreshHistoryEnabled();
    window.addEventListener(SETTINGS_UPDATED_EVENT, refreshHistoryEnabled,);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_UPDATED_EVENT, refreshHistoryEnabled,);
    };
  }, [],);

  useEffect(() => {
    if (!componentId) return;

    const handleSharedUpdate = (event: Event,) => {
      const detail = (event as CustomEvent<{ componentId?: string | null; }>).detail;
      if (detail?.componentId && detail.componentId !== componentId) {
        return;
      }
      void loadManifest();
    };

    window.addEventListener(SHARED_COMPONENTS_UPDATED_EVENT, handleSharedUpdate,);
    return () => window.removeEventListener(SHARED_COMPONENTS_UPDATED_EVENT, handleSharedUpdate,);
  }, [componentId, loadManifest,],);

  useEffect(() => {
    const handleWidgetEditState = (event: Event,) => {
      const detail = (event as CustomEvent<WidgetEditStateDetail>).detail;
      if (detail?.widgetId !== id) return;
      setIsEditingInChat(detail.isEditing,);
    };

    const handleWidgetEditSubmit = (event: Event,) => {
      const detail = (event as CustomEvent<WidgetEditSubmitDetail>).detail;
      if (detail?.widgetId !== id) return;
      const instruction = detail.instruction.trim();
      if (!instruction) return;
      void runGeneration(buildWidgetGenerationPrompt(prompt, generationContext, instruction,), prompt, "edit",);
    };

    window.addEventListener(WIDGET_EDIT_STATE_EVENT, handleWidgetEditState,);
    window.addEventListener(WIDGET_EDIT_SUBMIT_EVENT, handleWidgetEditSubmit,);
    return () => {
      window.removeEventListener(WIDGET_EDIT_STATE_EVENT, handleWidgetEditState,);
      window.removeEventListener(WIDGET_EDIT_SUBMIT_EVENT, handleWidgetEditSubmit,);
    };
  }, [generationContext, id, prompt,],);

  const loadHistory = useCallback(async (preferredCommitId?: string | null,) => {
    if (!file || !path || !historyEnabled) return;

    setHistoryLoading(true,);
    setHistoryError("",);
    try {
      const currentRecord = await readWidgetFile(path, file,);
      if (!currentRecord) {
        throw new Error("Could not load this widget from disk.",);
      }
      await ensureWidgetGitHistoryBaseline(currentRecord,);
      const entries = await listWidgetGitHistory(currentRecord,);
      const nextCommitId = entries.some((entry,) => entry.commitId === preferredCommitId)
        ? preferredCommitId ?? null
        : entries[0]?.commitId ?? null;

      setHistoryEntries(entries,);
      setSelectedHistoryCommitId(nextCommitId,);

      if (!nextCommitId) {
        setHistoryDiff(null,);
        return;
      }

      setHistoryDiff(await getWidgetGitDiff(currentRecord, nextCommitId,),);
    } catch (err) {
      setHistoryDiff(null,);
      setHistoryEntries([],);
      setSelectedHistoryCommitId(null,);
      setHistoryError(err instanceof Error ? err.message : "Could not load widget history.",);
    } finally {
      setHistoryLoading(false,);
    }
  }, [file, historyEnabled, path,],);

  useEffect(() => {
    if (!historyOpen) return;
    void loadHistory(selectedHistoryCommitId,);
  }, [
    componentId,
    file,
    historyOpen,
    libraryItemId,
    loadHistory,
    path,
    prompt,
    saved,
    selectedHistoryCommitId,
    sourceStr,
    specStr,
    storageSchemaStr,
  ],);

  const runtimeApi: SharedWidgetRuntimeApi = useMemo(() => {
    if (path && storageSchema && hasPersistentStorage(storageSchema,)) {
      return {
        mode: "instance",
        runQuery: async (queryName: string, params: Record<string, unknown> = {},) =>
          runWidgetStorageQuery(path, storageId, storageSchema, queryName, params,),
        runMutation: async (mutationName: string, params: Record<string, unknown> = {},) => {
          const changed = await runWidgetStorageMutation(path, storageId, storageSchema, mutationName, params,);
          setRuntimeRefreshToken((value,) => value + 1);
          return changed;
        },
        refresh: () => {
          setRuntimeRefreshToken((value,) => value + 1);
        },
        refreshToken: runtimeRefreshToken,
      };
    }

    if (!isShared || !componentId || missingComponent || !manifest) {
      return {
        mode: "inline",
        runQuery: async () => [],
        runMutation: async () => 0,
        refresh: () => {
        },
        refreshToken: runtimeRefreshToken,
      };
    }

    return {
      mode: "shared",
      runQuery: async (queryName: string, params: Record<string, unknown> = {},) =>
        runSharedComponentQuery(componentId, queryName, params,),
      runMutation: async (mutationName: string, params: Record<string, unknown> = {},) => {
        const changed = await runSharedComponentMutation(componentId, mutationName, params,);
        setRuntimeRefreshToken((value,) => value + 1);
        return changed;
      },
      refresh: () => {
        setRuntimeRefreshToken((value,) => value + 1);
      },
      refreshToken: runtimeRefreshToken,
    };
  }, [componentId, isShared, manifest, missingComponent, path, runtimeRefreshToken, storageId, storageSchema,],);

  const persistWidgetRecord = useCallback(async ({
    nextPrompt,
    nextRuntime,
    nextSource,
    nextSpec = "",
    nextSaved,
    nextLibraryItemId,
    nextComponentId,
    nextStorageSchema,
    createRevision = false,
    historyReason = null,
  }: {
    nextPrompt: string;
    nextRuntime: WidgetRuntimeKind;
    nextSource?: string;
    nextSpec?: string;
    nextSaved: boolean;
    nextLibraryItemId?: string | null;
    nextComponentId?: string | null;
    nextStorageSchema?: SharedStorageSchema | null;
    createRevision?: boolean;
    historyReason?: Exclude<WidgetGitReason, "import"> | null;
  },) => {
    const title = deriveTitle(nextPrompt,);
    const existingRecord = path && file ? await readWidgetFile(path, file,) : null;
    const effectiveSource = nextRuntime === "code"
      ? (nextSource ?? existingRecord?.source ?? sourceStr ?? "").trim()
      : (existingRecord?.source ?? "").trim();
    const effectiveSpec = nextRuntime === "json"
      ? (nextSpec ?? existingRecord?.spec ?? "").trim()
      : "";
    const persistedStorageId = existingRecord?.id || storageId;
    const nextPrimaryContent = nextRuntime === "code" ? effectiveSource : effectiveSpec;
    const nextHistory = existingRecord
      ? createRevision
        ? appendWidgetRevision(
          {
            ...existingRecord,
            runtime: nextRuntime,
            spec: effectiveSpec,
            source: effectiveSource,
          },
          nextPrompt,
          nextPrimaryContent,
        )
        : {
          currentRevisionId: existingRecord.currentRevisionId,
          revisions: existingRecord.revisions,
        }
      : undefined;

    if (path && file) {
      const record = await updateWidgetFile(path, file, {
        id: persistedStorageId,
        title,
        prompt: nextPrompt,
        runtime: nextRuntime,
        favorite: existingRecord?.favorite ?? false,
        saved: nextSaved,
        spec: effectiveSpec,
        source: effectiveSource,
        currentRevisionId: nextHistory?.currentRevisionId ?? existingRecord?.currentRevisionId ?? "",
        revisions: nextHistory?.revisions ?? existingRecord?.revisions ?? [],
        libraryItemId: nextLibraryItemId ?? null,
        componentId: nextComponentId ?? null,
        storageSchema: nextStorageSchema ?? existingRecord?.storageSchema ?? null,
      },);
      if (historyReason) {
        await recordWidgetGitRevision(record, historyReason, existingRecord,);
      }
      return record;
    }

    const record = await createWidgetFile({
      title,
      prompt: nextPrompt,
      runtime: nextRuntime,
      spec: effectiveSpec,
      source: effectiveSource,
      favorite: existingRecord?.favorite ?? false,
      saved: nextSaved,
      currentRevisionId: nextHistory?.currentRevisionId,
      revisions: nextHistory?.revisions,
      libraryItemId: nextLibraryItemId ?? null,
      componentId: nextComponentId ?? null,
      storageSchema: nextStorageSchema ?? existingRecord?.storageSchema ?? null,
    },);
    if (historyReason) {
      await recordWidgetGitRevision(record, historyReason, existingRecord,);
    }
    return record;
  }, [file, path, sourceStr, storageId,],);

  const runGeneration = async (
    generationPrompt: string,
    persistedPrompt = prompt,
    historyReason: Extract<WidgetGitReason, "rebuild" | "edit"> = "rebuild",
  ) => {
    window.dispatchEvent(
      new CustomEvent<WidgetBuildStateDetail>(WIDGET_BUILD_STATE_EVENT, {
        detail: { widgetId: id, isBuilding: true, },
      },),
    );
    updateAttributes({ prompt: persistedPrompt, loading: true, error: "", },);
    await waitForNextPaint();
    try {
      if (isShared && manifest) {
        const generated = await generateWidgetWithStorage(generationPrompt, manifest.storageSchema,);
        if (!storageSchemaMatch(generated.storageSchema, manifest.storageSchema,)) {
          throw new Error("Storage schema changed. Save as a new component to rebuild with a new DB schema.",);
        }
        const next = await updateSharedComponent(manifest.id, generated.source, persistedPrompt,);
        setManifest(next,);
        const record = await persistWidgetRecord({
          nextPrompt: persistedPrompt,
          nextRuntime: "code",
          nextSource: resolveStoredWidgetSource(next.uiSpec,) || generated.source,
          nextSaved: true,
          nextLibraryItemId: effectiveLibraryItemId,
          nextComponentId: manifest.id,
          nextStorageSchema: generated.storageSchema,
          createRevision: true,
          historyReason,
        },);
        updateAttributes({
          storageId: record.id,
          runtime: record.runtime,
          file: record.file,
          path: record.path,
          libraryItemId: record.libraryItemId,
          componentId: manifest.id,
          prompt: persistedPrompt,
          loading: false,
          spec: record.spec,
          source: record.source,
          storageSchema: stringifyStorageSchema(record.storageSchema,),
          saved: true,
          error: "",
        },);
        return;
      }

      const generated = await generateWidgetWithStorage(generationPrompt, storageSchema ?? undefined,);
      if (storageSchema && !storageSchemaMatch(generated.storageSchema, storageSchema,)) {
        throw new Error("Storage schema changed. Build a new widget to use a new DB schema.",);
      }
      const record = await persistWidgetRecord({
        nextPrompt: persistedPrompt,
        nextRuntime: "code",
        nextSource: generated.source,
        nextSaved: saved,
        nextLibraryItemId: effectiveLibraryItemId,
        nextComponentId: componentId,
        nextStorageSchema: generated.storageSchema,
        createRevision: true,
        historyReason,
      },);
      updateAttributes({
        storageId: record.id,
        runtime: record.runtime,
        file: record.file,
        path: record.path,
        libraryItemId: record.libraryItemId,
        componentId: record.componentId,
        prompt: persistedPrompt,
        spec: record.spec,
        source: record.source,
        storageSchema: stringifyStorageSchema(record.storageSchema,),
        loading: false,
        error: "",
      },);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === "string" ? err : "Something went wrong.";
      updateAttributes({
        prompt: persistedPrompt,
        loading: false,
        error: isAiKeyMissingError(errMsg,) ? getAiConfigurationMessage(errMsg,) : errMsg,
      },);
    } finally {
      window.dispatchEvent(
        new CustomEvent<WidgetBuildStateDetail>(WIDGET_BUILD_STATE_EVENT, {
          detail: { widgetId: id, isBuilding: false, },
        },),
      );
    }
  };

  const handleRebuild = async () => {
    await runGeneration(buildWidgetGenerationPrompt(prompt, generationContext,), prompt, "rebuild",);
  };

  const handleSave = async () => {
    if (isShared || !prompt || !currentSource) return;

    updateAttributes({ loading: true, error: "", },);
    await waitForNextPaint();
    try {
      const nextStorageSchema = storageSchema ?? EMPTY_STORAGE_SCHEMA;
      const item = await addToLibrary({
        title: deriveTitle(prompt,),
        description: prompt,
        prompt,
        html: currentSource,
        source: currentSource,
        storageSchema: nextStorageSchema,
      },);
      const record = await persistWidgetRecord({
        nextPrompt: prompt,
        nextRuntime: "code",
        nextSource: currentSource,
        nextSaved: true,
        nextLibraryItemId: item.id,
        nextComponentId: item.componentId,
        nextStorageSchema,
        createRevision: true,
        historyReason: "archive",
      },);

      updateAttributes({
        storageId: record.id,
        runtime: record.runtime,
        file: record.file,
        path: record.path,
        libraryItemId: item.id,
        componentId: item.componentId,
        spec: record.spec,
        source: record.source,
        storageSchema: stringifyStorageSchema(record.storageSchema,),
        saved: true,
        loading: false,
        error: "",
      },);
      if (item.componentId) {
        setManifest(await getSharedComponent(item.componentId,),);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === "string" ? err : "Something went wrong.";
      updateAttributes({
        loading: false,
        error: isAiKeyMissingError(errMsg,) ? getAiConfigurationMessage(errMsg,) : errMsg,
      },);
    }
  };

  const handleSelectHistory = async (commitId: string,) => {
    if (!file || !path) return;

    setSelectedHistoryCommitId(commitId,);
    setHistoryError("",);
    try {
      const currentRecord = await readWidgetFile(path, file,);
      if (!currentRecord) {
        throw new Error("Could not load this widget from disk.",);
      }
      setHistoryDiff(await getWidgetGitDiff(currentRecord, commitId,),);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Could not load widget diff.",);
    }
  };

  const handleRestoreHistory = async () => {
    if (!file || !path || !selectedHistoryCommitId || !historyDiff?.canRestore) return;

    setHistoryRestoring(true,);
    setHistoryError("",);
    try {
      const currentRecord = await readWidgetFile(path, file,);
      if (!currentRecord) {
        throw new Error("Could not load this widget from disk.",);
      }

      const { snapshot, } = await restoreWidgetGitRevision(currentRecord, selectedHistoryCommitId,);
      const currentSchema = stringifyStorageSchema(currentRecord.storageSchema,);
      const restoredSchema = stringifyStorageSchema(snapshot.storageSchema,);
      if (currentSchema !== restoredSchema) {
        throw new Error("Restore is blocked because the widget storage schema changed.",);
      }

      let nextSaved = snapshot.saved;
      let nextLibraryItemId = snapshot.libraryItemId ?? null;
      let nextComponentId = snapshot.componentId ?? null;
      if (nextLibraryItemId || nextComponentId) {
        const [libraryItems, componentManifest,] = await Promise.all([
          nextLibraryItemId ? loadLibrary().catch(() => []) : Promise.resolve([],),
          nextComponentId ? getSharedComponent(nextComponentId,).catch(() => null) : Promise.resolve(null,),
        ],);
        const hasLibraryItem = nextLibraryItemId
          ? libraryItems.some((item,) => item.id === nextLibraryItemId || item.componentId === nextComponentId)
          : true;
        const hasComponent = nextComponentId ? Boolean(componentManifest,) : true;
        if (!hasLibraryItem || !hasComponent) {
          nextSaved = false;
          nextLibraryItemId = null;
          nextComponentId = null;
        }
      }

      const restoredPrimaryContent = snapshot.runtime === "code" ? snapshot.source : snapshot.spec;
      const nextHistory = appendWidgetRevision(
        {
          ...currentRecord,
          runtime: snapshot.runtime,
          spec: snapshot.spec,
          source: snapshot.source,
        },
        snapshot.prompt,
        restoredPrimaryContent,
      );
      const restoredRecord = await updateWidgetFile(path, file, {
        ...currentRecord,
        title: snapshot.title,
        prompt: snapshot.prompt,
        runtime: snapshot.runtime,
        saved: nextSaved,
        spec: snapshot.spec,
        source: snapshot.source,
        currentRevisionId: nextHistory.currentRevisionId,
        revisions: nextHistory.revisions,
        libraryItemId: nextLibraryItemId,
        componentId: nextComponentId,
        storageSchema: snapshot.storageSchema ?? null,
      },);
      await recordWidgetGitRevision(restoredRecord, "restore", currentRecord,);
      updateAttributes({
        storageId: restoredRecord.id,
        runtime: restoredRecord.runtime,
        file: restoredRecord.file,
        path: restoredRecord.path,
        libraryItemId: restoredRecord.libraryItemId,
        componentId: restoredRecord.componentId,
        prompt: restoredRecord.prompt,
        spec: restoredRecord.spec,
        source: restoredRecord.source,
        storageSchema: stringifyStorageSchema(restoredRecord.storageSchema,),
        saved: restoredRecord.saved,
        loading: false,
        error: "",
      },);
      await loadHistory(null,);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Could not restore this widget revision.",);
    } finally {
      setHistoryRestoring(false,);
    }
  };

  const renderError = error || sharedLoadError;
  const toolbarTitle = formatToolbarTitle(prompt,);
  const saveTitle = isShared || saved ? "Archived in library" : "Archive in library";
  const rebuildTitle = loading || sharedLoading ? "Refreshing widget" : "Refresh widget";
  const showSaveAction = !isShared && !saved && Boolean(currentSource,);
  const showRenderOverlay = (loading || sharedLoading) && Boolean(currentSource,);
  const overlayText = isEditingInChat ? "Building new version..." : "Refreshing widget...";
  const overlayPrompt = isEditingInChat ? "Updating this widget with your latest edit." : prompt;
  const showLegacyWarning = !currentSource && !loading && !sharedLoading && generationContext?.runtime === "json";

  return (
    <NodeViewWrapper className={`widget-node ${selected || isEditingInChat ? "widget-selected" : ""}`}>
      <div className="widget-container">
        <div className="widget-toolbar" data-drag-handle>
          <span className="widget-prompt" title={prompt}>
            {toolbarTitle}
          </span>
          <div className="widget-actions">
            {historyEnabled && file && path && (
              <button
                className={`widget-btn widget-btn-icon ${historyOpen ? "widget-btn-active" : ""}`}
                onClick={() => {
                  setHistoryOpen((current,) => !current);
                }}
                disabled={loading || sharedLoading}
                title="Show widget Git history"
                aria-label="Show widget Git history"
              >
                <History strokeWidth={2} />
              </button>
            )}
            <button
              className={`widget-btn widget-btn-icon widget-btn-iterate ${isEditingInChat ? "widget-btn-active" : ""}`}
              onClick={() => {
                setIsEditingInChat(true,);
                window.dispatchEvent(
                  new CustomEvent(WIDGET_EDIT_REQUEST_EVENT, {
                    detail: {
                      widgetId: id,
                      title: toolbarTitle,
                    },
                  },),
                );
              }}
              disabled={loading || sharedLoading}
              title="Edit widget in chat"
              aria-label="Edit widget in chat"
            >
              <PencilLine strokeWidth={2} />
            </button>
            <button
              className="widget-btn widget-btn-icon widget-btn-rebuild"
              onClick={() => {
                void handleRebuild();
              }}
              disabled={loading || sharedLoading}
              title={rebuildTitle}
              aria-label={rebuildTitle}
            >
              <RefreshCw className={loading || sharedLoading ? "animate-spin" : undefined} strokeWidth={2} />
            </button>
            {showSaveAction && (
              <button
                className="widget-btn widget-btn-icon"
                onClick={() => {
                  void handleSave();
                }}
                disabled={loading || missingComponent}
                title={saveTitle}
                aria-label={saveTitle}
              >
                <Archive strokeWidth={2} />
              </button>
            )}
            <button
              className="widget-btn widget-btn-icon widget-btn-delete"
              onClick={deleteNode}
              title="Delete widget"
              aria-label="Delete widget"
            >
              <Trash2 strokeWidth={2} />
            </button>
          </div>
        </div>
        {historyOpen && historyEnabled && file && path && (
          <WidgetHistoryPanel
            entries={historyEntries}
            loading={historyLoading}
            error={historyError}
            diff={historyDiff}
            selectedCommitId={selectedHistoryCommitId}
            restoring={historyRestoring}
            onClose={() => setHistoryOpen(false,)}
            onSelect={(commitId,) => {
              void handleSelectHistory(commitId,);
            }}
            onRestore={() => {
              void handleRestoreHistory();
            }}
          />
        )}

        {missingComponent
          ? (
            <div className="widget-error">
              <p className="widget-error-title">Shared component missing</p>
              <p className="widget-error-message">This widget references a component that no longer exists.</p>
            </div>
          )
          : renderError
          ? (
            <div className="widget-error">
              <p className="widget-error-title">Sophia couldn't build this</p>
              <p className="widget-error-message">{renderError}</p>
            </div>
          )
          : currentSource
          ? (
            <div
              className="widget-render"
              onMouseDown={(event,) => event.stopPropagation()}
              onClick={(event,) => event.stopPropagation()}
            >
              <CodeWidgetRenderer runtime={runtimeApi} source={currentSource} />
              {showRenderOverlay && (
                <div className="widget-build-overlay">
                  <div className="widget-build-overlay-inner">
                    <div className="widget-spinner" />
                    <span className="widget-loading-text">{overlayText}</span>
                    <span className="widget-loading-prompt">{overlayPrompt}</span>
                  </div>
                </div>
              )}
            </div>
          )
          : loading || sharedLoading
          ? (
            <div className="widget-loading">
              <div className="widget-loading-inner">
                <div className="widget-spinner" />
                <span className="widget-loading-text">Building widget</span>
                <span className="widget-loading-prompt">{prompt}</span>
              </div>
            </div>
          )
          : showLegacyWarning
          ? (
            <div className="widget-error">
              <p className="widget-error-title">Legacy JSON widget</p>
              <p className="widget-error-message">Rebuild this widget to convert it to the TSX runtime.</p>
            </div>
          )
          : (
            <div className="widget-error">
              <p className="widget-error-title">No content yet.</p>
            </div>
          )}
      </div>
    </NodeViewWrapper>
  );
}
