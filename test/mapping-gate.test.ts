// The gate that decides whether the other four branches are worth sending.
//
// Two ways it used to say yes when it should not have: it read `requirements[0]` for every target,
// so with two requirements R2's target was scored against R1's answers; and it looked only at the
// mapping, so a shipped branch that already listed a target passed on its way to being the
// baseline the other four are compared against.

import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, readTargets, score, TARGETS, type Run } from "../bench/mapping-gate.ts";

const [R1, R2] = TARGETS;

const mapping = (t: (typeof TARGETS)[number], governs: boolean, verdict = governs ? "applies" : "does_not_apply", p = governs ? 0.9 : 0.8) => ({
  callId: `${t.file}:call-1`,
  file: t.file,
  function: t.function,
  call: t.call,
  verdict,
  probability: p,
  probabilities: { [verdict]: p },
  governs,
  why: `read as ${verdict}`,
});

const finding = (t: (typeof TARGETS)[number]) => ({ requirementId: t.requirementId, file: t.file, function: t.function, call: t.call });

const run = (options: { r1Governs?: boolean; r2Governs?: boolean; listed?: (typeof TARGETS)[number][] } = {}): Run => {
  const listed = options.listed ?? [];
  return {
    requirements: [
      { requirementId: "R1", requirementText: "…", mappings: [mapping(R1!, options.r1Governs ?? true)], findings: listed.filter((t) => t.requirementId === "R1").map(finding), observed: [], counts: { asked: 1, mapped: 1, governed: 1 } },
      { requirementId: "R2", requirementText: "…", mappings: [mapping(R2!, options.r2Governs ?? true)], findings: listed.filter((t) => t.requirementId === "R2").map(finding), observed: [], counts: { asked: 1, mapped: 1, governed: 1 } },
    ],
  };
};

test("both targets mapped and usable, neither listed: ready", () => {
  const { ready, rows } = gate(run());
  assert.equal(ready, true);
  assert.deepEqual(
    rows.map((r) => [r.target.requirementId, r.usable, r.listed]),
    [
      ["R1", true, false],
      ["R2", true, false],
    ],
  );
});

test("a usable mapping is not enough: a target listed on the shipped branch is not ready", () => {
  // The shipped branch is what every other reading is compared against. A run that lists a target
  // there has already broken the table it is the baseline of, and passing it on because the
  // mapping was fine hands the other four branches a baseline that disagrees with itself.
  const { ready, rows } = gate(run({ listed: [R2!] }));
  assert.equal(ready, false);
  assert.equal(rows.find((r) => r.target.requirementId === "R2")!.listed, true);
  assert.equal(rows.find((r) => r.target.requirementId === "R2")!.usable, true, "the mapping itself was fine — that is the point");
  assert.equal(rows.find((r) => r.target.requirementId === "R1")!.listed, false);
});

test("one target short of the bar is not ready, whatever the other one says", () => {
  assert.equal(gate(run({ r1Governs: false })).ready, false);
  assert.equal(gate(run({ r2Governs: false })).ready, false);
});

test("each target is read under its own requirement, not under the first one", () => {
  // R1's requirement holds a mapping for R2's call as well — an answer about the right call filed
  // under the wrong requirement. Reading `requirements[0]` for everything would have taken it.
  const crossed: Run = {
    requirements: [
      { requirementId: "R1", requirementText: "…", mappings: [mapping(R1!, true), mapping(R2!, true)], findings: [], observed: [], counts: { asked: 2, mapped: 2, governed: 2 } },
      { requirementId: "R2", requirementText: "…", mappings: [], findings: [], observed: [], counts: { asked: 0, mapped: 0, governed: 0 } },
    ],
  };
  const rows = readTargets(crossed);
  assert.equal(rows.find((r) => r.target.requirementId === "R1")!.usable, true);
  const r2 = rows.find((r) => r.target.requirementId === "R2")!;
  assert.equal(r2.usable, false);
  assert.match(r2.why, /never asked about this call under this requirement/);
  assert.equal(gate(crossed).ready, false);
});

test("a target is a call expression, not a function name", () => {
  const elsewhere: Run = {
    requirements: [
      { requirementId: "R1", requirementText: "…", mappings: [{ ...mapping(R1!, true), call: "baseline_path(base_dir)" }], findings: [], observed: [], counts: { asked: 1, mapped: 1, governed: 1 } },
      { requirementId: "R2", requirementText: "…", mappings: [mapping(R2!, true)], findings: [], observed: [], counts: { asked: 1, mapped: 1, governed: 1 } },
    ],
  };
  // Another call in the same function of the same file, and it is not the target.
  assert.equal(readTargets(elsewhere)[0]!.usable, false);
  assert.equal(gate(elsewhere).ready, false);
});

test("the expected table is fixed here, and a branch is scored against it per requirement", () => {
  assert.equal(score("correct", run()).agrees, true);
  assert.equal(score("correct", run({ listed: [R1!] })).agrees, false);
  assert.equal(score("m-read-baseline", run({ listed: [R1!] })).agrees, true);
  assert.equal(score("m-read-baseline", run()).agrees, false, "the mutation has to be listed");
  assert.equal(score("m-read-baseline", run({ listed: [R1!, R2!] })).agrees, false, "and the other target has to stay quiet");
  assert.equal(score("m-raw-override", run({ listed: [R2!] })).agrees, true);
  assert.equal(score("v-read-baseline", run()).agrees, true);
  assert.equal(score("v-raw-override", run({ listed: [R2!] })).agrees, false);
});
