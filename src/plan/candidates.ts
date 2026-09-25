// The functions and calls that exist at a pinned commit, each with an id.
//
// `#20` let the model write a function name and an operation as prose. It wrote
// a standard library function for a function that calls a wrapper of it, and named the callee
// rather than the function the requirement governs — and `#21` then measured what that plan does
// when it runs: the same answer on the shipped and the mutated branch, because it is looking
// somewhere the mutation does not reach.
//
// A name written from memory cannot be checked. An id can: it is either in the list built from the
// commit or it is not, and the check costs nothing and happens before a request.
//
// A Rust file is read by a parser (`src/syntax/rust.ts`, #83, ADR 0022), the same reading
// `BlockIndex` uses for a Rust file, so a candidate is a function by the rule the evidence builder
// uses and test code is out for the same reason it is out of `realDefinitions`. It used to be read
// line by line; #81's oracle measured what that dropped (`docs/call-oracle.md`).

import { redact } from "../evidence/redact.ts";
import { parseRust, type ParsedRust, type Span } from "../syntax/rust.ts";

export interface FunctionCandidate {
  /**
   * Unique across the repository, not just within the file: `src/config.rs:function-3`.
   *
   * A bare `function-1` was enough while a selection came from one file at a time. It is not once
   * the diff contributes candidates from every changed file — two files' `call-1` would dedup
   * against each other, and one file's pick would silently resolve against another's listing.
   */
  id: string;
  path: string;
  name: string;
  startLine: number;
  endLine: number;
  /**
   * The whole signature, up to the brace that opens the body, with runs of whitespace flattened.
   *
   * Not the definition line: Rust wraps signatures, and `fn create_staging_subdir(` on its own
   * line says nothing about the return type. Reading only the first line held every such function
   * as "does not return a Result" — which is a silent refusal to ask, and the kind that looks like
   * a considered decision in a report.
   */
  signature: string;
  /**
   * Set when the per-function cap left some of its calls out. What such a function calls is not
   * fully known, so nothing may be concluded from a call it does *not* seem to make.
   */
  callsCut?: true;
}

export interface CallCandidate {
  id: string;
  functionId: string;
  line: number;
  /** The source line, trimmed. What the model sees in the listing. */
  text: string;
  /** The name being called, as written. */
  callee: string;
  /**
   * Where the callee starts on its line, in UTF-16 code units from 0. Not in the listing a model
   * sees: the call oracle (#81, docs/call-oracle.md) pairs candidates with calls by it when a line
   * holds the same name twice.
   */
  column: number;
  /**
   * The call itself, from the callee through its closing parenthesis — `read_limited(&path, MAX)`.
   *
   * The callee alone is not enough to say which call is meant. Two calls to the same function in
   * one body are one propagating and one swallowing often enough that it is the interesting case,
   * and a condition built from the callee alone is the same sentence for both. The whole source
   * line is no good either: the mutation rewrites it (`#22`). The call expression is what survives
   * a change in how the result is handled and still tells two calls apart.
   */
  expression: string;
  /** False when the parentheses did not close within the scan; such a call cannot be re-bound. */
  expressionComplete: boolean;
}

export interface Candidates {
  path: string;
  functions: FunctionCandidate[];
  calls: CallCandidate[];
  /**
   * What was left out, so a listing is never silently short: the caps, the lines the parser could
   * not read (`unreadLines`, whose calls are not listed), and the macro invocations whose arguments
   * were not read (`macros`, ADR 0022).
   */
  omitted: { functions: number; calls: number; unreadLines: number; macros: number };
  /** Where the parser could not read. Nothing inside is listed. */
  unread: Span[];
}

const MAX_FUNCTIONS = 60;
/**
 * Calls read in one function, in line order, before the rest are counted and left out (#38).
 *
 * It was 40, which dropped calls before any budget ordered them: a measured unchanged caller calls
 * the changed function past its 40th call. The largest function measured with no cap had 495
 * (docs/local-check-cli.md, *The calls of a function, measured*); this is a guard against generated code, not a
 * limit a hand-written function is expected to reach. What it leaves out is still counted, and a
 * function it cut is still not taken for a sibling.
 */
const MAX_CALLS_PER_FUNCTION = 1000;

/** From the definition line through the brace that opens the body, bounded. */
function signatureAt(lines: readonly string[], startLine: number, endLine: number): string {
  const limit = Math.min(endLine, startLine + 8);
  const parts: string[] = [];
  for (let l = startLine; l <= limit; l++) {
    const text = (lines[l - 1] ?? "").trim();
    parts.push(text);
    if (text.endsWith("{")) break;
  }
  return parts.join(" ").replace(/\s+/g, " ").slice(0, 300);
}

export const isRustFunction = (line: string, name: string) => new RegExp(`\\bfn\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[(<]`).test(line);

/** Names the listing refuses on purpose: they construct a value rather than call out (`docs/call-oracle.md`, `declared_exclusion`). */
const NOT_A_CALL = new Set(["Ok", "Err", "Some"]);

