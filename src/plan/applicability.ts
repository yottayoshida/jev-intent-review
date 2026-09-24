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
// from the standard library, `exists()` among them — is **held**, not judged. That is narrow on
// purpose: this check is for calls whose definitions are in the repository being read.
//
// A name defined more than once used to be held with it. Three things narrow it now: the path the
// call writes (`State::load`), the form of the call (a method call reaches nothing that
// takes no `self`), and definitions that are versions of one thing (a trait's method, a function
// written once per platform), where every version must return a `Result`. What none of them
// settles is still held — and "not narrowed" is never reported as "not defined here", because a
// type brought in under another name (`use … as ChannelError`) or a function re-exported from
// another file is not followed.

import { defines, definedName } from "../change/blocks.ts";
import { isTestPath, type Discoverer } from "../discovery/discover.ts";
import { isRustFunction, type CallCandidate, type FunctionCandidate } from "./candidates.ts";
import { namesTheStandardLibrary, outsideResult } from "./outside-results.ts";
import { codeOnly, itemHead, quoted, returnTypesFor, topLevel, type ItemHead, type ReturnTypes } from "./result-type.ts";

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
 * them), and a repository's `fn new` then read as no definition at all (36 of them in one).
 */
export async function functionDefinitionsOf(discoverer: Discoverer, name: string): Promise<{ found: Definition[]; more: boolean; testOnly: number }> {
  const { hits, more } = await discoverer.search(`fn ${name}`);
  const reader = returnTypesFor(discoverer);
  const found: Definition[] = [];
  let testOnly = 0;
  for (const hit of hits) {
    if (!hit.path.endsWith(".rs") || isTestPath(hit.path)) continue;
    // Not `// the same check as fn parse_header()` at the end of a line, not `"fn emit() {}"`,
    // and not a line inside a string or a comment that started lines above: the file is read as
    // code whole.
    const code = await reader.codeLine(hit.path, hit.line);
    if (code === null || !isRustFunction(code, name)) continue;
    const index = await discoverer.index(hit.path);
    const inTest = (index?.testRegions ?? []).some((r) => hit.line >= r.start && hit.line <= r.end);
    if (inTest) continue;
    if (await declaredForTestsOnly(discoverer, hit.path)) testOnly++;
    else found.push({ path: hit.path, line: hit.line, text: hit.text });
  }
  return { found, more, testOnly };
}

const testOnlyFiles = new WeakMap<Discoverer, Map<string, Promise<boolean>>>();

/**
 * Whether a file is compiled only for tests because a module file declares it
 * `#[cfg(test)] mod x;`.
 *
 * `isTestPath` reads names, and a file of tests whose name does not say so (a `…_tests.rs` beside
 * source) is source by its name: when the only `impl` of a type is inside it, a call to one of its
 * methods would resolve to a definition that no shipped code reaches, and the budget would be spent
 * asking about test code.
 */
export function declaredForTestsOnly(discoverer: Discoverer, path: string): Promise<boolean> {
  let answers = testOnlyFiles.get(discoverer);
  if (!answers) {
    answers = new Map();
    testOnlyFiles.set(discoverer, answers);
  }
  let answer = answers.get(path);
  if (!answer) {
    answer = readDeclaration(discoverer, path);
    answers.set(path, answer);
  }
  return answer;
}

