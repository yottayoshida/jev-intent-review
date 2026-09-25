// bench/eval/retro/calibrate.ts (#89, RETRO.md v2): the hindsight check's calibration on dev.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CAL, calibrate, changedFunction, devCandidates, n1Problem, nextAttempt, plant, type CalDeps, type Candidate, type LaterFix } from "../bench/eval/retro/calibrate.ts";
import type { Bundle } from "../bench/eval/retro/material.ts";
import { CHECK_SYSTEM, checkRequest, KEEP_LABELS, LABEL_SYSTEM, LEAK_SYSTEM, majority, readLabel, WRITE_SYSTEM, type Answer } from "../bench/eval/retro/prompts.ts";
import { devRowsOf, DEV_SEARCH, rowsOf, SEARCH, type Hit } from "../bench/eval/retro/search.ts";

const bundleFor = (n: number): Bundle => ({ repo: `o/r${n}`, pull: { number: 100 + n, title: `Read config ${n}`, body: `Reading config ${n} must fail loudly.`, comments: [], reviews: [] }, issues: [], unavailable: [] });

interface Knobs {
  /** Cases whose writer finds a requirement. */
  writable?: (n: number) => boolean;
  /** Whether the check leaves a requirement out, from what it was asked. */
  check?: (request: string, call: number) => boolean;
  /** Answers that cannot be counted, by the run's number. */
  broken?: (run: number) => boolean;
  n?: number;
}

function fakes(k: Knobs = {}) {
  const writable = k.writable ?? (() => true);
  const check = k.check ?? ((req: string) => req.includes("(the call in `"));
  const calls: { system: string; request: string }[] = [];
  let run = 0;
  let checks = 0;
  const answer = (json: unknown): Answer => ({ counted: true, json, sent: { system: "", request: "", bytes: 0 }, model: ["claude-opus-5-5"] });
  const deps: CalDeps = {
    fix(repo, number): LaterFix {
      const n = number;
      return { repo, number, ref: `${repo}#${n}`, title: `Stop swallowing ${n}`, body: "b", diff: `@@ -1,1 +1,1 @@ fn changed_fn_${n}(x: u8) {\n-a\n+b\n`, mergedAt: "2026-08-01T00:00:00Z", base: "base", bundle: bundleFor(n), label80: "swallows_as_success" };
    },
    origin: (fix) => ({ number: 100 + fix.number, by: "named" }),
    bundle: (repo, number) => bundleFor(number - 100),
    annotate(system, request) {
      run += 1;
      calls.push({ system, request });
      if (k.broken?.(run)) return { counted: false, why: "not JSON", sent: { system, request, bytes: 0 }, model: [] };
      if (system === LABEL_SYSTEM) return answer({ label: "swallows_as_success", quote: "q" });
      if (system === WRITE_SYSTEM) {
        const n = Number(/config (\d+) must/.exec(request)![1]);
        return answer(writable(n) ? { requirements: [{ text: `load ${n} returns the read error.`, quote: `Reading config ${n} must fail loudly.` }] } : { requirements: [], why: "nothing about failure" });
      }
      if (system === LEAK_SYSTEM) return answer({ requirements: [{ text: "leaky", quote: /Reading config \d+ must fail loudly\./.exec(request)![0] }] });
      if (system === CHECK_SYSTEM) {
        checks += 1;
        return answer({ leaked: check(request, checks) ? [{ requirement: 1, words: "w", found_in_fix: "f" }] : [] });
      }
      throw new Error(`unexpected system prompt`);
    },
    shuffle: (xs) => [...xs].reverse(),
  };
  return { deps, calls, runs: () => run };
}

const candidates = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => ({ repo: `o/r${i + 1}`, number: i + 1, source: "pool" as const }));

test("the check passes when it leaves out the planted names and keeps the clean requirements", () => {
  const { deps } = fakes();
  const c = calibrate(candidates(12), deps);
  assert.equal(c.verdict, "pass", c.why);
  assert.equal(c.counts.plantedLeftOut, 10);
  assert.equal(c.counts.cleanLeftOut, 0);
  assert.equal(c.cases.length, 10, "stops taking cases once ten are usable");
});

