// Which calls the budget reaches first, with and without the order inside a function (the calls
// into a function the change touched first). No request is sent.
//
//   node bench/order-first-pass.ts --acceptance <dir> --omamori <clone> [--out <file>]
//
// `--acceptance` is the directory the acceptance set's clones were made in (one clone per
// repository, named as below); `--omamori` is a clone of omamori holding the five branches of
// `#468` (`bench/logs/beyond-diff-v1.json` names them).
//
// Two checks, each run with the order and without it:
//
//   - `shipped`: `applicabilityOf`, what the tool asks with today;
//   - `widened`: a stand-in for #45, which will make more calls askable. It reads a signature up to
//     its body and takes any type whose name ends in `Result` as a `Result`, and it finds a
//     callee's definition by `fn <name>`, holding it when that search is cut. It is meant as an
//     upper bound on what #45 makes askable, not as #45: on these four repositories every alias
//     of `Result` ends in `Result` (moltis `ChannelResult`, `MethodResult`; grovedb
//     `CostResult`), and a wider set of askable calls only pushes a target further back — more
//     functions before it, more calls ahead of it in its own. It is not a strict superset of
//     today's check: grovedb#500's `finalize` calls `self.merk.verify(...)`, which today's check
//     resolves through a search cut at 200 hits to one of seven `fn verify` and asks about, and
//     which this holds as defined seven times (twelve askable calls there, inside the budget
//     either way). It does not strip `/* */` comments inside a signature.
//
// "Without the order" is `roundRobin` over the applicable calls in the order they were found,
// which is what `selectSites` did before. Calls are compared by id, not by expression: two calls
// in one body can read the same (grovedb's `apply_chunk` has two `unpack_nested_bytes(...)`).
//
// The target names live here and not in `src/`: they are what this evaluation is about.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { definedName } from "../src/change/blocks.ts";
import { analyzeChange } from "../src/change/seeds.ts";
import { loadConfig } from "../src/config/config.ts";
import { pathFilter } from "../src/config/glob.ts";
import { Discoverer, isTestPath } from "../src/discovery/discover.ts";
import { applicabilityOf, type Applicability } from "../src/plan/applicability.ts";
import { isRustFunction, type CallCandidate, type FunctionCandidate } from "../src/plan/candidates.ts";
import { namesTheStandardLibrary, outsideResult } from "../src/plan/outside-results.ts";
import { CandidateFiles, sitesFromChange } from "../src/plan/from-diff.ts";
import { resolvedTo, roundRobin, selectSites, type Site } from "../src/plan/select.ts";
import { Git } from "../src/repository/git.ts";

const HERE = resolve(import.meta.dirname, "..");
const BUDGET = 20;
const { values } = parseArgs({ options: { acceptance: { type: "string" }, omamori: { type: "string" }, out: { type: "string" } } });
if (!values.acceptance || !values.omamori) throw new Error("usage: node bench/order-first-pass.ts --acceptance <dir> --omamori <clone> [--out <file>]");
const ACC = resolve(values.acceptance);
const OMA = resolve(values.omamori);

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
], [{ tag: "A", file: "merk/src/merk/restore.rs", function: "finalize", call: "rewrite_heights(grove_version)" }]);
add("grovedb-501", "grovedb", [["shipped", "43f4253c33ccb2f74fcc212c9d6e532f78ec95f5", "e9fcd18eef345a4a1c5ea645fc2875e408d15e6e"]], [
  { tag: "fixed", file: "merk/src/merk/restore.rs", function: "process_chunk", call: "set_base_root_key(chunk_tree.key().map(|k| k.to_vec()))" },
  { tag: "B", file: "grovedb/src/replication/state_sync_session.rs", function: "apply_inner_chunk", call: "process_chunk(chunk_id, ops, grove_version)" },
]);
add("kontor-385", "Kontor", [["shipped", "99cfbdfd4b0bccc60c2bc6476c3636e82995af2f", "5523cc5ad646537cce8fd160c1d7aef6b0cb897b"]], [
  { tag: "A", file: "core/indexer/src/reactor/consensus_state.rs", function: "get_decided_range", call: "batch_to_decided(b)" },
  { tag: "B", file: "core/indexer/src/reactor/batches.rs", function: "initiate_rollback", call: "get_decided_from_anchor(&conn, from_anchor)" },
]);
// The other four cases of the pre-check (`bench/acceptance/precheck-shipped.json`), at the same
// revisions. None carries a target this reaches; they are here for what the order moves.
const PRECHECK = JSON.parse(readFileSync(join(HERE, "bench/acceptance/precheck-shipped.json"), "utf8")) as { cases: Record<string, { revisions: { before: string; after: string } }> };
for (const [name, clone] of [["instruckt-tauri-9", "instruckt-tauri"], ["pybun-428", "pybun"], ["quebec-136", "quebec"], ["whatsapp-rust-759", "whatsapp-rust"]] as const) {
  const r = PRECHECK.cases[name]!.revisions;
  add(name, clone, [["shipped", r.before, r.after]], []);
}
const OMAMORI_TARGETS: Target[] = [
  { tag: "R1", file: "src/integrity.rs", function: "read_baseline", call: "crate::atomic_file::read_to_string_capped(&path, MAX_TRACKED_FILE_BYTES)" },
  { tag: "R2", file: "src/config.rs", function: "raw_override_disables", call: "crate::atomic_file::read_to_string_capped(path, MAX_CONFIG_FILE_BYTES)" },
];
// The shipped head of omamori `#468` and each of the four patches of `bench/fixtures/omamori-468/`
// committed on it. The clone given with `--omamori` has to hold these commits.
const omamoriBranches: Record<string, string> = {
  correct: "e58c04f6df082146969320b91f09aa7a0123ac1f",
  "m-read-baseline": "46cd434299a05ff8c6d2664f720f0606d7e11579",
  "v-read-baseline": "a3dae0a134cc70952fe467bad860a714e4c45792",
  "m-raw-override": "e8f2fdc8385e539aaffd6602ef869cfcbccd2bea",
  "v-raw-override": "6c96366a0ec6e0e5ef3092866d0a2d2da871e332",
};
for (const [version, head] of Object.entries(omamoriBranches)) runs.push({ case: "omamori-468", version, clone: OMA, base: "52a58fa", head, targets: OMAMORI_TARGETS });

