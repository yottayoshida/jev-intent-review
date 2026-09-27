// The one entry of the evaluation protocol (bench/eval/PROTOCOL.md).
//
//   node bench/eval/run.ts --set dev measure <clones> <limit>   every dev case, into bench/eval/logs/dev-v1.json
//   node bench/eval/run.ts --set dev report [<log>]             the metrics of a log, no request
//   node bench/eval/run.ts --set sealed open --reason "<why>"   appends the line that opens the sealed set
//   node bench/eval/run.ts --set sealed run <run id>            runs it, once that line is on origin/main
//
// `<clones>` holds one clone per case, named by the case id, with the branches of
// bench/acceptance/build-branches.sh; `measure` is bench/acceptance/run.ts's own.
//
// The sealed set cannot be run by accident, or without leaving a record: `open` sends nothing and only
// appends a line, and `run` sends nothing until that line has reached origin/main, the tree is clean,
// and the build it runs is the one it just made from that tree. A run that stops half way has still
// left its line on main. How many times each repository was opened is counted across every version of
// the protocol, so raising the version does not make a sealed result look unopened.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, type AcceptanceLog } from "../acceptance/replay.ts";
import { RUNS, scoreVersion } from "../acceptance/score.ts";
import { countsOf, estimateOver, GATES, judge, releaseVerdict, type EvalRow, type MetricName } from "./metrics.ts";
import { PROTOCOL_VERSION, type SealedBatch, type Split } from "./split.ts";
import { StopRun } from "./adjudicate.ts";
import { BASELINE_VERSION, EFFORT, MODEL } from "./baseline.ts";
import { batchFilesOf, caseRepo as sealedCaseRepo, checkCases, comparison, fetchSandbox, gitSandbox, leaks, materialize, measureCases, openSet, preflight, prepareClone, workOf, type CheckedCase, type Measured, type Preflight, type Work } from "./sealed.ts";
import { endpointFromEnv, jevModel } from "../../src/judgments/client.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
export const ACCESS_LOG = join(HERE, "sealed-access.jsonl");
const DEV_LOG = join(HERE, "logs", "dev-v1.json");

export { Refused } from "./refused.ts";
import { Refused } from "./refused.ts";

/**
 * The model a run asks for: the host and Jev's alias on it, known before anything is sent. Which
 * version answered is known only from the answers (#84's `modelIdentity`), so it is in the result line.
 */
export interface RequestedModel {
  host: string;
  requested: string;
}

export interface OpenLine {
  kind: "open";
  runId: string;
  at: string;
  head: string;
  protocolVersion: number;
  /** sha256 of split.json and pool.json in the tree `open` ran in (clean, so the ones at `head`). */
  manifest: string;
  model: RequestedModel;
  reason: string;
  repos: string[];
  /** For each repository, the times it has been opened, this one included, across every version. */
  opened: Record<string, number>;
  /** The sandbox commits the cases were checked at; `run` measures those, whatever was pushed since. */
  sandbox: Record<string, string>;
  /** The most requests jev may send over the whole run: every version's three runs at their largest. */
  limit: number;
  /** The baseline of #88 the run asks (BASELINE.md, "Sealed"). */
  baseline: { host: "claude-code"; model: string; effort: string; version: number };
  /** sha256 of what decides the comparison and the check, so a change merged in between is refused. */
  files: Record<string, string>;
  /** Each case's versions as rebuilt from its patches (check 4): the commits measured. */
  versions: Record<string, Record<string, { base: string; head: string; asCaseJson: boolean }>>;
}

/** What `prepare` found: the cases checked, and what the opening line records of them. */
export interface Prepared {
  repos: string[];
  sandbox: Record<string, string>;
  limit: number;
  baseline: OpenLine["baseline"];
  files: Record<string, string>;
  versions: OpenLine["versions"];
}

export interface ResultLine {
  kind: "result";
  runId: string;
  at: string;
  /** The commit that was built and run: the open line's `head` is the commit before it was merged. */
  head: string;
  manifest: string;
  dist: string;
  /** Each run's `modelIdentity` (#84): the versions the host named in its answers. */
  answeredBy: unknown[];
  result: string;
  resultSha256: string;
  /** sha256 of the logs that hold the cases' content, kept in the sandbox's `results` branch, not here. */
  results: Record<string, string>;
}

