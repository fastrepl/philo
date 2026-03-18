import * as React from "react";
import { useEffect, useMemo, useRef, useState, } from "react";
import type { ErrorInfo, ReactNode, } from "react";
import {
  CODE_WIDGET_FRAME_PARAM,
  CODE_WIDGET_LOAD,
  CODE_WIDGET_READY,
  CODE_WIDGET_RESIZE,
  CODE_WIDGET_STORAGE_REQUEST,
  CODE_WIDGET_STORAGE_RESPONSE,
  type CodeWidgetLoadMessage,
  type CodeWidgetStorageResponseMessage,
  isCodeWidgetMessage,
} from "./messages";
import { WidgetSdkProvider, } from "./sdk";
import * as PhiloSdk from "./sdk";

type WidgetComponent = React.ComponentType;

type WidgetBridge = {
  runQuery: (name: string, params?: Record<string, unknown>,) => Promise<Array<Record<string, unknown>>>;
  runMutation: (name: string, params?: Record<string, unknown>,) => Promise<number>;
};

class WidgetRenderBoundary extends React.Component<
  { onError: (message: string,) => void; children: ReactNode; },
  { error: string | null; }
> {
  state = { error: null as string | null, };

  static getDerivedStateFromError(error: Error,) {
    return { error: error.message, };
  }

  componentDidCatch(error: Error, _info: ErrorInfo,) {
    this.props.onError(error.message,);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="widget-error">
          <p className="widget-error-title">Code widget failed</p>
          <p className="widget-error-message">{this.state.error}</p>
        </div>
      );
    }

    return this.props.children;
  }
}

function readFrameId(): string {
  const search = new URLSearchParams(window.location.search,);
  return search.get(CODE_WIDGET_FRAME_PARAM,) ?? "";
}

function evaluateWidgetModule(code: string,): WidgetComponent {
  const globalScope = globalThis as typeof globalThis & {
    __PHILO_WIDGET_MODULE__?: { default?: WidgetComponent; };
    Philo?: typeof PhiloSdk;
    PhiloReact?: typeof React;
  };
  globalScope.Philo = PhiloSdk;
  globalScope.PhiloReact = React;
  delete globalScope.__PHILO_WIDGET_MODULE__;
  const run = new Function(
    `${code}
const moduleValue = typeof __PHILO_WIDGET_MODULE__ !== "undefined"
  ? __PHILO_WIDGET_MODULE__
  : globalThis.__PHILO_WIDGET_MODULE__;
return moduleValue?.default ?? moduleValue;`,
  );
  const component = run() as WidgetComponent | undefined;
  if (typeof component !== "function") {
    throw new Error("Compiled widget did not export a default component.",);
  }
  return component;
}

function createBridge(frameId: string,): WidgetBridge {
  return {
    runQuery: async (name: string, params: Record<string, unknown> = {},) =>
      await new Promise<Array<Record<string, unknown>>>((resolve, reject,) => {
        const requestId = crypto.randomUUID();

        const handleMessage = (event: MessageEvent<unknown>,) => {
          if (event.source !== window.parent) return;
          if (!isCodeWidgetMessage(event.data,)) return;
          const message = event.data as CodeWidgetStorageResponseMessage;
          if (
            message.type !== CODE_WIDGET_STORAGE_RESPONSE || message.frameId !== frameId
            || message.requestId !== requestId
          ) {
            return;
          }
          window.removeEventListener("message", handleMessage,);
          if (!message.ok) {
            reject(new Error(message.error || "Query failed.",),);
            return;
          }
          resolve(Array.isArray(message.result,) ? message.result as Array<Record<string, unknown>> : [],);
        };

        window.addEventListener("message", handleMessage,);
        window.parent.postMessage({
          type: CODE_WIDGET_STORAGE_REQUEST,
          frameId,
          requestId,
          action: "query",
          name,
          params,
        }, "*",);
      },),
    runMutation: async (name: string, params: Record<string, unknown> = {},) =>
      await new Promise<number>((resolve, reject,) => {
        const requestId = crypto.randomUUID();

        const handleMessage = (event: MessageEvent<unknown>,) => {
          if (event.source !== window.parent) return;
          if (!isCodeWidgetMessage(event.data,)) return;
          const message = event.data as CodeWidgetStorageResponseMessage;
          if (
            message.type !== CODE_WIDGET_STORAGE_RESPONSE || message.frameId !== frameId
            || message.requestId !== requestId
          ) {
            return;
          }
          window.removeEventListener("message", handleMessage,);
          if (!message.ok) {
            reject(new Error(message.error || "Mutation failed.",),);
            return;
          }
          resolve(typeof message.result === "number" ? message.result : 0,);
        };

        window.addEventListener("message", handleMessage,);
        window.parent.postMessage({
          type: CODE_WIDGET_STORAGE_REQUEST,
          frameId,
          requestId,
          action: "mutation",
          name,
          params,
        }, "*",);
      },),
  };
}

export function WidgetSandboxApp() {
  const [Widget, setWidget,] = useState<WidgetComponent | null>(null,);
  const [error, setError,] = useState<string | null>(null,);
  const frameId = useMemo(() => readFrameId(), [],);
  const bridge = useMemo(() => createBridge(frameId,), [frameId,],);
  const containerRef = useRef<HTMLDivElement>(null,);

  useEffect(() => {
    globalThis.__PHILO_WIDGET_REACT__ = React;
  }, [],);

  useEffect(() => {
    if (!frameId) return;
    window.parent.postMessage({ type: CODE_WIDGET_READY, frameId, }, "*",);
  }, [frameId,],);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>,) => {
      if (event.source !== window.parent) return;
      if (!isCodeWidgetMessage(event.data,)) return;
      const message = event.data as CodeWidgetLoadMessage;
      if (message.type !== CODE_WIDGET_LOAD || message.frameId !== frameId) return;

      try {
        setError(null,);
        setWidget(() => evaluateWidgetModule(message.code,));
      } catch (err) {
        setWidget(null,);
        setError(err instanceof Error ? err.message : "Widget evaluation failed.",);
      }
    };

    window.addEventListener("message", handleMessage,);
    return () => window.removeEventListener("message", handleMessage,);
  }, [frameId,],);

  useEffect(() => {
    if (!frameId || !containerRef.current) return;
    const sendSize = () => {
      window.parent.postMessage({
        type: CODE_WIDGET_RESIZE,
        frameId,
        height: Math.ceil(containerRef.current?.scrollHeight ?? 0,),
      }, "*",);
    };
    sendSize();
    const observer = new ResizeObserver(sendSize,);
    observer.observe(containerRef.current,);
    return () => observer.disconnect();
  }, [Widget, error, frameId,],);

  return (
    <div
      ref={containerRef}
      style={{
        minHeight: "120px",
        background: "#fff",
      }}
    >
      {error
        ? (
          <div className="widget-error">
            <p className="widget-error-title">Code widget failed</p>
            <p className="widget-error-message">{error}</p>
          </div>
        )
        : Widget
        ? (
          <WidgetSdkProvider bridge={bridge}>
            <WidgetRenderBoundary onError={setError}>
              <Widget />
            </WidgetRenderBoundary>
          </WidgetSdkProvider>
        )
        : (
          <div className="widget-error">
            <p className="widget-error-title">Loading widget</p>
          </div>
        )}
    </div>
  );
}
