import type { Spec, } from "@json-render/core";
import { JSONUIProvider, Renderer, } from "@json-render/react";
import { NodeViewWrapper, } from "@tiptap/react";
import type { NodeViewProps, } from "@tiptap/react";
import { Component, useCallback, useEffect, useMemo, useState, } from "react";
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
import { type SharedWidgetRuntimeApi, WidgetRuntimeProvider, } from "./registry";
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
  if (firstSentence.length <= 40) return firstSentence;
  return firstSentence.slice(0, 37,) + "...";
}

export function WidgetView({ node, updateAttributes, deleteNode, }: NodeViewProps,) {
  const { spec: specStr, saved, prompt, loading, error, componentId, } = node.attrs as {
    spec: string;
    saved: boolean;
    prompt: string;
    loading: boolean;
    error: string;
    componentId?: string | null;
  };
  const [missingComponent, setMissingComponent,] = useState(false,);
  const [sharedLoading, setSharedLoading,] = useState(false,);
  const [manifest, setManifest,] = useState<SharedComponentManifest | null>(null,);
  const [sharedLoadError, setSharedLoadError,] = useState<string | null>(null,);
  const [runtimeRefreshToken, setRuntimeRefreshToken,] = useState(0,);

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
  const currentSpec = useMemo(() => (isShared ? sharedSpec : inlineSpec), [isShared, sharedSpec, inlineSpec,],);

  const handleRebuild = async () => {
    updateAttributes({ loading: true, error: "", },);
    try {
      if (isShared && manifest) {
        const generated = await generateSharedWidget(prompt, manifest.storageSchema,);
        if (!storageSchemaMatch(generated.storageSchema, manifest.storageSchema,)) {
          throw new Error("Storage schema changed. Save as a new component to rebuild with a new DB schema.",);
        }
        const next = await updateSharedComponent(manifest.id, generated.uiSpec, manifest.prompt,);
        setManifest(next,);
        updateAttributes({ loading: false, spec: "", saved: true, error: "", },);
        return;
      }

      const nextSpec = await generateWidget(prompt,);
      updateAttributes({ spec: JSON.stringify(nextSpec,), loading: false, error: "", },);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === "string" ? err : "Something went wrong.";
      updateAttributes({
        loading: false,
        error: isAiKeyMissingError(errMsg,) ? getAiConfigurationMessage(errMsg,) : errMsg,
      },);
    }
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

      updateAttributes({
        componentId: item.componentId,
        spec: "",
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

  const toolbarState = isShared
    ? saved ? "Shared" : "Insert" // fallback, not expected for shared
    : saved
    ? "Saved"
    : "Unsaved";

  return (
    <NodeViewWrapper className="widget-node">
      <div className="widget-container">
        <div className="widget-toolbar" data-drag-handle>
          <span className="widget-prompt" title={prompt}>
            {prompt.length > 50 ? prompt.slice(0, 50,) + "..." : prompt}
          </span>
          <div className="widget-actions">
            <button
              className="widget-btn widget-btn-rebuild"
              onClick={handleRebuild}
              disabled={loading || sharedLoading}
            >
              {loading || sharedLoading ? "Updating..." : "Rebuild"}
            </button>
            <button
              className={`widget-btn ${toolbarState === "Shared" || isShared ? "widget-btn-saved" : ""}`}
              onClick={handleSave}
              disabled={isShared || loading || missingComponent}
            >
              {isShared || toolbarState === "Shared" ? "✓ Saved" : "Save to Library"}
            </button>
            <button className="widget-btn widget-btn-delete" onClick={deleteNode}>
              ✕
            </button>
          </div>
        </div>

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
                    <Renderer spec={currentSpec} registry={registry} />
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
      </div>
    </NodeViewWrapper>
  );
}
