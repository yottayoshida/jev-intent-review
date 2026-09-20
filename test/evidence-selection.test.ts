// Selecting related evidence, and refusing to ask when what the question needs is not there.
// No model and no repository: the test-region lookup is passed in.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SELECTIONS, classify, referentsPresent } from "../bench/evidence-selection.ts";
import type { Related } from "../src/evidence/builder.ts";

const caller: Related = { path: "src/cli/doctor.rs", lines: "663-695", code: "fn staging_info_at(dir: &Path) -> Result<StagingInfo, StagingUnreadable> {\n    todo!()\n}" };
const testBlock: Related = { path: "src/cli/doctor.rs", lines: "2569-2593", code: '    fn staging_listing_that_stops_partway_is_reported_as_unreadable() {\n        assert_eq!(json["status"], "error");\n    }' };
const callee: Related = { path: "src/util.rs", lines: "317-328", code: "pub(crate) fn collect_listing(\n    entries: impl Iterator<Item = std::io::Result<OsString>>,\n) -> Result<Vec<OsString>, ListingStopped> {\n}" };
const inTestFile: Related = { path: "tests/doctor_test.rs", lines: "10-20", code: "fn helper() {}" };

const inTestRegion = (path: string, line: number) => path === "src/cli/doctor.rs" && line >= 2500;

test("an entry inside a test region is a test, wherever the file lives", () => {
  const [a, b] = classify([caller, testBlock], ["collect_listing"], inTestRegion);
  assert.equal(a!.kind, "other", "the caller is not test code");
  assert.equal(b!.kind, "test", "a block inside `#[cfg(test)] mod tests` is");
});

test("a test path is a test even without a region lookup", () => {
  const [a] = classify([inTestFile], ["collect_listing"], () => false);
  assert.equal(a!.kind, "test");
});

test("an entry defining a declared referent is the needed callee", () => {
  const [a] = classify([callee], ["collect_listing"], inTestRegion);
  assert.equal(a!.kind, "needed_callee");
  assert.equal(a!.defines, "collect_listing");
});

test("every selection is a subset of what was built, and adds nothing", () => {
  const all = classify([caller, testBlock, testBlock, callee], ["collect_listing"], inTestRegion);
  for (const [id, select] of Object.entries(SELECTIONS)) {
    const kept = select(all);
    assert.ok(kept.length <= all.length, `${id} grew the packet`);
    for (const e of kept) assert.ok(all.includes(e), `${id} produced an entry that was not built`);
  }
  assert.deepEqual(SELECTIONS["as-is"](all).length, 4);
  assert.deepEqual(SELECTIONS["no-tests"](all).map((e) => e.kind), ["other", "needed_callee"]);
  assert.deepEqual(SELECTIONS["callee-only"](all).map((e) => e.kind), ["needed_callee"]);
  assert.deepEqual(SELECTIONS.none(all), []);
});

test("the duplicate is dropped with the kind, not deduplicated separately", () => {
  // Both copies of the same test go when test code goes. Keeping exactly one is not offered,
  // so "one copy versus two" stays confounded — the plan says so rather than the code implying
  // it was separated.
  const all = classify([testBlock, testBlock, callee], ["collect_listing"], inTestRegion);
  assert.equal(SELECTIONS["no-tests"](all).length, 1);
});

test("a packet without the needed referent is refused, and no probability lifts that", () => {
  const all = classify([caller, testBlock, callee], ["collect_listing"], inTestRegion);
  assert.equal(referentsPresent(SELECTIONS["as-is"](all), ["collect_listing"]).ok, true);
  assert.equal(referentsPresent(SELECTIONS["no-tests"](all), ["collect_listing"]).ok, true);
  const empty = referentsPresent(SELECTIONS.none(all), ["collect_listing"]);
  assert.equal(empty.ok, false);
  assert.match(empty.reason!, /does not carry collect_listing/);
});

test("a referent defined twice in the packet is refused too", () => {
  const other: Related = { ...callee, path: "src/other.rs", lines: "1-4" };
  const all = classify([callee, other], ["collect_listing"], inTestRegion);
  const twice = referentsPresent(all, ["collect_listing"]);
  assert.equal(twice.ok, false);
  assert.match(twice.reason!, /defined 2 times/);
});

test("no referents declared means nothing to withhold for", () => {
  assert.equal(referentsPresent([], []).ok, true);
});
