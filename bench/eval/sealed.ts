// The sealed cases, from the sandbox to the numbers (PROTOCOL.md, "Opening the sealed set"; ADR 0024).
//
// The cases live in the private jev-review-sandbox: each batch's verdicts on `batches`, the sealed cases
// on `sealed`, the dev ones on `dev`. Main holds each batch's sha256 (sealed-batches.json) and each
// repository's side (split.json). Before anything is sent, every case is checked through that chain:
//
//   1. the batch file's sha256 is main's line for the batch;
//   2. the case's directory holds exactly the files the batch's verdicts list, each with its sha256;
//   3. its repository — or the fork it was read on (`readAs`) — is on the split, on the side asked, and
//      one of the repositories opened;
//   4. every version rebuilt from its patches has case.json's base and head.
//
// Then jev-intent-review, the baseline of #88 and the adjudication run on those cases, in that order.
// What holds a case's content (the logs) is written under the run's own directory, outside the
// repository; what is printed is case ids and counts. Nothing here pushes or commits.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptanceLog } from "../acceptance/replay.ts";
import { isLive, RUNS, type CaseFile, type VersionLog } from "../acceptance/score.ts";
import { adjudicate, ANNOTATOR_TOOLS, ask, assertNoSettings, itemsOf, StopRun, type VersionAdjudication } from "./adjudicate.ts";
import { assertEmptyDir, budgetOf, gather, gitRepo, requirementOf, runClaude, userPrompt, type BaselineRun } from "./baseline.ts";
import { falseVersionsOf, jevRunsOf, judge, pairsOf, type AdjudicatedVersion, type BaselineVersion, type FalseVersion, type Pair } from "./compare.ts";
import { arrivedBetween, n1Problem, readAppended, workspaceState } from "./retro/calibrate.ts";
import type { SealedBatch, Split, SplitEntry } from "./split.ts";
import { Refused } from "./refused.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");

/** Rule 7: the sealed set stops at 17 repositories; the first 17 are opened, the rest kept (ADR 0024). */
export const OPEN_COUNT = 17;

export interface BatchEntry {
  order: number;
  repo: string;
  kept?: boolean;
  files_sha256?: Record<string, string>;
}

export interface BatchFile {
  measurement: string;
  id: string;
  entries: BatchEntry[];
}

/** What the check reads from a clone of the sandbox. A test puts a fake in. */
export interface SandboxView {
  /** The bytes of `path` at `commit`, or null when it is not there. */
  file(commit: string, path: string): Buffer | null;
  /** Every file under `dir` at `commit`, as paths relative to `dir`. */
  files(commit: string, dir: string): string[];
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const lower = (s: string) => s.toLowerCase();
/** A case's repository as split.json names it: `owner/repo`, lower case. */
export const caseRepo = (c: { repo: string }) => lower(c.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""));

/** Check 1: each batch file of the measurement, read at `commit`, is the one main holds the sha256 of. */
export function batchFilesOf(view: SandboxView, commit: string, lines: readonly SealedBatch[], measurement: SealedBatch["measurement"]): Map<string, BatchFile> {
  const out = new Map<string, BatchFile>();
  for (const line of lines.filter((l) => l.measurement === measurement)) {
    const path = `batches/${measurement.replace("#", "")}-${line.id}.json`;
    const bytes = view.file(commit, path);
    if (bytes === null) throw new Refused(`the sandbox's batches (${commit.slice(0, 7)}) has no ${path}`);
    if (sha256(bytes) !== line.sha256) throw new Refused(`${path} is not the file main holds the sha256 of (batch ${measurement} ${line.id})`);
    const file = JSON.parse(bytes.toString("utf8")) as BatchFile;
    if (file.id !== line.id || file.measurement !== measurement) throw new Refused(`${path} says it is batch ${file.measurement} ${file.id}`);
    out.set(line.id, file);
  }
  return out;
}

/** A repository opened: its split entry, and the row its case was built from. */
export interface Opened {
  repo: string;
  order: number;
  batch: string;
  entry: SplitEntry;
}

