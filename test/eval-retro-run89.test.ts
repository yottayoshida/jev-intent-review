import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRetro, Refused, runRetro, type RetroDeps, type RetroPrepared } from "../bench/eval/run.ts";
import { caseFiles, foundAt, frozenProblem, measureRetro, recordsProblem, reportOf, screenedOf, type RetroCase } from "../bench/eval/retro/run89.ts";
import type { RowRecord } from "../bench/eval/retro/screen.ts";
import type { TargetRecord } from "../bench/eval/retro/target.ts";
import { perRunOf } from "../bench/acceptance/run.ts";
import { workOf } from "../bench/eval/sealed.ts";
import { validateIntentSpec } from "../src/intent/schema.ts";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const view = (files: Record<string, string>) => ({ file: (_c: string, p: string) => (p in files ? Buffer.from(files[p]!) : null), files: () => [] });

test("the records are refused when a verdicts file or a row's record is not the one main holds", () => {
  const row = JSON.stringify({ row: 3 });
  const verdicts = JSON.stringify({ rows: [{ row: 3, sha256: sha(row) }] });
  const good = { "batches/89-b1.json": verdicts, "batches/89-b1/3.json": row };
  const line = [{ measurement: "#89", id: "b1", sha256: sha(verdicts) }];
  assert.equal(recordsProblem(view(good) as never, "c", line), null);
  // #80's lines are not this measurement's.
  assert.equal(recordsProblem(view({}) as never, "c", [{ measurement: "#80", id: "b1", sha256: "x" }]), null);
  assert.match(recordsProblem(view({}) as never, "c", line)!, /no verdicts/);
  assert.match(recordsProblem(view(good) as never, "c", [{ ...line[0]!, sha256: "x" }])!, /not the ones main holds/);
  assert.match(recordsProblem(view({ ...good, "batches/89-b1/3.json": "{}" }) as never, "c", line)!, /row 3's record/);
  assert.match(recordsProblem(view({ "batches/89-b1.json": verdicts }) as never, "c", line)!, /row 3's record/);
});

test("the frozen targets are refused unless main's hash, main's verdicts and the rows worked out again all agree", () => {
  const text = JSON.stringify({ verdicts: { b1: "v1" }, cases: [{ row: 2 }, { row: 5 }] });
  const f = Buffer.from(text);
  const line = { file: "batches/89-targets.json", sha256: sha(text) };
  assert.deepEqual((frozenProblem(f, line, { b1: "v1" }, [2, 5]) as TargetRecord[]).map((c) => c.row), [2, 5]);
  assert.match(frozenProblem(null, line, { b1: "v1" }, [2, 5]) as string, /not in the sandbox/);
  assert.match(frozenProblem(f, { ...line, sha256: "x" }, { b1: "v1" }, [2, 5]) as string, /not the ones main holds/);
  assert.match(frozenProblem(f, line, { b1: "v2" }, [2, 5]) as string, /other verdicts/);
  assert.match(frozenProblem(f, line, { b1: "v1" }, [2, 6]) as string, /not the ones the verdicts and the split give/);
  // Order counts: the first 17 by row.
  assert.match(frozenProblem(f, line, { b1: "v1" }, [5, 2]) as string, /not the ones the verdicts/);
});

const target = { file: "src/a.rs", function: "load", call: "read(p)", quote: "" } as TargetRecord["target"] & {};
const rec = (over: Partial<RowRecord> = {}): RowRecord => ({ row: 7, ref: "r", repo: "x/one", outcome: "case", requirement: "written", requirements: [{ text: "a failure to read is returned" }, { text: "a missing file is reported" }] as never, answers: [], ...over }) as RowRecord;
const trec = (over: Partial<TargetRecord> = {}): TargetRecord => ({ row: 7, ref: "r", repo: "x/one", origin: 12, landed: { base: "b", head: "h" } as never, target, answers: [], ...over });

test("a case's files hold the target once under each requirement, and nothing without a requirement or a target", () => {
  const { id, caseFile, spec } = caseFiles(trec(), rec(), "sealed");
  assert.equal(id, "c89-7");
  // The tool reads it: the spec passes its own schema, with the requirements as they were written.
  const read = validateIntentSpec(JSON.parse(JSON.stringify(spec)), "spec.json");
  assert.deepEqual(read.requirements.map((r) => [r.id, r.text]), [["R1", "a failure to read is returned"], ["R2", "a missing file is reported"]]);
  assert.equal(read.title, "c89-7");
  assert.deepEqual(spec.requirements.map((r) => r.id), ["R1", "R2"]);
  assert.deepEqual(Object.keys(caseFile.versions.shipped.targets), ["T-R1", "T-R2"]);
  assert.equal(caseFile.versions.shipped.targets["T-R2"]!.requirementId, "R2");
  assert.equal(caseFile.role, "unseen");
  assert.equal(caseFiles(trec(), rec(), "dev").caseFile.role, "regression");
  assert.deepEqual(caseFiles(trec({ target: null }), rec(), "sealed").caseFile.versions.shipped.targets, {});
  const none = caseFiles(trec(), rec({ requirement: "none" as never, requirements: undefined }), "sealed");
  assert.deepEqual(none.spec.requirements, []);
  assert.deepEqual(none.caseFile.versions.shipped.targets, {});
});

/** A repository whose one commit adds `src/a.rs`, and a work directory. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jir-run89-"));
  const clone = join(root, "repo");
  mkdirSync(join(clone, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(clone, "README"), "x\n");
  git("add", "."), git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(clone, "src", "a.rs"), "fn load() { read(p); }\nfn save() {\n    write_all(\n        buf,\n        len,\n    );\n}\n");
  git("add", "."), git("commit", "-q", "-m", "o");
  const head = git("rev-parse", "HEAD");
  const work = workOf(join(root, "work"));
  return { root, clone, base, head, work };
}

const finding = (call: string) => ({ file: "src/a.rs", function: "load", call });
const runOf = (calls: string[][], finished = true) => ({
  finished,
  started: "2026-09-28T00:00:00Z",
  ended: "2026-09-28T00:00:10Z",
  requests: 10,
  bytes: 100,
  requirements: calls.map((cs, i) => ({ requirementId: `R${i + 1}`, findings: cs.map(finding), observed: cs.map((c) => ({ ...finding(c), result: { observation: `claim ${c}` } })) })),
});

test("the run measures every case with a requirement, always, and adjudicates the other calls under the first requirement that listed them", async () => {
  const f = fixture();
  try {
    const c: RetroCase = { repo: "x/one", order: 7, id: "c89-7", caseFile: {} as never, clone: f.clone, target, requirements: [{ id: "R1", text: "one" }, { id: "R2", text: "two" }], originBy: "named", landed: { base: f.base, head: f.head } };
    const noReq: RetroCase = { ...c, order: 8, id: "c89-8", requirements: [], clone: "" };
    const unread: RetroCase = { ...c, order: 9, id: "c89-9", clone: "", target: null, whyNotNamed: "O cannot be read", landed: null };
    mkdirSync(join(f.work.cases, c.id), { recursive: true });
    writeFileSync(join(f.work.cases, c.id, "spec.json"), "{}");
    const measured: { id: string; always?: boolean }[] = [];
    const measure = async (id: string, _clone: string, _limit: number, log: { file: string }, opts: { always?: boolean }) => {
      measured.push({ id, ...opts });
      const runs = [runOf([["read(p)", "open(q)"], ["open(q)", "close(r)"]]), runOf([["read(p)"], []]), runOf([["read (p)?"], ["close(r)"]]), runOf([["other(s)"], []], false)];
      writeFileSync(log.file, JSON.stringify({ conditions: {}, cases: { [id]: { versions: { shipped: { runs } } } } }));
    };
    const asked: { reqText: string; calls: string[]; claims: string[] }[] = [];
    const adj = ((items: { n: number; call: string; claim: string }[], reqText: string) => {
      asked.push({ reqText, calls: items.map((i) => i.call), claims: items.map((i) => i.claim) });
      return { decided: Object.fromEntries(items.map((i) => [i.n, i.call.startsWith("open") ? "real_defect" : "false"])) };
    }) as never;
    const m = await measureRetro(f.work, [c, noReq, unread], 999, measure as never, async () => [{ requirementId: "R1", wouldAsk: [finding("read(p)")] }], adj);
    assert.deepEqual(measured, [{ id: "c89-7", always: true, perRun: perRunOf(2) }]);
    // The unfinished run's call is not adjudicated; `open(q)` goes under R1, `close(r)` under R2.
    assert.deepEqual(asked, [
      { reqText: "one", calls: ["open(q)"], claims: ["claim open(q)"] },
      { reqText: "two", calls: ["close(r)"], claims: ["claim close(r)"] },
    ]);
    const s = m.cases.find((x) => x.row === 7)!;
    assert.equal(s.covered, true);
    assert.equal(s.inDiff, true);
    assert.equal(s.foundAtHead, true);
    assert.equal(s.runs.length, 4);
    assert.equal(s.runs[0]!.seconds, 10);
    assert.deepEqual(s.adjudicated.map((a) => a.label), ["real_defect", "false"]);
    assert.deepEqual(m.cases.map((x) => x.row), [7, 8, 9]);
    assert.equal(m.cases[1]!.runs.length, 0);
    assert.equal(m.cases[2]!.whyNotNamed, "O cannot be read");
    // Detected: listed in the three counted runs (the third as `read (p)?`), the fourth not finished.
    const r = reportOf(m, [c, noReq, unread], "sealed", () => () => true);
    assert.equal(r.score.detected, 1);
    assert.equal(r.score.cases, 3);
    assert.deepEqual(r.score.guards, { falsePerPullRequest: 1, precision: 2 / 3, runCases: 1 });
    for (const file of ["jev.json", "adjudication.json", "scored.json"]) JSON.parse(readFileSync(join(f.work.root, file), "utf8"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the report holds only its own words: a case's text anywhere in it is refused, and a target named like one of those words is not", () => {
  // A function named `read` or `cost`, words the report holds: nothing refuses it, as nothing of it is in the report.
  const c: RetroCase = { repo: "x/secretrepo", order: 7, id: "c89-7", caseFile: {} as never, clone: "", target: { file: "a.rs", function: "cost", call: "read(p)" }, requirements: [{ id: "R1", text: "a secret requirement text" }], originBy: "named", landed: null };
  const m = { jev: {} as never, cases: [{ row: 7, originBy: "named", hasRequirement: true, target: c.target, whyNotNamed: undefined, covered: false, runs: [], adjudicated: [] }], failures: [] };
  const screened = { cases: 3, caughtBeforeMerge: 1, checksUnknown: 1 };
  const r = reportOf(m, [c], "sealed", () => () => true, screened);
  assert.equal(r.score.cases, 1);
  assert.equal(r.repositories, 1);
  assert.deepEqual(r.screened, screened);
  for (const [over, where] of [
    [{ originBy: "a secret requirement text" }, /score\.byOrigin/],
    [{ target: null, whyNotNamed: "x/secretrepo" }, /score\.notNamed/],
  ] as const) {
    const leaky = { ...m, cases: [{ ...m.cases[0]!, ...over }] };
    assert.throws(() => reportOf(leaky as never, [c], "sealed", () => () => true), (e: Error) => where.test(e.message) && !e.message.includes("secret"));
  }
  // Every way O was found and every reason a target was not named is a word the report may hold.
  const all = ["named", "blame", "unknown"].map((by, i) => ({ ...m.cases[0]!, row: i, originBy: by, target: null, whyNotNamed: "O cannot be read" }));
  assert.equal(reportOf({ ...m, cases: all as never }, [c], "dev", () => () => true).score.cases, 3);
});

test("the screening counts are of the side's cases: caught before the merge, and checks unknown", () => {
  const split = { repos: [{ repo: "x/one", side: "sealed", batch: { measurement: "#89" } }, { repo: "x/two", side: "dev", batch: { measurement: "#89" } }] } as never;
  const records = [
    { row: 1, repo: "x/one", outcome: "case", caught: { caught: true, checks: "read" } },
    { row: 2, repo: "X/One", outcome: "case", caught: { caught: false, checks: "unknown" } },
    { row: 3, repo: "x/one", outcome: "left out" },
    { row: 4, repo: "x/two", outcome: "case", caught: { caught: true, checks: "unknown" } },
  ] as never;
  assert.deepEqual(screenedOf(records, split, "sealed"), { cases: 2, caughtBeforeMerge: 1, checksUnknown: 1 });
});

test("a target is found at O's head only with its file, its function and its call there", () => {
  const f = fixture();
  try {
    const all = () => true;
    assert.equal(foundAt(f.clone, f.head, target, all), true);
    assert.equal(foundAt(f.clone, f.head, { ...target, file: "src/b.rs" }, all), false);
    assert.equal(foundAt(f.clone, f.head, { ...target, function: "missing" }, all), false);
    assert.equal(foundAt(f.clone, f.head, { ...target, call: "write(p)" }, all), false);
    // rustfmt's comma after the last argument is not part of the call (RETRO.md v10).
    assert.equal(foundAt(f.clone, f.head, { file: "src/a.rs", function: "save", call: "write_all(buf, len)" }, all), true);
    // Not at the base: the file came with O.
    assert.equal(foundAt(f.clone, f.base, target, all), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

const prepared = (over: Partial<RetroPrepared> = {}): RetroPrepared => ({ repos: ["x/one", "x/two"], sandbox: { batches: "b".repeat(40) }, limit: 500, files: { "bench/eval/retro/score.ts": "s" }, ...over });

function world(over: Partial<RetroDeps> = {}) {
  let log = "";
  let main: string | null = "";
  let sent = 0;
  const pinnedWith: (Record<string, string> | undefined)[] = [];
  const deps: RetroDeps = {
    now: () => "2026-09-28T00:00:00Z",
    newRunId: () => "run-1",
    head: () => "a".repeat(40),
    dirty: () => "",
    manifest: () => "m",
    accessLogOnMain: () => main,
    readAccessLog: () => log,
    appendAccessLog: (line) => void (log += line),
    modelIdentity: () => ({ host: "cloudflare", requested: "jev" }),
    changedSince: () => ["bench/eval/sealed-access.jsonl"],
    prepare: async (_id, pinned) => (pinnedWith.push(pinned), prepared()),
    build: () => "dist",
    measure: async () => (sent++, { file: "bench/eval/logs/r.json", sha256: "r", answeredBy: [], results: { "jev.json": "j" } }),
    ...over,
  };
  return { deps, pinnedWith, merge: () => void (main = log), setMain: (s: string) => void (main = s), get log() { return log; }, get sent() { return sent; } };
}

const refuses = (f: () => Promise<unknown>, p: RegExp) => assert.rejects(f, (e: unknown) => e instanceof Refused && p.test((e as Error).message));

test("a #89 opening names #89, counts each repository's openings over every measurement, and runs only once it is on main", async () => {
  const w = world();
  await refuses(() => openRetro(w.deps, "no issue named", 9), /names #89/);
  assert.equal(w.log, "");
  // A repository opened before by #80 counts.
  w.setMain(`${JSON.stringify({ kind: "open", runId: "old", repos: ["x/one"] })}\n`);
  const line = await openRetro(w.deps, "#89 the retrospective", 9);
  assert.equal(line.measurement, "#89");
  assert.deepEqual(line.opened, { "x/one": 2, "x/two": 1 });
  assert.deepEqual(w.pinnedWith, [undefined]);
  await refuses(() => runRetro(w.deps, "run-1"), /not opened on origin\/main/);
  w.merge();
  const moved = world({ prepare: async () => prepared({ limit: 501 }) });
  moved.setMain(w.log);
  await refuses(() => runRetro(moved.deps, "run-1"), /limit/);
  assert.equal(moved.sent, 0);
  // A change to the tool between the opening and the run: the tool would not be the opening's.
  const built = world({ changedSince: () => ["bench/eval/sealed-access.jsonl", "src/cli.ts"] });
  built.setMain(w.log);
  await refuses(() => runRetro(built.deps, "run-1"), /1 file\(s\) changed since the run was opened/);
  assert.equal(built.sent, 0);
  const result = await runRetro(w.deps, "run-1");
  assert.equal(result.kind, "result");
  assert.deepEqual(w.pinnedWith.at(-1), { batches: "b".repeat(40) });
  assert.equal(w.sent, 1);
  await refuses(() => runRetro(w.deps, "run-1"), /has run already/);
});

test("#80's run refuses a #89 line, and #89's refuses #80's", async () => {
  const { runSealed } = await import("../bench/eval/run.ts");
  const w = world();
  await openRetro(w.deps, "#89", 9);
  w.merge();
  await refuses(() => runSealed({ ...w.deps, prepare: async () => { throw new Error("not reached"); } } as never, "run-1"), /opened for #89/);
  const other = world();
  other.setMain(`${JSON.stringify({ kind: "open", runId: "run-80", repos: ["x/one"] })}\n`);
  await refuses(() => runRetro(other.deps, "run-80"), /not opened for #89/);
});
