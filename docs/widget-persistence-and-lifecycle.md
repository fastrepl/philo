# Widget Persistence And Lifecycle

This document is the implementation reference for how Philo stores widgets, updates them, saves them to the library, and tracks revisions.

If you are changing widget behavior, start here before editing the code. The goal is to avoid re-deriving the persistence model from `WidgetView.tsx`, `widget-files.ts`, and `library.ts` every time.

## Scope

This covers the desktop app widget flow implemented in:

- `apps/desktop/src/services/widget-files.ts`
- `apps/desktop/src/services/library.ts`
- `apps/desktop/src/components/editor/extensions/widget/WidgetExtension.ts`
- `apps/desktop/src/components/editor/extensions/widget/WidgetView.tsx`
- `apps/desktop/src/components/editor/EditorBubbleMenu.tsx`
- `apps/desktop/src/components/layout/AppLayout.tsx`

## Storage Layers

Philo widgets exist in four related layers:

1. Note content
   The note stores a widget embed like `![[widgets/<slug>-<id>.widget.md]]`.
2. Widget file
   The actual widget state lives in an individual `.widget.md` file under the resolved `widgets/` directory.
3. Widget instance storage
   If the widget has generated persistent storage, it also gets a sidecar SQLite database next to the widget file.
4. Library entry
   If the widget is archived to the library, it also gets a stable library entry and may get a shared component record.

The important rule is:

- The widget file is the source of truth for the current widget prompt, spec, saved state, and revision history.
- Widget instance data is instance-scoped by default, even when the widget is linked to a reusable library component.

## Files On Disk

### Widget files

Widget files live at:

- vault mode: `<vaultDir>/widgets/`
- default mode: `<journalDir>/widgets/`

Filename format:

```text
<slug>-<widget-id>.widget.md
```

### Library files

Library files live at:

- vault mode: `<vaultDir>/library/`
- default mode: `<journalDir>/library/`

Legacy non-shared library filename format:

```text
<slug>-<library-item-id>.component.md
```

Shared library entries are also backed by shared component manifests managed through `library.ts`.

## Widget File Schema

The in-memory shape in `widget-files.ts` is:

```ts
interface WidgetRevisionRecord {
  id: string;
  createdAt: string;
  prompt: string;
  spec: string;
}

interface WidgetFileRecord {
  id: string;
  title: string;
  prompt: string;
  saved: boolean;
  spec: string;
  currentRevisionId: string;
  revisions: WidgetRevisionRecord[];
  libraryItemId?: string | null;
  componentId?: string | null;
  storageSchema?: SharedStorageSchema | null;
  file: string;
  path: string;
}
```

Field meaning:

- `id`
  Stable widget file identity.
- `title`
  Display title derived from the prompt.
- `prompt`
  The current persisted widget prompt.
- `saved`
  Whether this widget is currently linked to a library entry.
- `spec`
  The current JSON UI spec used for rendering.
- `currentRevisionId`
  Pointer to the active revision in `revisions`.
- `revisions`
  Append-only revision snapshots for checkpoint/rollback support.
- `libraryItemId`
  Stable link to the library item that owns this widget, when archived.
- `componentId`
  Stable link to the shared component manifest for reusable widget templates.
- `storageSchema`
  Generated storage contract for this widget instance. When non-empty, it powers the widget's sidecar SQLite database.
- `file`
  Note embed target, usually `widgets/<filename>.widget.md`.
- `path`
  Absolute filesystem path.

## Widget Markdown Format

Each widget file is plain markdown with frontmatter-style metadata, the current spec, optional storage metadata, and an internal history block.

Example:

````md
---
id: "widget-uuid"
title: "Raffle"
prompt: "Build a raffle widget"
saved: true
libraryItemId: "library-item-uuid"
componentId: "shared-component-uuid"
---

```json
{
  "root": {
    "type": "Card"
  }
}
```

```json widget-storage
{
  "tables": [
    {
      "name": "items",
      "columns": [
        { "name": "id", "type": "integer", "primaryKey": true },
        { "name": "title", "type": "text", "notNull": true }
      ]
    }
  ],
  "namedQueries": [],
  "namedMutations": []
}
```

```json widget-history
{
  "currentRevisionId": "revision-uuid-2",
  "revisions": [
    {
      "id": "revision-uuid-1",
      "createdAt": "2026-03-17T08:00:00.000Z",
      "prompt": "Build a raffle widget",
      "spec": "{\"root\":{\"type\":\"Card\"}}"
    },
    {
      "id": "revision-uuid-2",
      "createdAt": "2026-03-17T08:05:00.000Z",
      "prompt": "Build a raffle widget with a winner area",
      "spec": "{\"root\":{\"type\":\"Card\",\"children\":[]}}"
    }
  ]
}
```
````

Notes:

- The first fenced `json` block is the current render spec.
- The optional `json widget-storage` block is the instance storage schema. If it contains tables, Philo creates a sibling `.widget.sqlite3` file for that widget instance.
- The `json widget-history` block is the internal checkpoint log.
- Older widget files without a history block are migrated lazily when rewritten.

