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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, type AcceptanceLog } from "../acceptance/replay.ts";
import { RUNS, scoreVersion } from "../acceptance/score.ts";
import { countsOf, estimateOver, GATES, judge, releaseVerdict, type EvalRow, type MetricName } from "./metrics.ts";
import { PROTOCOL_VERSION, type Split } from "./split.ts";
import { endpointFromEnv, jevModel } from "../../src/judgments/client.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
export const ACCESS_LOG = join(HERE, "sealed-access.jsonl");
const DEV_LOG = join(HERE, "logs", "dev-v1.json");

export class Refused extends Error {}

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
  sealedRepos(): string[];
  /** Builds dist/ from the tree and returns the hash of what it built. */
  build(): string;
  /** Sends the requests. Returns the result file, its sha256, and each run's `modelIdentity`. */
  measure(runId: string, repos: readonly string[]): Promise<{ file: string; sha256: string; answeredBy: unknown[] }>;
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

export function openSealed(deps: SealedDeps, reason: string): OpenLine {
  if (reason.trim() === "") throw new Refused("a sealed evaluation needs a reason: --reason \"<why the sealed set is opened>\"");
  const repos = deps.sealedRepos();
  if (repos.length === 0) throw new Refused("the sealed set has no case yet (split.json has no sealed repository): nothing to open");
  const model = deps.modelIdentity();
  if (model === null) throw new Refused("this environment sends judgments nowhere, so the model a sealed run asks for cannot be named");
  const dirty = deps.dirty();
  if (dirty.trim() !== "") throw new Refused(`the working tree is not clean, so the manifest would not be the commit the line names:\n${dirty}`);
  // Counted over main's lines and this tree's: a branch behind main must not count low.
  const before = allLines(deps.accessLogOnMain(), deps.readAccessLog()).filter((l): l is OpenLine => l.kind === "open");
  const opened = Object.fromEntries(repos.map((r) => [r, before.filter((l) => l.repos.includes(r)).length + 1]));
  const line: OpenLine = { kind: "open", runId: deps.newRunId(), at: deps.now(), head: deps.head(), protocolVersion: PROTOCOL_VERSION, manifest: deps.manifest(), model, reason: reason.trim(), repos, opened };
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
  const head = deps.head();
  const dist = deps.build();
  const { file, sha256, answeredBy } = await deps.measure(runId, open.repos);
  const line: ResultLine = { kind: "result", runId, at: deps.now(), head, manifest, dist, answeredBy, result: file, resultSha256: sha256 };
  deps.appendAccessLog(`${JSON.stringify(line)}\n`);
  return line;
}

// ---------------------------------------------------------------------------------------------
// The real dependencies.

const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const readSplit = () => JSON.parse(readFileSync(join(HERE, "split.json"), "utf8")) as Split;
/** A case's repository as split.json names it: `owner/repo`, lower case. */
const caseRepo = (c: { repo: string }) => c.repo.replace(/^https:\/\/github\.com\//, "").toLowerCase();

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
  sealedRepos: () => readSplit().repos.filter((r) => r.side === "sealed").map((r) => r.repo),
  build: () => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
    return hashTree(join(ROOT, "dist"));
  },
  // The sealed cases live outside this repository (jev-review-sandbox, branch `sealed`, PROTOCOL.md) and
  // the first of them comes with the second batch; so does this. Until then `open` refuses before here.
  measure: async () => {
    throw new Refused("no sealed case is wired to a runner yet (the second batch brings both)");
  },
};

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
export function report(log: AcceptanceLog, split: Split, set: "dev" | "sealed") {
  const side = new Map(split.repos.map((r) => [r.repo, r.side]));
  const cases = new Map(loadCases().map((c) => [c.id, c]));
  const rows: EvalRow[] = [];
  const requirements = new Set<string>();
  const included: string[] = [];
  const costs: { case: string; requests: number; bytes: number; runs: number }[] = [];
  let unlabelledListed = 0;
  for (const [id, entry] of Object.entries(log.cases)) {
    const c = cases.get(id);
    if (!c) throw new Error(`${id} is in the log and has no case.json`);
    const repo = caseRepo(c);
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
  const usage = "usage: run.ts --set dev measure <clones> <limit> | --set dev report [<log>] | --set sealed open --reason \"<why>\" | --set sealed run <run id>";
  try {
    if (set === "dev" && rest[0] === "measure" && rest[1] && rest[2]) return await measureDev(rest[1], Number(rest[2]));
    if (set === "dev" && rest[0] === "report") return console.log(JSON.stringify(report(JSON.parse(readFileSync(rest[1] ?? DEV_LOG, "utf8")), readSplit(), "dev"), null, 2));
    if (set === "sealed" && rest[0] === "open") {
      const r = rest.indexOf("--reason");
      const line = openSealed(realDeps, r === -1 ? "" : (rest[r + 1] ?? ""));
      return console.log(`opened ${line.runId}. Commit ${relative(ROOT, ACCESS_LOG)}, merge it to main, then: run.ts --set sealed run ${line.runId}`);
    }
    if (set === "sealed" && rest[0] === "run" && rest[1]) return console.log(JSON.stringify(await runSealed(realDeps, rest[1])));
    if (set === "sealed") throw new Refused(`the sealed set is run only through \`open\` then \`run\`.\n${usage}`);
    console.error(usage);
    process.exitCode = 2;
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    console.error(`refused: ${error.message}`);
    process.exitCode = 3;
  }
}

// realpath on both sides: a path through a symbolic link names this file too.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(process.argv.slice(2));
