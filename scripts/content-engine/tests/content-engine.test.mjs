import assert from "node:assert/strict";
import { promises as fs, } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildOpportunity,
  discoverContentFacts,
  draftContentPages,
  extractFactsFromSource,
  getTopicCatalog,
  hasMaterialChange,
  prioritizeContent,
  refreshGeneratedContent,
  renderOpportunityPage,
} from "../lib.mjs";

const SNAPSHOT_DIR = path.join(
  path.dirname(new URL(import.meta.url,).pathname,),
  "__snapshots__",
);

test("extractFactsFromSource normalizes markdown into tagged facts", () => {
  const facts = extractFactsFromSource({
    sourcePath: "README.md",
    sourceType: "readme",
    verifiedAt: "2026-03-24",
    text: `
# Heading

- Philo stores notes as plain markdown on disk and works with existing Obsidian vaults.
- Unfinished tasks roll into today automatically when the date changes.
- Recurring work comes back on schedule without rebuilding the plan from scratch.
`,
  },);

  assert.equal(facts.length, 3,);
  assert.deepEqual(facts[0].tags, ["markdown", "obsidian",],);
  assert.ok(facts[1].tags.includes("task-rollover",),);
  assert.ok(facts[2].tags.includes("recurring",),);
});

test("buildOpportunity rejects topics without enough evidence", () => {
  const topic = getTopicCatalog().find((item,) => item.id === "guide-task-rollover");
  const weakFacts = [
    createFact("rollover keeps unfinished work alive between days", ["task-rollover",],),
    createFact("daily notes are the planning surface in Philo", ["daily-notes",],),
  ];

  assert.equal(buildOpportunity(topic, weakFacts,), null,);
});

test("template renders stay stable", async (t,) => {
  const cases = [
    ["guide-task-rollover", "guide.mdx", [
      createFact("Philo rolls unfinished tasks into today automatically when the date changes.", [
        "task-rollover",
        "daily-notes",
      ],),
      createFact("Philo keeps tomorrow, today, and past notes close together in one timeline.", [
        "daily-notes",
        "timeline",
      ],),
      createFact("Recurring tasks can return on schedule so the planning surface rebuilds itself.", [
        "recurring",
        "daily-notes",
      ],),
      createFact("Notes stay as plain markdown files on disk.", ["markdown",],),
    ],],
    ["use-case-daily-planning", "use-case.mdx", [
      createFact("Philo is built for the gap between capture and execution.", ["daily-notes",],),
      createFact("Daily notes should help you run what you thought, not just remember it.", ["daily-notes",],),
      createFact("Unfinished tasks should carry forward until they are done.", ["task-rollover", "daily-notes",],),
      createFact("Recurring work should reappear automatically.", ["recurring", "daily-notes",],),
    ],],
    ["comparison-static-notes", "comparison.mdx", [
      createFact("Philo stores notes as plain markdown on disk.", ["markdown",],),
      createFact("Philo keeps older notes in one continuous timeline.", ["timeline", "daily-notes",],),
      createFact("Philo rolls unfinished tasks into today automatically.", ["task-rollover", "daily-notes",],),
      createFact("Philo brings recurring tasks back on schedule.", ["recurring", "daily-notes",],),
    ],],
    ["glossary-task-rollover", "glossary.mdx", [
      createFact("Task rollover means unfinished work carries into today automatically.", ["task-rollover",],),
      createFact("Philo keeps daily notes close together so in-flight work stays visible.", [
        "daily-notes",
        "timeline",
      ],),
      createFact("Rollover is different from recurrence because it preserves unfinished work.", [
        "task-rollover",
        "recurring",
      ],),
    ],],
    ["release-latest-roundup", "release.mdx", [
      createFact("Philo 0.0.10 tightens the execution loop around markdown notes.", ["release", "markdown",],),
      createFact("The release keeps daily planning, note chat, and search inside the app.", [
        "release",
        "chat",
        "search",
      ],),
      createFact("Philo still stores notes as markdown on disk and can work beside an existing vault.", [
        "release",
        "markdown",
        "obsidian",
      ],),
      createFact("Recent work keeps widgets, recurrence, and execution closer to the daily note.", [
        "release",
        "widgets",
        "recurring",
        "daily-notes",
      ],),
    ], { releases: [{ version: "0.0.10", score: 10, slug: "latest-philo-release-roundup", },], },],
  ];

  for (const [topicId, snapshotName, facts, extra = {},] of cases) {
    await t.test(snapshotName, async () => {
      const topic = getTopicCatalog().find((item,) => item.id === topicId);
      const opportunity = buildOpportunity(
        topic,
        facts,
        extra.demandSignals ?? [],
        [],
        extra.releases ?? [],
      );

      assert.ok(opportunity,);
      const rendered = renderOpportunityPage(
        opportunity,
        new Map(facts.map((fact,) => [fact.id, fact,]),),
        { now: new Date("2026-03-24T00:00:00.000Z",), },
      );
      const snapshot = await fs.readFile(path.join(SNAPSHOT_DIR, snapshotName,), "utf8",);
      assert.equal(rendered, snapshot,);
    },);
  }
});

