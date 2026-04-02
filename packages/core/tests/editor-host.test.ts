import assert from "node:assert/strict";
import test from "node:test";
import { parseEditorHostInboundMessage, parseEditorHostOutboundMessage, } from "../src/editor-host";

test("parseEditorHostOutboundMessage accepts save payloads", () => {
  const message = parseEditorHostOutboundMessage(JSON.stringify({
    type: "save_document",
    input: {
      document: {
        id: "pages/test.md",
        kind: "page",
        path: "pages/test.md",
        title: "Test",
        referenceDate: null,
        content: "# Test",
        updatedAt: "2026-04-01T12:00:00.000Z",
      },
    },
  },),);

  assert.deepEqual(message, {
    type: "save_document",
    input: {
      document: {
        id: "pages/test.md",
        kind: "page",
        path: "pages/test.md",
        title: "Test",
        referenceDate: null,
        content: "# Test",
        updatedAt: "2026-04-01T12:00:00.000Z",
      },
    },
  },);
});

test("parseEditorHostOutboundMessage rejects malformed payloads", () => {
  assert.equal(parseEditorHostOutboundMessage("{bad",), null,);
  assert.equal(
    parseEditorHostOutboundMessage({
      type: "open_note",
      date: 42,
    },),
    null,
  );
});

test("parseEditorHostInboundMessage accepts sync snapshots", () => {
  const message = parseEditorHostInboundMessage({
    type: "sync_state",
    state: {
      state: "idle",
      lastSyncedAt: "2026-04-01T13:00:00.000Z",
      errorMessage: null,
      pendingUploads: 1,
      pendingDownloads: 2,
    },
  },);

  assert.deepEqual(message, {
    type: "sync_state",
    state: {
      state: "idle",
      lastSyncedAt: "2026-04-01T13:00:00.000Z",
      errorMessage: null,
      pendingUploads: 1,
      pendingDownloads: 2,
    },
  },);
});

test("parseEditorHostInboundMessage rejects malformed results", () => {
  assert.equal(
    parseEditorHostInboundMessage({
      type: "widget_query_result",
      requestId: "x",
      rows: ["bad",],
    },),
    null,
  );
});