test("nine of ten planted is the line; eight fails, and so do two clean left out", () => {
  const plantedOnly = (limit: number) => (req: string) => req.includes("(the call in `") && Number(/changed_fn_(\d+)/.exec(req)?.[1] ?? /config (\d+)/.exec(req)![1]) <= limit;
  assert.equal(calibrate(candidates(10), fakes({ check: plantedOnly(9) }).deps).verdict, "pass");
  assert.equal(calibrate(candidates(10), fakes({ check: plantedOnly(8) }).deps).verdict, "fail");
  const cleanToo = (req: string) => req.includes("(the call in `") || /Read config [12]"/.test(req);
  const f = calibrate(candidates(10), fakes({ check: cleanToo }).deps);
  assert.equal(f.counts.cleanLeftOut, 2);
  assert.equal(f.verdict, "fail");
});

test("what is only recorded — the second checking and the fix-aware writer's ten — does not move the verdict", () => {
  // Every check after the first twenty says leaked: the second run and the leak ten.
  const { deps } = fakes({ check: (req, call) => call > 20 || req.includes("(the call in `") });
  const c = calibrate(candidates(10), deps);
  assert.equal(c.verdict, "pass");
  assert.equal(c.counts.agreement, 0.5, "the clean ten differ between the two runs");
  assert.deepEqual([c.counts.leakWritten, c.counts.leakCaught], [10, 10]);
});

test("fewer than ten writable cases stop as insufficient, before the check is asked", () => {
  // Twelve candidates, nine of them writable: the writer's step is what runs short.
  const { deps, calls } = fakes({ writable: (n) => n <= 9 });
  const c = calibrate(candidates(12), deps);
  assert.equal(c.verdict, "insufficient");
  assert.match(c.why, /^9 of 10/);
  assert.equal(calls.filter((x) => x.system === CHECK_SYSTEM).length, 0);
});

test("an answer the verdict needs that cannot be counted is asked again three times, then the calibration stops with a record", () => {
  const stopped = calibrate(candidates(10), fakes({ broken: () => true }).deps);
  assert.equal(stopped.verdict, "stopped");
  assert.match(stopped.why, /no answer that could be counted in 4 attempts/);
  assert.equal(stopped.counts.runs, 4, "the runs it spent are in the record");
  // Three failures then an answer: counted, and the run goes on.
  assert.equal(calibrate(candidates(10), fakes({ broken: (r) => r <= 3 }).deps).verdict, "pass");
});

test("an answer only recorded that cannot be counted never blocks the verdict", () => {
  // Every labeller's and every leak writer's answer fails; the verdict is still reached.
  const { deps } = fakes();
  const broken: CalDeps = { ...deps, annotate: (system, request) => (system === LABEL_SYSTEM || system === LEAK_SYSTEM ? { counted: false, why: "x", sent: { system, request, bytes: 0 }, model: [] } : deps.annotate(system, request)) };
  const c = calibrate(candidates(10), broken);
  assert.equal(c.verdict, "pass");
  assert.equal(c.recordsCut, 10 * 3 + 10, "thirty labels and ten leak writings given up on");
});

test("the calibration stops at the runs allowed, the N=1 run counted", () => {
  // One writer's run per unwritable case: 260 of them would take 260 runs.
  const c = calibrate(candidates(260), fakes({ writable: () => false }).deps, 1);
  assert.equal(c.verdict, "stopped");
  assert.match(c.why, /250 runs/);
  assert.equal(c.counts.runs, 250);
  assert.equal(CAL.maxRuns, 250);
});

test("a repository whose first row cannot be used has its next row tried; a used repository is not tried again", () => {
  const { deps } = fakes({ writable: (n) => n !== 1 });
  const rows: Candidate[] = [{ repo: "o/a", number: 1, source: "pool" }, { repo: "o/a", number: 2, source: "pool" }, { repo: "o/a", number: 3, source: "pool" }, ...candidates(12).slice(3)];
  const c = calibrate(rows, deps);
  assert.deepEqual(c.cases.filter((x) => x.fix.startsWith("o/a#")).map((x) => x.fix), ["o/a#1", "o/a#2"], "#1 wrote nothing, #2 was used, #3 was not tried");
});

