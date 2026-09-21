// Enumerating candidates from source, and checking a plan against them. No model, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { enumerate, listingFor } from "../bench/code-candidates.ts";
import { checkPlan, conditionFrom, referentsFor, type TypedPlan } from "../bench/typed-plan.ts";

const SOURCE = `use std::path::Path;

pub fn read_baseline(base_dir: &Path) -> Result<Option<Baseline>, AppError> {
    let path = baseline_path(base_dir);
    if !path.exists() {
        return Ok(None);
    }
    let content = crate::atomic_file::read_to_string_capped(&path, MAX)?;
    Ok(Some(serde_json::from_str(&content).map_err(|e| AppError::Config(e.to_string()))?))
}

fn baseline_path(base_dir: &Path) -> PathBuf {
    base_dir.join(".integrity.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_test_that_calls_it() {
        let got = read_baseline(Path::new("/tmp"));
        assert!(got.is_ok());
    }
}
`;

const c = enumerate("src/integrity.rs", SOURCE);
const target = c.functions.find((f) => f.name === "read_baseline")!;
const call = c.calls.find((k) => k.callee.endsWith("read_to_string_capped"))!;

test("functions come from outside the test region", () => {
  const names = c.functions.map((f) => f.name);
  assert.deepEqual(names, ["read_baseline", "baseline_path"]);
  assert.ok(!names.includes("a_test_that_calls_it"), "a function inside `#[cfg(test)]` is not a candidate");
});

test("a call inside a test is not a candidate either", () => {
  assert.ok(!c.calls.some((k) => k.line > 18), `a call from the test region got in: ${JSON.stringify(c.calls.filter((k) => k.line > 18))}`);
});

test("control flow is not a call", () => {
  for (const k of c.calls) assert.ok(!["if", "match", "return", "Ok", "Err", "Some"].includes(k.callee), `${k.callee} is not a call`);
});

test("each call knows which function it is in", () => {
  assert.equal(call.functionId, target.id);
  assert.ok(call.line >= target.startLine && call.line <= target.endLine);
});

test("the listing carries ids and nothing invented", () => {
  const l = listingFor(c);
  assert.deepEqual(new Set(l.functions.map((f) => f.id)), new Set(c.functions.map((f) => f.id)));
  for (const f of l.functions) assert.ok(SOURCE.includes(f.signature.slice(0, 40)), "a signature that is not in the source");
  for (const k of l.calls) assert.ok(SOURCE.includes(k.text.slice(0, 40)), "a call line that is not in the source");
});

const good: TypedPlan = { property: "call_failure_not_returned_as_success", targetId: target.id, failure: { kind: "call_result", callId: call.id, result: "err" } };

test("a plan naming things that are there passes", () => {
  const r = checkPlan(good, c);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.target.name, "read_baseline");
    assert.match(r.call.text, /read_to_string_capped/);
  }
});

test("each way of being wrong is a stage of its own", () => {
  const cases: [unknown, string][] = [
    ["not an object", "shape"],
    [{ ...good, property: "something_else" }, "property"],
    [{ ...good, targetId: "function-999" }, "target"],
    [{ ...good, failure: { ...good.failure, callId: "call-999" } }, "call"],
    [{ ...good, failure: { ...good.failure, kind: "prose" } }, "shape"],
    [{ ...good, failure: { ...good.failure, result: "ok" } }, "shape"],
  ];
  for (const [plan, stage] of cases) {
    const r = checkPlan(plan, c);
    assert.equal(r.ok, false, `${JSON.stringify(plan).slice(0, 60)} should not pass`);
    if (!r.ok) assert.equal(r.stage, stage, `${JSON.stringify(plan).slice(0, 60)}`);
  }
});

test("a call that is real but in another function is a binding failure, not a call failure", () => {
  // The shape `#20` produced: a call the requirement governs, in a function the mutation does not
  // touch. The listing has it, so it is not a missing id — it is a plan that does not hold together.
  const other = c.functions.find((f) => f.name === "baseline_path")!;
  const r = checkPlan({ ...good, targetId: other.id }, c);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.stage, "binding");
    assert.match(r.reason, /not inside baseline_path/);
  }
});

test("the condition is built from the plan, and has no field a verdict fits in", () => {
  const cond = conditionFrom(target, call);
  assert.ok(cond.setup.includes(call.callee), "the condition should name the call it means");
  assert.equal(cond.yields, "an error", "the assumed result comes from the kind, not from prose");
  for (const field of Object.values(cond)) {
    for (const word in { propagate: 1, should: 1, violat: 1, refus: 1 }) assert.ok(!field.toLowerCase().includes(word), `"${word}" reached the condition`);
  }
});

test("the condition holds across the versions being compared", () => {
  // The defect the first version had: it quoted `let content = …?;`, which the mutation rewrites,
  // so the condition contradicted the body it was asked about. A line number moves too.
  const cond = conditionFrom(target, call);
  assert.doesNotMatch(cond.setup, /line \d+/, "a line number moves when code above it changes");
  for (const field of Object.values(cond)) {
    assert.ok(!field.includes(call.text), "the condition must not quote a line a mutation can rewrite");
    assert.ok(!field.includes("let "), "quoting a binding is quoting the thing under test");
  }
});

test("a stipulated call result needs no referent", () => {
  // Measured in bench/logs/referent-needed-v1.json: 12/12 with the callee taken out.
  assert.deepEqual(referentsFor("call_result"), []);
});
