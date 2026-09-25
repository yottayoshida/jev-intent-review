// Pairs the listing's candidates with the oracle's calls in one file and classifies both
// (docs/call-oracle.md, *The classes*). No I/O: the fixtures test and the measurement share it.

import { enumerate, type Candidates } from "../../src/plan/candidates.ts";

export type Range = [number, number, number, number];

export interface OracleCall {
  fn: { name: string; line: number };
  line: number;
  column: number;
  callee: string;
  last: string;
  kind: "path" | "method" | "other";
  turbofish: "none" | "inner" | "last";
  multiline: boolean;
  capitalized: boolean;
}

export interface OracleFile {
  path: string;
  parsed: boolean;
  lines: number;
  error?: string;
  fns?: { name: string; line: number; body: Range }[];
  calls?: OracleCall[];
  ranges?: Record<"body" | "macro" | "pattern" | "type" | "attribute" | "string" | "comment" | "test_only", Range[]>;
  /** Every `mod name;` declared here, whose body is another file; `test` when under a test-only `cfg`. */
  mods?: { name: string; path: string | null; test: boolean }[];
}

/** `a/b/../c/./d.rs` → `a/c/d.rs`. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

/**
 * The files that are test-only because a file declares them `#[cfg(test)] mod name;`, every file
 * under such a module's directory, and every module a test-only file declares in turn, with or
 * without a `cfg` of its own. Rust's rule for where a module lives: a crate root, a `mod.rs` or a
 * file loaded through `#[path]` keeps its children beside it; `a.rs` keeps them under `a/`; and
 * `#[path = "…"]` names the file relative to the declaring file's directory.
 *
 * ponytail: a crate root is recognised by name (`lib.rs`, `main.rs`, `build.rs`, a file under
 * `bin/`), not from `Cargo.toml`, and a `#[path]` on a module declared inside an inline `mod { }` is
 * read from the file's directory as if it were not; a `[lib] path = …` elsewhere, or the nested
 * form, would resolve to the wrong file and leave its test modules in scope. Reading the manifest
 * and the module nesting is the fix if one appears.
 */
export function testOnlyFiles(files: readonly Pick<OracleFile, "path" | "mods">[]): Set<string> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
  const pathLoaded = new Set(files.flatMap((f) => (f.mods ?? []).filter((m) => m.path).map((m) => normalize(`${dirOf(f.path)}${m.path}`))));
  const resolve = (f: Pick<OracleFile, "path">, m: { name: string; path: string | null }): { files: string[]; under?: string } => {
    const dir = dirOf(f.path);
    if (m.path) return { files: [normalize(`${dir}${m.path}`)] };
    const base = f.path.slice(dir.length);
    const beside = ["lib.rs", "main.rs", "mod.rs", "build.rs"].includes(base) || dir.endsWith("bin/") || pathLoaded.has(f.path);
    const children = beside ? dir : `${dir}${base.replace(/\.rs$/, "")}/`;
    return { files: [`${children}${m.name}.rs`, `${children}${m.name}/mod.rs`], under: `${children}${m.name}/` };
  };

  const out = new Set<string>();
  const under: string[] = [];
  const pending: string[] = [];
  const mark = (r: { files: string[]; under?: string }) => {
    if (r.under) under.push(r.under);
    for (const p of r.files) if (byPath.has(p) && !out.has(p)) (out.add(p), pending.push(p));
  };
  for (const f of files) for (const m of f.mods ?? []) if (m.test) mark(resolve(f, m));
  for (;;) {
    for (const p of byPath.keys()) if (!out.has(p) && under.some((u) => p.startsWith(u))) (out.add(p), pending.push(p));
    const next = pending.shift();
    if (next === undefined) break;
    // A test-only file's own modules are test-only, whatever their attributes say.
    const f = byPath.get(next)!;
    for (const m of f.mods ?? []) mark(resolve(f, m));
  }
  return out;
}

export type CallClass = "detected" | "wrong_function" | "omitted_cap" | "omitted_unread" | "declared_exclusion" | "silent_miss";
export type CandidateClass = "matched" | "in_macro" | "false_positive";
export type Reason = "comment" | "string" | "test_only" | "attribute" | "type" | "pattern" | "definition" | "keyword" | "outside_fn" | "duplicate" | "other";

/**
 * Rust's keywords, which the listing's pattern takes for a callee when a `(` follows after a space:
 * `let (a, b) = …`, `for x in (0..n)`. Its refusal list holds some of them only.
 */
const KEYWORDS = new Set("as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn".split(" "));

export interface CallRow extends OracleCall {
  class: CallClass;
  macroNameCollision?: true;
  /** Neither run of the listing has a function starting on the line this call's function does. */
  fnNotListed?: true;
}

