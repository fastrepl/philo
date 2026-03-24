# Data Storage And Configuration

This document describes where Philo stores its data, which settings control those locations, and how configuration changes affect the filesystem layout.

## Two Layers Of Persistence

Philo persists data in two places:

1. A small app-owned config area under the app data directory.
2. User-facing content files under either a journal folder or an Obsidian vault.

The important distinction is:

- Configuration always lives under the app data directory.
- App-managed widget Git history also lives under the app data directory.
- Notes, images, Excalidraw files, widget files, widget-library files, and chat-history files live under the resolved content directory.
- Google OAuth secrets and tokens live in the OS credential store for new sessions.

## Base App Data Directory

`apps/desktop/src/services/paths.ts` defines the app-owned base directory via `getBaseDir()`.

- In development it uses `~/Library/Application Support/com.philo.dev/`.
- In production it uses Tauri's `appDataDir()`.

This base directory is where Philo stores app-managed files like `settings.json` and widget-history repos.

## Configuration: `settings.json`

Settings are stored as JSON at:

```text
<baseDir>/settings.json
```

The shape comes from `apps/desktop/src/services/settings.ts`:

```json
{
  "aiProvider": "anthropic",
  "anthropicApiKey": "",
  "openaiApiKey": "",
  "googleApiKey": "",
  "openrouterApiKey": "",
  "googleOAuthClientId": "<bundled google oauth client id>",
  "googleAccounts": [],
  "googleAccountEmail": "",
  "googleAccessToken": "",
  "googleRefreshToken": "",
  "googleAccessTokenExpiresAt": "",
  "googleGrantedScopes": [],
  "journalDir": "",
  "filenamePattern": "",
  "vaultDir": "",
  "dailyLogsFolder": "",
  "excalidrawFolder": "",
  "assetsFolder": "",
  "widgetGitHistoryEnabled": true,
  "hasCompletedOnboarding": false
}
```

What each field means:

- `aiProvider`
  - The currently selected AI provider in settings.
- `anthropicApiKey`
  - API key used by the AI/widget generation features.
  - Stored locally as plain JSON in `settings.json`.
- `openaiApiKey`
  - OpenAI API key used when OpenAI is the active provider.
- `googleApiKey`
  - Google AI Studio / Gemini API key used when Google is the active provider.
- `openrouterApiKey`
  - OpenRouter API key used when OpenRouter is the active provider.
- `googleOAuthClientId`
  - Bundled Google OAuth desktop client ID used by the `Continue with Google` flow in settings.
- `googleAccounts`
  - Connected Google accounts tracked by the app.
  - Each entry stores the email address, granted scopes, and cached access-token expiry summary.
- `googleAccountEmail`
  - Legacy migration field from the old single-account model.
- `googleAccessToken`
  - Legacy migration field. New Google sessions keep the access token in the OS credential store instead of `settings.json`.
- `googleRefreshToken`
  - Legacy migration field. New Google sessions keep the refresh token in the OS credential store instead of `settings.json`.
- `googleAccessTokenExpiresAt`
  - Legacy migration field from the old single-account model.
- `googleGrantedScopes`
  - Legacy migration field from the old single-account model.
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
- `widgetGitHistoryEnabled`
  - Enables the app-managed Git mirror used for widget snapshot history.
  - Default: `true`.
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

That makes path changes take effect immediately without a restart. The scope refresh covers the current journal root, vault root, assets directory, Excalidraw directory, and widgets directory.

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
- widget files live under `<baseDir>/journal/widgets/`
- widget library lives under `<baseDir>/journal/library/`
- chat history lives under `<baseDir>/journal/chats/`

### Mode 2: Obsidian-backed storage

If a vault is configured:

- notes live under `<vaultDir>/<dailyLogsFolder>/`
- assets live under `<vaultDir>/<assetsFolder>/` unless `assetsFolder` is absolute
- Excalidraw embeds resolve from `<vaultDir>/<excalidrawFolder>/` unless `excalidrawFolder` is absolute
- widget files live under `<vaultDir>/widgets/`
- widget library lives under `<vaultDir>/library/`
- chat history lives under `<vaultDir>/chats/`

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
- widget embeds that point at `.widget.md` files

