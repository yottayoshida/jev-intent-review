// Whether a function returns a `Result`, read from its whole signature and from the aliases this
// repository defines.
//
// The check before this looked for `Result<` in four lines of the callee (eight lines and 300
// characters of the target). On real pull requests it said "does not return a Result" of functions
// that do:
//
//   - moltis#1064's `dispatch_command` returns `ChannelResult<String>`, and the file says
//     `use moltis_channels::{…, Result as ChannelResult}`;
//   - Kontor#385's `get_decided_from_anchor` has its `-> Result<…>` on the fifth line;
//   - grovedb#501's `set_base_root_key` returns `CostResult<(), Error>`, and the repository says
//     `type CostResult<T, E> = CostContext<Result<T, E>>`.
//
// So the return type is taken from the signature itself — past the generics and the parameter
// list, up to the body, a `;` or `where` — and every name in it is resolved: a rename in the same
// file's `use`, an alias the repository defines (three deep), a type the repository defines, a
// short list of the standard library's. "Does not return a Result" is said only when every name in
// the return type is known not to be one. Anything else — a type from a dependency, `Self`, a type
// parameter, an alias that could not be followed, a signature that did not end — is said to be not
// settled, with what could not be read.
//
// ponytail: a reader of text, not of Rust. It resolves a name, not a path: `a::Error` and
// `b::Error` are the same `Error` to it, and a rename is read from any `use` in the file whatever
// its scope. Every such confusion lands on "not settled" or on the same answer as before, except
// when two same-named types disagree and only one of them is found — the hand-labelled answers in
// `bench/result-type-expected.json` are what that is checked against. A parser is spec Phase 4.

import { indentOf } from "../change/blocks.ts";
import { isTestPath, type Discoverer } from "../discovery/discover.ts";

export type ReturnReading =
  | { kind: "returns"; type: string }
  | { kind: "not"; type: string }
  | { kind: "unknown"; type?: string; why: string };

const MAX_SIGNATURE_LINES = 30;
const MAX_ALIAS_DEPTH = 3;
/** How much of a return type a reason quotes. */
const QUOTED = 80;

const PRIMITIVES = new Set(["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "bool", "char", "str"]);
/** Names from the standard library that are not a `Result` under any other name. */
const KNOWN = new Set(["Option", "Vec", "String", "Box", "Arc", "Rc", "HashMap", "HashSet", "BTreeMap", "BTreeSet", "VecDeque", "PathBuf", "Path", "Duration", "Instant", "Cow", "Pin", "Iterator", "Fn", "FnMut", "FnOnce"]);
/** Words that sit in a type without naming one. */
const NOT_TYPES = new Set(["dyn", "impl", "mut", "const", "fn", "unsafe", "extern", "for", "where", "as", "crate", "self", "super"]);

/** A return type as a reason quotes it. */
export const quoted = (type: string) => (type.length > QUOTED ? `${type.slice(0, QUOTED - 1)}…` : type);

// Code only: comments and the insides of string and character literals turned into spaces,
// newlines kept, so every offset still points where it did. `fn parse() in a comment` and
// `"fn emit() {}"` are not definitions. A lifetime's `'` is not a quote.
//
// ponytail: a raw string holding a `"` (`r#"say "hi""#`) ends early here, and the rest of it reads
// as code; nested block comments close at the first `*/`.
export function codeOnly(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      blank(i, j);
      i = j - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const to = end < 0 ? text.length : end + 2;
      blank(i, to);
      i = to - 1;
    } else if (c === "'") {
      // A character literal, not a lifetime: `'"'` must not open a string that runs for lines.
      const literal = /^'(?:\\u\{[0-9a-fA-F]{1,6}\}|\\.|[^\\'\n])'/.exec(text.slice(i, i + 12));
      if (literal) {
        blank(i + 1, i + literal[0].length - 1);
        i += literal[0].length - 1;
      }
    }
  }
  return out.join("");
}

