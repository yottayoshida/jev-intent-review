// A method whose name the standard library uses too is kept on the definition the name reading chose
// only when what it is called on is one of this repository's types and the definition is in its
// `impl` (#83, ADR 0027). A repository made of strings, read as the product reads Rust.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { calleeOf } from "../src/plan/applicability.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { headPath } from "../src/plan/receiver-type.ts";
import { STD_METHOD_NAMES } from "../src/plan/std-methods.ts";
import { parseRust } from "../src/syntax/rust.ts";

function repo(files: Record<string, string>): Discoverer {
  return {
    async search(words: string) {
      const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
      const hits = Object.entries(files).flatMap(([path, text]) => text.split("\n").flatMap((line, i) => (re.test(line) ? [{ path, line: i + 1, text: line }] : [])));
      return { hits, more: false };
    },
    async index(path: string) {
      return files[path] ? new BlockIndex(files[path]!.split("\n"), { path }) : null;
    },
  } as unknown as Discoverer;
}

/** Where the one call of `callee` in `caller` settles: the definition's line, or null when held. */
async function settles(files: Record<string, string>, path: string, caller: string, callee: string, nth = 0): Promise<number | null> {
  const source = files[path]!;
  const listing = enumerate(path, source, { parsed: parseRust(source) });
  const fn = listing.functions.find((f) => f.name === caller)!;
  assert.ok(fn, `fn ${caller}`);
  const call = listing.calls.filter((c) => c.functionId === fn.id && c.callee.split("::").pop() === callee)[nth]!;
  assert.ok(call, `${callee} in ${caller}`);
  const { at } = await calleeOf(repo(files), fn, call);
  return at && at.kind !== "outside" ? at.line : null;
}

const FOO = [
  "pub struct Foo;", // 1
  "impl Foo {", // 2
  "    pub fn len(&self) -> usize { 0 }", // 3
  "    pub fn clone(&self) -> Foo { Foo }", // 4
  "}", // 5
].join("\n");

test("the table holds the standard library's public methods and not internal names", () => {
  for (const n of ["len", "clone", "map_err", "unwrap", "iter", "to_string", "display", "as_slice"]) assert.ok(STD_METHOD_NAMES.has(n), n);
  for (const n of ["run", "validate", "build", "sign", "result", "new", "default", "from"]) assert.ok(!STD_METHOD_NAMES.has(n), n);
});

test("self.len() in the impl that defines len is kept", async () => {
  const files = { "src/foo.rs": `${FOO}\nimpl Foo {\n    fn run(&self) -> Result<(), ()> {\n        self.len();\n        Ok(())\n    }\n}\n` };
  assert.equal(await settles(files, "src/foo.rs", "run", "len"), 3);
});

test("v.len() on a Vec, on an Arc<Foo>, and inside impl Trait for Vec is held", async () => {
  const files = {
    "src/foo.rs": FOO,
    "src/use.rs": [
      "use crate::foo::Foo;", // 1
      "use std::sync::Arc;", // 2
      "fn a(v: Vec<u8>) -> Result<(), ()> { v.len(); Ok(()) }", // 3
      "fn b(a: Arc<Foo>) -> Result<(), ()> { a.clone(); Ok(()) }", // 4
      "fn c(f: &Foo) -> Result<(), ()> { f.len(); Ok(()) }", // 5
    ].join("\n"),
  };
  assert.equal(await settles(files, "src/use.rs", "a", "len"), null, "a Vec's len is std's");
  assert.equal(await settles(files, "src/use.rs", "b", "clone"), null, "an Arc's clone is Arc's");
  assert.equal(await settles(files, "src/use.rs", "c", "len"), 3, "a &Foo's len is Foo's (the control)");
  const trait = { "src/ext.rs": "pub trait Size { fn size(&self) -> usize; }\nimpl Size for Vec<u8> {\n    fn size(&self) -> usize { self.len() }\n}\n", "src/foo.rs": FOO };
  const listing = enumerate("src/ext.rs", trait["src/ext.rs"], { parsed: parseRust(trait["src/ext.rs"]) });
  const fn = listing.functions.find((f) => f.name === "size" && f.startLine === 3)!;
  const call = listing.calls.find((c) => c.functionId === fn.id && c.callee === "len")!;
  assert.equal((await calleeOf(repo(trait), fn, call)).at, null, "a Vec's own len goes before any trait of this repository's");
});

test("an alias of a standard-library type is no type of this repository's, and a let reads the name before it", async () => {
  const files = {
    "src/nodes.rs": [
      "pub struct Node;", // 1
      "pub type Nodes = Vec<Node>;", // 2
      "pub trait Size {", // 3
      "    fn len(&self) -> usize;", // 4
      "}", // 5
      "impl Size for Vec<Node> {", // 6
      "    fn len(&self) -> usize { 0 }", // 7
      "}", // 8
      "fn run(ns: &Nodes) -> Result<(), ()> {", // 9
      "    ns.len();", // 10
      "    Ok(())", // 11
      "}", // 12
    ].join("\n"),
  };
  assert.equal(await settles(files, "src/nodes.rs", "run", "len"), null, "Nodes is a Vec, and a Vec's own len goes first");
  // The control: the name reading alone settles it (the trait's versions), so the rule is what holds it.
  const bare = { "src/nodes.rs": files["src/nodes.rs"].replace("fn run(ns: &Nodes)", "fn run(ns: &Node)") };
  assert.equal(await settles(bare, "src/nodes.rs", "run", "len"), null, "a Node has no len: held too");
  const shadow = {
    "src/foo.rs": `${FOO}\nfn run(x: &Foo) -> Result<(), ()> {\n    let x = x.clone();\n    Ok(())\n}\n`,
  };
  assert.equal(await settles(shadow, "src/foo.rs", "run", "clone"), 4, "the x on the right is the parameter, a Foo");
  assert.ok(STD_METHOD_NAMES.has("poll"), "a method taking a typed self (`self: Pin<&mut Self>`)");
});

