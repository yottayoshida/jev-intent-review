// What narrowing a name defined more than once changes, before and after #45's second part, on the
// acceptance pre-check's eight cases, omamori `#468`'s five branches, and the two pull requests
// whose fix was held by this: cce-rust#168 and dataprof#370. No request is sent.
//
//   node bench/names-defined-twice.ts --acceptance <dir> --omamori <clone> --before <rev> \
//       [--extra <name>=<clone>:<before>:<after>] [--out <file>]
//
// `--before` is the commit of this repository whose `src/` is "before"; it is taken out with
// `git archive` into a scratch directory and imported from there. "After" is this tree's `src/`.
// `--extra` adds a run from a clone and two revisions, for repositories outside the pre-check.
//
// Scored against `bench/names-defined-twice-expected.json` when it exists: for every call this
// change makes askable, what three labellers said the call actually reaches, read from the calling
// code and its `use` lines rather than from this tool's own rules.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = resolve(import.meta.dirname, "..");
const BUDGET = 20;
// The callers' own budget (ADR 0015) is 0 here, so the total is the 20 this bench was taken with; how
// the 20 is dealt is no longer what it was then, and the tool before ignores the argument.
const { values } = parseArgs({ options: { acceptance: { type: "string" }, omamori: { type: "string" }, before: { type: "string" }, extra: { type: "string", multiple: true }, out: { type: "string" } } });
if (!values.acceptance || !values.omamori || !values.before) throw new Error("usage: node bench/names-defined-twice.ts --acceptance <dir> --omamori <clone> --before <rev> [--extra <name>=<clone>:<before>:<after>] [--out <file>]");
const ACC = resolve(values.acceptance);
const OMA = resolve(values.omamori);
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// ---- the two tools ----

const scratch = mkdtempSync(join(homedir(), ".cctmp", "names-twice-before-"));
execFileSync("sh", ["-c", `git -C "${HERE}" archive "${values.before}" src package.json | tar -x -C "${scratch}"`]);
symlinkSync(join(HERE, "node_modules"), join(scratch, "node_modules"));

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
const tools = { before: await toolAt(scratch), after: await toolAt(HERE) };

// ---- the runs ----

interface Run {
  case: string;
  repo: string;
  version: string;
  clone: string;
  before: string;
  after: string;
}
const PRECHECK = JSON.parse(readFileSync(join(HERE, "bench/acceptance/precheck-shipped.json"), "utf8")) as { cases: Record<string, { revisions: { before: string; after: string } }> };
const CLONES: Record<string, string> = { "whatsapp-rust-759": "whatsapp-rust", "moltis-1064": "moltis", "kontor-385": "Kontor", "instruckt-tauri-9": "instruckt-tauri", "grovedb-501": "grovedb", "grovedb-500": "grovedb", "quebec-136": "quebec", "pybun-428": "pybun" };
const runs: Run[] = Object.entries(CLONES).map(([name, clone]) => ({ case: name, repo: clone, version: "shipped", clone: join(ACC, clone), ...PRECHECK.cases[name]!.revisions }));
const OMAMORI: Record<string, string> = {
  correct: "e58c04f6df082146969320b91f09aa7a0123ac1f",
  "m-read-baseline": "46cd434299a05ff8c6d2664f720f0606d7e11579",
  "v-read-baseline": "a3dae0a134cc70952fe467bad860a714e4c45792",
  "m-raw-override": "e8f2fdc8385e539aaffd6602ef869cfcbccd2bea",
  "v-raw-override": "6c96366a0ec6e0e5ef3092866d0a2d2da871e332",
};
for (const [version, head] of Object.entries(OMAMORI)) runs.push({ case: "omamori-468", repo: "omamori", version, clone: OMA, before: git(OMA, "merge-base", "52a58fa", head), after: head });
for (const extra of values.extra ?? []) {
  const [name, rest] = extra.split("=");
  const [clone, before, after] = (rest ?? "").split(":");
  if (!name || !clone || !before || !after) throw new Error(`--extra wants <name>=<clone>:<before>:<after>, not ${extra}`);
  runs.push({ case: name, repo: name, version: "pull request", clone: resolve(clone), before, after });
}

interface Decision {
  id: string;
  file: string;
  function: string;
  line: number;
  callee: string;
  call: string;
  kind: string;
  reason: string;
  definedAt: string;
  inBudget: boolean;
}

