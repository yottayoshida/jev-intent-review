// How far the product's name resolution agrees with rust-analyzer's (#83, docs/resolution.md). Sends
// nothing to Jev.
//
//   cargo build --release --manifest-path bench/resolution-oracle/Cargo.toml
//   node bench/resolution.ts index <material.json>         rust-analyzer's SCIP index of each case
//   node bench/resolution.ts denominators <material.json>  the changed functions, written before measuring
//   node bench/resolution.ts measure <material.json>       writes bench/logs/resolution-<material name>.json
//   node bench/resolution.ts measure <material.json> --broken
//                                                         the same with each settled answer moved to
//                                                         another definition, to check the pairing moves
//   node bench/resolution.ts rustc <material.json>         the plan's third check, from measure's rows
//   node bench/resolution.ts fixtures                      rewrites test/fixtures/resolution/oracle.json
//
// The material is #81's (bench/call-oracle/material.dev.json). Clones are #81's, under
// ~/.cctmp/call-oracle-clones; indexes are kept under ~/.cctmp/resolution-scip. The session start
// sweeps both after 7 days.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { loadConfig } from "../src/config/config.ts";
import { pathFilter } from "../src/config/glob.ts";
import { analyzeChange } from "../src/change/seeds.ts";
import { Discoverer, isTestPath, refuseWord } from "../src/discovery/discover.ts";
import { isSensitivePath } from "../src/evidence/redact.ts";
import { calleeOf, declaredForTestsOnly, targetOf, type CalleeLocation } from "../src/plan/applicability.ts";
import type { CallCandidate, FunctionCandidate } from "../src/plan/candidates.ts";
import { CandidateFiles, COMMON_FILES, isRust, MAX_CALLER_FUNCTIONS, MAX_HOP_NAMES, readListing, readsAsCall, sitesFromChange } from "../src/plan/from-diff.ts";
import { Git } from "../src/repository/git.ts";
import { isMethodCandidate } from "./call-oracle/classify.ts";
import { clopperPearson, estimateOver } from "./eval/metrics.ts";
import { brokenAt, classifyCall, isTraitDeclaration, push, lastName, Oracle, oracleAnswer, parseSymbol, shapeOf, type CallClass, type Classified, type OracleOutput } from "./resolution/classify.ts";

const HERE = resolve(import.meta.dirname, "..");
const CRATE = join(HERE, "bench/resolution-oracle");
const BIN = join(CRATE, "target/release/resolution-oracle");
const FIXTURES = join(HERE, "test/fixtures/resolution");
const CLONES = join(homedir(), ".cctmp/call-oracle-clones");
const INDEXES = join(homedir(), ".cctmp/resolution-scip");
const RA = join(homedir(), ".rustup/toolchains/stable-aarch64-apple-darwin/bin/rust-analyzer");

// Fixed before measuring (the plan, *Design* 3 and 8).
const SEED = "83-resolution-v1";
const PER_CELL = 200;
const COVERAGE_FLOOR = 0.9;
const MIN_POOLED = 300;

/**
 * grovedb has no Cargo.lock, and a git dependency asks for versions of core2 and halo2_gadgets that
 * are all yanked, so `cargo metadata` fails and rust-analyzer indexes a third of the files. The
 * same versions are taken from their tags. Written next to the clones, never into one: a tracked
 * `.cargo/config.toml` would change what the product reads.
 */
const CARGO_PATCH = `# #83 part 2 (bench/resolution.ts): versions a dependency asks for that are all yanked.
[patch.crates-io]
core2 = { git = "https://github.com/technocreatives/core2", tag = "v0.3.3" }
halo2_gadgets = { git = "https://github.com/zcash/halo2", tag = "halo2_gadgets-0.4.0" }
`;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

interface Material {
  name: string;
  cases: { case: string; repo: string; commit: string }[];
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
}

