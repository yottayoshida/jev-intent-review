// The name-resolution record's classes (#83, docs/resolution.md). No Rust toolchain: rust-analyzer's
// index of test/fixtures/resolution/crate is committed with the sha of each source and of the
// oracle's, and checked against both.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { brokenAt, classifyCall, isTraitDeclaration, lastName, Oracle, oracleAnswer, parseSymbol, rowCrate, shapeOf, type OracleOutput } from "../bench/resolution/classify.ts";
import { resolutionOf, type Applicability, type CalleeLocation } from "../src/plan/applicability.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "test/fixtures/resolution");
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const committed = JSON.parse(readFileSync(join(DIR, "oracle.json"), "utf8")) as { oracleSources: Record<string, string>; sources: Record<string, string>; out: OracleOutput };
const oracle = new Oracle(committed.out);

const ok: Applicability = { ok: true, calleeDefinedAt: "x" };
const held = (kind: "callee_unresolved" | "callee_ambiguous" | "callee_return_unknown" | "callee_not_result"): Applicability => ({ ok: false, kind, reason: "r" });
const repo = (path: string, line: number): CalleeLocation => ({ kind: "repository", path, line });
const answerAt = (path: string, line: number, column: number) => oracleAnswer(oracle, oracle.at(path, line, column));
const classOf = (at: CalleeLocation, path: string, line: number, column: number, result: Applicability = ok) => classifyCall({ result, at }, answerAt(path, line, column)).class;

test("the committed index was written from these sources by this oracle", () => {
  const regenerate = "run `node bench/resolution.ts fixtures` after building the oracle";
  for (const [file, sha] of Object.entries(committed.oracleSources)) assert.equal(sha256(readFileSync(join(ROOT, "bench/resolution-oracle", file))), sha, `${file} changed: ${regenerate}`);
  const onDisk = readdirSync(join(DIR, "crate/src")).sort();
  assert.deepEqual(Object.keys(committed.sources).sort(), onDisk.map((f) => `src/${f}`), regenerate);
  for (const [file, sha] of Object.entries(committed.sources)) assert.equal(sha256(readFileSync(join(DIR, "crate", file))), sha, `${file} changed: ${regenerate}`);
  assert.equal(committed.out.misaligned, 0);
});

test("two functions named load: the one the call reaches is same, the other wrong, none chosen voided", () => {
  // src/caller.rs:2 `crate::a::load("z")`, the name at column 22.
  assert.equal(classOf(repo("src/a.rs", 1), "src/caller.rs", 2, 22), "same");
  assert.equal(classOf(repo("src/b.rs", 1), "src/caller.rs", 2, 22), "wrong");
  assert.equal(classOf(null, "src/caller.rs", 2, 22, held("callee_ambiguous")), "voided");
  // Settled to the right definition, which does not return a Result: still same, and the reason kept.
  const c = classifyCall({ result: held("callee_not_result"), at: repo("src/a.rs", 1) }, answerAt("src/caller.rs", 2, 22));
  assert.deepEqual([c.class, c.reason, c.resolution], ["same", "callee_not_result", "resolved"]);
});

test("versions of one thing: same_in_versions when rust-analyzer's definition is one of them", () => {
  const both: CalleeLocation = { kind: "versions", path: "src/a.rs", line: 1, all: [{ path: "src/a.rs", line: 1 }, { path: "src/b.rs", line: 1 }] };
  const other: CalleeLocation = { kind: "versions", path: "src/b.rs", line: 1, all: [{ path: "src/b.rs", line: 1 }, { path: "src/shapes.rs", line: 25 }] };
  assert.equal(classOf(both, "src/caller.rs", 2, 22), "same_in_versions");
  assert.equal(classOf(other, "src/caller.rs", 2, 22), "wrong");
});

test("a trait method called through dyn is dispatch, with or without a default body; on a concrete type it is the impl's", () => {
  assert.equal(answerAt("src/shapes.rs", 27, 6).kind, "dispatch"); // s.put(), declared without a body
  assert.equal(answerAt("src/shapes.rs", 28, 6).kind, "dispatch"); // s.get(), a default body, kind `Method`
  // d.get() on the concrete Disk: the default body, which rust-analyzer names by the trait. It is
  // dispatch too, though one definition is reached — the record counts it apart (docs/resolution.md).
  assert.equal(answerAt("src/shapes.rs", 35, 6).kind, "dispatch");
  assert.equal(classOf(repo("src/shapes.rs", 11), "src/shapes.rs", 26, 6), "same"); // d.put() → impl Store for Disk
  assert.equal(classOf(repo("src/shapes.rs", 2), "src/shapes.rs", 26, 6), "wrong");
});

test("a row of the table outside is same when rust-analyzer names the same crate and function", () => {
  const read: CalleeLocation = { kind: "outside", row: "fs::read" };
  const write: CalleeLocation = { kind: "outside", row: "fs::write" };
  assert.equal(classOf(read, "src/shapes.rs", 29, 21), "same");
  assert.equal(classOf(write, "src/shapes.rs", 29, 21), "wrong");
  assert.equal(classOf(repo("src/a.rs", 1), "src/shapes.rs", 29, 21), "wrong");
  assert.equal(rowCrate("fs::read"), "std");
  assert.equal(rowCrate("serde_json::from_str"), "serde_json");
});