Example:

```md
---
city: Seoul
---

- [ ] Review draft [[2026-03-10]]

![receipt](image_1741512345678_0.png)

![[weekly-plan.excalidraw]]
```

## Pages

Files under `pages/` are plain markdown, but they do not all share one exact schema.

Current location:

- vault mode: `<vaultDir>/pages/`
- default mode: sibling `pages/` folder next to the resolved journal root

Philo currently reads and writes four page-shaped markdown variants.

### 1. Plain Pages

These are the default attached pages. They may have no frontmatter at all.

Example:

```md
# Draft outline

- tighten the intro
- add screenshots
```

Notes:

- `type` defaults to `page` when omitted
- the body is the canonical editable content
- `attached_to` may be inferred from daily-note links instead of frontmatter

### 2. Meeting Pages

Meeting pages use frontmatter for structured metadata and then keep the meeting notes in the body.

Example:

```md
---
type: "meeting"
started_at: "2026-03-23T09:00:00.000Z"
ended_at: "2026-03-23T09:45:00.000Z"
participants:
  - "Alex"
  - "Sam"
location: "San Francisco"
executive_summary: "Aligned on launch scope and owners."
session_kind: "decision_making"
agenda:
  - "Launch timing"
  - "QA readiness"
action_items:
  - "Alex to confirm release checklist"
source: "ad-hoc"
---

## Summary

- Launch is still on track for Friday.

## Decisions

- Ship without the secondary onboarding tweak.
```

Notes:

- all meeting-specific frontmatter fields are optional
- the body is still the source of truth for the editable meeting note itself
- Philo may append transcript and summary sections into the body over time

### 3. URL Summary Pages

URL summary pages are normal `page` notes with URL-specific frontmatter and an AI-generated summary body.

Example:

```md
---
type: "page"
source: "https://example.com/article"
link_title: "Example article title"
summary_updated_at: "2026-03-23T17:10:00.000Z"
follow_up_questions:
  - "What are the main risks?"
  - "How does this compare to our current approach?"
  - "What should I read next on this topic?"
---

This article argues that...
```

Notes:

- `source` stores the canonical normalized URL
- `link_title`, `summary_updated_at`, and `follow_up_questions` are app-generated and optional
- the body remains editable markdown; it is not a hidden structured payload
- these pages are created when Philo converts a stale bare URL into a page chip

### 4. Typed GitHub Pages

Typed GitHub pages are still normal `page` notes, but they add `link_kind` and `link_data` so Philo can render a structured header for known GitHub resources.

Example:

```md
---
type: "page"
source: "https://github.com/vercel/ai/pull/13784"
link_title: "Version Packages (beta)"
summary_updated_at: "2026-03-24T04:30:00.000Z"
follow_up_questions:
  - "What changed in this PR beyond the release metadata?"
  - "Which packages are most likely to affect our integration?"
  - "What should I review before merging a similar release PR?"
link_kind: "github_pr"
link_data:
  owner: "vercel"
  repo: "ai"
  number: 13784
  title: "Version Packages (beta)"
  state: "Open"
  is_draft: false
  is_merged: false
  author: "vercel-ai-sdk[bot]"
  base_branch: "main"
  head_branch: "changeset-release/main"
  labels: []
  assignees: []
  reviewers:
    - "some-reviewer"
  changed_files_count: 10
  commits_count: 1
  additions: 42
  deletions: 12
  changed_files:
    - ".changeset/pre.json"
    - "packages/core/package.json"
---

This pull request updates prerelease package versions and release metadata...
```

Notes:

- `link_kind` identifies the specialized renderer; current app-generated values are `generic`, `github_pr`, `github_issue`, and `github_commit`
- `link_data` is structured app-generated metadata for the recognized source and is optional on disk
- the markdown body is still the canonical editable summary content
- existing generic URL summary pages remain valid even if they do not have `link_kind`

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