/** A Rust function named `name` begins on this line of code. */
const definesFunction = (code: string, name: string) => new RegExp(`\\bfn\\s+${name}\\s*[(<]`).exec(code);

/** Past the bracket that closes the one at `at`, or -1. `->` is one token, not a closing `>`. */
function pastClosing(text: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** Top-level pieces of a list, split at the commas outside any bracket — `Rect { x, y }: Rect` is one. */
export function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if ("<([{".includes(c)) depth++;
    else if (">)]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** The `;` at depth 0 from `at`, or -1. */
function endOfStatement(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if ("<([".includes(c)) depth++;
    else if (">)]".includes(c)) depth--;
    else if (c === ";" && depth === 0) return i;
  }
  return -1;
}

/** The names a generic parameter list declares, lifetimes left out. */
function parameterNames(list: string): Set<string> {
  const names = new Set<string>();
  for (const part of topLevel(list)) {
    if (part.startsWith("'")) continue;
    const name = /^(?:const\s+)?([A-Za-z_]\w*)/.exec(part)?.[1];
    if (name) names.add(name);
  }
  return names;
}

const skipSpace = (text: string, i: number) => {
  while (/\s/.test(text[i] ?? "")) i++;
  return i;
};
const endsHere = (text: string, i: number) => text[i] === "{" || text[i] === ";" || (/^where\b/.test(text.slice(i)) && !/[\w$]/.test(text[i - 1] ?? " "));

/**
 * The return type written in the signature that starts on `startLine`, and the generic parameters
 * the function declares. `()` when there is no `->`.
 */
export function signatureAt(
  lines: readonly string[],
  startLine: number,
  name: string,
): { ok: true; returns: string; generics: Set<string>; parameters: string[] } | { ok: false; why: string } {
  const unfinished = { ok: false as const, why: `the signature did not end within ${MAX_SIGNATURE_LINES} lines` };
  const text = codeOnly(lines.slice(startLine - 1, startLine - 1 + MAX_SIGNATURE_LINES).join("\n"));
  // The function named, on the line it was found on — not the first `fn` of whatever follows, and
  // not one in a comment or a string.
  const firstLine = text.split("\n", 1)[0]!;
  const found = definesFunction(firstLine, name);
  if (!found) return { ok: false, why: `line ${startLine} does not define \`fn ${name}\` outside a comment or a string` };
  let i = found.index + found[0].length - 1;
  let generics = new Set<string>();
  if (text[i] === "<") {
    const end = pastClosing(text, i, "<", ">");
    if (end < 0) return unfinished;
    generics = parameterNames(text.slice(i + 1, end - 1));
    i = end;
  }
  i = skipSpace(text, i);
  if (text[i] !== "(") return { ok: false, why: "its parameter list was not found" };
  const open = i;
  i = pastClosing(text, i, "(", ")");
  if (i < 0) return unfinished;
  const parameters = topLevel(text.slice(open + 1, i - 1));
  i = skipSpace(text, i);
  if (!text.startsWith("->", i)) return endsHere(text, i) ? { ok: true, returns: "()", generics, parameters } : unfinished;
  const start = (i += 2);
  let angle = 0;
  let other = 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if (c === "<") angle++;
    else if (c === ">") angle--;
    else if (c === "(" || c === "[") other++;
    else if (c === ")" || c === "]") other--;
    else if (angle === 0 && other === 0 && endsHere(text, i)) return { ok: true, returns: text.slice(start, i).replace(/\s+/g, " ").trim(), generics, parameters };
  }
  return unfinished;
}

/** What encloses a definition: the line of the item it sits in, the top of the file, or unread. */
export type Enclosing = { kind: "item"; text: string } | { kind: "top" } | { kind: "unknown" };

/** The item a header line begins, as far as a reader of text can tell. */
export type ItemHead = { kind: "impl"; self?: string; trait?: string } | { kind: "trait"; name: string } | { kind: "other" };

