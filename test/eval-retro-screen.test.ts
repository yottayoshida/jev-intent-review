// bench/eval/retro/screen.ts (#89, RETRO.md v3): the sealed rows of a batch, and the yield check.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LaterFix } from "../bench/eval/retro/calibrate.ts";
import { checksAt } from "../bench/eval/retro/checks.ts";
import type { Bundle } from "../bench/eval/retro/material.ts";
import { CAUGHT_SYSTEM, CHECK_SYSTEM, LABEL_SYSTEM, WRITE_SYSTEM, type Answer } from "../bench/eval/retro/prompts.ts";
import { DIFF_NOT_SERVED, diffRefused, isGone } from "../bench/eval/retro/gh.ts";
import { batchProblem, COUNT_KEYS, countsOf, nextBatch, unplacedBatch, overSize, type RowRecord, reposWithinCap, SCREEN, screenRows, verdictsFile, writeRow, writeVerdicts, yieldVerdict, type Row, type ScreenDeps } from "../bench/eval/retro/screen.ts";

const MARK = "SECRET-ROW-TEXT";

/** What a row's fix does at each step, by its pull request number. */
interface Behaviour {
  skip?: string;
  noOrigin?: boolean;
  fixGap?: boolean;
  originGap?: boolean;
  label?: string;
  caught?: boolean;
  writes?: boolean;
  leaked?: boolean;
  checks?: "read" | "none" | "unknown";
  /** Answers that cannot be counted, for this row's annotator runs. */
  broken?: boolean;
  /** The fix's fetch throws, as `execFileSync` does, with the row's text on the error. */
  throws?: boolean;
  /** Which text is made larger than any request may send. */
  big?: "fixBody" | "originComments" | "originBody" | "diff";
}

const HUGE = "x".repeat(SCREEN.maxRequestBytes);
const bundleOf = (n: number, gap = false, big: "body" | "comments" | null = null): Bundle => ({ repo: "o/r", pull: { number: n, title: `${MARK} title ${n}`, body: `Reading config ${n} must fail loudly. ${MARK}${big === "body" ? HUGE : ""}`, comments: big === "comments" ? [HUGE] : [], reviews: [] }, issues: [], unavailable: gap ? ["#1 description"] : [] });

function fakes(by: Record<number, Behaviour>) {
  let runs = 0;
  const rowOf = (request: string) => Number(/config (\d+) must/.exec(request)?.[1] ?? /title (\d+)/.exec(request)?.[1]);
  const deps: ScreenDeps = {
    fix(repo, number): LaterFix | { skip: string } {
      const b = by[number] ?? {};
      if (b.throws) throw Object.assign(new Error(`gh failed on ${MARK}`), { stdout: MARK, stderr: MARK });
      if (b.skip) return { skip: b.skip };
      return { repo, number, ref: `${repo}#${number}`, title: MARK, body: MARK, diff: b.big === "diff" ? HUGE : MARK, mergedAt: "2026-09-02T00:00:00Z", base: "b", bundle: bundleOf(number, b.fixGap, b.big === "fixBody" ? "body" : null), label80: null };
    },
    origin: (fix) => (by[fix.number]?.noOrigin ? { number: null, why: "none" } : { number: fix.number, by: "named" }),
    bundle: (_repo, n) => bundleOf(n, by[n]?.originGap, by[n]?.big === "originComments" ? "comments" : by[n]?.big === "originBody" ? "body" : null),
    checks: (_repo, n) => {
      const s = by[n]?.checks ?? "read";
      return s === "read" ? { state: "read", items: ["ci: success"] } : { state: s };
    },
    annotate(system, request) {
      runs += 1;
      const b = by[rowOf(request)] ?? {};
      const answer = (json: unknown): Answer => ({ counted: true, json, sent: { system, request, bytes: request.length }, model: ["claude-opus-5-5"] });
      if (b.broken) return { counted: false, why: "not JSON", sent: { system, request, bytes: 0 }, model: [] };
      if (system === LABEL_SYSTEM) return answer({ label: b.label ?? "swallows_as_success", quote: "q" });
      if (system === CAUGHT_SYSTEM) return answer({ caught: b.caught ?? false, quote: "" });
      if (system === WRITE_SYSTEM) {
        const n = rowOf(request);
        return answer(b.writes === false ? { requirements: [], why: "nothing" } : { requirements: [{ text: `load ${n} returns the error.`, quote: `Reading config ${n} must fail loudly.` }] });
      }
      if (system === CHECK_SYSTEM) return answer({ leaked: b.leaked ? [{ requirement: 1, words: "w", found_in_fix: "f" }] : [] });
      throw new Error("unexpected system prompt");
    },
  };
  return { deps, runs: () => runs };
}