/** Everything the sealed steps touch, so a test can put fakes in. */
export interface SealedDeps {
  now(): string;
  newRunId(): string;
  head(): string;
  /** `git status --porcelain`, empty when clean. */
  dirty(): string;
  manifest(): string;
  /** The access log as origin/main has it after a fetch; null when main has no such file. */
  accessLogOnMain(): string | null;
  readAccessLog(): string;
  appendAccessLog(line: string): void;
  /** Null when this environment sends judgments nowhere. */
  modelIdentity(): RequestedModel | null;
  /**
   * Checks every case to open through the chain of `sealed.ts` — at the tips of the sandbox's branches,
   * or at `pinned` — clones and rebuilds each, and checks the baseline can run. Sends nothing; refuses
   * on anything that does not hold.
   */
  prepare(runId: string, pinned?: Record<string, string>): Promise<Prepared>;
  /** Builds dist/ from the tree and returns the hash of what it built. */
  build(): string;
  /** Sends the requests. Returns the result file, its sha256, each run's `modelIdentity`, and the logs' sha256. */
  measure(runId: string, open: OpenLine): Promise<{ file: string; sha256: string; answeredBy: unknown[]; results: Record<string, string> }>;
}

const lines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as OpenLine | ResultLine);

/** Every line of main's log and of this tree's, each once (a line is its JSON text). */
function allLines(onMain: string | null, here: string): (OpenLine | ResultLine)[] {
  const seen = new Set<string>();
  const out: (OpenLine | ResultLine)[] = [];
  for (const text of [onMain ?? "", here]) {
    for (const l of text.split("\n").filter((x) => x.trim() !== "")) {
      if (seen.has(l)) continue;
      seen.add(l);
      out.push(JSON.parse(l) as OpenLine | ResultLine);
    }
  }
  return out;
}

export async function openSealed(deps: SealedDeps, reason: string): Promise<OpenLine> {
  if (reason.trim() === "") throw new Refused("a sealed evaluation needs a reason: --reason \"<why the sealed set is opened>\"");
  const model = deps.modelIdentity();
  if (model === null) throw new Refused("this environment sends judgments nowhere, so the model a sealed run asks for cannot be named");
  const dirty = deps.dirty();
  if (dirty.trim() !== "") throw new Refused(`the working tree is not clean, so the manifest would not be the commit the line names:\n${dirty}`);
  const runId = deps.newRunId();
  // Every check before the line exists: a case that fails does not spend an opening (ADR 0024).
  const p = await deps.prepare(runId);
  if (p.repos.length === 0) throw new Refused("the sealed set has no case yet (split.json has no sealed repository): nothing to open");
  // Counted over main's lines and this tree's: a branch behind main must not count low.
  const before = allLines(deps.accessLogOnMain(), deps.readAccessLog()).filter((l): l is OpenLine => l.kind === "open");
  const opened = Object.fromEntries(p.repos.map((r) => [r, before.filter((l) => l.repos.includes(r)).length + 1]));
  const line: OpenLine = { kind: "open", runId, at: deps.now(), head: deps.head(), protocolVersion: PROTOCOL_VERSION, manifest: deps.manifest(), model, reason: reason.trim(), repos: p.repos, opened, sandbox: p.sandbox, limit: p.limit, baseline: p.baseline, files: p.files, versions: p.versions };
  deps.appendAccessLog(`${JSON.stringify(line)}\n`);
  return line;
}

