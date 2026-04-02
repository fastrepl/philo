import {
  type EditorHostInboundMessage,
  type EditorHostLoadDocumentInput,
  type EditorHostSaveDocumentResult,
  type HostDocumentDescriptor,
  parseEditorHostOutboundMessage,
  type SyncStatusSnapshot,
} from "@philo/core";
import React from "react";
import { Linking, StyleSheet, View, } from "react-native";
import { WebView, type WebViewMessageEvent, } from "react-native-webview";

interface EditorWebViewProps {
  document: HostDocumentDescriptor;
  onLoadDocument: (input: EditorHostLoadDocumentInput,) => Promise<HostDocumentDescriptor | null>;
  onOpenNote: (date: string,) => Promise<void>;
  onOpenPage: (title: string,) => Promise<void>;
  onResolveAssetUrl: (path: string,) => Promise<string>;
  onSaveDocument: (document: HostDocumentDescriptor,) => Promise<EditorHostSaveDocumentResult>;
  onWidgetMutation: () => Promise<number>;
  onWidgetQuery: () => Promise<Array<Record<string, unknown>>>;
  syncState: SyncStatusSnapshot;
}

function buildInlineHostHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
    <title>Philo Editor Host</title>
    <style>
      :root {
        color-scheme: light;
        --paper: #f4efe2;
        --card: #fffdf6;
        --ink: #1e1c17;
        --muted: #6a604d;
        --line: rgba(30, 28, 23, 0.12);
        --accent: #1d4d47;
        --accent-soft: #d8ebe7;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top right, rgba(29, 77, 71, 0.08), transparent 32%),
          linear-gradient(180deg, #f9f4e9 0%, var(--paper) 100%);
        color: var(--ink);
        font: 15px/1.5 "SF Pro Text", "Helvetica Neue", sans-serif;
      }

      main {
        min-height: 100vh;
        padding: 20px 16px 24px;
      }

      section {
        min-height: calc(100vh - 44px);
        border: 1px solid var(--line);
        background: rgba(255, 253, 246, 0.96);
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        overflow: hidden;
      }

      header {
        padding: 18px 18px 12px;
        border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.72);
      }

      .eyebrow {
        margin: 0 0 6px;
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.15;
      }

      .meta {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        padding: 12px 18px;
        border-bottom: 1px solid var(--line);
      }

      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 0 10px;
        border: 1px solid var(--line);
        background: white;
        color: var(--muted);
        font-size: 12px;
      }

      .pill.status {
        border-color: rgba(29, 77, 71, 0.16);
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 600;
      }

      textarea {
        width: 100%;
        min-height: 100%;
        padding: 18px;
        border: 0;
        resize: none;
        background: transparent;
        color: var(--ink);
        font: 16px/1.6 "SF Mono", "Menlo", monospace;
        outline: none;
      }

      footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 14px 18px 18px;
        border-top: 1px solid var(--line);
      }

      .path {
        color: var(--muted);
        font-size: 12px;
      }

      button {
        border: 0;
        background: var(--ink);
        color: white;
        height: 42px;
        padding: 0 18px;
        font: inherit;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <header>
          <p class="eyebrow">Philo</p>
          <h1 id="title">Loading…</h1>
        </header>
        <div class="meta">
          <span class="pill status" id="status">Idle</span>
          <span class="pill" id="updated">Never synced</span>
        </div>
        <textarea id="editor" spellcheck="false" placeholder="Start writing…"></textarea>
        <footer>
          <span class="path" id="path"></span>
          <button id="save" type="button">Save</button>
        </footer>
      </section>
    </main>
    <script>
      const state = {
        document: null,
        dirty: false,
        syncState: null,
      };

      const titleEl = document.getElementById("title");
      const statusEl = document.getElementById("status");
      const updatedEl = document.getElementById("updated");
      const pathEl = document.getElementById("path");
      const editorEl = document.getElementById("editor");
      const saveButton = document.getElementById("save");

      function post(message) {
        const payload = JSON.stringify(message);
        if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === "function") {
          window.ReactNativeWebView.postMessage(payload);
          return;
        }

        if (window.parent && window.parent !== window) {
          window.parent.postMessage(payload, "*");
        }
      }

      function render() {
        titleEl.textContent = state.document ? state.document.title : "Untitled";
        statusEl.textContent = state.syncState ? state.syncState.state : "idle";
        updatedEl.textContent = state.syncState && state.syncState.lastSyncedAt
          ? "Synced " + state.syncState.lastSyncedAt
          : "Never synced";
        pathEl.textContent = state.document ? state.document.path : "";

        if (!state.dirty) {
          editorEl.value = state.document ? state.document.content : "";
        }
      }

      function receive(payload) {
        try {
          const message = typeof payload === "string" ? JSON.parse(payload) : payload;
          switch (message.type) {
            case "document_loaded":
              state.document = message.document;
              state.dirty = false;
              render();
              break;
            case "document_saved":
              state.document = message.result.document;
              state.dirty = false;
              render();
              break;
            case "sync_state":
              state.syncState = message.state;
              render();
              break;
            case "bridge_error":
              statusEl.textContent = "error";
              updatedEl.textContent = message.message;
              break;
          }
        } catch (error) {
          post({
            type: "bridge_error",
            message: error instanceof Error ? error.message : "Invalid host payload",
          });
        }
      }

      editorEl.addEventListener("input", () => {
        state.dirty = true;
      });

      saveButton.addEventListener("click", () => {
        if (!state.document) return;
        post({
          type: "save_document",
          input: {
            document: {
              ...state.document,
              content: editorEl.value,
            },
          },
        });
      });

      window.__PHILO_BRIDGE = { receive };
      window.addEventListener("message", (event) => receive(event.data));
      post({ type: "bridge_ready" });
      render();
    </script>
  </body>
