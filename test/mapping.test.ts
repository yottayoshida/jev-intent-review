// The question put to Jev about what a requirement requires of a call, and the rule for acting on
// the answer.
//
// The rule is fixed here, before the measurement it will be read with: `applies`, at or above the
// same bar the reading of the code clears.

import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptMapping, mappingQuestionFor, MAPPING_BAR, MAPPING_CRITERIA } from "../src/plan/mapping.ts";
import { BAR } from "../src/plan/local-check.ts";
import { enumerate } from "../src/plan/candidates.ts";
import type { ChoiceAnswer } from "../src/types.ts";

const SOURCE = `pub fn read_baseline(base_dir: &Path) -> Result<Option<Baseline>, AppError> {
    let content = read_capped(base_dir, MAX)?;
    Ok(Some(content))
}
`;
const c = enumerate("src/integrity.rs", SOURCE);
const fn = c.functions[0]!;
const call = c.calls.find((k) => k.callee === "read_capped")!;

const answer = (choice: string, p: number): ChoiceAnswer => ({ choice, confidence: p, probabilities: { [choice]: p } });

test("the question is three options with fixed criteria — which is what Jev answers", () => {
  const q = mappingQuestionFor(fn, call, "read_capped(base_dir, MAX)");
  assert.deepEqual(Object.keys(q), ["requirement_governs"]);
  assert.equal(q.requirement_governs!.type, "choice");
  assert.deepEqual(Object.keys(q.requirement_governs!.criteria).sort(), ["applies", "does_not_apply", "unknown"]);
  assert.deepEqual(q.requirement_governs!.criteria, MAPPING_CRITERIA);
});

test("the question names the call and the function, and assumes nothing about run time", () => {
  const { instructions } = mappingQuestionFor(fn, call, "read_capped(base_dir, MAX)").requirement_governs!;
  assert.match(instructions, /read_capped\(base_dir, MAX\)/);
  assert.match(instructions, /read_baseline/);
  assert.match(instructions, /Assume nothing about what happens at run time/);
  // The reading of the code is asked under an assumed failure. This one must not be: what a
  // requirement asks of a call is settled by its words, not by what the code does.
  assert.ok(!/Assume exactly this/.test(instructions), "this is not the condition the observation is asked under");
});

test("the rule is applies, at or above the same bar the code's reading clears", () => {
  assert.equal(MAPPING_BAR, BAR);
  assert.equal(acceptMapping(answer("applies", 0.9)).governs, true);
  assert.equal(acceptMapping(answer("applies", MAPPING_BAR)).governs, true, "at the bar counts");
  assert.equal(acceptMapping(answer("applies", MAPPING_BAR - 0.01)).governs, false);
  assert.equal(acceptMapping(answer("does_not_apply", 0.99)).governs, false);
  assert.equal(acceptMapping(answer("unknown", 0.99)).governs, false);
});

test("every option's probability is kept, so a reading near the bar can be re-read later", () => {
  const rich: ChoiceAnswer = { choice: "applies", confidence: 0.62, probabilities: { applies: 0.62, does_not_apply: 0.3, unknown: 0.08 } };
  const m = acceptMapping(rich);
  assert.equal(m.probability, 0.62);
  assert.deepEqual(m.probabilities, { applies: 0.62, does_not_apply: 0.3, unknown: 0.08 });
  assert.equal(m.governs, true);
});

test("no answer is its own verdict, not a quiet does_not_apply", () => {
  const none = acceptMapping(undefined);
  assert.equal(none.verdict, "no_answer");
  assert.equal(none.governs, false);
  assert.notEqual(none.verdict, "does_not_apply");
});

test("a choice outside the three is read as unknown rather than acted on", () => {
  const m = acceptMapping(answer("violates", 0.99));
  assert.equal(m.verdict, "unknown");
  assert.equal(m.governs, false);
});
