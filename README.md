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

- `⌘↵` build a widget from the current selection
- `⌘K` open note chat
- `⌘F` search notes
- `⌘J` open the widget library
- `⌘,` open settings

## Links

- Website: [philo.johnjeong.com](https://philo.johnjeong.com)
- Releases: [GitHub releases](https://github.com/ComputelessComputer/philo/releases)

## Stack

Tauri v2, React 19, TypeScript, TipTap, Tailwind CSS v4, and Rust.

## Internal docs

- [Data storage and configuration](docs/data-storage-and-configuration.md)
- [Markdown sync and editor rendering](docs/markdown-sync.md)
- [File and folder organization](docs/repo-structure.md)

## License

Philo is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