## Widget Files

Widget instances are stored as individual markdown files under the resolved widgets directory.

Current location:

- vault mode: `<vaultDir>/widgets/`
- default mode: `<journalDir>/widgets/`

Each widget becomes a `.widget.md` file that stores the current widget metadata, the active runtime payload, optional generated storage schema, and revision history.

If the widget has generated persistent storage, it also gets a sidecar SQLite database next to the widget file:

```text
<slug>-<widget-id>.widget.sqlite3
```

The markdown file remains the canonical source of truth for widget identity, prompt, runtime payload, and storage metadata. The SQLite sidecar stores the widget instance's queryable/mutable data rows. Daily notes do not inline the full widget payload. They store widget embeds that point back to the widget file.

For the full file schema and update lifecycle, see [Widget persistence and lifecycle](widget-persistence-and-lifecycle.md).

## Widget Git History

When `widgetGitHistoryEnabled` is on, Philo also stores widget Git history under the app data directory.

Current location:

```text
<baseDir>/widget-history/<widgets-root-hash>/
```

Behavior:

- each resolved `widgets/` directory gets its own app-managed Git repo
- the repo stores normalized widget markdown snapshots, not the raw live `.widget.md` files
- the repo never stores `.widget.sqlite3` sidecars
- switching vaults or journal roots creates a different history repo lazily; Philo does not migrate history between roots

The Git mirror is an app-owned developer-history layer. The live widget file under `widgets/` remains the canonical source of truth.

## Widget Library

The widget library is a merged view of archived widget files plus shared component manifests under the resolved library directory.

Current location:

- vault mode: `<vaultDir>/library/`
- default mode: `<journalDir>/library/`

For the current code-widget path:

- the canonical archived widget still lives under `widgets/` as a normal `.widget.md` file with `saved`, `libraryItemId`, and optional `componentId`
- the resolved library directory stores shared component manifests and any shared-component runtime assets
- the library drawer is built from saved widget files first, with shared component metadata layered on top

When a library item already knows its canonical widget file, inserting it from the library reuses that existing `.widget.md` file and its sibling SQLite storage. Repeated inserts therefore share the archived widget's file-backed state. Legacy entries without canonical widget file metadata still fall back to creating a new widget file.

There is also legacy support for:

```text
<baseDir>/library.json
```

If that legacy file exists and the new library directory is empty, Philo migrates the entries into `.component.md` files.

For the full widget lifecycle, including `.widget.md` files, editor placeholders, save/update procedures, and revision tracking, see [Widget persistence and lifecycle](widget-persistence-and-lifecycle.md).

## AI Chat History

AI chat history is stored as individual JSON files under the resolved chats directory.

Current location:

- vault mode: `<vaultDir>/chats/`
- default mode: `<journalDir>/chats/`

Each saved chat becomes:

```text
<id>.json
```

These files back the recent chat history shown in the app. They are separate from widget files and separate from the widget library.

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
- changing `vaultDir` does not migrate existing widget files, library items, or chat-history files into the new root

The settings UI already warns about the filename and folder cases. The code applies the new paths immediately, but it treats migration as a manual task.

## Practical Summary

If you want to know where something is stored:

- app settings and API key: `<baseDir>/settings.json`
- Google OAuth access and refresh tokens: OS credential store (Keychain on macOS, equivalent secure store on other platforms)
- daily notes: resolved `journalDir` plus `filenamePattern`
- pasted images: resolved assets folder
- widget files: `widgets/` under the vault root, or under the resolved journal root in default mode
- widget library: `library/` under the vault root or resolved journal root
- AI chat history: `chats/` under the vault root or resolved journal root
- Excalidraw content: wherever the configured Excalidraw path points, or the vault/journal fallback locations

The clean mental model is:

- `settings.json` tells Philo where to read and write content
- Google OAuth tokens are stored separately in the OS credential store
- the actual user data stays as normal files on disk
