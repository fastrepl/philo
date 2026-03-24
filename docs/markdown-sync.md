# Markdown Sync And Editor Rendering

Philo stores daily notes as markdown files on disk, but edits them in memory as TipTap JSON. The storage boundary is intentionally opinionated: the app normalizes markdown on the way in, normalizes it again on the way out, and treats the markdown file as the long-term source of truth.

## The Core Model

- In memory: `DailyNote.content` is a JSON string containing a TipTap document.
- On disk: each note is a `.md` file, optionally prefixed with frontmatter.
- `apps/desktop/src/services/storage.ts` owns file I/O.
- `apps/desktop/src/lib/markdown.ts` owns markdown parsing and serialization.

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
5. Rewrite canonical date-mention links back into note links with `rewriteDateMentionLinksToNoteLinks()`.
6. Re-attach frontmatter with `buildFrontmatter()`.
7. Call the Tauri command `write_markdown_file`.

The Rust side in `apps/desktop/src-tauri/src/lib.rs` is intentionally thin:

- `write_markdown_file(path, content)` creates parent directories if needed.
- Then it writes the raw string to disk.

There is no separate database for note bodies. The markdown file is the source of truth.

## What `json2md()` Actually Does

`apps/desktop/src/lib/markdown.ts` is not a straight `MarkdownManager.serialize()` wrapper. The current write-side logic does a few important normalizations so the saved markdown stays stable and reparses correctly:

1. Top-level blocks are serialized one at a time and stitched together with explicit newline counts.
   This is how Philo preserves empty paragraphs without inheriting TipTap's default double block spacing around lists.
2. Consecutive top-level paragraphs are still merged into one markdown paragraph with embedded newline text.
   This preserves blank lines between paragraphs without writing placeholder text like `&nbsp;`.
3. Empty bullet items are normalized from `-` to `-`, because TipTap's default serializer emits `-` but its parser reparses that as plain paragraph text instead of an empty bullet item.
4. When Philo is pointed at a vault, serialization uses tab indentation (`{ style: "tab", size: 1 }`) so the file on disk matches Obsidian's layout more closely.

The practical consequence is that the file on disk is not just "whatever TipTap emitted". Philo post-normalizes the markdown so the next load can reconstruct the same structure.

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
2. `rewriteNoteLinksToDateMentionLinks()` converts daily-note wiki links into canonical date mentions.
3. `resolveExcalidrawEmbeds()` turns `![[drawing.excalidraw]]` into a placeholder HTML node.
4. `replaceMentionWikiLinksWithChips()` turns `[[...]]` links into mention-chip HTML nodes.
5. `resolveMarkdownImages()` converts relative markdown image paths into Tauri asset-protocol URLs the editor can display.
6. `md2json()` parses the final markdown/HTML mix into a TipTap document.

The Tauri command `read_markdown_file(path)` just returns the raw file contents or `null` if the file does not exist.

## What `md2json()` Actually Does

The current load path does several markdown-specific repairs before the content ever reaches the editor:

1. Line endings are normalized to `\n`.
2. If the note is in a vault, leading tabs are expanded to parser-friendly spaces for parsing only.
   This does not rewrite the file on disk.
3. Obsidian-style nested bare task lines like `\t [ ] child` are rewritten to a parser-safe form like `\t- [ ] child` before lexing.
4. `MarkdownManager.instance.lexer()` is used directly so Philo can preserve blank lines that `marked` sometimes reports as:
   - explicit `space` tokens
   - leading `\n` on the next token
   - trailing `\n\n` on the previous token
5. Mixed top-level list tokens are split manually when `marked` merges bullet items and task items into one `list` token.
   This is what preserves a blank line between a bullet list and a task list across reloads.
6. Blank lines are reintroduced as explicit empty TipTap paragraph nodes.

That means the md -> TipTap path is intentionally more opinionated than a raw markdown parse. Philo has to compensate for parser edge cases around blank lines, mixed lists, empty bullet items, and Obsidian-style indentation.

## How The Editor Knows What To Render

