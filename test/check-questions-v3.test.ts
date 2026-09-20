// The v3 contract: the scoring, the verdict, and the gate that withholds a question before any
// request is sent. These run in `npm test` and use no model and no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BAR_V3, CONTROL_CRITERIA_V3, MEANING_V3, RESULT_CRITERIA_V3, canAnswerLocally, questionsV3, score, verdictOfV3, type ConditionV3 } from "../bench/check-questions-v3.ts";

const condition: ConditionV3 = {
  setup: "The function has just been entered.",
  operation: "The iterator `entries`",
  yields: "`Err(io_error)`",
  others: "Every other operation the function reaches succeeds.",
  finite: "The iterator is finite.",
};

test("the result options do not overlap: a success is one option whatever it carries", () => {
  assert.deepEqual(Object.keys(RESULT_CRITERIA_V3), ["returns_error", "returns_success", "cannot_determine"]);
  // The defect v3 exists to remove: under v2 an answer could be right about the property and
  // still be scored wrong for choosing the other success.
  const successes = Object.keys(RESULT_CRITERIA_V3).filter((k) => MEANING_V3[k as keyof typeof MEANING_V3].property === "breaks");
  assert.equal(successes.length, 1, "exactly one option may mean the property breaks");
});

test("both questions carry the whole condition, so neither depends on the other being asked", () => {
  const qs = questionsV3(condition);
  for (const q of [qs.on_error_result, qs.on_error_control]) {
    for (const part of [condition.setup, condition.operation, condition.yields, condition.others, condition.finite]) {
      assert.ok(q.instructions.includes(part), `a question is missing "${part}"`);
    }
  }
  assert.notEqual(qs.on_error_result.instructions, qs.on_error_control.instructions);
});

test("the condition names no expected answer", () => {
  const text = questionsV3(condition).on_error_result.instructions.toLowerCase();
  for (const word of ["propagate", "should", "must", "correct", "violat", "bug", "hands the failure back"]) {
    assert.ok(!text.includes(word), `the condition contains "${word}"`);
  }
});

test("a matching choice under the bar is a match that may not be counted", () => {
  const under = score("returns_error", 0.51, "returns_error");
  assert.deepEqual({ choiceMatch: under.choiceMatch, counted: under.counted }, { choiceMatch: true, counted: false });
  const over = score("returns_error", BAR_V3, "returns_error");
  assert.deepEqual({ choiceMatch: over.choiceMatch, counted: over.counted }, { choiceMatch: true, counted: true });
  const wrong = score("returns_success", 1, "returns_error");
  assert.deepEqual({ choiceMatch: wrong.choiceMatch, counted: wrong.counted }, { choiceMatch: false, counted: false });
});

test("the verdict reads the result answer only", () => {
  assert.equal(verdictOfV3("returns_error", 0.9).verdict, "property_holds");
  assert.equal(verdictOfV3("returns_success", 0.9).verdict, "property_breaks");
  assert.equal(verdictOfV3("cannot_determine", 0.9).verdict, "unknown");
  assert.equal(verdictOfV3("returns_error", 0.59).verdict, "unknown", "under the bar is unknown, not a weaker yes");
  assert.equal(verdictOfV3(undefined, 1).verdict, "unknown");
  // A choice outside the offered set never becomes a verdict. `readChoice` rejects it upstream;
  // this is the second place that must not turn it into an answer.
  assert.equal(verdictOfV3("stops_there", 1).verdict, "unknown");
  assert.equal(verdictOfV3("constructor", 1).verdict, "unknown");
});

test("the control question's answers are not in the verdict's mapping", () => {
  for (const choice of Object.keys(CONTROL_CRITERIA_V3)) {
    if (choice === "cannot_determine") continue; // shared name, and it is unknown either way
    assert.equal(verdictOfV3(choice, 1).verdict, "unknown", `${choice} must not decide anything`);
  }
});

test("a packet without the target's own body is withheld before any request", () => {
  const whole = { own: false, context: false, ambiguous: false };
  assert.equal(canAnswerLocally(whole, true).send, true);
  const ownCut = canAnswerLocally({ ...whole, own: true }, true);
  assert.equal(ownCut.send, false);
  assert.match(ownCut.reason!, /cut\.own/);
  const missing = canAnswerLocally(whole, false);
  assert.equal(missing.send, false);
  assert.match(missing.reason!, /not found/);
});

test("a cut in the surroundings does not withhold the question, and says why in the code", () => {
  // Deliberate, and different from `decide()`'s rule for `violates`: what the function returns is
  // in the body, and the body is here. Recorded as a bench judgement, not applied to the product.
  assert.equal(canAnswerLocally({ own: false, context: true, ambiguous: true }, true).send, true);
});
