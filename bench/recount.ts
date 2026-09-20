// Recompute the tables from a saved run. No API call, no repository, no model.
//
//   node bench/recount.ts bench/logs/real-requirement-v3.json
//
// The point is that a number in the prose can be checked without spending anything: the log holds
// every answer unrounded, so this reads them and counts again rather than trusting a summary that
// was written at the same time as the claim. It reads the shape written by
// `bench/real-requirement-check.ts`; the older logs have their own shape and are not rewritten
// into this one, so it says so and stops rather than pretending to read them.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: node bench/recount.ts <log.json>");
const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

if (!Array.isArray(doc.log) || doc.plan === undefined) {
  console.error(`${path} is not a real-requirement run log (no 'plan' and 'log'). The v1/v2 logs in bench/logs/ have a different shape; their own benches print their tables.`);
  process.exit(2);
}

interface Row {
  group: string;
  case: string;
  run: number | null;
  expected: { result: string | null; control: string | null; verdict: string };
  result?: { choice: string; probability: number; choiceMatch: boolean; counted: boolean };
  control?: { choice: string; probability: number; choiceMatch: boolean | null; counted: boolean | null };
  verdict?: string;
  met?: boolean;
  why?: string;
  error?: string;
  commit?: string;
  located?: { path: string; lines: string } | null;
}

const rows = doc.log as Row[];
const bar = (doc.questions as { bar: number } | undefined)?.bar ?? 0.6;
const plan = doc.plan as { hash: string };
const tool = doc.tool as { version: string; commit: string; model: string };
const sent = doc.sent as { requests: number; bytes: number; hardLimit: number };

console.log(`${path}`);
console.log(`tool ${tool.version} @ ${String(tool.commit).slice(0, 7)} · model ${tool.model} · plan ${plan.hash} · bar ${bar}`);
console.log(`requests ${sent.requests}/${sent.hardLimit} · ${(sent.bytes / 1024).toFixed(0)} KB\n`);

const groups = [...new Set(rows.map((r) => r.group))];
for (const group of groups) {
  console.log(`--- ${group} ---`);
  const cases = [...new Set(rows.filter((r) => r.group === group).map((r) => r.case))];
  for (const c of cases) {
    const runs = rows.filter((r) => r.case === c && r.run !== null);
    if (runs.length === 0) {
      const local = rows.find((r) => r.case === c)!;
      console.log(`  ${c.padEnd(44)} no request — ${local.met ? "withheld as planned" : "NOT as planned"}: ${local.why}`);
      continue;
    }
    const expected = runs[0]!.expected;
    const errors = runs.filter((r) => r.error).length;
    const choice = runs.filter((r) => r.result?.choiceMatch).length;
    const counted = runs.filter((r) => r.result?.counted).length;
    const verdict = runs.filter((r) => r.verdict === expected.verdict).length;
    const ps = runs.filter((r) => r.result).map((r) => r.result!.probability);
    const range = ps.length ? `${Math.min(...ps).toFixed(2)}-${Math.max(...ps).toFixed(2)}` : "-";
    const chosen = [...new Set(runs.filter((r) => r.result).map((r) => r.result!.choice))].join("/");
    console.log(
      `  ${c.padEnd(44)} n=${runs.length} choice ${choice}/${runs.length} · choice+bar ${counted}/${runs.length} · verdict ${verdict}/${runs.length}` +
        `  [${chosen} ${range}]  expected ${expected.result} → ${expected.verdict}${errors ? ` · ${errors} error(s)` : ""}`,
    );
    // Diagnostic only: the control answer is never part of the verdict, so it is printed apart.
    const cRuns = runs.filter((r) => r.control && r.control.choiceMatch !== null);
    if (cRuns.length) {
      const cChoice = cRuns.filter((r) => r.control!.choiceMatch).length;
      const cCounted = cRuns.filter((r) => r.control!.counted).length;
      const cps = cRuns.map((r) => r.control!.probability);
      console.log(`  ${"".padEnd(44)} control (diagnostic, not aggregated): choice ${cChoice}/${cRuns.length} · choice+bar ${cCounted}/${cRuns.length} [${Math.min(...cps).toFixed(2)}-${Math.max(...cps).toFixed(2)}]`);
    }
  }
}

const sending = [...new Set(rows.filter((r) => r.run !== null).map((r) => r.case))];
const unmet = sending.filter((c) => {
  const runs = rows.filter((r) => r.case === c && r.run !== null);
  return runs.filter((r) => r.result?.counted).length < runs.length;
});
const local = rows.filter((r) => r.run === null);
console.log(`\n${unmet.length === 0 ? `every case that sent requests met the pass condition (${bar} in every run)` : `not met: ${unmet.join(", ")}`}`);
console.log(local.every((r) => r.met) ? `${local.length} case(s) withheld locally, as planned` : `a local case did not behave as planned: ${local.filter((r) => !r.met).map((r) => r.case).join(", ")}`);