/**
 * The repositories of `side` placed by `measurement`'s batches, each with the number of its first kept
 * row, in order of that number; for the sealed side, the first `OPEN_COUNT` (ADR 0024). The number is
 * compared as a number: row 53 comes before row 107.
 */
export function openSet(split: Split, files: ReadonlyMap<string, BatchFile>, measurement: SealedBatch["measurement"], side: "sealed" | "dev" = "sealed", count: number | null = OPEN_COUNT): Opened[] {
  const placed = split.repos.filter((e) => !e.fixed && e.side === side && e.batch?.measurement === measurement);
  const out = placed.map((entry): Opened => {
    const file = files.get(entry.batch!.id);
    if (file === undefined) throw new Refused(`${entry.repo} names batch ${measurement} ${entry.batch!.id}, which main does not record`);
    const rows = file.entries.filter((e) => e.kept === true && lower(e.repo) === entry.repo).map((e) => e.order);
    if (rows.length === 0) throw new Refused(`${entry.repo} is on the split under batch ${entry.batch!.id}, whose verdicts keep no row of it`);
    return { repo: entry.repo, order: Math.min(...rows), batch: entry.batch!.id, entry };
  });
  out.sort((a, b) => a.order - b.order);
  if (count === null) return out;
  if (out.length < count) throw new Refused(`the ${side} side holds ${out.length} repositories of ${measurement}; ${count} are opened`);
  return out.slice(0, count);
}

export interface CheckedCase {
  repo: string;
  order: number;
  /** The case's directory name and case.json's id. */
  id: string;
  caseFile: CaseFile & { pr?: number; prHead?: string };
}

/**
 * Checks 2 and 3 for each repository opened: the directory `cases/<order>` at `commit` holds exactly the
 * files its batch entry lists, each with its sha256, and its case.json names the repository or the fork
 * it was read on. Returns the cases in the order given.
 */
export function checkCases(view: SandboxView, commit: string, opened: readonly Opened[], files: ReadonlyMap<string, BatchFile>): CheckedCase[] {
  const out: CheckedCase[] = [];
  for (const o of opened) {
    const entry = files.get(o.batch)!.entries.find((e) => e.order === o.order);
    const listed = entry?.files_sha256;
    if (listed === undefined || Object.keys(listed).length === 0) throw new Refused(`row ${o.order} (${o.repo}) has no file hashes in batch ${o.batch}`);
    if (listed["case.json"] === undefined || listed["spec.json"] === undefined) throw new Refused(`row ${o.order} (${o.repo}): batch ${o.batch} lists no case.json or spec.json`);
    const dir = `cases/${o.order}`;
    const present = view.files(commit, dir).sort();
    const expected = Object.keys(listed).sort();
    if (JSON.stringify(present) !== JSON.stringify(expected)) {
      const extra = present.filter((p) => !expected.includes(p));
      const missing = expected.filter((p) => !present.includes(p));
      throw new Refused(`${dir} does not hold the files batch ${o.batch} lists (${extra.length} not listed, ${missing.length} missing)`);
    }
    for (const name of expected) {
      const bytes = view.file(commit, `${dir}/${name}`)!;
      if (sha256(bytes) !== listed[name]) throw new Refused(`${dir}/${name} is not the file batch ${o.batch} holds the sha256 of`);
    }
    const caseFile = JSON.parse(view.file(commit, `${dir}/case.json`)!.toString("utf8")) as CheckedCase["caseFile"];
    const named = caseRepo(caseFile);
    const as = o.entry.readAs === undefined ? undefined : lower(o.entry.readAs);
    if (named !== o.repo && named !== as) throw new Refused(`${dir}/case.json names ${named}, and the split's entry is ${o.repo}${as ? ` (read on ${as})` : ""}`);
    if (out.some((c) => c.id === caseFile.id)) throw new Refused(`two cases have the id ${caseFile.id}`);
    out.push({ repo: o.repo, order: o.order, id: caseFile.id, caseFile });
  }
  return out;
}

