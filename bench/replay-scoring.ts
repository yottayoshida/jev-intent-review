// The scoring of the stated-requirements measurement, recomputed from the saved log alone.
//
//   node bench/replay-scoring.ts bench/logs/stated-requirements-v1.json
//
// Nothing here reads the repository the runs were taken against, and nothing is sent anywhere. The
// log holds every mapping and every reading the runs recorded, so the table can be produced again
// without the clone, without credentials, and without asking Jev a second time.

import { readFileSync } from "node:fs";
import { score, type Run } from "./mapping-gate.ts";

interface Saved {
  conditions: { expected: Record<string, Record<string, boolean>> };
  branches: Record<string, { head: string; requests: number; requirements: Run["requirements"] }>;
}

const path = process.argv[2] ?? "bench/logs/stated-requirements-v1.json";
const saved = JSON.parse(readFileSync(path, "utf8")) as Saved;

let all = true;
let requests = 0;
for (const [branch, run] of Object.entries(saved.branches)) {
  requests += run.requests;
  const { agrees, lines } = score(branch, { requirements: run.requirements });
  console.log(`== ${branch} (${run.head}, ${run.requests} requests)`);
  for (const line of lines) console.log(line);
  all &&= agrees;
}
console.log(`\n${Object.keys(saved.branches).length} branches, ${requests} requests in all.`);
console.log(all ? "EVERY BRANCH AGREES with the table fixed before the runs" : "AT LEAST ONE BRANCH DIFFERS from the table fixed before the runs");
process.exitCode = all ? 0 : 1;