test("an alias that names itself again ends, and is no type of this repository's", async () => {
  const files = {
    "src/error.rs": "pub struct Inner;\npub type Error = crate::error::Error;\nimpl Inner {\n    pub fn len(&self) -> usize { 0 }\n}\nfn run(e: &Error) -> Result<(), ()> {\n    e.len();\n    Ok(())\n}\n",
  };
  assert.equal(await settles(files, "src/error.rs", "run", "len"), null);
});

test("an associated type written `type X = X;` beside a struct X is the struct", async () => {
  const files = {
    "src/set.rs": [
      "pub struct ValidatorSet;", // 1
      "impl ValidatorSet {", // 2
      "    pub fn count(&self) -> usize { 0 }", // 3
      "}", // 4
      "pub trait Context { type ValidatorSet; }", // 5
      "pub struct Ctx;", // 6
      "impl Context for Ctx {", // 7
      "    type ValidatorSet = ValidatorSet;", // 8
      "}", // 9
      "impl Ctx {", // 10
      "    fn pick(&self, set: &Self::ValidatorSet) -> Result<(), ()> {", // 11
      "        set.count();", // 12
      "        Ok(())", // 13
      "    }", // 14
      "}", // 15
    ].join("\n"),
  };
  assert.equal(await settles(files, "src/set.rs", "pick", "count"), 3);
});

test("a repository type whose impl does not hold the one definition of the name is held", async () => {
  const files = {
    "src/bar.rs": "pub struct Bar;\nimpl Bar {\n    pub fn len(&self) -> usize { 0 }\n}\n",
    "src/foo.rs": "pub struct Foo;\nfn run(f: &Foo) -> Result<(), ()> {\n    f.len();\n    Ok(())\n}\n",
  };
  assert.equal(await settles(files, "src/foo.rs", "run", "len"), null, "a Foo is no Bar, and the one len here is Bar's");
});

test("a call's written return type, through a type alias and a workspace crate, keeps the definition", async () => {
  const costs = [
    "pub struct CostContext<T> { v: T }", // 1
    "pub type CostResult<T, E> = CostContext<Result<T, E>>;", // 2
    "impl<T> CostContext<T> {", // 3
    "    pub fn unwrap(self) -> T { self.v }", // 4
    "}", // 5
  ].join("\n");
  const files = {
    "costs/Cargo.toml": '[package]\nname = "grovedb-costs"\n',
    "costs/src/lib.rs": costs,
    "merk/src/tree.rs": [
      "use grovedb_costs::{CostContext, CostResult};", // 1
      "fn hash_of() -> CostContext<u8> { todo!() }", // 2
      "fn put() -> CostResult<(), ()> { todo!() }", // 3
      "fn run() -> Result<(), ()> {", // 4
      "    hash_of().unwrap();", // 5
      "    put().unwrap();", // 6
      "    Ok(())", // 7
      "}", // 8
    ].join("\n"),
  };
  assert.equal(await settles(files, "merk/src/tree.rs", "run", "unwrap", 0), 4, "CostContext, from another crate of the workspace");
  assert.equal(await settles(files, "merk/src/tree.rs", "run", "unwrap", 1), 4, "CostResult, an alias of it");
});

test("a closure's parameter, a macro's arguments, an enum's variant, and names and paths the rule leaves alone", async () => {
  const files = {
    "src/foo.rs": [
      FOO, // 1-5
      "pub enum Fuel { Add }", // 6
      "impl Fuel {", // 7
      "    pub fn consume(&self) -> Result<(), ()> { Ok(()) }", // 8
      "}", // 9
      "impl Foo {", // 10
      "    pub fn frobnicate(&self) -> Result<(), ()> { Ok(()) }", // 11
      "    fn run(&self, xs: Vec<Foo>) -> Result<(), ()> {", // 10
      "        xs.iter().map(|k| k.len());", // 11
      "        assert!(self.len() > 0);", // 12
      "        Fuel::Add.consume()?;", // 13
      "        xs[0].frobnicate()?;", // 14
      "        Foo::len(self);", // 15
      "        Ok(())", // 16
      "    }", // 17
      "}", // 18
    ].join("\n"),
  };
  assert.equal(await settles(files, "src/foo.rs", "run", "len", 0), null, "a closure's parameter is not read");
  assert.equal(await settles(files, "src/foo.rs", "run", "len", 1), 3, "inside assert!(…), read as outside it");
  assert.equal(await settles(files, "src/foo.rs", "run", "consume"), 8, "Fuel::Add is a Fuel");
  assert.equal(await settles(files, "src/foo.rs", "run", "frobnicate"), 11, "a name std does not use: the name reading, as before");
  assert.equal(await settles(files, "src/foo.rs", "run", "len", 2), 3, "Foo::len(self), a path: as before");
});

test("a written type's head", () => {
  assert.deepEqual(headPath("&'a mut CostContext<T>"), ["CostContext"]);
  assert.deepEqual(headPath("grovedb_costs::CostResult<(), E>"), ["grovedb_costs", "CostResult"]);
  assert.equal(headPath("impl Iterator<Item = u8>"), null);
  assert.equal(headPath("(u8, u8)"), null);
});