async function decide(tool: Awaited<ReturnType<typeof toolAt>>, run: Run): Promise<{ decisions: Decision[]; ms: number }> {
  const repo = new tool.Git(run.clone);
  const { config } = await tool.loadConfig(repo, run.before, run.after);
  const include = tool.pathFilter(config.repository.include, config.repository.ignore);
  const discoverer = new tool.Discoverer(repo, run.after, { include, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const change = await tool.analyzeChange(repo, run.before, run.after, include);
  const started = performance.now();
  const fromChange = await tool.fromDiff.sitesFromChange(new tool.fromDiff.CandidateFiles(discoverer), discoverer, tool.Discoverer.changedLines(change));
  const selection = await tool.selectSites([...fromChange.sources.values()], (fn: unknown, call: unknown) => tool.applicabilityOf(discoverer, fn, call), BUDGET, 0);
  const ms = Math.round(performance.now() - started);
  const budgeted = new Set(selection.budgeted.map((s: { call: { id: string } }) => s.call.id));
  // The two tools are imported from different directories, so their types are not shared here.
  const decisions = [...selection.applicable, ...selection.held].map((s: any) => ({
    id: s.call.id,
    file: s.fn.path,
    function: s.fn.name,
    line: s.call.line,
    callee: s.call.callee,
    call: s.call.expression,
    kind: s.applicability.ok ? "askable" : s.applicability.kind,
    reason: s.applicability.ok ? "" : s.applicability.reason,
    definedAt: s.applicability.ok ? (s.applicability.calleeDefinedAt ?? "") : "",
    inBudget: budgeted.has(s.call.id),
  }));
  return { decisions, ms };
}

/** The calls whose fix this part is for, and the defects inside the diff the budget must keep. */
const WATCHED = [
  { case: "cce-rust-168", tag: "fixed", file: "src/sync/commands.rs", function: "cmd_pull", call: "SyncState::load_strict(root)" },
  { case: "cce-rust-168", tag: "fixed", file: "src/sync/commands.rs", function: "pull_workspace", call: "SyncState::load_strict(&member_dir)" },
  { case: "cce-rust-168", tag: "fixed", file: "src/sync/knowledge_commands.rs", function: "cmd_knowledge_pull", call: "KnowledgeSyncState::load_strict(root)" },
  { case: "dataprof-370", tag: "fixed", file: "crates/dataprof-db/src/lib.rs", function: "analyze_database", call: "count_table_rows(query)" },
  { case: "moltis-1064", tag: "A", file: "crates/gateway/src/session/title.rs", function: "generate_title_for_session", call: "moltis_agents::title::generate_title(provider, &chat_msgs)" },
  { case: "moltis-1064", tag: "B", file: "crates/gateway/src/channel_events/commands/dispatch.rs", function: "dispatch_command", call: "session_handlers::handle_title(state, &session_key)" },
  { case: "kontor-385", tag: "A", file: "core/indexer/src/reactor/consensus_state.rs", function: "get_decided_range", call: "batch_to_decided(b)" },
  { case: "kontor-385", tag: "B", file: "core/indexer/src/reactor/batches.rs", function: "initiate_rollback", call: "get_decided_from_anchor(&conn, from_anchor)" },
  { case: "grovedb-500", tag: "A", file: "merk/src/merk/restore.rs", function: "finalize", call: "rewrite_heights(grove_version)" },
  { case: "grovedb-501", tag: "fixed", file: "merk/src/merk/restore.rs", function: "process_chunk", call: "set_base_root_key(chunk_tree.key().map(|k| k.to_vec()))" },
  { case: "grovedb-501", tag: "B", file: "grovedb/src/replication/state_sync_session.rs", function: "apply_inner_chunk", call: "process_chunk(chunk_id, ops, grove_version)" },
  { case: "omamori-468", tag: "R1", file: "src/integrity.rs", function: "read_baseline", call: "crate::atomic_file::read_to_string_capped(&path, MAX_TRACKED_FILE_BYTES)" },
  { case: "omamori-468", tag: "R2", file: "src/config.rs", function: "raw_override_disables", call: "crate::atomic_file::read_to_string_capped(path, MAX_CONFIG_FILE_BYTES)" },
];

// ---- the labels ----

interface Label {
  case: string;
  commit: string;
  file: string;
  function: string;
  call: string;
  /** `path:line` in the repository, or "outside" when the call reaches something not defined here. */
  reaches: string;
  /** Whether what it reaches returns a `Result`. */
  returns: "result" | "not" | "unsettled";
}
/** A label that names no definition in the repository. */
const OUTSIDE = new Set(["outside", "unclear"]);
const EXPECTED_PATH = join(HERE, "bench/names-defined-twice-expected.json");
const LABELS: Label[] = existsSync(EXPECTED_PATH) ? (JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as { labels: Label[] }).labels : [];
const labelFor = (run: Run, d: Decision) => LABELS.find((l) => l.case === run.case && l.file === d.file && l.function === d.function && l.call === d.call);
/** The same case at another commit shifts line numbers, so only a label from this one names lines. */
const sameCommit = (run: Run, label: Label | null) => label !== null && label.commit === run.after;

const out = [];
for (const run of runs) {
  const before = await decide(tools.before, run);
  const after = await decide(tools.after, run);
  const was = new Map(before.decisions.map((d) => [d.id, d]));
  const changed = after.decisions.filter((d) => was.get(d.id)?.kind !== d.kind).map((d) => ({ ...d, before: was.get(d.id) }));
  const counts = (ds: readonly Decision[]) => ds.reduce<Record<string, number>>((m, d) => ({ ...m, [d.kind]: (m[d.kind] ?? 0) + 1 }), {});
  const shape = ({ file, function: f, line, call, callee, kind, reason, definedAt, inBudget }: Decision) => ({ file, function: f, line, call, callee, kind, reason, definedAt, inBudget });
  out.push({
    case: run.case,
    version: run.version,
    revisions: { before: run.before, after: run.after },
    counts: { before: counts(before.decisions), after: counts(after.decisions) },
    ms: { before: before.ms, after: after.ms },
    budget: { before: before.decisions.filter((d) => d.inBudget).length, after: after.decisions.filter((d) => d.inBudget).length },
    watched: WATCHED.filter((w) => w.case === run.case).map((w) => {
      const at = (ds: readonly Decision[]) => ds.find((d) => d.file === w.file && d.function === w.function && d.call === w.call);
      const b = at(before.decisions);
      const a = at(after.decisions);
      return { tag: w.tag, call: w.call, before: b ? { kind: b.kind, inBudget: b.inBudget } : null, after: a ? { kind: a.kind, inBudget: a.inBudget } : null };
    }),
    // Asked about before and held now: this part should not take questions away.
    askableToHeld: changed.filter((d) => d.before?.kind === "askable").map((d) => ({ ...shape(d), was: d.before?.kind })),
    // Held before and askable now, with what the labellers said the call reaches.
    heldToAskable: changed.filter((d) => d.kind === "askable").map((d) => {
      const label = labelFor(run, d) ?? null;
      return { ...shape(d), was: d.before?.kind, wasWhy: d.before?.reason, label, labelNamesLines: sameCommit(run, label) };
    }),
    // Still held, with a reason that changed: the sample the labels cover by kind.
    reasonChanged: after.decisions
      .filter((d) => d.kind !== "askable" && was.get(d.id)?.kind !== "askable" && was.get(d.id)?.reason !== undefined && was.get(d.id)!.reason !== d.reason)
      .map((d) => ({ ...shape(d), was: was.get(d.id)!.kind, wasWhy: was.get(d.id)!.reason })),
    // A call that left the budget, or entered it, with what it is.
    budgetMoved: after.decisions
      .filter((d) => was.get(d.id) !== undefined && was.get(d.id)!.inBudget !== d.inBudget)
      .map((d) => ({ ...shape(d), wasInBudget: was.get(d.id)!.inBudget })),
    transitions: changed.reduce<Record<string, number>>((m, d) => {
      const key = `${d.before?.kind ?? "absent"} → ${d.kind}`;
      return { ...m, [key]: (m[key] ?? 0) + 1 };
    }, {}),
  });
}

const askable = out.flatMap((r) => r.heldToAskable.map((d) => ({ case: r.case, ...d })));
const summary = {
  before: values.before,
  beforeCommit: git(HERE, "rev-parse", values.before),
  runs: runs.length,
  newlyAskable: askable.length,
  askableLost: out.reduce((n, r) => n + r.askableToHeld.length, 0),
  reasonChanged: out.reduce((n, r) => n + r.reasonChanged.length, 0),
  budgetMoved: out.reduce((n, r) => n + r.budgetMoved.length, 0),
  // Check 2: every call this makes askable must reach a definition in the repository that returns a
  // `Result`, as the labels have it. Calls no label covers are listed, not counted as agreeing.
  scored: {
    labelled: askable.filter((d) => d.label !== null).length,
    agree: askable.filter((d) => d.label !== null && !OUTSIDE.has(d.label.reaches) && d.label.returns === "result").length,
    disagree: askable.filter((d) => d.label !== null && (OUTSIDE.has(d.label.reaches) || d.label.returns !== "result")),
    // Where the labels name a definition and the tool names another: held against the label, this
    // is which definition the report and the order inside a function point at.
    pointsElsewhere: askable.filter((d) => d.label !== null && d.labelNamesLines && !OUTSIDE.has(d.label.reaches) && d.definedAt !== "" && d.label.reaches.replace(/^trait:/, "") !== d.definedAt).map((d) => ({ case: d.case, call: d.call, label: d.label!.reaches, definedAt: d.definedAt })),
    unlabelled: askable.filter((d) => d.label === null).map((d) => ({ case: d.case, file: d.file, function: d.function, call: d.call })),
  },
};
const report = { summary, runs: out };
if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
