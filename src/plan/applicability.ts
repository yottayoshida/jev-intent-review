// Whether a question about a failed call can be put to a place at all, decided from definitions.
//
// The first version of this read the call's own line and looked for `?`, `.map_err`, `.is_ok()`
// and the like. It let through `exists()` in
//
//     if p.exists() || p.symlink_metadata().is_ok() {
//
// because the `.is_ok()` belongs to the call beside it, and it let through `Option::unwrap_or`,
// which is not a `Result` at all. Syntax on one line does not say what a call returns.
//
// So this resolves the name instead: the callee's definition is looked up in the repository at the
// pinned commit, and its signature is what decides. A name that resolves to nothing — every method
// from the standard library, `exists()` among them — or to more than one definition is **held**,
// not judged. That is narrow on purpose: the first version of this check is for calls whose
// definitions are in the repository being read.

import { defines, definedName } from "../change/blocks.ts";
import { isTestPath, type Discoverer } from "../discovery/discover.ts";
import { isRustFunction, type CallCandidate, type FunctionCandidate } from "./candidates.ts";
import { codeOnly, quoted, returnTypesFor, topLevel } from "./result-type.ts";

export type Applicability =
  | { ok: true; calleeDefinedAt: string }
  | {
      ok: false;
      /**
       * `*_not_result`: the return type was read to its end and is not a `Result`.
       * `*_return_unknown`: it could not be settled — the reason says what could not be read.
       */
      kind: "target_not_result" | "target_return_unknown" | "callee_unresolved" | "callee_ambiguous" | "callee_not_result" | "callee_return_unknown";
      reason: string;
    };

export interface Definition {
  path: string;
  line: number;
  text: string;
}

/**
 * The definitions of a bare name outside tests, at this commit, and whether the search that found
 * them was cut: past the search's cap a name may have definitions this did not see.
 */
export async function definitionsOfName(discoverer: Discoverer, name: string): Promise<{ found: Definition[]; more: boolean }> {
  const { hits, more } = await discoverer.search(name);
  const found: Definition[] = [];
  for (const hit of hits) {
    if (!defines(hit.text, name) || isTestPath(hit.path)) continue;
    if (definedName(hit.text) !== name) continue;
    const index = await discoverer.index(hit.path);
    const inTest = (index?.testRegions ?? []).some((r) => hit.line >= r.start && hit.line <= r.end);
    if (!inTest) found.push({ path: hit.path, line: hit.line, text: hit.text });
  }
  return { found, more };
}

/** The definitions of a bare name outside tests, at this commit, as far as the search reached. */
export async function definitionsOf(discoverer: Discoverer, name: string): Promise<Definition[]> {
  return (await definitionsOfName(discoverer, name)).found;
}

/**
 * A callee's definitions: a Rust `fn <name>(` or `fn <name><` line outside tests and outside
 * comments, and nothing else — not a JavaScript `function`, not a `let` line, not a snippet in a
 * Markdown file, which the language-blind `definitionsOfName` counts. The search is for
 * `fn <name>`, so a name as common as `get` is not cut at the search's cap before its definitions
 * are reached; when it still is, `more` says so and nothing is settled from what was seen.
 *
 * `definedName` is not asked: it declines names that read as keywords elsewhere (`new` among
 * them), and pybun's 36 `fn new` then read as no definition at all.
 */
export async function functionDefinitionsOf(discoverer: Discoverer, name: string): Promise<{ found: Definition[]; more: boolean }> {
  const { hits, more } = await discoverer.search(`fn ${name}`);
  const reader = returnTypesFor(discoverer);
  const found: Definition[] = [];
  for (const hit of hits) {
    if (!hit.path.endsWith(".rs") || isTestPath(hit.path)) continue;
    // Not `// the same check as fn parse_header()` at the end of a line, not `"fn emit() {}"`,
    // and not a line inside a string or a comment that started lines above: the file is read as
    // code whole.
    const code = await reader.codeLine(hit.path, hit.line);
    if (code === null || !isRustFunction(code, name)) continue;
    const index = await discoverer.index(hit.path);
    const inTest = (index?.testRegions ?? []).some((r) => hit.line >= r.start && hit.line <= r.end);
    if (!inTest) found.push({ path: hit.path, line: hit.line, text: hit.text });
  }
  return { found, more };
}

/**
 * Whether the call is written as a method call (`x.name(…)`), or undefined when its line does not
 * show. A path (`a::name(…)`) is not one.
 */
function isMethodCall(call: CallCandidate): boolean | undefined {
  if (call.callee.includes("::")) return false;
  const text = codeOnly(call.text);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Every place on the line the call could be — at a word's start, not inside `try_parse(a)` —
  // and the answer only when they all agree: the line does not say which one this call is.
  const places = (pattern: string) => [...text.matchAll(new RegExp(`(?<![\\w$])${pattern}`, "g"))].map((m) => m.index);
  let at = places(escape(call.expression.slice(0, 40)));
  if (at.length === 0) at = places(`${escape(call.callee)}\\s*\\(`);
  if (at.length === 0) return undefined;
  const methods = new Set(
    at.map((i) => {
      let before = i - 1;
      while (before >= 0 && /\s/.test(text[before]!)) before--;
      // `..` is a range or a struct update (`&buf[..len(buf)]`, `..defaults()`), not a method call.
      return text[before] === "." && text[before - 1] !== ".";
    }),
  );
  return methods.size === 1 ? [...methods][0] : undefined;
}

