// The hindsight check, calibrated on dev before it sees any sealed candidate (#89, RETRO.md v2, step 3).
//
//   node bench/eval/retro/calibrate.ts <clones>      writes bench/eval/retro/calibration-v1.json
//
// Ten requirements written by the writer from the original pull request's bundle alone, and the same
// ten with the name of a function the later fix changed added to their first item, are mixed and
// checked one by one. The check passes when it leaves out at least 9 of the 10 with the name and at
// most 1 of the 10 without. What it measures is the one kind of hindsight a name makes visible; a
// requirement that uses the bundle's words but picks the call the fix picked is not measured here.
// Beside the verdict, and never in it: a second checking of the same twenty (how often two runs
// agree), ten requirements written by an annotator shown the fix (`LEAK_SYSTEM`) and how many the check
// catches, and the v2 screen of each fix set against #80's label for it.

import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Label, Pool } from "../split.ts";
import { fetchBundle, type Bundle } from "./material.ts";
import { DEV_SEARCH, type Search } from "./search.ts";
import { namedOrigins, originOf, realDeps, type Origin } from "./origin.ts";
import {
  acceptRequirements, annotate, CHECK_SYSTEM, checkRequest, KEEP_LABELS, LABEL_SYSTEM, labelRequest, LEAK_SYSTEM, leakRequest, majority, PROMPTS_VERSION, readLabel, WRITE_SYSTEM, writeRequest,
  type Answer, type Fix, type Requirement,
} from "./prompts.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/**
 * The calibration's records: `calibration-v<n>.json`, one per attempt, never taken again under a name
 * already used. An attempt that stopped leaves its record, and the next is the next number: the runs
 * allowed are counted over every attempt, so stopping never gives the budget back.
 */
export const recordOf = (n: number) => join(HERE, `calibration-v${n}.json`);

/** The next attempt's number and the runs every earlier attempt spent, the N=1 runs included. */
export function nextAttempt(records: readonly { counts?: { runs?: number }; spentBefore?: number; n1?: unknown }[]): { number: number; spent: number } {
  // Each record's `counts.runs` is already the total so far: an attempt starts counting from what the
  // earlier ones spent. So the latest record holds it; summing them counted earlier runs twice (the third
  // attempt's record says 15 spent before it, where 10 were). An attempt the N=1 run stopped has no counts:
  // what was spent before it, and its one run.
  const last = records.at(-1);
  const spent = last === undefined ? 0 : (last.counts?.runs ?? (last.spentBefore ?? 0) + (last.n1 !== undefined ? 1 : 0));
  return { number: records.length + 1, spent };
}

/** How many of each kind; the pass line (RETRO.md v2). */
export const CAL = { cases: 10, plantedLeftOutAtLeast: 9, cleanLeftOutAtMost: 1, retries: 3, maxRuns: 250 } as const;

/** The later fix, and the pieces the steps need of it. */
export interface LaterFix extends Fix {
  repo: string;
  number: number;
  mergedAt: string;
  base: string;
  /** Its own bundle, cut at its merge, for the labellers. */
  bundle: Bundle;
  /** Its own label from `labels.json`, #80's, for comparison only. */
  label80: Label | null;
}

export interface CalDeps {
  /** The fix, or why it is not one: not a pull request, not merged, merged before the floor. */
  fix(repo: string, number: number): LaterFix | { skip: string };
  origin(fix: LaterFix): Origin;
  bundle(repo: string, number: number): Bundle;
  /** One `claude -p` run. */
  annotate(system: string, request: string): Answer;
  shuffle<T>(xs: T[]): T[];
}

export class Stopped extends Error {}

