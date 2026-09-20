// v4 changes the instructions and nothing else. These checks hold the "nothing else" part.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTROL_CRITERIA_V3, RESULT_CRITERIA_V3, questionsV3 } from "../bench/check-questions-v3.ts";
import { questionsV4, type ConditionV4 } from "../bench/check-questions-v4.ts";

const condition: ConditionV4 = {
  target: "staging_info_from",
  setup: "`dir` is a path and the function has just been entered.",
  operation: "The iterator `entries`",
  yields: "`Err(io_error)`",
  others: "Every other operation the function reaches succeeds.",
  finite: "The iterator is finite.",
};

test("v4 reuses v3's criteria objects, so the verdict rule is untouched", () => {
  const v4 = questionsV4(condition);
  assert.equal(v4.on_error_result.criteria, RESULT_CRITERIA_V3, "the result options must be the same object, not a copy");
  assert.equal(v4.on_error_control.criteria, CONTROL_CRITERIA_V3);
});

test("both questions name the target, and say the answer is not a dependency's", () => {
  const v4 = questionsV4(condition);
  for (const q of [v4.on_error_result, v4.on_error_control]) {
    assert.ok(q.instructions.includes("`staging_info_from`"), "a question does not name the target");
    assert.ok(q.instructions.includes("evidence.related"), "a question does not say what the other code is for");
  }
  assert.match(v4.on_error_result.instructions, /Not what any function under `evidence\.related` returns/);
});

test("both questions still carry the whole condition standalone", () => {
  const v4 = questionsV4(condition);
  for (const q of [v4.on_error_result, v4.on_error_control]) {
    for (const part of [condition.setup, condition.operation, condition.yields, condition.others, condition.finite]) {
      assert.ok(q.instructions.includes(part), `a question is missing "${part}"`);
    }
  }
});

test("v4's instructions differ from v3's, which is why it is a new version", () => {
  const { target: _target, ...v3Condition } = condition;
  const v3 = questionsV3(v3Condition);
  const v4 = questionsV4(condition);
  assert.notEqual(v3.on_error_result.instructions, v4.on_error_result.instructions);
  assert.notEqual(v3.on_error_control.instructions, v4.on_error_control.instructions);
});

test("naming the target does not name the answer", () => {
  const text = questionsV4(condition).on_error_result.instructions.toLowerCase();
  for (const word of ["propagate", "should", "must", "correct", "violat", "swallow", "bug"]) {
    assert.ok(!text.includes(word), `the question contains "${word}"`);
  }
});