## Note Serialization Format

When a note is saved, the widget node prefers writing an embed:

```md
![[widgets/raffle-<id>.widget.md]]
```

When a note is loaded, `resolveWidgetEmbeds()` reads the widget file and replaces the embed with a `data-widget` HTML placeholder for the editor runtime.

That runtime placeholder carries:

- `data-id`
- `data-file`
- `data-path`
- `data-prompt`
- `data-spec`
- `data-storage-schema`
- `data-saved`
- `data-library-item-id`
- `data-component-id`

## Build And Update Procedures

### 1. Create a new widget

Entry points:

- selection bubble menu `Build`
- `Mod-Shift-B`
- library insert

For a new AI-generated widget:

1. Insert a temporary widget node in the editor with `loading: true`.
2. Generate the JSON UI spec and storage schema together.
3. Create a new `.widget.md` file through `createWidgetFile()`.
4. If the storage schema is non-empty, create the widget's sidecar SQLite file.
5. Persist the first revision automatically.
6. Replace the temporary node attrs with the real file-backed widget record.

### 2. Rebuild an existing widget

Entry point:

- toolbar refresh button

Flow:

1. `WidgetView` builds a generation prompt from the saved widget prompt plus the current JSON spec.
2. The existing widget stays visible in the note.
3. The widget body gets an in-place build overlay.
4. The new spec and storage schema are generated together.
5. Existing widgets with a storage schema must keep that schema unchanged.
6. `persistWidgetRecord()` rewrites the widget file.
7. A new revision is appended if the prompt/spec changed.

### 3. Edit a widget through chat

Entry point:

- toolbar pencil button

Flow:

1. `WidgetView` requests a widget edit session.
2. `AppLayout` opens the AI composer with `[Edit widget] <title>`.
3. The user submits an edit instruction.
4. `WidgetView` turns that instruction into a generation prompt that includes:
   - the persisted widget prompt
   - the current widget JSON
   - the requested change
5. The widget rebuilds in place.
6. The resulting prompt/spec pair is persisted and appended as a new revision.

The important distinction is:

- the generation prompt can include the current JSON and the edit instruction
- the persisted prompt stays the canonical widget prompt stored on disk

### 4. Archive a widget to the library

Entry point:

- toolbar archive button on an inline widget

Flow:

1. `WidgetView.handleSave()` generates a shared widget version with storage metadata.
2. `addToLibrary()` creates the library entry and shared component manifest.
3. The widget file is rewritten with:
   - `saved: true`
   - `libraryItemId`
   - `componentId`
   - the widget instance's `storageSchema`
4. The editor node is updated to match the rewritten widget file.

### 5. Insert a widget from the library

Entry point:

- Library drawer

Flow:

1. `loadLibrary()` returns merged shared and legacy library items.
2. `AppLayout` creates a new widget file from the chosen library item.
3. The new widget file stores:
   - `saved: true`
   - `libraryItemId: item.id`
   - `componentId` if the item is shared
   - `storageSchema` copied from the reusable template
4. If the copied storage schema is non-empty, the inserted widget gets its own sidecar SQLite file.
5. The note gets a normal file-backed widget node.

This means library insertion creates a new widget file instance with independent data storage, not a direct pointer into the library's runtime database.

### 6. Remove a library item

Entry point:

- Library drawer delete action

Flow:

1. `removeFromLibrary()` removes the library entry.
2. `markWidgetLibraryReferenceRemoved()` scans widget files.
3. Matching widget files have their library link cleared:
   - `saved: false`
   - `libraryItemId: null`
   - `componentId: null` when it matched the removed shared component

This keeps note widgets and library state from drifting.

## Revision Tracking Rules

Philo uses internal widget revisions, not Git, for widget checkpoints.

Current rules:

- Every new widget starts with one revision.
- Every rebuild or chat edit that changes prompt/spec appends one new revision.
- Saving to library also appends a revision if it changes the persisted widget record.
- If a rewrite does not materially change the prompt/spec pair, no duplicate revision is appended.

Current limitation:

- The persistence layer supports checkpoints, but there is not yet a UI for browsing or restoring older revisions.

## Operational Invariants

When changing widget code, preserve these invariants:

- The widget file stays the canonical source of truth.
- `saved` alone is not enough to identify library linkage. Use `libraryItemId`.
- `componentId` identifies the reusable template, not the widget instance's data rows.
- Widget instance data should default to per-widget storage, not shared library storage.
- Revisions are append-only snapshots of prompt/spec state.
- Removing a library entry must clear saved/library references from widget files.
- Note markdown should keep storing widget embeds, not inline giant JSON blobs.

## Practical Change Checklist

If you touch widget persistence, verify:

- widget create still writes a `.widget.md` file
- note save/load still round-trips widget embeds
- rebuild/edit still append revisions
- save-to-library still writes `saved`, `libraryItemId`, and `componentId`
- library delete still clears matching widget files
- old widget files without history still load and rewrite correctly
