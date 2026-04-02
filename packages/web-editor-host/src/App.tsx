import {
  type EditorHostOutboundMessage,
  type HostDocumentDescriptor,
  parseEditorHostInboundMessage,
  type SyncStatusSnapshot,
} from "@philo/core";
import React from "react";
import { useMountEffect, } from "./useMountEffect";

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage(message: string,): void;
    };
    __PHILO_BRIDGE?: {
      receive(payload: unknown,): void;
    };
  }
}

const EMPTY_STATUS: SyncStatusSnapshot = {
  state: "idle",
  lastSyncedAt: null,
  errorMessage: null,
  pendingUploads: 0,
  pendingDownloads: 0,
};

const SAMPLE_DOCUMENT: HostDocumentDescriptor = {
  id: "pages/mobile.md",
  kind: "page",
  path: "pages/mobile.md",
  title: "Mobile page",
  referenceDate: null,
  content: "# Mobile page\n\nStart writing in the shared host.",
  updatedAt: null,
};

function postOutboundMessage(message: EditorHostOutboundMessage,) {
  const payload = JSON.stringify(message,);
  if (window.ReactNativeWebView?.postMessage) {
    window.ReactNativeWebView.postMessage(payload,);
    return;
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(payload, "*",);
  }
}

export default function App() {
  const [document, setDocument,] = React.useState<HostDocumentDescriptor>(SAMPLE_DOCUMENT,);
  const [syncState, setSyncState,] = React.useState<SyncStatusSnapshot>(EMPTY_STATUS,);
  const [notice, setNotice,] = React.useState("Waiting for native bridge…",);
  const [draftContent, setDraftContent,] = React.useState(SAMPLE_DOCUMENT.content,);

  useMountEffect(() => {
    function receive(payload: unknown,) {
      const message = parseEditorHostInboundMessage(payload,);
      if (!message) {
        setNotice("Ignored an invalid bridge payload.",);
        return;
      }

      switch (message.type) {
        case "document_loaded":
          if (message.document) {
            setDocument(message.document,);
            setDraftContent(message.document.content,);
            setNotice("Document loaded from host.",);
          }
          return;
        case "document_saved":
          setDocument(message.result.document,);
          setDraftContent(message.result.document.content,);
          setNotice(message.result.syncQueued ? "Saved and queued for sync." : "Saved locally.",);
          return;
        case "sync_state":
          setSyncState(message.state,);
          return;
        case "bridge_error":
          setNotice(message.message,);
          return;
        default:
          return;
      }
    }

    function handleMessage(event: MessageEvent,) {
      receive(event.data,);
    }

    window.__PHILO_BRIDGE = { receive, };
    window.addEventListener("message", handleMessage,);
    postOutboundMessage({ type: "bridge_ready", },);

    return () => {
      window.removeEventListener("message", handleMessage,);
      delete window.__PHILO_BRIDGE;
    };
  },);

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "24px 16px",
        fontFamily: "'SF Pro Text', 'Helvetica Neue', sans-serif",
        background:
          "radial-gradient(circle at top right, rgba(29, 77, 71, 0.08), transparent 28%), linear-gradient(180deg, #faf5ea 0%, #f1ebdd 100%)",
        color: "#1b1b18",
      }}
    >
      <section
        style={{
          width: "min(860px, 100%)",
          minHeight: "calc(100vh - 48px)",
          margin: "0 auto",
          display: "grid",
          gridTemplateRows: "auto auto 1fr auto",
          border: "1px solid rgba(27, 27, 24, 0.12)",
          background: "rgba(255, 253, 247, 0.95)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "22px 22px 14px",
            borderBottom: "1px solid rgba(27, 27, 24, 0.1)",
            background: "rgba(255,255,255,0.72)",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "11px",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "rgba(27, 27, 24, 0.52)",
            }}
          >
            Philo
          </p>
          <h1 style={{ margin: "10px 0 0", fontSize: "30px", lineHeight: 1.05, }}>
            {document.title}
          </h1>
        </header>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
            padding: "12px 22px",
            borderBottom: "1px solid rgba(27, 27, 24, 0.1)",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: "30px",
              padding: "0 10px",
              background: "#d8ebe7",
              color: "#1d4d47",
              fontSize: "12px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {syncState.state}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: "30px",
              padding: "0 10px",
              border: "1px solid rgba(27, 27, 24, 0.1)",
              color: "rgba(27, 27, 24, 0.64)",
              fontSize: "12px",
            }}
          >
            {document.path}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: "30px",
              padding: "0 10px",
              border: "1px solid rgba(27, 27, 24, 0.1)",
              color: "rgba(27, 27, 24, 0.64)",
              fontSize: "12px",
            }}
          >
            {syncState.lastSyncedAt ? `Synced ${syncState.lastSyncedAt}` : "Waiting for sync"}
          </span>
        </div>

        <textarea
          onChange={(event,) => setDraftContent(event.target.value,)}
          spellCheck={false}
          style={{
            width: "100%",
            minHeight: "100%",
            padding: "20px 22px",
            border: 0,
            outline: "none",
            resize: "none",
            background: "transparent",
            color: "#1b1b18",
            font: "16px/1.6 'SF Mono', Menlo, monospace",
          }}
          value={draftContent}
        />

        <footer
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "12px",
            alignItems: "center",
            padding: "14px 22px 20px",
            borderTop: "1px solid rgba(27, 27, 24, 0.1)",
          }}
        >
          <span style={{ color: "rgba(27, 27, 24, 0.64)", fontSize: "13px", }}>
            {notice}
          </span>
          <button
            onClick={() => {
              postOutboundMessage({
                type: "save_document",
                input: {
                  document: {
                    ...document,
                    content: draftContent,
                  },
                },
              },);
            }}
            style={{
              border: 0,
              minHeight: "42px",
              padding: "0 18px",
              background: "#1f1d17",
              color: "#fff9ef",
              font: "600 14px/1 'SF Pro Text', sans-serif",
              cursor: "pointer",
            }}
            type="button"
          >
            Save
          </button>
        </footer>
      </section>
    </main>
  );
}
