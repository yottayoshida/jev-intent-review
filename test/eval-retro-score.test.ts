// bench/eval/retro/score.ts (#89, RETRO.md v7-v9, "Scoring"): matching, detection, the gate and the guards.

import assert from "node:assert/strict";
import { test } from "node:test";
import { counted, detected, ENVELOPE, matches, normalCall, sameFile, score, type ScoredCase, type ScoredRun } from "../bench/eval/retro/score.ts";

const only = () => false;
const t = { file: "src/store/load.rs", function: "load", call: "self.read_config(path)?" };

test("a call is brought to one form: no receiver, a path cut to its last segment, no final ? or .await", () => {
  assert.deepEqual(normalCall("self.read_config(path)?"), { name: "read_config(path)", path: null });
  assert.deepEqual(normalCall("crate::a::Foo::new(x).await?"), { name: "new(x)", path: "Foo" });
  assert.deepEqual(normalCall("tokio::spawn(async move { x.run().await })"), { name: "spawn(asyncmove{x.run().await})", path: "tokio" });
  assert.deepEqual(normalCall("Vec::<u8>::with_capacity(n)"), { name: "with_capacity(n)", path: "Vec" });
  assert.deepEqual(normalCall("iter.collect::<Vec<_>>()"), { name: "collect()", path: null });
});

test("matching: the receiver and a longer path allowed, other names, other paths and inner halves not", () => {
  const at = (call: string, file = "src/store/load.rs", fn = "load") => ({ file, function: fn, call });
  assert.equal(matches(at("read_config(path)"), t, only), true, "the tool lists no receiver");
  assert.equal(matches(at("store::read_config(path)"), t, only), true, "a path on one side only is taken off");
  assert.equal(matches(at("config(path)"), t, only), false);
  assert.equal(matches(at("read_config(other)"), t, only), false, "the arguments are part of the call");
  const pathed = { ...t, call: "a::f(x)" };
  assert.equal(matches(at("b::f(x)"), pathed, only), false, "both have a path: the last segments must agree");
  assert.equal(matches(at("crate::a::f(x)"), pathed, only), true);
  assert.equal(matches(at("unwrap_or(x)"), { ...t, call: "or(x)" }, only), false);
  assert.equal(matches(at("wrap(read_config(path))"), t, only), false, "the outer call is not the inner");
  assert.equal(matches(at("read_config"), { ...t, call: "read_config" }, only), false, "a call with no ( never matches");
  assert.equal(matches(at("read_config(path)", "src/store/load.rs", "Store::load"), t, only), true, "the function's last segment");
  assert.equal(matches(at("read_config(path)", "src/store/load.rs", "save"), t, only), false);
});

test("the tool's 200 characters: two calls equal on their first 200 match", () => {
  const long = `f(${"x".repeat(300)})`;
  const cut = long.slice(0, 200);
  assert.equal(matches({ file: "a/b.rs", function: "g", call: cut }, { file: "a/b.rs", function: "g", call: long }, only), true);
});

test("files: segment by segment, the shorter with two segments or the only one of its name", () => {
  assert.equal(sameFile("crates/x/src/lib.rs", "src/lib.rs", only), true);
  assert.equal(sameFile("crates/x/src/lib.rs", "lib.rs", only), false, "a bare lib.rs could be any");
  assert.equal(sameFile("crates/x/src/lib.rs", "lib.rs", () => true), true, "unless it is the only one");
  assert.equal(sameFile("src/mylib.rs", "lib.rs", () => true), false, "segment by segment, not by characters");
  assert.equal(sameFile("a/b.rs", "b/b.rs", only), false, "a directory named a or b is a real one");
});

const run = (hit: boolean, over: Partial<ScoredRun> = {}): ScoredRun => ({
  finished: true,
  requests: 10,
  bytes: 1000,
  seconds: 30,
  listed: hit ? [{ file: t.file, function: "load", call: "read_config(path)", requirementId: "R1" }] : [{ file: "src/other.rs", function: "o", call: "other()", requirementId: "R1" }],
  ...over,
});
const kase = (row: number, runs: ScoredRun[], over: Partial<ScoredCase> = {}): ScoredCase => ({ row, originBy: "blame", hasRequirement: true, target: t, covered: true, runs, adjudicated: [], ...over });

test("detected: three runs of three, under any requirement, none over the envelope", () => {
  assert.equal(detected(kase(1, [run(true), run(true), run(true)]), only), true);
  assert.equal(detected(kase(1, [run(true), run(true), run(false)]), only), false, "two of three is not");
  const r2 = run(true);
  r2.listed = [{ ...r2.listed[0]!, requirementId: "R2" }];
  assert.equal(detected(kase(1, [run(true), r2, run(true)]), only), true, "a different requirement in one run");
  assert.equal(detected(kase(1, [run(true), run(true, { requests: ENVELOPE.requests + 1 }), run(true)]), only), false, "over the envelope");
  assert.equal(detected(kase(1, [run(true), run(true), run(true, { finished: false })]), only), false, "three did not finish");
  assert.equal(counted(kase(1, [run(true), run(true, { finished: false }), run(true), run(true)]))!.length, 3, "the first three finished");
  assert.equal(detected(kase(1, [run(true), run(true), run(true)], { target: null, whyNotNamed: "the checker does not agree" }), only), false);
  assert.equal(detected(kase(1, [], { hasRequirement: false }), only), false);
});

