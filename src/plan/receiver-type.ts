// The type a method call is made on, read only as far as it is written (#83, ADR 0027).
//
// A method call whose name is also a method of the standard library (`len`, `clone`, `map_err`) is
// kept on the definition the name reading chose only when what it is called on is one of this
// repository's types and the definition is in that type's `impl`. So the question here is narrow:
// is the receiver, as written, a type of this crate — and which one. Anything this cannot read is
// `null`, which holds the call: nothing is settled that the name reading had not settled already.
//
// Read: `self` (the `impl` the call is in), a name bound by a parameter or `let` with a written type,
// a `let` set from a call or a name, and a call (its definition's written return type) — to a depth
// of three. Not read: fields, `?`, `.await`, indexes, closure parameters and patterns, and any type
// a wrapper holds (`Arc<Foo>`'s `clone` is `Arc`'s).

import type { Discoverer } from "../discovery/discover.ts";
import { importOf, type Binding, type ParsedRust, type Receiver } from "../syntax/rust.ts";
import type { FunctionCandidate } from "./candidates.ts";
import { itemHead, returnTypesFor } from "./result-type.ts";

/** Types a method passes through to what they hold only sometimes; what they are called on is not read past them. */
const WRAPPERS = new Set(["Box", "Rc", "Arc", "Cow", "RefCell", "Cell", "Mutex", "RwLock", "Pin", "MutexGuard", "RwLockReadGuard", "RwLockWriteGuard", "Ref", "RefMut", "Weak"]);

/** How deep a receiver is followed through calls and `let`s. */
const DEPTH = 3;

/** Paths that name this repository's own code. */
const INSIDE = new Set(["crate", "self", "super", "Self"]);

export interface ReceiverContext {
  discoverer: Discoverer;
  fn: FunctionCandidate;
  /** The line the call is on: which bindings are in force. */
  line: number;
  parsed: ParsedRust;
  /** The definition a listed call at `line`/`startColumn` settles to, one only, or null. */
  settle: (line: number, startColumn: number, depth: number) => Promise<{ path: string; line: number; name: string } | null>;
}

/** The binding of a name in force at a line: the latest to begin, then the narrowest. */
export function bindingAt(bindings: readonly Binding[], name: string, line: number): Binding | undefined {
  let best: Binding | undefined;
  for (const b of bindings) {
    if (b.name !== name || line < b.scope.startLine || line > b.scope.endLine) continue;
    if (!best || b.scope.startLine > best.scope.startLine || (b.scope.startLine === best.scope.startLine && b.scope.endLine - b.scope.startLine < best.scope.endLine - best.scope.startLine)) best = b;
  }
  return best;
}

/** The written type's head path (`&mut CostContext<T>` → `["CostContext"]`), or null for what has none (`impl Trait`, `dyn T`, a tuple, a slice). */
export function headPath(type: string): string[] | null {
  const t = stripRefs(type);
  if (/^(dyn|impl)\b/.test(t) || !/^[A-Za-z_]/.test(t)) return null;
  return pathOf(t);
}

