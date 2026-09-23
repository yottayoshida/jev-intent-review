// What this check takes on trust about functions it cannot read, and what it refuses to.
// No model, no network: a repository made of strings.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { applicabilityOf } from "../src/plan/applicability.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { OUTSIDE_RESULTS, outsideResult } from "../src/plan/outside-results.ts";

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

/** The applicability of the one call to `callee` in `caller`. */
async function decide(files: Record<string, string>, path: string, caller: string, callee: string) {
  const candidates = enumerate(path, files[path]!);
  const fn = candidates.functions.find((f) => f.name === caller)!;
  assert.ok(fn, `fn ${caller} is a candidate`);
  const call = candidates.calls.find((c) => c.functionId === fn.id && c.callee.split("::").pop() === callee.split("::").pop())!;
  assert.ok(call, `${callee} is a call in ${caller}`);
  return applicabilityOf(repo(files), fn, call);
}

test("(a) a path into the standard library is matched however the caller wrote it", async () => {
  const files = { "src/a.rs": `pub fn run(p: &Path) -> Result<(), E> {\n    let text = std::fs::read_to_string(p)?;\n    Ok(())\n}\n` };
  const long = await decide(files, "src/a.rs", "run", "std::fs::read_to_string");
  assert.equal(long.ok, true, long.ok ? "" : long.reason);
  if (long.ok) assert.equal(long.calleeDefinedAt, "fs::read_to_string");

  const short = { "src/a.rs": `use std::fs;\n\npub fn run(p: &Path) -> Result<(), E> {\n    let text = fs::read_to_string(p)?;\n    Ok(())\n}\n` };
  const r = await decide(short, "src/a.rs", "run", "fs::read_to_string");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("(b) a method call is not matched, whatever the table holds", async () => {
  const files = { "src/a.rs": `pub fn run(f: &mut File) -> Result<(), E> {\n    f.read_to_string(&mut buf)?;\n    Ok(())\n}\n` };
  const r = await decide(files, "src/a.rs", "run", "read_to_string");
  assert.equal(r.ok, false, "the receiver's type is not read, so the name settles nothing");
  if (!r.ok) assert.equal(r.kind, "callee_unresolved");
});

test("(c) `entry.file_type()` is not matched: the name means different things on different types", async () => {
  const files = { "src/a.rs": `pub fn run(entry: &DirEntry) -> Result<(), E> {\n    let kind = entry.file_type()?;\n    Ok(())\n}\n` };
  const r = await decide(files, "src/a.rs", "run", "file_type");
  assert.equal(r.ok, false);
  assert.equal(outsideResult("file_type"), undefined, "a bare name is not a path");
});

test("(d) `std::` wins over this repository's definitions; a shorter path does not", async () => {
  const shadowed = {
    "src/a.rs": `pub fn run(p: &Path) -> Result<(), E> {\n    let text = std::fs::read_to_string(p)?;\n    Ok(())\n}\n`,
    "src/fs/read.rs": `pub fn read_to_string(p: &Path) -> String {\n    String::new()\n}\n`,
  };
  const std = await decide(shadowed, "src/a.rs", "run", "std::fs::read_to_string");
  assert.equal(std.ok, true, "the call named the standard library");
  if (std.ok) assert.equal(std.calleeDefinedAt, "fs::read_to_string");

  const ours = {
    "src/a.rs": `use crate::fs;\n\npub fn run(p: &Path) -> Result<(), E> {\n    let text = fs::read_to_string(p);\n    Ok(())\n}\n`,
    "src/fs/read.rs": `pub fn read_to_string(p: &Path) -> String {\n    String::new()\n}\n`,
  };
  const here = await decide(ours, "src/a.rs", "run", "fs::read_to_string");
  assert.equal(here.ok, false, "this repository defines it, and that definition decides");
  if (!here.ok) assert.equal(here.kind, "callee_not_result");
});

test("(e) a path the table does not hold is held as before", async () => {
  const files = { "src/a.rs": `pub fn run(v: &Value) -> Result<(), E> {\n    let s = other_crate::render(v)?;\n    Ok(())\n}\n` };
  const r = await decide(files, "src/a.rs", "run", "other_crate::render");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "callee_unresolved");
    assert.match(r.reason, /has no definition in this repository/);
  }
});

test("(f) `crate::`, `self::` and `super::` say the callee is here, so the table does not answer", () => {
  for (const path of ["crate::fs::read_to_string", "self::fs::read_to_string", "super::fs::read_to_string"]) {
    assert.equal(outsideResult(path), undefined, path);
  }
  assert.ok(outsideResult("fs::read_to_string"), "the same ending without those words is matched");
});

test("(g) a row written long is matched only long, because the short one means something else", () => {
  assert.equal(outsideResult("env::var"), undefined, "`gix-path`'s `env::var` returns an Option");
  assert.equal(outsideResult("std::env::var")?.path, "std::env::var");
  assert.equal(outsideResult("io::read_to_string"), undefined, "tokio's returns a future");
  assert.equal(outsideResult("std::io::read_to_string")?.path, "std::io::read_to_string");
});

test("(h) a module path does not reach a method of this repository that shares the name", async () => {
  const files = {
    "src/a.rs": `use std::fs;\n\npub fn run(a: &Path, b: &Path) -> Result<(), E> {\n    fs::rename(a, b)?;\n    Ok(())\n}\n`,
    "src/session.rs": `impl Session {\n    pub fn rename(&mut self, to: &str) {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(files, "src/a.rs", "run", "fs::rename");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "fs::rename", "a module holds no method, so the table answers");
});

test("(i) a path with no row is still held when this repository's only definition is a method", async () => {
  const files = {
    "src/a.rs": `use crate::net;\n\npub fn run(a: &Path) -> Result<(), E> {\n    net::retry(a)?;\n    Ok(())\n}\n`,
    "src/session.rs": `impl Session {\n    pub fn retry(&mut self, to: &str) -> Result<(), E> {\n        todo!()\n    }\n}\n`,
  };
  const r = await decide(files, "src/a.rs", "run", "net::retry");
  assert.equal(r.ok, false, "nothing reachable here and no row: the call stays held");
  if (!r.ok) {
    assert.equal(r.kind, "callee_unresolved");
    assert.match(r.reason, /names a module, which holds no method/);
  }
});

test("(j) a path the table holds is answered even when the only definitions here are compiled for tests", async () => {
  const files = {
    "src/lib.rs": `pub mod a;\n#[cfg(test)]\nmod fixtures;\n`,
    "src/a.rs": `use std::fs;\n\npub fn run(p: &Path) -> Result<(), E> {\n    let text = fs::read_to_string(p)?;\n    Ok(())\n}\n`,
    "src/fixtures.rs": `pub fn read_to_string(p: &Path) -> String {\n    String::new()\n}\n`,
  };
  const r = await decide(files, "src/a.rs", "run", "fs::read_to_string");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.calleeDefinedAt, "fs::read_to_string");
});

test("the table's rows each say where their return type was read", () => {
  assert.ok(OUTSIDE_RESULTS.length > 0);
  for (const row of OUTSIDE_RESULTS) {
    assert.match(row.path, /^[\w:]+::[\w]+$/, row.path);
    assert.match(row.from, /:\d+$/, `${row.path} says where it was read`);
    assert.match(row.returns, /\bResult\b/, `${row.path} returns a Result`);
  }
});
