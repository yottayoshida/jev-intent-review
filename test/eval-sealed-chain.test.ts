// The chain a sealed case is checked through before anything is sent (bench/eval/sealed.ts, ADR 0024),
// on a sandbox made here as a git repository: each link broken alone must refuse, and the untouched
// sandbox must pass — otherwise a check that always refuses would look like one that works.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { adjudicate, assertNoSettings, itemsOf, majority, readLabels, readSentences, sourceCopy, StopRun, type Item } from "../bench/eval/adjudicate.ts";
import { falseVersionsOf, pairsOf } from "../bench/eval/compare.ts";
import { Refused } from "../bench/eval/refused.ts";
import { batchFilesOf, checkCases, gitSandbox, leaks, openSet, prepareClone, sha256, stopRule, workOf, type BatchFile, type CheckedCase } from "../bench/eval/sealed.ts";
import type { SealedBatch, Split } from "../bench/eval/split.ts";
import type { CaseFile, VersionLog } from "../bench/acceptance/score.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitAll = (dir: string, msg: string) => {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
};

interface Built {
  dir: string;
  commit: string;
  lines: SealedBatch[];
  split: Split;
}

/**
 * A sandbox with batch b1 of #80: rows 4 and 53 kept (sealed; 53 read on a fork, `readAs`), row 107 kept
 * (sealed), row 9 kept (dev). `change` alters the tree after the verdicts' hashes are taken; `line` the
 * sha256 main records.
 */
function sandbox(change: (dir: string) => void = () => {}, line: (sha: string) => string = (s) => s): Built {
  const dir = mkdtempSync(join(tmpdir(), "jir-sealed-sb-"));
  git(dir, "init", "-q");
  const cases: Record<number, { repo: string; caseRepo: string }> = {
    4: { repo: "x/one", caseRepo: "https://github.com/x/one" },
    53: { repo: "x/source", caseRepo: "https://github.com/x/fork" },
    107: { repo: "x/three", caseRepo: "https://github.com/x/three" },
    9: { repo: "x/dev", caseRepo: "https://github.com/x/dev" },
  };
  const entries: BatchFile["entries"] = [{ order: 2, repo: "x/one", kept: false }];
  for (const [order, c] of Object.entries(cases)) {
    const d = join(dir, "cases", order);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "case.json"), JSON.stringify({ id: `cand-${order}`, repo: c.caseRepo, versions: {} }));
    writeFileSync(join(d, "spec.json"), `{"requirements":[{"id":"R1","text":"row ${order}"}]}`);
    writeFileSync(join(d, "verdict.json"), "{}");
    const files = Object.fromEntries(["case.json", "spec.json", "verdict.json"].map((n) => [n, sha256(readFileSync(join(d, n)))]));
    entries.push({ order: Number(order), repo: c.repo, kept: true, files_sha256: files });
  }
  mkdirSync(join(dir, "batches"));
  const batch = `${JSON.stringify({ measurement: "#80", id: "b1", from: 1, to: 200, entries }, null, 2)}\n`;
  writeFileSync(join(dir, "batches", "80-b1.json"), batch);
  change(dir);
  const commit = commitAll(dir, "sandbox");
  const salt = "5".repeat(40);
  const entry = (repo: string, side: "sealed" | "dev", readAs?: string) => ({ repo, side, fixed: false, why: ["t"], salt, batch: { measurement: "#80" as const, id: "b1" }, ...(readAs ? { readAs } : {}) });
  const split: Split = {
    protocolVersion: 4,
    what: "t",
    repos: [entry("x/one", "sealed"), entry("x/source", "sealed", "x/fork"), entry("x/three", "sealed"), entry("x/dev", "dev"), { ...entry("x/other", "sealed"), batch: { measurement: "#89", id: "r1" } }],
  };
  return { dir, commit, lines: [{ measurement: "#80", id: "b1", from: 1, to: 200, rows: 200, kept: 4, sha256: line(sha256(batch)) }], split };
}

/** Checks 1 to 3 on a built sandbox, opening its three sealed repositories. */
function check(b: Built, split = b.split) {
  const view = gitSandbox(b.dir);
  const files = batchFilesOf(view, b.commit, b.lines, "#80");
  return checkCases(view, b.commit, openSet(split, files, "#80", "sealed", 3), files);
}

const refuses = (f: () => unknown, pattern: RegExp) => assert.throws(f, (e: unknown) => e instanceof Refused && pattern.test((e as Error).message));