/** A clone of the sandbox at `dir`, read through git, never checked out. */
export function gitSandbox(dir: string): SandboxView {
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return {
    file: (commit, path) => {
      try {
        return git(["show", `${commit}:${path}`]);
      } catch {
        return null;
      }
    },
    files: (commit, d) =>
      git(["ls-tree", "-r", "--name-only", commit, "--", `${d}/`])
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((p) => p.slice(d.length + 1)),
  };
}

/** The run's directory: the sandbox clone, the cases, the clones, the logs, each tool's output. */
export interface Work {
  root: string;
  sandbox: string;
  cases: string;
  clones: string;
  logs: string;
  tmp: string;
}

export function workOf(root: string): Work {
  const w = { root, sandbox: join(root, "sb"), cases: join(root, "cases"), clones: join(root, "clones"), logs: join(root, "logs"), tmp: join(root, "tmp") };
  for (const d of [w.cases, w.clones, w.logs, w.tmp]) mkdirSync(d, { recursive: true });
  return w;
}

/** Runs a command with every output into `log`, never onto the terminal (they hold a case's paths). */
function quiet(cmd: string, args: string[], log: string, env: NodeJS.ProcessEnv = process.env, cwd?: string): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", env, cwd, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    writeFileSync(log, `${cmd} ${args.map((a) => (a.length > 80 ? "…" : a)).join(" ")}\nexit ${e.status}\n${e.stdout ?? ""}\n${e.stderr ?? ""}`, { flag: "a" });
    throw new Refused(`${cmd} failed; its output is in ${log}`);
  }
}