const hits = (k: number, of = 17) =>
  Array.from({ length: of }, (_, i) => kase(i + 1, i < k ? [run(true), run(true), run(true)] : [run(false), run(false), run(false)], { adjudicated: [{ call: { file: "src/other.rs", function: "o", call: "other()" }, label: "real_defect" }] }));

test("the gate: 8 of 17 has a lower bound above 0.20, 7 of 17 not (Clopper–Pearson)", () => {
  const eight = score(hits(8), () => only);
  assert.equal(eight.detected, 8);
  assert.ok(eight.primary.lower > 0.2, String(eight.primary.lower));
  assert.equal(eight.gate.passed, true);
  const seven = score(hits(7), () => only);
  assert.ok(seven.primary.lower < 0.2, String(seven.primary.lower));
  assert.equal(seven.gate.passed, false);
});

test("the denominator: every opened case, without a requirement or a target too", () => {
  const cases = hits(8);
  cases[16] = kase(17, [], { hasRequirement: false });
  cases[15] = kase(16, [run(true), run(true), run(true)], { target: null, whyNotNamed: "O cannot be read" });
  const r = score(cases, () => only);
  assert.equal(r.cases, 17);
  assert.equal(r.detected, 8);
  assert.equal(r.withRequirement.cases, 16);
  assert.deepEqual(r.notNamed, { "O cannot be read": 1 });
});

test("the guards: an undecided call is false and not real; a duplicate counts neither way", () => {
  const listed = (calls: string[]): ScoredRun => ({ ...run(true), listed: [{ file: t.file, function: "load", call: "read_config(path)", requirementId: "R1" }, ...calls.map((call) => ({ file: "src/x.rs", function: "x", call, requirementId: "R1" }))] });
  const c = kase(1, [listed(["a()", "b()", "c()"]), listed(["a()"]), listed([])], {
    adjudicated: [
      { call: { file: "src/x.rs", function: "x", call: "a()" }, label: "false" },
      { call: { file: "src/x.rs", function: "x", call: "b()" }, label: "cannot_decide" },
      { call: { file: "src/x.rs", function: "x", call: "c()" }, label: "duplicate" },
    ],
  });
  const r = score([c], () => only);
  // Union: the target once, a(), b(), c() once each; c() is a duplicate.
  assert.equal(r.guards.falsePerPullRequest, 2, "a() false and b() undecided");
  assert.equal(r.guards.precision, 1 / 3, "the target of target, a(), b()");
});

test("a call at the end of a chain is matched by its own name and arguments, whatever comes before it", () => {
  const only = () => true;
  const at = (call: string) => ({ file: "src/a.rs", function: "load", call });
  assert.equal(normalCall("self.client.get(url).send().await?").name, "send()");
  assert.equal(normalCall("File::open(p)?.read_to_string(&mut s)").name, "read_to_string(&muts)");
  assert.equal(normalCall("fs::read(p)").path, "fs");
  assert.equal(normalCall("x.iter().collect::<Vec<_>>()").name, "collect()");
  assert.equal(matches(at("send()"), at("self.client.get(url).send().await?"), only), true);
  assert.equal(matches(at("read_to_string(&mut s)"), at("File::open(p)?.read_to_string(&mut s)"), only), true);
  assert.equal(matches(at("open(p)"), at("File::open(p)?.read_to_string(&mut s)"), only), false);
  // A comparison in the receiver's arguments does not hide the called name.
  assert.equal(normalCall("a.b(x < y).c()").name, "c()");
  assert.equal(normalCall("a.b(x > y, z).c(w)").name, "c(w)");
});

test("a target not found in O's head is not detected, and is counted apart", () => {
  const only = () => true;
  const t = { file: "src/a.rs", function: "load", call: "read(p)" };
  const run: ScoredRun = { finished: true, requests: 1, bytes: 1, seconds: 1, listed: [{ ...t, requirementId: "R1" }] };
  const c: ScoredCase = { row: 1, originBy: "named", hasRequirement: true, target: t, covered: true, runs: [run, run, run], adjudicated: [] };
  assert.equal(detected(c, only), true);
  assert.equal(detected({ ...c, foundAtHead: false }, only), false);
  const s = score([{ ...c, foundAtHead: false }, c], () => only);
  assert.equal(s.detected, 1);
  assert.equal(s.notFoundAtHead, 1);
});

test("each stage's share is over the stage before it", () => {
  const only = () => true;
  const t = { file: "src/a.rs", function: "load", call: "read(p)" };
  const hit: ScoredRun = { finished: true, requests: 1, bytes: 1, seconds: 1, listed: [{ ...t, requirementId: "R1" }] };
  const base: ScoredCase = { row: 1, originBy: "named", hasRequirement: true, target: t, covered: true, runs: [hit, hit, hit], adjudicated: [] };
  // 4 cases: 3 with a requirement, 2 of those covered, 1 of those listed; and 1 listed though not covered.
  const cases: ScoredCase[] = [
    { ...base, row: 1 },
    { ...base, row: 2, runs: [] },
    { ...base, row: 3, covered: false },
    { ...base, row: 4, hasRequirement: false, runs: [] },
  ];
  const s = score(cases, () => only);
  assert.equal(s.stages.shares.requirement!.rate, 3 / 4);
  assert.equal(s.stages.shares.covered!.rate, 2 / 3);
  assert.equal(s.stages.shares.listed!.rate, 1 / 2);
  assert.equal(s.stages.listedNotCovered, 1);
  assert.equal(score([{ ...base, hasRequirement: false, runs: [] }], () => only).stages.shares.covered, null);
});