const rowsOf = (spec: [repo: string, n: number][]): Row[] => spec.map(([repo, n], i) => ({ order: i + 1, ref: `${repo}#${n}`, repo }));
const run = (rows: Row[], by: Record<number, Behaviour>, more: Partial<Parameters<typeof screenRows>[2]> = {}) =>
  screenRows(rows, fakes(by).deps, { maxRuns: 10_000, alreadyRun: 0, placed: new Set(), ...more });

test("a case is a row with its original and its screen kept; the writer and the checker are not filters", () => {
  const rows = rowsOf([["a/1", 1], ["a/2", 2], ["a/3", 3], ["a/4", 4], ["a/5", 5], ["a/6", 6], ["a/7", 7], ["a/8", 8]]);
  const r = run(rows, {
    1: { noOrigin: true },
    2: { fixGap: true },
    3: { label: "propagates" },
    4: { originGap: true },
    5: { writes: false },
    6: { leaked: true },
    7: { caught: true },
    8: {},
  });
  assert.equal(r.stopped, null);
  const by = Object.fromEntries(r.records.map((x) => [x.row, x]));
  assert.equal(by[1]!.why, "no original pull request");
  assert.equal(by[2]!.why, "the fix's own material is not complete");
  assert.equal(by[3]!.why, "screened out as propagates");
  assert.deepEqual([4, 5, 6, 7, 8].map((n) => by[n]!.outcome), ["case", "case", "case", "case", "case"]);
  assert.deepEqual([4, 5, 6, 8].map((n) => by[n]!.requirement), ["gap", "none", "left out by the check", "written"]);
  assert.equal(by[7]!.caught!.caught, true);
  const c = countsOf(r, 1000, rows.length);
  assert.equal(c.cases, 5, "every case counts toward kept, the caught one too");
  assert.equal(c.notCaught, 4, "the caught case is out of the yield's numerator");
  assert.equal(c.reposRead, 8);
});

test("a repository's later rows are skipped once it has a case, and counted among the rows read", () => {
  const rows = rowsOf([["a/x", 1], ["a/x", 2], ["b/y", 3], ["b/y", 4]]);
  const r = run(rows, { 1: {}, 3: { label: "propagates" }, 4: {} });
  assert.deepEqual(r.records.map((x) => [x.row, x.outcome, x.why ?? null]), [
    [1, "case", null],
    [2, "left out", "skipped: its repository has a case"],
    [3, "left out", "screened out as propagates"],
    // A row that fails leaves its repository's next row to be tried.
    [4, "case", null],
  ]);
  assert.equal(countsOf(r, 1000, rows.length).reposRead, 2, "the yield counts repositories, not rows");
});

test("a caught case still takes its repository's one case", () => {
  const r = run(rowsOf([["a/x", 1], ["a/x", 2]]), { 1: { caught: true }, 2: {} });
  assert.equal(r.records[1]!.why, "skipped: its repository has a case");
});

test("a repository another measurement placed is left out", () => {
  const r = run(rowsOf([["P/Q", 1]]), {}, { placed: new Set(["p/q"]) });
  assert.equal(r.records[0]!.why, "placed by another measurement");
});

test("the yield check is 3·c·M ≥ 68·r, read in integers, on a whole batch only", () => {
  assert.equal(yieldVerdict(1, 3, 68).go, true, "exactly 17");
  assert.equal(yieldVerdict(1, 3, 67).go, false, "just under 17");
  assert.equal(yieldVerdict(0, 0, 500).go, false);
  const y = yieldVerdict(10, 72, 900);
  assert.ok(Math.abs(y.projection - (10 / 72) * 900 * 0.75) < 1e-9);
  assert.ok(y.projectionLower < y.projection);
  const partial = run(rowsOf([["a/1", 1], ["a/2", 2]]), {}, { maxRuns: SCREEN.worstPerRow });
  assert.equal(countsOf(partial, 1000, 2).go, null, "no verdict from a batch that stopped");
});