/** A function the fix changed: from the hunk headers of its diff, or a `fn` line it removed or added. */
export function changedFunction(diff: string): string | null {
  // Only the fix's code: a test's function is not one the defect lived in.
  const isTest = (path: string) => /(^|\/)(tests?|benches|examples)\//.test(path) || /(^|\/)(\w*_tests?|test_\w*)\.rs$/.test(path);
  const lines: string[] = [];
  let skip = false;
  for (const line of diff.split("\n")) {
    const file = /^diff --git a\/(\S+) b\//.exec(line);
    if (file) skip = isTest(file[1]!);
    if (!skip) lines.push(line);
  }
  for (const line of lines) {
    const header = /^@@ [^@]+ @@.*\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (header) return header[1]!;
  }
  for (const line of lines) {
    const own = /^[-+]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (own) return own[1]!;
  }
  return null;
}

const squeeze = (s: string) => s.replace(/\s+/g, " ");
const wordsOf = (b: Bundle) => squeeze([b.pull.title, b.pull.body, ...b.pull.comments, ...b.pull.reviews, ...b.issues.flatMap((i) => [i.title, i.body, ...i.comments])].join("\n"));

/** The same requirements with the fix's function named in the first: the planted hindsight. */
export function plant(requirements: readonly Requirement[], name: string): Requirement[] {
  return requirements.map((r, i) => (i === 0 ? { ...r, text: `${r.text.replace(/\.\s*$/, "")} (the call in \`${name}\`).` } : r));
}

export interface CaseRecord {
  fix: string;
  origin: Origin;
  label80: Label | null;
  labels: Label[];
  screen: Label;
  kept: boolean | null;
  written?: { requirements: Requirement[] } | { none: string } | { invalid: string };
  name?: string | null;
  why?: string;
}

export interface Checked {
  case: string;
  kind: "clean" | "planted" | "leak";
  requirements: Requirement[];
  leftOut: boolean;
  second?: boolean;
}

export interface Calibration {
  version: 1;
  promptsVersion: number;
  cases: CaseRecord[];
  checked: Checked[];
  verdict: "pass" | "fail" | "insufficient" | "stopped";
  why: string;
  counts: { plantedLeftOut: number; cleanLeftOut: number; agreement: number | null; leakWritten: number; leakCaught: number; runs: number; byRepo: Record<string, number> };
  /** Recorded answers that were given up on — a budget reached or an answer never counted. They decide nothing. */
  recordsCut: number;
}

/** A candidate: dev's pool (with #80's label, which the screen is only set against) or dev's extra search (without). */
export interface Candidate {
  repo: string;
  number: number;
  /** `pool` rows keep #80's label; `extra` rows have none, and the screen decides whether they are kept. */
  source: "pool" | "extra";
}

/**
 * The whole calibration, over `candidates` in their order. A repository's case is the first of its rows
 * to pass every step; its later rows are not tried. `alreadyRun` counts runs spent before (the N=1 run),
 * so the budget is the whole of it. Never throws for want of answers: a calibration that cannot go on is
 * `stopped`, with what it had, so the record is written and the runs it spent are counted.
 */
