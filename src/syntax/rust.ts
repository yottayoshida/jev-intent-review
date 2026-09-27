// A Rust file's functions, calls and regions, read by a parser (tree-sitter-rust) rather than by lines
// (#83, ADR 0022). The listing (`enumerate`) and the Rust side of `BlockIndex` both read a file from
// here, so the two cannot disagree on where a function ends (#74).
//
// The grammar is `vendor/tree-sitter-rust.wasm`, loaded once when this module is, so every function
// below is synchronous and the callers keep their shapes. A tree lives in the WebAssembly memory, not
// in the JavaScript heap: it is read into plain objects and deleted before `parseRust` returns.
//
// Positions are 1-based lines and 0-based columns in UTF-16 code units, the units `web-tree-sitter`
// reports for a JavaScript string and the listing has always recorded.

import { readFileSync } from "node:fs";
import { Language, Parser, type Node } from "web-tree-sitter";
import { cfgPredicate, testOnlyCfg } from "./cfg.ts";

// Once per process. `Parser.init` resets the WebAssembly module every loaded grammar lives in, so a
// second copy of this module (a bench comparing two builds of `src/` side by side) must reuse the
// first's parser rather than initialise again.
const SHARED = Symbol.for("jev-intent-review/tree-sitter-rust");
const shared = globalThis as { [SHARED]?: Promise<Parser> };
shared[SHARED] ??= (async () => {
  await Parser.init();
  const language = await Language.load(readFileSync(new URL("../../vendor/tree-sitter-rust.wasm", import.meta.url)));
  const p = new Parser();
  p.setLanguage(language);
  return p;
})();
const parser = await shared[SHARED];

export interface Span {
  startLine: number;
  endLine: number;
}

export interface RustFunction extends Span {
  name: string;
  /** Inside code compiled only for tests (`#[cfg(test)]` and the like, `#[test]`). */
  testOnly: boolean;
}

export interface RustCall {
  /** Index into `functions` of the innermost function the call is in. */
  fn: number;
  line: number;
  /** Where the callee's last name starts. */
  column: number;
  /** Where the callee starts as written (`a` of `a::b::foo`, `Vec` of `Vec::<u8>::new`): the listing's `column`. */
  startColumn: number;
  /** The callee as written without generic arguments (`a::b::foo`, `Vec::new`); a method's own name; "" when the callee is not a name. */
  callee: string;
  /** Where the call's text starts, for `expression`: the callee's first segment, or a method's name. */
  exprStart: number;
  /** Where the call's arguments end. */
  exprEnd: number;
  /** Inside a macro whose arguments were read again as expressions (ADR 0022). */
  inMacro: boolean;
  /** For a method call (`x.name(…)`), what it is called on as far as it is written (#83, ADR 0027). */
  receiver?: Receiver;
}

/**
 * What a method call is called on (#83, ADR 0027): `self`, a name, another call — by the line and the
 * column the listing records it at, so its callee is looked up as any listed call's is — or not read.
 */
export type Receiver = { kind: "self" } | { kind: "name"; name: string } | { kind: "call"; line: number; startColumn: number } | { kind: "type"; path: string[] } | { kind: "unread" };

/**
 * A name a function binds, over the lines it is in force (#83): a parameter or a `let` with its written
 * `type`, a `let` set from a call or a name (`value`), or something this does not read the type of.
 */
export interface Binding {
  name: string;
  scope: Span;
  type?: string;
  value?: Receiver;
  unread?: true;
}

export interface RustItem extends Span {
  name?: string;
}

