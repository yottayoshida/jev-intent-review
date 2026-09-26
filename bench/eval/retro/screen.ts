// The retrospective's sealed rows, screened one batch at a time (#89, RETRO.md v3, "Candidates").
//
//   node bench/eval/retro/screen.ts reach                        M: repositories in the first 800 rows
//   node bench/eval/retro/screen.ts dry <clones>                 the rows of batch b1 that reach the screen; no model
//   node bench/eval/retro/screen.ts run <clones> <records> <max>  batch b1, at most <max> annotator runs, N=1 first
//
// Every row is examined in the recorded order of `retro/search-v1.json`, through the steps of RETRO.md,
// and its record — the fix, the original, every answer, why it was kept or left out — is written to
// `<records>/89-b1/<row>.json`, a clone of the sandbox's `batches` branch. The batch's verdicts file,
// `<records>/89-b1.json`, holds each row's outcome and the sha256 of each row's file; its own sha256 goes
// to `sealed-batches.json`. **Nothing of a row is printed**: standard output is one JSON of counts
// (`COUNT_KEYS`), and an error names only the row, the step and the error's kind. The orchestrator does
// not open the records (PROTOCOL.md: no plan, memory or note holds a requirement or a function of a
// candidate).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clopperPearson } from "../metrics.ts";
import type { Label, Split } from "../split.ts";
import { arrivedBetween, n1Problem, readAppended, realCalDeps, Stopped, workspaceState, type LaterFix } from "./calibrate.ts";
import { fetchChecks } from "./checks.ts";
import { isGone } from "./gh.ts";
import type { Bundle } from "./material.ts";
import type { Origin } from "./origin.ts";
import {
  acceptRequirements, CAUGHT_SYSTEM, CHECK_SYSTEM, caughtRequest, checkRequest, KEEP_LABELS, LABEL_SYSTEM, labelRequest, majority, PROMPTS_VERSION, readLabel, WRITE_SYSTEM, writeRequest,
  type Answer, type Requirement,
} from "./prompts.ts";
import type { Search } from "./search.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** RETRO.md v3: the batch, the cap, the retries, and the most runs one row can take. */
export const SCREEN = {
  batch: "b1",
  from: 1,
  to: 100,
  /** The cap on rows examined: the projection counts only repositories within it. */
  cap: 800,
  retries: 3,
  /** Screen 3, caught 3, writer 1, checker 1 — each asked up to `retries + 1` times. */
  worstPerRow: 8 * 4,
} as const;

/** The checks a pull request had at its merge: read, none at all, or not readable. */
export type Checks = { state: "read"; items: string[] } | { state: "none" } | { state: "unknown" };

export interface ScreenDeps {
  fix(repo: string, number: number): LaterFix | { skip: string };
  origin(fix: LaterFix): Origin;
  bundle(repo: string, number: number): Bundle;
  checks(repo: string, number: number): Checks;
  annotate(system: string, request: string): Answer;
}

export interface Row {
  order: number;
  ref: string;
  repo: string;
}

/** Why a row is not a case, in words that carry nothing of it. */
export type LeftOut =
  | "skipped: its repository has a case"
  | "placed by another measurement"
  | "not a pull request"
  | "not merged"
  | "merged before the floor"
  | "no original pull request"
  | "the fix's own material is not complete"
  | `screened out as ${Label}`;

export type Requirement_ = "written" | "none" | "invalid" | "gap" | "left out by the check";

export interface RowRecord {
  row: number;
  ref: string;
  repo: string;
  outcome: "case" | "left out";
  why?: LeftOut;
  origin?: Origin;
  labels?: Label[];
  screen?: Label;
  caught?: { answers: boolean[]; caught: boolean; checks: Checks["state"] };
  requirement?: Requirement_;
  requirements?: Requirement[];
  answers: Answer[];
}

export interface BatchRun {
  records: RowRecord[];
  /** Why the run stopped before the batch's last row, or `null`. The row it stopped at is decided neither way. */
  stopped: string | null;
  runs: number;
}

const FIX_SKIPS: Record<string, LeftOut> = { "not a pull request": "not a pull request", "not merged": "not merged" };

