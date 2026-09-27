// How the product's name resolution compares with rust-analyzer's (#83, docs/resolution.md).
//
// Pure: the oracle's output (bench/resolution-oracle) and the product's answers in, classes out.
// The classes and their order are fixed in the plan before any measurement.

import { OUTSIDE_RESULTS } from "../../src/plan/outside-results.ts";
import { resolutionOf, type Applicability, type CalleeLocation } from "../../src/plan/applicability.ts";

export interface OracleOutput {
  tool: string;
  indexes: { file: string; prefix: string; documents: number }[];
  misaligned: number;
  files: Record<string, number>;
  symbols: [string, string][];
  defs: [number, string, number, number, number][];
  refs: Record<string, [number, number, number[]][]>;
}

export interface Def {
  path: string;
  /** The line of the definition's name. */
  line: number;
  /** The lines of the item it names. */
  start: number;
  end: number;
}

/** `rust-analyzer cargo std 1.98.1 fs/read().` → its package and descriptors. Names with spaces are backquoted, so only the first four spaces split. */
export function parseSymbol(symbol: string): { local: boolean; crate: string; descriptors: string } {
  if (symbol.startsWith("local ")) return { local: true, crate: "", descriptors: symbol };
  const parts: string[] = [];
  let rest = symbol;
  for (let i = 0; i < 4; i++) {
    const at = rest.indexOf(" ");
    if (at < 0) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  return { local: false, crate: parts[2] ?? "", descriptors: rest };
}

export type Shape = "local" | "callable" | "macro" | "other";

/** A method or function descriptor ends `name().` or, disambiguated, `name(+1).`. */
export function shapeOf(symbol: string): Shape {
  const { local, descriptors } = parseSymbol(symbol);
  if (local) return "local";
  if (descriptors.endsWith("!")) return "macro";
  if (/\([^()]*\)\.$/.test(descriptors)) return "callable";
  return "other";
}

/** The last name a descriptor chain gives: `impl#[\`Vec<T>\`]push().` → `push`. */
export function lastName(symbol: string): string {
  const d = parseSymbol(symbol).descriptors.replace(/\([^()]*\)\.$/, "");
  const m = /([A-Za-z_][A-Za-z0-9_]*|`[^`]*`)$/.exec(d);
  return (m?.[1] ?? "").replace(/^`|`$/g, "");
}

/**
 * A method declared in a trait, with or without a default body: rust-analyzer writes it
 * `Trait#method().`, and a method of an `impl` block `impl#[Type]method().` or
 * `impl#[Type][Trait]method().`. Read from the symbol alone: the kind the index gives a method
 * with a default body is `Method`, not `TraitMethod` (test/fixtures/resolution, `Store::get`).
 */
export function isTraitDeclaration(symbol: string): boolean {
  const d = parseSymbol(symbol).descriptors;
  return !d.includes("impl#") && /#[^#/]*\([^()]*\)\.$/.test(d);
}

/** Append to a map of lists without copying the list. */
export function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export class Oracle {
  readonly #symbols: [string, string][];
  readonly #defs = new Map<number, Def[]>();
  readonly #refs = new Map<string, Map<string, number[]>>();
  readonly #refsTo = new Map<number, { path: string; line: number }[]>();
  readonly files: ReadonlySet<string>;
  /**
   * The crates the repository defines: those some symbol with a definition here belongs to. A symbol
   * of one of them with no definition occurrence is generated — a `#[derive]`, a macro's output —
   * and is not outside the repository.
   */
  readonly repoCrates: ReadonlySet<string>;
  /** Callable definitions per file, for the innermost one around a line. */
  readonly #callableDefs = new Map<string, { id: number; def: Def }[]>();

  constructor(out: OracleOutput) {
    this.#symbols = out.symbols;
    this.files = new Set(Object.keys(out.files));
    this.repoCrates = new Set(out.defs.map(([id]) => parseSymbol(out.symbols[id]![0]).crate).filter((c) => c !== ""));
    for (const [id, path, line, start, end] of out.defs) {
      const def = { path, line, start, end };
      push(this.#defs, id, def);
      if (shapeOf(out.symbols[id]![0]) === "callable") push(this.#callableDefs, path, { id, def });
    }
    for (const [path, rows] of Object.entries(out.refs)) {
      const at = new Map<string, number[]>();
      for (const [line, column, ids] of rows) {
        at.set(`${line}:${column}`, ids);
        for (const id of ids) push(this.#refsTo, id, { path, line });
      }
      this.#refs.set(path, at);
    }
  }

  symbol(id: number): { text: string; kind: string } {
    const [text, kind] = this.#symbols[id]!;
    return { text, kind };
  }

  /** The symbols used at a name's position, or undefined when the index has nothing there. */
  at(path: string, line: number, column: number): number[] | undefined {
    return this.#refs.get(path)?.get(`${line}:${column}`);
  }

  defsOf(id: number): Def[] {
    return this.#defs.get(id) ?? [];
  }

  /** The names used on lines `from` to `to` of a file. */
  refsIn(path: string, from: number, to: number): number[] {
    const out: number[] = [];
    for (const [key, ids] of this.#refs.get(path) ?? []) {
      const line = Number(key.slice(0, key.indexOf(":")));
      if (line >= from && line <= to) out.push(...ids);
    }
    return out;
  }

  refsTo(id: number): { path: string; line: number }[] {
    return this.#refsTo.get(id) ?? [];
  }

  /** The innermost callable definition whose item holds the line. */
  enclosing(path: string, line: number): { id: number; def: Def } | undefined {
    let best: { id: number; def: Def } | undefined;
    for (const c of this.#callableDefs.get(path) ?? []) {
      if (line < c.def.start || line > c.def.end) continue;
      if (!best || c.def.end - c.def.start < best.def.end - best.def.start) best = c;
    }
    return best;
  }
}

/** What rust-analyzer says a call reaches. */
export type OracleAnswer =
  | { kind: "unresolved" }
  | { kind: "not_fn" }
  | { kind: "ambiguous"; symbols: string[] }
  | { kind: "macro_rules"; symbol: string }
  | { kind: "dispatch"; symbol: string }
  | { kind: "repository"; symbol: string; defs: Def[] }
  | { kind: "generated"; symbol: string }
  | { kind: "outside"; symbol: string; crate: string; name: string };

export function oracleAnswer(oracle: Oracle, ids: number[] | undefined): OracleAnswer {
  if (!ids || ids.length === 0) return { kind: "unresolved" };
  const callable = ids.filter((id) => shapeOf(oracle.symbol(id).text) === "callable");
  if (callable.length > 1) return { kind: "ambiguous", symbols: callable.map((id) => oracle.symbol(id).text) };
  if (callable.length === 0) {
    const macro = ids.find((id) => shapeOf(oracle.symbol(id).text) === "macro");
    return macro === undefined ? { kind: "not_fn" } : { kind: "macro_rules", symbol: oracle.symbol(macro).text };
  }
  const id = callable[0]!;
  const { text } = oracle.symbol(id);
  if (isTraitDeclaration(text)) return { kind: "dispatch", symbol: text };
  const defs = oracle.defsOf(id);
  if (defs.length > 0) return { kind: "repository", symbol: text, defs };
  const crate = parseSymbol(text).crate;
  if (oracle.repoCrates.has(crate)) return { kind: "generated", symbol: text };
  return { kind: "outside", symbol: text, crate, name: lastName(text) };
}

export type CallClass =
  | "same"
  | "same_in_versions"
  | "wrong"
  | "voided"
  | "both_unresolved"
  | "oracle_unresolved"
  | "oracle_not_fn"
  | "oracle_ambiguous"
  | "dispatch"
  | "macro_rules"
  | "oracle_generated";

/** The crate a row of the table outside is defined in, from where its source says so: `std/src/fs.rs:…`, `serde_json-1.0.151/src/…`. */
export function rowCrate(row: string): string | undefined {
  const from = OUTSIDE_RESULTS.find((r) => r.path === row)?.from;
  return from?.split("/")[0]!.replace(/-\d[\w.-]*$/, "");
}

const sameDef = (d: Def, at: { path: string; line: number }) => d.path === at.path && at.line >= d.start && at.line <= d.line;

export interface Classified {
  class: CallClass;
  /** Where the product settled: `repository`, `versions`, `outside`, or `none`. */
  product: string;
  /** `ok`, or why the product held the call (`callee_unresolved`…), whatever `at` is. */
  reason: string;
  resolution: ReturnType<typeof resolutionOf>;
  oracle: OracleAnswer["kind"];
}

/**
 * The axis is `at`, not whether the product could ask: a callee settled to the right definition that
 * does not return a `Result` is `same`, and its reason is kept beside it (the plan's second review).
 */
export function classifyCall(product: { result: Applicability; at: CalleeLocation }, answer: OracleAnswer, indexed: (path: string) => boolean = () => true): Classified {
  const { result, at } = product;
  const base = { product: at?.kind ?? "none", reason: result.ok ? "ok" : result.kind, resolution: resolutionOf(result, at), oracle: answer.kind };
  const of = (c: CallClass): Classified => ({ class: c, ...base });
  switch (answer.kind) {
    case "unresolved":
      return of(at === null ? "both_unresolved" : "oracle_unresolved");
    case "not_fn":
      return of("oracle_not_fn");
    case "ambiguous":
      return of("oracle_ambiguous");
    case "dispatch":
      return of("dispatch");
    case "macro_rules":
      return of("macro_rules");
    case "generated": {
      // Generated code has no source: a definition the product settled in an indexed file is another
      // one. A pick in a file the index does not hold cannot be told apart, and stays generated.
      const places = at === null || at.kind === "outside" ? [] : at.kind === "versions" ? at.all : [at];
      return of(places.length > 0 && places.every((p) => indexed(p.path)) ? "wrong" : "oracle_generated");
    }
  }
  if (at === null) return of("voided");
  if (at.kind === "outside") {
    return of(answer.kind === "outside" && answer.crate === rowCrate(at.row) && answer.name === at.row.split("::").at(-1) ? "same" : "wrong");
  }
  if (answer.kind !== "repository") return of("wrong");
  if (at.kind === "repository") return of(answer.defs.some((d) => sameDef(d, at)) ? "same" : "wrong");
  return of(at.all.some((v) => answer.defs.some((d) => sameDef(d, v))) ? "same_in_versions" : "wrong");
}

/** Each settled answer moved to the next different definition among those sampled: `same` must move to `wrong` by exactly that count. */
export function brokenAt(ats: CalleeLocation[]): CalleeLocation[] {
  const places = ats.filter((a): a is Extract<CalleeLocation, { kind: "repository" }> => a?.kind === "repository");
  return ats.map((a) => {
    if (a?.kind !== "repository") return a;
    const other = places.find((p) => p.path !== a.path || Math.abs(p.line - a.line) > 5);
    return other ?? a;
  });
}