test("the untouched sandbox passes checks 1 to 3, in the number order of the rows", () => {
  const b = sandbox();
  assert.deepEqual(check(b).map((c) => [c.order, c.repo, c.id]), [[4, "x/one", "cand-4"], [53, "x/source", "cand-53"], [107, "x/three", "cand-107"]]);
});

test("check 1: a batch file that is not the one main holds the sha256 of is refused", () => {
  refuses(() => check(sandbox((d) => writeFileSync(join(d, "batches", "80-b1.json"), `${readFileSync(join(d, "batches", "80-b1.json"), "utf8")} `))), /not the file main holds/);
  refuses(() => check(sandbox(undefined, (s) => s.replace(/^./, s[0] === "0" ? "1" : "0"))), /not the file main holds/);
  refuses(() => check(sandbox((d) => rmSync(join(d, "batches", "80-b1.json")))), /has no batches\/80-b1.json/);
});

test("check 2: a case with a file changed, added or missing, or no directory at all, is refused", () => {
  refuses(() => check(sandbox((d) => writeFileSync(join(d, "cases", "4", "spec.json"), "{}"))), /not the file batch b1 holds/);
  refuses(() => check(sandbox((d) => writeFileSync(join(d, "cases", "53", "extra.patch"), "x"))), /1 not listed, 0 missing/);
  refuses(() => check(sandbox((d) => rmSync(join(d, "cases", "107", "verdict.json")))), /0 not listed, 1 missing/);
  refuses(() => check(sandbox((d) => rmSync(join(d, "cases", "107"), { recursive: true }))), /0 not listed, 3 missing/);
});

