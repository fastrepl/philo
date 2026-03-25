import { draftContentPages, } from "./lib.mjs";

const report = await draftContentPages();
console.log(JSON.stringify(
  {
    created: report.created.length,
    pruned: report.pruned.length,
    skipped: report.skipped.length,
  },
  null,
  2,
),);
