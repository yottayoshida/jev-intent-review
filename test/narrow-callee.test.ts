// Which definition a call reaches when its name is defined more than once: the path the call
// writes, the form of the call, and definitions that are versions of one thing. No model, no
// network: a repository made of strings.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { applicabilityOf, declaredForTestsOnly, functionDefinitionsOf } from "../src/plan/applicability.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { enclosingItem, itemHead } from "../src/plan/result-type.ts";

/** A repository of files. */
function repo(files: Record<string, string>): Discoverer {
  return {
    async search(words: string) {
      const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
      const hits = Object.entries(files).flatMap(([path, text]) => text.split("\n").flatMap((line, i) => (re.test(line) ? [{ path, line: i + 1, text: line }] : [])));
      return { hits, more: false };
    },
    async index(path: string) {
      return files[path] ? new BlockIndex(files[path]!.split("\n")) : null;
    },
  } as unknown as Discoverer;
}

/** The applicability of the one call to `callee` in `caller`, in a repository of these files. */
async function decide(files: Record<string, string>, path: string, caller: string, callee: string) {
  const candidates = enumerate(path, files[path]!);
  const fn = candidates.functions.find((f) => f.name === caller)!;
  assert.ok(fn, `fn ${caller} is a candidate`);
  const call = candidates.calls.find((c) => c.functionId === fn.id && c.callee.split("::").pop() === callee.split("::").pop())!;
  assert.ok(call, `${callee} is a call in ${caller}`);
  return applicabilityOf(repo(files), fn, call);
}

const CALLER = `use crate::sync::SyncState;\n\npub fn cmd_pull(root: &Path) -> Result<(), E> {\n    let state = SyncState::load_strict(root)?;\n    Ok(())\n}\n`;