/**
 * The rows of a batch, in order, from the first not in `decided`. A row is started only when its worst
 * case fits the runs left; an answer never counted after the retries stops the run, and the row it was
 * on is left undecided, so a resumed run asks it again from its start. Decided rows are never asked again.
 */
export function screenRows(
  rows: readonly Row[],
  deps: ScreenDeps,
  opts: {
    maxRuns: number;
    alreadyRun: number;
    placed: ReadonlySet<string>;
    decided?: readonly RowRecord[];
    /**
     * Called before a row is begun, with the runs spent and its worst case reserved, and again with each
     * decided row: a run killed midway leaves every decided row written and never fewer runs counted
     * than were spent.
     */
    progress?: (runs: number, decided: RowRecord | null) => void;
  },
): BatchRun {
  const records = [...(opts.decided ?? [])];
  const withCase = new Set(records.filter((r) => r.outcome === "case").map((r) => r.repo.toLowerCase()));
  const decidedRows = new Set(records.map((r) => r.row));
  let runs = opts.alreadyRun;
  let stopped: string | null = null;
  for (const row of rows) {
    if (decidedRows.has(row.order)) continue;
    const repo = row.repo.toLowerCase();
    const answers: Answer[] = [];
    const decide = (rec: RowRecord) => {
      records.push(rec);
      opts.progress?.(runs, rec);
    };
    const leave = (why: LeftOut, more: Partial<RowRecord> = {}) => decide({ row: row.order, ref: row.ref, repo: row.repo, outcome: "left out", why, ...more, answers });
    if (withCase.has(repo)) {
      leave("skipped: its repository has a case");
      continue;
    }
    if (opts.placed.has(repo)) {
      leave("placed by another measurement");
      continue;
    }
    if (runs + SCREEN.worstPerRow > opts.maxRuns) {
      stopped = `row ${row.order}: its worst case (${SCREEN.worstPerRow} runs) does not fit the ${opts.maxRuns - runs} runs left`;
      break;
    }
    opts.progress?.(runs + SCREEN.worstPerRow, null);
    const ask = (system: string, request: string, valid: (json: unknown) => boolean): unknown => {
      for (let attempt = 0; attempt <= SCREEN.retries; attempt++) {
        runs += 1;
        const a = deps.annotate(system, request);
        answers.push(a);
        if (a.counted && valid(a.json)) return a.json;
      }
      throw new Stopped(`row ${row.order}: an annotator gave no answer that could be counted in ${SCREEN.retries + 1} attempts`);
    };
    let step = "the fix";
    try {
      const fix = deps.fix(row.repo, Number(row.ref.split("#")[1]));
      if ("skip" in fix) {
        leave(FIX_SKIPS[fix.skip] ?? "merged before the floor");
        continue;
      }
      step = "the original";
      const origin = deps.origin(fix);
      if (origin.number === null) {
        leave("no original pull request", { origin });
        continue;
      }
      if (fix.bundle.unavailable.length > 0) {
        leave("the fix's own material is not complete", { origin });
        continue;
      }
      step = "the bundle";
      const bundle = deps.bundle(row.repo, origin.number);
      step = "the screen";
      const labels = [0, 1, 2].map(() => readLabel(ask(LABEL_SYSTEM, labelRequest(fix.bundle), (j) => readLabel(j) !== null)) ?? "cannot_label");
      const screen = majority(labels);
      if (!KEEP_LABELS.includes(screen)) {
        leave(`screened out as ${screen}`, { origin, labels, screen });
        continue;
      }
      // A case from here on: whatever follows, it is this repository's case.
      step = "caught before the merge";
      const checks = deps.checks(row.repo, origin.number);
      const defect = `${fix.bundle.pull.title}\n\n${fix.bundle.pull.body}`;
      const said = [0, 1, 2].map(() => (ask(CAUGHT_SYSTEM, caughtRequest([...bundle.pull.reviews, ...bundle.pull.comments], checks.state === "read" ? checks.items : [], defect), (j) => typeof (j as { caught?: unknown } | null)?.caught === "boolean") as { caught: boolean }).caught);
      const caught = { answers: said, caught: said.filter(Boolean).length >= 2, checks: checks.state };
      step = "the requirement";
      let requirement: Requirement_;
      let requirements: Requirement[] | undefined;
      if (bundle.unavailable.length > 0) requirement = "gap";
      else {
        const written = acceptRequirements(ask(WRITE_SYSTEM, writeRequest(bundle), () => true), bundle);
        if ("none" in written) requirement = "none";
        else if ("invalid" in written) requirement = "invalid";
        else {
          step = "the check";
          requirements = written.requirements;
          const checked = ask(CHECK_SYSTEM, checkRequest(bundle, fix, written.requirements), (j) => Array.isArray((j as { leaked?: unknown } | null)?.leaked)) as { leaked: unknown[] };
          requirement = checked.leaked.length > 0 ? "left out by the check" : "written";
        }
      }
      decide({ row: row.order, ref: row.ref, repo: row.repo, outcome: "case", origin, labels, screen, caught, requirement, ...(requirements ? { requirements } : {}), answers });
      withCase.add(repo);
    } catch (error) {
      // Nothing of the row in the reason: its number, the step, the error's kind.
      stopped = error instanceof Stopped ? error.message : `row ${row.order}: stopped at ${step} by ${error instanceof Error ? error.constructor.name : typeof error}`;
      break;
    }
  }
  return { records, stopped, runs };
}