test("M counts repositories in the first 800 rows only", () => {
  const rows = Array.from({ length: 801 }, (_, i) => ({ order: i + 1, repo: i < 800 ? `r/${i % 5}` : "late/one" }));
  assert.equal(reposWithinCap(rows), 5);
  assert.equal(reposWithinCap([...rows].reverse()), 5, "in recorded order, not the file's");
});

test("a row is started only when its worst case fits; the run stops between rows", () => {
  const rows = rowsOf([["a/1", 1], ["a/2", 2]]);
  const r = run(rows, {}, { maxRuns: SCREEN.worstPerRow + 5 });
  assert.equal(r.records.length, 1);
  assert.match(r.stopped!, /^row 2: its worst case/);
  const resumed = run(rows, {}, { maxRuns: 1000, alreadyRun: r.runs, decided: r.records });
  assert.deepEqual(resumed.records.map((x) => x.row), [1, 2]);
});

test("an answer never counted stops the run and leaves that row undecided, to be asked again", () => {
  const rows = rowsOf([["a/1", 1], ["a/2", 2], ["a/3", 3]]);
  const r = run(rows, { 2: { broken: true } });
  assert.deepEqual(r.records.map((x) => x.row), [1]);
  assert.match(r.stopped!, /^row 2: an annotator gave no answer/);
  const f = fakes({});
  const again = screenRows(rows, f.deps, { maxRuns: 1000, alreadyRun: 0, placed: new Set(), decided: r.records });
  assert.deepEqual(again.records.map((x) => x.row), [1, 2, 3]);
  assert.equal(f.runs(), 16, "row 1 is not asked again: two cases of 8 runs");
});

test("nothing of a row reaches the counts or the stop reason, an error carrying the row's text included", () => {
  const rows = rowsOf([["a/1", 1], ["a/2", 2]]);
  const r = run(rows, { 2: { throws: true } });
  assert.match(r.stopped!, /^row 2: stopped at the fix by Error$/);
  const out = { batch: "b1", ...countsOf(r, 10, rows.length), sha256: null };
  assert.ok(!JSON.stringify(out).includes(MARK));
  assert.deepEqual(Object.keys(out).filter((k) => !(COUNT_KEYS as readonly string[]).includes(k)), []);
  // The records hold it, and are only written to the records directory.
  assert.ok(JSON.stringify(r.records).includes(MARK));
});

test("the command prints only the kind of an error", () => {
  const p = spawnSync(process.execPath, [join(import.meta.dirname, "..", "bench", "eval", "retro", "screen.ts"), "run", "c", "r", "not-a-number"], { encoding: "utf8" });
  assert.equal(p.stdout, "");
  assert.equal(p.stderr.trim(), "screen.ts stopped: Error");
});

test("the verdicts file lists every row file's sha256, and a changed byte is found", () => {
  const dir = mkdtempSync(join(tmpdir(), "jir-screen-"));
  const rows = rowsOf([["a/1", 1], ["a/2", 2]]);
  const r = run(rows, { 2: { label: "propagates" } });
  for (const rec of r.records) writeRow(dir, "b1", rec);
  const sha = writeVerdicts(dir, "b1", rows, countsOf(r, 10, rows.length));
  assert.equal(sha, createHash("sha256").update(readFileSync(verdictsFile(dir, "b1"))).digest("hex"));
  assert.equal(batchProblem(dir, "b1"), null);
  const file = join(dir, "89-b1", "2.json");
  const bytes = readFileSync(file);
  bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1;
  writeFileSync(file, bytes);
  assert.equal(batchProblem(dir, "b1"), "row 2's file is not the one hashed");
});