async function readDeclaration(discoverer: Discoverer, path: string): Promise<boolean> {
  const parts = path.split("/");
  let name = parts[parts.length - 1]!.replace(/\.rs$/, "");
  let directory = parts.slice(0, -1);
  if (name === "mod") {
    name = directory[directory.length - 1] ?? "";
    directory = directory.slice(0, -1);
  }
  if (name === "") return false;
  const reader = returnTypesFor(discoverer);
  // Where Rust lets the declaration be: the directory's module file, the crate's root, or the file
  // named after the directory. One level up only — a module of a module of a test module is left.
  const parents = [[...directory, "mod.rs"].join("/"), [...directory, "lib.rs"].join("/"), [...directory, "main.rs"].join("/")];
  if (directory.length > 0) parents.push(`${directory.join("/")}.rs`);
  // At the file's top level: a `mod x;` indented inside an inline `mod tests { … }` declares
  // `tests/x.rs`, not this file.
  const declares = new RegExp(`^(?:#\\[[^\\]]*\\]\\s*)*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*;`);
  // Every declaration of this module that can be found: a crate whose `lib.rs` declares it and
  // whose `main.rs` declares it under `#[cfg(test)]` still compiles it into the library.
  let declared = 0;
  let forTests = 0;
  for (const parent of parents) {
    if (parent === path) continue;
    const lines = await reader.codeLinesOf(parent);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      if (!declares.test(lines[i]!)) continue;
      declared++;
      // The attributes of this declaration: the ones on its own line and the ones directly above
      // it. Not a window of lines — `#[cfg(test)]` / `mod a;` / `mod b;` says nothing about `b`.
      const attributes = [lines[i]!, ...(await reader.attributes(parent, i + 1))];
      if (attributes.some((attribute) => /#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(attribute))) forTests++;
    }
  }
  return declared > 0 && declared === forTests;
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
  // `fs::rename(a, b)` names a module, and a module holds no method: a `fn rename(&mut self, …)`
  // is reached by `x.rename(…)` or by its type's name, never by this. A capitalised segment is a
  // type, where `Type::method(&mut x, …)` is how a method is written in full.
  const qualifier = call.callee.split("::").at(-2);
  if (!method && takesSelf && qualifier !== undefined && /^[a-z_]/.test(qualifier)) {
    return `takes \`self\`, and \`${qualifier}\` names a module, which holds no method`;
  }
  const expected = parameters.length - (method ? 1 : 0);
  const passed = argumentCount(call);
  if (passed !== undefined && passed !== expected) return `takes ${expected} argument${expected === 1 ? "" : "s"} as this call is written, and this call passes ${passed}`;
  return null;
}

/** Past this many definitions left after the path, signatures are not read. */
const NARROW_CAP = 20;

/** Where a definition is written: the item that encloses it, the top of its file, or unread. */
type Where = ItemHead | { kind: "top" } | "unread";

async function whereWritten(reader: ReturnTypes, definition: Definition): Promise<Where> {
  const enclosing = await reader.enclosing(definition.path, definition.line);
  if (enclosing.kind === "unknown") return "unread";
  if (enclosing.kind === "top") return { kind: "top" };
  const head = itemHead(enclosing.text);
  // A header whose type has no name is a header this did not read: `impl<T>` alone on its line,
  // with `Trait for` and `Q` on the lines below it, names nothing yet.
  return head.kind === "impl" && head.self === undefined ? "unread" : head;
}

/**
 * Where a file's crate begins: everything up to its `src/`. A path with none — `examples/demo.rs`,
 * or a crate laid out without one — falls back to the file's own directory, never to the whole
 * repository, or a workspace's other crates come back in.
 */
function crateOf(path: string): string {
  const at = path.lastIndexOf("/src/");
  if (at >= 0) return path.slice(0, at + "/src/".length);
  if (path.startsWith("src/")) return "src/";
  const directory = path.lastIndexOf("/");
  return directory >= 0 ? path.slice(0, directory + 1) : "";
}

/** The type `Self` names where the call is written, or undefined when that cannot be read. */
async function selfType(reader: ReturnTypes, fn: FunctionCandidate): Promise<string | undefined> {
  const enclosing = await reader.enclosing(fn.path, fn.startLine);
  if (enclosing.kind !== "item") return undefined;
  const head = itemHead(enclosing.text);
  return head.kind === "impl" ? head.self : head.kind === "trait" ? head.name : undefined;
}

/**
 * The definitions written under the path the call names (`State::load`, `handlers::run`,
 * `Self::path`), or "unread" when the writing could not be read and nothing should be narrowed by it.
 *
 * An empty list is not "the callee is not defined here": a `Renamed::new` can be `impl Error` under a
 * `use … as Renamed`, and a `module::helper` can be written in another file of the module and
 * re-exported. Neither is followed, so the call is held, not judged.
 */
async function underQualifier(reader: ReturnTypes, fn: FunctionCandidate, qualifier: string, definitions: Definition[]): Promise<Definition[] | "unread"> {
  if (!/^[A-Z]/.test(qualifier)) {
    // A module's own file, or one of the files it re-exports: only the first is followed. Inside
    // the crate the call is written in — a workspace has a `util.rs` in every crate, and the one
    // in another crate is not what `util::parse()` names here.
    const crate = crateOf(fn.path);
    return definitions.filter((d) => {
      if (!d.path.startsWith(crate)) return false;
      const under = d.path.slice(crate.length);
      return under === `${qualifier}.rs` || under === `${qualifier}/mod.rs` || under.endsWith(`/${qualifier}.rs`) || under.endsWith(`/${qualifier}/mod.rs`);
    });
  }
  const wanted = qualifier === "Self" ? await selfType(reader, fn) : qualifier;
  if (wanted === undefined) return "unread";
  const kept: Definition[] = [];
  for (const definition of definitions) {
    const written = await whereWritten(reader, definition);
    if (written === "unread") return "unread";
    if (written.kind === "impl" ? written.self === wanted : written.kind === "trait" && written.name === wanted) kept.push(definition);
  }
  return kept;
}

/**
 * The definitions read together because they are versions of one thing, with the one to name
 * first: a trait's method (its declaration and the implementations of that trait) or a function
 * written once per platform (`#[cfg(unix)]` and `#[cfg(not(unix))]` at the top of one file).
 * Null when they are merely definitions that share a name.
 *
 * The trait's declaration must be in this repository. Without that, two `impl TryFrom<A> for B`
 * blocks would make `try_from` a trait method of this repository's, and every method a dependency
 * declares would follow.
 */
async function versionsOfOneThing(reader: ReturnTypes, definitions: Definition[]): Promise<Definition[] | null> {
  const written: Exclude<Where, "unread">[] = [];
  for (const definition of definitions) {
    const where = await whereWritten(reader, definition);
    if (where === "unread") return null;
    written.push(where);
  }
  const traits = new Set(written.map((w) => (w.kind === "trait" ? w.name : w.kind === "impl" ? w.trait : undefined)));
  // Declared once: two `trait Conn` in two files are two things that share a name, and an
  // implementation of either would answer for both.
  const declarations = written.filter((w) => w.kind === "trait").length;
  const declared = written.findIndex((w) => w.kind === "trait");
  if (traits.size === 1 && !traits.has(undefined) && declarations === 1) {
    return [definitions[declared]!, ...definitions.filter((_, i) => i !== declared)];
  }
  if (written.every((w) => w.kind === "top") && new Set(definitions.map((d) => d.path)).size === 1) {
    const cfg = await Promise.all(definitions.map(async (d) => (await reader.attributes(d.path, d.line)).some((a) => /#\[\s*cfg\s*\(/.test(a))));
    if (cfg.every(Boolean)) return definitions;
  }
  return null;
}

type Narrowed = { ok: true; definitions: Definition[]; sole: boolean } | { ok: false; held: Applicability };

/**
 * The definitions of `bare` this call reaches — one, or several read together — or why that is not
 * settled. A name defined more than once used to end here; three things narrow it: the path the
 * call writes, the form of the call, and definitions that are versions of one thing.
 */
async function narrow(discoverer: Discoverer, fn: FunctionCandidate, call: CallCandidate, bare: string, found: Definition[]): Promise<Narrowed> {
  if (found.length === 1) return { ok: true, definitions: found, sole: true };
  const reader = returnTypesFor(discoverer);
  const many = `${bare} is defined ${found.length} times here`;
  const unresolved = (reason: string): Narrowed => ({ ok: false, held: { ok: false, kind: "callee_ambiguous", reason } });
  let definitions = found;

  const segments = call.callee.split("::");
  const qualifier = segments.length > 1 ? segments[segments.length - 2]! : undefined;
  if (qualifier !== undefined && !["crate", "super", "self"].includes(qualifier)) {
    const under = await underQualifier(reader, fn, qualifier, definitions);
    // A path this could not apply settles nothing here — and nothing after it may settle the call
    // either, or the form would pick the very definition the path was going to rule out.
    if (under === "unread") return unresolved(`${many}, and one of them is under a header this did not read, so \`${qualifier}\` cannot be applied and which one this call reaches is not resolved`);
    if (under.length === 0) {
      return unresolved(`${many}, and none of them is written under \`${qualifier}\`; a name brought in under another name or re-exported from another file is not followed, so which one this call reaches is not resolved`);
    }
    definitions = under;
  }

  // The form is asked of a definition the path picked out too: `Foo::new(a, b)` reaches no
  // `fn new(a)`, and the one definition of a name is held for exactly that reason.
  if (definitions.length > NARROW_CAP) {
    const left = definitions.length === found.length ? `more than ${NARROW_CAP} of them` : `more than ${NARROW_CAP} of them left after the path this call writes`;
    return unresolved(`${many}, ${left}, so their signatures are not read and which one this call reaches is not resolved`);
  }
  const reachable: Definition[] = [];
  for (const definition of definitions) {
    const signature = await reader.signature(definition.path, definition.line, bare);
    if (!signature.ok || !unreachable(call, signature.parameters)) reachable.push(definition);
  }
  if (reachable.length === 0) {
    const none =
      definitions.length === 1
        ? `the definition of ${bare} this call names (${definitions[0]!.path}:${definitions[0]!.line}) cannot be reached as this call is written`
        : `none of the ${definitions.length} definitions of ${bare} left here can be reached as this call is written`;
    return { ok: false, held: { ok: false, kind: "callee_unresolved", reason: `${none}, so what it returns is not established here` } };
  }
  definitions = reachable;
  if (definitions.length === 1) return { ok: true, definitions, sole: false };

  const versions = await versionsOfOneThing(reader, definitions);
  if (!versions) return unresolved(`${many}, so which one this call reaches is not resolved`);
  return { ok: true, definitions: versions, sole: false };
}

/**
 * Whether the calling function returns a `Result`: the first half of `applicabilityOf`, and what a
 * sibling must satisfy to be asked about (ADR 0005). `null` when it does.
 */
export async function targetOf(discoverer: Discoverer, fn: FunctionCandidate): Promise<Extract<Applicability, { ok: false }> | null> {
  const target = await returnTypesFor(discoverer).at(fn.path, fn.startLine, fn.name);
  if (target.kind === "not") {
    return { ok: false, kind: "target_not_result", reason: `${fn.name} returns \`${quoted(target.type)}\` and does not return a Result, so "a success" and "an error" do not sort what it returns` };
  }
  if (target.kind === "unknown") {
    return { ok: false, kind: "target_return_unknown", reason: `whether ${fn.name} returns a Result is not settled here: ${target.why}` };
  }
  return null;
}

/**
 * Where a call's callee settled, whatever it returns. `repository` is one definition here;
 * `versions` is several read as one thing (a trait's method, or a function written once per
 * platform under `#[cfg(…)]`), named by the first; `outside` is a row of the table of functions
 * outside the repository (ADR 0011). `null` when nothing settled it.
 */
export type CalleeLocation = { kind: "repository" | "versions"; path: string; line: number } | { kind: "outside"; row: string } | null;

/**
 * The second half of `applicabilityOf`: what the callee is and whether it returns a `Result`,
 * read the same way whatever the calling function returns — so a call can be followed from a
 * function that does not return one (the siblings of a change, ADR 0005). `result` is what
 * `applicabilityOf` says of the call once the calling function returns a `Result`, word for word.
 */
export async function calleeOf(discoverer: Discoverer, fn: FunctionCandidate, call: CallCandidate): Promise<{ result: Applicability; at: CalleeLocation }> {
  const reader = returnTypesFor(discoverer);
  const bare = call.callee.split("::").pop()!;
  const outside = outsideResult(call.callee);
  // A call that writes `std::` says which library it means, and no definition here is that library.
  if (outside && namesTheStandardLibrary(call.callee)) return { result: { ok: true, calleeDefinedAt: outside.path }, at: { kind: "outside", row: outside.path } };
  const { found, more, testOnly } = await functionDefinitionsOf(discoverer, bare);
  if (more) return { result: { ok: false, kind: "callee_return_unknown", reason: `the search for \`fn ${bare}\` stopped at its cap, so not every definition of ${bare} was seen` }, at: null };
  if (found.length === 0) {
    // Nothing here defines the name, and the path the call writes is one this tool knows from
    // outside the repository (ADR 0011). Definitions compiled only for tests do not count against
    // that: the docs say they are not the callee's definitions at all.
    if (outside) return { result: { ok: true, calleeDefinedAt: outside.path }, at: { kind: "outside", row: outside.path } };
    // Definitions this repository compiles only for tests are not definitions this call reaches,
    // and their absence is not the absence of a definition.
    if (testOnly > 0) return { result: { ok: false, kind: "callee_ambiguous", reason: `every definition of ${bare} here (${testOnly}) is in a file declared under \`#[cfg(test)] mod\`, so what this call reaches outside tests is not established here` }, at: null };
    return { result: { ok: false, kind: "callee_unresolved", reason: `${bare} has no definition in this repository, so what it returns is not established here` }, at: null };
  }
  const narrowed = await narrow(discoverer, fn, call, bare, found);
  // Nothing here that this call can reach, and a path the table knows: the definitions found share
  // the name with something else. `fs::rename(a, b)` meets a repository's `Session::rename(&mut
  // self, …)` by name alone, and a module holds no method.
  if (!narrowed.ok) {
    const held = narrowed.held;
    if (!held.ok && held.kind === "callee_unresolved" && outside) return { result: { ok: true, calleeDefinedAt: outside.path }, at: { kind: "outside", row: outside.path } };
    return { result: held, at: null };
  }
  const { definitions, sole } = narrowed;
  const def = definitions[0]!;
  const at = `${def.path}:${def.line}`;

  if (definitions.length === 1) {
    const named = sole ? `the one function named ${bare} in this repository (${at})` : `the definition of ${bare} this call reaches (${at})`;
    const signature = await reader.signature(def.path, def.line, bare);
    if (sole && signature.ok) {
      const why = unreachable(call, signature.parameters);
      if (why && outside) return { result: { ok: true, calleeDefinedAt: outside.path }, at: { kind: "outside", row: outside.path } };
      if (why) return { result: { ok: false, kind: "callee_unresolved", reason: `${named} ${why}, so this call does not reach it and what it returns is not established here` }, at: null };
    }
    const callee = await reader.readingOf(signature, def.path);
    if (callee.kind === "not") {
      return { result: { ok: false, kind: "callee_not_result", reason: `${named} returns \`${quoted(callee.type)}\` and does not return a Result, so it has no error to assume` }, at: { kind: "repository", path: def.path, line: def.line } };
    }
    if (callee.kind === "unknown") {
      return { result: { ok: false, kind: "callee_return_unknown", reason: `whether ${named} returns a Result is not settled here: ${callee.why}` }, at: { kind: "repository", path: def.path, line: def.line } };
    }
    return { result: { ok: true, calleeDefinedAt: at }, at: { kind: "repository", path: def.path, line: def.line } };
  }

  // Versions of one thing: which one runs is not settled, so all of them must return a Result.
  const readings = await Promise.all(definitions.map(async (d) => reader.readingOf(await reader.signature(d.path, d.line, bare), d.path)));
  for (const [i, reading] of readings.entries()) {
    if (reading.kind === "returns") continue;
    const where = `${definitions[i]!.path}:${definitions[i]!.line}`;
    const why = reading.kind === "not" ? `returns \`${quoted(reading.type)}\` and does not return a Result` : `is not settled: ${reading.why}`;
    return { result: { ok: false, kind: "callee_ambiguous", reason: `${bare} is defined ${found.length} times here as one thing written ${definitions.length} times, and one of them (${where}) ${why}, so this call has no error to assume` }, at: { kind: "versions", path: def.path, line: def.line } };
  }
  return { result: { ok: true, calleeDefinedAt: at }, at: { kind: "versions", path: def.path, line: def.line } };
}

/**
 * Whether `call_failure_not_returned_as_success` can be asked here.
 *
 * Both halves come from a signature, never from how a line looks (`result-type.ts`):
 *
 *   - the target must return a `Result`, or "a success" and "an error" sort nothing it returns;
 *   - the callee must be settled to a definition in this repository — one `fn` of its name, or the
 *     one `narrow` selects out of several — and return a `Result`, or there is no error to assume.
 *
 * "Does not return a Result" is said only of a return type read to its end, and the reason names
 * the definition it read.
 */
export async function applicabilityOf(discoverer: Discoverer, fn: FunctionCandidate, call: CallCandidate): Promise<Applicability> {
  return (await targetOf(discoverer, fn)) ?? (await calleeOf(discoverer, fn, call)).result;
}
