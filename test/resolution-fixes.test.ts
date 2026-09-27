// The two fixes ADR 0025 named that #83's third part makes: a row of the table outside is matched only
// from its own crate, and a name the search hits is a caller only where it reads as a call.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { readsAsCall } from "../src/plan/from-diff.ts";
import { outsideResult } from "../src/plan/outside-results.ts";
import { importOf, parseRust } from "../src/syntax/rust.ts";

const at = (source: string, line: number, name: string) => importOf(parseRust(source), line, name);

test("use: nested lists, self, aliases and a list at the top are expanded; a glob brings no name", () => {
  const src = [
    "use std::fs::{self, OpenOptions};", // 1
    "use std::{io, path::{Path, PathBuf}};", // 2
    "use std::fs::File as F;", // 3
    "use { async_trait::async_trait, tokio::{fs as tfs, io::AsyncWriteExt} };", // 4
    "use std::io::*;", // 5
    "fn main() {}", // 6
  ].join("\n");
  assert.deepEqual(at(src, 6, "fs"), ["std", "fs"]);
  assert.deepEqual(at(src, 6, "OpenOptions"), ["std", "fs", "OpenOptions"]);
  assert.deepEqual(at(src, 6, "io"), ["std", "io"]);
  assert.deepEqual(at(src, 6, "PathBuf"), ["std", "path", "PathBuf"]);
  assert.deepEqual(at(src, 6, "F"), ["std", "fs", "File"]);
  assert.deepEqual(at(src, 6, "tfs"), ["tokio", "fs"]);
  assert.deepEqual(at(src, 6, "Read"), null, "a glob brings no name it can be looked up by");
});

test("use: a block's use reaches only that block, the innermost wins, and a mod needs use super::*", () => {
  const src = [
    "use std::fs;", // 1
    "fn a() {", // 2
    "    use tokio::fs;", // 3
    "    fs::write(p, b);", // 4
    "}", // 5
    "fn b() { fs::write(p, b); }", // 6
    "mod inner {", // 7
    "    fn c() { fs::write(p, b); }", // 8
    "}", // 9
    "mod glob {", // 10
    "    use super::*;", // 11
    "    fn d() { fs::write(p, b); }", // 12
    "}", // 13
  ].join("\n");
  assert.deepEqual(at(src, 4, "fs"), ["tokio", "fs"], "the function's own use wins");
  assert.deepEqual(at(src, 6, "fs"), ["std", "fs"], "the file's use outside that function");
  assert.equal(at(src, 8, "fs"), null, "a mod is not reached by a use outside it");
  assert.deepEqual(at(src, 12, "fs"), ["std", "fs"], "unless it writes use super::*");
  // Two uses in one block bringing one name by different paths settle nothing.
  assert.equal(at("use std::fs;\nuse tokio::fs;\nfn e() {}", 3, "fs"), null);
});

test("macros whose arguments are not read as calls are recorded, call-shaped or not", () => {
  const src = [
    "fn run() {", // 1
    "    let h = tauri::generate_handler![commands::get, commands::put];", // 2
    "    let v = json!({ \"description\": \"Directory to analyze (defaults)\" });", // 3
    "    if matches!(x, Foo(y)) {}", // 4
    "    let w = vec![a(1), b(2)];", // 5
    "}", // 6
  ].join("\n");
  const unread = parseRust(src).macrosUnreadAt.map((s) => s.startLine);
  assert.ok(unread.includes(2), "no call shape: generate_handler!");
  assert.ok(unread.includes(3), "arguments that do not read as an expression: json!");
  assert.ok(unread.includes(4), "a pattern: matches!");
  assert.ok(!unread.includes(5), "vec! is read, and its calls are listed");
});

/** A repository of strings, read as the product reads a Rust file (with its parse). */
function repo(files: Record<string, string>): Discoverer {
  return {
    async search() {
      return { hits: [], more: false };
    },
    async index(path: string) {
      return files[path] ? new BlockIndex(files[path]!.split("\n"), { path }) : null;
    },
  } as unknown as Discoverer;
}