const cloneOf = (repo: string) => join(CLONES, repo.replace(/^https:\/\/github\.com\//, "").replace("/", "-"));

function checkout(repo: string, commit: string): string {
  const dir = cloneOf(repo);
  if (!existsSync(dir)) throw new Error(`${dir}: clone it first with bench/call-oracle.ts measure`);
  git(dir, "checkout", "-q", "--force", "--detach", commit);
  return dir;
}

/** The commit each case's change starts from: the pull request's merge base (bench/acceptance/precheck-shipped.json), and omamori-468's by its branch point. */
function before(dir: string, k: { case: string; commit: string }): string {
  const shipped = JSON.parse(readFileSync(join(HERE, "bench/acceptance/precheck-shipped.json"), "utf8")) as { cases: Record<string, { revisions: { before: string; after: string } }> };
  const row = shipped.cases[k.case];
  if (row) {
    if (row.revisions.after !== k.commit) throw new Error(`${k.case}: the material's commit is not the one precheck-shipped.json read`);
    return row.revisions.before;
  }
  if (k.case === "omamori-468") return git(dir, "merge-base", "52a58fa", k.commit).trim();
  throw new Error(`${k.case}: no base commit`);
}

// --- index -------------------------------------------------------------------------------------

/** The Cargo projects to index: the root manifest, or else each manifest with none above it. */
function cargoRoots(dir: string, commit: string): string[] {
  const manifests = git(dir, "ls-tree", "-r", "--name-only", commit)
    .split("\n")
    .filter((p) => p === "Cargo.toml" || p.endsWith("/Cargo.toml"))
    .map((p) => dirname(p));
  if (manifests.includes(".")) return ["."];
  return manifests.filter((m) => !manifests.some((o) => o !== m && m.startsWith(`${o}/`))).sort();
}

interface IndexMeta {
  commit: string;
  tool: string;
  cargoPatch: string;
  roots: { root: string; file: string; rc: number; seconds: number }[];
}

function index(materialPath: string): void {
  const material = JSON.parse(readFileSync(materialPath, "utf8")) as Material;
  mkdirSync(join(CLONES, ".cargo"), { recursive: true });
  writeFileSync(join(CLONES, ".cargo/config.toml"), CARGO_PATCH);
  const tool = execFileSync(RA, ["--version"], { encoding: "utf8" }).trim();
  for (const k of material.cases) {
    const out = join(INDEXES, k.case);
    const metaPath = join(out, "meta.json");
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as IndexMeta;
      if (meta.commit === k.commit && meta.tool === tool && meta.cargoPatch === CARGO_PATCH && meta.roots.every((r) => r.rc === 0 && existsSync(join(out, r.file)))) {
        console.log(`${k.case}: kept`);
        continue;
      }
    }
    const dir = checkout(k.repo, k.commit);
    mkdirSync(out, { recursive: true });
    const roots = cargoRoots(dir, k.commit).map((root, i) => {
      const file = `${i}.scip`;
      const started = performance.now();
      const run = spawnSync(RA, ["scip", join(dir, root), "--output", join(out, file)], { encoding: "utf8", maxBuffer: 1 << 30 });
      const seconds = Math.round((performance.now() - started) / 1000);
      if (run.status !== 0) console.log(`${k.case} ${root}: rust-analyzer exit ${run.status}: ${run.stderr.split("\n").find((l) => /error/i.test(l)) ?? ""}`);
      return { root, file, rc: run.status ?? -1, seconds };
    });
    const meta: IndexMeta = { commit: k.commit, tool, cargoPatch: CARGO_PATCH, roots };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 1)}\n`);
    console.log(`${k.case}: ${roots.map((r) => `${r.root} rc=${r.rc} ${r.seconds}s`).join(", ")}`);
  }
}

function runOracle(dir: string, scips: string[]): OracleOutput {
  if (!existsSync(BIN)) throw new Error(`build the oracle first: cargo build --release --manifest-path ${CRATE}/Cargo.toml`);
  const out = spawnSync(BIN, [dir, ...scips], { maxBuffer: 2 ** 31 - 1, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`resolution-oracle failed: ${out.stderr}`);
  return JSON.parse(out.stdout) as OracleOutput;
}

function oracleFor(k: { case: string; commit: string }, dir: string): { oracle: Oracle; out: OracleOutput; meta: IndexMeta } {
  const meta = JSON.parse(readFileSync(join(INDEXES, k.case, "meta.json"), "utf8")) as IndexMeta;
  if (meta.commit !== k.commit) throw new Error(`${k.case}: the index is of ${meta.commit}, not ${k.commit}; run index`);
  const scips = meta.roots.filter((r) => r.rc === 0).map((r) => join(INDEXES, k.case, r.file));
  const out = runOracle(dir, scips);
  return { oracle: new Oracle(out), out, meta };
}

// --- the product's side ------------------------------------------------------------------------

interface Setting {
  dir: string;
  discoverer: Discoverer;
  include: (path: string) => boolean;
  git: Git;
}

/** As the product runs: `runLocalCheck`'s discoverer (src/review/local-check-run.ts). */
async function setting(k: { repo: string; commit: string }): Promise<Setting> {
  const dir = checkout(k.repo, k.commit);
  const repo = new Git(dir);
  const { config } = await loadConfig(repo, k.commit, k.commit);
  const include = pathFilter(config.repository.include, config.repository.ignore);
  return { dir, discoverer: new Discoverer(repo, k.commit, { include }), include, git: repo };
}

type Form = "function" | "path" | "method" | "macro";

interface ListedCall {
  path: string;
  fn: FunctionCandidate;
  call: CallCandidate;
  /** Where the callee's last name starts, which is where the index records the name's use. */
  nameColumn: number;
  form: Form;
  covered: boolean;
}

/** Every call the product lists at this commit, with where its name is. */
async function listedCalls(s: Setting, commit: string, oracle: Oracle, seen: Set<string>): Promise<{ calls: ListedCall[]; files: number; filesNotIndexed: number; notRead: number; duplicates: number }> {
  const entries = git(s.dir, "ls-tree", "-r", commit)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t") as [string, string];
      return { blob: meta.split(" ")[2]!, path };
    })
    .filter((e) => e.path.endsWith(".rs") && s.include(e.path) && !isSensitivePath(e.path) && !isTestPath(e.path));
  const calls: ListedCall[] = [];
  let files = 0;
  let filesNotIndexed = 0;
  let notRead = 0;
  let duplicates = 0;
  for (const e of entries) {
    if (seen.has(e.blob)) {
      duplicates += 1;
      continue;
    }
    seen.add(e.blob);
    const idx = await s.discoverer.index(e.path);
    const listing = await readListing(s.discoverer, e.path);
    if (!idx || !listing) {
      notRead += 1;
      continue;
    }
    if (listing.functions.length === 0) continue;
    files += 1;
    if (!oracle.files.has(e.path)) filesNotIndexed += 1;
    const lines = idx.lines;
    const nameOf = new Map<string, number>();
    for (const c of idx.rust?.calls ?? []) nameOf.set(`${c.line}:${c.startColumn}:${c.callee}`, c.column);
    const inMacro = new Set((idx.rust?.calls ?? []).filter((c) => c.inMacro).map((c) => `${c.line}:${c.startColumn}`));
    const fnOf = new Map(listing.functions.map((f) => [f.id, f]));
    for (const call of listing.calls) {
      const nameColumn = nameOf.get(`${call.line}:${call.column}:${call.callee}`);
      if (nameColumn === undefined) throw new Error(`${e.path}:${call.line}: a listed call the parser does not hold`);
      const form: Form = inMacro.has(`${call.line}:${call.column}`) ? "macro" : isMethodCandidate(lines, call) ? "method" : call.callee.includes("::") ? "path" : "function";
      calls.push({ path: e.path, fn: fnOf.get(call.functionId)!, call, nameColumn, form, covered: oracle.at(e.path, call.line, nameColumn) !== undefined });
    }
  }
  return { calls, files, filesNotIndexed, notRead, duplicates };
}

/** Up to `PER_CELL` of each form, by a hash of the seed and the call: the same sample every run. */
function sample(calls: ListedCall[], caseName: string): ListedCall[] {
  const byForm = new Map<Form, ListedCall[]>();
  for (const c of calls) push(byForm, c.form, c);
  const out: ListedCall[] = [];
  for (const group of byForm.values()) {
    const keyed = group.map((c) => ({ c, key: sha256(`${SEED}\u0000${caseName}\u0000${c.path}\u0000${c.call.id}`) }));
    keyed.sort((a, b) => (a.key < b.key ? -1 : 1));
    out.push(...keyed.slice(0, PER_CELL).map((k) => k.c));
  }
  return out;
}

// --- the callers' side -------------------------------------------------------------------------


interface CallerRecord {
  changedFunctions: { path: string; name: string; startLine: number; inOracle: boolean }[];
  names: number;
  product: number;
  oracle: number;
  both: number;
  /**
   * Product callers rust-analyzer does not see referring to any changed function, by what rust-analyzer
   * says the name there is: a trait's declaration (`dispatch`, which may reach the changed function),
   * another function of the same name (`wrong`), or no use of the name at all (`no_reference`).
   */
  wrong: { path: string; name: string; line: number; why: "dispatch" | "wrong" | "no_reference" }[];
  /** rust-analyzer callers the product did not take, by why. */
  missed: Record<string, number>;
  missedRows: { path: string; name: string; line: number; why: string }[];
  /** Names the product did not follow, by why; their rust-analyzer callers are counted here and not as missed. */
  capped: Record<string, number>;
  oracleOutsideFunction: number;
  /** rust-analyzer's references in code compiled only for tests (#81's syn oracle), out of scope as the listing leaves them out. */
  oracleTestCode: number;
}

const CALL_ORACLE = join(HERE, "bench/call-oracle/target/release/call-oracle");

/** Lines of a file that are compiled only for tests, from #81's syn oracle: a scope both sides share, and not the product's own reading. */
function testOnlyRanges(dir: string): (path: string) => [number, number][] {
  const cache = new Map<string, [number, number][]>();
  return (path) => {
    let hit = cache.get(path);
    if (!hit) {
      const out = spawnSync(CALL_ORACLE, [dir], { input: path, encoding: "utf8", maxBuffer: 1 << 28 });
      if (out.status !== 0) throw new Error(`call-oracle: ${out.stderr}`);
      const [file] = JSON.parse(out.stdout) as { ranges?: { test_only: [number, number, number, number][] } }[];
      hit = (file?.ranges?.test_only ?? []).map((r) => [r[0], r[2]]);
      cache.set(path, hit);
    }
    return hit;
  };
}

/** The change read as the product reads it: its changed functions and the callers the product took, in from-diff.ts's order. */
async function productChange(s: Setting, k: { case: string; commit: string }) {
  const change = await analyzeChange(s.git, before(s.dir, k), k.commit, s.include);
  const files = new CandidateFiles(s.discoverer);
  const fromChange = await sitesFromChange(files, s.discoverer, Discoverer.changedLines(change));
  const changed: FunctionCandidate[] = [];
  const productCallers: FunctionCandidate[] = [];
  for (const [, src] of [...fromChange.sources.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const f of src.candidates.functions) {
      if (src.changed?.includes(f.id)) changed.push(f);
      if (src.callsChanged?.includes(f.id)) productCallers.push(f);
    }
  }
  return { files, changed, productCallers };
}

async function callers(s: Setting, k: { case: string; commit: string }, oracle: Oracle): Promise<CallerRecord> {
  const { files, changed, productCallers } = await productChange(s, k);

  // The hop as from-diff.ts walks it, uncapped, to say why a caller rust-analyzer sees was not taken.
  const names = [...new Map(changed.map((f) => [f.name, f])).values()];
  const cappedName = new Map<string, string>();
  const hitFate = new Map<string, string>(); // path:line → fate
  for (const [i, fn] of names.entries()) {
    if (i >= MAX_HOP_NAMES) {
      cappedName.set(fn.name, "hop_names_cap");
      continue;
    }
    if (refuseWord(fn.name, 3)) {
      cappedName.set(fn.name, "refused_word");
      continue;
    }
    const { hits, more } = await s.discoverer.search(fn.name);
    const outside = hits.filter((h) => !isTestPath(h.path) && isRust(h.path));
    if (more || new Set(outside.map((h) => h.path)).size > COMMON_FILES) {
      cappedName.set(fn.name, "not_followed");
      continue;
    }
    for (const hit of outside) {
      const key = `${hit.path}:${hit.line}`;
      if (await declaredForTestsOnly(s.discoverer, hit.path, { forListing: true })) hitFate.set(key, "test_only");
      else {
        const listing = await files.of(hit.path);
        if (!listing) hitFate.set(key, "unreadable");
        else {
          const around = listing.functions.find((f) => hit.line >= f.startLine && hit.line <= f.endLine);
          if (!around) hitFate.set(key, "outside_function");
          // The product takes a hit only where it reads as a call (#83, readsAsCall).
          else hitFate.set(key, (await readsAsCall(s.discoverer, listing, around, hit.path, hit.line, fn.name)) ? "found" : "not_a_call");
        }
      }
    }
  }

  // rust-analyzer's callers of each changed function, outside tests as the product reads them.
  const changedFunctions: CallerRecord["changedFunctions"] = [];
  const oracleCallers = new Map<string, { path: string; line: number; name: string; start: number; end: number; of: string }>();
  let oracleOutsideFunction = 0;
  let oracleTestCode = 0;
  const testRanges = testOnlyRanges(s.dir);
  for (const f of changed) {
    // The changed function's own definition: a callable whose name line is inside it and whose name is its.
    const own = [...Array(f.endLine - f.startLine + 1).keys()]
      .map((d) => oracle.enclosing(f.path, f.startLine + d))
      .find((c) => c && c.def.line >= f.startLine && c.def.line <= f.endLine && lastName(oracle.symbol(c.id).text) === f.name);
    changedFunctions.push({ path: f.path, name: f.name, startLine: f.startLine, inOracle: own !== undefined });
    if (!own) continue;
    for (const ref of oracle.refsTo(own.id)) {
      if (isTestPath(ref.path) || !isRust(ref.path)) continue;
      if (await declaredForTestsOnly(s.discoverer, ref.path, { forListing: true })) continue;
      if (testRanges(ref.path).some(([a, b]) => ref.line >= a && ref.line <= b)) {
        oracleTestCode += 1;
        continue;
      }
      const around = oracle.enclosing(ref.path, ref.line);
      if (!around) {
        oracleOutsideFunction += 1;
        continue;
      }
      if (around.id === own.id) continue; // its own body
      const name = lastName(oracle.symbol(around.id).text);
      if (changed.some((c) => c.path === ref.path && around.def.line >= c.startLine && around.def.line <= c.endLine)) continue;
      oracleCallers.set(`${ref.path}:${around.def.line}`, { path: ref.path, line: around.def.line, name, start: around.def.start, end: around.def.end, of: f.name });
    }
  }

  const matches = (p: FunctionCandidate, o: { path: string; line: number; name: string }) => p.path === o.path && o.line >= p.startLine && o.line <= p.endLine && p.name === o.name;
  const changedNames = new Set(changed.map((f) => f.name));
  const wrong = productCallers
    .filter((p) => ![...oracleCallers.values()].some((o) => matches(p, o)))
    .map((p) => {
      const named = oracle.refsIn(p.path, p.startLine, p.endLine).filter((id) => changedNames.has(lastName(oracle.symbol(id).text)) && shapeOf(oracle.symbol(id).text) === "callable");
      const why: CallerRecord["wrong"][number]["why"] = named.some((id) => isTraitDeclaration(oracle.symbol(id).text)) ? "dispatch" : named.length > 0 ? "wrong" : "no_reference";
      return { path: p.path, name: p.name, line: p.startLine, why };
    });
  const missed: Record<string, number> = {};
  const missedRows: CallerRecord["missedRows"] = [];
  const capped: Record<string, number> = {};
  let both = 0;
  for (const o of oracleCallers.values()) {
    if (productCallers.some((p) => matches(p, o))) {
      both += 1;
      continue;
    }
    const cap = cappedName.get(o.of);
    if (cap) {
      capped[cap] = (capped[cap] ?? 0) + 1;
      continue;
    }
    const fates = [...hitFate.entries()].filter(([key]) => {
      const [path, line] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
      return path === o.path && line >= o.start && line <= o.end;
    });
    const why = fates.length === 0 ? "not_found_by_search" : fates.some(([, f]) => f === "found") ? (productCallers.length >= MAX_CALLER_FUNCTIONS ? "caller_cap" : "found_not_taken") : fates[0]![1];
    if (why === "caller_cap") {
      capped[why] = (capped[why] ?? 0) + 1;
      continue;
    }
    missed[why] = (missed[why] ?? 0) + 1;
    missedRows.push({ path: o.path, name: o.name, line: o.line, why });
  }
  return { changedFunctions, names: names.length, product: productCallers.length, oracle: oracleCallers.size, both, wrong, missed, missedRows, capped, oracleOutsideFunction, oracleTestCode };
}

// --- denominators ------------------------------------------------------------------------------

async function denominators(materialPath: string): Promise<void> {
  const material = JSON.parse(readFileSync(materialPath, "utf8")) as Material;
  for (const k of material.cases) {
    const s = await setting(k);
    const { changed } = await productChange(s, k);
    console.log(`${k.case}: ${changed.length} changed functions, ${new Set(changed.map((f) => f.name)).size} names: ${changed.map((f) => `${f.path}::${f.name}`).join(", ")}`);
  }
}

// --- measure -----------------------------------------------------------------------------------

type Counts = Partial<Record<CallClass, number>>;
const bump = (c: Counts, k: CallClass) => (c[k] = (c[k] ?? 0) + 1);

/** The calls the trust judgement reads: rust-analyzer settled them to one definition that is not a trait's declaration or a macro. */
const DECIDED: CallClass[] = ["same", "same_in_versions", "wrong", "voided"];

interface Row {
  case: string;
  repo: string;
  path: string;
  line: number;
  callee: string;
  form: Form;
  asked: boolean;
  class: Classified;
  /** Where the product and rust-analyzer said the call goes. */
  product: CalleeLocation;
  oracle: string;
  /** Where rust-analyzer's definition is, when it is in the repository: what the rustc check renames. */
  oracleDef?: { path: string; line: number };
  /** For `dispatch`: the trait is not the repository's, so a callee the product settled here is not it. */
  traitOutside?: boolean;
  column: number;
}

async function measure(materialPath: string, broken: boolean): Promise<void> {
  const material = JSON.parse(readFileSync(materialPath, "utf8")) as Material;
  const seen = new Set<string>();
  const rows: Row[] = [];
  const byCase: Record<string, unknown> = {};
  const coverage: { case: string; repo: string; calls: number; covered: number; rate: number; kept: boolean }[] = [];
  const callerRecords: Record<string, CallerRecord> = {};
  let moved = 0;
  let shifted = 0;

  for (const k of material.cases) {
    const s = await setting(k);
    const { oracle, out, meta } = oracleFor(k, s.dir);
    const listed = await listedCalls(s, k.commit, oracle, seen);
    const covered = listed.calls.filter((c) => c.covered).length;
    const rate = listed.calls.length === 0 ? 1 : covered / listed.calls.length;
    coverage.push({ case: k.case, repo: k.repo, calls: listed.calls.length, covered, rate, kept: rate >= COVERAGE_FLOOR });
    const forms: Record<string, number> = {};
    for (const c of listed.calls) forms[c.form] = (forms[c.form] ?? 0) + 1;

    const picked = sample(listed.calls, k.case);
    const answers = await Promise.all(picked.map((c) => calleeOf(s.discoverer, c.fn, c.call)));
    const targets = new Map<string, boolean>();
    for (const c of picked) if (!targets.has(c.fn.id)) targets.set(c.fn.id, (await targetOf(s.discoverer, c.fn)) === null);
    const indexed = (path: string) => oracle.files.has(path);
    const ats = broken ? brokenAt(answers.map((a) => a.at)) : answers.map((a) => a.at);
    for (const [i, c] of picked.entries()) {
      const answer = oracleAnswer(oracle, oracle.at(c.path, c.call.line, c.nameColumn));
      const cls = classifyCall({ result: answers[i]!.result, at: ats[i]! }, answer, indexed);
      if (broken && answers[i]!.at !== ats[i]) {
        shifted += 1;
        if (classifyCall(answers[i]!, answer, indexed).class === "same" && cls.class === "wrong") moved += 1;
      }
      rows.push({ case: k.case, repo: k.repo, path: c.path, line: c.call.line, callee: c.call.callee, form: c.form, asked: targets.get(c.fn.id)!, class: cls, product: ats[i]!, oracle: "symbol" in answer ? answer.symbol : answer.kind, ...(answer.kind === "repository" && answer.defs.length === 1 ? { oracleDef: { path: answer.defs[0]!.path, line: answer.defs[0]!.line } } : {}), column: c.nameColumn, ...(answer.kind === "dispatch" ? { traitOutside: !oracle.repoCrates.has(parseSymbol(answer.symbol).crate) } : {}) });
    }
    if (!broken) callerRecords[k.case] = await callers(s, k, oracle);
    byCase[k.case] = {
      commit: k.commit,
      index: { tool: out.tool, roots: meta.roots, documents: out.indexes.reduce((n, x) => n + x.documents, 0), misaligned: out.misaligned },
      files: { listed: listed.files, notIndexed: listed.filesNotIndexed, notRead: listed.notRead, duplicatesOfEarlierCases: listed.duplicates },
      calls: { listed: listed.calls.length, byForm: forms, sampled: picked.length },
    };
    console.log(`${k.case}: ${listed.calls.length} calls, coverage ${(rate * 100).toFixed(1)}%, sampled ${picked.length}`);
  }

  const kept = new Set(coverage.filter((c) => c.kept).map((c) => c.case));
  const table = (subset: Row[]) => {
    const forms = [...new Set(subset.map((r) => r.form))].sort();
    return Object.fromEntries(
      forms.map((form) => {
        const all = subset.filter((r) => r.form === form);
        const classes: Counts = {};
        for (const r of all) bump(classes, r.class.class);
        const decided = all.filter((r) => DECIDED.includes(r.class.class));
        const wrong = decided.filter((r) => r.class.class === "wrong").length;
        const voided = decided.filter((r) => r.class.class === "voided").length;
        const byRepo = new Map<string, { wrong: number; decided: number }>();
        for (const r of decided) {
          const x = byRepo.get(r.repo) ?? { wrong: 0, decided: 0 };
          x.decided += 1;
          if (r.class.class === "wrong") x.wrong += 1;
          byRepo.set(r.repo, x);
        }
        const worstRepo = Math.max(0, ...[...byRepo.values()].map((x) => x.wrong / x.decided));
        const pooled = decided.length > 0 ? clopperPearson(wrong, decided.length) : { lower: null, upper: null };
        const wrongRate = decided.length > 0 ? wrong / decided.length : null;
        const voidedRate = decided.length > 0 ? voided / decided.length : null;
        // The same count over the calls the product settled (`voided` left out): what a settled callee is worth.
        const settled = decided.filter((r) => r.class.class !== "voided").length;
        const dispatch = all.filter((r) => r.class.class === "dispatch");
        const settledHere = dispatch.filter((r) => r.product?.kind === "repository" || r.product?.kind === "versions");
        const verdict = verdictOf(form, decided.length, wrongRate, pooled.upper, worstRepo, voidedRate);
        return [
          form,
          {
            calls: all.length,
            classes,
            decided: decided.length,
            wrong: { count: wrong, rate: wrongRate, pooled, worstRepo, overRepos: estimateOver([...byRepo.entries()].map(([repo, x]) => ({ repo, hits: x.wrong, units: x.decided }))) },
            wrongOfSettled: { settled, rate: settled > 0 ? wrong / settled : null },
            dispatch: {
              count: dispatch.length,
              productSettledHere: settledHere.length,
              // Settled here although the trait is another crate's: wrong, and counted as dispatch, not wrong.
              ofWhichTraitOutside: settledHere.filter((r) => r.traitOutside).length,
            },
            voided: {
              count: voided,
              rate: voidedRate,
              byReason: countBy(decided.filter((r) => r.class.class === "voided").map((r) => r.class.reason)),
              // Where rust-analyzer's answer is: a relation lost inside the repository, or a callee outside it that the table does not hold.
              byOracle: countBy(decided.filter((r) => r.class.class === "voided").map((r) => r.class.oracle)),
            },
            verdict,
          },
        ];
      }),
    );
  };

  const keptRows = rows.filter((r) => kept.has(r.case));
  const summary = {
    what: "#83's second part (docs/resolution.md): the product's name resolution against rust-analyzer's SCIP index, on #80's dev material (#81's nine cases). Written by `node bench/resolution.ts measure`.",
    material: basename(materialPath),
    fixedBeforeMeasuring: { seed: SEED, perCell: PER_CELL, coverageFloor: COVERAGE_FLOOR, minPooled: MIN_POOLED, decided: DECIDED, criteria: CRITERIA },
    oracleSources: oracleSources(),
    coverage,
    ...(broken ? { broken: { shifted, movedSameToWrong: moved } } : {}),
    all: table(keptRows),
    asked: table(keptRows.filter((r) => r.asked)),
    excludedCases: coverage.filter((c) => !c.kept).map((c) => c.case),
    byCase,
    callers: broken ? undefined : { verdict: callersVerdict(callerRecords), byCase: callerRecords },
  };
  const name = `resolution-${material.name}${broken ? "-broken" : ""}`;
  writeFileSync(join(HERE, `bench/logs/${name}.json`), `${JSON.stringify(summary, null, 1)}\n`);
  if (!broken) {
    const disagreements = rows.filter((r) => r.class.class === "wrong" || r.class.class === "voided");
    writeFileSync(join(HERE, `bench/logs/${name}-rows.jsonl`), `${disagreements.map((r) => JSON.stringify(r)).join("\n")}\n`);
    // Every sampled row, for the rustc check; not committed.
    writeFileSync(join(INDEXES, `${name}-all-rows.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  console.log(`wrote bench/logs/${name}.json`);
}

