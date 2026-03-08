# Philo

<img width="727" height="776" alt="image" src="https://github.com/user-attachments/assets/5c8474ad-e8e1-4d1c-b965-abc4bc1a060e" />

A daily journaling app that builds things for you.

Write your notes in a timeline, manage tasks that carry forward automatically, and hit **⌘↵** to generate custom mini-apps — a calorie tracker, a world clock, a habit chart — embedded right inside your journal.

## Links

- Website: https://philo.johnjeong.com

## How it works

1. **Journal** — write daily notes in a scrollable timeline (tomorrow → today → past)
2. **Track tasks** — checkbox tasks roll over automatically; unchecked items carry forward to today on each app launch
3. **Recurring tasks** — add `@daily`, `@weekly`, `@monthly`, `@2days`, `@3weeks`, etc. to a task and it reappears on schedule after you check it off
4. **Generate widgets** — describe what you need and press ⌘↵ to create an interactive widget inline
5. **Save to library** — widgets are disposable by default. Save the ones you like (⌘J to browse) and reuse them anywhere.

## Features

- **Daily timeline** — tomorrow, today, and past notes in a single scrollable view with a floating "Go to Today" button
- **Task rollover** — unchecked tasks from past days automatically move to today
- **Recurring tasks** — tag tasks with recurrence intervals (`@daily`, `@weekly`, `@2weeks`, etc.) to have them repeat
- **AI widgets** — generate interactive React mini-apps inline via Claude
- **Widget library** — save and reuse generated widgets across notes (⌘J)
- **Image support** — paste or drag-and-drop images directly into notes
- **Local storage** — all data stored as markdown files on disk (`$APPDATA/philo/journal/`)
- **Dark mode** — follows system theme

## Use cases

- **Daily journaling** — capture thoughts, plan tomorrow, review the past
- **Habit tracking** — recurring tasks like `- [ ] Meditate @daily` reappear each day
- **Personal dashboards** — embed a calorie tracker, mood logger, or workout log directly in your journal
- **Quick tools** — need a unit converter or tip calculator? Generate it on the spot
- **Project planning** — spin up a kanban board, countdown timer, or progress tracker inside your notes

## Keyboard shortcuts

- **⌘↵** — Generate a widget from the current selection
- **⌘J** — Open the widget library
- **⌘,** — Open settings

## Inspiration

Inspired by [Logseq](https://logseq.com) and [@omer_vexler](https://x.com/omer_vexler/status/1939756227749347615).

## Stack

Tauri v2 · React 19 · TypeScript · TipTap · Tailwind CSS v4 · Anthropic Claude

## Release

Run `pnpm run release:check` after bumping the desktop version and before creating a GitHub release. It verifies formatting, frontend typechecks and build, and the Rust fmt/check/clippy/test/build steps that the desktop release depends on.

## Internal docs

- [Markdown sync and editor rendering](docs/markdown-sync.md)

## Relationship to Char (formerly Hyprnote)

Philo is a proof-of-concept playground for a daily journaling feature being developed for [Char](https://github.com/fastrepl/hyprnote). It borrows Char's editor styling and file-saving mechanism (via a git submodule at `vendor/hyprnote`) while adding philo-specific features: task rollover, recurring tasks, and AI widget generation.
