import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { score, WRAP, wrappedByACall } from "../bench/evidence-settles/probe.ts";
import type { ChoiceAnswer } from "../src/types.ts";

// The probe's lines are fixed before any request (#82, ADR 0019). These hold the scorer to them: an
// answer that is always the same, whichever it is, must not pass.

type Item = Parameters<typeof score>[0][number];
const plan = JSON.parse(readFileSync(new URL("../bench/evidence-settles/plan.json", import.meta.url), "utf8")) as { items: Item[] };
const a = (choice: string, probability = 0.9): ChoiceAnswer => ({ choice, probability, probabilities: { [choice]: probability } });
const failure = (item: Item) => !item.id.startsWith("cba") && !item.id.startsWith("constructed");

function records(evidence: (item: Item) => string) {
  return plan.items.flatMap((item) =>
    [1, 2, 3].map((run) => ({
      id: item.id,
      run,
      shared: {
        [failure(item) ? "on_error_result" : "in_forbidden_case"]: a(item.earlier ?? (failure(item) ? "returns_error" : "does_not_reach")),
        evidence_settles: a(evidence(item)),
      },
    })),
  );
}
const verdict = (lines: string[]) => lines[lines.length - 1]!;

test("the probe's plan has the sets the plan names: H 5, S 17, W at least 4", () => {
  const n = (s: string) => plan.items.filter((i) => i.set === s).length;
  assert.deepEqual([n("H"), n("S")], [5, 17]);
  assert.ok(n("W") >= 4);
});

test("an answer that is always `turns_on_code_not_sent`, or always settled, fails; one that follows the hidden helper passes", () => {
  assert.match(verdict(score(plan.items, records(() => "turns_on_code_not_sent"))), /^FAIL/);
  assert.match(verdict(score(plan.items, records(() => "settled_by_code_sent"))), /^FAIL/);
  assert.match(verdict(score(plan.items, records((i) => (i.set === "H" ? "turns_on_code_not_sent" : "settled_by_code_sent")))), /^PASS/);
});

test("one stopped run of S, or a missing run of H, fails the probe", () => {
  const good = records((i) => (i.set === "H" ? "turns_on_code_not_sent" : "settled_by_code_sent"));
  const s = plan.items.find((i) => i.set === "S")!;
  const oneStopped = good.map((r) => (r.id === s.id && r.run === 1 ? { ...r, shared: { ...r.shared, evidence_settles: a("turns_on_code_not_sent") } } : r));
  assert.match(verdict(score(plan.items, oneStopped)), /^FAIL/);
  const h = plan.items.find((i) => i.set === "H")!;
  assert.match(verdict(score(plan.items, good.filter((r) => !(r.id === h.id && r.run === 3)))), /^FAIL/);
});

test("the control rule and the rule without Jev read the shapes they name", () => {
  // What follows the call's expression, which ends at its closing parenthesis.
  assert.ok(WRAP.test("\n            .await?;"));
  assert.ok(WRAP.test(".map_err(|e| e.into())?"));
  assert.ok(!WRAP.test(";"));
  assert.ok(wrappedByACall("step_outcome(self.rewrite_heights(v))?;", "self.rewrite_heights(v)"));
  assert.ok(!wrappedByACall("Ok(self.rewrite_heights(v)?)", "self.rewrite_heights(v)"));
  assert.ok(!wrappedByACall("self.rewrite_heights(v)?;", "self.rewrite_heights(v)"));
});