/** A written type past its references, lifetimes and `mut` (`&'a mut X` → `X`). */
function stripRefs(type: string): string {
  let t = type.trim();
  for (;;) {
    const next = t.replace(/^&\s*('\w+\s+)?(mut\s+)?/, "").replace(/^'\w+\s+/, "").trim();
    if (next === t) return t;
    t = next;
  }
}

/** The path a type begins with (`a::B<C>` → `["a", "B"]`), or null. */
function pathOf(t: string): string[] | null {
  const path = /^((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)/.exec(t)?.[1];
  return path ? path.split("::").map((s) => s.trim()) : null;
}

/**
 * The name of the repository type a receiver is, or null. The names an `impl` may be written for
 * under — the type and what an alias of it names — are `namesOf`'s.
 */
export async function receiverType(receiver: Receiver, ctx: ReceiverContext, depth = 0): Promise<string | null> {
  if (depth >= DEPTH) return null;
  const reader = returnTypesFor(ctx.discoverer);
  switch (receiver.kind) {
    case "self":
      return implSelf(ctx.fn.path, ctx.fn.startLine, ctx);
    case "name": {
      const b = bindingAt(ctx.parsed.bindings, receiver.name, ctx.line);
      if (!b || b.unread) return null;
      if (b.type) return typeFromText(b.type, ctx.fn.path, ctx.line, ctx);
      return b.value ? receiverType(b.value, ctx, depth + 1) : null;
    }
    case "call": {
      const def = await ctx.settle(receiver.line, receiver.startColumn, depth + 1);
      if (!def) return null;
      const signature = await reader.signature(def.path, def.line, def.name);
      if (!signature.ok) return null;
      const head = headPath(signature.returns);
      if (!head || signature.generics.has(head[0]!)) return null;
      if (head.length === 1 && head[0] === "Self") return implSelf(def.path, def.line, ctx);
      return typeFromText(signature.returns, def.path, def.line, ctx);
    }
    case "type":
      // A value written as `Enum::Variant`: of the enum, `Self` being the `impl`'s.
      return receiver.path.length === 1 && receiver.path[0] === "Self" ? receiverType({ kind: "self" }, ctx, depth) : typeFromText(receiver.path.join("::"), ctx.fn.path, ctx.line, ctx);
    case "unread":
      return null;
  }
}

/**
 * The trait a receiver is written as — `dyn T` or `impl T`, past `&`, `Box`, `Rc` and `Arc` — when `T`
 * is a trait of this repository, or null (#37, ADR 0028). Read as far as `receiverType` reads: a
 * parameter or `let` with a written type, a `let` set from a call or a name, a call's written return type.
 */
export async function receiverTrait(receiver: Receiver, ctx: ReceiverContext, depth = 0): Promise<string | null> {
  if (depth >= DEPTH) return null;
  switch (receiver.kind) {
    case "name": {
      const b = bindingAt(ctx.parsed.bindings, receiver.name, ctx.line);
      if (!b || b.unread) return null;
      if (b.type) return traitFromText(b.type, ctx.fn.path, ctx.line, ctx);
      return b.value ? receiverTrait(b.value, ctx, depth + 1) : null;
    }
    case "call": {
      const def = await ctx.settle(receiver.line, receiver.startColumn, depth + 1);
      if (!def) return null;
      const signature = await returnTypesFor(ctx.discoverer).signature(def.path, def.line, def.name);
      return signature.ok ? traitFromText(signature.returns, def.path, def.line, ctx) : null;
    }
    default:
      return null;
  }
}

/** The trait path a written type names as `dyn T` or `impl T` (`&Arc<dyn T + Send>` → `["T"]`), or null for any other type. */
export function writtenTrait(type: string): string[] | null {
  let t = type.trim();
  for (;;) {
    const bare = stripRefs(t);
    const held = /^(?:(?:std|alloc)::(?:boxed|rc|sync)::)?(?:Box|Rc|Arc)\s*<([\s\S]*)>$/.exec(bare)?.[1]?.trim() ?? bare;
    if (held === t) break;
    t = held;
  }
  const path = /^(?:dyn|impl)\s+(.*)$/s.exec(t)?.[1];
  return path ? pathOf(path) : null;
}

/** The name when it is one of this repository's; whether a `trait` of it declares the method is the caller's to find. */
async function traitFromText(type: string, file: string, line: number, ctx: ReceiverContext): Promise<string | null> {
  const path = writtenTrait(type);
  return path ? repositoryType(path, file, line, ctx) : null;
}

/** `Self` at `file`:`line`: the type of the `impl` around it, when that is one of this repository's. */
async function implSelf(file: string, line: number, ctx: ReceiverContext): Promise<string | null> {
  const enclosing = await returnTypesFor(ctx.discoverer).enclosing(file, line);
  if (enclosing.kind !== "item") return null;
  const head = itemHead(enclosing.text);
  // `impl Trait for T` with a generic `T` is no type of this crate's; `repositoryType` says so.
  return head.kind === "impl" && head.self ? repositoryType([head.self], file, line, ctx) : null;
}

async function typeFromText(type: string, file: string, line: number, ctx: ReceiverContext): Promise<string | null> {
  const head = headPath(type);
  if (!head) return null;
  if (WRAPPERS.has(head.at(-1)!)) return null;
  return repositoryType(head, file, line, ctx);
}

/**
 * The name when a type written `path` at `file`:`line` is one of this repository's: from the file's own
 * crate (`crate`/`self`/`super`, or no `use` bringing the name from elsewhere — a glob from
 * elsewhere counts), or from another crate of this workspace (`use grovedb_costs::CostContext`) — and
 * defined in that crate. Anything else — std's, a dependency's, unknown — is null.
 */
async function repositoryType(path: string[], file: string, line: number, ctx: ReceiverContext, seen: ReadonlySet<string> = new Set()): Promise<string | null> {
  const name = path.at(-1)!;
  const parsed = file === ctx.fn.path ? ctx.parsed : (await ctx.discoverer.index(file))?.rust;
  if (!parsed) return null;
  // The crate the type's first name comes from: this file's, a workspace member's, or none known.
  const from = async (first: string): Promise<string | null> => (INSIDE.has(first) ? crateOf(file) : workspaceCrate(first, ctx.discoverer));
  let crate: string | null;
  if (path.length > 1) {
    const brought = importOf(parsed, line, path[0]!);
    crate = await from(brought ? brought[0]! : path[0]!);
  } else {
    const brought = importOf(parsed, line, name);
    if (brought) crate = await from(brought[0]!);
    else {
      const inside = (s: { startLine: number; endLine: number }) => line >= s.startLine && line <= s.endLine;
      if (parsed.uses.some((u) => u.glob && inside(u.scope) && !INSIDE.has(u.path[0]!))) return null;
      crate = crateOf(file);
    }
  }
  const kinds = crate === null ? null : await definedIn(name, crate, ctx.discoverer);
  if (!kinds || kinds.size === 0) return null;
  // Only an alias — no `struct`, `enum`, `union` or `trait` of the name in the crate — is this
  // repository's only when what it names is (`type Nodes = Vec<Node>` is a `Vec`), and not when it comes
  // back to a name already followed (`type Error = crate::error::Error;`). An associated type written
  // `type ValidatorSet = ValidatorSet;` beside a `struct ValidatorSet` is the struct.
  const alias = kinds.size === 1 && kinds.has("type") ? await returnTypesFor(ctx.discoverer).aliasTarget(name) : undefined;
  if (alias) {
    const head = headPath(alias.rhs);
    if (!head || WRAPPERS.has(head.at(-1)!) || seen.has(head.at(-1)!) || (await repositoryType(head, alias.path, alias.line, ctx, new Set([...seen, name]))) === null) return null;
  }
  return name;
}

/** The keywords a type or trait of the name is defined with under `crate` (`struct`, `type`, …): empty when none. */
async function definedIn(name: string, crate: string, discoverer: Discoverer): Promise<Set<string>> {
  const defs = await returnTypesFor(discoverer).typeDefinitions(name);
  return new Set(defs === "cut" ? [] : defs.filter((d) => d.path.startsWith(crate)).map((d) => d.keyword));
}

const workspaceCrates = new WeakMap<Discoverer, Map<string, Promise<string | null>>>();

/**
 * Where a crate of this repository named `ident` (`grovedb_costs`) keeps its sources: the directory of
 * the `Cargo.toml` whose `name` is it (with `-` for `_`), plus `src/`. Null when this repository has
 * no such crate — a dependency.
 */
function workspaceCrate(ident: string, discoverer: Discoverer): Promise<string | null> {
  let cache = workspaceCrates.get(discoverer);
  if (!cache) workspaceCrates.set(discoverer, (cache = new Map()));
  let found = cache.get(ident);
  if (!found) {
    found = (async () => {
      for (const written of new Set([ident, ident.replace(/_/g, "-")])) {
        const { hits } = await discoverer.search(written);
        const manifest = hits.find((h) => (h.path === "Cargo.toml" || h.path.endsWith("/Cargo.toml")) && new RegExp(`^\\s*name\\s*=\\s*"${written}"`).test(h.text));
        if (manifest) return `${manifest.path.slice(0, -"Cargo.toml".length)}src/`;
      }
      return null;
    })();
    cache.set(ident, found);
  }
  return found;
}

/**
 * Where a file's crate begins: everything up to its `src/`. A path with none — `examples/demo.rs`,
 * or a crate laid out without one — falls back to the file's own directory, never to the whole
 * repository, or a workspace's other crates come back in.
 */
export function crateOf(path: string): string {
  const at = path.lastIndexOf("/src/");
  if (at >= 0) return path.slice(0, at + "/src/".length);
  if (path.startsWith("src/")) return "src/";
  const directory = path.lastIndexOf("/");
  return directory >= 0 ? path.slice(0, directory + 1) : "";
}

/** The names an `impl` for this type may be written under: the type and, when it is an alias, what the alias names. */
export async function namesOf(name: string, discoverer: Discoverer): Promise<Set<string>> {
  const names = new Set([name]);
  const target = await returnTypesFor(discoverer).aliasTarget(name);
  const head = target && headPath(target.rhs);
  if (head) names.add(head.at(-1)!);
  return names;
}