export interface ParsedRust {
  functions: RustFunction[];
  calls: RustCall[];
  /**
   * `impl`, `trait`, `mod`, `struct`, `enum`, `const`, `static`, `union`, `type`, `macro_rules!`, and every
   * other construct at the top of the file (`use`, an item macro): what `BlockIndex` reads a line
   * outside every function as.
   */
  items: RustItem[];
  /** What the parser could not read: its ERROR nodes, outermost ones only. Nothing inside is listed. */
  unread: Span[];
  /** Macro invocations holding call-shaped text whose arguments were not read (ADR 0022). */
  macrosNotRead: number;
  /**
   * Where every macro invocation whose arguments were not read as calls is — call-shaped or not,
   * inside a function or outside (`tauri::generate_handler![a::b]`, `json!({…})`, `matches!(…)`).
   * A name there may be a call nobody read, which is not the same as no call (#83).
   */
  macrosUnreadAt: Span[];
  /** Every name a `use` brings in, with the block it applies to (#83). */
  uses: UseBinding[];
  /** What names functions bind, and where (#83, ADR 0027). */
  bindings: Binding[];
  /** Inline `mod x { … }` blocks, which a `use` outside does not reach unless they `use super::*`. */
  mods: (Span & { superGlob: boolean })[];
}

/**
 * A name a `use` brings into a block: `use std::fs;` brings `fs` as `std::fs`, `use std::fs::File as F;`
 * brings `F` as `std::fs::File`, `use std::fs::{self, OpenOptions};` brings `fs` and `OpenOptions`. A glob
 * (`use std::io::*;`) brings no name it can be looked up by, and is kept as `glob`.
 */
export interface UseBinding {
  name: string;
  path: string[];
  glob?: true;
  /** The lines of the block the `use` is written in: the file, a `mod`'s body, a function's body. */
  scope: Span;
}

/**
 * Macros whose arguments are not expressions even when they read as some (ADR 0022, by exact name): a
 * pattern (`matches!(x, Foo(y))` would read `Foo(y)` as a call — #81's first review), or code handled
 * as data (`stringify!`, `quote!`). Every other macro whose arguments read as expressions, with no error
 * anywhere, is read: a project's own error macro (`cost_return_on_error!(cost, tree.get(p))`) holds the
 * calls a requirement governs as much as `?` does.
 */
const NOT_EXPRESSION_MACROS = new Set([
  "matches",
  "assert_matches",
  "debug_assert_matches",
  "stringify",
  "concat",
  "concat_idents",
  "quote",
  "quote_spanned",
  "parse_quote",
  "parse_quote_spanned",
  "paste",
  // Assembly: `options(nomem)` is an operand, not a call.
  "asm",
  "global_asm",
  "naked_asm",
]);

const ITEM_TYPES = new Set(["impl_item", "trait_item", "mod_item", "struct_item", "enum_item", "const_item", "static_item", "union_item", "type_item", "macro_definition"]);

/** `&raw` not followed by `const` or `mut`: a borrow of something named `raw` (see `parseRust`). */
const RAW_BORROW = /&(\s*)raw\b(?!\s+(?:const|mut)\b)/g;

/** `unsafe extern`, which the grammar does not know (see `parseRust`). */
const UNSAFE_EXTERN = /\bunsafe(\s+)extern\b/g;

