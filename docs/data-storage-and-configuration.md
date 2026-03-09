# Data Storage And Configuration

This document describes where Philo stores its data, which settings control those locations, and how configuration changes affect the filesystem layout.

## Two Layers Of Persistence

Philo persists data in two places:

1. A small app-owned config area under the app data directory.
2. User-facing content files under either a journal folder or an Obsidian vault.

The important distinction is:

- Configuration always lives under the app data directory.
- Notes, images, Excalidraw files, and widget-library files live under the resolved content directory.

## Base App Data Directory

`apps/desktop/src/services/paths.ts` defines the app-owned base directory via `getBaseDir()`.

- In development it uses `~/Library/Application Support/com.philo.dev/`.
- In production it uses Tauri's `appDataDir()`.

This base directory is where Philo stores app-managed files like `settings.json`.

## Configuration: `settings.json`

Settings are stored as JSON at:

```text
<baseDir>/settings.json
```

The shape comes from `apps/desktop/src/services/settings.ts`:

```json
{
  "anthropicApiKey": "",
  "journalDir": "",
  "filenamePattern": "",
  "vaultDir": "",
  "dailyLogsFolder": "",
  "excalidrawFolder": "",
  "assetsFolder": "",
  "hasCompletedOnboarding": false
}
```

What each field means:

- `anthropicApiKey`
  - API key used by the AI/widget generation features.
  - Stored locally as plain JSON in `settings.json`.
- `journalDir`
  - The currently resolved root directory for daily notes.
  - When a vault is configured, this is usually `<vaultDir>/<dailyLogsFolder>`.
- `filenamePattern`
  - Pattern used to map dates to note file paths.
  - Default: `{YYYY}-{MM}-{DD}`.
- `vaultDir`
  - Optional root of an Obsidian vault.
- `dailyLogsFolder`
  - Folder inside the vault where daily notes are written.
- `excalidrawFolder`
  - Folder used to resolve `![[*.excalidraw]]` embeds.
- `assetsFolder`
  - Folder used for pasted/dropped image files.
- `hasCompletedOnboarding`
  - Used to decide whether first-run setup should appear.

## How Configuration Is Written

There are two UI flows that write `settings.json`:

- `components/onboarding/OnboardingModal.tsx`
  - First-run setup.
- `components/settings/SettingsModal.tsx`
  - Ongoing configuration edits.

Both flows call `saveSettings()` from `services/settings.ts`.

After saving, Philo also:

- resets the cached journal path with `resetJournalDir()`
- re-extends Tauri filesystem scope with `initJournalScope()`

That makes path changes take effect immediately without a restart.

## How The Active Note Root Is Chosen

`getJournalDir()` in `services/paths.ts` resolves the active note root with this precedence:

1. `settings.journalDir` if present
2. otherwise `settings.vaultDir + settings.dailyLogsFolder`
3. otherwise `<baseDir>/journal`

So there are two common operating modes.

### Mode 1: Default app-managed storage

If no vault is configured:

- notes live under `<baseDir>/journal/`
- assets live under `<baseDir>/journal/assets/`
- widget library lives under `<baseDir>/journal/library/`

### Mode 2: Obsidian-backed storage

If a vault is configured:

- notes live under `<vaultDir>/<dailyLogsFolder>/`
- assets live under `<vaultDir>/<assetsFolder>/` unless `assetsFolder` is absolute
- Excalidraw embeds resolve from `<vaultDir>/<excalidrawFolder>/` unless `excalidrawFolder` is absolute
- widget library lives under `<vaultDir>/library/`

Settings still remain in `<baseDir>/settings.json` even when content is stored in the vault.

## Daily Notes

Daily notes are plain markdown files written by `services/storage.ts`.

The final path is:

```text
<journalDir>/<filenamePattern(date)>.md
```

Examples:

- flat pattern: `2026-03-09.md`
- yearly folders: `2026/2026-03-09.md`
- yearly and monthly folders: `2026/03/2026-03-09.md`

What a note file stores:

- markdown body content
- optional frontmatter, currently used for `city`
- note links that follow the active filename pattern
- markdown image references
- Obsidian-style Excalidraw embeds
- widget placeholders serialized as HTML blocks

Example:

```md
---
city: Seoul
---

- [ ] Review draft [[2026-03-10]]

![receipt](image_1741512345678_0.png)

![[weekly-plan.excalidraw]]
```

## Images / Assets

Pasted and dropped images are saved by `services/images.ts`.

Behavior:

- the file is written into the resolved assets directory
- the filename is generated as `image_<timestamp>_<index>.<ext>`
- markdown stores a relative asset path, not the temporary editor URL

Default location:

```text
<journalDir>/assets/
```

Vault-backed location:

```text
<vaultDir>/<assetsFolder>/
```

If `assetsFolder` is absolute, Philo writes there directly.

## Excalidraw Embeds

Philo does not own Excalidraw scene files by itself. It resolves them from the configured vault/journal paths.

Resolution rules come from `services/excalidraw.ts`:

- explicit relative paths inside the note are honored
- otherwise Philo searches the configured Excalidraw folder, vault root, and journal root
- configured absolute Excalidraw paths are used directly

The setting only changes where Philo looks. It does not migrate Excalidraw files.

## Widget Library

The widget library is stored as individual markdown files, not in a database.

Current location:

- vault mode: `<vaultDir>/library/`
- default mode: `<journalDir>/library/`

Each saved widget becomes:

```text
<slug>-<id>.component.md
```

Each file contains:

- frontmatter-like metadata fields such as `id`, `title`, `description`, `prompt`, `savedAt`
- a fenced JSON block containing the widget spec

There is also legacy support for:

```text
<baseDir>/library.json
```

If that legacy file exists and the new library directory is empty, Philo migrates the entries into `.component.md` files.

## Obsidian Detection And Bootstrap

When the user points Philo at a vault, `services/obsidian.ts` and the Tauri backend inspect `.obsidian` files to detect:

- daily notes folder
- filename format
- attachment folder
- Excalidraw folder

On first setup Philo can also create minimal vault config files through `bootstrap_obsidian_vault()`.

That setup writes config into the vault's `.obsidian/` directory, but Philo's own runtime settings still stay in `settings.json`.

## What Configuration Changes Do Not Do

Changing configuration updates future reads and writes, but it does not automatically move existing files.

Specifically:

- changing `vaultDir` or `dailyLogsFolder` does not move old notes
- changing `assetsFolder` does not move old images
- changing `filenamePattern` does not rename existing note files
- changing `excalidrawFolder` does not relocate drawings

The settings UI already warns about the filename and folder cases. The code applies the new paths immediately, but it treats migration as a manual task.

## Practical Summary

If you want to know where something is stored:

- app settings and API key: `<baseDir>/settings.json`
- daily notes: resolved `journalDir` plus `filenamePattern`
- pasted images: resolved assets folder
- widget library: `library/` under the vault or journal root
- Excalidraw content: wherever the configured Excalidraw path points, or the vault/journal fallback locations

The clean mental model is:

- `settings.json` tells Philo where to read and write content
- the actual user data stays as normal files on disk