/**
 * How many arguments the call passes, or undefined when that cannot be counted without a parser:
 * a closure's `|a, b|`, a comparison's `<`, a turbofish and a character literal (`','`, `'('`) all
 * put a comma or a bracket where a count would misread it, so a call holding any of them is not
 * counted.
 */
function argumentCount(call: CallCandidate): number | undefined {
  if (!call.expressionComplete) return undefined;
  const code = codeOnly(call.expression);
  const open = code.indexOf("(");
  if (open < 0 || !code.endsWith(")")) return undefined;
  const inside = code.slice(open + 1, -1);
  if (/[|<>']/.test(inside)) return undefined;
  return topLevel(inside).length;
}

const TAKES_SELF = /^(?:&\s*(?:'\w+\s*)?)?(?:mut\s+)?self\b/;

/**
 * Why a call cannot reach the one definition of its name, or null when nothing says it cannot.
 *
 * Found by name, `state.inner.read().await` met `fn read(&self, key)` and `"".to_string()` met
 * `async fn to_string<T>(accessor, self_)`: the standard library's methods, taken for this
 * repository's functions. Two things a signature can rule out: a method call to a function that
 * takes no `self`, and a number of arguments the function does not take. Nothing here can show
 * that a call does reach a definition.
 */
function unreachable(call: CallCandidate, parameters: readonly string[]): string | null {
  const method = isMethodCall(call);
  if (method === undefined) return null;
  const takesSelf = parameters.length > 0 && TAKES_SELF.test(parameters[0]!);
  if (method && !takesSelf) return "is called as a method here and takes no `self`";
  const expected = parameters.length - (method ? 1 : 0);
  const passed = argumentCount(call);
  if (passed !== undefined && passed !== expected) return `takes ${expected} argument${expected === 1 ? "" : "s"} as this call is written, and this call passes ${passed}`;
  return null;
}

/**
 * Whether `call_failure_not_returned_as_success` can be asked here.
 *
 * Both halves come from a signature, never from how a line looks (`result-type.ts`):
 *
 *   - the target must return a `Result`, or "a success" and "an error" sort nothing it returns;
 *   - the callee must be defined once in this repository and return a `Result`, or there is no
 *     error to assume.
 *
 * "Does not return a Result" is said only of a return type read to its end. The callee is the one
 * `fn` of its name here, found by name, so the reason names the definition it read.
 */
export async function applicabilityOf(discoverer: Discoverer, fn: FunctionCandidate, call: CallCandidate): Promise<Applicability> {
  const reader = returnTypesFor(discoverer);
  const target = await reader.at(fn.path, fn.startLine, fn.name);
  if (target.kind === "not") {
    return { ok: false, kind: "target_not_result", reason: `${fn.name} returns \`${quoted(target.type)}\` and does not return a Result, so "a success" and "an error" do not sort what it returns` };
  }
  if (target.kind === "unknown") {
    return { ok: false, kind: "target_return_unknown", reason: `whether ${fn.name} returns a Result is not settled here: ${target.why}` };
  }
  const bare = call.callee.split("::").pop()!;
  const { found, more } = await functionDefinitionsOf(discoverer, bare);
  if (more) return { ok: false, kind: "callee_return_unknown", reason: `the search for \`fn ${bare}\` stopped at its cap, so not every definition of ${bare} was seen` };
  if (found.length === 0) return { ok: false, kind: "callee_unresolved", reason: `${bare} has no definition in this repository, so what it returns is not established here` };
  if (found.length > 1) return { ok: false, kind: "callee_ambiguous", reason: `${bare} is defined ${found.length} times here, so which one this call reaches is not resolved` };
  const def = found[0]!;
  const at = `${def.path}:${def.line}`;
  const signature = await reader.signature(def.path, def.line, bare);
  if (signature.ok) {
    const why = unreachable(call, signature.parameters);
    if (why) return { ok: false, kind: "callee_unresolved", reason: `the one function named ${bare} in this repository (${at}) ${why}, so this call does not reach it and what it returns is not established here` };
  }
  const callee = await reader.readingOf(signature, def.path);
  if (callee.kind === "not") {
    return { ok: false, kind: "callee_not_result", reason: `the one function named ${bare} in this repository (${at}) returns \`${quoted(callee.type)}\` and does not return a Result, so it has no error to assume` };
  }
  if (callee.kind === "unknown") {
    return { ok: false, kind: "callee_return_unknown", reason: `whether the one function named ${bare} in this repository (${at}) returns a Result is not settled here: ${callee.why}` };
  }
  return { ok: true, calleeDefinedAt: at };
}
