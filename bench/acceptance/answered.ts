// Whether the defects of the acceptance set placed where the run reads — a changed function (A) or
// its unchanged caller (B) — were asked about and answered in three runs of three (#38). No request is
// sent: it reads a log `run.ts measure` wrote.
//
//   node bench/acceptance/answered.ts bench/logs/acceptance-v4.json
//
// Inside the budget or not is settled by the commit, before any request (`run.ts precheck`); what
// three runs add is whether both questions about the target came back answered each time.

import { readFileSync } from "node:fs";
import { loadCases, type AcceptanceLog } from "./replay.ts";
import { answeredRuns, RUNS } from "./score.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: answered.ts <log>");
  process.exit(2);
}
const log = JSON.parse(readFileSync(path, "utf8")) as AcceptanceLog;
let all = true;
let lines = 0;
for (const c of loadCases()) {
  const measured = log.cases[c.id];
  if (!measured) continue;
  for (const [versionId, version] of Object.entries(c.versions)) {
    // A defect is a target the table expects to be listed; rewrite and hidden sit at A without one.
    if ((version.place !== "A" && version.place !== "B") || !Object.values(version.expected).includes("listed")) continue;
    const v = measured.versions[versionId];
    if (!v) {
      console.log(`${c.id} ${versionId} (place ${version.place}): not measured`);
      all = false;
      continue;
    }
    for (const r of answeredRuns(c, versionId, v).filter((x) => version.expected[x.targetKey] === "listed")) {
      lines += 1;
      const ok = r.finished === RUNS && r.answered === RUNS;
      all &&= ok;
      console.log(`${c.id} ${versionId} (place ${version.place}) ${r.targetKey}: asked and answered in ${r.answered} of ${r.finished} finished runs (${r.attempted} attempted)${ok ? "" : " — not three of three"}`);
    }
  }
}
// A log with no A or B defect in it — empty, or missing a case — is not a pass.
const counted = lines;
if (counted === 0) all = false;
console.log(all ? `every A and B defect: three of three (${counted})` : `not every A and B defect is three of three (${counted} counted)`);
process.exitCode = all ? 0 : 1;
