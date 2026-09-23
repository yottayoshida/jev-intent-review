// Whether a call can be asked about, before and after the signature reading of #45's first part,
// on the acceptance pre-check's eight cases and omamori `#468`'s five branches — and against the
// answers labelled by hand before that reading was written. No request is sent.
//
//   node bench/result-type.ts --acceptance <dir> --omamori <clone> --before <rev> [--out <file>]
//
// `--before` is the commit of this repository whose `src/` is "before" (the parent of this change);
// it is taken out with `git archive` into a scratch directory and imported from there. "After" is
// this tree's `src/`. `--acceptance` and `--omamori` are as in `bench/order-first-pass.ts`.
//
// The labels (`bench/result-type-expected.json`) were written by three fresh subagents from the
// source at each case's commit, following the rules written in that file, before this change's
// code existed. They are what "after" is scored against, call by call: a callee by its name in its
// repository at that commit, a target by its file and name. Labels were not written for calls that
// only this change's reading brought into view and that the stand-in used to choose the labels did
// not foresee: a call that became askable carries `label: null` in `heldToAskable`, and every
// "does not return a Result" after the change carries its label in `saysNotAfter` — null where
// none was written.
//
// The target names live here and not in `src/`: they are what this evaluation is about.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = resolve(import.meta.dirname, "..");
const BUDGET = 20;
// The callers' own budget (ADR 0015) is 0 here, so the total is the 20 this bench was taken with; how
// the 20 is dealt is no longer what it was then, and the tool before ignores the argument.
const { values } = parseArgs({ options: { acceptance: { type: "string" }, omamori: { type: "string" }, before: { type: "string" }, out: { type: "string" } } });
if (!values.acceptance || !values.omamori || !values.before) throw new Error("usage: node bench/result-type.ts --acceptance <dir> --omamori <clone> --before <rev> [--out <file>]");
const ACC = resolve(values.acceptance);
const OMA = resolve(values.omamori);
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// ---- the two tools ----

const scratch = mkdtempSync(join(homedir(), ".cctmp", "result-type-before-"));
execFileSync("sh", ["-c", `git -C "${HERE}" archive "${values.before}" src package.json | tar -x -C "${scratch}"`]);
symlinkSync(join(HERE, "node_modules"), join(scratch, "node_modules"));
const beforeCommit = git(HERE, "rev-parse", values.before);

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
// The same branches as `bench/order-first-pass.ts`.
const OMAMORI: Record<string, string> = {
  correct: "e58c04f6df082146969320b91f09aa7a0123ac1f",
  "m-read-baseline": "46cd434299a05ff8c6d2664f720f0606d7e11579",
  "v-read-baseline": "a3dae0a134cc70952fe467bad860a714e4c45792",
  "m-raw-override": "e8f2fdc8385e539aaffd6602ef869cfcbccd2bea",
  "v-raw-override": "6c96366a0ec6e0e5ef3092866d0a2d2da871e332",
};
for (const [version, head] of Object.entries(OMAMORI)) runs.push({ case: "omamori-468", repo: "omamori", version, clone: OMA, before: git(OMA, "merge-base", "52a58fa", head), after: head });

/** Calls this evaluation is about: the defects inside the diff, and the calls #45 names. */
const WATCHED = [
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

interface Decision {
  id: string;
  file: string;
  function: string;
  line: number;
  callee: string;
  call: string;
  kind: string;
  reason: string;
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
    callee: s.call.callee.split("::").pop(),
    call: s.call.expression,
    kind: s.applicability.ok ? "askable" : s.applicability.kind,
    reason: s.applicability.ok ? "" : s.applicability.reason,
    inBudget: budgeted.has(s.call.id),
  }));
  return { decisions, ms };
}

// ---- the labels ----

interface Expected {
  targets: { repo: string; commits: string[]; path: string; function: string; label: string }[];
  callees: { repo: string; commits: string[]; name: string; label: string }[];
  /** Disagreements whose cause was settled after the first measurement, with the reason. */
  adjudicated: { repo: string; about: string; names: string[]; labels: string[]; got: string[]; callerFiles?: string[]; reasonMatches: string; reason: string }[];
  /** Labels written after the first measurement, for calls outside the items labelled beforehand. */
  labelledAfter: { repo: string; commits: string[]; name: string; label: string }[];
}
const EXPECTED = JSON.parse(readFileSync(join(HERE, "bench/result-type-expected.json"), "utf8")) as Expected;
/**
 * A settled cause covers a disagreement only for the names, labels and results it names, the
 * callers' files when it names them, and a reason the tool printed that reads as it says — so the
 * same name held for a different reason is not excused.
 */
