// bench/eval/retro/target.ts (#89, RETRO.md v7, "Opening and targets"): naming and freezing each case's target.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Bundle } from "../bench/eval/retro/material.ts";
import { TARGET_CHECK_SYSTEM, TARGET_SYSTEM, type Answer } from "../bench/eval/retro/prompts.ts";
import type { RowRecord } from "../bench/eval/retro/screen.ts";
import { SCREEN } from "../bench/eval/retro/screen.ts";
import { casesToOpen, changedFiles, frozenText, kept, landedRange, nameTarget, refusalOf, summaryOf, type TargetDeps } from "../bench/eval/retro/target.ts";

const MARK = "SECRET-CASE-TEXT";
const bundle: Bundle = { repo: "o/r", pull: { number: 9, title: `${MARK} fix`, body: MARK, comments: [], reviews: [] }, issues: [], unavailable: [] };
const DIFF = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-x\n+y\n";
const answer = (json: unknown, counted = true): Answer => ({ counted, json, sent: { system: "", request: "", bytes: 0 }, model: ["claude-opus-5-5"] });

interface Knobs {
  name?: unknown;
  agree?: unknown;
  broken?: "namer" | "checker";
  noFile?: boolean;
  bigFile?: boolean;
}

function deps(k: Knobs = {}) {
  const calls: string[] = [];
  const d: TargetDeps = {
    fix: () => ({ bundle, diff: DIFF }),
    landed: () => ({ base: "b".repeat(40), head: "h".repeat(40), how: "merge" }),
    fileAt: () => (k.noFile ? null : k.bigFile ? "x".repeat(SCREEN.maxRequestBytes) : `fn load() { std::fs::read(p)?; } ${MARK}`),
    annotate(system) {
      calls.push(system === TARGET_SYSTEM ? "namer" : system === TARGET_CHECK_SYSTEM ? "checker" : "other");
      if (system === TARGET_SYSTEM) return k.broken === "namer" ? answer(null, false) : answer(k.name ?? { file: "src/a.rs", function: "load", call: "std::fs::read(p)", quote: "std::fs::read(p)?;" });
      return k.broken === "checker" ? answer(null, false) : answer(k.agree ?? { agree: true, why: "w" });
    },
  };
  return { d, calls };
}
const c = { row: 5, ref: "o/r#9", repo: "o/r", origin: 3 };

test("a target is named when the namer names a call and the checker agrees", () => {
  const { d, calls } = deps();
  const r = nameTarget(c, d);
  assert.deepEqual(r.target, { file: "src/a.rs", function: "load", call: "std::fs::read(p)", quote: "std::fs::read(p)?;" });
  assert.equal(r.why, undefined);
  assert.deepEqual(calls, ["namer", "checker"]);
  assert.deepEqual(r.landed, { base: "b".repeat(40), head: "h".repeat(40), how: "merge" });
});

test("each way a target is not named, and none sends what it need not", () => {
  const why = (k: Knobs) => {
    const { d, calls } = deps(k);
    const r = nameTarget(c, d);
    assert.equal(r.target, null);
    return [r.why, calls.length];
  };
  assert.deepEqual(why({ agree: { agree: false, why: "no" } }), ["the checker does not agree", 2]);
  assert.deepEqual(why({ name: { none: "cannot tell" } }), ["no call is named", 1]);
  assert.deepEqual(why({ name: { file: "src/a.rs", function: "load", call: "read", quote: "read" } }), ["a call without (", 1], "the checker is not asked");
  assert.deepEqual(why({ broken: "namer" }), ["an answer never counted", 4]);
  assert.deepEqual(why({ broken: "checker" }), ["an answer never counted", 5]);
  assert.deepEqual(why({ noFile: true }), ["no file of the fix at O's head", 0]);
  assert.deepEqual(why({ bigFile: true }), ["a request over the size", 0], "nothing sent over the cap");
});

test("O's range as it landed: a merge commit, a rebase, a squash", () => {
  const graph: Record<string, string[]> = { M: ["P1", "X"], R3: ["R2"], R2: ["R1"], R1: ["B"], S: ["P"] };
  const messages: Record<string, string[]> = { R3: ["one", "two", "three"], S: ["unrelated"] };
  const git = { parents: (s: string) => graph[s] ?? [], messages: (h: string, n: number) => (messages[h] ?? []).slice(-n) };
  assert.deepEqual(landedRange(git, "M", ["a", "b"]), { base: "P1", head: "M", how: "merge" });
  assert.deepEqual(landedRange(git, "R3", ["one", "two", "three"]), { base: "B", head: "R3", how: "rebase" });
  assert.deepEqual(landedRange(git, "S", ["a", "b"]), { base: "P", head: "S", how: "squash" }, "messages differ: squashed");
  assert.deepEqual(landedRange(git, "S", ["only"]), { base: "P", head: "S", how: "squash" });
});