export async function runSealed(deps: SealedDeps, runId: string): Promise<ResultLine> {
  const onMain = deps.accessLogOnMain();
  const open = onMain === null ? undefined : lines(onMain).find((l): l is OpenLine => l.kind === "open" && l.runId === runId);
  if (open === undefined) throw new Refused(`run ${runId} is not opened on origin/main: commit the line \`open\` appended, merge it, then run`);
  // Looked for on main as well as here: a fresh clone of main has no local result line to find.
  if (allLines(onMain, deps.readAccessLog()).some((l) => l.kind === "result" && l.runId === runId)) throw new Refused(`run ${runId} has run already; open another`);
  const dirty = deps.dirty();
  if (dirty.trim() !== "") throw new Refused(`the working tree is not clean, so the build would not be the commit the log names:\n${dirty}`);
  const model = deps.modelIdentity();
  if (model === null || JSON.stringify(model) !== JSON.stringify(open.model)) throw new Refused("this environment does not ask the host and model the run was opened with");
  const manifest = deps.manifest();
  if (manifest !== open.manifest) throw new Refused("split.json or pool.json is not what the run was opened with; open another");
  // The same checks again, at the commits the opening recorded; what they found must be what it found.
  const p = await deps.prepare(runId, open.sandbox);
  for (const k of ["repos", "limit", "baseline", "files", "versions"] as const) {
    if (JSON.stringify(p[k]) !== JSON.stringify(open[k])) throw new Refused(`the ${k} checked now is not what the run was opened with; open another`);
  }
  const head = deps.head();
  const dist = deps.build();
  const { file, sha256, answeredBy, results } = await deps.measure(runId, open);
  const line: ResultLine = { kind: "result", runId, at: deps.now(), head, manifest, dist, answeredBy, result: file, resultSha256: sha256, results };
  deps.appendAccessLog(`${JSON.stringify(line)}\n`);
  return line;
}

// ---------------------------------------------------------------------------------------------
// The real dependencies.

const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const readSplit = () => JSON.parse(readFileSync(join(HERE, "split.json"), "utf8")) as Split;
/** A case's repository as split.json names it: `owner/repo`, lower case. */
const caseRepo = sealedCaseRepo;

function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${relative(dir, p)}\0`).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

export const realDeps: SealedDeps = {
  now: () => new Date().toISOString(),
  newRunId: () => randomUUID(),
  head: () => git("rev-parse", "HEAD").trim(),
  dirty: () => git("status", "--porcelain"),
  manifest: () => sha256(readFileSync(join(HERE, "split.json")) + "\0" + readFileSync(join(HERE, "pool.json"))),
  accessLogOnMain: () => {
    git("fetch", "--quiet", "origin", "main");
    try {
      return git("show", `origin/main:${relative(ROOT, ACCESS_LOG)}`);
    } catch {
      return null;
    }
  },
  readAccessLog: () => (existsSync(ACCESS_LOG) ? readFileSync(ACCESS_LOG, "utf8") : ""),
  appendAccessLog: (line) => appendFileSync(ACCESS_LOG, line),
  modelIdentity: () => {
    const endpoint = endpointFromEnv(process.env);
    return endpoint === null ? null : { host: endpoint.host, requested: jevModel(endpoint.host) };
  },
  prepare: async (runId, pinned) => {
    const work = workOf(sealedWork(runId));
    // A run already started here is refused by `measureCases` too; refused here it costs no clone or probe.
    if (pinned !== undefined && existsSync(join(work.root, "started"))) throw new Refused(`run ${runId} was already started in ${work.root}; open again`);
    const commits = fetchSandbox(work, ["sealed", "batches"], pinned);
    const cases = await checkedAndCloned(work, commits, "sealed", commits.sealed!, null);
    // Before the line is written: an annotator not confined, or a mark of these runs on the workspace,
    // refuses without spending an opening.
    const n1 = preflight(work);
    if (n1.problem !== null) throw new Refused(`before any request: ${n1.problem}`);
    prepared.set(runId, { work, cases, n1 });
    return {
      repos: cases.map((c) => c.repo),
      sandbox: commits,
      limit: await limitOf(cases),
      baseline: { host: "claude-code", model: MODEL, effort: EFFORT, version: BASELINE_VERSION },
      files: decidingFiles(),
      versions: Object.fromEntries(cases.map((c) => [c.id, c.versions])),
    };
  },
  build: () => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
    return hashTree(join(ROOT, "dist"));
  },
  measure: async (runId, open) => {
    const p = prepared.get(runId);
    if (p === undefined) throw new Refused(`run ${runId} was not prepared in this process`);
    const { measure } = await import("../acceptance/run.ts");
    const m = await measureCases({ work: p.work, cases: p.cases, limit: open.limit, n1: p.n1, say: (l) => console.log(l) }, measure);
    const out = numbersOf(m, p.work, p.cases, "sealed");
    mkdirSync(join(HERE, "logs"), { recursive: true });
    const file = join(HERE, "logs", `sealed-${runId}-report.json`);
    const text = `${JSON.stringify(out, null, 2)}\n`;
    writeFileSync(file, text);
    const results = Object.fromEntries(["jev.json", "baseline.json", "adjudication.json"].map((f) => [f, sha256(readFileSync(join(p.work.root, f)))]));
    console.log(`the logs of the cases are in ${p.work.root}; push them to the sandbox's results branch as results/${runId}/`);
    return { file: relative(ROOT, file), sha256: sha256(text), answeredBy: answeredByOf(m.jev), results };
  },
};

