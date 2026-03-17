import type { Spec, } from "@json-render/core";
import { JSONUIProvider, Renderer, } from "@json-render/react";
import { NodeViewWrapper, } from "@tiptap/react";
import type { NodeViewProps, } from "@tiptap/react";
import { Archive, PencilLine, RefreshCw, Trash2, } from "lucide-react";
import { Component, useCallback, useEffect, useMemo, useRef, useState, } from "react";
import type { ErrorInfo, ReactNode, } from "react";
import { getAiConfigurationMessage, isAiKeyMissingError, } from "../../../../services/ai";
import { generateSharedWidget, generateWidget, } from "../../../../services/generate";
import {
  addToLibrary,
  getSharedComponent,
  runSharedComponentMutation,
  runSharedComponentQuery,
  SHARED_COMPONENTS_UPDATED_EVENT,
  type SharedComponentManifest,
  type SharedStorageSchema,
  updateSharedComponent,
} from "../../../../services/library";
import { createWidgetFile, updateWidgetFile, } from "../../../../services/widget-files";
import {
  type SharedWidgetRuntimeApi,
  WidgetRuntimeProvider,
  WidgetStateProvider,
  WidgetTemporalProvider,
} from "./registry";
import { registry, } from "./registry";

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

function parseSpec(candidate: unknown,): Spec | null {
  if (!candidate) return null;
  if (typeof candidate === "object") return candidate as Spec;
  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate,);
      return typeof parsed === "object" ? parsed as Spec : null;
    } catch {
      return null;
    }
  }
  return null;
}

function stringifySpec(candidate: unknown, fallback = "",): string {
  if (typeof candidate === "string") return candidate;
  if (!candidate) return fallback;
  return JSON.stringify(candidate,);
}

class RendererBoundary extends Component<{ children: ReactNode; }, { error: string | null; }> {
  state = { error: null as string | null, };

  static getDerivedStateFromError(err: Error,) {
    return { error: err.message, };
  }