test("a row outside is matched only from its own crate", () => {
  const imports = (source: string, line: number) => (name: string) => at(source, line, name);
  const std = "use std::fs;\nfn f() { fs::write(p, b); }";
  const tokio = "use tokio::fs;\nfn f() { fs::write(p, b); }";
  const nested = "use { a::b, tokio::{fs, io::X} };\nfn f() { fs::create_dir_all(p); }";
  const file = "use tokio::{fs::File, io};\nfn f() { File::open(p); }";
  const stdFile = "use std::fs::{self, File};\nfn f() { File::open(p); }";
  assert.equal(outsideResult("fs::write", imports(std, 2))?.path, "fs::write");
  assert.equal(outsideResult("fs::write", imports(tokio, 2)), undefined, "use tokio::fs");
  assert.equal(outsideResult("fs::create_dir_all", imports(nested, 2)), undefined, "a use list at the top");
  assert.equal(outsideResult("File::open", imports(file, 2)), undefined, "File from tokio, in a list");
  assert.equal(outsideResult("File::open", imports(stdFile, 2))?.path, "File::open");
  assert.equal(outsideResult("tokio::fs::write", imports(tokio, 2)), undefined, "written from tokio");
  assert.equal(outsideResult("std::fs::read", imports("fn f() {}", 1))?.path, "fs::read", "written from std, no use needed");
  // No `use` brings the name in (a glob, `use super::*` from a parent file, a `use` inside a macro):
  // matched by its ending as before — unless it is written from another crate.
  assert.equal(outsideResult("fs::read", imports("fn f() {}", 1))?.path, "fs::read", "nothing brings fs in: as before");
  assert.equal(outsideResult("fs::write", imports("use std::io::*;\nfn f() {}", 2))?.path, "fs::write", "a glob: as before");
  assert.equal(outsideResult("sfs::write", imports("use std::fs::{self as sfs};\nfn f() {}", 2))?.path, "fs::write", "self, renamed");
  assert.equal(outsideResult("F::open", imports("use std::fs::File as F;\nfn f() {}", 2))?.path, "File::open", "an alias is read as what it names");
  assert.equal(outsideResult("env::var", imports("use std::env;\nfn f() {}", 2)), undefined, "std::env::var needs the longer path, as before");
  // Without the file's uses (a file not read as Rust), the ending alone, as before #83.
  assert.equal(outsideResult("fs::write")?.path, "fs::write");
});

test("a line the search hits is a caller only where it reads as a call", async () => {
  const path = "src/a.rs";
  const source = [
    "fn target() {}", // 1
    "// target is called elsewhere", // 2
    "fn in_comment() {", // 3
    "    // target()", // 4
    "}", // 5
    "fn in_string() {", // 6
    "    let s = \"target (x)\";", // 7
    "}", // 8
    "fn parameter(target: u8) {}", // 9
    "fn calls() {", // 10
    "    target();", // 11
    "}", // 12
    "fn nested() {", // 13
    "    fn inner() { target(); }", // 14
    "}", // 15
    "fn handler() {", // 16
    "    let h = tauri::generate_handler![target, other];", // 17
    "}", // 18
    "fn json_string() {", // 19
    "    let v = json!({ \"d\": \"target (x)\" });", // 20
    "}", // 21
    "fn raw() {", // 22
    "    let p = r\"C:\\\";", // 23
    "    target();", // 24
    "}", // 25
    "fn value() {", // 26
    "    let xs = v.iter().map(target);", // 27
    "}", // 28
    "fn local(target: u8) {", // 29
    "    let s = Some(target);", // 30
    "}", // 31
    "fn shadow() {", // 32
    "    let target = 3;", // 33
    "    use_it(target);", // 34
    "}", // 35
  ].join("\n");
  const discoverer = repo({ [path]: source });
  const listing = enumerate(path, source, { parsed: parseRust(source) });
  const fnAt = (line: number) => [...listing.functions].filter((f) => line >= f.startLine && line <= f.endLine).sort((a, b) => a.startLine - b.startLine)[0]!;
  const reads = (line: number) => readsAsCall(discoverer, listing, fnAt(line), path, line, "target");
  assert.equal(await reads(4), false, "a comment");
  assert.equal(await reads(7), false, "a string");
  assert.equal(await reads(9), false, "a parameter");
  assert.equal(await reads(11), true, "a call");
  assert.equal(await reads(14), true, "a call in a function inside it, by the line");
  assert.equal(await reads(17), true, "a macro whose arguments are not read: not read is not no call");
  assert.equal(await reads(20), false, "a string inside such a macro is still a string");
  assert.equal(await reads(24), true, "a listed call after a raw string the comment stripper misreads");
  assert.equal(await reads(27), true, "the function passed as a value");
  assert.equal(await reads(30), false, "a parameter of the same name, used");
  assert.equal(await reads(34), false, "a local of the same name, used");
  assert.equal(await reads(33), false, "the line that binds the local");
  // A function whose calls were cut is taken as before.
  assert.equal(await readsAsCall(discoverer, listing, { ...fnAt(9), callsCut: true }, path, 9, "target"), true);
});

test("codeOnly ends a raw string at its own closing quote and hashes", async () => {
  const { codeOnly } = await import("../src/plan/result-type.ts");
  assert.equal(codeOnly('let p = r"C:\\";\ntarget();'), 'let p = r"   ";\ntarget();', "a backslash does not escape the end of a raw string");
  assert.equal(codeOnly('let s = r#"say "hi" f()"#; g();'), 'let s = r#"            "#; g();');
  assert.equal(codeOnly('let b = br"x"; g();'), 'let b = br" "; g();');
  assert.equal(codeOnly("let err = 1; for r in xs { g(); }"), "let err = 1; for r in xs { g(); }", "an r in a name or alone is not a raw string");
});