test("the checks at the merge: finished before it, none at all, or a list cut short", () => {
  const at = "2026-09-01T10:00:00Z";
  const runs = (items: { name: string; conclusion: string | null; completed_at: string | null }[], total = items.length) => ({ total, items });
  assert.deepEqual(checksAt({ mergedAt: at, runs: runs([{ name: "ci", conclusion: "failure", completed_at: "2026-09-01T09:00:00Z" }, { name: "late", conclusion: "success", completed_at: "2026-09-01T11:00:00Z" }]), statuses: [{ context: "lint", state: "success", updated_at: "2026-09-01T08:00:00Z" }] }), { state: "read", items: ["ci: failure", "lint: success"] });
  assert.deepEqual(checksAt({ mergedAt: at, runs: runs([]), statuses: [] }), { state: "none" });
  assert.deepEqual(checksAt({ mergedAt: at, runs: runs([], 150), statuses: [] }), { state: "unknown" });
  assert.deepEqual(checksAt({ mergedAt: null, runs: runs([]), statuses: [] }), { state: "unknown" });
});

test("every decided row is handed on as it is decided, with the runs and each row's worst case reserved first", () => {
  const rows = rowsOf([["a/1", 1], ["a/2", 2], ["a/3", 3]]);
  const seen: [number, number | null][] = [];
  const r = run(rows, { 2: { label: "propagates" }, 3: { broken: true } }, { progress: (runs: number, rec: RowRecord | null) => seen.push([runs, rec?.row ?? null]) });
  assert.deepEqual(seen, [
    [SCREEN.worstPerRow, null],
    [8, 1],
    [8 + SCREEN.worstPerRow, null],
    [11, 2],
    [11 + SCREEN.worstPerRow, null],
  ]);
  assert.equal(r.runs, 15, "row 3's four failed runs are spent, and counted");
  assert.ok(seen.every(([runs]) => runs >= 0) && Math.max(...seen.map(([runs]) => runs)) >= r.runs, "a kill midway never counts fewer runs than were spent");
});

test("another measurement's repositories are in neither r nor M", () => {
  const r = run(rowsOf([["P/Q", 1], ["a/1", 2]]), {}, { placed: new Set(["p/q"]) });
  assert.equal(countsOf(r, 10, 2).reposRead, 1);
  assert.equal(reposWithinCap([{ order: 1, repo: "P/Q" }, { order: 2, repo: "a/1" }], new Set(["p/q"])), 1);
});

const screenTs = join(import.meta.dirname, "..", "bench", "eval", "retro", "screen.ts");
/** The batch the real command reads next, from the lines main holds. */
const NEXT = nextBatch(JSON.parse(readFileSync(join(import.meta.dirname, "..", "bench", "eval", "sealed-batches.json"), "utf8")).batches).id;

test("nothing runs past the number allowed, the N=1 run included", () => {
  const dir = mkdtempSync(join(tmpdir(), "jir-screen-"));
  writeFileSync(join(dir, `89-${NEXT}.runs.json`), JSON.stringify({ runs: 40 }));
  const p = spawnSync(process.execPath, [screenTs, "run", "no-clones", dir, "40"], { encoding: "utf8" });
  assert.equal(p.stderr, "");
  assert.deepEqual(JSON.parse(p.stdout), { batch: NEXT, stopped: "40 of the 40 runs allowed are spent", runs: 40 });
  // Room for the N=1 run but not for a row after it: the N=1 run is not spent for nothing.
  const q = spawnSync(process.execPath, [screenTs, "run", "no-clones", dir, String(40 + SCREEN.worstPerRow)], { encoding: "utf8" });
  assert.equal(q.stderr, "");
  assert.equal(JSON.parse(q.stdout).runs, 40);
});