  componentDidCatch(err: Error, info: ErrorInfo,) {
    console.error("Widget render error:", err, info,);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="widget-error">
          <p className="widget-error-title">Sophia couldn't render this</p>
          <p className="widget-error-message">{this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
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

function specNeedsInlineRepair(spec: Spec | null,): boolean {
  if (!spec || typeof spec !== "object") return false;

  const elements = "elements" in spec && spec.elements && typeof spec.elements === "object"
    ? Object.values(spec.elements as Record<string, { type?: string; props?: Record<string, unknown>; }>,)
    : [];

  return elements.some((element,) => {
    if (!element || typeof element !== "object") return false;
    if (element.type === "Button") {
      return !element.props?.mutation && !element.props?.action;
    }
    if (element.type === "TextInput") {
      return !element.props?.query && !element.props?.binding;
    }
    if (element.type === "Checkbox") {
      return !element.props?.query && !element.props?.binding;
    }
    return false;
  },);
}

export function WidgetView({ node, updateAttributes, deleteNode, }: NodeViewProps,) {
  const { id, spec: specStr, saved, prompt, loading, error, componentId, file, path, } = node.attrs as {
    id: string;
    spec: string;
    saved: boolean;
    prompt: string;
    loading: boolean;
    error: string;
    componentId?: string | null;
    file?: string;
    path?: string;
  };
  const [missingComponent, setMissingComponent,] = useState(false,);
  const [sharedLoading, setSharedLoading,] = useState(false,);
  const [manifest, setManifest,] = useState<SharedComponentManifest | null>(null,);
  const [sharedLoadError, setSharedLoadError,] = useState<string | null>(null,);
  const [runtimeRefreshToken, setRuntimeRefreshToken,] = useState(0,);
  const [isIterating, setIsIterating,] = useState(false,);
  const [promptDraft, setPromptDraft,] = useState(prompt,);
  const [autoRepairAttempted, setAutoRepairAttempted,] = useState(false,);
  const promptInputRef = useRef<HTMLTextAreaElement>(null,);

  const inlineSpec = useMemo(() => parseSpec(specStr,), [specStr,],);

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
    loadManifest();
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
    setPromptDraft(prompt,);
  }, [prompt,],);

  useEffect(() => {
    setAutoRepairAttempted(false,);
  }, [id,],);

  useEffect(() => {
    if (!isIterating) return;
    promptInputRef.current?.focus();
    promptInputRef.current?.setSelectionRange(promptDraft.length, promptDraft.length,);
  }, [isIterating, promptDraft,],);

  const isShared = Boolean(componentId,);
  const runtimeApi: SharedWidgetRuntimeApi = useMemo(() => {
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
  }, [componentId, isShared, manifest, missingComponent, runtimeRefreshToken,],);

  const sharedSpec = manifest?.uiSpec ? parseSpec(manifest.uiSpec,) : null;
  const currentSpec = useMemo(
    () => (isShared ? sharedSpec ?? inlineSpec : inlineSpec),
    [inlineSpec, isShared, sharedSpec,],
  );

  const persistWidgetRecord = useCallback(async (
    nextPrompt: string,
    nextSpec: string,
    nextSaved: boolean,
    nextComponentId?: string | null,
  ) => {
    const title = deriveTitle(nextPrompt,);
    if (path && file) {
      return await updateWidgetFile(path, file, {
        id,
        title,
        prompt: nextPrompt,
        saved: nextSaved,
        spec: nextSpec,
        componentId: nextComponentId ?? null,
      },);
    }

    return await createWidgetFile({
      title,
      prompt: nextPrompt,
      spec: nextSpec,
      saved: nextSaved,
      componentId: nextComponentId ?? null,
    },);
  }, [file, id, path,],);

  const runGeneration = async (nextPrompt: string,) => {
    updateAttributes({ prompt: nextPrompt, loading: true, error: "", },);
    try {
      if (isShared && manifest) {
        const generated = await generateSharedWidget(nextPrompt, manifest.storageSchema,);
        if (!storageSchemaMatch(generated.storageSchema, manifest.storageSchema,)) {
          throw new Error("Storage schema changed. Save as a new component to rebuild with a new DB schema.",);
        }
        const next = await updateSharedComponent(manifest.id, generated.uiSpec, nextPrompt,);
        setManifest(next,);
        const record = await persistWidgetRecord(nextPrompt, stringifySpec(next.uiSpec,), true, manifest.id,);
        updateAttributes({
          id: record.id,
          file: record.file,
          path: record.path,
          prompt: nextPrompt,
          loading: false,
          spec: record.spec,
          saved: true,
          error: "",
        },);
        return;
      }

      const nextSpec = await generateWidget(nextPrompt,);
      const record = await persistWidgetRecord(nextPrompt, JSON.stringify(nextSpec,), saved, componentId,);
      updateAttributes({
        id: record.id,
        file: record.file,
        path: record.path,
        prompt: nextPrompt,
        spec: record.spec,
        loading: false,
        error: "",
      },);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === "string" ? err : "Something went wrong.";
      updateAttributes({
        prompt: nextPrompt,
        loading: false,
        error: isAiKeyMissingError(errMsg,) ? getAiConfigurationMessage(errMsg,) : errMsg,
      },);
    }
  };

  const handleRebuild = async () => {
    await runGeneration(prompt,);
  };

  const handleIterateSubmit = async (event: React.FormEvent<HTMLFormElement>,) => {
    event.preventDefault();
    const nextPrompt = promptDraft.trim();
    if (!nextPrompt) return;
    setIsIterating(false,);
    await runGeneration(nextPrompt,);
  };

  const handleIterateCancel = () => {
    setPromptDraft(prompt,);
    setIsIterating(false,);
  };

  const handleSave = async () => {
    if (isShared || !specStr || !inlineSpec || !prompt) return;

    updateAttributes({ loading: true, },);
    try {
      const uiSpec = inlineSpec;
      const generated = await generateSharedWidget(prompt, undefined,);
      if (!generated.uiSpec || !generated.storageSchema) {
        throw new Error("Missing shared component generation data.",);
      }

      const item = await addToLibrary({
        title: deriveTitle(prompt,),
        description: prompt,
        prompt,
        html: JSON.stringify(uiSpec,),
        uiSpec: JSON.stringify(generated.uiSpec,),
        storageSchema: generated.storageSchema,
      },);
      const record = await persistWidgetRecord(
        prompt,
        stringifySpec(item.uiSpec, JSON.stringify(generated.uiSpec,),),
        true,
        item.componentId,
      );

      updateAttributes({
        id: record.id,
        file: record.file,
        path: record.path,
        componentId: item.componentId,
        spec: record.spec,
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

  useEffect(() => {
    if (isShared || loading || sharedLoading || autoRepairAttempted || !currentSpec) {
      return;
    }

    if (!specNeedsInlineRepair(currentSpec,)) {
      return;
    }

    setAutoRepairAttempted(true,);
    void runGeneration(prompt,);
  }, [autoRepairAttempted, currentSpec, isShared, loading, prompt, sharedLoading,],);

  const renderError = error || sharedLoadError;
  const toolbarTitle = formatToolbarTitle(prompt,);
  const saveTitle = isShared || saved ? "Archived in library" : "Archive in library";
  const rebuildTitle = loading || sharedLoading ? "Refreshing widget" : "Refresh widget";
  const showSaveAction = !isShared && !saved;

  return (
    <NodeViewWrapper className="widget-node">
      <div className="widget-container">
        {isIterating && (
          <form className="widget-iterate-form" onSubmit={(event,) => void handleIterateSubmit(event,)}>
            <textarea
              ref={promptInputRef}
              className="widget-iterate-input"
              value={promptDraft}
              onChange={(event,) => setPromptDraft(event.target.value,)}
              placeholder="Refine this widget..."
              rows={3}
              disabled={loading || sharedLoading}
            />
            <div className="widget-iterate-actions">
              <button
                type="button"
                className="widget-btn widget-iterate-btn"
                onClick={handleIterateCancel}
                disabled={loading || sharedLoading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="widget-btn widget-btn-rebuild widget-iterate-btn"
                disabled={!promptDraft.trim() || loading || sharedLoading}
              >
                Update widget
              </button>
            </div>
          </form>
        )}

        {loading || sharedLoading
          ? (
            <div className="widget-loading">
              <div className="widget-loading-inner">
                <div className="widget-spinner" />
                <span className="widget-loading-text">Sophia is building...</span>
                <span className="widget-loading-prompt">{prompt}</span>
              </div>
            </div>
          )
          : missingComponent
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
          : currentSpec
          ? (
            <div
              className="widget-render"
              onMouseDown={(e,) => e.stopPropagation()}
              onClick={(e,) => e.stopPropagation()}
            >
              <RendererBoundary>
                <JSONUIProvider registry={registry}>
                  <WidgetRuntimeProvider runtime={runtimeApi}>
                    <WidgetStateProvider key={componentId ?? specStr}>
                      <WidgetTemporalProvider>
                        <Renderer spec={currentSpec} registry={registry} />
                      </WidgetTemporalProvider>
                    </WidgetStateProvider>
                  </WidgetRuntimeProvider>
                </JSONUIProvider>
              </RendererBoundary>
            </div>
          )
          : (
            <div className="widget-error">
              <p className="widget-error-title">No content yet.</p>
            </div>
          )}

        <div className="widget-toolbar" data-drag-handle>
          <span className="widget-prompt" title={prompt}>
            {toolbarTitle}
          </span>
          <div className="widget-actions">
            <button
              className={`widget-btn widget-btn-icon widget-btn-iterate ${isIterating ? "widget-btn-active" : ""}`}
              onClick={() => {
                if (isIterating) {
                  handleIterateCancel();
                  return;
                }
                setPromptDraft(prompt,);
                setIsIterating(true,);
              }}
              disabled={loading || sharedLoading}
              title="Iterate widget"
              aria-label="Iterate widget"
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
      </div>
    </NodeViewWrapper>
  );
}