/** The keys standard output may carry, and nothing else. */
export const COUNT_KEYS = [
  "batch", "rowsRead", "reachScreen", "stopped", "runs", "reposRead", "cases", "notCaught", "caught", "checksNone", "checksUnknown",
  "requirement", "leftOut", "M", "projection", "projectionLower", "go", "sha256",
] as const;

/**
 * The yield check (RETRO.md v3): `c` of the `r` repositories read had a case not caught before the merge;
 * `M` repositories are in the first `SCREEN.cap` rows. Go on when `c/r × M × 3/4 ≥ 17`, read in
 * integers — `3·c·M ≥ 68·r` — so that no rounding moves the line.
 */
export function yieldVerdict(c: number, r: number, M: number): { go: boolean; projection: number; projectionLower: number } {
  if (r === 0) return { go: false, projection: 0, projectionLower: 0 };
  const lower = clopperPearson(c, r).lower;
  return { go: 3 * c * M >= 68 * r, projection: (c / r) * M * 0.75, projectionLower: lower * M * 0.75 };
}

/** M: the repositories among the first `SCREEN.cap` rows of the search, in its recorded order, those another measurement placed aside. */
export function reposWithinCap(rows: readonly Pick<Row, "order" | "repo">[], placed: ReadonlySet<string> = new Set()): number {
  return new Set([...rows].sort((a, b) => a.order - b.order).slice(0, SCREEN.cap).map((r) => r.repo.toLowerCase()).filter((r) => !placed.has(r))).size;
}

