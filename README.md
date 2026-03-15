# Philo

![Philo app screenshot](docs/assets/philo-app-screenshot.png)

Philo is a local-first daily notes app for planning and execution.

It keeps your notes as markdown on disk, works with existing Obsidian vaults, carries unfinished work forward automatically, and lets you generate small tools inline when a note needs one.

## What Philo does

- Keeps tomorrow, today, and recent notes in one continuous daily planning surface
- Carries unfinished tasks forward so work does not disappear between days
- Lets you chat with your notes, search across them, and prepare AI-assisted edits with dry-run diffs
- Generates disposable or reusable widgets directly inside a note
- Preserves markdown portability with support for images, wiki links, and Excalidraw embeds
- Works with app-managed storage or an existing Obsidian vault

## Product highlights

### Local-first by default

Philo stores notes as plain markdown files on disk instead of locking them into a database. You can point it at your own journal folder or an Obsidian vault and keep your existing file layout.

### A calmer daily loop

The core workflow is simple: open today, see what carried over, write what matters, and keep moving. Philo keeps the planning surface short instead of sending you into a heavier project system.

### AI that works inside the note

Philo includes an in-app assistant named Sophia. It can answer questions against recent notes, cite what it used, and prepare note changes for review before anything is applied. Widget generation is also built in, so quick one-off tools can live right where the note needs them.

### Reusable when it earns it

Generated widgets start disposable. When one proves useful, save it to the library and reuse it later in other notes.

## Keyboard shortcuts

- `⌘⇧B` build a widget from the current selection
- `⌘J` open note chat
- `⌘F` search notes
- `⌘P` open the widget library
- `⌘,` open settings

## Links

- Website: [philo.johnjeong.com](https://philo.johnjeong.com)
- Releases: [GitHub releases](https://github.com/ComputelessComputer/philo/releases)

## Stack

Tauri v2, React 19, TypeScript, TipTap, Tailwind CSS v4, and Rust.

## Google Account Setup

Philo's `Settings -> Google Account` flow uses Philo's bundled desktop OAuth client. End users only need to click `Continue with Google` in settings and complete consent in their browser.

If you are maintaining Philo's Google Cloud project, make sure:

1. The Gmail API and Google Calendar API are enabled.
2. The OAuth consent screen is configured in `Google Auth platform`.
3. The bundled desktop OAuth client remains active on the project.
4. `PHILO_GOOGLE_OAUTH_CLIENT_SECRET` is available in local build envs and GitHub Actions secrets if that client requires a secret during token exchange.

For local desktop development, put `PHILO_GOOGLE_OAUTH_CLIENT_SECRET=...` in the repo root `.env` or export it in your shell before starting `pnpm dev`. The desktop Tauri launcher reads that value and passes it through to Rust for the Google token exchange.

Philo currently requests:

- `openid`, `email`, and `profile`
- `https://www.googleapis.com/auth/calendar.events.readonly`
- `https://www.googleapis.com/auth/gmail.readonly`

Google access and refresh tokens are stored in the OS credential store, not in Philo's plain JSON settings file.

If your OAuth consent screen is still in testing and your audience is external, add your Google account as a test user before signing in. Gmail read-only is a restricted scope, so a public rollout may require Google verification.

## Internal docs

- [Data storage and configuration](docs/data-storage-and-configuration.md)
- [Markdown sync and editor rendering](docs/markdown-sync.md)
- [File and folder organization](docs/repo-structure.md)

## License

Philo is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