test("the cases opened: not caught before the merge, on the side asked, by row, the first N", () => {
  const rec = (row: number, repo: string, caught: boolean, outcome: "case" | "left out" = "case") => ({ row, ref: `${repo}#1`, repo, outcome, origin: { number: 2, by: "named" }, caught: { answers: [], caught, checks: "read" }, answers: [] }) as unknown as RowRecord;
  const entry = (repo: string, side: "sealed" | "dev") => ({ repo, side, fixed: false, why: ["t"], salt: "s", batch: { measurement: "#89" as const, id: "b1" } });
  const split = { repos: [entry("a/s1", "sealed"), entry("a/s2", "sealed"), entry("a/s3", "sealed"), entry("a/d1", "dev"), entry("a/caught", "sealed")] };
  const records = [rec(30, "a/s3", false), rec(4, "a/s1", false), rec(9, "a/caught", true), rec(12, "a/s2", false), rec(2, "a/d1", false), rec(1, "a/x", false, "left out")];
  assert.deepEqual(casesToOpen(records, split, "sealed", 2).map((x) => x.row), [4, 12]);
  assert.deepEqual(casesToOpen(records, split, "sealed", null).map((x) => x.repo), ["a/s1", "a/s2", "a/s3"], "the caught one is not opened");
  assert.deepEqual(casesToOpen(records, split, "dev", null).map((x) => x.repo), ["a/d1"]);
});

test("the files a fix changes, by their name before it", () => {
  assert.deepEqual(changedFiles("diff --git a/old.rs b/new.rs\n+x\ndiff --git a/b.rs b/b.rs\n"), ["old.rs", "b.rs"]);
});

test("the frozen file keeps the verdicts it came from and the prompts' version", () => {
  const { d } = deps();
  const f = JSON.parse(frozenText("sealed", [nameTarget(c, d)], { b1: "a".repeat(64) }));
  assert.deepEqual([f.measurement, f.retroVersion, f.side, f.verdicts.b1], ["#89", 7, "sealed", "a".repeat(64)]);
});

const ts = join(import.meta.dirname, "..", "bench", "eval", "retro", "target.ts");

test("the command prints only the kind of an error", () => {
  const p = spawnSync(process.execPath, [ts, "sealed", "c", "/nonexistent-records", "x"], { encoding: "utf8" });
  assert.equal(p.stdout, "");
  assert.equal(p.stderr.trim(), "target.ts stopped: Error");
});

test("a sealed naming happens once: a finished one, or its line on main, refuses another", () => {
  const none = () => false;
  assert.deepEqual(refusalOf("sealed", none, []), { file: "89-targets.json" });
  assert.match((refusalOf("sealed", (n) => n === "89-targets.json", []) as { refused: string }).refused, /named already/);
  assert.match((refusalOf("sealed", none, [{ side: "sealed", file: "batches/89-targets.json", sha256: "a".repeat(64) }]) as { refused: string }).refused, /main holds/);
  assert.deepEqual(refusalOf("sealed", none, [{ side: "dev", file: "x", sha256: "b".repeat(64) }]), { file: "89-targets.json" }, "a dev line does not");
});

test("dev has three attempts, each its own file", () => {
  const have = (k: number) => (n: string) => [1, 2, 3].slice(0, k).some((i) => n === `89-targets-dev-${i}.json`);
  assert.deepEqual(refusalOf("dev", have(0), []), { file: "89-targets-dev-1.json" });
  assert.deepEqual(refusalOf("dev", have(2), []), { file: "89-targets-dev-3.json" });
  assert.match((refusalOf("dev", have(3), []) as { refused: string }).refused, /3 attempts/);
});

test("frozen.json holds lines of the shape the refusal reads", () => {
  const f = JSON.parse(readFileSync(join(import.meta.dirname, "..", "bench", "eval", "retro", "frozen.json"), "utf8"));
  assert.ok(Array.isArray(f.lines));
  for (const l of f.lines) assert.deepEqual(Object.keys(l).sort(), ["file", "sha256", "side"]);
});

test("an answer is kept by what it sent's bytes and sha256, not its text", () => {
  const k = kept({ counted: true, json: {}, sent: { system: "S", request: `${MARK} long request`, bytes: 99 }, model: [] });
  assert.ok(!JSON.stringify(k).includes(MARK));
  assert.equal(k.sent.bytes, 99);
  assert.match(k.sent.request, /^[0-9a-f]{64}$/);
});

test("sealed prints nothing about how many were named; dev prints the yield", () => {
  const named = nameTarget(c, deps().d);
  const notNamed = nameTarget(c, deps({ agree: { agree: false, why: "no" } }).d);
  const sealed = summaryOf("sealed", [named, notNamed], 3, 10, "t");
  assert.deepEqual(Object.keys(sealed).sort(), ["cases", "sha256", "side", "withinRuns"], "no count, no runs");
  assert.ok(!JSON.stringify(sealed).includes(MARK));
  const dev = summaryOf("dev", [named, notNamed], 3, 10, "t");
  assert.deepEqual([dev.named, dev.notNamed], [1, { "the checker does not agree": 1 }]);
  assert.ok(!JSON.stringify(dev).includes(MARK));
});
