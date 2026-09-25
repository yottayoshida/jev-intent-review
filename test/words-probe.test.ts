import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { score } from "../bench/decisive/probe-words.ts";
import type { ChoiceAnswer } from "../src/types.ts";

// The probe's lines are fixed before any request (#82, ADR 0020). These hold the scorer to them: an
// answer that is the same every time, whatever it is, adopts nothing.

type Plan = Parameters<typeof score>[0];
type Rec = Parameters<typeof score>[1][number];
const plan = JSON.parse(readFileSync(new URL("../bench/decisive/words-probe.json", import.meta.url), "utf8")) as Plan;
const a = (choice: string, probability = 0.9): ChoiceAnswer => ({ choice, probability, probabilities: { [choice]: probability } });

/** Every target and outside call, every run, every arm, answered by `answer` (and its checks by `value`). */
function records(answer: (item: { set: string; values?: Record<string, string> }, arm: number) => string, value: (want: string) => string = (w) => w): Rec[] {
  const out: Rec[] = [];
  for (const item of [...plan.targets, ...plan.outside]) {
    for (let run = 1; run <= plan.runs; run++) {
      for (const arm of [0, 1, 2] as const) {
        const rec: Rec = { id: item.id, run, arm, packet: "p", sent: [], answer: a(answer(item, arm)) };
        if (arm === 2 && "values" in item) rec.checks = Object.fromEntries(Object.entries(item.values).map(([n, w]) => [n, a(value(w))]));
        out.push(rec);
      }
    }
  }
  return out;
}
/** The right reading of each set, in every arm. */
const right = (item: { set: string }) => (item.set === "H" || item.set === "D" ? "reaches_it" : "does_not_reach");

test("the probe's plan has 3 hidden, 3 defect, 9 settled targets and 11 outside calls", () => {
  const n = (s: string) => plan.targets.filter((t) => t.set === s).length;
  assert.deepEqual([n("H"), n("D"), n("S"), plan.outside.length], [3, 3, 9, 11]);
  assert.ok(plan.targets.filter((t) => t.version === "helper").every((t) => Object.values(t.values).every((v) => v === "returns_false_or_err")), "every helper's value is false/Err");
  assert.ok(plan.targets.filter((t) => t.version === "hidden").every((t) => Object.values(t.values).every((v) => v === "returns_true_or_ok")), "every hidden's value is true/Ok");
});

test("a right reading everywhere adopts arm 2; the old words as the control are scored but never adopted", () => {
  const { adopt } = score(plan, records(right));
  assert.equal(adopt, 2);
});

test("a check-value answer that is the same for every check adopts arm 1 at best, never arm 2", () => {
  assert.equal(score(plan, records(right, () => "returns_true_or_ok")).adopt, 1);
  assert.equal(score(plan, records(right, () => "returns_false_or_err")).adopt, 1);
});

test("a function answer that is the same every time adopts nothing", () => {
  assert.equal(score(plan, records(() => "reaches_it")).adopt, null, "always reaches: the settled targets fail");
  assert.equal(score(plan, records(() => "does_not_reach")).adopt, null, "always holds: the hidden targets fail");
  assert.equal(score(plan, records(() => "cannot_determine")).adopt, null);
});

test("one confident wrong reading of a hidden target, or one shipped target read as reaching, fails the arm", () => {
  const hidden = plan.targets.find((t) => t.set === "H")!;
  const oneWrong = records(right).map((r) => (r.id === hidden.id && r.arm === 2 && r.run === 1 ? { ...r, answer: a("does_not_reach") } : r));
  assert.equal(score(plan, oneWrong).adopt, 1, "arm 2 fails on the hidden line, arm 1 still passes");
  const shipped = plan.targets.find((t) => t.version === "shipped")!;
  const listed = records(right).map((r) => (r.id === shipped.id && r.arm !== 0 && r.run === 2 ? { ...r, answer: a("reaches_it") } : r));
  assert.equal(score(plan, listed).adopt, null);
});

test("the outside line needs arm 0 to have held at least 10 runs, and no hold turned into a listing", () => {
  const noHolds = records((item, arm) => (arm === 0 && item.set.startsWith("outside") ? "cannot_determine" : right(item)));
  assert.equal(score(plan, noHolds).adopt, null, "fewer than 10 holds in arm 0: nothing is adopted");
  const outside = plan.outside[0]!;
  const turned = records(right).map((r) => (r.id === outside.id && r.arm === 2 && r.run === 1 ? { ...r, answer: a("reaches_it") } : r));
  assert.equal(score(plan, turned).adopt, 1);
});
