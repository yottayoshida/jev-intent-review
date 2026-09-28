// A method called on what is written `dyn T` or `impl T` is looked for in `T`: its declaration and its
// `impl T for …`, found from the trait's side (#37, ADR 0028). A repository made of strings.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { calleeOf } from "../src/plan/applicability.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { writtenTrait } from "../src/plan/receiver-type.ts";
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

/** Where the one call of `callee` in `caller` settles, as `path:line` of the first and how many versions; null when not. */
async function settles(files: Record<string, string>, path: string, caller: string, callee: string): Promise<{ at: string; versions: string[]; ok: boolean } | null> {
  const source = files[path]!;
  const listing = enumerate(path, source, { parsed: parseRust(source) });
  const fn = listing.functions.find((f) => f.name === caller)!;
  assert.ok(fn, `fn ${caller}`);
  const call = listing.calls.find((c) => c.functionId === fn.id && c.callee.split("::").pop() === callee)!;
  assert.ok(call, `${callee} in ${caller}`);
  const { result, at } = await calleeOf(repo(files), fn, call);
  if (!at || at.kind === "outside") return null;
  return { at: `${at.path}:${at.line}`, versions: at.kind === "versions" ? at.all.map((a) => `${a.path}:${a.line}`) : [], ok: result.ok };
}

const PROVIDER = [
  "pub trait Provider {", // 1
  "    fn complete(&self, m: &str) -> Result<String, Error>;", // 2
  "}", // 3
  "pub struct A;", // 4
  "impl Provider for A {", // 5
  "    fn complete(&self, m: &str) -> Result<String, Error> {", // 6
  "        Ok(String::new())", // 7
  "    }", // 8
  "}", // 9
  "pub struct B;", // 10
  "impl Provider for B {", // 11
  "    fn complete(&self, m: &str) -> Result<String, Error> {", // 12
  "        Err(Error)", // 13
  "    }", // 14
  "}", // 15
  "pub struct Error;", // 16
].join("\n");

/** Another trait of this repository with a `complete` of its own: the name alone reaches both. */
const CLIENT = [
  "pub trait Client {", // 1
  "    fn complete(&self, p: &str) -> Result<u8, ()>;", // 2
  "}", // 3
  "pub struct C;", // 4
  "impl Client for C {", // 5
  "    fn complete(&self, p: &str) -> Result<u8, ()> {", // 6
  "        Ok(0)", // 7
  "    }", // 8
  "}", // 9
].join("\n");

const user = (param: string) =>
  [
    "use crate::provider::Provider;", // 1
    "use std::sync::Arc;", // 2
    `pub fn title(p: ${param}) -> Result<String, ()> {`, // 3
    '    let r = p.complete("x");', // 4
    "    Ok(String::new())", // 5
    "}", // 6
  ].join("\n");

test("writtenTrait reads dyn T and impl T past &, Box, Rc and Arc, and nothing else", () => {
  assert.deepEqual(writtenTrait("Arc<dyn Provider>"), ["Provider"]);
  assert.deepEqual(writtenTrait("&dyn Provider + Send"), ["Provider"]);
  assert.deepEqual(writtenTrait("&'a mut Box<dyn crate::provider::Provider + Send + Sync>"), ["crate", "provider", "Provider"]);
  assert.deepEqual(writtenTrait("std::sync::Arc<dyn Provider>"), ["Provider"]);
  assert.deepEqual(writtenTrait("impl Provider"), ["Provider"]);
  for (const t of ["Arc<Foo>", "Foo", "Vec<Box<dyn Provider>>", "Option<Arc<dyn Provider>>", "(dyn Provider)", "&[u8]"]) assert.equal(writtenTrait(t), null, t);
});

test("a method on Arc<dyn T> is T's: the declaration first, then every impl, and another trait's method of the name is left out", async () => {
  const files = { "src/provider.rs": PROVIDER, "src/client.rs": CLIENT, "src/title.rs": user("Arc<dyn Provider>") };
  const got = await settles(files, "src/title.rs", "title", "complete");
  assert.deepEqual(got, { at: "src/provider.rs:2", versions: ["src/provider.rs:2", "src/provider.rs:6", "src/provider.rs:12"], ok: true });
  // The control: written as a concrete type this repository does not define, the name reading decides, and two traits share it.
  assert.equal(await settles({ ...files, "src/title.rs": user("Other") }, "src/title.rs", "title", "complete"), null, "not narrowed without dyn T");
});

test("&dyn T + Send, Box<dyn T> and an impl T parameter are read the same", async () => {
  for (const param of ["&dyn Provider", "&(dyn Provider)", "Box<dyn Provider + Send>", "impl Provider"]) {
    const got = await settles({ "src/provider.rs": PROVIDER, "src/client.rs": CLIENT, "src/title.rs": user(param) }, "src/title.rs", "title", "complete");
    if (param === "&(dyn Provider)") assert.equal(got, null, "a parenthesised dyn is not read");
    else assert.equal(got?.at, "src/provider.rs:2", param);
  }
});

test("a let set from a call whose written return type is Arc<dyn T> is read too", async () => {
  const files = {
    "src/provider.rs": PROVIDER,
    "src/client.rs": CLIENT,
    "src/title.rs": [
      "use crate::provider::Provider;", // 1
      "use std::sync::Arc;", // 2
      "fn pick() -> Arc<dyn Provider> {", // 3
      "    todo!()", // 4
      "}", // 5
      "pub fn title() -> Result<String, ()> {", // 6
      "    let p = pick();", // 7
      '    let r = p.complete("x");', // 8
      "    Ok(String::new())", // 9
      "}", // 10
    ].join("\n"),
  };
  assert.equal((await settles(files, "src/title.rs", "title", "complete"))?.at, "src/provider.rs:2");
});

