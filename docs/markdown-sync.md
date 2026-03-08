# Markdown Sync And Editor Rendering

Philo stores daily notes as markdown files on disk, but edits them in memory as TipTap JSON. The desktop app converts between those two representations at the storage boundary so the editor can stay structured while the filesystem stays plain markdown.

## The Core Model

- In memory: `DailyNote.content` is a JSON string containing a TipTap document.
- On disk: each note is a `.md` file, optionally prefixed with frontmatter.
- The boundary lives in `apps/desktop/src/services/storage.ts`.

That contract is already called out in `apps/desktop/src/types/note.ts`:

```ts
content: string; // TipTap JSON string (in-memory), markdown on disk
```

## Where The Markdown File Lives

`apps/desktop/src/services/paths.ts` decides the note path:

- If `journalDir` is configured, Philo writes directly there.
- Otherwise, if `vaultDir` is configured, Philo writes into the vault's daily-notes folder.
- Otherwise it falls back to the app data directory under `journal/`.
- The filename comes from the configured pattern, defaulting to `YYYY-MM-DD.md`.

`getNotePath(date)` is the final source of truth for note file paths.

## Save Path: Editor To Raw Markdown

The write flow is:

1. `EditableNote` listens to TipTap `onUpdate`.
2. Changes are debounced for 500 ms.
3. The updated TipTap document is serialized with `editor.getJSON()`.
4. `saveDailyNote()` converts that JSON into markdown and writes the file through a Tauri command.

The important steps in `apps/desktop/src/services/storage.ts` are:

1. Parse the JSON string with `parseJsonContent()`.
2. Convert TipTap JSON to markdown with `json2md()`.
3. Rewrite asset URLs back to relative markdown paths with `unresolveMarkdownImages()`.
4. Rewrite `@mentions` into Obsidian-style wiki links with `convertAtMentionsToWikiLinks()`.
5. Re-attach frontmatter with `buildFrontmatter()`.
6. Call the Tauri command `write_markdown_file`.

The Rust side in `apps/desktop/src-tauri/src/lib.rs` is intentionally thin:

- `write_markdown_file(path, content)` creates parent directories if needed.
- Then it writes the raw string to disk.

There is no separate database for note bodies. The markdown file is the source of truth.

## Load Path: Raw Markdown Back Into The Editor

The read flow is the inverse:

1. `AppLayout` loads today's note with `getOrCreateDailyNote()`.
2. Past notes lazy-load when they scroll near the viewport.
3. `loadDailyNote()` reads the markdown file from disk.
4. The markdown is normalized into editor-friendly markup.
5. `md2json()` converts that markdown into TipTap JSON.
6. `EditableNote` receives that JSON string and calls `setContent()`.

The normalization inside `loadDailyNote()` is important:

1. `parseFrontmatter()` strips frontmatter and extracts `city`.
2. `resolveExcalidrawEmbeds()` turns `![[drawing.excalidraw]]` into a placeholder HTML node.
3. `replaceMentionWikiLinksWithChips()` turns `[[...]]` links into mention-chip HTML nodes.
4. `resolveMarkdownImages()` converts relative markdown image paths into Tauri asset-protocol URLs the editor can display.
5. `md2json()` parses the final markdown/HTML mix into a TipTap document.

The Tauri command `read_markdown_file(path)` just returns the raw file contents or `null` if the file does not exist.

## How The Editor Knows What To Render

`apps/desktop/src/components/journal/EditableNote.tsx` configures the live TipTap editor. `apps/desktop/src/lib/markdown.ts` configures a `MarkdownManager` with the matching markdown extensions for load/save.

That pairing is what makes the round-trip work:

- Standard markdown nodes come from `StarterKit`, `TaskList`, `Image`, `Link`, `Table`, `Underline`, and `Highlight`.
- `CustomParagraph` preserves intentionally blank paragraphs.
- `MentionChipExtension` renders chips in the editor, but serializes them as wiki links like `[[2026-03-08]]` or `[[tag_work|work]]`.
- `ExcalidrawExtension` renders an embedded preview in the editor, but serializes back to `![[file.excalidraw]]`.
- `WidgetExtension` renders an interactive React node view in the editor, but persists as a raw HTML sentinel:

```html
<div data-widget="" data-id="..." data-prompt="..." data-spec="..." data-saved="true"></div>
```

The editor is therefore not reading the markdown file directly on every keystroke. It reads a TipTap document that was derived from markdown when the note was loaded.

## External File Sync Behavior

Philo already does a limited form of filesystem sync with the raw markdown file:

- On startup it loads from disk.
- While the app is open, today's note is re-read when the window regains focus.
- The journal directory is also watched for `.md` file changes; if one changes, Philo refreshes today's note from disk.

This means external edits to today's markdown file can show up in the editor without restarting the app.

Current limitations:

- The watcher only re-syncs today's note, not every already-mounted past note.
- Sync is file-level reload, not operational merge. The latest disk read replaces the in-memory note state.
- Autosave is still editor-driven, so local editor changes are usually written back within 500 ms.

## Obsidian / Vault Integration

When Philo is pointed at an Obsidian vault, it tries to honor the vault layout instead of inventing its own:

- `detectObsidianFolders()` reads `.obsidian` config to detect the daily-notes folder, attachments folder, excalidraw folder, and filename format.
- `bootstrap_obsidian_vault()` can create a minimal `.obsidian` setup for a fresh vault.
- Mention links and Excalidraw embeds intentionally use Obsidian-friendly syntax so the markdown stays portable.

## Practical Example

A note might look like this on disk:

```md
---
city: Seoul
---

- [ ] Review draft [[2026-03-09]]

![[weekly-plan.excalidraw]]

<div data-widget="" data-id="w1" data-prompt="habit tracker" data-spec="{...}" data-saved="true"></div>
```

That same note appears in the editor as:

- a task item with a rendered mention chip
- an embedded Excalidraw block
- an interactive widget node view

The markdown file stays plain and portable, while the editor gets richer UI from the custom TipTap extensions.
