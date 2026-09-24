// What a change to how calls are listed or chosen does, before and after, on the acceptance
// pre-check's eight cases, every version of moltis#1064 and grovedb#500, and omamori `#468`'s five
// branches — with the listing's caps as they are, and with every cap lifted, to see whether the
// order holds as the set grows. No request is sent. v1 measured the callers' own budget (ADR 0015);
// v2 the cap of calls a function (#38, second part).
//
//   node bench/budget-by-origin.ts --acceptance <dir> --omamori <clone> --before <rev> [--out <file>] [--only <case>]
//
// `--before` is the commit of this repository whose `src/` is "before"; it is taken out with
// `git archive`. "After" is this tree's `src/`. Each is also copied with the caps of `enumerate` and
// `sitesFromChange` set to 100000 ("uncapped"); nothing else in the copy differs, and the run says
// which constants it replaced.
//
// Per run and tool it counts what the plan for #38 said it would: the known targets inside the
// budget, the calls on a changed line left outside it, the changed functions that got no question,
// and how many of the callers' calls are asked. It also runs each tool's command with
// `--candidates-only` where a case has a spec, for the siblings (which `selectSites` does not reach)
// and the wall time. The checks read the capped tools only: the uncapped copies replace the same
// constants in both, so a change to one of those constants makes them the same tool, and they are
// kept for reference. The targets live here and not in `src/`.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = resolve(import.meta.dirname, "..");
const BUDGET = 20;
const CALLER_BUDGET = 10;
// `--only <case>` runs one case, for checking the bench itself; a log is taken with every case.
const { values } = parseArgs({ options: { acceptance: { type: "string" }, omamori: { type: "string" }, before: { type: "string" }, out: { type: "string" }, only: { type: "string" } } });
if (!values.acceptance || !values.omamori || !values.before) throw new Error("usage: node bench/budget-by-origin.ts --acceptance <dir> --omamori <clone> --before <rev> [--out <file>] [--only <case>]");
const ACC = resolve(values.acceptance);
const OMA = resolve(values.omamori);
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const beforeRev = git(HERE, "rev-parse", values.before);

// ---- the four tools ----

const CAPS: [string, RegExp, string][] = [
  ["src/plan/candidates.ts", /^const MAX_FUNCTIONS = \d+;$/m, "const MAX_FUNCTIONS = 100000;"],
  ["src/plan/candidates.ts", /^const MAX_CALLS_PER_FUNCTION = \d+;$/m, "const MAX_CALLS_PER_FUNCTION = 100000;"],
  ["src/plan/from-diff.ts", /^const MAX_CHANGED_FUNCTIONS = \d+;$/m, "const MAX_CHANGED_FUNCTIONS = 100000;"],
  ["src/plan/from-diff.ts", /^const MAX_HOP_NAMES = \d+;$/m, "const MAX_HOP_NAMES = 100000;"],
  ["src/plan/from-diff.ts", /^const MAX_CALLER_FUNCTIONS = \d+;$/m, "const MAX_CALLER_FUNCTIONS = 100000;"],
];