/** The run's own directory, outside the repository: the sandbox clone, the cases, the clones, the logs. */
const sealedWork = (runId: string) => join(homedir(), ".cctmp", `sealed-${runId}`);
/** What `prepare` built in this process, for `measure` to run on. */
const prepared = new Map<string, { work: Work; cases: (CheckedCase & { clone: string; versions: Record<string, { base: string; head: string; asCaseJson: boolean }> })[]; n1: Preflight }>();

/**
 * The files whose change between open and run is refused: what checks the cases, runs each system,
 * adjudicates, scores and counts. The rest of the tree is the tool itself, built into `dist/`, whose hash
 * is in the result line.
 */
function decidingFiles(): Record<string, string> {
  const files = [
    "bench/eval/run.ts", "bench/eval/sealed.ts", "bench/eval/baseline.ts", "bench/eval/compare.ts", "bench/eval/adjudicate.ts", "bench/eval/metrics.ts", "bench/eval/split.ts",
    "bench/eval/retro/prompts.ts", "bench/eval/retro/calibrate.ts", "bench/eval/sealed-batches.json",
    "bench/acceptance/run.ts", "bench/acceptance/score.ts", "bench/acceptance/replay.ts",
  ];
  return Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(ROOT, f)))]));
}

/**
 * Checks 1-4 of `sealed.ts` on the cases of `side`: the batch files, the files of each case, the split,
 * each version rebuilt. For the sealed side the first 17 (`openSet`); for dev, the rows in `only`.
 */
async function checkedAndCloned(work: Work, commits: Record<string, string>, side: "sealed" | "dev", casesAt: string, only: readonly number[] | null) {
  const view = gitSandbox(work.sandbox);
  const lines = (JSON.parse(readFileSync(join(HERE, "sealed-batches.json"), "utf8")) as { batches: SealedBatch[] }).batches;
  const files = batchFilesOf(view, commits.batches!, lines, "#80");
  const opened = side === "sealed" ? openSet(readSplit(), files, "#80") : openSet(readSplit(), files, "#80", "dev", null).filter((o) => only!.includes(o.order));
  if (only !== null && opened.length !== only.length) throw new Refused(`rows ${only.join(", ")} are not all dev cases of #80's batches`);
  const cases = checkCases(view, casesAt, opened, files);
  materialize(view, casesAt, cases, work);
  const withClones = cases.map((c) => ({ ...c, ...prepareClone(c, work) }));
  // The baseline must be able to run before anything is sent.
  execFileSync("claude", ["--version"], { stdio: "ignore" });
  return withClones;
}

/** Every version's three runs at the most `measure` lets one run send. */
async function limitOf(cases: readonly CheckedCase[]): Promise<number> {
  const { perRun } = await import("../acceptance/run.ts");
  return cases.reduce((n, c) => n + Object.keys(c.caseFile.versions).reduce((k, v) => k + RUNS * perRun(c.caseFile, v), 0), 0);
}

const answeredByOf = (log: AcceptanceLog) => Object.values(log.cases).flatMap((c) => Object.values(c.versions).flatMap((v) => (v.runs as { modelIdentity?: unknown }[]).map((r) => r.modelIdentity ?? null)));