test("(a) the type a call writes picks the definition inside that type's impl", async () => {
  const files = {
    "src/cmd.rs": CALLER,
    "src/sync.rs": `pub struct SyncState;\n\nimpl SyncState {\n    pub fn load_strict(root: &Path) -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
    "src/knowledge.rs": `pub struct KnowledgeSyncState;\n\nimpl KnowledgeSyncState {\n    pub fn load_strict(root: &Path) -> u8 {\n        0\n    }\n}\n`,
  };
  const r = await decide(files, "src/cmd.rs", "cmd_pull", "SyncState::load_strict");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "src/sync.rs:4", "the one under `impl SyncState`, not the other");
});

test("(b) an impl header is read whether it is generic or for a trait, and a trait's bound is not a where clause", () => {
  const lines = ["impl<T> Store<T> {", "    fn a() {}", "}", "impl Reader for Store<u8> {", "    fn b() {}", "}", "pub trait Reader: Send {", "    fn c() {}", "}"];
  assert.deepEqual(itemHead(enclosingItem(lines, 2).kind === "item" ? (enclosingItem(lines, 2) as { text: string }).text : ""), { kind: "impl", self: "Store" });
  assert.deepEqual(itemHead((enclosingItem(lines, 5) as { text: string }).text), { kind: "impl", trait: "Reader", self: "Store" });
  assert.deepEqual(itemHead((enclosingItem(lines, 8) as { text: string }).text), { kind: "trait", name: "Reader" });
  // `->` is one token: the `>` of a returning function type closes no generic list.
  assert.deepEqual(itemHead("impl Callback<fn() -> T> for Handler {"), { kind: "impl", trait: "Callback", self: "Handler" });
});

test("(c) `Self::` picks the definition in the impl the call is written in", async () => {
  const files = {
    "src/sync.rs": `impl SyncState {\n    pub fn load_strict(root: &Path) -> Result<Self, E> {\n        let p = Self::path(root)?;\n        todo!()\n    }\n\n    fn path(root: &Path) -> Result<PathBuf, E> {\n        todo!()\n    }\n}\n`,
    "src/other.rs": `impl Other {\n    fn path(root: &Path) -> u8 {\n        0\n    }\n}\n`,
  };
  const r = await decide(files, "src/sync.rs", "load_strict", "Self::path");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "src/sync.rs:7");
});

test("(d) a module a call writes picks the definition in that module's file", async () => {
  const files = {
    "src/commands/mod.rs": `pub mod install;\n\npub fn execute(args: Args) -> Result<(), E> {\n    install::add_package(args)?;\n    Ok(())\n}\n`,
    "src/commands/install.rs": `pub fn add_package(args: Args) -> Result<(), E> {\n    todo!()\n}\n`,
    "src/other.rs": `pub fn add_package(args: Args) -> u8 {\n    0\n}\n`,
  };
  const r = await decide(files, "src/commands/mod.rs", "execute", "install::add_package");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "src/commands/install.rs:1");
});

test("(e) a path that matches no definition is held, and is never reported as having none", async () => {
  const files = {
    "src/cmd.rs": `pub fn run() -> Result<(), E> {\n    let e = ChannelError::invalid_input("no")?;\n    Ok(())\n}\n`,
    // What the call names is `Error` under `use moltis_channels::Error as ChannelError`, which is
    // not followed, and a second definition keeps the name from resolving by itself.
    "src/error.rs": `impl Error {\n    pub fn invalid_input(message: &str) -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
    "src/media.rs": `impl MediaError {\n    pub fn invalid_input(message: &str) -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(files, "src/cmd.rs", "run", "ChannelError::invalid_input");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "callee_ambiguous");
    assert.match(r.reason, /none of them is written under `ChannelError`/);
    assert.match(r.reason, /re-exported from another file is not followed/);
    assert.doesNotMatch(r.reason, /has no definition in this repository/, "not narrowed is not the same as not defined");
  }
});

const TRAIT_CALLER = `pub async fn analyze(connector: &mut Box<dyn DatabaseConnector>, query: &str) -> Result<u64, E> {\n    let n = connector.count_rows(query).await?;\n    Ok(n)\n}\n`;

test("(f) a trait's method is settled by every definition the call can reach, and one that is not a Result holds it", async () => {
  const all = {
    "src/db.rs": `${TRAIT_CALLER}\npub trait DatabaseConnector: Send {\n    async fn count_rows(&mut self, query: &str) -> Result<u64, E>;\n}\n`,
    "src/mysql.rs": `impl DatabaseConnector for MySql {\n    async fn count_rows(&mut self, query: &str) -> Result<u64, E> {\n        todo!()\n    }\n}\n`,
    "src/sqlite.rs": `impl DatabaseConnector for Sqlite {\n    async fn count_rows(&mut self, query: &str) -> Result<u64, E> {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(all, "src/db.rs", "analyze", "count_rows");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "src/db.rs:7", "the declaration is what the call names");

  const odd = { ...all, "src/sqlite.rs": `impl DatabaseConnector for Sqlite {\n    async fn count_rows(&mut self, query: &str) -> u64 {\n        0\n    }\n}\n` };
  const held = await decide(odd, "src/db.rs", "analyze", "count_rows");
  assert.equal(held.ok, false);
  if (!held.ok) {
    assert.equal(held.kind, "callee_ambiguous");
    assert.match(held.reason, /src\/sqlite\.rs:2\) returns `u64` and does not return a Result/);
  }
});

test("(g) a name two traits declare, and one no trait declares, stay held", async () => {
  const twoTraits = {
    "src/db.rs": `${TRAIT_CALLER}\npub trait DatabaseConnector: Send {\n    async fn count_rows(&mut self, query: &str) -> Result<u64, E>;\n}\n`,
    "src/mysql.rs": `impl DatabaseConnector for MySql {\n    async fn count_rows(&mut self, query: &str) -> Result<u64, E> {\n        todo!()\n    }\n}\n`,
    "src/counter.rs": `pub trait Counter {\n    fn count_rows(&mut self, query: &str) -> Result<u64, E>;\n}\n`,
  };
  const r = await decide(twoTraits, "src/db.rs", "analyze", "count_rows");
  assert.equal(r.ok, false, "two traits of this repository declare it");
  if (!r.ok) assert.equal(r.kind, "callee_ambiguous");

  // `Encoder` is a dependency's trait: two implementations of it here are not a method of this
  // repository's, or every trait anything implements twice would settle a call.
  const noDeclaration = {
    "src/cmd.rs": `pub fn run(value: &Wire) -> Result<(), E> {\n    value.encode()?;\n    Ok(())\n}\n`,
    "src/wire.rs": `impl Encoder for Wire {\n    fn encode(&self) -> Result<Vec<u8>, E> {\n        todo!()\n    }\n}\n`,
    "src/frame.rs": `impl Encoder for Frame {\n    fn encode(&self) -> Result<Vec<u8>, E> {\n        todo!()\n    }\n}\n`,
  };
  const t = await decide(noDeclaration, "src/cmd.rs", "run", "encode");
  assert.equal(t.ok, false, "a trait this repository does not declare is not this repository's method");
  if (!t.ok) assert.equal(t.kind, "callee_ambiguous");
});

test("(h) one function written once per platform is settled; two helpers inside other functions are not", async () => {
  const platforms = {
    "src/audit.rs": `pub fn append(file: &File) -> Result<(), Error> {\n    flock_exclusive(file)?;\n    Ok(())\n}\n`,
    "src/lock.rs": `#[cfg(unix)]\npub fn flock_exclusive(file: &File) -> Result<(), Error> {\n    todo!()\n}\n\n#[cfg(not(unix))]\npub fn flock_exclusive(_file: &File) -> Result<(), Error> {\n    Ok(())\n}\n`,
  };
  const r = await decide(platforms, "src/audit.rs", "append", "flock_exclusive");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "src/lock.rs:2");

  const nested = {
    "src/a.rs": `pub fn run() -> Result<(), E> {\n    helper()?;\n    Ok(())\n}\n\nfn outer() -> Result<(), E> {\n    fn helper() -> Result<u8, E> {\n        Ok(0)\n    }\n    Ok(())\n}\n\nfn other() -> Result<(), E> {\n    fn helper() -> Result<u8, E> {\n        Ok(1)\n    }\n    Ok(())\n}\n`,
  };
  const inner = await decide(nested, "src/a.rs", "run", "helper");
  assert.equal(inner.ok, false, "functions inside other functions are not versions of one thing");
});

test("(i) the function above a definition inside the same impl is not its header, and one written over lines still names its type", async () => {
  const lines = ["impl Store {", "    pub fn first(&self) -> u8 {", "        0", "    }", "", "    pub fn second(&self) -> Result<(), E> {", "        Ok(())", "    }", "}"];
  const enclosing = enclosingItem(lines, 6);
  assert.equal(enclosing.kind, "item");
  if (enclosing.kind === "item") assert.equal(enclosing.text, "impl Store {");

  const split = {
    "src/cmd.rs": `pub fn run() -> Result<(), E> {\n    let s = Store::open()?;\n    Ok(())\n}\n`,
    "src/store.rs": `impl<T>\n    Reader for\n    Store<T>\n{\n    pub fn open() -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
    "src/other.rs": `impl Other {\n    pub fn open() -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(split, "src/cmd.rs", "run", "Store::open");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "src/store.rs:5", "the implementation for `Store<T>`, not the one for `Other`");
});

test("(i2) a header that never reaches its brace is not read, and narrows nothing", () => {
  const bounds = ["    T: A,", "    T: B,", "    T: C,", "    T: D,", "    T: E,", "    T: F,", "    T: G,", "    T: H,"];
  const lines = ["impl<T>", "    Reader for", "    Store<T>", "where", ...bounds, "{", "    pub fn open() -> Result<Self, E> {", "        todo!()", "    }", "}"];
  assert.equal(enclosingItem(lines, lines.indexOf("    pub fn open() -> Result<Self, E> {") + 1).kind, "unknown", "the brace is past the cap");
});

test("(j) definitions in a file declared `#[cfg(test)] mod x;` are not counted, and their absence is not reported as no definition", async () => {
  const files = {
    // The call is in another file: a `#[cfg(test)]` line makes what follows it in its own file a
    // test region already, which is a separate matter from where a module is declared.
    "src/reactor/mod.rs": `pub mod blocks;\npub mod run;\n#[cfg(test)]\nmod cluster_tests;\n`,
    "src/reactor/run.rs": `pub fn initiate(n: usize) -> Result<(), E> {\n    let c = Cluster::start(n)?;\n    Ok(())\n}\n`,
    "src/reactor/cluster_tests.rs": `impl Cluster {\n    async fn start(n: usize) -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
    "src/reactor/blocks.rs": `pub fn rollback() -> Result<(), E> {\n    Ok(())\n}\n`,
  };
  const d = repo(files);
  assert.equal(await declaredForTestsOnly(d, "src/reactor/cluster_tests.rs"), true);
  assert.equal(await declaredForTestsOnly(d, "src/reactor/blocks.rs"), false, "a module declared without the attribute is code");
  const { found, testOnly } = await functionDefinitionsOf(d, "start");
  assert.deepEqual([found.length, testOnly], [0, 1]);

  const r = await decide(files, "src/reactor/run.rs", "initiate", "Cluster::start");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "callee_ambiguous");
    assert.match(r.reason, /declared under `#\[cfg\(test\)\] mod`/);
    assert.doesNotMatch(r.reason, /has no definition in this repository/);
  }
});

test("(j2) the attribute of the declaration above, not of a declaration three lines up", async () => {
  const files = {
    "src/lib.rs": `#[cfg(test)]\nmod fixtures;\nmod store;\n`,
    "src/fixtures.rs": `pub fn make() -> Result<u8, E> {\n    Ok(0)\n}\n`,
    "src/store.rs": `pub fn make() -> Result<u8, E> {\n    Ok(1)\n}\n`,
  };
  const d = repo(files);
  assert.equal(await declaredForTestsOnly(d, "src/fixtures.rs"), true);
  assert.equal(await declaredForTestsOnly(d, "src/store.rs"), false, "the attribute belongs to the declaration it is written above");
});

test("(l) the form of the call is asked of the definition the path picked out, not only of a name defined once", async () => {
  const files = {
    "src/cmd.rs": `pub fn run(root: &Path) -> Result<(), E> {\n    let s = Store::open(root, true)?;\n    Ok(())\n}\n`,
    "src/store.rs": `impl Store {\n    pub fn open(root: &Path) -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
    "src/other.rs": `impl Other {\n    pub fn open(root: &Path, write: bool) -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(files, "src/cmd.rs", "run", "Store::open");
  assert.equal(r.ok, false, "the definition under `impl Store` takes one argument and this call passes two");
  if (!r.ok) {
    assert.equal(r.kind, "callee_unresolved");
    assert.match(r.reason, /cannot be reached as this call is written/);
  }
});

test("(m) a header this did not read stops the path, and nothing after it settles the call", async () => {
  const bounds = ["    T: A,", "    T: B,", "    T: C,", "    T: D,", "    T: E,", "    T: F,", "    T: G,", "    T: H,"].join("\n");
  const files = {
    "src/cmd.rs": `pub fn run(root: &Path) -> Result<(), E> {\n    let s = Foo::name(root)?;\n    Ok(())\n}\n`,
    // Two arguments: the form alone would rule this one out and leave the unread one.
    "src/foo.rs": `impl Foo {\n    pub fn name(root: &Path, write: bool) -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
    "src/bar.rs": `impl<T>\n    Trait for\n    Bar<T>\nwhere\n${bounds}\n{\n    pub fn name(root: &Path) -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(files, "src/cmd.rs", "run", "Foo::name");
  assert.equal(r.ok, false, "`Foo::name` must not settle to a definition under a header that was not read");
  if (!r.ok) {
    assert.equal(r.kind, "callee_ambiguous");
    assert.match(r.reason, /under a header this did not read/);
  }
});

test("(n) a module is the one in this crate, not the file of the same name in another", async () => {
  const files = {
    "crates/a/src/lib.rs": `pub mod util;\n\npub fn run() -> Result<(), E> {\n    util::parse()?;\n    Ok(())\n}\n`,
    "crates/a/src/util.rs": `pub fn parse() -> Result<u8, E> {\n    Ok(0)\n}\n`,
    "crates/b/src/util.rs": `pub fn parse() -> u8 {\n    0\n}\n`,
  };
  const r = await decide(files, "crates/a/src/lib.rs", "run", "util::parse");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "crates/a/src/util.rs:1");

  // The same call with nothing in its own crate: held, and never resolved to the other crate's.
  const elsewhere = { ...files, "crates/a/src/util.rs": `pub fn other() -> Result<u8, E> {\n    Ok(0)\n}\n`, "crates/c/src/util.rs": `pub fn parse() -> Result<u8, E> {\n    Ok(2)\n}\n` };
  const held = await decide(elsewhere, "crates/a/src/lib.rs", "run", "util::parse");
  assert.equal(held.ok, false, "neither of the other crates' `util.rs` is what `util::parse()` names here");
});

test("(o) a module declared under `#[cfg(test)]` in one file and plainly in another is code", async () => {
  const files = {
    "src/lib.rs": `pub mod helpers;\n`,
    "src/main.rs": `#[cfg(test)]\nmod helpers;\n`,
    "src/helpers.rs": `pub fn make() -> Result<u8, E> {\n    Ok(0)\n}\n`,
  };
  assert.equal(await declaredForTestsOnly(repo(files), "src/helpers.rs"), false, "the library compiles it");
});

test("(p) a header written over lines is read whole, so the trait is not taken for the type", async () => {
  const lines = ["impl<T> Reader", "    for Store<T>", "{", "    pub fn open() -> Result<Self, E> {", "        todo!()", "    }", "}"];
  const enclosing = enclosingItem(lines, 4);
  assert.equal(enclosing.kind, "item");
  if (enclosing.kind === "item") assert.deepEqual(itemHead(enclosing.text), { kind: "impl", trait: "Reader", self: "Store" });

  const files = {
    "src/cmd.rs": `pub fn run() -> Result<(), E> {\n    let s = Reader::open()?;\n    Ok(())\n}\n`,
    "src/store.rs": `impl<T> Reader\n    for Store<T>\n{\n    pub fn open() -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
    "src/other.rs": `impl Other {\n    pub fn open() -> Result<Self, E> {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(files, "src/cmd.rs", "run", "Reader::open");
  assert.equal(r.ok, false, "`Reader::open` must not settle to the implementation for `Store<T>`");
});

test("(q) a caller outside a `src/` directory does not reach another crate's module", async () => {
  const files = {
    "examples/demo.rs": `pub fn run() -> Result<(), E> {\n    util::parse()?;\n    Ok(())\n}\n`,
    "crates/b/src/util.rs": `pub fn parse() -> Result<u8, E> {\n    Ok(0)\n}\n`,
    "crates/c/src/util.rs": `pub fn parse() -> Result<u8, E> {\n    Ok(1)\n}\n`,
  };
  const r = await decide(files, "examples/demo.rs", "run", "util::parse");
  assert.equal(r.ok, false, "neither crate's `util.rs` is the `util` this example names");
});

test("(r) a `mod x;` inside an inline test module does not make x's file test-only", async () => {
  const files = {
    "src/lib.rs": `pub fn run() {}\n\n#[cfg(test)]\nmod tests {\n    mod fixtures;\n}\n`,
    "src/fixtures.rs": `pub fn make() -> Result<u8, E> {\n    Ok(0)\n}\n`,
  };
  assert.equal(await declaredForTestsOnly(repo(files), "src/fixtures.rs"), false, "that declaration is `tests/fixtures.rs`");
});

test("(s) two traits of the same name in different files are two things, not one", async () => {
  const files = {
    "src/cmd.rs": `pub async fn run(conn: &mut Box<dyn Conn>) -> Result<(), E> {\n    conn.open().await?;\n    Ok(())\n}\n`,
    "src/a.rs": `pub trait Conn {\n    async fn open(&mut self) -> Result<(), E>;\n}\n`,
    "src/b.rs": `pub trait Conn {\n    async fn open(&mut self) -> Result<(), E>;\n}\n`,
    "src/impl_a.rs": `impl Conn for Mysql {\n    async fn open(&mut self) -> Result<(), E> {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(files, "src/cmd.rs", "run", "open");
  assert.equal(r.ok, false, "which `Conn` this is is not settled by the name alone");
});

test("(k) past twenty definitions left, signatures are not read and the call is held", async () => {
  const files: Record<string, string> = {
    "src/a.rs": `pub fn run(thing: &Thing) -> Result<(), E> {\n    thing.make()?;\n    Ok(())\n}\n`,
  };
  for (let i = 0; i < 21; i++) files[`src/s${i}.rs`] = `impl S${i} {\n    pub fn make(&self) -> Result<u8, E> {\n        Ok(0)\n    }\n}\n`;
  const r = await decide(files, "src/a.rs", "run", "make");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "callee_ambiguous");
    assert.match(r.reason, /more than 20 of them/);
    assert.match(r.reason, /their signatures are not read/);
  }
});