function copyOf(from: "before" | "after", uncapped: boolean): string {
  const dir = mkdtempSync(join(homedir(), ".cctmp", `budget-by-origin-${from}-`));
  if (from === "before") execFileSync("sh", ["-c", `git -C "${HERE}" archive "${beforeRev}" src package.json | tar -x -C "${dir}"`]);
  else {
    cpSync(join(HERE, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(HERE, "package.json"), join(dir, "package.json"));
  }
  symlinkSync(join(HERE, "node_modules"), join(dir, "node_modules"));
  if (uncapped) {
    for (const [file, pattern, line] of CAPS) {
      const path = join(dir, file);
      const text = readFileSync(path, "utf8");
      if (!pattern.test(text)) throw new Error(`${from}: ${file} has no ${pattern}`);
      writeFileSync(path, text.replace(pattern, line));
    }
  }
  return dir;
}

async function toolAt(root: string) {
  return {
    Git: (await import(join(root, "src/repository/git.ts"))).Git,
    Discoverer: (await import(join(root, "src/discovery/discover.ts"))).Discoverer,
    analyzeChange: (await import(join(root, "src/change/seeds.ts"))).analyzeChange,
    fromDiff: await import(join(root, "src/plan/from-diff.ts")),
    selectSites: (await import(join(root, "src/plan/select.ts"))).selectSites,
    applicabilityOf: (await import(join(root, "src/plan/applicability.ts"))).applicabilityOf,
    loadConfig: (await import(join(root, "src/config/config.ts"))).loadConfig,
    pathFilter: (await import(join(root, "src/config/glob.ts"))).pathFilter,
  };
}
const ROOTS = {
  "before, capped": copyOf("before", false),
  "after, capped": copyOf("after", false),
  "before, uncapped": copyOf("before", true),
  "after, uncapped": copyOf("after", true),
};
const TOOLS = Object.fromEntries(await Promise.all(Object.entries(ROOTS).map(async ([name, root]) => [name, { ...(await toolAt(root)), root }] as const)));

// ---- the runs ----

interface Target {
  tag: string;
  file: string;
  function: string;
  call: string;
}
interface Run {
  case: string;
  version: string;
  clone: string;
  base: string;
  head: string;
  targets: Target[];
}
const runs: Run[] = [];
const add = (name: string, clone: string, versions: [string, string, string][], targets: Target[]) => {
  for (const [version, base, head] of versions) runs.push({ case: name, version, clone: join(ACC, clone), base, head, targets });
};
// The targets of `bench/order-first-pass.ts`, and grovedb#500's unchanged caller, which the cap of
// forty calls per function dropped until #38's second part. It is scored everywhere: v1 excused it on
// the capped tools, which let a tool that still dropped it pass.
const MOLTIS_A = { tag: "A", file: "crates/gateway/src/session/title.rs", function: "generate_title_for_session", call: "moltis_agents::title::generate_title(provider, &chat_msgs)" };
const MOLTIS_B = { tag: "B", file: "crates/gateway/src/channel_events/commands/dispatch.rs", function: "dispatch_command", call: "session_handlers::handle_title(state, &session_key)" };
add("moltis-1064", "moltis", [
  ["shipped", "a30a6b6a6594dcec15ceb65b8e7424972e9c88d4", "4106d46dad04481a932597141739e42a5452cc86"],
  ["defect-A", "a30a6b6a6594dcec15ceb65b8e7424972e9c88d4", "fa45a528825734c277a84107af93b4ea9ff105d0"],
  ["rewrite-A", "a30a6b6a6594dcec15ceb65b8e7424972e9c88d4", "e14b5b7d1268fc583d428735086583335943e684"],
  ["hidden-A", "d2697974d470b2adde91472e85ed5c14e78174b4", "e5f20ac177a50c402b266ba5516d9559b8938686"],
  ["defect-B", "3eae0c6bcbcafe16167085ca8f4381cbff0051d4", "4697c3977399b015efd2ac38fd9aec6797783117"],
], [MOLTIS_A, MOLTIS_B]);
add("grovedb-500", "grovedb", [
  ["shipped", "43f4253c33ccb2f74fcc212c9d6e532f78ec95f5", "c0e02819ac99a545e70a858208f2095c5fb461c7"],
  ["defect-A", "43f4253c33ccb2f74fcc212c9d6e532f78ec95f5", "26efc3e5a004ad96250d823e95e7ca893e13d62f"],
  ["rewrite-A", "43f4253c33ccb2f74fcc212c9d6e532f78ec95f5", "87e06509bc8da68b9c815ad5799f507d81183c69"],
  ["hidden-A", "ad3f80263ed21321bee9f450a854d0ee92356b8a", "549b1b679045e354e5b42fb2b0fd9d7241ffc3cd"],
], [
  { tag: "A", file: "merk/src/merk/restore.rs", function: "finalize", call: "rewrite_heights(grove_version)" },
  { tag: "B", file: "grovedb/src/replication/state_sync_session.rs", function: "apply_chunk", call: "finalize(grove_version)" },
]);
add("grovedb-501", "grovedb", [["shipped", "43f4253c33ccb2f74fcc212c9d6e532f78ec95f5", "e9fcd18eef345a4a1c5ea645fc2875e408d15e6e"]], [
  { tag: "fixed", file: "merk/src/merk/restore.rs", function: "process_chunk", call: "set_base_root_key(chunk_tree.key().map(|k| k.to_vec()))" },
  { tag: "B", file: "grovedb/src/replication/state_sync_session.rs", function: "apply_inner_chunk", call: "process_chunk(chunk_id, ops, grove_version)" },
]);
add("kontor-385", "Kontor", [["shipped", "99cfbdfd4b0bccc60c2bc6476c3636e82995af2f", "5523cc5ad646537cce8fd160c1d7aef6b0cb897b"]], [
  { tag: "A", file: "core/indexer/src/reactor/consensus_state.rs", function: "get_decided_range", call: "batch_to_decided(b)" },
  { tag: "B", file: "core/indexer/src/reactor/batches.rs", function: "initiate_rollback", call: "get_decided_from_anchor(&conn, from_anchor)" },
]);
const PRECHECK = JSON.parse(readFileSync(join(HERE, "bench/acceptance/precheck-shipped.json"), "utf8")) as { cases: Record<string, { revisions: { before: string; after: string } }> };
for (const [name, clone] of [["instruckt-tauri-9", "instruckt-tauri"], ["pybun-428", "pybun"], ["quebec-136", "quebec"], ["whatsapp-rust-759", "whatsapp-rust"]] as const) {
  const r = PRECHECK.cases[name]!.revisions;
  add(name, clone, [["shipped", r.before, r.after]], []);
}
const OMAMORI_TARGETS: Target[] = [
  { tag: "R1", file: "src/integrity.rs", function: "read_baseline", call: "crate::atomic_file::read_to_string_capped(&path, MAX_TRACKED_FILE_BYTES)" },
  { tag: "R2", file: "src/config.rs", function: "raw_override_disables", call: "crate::atomic_file::read_to_string_capped(path, MAX_CONFIG_FILE_BYTES)" },
];
const omamoriBranches: Record<string, string> = {
  correct: "e58c04f6df082146969320b91f09aa7a0123ac1f",
  "m-read-baseline": "46cd434299a05ff8c6d2664f720f0606d7e11579",
  "v-read-baseline": "a3dae0a134cc70952fe467bad860a714e4c45792",
  "m-raw-override": "e8f2fdc8385e539aaffd6602ef869cfcbccd2bea",
  "v-raw-override": "6c96366a0ec6e0e5ef3092866d0a2d2da871e332",
};
for (const [version, head] of Object.entries(omamoriBranches)) runs.push({ case: "omamori-468", version, clone: OMA, base: "52a58fa", head, targets: OMAMORI_TARGETS });

// ---- one selection, counted ----

interface S {
  call: { id: string; line: number; expression: string };
  fn: { id: string; path: string; name: string };
  fnOrigin: "changed" | "calls_changed";
}

const SPEC = (name: string) => join(HERE, "bench/acceptance/cases", name, "spec.json");

/** The command itself, set built only: the siblings and the wall time. `null` where the case has no spec. */
function command(root: string, run: Run) {
  const spec = SPEC(run.case);
  if (!existsSync(spec)) return null;
  const started = performance.now();
  const out = spawnSync("node", [join(root, "src/cli/main.ts"), "--candidates-only", "--skip-change-check", "--base", run.base, "--head", run.head, "--intent-spec", spec, "--json"], { cwd: run.clone, encoding: "utf8", maxBuffer: 1 << 30 });
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  if (out.status !== 0) throw new Error(`${root} on ${run.case} ${run.version}: exit ${out.status}: ${out.stderr.slice(0, 400)}`);
  const report = JSON.parse(out.stdout) as { requirements: { counts: { siblings?: { functions: number; applicable: number } }; wouldAsk: { origin: string; function: string }[] }[] };
  const r = report.requirements[0]!;
  const siblings = r.wouldAsk.filter((w) => w.origin === "shares_call");
  return { seconds, reportBytes: Buffer.byteLength(out.stdout), siblingFunctions: r.counts.siblings?.functions ?? 0, siblingApplicable: r.counts.siblings?.applicable ?? 0, siblingsInBudget: siblings.length, siblingNames: [...new Set(siblings.map((w) => w.function))].sort() };
}

async function measure(tool: (typeof TOOLS)[string], run: Run) {
  const repo = new tool.Git(run.clone);
  const head = git(run.clone, "rev-parse", run.head);
  const before = git(run.clone, "merge-base", run.base, head);
  const { config } = await tool.loadConfig(repo, before, head);
  const include = tool.pathFilter(config.repository.include, config.repository.ignore);
  const change = await tool.analyzeChange(repo, before, head, include);
  const changedLines = tool.Discoverer.changedLines(change) as Map<string, Set<number>>;
  const discoverer = new tool.Discoverer(repo, head, { include, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const fromChange = await tool.fromDiff.sitesFromChange(new tool.fromDiff.CandidateFiles(discoverer), discoverer, changedLines);
  // The tool before takes three arguments and ignores the fourth.
  const sel = await tool.selectSites([...fromChange.sources.values()], (fn: unknown, call: unknown) => tool.applicabilityOf(discoverer, fn, call), BUDGET, CALLER_BUDGET);
  const applicable = sel.applicable as S[];
  const budgeted = sel.budgeted as S[];
  const inBudget = new Set(budgeted.map((s) => s.call.id));
  const onChangedLine = (s: S) => changedLines.get(s.fn.path)?.has(s.call.line) ?? false;
  const changedFns = new Set(applicable.filter((s) => s.fnOrigin === "changed").map((s) => s.fn.id));
  const askedFns = new Set(budgeted.filter((s) => s.fnOrigin === "changed").map((s) => s.fn.id));
  const at = (t: Target) => applicable.filter((s) => s.fn.path === t.file && s.fn.name === t.function && s.call.expression === t.call);
  return {
    applicable: applicable.length,
    budgeted: budgeted.length,
    changedAsked: budgeted.filter((s) => s.fnOrigin === "changed").length,
    callersApplicable: applicable.filter((s) => s.fnOrigin === "calls_changed").length,
    callersAsked: budgeted.filter((s) => s.fnOrigin === "calls_changed").length,
    changedLineCalls: applicable.filter(onChangedLine).length,
    changedLineLeft: applicable.filter((s) => onChangedLine(s) && !inBudget.has(s.call.id)).length,
    changedFunctions: changedFns.size,
    changedFunctionsNotAsked: [...changedFns].filter((f) => !askedFns.has(f)).length,
    targets: Object.fromEntries(
      run.targets.map((t) => {
        const hits = at(t);
        const rank = budgeted.findIndex((s) => hits.some((h) => h.call.id === s.call.id));
        return [t.tag, hits.length === 0 ? "not askable" : rank >= 0 ? `inside (${rank + 1} of ${budgeted.length})` : "outside"];
      }),
    ),
    command: command(tool.root, run),
  };
}

// ---- the table ----

const rows = [];
for (const run of runs.filter((r) => values.only === undefined || r.case === values.only)) {
  const row: Record<string, unknown> = { case: run.case, version: run.version };
  for (const [name, tool] of Object.entries(TOOLS)) row[name] = await measure(tool, run);
  rows.push(row);
  console.log(`${run.case} ${run.version} done`);
}

type M = Awaited<ReturnType<typeof measure>>;
const checks = rows.map((row) => {
  const out: Record<string, unknown> = { case: row.case, version: row.version };
  const b = row["before, capped"] as M;
  const a = row["after, capped"] as M;
  out.capped = {
    callersNotFewer: a.callersAsked >= b.callersAsked,
    changedLineLeftNotMore: a.changedLineLeft <= b.changedLineLeft,
    changedFunctionsNotAskedNotMore: a.changedFunctionsNotAsked <= b.changedFunctionsNotAsked,
    targetsInside: Object.values(a.targets).every((v) => (v as string).startsWith("inside")),
    atMostBoth: a.budgeted <= BUDGET + CALLER_BUDGET,
  };
  return out;
});
const failed = checks.filter((c) => Object.values(c.capped as Record<string, boolean>).some((v) => !v));

const result = {
  what: "The selection before and after a change to how calls are listed or chosen — v1 the callers' own budget (ADR 0015), v2 the cap of calls a function (#38, second part) — with the listing's caps and without them, the checks on the capped tools. No request sent.",
  budgets: { budget: BUDGET, callerBudget: CALLER_BUDGET },
  before: beforeRev,
  // A hash of every file under src/, since "after" is this tree and may be ahead of any commit.
  after: `src/ sha256 ${execFileSync("sh", ["-c", `cd "${HERE}" && find src -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256`], { encoding: "utf8" }).split(" ")[0]}`,
  uncapped: CAPS.map(([file, , line]) => `${file}: ${line}`),
  rows,
  checks,
  failed: failed.map((f) => `${f.case} ${f.version}`),
};
if (values.out) writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ runs: rows.length, failed: result.failed }, null, 2));
