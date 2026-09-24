// What reading a function's end from the line its body opens on (#74) changes in the regions the
// changes' question asks about, before and after, on the acceptance pre-check's eight cases, every
// version of moltis#1064 and grovedb#500, and omamori `#468`'s five branches. No request is sent.
//
//   node bench/change-regions.ts --acceptance <dir> --omamori <clone> --before <rev> [--out <file>]
//
// `--before` is the commit whose `src/` is "before" (`git archive`); "after" is this tree's `src/`.
// A region is one request of the changes' question when it carries behaviour (`changesBehaviour`),
// and its span and name go into the packet — so a region that splits in two is one more request, and
// one whose span moves is a packet a kept answer no longer covers (ADR 0013).
//
// The evidence the calls are asked with is not measured here: its callers and callees are built only
// when `maxRelatedChars` is above 0, which no run does (`DEFAULT_LOCAL_CHECK`, ADR 0007).

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { acceptance: { type: "string" }, omamori: { type: "string" }, before: { type: "string" }, out: { type: "string" } } });
if (!values.acceptance || !values.omamori || !values.before) throw new Error("usage: node bench/change-regions.ts --acceptance <dir> --omamori <clone> --before <rev> [--out <file>]");
const ACC = resolve(values.acceptance);
const OMA = resolve(values.omamori);
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const beforeRev = git(HERE, "rev-parse", values.before);

function copyOf(from: "before" | "after"): string {
  const dir = mkdtempSync(join(homedir(), ".cctmp", `change-regions-${from}-`));
  if (from === "before") execFileSync("sh", ["-c", `git -C "${HERE}" archive "${beforeRev}" src package.json | tar -x -C "${dir}"`]);
  else {
    cpSync(join(HERE, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(HERE, "package.json"), join(dir, "package.json"));
  }
  symlinkSync(join(HERE, "node_modules"), join(dir, "node_modules"));
  return dir;
}

async function toolAt(root: string) {
  return {
    Git: (await import(join(root, "src/repository/git.ts"))).Git,
    analyzeChange: (await import(join(root, "src/change/seeds.ts"))).analyzeChange,
    changesBehaviour: (await import(join(root, "src/review/unexpected-change.ts"))).changesBehaviour,
    loadConfig: (await import(join(root, "src/config/config.ts"))).loadConfig,
    pathFilter: (await import(join(root, "src/config/glob.ts"))).pathFilter,
  };
}
const TOOLS = { before: await toolAt(copyOf("before")), after: await toolAt(copyOf("after")) };

interface Run {
  case: string;
  version: string;
  clone: string;
  base: string;
  head: string;
}
const runs: Run[] = [];
const PRECHECK = JSON.parse(readFileSync(join(HERE, "bench/acceptance/precheck-shipped.json"), "utf8")) as { cases: Record<string, { revisions: { before: string; after: string } }> };
const CLONES: Record<string, string> = { "whatsapp-rust-759": "whatsapp-rust", "moltis-1064": "moltis", "kontor-385": "Kontor", "instruckt-tauri-9": "instruckt-tauri", "grovedb-501": "grovedb", "grovedb-500": "grovedb", "quebec-136": "quebec", "pybun-428": "pybun" };
for (const [name, clone] of Object.entries(CLONES)) {
  const r = PRECHECK.cases[name]!.revisions;
  runs.push({ case: name, version: "shipped", clone: join(ACC, clone), base: r.before, head: r.after });
}
for (const name of ["moltis-1064", "grovedb-500"]) {
  const c = JSON.parse(readFileSync(join(HERE, "bench/acceptance/cases", name, "case.json"), "utf8")) as { versions: Record<string, { base: string; head: string }> };
  for (const [version, v] of Object.entries(c.versions)) if (version !== "shipped") runs.push({ case: name, version, clone: join(ACC, CLONES[name]!), base: v.base, head: v.head });
}
const OMAMORI: Record<string, string> = {
  correct: "e58c04f6df082146969320b91f09aa7a0123ac1f",
  "m-read-baseline": "46cd434299a05ff8c6d2664f720f0606d7e11579",
  "v-read-baseline": "a3dae0a134cc70952fe467bad860a714e4c45792",
  "m-raw-override": "e8f2fdc8385e539aaffd6602ef869cfcbccd2bea",
  "v-raw-override": "6c96366a0ec6e0e5ef3092866d0a2d2da871e332",
};
for (const [version, head] of Object.entries(OMAMORI)) runs.push({ case: "omamori-468", version, clone: OMA, base: "52a58fa", head });

interface Region {
  path: string;
  code: boolean;
  block: { startLine: number; endLine: number; name?: string; windowed: boolean };
}

async function regionsOf(tool: (typeof TOOLS)["before"], run: Run) {
  const repo = new tool.Git(run.clone);
  const head = git(run.clone, "rev-parse", run.head);
  const before = git(run.clone, "merge-base", run.base, head);
  const { config } = await tool.loadConfig(repo, before, head);
  const include = tool.pathFilter(config.repository.include, config.repository.ignore);
  const change = await tool.analyzeChange(repo, before, head, include);
  const asked = (change.regions as Region[]).filter((r) => tool.changesBehaviour(r));
  return asked.map((r) => `${r.path}:${r.block.startLine}-${r.block.endLine}${r.block.windowed ? "W" : ""}(${r.block.name ?? ""})`);
}

const rows = [];
for (const run of runs) {
  const b = await regionsOf(TOOLS.before, run);
  const a = await regionsOf(TOOLS.after, run);
  const kept = a.filter((x) => b.includes(x));
  rows.push({ case: run.case, version: run.version, before: b.length, after: a.length, same: kept.length, gone: b.filter((x) => !a.includes(x)), new: a.filter((x) => !b.includes(x)) });
  console.log(`${run.case} ${run.version}: ${b.length} -> ${a.length} regions, ${kept.length} unchanged`);
}
const result = {
  what: "The regions the changes' question asks about — one request each — before and after a function's end is read from the line its body opens on (#74). No request sent.",
  before: beforeRev,
  after: `src/ sha256 ${execFileSync("sh", ["-c", `cd "${HERE}" && find src -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256`], { encoding: "utf8" }).split(" ")[0]}`,
  rows,
  totals: { before: rows.reduce((n, r) => n + r.before, 0), after: rows.reduce((n, r) => n + r.after, 0), unchanged: rows.reduce((n, r) => n + r.same, 0) },
};
if (values.out) writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.totals));
