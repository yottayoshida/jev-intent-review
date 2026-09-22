// Whether a function returns a `Result`, read from its whole signature and the aliases a repository
// defines. No model, no network: a repository made of strings.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { applicabilityOf, functionDefinitionsOf } from "../src/plan/applicability.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { ReturnTypes, signatureAt } from "../src/plan/result-type.ts";

/** A repository of files; `cut` names the searches that stop at their cap. */
function repo(files: Record<string, string>, cut: string[] = []): Discoverer {
  return {
    async search(words: string) {
      const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
      const hits = Object.entries(files).flatMap(([path, text]) => text.split("\n").flatMap((line, i) => (re.test(line) ? [{ path, line: i + 1, text: line }] : [])));
      return { hits, more: cut.includes(words) };
    },
    async index(path: string) {
      return files[path] ? new BlockIndex(files[path]!.split("\n")) : null;
    },
  } as unknown as Discoverer;
}

const read = async (files: Record<string, string>, path: string, name: string, cut: string[] = []) => {
  const lines = files[path]!.split("\n");
  const line = lines.findIndex((l) => new RegExp(`\\bfn\\s+${name}\\b`).test(l)) + 1;
  assert.ok(line > 0, `fn ${name} is in ${path}`);
  return new ReturnTypes(repo(files, cut)).at(path, line, name);
};

test("(a) a return type on the fifth or seventh line of a signature is read", async () => {
  const src = `pub async fn get_decided_from_anchor(
    &self,
    conn: &libsql::Connection,
    anchor: Height,
) -> Result<Vec<Decided>> {
    todo!()
}

fn longer(
    a: u8,
    b: u8,
    c: u8,
    d: u8,
    e: u8,
) -> Result<(), E> {
    Ok(())
}
`;
  assert.equal((await read({ "src/a.rs": src }, "src/a.rs", "get_decided_from_anchor")).kind, "returns");
  assert.equal((await read({ "src/a.rs": src }, "src/a.rs", "longer")).kind, "returns");
});

test("(b) an arrow inside the generics or the parameters is not the return type", async () => {
  const src = `use moltis_channels::Result as ChannelResult;

fn f<F: Fn() -> u8>(f: F) -> ChannelResult<u8> {
    todo!()
}

fn g(h: impl Fn() -> Result<u8>) -> u8 {
    0
}
`;
  const f = await read({ "src/a.rs": src }, "src/a.rs", "f");
  assert.equal(f.kind, "returns");
  assert.equal(f.type, "ChannelResult<u8>");
  const g = await read({ "src/a.rs": src }, "src/a.rs", "g");
  assert.deepEqual([g.kind, g.type], ["not", "u8"], "the Result in the parameter is not what g returns");
});

test("(c) a Result renamed in a use statement, however the statement is written", async () => {
  const forms = [
    "use x::{Result as R};",
    "use x::Result as R;",
    "use {\n    a::{b, Result as R},\n    c,\n};",
    "pub(crate) use x::{\n    Other,\n    Result as R,\n};",
  ];
  for (const form of forms) {
    const src = `${form}\n\npub fn h() -> R<String> {\n    todo!()\n}\n`;
    assert.equal((await read({ "src/a.rs": src }, "src/a.rs", "h")).kind, "returns", form);
  }
});

test("(d) aliases the repository defines are followed, two deep, including a right-hand side on the next line", async () => {
  const files = {
    "src/err.rs": `pub type R<T> = std::result::Result<T, Error>;\npub type R2<T> = R<T>;\npub type Next<T> =\n    Result<T, Error>;\n`,
    "costs/src/lib.rs": `pub type CostResult<T, E> = CostContext<Result<T, E>>;\npub struct CostContext<T> { value: T }\n`,
    "src/a.rs": `fn one() -> R<u8> { todo!() }\nfn two() -> R2<u8> { todo!() }\nfn next() -> Next<()> { todo!() }\nfn cost() -> CostResult<(), Error> { todo!() }\n`,
  };
  for (const name of ["one", "two", "next", "cost"]) assert.equal((await read(files, "src/a.rs", name)).kind, "returns", name);
});