export interface CandidateRow {
  fn: { name: string; line: number };
  line: number;
  /** In characters, at the start of the last name — the oracle's position. */
  column: number;
  callee: string;
  class: CandidateClass;
  reason?: Reason;
}

export interface FileResult {
  path: string;
  calls: CallRow[];
  candidates: CandidateRow[];
  /** Pairs made at step 2: same function, line and name, a different column. */
  columnDisagreements: number;
}

/** `NOT_A_CALL` in src/plan/candidates.ts, split by why each name is there. */
export const DECLARED = new Set(["Ok", "Err", "Some"]);
export const MACRO_NAMES = new Set(["assert", "assert_eq", "println", "format", "vec", "panic", "write", "writeln"]);

const inside = (r: Range, line: number, col: number) =>
  (line > r[0] || (line === r[0] && col >= r[1])) && (line < r[2] || (line === r[2] && col < r[3]));

/** A UTF-16 column on a line as a column in characters, which is how the oracle counts. */
function charColumn(lineText: string, utf16: number): number {
  return [...lineText.slice(0, utf16)].length;
}

/**
 * Whether a candidate is a method call by the text before its name: `.foo(` and `.r#type(`, not
 * the `..` of `..Default::default()`. Used only to break the listing on purpose, to check that the
 * pairing moves (docs/call-oracle.md, *Checking the oracle*).
 */