export function calibrate(candidates: readonly Candidate[], deps: CalDeps, alreadyRun = 0): Calibration {
  let runs = alreadyRun;
  let recordsCut = 0;
  /** One answer the verdict needs: asked again up to `CAL.retries` times; none counted stops the calibration. */
  const ask = (system: string, request: string, valid: (json: unknown) => boolean = () => true): unknown => {
    for (let attempt = 0; attempt <= CAL.retries; attempt++) {
      if (runs >= CAL.maxRuns) throw new Stopped(`the calibration reached ${CAL.maxRuns} runs, the number allowed`);
      runs += 1;
      const a = deps.annotate(system, request);
      if (a.counted && valid(a.json)) return a.json;
    }
    throw new Stopped(`an annotator gave no answer that could be counted in ${CAL.retries + 1} attempts; nothing is decided from it`);
  };
  /** One answer only recorded: given up on without stopping, so it can never decide or block the verdict. */
  const record = (system: string, request: string, valid?: (json: unknown) => boolean): unknown | null => {
    try {
      return ask(system, request, valid);
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      recordsCut += 1;
      return null;
    }
  };
  const labelled = (json: unknown) => readLabel(json) !== null;
  const screen = (fix: LaterFix, keep: (f: LaterFix) => unknown) => {
    const labels = [0, 1, 2].map(() => readLabel(keep(fix)) ?? "cannot_label");
    return { labels, screen: majority(labels) };
  };

  const cases: CaseRecord[] = [];
  const usable: { key: string; fix: LaterFix; bundle: Bundle; requirements: Requirement[]; name: string; rec: CaseRecord; source: Candidate["source"] }[] = [];
  /** The verdict's answers as they come, so a calibration that stops still records how far it got. */
  const checked: Checked[] = [];
  const done = new Set<string>();
  const counts = () => {
    const byRepo: Record<string, number> = {};
    for (const u of usable) byRepo[u.fix.repo] = (byRepo[u.fix.repo] ?? 0) + 1;
    return { plantedLeftOut: 0, cleanLeftOut: 0, agreement: null, leakWritten: 0, leakCaught: 0, runs, byRepo };
  };
  const result = (verdict: Calibration["verdict"], why: string, checked: Checked[] = [], more: Partial<Calibration["counts"]> = {}): Calibration => ({ version: 1, promptsVersion: PROMPTS_VERSION, cases, checked, verdict, why, counts: { ...counts(), ...more, runs }, recordsCut });

  try {
    for (const c of candidates) {
      if (usable.length >= CAL.cases) break;
      if (done.has(c.repo.toLowerCase())) continue;
      const fix = deps.fix(c.repo, c.number);
      if ("skip" in fix) continue;
      const key = `${c.repo}#${c.number}`;
      // The steps that run no annotator first (RETRO.md v2, "Candidates").
      const origin = deps.origin(fix);
      const rec: CaseRecord = { fix: key, origin, label80: fix.label80, labels: [], screen: "cannot_label", kept: null };
      cases.push(rec);
      if (origin.number === null) {
        rec.why = origin.why;
        continue;
      }
      const bundle = deps.bundle(c.repo, origin.number);
      if (bundle.unavailable.length > 0) {
        rec.why = `the bundle is not complete: ${bundle.unavailable.join("; ")}`;
        continue;
      }
      // An extra row has no label from #80: the screen decides it, as it will for a sealed row.
      if (c.source === "extra") {
        Object.assign(rec, screen(fix, (f) => ask(LABEL_SYSTEM, labelRequest(f.bundle), labelled)));
        rec.kept = KEEP_LABELS.includes(rec.screen);
        if (!rec.kept) {
          rec.why = `screened out as ${rec.screen}`;
          continue;
        }
      }
      const written = acceptRequirements(ask(WRITE_SYSTEM, writeRequest(bundle)), bundle);
      rec.written = written;
      if (!("requirements" in written)) continue;
      const name = changedFunction(fix.diff);
      rec.name = name;
      if (name === null || wordsOf(bundle).includes(name)) {
        rec.why = name === null ? "no function name in the fix's diff to plant" : `\`${name}\` is in the bundle already`;
        continue;
      }
      usable.push({ key, fix, bundle, requirements: written.requirements, name, rec, source: c.source });
      done.add(c.repo.toLowerCase());
    }
    if (usable.length < CAL.cases) return result("insufficient", `${usable.length} of ${CAL.cases} cases had a requirement written and a name to plant`);

    const leftOut = (json: unknown) => Array.isArray((json as { leaked?: unknown } | null)?.leaked) && (json as { leaked: unknown[] }).leaked.length > 0;
    const answered = (json: unknown) => Array.isArray((json as { leaked?: unknown } | null)?.leaked);
    const items = deps.shuffle(usable.flatMap((u) => [
      { u, kind: "clean" as const, requirements: u.requirements },
      { u, kind: "planted" as const, requirements: plant(u.requirements, u.name) },
    ]));
    // The verdict's twenty, all asked before anything that is only recorded — the pool rows' screen too,
    // so a recorded answer never spends the budget the verdict needs.
    for (const it of items) checked.push({ case: it.u.key, kind: it.kind, requirements: it.requirements, leftOut: leftOut(ask(CHECK_SYSTEM, checkRequest(it.u.bundle, it.u.fix, it.requirements), answered)) });
    const main = [...checked];
    const plantedLeftOut = main.filter((c) => c.kind === "planted" && c.leftOut).length;
    const cleanLeftOut = main.filter((c) => c.kind === "clean" && c.leftOut).length;
    const pass = plantedLeftOut >= CAL.plantedLeftOutAtLeast && cleanLeftOut <= CAL.cleanLeftOutAtMost;

    // Recorded, never in the verdict: a pool row's screen against #80's label, the same twenty checked
    // again, and the fix-aware writer's ten.
    for (const u of usable) {
      if (u.source !== "pool") continue;
      Object.assign(u.rec, screen(u.fix, (f) => record(LABEL_SYSTEM, labelRequest(f.bundle), labelled)));
      u.rec.kept = KEEP_LABELS.includes(u.rec.screen);
    }
    items.forEach((it, i) => {
      const again = record(CHECK_SYSTEM, checkRequest(it.u.bundle, it.u.fix, it.requirements), answered);
      if (again !== null) checked[i]!.second = leftOut(again);
    });
    let leakWritten = 0;
    let leakCaught = 0;
    for (const u of usable) {
      const json = record(LEAK_SYSTEM, leakRequest(u.bundle, u.fix));
      if (json === null) continue;
      const w = acceptRequirements(json, u.bundle);
      if (!("requirements" in w)) continue;
      leakWritten += 1;
      const out = record(CHECK_SYSTEM, checkRequest(u.bundle, u.fix, w.requirements), answered);
      if (out === null) continue;
      if (leftOut(out)) leakCaught += 1;
      checked.push({ case: u.key, kind: "leak", requirements: w.requirements, leftOut: leftOut(out) });
    }
    const twice = main.filter((c) => c.second !== undefined);
    const agreement = twice.length === 0 ? null : twice.filter((c) => c.second === c.leftOut).length / twice.length;
    return result(
      pass ? "pass" : "fail",
      `left out ${plantedLeftOut} of ${CAL.cases} with a planted name and ${cleanLeftOut} of ${CAL.cases} without; the line is at least ${CAL.plantedLeftOutAtLeast} and at most ${CAL.cleanLeftOutAtMost}`,
      checked,
      { plantedLeftOut, cleanLeftOut, agreement, leakWritten, leakCaught },
    );
  } catch (error) {
    if (error instanceof Stopped) return result("stopped", error.message, checked);
    // Anything else — the network, a clone — is not a fact about a case either: stopped, with its words.
    return result("stopped", `stopped by an error: ${error instanceof Error ? error.message : String(error)}`, checked);
  }
}