test("check 3: a case.json naming another repository, or a fork without its readAs, is refused", () => {
  refuses(() => check(sandbox((d) => writeFileSync(join(d, "cases", "4", "case.json"), JSON.stringify({ id: "cand-4", repo: "https://github.com/x/else", versions: {} })))), /not the file batch b1 holds|names x\/else/);
  const b = sandbox();
  const noReadAs: Split = { ...b.split, repos: b.split.repos.map((e) => (e.repo === "x/source" ? { ...e, readAs: undefined } : e)) };
  refuses(() => check(b, noReadAs), /names x\/fork, and the split's entry is x\/source/);
});

test("openSet: the first N by the number of each first kept row, compared as numbers, the measurement's own only", () => {
  const b = sandbox();
  const files = batchFilesOf(gitSandbox(b.dir), b.commit, b.lines, "#80");
  // As strings "107" < "4" < "53"; as numbers 4 < 53 < 107.
  assert.deepEqual(openSet(b.split, files, "#80", "sealed", 2).map((o) => o.order), [4, 53]);
  // #89's sealed entry is not #80's, and the dev one is not sealed.
  assert.deepEqual(openSet(b.split, files, "#80", "sealed", null).map((o) => o.repo), ["x/one", "x/source", "x/three"]);
  assert.deepEqual(openSet(b.split, files, "#80", "dev", null).map((o) => o.repo), ["x/dev"]);
  refuses(() => openSet(b.split, files, "#80", "sealed", 17), /holds 3 repositories of #80; 17 are opened/);
});

test("check 4: a case built with build-branches.sh must rebuild at case.json's SHAs; one built otherwise is measured at the rebuilt commits", () => {
  const repo = mkdtempSync(join(tmpdir(), "jir-sealed-cand-"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, "lib.rs"), "fn a() {}\n");
  const mb = commitAll(repo, "base");
  writeFileSync(join(repo, "lib.rs"), "fn a() { b(); }\n");
  const head = commitAll(repo, "pr");
  const work = workOf(mkdtempSync(join(tmpdir(), "jir-sealed-work-")));
  const dir = join(work.cases, "cand-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "defect-A.head.patch"), "--- a/lib.rs\n+++ b/lib.rs\n@@ -1 +1 @@\n-fn a() { b(); }\n+fn a() { let _ = b(); }\n");
  const build = (defectHead: string, recorded = true): CheckedCase => ({
    repo: "x/one",
    order: 1,
    id: "cand-1",
    caseFile: { id: "cand-1", repo, role: "unseen", ...(recorded ? { build: "bench/acceptance/build-branches.sh <clone> …" } : {}), versions: { shipped: { base: mb, head, targets: {}, expected: {} }, "defect-A": { base: mb, head: defectHead, targets: {}, expected: {} } } } as unknown as CaseFile,
  });
  // The SHA the script makes, then the same case with one character of it changed.
  refuses(() => prepareClone(build("0".repeat(40)), work), /rebuilt from its patches it is not case.json's/);
  const log = join(work.logs, "clone-cand-1.txt");
  assert.ok(!existsSync(log) || readFileSync(log, "utf8") === "", "a mismatch is not a failed command");
  const made = execFileSync("git", ["-C", join(work.clones, "cand-1"), "rev-parse", "refs/acceptance/cand-1-defect-A"], { encoding: "utf8" }).trim();
  assert.equal(prepareClone(build(made), work).clone, join(work.clones, "cand-1"));
  // Built another way (no `build` recorded): its own SHA cannot be made again, and the rebuilt commit is the version.
  const other = build("1".repeat(40), false);
  const r = prepareClone(other, work);
  assert.deepEqual(r.versions["defect-A"], { base: mb, head: made });
  assert.equal(other.caseFile.versions["defect-A"]!.head, made, "the case measured names the rebuilt commit");
  assert.equal(JSON.parse(readFileSync(join(dir, "case.json"), "utf8")).versions["defect-A"].head, made);
  // The label is in the commit message: a case built with `cand1-<version>` rebuilds only under that label.
  const templated = build("2".repeat(40), false);
  (templated.caseFile as { build?: string }).build = "bench/acceptance/build-branches.sh <clone> <merge-base> <pr-head> <this dir> <base-patch|-> <head-patch|-> cand1-<version>";
  assert.throws(() => prepareClone(templated, work), /not case.json's base and head/);
  const labelled = execFileSync("git", ["-C", join(work.clones, "cand-1"), "rev-parse", "refs/acceptance/cand1-defect-A"], { encoding: "utf8" }).trim();
  assert.notEqual(labelled, made, "another label, another commit");
  const again = build(labelled, false);
  (again.caseFile as { build?: string }).build = (templated.caseFile as { build?: string }).build;
  assert.equal(prepareClone(again, work).versions["defect-A"]!.head, labelled);
});

test("the stop rule: the same version failing twice, or five failures in all, stops", () => {
  const a = stopRule();
  a.fail("v1")("x");
  assert.throws(() => a.fail("v1")("x"), StopRun);
  const b = stopRule();
  for (const v of ["v1", "v2", "v3", "v4"]) b.fail(v)("x");
  assert.throws(() => b.fail("v5")("x"), /five runs/);
});

test("adjudication: two of three decide, three different make cannot_decide, answers must cover every item", () => {
  assert.equal(majority(["false", "false", "real_defect"]), "false");
  assert.equal(majority(["false", "real_defect", "duplicate"]), "cannot_decide");
  const items: Item[] = [
    { n: 1, file: "a.rs", function: "f", call: "g()", claim: "", by: ["jev"] },
    { n: 2, file: "a.rs", function: "h", call: "k()", claim: "", by: ["baseline"] },
  ];
  assert.equal(readLabels([{ n: 1, label: "false" }], items), null);
  assert.equal(readLabels([{ n: 1, label: "false" }, { n: 2, label: "maybe" }], items), null);
  assert.equal(readLabels([{ n: 1, label: "false" }, { n: 2, label: "real_defect" }], items)?.get(2), "real_defect");
  assert.equal(readSentences([{ n: 1, sentence: "s" }], items), null);
});

test("adjudication: a known target is not an item, one call is one item whichever system made it", () => {
  const t = { requirementId: "R1", file: "a.rs", function: "f", call: "g()" };
  const items = itemsOf([t], [[{ ...t, requirementId: "R1" }, { file: "a.rs", function: "h", call: "k()", requirementId: "R1", observation: "o" }]], [[{ file: "b/a.rs", function: "Type::h", call: "self.k()", claim: "c" }]]);
  // The baseline's quote of `k()` is another item (the call text differs); the jev row of `g()` is a known target.
  assert.deepEqual(items.map((i) => [i.call, i.by]), [["k()", ["jev"]], ["self.k()", ["baseline"]]]);
});

test("adjudication: a run that cannot be counted is taken again, and the stop rule is told", () => {
  const items: Item[] = [{ n: 1, file: "a.rs", function: "f", call: "g()", claim: "c", by: ["jev"] }];
  const answers = [
    { counted: false, why: "claude exited 1" },
    { counted: true, json: [{ n: 1, sentence: "In f of a.rs, when g() fails, …" }] },
    { counted: true, json: [{ n: 1, label: "false" }] },
    { counted: true, json: [{ n: 1, label: "not a label" }] },
    { counted: true, json: [{ n: 1, label: "false" }] },
    { counted: true, json: [{ n: 1, label: "real_defect" }] },
  ];
  const told: string[] = [];
  const toolsAsked: string[] = [];
  const r = adjudicate(items, "R", "/nowhere", "h", "/empty", (why) => told.push(why), {
    ask: (_s, _r, _cwd, tools) => (toolsAsked.push(tools), { sent: { system: "", request: "", bytes: 0 }, model: [], ...answers.shift()! }),
    sourceCopy: () => mkdtempSync(join(tmpdir(), "jir-src-")),
  });
  assert.deepEqual(told, ["claude exited 1", "the answer was not one label for every sentence"]);
  assert.equal(r.decided[1], "false");
  assert.deepEqual(toolsAsked, ["", "", "Read,Grep,Glob", "Read,Grep,Glob", "Read,Grep,Glob", "Read,Grep,Glob"], "the rewriter has no tools, the annotators read only");
});

test("the source copy holds no .git, .claude, CLAUDE.md or CLAUDE.local.md at any depth", () => {
  const repo = mkdtempSync(join(tmpdir(), "jir-src-repo-"));
  git(repo, "init", "-q");
  for (const p of ["src/lib.rs", "CLAUDE.md", "sub/CLAUDE.local.md", "sub/deep/CLAUDE.md", ".claude/settings.json", "sub/.claude/hooks.json"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "x");
  }
  const head = commitAll(repo, "c");
  const copy = sourceCopy(repo, head);
  const all = execFileSync("find", [copy], { encoding: "utf8" });
  assert.match(all, /src\/lib\.rs/);
  assert.doesNotMatch(all, /CLAUDE|\.claude|\.git/);
  // Its own check catches one put back.
  writeFileSync(join(copy, "sub", "CLAUDE.md"), "x");
  assert.throws(() => assertNoSettings(copy), /holds .*CLAUDE\.md/);
});

test("pairs and correct versions from the three logs: hits, budget 0, a known target, a finding judged false", () => {
  const t = { requirementId: "R1", file: "a.rs", function: "f", call: "g()" };
  const c = {
    id: "cand-1",
    repo: "https://github.com/x/one",
    role: "unseen",
    versions: {
      "defect-A": { base: "b", head: "d", targets: { A: t }, expected: { A: "listed" } },
      "defect-B": { base: "b", head: "e", targets: { B: { ...t, function: "k" } }, expected: { B: "listed" } },
      shipped: { base: "b", head: "h", targets: { A: t }, expected: { A: "not_listed" } },
    },
  } as unknown as CaseFile;
  const run = (findings: object[]) => ({ finished: true, requirements: [{ requirementId: "R1", observed: [], unchecked: [], mappings: [], findings }] });
  const v = (head: string, findings: object[]): VersionLog => ({ base: "b", head, enumeration: { wouldAsk: [t], unchecked: [], notes: [] }, runs: [run(findings), run(findings), run(findings)] as VersionLog["runs"] });
  const jev = { "defect-A": v("d", [t]), "defect-B": v("e", []), shipped: v("h", [{ ...t, function: "z", call: "q()" }]) };
  const counted = (findings: object[]) => ({ counted: true, findings, listed: findings.length, model: [], costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 });
  const baseline = {
    "defect-A": { budget: 100, runs: [counted([]), counted([]), counted([])] },
    "defect-B": { budget: 0, runs: [] },
    shipped: { budget: 100, runs: [counted([{ ...t, claim: "c" }]), counted([]), counted([])] },
  } as Parameters<typeof pairsOf>[3];
  assert.deepEqual(pairsOf("x/one", c, jev, baseline), [
    { repo: "x/one", place: "A", jev: true, baseline: false },
    { repo: "x/one", place: "B", jev: false, baseline: false },
  ]);
  // The baseline named the known target on shipped: false. jev's other call is judged false by the annotators.
  const judged = { shipped: { items: [{ n: 1, file: "a.rs", function: "z", call: "q()", claim: "", by: ["jev" as const] }], decided: { 1: "false" as const } } };
  assert.deepEqual(falseVersionsOf("x/one", c, jev, baseline, judged), [{ repo: "x/one", jev: true, baseline: true, jevKnown: { listed: 0, targets: 1 } }]);
  assert.deepEqual(falseVersionsOf("x/one", c, jev, baseline, { shipped: { ...judged.shipped, decided: { 1: "cannot_decide" } } })[0]!.jev, false, "cannot_decide is never false");
});

test("the report check finds a case's requirement, function or call, and passes numbers", () => {
  const c = { caseFile: { id: "cand-1", versions: { shipped: { targets: { A: { requirementId: "R1", file: "a.rs", function: "Store::persist_row", call: "write_all(buf)" } } } } } as unknown as CaseFile };
  const spec = () => ["a failure must reach the caller"];
  assert.deepEqual(leaks(JSON.stringify({ n: 3, recall: 0.5, cases: ["cand-1"] }), [c], spec), []);
  assert.deepEqual(leaks("persist_row", [c], spec), ["cand-1: a function"]);
  assert.deepEqual(leaks("x write_all(buf) y", [c], spec), ["cand-1: a call"]);
  assert.deepEqual(leaks("… a failure must reach the caller …", [c], spec), ["cand-1: a requirement"]);
});

test("the sandbox view lists the files under a directory at a commit, and reads one", () => {
  const b = sandbox();
  const view = gitSandbox(b.dir);
  assert.deepEqual(view.files(b.commit, "cases/4").sort(), ["case.json", "spec.json", "verdict.json"]);
  assert.equal(view.file(b.commit, "cases/4/none"), null);
  assert.ok(fileURLToPath(import.meta.url));
});

test("the confinement probe: reading inside is needed, reading outside stops, and the probe's own answer is checked", async () => {
  const { probeConfinement } = await import("../bench/eval/sealed.ts");
  const work = workOf(mkdtempSync(join(tmpdir(), "jir-probe-work-")));
  // A fake annotator that does what the file system lets it: reads a relative path in cwd, and an absolute one if `outside`.
  const annotator = (outside: boolean, inside = true) => (_s: string, request: string, cwd: string) => {
    const m = /Read the file (\S+?)\.?( in your working directory)?\.?$/.exec(request)!;
    const path = m[1]!.startsWith("/") ? m[1]! : join(cwd, m[1]!);
    const allowed = m[1]!.startsWith("/") ? outside : inside;
    return { counted: true, json: { content: allowed ? readFileSync(path, "utf8") : "" }, sent: { system: "", request, bytes: 0 }, model: [] };
  };
  assert.equal(probeConfinement(work, annotator(false)), null);
  assert.match(probeConfinement(work, annotator(true)) ?? "", /read a file outside/);
  assert.match(probeConfinement(work, annotator(false, false)) ?? "", /could not read its own working directory/);
});

test("a run is measured once in its directory: a second run of the same opening stops before sending", async () => {
  const { measureCases } = await import("../bench/eval/sealed.ts");
  const work = workOf(mkdtempSync(join(tmpdir(), "jir-once-")));
  writeFileSync(join(work.root, "jev.json"), JSON.stringify({ conditions: {}, cases: {} }));
  let measured = 0;
  const measure = async () => void (measured += 1);
  const input = { work, cases: [], limit: 0, n1: null, say: () => {} };
  await measureCases(input, measure);
  await assert.rejects(measureCases(input, measure), (e: unknown) => e instanceof StopRun && /already started/.test((e as Error).message));
  assert.equal(measured, 0);
});

test("the preflight refuses an annotator that reads outside its directory, before anything is sent", async () => {
  const { preflight } = await import("../bench/eval/sealed.ts");
  const work = workOf(mkdtempSync(join(tmpdir(), "jir-pre-")));
  const leaky = (_s: string, request: string, cwd: string) => {
    const path = /Read the file (\S+?)\.?( in your working directory)?\.?$/.exec(request)![1]!;
    return { counted: true, json: { content: readFileSync(path.startsWith("/") ? path : join(cwd, path), "utf8") }, sent: { system: "", request, bytes: 0 }, model: [] };
  };
  // The workspace this machine has is not CI's: a fixed state, with no commit arriving in between.
  const state = () => ({ originMain: "a subject", statusLines: 0, auditBytes: null });
  assert.match(preflight(work, leaky, state, () => []).problem ?? "", /outside its working directory/);
  // An auto-backup commit arriving during the probe refuses too, with a confined annotator.
  const confined = (_s: string, request: string, cwd: string) => ({ counted: true, json: { content: request.includes("/") ? "" : readFileSync(join(cwd, "inside.txt"), "utf8") }, sent: { system: "", request, bytes: 0 }, model: [] });
  assert.equal(preflight(work, confined, state, () => []).problem, null);
  assert.match(preflight(work, confined, state, () => ["Auto-backup: 3 file(s) updated"]).problem ?? "", /auto-backup/);
});

test("the source copy keeps no symbolic link, and a batch that lists no case.json is refused", () => {
  const repo = mkdtempSync(join(tmpdir(), "jir-link-"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, "lib.rs"), "x");
  execFileSync("ln", ["-s", "/etc/hosts", join(repo, "far")]);
  const copy = sourceCopy(repo, commitAll(repo, "c"));
  assert.deepEqual(execFileSync("find", [copy, "-type", "l"], { encoding: "utf8" }).trim(), "");
  assert.match(execFileSync("find", [copy], { encoding: "utf8" }), /lib\.rs/);
  // Straight at check 2: the batch's entry for row 4 lists no case.json.
  const b = sandbox();
  const view = gitSandbox(b.dir);
  const files = batchFilesOf(view, b.commit, b.lines, "#80");
  delete files.get("b1")!.entries.find((e) => e.order === 4)!.files_sha256!["case.json"];
  refuses(() => checkCases(view, b.commit, openSet(b.split, files, "#80", "sealed", 3), files), /row 4 \(x\/one\): batch b1 lists no case.json/);
});

test("a version jev sent nothing on gets the median of the budgets of the run's versions it sent on", async () => {
  const { medianBudget } = await import("../bench/eval/sealed.ts");
  const t = { requirementId: "R1", file: "a.rs", function: "f", call: "g()" };
  const ver = { base: "b", head: "h", targets: { A: t }, expected: { A: "listed" } };
  const c = (id: string) => ({ id, caseFile: { id, repo: "x", role: "unseen", versions: { shipped: ver, "defect-A": ver, "defect-B": ver } } as unknown as CaseFile });
  const runs = (...bytes: number[]) => bytes.map((b) => ({ finished: true, requirements: [], bytes: b }));
  const live = (bytes: number[]) => ({ base: "b", head: "h", enumeration: { wouldAsk: [t], unchecked: [], notes: [] }, runs: runs(...bytes) });
  const held = { base: "b", head: "h", enumeration: { wouldAsk: [], unchecked: [], notes: [] }, runs: [] };
  const jev = {
    conditions: {},
    // Budgets per live version: 200 (median of 100, 200, 300), 50, 1000; the held version is left out.
    cases: { one: { versions: { shipped: live([100, 200, 300]), "defect-A": held, "defect-B": live([50, 50, 50]) } }, two: { versions: { shipped: live([1000, 1000, 1000]), "defect-A": held, "defect-B": held } } },
  } as never;
  assert.equal(medianBudget([c("one"), c("two")], jev), 200);
  const none = { conditions: {}, cases: { one: { versions: { shipped: held, "defect-A": held, "defect-B": held } } } } as never;
  assert.equal(medianBudget([c("one")], none), null);
});

test("an answer's JSON is read with an explanation after it, and a step that never answers stops by itself", async () => {
  const { jsonIn, MAX_ATTEMPTS } = await import("../bench/eval/adjudicate.ts");
  // What an annotator answered on the rehearsal (dev row 53): a fenced block, then prose.
  assert.deepEqual(jsonIn('```json\n[{"n": 1, "label": "false"}]\n```\n\nThe sentence is wrong. In `write_all` only a `NotFound` error is ignored.'), [{ n: 1, label: "false" }]);
  assert.deepEqual(jsonIn('[{"n": 1, "sentence": "s"}]'), [{ n: 1, sentence: "s" }]);
  assert.deepEqual(jsonIn('Here: [{"n": 2, "label": "real_defect"}] — done.'), [{ n: 2, label: "real_defect" }]);
  assert.equal(jsonIn("no json at all"), undefined);
  const items: Item[] = [{ n: 1, file: "a.rs", function: "f", call: "g()", claim: "c", by: ["jev"] }];
  let asked = 0;
  const never = () => (asked++, { counted: false, why: "x", sent: { system: "", request: "", bytes: 0 }, model: [] });
  assert.throws(() => adjudicate(items, "R", "/nowhere", "h", "/empty", () => {}, { ask: never, sourceCopy: () => mkdtempSync(join(tmpdir(), "jir-src-")) }), (e: unknown) => e instanceof StopRun);
  assert.equal(asked, MAX_ATTEMPTS, "a fail that does not throw still stops at the cap");
});