test("an impl<P> T for W<P> is a version, and an impl inside #[cfg(test)] is not", async () => {
  const extra = [
    "pub struct W<P>(P);", // 1
    "impl<P: Clone> Provider for W<P> {", // 2
    "    fn complete(&self, m: &str) -> Result<String, Error> {", // 3
    "        Ok(String::new())", // 4
    "    }", // 5
    "}", // 6
    "#[cfg(test)]", // 7
    "mod tests {", // 8
    "    struct M;", // 9
    "    impl Provider for M {", // 10
    "        fn complete(&self, m: &str) -> Result<String, Error> {", // 11
    "            Ok(String::new())", // 12
    "        }", // 13
    "    }", // 14
    "}", // 15
  ].join("\n");
  const files = { "src/provider.rs": PROVIDER, "src/wrap.rs": `use crate::provider::{Error, Provider};\n${extra}`, "src/client.rs": CLIENT, "src/title.rs": user("Arc<dyn Provider>") };
  const got = await settles(files, "src/title.rs", "title", "complete");
  assert.ok(got?.versions.includes("src/wrap.rs:4"), JSON.stringify(got));
  assert.ok(!got?.versions.includes("src/wrap.rs:12"), "the test impl is left out");
});

test("an impl indented inside a mod block is a version too", async () => {
  const inner = "use crate::provider::{Error, Provider};\npub mod inner {\n    use super::*;\n    pub struct I;\n    impl Provider for I {\n        fn complete(&self, m: &str) -> Result<String, Error> {\n            Ok(String::new())\n        }\n    }\n}\n";
  const got = await settles({ "src/provider.rs": PROVIDER, "src/inner.rs": inner, "src/client.rs": CLIENT, "src/title.rs": user("Arc<dyn Provider>") }, "src/title.rs", "title", "complete");
  assert.ok(got?.versions.includes("src/inner.rs:6"), JSON.stringify(got));
});

test("a version that does not return a Result makes the call not askable, as versions always have", async () => {
  const bad = PROVIDER.replace("impl Provider for B {\n    fn complete(&self, m: &str) -> Result<String, Error> {", "impl Provider for B {\n    fn complete(&self, m: &str) -> String {");
  const got = await settles({ "src/provider.rs": bad, "src/client.rs": CLIENT, "src/title.rs": user("Arc<dyn Provider>") }, "src/title.rs", "title", "complete");
  assert.equal(got?.ok, false);
  assert.equal(got?.at, "src/provider.rs:2");
});

test("not narrowed: a name T does not declare, a method in impl dyn T, a trait from a dependency, a standard-library name", async () => {
  const base = { "src/provider.rs": PROVIDER, "src/client.rs": CLIENT };
  // `T` declares no `complete`: a supertrait's, say. The name reading decides, and two traits share it.
  const noDecl = { ...base, "src/provider.rs": PROVIDER.replace("pub trait Provider {\n    fn complete(&self, m: &str) -> Result<String, Error>;\n}", "pub trait Provider {\n    fn name(&self) -> &str;\n}") };
  assert.equal(await settles({ ...noDecl, "src/title.rs": user("Arc<dyn Provider>") }, "src/title.rs", "title", "complete"), null);
  // A method of the trait object itself may be the one reached.
  const onDyn = { ...base, "src/dyn.rs": "use crate::provider::Provider;\nimpl dyn Provider {\n    pub fn complete(&self, m: &str) -> Result<String, ()> {\n        Ok(String::new())\n    }\n}\n", "src/title.rs": user("Arc<dyn Provider>") };
  assert.equal(await settles(onDyn, "src/title.rs", "title", "complete"), null);
  // Brought in from another crate: not this repository's trait, whatever a trait here is called.
  const dependency = { ...base, "src/title.rs": user("Arc<dyn Provider>").replace("use crate::provider::Provider;", "use other_crate::Provider;") };
  assert.equal(await settles(dependency, "src/title.rs", "title", "complete"), null);
  // A standard-library name stays under ADR 0027: `clone` on an `Arc<dyn T>` is `Arc`'s.
  const cloned = { ...base, "src/provider.rs": PROVIDER.replace("    fn complete(&self, m: &str) -> Result<String, Error>;\n}", "    fn complete(&self, m: &str) -> Result<String, Error>;\n    fn clone(&self) -> Result<u8, ()>;\n}"), "src/title.rs": user("Arc<dyn Provider>").replace('p.complete("x")', "p.clone()") };
  assert.equal(await settles(cloned, "src/title.rs", "title", "clone"), null);
});

test("a trait's default body no impl overrides is one definition, not versions, as the name reading settles it", async () => {
  const withDefault = PROVIDER.replace("pub trait Provider {\n    fn complete(&self, m: &str) -> Result<String, Error>;\n}", "pub trait Provider {\n    fn complete(&self, m: &str) -> Result<String, Error>;\n    fn warm(&self) -> Result<(), Error> {\n        Ok(())\n    }\n}");
  const files = { "src/provider.rs": withDefault, "src/client.rs": CLIENT, "src/title.rs": user("Arc<dyn Provider>").replace('p.complete("x")', "p.warm()") };
  assert.deepEqual(await settles(files, "src/title.rs", "title", "warm"), { at: "src/provider.rs:3", versions: [], ok: true });
});
