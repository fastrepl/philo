import { runContentSync, } from "./lib.mjs";

const report = await runContentSync();
console.log(JSON.stringify(
  {
    facts: report.discover.facts.length,
    opportunities: report.prioritize.opportunities.length,
    created: report.draft.created.length,
    pruned: report.draft.pruned.length,
    updated: report.refresh.updated.length,
  },
  null,
  2,
),);