test("(e) fmt::Result is a Result; numbers, unit, Vec and the repository's own struct are not", async () => {
  const files = {
    "src/a.rs": `impl fmt::Display for X {\n    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {\n        Ok(())\n    }\n}\n\nfn len(&self) -> usize { 0 }\nfn set(&mut self) { }\nfn bytes() -> Vec<u8> { vec![] }\nfn value() -> Value { todo!() }\n`,
    "src/value.rs": `pub struct Value {\n    raw: Vec<u8>,\n}\n`,
  };
  assert.equal((await read(files, "src/a.rs", "fmt")).kind, "returns");
  for (const [name, type] of [["len", "usize"], ["set", "()"], ["bytes", "Vec<u8>"], ["value", "Value"]]) {
    const r = await read(files, "src/a.rs", name!);
    assert.deepEqual([r.kind, r.type], ["not", type], name);
  }
});

test("(f) two aliases of one name that disagree settle nothing", async () => {
  const files = {
    "a/src/lib.rs": `pub type Out<T> = Result<T, AError>;\n`,
    "b/src/lib.rs": `pub type Out<T> = Vec<T>;\n`,
    "src/a.rs": `fn f() -> Out<u8> { todo!() }\n`,
  };
  const r = await read(files, "src/a.rs", "f");
  assert.equal(r.kind, "unknown");
  if (r.kind === "unknown") assert.match(r.why, /`Out` has 2 definitions here that disagree/);
});

test("(f) an alias of an array type is read to the end of its statement, not to the `;` inside the brackets", async () => {
  // grovedb defines `CryptoHash` twice, `[u8; HASH_LENGTH]` and `[u8; 32]`. Cut at the first `;`
  // both read as `[u8`, agreed, and settled "not a Result" without reading `HASH_LENGTH` at all.
  const files = {
    "query/src/lib.rs": `pub const HASH_LENGTH: usize = 32;\npub type CryptoHash = [u8; HASH_LENGTH];\n`,
    "types/src/lib.rs": `pub type CryptoHash = [u8; 32];\n`,
    "costs/src/lib.rs": `pub struct CostContext<T> { value: T }\n`,
    "src/a.rs": `fn value_hash() -> CostContext<CryptoHash> { todo!() }\nfn plain() -> [u8; 32] { [0; 32] }\n`,
  };
  const r = await read(files, "src/a.rs", "value_hash");
  assert.equal(r.kind, "unknown");
  if (r.kind === "unknown") assert.match(r.why, /`CryptoHash` has 2 definitions here that disagree/);
  assert.equal((await read(files, "src/a.rs", "plain")).kind, "not");
});

test("(g) a signature that does not end within 30 lines settles nothing", async () => {
  const params = Array.from({ length: 40 }, (_, i) => `    p${i}: u8,`).join("\n");
  const src = `fn huge(\n${params}\n) -> Result<(), E> {\n    Ok(())\n}\n`;
  const r = await read({ "src/a.rs": src }, "src/a.rs", "huge");
  assert.equal(r.kind, "unknown");
  if (r.kind === "unknown") assert.match(r.why, /did not end within 30 lines/);
});

test("(h) a dependency's type, Self, a type parameter and a trait of the repository settle nothing", async () => {
  const files = {
    "src/a.rs": `fn txid() -> Txid { todo!() }\nimpl X {\n    fn build(self) -> Self { self }\n}\nfn with<T>(f: impl FnOnce() -> T) -> T { f() }\nfn fut() -> impl MyFut { todo!() }\nfn py() -> PyResult<u8> { todo!() }\n`,
    "src/fut.rs": `pub trait MyFut: Future<Output = Result<u8, E>> {}\n`,
  };
  const expected: Record<string, RegExp> = {
    txid: /`Txid` is not defined in this repository/,
    build: /`Self` is not followed/,
    with: /`T` is a type parameter/,
    fut: /`MyFut` is a trait/,
    py: /`PyResult` is not defined in this repository/,
  };
  for (const [name, why] of Object.entries(expected)) {
    const r = await read(files, "src/a.rs", name);
    assert.equal(r.kind, "unknown", name);
    if (r.kind === "unknown") assert.match(r.why, why, name);
  }
});

