---
alwaysApply: true
---

## Definition

- The app's name is Philo.

## Commit Discipline

- Commit after every discrete action. Each meaningful change (e.g. adding a feature, fixing a bug, refactoring, updating docs, adding a test) must be committed individually before moving on.
- Use concise, imperative commit messages (e.g. `add bucket column reordering`, `fix off-by-one in timeline view`).
- Do not batch unrelated changes into a single commit.
- If a task involves multiple steps, commit after each step — not all at the end.

## Releases

- When asked to create a release: bump the version in `apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/src-tauri/tauri.conf.json`, commit, push, then create the release with `gh release create`. The CI workflow (`.github/workflows/release.yml`) will automatically build and upload platform binaries (`.dmg`, `.exe`, etc.) to the release.
- Releases must be published immediately — do not use `--draft`.
- Include release notes with concise, descriptive bullet points explaining what changed (e.g. `- Add @ autocomplete dropdown for selecting tasks by ID or title`). Do not just list version numbers or raw commit messages.
- Each bullet should describe the user-facing change, not implementation details.

## Comments

- By default, avoid writing comments at all.
- If you write one, it should be about "Why", not "What".

## General

- Avoid creating unnecessary structs, enums, or traits if they are not shared. Prefer inlining types when they're only used in one place.
- Run `pnpm typecheck && pnpm fmt` before committing.
- Run `cargo clippy` and fix any warnings before committing Rust changes.
- Run `cargo check` periodically while making Rust changes to catch errors early — don't wait until the end.
- Run `cargo build` after Rust code changes to verify compilation before committing.
- Keep commits small and reviewable.

## TypeScript

- Avoid creating a bunch of types/interfaces if they are not shared. Especially for function props. Just inline them.
- After some amount of TypeScript changes, run `pnpm -r typecheck`.