/** A line that begins an item. Read before the one below: `pub trait X: Send` is not a bound. */
const BEGINS_ITEM = /^(?:pub\b|impl\b|trait\b|mod\b|unsafe\b|async\b|extern\b|default\b|fn\b|struct\b|enum\b|union\b|macro_rules\b)/;
/** A line that carries a header on but names nothing: a brace, an attribute, a bound, an operator. */
const CARRIES_NOTHING = /^(?:[{}()[\],+&|]|'\w|->|::|where\b|#\[|[\w:<>, &'+]+:\s)/;

/** How many lines an item's header may be written over before it is given up on. */
const HEADER_LINES = 10;

/**
 * The item's header from the line it starts on: everything up to the `{` that opens its body, on
 * one line. `impl<T> Reader` / `for Store<T>` / `{` is one header, and reading only its first line
 * would take `Reader` for the type — the trait is not the type it is implemented for.
 */
function headerFrom(codeLines: readonly string[], at: number): string | null {
  const parts: string[] = [];
  for (let i = at; i < codeLines.length && i < at + HEADER_LINES; i++) {
    const text = codeLines[i]!.trim();
    if (text !== "") parts.push(text);
    if (text.includes("{")) return parts.join(" ");
  }
  return null;
}

/**
 * The item a definition on `line` sits in, read from indentation: the first line above it that is
 * less indented and begins an item, joined to the `{` that opens the item's body. Lines at the
 * same indentation or deeper are the item's own body (the `fn` above this one inside the same
 * `impl`), never its header. A header that never reaches a `{`, and a line that begins no item and
 * can hold a name, are `unknown` — a caller then narrows nothing rather than narrowing by half a
 * header.
 */
export function enclosingItem(codeLines: readonly string[], line: number): Enclosing {
  const own = codeLines[line - 1];
  if (own === undefined) return { kind: "unknown" };
  const depth = indentOf(own);
  for (let i = line - 2; i >= 0; i--) {
    const text = codeLines[i]!;
    if (text.trim() === "" || indentOf(text) >= depth) continue;
    const trimmed = text.trim();
    if (BEGINS_ITEM.test(trimmed)) {
      const header = headerFrom(codeLines, i);
      return header === null ? { kind: "unknown" } : { kind: "item", text: header };
    }
    if (CARRIES_NOTHING.test(trimmed)) continue;
    return { kind: "unknown" };
  }
  return { kind: "top" };
}