test("(i) a callee's definitions are Rust fn lines, pub(in …) and attributes included, and nothing else", async () => {
  const files = {
    "src/h.rs": `pub(in crate::channel_events) async fn handle_title(state: &State) -> Result<String> {\n    todo!()\n}\n#[inline] pub fn quick() -> Result<u8> { Ok(0) }\nimpl S {\n    pub fn new() -> Result<Self> { todo!() }\n}\n`,
    "web/app.js": `function handle_title(x) { return x; }\nconst quick = () => 1;\n`,
    "docs/api.md": "```rust\nfn handle_title() -> u8 { 0 }\n```\n",
    "src/e.rs": `fn other() -> Result<()> {\n    let (status, message) = if ok { a } else { b };\n    // fn quick() -> u8 in a comment\n    Ok(())\n}\n`,
  };
  const d = repo(files);
  for (const name of ["handle_title", "quick", "new"]) {
    const { found } = await functionDefinitionsOf(d, name);
    assert.deepEqual(found.map((f) => f.path), ["src/h.rs"], name);
  }
  assert.deepEqual((await functionDefinitionsOf(d, "let")).found, [], "a `let` line is not a definition");
});

test("(j) a lifetime and a comment holding a bracket do not end the signature early", async () => {
  const src = `pub fn borrow<'a>(\n    input: &'a str, // a note (with brackets\n    /* and ( here */ n: usize,\n) -> Result<&'a str, E> {\n    Ok(input)\n}\n`;
  const r = await read({ "src/a.rs": src }, "src/a.rs", "borrow");
  assert.deepEqual([r.kind, r.type], ["returns", "Result<&'a str, E>"]);
  const direct = signatureAt(src.split("\n"), 1, "borrow");
  assert.ok(direct.ok && direct.generics.size === 0, "a lifetime is not a type parameter");
});

test("(k) a callee whose definition search stops at its cap settles nothing", async () => {
  const src = `pub fn run() -> Result<(), E> {\n    let x = helper()?;\n    Ok(())\n}\npub fn helper() -> Result<u8, E> { Ok(0) }\n`;
  const files = { "src/a.rs": src };
  const c = enumerate("src/a.rs", src);
  const fn = c.functions.find((f) => f.name === "run")!;
  const call = c.calls.find((k) => k.callee === "helper")!;
  assert.equal((await applicabilityOf(repo(files), fn, call)).ok, true, "found, it is askable");
  const cut = await applicabilityOf(repo(files, ["fn helper"]), fn, call);
  assert.equal(cut.ok, false);
  if (!cut.ok) {
    assert.equal(cut.kind, "callee_return_unknown");
    assert.match(cut.reason, /the search for `fn helper` stopped at its cap/);
  }
});