/** Clones the sandbox branches named at `commits` (or their tips) into `work.sandbox`, and returns the commits. */
export function fetchSandbox(work: Work, branches: readonly string[], pinned?: Record<string, string>): Record<string, string> {
  const log = join(work.logs, "sandbox.txt");
  if (!existsSync(join(work.sandbox, ".git"))) quiet("gh", ["repo", "clone", "yottayoshida/jev-review-sandbox", work.sandbox, "--", "--quiet", "--no-checkout"], log);
  quiet("git", ["-C", work.sandbox, "fetch", "--quiet", "origin", ...branches.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`)], log);
  return Object.fromEntries(
    branches.map((b) => {
      const tip = quiet("git", ["-C", work.sandbox, "rev-parse", `refs/remotes/origin/${b}`], log).trim();
      const at = pinned?.[b] ?? tip;
      quiet("git", ["-C", work.sandbox, "cat-file", "-e", `${at}^{commit}`], log);
      return [b, at];
    }),
  );
}

/** Writes each checked case's files into `work.cases/<id>`, where `measure` and the baseline read them. */
export function materialize(view: SandboxView, commit: string, cases: readonly CheckedCase[], work: Work): void {
  for (const c of cases) {
    const dir = join(work.cases, c.id);
    for (const name of view.files(commit, `cases/${c.order}`)) {
      const to = join(dir, name);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, view.file(commit, `cases/${c.order}/${name}`)!);
    }
  }
}

/**
 * Check 4: a full clone of the case's repository (every blob, so nothing is fetched once requests are
 * being sent), the pull request's head fetched, and every version rebuilt from its patches with
 * `build-branches.sh`. A case that records it was built so (case.json's `build` names the script) must
 * come out at case.json's base and head. A case built another way cannot: its commits carry another
 * author and date. Its version is then the rebuilt commits — the patches, whose sha256 check 2 held,
 * decide the content — and the case written for `measure` names them. Returns the clone and every
 * version's commits, which the opening line records and `run` must find again.
 */
export function prepareClone(c: CheckedCase, work: Work): { clone: string; versions: Record<string, { base: string; head: string }> } {
  const clone = join(work.clones, c.id);
  const log = join(work.logs, `clone-${c.id}.txt`);
  // A path is a local repository (the tests'); anything else is on GitHub.
  const url = c.caseFile.repo.startsWith("https://") || c.caseFile.repo.startsWith("/") ? c.caseFile.repo : `https://github.com/${c.caseFile.repo}`;
  if (!existsSync(join(clone, ".git"))) quiet("git", ["clone", "--quiet", url, clone], log);
  const shipped = c.caseFile.versions.shipped;
  if (shipped === undefined) throw new Refused(`${c.id} has no shipped version`);
  const has = (sha: string) => {
    try {
      execFileSync("git", ["-C", clone, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!has(shipped.head)) {
    try {
      quiet("git", ["-C", clone, "fetch", "--quiet", "origin", shipped.head], log);
    } catch {
      quiet("git", ["-C", clone, "fetch", "--quiet", "origin", `refs/pull/${c.caseFile.pr}/head`], log);
    }
  }
  if (!has(shipped.base) || !has(shipped.head)) throw new Refused(`${c.id}: the clone lacks the shipped base or head`);
  const dir = join(work.cases, c.id);
  const env = { ...process.env, TMPDIR: work.tmp };
  const build = (c.caseFile as { build?: unknown }).build;
  const reproducible = typeof build === "string" && build.includes("build-branches.sh");
  // The label is in each commit's message, so the SHAs come back only with the label the case was built
  // with: case.json's `build` ends with its template (`cand53-<version>`).
  const template = typeof build === "string" ? /(\S*<version>\S*)\s*$/.exec(build)?.[1] : undefined;
  const labelOf = (versionId: string) => (template === undefined ? `${c.id}-${versionId}` : template.replace("<version>", versionId));
  const versions: Record<string, { base: string; head: string }> = { shipped: { base: shipped.base, head: shipped.head } };
  for (const [versionId, v] of Object.entries(c.caseFile.versions)) {
    if (versionId === "shipped") continue;
    const base = existsSync(join(dir, `${versionId}.base.patch`)) ? `${versionId}.base.patch` : "-";
    const head = existsSync(join(dir, `${versionId}.head.patch`)) ? `${versionId}.head.patch` : "-";
    if (base === "-" && head === "-") throw new Refused(`${c.id} ${versionId} has no patch to build it from`);
    const got = quiet("bash", [join(ROOT, "bench", "acceptance", "build-branches.sh"), clone, shipped.base, shipped.head, dir, base, head, labelOf(versionId)], log, env).trim();
    const [b, h] = got.split(" ");
    if (!/^[0-9a-f]{40}$/.test(b ?? "") || !/^[0-9a-f]{40}$/.test(h ?? "")) throw new Refused(`${c.id} ${versionId}: build-branches.sh printed no base and head`);
    if (reproducible && got !== `${v.base} ${v.head}`) throw new Refused(`${c.id} ${versionId}: rebuilt from its patches it is not case.json's base and head`);
    versions[versionId] = { base: b!, head: h! };
  }
  // The case `measure` and the scoring read names the commits that were built, which are the ones measured.
  for (const [versionId, v] of Object.entries(versions)) Object.assign(c.caseFile.versions[versionId]!, v);
  writeFileSync(join(dir, "case.json"), `${JSON.stringify(c.caseFile, null, 2)}\n`);
  return { clone, versions };
}

// ---------------------------------------------------------------------------------------------
// Measuring.

export interface Measured {
  jev: AcceptanceLog;
  baseline: Record<string, Record<string, BaselineVersion & { budgetFrom?: string; requirementId: string; material: { bytes: number } }>>;
  adjudication: Record<string, Record<string, VersionAdjudication>>;
  pairs: Pair[];
  falseVersions: FalseVersion[];
  n1: { before: unknown; after: unknown; problem: string | null } | null;
  failures: string[];
}

/** The stop rule (ADR 0024): the same version failing twice, or five failures in all, stops the run. */
export function stopRule(): { fail: (version: string) => (why: string) => void; failures: string[] } {
  const failures: string[] = [];
  const byVersion = new Map<string, number>();
  return {
    failures,
    fail: (version) => (why) => {
      failures.push(`${version}: ${why}`);
      const n = (byVersion.get(version) ?? 0) + 1;
      byVersion.set(version, n);
      if (n >= 2) throw new StopRun(`${version} could not be counted twice (${why}); the run stops and is opened again`);
      if (failures.length >= 5) throw new StopRun(`five runs could not be counted; the run stops and is opened again`);
    },
  };
}

/**
 * Whether an annotator reads only its working directory: a file inside it must be read, one outside it
 * (a token in the run's own directory, where the sandbox and the logs are) must not. Two `claude -p`
 * runs with the annotators' tools. Returns why it failed, or null.
 */
export function probeConfinement(work: Work, run: typeof ask = ask): string | null {
  const inside = randomBytes(12).toString("hex");
  const outside = randomBytes(12).toString("hex");
  const cwd = mkdtempSync(join(tmpdir(), "jev-probe-"));
  try {
    writeFileSync(join(cwd, "inside.txt"), inside);
    const far = join(work.root, "probe-outside.txt");
    writeFileSync(far, outside);
    assertNoSettings(cwd);
    const system = 'Answer only with a JSON object {"content": string}: the text of the file asked for, or "" if you cannot read it.';
    const a = run(system, "Read the file inside.txt in your working directory.", cwd, ANNOTATOR_TOOLS);
    if (!a.counted || !JSON.stringify(a.json ?? "").includes(inside)) return `an annotator could not read its own working directory (${a.why ?? "no content"})`;
    const b = run(system, `Read the file ${far}.`, cwd, ANNOTATOR_TOOLS);
    if (!b.counted) return `the confinement probe gave no answer (${b.why})`;
    if (JSON.stringify(b.json ?? "").includes(outside)) return "an annotator read a file outside its working directory";
    return null;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export interface Preflight {
  before: ReturnType<typeof workspaceState>;
  after: ReturnType<typeof workspaceState>;
  problem: string | null;
}

/**
 * What must hold before an opening is spent, sending nothing to Jev: the annotators read only their
 * directory, and those first two `claude -p` runs (01's N=1) leave no auto-backup commit on the
 * workspace's main. The audit log is recorded too, but with `Read,Grep,Glob` no Bash hook runs, so it
 * shows nothing of these runs either way; what the record can catch is the commit.
 */
export function preflight(work: Work, run: typeof ask = ask): Preflight {
  const before = workspaceState();
  const confined = probeConfinement(work, run);
  const after = workspaceState();
  const problem = confined ?? n1Problem(arrivedBetween(before.originMain, after.originMain), readAppended(before.auditBytes), work.root, true);
  return { before, after, problem };
}

export interface MeasureInput {
  work: Work;
  cases: readonly (CheckedCase & { clone: string })[];
  limit: number;
  /** What `preflight` found when the cases were prepared (01's N=1); recorded with the results. */
  n1: Preflight | null;
  say: (line: string) => void;
}

/**
 * jev on every case, then the baseline on the same bytes, then the adjudication of the correct
 * versions. Stops with `StopRun` rather than leave a version short: a short version would bias the
 * comparison, and PROTOCOL.md has a stopped run opened again.
 */
export async function measureCases(input: MeasureInput, measure: (id: string, clone: string, limit: number, log: { file: string; cases: string }) => Promise<void>): Promise<Measured> {
  const { work, cases, say } = input;
  const out: Measured = { jev: { conditions: {}, cases: {} }, baseline: {}, adjudication: {}, pairs: [], falseVersions: [], n1: input.n1, failures: [] };
  // A run is measured once in its directory: a second `run` of a stopped opening would pick up jev's log
  // where it stopped, with the stop rule counting from zero. PROTOCOL.md has it opened again instead.
  const started = join(work.root, "started");
  if (existsSync(started)) throw new StopRun(`this opening was already started in ${work.root}; open again`);
  writeFileSync(started, new Date().toISOString());
  const jevFile = join(work.root, "jev.json");
  for (const c of cases) await measure(c.id, c.clone, input.limit, { file: jevFile, cases: work.cases });
  const jev = JSON.parse(readFileSync(jevFile, "utf8")) as AcceptanceLog;
  out.jev = jev;
  for (const c of cases) {
    for (const [versionId, version] of Object.entries(c.caseFile.versions)) {
      const v = jev.cases[c.id]?.versions[versionId];
      if (v === undefined) throw new StopRun(`${c.id} ${versionId} was not measured by jev`);
      if (isLive(version, v.enumeration) && v.runs.filter((r) => r.finished).length < RUNS) throw new StopRun(`${c.id} ${versionId}: jev finished ${v.runs.filter((r) => r.finished).length} runs of ${RUNS}`);
    }
  }
  say(`jev: ${cases.length} cases measured`);

  const empty = mkdtempSync(join(tmpdir(), "jev-sealed-empty-"));
  assertEmptyDir(empty);
  const { fail, failures } = stopRule();
  out.failures = failures;
  const baselineFile = join(work.root, "baseline.json");
  // A version jev sent nothing on — it held its target, or had none inside its budget — still has its
  // baseline: at the median of the bytes jev sent on the run's other versions (owner, 2026-09-26), so a
  // defect jev did not reach is one the baseline can find.
  const fallback = medianBudget(cases, jev);
  for (const c of cases) {
    const book = (out.baseline[c.id] ??= {});
    for (const [versionId, version] of Object.entries(c.caseFile.versions)) {
      if (!/^(shipped|defect-[AB]|rewrite-[AB])$/.test(versionId)) continue;
      const v = jev.cases[c.id]!.versions[versionId]!;
      const req = requirementOf(c.caseFile, version.targets, work.cases);
      const live = isLive(version, v.enumeration);
      const budget = live ? budgetOf(v.runs as { finished: boolean; bytes?: number }[]) : fallback;
      if (budget === null) throw new StopRun(live ? `${c.id} ${versionId}: jev's finished runs recorded no bytes` : `${c.id} ${versionId}: jev sent on no version of the run, so the baseline has no bytes to be given`);
      const material = gather(gitRepo(c.clone), req.text, v.base, v.head, budget);
      const runs: BaselineRun[] = [];
      while (runs.filter((r) => r.counted).length < RUNS) {
        const run = runClaude(userPrompt(req.text, material.text), empty);
        runs.push(run);
        if (!run.counted) fail(`${c.id} ${versionId} baseline`)(run.why ?? "not counted");
      }
      book[versionId] = { budget, budgetFrom: live ? "this version" : "the median of the run", runs, requirementId: req.id, material: { bytes: material.bytes } };
      writeFileSync(baselineFile, `${JSON.stringify(out.baseline, null, 2)}\n`);
    }
  }
  say(`baseline: ${Object.values(out.baseline).reduce((n, b) => n + Object.values(b).reduce((m, v) => m + v.runs.length, 0), 0)} runs`);

  const adjFile = join(work.root, "adjudication.json");
  for (const c of cases) {
    const book = (out.adjudication[c.id] ??= {});
    for (const [versionId, version] of Object.entries(c.caseFile.versions)) {
      if (!/^(shipped|rewrite-[AB])$/.test(versionId)) continue;
      const v = jev.cases[c.id]!.versions[versionId]!;
      const targets = Object.values(version.targets);
      const req = requirementOf(c.caseFile, version.targets, work.cases);
      const jevRuns = withObservations(v, req.id);
      const b = out.baseline[c.id]![versionId]!;
      const baseRuns = b.budget === 0 ? [] : b.runs.filter((r) => r.counted).slice(0, RUNS).map((r) => r.findings);
      const items = itemsOf(targets, jevRuns, baseRuns);
      book[versionId] = adjudicate(items, req.text, c.clone, v.head, empty, fail(`${c.id} ${versionId} adjudication`));
      writeFileSync(adjFile, `${JSON.stringify(out.adjudication, null, 2)}\n`);
    }
  }
  say(`adjudication: ${Object.values(out.adjudication).reduce((n, b) => n + Object.values(b).reduce((m, v) => m + v.runs.length, 0), 0)} runs`);

  for (const c of cases) {
    const jevVersions = jev.cases[c.id]!.versions as Record<string, VersionLog>;
    out.pairs.push(...pairsOf(c.repo, c.caseFile, jevVersions, out.baseline[c.id]!));
    out.falseVersions.push(...falseVersionsOf(c.repo, c.caseFile, jevVersions, out.baseline[c.id]!, out.adjudication[c.id] as Record<string, AdjudicatedVersion>));
  }
  return out;
}

/**
 * The bytes a version jev sent nothing on is given: the median over the run's versions jev sent on of
 * each one's budget (the median of its finished runs). Null when jev sent on none.
 */
export function medianBudget(cases: readonly { id: string; caseFile: CaseFile }[], jev: AcceptanceLog): number | null {
  const sentOn = cases.flatMap((c) =>
    Object.entries(c.caseFile.versions).flatMap(([versionId, version]) => {
      const v = jev.cases[c.id]?.versions[versionId];
      if (v === undefined || !/^(shipped|defect-[AB]|rewrite-[AB])$/.test(versionId) || !isLive(version, v.enumeration)) return [];
      const b = budgetOf(v.runs as { finished: boolean; bytes?: number }[]);
      return b === null ? [] : [b];
    }),
  );
  return budgetOf(sentOn.map((bytes) => ({ finished: true, bytes })));
}

/** jev's top five of each counted run, with the observation that listed each, for the rewriter to read. */
function withObservations(v: VersionLog, requirementId: string) {
  const runs = v.runs.filter((r) => r.finished).slice(0, RUNS);
  return jevRunsOf(v, requirementId).map((findings, k) => {
    const r = runs[k]!.requirements.find((x) => x.requirementId === requirementId);
    return findings.map((f) => ({ ...f, observation: r?.observed.find((o) => o.file === f.file && o.function === f.function && o.call === f.call)?.result.observation ?? "" }));
  });
}

/** The comparison's numbers, and what they rest on: no requirement, function or patch of a case. */
export function comparison(m: Measured) {
  const verdict = judge(m.pairs, m.falseVersions);
  const count = (xs: Record<string, Record<string, { runs: { counted: boolean }[] }>>) => Object.values(xs).reduce((n, b) => n + Object.values(b).reduce((k, v) => k + v.runs.length, 0), 0);
  const costUsd = Object.values(m.baseline).reduce((n, b) => n + Object.values(b).reduce((k, v) => k + v.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0), 0), 0);
  return {
    verdict,
    pairs: m.pairs.length,
    falseVersions: m.falseVersions.length,
    runs: { baseline: count(m.baseline), adjudication: count(m.adjudication), failures: m.failures.length },
    baselineCostUsd: Math.round(costUsd * 100) / 100,
    n1: m.n1 === null ? null : { problem: m.n1.problem },
  };
}

/**
 * Whether `text` holds any requirement sentence, target function or target call of `cases`: the report
 * goes to the public repository, and none of them may. Returns what leaked, empty when nothing.
 */
export function leaks(text: string, cases: readonly { caseFile: CaseFile }[], specOf: (c: CaseFile) => string[]): string[] {
  const out: string[] = [];
  for (const { caseFile } of cases) {
    for (const s of specOf(caseFile)) if (s.length >= 12 && text.includes(s)) out.push(`${caseFile.id}: a requirement`);
    for (const v of Object.values(caseFile.versions)) {
      for (const t of Object.values(v.targets)) {
        const fn = t.function.split("::").at(-1)!;
        if (fn.length >= 4 && new RegExp(`\\b${fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) out.push(`${caseFile.id}: a function`);
        if (t.call.length >= 6 && text.includes(t.call)) out.push(`${caseFile.id}: a call`);
      }
    }
  }
  return [...new Set(out)];
}
