// The constructed case for `check_before_action`, through the command line, against real Jev.
//
//   node bench/forms/run.ts precheck        which calls each version would ask about; sends nothing
//   node bench/forms/run.ts measure [runs]  each version `runs` times (default 3), recorded and scored
//
// `measure` needs JEV_PROVIDER and that host's key in the environment, as the CLI does. It records
// the host's origin and the number of requests per run, never a header or a key.
//
// The case is built in a throwaway git repository under ~/.cctmp: one base commit, and one commit per
// version on top of it, all with a fixed author and date so the same files give the same commits.
// Before anything is sent, the log's head records the sha256 of the expected table, the spec and
// every version file; a log started under other files is not added to.
//
// This case was written to exercise the form, so it is not one of the cases "not used to tune
// anything" in `docs/local-check-cli.md`. What it can show is whether the form separates a defect
// from the shipped code and a behaviour-preserving rewrite on code whose names were chosen for it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main.ts";
import type { LocalCheckResult } from "../../src/review/local-check-run.ts";

const HERE = new URL("./check-before-action/", import.meta.url).pathname;
const LOG = new URL("../logs/check-before-action-v1.json", import.meta.url).pathname;
const VERSIONS = ["shipped", "defect", "rewrite", "hidden", "caller"] as const;
type Version = (typeof VERSIONS)[number];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (name: string) => readFileSync(join(HERE, name), "utf8");

const FIXED = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid", GIT_AUTHOR_DATE: "2026-09-22T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-22T00:00:00Z" };

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...FIXED } }).trim();
}