test("a call that cannot reach the one definition of its name is held, not asked about", async () => {
  // Found by name, the standard library's methods were taken for this repository's functions:
  // Kontor's `"".to_string()` met `async fn to_string<T>(accessor, self_)`, moltis's `read()` met
  // `fn read(&self, key)`, grovedb's `remove(chunk_id)` met `fn remove<V>(self, a, b)`.
  const src = `pub fn run(&self) -> Result<(), E> {
    let s = "".to_string();
    let g = self.inner.read();
    self.pending.remove(chunk_id);
    let b = self.batch(b)?;
    let p = helper(x, y)?;
    let c = combine(|a, b| a + b)?;
    Ok(())
}
pub async fn to_string<T>(accessor: A, self_: T) -> Result<String> { todo!() }
pub fn read(&self, key: &str) -> Result<u8, E> { todo!() }
pub fn remove<V>(self, a: u8, b: u8) -> Result<(), E> { todo!() }
pub fn batch(&self, b: u8) -> Result<u8, E> { todo!() }
pub fn helper(x: u8, y: u8) -> Result<u8, E> { todo!() }
pub fn combine(f: impl Fn(u8, u8) -> u8) -> Result<u8, E> { todo!() }
`;
  const files = { "src/a.rs": src };
  const c = enumerate("src/a.rs", src);
  const run = c.functions.find((f) => f.name === "run")!;
  const d = repo(files);
  const at = async (callee: string) => applicabilityOf(d, run, c.calls.find((k) => k.callee === callee && k.functionId === run.id)!);
  for (const [callee, why] of [["to_string", /is called as a method here and takes no `self`/], ["read", /takes 1 argument as this call is written, and this call passes 0/], ["remove", /takes 2 arguments as this call is written, and this call passes 1/]] as const) {
    const r = await at(callee);
    assert.equal(r.ok, false, callee);
    if (!r.ok) {
      assert.equal(r.kind, "callee_unresolved", callee);
      assert.match(r.reason, why, callee);
    }
  }
  for (const callee of ["batch", "helper", "combine"]) assert.equal((await at(callee)).ok, true, `${callee} reaches its definition`);
});

test("calls that do reach their definition are not held for how their line looks", async () => {
  // Each of these was held as "has no definition here" by the first version of the form check.
  const src = `pub fn run(&mut self, buf: &[u8], cache: &Cache, s: &S, r: &R) -> Result<(), E> {
    self.expect(',')?;
    let h = helper(')', 1)?;
    let body = &buf[..header_len(buf)?];
    let c = Config { port: 1, ..load_defaults()? };
    let v = cache.load(k).unwrap_or(load(k)?);
    let t = s.try_parse(a)?; let p = parse(a)?;
    r.draw(rect)?;
    Ok(())
}
pub fn expect(&mut self, c: char) -> Result<(), E> { todo!() }
pub fn helper(c: char, n: u8) -> Result<u8, E> { todo!() }
pub fn header_len(b: &[u8]) -> Result<usize, E> { todo!() }
pub fn load_defaults() -> Result<Config, E> { todo!() }
pub fn load(k: u8) -> Result<u8, E> { todo!() }
pub fn parse(a: u8) -> Result<u8, E> { todo!() }
pub fn draw(&self, Rect { x, y }: Rect) -> Result<(), E> { todo!() }
`;
  const files = { "src/a.rs": src };
  const c = enumerate("src/a.rs", src);
  const run = c.functions.find((f) => f.name === "run")!;
  const d = repo(files);
  const expressions = ["expect(',')", "helper(')', 1)", "header_len(buf)", "load_defaults()", "load(k)", "parse(a)", "draw(rect)"];
  for (const expression of expressions) {
    const call = c.calls.find((k) => k.functionId === run.id && k.expression === expression);
    assert.ok(call, `${expression} is listed`);
    const r = await applicabilityOf(d, run, call!);
    assert.equal(r.ok, true, `${expression}: ${r.ok ? "" : r.reason}`);
  }
});

test("a fn inside a string or a comment that spans lines is not a definition, and a '\"' does not hide code", async () => {
  const files = {
    "src/gen.rs": `pub fn template() -> &'static str {\n    "header\n fn gen2() -> u8 { 0 }\n footer"\n}\n/* a note\n fn gen3() -> u8 { 0 }\n*/\n`,
    "src/quote.rs": `pub fn is_quote(c: char) -> bool {\n    c == '"'\n}\npub fn real() -> Result<u8, E> {\n    Ok(1)\n}\n`,
  };
  const d = repo(files);
  assert.deepEqual((await functionDefinitionsOf(d, "gen2")).found, [], "inside a string that spans lines");
  assert.deepEqual((await functionDefinitionsOf(d, "gen3")).found, [], "inside a block comment that spans lines");
  const real = (await functionDefinitionsOf(d, "real")).found;
  assert.equal(real.length, 1, "a character literal holding a double quote does not open a string");
  assert.equal((await new ReturnTypes(d).at(real[0]!.path, real[0]!.line, "real")).kind, "returns");
});