test("a batch whose verdicts are written is not run again", () => {
  const dir = mkdtempSync(join(tmpdir(), "jir-screen-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(verdictsFile(dir, NEXT), "{}");
  const p = spawnSync(process.execPath, [screenTs, "run", "no-clones", dir, "100"], { encoding: "utf8" });
  assert.equal(p.stdout, "");
  assert.equal(p.stderr.trim(), "screen.ts stopped: Error");
});

test("checks that exist but had not finished by the merge are read, as none of them; every run of a check is asked for", () => {
  assert.deepEqual(checksAt({ mergedAt: "2026-09-01T10:00:00Z", runs: { total: 1, items: [{ name: "ci", conclusion: "success", completed_at: "2026-09-01T11:00:00Z" }] }, statuses: [] }), { state: "read", items: [] });
  assert.match(readFileSync(join(import.meta.dirname, "..", "bench", "eval", "retro", "checks.ts"), "utf8"), /check-runs\?per_page=100&filter=all/);
});

test("only GitHub no longer having the pull request makes O's bundle a gap; a rate limit or the network stops", () => {
  assert.equal(isGone(new Error("o/r#5 did not merge")), true);
  assert.equal(isGone(Object.assign(new Error("Command failed"), { stderr: "gh: Could not resolve to a PullRequest with the number of 5." })), true);
  assert.equal(isGone(Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)" })), true);
  assert.equal(isGone(Object.assign(new Error("Command failed"), { stderr: "gh: API rate limit exceeded (HTTP 403)" })), false);
  assert.equal(isGone(Object.assign(new Error("Command failed"), { stderr: "gh: Gone (HTTP 410)" })), true);
  assert.equal(isGone(new Error("getaddrinfo ENOTFOUND api.github.com")), false);
});

test("a fix whose diff GitHub does not serve is a row whose fix's material is not complete", () => {
  const r = run(rowsOf([["a/1", 1], ["a/2", 2]]), { 1: { skip: DIFF_NOT_SERVED } });
  assert.equal(r.records[0]!.why, "the fix's own material is not complete");
  assert.equal(r.records[1]!.outcome, "case", "the run goes on to the next row");
  assert.equal(diffRefused(Object.assign(new Error("Command failed"), { stderr: "gh: Sorry, the diff exceeded the maximum number of lines (20000) (HTTP 406)" })), true);
  assert.equal(diffRefused(Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)" })), false);
});

test("a clones directory holding a partial clone is refused", async () => {
  const { realCalDeps } = await import("../bench/eval/retro/calibrate.ts");
  const clones = mkdtempSync(join(tmpdir(), "jir-clones-"));
  const dir = join(clones, "o__r");
  mkdirSync(dir);
  spawnSync("git", ["init", "-q", dir]);
  spawnSync("git", ["-C", dir, "config", "remote.origin.partialclonefilter", "blob:none"]);
  const deps = realCalDeps(clones, new Map(), tmpdir());
  const fix = { repo: "o/r", number: 1, ref: "o/r#1", title: "", body: "", diff: "", mergedAt: "2026-09-01T00:00:00Z", base: "HEAD", bundle: bundleOf(1), label80: null };
  assert.throws(() => deps.origin(fix), /a partial clone is in the clones directory/);
});

test("a request over the size is not sent, and each step counts it against the tool", () => {
  const rows = rowsOf([["a/1", 1], ["a/2", 2], ["a/3", 3], ["a/4", 4]]);
  const seen: [number, number | null][] = [];
  const r = run(rows, { 1: { big: "fixBody" }, 2: { big: "originComments" }, 3: { big: "originBody" }, 4: { big: "diff" } }, { progress: (runs: number, rec: RowRecord | null) => seen.push([runs, rec?.row ?? null]) });
  assert.equal(r.stopped, null);
  const by = Object.fromEntries(r.records.map((x) => [x.row, x]));
  assert.equal(by[1]!.why, "the screen's request is over the size sent", "the screen cannot read the fix: the row is left out");
  assert.deepEqual([by[2]!.caught!.caught, by[2]!.caught!.overSize, by[2]!.requirement], [false, true, "not sent: over the size"], "not caught, so in the denominator; no requirement");
  assert.deepEqual([by[3]!.caught!.caught, by[3]!.caught!.overSize, by[3]!.requirement], [false, undefined, "not sent: over the size"], "only the writer's request is over");
  assert.equal(by[4]!.requirement, "not sent: over the size", "a requirement the check could not read counts as not written");
  // Runs, decided row by decided row: nothing spent on a request not sent.
  assert.deepEqual(seen.filter(([, row]) => row !== null).map(([runs, row]) => [row, runs]), [[1, 0], [2, 3], [3, 9], [4, 16]]);
  const c = countsOf(r, 100, 4);
  assert.equal(c.notCaught, 3);
  assert.deepEqual(c.requirement, { "not sent: over the size": 3 });
  assert.deepEqual(by[1]!.notSent!.map((n) => n.step), ["the screen"]);
  assert.deepEqual(by[2]!.notSent!.map((n) => n.step), ["caught before the merge", "the requirement"]);
  assert.deepEqual(by[4]!.notSent!.map((n) => n.step), ["the check"]);
  assert.ok(by[4]!.notSent![0]!.bytes > SCREEN.maxRequestBytes);
  assert.equal(by[3]!.caught!.overSize, undefined);
});

test("the cap: exactly the most bytes is sent, one byte more is not", () => {
  const system = "s".repeat(1000);
  assert.equal(overSize(system, "r".repeat(SCREEN.maxRequestBytes - 1000)), null);
  assert.equal(overSize(system, "r".repeat(SCREEN.maxRequestBytes - 999)), SCREEN.maxRequestBytes + 1);
  assert.equal(overSize("", "é".repeat(SCREEN.maxRequestBytes / 2 + 1)), SCREEN.maxRequestBytes + 2, "bytes, not characters");
});

test("the next batch reads on from the last row main holds, named in order", () => {
  const line = (measurement: "#80" | "#89", id: string, from: number, to: number) => ({ measurement, id, from, to, rows: to - from + 1, kept: 0, sha256: "a".repeat(64) });
  assert.deepEqual(nextBatch([]), { id: "b1", from: 1, to: 100 });
  assert.deepEqual(nextBatch([line("#80", "b1", 1, 100), line("#80", "b2", 101, 200), line("#89", "b1", 1, 100)]), { id: "b2", from: 101, to: 200 }, "#80's lines are not this measurement's");
  assert.deepEqual(nextBatch([line("#89", "b1", 1, 100), line("#89", "b2", 101, 200)]), { id: "b3", from: 201, to: 300 });
});

test("a repository with a case from an earlier batch is skipped, not left out as another measurement's", () => {
  const r = run(rowsOf([["Old/Case", 1], ["a/2", 2]]), {}, { hasCase: new Set(["old/case"]) });
  assert.equal(r.records[0]!.why, "skipped: its repository has a case");
  assert.equal(r.records[1]!.outcome, "case");
  assert.equal(countsOf(r, 10, 2).reposRead, 2, "the skipped repository was read");
});

test("a batch line out of order, or past the cap, stops the next batch", () => {
  const line = (id: string, from: number, to: number) => ({ measurement: "#89" as const, id, from, to, rows: to - from + 1, kept: 0, sha256: "a".repeat(64) });
  assert.throws(() => nextBatch([line("b1", 1, 100), line("b3", 101, 200)]), /is b3 101-200, not b2 101-200/);
  assert.throws(() => nextBatch([line("b1", 1, 100), line("b2", 150, 249)]), /not b2 101-200/);
  const eight = Array.from({ length: 8 }, (_, i) => line(`b${i + 1}`, i * 100 + 1, (i + 1) * 100));
  assert.throws(() => nextBatch(eight), /800 rows have been examined/);
  assert.deepEqual(nextBatch(eight.slice(0, 7)), { id: "b8", from: 701, to: 800 });
});

test("the next batch waits until every earlier batch's repositories are placed", () => {
  const b1 = { measurement: "#89" as const, id: "b1", from: 1, to: 100, rows: 100, kept: 2, sha256: "a".repeat(64) };
  const entry = (repo: string) => ({ repo, side: "sealed" as const, fixed: false, why: ["t"], salt: "s", batch: { measurement: "#89" as const, id: "b1" } });
  assert.match(unplacedBatch([b1], { repos: [entry("x/one")] })!, /kept 2 and 1 are on the split/);
  assert.equal(unplacedBatch([b1], { repos: [entry("x/one"), entry("x/two")] }), null);
  assert.equal(unplacedBatch([], { repos: [] }), null);
});

test("the yield check is given on b1 only", () => {
  const rows = rowsOf([["a/1", 1]]);
  const r = run(rows, {});
  assert.notEqual(countsOf(r, 100, 1).go, null);
  const later = countsOf(r, 100, 1, false);
  assert.deepEqual([later.go, later.projection, later.projectionLower], [null, null, null]);
});
