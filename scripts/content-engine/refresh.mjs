import { refreshGeneratedContent, } from "./lib.mjs";

const report = await refreshGeneratedContent();
console.log(JSON.stringify(
  {
    updated: report.updated.length,
    unchanged: report.unchanged.length,
    skipped: report.skipped.length,
  },
  null,
  2,
),);