`apps/desktop/src/components/journal/EditableNote.tsx` configures the live TipTap editor. `apps/desktop/src/lib/markdown.ts` configures a `MarkdownManager` with the matching markdown extensions for load/save.

That pairing is what makes the round-trip work:

- Standard markdown nodes come from `StarterKit`, `TaskList`, `Image`, `Link`, `Table`, `UnderlineExtension`, and `Highlight`.
- `CustomParagraph` preserves intentionally blank paragraphs.
- `MentionChipExtension` renders chips in the editor, but serializes them as wiki links like `[[2026-03-08]]` or `[[tag_work|work]]`.
- `ExcalidrawExtension` renders an embedded preview in the editor, but serializes back to `![[file.excalidraw]]`.
- `WidgetExtension` renders an interactive React node view in the editor, but file-backed widgets serialize as embeds like `![[widgets/<slug>-<id>.widget.md]]`.
- On load, `resolveWidgetEmbeds()` turns those embeds into `data-widget` HTML placeholders for TipTap. Those placeholders carry the per-node editor id plus the stable widget file/storage id.

The editor is therefore not reading the markdown file directly on every keystroke. It reads a TipTap document that was derived from markdown when the note was loaded.

## Chip Kinds

Philo currently renders six mention-chip kinds in the editor:

- `date`
- `recurring`
- `tag`
- `page`
- `gmail`
- `google_calendar`

Important behavior:

- page chips are the common display form for attached pages, shared pages, and URL-created pages
- URL chips are not a separate markdown primitive; when a stale bare URL is converted, Philo creates or reuses a shared page and inserts a normal `page` chip
- those page chips still serialize as wiki links on disk, so the markdown round-trip stays uniform even when the in-editor display is richer

## Page Display Variants

The page markdown under `pages/` is not the same as the page presentation in the app. `PageView` currently has several display modes layered on top of the same underlying markdown page model:

- plain page: page title plus editable body
- meeting page: title, meeting badge, attached-date link when relevant, then editable body
- generic URL summary page: `link_title` as heading, source URL link, summary timestamp, editable summary body, follow-up AI chips
- typed GitHub page: `link_title` as heading, source URL link, structured GitHub metadata header, editable summary body, follow-up AI chips

That means two pages can both be stored as normal markdown files under `pages/` while rendering very differently in the app because their frontmatter carries different metadata.

## Editor Behavior That Matters For Sync

The live editor now uses normal block splitting for Enter at the top level. That matters because list creation depends on real paragraph boundaries:

- typing plain text, pressing Enter, and then typing `-` should create a real bullet list item
- pressing `cmd+l` on a blank block should turn that block into a task item
- blank lines in the editor are represented as actual empty paragraph nodes, not newline characters embedded in the previous paragraph

The markdown serializer assumes the TipTap document is already structurally correct before it writes to disk. If the editor shape is wrong, the markdown file will be wrong too.

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
- Local writes suppress the watcher briefly so Philo does not immediately reload the file it just saved and reset the editor selection.

## Obsidian / Vault Integration

When Philo is pointed at an Obsidian vault, it tries to honor the vault layout instead of inventing its own:

- `detectObsidianFolders()` reads `.obsidian` config to detect the daily-notes folder, attachments folder, excalidraw folder, and filename format.
- `bootstrap_obsidian_vault()` can create a minimal `.obsidian` setup for a fresh vault.
- Mention links and Excalidraw embeds intentionally use Obsidian-friendly syntax so the markdown stays portable.
- Vault-backed notes load with tab indentation assumptions and save back with tab indentation as well.

## Practical Example

A note might look like this on disk:

```md
---
city: Seoul
---

- [ ] Review draft [[2026_03_09]]

![[weekly-plan.excalidraw]]

![[widgets/habit-tracker-123.widget.md]]
```

That same note appears in the editor as:

- a task item with a rendered mention chip
- an embedded Excalidraw block
- an interactive widget node view

The markdown file stays plain and portable, while the editor gets richer UI from the custom TipTap extensions.

For widgets specifically:

- the note on disk stores the embed target
- the `.widget.md` file stores the widget source, storage schema, and revision history
- the in-memory editor placeholder is only a runtime transport shape, not the canonical saved note format