test("hasMaterialChange ignores updatedAt-only churn", () => {
  const current = [
    "---",
    'title: "Test"',
    "updatedAt: 2026-03-20",
    "---",
    "",
    "Body",
    "",
  ].join("\n",);
  const sameBody = [
    "---",
    'title: "Test"',
    "updatedAt: 2026-03-24",
    "---",
    "",
    "Body",
    "",
  ].join("\n",);
  const changedBody = [
    "---",
    'title: "Test"',
    "updatedAt: 2026-03-24",
    "---",
    "",
    "Changed",
    "",
  ].join("\n",);

  assert.equal(hasMaterialChange(current, sameBody,), false,);
  assert.equal(hasMaterialChange(current, changedBody,), true,);
});

test("draftContentPages caps generated drafts and writes an audit queue", async () => {
  const root = await createFixtureRepo();
  const now = new Date("2026-03-24T00:00:00.000Z",);

  await writeEngineConfig(root, {
    maxGeneratedDrafts: 2,
    auditQueueSize: 2,
  },);

  await discoverContentFacts({ root, now, },);
  await prioritizeContent({ root, now, },);
  const report = await draftContentPages({ root, now, },);
  const auditQueue = JSON.parse(
    await fs.readFile(path.join(root, "apps/landing/content-engine/state/audit-queue.json",), "utf8",),
  );

  assert.equal(report.created.length, 2,);
  assert.ok(report.skipped.some((item,) => item.reason === "batch-limit"),);
  assert.equal(auditQueue.items.length, 2,);
  assert.deepEqual(auditQueue.items[0].audit, {
    skill: "audit",
    platform: "blog",
    tone: "technical",
    lowercaseMode: false,
  },);
});

test("draftContentPages prunes tracked generated drafts down to the configured limit", async () => {
  const root = await createFixtureRepo();
  const now = new Date("2026-03-24T00:00:00.000Z",);

  await writeEngineConfig(root, {
    maxGeneratedDrafts: 4,
    auditQueueSize: 2,
  },);

  await discoverContentFacts({ root, now, },);
  await prioritizeContent({ root, now, },);
  await draftContentPages({ root, now, },);

  await writeEngineConfig(root, {
    maxGeneratedDrafts: 2,
    auditQueueSize: 2,
  },);

  const report = await draftContentPages({ root, now, },);
  const generatedDrafts = await listGeneratedDraftPages(root,);

  assert.equal(report.pruned.length, 2,);
  assert.equal(generatedDrafts.length, 2,);
});

test("refresh updates generated pages without touching manual pages", async () => {
  const root = await createFixtureRepo();
  const now = new Date("2026-03-24T00:00:00.000Z",);
  const releaseFile = path.join(root, "apps/landing/content-engine/inputs/releases.json",);
  const manualGuide = path.join(root, "apps/landing/src/content/guides/task-rollover-in-daily-notes.mdx",);

  await writeEngineConfig(root, {
    maxGeneratedDrafts: 10,
    auditQueueSize: 3,
  },);

  await discoverContentFacts({ root, now, },);
  await prioritizeContent({ root, now, },);
  await draftContentPages({ root, now, },);

  const releasePage = path.join(root, "apps/landing/src/content/guides/latest-philo-release-roundup.mdx",);
  const beforeRelease = await fs.readFile(releasePage, "utf8",);
  const beforeManual = await fs.readFile(manualGuide, "utf8",);

  await fs.writeFile(
    releaseFile,
    `${
      JSON.stringify(
        [{
          version: "0.0.11",
          publishedAt: "2026-03-24",
          summary: "Philo 0.0.11 adds a tighter release narrative for the landing site.",
          highlights: [
            "The new release keeps generated content tied to first-party facts only.",
            "Release-driven pages refresh when the main content changes materially.",
            "Generated pages stay draft-owned until a human review changes their status.",
          ],
        },],
        null,
        2,
      )
    }\n`,
    "utf8",
  );

  await discoverContentFacts({ root, now: new Date("2026-03-25T00:00:00.000Z",), },);
  await prioritizeContent({ root, now: new Date("2026-03-25T00:00:00.000Z",), },);
  const report = await refreshGeneratedContent({ root, now: new Date("2026-03-25T00:00:00.000Z",), },);

  const afterRelease = await fs.readFile(releasePage, "utf8",);
  const afterManual = await fs.readFile(manualGuide, "utf8",);

  assert.ok(report.updated.some((item,) => item.filePath.endsWith("latest-philo-release-roundup.mdx",)),);
  assert.ok(afterRelease.includes("Philo 0.0.11 adds a tighter release narrative for the landing site.",),);
  assert.notEqual(afterRelease, beforeRelease,);
  assert.equal(afterManual, beforeManual,);
});

