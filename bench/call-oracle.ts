// The call oracle's measurement (#81, docs/call-oracle.md). Sends nothing to Jev.
//
//   cargo build --release --manifest-path bench/call-oracle/Cargo.toml
//   node bench/call-oracle.ts fixtures                    rewrites test/fixtures/call-oracle/{oracle,baseline}.json
//   node bench/call-oracle.ts measure <material.json>     writes bench/logs/call-oracle-<material name>.json
//   node bench/call-oracle.ts measure <material.json> --broken
//                                                         the same with the listing's method calls taken out,
//                                                         to check the pairing moves; writes
//                                                         bench/logs/call-oracle-<material name>-broken.json
//   node bench/call-oracle.ts sample <rows.json> <seed>   the sample the annotators are shown
//
// Clones are kept under ~/.cctmp/call-oracle-clones, which the session start sweeps after 7 days.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { loadConfig } from "../src/config/config.ts";
import { pathFilter } from "../src/config/glob.ts";
import { Discoverer, isTestPath } from "../src/discovery/discover.ts";
import { declaredForTestsOnly } from "../src/plan/applicability.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { readListing } from "../src/plan/from-diff.ts";
import { isSensitivePath } from "../src/evidence/redact.ts";
import { Git } from "../src/repository/git.ts";
import { estimateOver } from "./eval/metrics.ts";
import { add, classify, emptyTotals, formOf, isMethodCandidate, listings, testOnlyFiles, type FileResult, type Listings, type OracleFile, type Totals } from "./call-oracle/classify.ts";

const HERE = resolve(import.meta.dirname, "..");
const CRATE = join(HERE, "bench/call-oracle");
const BIN = join(CRATE, "target/release/call-oracle");
const FIXTURES = join(HERE, "test/fixtures/call-oracle");
const CLONES = join(homedir(), ".cctmp/call-oracle-clones");

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The oracle's own sources, so output written by another version of it is noticed. */
export function oracleSources(): Record<string, string> {
  return Object.fromEntries(["src/main.rs", "Cargo.toml", "Cargo.lock"].map((f) => [f, sha256(readFileSync(join(CRATE, f)))]));
}