</html>`;
}

export function EditorWebView({
  document,
  onLoadDocument,
  onOpenNote,
  onOpenPage,
  onResolveAssetUrl,
  onSaveDocument,
  onWidgetMutation,
  onWidgetQuery,
  syncState,
}: EditorWebViewProps,) {
  const webViewRef = React.useRef<WebView>(null,);
  const hostUrl = process.env.EXPO_PUBLIC_WEB_EDITOR_HOST_URL?.trim() || "";

  function sendMessage(message: EditorHostInboundMessage,) {
    const payload = JSON.stringify(message,);
    webViewRef.current?.injectJavaScript(
      `window.__PHILO_BRIDGE?.receive(${JSON.stringify(payload,)}); true;`,
    );
  }

  async function handleMessage(event: WebViewMessageEvent,) {
    const message = parseEditorHostOutboundMessage(event.nativeEvent.data,);
    if (!message) {
      sendMessage({
        type: "bridge_error",
        message: "The mobile editor host sent an invalid message.",
      },);
      return;
    }

    switch (message.type) {
      case "bridge_ready":
        sendMessage({ type: "document_loaded", document, },);
        sendMessage({ type: "sync_state", state: syncState, },);
        return;
      case "load_document": {
        const nextDocument = await onLoadDocument(message.input,);
        sendMessage({ type: "document_loaded", document: nextDocument, },);
        return;
      }
      case "save_document": {
        const result = await onSaveDocument(message.input.document,);
        sendMessage({ type: "document_saved", result, },);
        return;
      }
      case "open_note":
        await onOpenNote(message.date,);
        return;
      case "open_page":
        await onOpenPage(message.title,);
        return;
      case "resolve_asset_url": {
        const url = await onResolveAssetUrl(message.path,);
        sendMessage({
          type: "asset_url_resolved",
          path: message.path,
          requestId: message.requestId,
          url,
        },);
        return;
      }
      case "pick_image":
        sendMessage({
          type: "image_picked",
          requestId: message.requestId,
          asset: null,
        },);
        return;
      case "run_widget_query": {
        const rows = await onWidgetQuery();
        sendMessage({
          type: "widget_query_result",
          requestId: message.requestId,
          rows,
        },);
        return;
      }
      case "run_widget_mutation": {
        const changedRows = await onWidgetMutation();
        sendMessage({
          type: "widget_mutation_result",
          requestId: message.requestId,
          changedRows,
        },);
        return;
      }
      case "open_external_url":
        await Linking.openURL(message.url,);
        return;
      case "report_sync_state":
        sendMessage({
          type: "sync_state",
          state: syncState,
        },);
        return;
    }
  }

  return (
    <View style={styles.root}>
      <WebView
        ref={webViewRef}
        onMessage={(event,) => {
          void handleMessage(event,);
        }}
        originWhitelist={["*",]}
        source={hostUrl ? { uri: hostUrl, } : { html: buildInlineHostHtml(), }}
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: "hidden",
  },
  webview: {
    flex: 1,
    backgroundColor: "transparent",
  },
},);