const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

const CRITERIA = {
  trusted: "pooled wrong's upper bound ≤ 1%, no repository's wrong over 5%, voided ≤ 20%, at least 300 decided calls",
  ambiguous: "wrong's point estimate ≤ 5% and not trusted (or fewer than 300 decided calls)",
  unsupported: "wrong's point estimate over 5%; a trait's declaration (dispatch) and macro_rules! are unsupported as forms",
  callers: "wrong callers ≤ 5% of the product's and missed (caps aside) ≤ 20% of rust-analyzer's: trusted; wrong over 5%: unsupported; otherwise ambiguous",
};

function verdictOf(form: string, decided: number, wrongRate: number | null, upper: number | null, worstRepo: number, voidedRate: number | null): "trusted" | "ambiguous" | "ambiguous_too_few" | "unsupported" | "no_calls" {
  if (wrongRate === null || upper === null || voidedRate === null) return "no_calls";
  if (wrongRate > 0.05) return "unsupported";
  if (decided < MIN_POOLED) return "ambiguous_too_few";
  if (upper <= 0.01 && worstRepo <= 0.05 && voidedRate <= 0.2) return "trusted";
  return "ambiguous";
}

/**
 * The callers' direction, pooled over the cases. `dispatch` is out of the count of wrong callers: a
 * call through a trait's declaration may reach the changed function, and the index does not say.
 */