/** The throwaway repository, and the commit of each version. */
function build(): { dir: string; base: string; heads: Record<Version, string> } {
  const box = join(homedir(), ".cctmp");
  mkdirSync(box, { recursive: true });
  const dir = mkdtempSync(join(box, "forms-cba-"));
  git(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(join(dir, "src"));
  // `main.rs` is the probe that runs a version (`rustc`), not part of the code under review: in the
  // repository it would be one more caller of `open_session`, and its calls more places to ask.
  writeFileSync(join(dir, "src/store.rs"), read("store.rs"));
  writeFileSync(join(dir, "src/auth.rs"), read("base.rs"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  const heads = {} as Record<Version, string>;
  for (const v of VERSIONS) {
    git(dir, ["checkout", "-q", "-B", v, base]);
    writeFileSync(join(dir, "src/auth.rs"), read(`${v}.rs`));
    git(dir, ["commit", "-q", "-am", v]);
    heads[v] = git(dir, ["rev-parse", "HEAD"]);
  }
  git(dir, ["checkout", "-q", "main"]);
  return { dir, base, heads };
}

interface Distilled {
  exit: number;
  requests: number;
  origins: string[];
  observed: { key: string; outcome: string; mapping: string; observation: string }[];
  findings: string[];
  unchecked: { key: string; why: string }[];
  counts: LocalCheckResult["counts"];
  stderr: string;
}

async function once(repo: string, base: string, head: string, candidatesOnly: boolean): Promise<Distilled> {
  const out: string[] = [];
  const err: string[] = [];
  let requests = 0;
  const origins = new Set<string>();
  const counting: typeof fetch = (input, init) => {
    requests += 1;
    origins.add(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).origin);
    return fetch(input, init);
  };
  const args = ["--experimental-local-check", "--intent-spec", join(HERE, "spec.json"), "--base", base, "--head", head, "--json", ...(candidatesOnly ? ["--experimental-candidates-only"] : [])];
  const exit = await main(args, { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: repo, env: process.env }, { fetch: counting });
  const report = out.length > 0 ? (JSON.parse(out.join("")) as { requirements: LocalCheckResult[] }) : { requirements: [] };
  const r = report.requirements[0];
  const key = (o: { function: string; call: string }) => `${o.function} · ${o.call}`;
  return {
    exit,
    requests,
    origins: [...origins],
    observed: (r?.observed ?? []).map((o) => {
      const m = r!.mappings.find((x) => x.callId === o.callId);
      return { key: key(o), outcome: o.outcome, mapping: m ? `${m.verdict} ${m.probability.toFixed(2)}` : "none", observation: `${o.result.observation} ${o.result.probability.toFixed(2)}` };
    }),
    findings: (r?.findings ?? []).map(key),
    unchecked: (r?.unchecked ?? []).map((u) => ({ key: key(u), why: u.why })),
    counts: r?.counts as LocalCheckResult["counts"],
    stderr: err.join("").slice(0, 2000),
  };
}

type Row = Record<string, string>;

/** Whether one run meets its version's row. */
function meets(row: Row, run: Distilled): { ok: boolean; misses: string[] } {
  const misses: string[] = [];
  const outcome = new Map(run.observed.map((o) => [o.key, o.outcome]));
  for (const [key, want] of Object.entries(row)) {
    if (key === "*" || key === "why") continue;
    const got = outcome.get(key);
    if (got === undefined) misses.push(`${key}: not read`);
    else if (want === "not_violates" ? got === "violates" : got !== want) misses.push(`${key}: ${got}, expected ${want}`);
  }
  if (row["*"] === "not_violates") {
    for (const o of run.observed) if (!Object.hasOwn(row, o.key) && o.outcome === "violates") misses.push(`${o.key}: violates, expected not_violates`);
  }
  return { ok: misses.length === 0 && run.exit === 0, misses };
}

async function precheck() {
  const { dir, base, heads } = build();
  for (const v of VERSIONS) {
    const r = await once(dir, base, heads[v], true);
    console.log(`${v.padEnd(8)} exit ${r.exit}, requests ${r.requests}; could be asked: ${r.counts ? `${r.counts.applicable} of ${r.counts.calls}` : "?"}`);
    for (const u of r.unchecked) console.log(`    held  ${u.key}: ${u.why}`);
  }
  console.log(`repository: ${dir}`);
}

async function measure(runs: number) {
  const expected = JSON.parse(read("expected.json")) as { scored: Record<string, Row>; recorded: Record<string, Row> };
  const files = Object.fromEntries(["expected.json", "spec.json", "store.rs", "base.rs", "main.rs", ...VERSIONS.map((v) => `${v}.rs`)].map((f) => [f, sha256(read(f))]));
  const tool = execFileSync("git", ["-C", new URL("../..", import.meta.url).pathname, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const source = Object.fromEntries(["src/plan/forms.ts", "src/review/outcome.ts", "src/review/local-check-run.ts", "src/plan/local-check.ts", "src/plan/mapping.ts"].map((f) => [f, sha256(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"))]));
  const conditions = { files, runsPerVersion: runs, provider: process.env.JEV_PROVIDER ?? "(unset)" };
  type Log = { conditions: typeof conditions; tool: { head: string; source: Record<string, string>; note: string }; versions: Partial<Record<Version, { base: string; head: string; runs: Distilled[] }>> };
  const log: Log = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : { conditions, tool: { head: tool, source, note: "the source was uncommitted when measured; `source` is the sha256 of each file as it ran" }, versions: {} };
  if (JSON.stringify(log.conditions) !== JSON.stringify(conditions)) throw new Error(`the log was started under other files:\n${JSON.stringify(log.conditions)}\nnow:\n${JSON.stringify(conditions)}`);
  writeFileSync(LOG, `${JSON.stringify(log, null, 2)}\n`);

  const { dir, base, heads } = build();
  for (const v of VERSIONS) {
    const entry = (log.versions[v] ??= { base, head: heads[v], runs: [] });
    if (entry.head !== heads[v] || entry.base !== base) throw new Error(`${v}: the commits moved (${entry.base}..${entry.head} logged, ${base}..${heads[v]} now)`);
    while (entry.runs.length < runs) {
      const r = await once(dir, base, heads[v], false);
      entry.runs.push(r);
      writeFileSync(LOG, `${JSON.stringify(log, null, 2)}\n`);
      console.log(`${v} run ${entry.runs.length}: exit ${r.exit}, ${r.requests} requests to ${r.origins.join(", ") || "nowhere"}; findings ${JSON.stringify(r.findings)}`);
      if (r.exit !== 0) console.log(`    stderr: ${r.stderr}`);
    }
  }

  console.log("\nscored:");
  let all = true;
  for (const [v, row] of Object.entries(expected.scored)) {
    const results = log.versions[v as Version]!.runs.slice(0, runs).map((r) => meets(row, r));
    const good = results.filter((x) => x.ok).length;
    if (good !== runs) all = false;
    console.log(`  ${v.padEnd(8)} ${good}/${runs}${results.flatMap((x) => x.misses).map((m) => `\n      ${m}`).join("")}`);
  }
  console.log("recorded, not scored:");
  for (const [v, row] of Object.entries(expected.recorded)) {
    const results = log.versions[v as Version]!.runs.slice(0, runs).map((r) => meets(row, r));
    console.log(`  ${v.padEnd(8)} ${results.filter((x) => x.ok).length}/${runs} as the table reads${results.flatMap((x) => x.misses).map((m) => `\n      ${m}`).join("")}`);
  }
  console.log(`\n${all ? "PASS" : "FAIL"}: every scored version meets its row in each of ${runs} runs`);
  console.log(`repository: ${dir}`);
}

const [mode, n] = process.argv.slice(2);
if (mode === "precheck") await precheck();
else if (mode === "measure") await measure(Number(n ?? 3));
else throw new Error("usage: node bench/forms/run.ts precheck | measure [runs]");