export function isMethodCandidate(lines: readonly string[], c: { line: number; column: number }): boolean {
  return /(^|[^.])\.(r#)?$/.test((lines[c.line - 1] ?? "").slice(0, c.column));
}

export interface Listings {
  /** As the product runs it. */
  capped: Candidates;
  /** With no cap on functions, to know which the cap cut. */
  uncapped: Candidates;
}

export function listings(path: string, source: string): Listings {
  const uncapped = enumerate(path, source, { maxFunctions: Number.POSITIVE_INFINITY });
  // docs/call-oracle.md: the per-function cap of 1,000 calls has never fired; a file that reaches it
  // stops the measurement rather than be classified as if it had not.
  if (uncapped.omitted.calls > 0) throw new Error(`${path}: the listing's cap of calls per function fired; classify it before measuring`);
  return { capped: enumerate(path, source), uncapped };
}

export function classify(parsed: OracleFile, source: string, { capped, uncapped }: Listings, options: { testOnlyFile?: boolean } = {}): FileResult {
  if (!parsed.parsed || !parsed.calls || !parsed.ranges) throw new Error(`${parsed.path}: classify only files the oracle parsed`);
  // A file a parent declares `#[cfg(test)] mod …;`: nothing in it is in scope.
  const oracle: OracleFile = options.testOnlyFile ? { ...parsed, calls: [], ranges: { ...parsed.ranges!, test_only: [[1, 0, parsed.lines + 1, 0]] } } : parsed;
  const lines = source.split("\n");
  const fnLine = new Map(capped.functions.map((f) => [f.id, { name: f.name, line: f.startLine }]));

  const cands = capped.calls.map((c) => {
    const last = c.callee.split("::").pop()!;
    const text = lines[c.line - 1] ?? "";
    return { fn: fnLine.get(c.functionId)!, line: c.line, column: charColumn(text, c.column + c.callee.length - last.length), callee: c.callee, last };
  });
  const calls = oracle.calls!;

  const callPair: (number | null)[] = calls.map(() => null);
  const candPair: (number | null)[] = cands.map(() => null);
  const stepOf: number[] = calls.map(() => 0);

  const keys: ((x: { fn: { line: number }; line: number; last: string; column: number }) => string)[] = [
    (x) => `${x.fn.line}|${x.line}|${x.last}|${x.column}`,
    (x) => `${x.fn.line}|${x.line}|${x.last}`,
    (x) => `${x.line}|${x.last}`,
  ];
  keys.forEach((key, step) => {
    const open = new Map<string, number[]>();
    calls.forEach((c, i) => {
      if (callPair[i] !== null) return;
      const k = key(c);
      open.set(k, [...(open.get(k) ?? []), i]);
    });
    cands.forEach((c, j) => {
      if (candPair[j] !== null) return;
      const i = open.get(key(c))?.shift();
      if (i === undefined) return;
      callPair[i] = j;
      candPair[j] = i;
      stepOf[i] = step + 1;
    });
  });

  const cappedFns = new Set(capped.functions.map((f) => f.startLine));
  const allFns = new Set(uncapped.functions.map((f) => f.startLine));
  const callRows: CallRow[] = calls.map((c, i) => {
    let cls: CallClass;
    if (callPair[i] !== null) cls = stepOf[i] === 3 ? "wrong_function" : "detected";
    else if (DECLARED.has(c.last)) cls = "declared_exclusion";
    // In lines the listing says its parser could not read (#83): left out, and said so.
    else if ((capped.unread ?? []).some((u) => c.line >= u.startLine && c.line <= u.endLine)) cls = "omitted_unread";
    else if (capped.omitted.functions > 0 && allFns.has(c.fn.line) && !cappedFns.has(c.fn.line)) cls = "omitted_cap";
    else cls = "silent_miss";
    const row: CallRow = { ...c, class: cls };
    if (cls === "silent_miss" && MACRO_NAMES.has(c.last)) row.macroNameCollision = true;
    if (cls === "silent_miss" && !allFns.has(c.fn.line)) row.fnNotListed = true;
    return row;
  });

  const r = oracle.ranges!;
  const any = (rs: Range[], line: number, col: number) => rs.some((x) => inside(x, line, col));
  // A function's own name on its definition line: `fn inner() {` read as a call to `inner`.
  const definitions = new Set((oracle.fns ?? []).map((f) => `${f.line}|${f.name}`));
  const pairedAt = new Set(calls.filter((_, i) => callPair[i] !== null).map((c) => `${c.line}|${c.last}`));
  const candRows: CandidateRow[] = cands.map((c, j) => {
    const base = { fn: c.fn, line: c.line, column: c.column, callee: c.callee };
    if (candPair[j] !== null) return { ...base, class: "matched" };
    const at = (rs: Range[]) => any(rs, c.line, c.column);
    if (at(r.comment)) return { ...base, class: "false_positive", reason: "comment" };
    if (at(r.string)) return { ...base, class: "false_positive", reason: "string" };
    if (at(r.macro)) return { ...base, class: "in_macro" };
    const reason: Reason = at(r.test_only)
      ? "test_only"
      : at(r.attribute)
        ? "attribute"
        : // A type can sit inside a pattern (`let g: &dyn Fn(u8) = …`); the reverse cannot happen.
          at(r.type)
          ? "type"
          : at(r.pattern)
            ? "pattern"
            : definitions.has(`${c.line}|${c.last}`)
              ? "definition"
              : KEYWORDS.has(c.callee)
                ? "keyword"
                : !at(r.body)
              ? "outside_fn"
              : pairedAt.has(`${c.line}|${c.last}`)
                ? "duplicate"
                : "other";
    return { ...base, class: "false_positive", reason };
  });

  const columnDisagreements = calls.filter((_, i) => stepOf[i] === 2).length;
  return { path: oracle.path, calls: callRows, candidates: candRows, columnDisagreements };
}

export interface Totals {
  files: number;
  lines: number;
  unparsed: { files: number; lines: number; candidates: number };
  calls: Record<CallClass, number> & { total: number; macroNameCollision: number; fnNotListed: number };
  candidates: Record<CandidateClass, number> & { total: number; byReason: Partial<Record<Reason, number>> };
  columnDisagreements: number;
  /** silent_miss / calls in scope. */
  silentMissRate: number;
  /** false_positive / candidates outside macros. */
  falsePositiveRate: number;
}

export function emptyTotals(): Totals {
  return {
    files: 0,
    lines: 0,
    unparsed: { files: 0, lines: 0, candidates: 0 },
    calls: { total: 0, detected: 0, wrong_function: 0, omitted_cap: 0, omitted_unread: 0, declared_exclusion: 0, silent_miss: 0, macroNameCollision: 0, fnNotListed: 0 },
    candidates: { total: 0, matched: 0, in_macro: 0, false_positive: 0, byReason: {} },
    columnDisagreements: 0,
    silentMissRate: 0,
    falsePositiveRate: 0,
  };
}

export function add(t: Totals, f: FileResult, lines: number): void {
  t.files += 1;
  t.lines += lines;
  for (const c of f.calls) {
    t.calls.total += 1;
    t.calls[c.class] += 1;
    if (c.macroNameCollision) t.calls.macroNameCollision += 1;
    if (c.fnNotListed) t.calls.fnNotListed += 1;
  }
  for (const c of f.candidates) {
    t.candidates.total += 1;
    t.candidates[c.class] += 1;
    if (c.reason) t.candidates.byReason[c.reason] = (t.candidates.byReason[c.reason] ?? 0) + 1;
  }
  t.columnDisagreements += f.columnDisagreements;
  t.silentMissRate = t.calls.total === 0 ? 0 : t.calls.silent_miss / t.calls.total;
  const outsideMacros = t.candidates.total - t.candidates.in_macro;
  t.falsePositiveRate = outsideMacros === 0 ? 0 : t.candidates.false_positive / outsideMacros;
}

/** `path` + `turbofish=last` + `multiline`: the syntax form a call's row is counted under. */
export function formOf(c: OracleCall): string {
  return [c.kind, c.turbofish === "none" ? "" : `turbofish=${c.turbofish}`, c.multiline ? "multiline" : "", c.capitalized ? "capitalized" : ""].filter(Boolean).join(" ");
}