function callersVerdict(records: Record<string, CallerRecord>) {
  const all = Object.values(records);
  const product = all.reduce((n, r) => n + r.product, 0);
  const dispatch = all.reduce((n, r) => n + r.wrong.filter((w) => w.why === "dispatch").length, 0);
  const wrong = all.reduce((n, r) => n + r.wrong.filter((w) => w.why !== "dispatch").length, 0);
  const oracle = all.reduce((n, r) => n + r.oracle, 0);
  const capped = all.reduce((n, r) => n + Object.values(r.capped).reduce((a, b) => a + b, 0), 0);
  const missed = all.reduce((n, r) => n + Object.values(r.missed).reduce((a, b) => a + b, 0), 0);
  const wrongRate = product - dispatch > 0 ? wrong / (product - dispatch) : null;
  const missedRate = oracle - capped > 0 ? missed / (oracle - capped) : null;
  const verdict = wrongRate === null || missedRate === null ? "no_callers" : wrongRate > 0.05 ? "unsupported" : missedRate <= 0.2 ? "trusted" : "ambiguous";
  return { product, dispatch, wrong, wrongRate, oracle, capped, missed, missedRate, verdict };
}

/** The oracle's own sources, so output written by another version of it is noticed. */
export function oracleSources(): Record<string, string> {
  return Object.fromEntries(["src/main.rs", "Cargo.toml", "Cargo.lock"].map((f) => [f, sha256(readFileSync(join(CRATE, f)))]));
}

