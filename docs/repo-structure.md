# File And Folder Organization

This repo is a small pnpm workspace with three app targets plus shared packages:

- `apps/desktop` is the actual Philo desktop app.
- `apps/mobile` is the Expo iPhone shell.
- `apps/landing` is the marketing site.
- `packages/core` holds shared sync and bridge contracts.
- `packages/web-editor-host` is the standalone browser host used by the mobile WebView flow.

If you are making product changes, most of the time you will be working inside `apps/desktop`.

## Top Level

```text
.
├── apps/
├── docs/
├── scripts/
├── vendor/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── dprint.json
└── README.md
```

## What Each Top-Level Folder Is For

- `apps/`
  - Workspace packages.
  - `desktop` is the Tauri app.
  - `mobile` is the Expo app.
  - `landing` is the Astro site.
- `packages/`
  - Shared packages reused across app targets.
  - `core` contains sync and WebView bridge types/helpers.
  - `web-editor-host` contains the standalone editor host loaded by mobile.
- `docs/`
  - Internal documentation like architecture notes.
  - Notable references include:
    - `data-storage-and-configuration.md`
    - `mobile-sync.md`
    - `markdown-sync.md`
    - `widget-persistence-and-lifecycle.md`
- `scripts/`
  - Repo-level utility scripts, including release verification.
- `vendor/`
  - Vendored upstream code. In this repo that is mostly `vendor/hyprnote` native plugin code.
  - It is shared reference code, not the main place for Philo-specific product work.
- `dist/`
  - Generated build output.
- `node_modules/`, `.turbo/`
  - Generated dependency/cache folders.

## Desktop App Layout

The desktop app is split into a web frontend and a Rust/Tauri backend:

```text
apps/desktop/
├── src/
├── src-tauri/
├── public/
├── scripts/
├── vite.config.ts
└── package.json
```

## Mobile App Layout

`apps/mobile` is the Expo shell used for iPhone development.

```text
apps/mobile/
├── src/
├── App.tsx
├── app.json
├── index.ts
└── package.json
```

Important pieces:

- `App.tsx`
  - Native shell with Today, Search, and Settings surfaces.
- `src/services/sync.ts`
  - Mobile mirrored-cache persistence, Supabase auth/session handling, and sync pull/push logic.
- `src/components/EditorWebView.tsx`
  - Native bridge that renders the shared browser host inside `react-native-webview`.
- `src/hooks/useMountEffect.ts`
  - Mount-only React escape hatch used for linking and app-state listeners.

## Shared Packages

```text
packages/
├── core/
└── web-editor-host/
```

- `packages/core`
  - Shared sync kinds, conflict helpers, and editor-host bridge message parsing.
- `packages/web-editor-host`
  - Standalone browser editor shell used by the mobile WebView path and local Vite development.

## `apps/desktop/src`

This is the React/TypeScript side of the desktop app.

### Main entry files

- `main.tsx`
  - Frontend bootstrapping.
- `App.tsx`
  - Top-level React app shell.
- `App.css`
  - App-wide frontend styles.

### `components/`

UI components, grouped by feature area.

- `components/layout/`
  - App shell, top-level timeline layout, global search, modal wiring.
- `components/journal/`
  - Daily note editing and note-specific UI.
- `components/editor/`
  - Shared editor UI and custom TipTap extensions.
  - Widget-specific editor files live under `components/editor/extensions/widget/`.
  - `components/editor/extensions/widget/code/` contains the code-widget compiler, runtime renderer, and widget SDK.
- `components/library/`
  - Widget library UI.
- `components/settings/`
  - Settings modal and setup UI.
- `components/onboarding/`
  - First-run vault/journal configuration flow.
- `components/ai/`
  - AI-related UI pieces.
- `components/shared/`
  - Reusable shared components.

### `services/`

Non-UI application logic. This is where most filesystem and domain behavior lives.

- `storage.ts`
  - Daily note read/write logic.
- `paths.ts`
  - Resolves journal/vault paths and note filenames.
- `obsidian.ts`
  - Obsidian vault detection and bootstrap helpers.
- `images.ts`
  - Asset saving and asset URL resolution.
- `excalidraw.ts`
  - Excalidraw embed resolution/render helpers.
- `mentions.ts`
  - Mention parsing and markdown conversions.
- `tasks.ts`
  - Rollover and recurring-task behavior.
- `library.ts`
  - Library drawer item loading, archived widget reuse, and shared component persistence.
- `chats.ts`
  - File-backed AI chat history persistence.