// ---- the stand-in for #45 ----

/** From `start` (at an opening bracket) past its match; `->` is one token, not a closing `>`. */
function pastMatching(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "-" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if (text[i] === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** The return type written after a function's parameters, up to its body; `()` when there is none. */
export function returnTypeAt(lines: readonly string[], startLine: number): string | null {
  const text = lines
    .slice(startLine - 1, startLine + 29)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  const name = /\bfn\s+\w+\s*/.exec(text);
  if (!name) return null;
  let i = name.index + name[0].length;
  if (text[i] === "<" && (i = pastMatching(text, i, "<", ">")) < 0) return null;
  while (/\s/.test(text[i] ?? "")) i++;
  if (text[i] !== "(" || (i = pastMatching(text, i, "(", ")")) < 0) return null;
  while (/\s/.test(text[i] ?? "")) i++;
  if (!(text[i] === "-" && text[i + 1] === ">")) return "()";
  const start = (i += 2);
  let angle = 0;
  let paren = 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "-" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if (ch === "<") angle++;
    else if (ch === ">") angle--;
    else if (ch === "(" || ch === "[") paren++;
    else if (ch === ")" || ch === "]") paren--;
    const where = /\s/.test(text[i - 1] ?? " ") && /^where\b/.test(text.slice(i));
    if (angle === 0 && paren === 0 && (ch === "{" || ch === ";" || where)) return text.slice(start, i).replace(/\s+/g, " ").trim();
  }
  return null;
}

const RESULT_LIKE = /\b\w*Result\b/;

function widened(discoverer: Discoverer) {
  const definitions = new Map<string, Promise<{ path: string; line: number }[] | "cut">>();
  const definitionsOf = (name: string) => {
    let found = definitions.get(name);
    if (!found) {
      found = (async () => {
        const { hits, more } = await discoverer.search(`fn ${name}`);
        if (more) return "cut" as const;
        const out: { path: string; line: number }[] = [];
        for (const hit of hits) {
          if (!hit.path.endsWith(".rs") || isTestPath(hit.path)) continue;
          if (definedName(hit.text) !== name || !isRustFunction(hit.text, name)) continue;
          const index = await discoverer.index(hit.path);
          if ((index?.testRegions ?? []).some((r) => hit.line >= r.start && hit.line <= r.end)) continue;
          out.push({ path: hit.path, line: hit.line });
        }
        return out;
      })();
      definitions.set(name, found);
    }
    return found;
  };
  return async (fn: FunctionCandidate, call: CallCandidate): Promise<Applicability> => {
    const own = returnTypeAt((await discoverer.index(fn.path))?.lines ?? [], fn.startLine);
    if (!own || !RESULT_LIKE.test(own)) return { ok: false, kind: "target_not_result", reason: `returns ${own}` };
    // The same order as the shipped check: a path into a function outside this repository is
    // answered by the table, and a `std::` one before this repository's definitions are looked at
    // (`src/plan/outside-results.ts`, ADR 0011).
    const outside = outsideResult(call.callee);
    if (outside && namesTheStandardLibrary(call.callee)) return { ok: true, calleeDefinedAt: outside.path };
    const found = await definitionsOf(call.callee.split("::").pop()!);
    if (found === "cut") return { ok: false, kind: "callee_ambiguous", reason: "the search was cut" };
    if (found.length === 0 && outside) return { ok: true, calleeDefinedAt: outside.path };
    if (found.length !== 1) return { ok: false, kind: found.length === 0 ? "callee_unresolved" : "callee_ambiguous", reason: `${found.length} definitions` };
    const theirs = returnTypeAt((await discoverer.index(found[0]!.path))?.lines ?? [], found[0]!.line);
    if (!theirs || !RESULT_LIKE.test(theirs)) return { ok: false, kind: "callee_not_result", reason: `returns ${theirs}` };
    return { ok: true, calleeDefinedAt: `${found[0]!.path}:${found[0]!.line}` };
  };
}

// ---- the runs ----

const place = (s: Site) => ({ id: s.call.id, file: s.fn.path, function: s.fn.name, line: s.call.line, call: s.call.expression });
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

const rows = [];
for (const run of runs) {
  const repo = new Git(run.clone);
  const head = git(run.clone, "rev-parse", run.head);
  const before = git(run.clone, "merge-base", run.base, head);
  const { config } = await loadConfig(repo, before, head);
  const include = pathFilter(config.repository.include, config.repository.ignore);
  const change = await analyzeChange(repo, before, head, include);
  const changedLines = Discoverer.changedLines(change);
  for (const check of ["shipped", "widened"] as const) {
    const discoverer = new Discoverer(repo, head, { include, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
    const fromChange = await sitesFromChange(new CandidateFiles(discoverer), discoverer, changedLines);
    const decide = check === "shipped" ? (fn: FunctionCandidate, call: CallCandidate) => applicabilityOf(discoverer, fn, call) : widened(discoverer);
    const started = performance.now();
    const selection = await selectSites([...fromChange.sources.values()], decide, BUDGET);
    const ms = Math.round(performance.now() - started);
    const lineOrder = roundRobin(selection.applicable, BUDGET).taken;
    const withOrder = new Set(selection.budgeted.map((s) => s.call.id));
    const without = new Set(lineOrder.map((s) => s.call.id));
    const perFunction = (list: readonly Site[]) => list.reduce<Record<string, number>>((m, s) => ({ ...m, [s.fn.id]: (m[s.fn.id] ?? 0) + 1 }), {});
    const same = (a: Record<string, number>, b: Record<string, number>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    const changedAt = new Set<string>();
    for (const source of fromChange.sources.values()) for (const id of source.changed ?? []) {
      const fn = source.candidates.functions.find((f) => f.id === id);
      if (fn) changedAt.add(`${fn.path}:${fn.startLine}`);
    }
    const movedUp = selection.applicable.filter((s) => changedAt.has(resolvedTo(s.applicability) ?? "")).length;
    const targets = run.targets.map((t) => {
      const at = (list: readonly Site[]) => list.filter((s) => s.fn.path === t.file && s.fn.name === t.function && s.call.expression === t.call);
      const held = at(selection.held).map((s) => (s.applicability && !s.applicability.ok ? s.applicability.kind : "held"));
      return { ...t, enumerated: at(selection.widened).length, applicable: at(selection.applicable).length, inBudgetWithOrder: at(selection.budgeted).length, inBudgetWithoutOrder: at(lineOrder).length, held };
    });
    rows.push({
      case: run.case,
      version: run.version,
      check,
      revisions: { before, after: head },
      functionsWithAnAskableCall: new Set(selection.applicable.map((s) => s.fn.id)).size,
      applicable: selection.applicable.length,
      movedUp,
      perFunctionCountsUnchanged: same(perFunction(selection.budgeted), perFunction(lineOrder)),
      // The functions in the order they first take a turn, with and without the order.
      functionOrderUnchanged: JSON.stringify([...new Set(selection.budgeted.map((s) => s.fn.id))]) === JSON.stringify([...new Set(lineOrder.map((s) => s.fn.id))]),
      entered: selection.budgeted.filter((s) => !without.has(s.call.id)).map(place),
      left: lineOrder.filter((s) => !withOrder.has(s.call.id)).map(place),
      targets,
      ms,
    });
  }
}

// The tool is named by a hash of its `src/`, since a run comes before its own commit.
const srcFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : [join(dir, e.name)])).sort();
const srcDigest = createHash("sha256");
for (const f of srcFiles(join(HERE, "src"))) srcDigest.update(f.slice(HERE.length)).update(readFileSync(f));
const log = {
  what: "Which calls the budget of 20 reaches, with the order inside a function (calls into a function the change touched first) and without it, under today's applicability check and a wider stand-in for #45. No request sent.",
  tool: { commit: git(HERE, "rev-parse", "HEAD"), src: srcDigest.digest("hex") },
  budget: BUDGET,
  rows,
};
const text = `${JSON.stringify(log, null, 2)}\n`;
if (values.out) writeFileSync(values.out, text);
else process.stdout.write(text);