// --- rustc -------------------------------------------------------------------------------------

const RUSTC_PER_CLASS = 20;
const SCRATCH = join(homedir(), ".cctmp/resolution-rustc");

interface CompilerSpan {
  file_name: string;
  line_start: number;
  line_end: number;
  column_start: number;
  column_end: number;
  text: { text: string }[];
}

/** `cargo check` in a Cargo project, and every error's spans as absolute paths. `null` when cargo itself failed to run. */
function cargoCheck(project: string, target: string): { spans: (CompilerSpan & { abs: string; code: string })[]; ok: boolean } | null {
  const run = spawnSync("cargo", ["check", "--workspace", "--message-format=json", "--quiet"], { cwd: project, env: { ...process.env, CARGO_TARGET_DIR: target }, encoding: "utf8", maxBuffer: 2 ** 31 - 1 });
  if (run.status === null) return null;
  const spans: (CompilerSpan & { abs: string; code: string })[] = [];
  for (const line of run.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const m = JSON.parse(line) as { reason: string; message?: { level: string; code: { code: string } | null; spans: CompilerSpan[] } };
    if (m.reason !== "compiler-message" || m.message?.level !== "error") continue;
    for (const s of m.message.spans) spans.push({ ...s, code: m.message.code?.code ?? "", abs: s.file_name.startsWith("/") ? s.file_name : join(project, s.file_name) });
  }
  return { spans, ok: run.status === 0 };
}

