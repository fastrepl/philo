import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConflictCopyPath,
  classifySyncPath,
  getSyncStorageType,
  hashContent,
  normalizeSyncPath,
  resolveSyncWrite,
} from "../src/index";

test("normalizeSyncPath normalizes slashes and leading dots", () => {
  assert.equal(normalizeSyncPath("./pages\\roadmap.md",), "pages/roadmap.md",);
});

test("classifySyncPath detects synced document kinds", () => {
  assert.equal(classifySyncPath("2026-04-01.md",), "daily_note_markdown",);
  assert.equal(classifySyncPath("pages/roadmap.md",), "page_markdown",);
  assert.equal(classifySyncPath("widgets/score.widget.md",), "widget_markdown",);
  assert.equal(classifySyncPath("widgets/score.widget.sqlite3",), "widget_storage_blob",);
  assert.equal(classifySyncPath("assets/receipt.png",), "asset_blob",);
  assert.equal(classifySyncPath("drawings/plan.excalidraw",), "excalidraw_blob",);
  assert.equal(classifySyncPath("notes/untagged.txt",), null,);
});

test("getSyncStorageType separates text and blob kinds", () => {
  assert.equal(getSyncStorageType("page_markdown",), "text",);
  assert.equal(getSyncStorageType("widget_storage_blob",), "blob",);
});

test("hashContent is deterministic and content-sensitive", () => {
  const first = hashContent("hello world",);
  const second = hashContent("hello world",);
  const third = hashContent("hello world!",);

  assert.equal(first, second,);
  assert.notEqual(first, third,);
});

test("buildConflictCopyPath inserts a stable conflict suffix before the extension", () => {
  assert.equal(
    buildConflictCopyPath("pages/roadmap.md", "iphone", "2026-04-01T10:11:12.000Z",),
    "pages/roadmap.conflict-iphone-2026-04-01T10-11-12-000Z.md",
  );
});

test("resolveSyncWrite applies when revisions match", () => {
  const result = resolveSyncWrite({
    path: "pages/roadmap.md",
    kind: "page_markdown",
    baseRevision: 4,
    remoteRevision: 4,
    localHash: "local",
    remoteHash: "remote",
    deviceId: "iphone",
    now: "2026-04-01T10:11:12.000Z",
  },);

  assert.equal(result.status, "applied",);
  assert.equal(result.nextRevision, 5,);
  assert.equal(result.conflict, null,);
});

test("resolveSyncWrite returns noop when hashes already match", () => {
  const result = resolveSyncWrite({
    path: "pages/roadmap.md",
    kind: "page_markdown",
    baseRevision: 4,
    remoteRevision: 8,
    localHash: "same",
    remoteHash: "same",
    deviceId: "iphone",
  },);

  assert.equal(result.status, "noop",);
  assert.equal(result.nextRevision, 8,);
});

test("resolveSyncWrite returns a conflict copy for stale revisions", () => {
  const result = resolveSyncWrite({
    path: "pages/roadmap.md",
    kind: "page_markdown",
    baseRevision: 2,
    remoteRevision: 3,
    localHash: "local",
    remoteHash: "remote",
    deviceId: "iphone",
    now: "2026-04-01T10:11:12.000Z",
  },);

  assert.equal(result.status, "conflict",);
  assert.equal(result.nextRevision, null,);
  assert.deepEqual(result.conflict, {
    path: "pages/roadmap.md",
    kind: "page_markdown",
    baseRevision: 2,
    remoteRevision: 3,
    localHash: "local",
    remoteHash: "remote",
    conflictPath: "pages/roadmap.conflict-iphone-2026-04-01T10-11-12-000Z.md",
    detectedAt: "2026-04-01T10:11:12.000Z",
  },);
});
