# Philo Content Engine

This directory holds the inputs and generated state for Philo's repo-backed landing content engine.

## Goals

- Choose topics from demand, not guesswork.
- Make claims only from first-party repo facts.
- Generate draft pages that require review before they become published.

## Inputs

- `inputs/demand-signals.json`
  - Manually curated demand or Search Console style scoring by slug.
- `inputs/community-questions.json`
  - Approved questions worth turning into content.
- `inputs/releases.json`
  - First-party release summaries and highlights.
- `inputs/geo-prompts.json`
  - A fixed weekly prompt suite for directional GEO checks.

## State

- `state/facts.json`
  - Extracted repo-backed facts.
- `state/opportunities.json`
  - Scored topic opportunities and selected evidence.
- `state/draft-report.json`
  - Pages created by the last draft run.
- `state/refresh-report.json`
  - Pages updated or skipped by the last refresh run.

The JSON files in `state/` are intentionally ignored in git. They are generated execution artifacts, not hand-maintained source files.

## Commands

- `pnpm run content-engine:discover`
- `pnpm run content-engine:prioritize`
- `pnpm run content-engine:draft`
- `pnpm run content-engine:refresh`
- `pnpm run content-engine:sync`
- `pnpm run content-engine:test`

## Publishing model

- Generated pages are written with `status: draft` and `ownership: generated`.
- The public Astro routes only include `published` entries.
- Manual pages keep `ownership: manual` and are never rewritten by `refresh`.
