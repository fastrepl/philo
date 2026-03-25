import crypto from "node:crypto";
import { promises as fs, } from "node:fs";
import path from "node:path";
import { fileURLToPath, } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url,),);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..",);

const SOURCE_TYPE_PRIORITY = {
  readme: 5,
  docs: 4,
  "landing-mdx": 3,
  release: 3,
  asset: 1,
};

const DEFAULT_ENGINE_CONFIG = {
  maxGeneratedDrafts: 4,
  auditQueueSize: 4,
  auditDefaults: {
    platform: "blog",
    tone: "technical",
    lowercaseMode: false,
  },
};

const TAG_RULES = [
  { tag: "daily-notes", patterns: [/\bdaily notes?\b/i, /\bjournal(?:ing)?\b/i, /\bdaily planning\b/i,], },
  { tag: "timeline", patterns: [/\btimeline\b/i, /\bcontinuous feed\b/i, /\bpast notes\b/i,], },
  {
    tag: "task-rollover",
    patterns: [
      /\broll(?:s|ed)? (?:unfinished )?tasks?\b/i,
      /\bcarry forward\b/i,
      /\broll forward\b/i,
      /\binto today\b/i,
    ],
  },
  {
    tag: "recurring",
    patterns: [/\brecurring\b/i, /\b#daily\b/i, /\b#weekly\b/i, /\b#3days\b/i, /\bon schedule\b/i,],
  },
  { tag: "markdown", patterns: [/\bmarkdown\b/i, /\bplain text\b/i, /\bon disk\b/i,], },
  { tag: "obsidian", patterns: [/\bobsidian\b/i, /\blogseq\b/i, /\bvault\b/i,], },
  { tag: "widgets", patterns: [/\bwidgets?\b/i, /\bcalculator\b/i, /\btracker\b/i, /\btool\b/i,], },
  { tag: "library", patterns: [/\blibrary\b/i, /\breusable\b/i, /\barchive(?:d)?\b/i,], },
  { tag: "chat", patterns: [/\bnote chat\b/i, /\bchat\b/i,], },
  { tag: "search", patterns: [/\bsearch\b/i,], },
  { tag: "open-source", patterns: [/\bopen source\b/i, /\bfree forever\b/i, /\bgpl\b/i,], },
  { tag: "google", patterns: [/\bgoogle\b/i, /\bgmail\b/i, /\bcalendar\b/i,], },
  { tag: "release", patterns: [/\brelease\b/i, /\bversion\b/i, /\bnightly\b/i, /\bwhat changed\b/i,], },
];

const TOPIC_CATALOG = [
  {
    id: "guide-daily-note-timeline",
    slug: "daily-note-timeline",
    section: "guides",
    pageType: "guide",
    template: "how-to",
    title: "Daily note timeline in Philo",
    summary: "How Philo keeps past, current, and next notes in one planning surface.",
    audience: "people who plan from daily notes",
    primaryQuery: "daily note timeline",
    intent: "informational",
    requiredTags: ["daily-notes", "timeline",],
    optionalTags: ["task-rollover", "markdown",],
    bestFor: [
      "People who want older note context visible while planning today",
      "Markdown users who dislike hopping between separate daily files",
    ],
    notFor: [
      "People who want each day fully isolated from prior work",
      "Workflows that never use daily notes as the planning surface",
    ],
    faqs: [
      {
        question: "Does Philo replace the daily note file model?",
        answer:
          "No. Philo keeps daily notes as markdown files on disk while changing how they are surfaced in the app.",
      },
      {
        question: "Why does a timeline matter?",
        answer:
          "It reduces the morning reconstruction work of finding what was already in flight before you start planning.",
      },
    ],
    relatedLinks: [
      { label: "Task rollover in daily notes", href: "/guides/task-rollover-in-daily-notes", },
      { label: "Glossary: daily note timeline", href: "/glossary/daily-note-timeline", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "guide-task-rollover",
    slug: "task-rollover-in-daily-notes",
    section: "guides",
    pageType: "guide",
    template: "how-to",
    title: "Task rollover in daily notes",
    summary: "What task rollover means in Philo and why it keeps daily planning lighter.",
    audience: "people who lose unfinished work between days",
    primaryQuery: "task rollover in daily notes",
    intent: "informational",
    requiredTags: ["task-rollover", "daily-notes",],
    optionalTags: ["timeline", "recurring",],
    bestFor: [
      "Anyone who wants unfinished tasks to reappear automatically",
      "Daily note users who want less manual carry-forward work",
    ],
    notFor: [
      "People who intentionally rebuild their task list from scratch every day",
      "Workflows that already enforce carry-forward elsewhere",
    ],
    faqs: [
      {
        question: "Is rollover the same as recurrence?",
        answer: "No. Rollover keeps unfinished work alive, while recurrence recreates scheduled work on a cadence.",
      },
      {
        question: "Why is rollover useful in markdown notes?",
        answer: "It removes the manual copy-paste step that usually breaks momentum in plain daily note systems.",
      },
    ],
    relatedLinks: [
      { label: "Recurring task tags", href: "/guides/recurring-task-tags", },
      { label: "Glossary: task rollover", href: "/glossary/task-rollover", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "guide-recurring-tags",
    slug: "recurring-task-tags",
    section: "guides",
    pageType: "guide",
    template: "how-to",
    title: "Recurring task tags in Philo",
    summary: "How inline recurrence tags make recurring work obvious and editable in plain text.",
    audience: "people who run routines from daily notes",
    primaryQuery: "recurring task tags",
    intent: "informational",
    requiredTags: ["recurring", "daily-notes",],
    optionalTags: ["markdown", "task-rollover",],
    bestFor: [
      "People who want daily or weekly routines to manage themselves",
      "Markdown users who want recurrence logic next to the task text",
    ],
    notFor: [
      "People who need a complex calendar-first recurrence system",
      "Teams trying to model company-wide scheduling rules",
    ],
    faqs: [
      {
        question: "What tags does Philo use?",
        answer:
          "Philo uses inline recurrence tags such as #daily, #weekly, and #3days so the task carries its own recurrence rules.",
      },
      {
        question: "Why use tags instead of a separate form?",
        answer: "Tags keep the rule visible in the markdown itself, which makes the behavior easier to trust and edit.",
      },
    ],
    relatedLinks: [
      { label: "From recurring tasks to recurring systems", href: "/blog/from-recurring-tasks-to-recurring-systems", },
      { label: "Glossary: recurring tags", href: "/glossary/recurring-tags", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "guide-markdown-on-disk",
    slug: "markdown-notes-on-disk",
    section: "guides",
    pageType: "guide",
    template: "how-to",
    title: "Markdown notes on disk with Philo",
    summary: "How Philo keeps markdown as the source of truth while adding planning behavior on top.",
    audience: "people who care about portable notes",
    primaryQuery: "markdown notes on disk",
    intent: "informational",
    requiredTags: ["markdown",],
    optionalTags: ["daily-notes", "obsidian",],
    bestFor: [
      "People who want their notes to stay as local markdown files",
      "Users who want planning features without moving into a hosted silo",
    ],
    notFor: [
      "People who prefer a cloud-only note database",
      "Teams that need a centralized workspace instead of local files",
    ],
    faqs: [
      {
        question: "What is the source of truth for notes in Philo?",
        answer:
          "The markdown file on disk remains the source of truth for note bodies; Philo edits TipTap JSON in memory and saves back to markdown.",
      },
      {
        question: "Does Philo lock you into a proprietary format?",
        answer: "No. Philo is designed to sit beside your vault and keep notes as markdown files you control.",
      },
    ],
    relatedLinks: [
      { label: "Markdown, not lock-in", href: "/blog/why-we-built-a-journal-that-can-execute-ideas", },
      { label: "Use Philo beside an Obsidian vault", href: "/use-cases/use-philo-beside-an-obsidian-vault", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "guide-obsidian-vaults",
    slug: "using-philo-with-an-obsidian-vault",
    section: "guides",
    pageType: "guide",
    template: "how-to",
    title: "Using Philo with an Obsidian vault",
    summary: "How Philo works beside an existing vault instead of forcing a content migration.",
    audience: "Obsidian users exploring a better daily planning loop",
    primaryQuery: "using philo with an obsidian vault",
    intent: "informational",
    requiredTags: ["obsidian", "markdown",],
    optionalTags: ["daily-notes", "widgets",],
    bestFor: [
      "Obsidian users who want execution-oriented daily planning without moving files",
      "People who already have a vault and want Philo to augment it",
    ],
    notFor: [
      "People who want Philo to become their only note app immediately",
      "Workflows that do not rely on markdown vaults",
    ],
    faqs: [
      {
        question: "Can Philo work with an existing vault?",
        answer:
          "Yes. Philo stores notes as markdown on disk and is meant to sit beside an existing Obsidian vault rather than replace it.",
      },
      {
        question: "Why would an Obsidian user add Philo?",
        answer:
          "Philo focuses on the gap between capture and execution, especially around task rollover, recurrence, and inline widgets.",
      },
    ],
    relatedLinks: [
      { label: "Markdown notes on disk", href: "/guides/markdown-notes-on-disk", },
      { label: "Use Philo beside an Obsidian vault", href: "/use-cases/use-philo-beside-an-obsidian-vault", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "guide-disposable-widgets",
    slug: "disposable-widgets-in-notes",
    section: "guides",
    pageType: "guide",
    template: "how-to",
    title: "Disposable widgets in notes",
    summary: "How Philo treats one-off tools as cheap, inline widgets instead of heavyweight software projects.",
    audience: "people who need temporary tools while planning",
    primaryQuery: "disposable widgets in notes",
    intent: "informational",
    requiredTags: ["widgets",],
    optionalTags: ["library", "daily-notes",],
    bestFor: [
      "People who want calculators, trackers, or small tools inline in a note",
      "Anyone who wants creation to be cheap and deletion to be safe",
    ],
    notFor: [
      "People who only need static text and checklists",
      "Teams looking for a permanent low-code platform",
    ],
    faqs: [
      {
        question: "Why make widgets disposable by default?",
        answer:
          "Because many note-adjacent tools are only useful for a day or a week and should not carry a permanent setup tax.",
      },
      {
        question: "Can useful widgets be saved?",
        answer: "Yes. Widgets that earn their place can be saved into a small reusable library.",
      },
    ],
    relatedLinks: [
      { label: "The case for disposable widgets", href: "/blog/the-case-for-disposable-widgets", },
      { label: "Glossary: disposable widgets", href: "/glossary/disposable-widgets", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "guide-note-chat",
    slug: "note-chat-in-philo",
    section: "guides",
    pageType: "guide",
    template: "how-to",
    title: "Note chat in Philo",
    summary: "Where note chat fits in Philo's markdown-native daily note workflow.",
    audience: "people who want AI help inside the note instead of another app",
    primaryQuery: "note chat in philo",
    intent: "informational",
    requiredTags: ["chat",],
    optionalTags: ["daily-notes", "markdown", "search",],
    bestFor: [
      "People who want AI assistance inside the same note they are planning from",
      "Users who want dry-run edits and note-aware help without context switching",
    ],
    notFor: [
      "People who never use AI in their note workflow",
      "Teams that need a separate collaborative assistant product",
    ],
    faqs: [
      {
        question: "What does note chat do in Philo?",
        answer: "Philo includes optional AI features for note chat, search, and dry-run edits inside the app.",
      },
      {
        question: "Why keep chat inside the note?",
        answer:
          "It keeps context attached to the planning surface instead of forcing another handoff to a separate tool.",
      },
    ],
    relatedLinks: [
      { label: "Note search in Philo", href: "/guides/note-search-in-philo", },
      { label: "One place to write, decide, and run", href: "/use-cases/write-decide-and-run-in-one-place", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "guide-note-search",
    slug: "note-search-in-philo",
    section: "guides",
    pageType: "guide",
    template: "how-to",
    title: "Note search in Philo",
    summary: "How Philo keeps note search close to the daily planning loop.",
    audience: "people who want note search in the same app they plan from",
    primaryQuery: "note search in philo",
    intent: "informational",
    requiredTags: ["search",],
    optionalTags: ["daily-notes", "chat",],
    bestFor: [
      "People who want search without leaving their note workflow",
      "Users who need to recover context quickly while planning",
    ],
    notFor: [
      "People who already centralize search in another app",
      "Workflows that do not care about fast historical note recall",
    ],
    faqs: [
      {
        question: "Does Philo include search?",
        answer: "Yes. Search is one of the optional AI-adjacent features available inside the app.",
      },
      {
        question: "Why pair search with daily notes?",
        answer: "It shortens the loop between finding context and deciding what to do next.",
      },
    ],
    relatedLinks: [
      { label: "Note chat in Philo", href: "/guides/note-chat-in-philo", },
      { label: "A calmer daily planning loop", href: "/blog/a-calmer-daily-planning-loop", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "use-case-daily-planning",
    slug: "daily-planning-in-markdown-notes",
    section: "use-cases",
    pageType: "use-case",
    template: "use-case",
    title: "Daily planning in markdown notes",
    summary: "When Philo is a better fit than a plain daily note file for running the day.",
    audience: "people who already plan in markdown",
    primaryQuery: "daily planning in markdown notes",
    intent: "commercial",
    requiredTags: ["daily-notes", "markdown",],
    optionalTags: ["timeline", "task-rollover", "recurring",],
    bestFor: [
      "People who already use daily notes as their planning surface",
      "Markdown users who want execution features without changing file ownership",
    ],
    notFor: [
      "People who never plan from notes",
      "Teams that need a shared project tracker instead of a personal execution loop",
    ],
    faqs: [
      {
        question: "Why not just use a plain markdown file?",
        answer:
          "A plain file captures ideas well, but it usually makes you manually rebuild rollover, recurrence, and context every day.",
      },
      {
        question: "What changes with Philo?",
        answer: "Philo keeps the markdown file model while adding a calmer planning loop around it.",
      },
    ],
    relatedLinks: [
      { label: "Markdown notes on disk", href: "/guides/markdown-notes-on-disk", },
      { label: "Daily note timeline in Philo", href: "/guides/daily-note-timeline", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "use-case-recurring-systems",
    slug: "running-recurring-systems-from-daily-notes",
    section: "use-cases",
    pageType: "use-case",
    template: "use-case",
    title: "Running recurring systems from daily notes",
    summary: "Why Philo fits people whose routines should rebuild themselves automatically.",
    audience: "people with recurring obligations",
    primaryQuery: "recurring systems in daily notes",
    intent: "commercial",
    requiredTags: ["recurring", "daily-notes",],
    optionalTags: ["task-rollover", "markdown",],
    bestFor: [
      "People who run daily, weekly, or every-few-days routines from notes",
      "Users who want recurrence logic to stay visible in plain text",
    ],
    notFor: [
      "People who only track one-off tasks",
      "Calendar-heavy workflows that need complex scheduling rules",
    ],
    faqs: [
      {
        question: "What makes recurring work feel lighter in Philo?",
        answer:
          "Philo brings recurring tasks back on schedule so the planning surface rebuilds itself without manual setup every morning.",
      },
      {
        question: "Why call this a system instead of a reminder?",
        answer: "Because the value is in reducing repeat decisions, not just pinging you at a certain time.",
      },
    ],
    relatedLinks: [
      { label: "Recurring task tags in Philo", href: "/guides/recurring-task-tags", },
      { label: "From recurring tasks to recurring systems", href: "/blog/from-recurring-tasks-to-recurring-systems", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "use-case-obsidian",
    slug: "use-philo-beside-an-obsidian-vault",
    section: "use-cases",
    pageType: "use-case",
    template: "use-case",
    title: "Use Philo beside an Obsidian vault",
    summary: "When an existing vault is still the source of truth, but you want a tighter planning loop.",
    audience: "people already invested in Obsidian",
    primaryQuery: "use philo beside an obsidian vault",
    intent: "commercial",
    requiredTags: ["obsidian", "markdown",],
    optionalTags: ["daily-notes", "widgets",],
    bestFor: [
      "People who already store notes in an Obsidian vault",
      "Users who want execution features without abandoning markdown ownership",
    ],
    notFor: [
      "People looking for a cloud migration path",
      "Workflows that are not built around a vault",
    ],
    faqs: [
      {
        question: "Does Philo force an Obsidian user to migrate?",
        answer: "No. Philo is meant to sit beside your vault, not replace it.",
      },
      {
        question: "What does Philo add on top?",
        answer:
          "It focuses on keeping planning, unfinished work, recurrence, and lightweight tools closer to the note itself.",
      },
    ],
    relatedLinks: [
      { label: "Using Philo with an Obsidian vault", href: "/guides/using-philo-with-an-obsidian-vault", },
      { label: "Philo vs static markdown daily notes", href: "/comparisons/philo-vs-static-markdown-daily-notes", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "use-case-disposable-tools",
    slug: "quick-tools-inside-notes",
    section: "use-cases",
    pageType: "use-case",
    template: "use-case",
    title: "Quick tools inside notes",
    summary: "When inline widgets are better than opening or building a separate tool.",
    audience: "people solving temporary problems while planning",
    primaryQuery: "quick tools inside notes",
    intent: "commercial",
    requiredTags: ["widgets",],
    optionalTags: ["library", "daily-notes",],
    bestFor: [
      "People who need a one-off tracker, calculator, or checklist while planning",
      "Users who want a widget to live in the same note as the decision it supports",
    ],
    notFor: [
      "People who only want reusable permanent tools",
      "Teams that need a broad internal tooling platform",
    ],
    faqs: [
      {
        question: "What kinds of tools fit this model?",
        answer:
          "Temporary trackers, calculators, experiments, and small planning utilities fit the disposable widget model well.",
      },
      {
        question: "What happens when a quick tool becomes useful long term?",
        answer:
          "Philo lets you save the winners into a small reusable library instead of committing every experiment up front.",
      },
    ],
    relatedLinks: [
      { label: "Disposable widgets in notes", href: "/guides/disposable-widgets-in-notes", },
      { label: "Glossary: widget library", href: "/glossary/widget-library", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "use-case-execution-loop",
    slug: "write-decide-and-run-in-one-place",
    section: "use-cases",
    pageType: "use-case",
    template: "use-case",
    title: "Write, decide, and run in one place",
    summary: "How Philo shortens the loop between note capture and actual execution.",
    audience: "people who lose momentum between writing and doing",
    primaryQuery: "write decide and run in one place",
    intent: "commercial",
    requiredTags: ["daily-notes",],
    optionalTags: ["widgets", "chat", "search", "task-rollover",],
    bestFor: [
      "People who think in fragments, checklists, and half-built plans",
      "Users who want fewer handoffs between capture, planning, and execution",
    ],
    notFor: [
      "People who prefer a strict ticket-first workflow for everything",
      "Teams that need deeply structured multi-user workflow software",
    ],
    faqs: [
      {
        question: "What is Philo optimizing for?",
        answer:
          "Philo is optimizing for a shorter loop: write, decide, and run without rebuilding context somewhere else.",
      },
      {
        question: "Why does this matter?",
        answer: "Because momentum often dies at the handoff from raw note to another separate execution tool.",
      },
    ],
    relatedLinks: [
      {
        label: "Why we built a journal that can execute ideas",
        href: "/blog/why-we-built-a-journal-that-can-execute-ideas",
      },
      { label: "Note chat in Philo", href: "/guides/note-chat-in-philo", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "comparison-static-notes",
    slug: "philo-vs-static-markdown-daily-notes",
    section: "comparisons",
    pageType: "comparison",
    template: "comparison",
    title: "Philo vs static markdown daily notes",
    summary: "When a plain daily note file is enough and when Philo earns the extra layer.",
    audience: "people deciding whether plain markdown is enough",
    primaryQuery: "philo vs static markdown daily notes",
    intent: "commercial",
    requiredTags: ["markdown", "daily-notes",],
    optionalTags: ["timeline", "task-rollover", "recurring",],
    comparisonTarget: "Static markdown daily notes",
    comparisonRows: [
      {
        question: "You want planning context to persist across days",
        philo: "Built for it with timeline context and automatic carry-forward behavior.",
        alternative: "Possible, but usually requires manual reconstruction and copying.",
      },
      {
        question: "You want notes to stay as markdown on disk",
        philo: "Yes. Markdown remains the source of truth.",
        alternative: "Yes. This is the baseline strength.",
      },
      {
        question: "You want one-off tools inline in the note",
        philo: "Built for inline widgets and a reusable library.",
        alternative: "Usually requires separate tools or custom setup.",
      },
    ],
    bestFor: [
      "People who already like markdown but want a stronger execution loop",
      "Users who are tired of manually rebuilding context every morning",
    ],
    notFor: [
      "People who only need text capture and nothing else",
      "Workflows where manual carry-forward is not a problem",
    ],
    faqs: [
      {
        question: "Why not stay with plain markdown files only?",
        answer:
          "You can, but plain files typically push rollover, recurrence, and tool building back onto the user every day.",
      },
      {
        question: "Does Philo stop being markdown-native?",
        answer: "No. The file on disk remains markdown; Philo changes the planning behavior around it.",
      },
    ],
    relatedLinks: [
      { label: "Markdown notes on disk", href: "/guides/markdown-notes-on-disk", },
      { label: "Daily planning in markdown notes", href: "/use-cases/daily-planning-in-markdown-notes", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "comparison-task-manager",
    slug: "philo-vs-a-separate-task-manager",
    section: "comparisons",
    pageType: "comparison",
    template: "comparison",
    title: "Philo vs a separate task manager",
    summary: "When the task list should live with the note and when it should stay separate.",
    audience: "people splitting work between notes and task apps",
    primaryQuery: "philo vs a separate task manager",
    intent: "commercial",
    requiredTags: ["task-rollover", "recurring", "daily-notes",],
    optionalTags: ["widgets", "markdown",],
    comparisonTarget: "A separate task manager",
    comparisonRows: [
      {
        question: "You want task context to stay attached to the note",
        philo: "Strong fit because planning happens in the note itself.",
        alternative: "Often requires jumping between capture and execution surfaces.",
      },
      {
        question: "You want recurring work to rebuild your note automatically",
        philo: "Built around bringing recurring tasks back on schedule inside daily notes.",
        alternative: "Possible, but usually outside the note and detached from writing context.",
      },
      {
        question: "You want a dedicated shared task system for a team",
        philo: "Less ideal. Philo is centered on a personal daily planning loop.",
        alternative: "Often the better fit.",
      },
    ],
    bestFor: [
      "People whose task list only makes sense next to the note that produced it",
      "Users who want fewer handoffs between note capture and execution",
    ],
    notFor: [
      "Teams that need a centralized task workflow",
      "People who prefer tasks fully detached from notes",
    ],
    faqs: [
      {
        question: "Is Philo trying to replace every task manager?",
        answer: "No. It is trying to make the daily note itself better at execution for people who already plan there.",
      },
      {
        question: "When is a separate task manager still the better fit?",
        answer: "When the center of gravity is a shared task system rather than a personal note-driven workflow.",
      },
    ],
    relatedLinks: [
      { label: "Task rollover in daily notes", href: "/guides/task-rollover-in-daily-notes", },
      {
        label: "Running recurring systems from daily notes",
        href: "/use-cases/running-recurring-systems-from-daily-notes",
      },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "comparison-heavy-project-tools",
    slug: "philo-vs-heavy-project-management-tools",
    section: "comparisons",
    pageType: "comparison",
    template: "comparison",
    title: "Philo vs heavy project management tools",
    summary: "Why Philo fits lightweight personal execution loops better than heavyweight structured systems.",
    audience: "people deciding between a planner and a large work-management tool",
    primaryQuery: "philo vs heavy project management tools",
    intent: "commercial",
    requiredTags: ["daily-notes", "widgets",],
    optionalTags: ["markdown", "task-rollover",],
    comparisonTarget: "Heavy project management tools",
    comparisonRows: [
      {
        question: "You want a calm personal planning loop",
        philo: "Strong fit because the note itself stays central.",
        alternative: "Can feel heavy if you only need personal daily execution.",
      },
      {
        question: "You want structured shared workflows and fields everywhere",
        philo: "Less ideal. That is not the core bet.",
        alternative: "Often the better fit.",
      },
      {
        question: "You want one-off tools created inline",
        philo: "Fits the disposable widget model well.",
        alternative: "Usually requires more setup and permanence.",
      },
    ],
    bestFor: [
      "People who do not want a giant workspace just to run daily work",
      "Users who want a local markdown-centered execution loop",
    ],
    notFor: [
      "Teams needing strict project process and enterprise workflow control",
      "Organizations choosing a shared system of record",
    ],
    faqs: [
      {
        question: "Is Philo meant to be a big workspace replacement?",
        answer:
          "No. The product direction is explicitly about keeping the planning loop short, not building another giant workspace.",
      },
      {
        question: "When do heavyweight tools still win?",
        answer: "They win when the problem is a shared project system, not a personal note-driven execution loop.",
      },
    ],
    relatedLinks: [
      { label: "Write, decide, and run in one place", href: "/use-cases/write-decide-and-run-in-one-place", },
      { label: "Disposable widgets in notes", href: "/guides/disposable-widgets-in-notes", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "comparison-manual-recurring",
    slug: "philo-vs-manual-recurring-checklists",
    section: "comparisons",
    pageType: "comparison",
    template: "comparison",
    title: "Philo vs manual recurring checklists",
    summary: "Why automatic recurrence changes the planning burden in a markdown workflow.",
    audience: "people manually rewriting the same routine",
    primaryQuery: "philo vs manual recurring checklists",
    intent: "commercial",
    requiredTags: ["recurring", "daily-notes",],
    optionalTags: ["markdown", "task-rollover",],
    comparisonTarget: "Manual recurring checklists",
    comparisonRows: [
      {
        question: "You are rewriting the same routine every day",
        philo: "Removes that step by bringing recurring tasks back on schedule.",
        alternative: "Keeps the burden on you every time.",
      },
      {
        question: "You want recurrence logic visible in the task text",
        philo: "Uses inline tags inside the markdown.",
        alternative: "Usually relies on memory or copy-forward rituals.",
      },
      {
        question: "You prefer explicit manual control over every recurrence step",
        philo: "Less ideal if you do not want automation.",
        alternative: "Better fit.",
      },
    ],
    bestFor: [
      "People whose checklists should rebuild themselves",
      "Users who want recurrence visible in plain text",
    ],
    notFor: [
      "People who deliberately rewrite routines from scratch",
      "Workflows that do not repeat often enough to justify automation",
    ],
    faqs: [
      {
        question: "What is the real benefit of recurrence?",
        answer: "It reduces decisions you never needed to make again, which makes the planning surface calmer.",
      },
      {
        question: "Why keep recurrence inline?",
        answer:
          "Because the rule stays editable where the task already lives instead of hiding in a separate settings surface.",
      },
    ],
    relatedLinks: [
      { label: "Recurring task tags in Philo", href: "/guides/recurring-task-tags", },
      { label: "From recurring tasks to recurring systems", href: "/blog/from-recurring-tasks-to-recurring-systems", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "glossary-daily-note-timeline",
    slug: "daily-note-timeline",
    section: "glossary",
    pageType: "glossary",
    template: "glossary",
    title: "Daily note timeline",
    summary: "The Philo idea that yesterday, today, and tomorrow should stay close together while you plan.",
    audience: "people learning Philo's planning vocabulary",
    primaryQuery: "daily note timeline definition",
    intent: "informational",
    requiredTags: ["timeline", "daily-notes",],
    optionalTags: ["task-rollover",],
    bestFor: [
      "People who want a quick definition of a core Philo concept",
    ],
    notFor: [
      "People who need a product comparison instead of a definition",
    ],
    faqs: [
      {
        question: "Why does Philo use a timeline instead of isolated daily pages?",
        answer: "Because the page should already know what was in flight when you open it.",
      },
    ],
    relatedLinks: [
      { label: "Daily note timeline in Philo", href: "/guides/daily-note-timeline", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "glossary-task-rollover",
    slug: "task-rollover",
    section: "glossary",
    pageType: "glossary",
    template: "glossary",
    title: "Task rollover",
    summary: "The behavior where unfinished work carries into today automatically.",
    audience: "people learning Philo's planning vocabulary",
    primaryQuery: "task rollover definition",
    intent: "informational",
    requiredTags: ["task-rollover",],
    optionalTags: ["daily-notes", "recurring",],
    bestFor: ["People who want the shortest explanation of rollover behavior",],
    notFor: ["People who need a full workflow guide instead of a definition",],
    faqs: [
      {
        question: "How is rollover different from recurrence?",
        answer: "Rollover preserves unfinished work, while recurrence recreates work on a schedule.",
      },
    ],
    relatedLinks: [
      { label: "Task rollover in daily notes", href: "/guides/task-rollover-in-daily-notes", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "glossary-recurring-tags",
    slug: "recurring-tags",
    section: "glossary",
    pageType: "glossary",
    template: "glossary",
    title: "Recurring tags",
    summary: "Inline tags like #daily and #weekly that make task recurrence explicit in the note itself.",
    audience: "people learning Philo's planning vocabulary",
    primaryQuery: "recurring tags definition",
    intent: "informational",
    requiredTags: ["recurring",],
    optionalTags: ["markdown", "daily-notes",],
    bestFor: ["People who want a precise definition of inline recurrence",],
    notFor: ["People who need setup steps instead of terminology",],
    faqs: [
      {
        question: "Why use recurring tags instead of hidden rules?",
        answer: "The tag keeps the recurrence behavior visible and editable in plain text.",
      },
    ],
    relatedLinks: [
      { label: "Recurring task tags in Philo", href: "/guides/recurring-task-tags", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "glossary-disposable-widgets",
    slug: "disposable-widgets",
    section: "glossary",
    pageType: "glossary",
    template: "glossary",
    title: "Disposable widgets",
    summary: "Temporary inline tools that are cheap to create and safe to delete when the note no longer needs them.",
    audience: "people learning Philo's planning vocabulary",
    primaryQuery: "disposable widgets definition",
    intent: "informational",
    requiredTags: ["widgets",],
    optionalTags: ["library",],
    bestFor: ["People who want the shortest definition of Philo's widget model",],
    notFor: ["People who need a product walkthrough instead of a concept definition",],
    faqs: [
      {
        question: "What happens when a disposable widget becomes useful long term?",
        answer: "Philo lets you keep the winners in a small reusable library.",
      },
    ],
    relatedLinks: [
      { label: "Disposable widgets in notes", href: "/guides/disposable-widgets-in-notes", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "glossary-widget-library",
    slug: "widget-library",
    section: "glossary",
    pageType: "glossary",
    template: "glossary",
    title: "Widget library",
    summary: "The small reusable collection where Philo keeps widgets that earned a permanent place.",
    audience: "people learning Philo's planning vocabulary",
    primaryQuery: "widget library definition",
    intent: "informational",
    requiredTags: ["library", "widgets",],
    optionalTags: ["markdown",],
    bestFor: ["People who want a fast definition of the reusable widget layer",],
    notFor: ["People who need a comparison or setup guide",],
    faqs: [
      {
        question: "Why keep the library small?",
        answer: "Because Philo treats permanence as something a widget earns after proving useful.",
      },
    ],
    relatedLinks: [
      { label: "Quick tools inside notes", href: "/use-cases/quick-tools-inside-notes", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
  {
    id: "release-latest-roundup",
    slug: "latest-philo-release-roundup",
    section: "guides",
    pageType: "guide",
    template: "release",
    title: "Latest Philo release roundup",
    summary: "A fact-backed release page that turns first-party release notes into update-focused landing content.",
    audience: "people evaluating what changed recently in Philo",
    primaryQuery: "latest philo release",
    intent: "informational",
    requiredTags: ["release",],
    optionalTags: ["widgets", "google", "markdown",],
    bestFor: [
      "People who want a concise view of recent Philo changes",
      "Users tracking whether new releases affect their workflow",
    ],
    notFor: [
      "People who need a timeless product overview instead of recent updates",
      "Readers looking for speculative roadmap plans",
    ],
    faqs: [
      {
        question: "What should belong on a release roundup page?",
        answer: "Only first-party shipped changes with clear release-note evidence and no speculative roadmap claims.",
      },
    ],
    relatedLinks: [
      { label: "Philo guides", href: "/guides", },
      { label: "Notes from the team", href: "/blog", },
    ],
    image: "/philo-hero-screenshot.svg",
  },
];

export function resolveEnginePaths(root = REPO_ROOT,) {
  const landingRoot = path.join(root, "apps/landing",);
  const engineRoot = path.join(landingRoot, "content-engine",);

  return {
    root,
    landingRoot,
    engineRoot,
    inputsDir: path.join(engineRoot, "inputs",),
    stateDir: path.join(engineRoot, "state",),
    contentDir: path.join(landingRoot, "src/content",),
    publicDir: path.join(landingRoot, "public",),
    readmePath: path.join(root, "README.md",),
    docsDir: path.join(root, "docs",),
  };
}

export function getTopicCatalog() {
  return structuredClone(TOPIC_CATALOG,);
}

export async function discoverContentFacts(options = {},) {
  const paths = resolveEnginePaths(options.root,);
  await ensureDir(paths.stateDir,);

  const sources = await buildDiscoverSources(paths,);
  const facts = dedupeFacts(
    sources.flatMap((source,) => extractFactsFromSource(source, paths.root,)),
  );
  const payload = {
    generatedAt: formatDateTime(options.now ?? new Date(),),
    facts,
  };

  await writeJson(path.join(paths.stateDir, "facts.json",), payload,);

  return {
    facts,
    sources: sources.map(({ sourcePath, sourceType, },) => ({ sourcePath, sourceType, })),
    outputPath: path.join(paths.stateDir, "facts.json",),
  };
}

export async function prioritizeContent(options = {},) {
  const paths = resolveEnginePaths(options.root,);
  const factsPayload = await readJson(path.join(paths.stateDir, "facts.json",), { generatedAt: null, facts: [], },);
  const facts = factsPayload.facts ?? [];
  const demandSignals = await readJson(path.join(paths.inputsDir, "demand-signals.json",), [],);
  const communityQuestions = await readJson(path.join(paths.inputsDir, "community-questions.json",), [],);
  const releases = await readJson(path.join(paths.inputsDir, "releases.json",), [],);
  const opportunities = getTopicCatalog()
    .map((topic,) => buildOpportunity(topic, facts, demandSignals, communityQuestions, releases,))
    .filter(Boolean,)
    .sort((left, right,) => right.score - left.score);

  const payload = {
    generatedAt: formatDateTime(options.now ?? new Date(),),
    opportunities,
  };

  await writeJson(path.join(paths.stateDir, "opportunities.json",), payload,);

  return {
    opportunities,
    outputPath: path.join(paths.stateDir, "opportunities.json",),
  };
}

export async function draftContentPages(options = {},) {
  const paths = resolveEnginePaths(options.root,);
  const config = await readEngineConfig(paths,);
  const opportunitiesPayload = await readJson(path.join(paths.stateDir, "opportunities.json",), {
    opportunities: [],
  },);
  const factsPayload = await readJson(path.join(paths.stateDir, "facts.json",), { facts: [], },);
  const opportunities = opportunitiesPayload.opportunities ?? [];
  const factsById = new Map((factsPayload.facts ?? []).map((fact,) => [fact.id, fact,]),);
  let existing = await indexContentFiles(paths.contentDir, paths.root,);
  const selection = selectDraftTargets(opportunities, existing, paths, config.maxGeneratedDrafts,);
  const selectedKeys = new Set(selection.selected.map((opportunity,) => getOpportunityKey(opportunity,)),);

  const created = [];
  const skipped = [...selection.skipped,];
  const pruned = await pruneGeneratedDraftPages(paths, selectedKeys,);
  existing = await indexContentFiles(paths.contentDir, paths.root,);

  for (const opportunity of selection.selected) {
    const targetPath = path.join(paths.contentDir, opportunity.section, `${opportunity.slug}.mdx`,);
    if (await fileExists(targetPath,)) {
      const currentRaw = await fs.readFile(targetPath, "utf8",);
      const reason = (
          readScalarFrontmatter(currentRaw, "ownership",) === "generated"
          && readScalarFrontmatter(currentRaw, "status",) === "draft"
        )
        ? "tracked"
        : "exists";
      skipped.push({ slug: opportunity.slug, reason, filePath: toRepoPath(targetPath, paths.root,), },);
      continue;
    }

    const rendered = renderOpportunityPage(opportunity, factsById, {
      now: options.now,
      publishedAt: null,
      updatedAt: null,
    },);
    await ensureDir(path.dirname(targetPath,),);
    await fs.writeFile(targetPath, rendered, "utf8",);
    created.push({ slug: opportunity.slug, filePath: toRepoPath(targetPath, paths.root,), },);
    existing.set(targetPath, {
      filePath: toRepoPath(targetPath, paths.root,),
      canonicalPath: opportunity.canonicalPath,
      primaryQuery: opportunity.primaryQuery,
      ownership: opportunity.ownership,
    },);
  }

  const report = {
    generatedAt: formatDateTime(options.now ?? new Date(),),
    created,
    pruned,
    skipped,
  };

  await writeJson(path.join(paths.stateDir, "draft-report.json",), report,);
  await writeAuditQueue(paths, opportunities, config, {
    now: options.now,
    createdKeys: new Set(created.map((item,) => getContentKey(item.filePath,)),),
  },);

  return report;
}

export async function refreshGeneratedContent(options = {},) {
  const paths = resolveEnginePaths(options.root,);
  const config = await readEngineConfig(paths,);
  const opportunitiesPayload = await readJson(path.join(paths.stateDir, "opportunities.json",), {
    opportunities: [],
  },);
  const factsPayload = await readJson(path.join(paths.stateDir, "facts.json",), { facts: [], },);
  const opportunities = new Map(
    (opportunitiesPayload.opportunities ?? []).map((item,) => [`${item.section}/${item.slug}`, item,]),
  );
  const factsById = new Map((factsPayload.facts ?? []).map((fact,) => [fact.id, fact,]),);
  const files = await listFiles(paths.contentDir, (filePath,) => filePath.endsWith(".mdx",),);

  const updated = [];
  const unchanged = [];
  const skipped = [];

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8",);
    if (readScalarFrontmatter(raw, "ownership",) !== "generated") {
      skipped.push({ filePath: toRepoPath(filePath, paths.root,), reason: "manual-owned", },);
      continue;
    }

    const section = path.basename(path.dirname(filePath,),);
    const slug = path.basename(filePath, ".mdx",);
    const opportunity = opportunities.get(`${section}/${slug}`,);
    if (!opportunity) {
      skipped.push({ filePath: toRepoPath(filePath, paths.root,), reason: "missing-opportunity", },);
      continue;
    }

    const publishedAt = readScalarFrontmatter(raw, "publishedAt",) ?? todayStamp(options.now,);
    const updatedAt = readScalarFrontmatter(raw, "updatedAt",) ?? todayStamp(options.now,);
    const rendered = renderOpportunityPage(opportunity, factsById, {
      now: options.now,
      publishedAt,
      updatedAt,
    },);

    if (!hasMaterialChange(raw, rendered,)) {
      unchanged.push({ filePath: toRepoPath(filePath, paths.root,), },);
      continue;
    }

    const nextRendered = renderOpportunityPage(opportunity, factsById, {
      now: options.now,
      publishedAt,
      updatedAt: todayStamp(options.now,),
    },);

    await fs.writeFile(filePath, nextRendered, "utf8",);
    updated.push({ filePath: toRepoPath(filePath, paths.root,), },);
  }

  const report = {
    generatedAt: formatDateTime(options.now ?? new Date(),),
    updated,
    unchanged,
    skipped,
  };

  await writeJson(path.join(paths.stateDir, "refresh-report.json",), report,);
  await writeAuditQueue(paths, opportunitiesPayload.opportunities ?? [], config, {
    now: options.now,
    updatedKeys: new Set(updated.map((item,) => getContentKey(item.filePath,)),),
  },);

  return report;
}

export async function runContentSync(options = {},) {
  const discover = await discoverContentFacts(options,);
  const prioritize = await prioritizeContent(options,);
  const draft = await draftContentPages(options,);
  const refresh = await refreshGeneratedContent(options,);

  return { discover, prioritize, draft, refresh, };
}

export function extractFactsFromSource(source, root = REPO_ROOT,) {
  const text = stripCodeBlocks(stripFrontmatter(source.text,),);
  const lines = text
    .split("\n",)
    .flatMap((line,) => splitIntoStatements(normalizeStatement(line,),))
    .filter(isUsefulStatement,);
  const seen = new Set();

  return lines.flatMap((statement,) => {
    const normalized = statement.toLowerCase();
    if (seen.has(normalized,)) {
      return [];
    }

    seen.add(normalized,);
    return [{
      id: createStableId(`${source.sourcePath}:${statement}`,),
      statement,
      sourcePath: source.sourcePath,
      sourceType: source.sourceType,
      verifiedAt: source.verifiedAt,
      tags: inferTags(statement,),
    },];
  },);
}

export function buildOpportunity(topic, facts, demandSignals = [], communityQuestions = [], releases = [],) {
  const selectedFacts = selectFactsForTopic(topic, facts,);
  if (selectedFacts.length < 3) {
    return null;
  }

  const demandBoost = sumBoosts(topic.slug, demandSignals,) + sumBoosts(topic.slug, communityQuestions,);
  const releaseBoost = topic.template === "release" && releases.length > 0 ? 30 : 0;
  const score = selectedFacts.reduce((total, item,) => total + item.score, 0,) + demandBoost + releaseBoost;

  return {
    id: topic.id,
    slug: topic.slug,
    section: topic.section,
    pageType: topic.pageType,
    template: topic.template,
    title: topic.title,
    summary: topic.summary,
    canonicalPath: `/${topic.section}/${topic.slug}`,
    audience: topic.audience,
    primaryQuery: topic.primaryQuery,
    intent: topic.intent,
    score,
    requiredFactIds: selectedFacts.map((item,) => item.fact.id),
    status: "draft",
    ownership: "generated",
    bestFor: topic.bestFor,
    notFor: topic.notFor,
    faqs: topic.faqs,
    relatedLinks: topic.relatedLinks,
    image: topic.image,
    comparisonTarget: topic.comparisonTarget ?? null,
    comparisonRows: topic.comparisonRows ?? [],
  };
}

export function renderOpportunityPage(opportunity, factsById, options = {},) {
  const publishedAt = options.publishedAt ?? todayStamp(options.now,);
  const updatedAt = options.updatedAt ?? todayStamp(options.now,);
  const facts = opportunity.requiredFactIds
    .map((factId,) => factsById.get(factId,))
    .filter(Boolean,);
  if (facts.length < 3) {
    throw new Error(`Opportunity ${opportunity.slug} does not have enough evidence to render.`,);
  }

  const body = renderTemplateBody(opportunity, facts,);

  const frontmatter = serializeFrontmatter({
    title: opportunity.title,
    summary: opportunity.summary,
    publishedAt,
    updatedAt,
    pageType: opportunity.pageType,
    canonicalPath: opportunity.canonicalPath,
    primaryQuery: opportunity.primaryQuery,
    evidenceIds: opportunity.requiredFactIds,
    status: opportunity.status,
    ownership: opportunity.ownership,
    bestFor: opportunity.bestFor,
    notFor: opportunity.notFor,
    faqs: opportunity.faqs,
    relatedLinks: opportunity.relatedLinks,
    image: opportunity.image,
  },);

  return `${frontmatter}\n${body.trim()}\n`;
}

export function hasMaterialChange(currentRaw, nextRaw,) {
  return stripVolatileFrontmatter(currentRaw,) !== stripVolatileFrontmatter(nextRaw,);
}

async function readEngineConfig(paths,) {
  const config = await readJson(path.join(paths.inputsDir, "engine-config.json",), {},);
  const auditDefaults = config.auditDefaults ?? {};

  return {
    maxGeneratedDrafts: normalizePositiveInteger(config.maxGeneratedDrafts, DEFAULT_ENGINE_CONFIG.maxGeneratedDrafts,),
    auditQueueSize: normalizePositiveInteger(config.auditQueueSize, DEFAULT_ENGINE_CONFIG.auditQueueSize,),
    auditDefaults: {
      platform: typeof auditDefaults.platform === "string"
        ? auditDefaults.platform
        : DEFAULT_ENGINE_CONFIG.auditDefaults.platform,
      tone: typeof auditDefaults.tone === "string" ? auditDefaults.tone : DEFAULT_ENGINE_CONFIG.auditDefaults.tone,
      lowercaseMode: typeof auditDefaults.lowercaseMode === "boolean"
        ? auditDefaults.lowercaseMode
        : DEFAULT_ENGINE_CONFIG.auditDefaults.lowercaseMode,
    },
  };
}

function normalizePositiveInteger(value, fallback,) {
  const normalized = Number(value,);
  return Number.isInteger(normalized,) && normalized > 0 ? normalized : fallback;
}

function selectDraftTargets(opportunities, indexedFiles, paths, limit,) {
  const eligible = [];
  const skipped = [];

  for (const opportunity of opportunities) {
    const targetPath = path.join(paths.contentDir, opportunity.section, `${opportunity.slug}.mdx`,);
    const duplicate = findDuplicate(indexedFiles, opportunity, targetPath,);
    if (duplicate) {
      skipped.push({ slug: opportunity.slug, reason: duplicate.reason, filePath: duplicate.filePath, },);
      continue;
    }

    eligible.push({ opportunity, targetPath, },);
  }

  const selected = [];
  const selectedKeys = new Set();
  const coveredSections = new Set();

  for (const item of eligible) {
    if (selected.length >= limit) {
      break;
    }

    if (coveredSections.has(item.opportunity.section,)) {
      continue;
    }

    selected.push(item.opportunity,);
    selectedKeys.add(getOpportunityKey(item.opportunity,),);
    coveredSections.add(item.opportunity.section,);
  }

  for (const item of eligible) {
    if (selected.length >= limit) {
      break;
    }

    const key = getOpportunityKey(item.opportunity,);
    if (selectedKeys.has(key,)) {
      continue;
    }

    selected.push(item.opportunity,);
    selectedKeys.add(key,);
  }

  for (const item of eligible) {
    if (selectedKeys.has(getOpportunityKey(item.opportunity,),)) {
      continue;
    }

    skipped.push({
      slug: item.opportunity.slug,
      reason: "batch-limit",
      filePath: toRepoPath(item.targetPath, paths.root,),
    },);
  }

  return { selected, skipped, };
}

async function pruneGeneratedDraftPages(paths, keepKeys,) {
  const drafts = await collectGeneratedDraftFiles(paths,);
  const pruned = [];

  for (const draft of drafts) {
    if (keepKeys.has(draft.key,)) {
      continue;
    }

    await fs.unlink(draft.filePath,);
    pruned.push({ slug: draft.slug, filePath: draft.repoPath, reason: "batch-limit", },);
  }

  return pruned;
}

async function writeAuditQueue(paths, opportunities, config, options = {},) {
  await ensureDir(paths.stateDir,);

  const createdKeys = options.createdKeys ?? new Set();
  const updatedKeys = options.updatedKeys ?? new Set();
  const opportunityMap = new Map(opportunities.map((opportunity,) => [getOpportunityKey(opportunity,), opportunity,]),);
  const items = (await collectGeneratedDraftFiles(paths,))
    .map((draft,) => {
      const opportunity = opportunityMap.get(draft.key,);
      return {
        slug: draft.slug,
        section: draft.section,
        title: opportunity?.title ?? draft.title,
        filePath: draft.repoPath,
        score: opportunity?.score ?? 0,
        change: createdKeys.has(draft.key,)
          ? "created"
          : updatedKeys.has(draft.key,)
          ? "updated"
          : "tracked",
      };
    },)
    .sort((left, right,) => right.score - left.score || left.filePath.localeCompare(right.filePath,))
    .slice(0, config.auditQueueSize,)
    .map((item,) => ({
      ...item,
      audit: {
        skill: "audit",
        ...config.auditDefaults,
      },
    }));

  const payload = {
    generatedAt: formatDateTime(options.now ?? new Date(),),
    maxGeneratedDrafts: config.maxGeneratedDrafts,
    instruction: "Run the local audit skill on queued drafts before changing status from draft to published.",
    auditDefaults: config.auditDefaults,
    items,
  };

  await writeJson(path.join(paths.stateDir, "audit-queue.json",), payload,);
  return payload;
}

async function buildDiscoverSources(paths,) {
  const sources = [];
  const readme = await maybeReadFile(paths.readmePath,);
  if (readme) {
    sources.push({
      sourcePath: "README.md",
      sourceType: "readme",
      verifiedAt: todayStamp(),
      text: readme,
    },);
  }

  const docsFiles = await listFiles(paths.docsDir, (filePath,) => filePath.endsWith(".md",),);
  for (const filePath of docsFiles) {
    const text = await fs.readFile(filePath, "utf8",);
    sources.push({
      sourcePath: toRepoPath(filePath, paths.root,),
      sourceType: "docs",
      verifiedAt: todayStamp(),
      text,
    },);
  }

  const contentFiles = await listFiles(paths.contentDir, (filePath,) => filePath.endsWith(".mdx",),);
  for (const filePath of contentFiles) {
    const text = await fs.readFile(filePath, "utf8",);
    if (!text.includes("ownership: manual",)) {
      continue;
    }

    sources.push({
      sourcePath: toRepoPath(filePath, paths.root,),
      sourceType: "landing-mdx",
      verifiedAt: todayStamp(),
      text,
    },);
  }

  const releases = await readJson(path.join(paths.inputsDir, "releases.json",), [],);
  for (const release of releases) {
    const lines = [release.summary, ...(release.highlights ?? []),].filter(Boolean,);
    if (lines.length === 0) {
      continue;
    }

    sources.push({
      sourcePath: `apps/landing/content-engine/inputs/releases.json#${
        release.version ?? createStableId(lines.join("|",),)
      }`,
      sourceType: "release",
      verifiedAt: release.publishedAt ?? todayStamp(),
      text: lines.join("\n",),
    },);
  }

  const assetFacts = await discoverAssetSources(paths,);
  return [...sources, ...assetFacts,];
}

async function discoverAssetSources(paths,) {
  const assets = [
    {
      filePath: path.join(paths.publicDir, "philo-hero-screenshot.svg",),
      statement: "Philo ships a landing-page hero screenshot that shows the product interface.",
    },
    {
      filePath: path.join(paths.publicDir, "philo-demo.mp4",),
      statement: "Philo ships a landing-page demo video that shows the product workflow.",
    },
  ];

  const discovered = [];
  for (const asset of assets) {
    if (!await fileExists(asset.filePath,)) {
      continue;
    }

    discovered.push({
      sourcePath: toRepoPath(asset.filePath, paths.root,),
      sourceType: "asset",
      verifiedAt: todayStamp(),
      text: asset.statement,
    },);
  }

  return discovered;
}

function selectFactsForTopic(topic, facts,) {
  return facts
    .map((fact,) => ({
      fact,
      score: scoreFactForTopic(topic, fact,),
    }))
    .filter((item,) => item.score > 0)
    .sort((left, right,) => (
      right.score - left.score
      || SOURCE_TYPE_PRIORITY[right.fact.sourceType] - SOURCE_TYPE_PRIORITY[left.fact.sourceType]
    ))
    .slice(0, 6,);
}

function scoreFactForTopic(topic, fact,) {
  const requiredMatches = topic.requiredTags.filter((tag,) => fact.tags.includes(tag,)).length;
  const optionalMatches = (topic.optionalTags ?? []).filter((tag,) => fact.tags.includes(tag,)).length;
  const textMatches = overlapCount(tokenize(topic.primaryQuery,), tokenize(fact.statement,),);

  if (topic.template === "release" && fact.sourceType !== "release" && optionalMatches === 0) {
    return 0;
  }

  if (requiredMatches === 0 && optionalMatches === 0) {
    return 0;
  }

  return requiredMatches * 40 + optionalMatches * 10 + textMatches;
}

function sumBoosts(slug, records,) {
  return records
    .filter((item,) => item.slug === slug)
    .reduce((total, item,) => total + Number(item.score ?? 0,), 0,);
}

function renderTemplateBody(opportunity, facts,) {
  switch (opportunity.template) {
    case "comparison":
      return renderComparisonTemplate(opportunity, facts,);
    case "glossary":
      return renderGlossaryTemplate(opportunity, facts,);
    case "release":
      return renderReleaseTemplate(opportunity, facts,);
    case "use-case":
      return renderUseCaseTemplate(opportunity, facts,);
    default:
      return renderGuideTemplate(opportunity, facts,);
  }
}

function renderGuideTemplate(opportunity, facts,) {
  return `
Philo is a fit for ${opportunity.audience} because it keeps the note, the plan, and the supporting workflow closer together.

## Direct answer

${escapeMdxText(facts[0].statement,)}

${escapeMdxText(facts[1].statement,)}

## What this looks like in Philo

${facts.slice(0, 4,).map((fact,) => `- ${escapeMdxText(fact.statement,)}`).join("\n",)}

## Why it matters

${escapeMdxText(facts[2].statement,)}

${escapeMdxText(facts[3]?.statement ?? facts[1].statement,)}

## Evidence trail

${renderEvidenceList(facts,)}
`;
}

function renderUseCaseTemplate(opportunity, facts,) {
  return `
${escapeMdxText(facts[0].statement,)}

## Where this workflow fits

Philo is designed for ${opportunity.audience}. The product direction is about keeping the loop between writing, deciding, and running as short as possible.

## Capability checklist

${facts.slice(0, 5,).map((fact,) => `- ${escapeMdxText(fact.statement,)}`).join("\n",)}

## Why this workflow feels lighter

${escapeMdxText(facts[1].statement,)}

${escapeMdxText(facts[2].statement,)}

## Evidence trail

${renderEvidenceList(facts,)}
`;
}

function renderComparisonTemplate(opportunity, facts,) {
  const rows = opportunity.comparisonRows.map((row,) => `| ${row.question} | ${row.philo} | ${row.alternative} |`).join(
    "\n",
  );

  return `
${escapeMdxText(facts[0].statement,)}

## Quick take

Choose Philo when the center of gravity is the note itself. Choose ${opportunity.comparisonTarget.toLowerCase()} when the center of gravity is somewhere else.

## Comparison table

| Decide this way if... | Philo | ${opportunity.comparisonTarget} |
| --- | --- | --- |
${rows}

## What Philo is actually optimizing for

${escapeMdxText(facts[1].statement,)}

${escapeMdxText(facts[2].statement,)}

## Evidence trail

${renderEvidenceList(facts,)}
`;
}

function renderGlossaryTemplate(opportunity, facts,) {
  return `
${escapeMdxText(facts[0].statement,)}

## In Philo

${escapeMdxText(facts[1].statement,)}

## Why the term matters

${escapeMdxText(facts[2].statement,)}

## Evidence trail

${renderEvidenceList(facts,)}
`;
}

function renderReleaseTemplate(opportunity, facts,) {
  return `
${escapeMdxText(facts[0].statement,)}

## What changed

${facts.slice(0, 5,).map((fact,) => `- ${escapeMdxText(fact.statement,)}`).join("\n",)}

## Why it matters

${escapeMdxText(facts[1].statement,)}

${escapeMdxText(facts[2].statement,)}

## Evidence trail

${renderEvidenceList(facts,)}
`;
}

function renderEvidenceList(facts,) {
  return facts.map((fact,) => `- \`${fact.id}\` ${escapeMdxText(fact.statement,)} (${fact.sourcePath})`).join("\n",);
}

function escapeMdxText(value,) {
  return value
    .replaceAll("{", "\\{",)
    .replaceAll("}", "\\}",)
    .replaceAll("<", "&lt;",)
    .replaceAll(">", "&gt;",);
}

function serializeFrontmatter(frontmatter,) {
  const lines = [
    "---",
    `title: ${yamlString(frontmatter.title,)}`,
    `summary: ${yamlString(frontmatter.summary,)}`,
    `publishedAt: ${frontmatter.publishedAt}`,
    `updatedAt: ${frontmatter.updatedAt}`,
    `pageType: ${frontmatter.pageType}`,
    `canonicalPath: ${frontmatter.canonicalPath}`,
    `primaryQuery: ${yamlString(frontmatter.primaryQuery,)}`,
    ...serializeStringArray("evidenceIds", frontmatter.evidenceIds,),
    `status: ${frontmatter.status}`,
    `ownership: ${frontmatter.ownership}`,
    ...serializeStringArray("bestFor", frontmatter.bestFor,),
    ...serializeStringArray("notFor", frontmatter.notFor,),
    ...serializeObjectArray("faqs", frontmatter.faqs, ["question", "answer",],),
    ...serializeObjectArray("relatedLinks", frontmatter.relatedLinks, ["label", "href",],),
  ];

  if (frontmatter.image) {
    lines.push(`image: ${frontmatter.image}`,);
  }

  lines.push("---",);
  return lines.join("\n",);
}

function serializeStringArray(key, values,) {
  if (!values || values.length === 0) {
    return [`${key}: []`,];
  }

  return [
    `${key}:`,
    ...values.map((value,) => `  - ${yamlString(value,)}`),
  ];
}

function serializeObjectArray(key, values, fields,) {
  if (!values || values.length === 0) {
    return [`${key}: []`,];
  }

  return [
    `${key}:`,
    ...values.flatMap((value,) => (
      fields.map((field, index,) => `${index === 0 ? "  -" : "   "} ${field}: ${yamlString(value[field],)}`)
    )),
  ];
}

function yamlString(value,) {
  return JSON.stringify(String(value,),);
}

async function indexContentFiles(contentDir, root,) {
  const files = await listFiles(contentDir, (filePath,) => filePath.endsWith(".md",) || filePath.endsWith(".mdx",),);
  const indexed = new Map();

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8",);
    indexed.set(filePath, {
      filePath: toRepoPath(filePath, root,),
      canonicalPath: readScalarFrontmatter(raw, "canonicalPath",),
      primaryQuery: stripQuotes(readScalarFrontmatter(raw, "primaryQuery",),),
      ownership: readScalarFrontmatter(raw, "ownership",),
    },);
  }

  return indexed;
}

async function collectGeneratedDraftFiles(paths,) {
  const files = await listFiles(paths.contentDir, (filePath,) => filePath.endsWith(".mdx",),);
  const drafts = [];

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8",);
    if (readScalarFrontmatter(raw, "ownership",) !== "generated") {
      continue;
    }

    if (readScalarFrontmatter(raw, "status",) !== "draft") {
      continue;
    }

    drafts.push({
      key: getContentKey(toRepoPath(filePath, paths.root,),),
      slug: path.basename(filePath, ".mdx",),
      section: path.basename(path.dirname(filePath,),),
      title: readScalarFrontmatter(raw, "title",) ?? path.basename(filePath, ".mdx",),
      filePath,
      repoPath: toRepoPath(filePath, paths.root,),
    },);
  }

  return drafts;
}

function findDuplicate(indexedFiles, opportunity, targetPath,) {
  for (const [filePath, metadata,] of indexedFiles.entries()) {
    if (filePath === targetPath) {
      if (metadata.ownership === "manual") {
        return { reason: "manual-owned", filePath: metadata.filePath, };
      }

      continue;
    }

    if (metadata.canonicalPath === opportunity.canonicalPath) {
      return { reason: "duplicate-canonical-path", filePath: metadata.filePath, };
    }

    if (metadata.primaryQuery?.toLowerCase() === opportunity.primaryQuery.toLowerCase()) {
      return { reason: "duplicate-primary-query", filePath: metadata.filePath, };
    }

    if (metadata.ownership === "manual" && filePath === targetPath) {
      return { reason: "manual-owned", filePath: metadata.filePath, };
    }
  }

  return null;
}

function readScalarFrontmatter(raw, key,) {
  const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m",),);
  return match ? stripQuotes(match[1].trim(),) : null;
}

function stripQuotes(value,) {
  return value?.replace(/^"(.*)"$/, "$1",) ?? null;
}

function stripVolatileFrontmatter(raw,) {
  return raw.replace(/^updatedAt:\s*.+$/m, "updatedAt: <stable>",).trim();
}

function getOpportunityKey(opportunity,) {
  return `${opportunity.section}/${opportunity.slug}`;
}

function getContentKey(filePath,) {
  const normalizedPath = filePath.replaceAll("\\", "/",);
  const section = normalizedPath.split("/",).at(-2,);
  const slug = path.basename(normalizedPath, ".mdx",);
  return `${section}/${slug}`;
}

function dedupeFacts(facts,) {
  const deduped = new Map();
  for (const fact of facts) {
    const key = fact.statement.toLowerCase();
    const current = deduped.get(key,);
    if (!current || SOURCE_TYPE_PRIORITY[fact.sourceType] > SOURCE_TYPE_PRIORITY[current.sourceType]) {
      deduped.set(key, fact,);
    }
  }

  return [...deduped.values(),].sort((left, right,) =>
    left.sourcePath.localeCompare(right.sourcePath,) || left.statement.localeCompare(right.statement,)
  );
}

function inferTags(statement,) {
  return TAG_RULES
    .filter((rule,) => rule.patterns.some((pattern,) => pattern.test(statement,)))
    .map((rule,) => rule.tag);
}

function normalizeStatement(line,) {
  return line
    .replace(/^#{1,6}\s+/, "",)
    .replace(/^\s*[-*+]\s+/, "",)
    .replace(/^\s*\d+\.\s+/, "",)
    .replace(/!\[[^\]]*]\([^)]+\)/g, "",)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1",)
    .replace(/`([^`]+)`/g, "$1",)
    .replace(/<[^>]+>/g, " ",)
    .replace(/\s+/g, " ",)
    .trim();
}

function splitIntoStatements(line,) {
  return line
    .split(/(?<=[.!?])\s+/u,)
    .map((statement,) => statement.trim())
    .filter(Boolean,);
}

function isUsefulStatement(line,) {
  if (!line) {
    return false;
  }

  if (
    line.startsWith("---",) || line.startsWith("title:",) || line.startsWith("summary:",)
    || line.startsWith("publishedAt:",) || line.startsWith("updatedAt:",) || line.startsWith("pageType:",)
    || line.startsWith("canonicalPath:",) || line.startsWith("primaryQuery:",) || line.startsWith("status:",)
    || line.startsWith("ownership:",)
  ) {
    return false;
  }

  if (line.length < 28 || line.length > 220) {
    return false;
  }

  if (/(?:apps\/|src\/|services\/|components\/|\.tsx?\b|\.md\b|\.widget\b|\/journal\/|<vaultDir>)/.test(line,)) {
    return false;
  }

  if (/^[A-Z][A-Za-z ]+$/.test(line,) && !line.includes("Philo",)) {
    return false;
  }

  return /[a-z]/.test(line,);
}

function stripFrontmatter(text,) {
  if (!text.startsWith("---",)) {
    return text;
  }

  const match = text.match(/^---\n[\s\S]*?\n---\n?/,);
  return match ? text.slice(match[0].length,) : text;
}

function stripCodeBlocks(text,) {
  return text.replace(/```[\s\S]*?```/g, "",);
}

function tokenize(value,) {
  return value.toLowerCase().split(/[^a-z0-9]+/,).filter(Boolean,);
}

function overlapCount(left, right,) {
  const rightSet = new Set(right,);
  return left.filter((token,) => rightSet.has(token,)).length;
}

function createStableId(value,) {
  return crypto.createHash("sha1",).update(value,).digest("hex",).slice(0, 12,);
}

function todayStamp(now = new Date(),) {
  return now.toISOString().slice(0, 10,);
}

function formatDateTime(now = new Date(),) {
  return now.toISOString();
}

async function ensureDir(dirPath,) {
  await fs.mkdir(dirPath, { recursive: true, },);
}

async function maybeReadFile(filePath,) {
  try {
    return await fs.readFile(filePath, "utf8",);
  } catch {
    return null;
  }
}

async function fileExists(filePath,) {
  try {
    await fs.access(filePath,);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback,) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8",),);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value,) {
  await ensureDir(path.dirname(filePath,),);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2,)}\n`, "utf8",);
}

async function listFiles(dirPath, matcher,) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true, },).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name,);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, matcher,),);
      continue;
    }

    if (matcher(fullPath,)) {
      files.push(fullPath,);
    }
  }

  return files.sort();
}

function toRepoPath(filePath, root,) {
  return path.relative(root, filePath,).split(path.sep,).join("/",);
}
