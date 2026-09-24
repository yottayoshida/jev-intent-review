// The functions and calls that exist at a pinned commit, each with an id.
//
// `#20` let the model write a function name and an operation as prose. It wrote
// `fs::read_to_string` for a function that calls `read_to_string_capped`, and named the callee
// rather than the function the requirement governs — and `#21` then measured what that plan does
// when it runs: the same answer on the shipped and the mutated branch, because it is looking
// somewhere the mutation does not reach.
//
// A name written from memory cannot be checked. An id can: it is either in the list built from the
// commit or it is not, and the check costs nothing and happens before a request.
//
// Enumeration uses the product's own reading of the file — `definedName`, `functionEnd`,
// `testRegions` — so a candidate is a function by the same rule the evidence builder uses, and
// test code is out for the same reason it is out of `realDefinitions`.

import { bodyOpens, definedName, functionEnd, testRegions } from "../change/blocks.ts";
import { redact } from "../evidence/redact.ts";

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
   * The call itself, from the callee through its closing parenthesis — `read_to_string_capped(&path, MAX)`.
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
  /** What the caps left out, so a listing is never silently short. */
  omitted: { functions: number; calls: number };
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

/**
 * `definedName` names anything a line defines, `let path = …` included — it is language-agnostic
 * and the evidence builder wants it that way. A candidate here has to be a function, so the name
 * it found must also appear after `fn`. That makes this enumeration Rust-only, which is what the
 * bench measures; a second language would need its own line, not a looser one here.
 */
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

/** `foo(` / `a::b::foo(` / `x.foo(` — the name immediately before an open parenthesis. */
const CALL = /(?<![\w$])((?:[A-Za-z_][\w$]*::)*[A-Za-z_][\w$]*)\s*\(/g;
// Control flow reads as a call and is not one. `Ok`/`Err`/`Some` construct rather than call out.
const NOT_A_CALL = new Set(["if", "while", "for", "match", "return", "fn", "Ok", "Err", "Some", "None", "assert", "assert_eq", "println", "format", "vec", "panic", "write", "writeln"]);

/** How far a call may run before this gives up on closing its parentheses. */
const EXPRESSION_CHARS = 300;

/**
 * The call from `at` through its matching close parenthesis, with runs of whitespace flattened so
 * a call split over lines and the same call on one line read alike.
 *
 * String literals are skipped rather than counted: `open("a(b")` closes where it looks like it
 * does. Comments are not — a `(` in a trailing comment inside a call's arguments would confuse
 * this, and `expressionComplete` is how that shows up rather than a wrong answer.
 */
function callExpression(source: string, at: number): { text: string; complete: boolean } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = at; i < Math.min(source.length, at + EXPRESSION_CHARS); i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(at, i + 1).replace(/\s+/g, " ").trim(), complete: true };
    }
  }
  return { text: source.slice(at, at + EXPRESSION_CHARS).replace(/\s+/g, " ").trim(), complete: false };
}

/**
 * Every function defined outside a test region, and the calls inside each.
 *
 * Both lists are capped, and what was left out is counted rather than dropped quietly — a model
 * choosing from a list that is short without saying so would be choosing from a different file.
 */
export function enumerate(path: string, source: string): Candidates {
  const lines = source.split("\n");
  const tests = testRegions(lines);
  const inTest = (line: number) => tests.some((r) => line >= r.start && line <= r.end);

  const functions: FunctionCandidate[] = [];
  /** The 1-based line each function's body opens on, by id. */
  const bodyLine = new Map<string, number>();
  let omittedFunctions = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const name = definedName(line);
    if (!name || !isRustFunction(line, name)) continue;
    const startLine = i + 1;
    if (inTest(startLine)) continue;
    if (functions.length >= MAX_FUNCTIONS) {
      omittedFunctions += 1;
      continue;
    }
    // `functionEnd` indexes `lines` from 0 and answers from 0; `BlockIndex.enclosing` counts lines
    // from 1. Passing one to the other returns the line after the signature as the whole function.
    const id = `${path}:function-${functions.length + 1}`;
    const opens = bodyOpens(lines, startLine - 1);
    const endLine = functionEnd(lines, startLine - 1) + 1;
    bodyLine.set(id, opens + 1);
    functions.push({ id, path, name, startLine, endLine, signature: signatureAt(lines, startLine, endLine) });
  }

  const calls: CallCandidate[] = [];
  let omittedCalls = 0;
  for (const fn of functions) {
    let taken = 0;
    // From the line after the one the body opens on: a Rust signature calls nothing — `pub(crate)`
    // reads as a call to `pub` if it is scanned, and so does a `where` clause's `Fn(…)`.
    for (let l = (bodyLine.get(fn.id) ?? fn.startLine) + 1; l <= fn.endLine; l++) {
      const text = lines[l - 1] ?? "";
      const trimmed = text.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("///")) continue;
      for (const m of text.matchAll(CALL)) {
        const callee = m[1]!;
        const bare = callee.split("::").pop()!;
        if (NOT_A_CALL.has(bare) || NOT_A_CALL.has(callee)) continue;
        if (taken >= MAX_CALLS_PER_FUNCTION) {
          omittedCalls += 1;
          fn.callsCut = true;
          continue;
        }
        // From this line to a few below, so a call split over lines still closes. `m.index` is an
        // offset into this line, which is where the window starts.
        const window = lines.slice(l - 1, Math.min(fn.endLine, l + 5)).join("\n");
        const expression = callExpression(window, m.index);
        calls.push({ id: `${path}:call-${calls.length + 1}`, functionId: fn.id, line: l, text: trimmed.slice(0, 200), callee, expression: expression.text, expressionComplete: expression.complete });
        taken += 1;
      }
    }
  }

  return { path, functions, calls, omitted: { functions: omittedFunctions, calls: omittedCalls } };
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
