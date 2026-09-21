// The two rules `#24` got wrong in prose, and the step it did not have. No model, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { enumerate } from "../bench/code-candidates.ts";
import { applicability, reachesTheDefect, scoreSet, type SiteOutcome } from "../bench/set-scoring.ts";

const SOURCE = `pub fn read_baseline(base_dir: &Path) -> Result<Option<Baseline>, AppError> {
    let path = baseline_path(base_dir);
    if !path.exists() {
        return Ok(None);
    }
    let content = crate::atomic_file::read_to_string_capped(&path, MAX)?;
    Ok(Some(content))
}

fn is_thing(p: &Path) -> bool {
    p.exists()
}
`;

const c = enumerate("src/integrity.rs", SOURCE);
const fn = c.functions.find((f) => f.name === "read_baseline")!;
const boolFn = c.functions.find((f) => f.name === "is_thing")!;
const mutated = c.calls.find((k) => k.callee.endsWith("read_to_string_capped"))!;
const existsCall = c.calls.find((k) => k.callee === "exists" && k.functionId === fn.id)!;
const truth = { functionName: "read_baseline", callee: "read_to_string_capped" };

test("reaching the defect is the call, not the function it is in", () => {
  // `#24` counted `exists()` inside `read_baseline` as reaching it.
  const onlyExists = reachesTheDefect([{ fn, call: existsCall }], truth);
  assert.equal(onlyExists.call, false, "another call in the same function does not reach the defect");
  assert.equal(onlyExists.functionOnly, true, "and that is worth saying, not silently false");

  const withIt = reachesTheDefect([{ fn, call: mutated }], truth);
  assert.equal(withIt.call, true);
  assert.equal(withIt.functionOnly, false);

  assert.equal(reachesTheDefect([], truth).call, false);
});

test("a call whose result is handled as a Result can carry the condition", () => {
  const line = "    let content = crate::atomic_file::read_to_string_capped(&path, MAX)?;";
  assert.equal(applicability(fn, mutated, line).ok, true);
});

test("a call that is not handled as a Result cannot", () => {
  // `exists()` returns bool. `#24` assumed "it returns an error" about two such calls.
  const line = "    if !path.exists() {";
  const r = applicability(fn, existsCall, line);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not handled as a Result/);
});

test("a target that does not return a Result cannot either", () => {
  const r = applicability(boolFn, existsCall, "    p.exists()");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /does not return a Result/);
});

test("unverified and not-applicable count as neither right nor wrong", () => {
  const outcomes: SiteOutcome[] = [
    { kind: "right" },
    { kind: "wrong" },
    { kind: "unverified" },
    { kind: "unverified" },
    { kind: "not_applicable", reason: "bool" },
    { kind: "withheld", reason: "not found in this version" },
  ];
  const s = scoreSet(outcomes, { call: false, functionOnly: true });
  assert.deepEqual(
    { right: s.right, wrong: s.wrong, unverified: s.unverified, notApplicable: s.notApplicable, withheld: s.withheld },
    { right: 1, wrong: 1, unverified: 2, notApplicable: 1, withheld: 1 },
  );
  assert.equal(s.sites, 6, "every site is still in the set — none is dropped to flatter the method");
  assert.equal(s.reachesDefect, false);
  assert.equal(s.reachesFunctionOnly, true);
});

test("dropping hard candidates cannot improve a score, because nothing is dropped", () => {
  // The reason unreadable sites stay in the set: a method that discards what it cannot handle
  // would otherwise look better than one that reports it.
  const withHard: SiteOutcome[] = [{ kind: "right" }, { kind: "unverified" }, { kind: "not_applicable", reason: "bool" }];
  const trimmed: SiteOutcome[] = [{ kind: "right" }];
  assert.notEqual(scoreSet(withHard, { call: true, functionOnly: false }).sites, scoreSet(trimmed, { call: true, functionOnly: false }).sites);
  assert.equal(scoreSet(withHard, { call: true, functionOnly: false }).right, scoreSet(trimmed, { call: true, functionOnly: false }).right);
});