/** How far a call's text is kept before it is cut, and then marked as not re-bindable. */
const EXPRESSION_CHARS = 300;

/**
 * The call from its callee through its closing parenthesis, with runs of whitespace flattened so a
 * call split over lines and the same call on one line read alike — the form `local-check.ts` and
 * `applicability.ts` search a line for. The parser always knows where a call ends, so only a call
 * longer than the cut is incomplete.
 */
function callExpression(source: string, start: number, end: number): { text: string; complete: boolean } {
  if (end - start > EXPRESSION_CHARS) return { text: source.slice(start, start + EXPRESSION_CHARS).replace(/\s+/g, " ").trim(), complete: false };
  return { text: source.slice(start, end).replace(/\s+/g, " ").trim(), complete: true };
}

/** A file with nothing to list: one compiled only for tests. */
export function emptyCandidates(path: string): Candidates {
  return { path, functions: [], calls: [], omitted: { functions: 0, calls: 0, unreadLines: 0, macros: 0 }, unread: [] };
}

/**
 * Every function defined outside code compiled only for tests, and the calls inside each.
 *
 * Both lists are capped, and what was left out is counted rather than dropped quietly — a model
 * choosing from a list that is short without saying so would be choosing from a different file.
 * `parsed` is the file's reading when the caller has one (`BlockIndex.rust`), so a file is parsed once.
 */
export function enumerate(path: string, source: string, options: { maxFunctions?: number; parsed?: ParsedRust } = {}): Candidates {
  // The call oracle (#81) runs the listing again without the cap, to know which functions it cut.
  const maxFunctions = options.maxFunctions ?? MAX_FUNCTIONS;
  const parsed = options.parsed ?? parseRust(source);
  const lines = source.split("\n");

  const functions: FunctionCandidate[] = [];
  /** The listed function each of the parser's functions is, by the parser's index. */
  const listed = new Map<number, FunctionCandidate>();
  let omittedFunctions = 0;
  parsed.functions.forEach((f, i) => {
    if (f.testOnly) return;
    if (functions.length >= maxFunctions) {
      omittedFunctions += 1;
      return;
    }
    const fn: FunctionCandidate = { id: `${path}:function-${functions.length + 1}`, path, name: f.name, startLine: f.startLine, endLine: f.endLine, signature: signatureAt(lines, f.startLine, f.endLine) };
    functions.push(fn);
    listed.set(i, fn);
  });

  const byFunction = new Map<FunctionCandidate, ParsedRust["calls"]>();
  for (const c of parsed.calls) {
    const fn = listed.get(c.fn);
    if (!fn) continue;
    const bare = c.callee.split("::").pop() ?? "";
    if (NOT_A_CALL.has(bare)) continue;
    const list = byFunction.get(fn) ?? [];
    list.push(c);
    byFunction.set(fn, list);
  }

  const calls: CallCandidate[] = [];
  let omittedCalls = 0;
  for (const fn of functions) {
    const own = (byFunction.get(fn) ?? []).sort((a, b) => a.line - b.line || a.column - b.column);
    let taken = 0;
    for (const c of own) {
      if (taken >= MAX_CALLS_PER_FUNCTION) {
        omittedCalls += 1;
        fn.callsCut = true;
        continue;
      }
      const expression = callExpression(source, c.exprStart, c.exprEnd);
      const text = (lines[c.line - 1] ?? "").trim();
      // `column` is where the callee starts as written (`a` of `a::b::foo`, `Vec` of `Vec::<u8>::new`).
      calls.push({ id: `${path}:call-${calls.length + 1}`, functionId: fn.id, line: c.line, text: text.slice(0, 200), callee: c.callee, column: c.startColumn, expression: expression.text, expressionComplete: expression.complete });
      taken += 1;
    }
  }

  const unreadLines = parsed.unread.reduce((n, u) => n + (u.endLine - u.startLine + 1), 0);
  return { path, functions, calls, omitted: { functions: omittedFunctions, calls: omittedCalls, unreadLines, macros: parsed.macrosNotRead }, unread: parsed.unread };
}

/**
 * The listing a model chooses from: ids and nothing it could not have seen in the file.
 *
 * Source text goes out over the network here, so it is redacted on the way, the same as the
 * evidence packets are. A listing is a few hundred trimmed lines of a file, which is exactly where
 * a key assigned to a constant would sit — and the planner has no use for the value either way.
 */
export function listingFor(c: Candidates): { functions: { id: string; name: string; lines: string; signature: string }[]; calls: { id: string; in: string; line: number; text: string }[]; omitted: Candidates["omitted"] } {
  const clean = (text: string) => redact(text).text;
  return {
    functions: c.functions.map((f) => ({ id: f.id, name: f.name, lines: `${f.startLine}-${f.endLine}`, signature: clean(f.signature) })),
    calls: c.calls.map((k) => ({ id: k.id, in: k.functionId, line: k.line, text: clean(k.text) })),
    omitted: c.omitted,
  };
}