test("an extra row is kept only when the screen keeps it; a pool row's screen decides nothing", () => {
  const { deps } = fakes();
  const screened: CalDeps = { ...deps, annotate: (system, request) => (system === LABEL_SYSTEM ? { counted: true, json: { label: "propagates", quote: "q" }, sent: { system, request, bytes: 0 }, model: ["claude-opus-5-5"] } : deps.annotate(system, request)) };
  const extra = calibrate(candidates(12).map((c) => ({ ...c, source: "extra" as const })), screened);
  assert.equal(extra.verdict, "insufficient");
  assert.ok(extra.cases.every((x) => x.why === "screened out as propagates"));
  const pool = calibrate(candidates(12), screened);
  assert.equal(pool.verdict, "pass");
  assert.ok(pool.cases.filter((x) => x.screen === "propagates").length >= 10, "recorded against #80's label, and the case still used");
});

test("the N=1 run stops the calibration only for a mark of its own", () => {
  assert.equal(n1Problem(["docs: another session's work"], "", "/e/jir-annotator-1", true), null, "another session's commit is recorded, not taken for this run's");
  // An auto-backup under another session's commit is still found: every commit that arrived is read.
  assert.match(n1Problem(["fix: on top", "Auto-backup: 2 file(s) updated at 2026-09-25 14:00"], "", "/e/jir-annotator-1", true)!, /auto-backup/);
  assert.match(n1Problem([], '{"cwd":"/e/jir-annotator-1"}', "/e/jir-annotator-1", true)!, /audit log/);
  assert.match(n1Problem([], "", "/e/jir-annotator-1", false)!, /could be counted/);
});

test("the pool rows' screen never spends the budget the verdict needs", () => {
  // Every labeller's answer fails (12 runs a case if it were asked before the verdict), and the budget
  // is just what the writers and the twenty checks take: the verdict is still reached.
  const { deps } = fakes();
  const broken: CalDeps = { ...deps, annotate: (system, request) => (system === LABEL_SYSTEM ? { counted: false, why: "x", sent: { system, request, bytes: 0 }, model: [] } : deps.annotate(system, request)) };
  const c = calibrate(candidates(10), broken, CAL.maxRuns - 30);
  assert.equal(c.verdict, "pass", c.why);
  assert.ok(c.recordsCut > 0);
});

test("an attempt that stopped leaves its record, and the next one counts its runs: stopping never gives the budget back", () => {
  assert.deepEqual(nextAttempt([]), { number: 1, spent: 0 });
  assert.deepEqual(nextAttempt([{ counts: { runs: 5 }, n1: {} }]), { number: 2, spent: 5 });
  // Each record's runs are the total so far: 5, then 10 after a second attempt of 5 — not 15.
  assert.deepEqual(nextAttempt([{ counts: { runs: 5 }, n1: {} }, { counts: { runs: 10 }, spentBefore: 5, n1: {} }]), { number: 3, spent: 10 });
  // An attempt the N=1 run stopped spent what came before it and that one run.
  assert.deepEqual(nextAttempt([{ counts: { runs: 5 }, n1: {} }, { spentBefore: 5, n1: {} }]), { number: 3, spent: 6 });
});

test("a calibration that stops keeps the verdict's answers it had", () => {
  // The budget runs out inside the twenty checks.
  const c = calibrate(candidates(10), fakes().deps, CAL.maxRuns - 15);
  assert.equal(c.verdict, "stopped");
  assert.equal(c.checked.length, 5, "the five checks answered before the budget ran out");
});

test("a planted requirement differs from its clean one by the name alone, and the check's request carries no kind", () => {
  const b = bundleFor(1);
  const fix = { ref: "o/r1#1", title: "t", body: "b", diff: "d" };
  const clean = [{ text: "load returns the read error.", quote: "Reading config 1 must fail loudly." }];
  const planted = plant(clean, "changed_fn_1");
  assert.equal(planted[0]!.text, "load returns the read error (the call in `changed_fn_1`).");
  const a = checkRequest(b, fix, clean);
  const z = checkRequest(b, fix, planted);
  assert.equal(a.replace("load returns the read error.", "X"), z.replace("load returns the read error (the call in `changed_fn_1`).", "X"));
  assert.ok(!/planted|clean|kind/i.test(z));
});

