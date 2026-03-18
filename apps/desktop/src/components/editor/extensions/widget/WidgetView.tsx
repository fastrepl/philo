import { NodeViewWrapper, } from "@tiptap/react";
import type { NodeViewProps, } from "@tiptap/react";
import { Archive, PencilLine, RefreshCw, Trash2, } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, } from "react";
import { getAiConfigurationMessage, isAiKeyMissingError, } from "../../../../services/ai";
import { generateWidgetWithStorage, } from "../../../../services/generate";
import {
  addToLibrary,
  getSharedComponent,
  resolveStoredWidgetSource,
  runSharedComponentMutation,
  runSharedComponentQuery,
  SHARED_COMPONENTS_UPDATED_EVENT,
  type SharedComponentManifest,
  type SharedStorageSchema,
  updateSharedComponent,
} from "../../../../services/library";
import {
  appendWidgetRevision,
  createWidgetFile,
  readWidgetFile,
  updateWidgetFile,
  type WidgetRuntimeKind,
} from "../../../../services/widget-files";
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
      void runGeneration(buildWidgetGenerationPrompt(prompt, generationContext, instruction,), prompt,);
    };

    window.addEventListener(WIDGET_EDIT_STATE_EVENT, handleWidgetEditState,);
    window.addEventListener(WIDGET_EDIT_SUBMIT_EVENT, handleWidgetEditSubmit,);
    return () => {
      window.removeEventListener(WIDGET_EDIT_STATE_EVENT, handleWidgetEditState,);
      window.removeEventListener(WIDGET_EDIT_SUBMIT_EVENT, handleWidgetEditSubmit,);
    };
  }, [generationContext, id, prompt,],);

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
      return await updateWidgetFile(path, file, {
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
    }

    return await createWidgetFile({
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
  }, [file, path, sourceStr, storageId,],);

  const runGeneration = async (generationPrompt: string, persistedPrompt = prompt,) => {
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
    await runGeneration(buildWidgetGenerationPrompt(prompt, generationContext,), prompt,);
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