export function countsOf(run: BatchRun, M: number, rowsInBatch: number) {
  const cases = run.records.filter((r) => r.outcome === "case");
  const notCaught = cases.filter((r) => !r.caught!.caught).length;
  // Repositories another measurement placed are not this measurement's: not in `r`, as not in `M`.
  const reposRead = new Set(run.records.filter((r) => r.why !== "placed by another measurement").map((r) => r.repo.toLowerCase())).size;
  const requirement: Record<string, number> = {};
  for (const r of cases) requirement[r.requirement!] = (requirement[r.requirement!] ?? 0) + 1;
  const leftOut: Record<string, number> = {};
  for (const r of run.records) if (r.outcome === "left out") leftOut[r.why!] = (leftOut[r.why!] ?? 0) + 1;
  const complete = run.stopped === null && run.records.length === rowsInBatch;
  const y = yieldVerdict(notCaught, reposRead, M);
  return {
    rowsRead: run.records.length,
    stopped: run.stopped,
    runs: run.runs,
    reposRead,
    cases: cases.length,
    notCaught,
    caught: cases.length - notCaught,
    checksNone: cases.filter((r) => r.caught!.checks === "none").length,
    checksUnknown: cases.filter((r) => r.caught!.checks === "unknown").length,
    requirement,
    leftOut,
    M,
    // The verdict only on a whole batch.
    projection: complete ? y.projection : null,
    projectionLower: complete ? y.projectionLower : null,
    go: complete ? y.go : null,
  };
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const rowFile = (dir: string, row: number) => join(dir, `89-${SCREEN.batch}`, `${row}.json`);
export const verdictsFile = (dir: string) => join(dir, `89-${SCREEN.batch}.json`);

/** Each row's record, written as it is decided. */
export function writeRow(dir: string, rec: RowRecord): void {
  mkdirSync(join(dir, `89-${SCREEN.batch}`), { recursive: true });
  writeFileSync(rowFile(dir, rec.row), `${JSON.stringify(rec, null, 2)}\n`);
}

export function readRows(dir: string, rows: readonly Row[]): RowRecord[] {
  return rows.filter((r) => existsSync(rowFile(dir, r.order))).map((r) => JSON.parse(readFileSync(rowFile(dir, r.order), "utf8")) as RowRecord);
}

/** The verdicts file: each row's outcome and its file's sha256, and the counts. Its sha256 is returned. */
export function writeVerdicts(dir: string, rows: readonly Row[], counts: object): string {
  const verdicts = {
    measurement: "#89",
    id: SCREEN.batch,
    from: rows[0]!.order,
    to: rows.at(-1)!.order,
    promptsVersion: PROMPTS_VERSION,
    // Each file read once, from disk: the hash is of what is there, not of what was meant to be written.
    rows: rows.map((r) => {
      const bytes = readFileSync(rowFile(dir, r.order));
      const rec = JSON.parse(bytes.toString("utf8")) as RowRecord;
      return { row: r.order, ref: r.ref, outcome: rec.outcome, why: rec.why ?? null, sha256: sha256(bytes) };
    }),
    counts,
  };
  const text = `${JSON.stringify(verdicts, null, 2)}\n`;
  writeFileSync(verdictsFile(dir), text);
  return sha256(text);
}

/** Why the batch's files do not match its verdicts, or `null`: every row file's sha256 as listed. */
export function batchProblem(dir: string): string | null {
  const v = JSON.parse(readFileSync(verdictsFile(dir), "utf8")) as { rows: { row: number; sha256: string }[] };
  for (const r of v.rows) {
    if (!existsSync(rowFile(dir, r.row))) return `row ${r.row} has no file`;
    if (sha256(readFileSync(rowFile(dir, r.row))) !== r.sha256) return `row ${r.row}'s file is not the one hashed`;
  }
  return null;
}

// ---- The real run -------------------------------------------------------------------------------

const searchRows = (): Row[] => (JSON.parse(readFileSync(join(HERE, "search-v1.json"), "utf8")) as Search).rows.map((r) => ({ order: r.order, ref: r.ref, repo: r.repo }));
const inBatch = (rows: readonly Row[]) => rows.filter((r) => r.order >= SCREEN.from && r.order <= SCREEN.to);
/** Every repository on the split, a fork's `readAs` too: another measurement's. */
const placedRepos = () => new Set((JSON.parse(readFileSync(join(HERE, "..", "split.json"), "utf8")) as Split).repos.flatMap((r) => [r.repo, ...(r.readAs === undefined ? [] : [r.readAs])]).map((r) => r.toLowerCase()));

function realDeps(clones: string, empty: string): ScreenDeps {
  const cal = realCalDeps(clones, new Map(), empty);
  const bundle = (repo: string, n: number): Bundle => {
    try {
      return cal.bundle(repo, n);
    } catch (error) {
      // GitHub no longer having O is a fact about the case — a gap, as RETRO counts one; anything else stops.
      if (isGone(error)) return { repo, pull: { number: n, title: "", body: "", comments: [], reviews: [] }, issues: [], unavailable: [`#${n} could not be read`] };
      throw error;
    }
  };
  return { fix: cal.fix, origin: cal.origin, bundle, annotate: cal.annotate, checks: (repo, n) => fetchChecks(repo, n) };
}

/** Standard output: the counts, under `COUNT_KEYS` only. */
function print(out: Record<string, unknown>) {
  console.log(JSON.stringify(Object.fromEntries(COUNT_KEYS.filter((k) => k in out).map((k) => [k, out[k]])), null, 2));
}

export function main(argv: readonly string[]) {
  const [mode, clones, records, max] = argv;
  const search = searchRows();
  const placed = placedRepos();
  const rows = inBatch(search);
  const M = reposWithinCap(search, placed);
  if (mode === "reach") return print({ batch: SCREEN.batch, M });
  if (mode === "dry") {
    // The steps that run no annotator, over the batch: how many rows reach the screen. Nothing is written.
    const deps = realDeps(clones!, mkdtempSync(join(tmpdir(), "jir-annotator-")));
    let reach = 0;
    for (const row of rows) {
      if (placed.has(row.repo.toLowerCase())) continue;
      const fix = deps.fix(row.repo, Number(row.ref.split("#")[1]));
      if ("skip" in fix || fix.bundle.unavailable.length > 0) continue;
      if (deps.origin(fix).number === null) continue;
      reach += 1;
    }
    return print({ batch: SCREEN.batch, rowsRead: rows.length, M, reachScreen: reach });
  }
  if (mode !== "run") throw new Error("usage: screen.ts reach | dry <clones> | run <clones> <records> <max runs>");
  const maxRuns = Number(max);
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || !records) throw new Error("usage: screen.ts run <clones> <records> <max runs>");
  // A batch whose verdicts are written is hashed and may be on main: it is never run again.
  if (existsSync(verdictsFile(records))) throw new Error("this batch's verdicts are written; it is not run again");
  const decided = readRows(records, rows);
  const spentFile = join(records, `89-${SCREEN.batch}.runs.json`);
  const spent = existsSync(spentFile) ? (JSON.parse(readFileSync(spentFile, "utf8")) as { runs: number }).runs : 0;
  // Nothing runs, the N=1 run included, past the number allowed — nor the N=1 run when no row would fit after it.
  const needed = decided.length < rows.length ? 1 + SCREEN.worstPerRow : 1;
  if (spent + needed > maxRuns) return print({ batch: SCREEN.batch, stopped: `${spent} of the ${maxRuns} runs allowed are spent`, runs: spent });
  const empty = mkdtempSync(join(tmpdir(), "jir-annotator-"));
  const deps = realDeps(clones!, empty);
  // N=1 first, as the calibration: one writer's run and the workspace's state around it. Counted.
  const before = workspaceState();
  const probe = deps.annotate(WRITE_SYSTEM, writeRequest({ repo: "o/r", pull: { number: 1, title: "Read the config", body: "Reading the config must fail loudly when the file cannot be read.", comments: [], reviews: [] }, issues: [], unavailable: [] }));
  const after = workspaceState();
  const problem = n1Problem(arrivedBetween(before.originMain, after.originMain), readAppended(before.auditBytes), empty, probe.counted);
  writeFileSync(spentFile, `${JSON.stringify({ runs: spent + 1, n1: { before, after, problem } }, null, 2)}\n`);
  if (problem !== null) return print({ batch: SCREEN.batch, stopped: `N=1: ${problem}`, runs: spent + 1 });
  const spend = (runs: number) => writeFileSync(spentFile, `${JSON.stringify({ runs, n1: { before, after, problem } }, null, 2)}\n`);
  const result = screenRows(rows, deps, {
    maxRuns,
    alreadyRun: spent + 1,
    placed,
    decided,
    progress: (runs, rec) => {
      if (rec !== null) writeRow(records, rec);
      spend(runs);
    },
  });
  spend(result.runs);
  const counts = countsOf(result, M, rows.length);
  const whole = counts.go !== null;
  return print({ batch: SCREEN.batch, ...counts, sha256: whole ? writeVerdicts(records, rows, counts) : null });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // Only the kind of the error: a child process's error carries what it printed.
    console.error(`screen.ts stopped: ${error instanceof Error ? error.constructor.name : typeof error}`);
    process.exitCode = 1;
  }
}