test("the name to plant is a function the fix changed, from a hunk header or a fn line", () => {
  assert.equal(changedFunction("@@ -3,2 +3,2 @@ pub fn read_baseline(path: &Path) -> Result<()> {\n-a\n+b"), "read_baseline");
  assert.equal(changedFunction("@@ -3,2 +3,2 @@ impl Foo {\n+    pub(crate) async fn load(&self) {}\n"), "load");
  assert.equal(changedFunction("@@ -1 +1 @@\n-// a comment\n+// another"), null);
  assert.equal(changedFunction("diff --git a/src/latest_build.rs b/src/latest_build.rs\n@@ -1 +1 @@ fn newest() {\n-a\n+b"), "newest", "a name that only contains test_ is not a test file");
  // A test's function is not the fix's: skipped for the next file's.
  assert.equal(changedFunction("diff --git a/tests/load.rs b/tests/load.rs\n@@ -1 +1 @@ fn test_load() {\n-a\n+b\ndiff --git a/src/load.rs b/src/load.rs\n@@ -9 +9 @@ fn load() {\n-a\n+b"), "load");
});

test("a case whose name is already in the bundle, or has none, is not used", () => {
  const { deps } = fakes();
  const withName = { ...deps, bundle: (repo: string, number: number) => ({ ...bundleFor(number - 100), pull: { ...bundleFor(number - 100).pull, body: `Reading config ${number - 100} must fail loudly. See changed_fn_${number - 100}.` } }) };
  const c = calibrate(candidates(10), withName);
  assert.equal(c.verdict, "insufficient");
  assert.ok(c.cases.every((x) => /in the bundle already/.test(x.why ?? "")));
});

test("the labels: two of three decide, three different make cannot_label; only four labels keep a fix", () => {
  assert.equal(majority(["swallows_as_success", "propagates", "swallows_as_success"]), "swallows_as_success");
  assert.equal(majority(["swallows_as_success", "propagates", "other"]), "cannot_label");
  assert.equal(readLabel({ label: "nonsense" }), null);
  assert.deepEqual([...KEEP_LABELS].sort(), ["falls_back_or_degrades", "logs_or_warns", "records_or_handles_locally", "swallows_as_success"]);
  assert.ok(LABEL_SYSTEM.includes("the behaviour the fix changed, not the one it asks for"), "PROTOCOL.md's words");
});

test("dev's candidates are #80's kept labels, each once, in the pool's order", () => {
  const pool = { rows: [
    { id: "a/x#1", repo: "a/x", label: { label: "swallows_as_success" } },
    { id: "a/x#1", repo: "a/x", label: { label: "swallows_as_success" } },
    { id: "b/y#2", repo: "b/y", label: { label: "propagates" } },
    { id: "c/z#3", repo: "c/z", label: { label: "logs_or_warns" } },
    { id: "d/w#4", repo: "d/w" },
  ] };
  assert.deepEqual(devCandidates(pool as never).map((c) => `${c.repo}#${c.number}`), ["a/x#1", "c/z#3"]);
});

test("dev's extra search keeps the split's dev repositories and writes apart from the sealed search", () => {
  const hit = (repo: string, number: number): Hit => ({ number, title: "t", repository: { nameWithOwner: repo }, closedAt: "2026-08-01T00:00:00Z" });
  const hits = new Map([["ignored error", [hit("Dev/A", 1), hit("New/B", 2), hit("dev/c", 3)]]]);
  const d = devRowsOf(hits, new Set(["dev/a", "dev/c"]), 0);
  assert.deepEqual(d.rows.map((r) => r.ref), ["Dev/A#1", "dev/c#3"]);
  assert.equal(d.left.notDev, 1);
  assert.notEqual(DEV_SEARCH, SEARCH);
  // The sealed rows of the same hits are what they were.
  assert.deepEqual(rowsOf(hits, new Set(["dev/a", "dev/c"]), new Set(), 0).rows.map((r) => r.ref), ["New/B#2"]);
});