test("a definition is the named fn on its own line, not one in a comment, a string or beside it", async () => {
  const files = {
    "src/b.rs": `fn check() -> Result<(), E> {\n    let n = x.len(); // the same check as fn parse_header() in the reader\n    Ok(())\n}\nfn next() -> usize { 0 }\n`,
    "src/c.rs": `fn first() -> u8 { 0 } pub fn helper() -> Result<u8, E> { Ok(1) }\n`,
    "src/d.rs": `fn render(out: &mut String) {\n    out.push_str("fn emit() {}");\n}\n`,
  };
  const d = repo(files);
  assert.deepEqual((await functionDefinitionsOf(d, "parse_header")).found, [], "a comment is not a definition");
  assert.deepEqual((await functionDefinitionsOf(d, "emit")).found, [], "a string is not a definition");
  const helper = (await functionDefinitionsOf(d, "helper")).found;
  assert.equal(helper.length, 1);
  const r = await new ReturnTypes(d).at(helper[0]!.path, helper[0]!.line, "helper");
  assert.deepEqual([r.kind, r.type], ["returns", "Result<u8, E>"], "the named function, not the first on the line");
  const wrong = await new ReturnTypes(d).at("src/b.rs", 2, "parse_header");
  assert.equal(wrong.kind, "unknown", "a line that does not define the name is not read as if it did");
});

test("an attribute on the alias's line, a path through an alias's parameter, and an impl's parameter", async () => {
  const files = {
    "src/err.rs": `#[cfg(feature = "std")] pub type Out<T> = Result<T, E>;\npub type Assoc<T> = T::Output;\n`,
    "src/r.rs": `pub struct R { raw: u8 }\n`,
    "src/a.rs": `fn out() -> Out<u8> { todo!() }\nfn assoc() -> Assoc<u8> { todo!() }\nimpl<R> W<R> {\n    fn into_inner(self) -> R { todo!() }\n}\n`,
  };
  assert.equal((await read(files, "src/a.rs", "out")).kind, "returns", "the attribute does not hide the alias");
  const assoc = await read(files, "src/a.rs", "assoc");
  assert.equal(assoc.kind, "unknown");
  if (assoc.kind === "unknown") assert.match(assoc.why, /`T::Output` depends on a type parameter/);
  const inner = await read(files, "src/a.rs", "into_inner");
  assert.equal(inner.kind, "unknown", "the impl's R is not the repository's struct R");
});

test("reasons quote the return type they read and say what could not be read", async () => {
  const src = `pub fn run() -> Result<(), E> {\n    let n = count();\n    let t = token();\n    Ok(())\n}\npub fn count() -> usize { 0 }\npub fn token() -> Txid { todo!() }\npub fn plain() -> u8 {\n    count()\n}\n`;
  const files = { "src/a.rs": src };
  const c = enumerate("src/a.rs", src);
  const run = c.functions.find((f) => f.name === "run")!;
  const plain = c.functions.find((f) => f.name === "plain")!;
  const d = repo(files);
  const count = await applicabilityOf(d, run, c.calls.find((k) => k.callee === "count" && k.functionId === run.id)!);
  assert.equal(count.ok, false);
  if (!count.ok) {
    assert.equal(count.kind, "callee_not_result");
    assert.match(count.reason, /the one function named count in this repository \(src\/a\.rs:6\) returns `usize` and does not return a Result/);
  }
  const token = await applicabilityOf(d, run, c.calls.find((k) => k.callee === "token")!);
  assert.equal(token.ok, false);
  if (!token.ok) {
    assert.equal(token.kind, "callee_return_unknown");
    assert.doesNotMatch(token.reason, /does not return a Result/);
    assert.match(token.reason, /`Txid` is not defined in this repository/);
  }
  const target = await applicabilityOf(d, plain, c.calls.find((k) => k.functionId === plain.id)!);
  assert.equal(target.ok, false);
  if (!target.ok) {
    assert.equal(target.kind, "target_not_result");
    assert.match(target.reason, /plain returns `u8` and does not return a Result/);
  }
});