function runOracle(root: string, paths: string[]): OracleFile[] {
  if (!existsSync(BIN)) throw new Error(`build the oracle first: cargo build --release --manifest-path ${CRATE}/Cargo.toml`);
  const out = spawnSync(BIN, [root], { input: paths.join("\n"), maxBuffer: 1 << 30, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`call-oracle failed: ${out.stderr}`);
  const files = JSON.parse(out.stdout) as OracleFile[];
  if (files.length !== paths.length) throw new Error(`call-oracle answered ${files.length} files of ${paths.length}`);
  return files;
}

/**
 * The product's listing of a file and the same file with no cap on functions, which `omitted_cap`
 * needs. A file the product declares test-only lists nothing either way.
 */
async function productListings(discoverer: Discoverer, path: string): Promise<Listings> {
  const capped = await readListing(discoverer, path);
  const index = await discoverer.index(path);
  if (!capped || !index) throw new Error(`${path}: the product cannot read this file`);
  const uncapped = (await declaredForTestsOnly(discoverer, path, { forListing: true })) ? capped : enumerate(path, index.lines.join("\n"), { maxFunctions: Number.POSITIVE_INFINITY, ...(index.rust ? { parsed: index.rust } : {}) });
  // docs/call-oracle.md: a file that reaches the per-function cap stops the measurement.
  if (uncapped.omitted.calls > 0) throw new Error(`${path}: the listing's cap of calls per function fired; classify it before measuring`);
  return { capped, uncapped };
}

/** The listing with every method call taken out. */
function withoutMethods(source: string, l: Listings): Listings {
  const lines = source.split("\n");
  return { ...l, capped: { ...l.capped, calls: l.capped.calls.filter((c) => !isMethodCandidate(lines, c)) } };
}

// --- fixtures ----------------------------------------------------------------------------------

function fixtures(): void {
  const names = execFileSync("ls", [FIXTURES], { encoding: "utf8" })
    .split("\n")
    .filter((n) => n.endsWith(".rs"))
    .sort();
  const files = runOracle(FIXTURES, names);
  const oracle = {
    note: "Written by `node bench/call-oracle.ts fixtures`. test/call-oracle.test.ts checks the shas.",
    sources: oracleSources(),
    files: files.map((f) => ({ sha256: sha256(readFileSync(join(FIXTURES, f.path))), ...f })),
  };
  const baseline = files.map((f) => {
    const source = readFileSync(join(FIXTURES, f.path), "utf8");
    return classify(f, source, listings(f.path, source));
  });
  writeFileSync(join(FIXTURES, "oracle.json"), `${JSON.stringify(oracle, null, 1)}\n`);
  writeFileSync(join(FIXTURES, "baseline.json"), `${JSON.stringify(baseline, null, 1)}\n`);
  console.log(`${files.length} fixtures`);
}

// --- measure -----------------------------------------------------------------------------------

interface Material {
  name: string;
  status: string;
  cases: { case: string; repo: string; commit: string }[];
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
}

function checkout(repo: string, commit: string): string {
  const dir = join(CLONES, repo.replace(/^https:\/\/github\.com\//, "").replace("/", "-"));
  if (!existsSync(dir)) {
    mkdirSync(CLONES, { recursive: true });
    execFileSync("git", ["clone", "-q", "--no-checkout", repo, dir]);
  }
  try {
    execFileSync("git", ["-C", dir, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
  } catch {
    git(dir, "fetch", "-q", "origin", commit);
  }
  git(dir, "checkout", "-q", "--force", "--detach", commit);
  return dir;
}

const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

interface Tally {
  totals: Totals;
  byForm: Record<string, Record<string, number>>;
  /** Files a parent declares `#[cfg(test)] mod …;`, and the calls in them left out of scope. */
  testOnlyFiles: { files: number; calls: number };
}
const tally = (): Tally => ({ totals: emptyTotals(), byForm: {}, testOnlyFiles: { files: 0, calls: 0 } });

function record(t: Tally, f: FileResult, lines: number) {
  add(t.totals, f, lines);
  for (const c of f.calls) {
    const form = (t.byForm[formOf(c)] ??= {});
    form[c.class] = (form[c.class] ?? 0) + 1;
  }
}

async function measure(materialPath: string, broken: boolean): Promise<void> {
  const material = JSON.parse(readFileSync(materialPath, "utf8")) as Material;
  const seen = new Set<string>();
  const all = tally();
  const byCase: Record<string, Tally & { repo: string; commit: string; skippedDuplicates: number }> = {};
  const unparsed: { case: string; path: string; lines: number; candidates: number; error: string }[] = [];
  const notRead: { case: string; path: string; lines: number; calls: number }[] = [];
  const rows: { case: string; path: string; result: FileResult }[] = [];
  /** Per file: its blob, so a later run can tell the same file from a changed one, and its counts. */
  const perFile: { case: string; path: string; blob: string; lines: number; calls: Record<string, number>; candidates: Record<string, number> }[] = [];

  for (const k of material.cases) {
    const dir = checkout(k.repo, k.commit);
    const { config } = await loadConfig(new Git(dir), k.commit, k.commit);
    const include = pathFilter(config.repository.include, config.repository.ignore);
    // The listing as the product reads it (#83): through the Discoverer, a file declared test-only by
    // a parent listing nothing. The scope stays the oracle's own (docs/call-oracle.md).
    const discoverer = new Discoverer(new Git(dir), k.commit, { include });
    const entries = git(dir, "ls-tree", "-r", k.commit)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t") as [string, string];
        return { blob: meta.split(" ")[2]!, path };
      })
      .filter((e) => e.path.endsWith(".rs") && include(e.path) && !isSensitivePath(e.path) && !isTestPath(e.path));
    const fresh = entries.filter((e) => !seen.has(e.blob));
    for (const e of fresh) seen.add(e.blob);
    const t = (byCase[k.case] = { ...tally(), repo: k.repo, commit: k.commit, skippedDuplicates: entries.length - fresh.length });

    // Every file, not only those not measured yet: a test module's declaration may sit in a parent
    // already measured under another case.
    const everything = runOracle(dir, entries.map((e) => e.path));
    const testFiles = testOnlyFiles(everything);
    const blobOf = new Map(fresh.map((e) => [e.path, e.blob]));
    const files = everything.filter((o) => blobOf.has(o.path));
    for (const o of files) {
      const source = readFileSync(join(dir, o.path), "utf8");
      // A file the product does not read at all — too large, or binary (`Git.readText`) — is taken
      // out on both sides and counted, as a file the oracle cannot parse is (docs/call-oracle.md).
      if ((await discoverer.index(o.path)) === null) {
        notRead.push({ case: k.case, path: o.path, lines: o.lines, calls: o.calls?.length ?? 0 });
        continue;
      }
      let l = await productListings(discoverer, o.path);
      if (broken) l = withoutMethods(source, l);
      if (!o.parsed) {
        unparsed.push({ case: k.case, path: o.path, lines: o.lines, candidates: l.capped.calls.length, error: o.error ?? "" });
        for (const x of [all.totals, t.totals]) {
          x.unparsed.files += 1;
          x.unparsed.lines += o.lines;
          x.unparsed.candidates += l.capped.calls.length;
        }
        continue;
      }
      const testOnlyFile = testFiles.has(o.path);
      if (testOnlyFile)
        for (const x of [all, t]) {
          x.testOnlyFiles.files += 1;
          x.testOnlyFiles.calls += o.calls!.length;
        }
      const result = classify(o, source, l, { testOnlyFile });
      record(all, result, o.lines);
      record(t, result, o.lines);
      rows.push({ case: k.case, path: o.path, result });
      perFile.push({
        case: k.case,
        path: o.path,
        blob: blobOf.get(o.path)!,
        lines: o.lines,
        calls: count(result.calls.map((c) => c.class)),
        candidates: count(result.candidates.map((c) => c.reason ?? c.class)),
      });
    }
    console.error(`${k.case}: ${fresh.length} files (${t.skippedDuplicates} already measured), ${t.totals.calls.total} calls, silent ${t.totals.calls.silent_miss}, fp ${t.totals.candidates.false_positive}`);
  }

  const base = join(HERE, "bench/logs", `call-oracle-${material.name}`);
  // The listing the record was made with: #83 compares against it unchanged.
  // Everything the listing is decided by since #83: the parser, its grammar, the file-level test rule.
  const listing = Object.fromEntries(["src/plan/candidates.ts", "src/change/blocks.ts", "src/syntax/rust.ts", "src/syntax/cfg.ts", "src/plan/from-diff.ts", "src/plan/applicability.ts", "vendor/tree-sitter-rust.wasm"].map((f) => [f, sha256(readFileSync(join(HERE, f)))]));
  if (broken) {
    // The pairing check (docs/call-oracle.md, *Is the oracle right?*): what moved, against the record.
    const record = JSON.parse(readFileSync(`${base}.json`, "utf8")) as { totals: Totals; byForm: Record<string, Record<string, number>> };
    const moved = Object.fromEntries(
      [...new Set([...Object.keys(record.byForm), ...Object.keys(all.byForm)])]
        .filter((f) => JSON.stringify(record.byForm[f]) !== JSON.stringify(all.byForm[f]))
        .map((f) => [f, { before: record.byForm[f], after: all.byForm[f] }]),
    );
    const out = { material: material.name, broken: "the listing's method calls taken out (isMethodCandidate)", oracle: oracleSources(), listing, detectedBefore: record.totals.calls.detected, detectedAfter: all.totals.calls.detected, silentBefore: record.totals.calls.silent_miss, silentAfter: all.totals.calls.silent_miss, formsThatMoved: moved };
    writeFileSync(`${base}-broken.json`, `${JSON.stringify(out, null, 1)}\n`);
    console.log(JSON.stringify(out, null, 1));
    return;
  }
  // bench/eval/PROTOCOL.md, *The interval and the gates*: calls of one repository are not independent,
  // so each rate is the mean over repositories of each repository's own rate, with its interval.
  const over = (hits: (t: Totals) => number, units: (t: Totals) => number) => estimateOver(Object.values(byCase).map((c) => ({ repo: c.repo.replace(/^https:\/\/github\.com\//, ""), hits: hits(c.totals), units: units(c.totals) })));
  const estimates = {
    detected: over((t) => t.calls.detected, (t) => t.calls.total),
    silentMiss: over((t) => t.calls.silent_miss, (t) => t.calls.total),
    falsePositive: over((t) => t.candidates.false_positive, (t) => t.candidates.total - t.candidates.in_macro),
  };
  const summary = { material: material.name, status: material.status, oracle: oracleSources(), listing, estimates, totals: all.totals, testOnlyFiles: all.testOnlyFiles, notReadByTheProduct: notRead, byForm: all.byForm, byCase, unparsed, perFile };
  writeFileSync(`${base}.json`, `${JSON.stringify(summary, null, 1)}\n`);
  // One line per call and per candidate. Tens of megabytes, so not committed: the commits are pinned
  // and the classification is deterministic, so the same command writes the same lines again.
  const rowsPath = join(homedir(), ".cctmp", `call-oracle-${material.name}.rows.jsonl`);
  const flat = rows.flatMap(({ case: c, path, result }) => [
    ...result.calls.map((r) => ({ case: c, path, side: "call", fn: `${r.fn.name}@${r.fn.line}`, line: r.line, column: r.column, name: r.callee || `<${r.kind}>`, form: formOf(r), class: r.class, ...(r.macroNameCollision ? { macroNameCollision: true } : {}), ...(r.fnNotListed ? { fnNotListed: true } : {}) })),
    ...result.candidates.map((r) => ({ case: c, path, side: "candidate", fn: `${r.fn.name}@${r.fn.line}`, line: r.line, column: r.column, name: r.callee, class: r.class, ...(r.reason ? { reason: r.reason } : {}) })),
  ]);
  writeFileSync(rowsPath, `${flat.map((r) => JSON.stringify(r)).join("\n")}\n`);
  console.log(JSON.stringify(all.totals, null, 1));
  console.log(`wrote ${basename(base)}.json and ${rowsPath}`);
}

// --- sample ------------------------------------------------------------------------------------

/** mulberry32: a seeded generator, so the sample can be drawn again. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(rowsPath: string, seed: number, material: string): void {
  const rows = readFileSync(rowsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const want: [string, string, number][] = [
    ["call", "detected", 20],
    ["call", "silent_miss", 20],
    ["candidate", "false_positive", 20],
    ["call", "wrong_function", 10],
    ["call", "declared_exclusion", 10],
  ];
  const cases = (JSON.parse(readFileSync(material, "utf8")) as Material).cases;
  const random = rng(seed);
  const picked = want.flatMap(([side, cls, n]) => {
    const pool = rows.filter((r) => r.side === side && r.class === cls);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, n);
  });
  const items = picked.map((r, i) => {
    const k = cases.find((c) => c.case === r.case)!;
    const dir = checkout(k.repo, k.commit);
    const lines = readFileSync(join(dir, r.path as string), "utf8").split("\n");
    const at = r.line as number;
    const numbered = (from: number, to: number) => lines.slice(Math.max(0, from - 1), to).map((t, j) => `${Math.max(1, from) + j}| ${t}`);
    // The function's header and the attributes above it, which say whether it is test-only.
    const fnLine = Number(String(r.fn).split("@").pop());
    const header = fnLine < at - 8 ? [...numbered(fnLine - 4, fnLine + 1), "   …"] : [];
    const context = [...header, ...numbered(at - 8, at + 3)];
    // What the annotator is shown: the position and the function the oracle or the listing names,
    // never the class.
    return { item: i + 1, path: r.path, function: r.fn, line: at, column: r.column, name: r.name, context: context.join("\n"), expected: r.side === "call" ? "yes" : "no", class: r.class, side: r.side };
  });
  console.log(JSON.stringify(items, null, 1));
}

// --- main --------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
if (command === "fixtures") fixtures();
else if (command === "measure") await measure(rest[0]!, rest.includes("--broken"));
else if (command === "sample") sample(rest[0]!, Number(rest[1] ?? 81), rest[2] ?? join(CRATE, "material.dev.json"));
else {
  console.error("usage: node bench/call-oracle.ts fixtures | measure <material.json> [--broken] | sample <rows.jsonl> [seed] [material.json]");
  process.exit(2);
}