const adjudicated = (repo: string, about: string, name: string, label: string, got: string, callerFile: string, reason: string) =>
  EXPECTED.adjudicated.find(
    (a) =>
      a.repo === repo &&
      a.about === about &&
      a.names.includes(name) &&
      a.labels.includes(label) &&
      a.got.includes(got) &&
      (a.callerFiles === undefined || a.callerFiles.includes(callerFile)) &&
      new RegExp(a.reasonMatches).test(reason),
  );
const calleeLabel = (repo: string, name: string, commit: string) =>
  EXPECTED.callees.find((c) => c.repo === repo && c.name === name && c.commits.includes(commit)) ?? EXPECTED.labelledAfter.find((c) => c.repo === repo && c.name === name && c.commits.includes(commit));
/** What each label says the decision on a call must be. */
const TARGET_KIND: Record<string, string> = { not: "target_not_result", unknown: "target_return_unknown" };
const CALLEE_KIND: Record<string, string> = { returns: "askable", not: "callee_not_result", unknown: "callee_return_unknown", cut: "callee_return_unknown", no_def: "callee_unresolved", ambiguous: "callee_ambiguous" };
const TARGET_KINDS = new Set(["target_not_result", "target_return_unknown"]);

function score(run: Run, decisions: readonly Decision[]) {
  const rows = [];
  for (const d of decisions) {
    const target = EXPECTED.targets.find((t) => t.repo === run.repo && t.path === d.file && t.function === d.function);
    if (target) {
      const expected = TARGET_KIND[target.label];
      const got = TARGET_KINDS.has(d.kind) ? d.kind : "target_returns";
      const agrees = expected === undefined ? got === "target_returns" : got === expected;
      rows.push({ about: "target", file: d.file, function: d.function, label: target.label, got, agrees, adjudicated: !agrees && adjudicated(run.repo, "target", d.function, target.label, got, d.file, d.reason) !== undefined });
    }
    if (TARGET_KINDS.has(d.kind)) continue; // the callee was not read
    const callee = EXPECTED.callees.find((c) => c.repo === run.repo && c.name === d.callee && c.commits.includes(run.after));
    if (!callee) continue;
    const agrees = CALLEE_KIND[callee.label] === d.kind;
    const settled = agrees ? undefined : adjudicated(run.repo, "callee", d.callee, callee.label, d.kind, d.file, d.reason);
    rows.push({ about: "callee", file: d.file, function: d.function, callee: d.callee, call: d.call, label: callee.label, got: d.kind, agrees, adjudicated: settled !== undefined, reason: d.reason });
  }
  // One row per distinct thing labelled: a target once per function, a callee once per call.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = r.about === "target" ? `${r.file}\u0000${r.function}` : JSON.stringify(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SAYS_NOT = /does not return a Result/;
const out = [];
for (const run of runs) {
  const before = await decide(tools.before, run);
  const after = await decide(tools.after, run);
  const was = new Map(before.decisions.map((d) => [d.id, d]));
  const changed = after.decisions.filter((d) => was.get(d.id)?.kind !== d.kind).map((d) => ({ ...d, before: { kind: was.get(d.id)?.kind, reason: was.get(d.id)?.reason } }));
  const counts = (ds: readonly Decision[]) => ds.reduce<Record<string, number>>((m, d) => ({ ...m, [d.kind]: (m[d.kind] ?? 0) + 1 }), {});
  const scored = score(run, after.decisions);
  // Before, said "does not return a Result" of a call whose label says it returns one or is not settled.
  const falseBefore = before.decisions.filter((d) => SAYS_NOT.test(d.reason)).filter((d) => {
    const t = EXPECTED.targets.find((x) => x.repo === run.repo && x.path === d.file && x.function === d.function);
    if (d.kind === "target_not_result") return t !== undefined && t.label !== "not";
    const c = EXPECTED.callees.find((x) => x.repo === run.repo && x.name === d.callee && x.commits.includes(run.after));
    return c !== undefined && (c.label === "returns" || c.label === "unknown" || c.label === "cut");
  }).length;
  const watched = WATCHED.filter((w) => w.case === run.case).map((w) => {
    const at = (ds: readonly Decision[]) => ds.find((d) => d.file === w.file && d.function === w.function && d.call === w.call);
    const b = at(before.decisions);
    const a = at(after.decisions);
    return { tag: w.tag, before: b ? { kind: b.kind, inBudget: b.inBudget } : null, after: a ? { kind: a.kind, inBudget: a.inBudget } : null };
  });
  out.push({
    case: run.case,
    version: run.version,
    revisions: { before: run.before, after: run.after },
    counts: { before: counts(before.decisions), after: counts(after.decisions) },
    ms: { before: before.ms, after: after.ms },
    watched,
    scored: {
      rows: scored.length,
      agree: scored.filter((r) => r.agrees).length,
      // Disagreements with no settled cause. Check 2 is that this is empty.
      disagree: scored.filter((r) => !r.agrees && !r.adjudicated),
      adjudicated: scored.filter((r) => !r.agrees && r.adjudicated).map((r) => ({ about: r.about, name: "callee" in r ? r.callee : r.function, label: r.label, got: r.got })),
    },
    falseNotResultBefore: falseBefore,
    // Every "does not return a Result" after the change, with its label; the same reason for the same
    // callee in the same function once, with how many calls it covers.
    saysNotAfter: Object.values(
      after.decisions
        .filter((d) => SAYS_NOT.test(d.reason))
        .reduce<Record<string, { file: string; function: string; callee: string; kind: string; label: string | null; reason: string; calls: number }>>((m, d) => {
          const label = d.kind === "target_not_result" ? EXPECTED.targets.find((t) => t.repo === run.repo && t.function === d.function)?.label : calleeLabel(run.repo, d.callee, run.after)?.label;
          const key = JSON.stringify([d.file, d.function, d.callee, d.kind, d.reason]);
          const row = m[key] ?? { file: d.file, function: d.function, callee: d.callee, kind: d.kind, label: label ?? null, reason: d.reason, calls: 0 };
          row.calls += 1;
          return { ...m, [key]: row };
        }, {}),
    ),
    // Asked about before and held now: each needs a label saying it was a misreading.
    askableToHeld: changed
      .filter((d) => d.before.kind === "askable")
      .map(({ id, file, function: f, line, call, callee, kind, reason, before }) => ({ id, file, function: f, line, call, kind, reason, before, label: calleeLabel(run.repo, callee, run.after)?.label ?? null })),
    // Held before and askable now, with the callee's label when there is one; `label: null` is a call
    // no label covers.
    heldToAskable: changed
      .filter((d) => d.kind === "askable")
      .map(({ id, file, function: f, line, call, callee, before }) => ({ id, file, function: f, line, call, before, label: calleeLabel(run.repo, callee, run.after)?.label ?? null })),
    otherChanges: changed.filter((d) => d.kind !== "askable" && d.before.kind !== "askable").length,
    // Every decision that changed, as "before → after" and how many times.
    transitions: changed.reduce<Record<string, number>>((m, d) => {
      const key = `${d.before.kind ?? "absent"} → ${d.kind}`;
      return { ...m, [key]: (m[key] ?? 0) + 1 };
    }, {}),
  });
}

const srcFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : [join(dir, e.name)])).sort();
const digest = createHash("sha256");
for (const f of srcFiles(join(HERE, "src"))) digest.update(f.slice(HERE.length)).update(readFileSync(f));
const log = {
  what: "Whether each call can be asked about, with the tool before and after reading whole signatures and aliases (#45, first part), on 13 pre-check runs, scored against labels written by hand before the change. No request sent.",
  tool: { before: beforeCommit, after: { commit: git(HERE, "rev-parse", "HEAD"), src: digest.digest("hex") } },
  budget: BUDGET,
  runs: out,
};
const text = `${JSON.stringify(log, null, 2)}\n`;
if (values.out) writeFileSync(values.out, text);
else process.stdout.write(text);
