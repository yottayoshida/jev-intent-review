// The gate before the five branches: does each **known target** have a mapping that can be used?
//
//   node bench/mapping-gate.ts <run.json> [<run.json> ...]
//
// Not "the run produced some mapping somewhere". A run can read an `applies` about a call nobody
// is measuring and look ready while both targets went unanswered, and the number that would show
// it — `governed` — counts the whole run. So each target is read on its own:
//
//   1. a mapping record exists for it;
//   2. Jev answered `applies` at or above the bar the run recorded acting on;
//   3. on the shipped branch, no finding stands against it.
//
// The probabilities are printed whatever the verdict: a target settled at 0.58 and one settled at
// 0.05 are both "not ready", and only one of them is a bar away from ready.
//
// The target names live here and not in `src/`: they are what this evaluation happens to be
// about, and the product has no business knowing them.

import { readFileSync } from "node:fs";

interface Record_ {
  callId: string;
  verdict: string;
  probability: number;
  probabilities: Record<string, number>;
  governs: boolean;
  function: string;
  call: string;
  why: string;
}

interface Run {
  requirements: {
    requirementId: string;
    requirementText: string;
    mappings: Record_[];
    findings: { function: string; call: string; quote: string }[];
    counts: { asked: number; mapped: number; governed: number };
  }[];
}

/** The two calls `#27` measured, named by the function they are in and the helper they call. */
const TARGETS = [
  { function: "read_baseline", callee: "read_to_string_capped" },
  { function: "raw_override_disables", callee: "read_to_string_capped" },
];

function gate(path: string): boolean {
  const run = JSON.parse(readFileSync(path, "utf8")) as Run;
  const r = run.requirements[0];
  if (!r) {
    console.log(`${path}: no requirement in this run`);
    return false;
  }
  console.log(`\n== ${path}  (${r.requirementId}: asked ${r.counts.asked}, mapped ${r.counts.mapped}, governed ${r.counts.governed})`);
  let ready = true;
  for (const target of TARGETS) {
    const m = r.mappings.find((x) => x.function === target.function && x.call.includes(target.callee));
    if (!m) {
      console.log(`   ${target.function.padEnd(24)} NOT ASKED — no mapping record for it`);
      ready = false;
      continue;
    }
    const finding = r.findings.find((f) => f.function === target.function && f.call.includes(target.callee));
    console.log(`   ${target.function.padEnd(24)} ${m.governs ? "USABLE" : "NOT USABLE"} — ${m.why}`);
    console.log(`      every option: ${JSON.stringify(m.probabilities)}`);
    console.log(`      finding on this branch: ${finding ? "yes" : "no"}`);
    if (!m.governs) ready = false;
  }
  return ready;
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node bench/mapping-gate.ts <run.json> [...]");
  process.exit(2);
}
const results = paths.map(gate);
console.log(`\n${results.every(Boolean) ? "READY: every target in every run has a usable mapping" : "NOT READY: at least one target has no usable mapping — record this and stop"}`);