- `widget-files.ts`
  - File-backed widget persistence, widget markdown parsing, widget embed resolution, and widget revision history.
- `widget-git-history.ts`
  - Desktop bridge for app-managed Git widget snapshots, diffs, and restore.
- `widget-storage.ts`
  - Widget-instance storage helpers, schema normalization, and Tauri bridge for per-widget SQLite queries/mutations.
- `generate.ts`, `assistant.ts`
  - AI/widget generation logic. New widgets are generated as TSX code widgets plus storage schema.
- `settings.ts`
  - Persistent settings access.
- `updater.ts`
  - Desktop update handling.
- `format.ts`
  - Note formatting helpers.

### `lib/`

Low-level shared utilities used across features.

- `markdown.ts`
  - The TipTap JSON <-> markdown conversion layer.

### `hooks/`

React hooks for app-level state derived from the environment.

- `useCurrentDate.ts`
- `useTimezoneCity.ts`

### `types/`

Small shared type definitions.

- `note.ts`
  - Daily note shape and date helpers.

### `assets/`

Static frontend assets imported by the desktop app.

## `apps/desktop/src-tauri`

This is the native shell and backend side of the desktop app.

```text
apps/desktop/src-tauri/
├── src/
├── icons/
├── capabilities/
├── Cargo.toml
├── tauri.conf.json
└── tauri.dev.conf.json
```

### Important files

- `src/lib.rs`
  - Main Tauri command handlers and desktop-native logic.
  - Filesystem commands, search indexing, Obsidian detection, window behavior, menu wiring.
- `src/main.rs`
  - Rust entrypoint.
- `Cargo.toml`
  - Rust dependencies and package metadata.
- `tauri.conf.json`
  - Desktop app packaging/runtime config.
- `capabilities/default.json`
  - Tauri capability configuration.
- `icons/`
  - App icons for different platforms.

### Generated / build output inside `src-tauri`

- `target/`
  - Rust build output.
- `gen/`
  - Generated Tauri artifacts.

These are not the main places to make hand edits.

## Landing Site Layout

`apps/landing` is much smaller and follows the usual Astro split:

- `src/pages/`
  - Route files.
- `src/content/blog/`
  - Blog posts.
- `public/`
  - Static files.

## Vendored Code

`vendor/hyprnote` is a vendored upstream codebase that Philo still uses for some native Tauri plugins.

In practice:

- Philo-specific app work should usually start in `apps/desktop`.
- Only touch `vendor/hyprnote` if the change genuinely belongs in the vendored upstream layer.

## Rule Of Thumb For New Code

- UI or interaction change: `apps/desktop/src/components`
- Filesystem or note behavior: `apps/desktop/src/services`
- Markdown/editor round-trip behavior: `apps/desktop/src/lib/markdown.ts` or `components/editor`
- Native desktop command or OS integration: `apps/desktop/src-tauri/src/lib.rs`
- Marketing site content or pages: `apps/landing`
- Internal explanations: `docs`

## Widget-Specific Pointers

If you are changing widgets, these are the highest-signal files:

- `apps/desktop/src/components/editor/extensions/widget/WidgetExtension.ts`
  - TipTap node definition and markdown/HTML serialization entrypoint.
- `apps/desktop/src/components/editor/extensions/widget/WidgetView.tsx`
  - Widget toolbar behavior, rebuild flow, save-to-library flow, Git history/restore UI wiring, library reuse behavior, and runtime rendering.
- `apps/desktop/src/components/editor/extensions/widget/WidgetHistoryPanel.tsx`
  - Inline Git history browser and diff/restore controls for widgets.
- `apps/desktop/src/services/widget-files.ts`
  - `.widget.md` file format, disk persistence, widget embed resolution, and revision snapshots.
- `apps/desktop/src/services/widget-git-history.ts`
  - Normalized widget snapshot serialization and Tauri bridge for Git-backed widget history.
- `apps/desktop/src/services/widget-storage.ts`
  - Instance-scoped widget SQLite storage and runtime query/mutation plumbing.
- `apps/desktop/src/services/library.ts`
  - Library item persistence and shared component storage.
- `docs/widget-persistence-and-lifecycle.md`
  - The implementation reference for widget schema and lifecycle behavior.

## Folders You Usually Ignore While Editing

- `node_modules/`
- `.turbo/`
- `dist/`
- `apps/desktop/dist/`
- `apps/desktop/src-tauri/target/`

Those are generated outputs, caches, or installed dependencies rather than source-of-truth code.