function createFact(statement, tags,) {
  return {
    id: `fact-${Math.abs(hashCode(statement,),)}`,
    statement,
    sourcePath: "README.md",
    sourceType: "readme",
    verifiedAt: "2026-03-24",
    tags,
  };
}

function hashCode(value,) {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0,);
    hash |= 0;
  }

  return hash;
}

async function writeEngineConfig(root, config,) {
  await fs.writeFile(
    path.join(root, "apps/landing/content-engine/inputs/engine-config.json",),
    `${JSON.stringify(config, null, 2,)}\n`,
    "utf8",
  );
}

async function listGeneratedDraftPages(root,) {
  const contentRoot = path.join(root, "apps/landing/src/content",);
  const files = await collectFiles(contentRoot, ".mdx",);
  const drafts = [];

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8",);
    if (!raw.includes("ownership: generated",) || !raw.includes("status: draft",)) {
      continue;
    }

    drafts.push(filePath,);
  }

  return drafts;
}

async function collectFiles(root, extension,) {
  const entries = await fs.readdir(root, { withFileTypes: true, },);
  const files = [];

  for (const entry of entries) {
    const nextPath = path.join(root, entry.name,);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(nextPath, extension,)),);
      continue;
    }

    if (nextPath.endsWith(extension,)) {
      files.push(nextPath,);
    }
  }

  return files;
}

async function createFixtureRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "philo-content-engine-",),);
  const paths = [
    "docs",
    "apps/landing/public",
    "apps/landing/src/content/blog",
    "apps/landing/src/content/guides",
    "apps/landing/src/content/use-cases",
    "apps/landing/src/content/comparisons",
    "apps/landing/src/content/glossary",
    "apps/landing/content-engine/inputs",
    "apps/landing/content-engine/state",
  ];

  for (const relativePath of paths) {
    await fs.mkdir(path.join(root, relativePath,), { recursive: true, },);
  }

  await fs.writeFile(
    path.join(root, "README.md",),
    `
Philo is the IDE for your daily notes.
Philo keeps tomorrow, today, and past notes close together in one continuous timeline.
Unchecked tasks roll forward automatically when the date changes.
Recurring tasks return on schedule with tags like #daily and #weekly.
Philo stores notes as plain markdown on disk and can work beside an existing Obsidian vault.
Philo generates disposable widgets inline and lets useful widgets move into a small reusable library.
Philo includes optional note chat and search inside the app.
`,
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "docs/markdown-sync.md",),
    `
The markdown file on disk is the source of truth for note bodies.
Philo treats markdown storage as durable and portable.
`,
    "utf8",
  );

  await fs.writeFile(path.join(root, "apps/landing/public/philo-hero-screenshot.svg",), "<svg></svg>\n", "utf8",);
  await fs.writeFile(path.join(root, "apps/landing/public/philo-demo.mp4",), "demo\n", "utf8",);

  await fs.writeFile(
    path.join(root, "apps/landing/src/content/blog/manual-source.mdx",),
    `---
title: "Manual source"
summary: "Manual source"
publishedAt: 2026-03-01
updatedAt: 2026-03-01
pageType: blog
canonicalPath: /blog/manual-source
primaryQuery: "manual source"
evidenceIds: []
status: published
ownership: manual
bestFor: []
notFor: []
faqs: []
relatedLinks: []
image: /philo-hero-screenshot.svg
---

Philo is meant to sit beside your vault, not replace it.
`,
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "apps/landing/src/content/guides/task-rollover-in-daily-notes.mdx",),
    `---
title: "Manual task rollover guide"
summary: "Keep this untouched."
publishedAt: 2026-03-01
updatedAt: 2026-03-01
pageType: guide
canonicalPath: /guides/task-rollover-in-daily-notes
primaryQuery: "task rollover in daily notes manual"
evidenceIds: []
status: published
ownership: manual
bestFor: []
notFor: []
faqs: []
relatedLinks: []
image: /philo-hero-screenshot.svg
---

Do not rewrite this manual page.
`,
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "apps/landing/content-engine/inputs/demand-signals.json",),
    `${
      JSON.stringify(
        [
          { slug: "latest-philo-release-roundup", score: 12, source: "release", },
          { slug: "daily-planning-in-markdown-notes", score: 20, source: "search-console", },
        ],
        null,
        2,
      )
    }\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "apps/landing/content-engine/inputs/community-questions.json",),
    `${JSON.stringify([], null, 2,)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "apps/landing/content-engine/inputs/geo-prompts.json",),
    `${JSON.stringify([], null, 2,)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "apps/landing/content-engine/inputs/releases.json",),
    `${
      JSON.stringify(
        [{
          version: "0.0.10",
          publishedAt: "2026-03-24",
          summary: "Philo 0.0.10 keeps release pages grounded in first-party facts.",
          highlights: [
            "The release keeps daily planning close to the note.",
            "Generated content pages stay draft-owned until review.",
            "The product remains markdown-native and vault-friendly.",
          ],
        },],
        null,
        2,
      )
    }\n`,
    "utf8",
  );

  return root;
}