test("not a function, a macro's arguments, a non-ASCII line, and nothing indexed", () => {
  assert.equal(answerAt("src/shapes.rs", 30, 13).kind, "not_fn"); // Point(1), a tuple struct
  assert.equal(answerAt("src/shapes.rs", 32, 4).kind, "not_fn"); // f(), a closure
  assert.equal(classOf(repo("src/a.rs", 1), "src/shapes.rs", 33, 29), "same"); // inside twice!(…)
  // `("é", crate::b::load("é"))`: column 28 in UTF-16, 29 in UTF-8.
  assert.equal(classOf(repo("src/b.rs", 1), "src/shapes.rs", 34, 28), "same");
  assert.equal(oracle.at("src/shapes.rs", 34, 29), undefined);
  assert.equal(classOf(null, "src/shapes.rs", 1, 0, held("callee_unresolved")), "both_unresolved");
  assert.equal(classOf(repo("src/a.rs", 1), "src/shapes.rs", 1, 0), "oracle_unresolved");
});

test("callers: rust-analyzer's references to a::load sit in uses_a and run, never in uses_b", () => {
  const load = committed.out.symbols.findIndex(([s]) => s.endsWith(" a/load()."));
  const around = oracle.refsTo(load).map((r) => oracle.enclosing(r.path, r.line)).map((e) => e && `${lastName(oracle.symbol(e.id).text)}@${e.def.line}`);
  assert.deepEqual(around.sort(), ["run@25", "uses_a@1"]);
});

test("a symbol of the repository's own crate with no definition in the index is generated: not outside, and no handwritten definition", () => {
  const out: OracleOutput = { ...committed.out, symbols: [...committed.out.symbols, ["rust-analyzer cargo fixture 0.1.0 shapes/impl#[Disk][Default]default().", ""], ["rust-analyzer cargo serde 1.0.0 de/from_str().", ""]] };
  const o = new Oracle(out);
  const n = committed.out.symbols.length;
  assert.equal(oracleAnswer(o, [n]).kind, "generated");
  assert.equal(oracleAnswer(o, [n + 1]).kind, "outside");
  // A handwritten definition the product settled, where the callee is generated, is another one…
  assert.equal(classifyCall({ result: ok, at: repo("src/a.rs", 1) }, oracleAnswer(o, [n]), (p) => o.files.has(p)).class, "wrong");
  // …unless it is in a file the index does not hold, where nothing tells the two apart.
  assert.equal(classifyCall({ result: ok, at: repo("benches/b.rs", 1) }, oracleAnswer(o, [n]), (p) => o.files.has(p)).class, "oracle_generated");
  assert.equal(classifyCall({ result: held("callee_unresolved"), at: null }, oracleAnswer(o, [n])).class, "oracle_generated");
});

test("symbols are read by their descriptors", () => {
  const std = "rust-analyzer cargo std https://github.com/rust-lang/rust/library/std fs/read().";
  assert.deepEqual([parseSymbol(std).crate, lastName(std), shapeOf(std)], ["std", "read", "callable"]);
  assert.equal(shapeOf("rust-analyzer cargo fixture 0.1.0 shapes/twice!"), "macro");
  assert.equal(shapeOf("rust-analyzer cargo fixture 0.1.0 shapes/Point#"), "other");
  assert.equal(shapeOf("local 3"), "local");
  assert.equal(lastName("rust-analyzer cargo criterion 0.8.2 impl#[`Criterion<M>`]bench_function()."), "bench_function");
  assert.equal(isTraitDeclaration("rust-analyzer cargo fixture 0.1.0 shapes/Store#get()."), true);
  assert.equal(isTraitDeclaration("rust-analyzer cargo fixture 0.1.0 shapes/impl#[Disk][Store]put()."), false);
  assert.equal(isTraitDeclaration("rust-analyzer cargo core https://github.com/rust-lang/rust/library/core result/impl#[`Result<T, E>`][Try]branch()."), false);
  assert.equal(isTraitDeclaration("rust-analyzer cargo std https://github.com/rust-lang/rust/library/std io/Read#read_to_string()."), true);
  assert.equal(isTraitDeclaration(std), false);
});

test("the broken reading moves every same to wrong", () => {
  const ats = [repo("src/a.rs", 1), repo("src/b.rs", 1)];
  const moved = brokenAt(ats);
  assert.deepEqual(moved, [repo("src/b.rs", 1), repo("src/a.rs", 1)]);
  assert.equal(classOf(ats[0]!, "src/caller.rs", 2, 22), "same");
  assert.equal(classOf(moved[0]!, "src/caller.rs", 2, 22), "wrong");
});

test("resolutionOf reads where the callee settled, not whether it returns a Result", () => {
  assert.equal(resolutionOf(held("callee_return_unknown"), repo("src/a.rs", 1)), "resolved");
  assert.equal(resolutionOf(ok, { kind: "outside", row: "fs::read" }), "resolved");
  assert.equal(resolutionOf(ok, { kind: "versions", path: "a", line: 1, all: [] }), "ambiguous");
  assert.equal(resolutionOf(held("callee_ambiguous"), null), "ambiguous");
  assert.equal(resolutionOf(held("callee_unresolved"), null), "unsupported");
  assert.equal(resolutionOf(held("callee_return_unknown"), null), "unsupported");
});