/**
 * Whether the rename broke the call: an error at the call's name (its line, and a column range that
 * holds the name's start; compiler columns are 1-based), or an unresolved import (E0432) in the
 * call's own file naming it — rustc reports a name brought in by `use` there and nowhere else.
 */
const hits = (spans: (CompilerSpan & { abs: string; code: string })[], file: string, line: number, column: number, name: string) =>
  spans.some(
    (s) =>
      s.abs === file &&
      ((s.line_start <= line && s.line_end >= line && (s.line_start < line || s.column_start - 1 <= column) && (s.line_end > line || s.column_end - 1 > column)) ||
        (s.code === "E0432" && s.text.some((t) => new RegExp(`\\b${name}\\b`).test(t.text)))),
  );

/**
 * The plan's third check. For `same` and `voided`, the definition rust-analyzer names is renamed and
 * the call must break there. For `wrong` — nearly all of them a callee outside the repository, so
 * nothing of rust-analyzer's to rename — the product's own pick is renamed and the call must not
 * break. Rows are taken in the order of a hash of the seed and the row, and a row whose Cargo project
 * does not build before any rename is passed over and counted, until `RUSTC_PER_CLASS` are checked:
 * whether a project builds does not depend on the row's class.
 */
async function rustc(materialPath: string): Promise<void> {
  const material = JSON.parse(readFileSync(materialPath, "utf8")) as Material;
  const all = readFileSync(join(INDEXES, `resolution-${material.name}-all-rows.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  const commitOf = new Map(material.cases.map((k) => [k.case, k]));
  mkdirSync(join(SCRATCH, ".cargo"), { recursive: true });
  writeFileSync(join(SCRATCH, ".cargo/config.toml"), CARGO_PATCH);

  const scratches = new Map<string, { scratch: string; projectOf: (path: string) => string; target: string }>();
  const scratchOf = (caseName: string) => {
    let s = scratches.get(caseName);
    if (s) return s;
    const k = commitOf.get(caseName)!;
    const scratch = join(SCRATCH, caseName);
    if (!existsSync(scratch)) execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", cloneOf(k.repo), scratch]);
    git(scratch, "checkout", "-q", "--force", "--detach", k.commit);
    const roots = cargoRoots(scratch, k.commit);
    s = { scratch, target: join(SCRATCH, `target-${caseName}`), projectOf: (path) => join(scratch, roots.filter((r) => r === "." || path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? ".") };
    scratches.set(caseName, s);
    return s;
  };
  const baselines = new Map<string, boolean>();
  const builds = (project: string, target: string) => {
    if (!baselines.has(project)) baselines.set(project, cargoCheck(project, target)?.ok ?? false);
    return baselines.get(project)!;
  };

  type Result = { case: string; class: CallClass; probe: "oracle" | "product"; path: string; line: number; callee: string; renamed: string; broke: boolean | null; note?: string };
  const results: Result[] = [];
  const passedOver: Record<string, number> = {};
  const plan: [CallClass, "oracle" | "product"][] = [["same", "oracle"], ["voided", "oracle"], ["wrong", "product"]];
  for (const [cls, probe] of plan) {
    const rows = all
      .filter((r) => r.class.class === cls && (probe === "oracle" ? r.oracleDef : r.product?.kind === "repository"))
      .map((r) => ({ r, key: sha256(`${SEED}\u0000rustc\u0000${r.case}\u0000${r.path}:${r.line}:${r.column}`) }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((x) => x.r);
    let checked = 0;
    for (const row of rows) {
      if (checked >= RUSTC_PER_CLASS) break;
      const { scratch, projectOf, target } = scratchOf(row.case);
      git(scratch, "checkout", "-q", "--force", "--detach", commitOf.get(row.case)!.commit);
      const project = projectOf(row.path);
      if (!builds(project, target)) {
        const key = `${row.case} ${project.slice(scratch.length + 1) || "."}`;
        passedOver[key] = (passedOver[key] ?? 0) + 1;
        continue;
      }
      const def = probe === "oracle" ? row.oracleDef! : { path: (row.product as { path: string }).path, line: (row.product as { line: number }).line };
      const name = row.callee.split("::").at(-1)!;
      const record = { case: row.case, class: cls, probe, path: row.path, line: row.line, callee: row.callee, renamed: `${def.path}:${def.line}` };
      const file = join(scratch, def.path);
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      const re = new RegExp(`\\bfn\\s+(r#)?${name}\\b`);
      const at = [def.line - 1, def.line, def.line - 2].find((i) => i >= 0 && re.test(lines[i] ?? ""));
      if (at === undefined) {
        results.push({ ...record, broke: null, note: "no \`fn name\` on the definition's line" });
        continue;
      }
      lines[at] = lines[at]!.replace(re, (m) => `${m}__jir_probe`);
      writeFileSync(file, lines.join("\n"));
      try {
        const after = cargoCheck(project, target);
        results.push({ ...record, broke: after ? hits(after.spans, join(scratch, row.path), row.line, row.column, name) : null });
      } finally {
        writeFileSync(file, text);
      }
      if (results.at(-1)!.broke !== null) checked += 1;
      console.log(`${row.case} ${cls}/${probe} ${row.path}:${row.line} ${row.callee}: ${results.at(-1)!.broke}`);
    }
  }
  const tally = (cls: string) => {
    const r = results.filter((x) => x.class === cls);
    return { checked: r.filter((x) => x.broke !== null).length, broke: r.filter((x) => x.broke === true).length, held: r.filter((x) => x.broke === false).length, notRenamed: r.filter((x) => x.broke === null).length };
  };
  const summary = {
    what: "#83's second part, the plan's third check: renaming the definition rust-analyzer names breaks a same or voided call there, and renaming the product's own pick of a wrong call does not (bar 95% each). Written by `node bench/resolution.ts rustc`.",
    perClass: RUSTC_PER_CLASS,
    seed: SEED,
    tally: { same: tally("same"), voided: tally("voided"), wrongProductPick: tally("wrong") },
    passedOver: { why: "the Cargo project does not build before any rename (a toolchain file this cargo does not read, a wasm target not installed, a C++ build)", rows: passedOver },
    results,
  };
  writeFileSync(join(HERE, `bench/logs/resolution-rustc-${material.name}.json`), `${JSON.stringify(summary, null, 1)}\n`);
  console.log(JSON.stringify(summary.tally), JSON.stringify(passedOver));
}

// --- fixtures ----------------------------------------------------------------------------------

/** The fixture crate is indexed by rust-analyzer and its answer committed, so the tests run without it. */
function fixtures(): void {
  const crate = join(FIXTURES, "crate");
  const scip = join(INDEXES, "fixture.scip");
  mkdirSync(INDEXES, { recursive: true });
  const run = spawnSync(RA, ["scip", crate, "--output", scip], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`rust-analyzer: ${run.stderr}`);
  const out = runOracle(crate, [scip]);
  const sources = Object.fromEntries(
    readdirSync(join(crate, "src"))
      .sort()
      .map((f) => [`src/${f}`, sha256(readFileSync(join(crate, "src", f)))]),
  );
  writeFileSync(join(FIXTURES, "oracle.json"), `${JSON.stringify({ note: "Written by `node bench/resolution.ts fixtures`. test/resolution.test.ts checks the shas.", oracleSources: oracleSources(), sources, out: { ...out, tool: out.tool.replace(/ \(.*\)$/, "") } }, null, 1)}\n`);
  console.log(`${Object.keys(out.files).length} files, ${out.symbols.length} symbols`);
}

// --- main --------------------------------------------------------------------------------------

if (import.meta.main) {
  const [command, arg, flag] = process.argv.slice(2);
  if (command === "index" && arg) index(arg);
  else if (command === "denominators" && arg) await denominators(arg);
  else if (command === "measure" && arg) await measure(arg, flag === "--broken");
  else if (command === "rustc" && arg) await rustc(arg);
  else if (command === "fixtures") fixtures();
  else {
    console.error("usage: node bench/resolution.ts index|denominators|measure|rustc <material.json> [--broken] | fixtures");
    process.exit(2);
  }
}