/** The numbers of one run: #80's report and #88's comparison. Refused if any case's text is in them. */
function numbersOf(m: Measured, work: Work, cases: readonly CheckedCase[], set: "dev" | "sealed") {
  const out = { set, eval: report(m.jev, readSplit(), set, work.cases), comparison: comparison(m) };
  const specOf = (c: { id: string }) => (JSON.parse(readFileSync(join(work.cases, c.id, "spec.json"), "utf8")) as { requirements: { text: string }[] }).requirements.map((r) => r.text);
  const leaked = leaks(JSON.stringify(out), cases, specOf);
  if (leaked.length > 0) throw new Refused(`the report would hold a case's content (${leaked.join("; ")}); nothing is written`);
  return out;
}

/**
 * The rehearsal (ADR 0024): the same path as a sealed run - the batch files, the case's files, the
 * clone, jev, the baseline, the adjudication, the numbers - on dev cases of the sandbox's `dev` branch,
 * which may be read and run at will. No opening, no line; everything stays in the run's directory.
 */
async function rehearse(orders: number[]) {
  const runId = `dev-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const work = workOf(join(homedir(), ".cctmp", runId));
  const commits = fetchSandbox(work, ["dev", "batches"]);
  const cases = await checkedAndCloned(work, commits, "dev", commits.dev!, orders);
  const n1 = preflight(work);
  if (n1.problem !== null) throw new Refused(`before any request: ${n1.problem}`);
  console.log("the annotators read only their directory; the first claude -p runs left no auto-backup commit");
  const { measure } = await import("../acceptance/run.ts");
  const m = await measureCases({ work, cases, limit: await limitOf(cases), n1, say: (l) => console.log(l) }, measure);
  const out = numbersOf(m, work, cases, "dev");
  writeFileSync(join(work.root, "report.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ work: work.root, cases: cases.map((c) => c.id), comparison: out.comparison }, null, 2));
}

// ---------------------------------------------------------------------------------------------
// Dev: measuring, and the metrics of a log.

async function measureDev(clones: string, limit: number) {
  const { measure } = await import("../acceptance/run.ts");
  mkdirSync(join(HERE, "logs"), { recursive: true });
  const dev = new Set(readSplit().repos.filter((r) => r.side === "dev").map((r) => r.repo));
  for (const c of loadCases()) {
    const repo = caseRepo(c);
    if (!dev.has(repo)) throw new Error(`${c.id} (${repo}) is not on the dev side of split.json`);
    const clone = join(clones, c.id);
    if (!existsSync(clone)) {
      console.log(`${c.id}: no clone at ${clone}; skipped`);
      continue;
    }
    await measure(c.id, clone, limit, { file: DEV_LOG });
  }
}

/** The metrics of a log, with the counts behind each: repositories, requirements, cases, targets. */
export function report(log: AcceptanceLog, split: Split, set: "dev" | "sealed", casesDir?: string) {
  const side = new Map(split.repos.map((r) => [r.repo, r.side]));
  // A case read on a fork names the fork; the split names the repository it counts as (`readAs`).
  const canonical = new Map(split.repos.flatMap((r): [string, string][] => [[r.repo, r.repo], ...(r.readAs ? [[r.readAs.toLowerCase(), r.repo] as [string, string]] : [])]));
  const cases = new Map(loadCases(casesDir).map((c) => [c.id, c]));
  const rows: EvalRow[] = [];
  const requirements = new Set<string>();
  const included: string[] = [];
  const costs: { case: string; requests: number; bytes: number; runs: number }[] = [];
  let unlabelledListed = 0;
  for (const [id, entry] of Object.entries(log.cases)) {
    const c = cases.get(id);
    if (!c) throw new Error(`${id} is in the log and has no case.json`);
    const repo = canonical.get(caseRepo(c)) ?? caseRepo(c);
    if (side.get(repo) !== set) throw new Error(`${id} (${repo}) is ${side.get(repo) ?? "not on the split"}, and this report is of ${set}`);
    included.push(id);
    const cost = { case: id, requests: 0, bytes: 0, runs: 0 };
    for (const [versionId, v] of Object.entries(entry.versions)) {
      for (const run of v.runs as { requests?: number; bytes?: number }[]) {
        cost.requests += run.requests ?? 0;
        cost.bytes += run.bytes ?? 0;
        cost.runs += 1;
      }
      // A listed call that is none of the version's targets has no label: counted, never scored.
      const targets = Object.values(c.versions[versionId]?.targets ?? {});
      for (const run of v.runs.filter((r) => r.finished).slice(0, RUNS)) {
        for (const r of run.requirements) {
          unlabelledListed += r.findings.filter((f) => !targets.some((t) => t.file === f.file && t.function === f.function && t.call === f.call)).length;
        }
      }
      for (const row of scoreVersion(c, versionId, v)) {
        rows.push({ repo, versionId, row });
        requirements.add(`${repo}:${row.target.requirementId}`);
      }
    }
    costs.push(cost);
  }
  const counts = countsOf(rows);
  const gates = Object.fromEntries((Object.keys(GATES) as MetricName[]).map((m) => [m, judge(GATES[m], estimateOver(counts[m]))])) as Record<MetricName, ReturnType<typeof judge>>;
  return {
    set,
    behind: { repositories: new Set(rows.map((r) => r.repo)).size, requirements: requirements.size, cases: included.length, targets: rows.length, runs: rows.reduce((n, r) => n + r.row.runs.length, 0) },
    reported: { reach: estimateOver(counts.reach), cannotDetermine: estimateOver(counts.cannotDetermine), unlabelledListed },
    costs,
    gates,
    release: releaseVerdict(gates),
  };
}

async function cli(argv: string[]) {
  const at = argv.indexOf("--set");
  const set = at === -1 ? undefined : argv[at + 1];
  const rest = argv.filter((_, i) => i !== at && i !== at + 1);
  const usage = "usage: run.ts --set dev measure <clones> <limit> | --set dev report [<log>] | --set dev sandbox <row>... | --set sealed open --reason \"<why>\" | --set sealed run <run id>";
  try {
    if (set === "dev" && rest[0] === "measure" && rest[1] && rest[2]) return await measureDev(rest[1], Number(rest[2]));
    if (set === "dev" && rest[0] === "report") return console.log(JSON.stringify(report(JSON.parse(readFileSync(rest[1] ?? DEV_LOG, "utf8")), readSplit(), "dev"), null, 2));
    if (set === "dev" && rest[0] === "sandbox" && rest.length > 1) return await rehearse(rest.slice(1).map(Number));
    if (set === "sealed" && rest[0] === "open") {
      const r = rest.indexOf("--reason");
      const line = await openSealed(realDeps, r === -1 ? "" : (rest[r + 1] ?? ""));
      return console.log(`opened ${line.runId}. Commit ${relative(ROOT, ACCESS_LOG)}, merge it to main, then: run.ts --set sealed run ${line.runId}`);
    }
    if (set === "sealed" && rest[0] === "run" && rest[1]) return console.log(JSON.stringify(await runSealed(realDeps, rest[1])));
    if (set === "sealed") throw new Refused(`the sealed set is run only through \`open\` then \`run\`.\n${usage}`);
    console.error(usage);
    process.exitCode = 2;
  } catch (error) {
    if (error instanceof StopRun) {
      console.error(`stopped: ${error.message}`);
      process.exitCode = 4;
      return;
    }
    if (!(error instanceof Refused)) {
      // A sealed or rehearsal step's other errors can carry a case's paths or a tool's stderr: they go
      // to a file, and the terminal gets only where.
      if (set === "sealed" || rest[0] === "sandbox") {
        const file = join(homedir(), ".cctmp", `run-ts-error-${Date.now()}.txt`);
        writeFileSync(file, error instanceof Error ? (error.stack ?? error.message) : String(error));
        console.error(`failed: ${error instanceof Error ? error.name : "error"}; the details are in ${file}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.error(`refused: ${error.message}`);
    process.exitCode = 3;
  }
}

// realpath on both sides: a path through a symbolic link names this file too.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(process.argv.slice(2));