/** The type an `impl` is for and the trait it implements, or the name a `trait` declares. */
export function itemHead(text: string): ItemHead {
  const head = text.replace(/^(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:unsafe\s+)?/, "");
  const declared = /^trait\s+(\w+)/.exec(head);
  if (declared) return { kind: "trait", name: declared[1]! };
  if (!/^impl\b/.test(head)) return { kind: "other" };
  let rest = head.slice("impl".length).trimStart();
  if (rest.startsWith("<")) {
    const end = pastClosing(rest, 0, "<", ">");
    if (end < 0) return { kind: "other" };
    rest = rest.slice(end);
  }
  let depth = 0;
  let implements_ = -1;
  for (let i = 0; i < rest.length; i++) {
    // `->` is one token: `impl Callback<fn() -> T> for Handler` closes no bracket at its `>`.
    if (rest[i] === "-" && rest[i + 1] === ">") {
      i++;
      continue;
    }
    if (rest[i] === "<") depth++;
    else if (rest[i] === ">") depth--;
    else if (depth === 0 && /^\s+for\s+/.test(rest.slice(i))) {
      implements_ = i;
      break;
    }
  }
  const named = (part: string) => /^([\w:]+)/.exec(part.trim().replace(/^&\s*(?:'\w+\s*)?(?:mut\s+)?/, ""))?.[1]?.split("::").pop();
  if (implements_ < 0) return { kind: "impl", self: named(rest) };
  return { kind: "impl", trait: named(rest.slice(0, implements_)), self: named(rest.slice(implements_).replace(/^\s+for\s+/, "")) };
}

/** The attribute lines directly above `line`, with nothing but attributes between. */
export function attributesAbove(codeLines: readonly string[], line: number): string[] {
  const found: string[] = [];
  for (let i = line - 2; i >= 0 && /^\s*#\[/.test(codeLines[i]!); i--) found.unshift(codeLines[i]!.trim());
  return found;
}

/** Every path a type names, as its segments — not associated-type bindings (`Output = …`), not lifetimes. */
function pathsIn(type: string): string[][] {
  const paths: string[][] = [];
  const PATH = /[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*/g;
  for (const m of type.matchAll(PATH)) {
    const before = type[m.index - 1] ?? " ";
    if (before === "'" || /[\w$]/.test(before)) continue;
    if (/^\s*=(?!=)/.test(type.slice(m.index + m[0].length))) continue;
    const segments = m[0].split("::").map((s) => s.trim());
    if (segments.length === 1 && NOT_TYPES.has(segments[0]!)) continue;
    paths.push(segments);
  }
  return paths;
}

interface Alias {
  path: string;
  line: number;
  rhs: string;
  generics: Set<string>;
}

type Verdict = { kind: "returns" } | { kind: "not" } | { kind: "unknown"; why: string };

/** Reads what functions return, for one commit. Everything it looks up is kept for the run. */
export class ReturnTypes {
  readonly #discoverer: Discoverer;
  readonly #renames = new Map<string, Promise<Map<string, string>>>();
  readonly #aliases = new Map<string, Promise<Alias[] | "cut">>();
  readonly #defined = new Map<string, Promise<"data" | "trait" | "none" | "cut">>();
  readonly #code = new Map<string, Promise<string[] | null>>();

  constructor(discoverer: Discoverer) {
    this.#discoverer = discoverer;
  }

  /**
   * The file's lines as code, read whole: a `fn` inside a string or a comment that spans lines is
   * not code on any of them.
   */
  #codeLines(path: string): Promise<string[] | null> {
    let found = this.#code.get(path);
    if (!found) {
      found = (async () => {
        const lines = (await this.#discoverer.index(path))?.lines;
        return lines ? codeOnly(lines.join("\n")).split("\n") : null;
      })();
      this.#code.set(path, found);
    }
    return found;
  }

  /** Line `line` of `path` as code, or null when the file cannot be read. */
  async codeLine(path: string, line: number): Promise<string | null> {
    return (await this.#codeLines(path))?.[line - 1] ?? null;
  }

  /** Every line of `path` as code, or null when the file cannot be read. */
  async codeLinesOf(path: string): Promise<string[] | null> {
    return this.#codeLines(path);
  }

  /** The item a definition on `line` of `path` sits in. */
  async enclosing(path: string, line: number): Promise<Enclosing> {
    const lines = await this.#codeLines(path);
    return lines ? enclosingItem(lines, line) : { kind: "unknown" };
  }

  /** The attributes written directly above `line` of `path`. */
  async attributes(path: string, line: number): Promise<string[]> {
    const lines = await this.#codeLines(path);
    return lines ? attributesAbove(lines, line) : [];
  }

  /** The signature of `fn name` on `line` of `path`, or why it could not be read. */
  async signature(path: string, line: number, name: string): Promise<ReturnType<typeof signatureAt>> {
    const lines = await this.#codeLines(path);
    if (!lines) return { ok: false, why: `${path} could not be read here` };
    return signatureAt(lines, line, name);
  }

  /** What `fn name`, whose signature starts on `line` of `path`, returns. */
  async at(path: string, line: number, name: string): Promise<ReturnReading> {
    return this.readingOf(await this.signature(path, line, name), path);
  }

  /** What a signature already read from `path` returns. */
  async readingOf(signature: Awaited<ReturnType<ReturnTypes["signature"]>>, path: string): Promise<ReturnReading> {
    if (!signature.ok) return { kind: "unknown", why: signature.why };
    const verdict = await this.#type(signature.returns, path, 0, signature.generics, new Set());
    return verdict.kind === "unknown" ? { kind: "unknown", type: signature.returns, why: verdict.why } : { kind: verdict.kind, type: signature.returns };
  }

  /** A `Result` anywhere in the type, once its names are followed, returns one; else every name must be known. */
  async #type(type: string, file: string, depth: number, generics: ReadonlySet<string>, skip: ReadonlySet<string>): Promise<Verdict> {
    let unknown: string | undefined;
    for (const segments of pathsIn(type)) {
      if (segments.includes("Result")) return { kind: "returns" };
      const verdict = await this.#name(segments, file, depth, generics, skip);
      if (verdict.kind === "returns") return verdict;
      if (verdict.kind === "unknown") unknown ??= verdict.why;
    }
    return unknown === undefined ? { kind: "not" } : { kind: "unknown", why: unknown };
  }

  async #name(segments: readonly string[], file: string, depth: number, generics: ReadonlySet<string>, skip: ReadonlySet<string>): Promise<Verdict> {
    const name = segments[segments.length - 1]!;
    const head = segments[0]!;
    // An alias's own parameters stand for the arguments it is given, which are read where they are
    // written; a path through one (`T::Output`) is whatever that argument makes it.
    if (skip.has(head)) return segments.length === 1 ? { kind: "not" } : { kind: "unknown", why: `\`${segments.join("::")}\` depends on a type parameter` };
    if (head === "Self") return { kind: "unknown", why: "`Self` is not followed to the type it names" };
    if (generics.has(head)) return { kind: "unknown", why: `\`${head}\` is a type parameter` };
    if (PRIMITIVES.has(name)) return { kind: "not" };
    if (depth >= MAX_ALIAS_DEPTH) return { kind: "unknown", why: `\`${name}\` is an alias more than ${MAX_ALIAS_DEPTH} deep` };

    const renamed = (await this.#renamesIn(file)).get(name);
    if (renamed !== undefined) return renamed === "Result" ? { kind: "returns" } : this.#name([renamed], file, depth + 1, generics, skip);

    const aliases = await this.#aliasesOf(name);
    if (aliases === "cut") return { kind: "unknown", why: `the search for \`type ${name}\` stopped at its cap` };
    if (aliases.length > 0) {
      // The right-hand side is read where it is written: the function's own parameters do not reach it.
      const verdicts = await Promise.all(aliases.map((a) => this.#type(a.rhs, a.path, depth + 1, new Set(), a.generics)));
      const kinds = new Set(verdicts.map((v) => v.kind));
      if (kinds.size === 1) return verdicts[0]!;
      return { kind: "unknown", why: `\`${name}\` has ${aliases.length} definitions here that disagree` };
    }
    if (KNOWN.has(name)) return { kind: "not" };
    // A parameter of the enclosing `impl` is not in the function's own generics. One capital letter
    // that no rename or alias here explains is read as one, whatever the repository names that way.
    if (segments.length === 1 && /^[A-Z]$/.test(name)) return { kind: "unknown", why: `\`${name}\` reads as a type parameter of what encloses the function` };
    const defined = await this.#definedAs(name);
    if (defined === "data") return { kind: "not" };
    if (defined === "trait") return { kind: "unknown", why: `\`${name}\` is a trait, and what implements it is not read` };
    if (defined === "cut") return { kind: "unknown", why: `the search for \`${name}\` stopped at its cap` };
    return { kind: "unknown", why: `\`${name}\` is not defined in this repository` };
  }

  /** `X as Y` in the file's `use` statements, as Y → the last segment of X. */
  #renamesIn(file: string): Promise<Map<string, string>> {
    let found = this.#renames.get(file);
    if (!found) {
      found = (async () => {
        const renames = new Map<string, string>();
        const lines = (await this.#discoverer.index(file))?.lines ?? [];
        const text = codeOnly(lines.join("\n"));
        for (const statement of text.matchAll(/(?:^|[;{}\n])\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]*);/g)) {
          for (const m of statement[1]!.matchAll(/([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)/g)) {
            if (m[2] !== "_" && m[1] !== "self") renames.set(m[2]!, m[1]!);
          }
        }
        return renames;
      })();
      this.#renames.set(file, found);
    }
    return found;
  }

  /** `type NAME<…> = …;` in the repository, outside tests. */
  #aliasesOf(name: string): Promise<Alias[] | "cut"> {
    let found = this.#aliases.get(name);
    if (!found) {
      found = (async () => {
        const hits = await this.#definitionLines(`type ${name}`);
        if (hits === "cut") return "cut";
        const aliases: Alias[] = [];
        // Attributes on the same line (`#[cfg(feature = "x")] pub type …`) are part of the head.
        const HEAD = new RegExp(`^\\s*(?:#\\[[^\\]]*\\]\\s*)*(?:pub(?:\\([^)]*\\))?\\s+)?type\\s+${name}\\b\\s*`);
        for (const hit of hits) {
          const lines = (await this.#discoverer.index(hit.path))?.lines ?? [];
          const statement = codeOnly(lines.slice(hit.line - 1, hit.line + 9).join("\n"));
          const head = HEAD.exec(statement);
          if (!head) continue;
          let i = head[0].length;
          let generics = new Set<string>();
          if (statement[i] === "<") {
            const end = pastClosing(statement, i, "<", ">");
            if (end < 0) continue;
            generics = parameterNames(statement.slice(i + 1, end - 1));
            i = skipSpace(statement, end);
          }
          if (statement[i] !== "=") continue;
          // The `;` that ends the statement, not the one inside an array type (`[u8; HASH_LENGTH]`).
          const semicolon = endOfStatement(statement, i + 1);
          if (semicolon < 0) continue;
          aliases.push({ path: hit.path, line: hit.line, rhs: statement.slice(i + 1, semicolon).trim(), generics });
        }
        return aliases;
      })();
      this.#aliases.set(name, found);
    }
    return found;
  }

  /** Whether the repository defines the name as a data type or as a trait. */
  #definedAs(name: string): Promise<"data" | "trait" | "none" | "cut"> {
    let found = this.#defined.get(name);
    if (!found) {
      found = (async () => {
        let cut = false;
        for (const keyword of ["struct", "enum", "union"]) {
          const hits = await this.#definitionLines(`${keyword} ${name}`);
          if (hits === "cut") cut = true;
          else if (hits.length > 0) return "data";
        }
        const traits = await this.#definitionLines(`trait ${name}`);
        if (traits === "cut") return "cut";
        if (traits.length > 0) return "trait";
        return cut ? "cut" : "none";
      })();
      this.#defined.set(name, found);
    }
    return found;
  }

  /** Lines of Rust outside tests that hold the words, or "cut" when the search stopped at its cap. */
  async #definitionLines(words: string): Promise<{ path: string; line: number }[] | "cut"> {
    const { hits, more } = await this.#discoverer.search(words);
    if (more) return "cut";
    const out: { path: string; line: number }[] = [];
    for (const hit of hits) {
      if (!hit.path.endsWith(".rs") || isTestPath(hit.path)) continue;
      const index = await this.#discoverer.index(hit.path);
      if ((index?.testRegions ?? []).some((r) => hit.line >= r.start && hit.line <= r.end)) continue;
      // The words at the start of a declaration, not inside one (`impl Trait for struct_like`).
      if (!new RegExp(`^\\s*(?:#\\[[^\\]]*\\]\\s*)*(?:pub(?:\\([^)]*\\))?\\s+)?(?:unsafe\\s+)?${words.replace(" ", "\\s+")}\\b`).test(hit.text)) continue;
      out.push({ path: hit.path, line: hit.line });
    }
    return out;
  }
}

const readers = new WeakMap<Discoverer, ReturnTypes>();

/** The reader for this commit's discoverer, made once and kept with it. */
export function returnTypesFor(discoverer: Discoverer): ReturnTypes {
  let reader = readers.get(discoverer);
  if (!reader) {
    reader = new ReturnTypes(discoverer);
    readers.set(discoverer, reader);
  }
  return reader;
}
