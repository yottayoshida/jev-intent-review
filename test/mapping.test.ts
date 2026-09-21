// What code can check about a mapping, and what it deliberately cannot.
//
// The point of these is the boundary: every one of the accepted mappings below passes every check
// this file has, and one of them is plainly wrong about the sentence. Passing is a shape, not a
// correctness claim, and the report says so where it prints one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMapping, MAPPING_PROPERTY } from "../src/plan/mapping.ts";

const context = {
  callIds: new Set(["src/integrity.rs:call-3"]),
  requirementId: "R1",
  requirementText: "A FIFO, directory or symlink planted at a path omamori reads is now refused by name instead of being silently treated as an empty file.",
};

const good = { callId: "src/integrity.rs:call-3", verdict: "applies", quote: "refused by name instead of being silently treated as an empty file", reason: "this is the read the sentence is about" };

test("a mapping that names a real call and quotes the requirement is accepted", () => {
  const r = checkMapping(good, context);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.mapping.requirementId, "R1");
    assert.equal(r.mapping.property, MAPPING_PROPERTY);
    assert.equal(r.mapping.verdict, "applies");
  }
});

test("accepted is a shape, not a correct reading", () => {
  // Every check here passes, and the reason given is nonsense about the sentence. Nothing in this
  // file can tell the difference, which is why the report attributes a finding to a model rather
  // than stating it.
  const r = checkMapping({ ...good, reason: "because the word 'file' appears twice" }, context);
  assert.equal(r.ok, true);
});

test("a call this run did not offer is refused", () => {
  const r = checkMapping({ ...good, callId: "src/elsewhere.rs:call-1" }, context);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "unknown_call");
    assert.match(r.reason, /is not a call this run offered/);
  }
});

test("a quote that is not in the requirement is refused, and so is one too short to be one", () => {
  const invented = checkMapping({ ...good, quote: "must never be swallowed under any circumstances" }, context);
  assert.equal(invented.ok, false);
  if (!invented.ok) assert.equal(invented.kind, "quote_not_in_requirement");
  const tiny = checkMapping({ ...good, quote: "a FIFO" }, context);
  assert.equal(tiny.ok, false);
  if (!tiny.ok) assert.match(tiny.reason, /too short/);
});

test("whitespace and case in a quote are not what decides", () => {
  const r = checkMapping({ ...good, quote: "REFUSED BY NAME\n  instead of being   silently treated as an empty file" }, context);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("a verdict that does not apply needs no quote: there may be nothing to point at", () => {
  const r = checkMapping({ ...good, verdict: "does_not_apply", quote: "" }, context);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  const unknown = checkMapping({ ...good, verdict: "unknown", quote: "" }, context);
  assert.equal(unknown.ok, true, unknown.ok ? "" : unknown.reason);
});

test("anything that is not one of the three verdicts, or not the shape asked for, is refused", () => {
  for (const bad of [{ ...good, verdict: "violates" }, { ...good, verdict: "yes" }, { callId: "src/integrity.rs:call-3" }, null, "applies", 7]) {
    const r = checkMapping(bad, context);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.equal(r.kind, "bad_shape");
  }
});
