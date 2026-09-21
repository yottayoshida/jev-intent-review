// Re-scoring `bench/logs/candidate-set-v1.json` without asking anything again.
//
//   node bench/candidate-set-rescore.ts bench/logs/candidate-set-v1.json
//
// The run's own summary had two faults, both in the scoring and neither in the answers:
//
//   - **"the mutated function is in the set"** was decided at function granularity. A set can
//     contain `exists()` inside `read_baseline` and not contain the call the mutation changed —
//     which is exactly what happened, and it made a set that cannot see the defect look like one
//     that reaches it.
//   - **"false violations"** compared every site that is not the mutated one against an assumed
//     `returns_error`. That is the thing this step was warned against: a function that records a
//     failure and carries on is handled differently, and the same callee is a lead and not a
//     reason. Those labels were never established by reading the code, so the column was
//     measuring disagreement with an assumption.
//
// What is left, honestly: whether the **mutated call** is in the set, and what the set contains
// whose behaviour nobody established. The answers are unchanged and are read from the log.

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "bench/logs/candidate-set-v1.json";
const d = JSON.parse(readFileSync(path, "utf8")) as {
  cases: {
    case: string;
    generated: { picks?: { callId?: string; clause?: string }[] };
    selections: Record<string, string[]>;
    sites: { callId: string; function: string; expression: string; related: string; clause: string | null }[];
    leftOverBudget: number;
    listing: { functions: number; calls: number; omitted: { functions: number; calls: number } };
  }[];
  log: Record<string, unknown>[];
  sent: { requests: number; bytes: number };
};

/**
 * The call each mutation actually changes, from `bench/fixtures/omamori-468/*.patch`. Named by the
 * callee and the function it is in, which is what the patches touch.
 */
const MUTATED = {
  "omamori-read-baseline": { fn: "read_baseline", callee: "read_to_string_capped" },
  "omamori-raw-override-disables": { fn: "raw_override_disables", callee: "read_to_string_capped" },
} as const;

console.log(`${path}\nanswers unchanged; ${d.sent.requests} requests were spent when they were collected\n`);

for (const rec of d.cases) {
  const m = MUTATED[rec.case as keyof typeof MUTATED];
  const picks = rec.generated.picks ?? [];
  console.log(`== ${rec.case}`);
  console.log(`   the model picked ${picks.length}: ${rec.sites.filter((s) => s.related === "stated").map((s) => `${s.expression.split("(")[0]} in ${s.function}`).join(", ")}`);
  console.log(`   none of them is a call to \`${m.callee}\`: ${rec.sites.every((s) => !s.expression.includes(m.callee))}`);

  for (const method of ["single", "multi", "expanded"] as const) {
    const ids = new Set(rec.selections[method]);
    const chosen = rec.sites.filter((s) => ids.has(s.callId));
    // The mutated *call*, not merely the mutated function.
    const hasMutatedCall = chosen.some((s) => s.function === m.fn && s.expression.includes(m.callee));
    const inMutatedFunction = chosen.some((s) => s.function === m.fn);
    const runsAtMutatedCall = d.log.filter((r) => r.case === rec.case && ids.has(String(r.callId)) && r.which === "mutant" && r.result && chosen.find((s) => s.callId === r.callId && s.function === m.fn && s.expression.includes(m.callee)));
    const found = runsAtMutatedCall.filter((r) => (r.result as { counted: boolean }).counted).length;
    const noClause = chosen.filter((s) => s.clause === null).length;
    console.log(
      `   ${method.padEnd(9)} sites ${String(chosen.length).padStart(2)}` +
        ` · the mutated call in the set: ${hasMutatedCall ? "yes" : "NO"}` +
        ` (somewhere in ${m.fn}: ${inMutatedFunction ? "yes" : "no"})` +
        ` · defect found ${runsAtMutatedCall.length ? `${found}/${runsAtMutatedCall.length}` : "n/a"}` +
        ` · no stated clause ${noClause}`,
    );
  }
  const judged = new Set(d.log.filter((r) => r.case === rec.case && r.result).map((r) => String(r.callId)));
  const unverified = rec.sites.filter((s) => judged.has(s.callId) && !(s.function === m.fn && s.expression.includes(m.callee)));
  console.log(`   behaviour never established for ${unverified.length} of the ${judged.size} judged sites — their answers are not scored here`);
  console.log(`   left over the set budget: ${rec.leftOverBudget} · omitted from the listing: ${rec.listing.omitted.calls} calls\n`);
}

console.log("What the run does establish: the picks follow the requirement's own words — it names FIFO,");
console.log("directory and symlink, and the picks are symlink calls — while the mechanism the requirement");
console.log("was fixed by, `read_to_string_capped`, appears nowhere in its text. Widening by callee then");
console.log("inherits that: it widens around the picked callees, not around the shared reader.");