/** Text that holds something shaped like a call: a name, maybe a turbofish, then `(`. */
const CALL_SHAPE = /[A-Za-z_]\w*\s*(::\s*<[^()]*>)?\s*\(/;

/** The attributes written before an item, which tree-sitter keeps as the item's preceding siblings. */
function attributesOf(node: Node, text: (n: Node) => string): string[] {
  const out: string[] = [];
  for (let s = node.previousSibling; s; s = s.previousSibling) {
    if (s.type === "attribute_item") out.push(text(s).replace(/\s+/g, " "));
    else if (s.type !== "line_comment" && s.type !== "block_comment") break;
  }
  return out;
}

/** `#[test]`, `#[tokio::test]`, or a `cfg` that holds only when the tests are compiled. */
function testOnlyAttributes(attrs: readonly string[]): boolean {
  return attrs.some((a) => {
    const predicate = cfgPredicate(a);
    if (predicate !== null) return testOnlyCfg(predicate);
    // `#[test]`, `#[tokio::test]`, `#[tokio::test(flavor = "multi_thread")]`: a path ending in `test`.
    return /^#\[\s*(?:[A-Za-z_]\w*\s*::\s*)*test\s*(?:\(.*\))?\s*\]$/.test(a);
  });
}

/** The name nodes of a callee, for its text without generic arguments, or null when it is not a path. */
function pathNames(node: Node, text: (n: Node) => string): string[] | null {
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "self":
    case "super":
    case "crate":
    case "metavariable":
      return [text(node).replace(/^r#/, "")];
    case "scoped_identifier":
    case "scoped_type_identifier": {
      const name = node.childForFieldName("name");
      if (!name) return null;
      const path = node.childForFieldName("path");
      // `<T as Trait>::f` and the like: the qualified type is not a path of names.
      const head = path === null ? [] : pathNames(path.type === "generic_type" ? (path.childForFieldName("type") ?? path) : path, text);
      return head === null ? [text(name).replace(/^r#/, "")] : [...head, text(name).replace(/^r#/, "")];
    }
    case "generic_function":
      return pathNames(node.childForFieldName("function")!, text);
    default:
      return null;
  }
}

interface Walk {
  /** Maps an index in the text being walked to an index in the file. */
  offset: (index: number) => number;
  inMacro: boolean;
}

/**
 * Reads one file. Never throws on the file's content: what the parser cannot read is an `unread` span.
 */
export function parseRust(source: string): ParsedRust {
  // What the parser is given. tree-sitter-rust 0.24 has two gaps that fail whole expressions, and both
  // are rewritten here to text of the same length (ADR 0022):
  // - `&raw` read as the start of a raw borrow (`&raw const x`) even when `raw` is a variable — 39 of
  //   the 44 files of #80's dev material it could not read;
  // - Rust 2024's `unsafe extern "C" { … }`, read as `extern "C" { … }` with `unsafe` blanked.
  // Every position is therefore the file's, and every name is read from the file, never from the tree.
  const parseText = source
    .replace(RAW_BORROW, (_m, space: string) => `&${space}rAw`)
    .replace(UNSAFE_EXTERN, (_m, space: string) => `      ${space}extern`);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const position = (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - (lineStarts[lo] as number) };
  };

  const result: ParsedRust = { functions: [], calls: [], items: [], unread: [], macrosNotRead: 0, macrosUnreadAt: [], uses: [], mods: [], bindings: [] };
  const spanOf = (n: Node, w: Walk): Span => ({ startLine: position(w.offset(n.startIndex)).line, endLine: position(w.offset(Math.max(n.startIndex, n.endIndex - 1))).line });
  /** A node's text in the file, not in what the parser was given. */
  const textIn = (w: Walk) => (n: Node) => source.slice(w.offset(n.startIndex), w.offset(n.endIndex));

  const walk = (root: Node, w: Walk, fnIndex: number | null, testOnly: boolean) => {
    // Explicit stack: a generated file can nest deeper than the call stack allows.
    const stack: { node: Node; fn: number | null; test: boolean }[] = [{ node: root, fn: fnIndex, test: testOnly }];
    while (stack.length > 0) {
      const { node, fn, test } = stack.pop()!;
      if (node.isError && !w.inMacro) {
        const start = position(w.offset(node.startIndex));
        const end = position(w.offset(Math.max(node.startIndex, node.endIndex - 1)));
        result.unread.push({ startLine: start.line, endLine: end.line });
        continue;
      }
      let nextFn = fn;
      let nextTest = test;
      const isItem = node.type === "function_item" || node.type === "function_signature_item" || ITEM_TYPES.has(node.type);
      if (isItem && !w.inMacro) {
        const start = position(w.offset(node.startIndex)).line;
        const end = position(w.offset(Math.max(node.startIndex, node.endIndex - 1))).line;
        // Test code: nothing in it is listed (`RustFunction.testOnly`, and no call is read).
        if (!test && testOnlyAttributes(attributesOf(node, textIn(w)))) nextTest = true;
        if (node.type === "function_item" || node.type === "function_signature_item") {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const nameLine = position(w.offset(nameNode.startIndex)).line;
            result.functions.push({ name: textIn(w)(nameNode).replace(/^r#/, ""), startLine: nameLine, endLine: end, testOnly: nextTest });
            nextFn = result.functions.length - 1;
          }
        } else {
          const nameNode = node.childForFieldName("name") ?? node.childForFieldName("type");
          result.items.push({ startLine: start, endLine: end, ...(nameNode ? { name: textIn(w)(nameNode) } : {}) });
        }
      }
      if (node.type === "call_expression" && nextFn !== null && !nextTest) readCall(node, w, nextFn);
      if (!nextTest) readBindings(node, w);
      if (node.type === "use_declaration" && !w.inMacro) readUse(node, w);
      if (node.type === "mod_item" && !w.inMacro) {
        const body = node.childForFieldName("body");
        if (body) result.mods.push({ ...spanOf(body, w), superGlob: false });
      }
      if (node.type === "macro_invocation") {
        let read = false;
        if (nextFn !== null && !nextTest) read = readMacro(node, w, nextFn);
        // Outside every function (`cfg_if! { … fn plat() { … } }` at the top of a file, a macro in an
        // `impl`): not read, and counted like any macro not read, so its calls are not gone unsaid.
        else if (!nextTest && !w.inMacro) {
          const tokens = node.namedChildren.find((c) => c.type === "token_tree");
          if (tokens && CALL_SHAPE.test(textIn(w)(tokens))) result.macrosNotRead += 1;
        }
        if (!read && !nextTest) result.macrosUnreadAt.push(spanOf(node, w));
        continue;
      }
      // A token the parser supplied because the file lacks it (`a(1;`, a `)` missing from a signature):
      // an unnamed node, so it is looked for among all the children. Its line is not read as written.
      if (!w.inMacro) {
        for (const c of node.children) {
          if (!c?.isMissing) continue;
          const at = position(w.offset(c.startIndex)).line;
          result.unread.push({ startLine: at, endLine: at });
        }
      }
      const children = node.namedChildren;
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i] as Node, fn: nextFn, test: nextTest });
    }
  };

  /**
   * What a method call is called on, as far as it is written (#83, ADR 0027): `self`, a name, or
   * another call (by where the listing records it, so its callee can be looked up as the listing's
   * is). A field, `?`, `.await`, an index or anything else is not read. `&`, `*` and brackets are.
   */
  const receiverOf = (value: Node | null, w: Walk): Receiver => {
    let n = value;
    while (n && (n.type === "parenthesized_expression" || n.type === "reference_expression" || (n.type === "unary_expression" && textIn(w)(n).trimStart().startsWith("*")))) {
      n = n.type === "reference_expression" ? n.childForFieldName("value") : (n.namedChildren.at(-1) ?? null);
    }
    if (!n) return { kind: "unread" };
    if (n.type === "self") return { kind: "self" };
    if (n.type === "identifier") return { kind: "name", name: textIn(w)(n).replace(/^r#/, "") };
    // An enum's variant (`Fuel::AddFile.consume(…)`): a value of the enum. CamelCase only — an
    // associated constant (`Foo::MAX.len()`) is some other type.
    if (n.type === "scoped_identifier") {
      const names = pathNames(n, textIn(w));
      if (names && names.length >= 2 && /^[A-Z][a-z]/.test(names.at(-1)!) && /^[A-Z]/.test(names.at(-2)!)) return { kind: "type", path: names.slice(0, -1) };
    }
    if (n.type === "call_expression") {
      const place = callPlace(n, w);
      if (place && place.callee !== "") return { kind: "call", line: place.line, startColumn: place.startColumn };
    }
    return { kind: "unread" };
  };

  /** Where a call is, as the listing records it: its callee, the line and column of its last name, where it starts. */
  const callPlace = (node: Node, w: Walk) => {
    const func = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (!func || !args) return null;
    const text = textIn(w);
    let callee = "";
    let nameNode: Node | null = null;
    let exprStartNode: Node = func;
    const inner = func.type === "generic_function" ? func.childForFieldName("function") : func;
    if (inner?.type === "field_expression") {
      nameNode = inner.childForFieldName("field");
      callee = nameNode ? text(nameNode).replace(/^r#/, "") : "";
      if (nameNode) exprStartNode = nameNode;
    } else if (inner) {
      const names = pathNames(inner, text);
      if (names) {
        callee = names.join("::");
        nameNode = inner.type === "scoped_identifier" ? inner.childForFieldName("name") : inner;
        // From where the callee is written: `a::b::foo(…)`, and `<T as Trait>::g(…)` from the `<`.
        exprStartNode = inner;
      }
    }
    const at = nameNode ?? args;
    const p = position(w.offset(at.startIndex));
    // The listing's column is where the name starts, after an `r#`.
    const column = p.column + (nameNode && text(nameNode).startsWith("r#") ? 2 : 0);
    // Where the callee is written, on the name's line; a callee that is not a name keeps the `(`.
    const written = nameNode ? position(w.offset(exprStartNode.startIndex)) : p;
    const startColumn = nameNode && written.line === p.line ? written.column + (text(exprStartNode).startsWith("r#") ? 2 : 0) : column;
    return { line: p.line, column, startColumn, callee, exprStart: w.offset(exprStartNode.startIndex), exprEnd: w.offset(args.endIndex), method: inner?.type === "field_expression" ? inner : null };
  };

  const readCall = (node: Node, w: Walk, fn: number) => {
    const place = callPlace(node, w);
    if (!place) return;
    const { method, ...at } = place;
    result.calls.push({ fn, ...at, inMacro: w.inMacro, ...(method ? { receiver: receiverOf(method.childForFieldName("value"), w) } : {}) });
  };

  /** The names a pattern binds: every identifier in it. */
  const patternNames = (pattern: Node | null, w: Walk): string[] => {
    if (!pattern) return [];
    if (pattern.type === "identifier") return [textIn(w)(pattern).replace(/^r#/, "")];
    const out: string[] = [];
    const stack = [pattern];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === "identifier") out.push(textIn(w)(n).replace(/^r#/, ""));
      for (const c of n.namedChildren) if (c) stack.push(c);
    }
    return out;
  };

  /**
   * What a function binds a name to, and where (#83): a parameter or a `let` with its written type,
   * or a `let` with the call or name it is set from; anything else — a closure's parameter, `for`,
   * `if let`, a match arm, a pattern — as not read, so it hides the names outside it.
   */
  const readBindings = (node: Node, w: Walk) => {
    const span = (n: Node): Span => spanOf(n, w);
    const unread = (names: string[], scope: Span) => {
      for (const name of names) result.bindings.push({ name, scope, unread: true });
    };
    switch (node.type) {
      case "function_item": {
        const body = node.childForFieldName("body");
        if (!body) return;
        for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
          if (p?.type !== "parameter") continue;
          const pattern = p.childForFieldName("pattern");
          const type = p.childForFieldName("type");
          if (pattern?.type === "identifier" && type) result.bindings.push({ name: textIn(w)(pattern).replace(/^r#/, ""), scope: span(body), type: textIn(w)(type) });
          else unread(patternNames(pattern, w), span(body));
        }
        return;
      }
      case "closure_expression":
        unread(patternNames(node.childForFieldName("parameters"), w), span(node));
        return;
      case "let_declaration": {
        // In force from the line after the statement (`let x = x.clone();` reads the `x` before it), to
        // the end of the block it is in.
        const block = node.parent;
        if (!block) return;
        const scope = { startLine: span(node).endLine + 1, endLine: span(block).endLine };
        const pattern = node.childForFieldName("pattern");
        const type = node.childForFieldName("type");
        const value = node.childForFieldName("value");
        if (pattern?.type !== "identifier") return unread(patternNames(pattern, w), scope);
        const name = textIn(w)(pattern).replace(/^r#/, "");
        if (type) result.bindings.push({ name, scope, type: textIn(w)(type) });
        else if (value) result.bindings.push({ name, scope, value: receiverOf(value, w) });
        else result.bindings.push({ name, scope, unread: true });
        return;
      }
      case "for_expression":
        unread(patternNames(node.childForFieldName("pattern"), w), span(node));
        return;
      case "let_condition":
      case "match_arm":
        unread(patternNames(node.childForFieldName("pattern"), w), span(node.type === "let_condition" ? (node.parent ?? node) : node));
        return;
    }
  };

  /** The names a `use` brings in, each with the block the `use` is written in. */
  const readUse = (node: Node, w: Walk) => {
    const text = textIn(w);
    let block: Node | null = node.parent;
    while (block && block.type !== "source_file" && block.type !== "declaration_list" && block.type !== "block") block = block.parent;
    const scope: Span = block && block.type !== "source_file" ? spanOf(block, w) : { startLine: 1, endLine: lineStarts.length };
    const bind = (name: string, path: string[], glob = false) => {
      if (name === "_" && !glob) return;
      result.uses.push({ name, path, ...(glob ? { glob: true as const } : {}), scope });
    };
    const expand = (n: Node, prefix: string[]) => {
      switch (n.type) {
        case "use_as_clause": {
          const path = n.childForFieldName("path");
          const alias = n.childForFieldName("alias");
          const names = path ? pathNames(path, text) : null;
          // `use std::fs::{self as sfs};` brings `sfs` as `std::fs`.
          const full = names ? [...prefix, ...names] : null;
          if (full && alias) bind(text(alias), full.at(-1) === "self" && full.length > 1 ? full.slice(0, -1) : full);
          return;
        }
        case "scoped_use_list": {
          const path = n.childForFieldName("path");
          const list = n.childForFieldName("list");
          const names = path ? (pathNames(path, text) ?? []) : [];
          if (list) expand(list, [...prefix, ...names]);
          return;
        }
        case "use_list":
          for (const c of n.namedChildren) if (c) expand(c, prefix);
          return;
        case "use_wildcard": {
          const inner = n.namedChildren[0];
          bind("*", [...prefix, ...(inner ? (pathNames(inner, text) ?? []) : [])], true);
          return;
        }
        default: {
          const names = pathNames(n, text);
          if (!names) return;
          const full = [...prefix, ...names];
          // `use std::fs::{self}` brings `fs`.
          if (full.at(-1) === "self" && full.length > 1) bind(full.at(-2)!, full.slice(0, -1));
          else bind(full.at(-1)!, full);
        }
      }
    };
    const argument = node.childForFieldName("argument");
    if (argument) expand(argument, []);
  };

  /** Whether the macro's arguments were read as calls. */
  const readMacro = (node: Node, w: Walk, fn: number): boolean => {
    const tokens = node.namedChildren.find((c) => c.type === "token_tree");
    if (!tokens) return false;
    if (!CALL_SHAPE.test(textIn(w)(tokens))) return false;
    const macro = node.childForFieldName("macro");
    const name = macro ? (textIn(w)(macro).split("::").pop() ?? "").trim() : "";
    // Read again from what the parser was given, so a `&raw` inside is treated as it is outside.
    const text = parseText.slice(w.offset(tokens.startIndex), w.offset(tokens.endIndex));
    if (NOT_EXPRESSION_MACROS.has(name)) {
      result.macrosNotRead += 1;
      return false;
    }
    // The arguments, read again as an expression: `vec![x; n]` as an array, the rest as arguments.
    const inside = text.slice(1, -1);
    const prefix = name === "vec" ? "fn __m() { let _ = [" : "fn __m() { __m(";
    const suffix = name === "vec" ? "]; }" : "); }";
    const wrapped = parser.parse(prefix + inside + suffix);
    if (!wrapped) {
      result.macrosNotRead += 1;
      return false;
    }
    try {
      // All or nothing: a macro whose arguments do not read as an expression is not read at all.
      if (wrapped.rootNode.hasError) {
        result.macrosNotRead += 1;
        return false;
      }
      const base = w.offset(tokens.startIndex + 1) - prefix.length;
      const body = wrapped.rootNode.namedChildren[0]?.childForFieldName("body");
      // Only what the macro was given: `let _ = [ … ]`'s array, or `__m( … )`'s arguments — the
      // wrapper's own call to `__m` is not a call in the file.
      const statement = body?.namedChildren[0];
      const given = name === "vec" ? statement?.childForFieldName("value") : statement?.namedChildren[0]?.childForFieldName("arguments");
      if (!given) {
        result.macrosNotRead += 1;
        return false;
      }
      walk(given, { offset: (i) => base + i, inMacro: true }, fn, false);
      return true;
    } finally {
      wrapped.delete();
    }
  };

  const tree = parser.parse(parseText);
  if (!tree) {
    result.unread.push({ startLine: 1, endLine: lineStarts.length });
    return result;
  }
  try {
    walk(tree.rootNode, { offset: (i) => i, inMacro: false }, null, false);
    // A `mod` writing `use super::*` in its own body reaches the `use`s outside it (`importOf`).
    for (const m of result.mods) m.superGlob = result.uses.some((u) => u.glob && u.path.join("::") === "super" && u.scope.startLine === m.startLine && u.scope.endLine === m.endLine);
    for (const top of tree.rootNode.namedChildren) {
      if (top.isError || top.type === "function_item" || top.type === "function_signature_item" || ITEM_TYPES.has(top.type) || top.type.endsWith("comment")) continue;
      result.items.push({ startLine: position(top.startIndex).line, endLine: position(Math.max(top.startIndex, top.endIndex - 1)).line });
    }
  } finally {
    tree.delete();
  }
  // Nothing inside what the parser could not read is listed, whatever it looked like: not a call, and
  // not a function whose name is there. The parser's recovery can also stretch the function around
  // such a place over what follows — the next function's body — so the lines of a function whose name
  // was not read are a hole in the function around it (#83's reviews). A call left in no listed function is not
  // dropped unsaid: its line is added to what was not read.
  if (result.unread.length > 0) {
    const inUnread = (line: number) => result.unread.some((u) => line >= u.startLine && line <= u.endLine);
    const dropped = result.functions.filter((f) => inUnread(f.startLine));
    const kept = new Map<number, number>();
    const listed: RustFunction[] = [];
    const holes: Span[][] = [];
    result.functions.forEach((f, i) => {
      if (inUnread(f.startLine)) return;
      // The dropped function's lines are a hole in this one: a call there is not this function's, and a
      // call after it still is.
      holes.push(dropped.filter((d) => d.startLine > f.startLine && d.startLine <= f.endLine));
      kept.set(i, listed.length);
      listed.push(f);
    });
    result.functions = listed;
    const contains = (i: number, line: number) => line >= listed[i]!.startLine && line <= listed[i]!.endLine && !holes[i]!.some((h) => line >= h.startLine && line <= h.endLine);
    const around = (line: number) => {
      let best: number | undefined;
      listed.forEach((f, i) => {
        if (!contains(i, line)) return;
        const b = best === undefined ? undefined : listed[best]!;
        if (!b || f.endLine - f.startLine < b.endLine - b.startLine) best = i;
      });
      return best;
    };
    const orphans: number[] = [];
    result.calls = result.calls.flatMap((c) => {
      if (inUnread(c.line)) return [];
      const own = kept.get(c.fn);
      // `unsafe { geteuid() }` below an `extern` block the parser could not read is still the call of
      // the function it is written in.
      const fn = own !== undefined && contains(own, c.line) ? own : around(c.line);
      if (fn === undefined) {
        orphans.push(c.line);
        return [];
      }
      return listed[fn]!.testOnly ? [] : [{ ...c, fn }];
    });
    for (const line of new Set(orphans)) result.unread.push({ startLine: line, endLine: line });
  }
  return result;
}

/**
 * The path a name is brought in by at `line`: the `use` written in the innermost block around the line
 * that brings it (a `mod x { … }` is not reached by a `use` outside it unless it writes `use super::*`).
 * Null when no `use` brings it, or when two in the same block bring it by different paths. Globs bring
 * no name here (#83).
 */
export function importOf(parsed: Pick<ParsedRust, "uses" | "mods">, line: number, name: string): string[] | null {
  const inside = (s: Span) => line >= s.startLine && line <= s.endLine;
  const size = (s: Span) => s.endLine - s.startLine;
  // The innermost `mod` a `use` outside cannot reach into: the first, going out, without `use super::*`.
  const boundary = parsed.mods
    .filter(inside)
    .sort((a, b) => size(a) - size(b))
    .find((m) => !m.superGlob);
  const found = parsed.uses.filter(
    (u) => !u.glob && u.name === name && inside(u.scope) && (!boundary || (u.scope.startLine >= boundary.startLine && u.scope.endLine <= boundary.endLine)),
  );
  if (found.length === 0) return null;
  const innermost = Math.min(...found.map((u) => size(u.scope)));
  const paths = new Set(found.filter((u) => size(u.scope) === innermost).map((u) => u.path.join("::")));
  return paths.size === 1 ? [...paths][0]!.split("::") : null;
}
