// `check_before_action` on the code of the acceptance set's pull requests (#39), through the command
// line, against real Jev — the way the failure form was measured there: the shipped code, a mutation
// whose behaviour difference was observed, a behaviour-preserving rewrite, and the check hidden in a
// helper, with the table of right readings fixed before the first request.
//
//   node bench/forms/real.ts precheck <acceptance dir>          which calls each version would ask; sends nothing
//   node bench/forms/real.ts measure  <acceptance dir> [runs]   each version `runs` times (default 3)
//
// `<acceptance dir>` holds the clones (`moltis`, `grovedb`), as for `bench/acceptance/run.ts`. Each
// case is a directory under `real/`: `case.json` names the clone, the pull request's base and head,
// the spec (the sentence written for `bench/forms/reach/`, used as it is), the target call and each
// version's patches; `expected.json` is the table. A version is built as commits in the clone with a
// fixed author and date, so the same patches give the same commits, and kept under
// `refs/bench/check-before-action/`. Before anything is sent the log's head records the sha256 of
// every case file; a log started under other files is not added to.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { meets, once, type Distilled, type Row } from "./common.ts";

const HERE = new URL("./real/", import.meta.url).pathname;
// v1 is the measurement with the tool before calls named by the requirement took their turns first
// (#39, ADR 0016), v2 the one after it; v3 the one after the check's body is sent with the packet
// (#82, ADR 0019). A later tool writes a later version.
const LOG = new URL("../logs/check-before-action-real-v4.json", import.meta.url).pathname;
const VERSIONS = ["shipped", "defect", "rewrite", "hidden", "helper"] as const;
type Version = (typeof VERSIONS)[number];

export interface RealCase {
  id: string;
  clone: string;
  base: string;
  head: string;
  /** Relative to the case directory. */
  spec: string;
  target: { function: string; call: string };
  versions: Record<Version, { base?: string[]; head?: string[] }>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const FIXED = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid", GIT_AUTHOR_DATE: "2026-09-24T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-24T00:00:00Z" };
const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...FIXED } }).trim();

export function loadRealCases(dir = HERE): { dir: string; c: RealCase }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: join(dir, e.name), c: JSON.parse(readFileSync(join(dir, e.name, "case.json"), "utf8")) as RealCase }));
}

/** Every file of a case whose bytes a measurement rests on, by name, with its sha256. */
export function caseFiles(dir: string, c: RealCase): Record<string, string> {
  const names = new Set(["case.json", "expected.json", ...Object.values(c.versions).flatMap((v) => [...(v.base ?? []), ...(v.head ?? [])])]);
  const files: Record<string, string> = {};
  for (const n of [...names].sort()) files[n] = sha256(readFileSync(join(dir, n), "utf8"));
  files[`spec: ${c.spec}`] = sha256(readFileSync(resolve(dir, c.spec), "utf8"));
  return files;
}

/** One commit: `from` with `patches` applied, or `from` itself when there are none. */
function commitOf(repo: string, from: string, patches: string[], dir: string, label: string): string {
  if (patches.length === 0) return from;
  const box = join(homedir(), ".cctmp");
  mkdirSync(box, { recursive: true });
  const work = mkdtempSync(join(box, "forms-real-"));
  git(repo, ["worktree", "add", "-q", "--detach", work, from]);
  try {
    for (const p of patches) git(work, ["apply", join(dir, p)]);
    git(work, ["commit", "-q", "-am", label]);
    return git(work, ["rev-parse", "HEAD"]);
  } finally {
    git(repo, ["worktree", "remove", "--force", work]);
  }
}

/** The base and head commits of every version, built once and kept under refs/bench. */
function build(acceptance: string, dir: string, c: RealCase): Record<Version, { base: string; head: string }> {
  const repo = join(acceptance, c.clone);
  const out = {} as Record<Version, { base: string; head: string }>;
  for (const v of VERSIONS) {
    const spec = c.versions[v];
    const base = commitOf(repo, c.base, spec.base ?? [], dir, `${c.id} ${v} base`);
    const head = commitOf(repo, c.head, spec.head ?? [], dir, `${c.id} ${v} head`);
    git(repo, ["update-ref", `refs/bench/check-before-action/${c.id}/${v}/base`, base]);
    git(repo, ["update-ref", `refs/bench/check-before-action/${c.id}/${v}/head`, head]);
    out[v] = { base, head };
  }
  return out;
}

async function precheck(acceptance: string) {
  for (const { dir, c } of loadRealCases()) {
    const commits = build(acceptance, dir, c);
    const target = `${c.target.function} · ${c.target.call}`;
    for (const v of VERSIONS) {
      const r = await once(join(acceptance, c.clone), resolve(dir, c.spec), commits[v].base, commits[v].head, true);
      const at = r.wouldAsk.indexOf(target);
      console.log(`${c.id} ${v.padEnd(8)} exit ${r.exit}, requests ${r.requests}; inside the budgets ${r.wouldAsk.length}, could be asked ${r.counts ? r.counts.applicable + (r.counts.siblings?.applicable ?? 0) : "?"}; target ${at >= 0 ? `inside, position ${at + 1}` : "NOT inside"}`);
    }
  }
}

type Log = {
  conditions: { files: Record<string, Record<string, string>>; runsPerVersion: number; provider: string };
  tool: { head: string };
  cases: Record<string, Partial<Record<Version, { base: string; head: string; runs: Distilled[]; notInside?: true }>>>;
};