// ---- The dev candidates and the real deps ------------------------------------------------------

/** Dev's later fixes: the pool's rows #80 labelled with a kept label, in the pool's order, each once. */
export function devCandidates(pool: Pick<Pool, "rows">): (Candidate & { label80: Label })[] {
  const out: (Candidate & { label80: Label })[] = [];
  const ids = new Set<string>();
  for (const r of pool.rows as { id: string; repo: string; label?: { label: Label } }[]) {
    const label = r.label?.label;
    if (!label || !KEEP_LABELS.includes(label) || ids.has(r.id)) continue;
    ids.add(r.id);
    out.push({ repo: r.id.split("#")[0]!, number: Number(r.id.split("#")[1]), source: "pool", label80: label });
  }
  return out;
}

const EARLIEST_FIX = "2026-07-01";

export function realCalDeps(clones: string, labels80: Map<string, Label>, empty: string): CalDeps {
  const api = (path: string) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const defaults = new Map<string, string>();
  const cloneOf = (repo: string) => {
    const dir = join(clones, repo.replace("/", "__"));
    if (!existsSync(dir)) execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `https://github.com/${repo}.git`, dir], { stdio: "ignore" });
    // A clone taken before the fix merged may not hold its base: fetched every time it is used.
    else execFileSync("git", ["-C", dir, "fetch", "-q", "origin"], { stdio: "ignore" });
    return dir;
  };
  return {
    fix(repo, number) {
      let p: { merged_at: string | null; base: { sha: string }; title: string; body: string | null };
      try {
        p = api(`repos/${repo}/pulls/${number}`);
      } catch (error) {
        // Only GitHub saying there is no such pull request makes a row "not a pull request"; any other
        // failure — a rate limit, the network — stops the calibration instead of changing the candidates.
        if (/HTTP 404/.test(String(error))) return { skip: "not a pull request" };
        throw error;
      }
      if (!p.merged_at) return { skip: "not merged" };
      if (p.merged_at < EARLIEST_FIX) return { skip: `merged before ${EARLIEST_FIX}` };
      // The API's raw diff, escape sequences allowed: `gh pr diff` and `gh api` both refuse a diff holding them
      // (beboite/boite-legacy#187 stopped the first attempt, 2026-09-25). It is only ever read as text.
      const diff = execFileSync("gh", ["api", "--allow-escape-sequences", "-H", "Accept: application/vnd.github.v3.diff", `repos/${repo}/pulls/${number}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { repo, number, ref: `${repo}#${number}`, title: p.title, body: p.body ?? "", diff, mergedAt: p.merged_at, base: p.base.sha, bundle: fetchBundle(repo, number), label80: labels80.get(`${repo}#${number}`) ?? null };
    },
    origin(fix) {
      const clone = cloneOf(fix.repo);
      // The default branch as it is now, not the fix's base name (origin.ts, `onDefault`).
      if (!defaults.has(fix.repo)) defaults.set(fix.repo, (api(`repos/${fix.repo}`) as { default_branch: string }).default_branch);
      return originOf(namedOrigins([fix.title, fix.body]), { base: fix.base, mergedAt: fix.mergedAt }, fix.diff, realDeps(clone, fix.repo, `origin/${defaults.get(fix.repo)}`));
    },
    bundle: (repo, number) => fetchBundle(repo, number),
    annotate: (system, request) => annotate(system, request, empty),
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

const AUDIT = join(homedir(), ".local", "share", "omamori", "audit.jsonl");

/** What 01's procedure records around the first run: the workspace's main and tree, the audit log's size. */
export function workspaceState() {
  const ws = join(homedir(), "claude_workspace");
  return {
    originMain: execFileSync("git", ["-C", ws, "log", "origin/main", "--format=%H %s", "-1"], { encoding: "utf8" }).trim(),
    statusLines: execFileSync("git", ["-C", ws, "status", "--short"], { encoding: "utf8" }).split("\n").filter(Boolean).length,
    auditBytes: existsSync(AUDIT) ? statSync(AUDIT).size : null,
  };
}

/**
 * Whether the N=1 run left a mark of its own. Other sessions work in the same workspace, so a moved
 * `origin/main` or a longer `git status` is recorded and not taken for this run's: what stops the
 * calibration is what only this run could make — an auto-backup commit (the SessionEnd hook, which a
 * `claude -p` loading user settings would fire) or the audit log naming the run's empty directory — or
 * a run that gave no answer to count.
 */
export function n1Problem(arrived: readonly string[], appendedAudit: string, emptyDir: string, counted: boolean): string | null {
  if (!counted) return "the N=1 run gave no answer that could be counted";
  // Every commit that reached main during the run, not only the newest: another session's may be on top.
  const backup = arrived.find((subject) => /^Auto-backup:/.test(subject));
  if (backup !== undefined) return `an auto-backup commit reached the workspace's main during the N=1 run: ${backup}`;
  if (appendedAudit.includes(emptyDir)) return "omamori's audit log names the N=1 run's directory";
  return null;
}

/** Subjects of the commits on the workspace's `origin/main` after `from` and up to `to`. */
function arrivedBetween(from: string, to: string): string[] {
  if (from === to) return [];
  const ws = join(homedir(), "claude_workspace");
  return execFileSync("git", ["-C", ws, "log", "--format=%s", `${from.split(" ")[0]}..${to.split(" ")[0]}`], { encoding: "utf8" }).split("\n").filter(Boolean);
}

function readAppended(from: number | null): string {
  if (from === null || !existsSync(AUDIT)) return "";
  const size = statSync(AUDIT).size;
  // A log rotated during the run is shorter than before: read the new one from its start.
  if (size < from) from = 0;
  if (size === from) return "";
  const fd = openSync(AUDIT, "r");
  try {
    const buf = Buffer.alloc(Math.min(size - from, 16 * 1024 * 1024));
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function main(clones: string) {
  const earlier: { verdict?: string; counts?: { runs?: number }; n1?: unknown }[] = [];
  for (let n = 1; existsSync(recordOf(n)); n++) earlier.push(JSON.parse(readFileSync(recordOf(n), "utf8")));
  if (earlier.some((r) => r.verdict === "pass" || r.verdict === "fail" || r.verdict === "insufficient")) throw new Error("a calibration already reached its verdict; it is not taken again");
  const { number: attempt, spent } = nextAttempt(earlier);
  if (spent + 1 >= CAL.maxRuns) throw new Error(`earlier attempts spent ${spent} of the ${CAL.maxRuns} runs allowed`);
  const RECORD = recordOf(attempt);
  mkdirSync(clones, { recursive: true });
  const pool = JSON.parse(readFileSync(join(HERE, "..", "pool.json"), "utf8")) as Pool;
  const fromPool = devCandidates(pool);
  const labels80 = new Map(fromPool.map((c) => [`${c.repo}#${c.number}`, c.label80]));
  // Dev's extra material, when it was searched (`search.ts --dev`): tried after the pool, screened.
  // A row the pool already has is not tried twice (that would draw its writer again).
  const inPool = new Set(fromPool.map((c) => `${c.repo}#${c.number}`.toLowerCase()));
  const extra: Candidate[] = (existsSync(DEV_SEARCH) ? (JSON.parse(readFileSync(DEV_SEARCH, "utf8")) as Search).rows : [])
    .map((r) => ({ repo: r.ref.split("#")[0]!, number: Number(r.ref.split("#")[1]), source: "extra" as const }))
    .filter((c) => !inPool.has(`${c.repo}#${c.number}`.toLowerCase()));
  // The system temp directory, as the baseline of #88 runs: nothing above it is a repository or holds
  // `.claude` (the home directory does: `~/.claude` would reach the model, and `assertEmptyDir` refuses it).
  const empty = mkdtempSync(join(tmpdir(), "jir-annotator-"));
  const deps = realCalDeps(clones, labels80, empty);
  // N=1 first: one writer's run, with the workspace's state before and after it. It counts toward the 250.
  const before = workspaceState();
  const probe = deps.annotate(WRITE_SYSTEM, writeRequest({ repo: "o/r", pull: { number: 1, title: "Read the config", body: "Reading the config must fail loudly when the file cannot be read.", comments: [], reviews: [] }, issues: [], unavailable: [] }));
  const after = workspaceState();
  const problem = n1Problem(arrivedBetween(before.originMain, after.originMain), readAppended(before.auditBytes), empty, probe.counted);
  const n1 = { before, after, emptyDir: empty, probe: { counted: probe.counted, model: probe.model, why: probe.why ?? null }, problem };
  console.log(JSON.stringify(n1, null, 2));
  const result: Calibration | { verdict: "stopped"; why: string } = problem !== null ? { verdict: "stopped", why: problem } : calibrate([...fromPool, ...extra], deps, spent + 1);
  writeFileSync(RECORD, `${JSON.stringify({ ...result, attempt, spentBefore: spent, n1, extraRows: extra.length }, null, 2)}\n`);
  console.log(`${result.verdict}: ${result.why}${"counts" in result ? ` (${result.counts.runs} runs)` : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv[2] ?? join(homedir(), ".cctmp", "jir-retro-clones"));
