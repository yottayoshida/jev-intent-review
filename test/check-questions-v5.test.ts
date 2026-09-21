// v5 takes how the failure happens out of the template. These checks hold everything else still.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTROL_CRITERIA_V3, RESULT_CRITERIA_V3 } from "../bench/check-questions-v3.ts";
import { questionsV4 } from "../bench/check-questions-v4.ts";
import { questionsV5, type ConditionV5 } from "../bench/check-questions-v5.ts";

const iterating: ConditionV5 = {
  target: "staging_info_from",
  setup: "`dir` is a path and the function has just been entered.",
  occurrence: "At one iteration",
  operation: "the iterator `entries`",
  yields: "`Err(io_error)`",
  others: "Every other operation the function reaches succeeds.",
  extra: "The iterator is finite.",
};

const calling: ConditionV5 = {
  target: "read_baseline",
  setup: "`base_dir` is a directory, and the baseline file under it exists.",
  occurrence: "When it is called",
  operation: "`crate::atomic_file::read_to_string_capped(&path, MAX_TRACKED_FILE_BYTES)`",
  yields: "`Err(io_error)`",
  others: "Every other operation the function reaches succeeds.",
  extra: "",
};

test("v5 reuses v3's criteria objects, so the verdict rule is untouched", () => {
  const v5 = questionsV5(calling);
  assert.equal(v5.on_error_result.criteria, RESULT_CRITERIA_V3, "the result options must be the same object, not a copy");
  assert.equal(v5.on_error_control.criteria, CONTROL_CRITERIA_V3);
});

test("a failure that is one call does not read as an iteration", () => {
  // The reason v5 exists: v4 hard-codes "at one iteration" and takes a `finite` field, and the
  // first two new targets fail on a call. A template that cannot say so is what was frozen.
  const v4 = questionsV4({ target: calling.target, setup: calling.setup, operation: calling.operation, yields: calling.yields, others: calling.others, finite: "" });
  assert.match(v4.on_error_result.instructions, /at one iteration/);
  assert.doesNotMatch(questionsV5(calling).on_error_result.instructions, /iteration/);
});

test("an iterating condition still reads as one", () => {
  assert.match(questionsV5(iterating).on_error_result.instructions, /At one iteration, the iterator `entries` returns/);
  assert.match(questionsV5(iterating).on_error_result.instructions, /The iterator is finite\./);
});

test("an empty `extra` leaves no gap in the sentence", () => {
  const text = questionsV5(calling).on_error_result.instructions;
  assert.doesNotMatch(text, / {2,}/, "two spaces means a field was dropped in");
  assert.ok(text.includes("succeeds. Under that condition:"), "the condition should run straight into the ask");
});

test("both questions name the target and say the answer is not a dependency's", () => {
  const v5 = questionsV5(calling);
  for (const q of [v5.on_error_result, v5.on_error_control]) {
    assert.ok(q.instructions.includes("`read_baseline`"));
    assert.ok(q.instructions.includes("evidence.related"));
  }
  assert.match(v5.on_error_result.instructions, /Not what any function under `evidence\.related` returns/);
});

test("both questions carry the whole condition standalone", () => {
  const v5 = questionsV5(iterating);
  for (const q of [v5.on_error_result, v5.on_error_control]) {
    for (const part of [iterating.setup, iterating.occurrence, iterating.operation, iterating.yields, iterating.others, iterating.extra]) {
      assert.ok(q.instructions.includes(part), `a question is missing "${part}"`);
    }
  }
});

test("naming the target does not name the answer", () => {
  const text = questionsV5(calling).on_error_result.instructions.toLowerCase();
  for (const word of ["propagate", "should", "must", "correct", "violat", "swallow", "refus"]) {
    assert.ok(!text.includes(word), `the question contains "${word}"`);
  }
});

test("v5's wording is not v4's, which is why its numbers are not carried over", () => {
  const v4 = questionsV4({ target: iterating.target, setup: iterating.setup, operation: iterating.operation, yields: iterating.yields, others: iterating.others, finite: iterating.extra });
  assert.notEqual(v4.on_error_result.instructions, questionsV5(iterating).on_error_result.instructions);
});