async function measure(acceptance: string, runs: number) {
  const cases = loadRealCases();
  const conditions = { files: Object.fromEntries(cases.map(({ dir, c }) => [c.id, caseFiles(dir, c)])), runsPerVersion: runs, provider: process.env.JEV_PROVIDER ?? "(unset)" };
  const tool = git(new URL("../..", import.meta.url).pathname, ["rev-parse", "HEAD"]);
  const log: Log = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : { conditions, tool: { head: tool }, cases: {} };
  if (JSON.stringify(log.conditions) !== JSON.stringify(conditions)) throw new Error(`the log was started under other files:\n${JSON.stringify(log.conditions)}\nnow:\n${JSON.stringify(conditions)}`);
  writeFileSync(LOG, `${JSON.stringify(log, null, 2)}\n`);

  for (const { dir, c } of cases) {
    const commits = build(acceptance, dir, c);
    const entries = (log.cases[c.id] ??= {});
    for (const v of VERSIONS) {
      const entry = (entries[v] ??= { ...commits[v], runs: [] });
      if (entry.head !== commits[v].head || entry.base !== commits[v].base) throw new Error(`${c.id} ${v}: the commits moved`);
      // A target outside the budgets is settled by the listing: nothing is sent for that version.
      if (entry.runs.length === 0 && !entry.notInside) {
        const pre = await once(join(acceptance, c.clone), resolve(dir, c.spec), entry.base, entry.head, true);
        if (!pre.wouldAsk.includes(`${c.target.function} · ${c.target.call}`)) {
          entry.notInside = true;
          writeFileSync(LOG, `${JSON.stringify(log, null, 2)}\n`);
          console.log(`${c.id} ${v}: the target is not inside the budgets; settled by the listing, nothing sent`);
        }
      }
      while (!entry.notInside && entry.runs.length < runs) {
        const r = await once(join(acceptance, c.clone), resolve(dir, c.spec), entry.base, entry.head, false);
        entry.runs.push(r);
        writeFileSync(LOG, `${JSON.stringify(log, null, 2)}\n`);
        console.log(`${c.id} ${v} run ${entry.runs.length}: exit ${r.exit}, ${r.requests} requests to ${r.origins.join(", ") || "nowhere"}; findings ${JSON.stringify(r.findings)}`);
        if (r.exit !== 0) console.log(`    stderr: ${r.stderr}`);
      }
    }
  }
  console.log(score(log, runs).join("\n"));
}

/**
 * The table a log was taken under: the log records `expected.json`'s sha256, and a table replaced
 * since is kept byte for byte as `expected-v<n>.json` (version 1: hidden recorded, not scored). A log
 * whose sha matches none — one written by hand — scores under the current table.
 */
function tableOf(dir: string, c: RealCase, log: Log): { scored: Record<string, Row>; recorded: Record<string, Row> } {
  const recorded = log.conditions.files?.[c.id]?.["expected.json"];
  const names = ["expected.json", ...readdirSync(dir).filter((n) => /^expected-v\d+\.json$/.test(n))];
  const name = names.find((n) => sha256(readFileSync(join(dir, n), "utf8")) === recorded);
  // A log whose recorded table matches none kept here — a table replaced without its
  // `expected-v<n>.json` kept — is scored under the current one, and says so rather than passing
  // quietly. A log that records no table at all (one written by hand, in a test) is scored under
  // the current one without a word: it has nothing to match.
  if (name === undefined && recorded !== undefined) console.error(`${c.id}: the log's expected.json (${recorded.slice(0, 12)}…) matches no table in ${dir}; scoring under the current one`);
  return JSON.parse(readFileSync(join(dir, name ?? "expected.json"), "utf8")) as { scored: Record<string, Row>; recorded: Record<string, Row> };
}

/** Each case's scored and recorded rows against the log, and whether every scored version passed. */
export function score(log: Log, runs: number, cases = loadRealCases()): string[] {
  const lines: string[] = [];
  let all = true;
  for (const { dir, c } of cases) {
    const expected = tableOf(dir, c, log);
    for (const [part, rows] of [["scored", expected.scored], ["recorded, not scored", expected.recorded]] as const) {
      lines.push(`${c.id} ${part}:`);
      for (const [v, row] of Object.entries(rows)) {
        const entry = log.cases[c.id]?.[v as Version];
        if (entry?.notInside) {
          if (part === "scored") all = false;
          lines.push(`  ${v.padEnd(8)} not reached: the target is not inside the budgets, nothing sent`);
          continue;
        }
        const results = (entry?.runs ?? []).slice(0, runs).map((r) => meets(row, r));
        const good = results.filter((x) => x.ok).length;
        if (part === "scored" && (good !== runs || results.length !== runs)) all = false;
        lines.push(`  ${v.padEnd(8)} ${good}/${runs}${results.flatMap((x) => x.misses).map((m) => `\n      ${m}`).join("")}`);
      }
    }
  }
  lines.push(`${all ? "PASS" : "FAIL"}: every scored version meets its row in each of ${runs} runs`);
  return lines;
}

const [mode, acceptance, n] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (mode === "precheck" && acceptance) await precheck(acceptance);
  else if (mode === "measure" && acceptance) await measure(acceptance, Number(n ?? 3));
  else throw new Error("usage: node bench/forms/real.ts precheck <acceptance dir> | measure <acceptance dir> [runs]");
}
