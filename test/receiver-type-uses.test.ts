// Where the answer about a method named like one of std's is used, it only takes away (#83, ADR 0027):
// a sibling's seed and a decisive body's second level. A repository made of strings.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import type { ChangeAnalysis } from "../src/change/seeds.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { decisiveBodies } from "../src/evidence/builder.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { CandidateFiles } from "../src/plan/from-diff.ts";
import { siblingsOf } from "../src/plan/siblings.ts";
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

const FOO = [
  "pub struct Foo;", // 1
  "impl Foo {", // 2
  "    pub fn len(&self) -> Result<usize, ()> { Ok(0) }", // 3
  "}", // 4
  "pub fn helper() -> Result<(), ()> { Ok(()) }", // 5
].join("\n");

async function seedsOf(changed: string): Promise<string[]> {
  const files = {
    "src/foo.rs": FOO,
    "src/a.rs": changed,
    "src/b.rs": "use crate::foo::Foo;\nfn other(f: &Foo) -> Result<(), ()> {\n    f.len()?;\n    crate::foo::helper()?;\n    Ok(())\n}\n",
  };
  const d = repo(files);
  const candidates = enumerate("src/a.rs", changed, { parsed: parseRust(changed) });
  const fn = candidates.functions.find((f) => f.name === "touch")!;
  const change = { regions: [], files: [], changedPaths: [], definedSymbols: [], calledSymbols: [], changedIdentifiers: [], concepts: [], skipped: [] } as unknown as ChangeAnalysis;
  const set = await siblingsOf(new CandidateFiles(d), d, change, [{ fn, candidates }], new Set([fn.id]));
  return set.seeds.map((s) => s.name).sort();
}

test("a std-named method only on a removed line is no seed; a function of such a name there is", async () => {
  const files = {
    "src/foo.rs": [
      "pub struct Foo;", // 1
      "impl Foo {", // 2
      "    pub fn map_err(&self) -> Result<(), ()> { Ok(()) }", // 3
      "}", // 4
      "pub fn read(p: &str) -> Result<(), ()> { Ok(()) }", // 5
    ].join("\n"),
    "src/a.rs": "fn touch() -> Result<(), ()> {\n    Ok(())\n}\n",
    "src/b.rs": "use crate::foo::{read, Foo};\nfn other(f: &Foo) -> Result<(), ()> {\n    f.map_err()?;\n    read(\"x\")?;\n    Ok(())\n}\n",
  };
  const d = repo(files);
  const region = { path: "src/a.rs", code: true, block: { name: "touch", startLine: 1, endLine: 3 }, changedLines: [2], added: [], removed: ["    r.map_err()?;", "    read(p)?;"] };
  const change = { regions: [region], files: [], changedPaths: [], definedSymbols: [], calledSymbols: [], changedIdentifiers: [], concepts: [], skipped: [] } as unknown as ChangeAnalysis;
  const set = await siblingsOf(new CandidateFiles(d), d, change, [], new Set());
  assert.deepEqual(set.seeds.map((s) => s.name).sort(), ["read"], "map_err called as a method on a removed line is no seed; read(p) is");
});

test("a std-named method in a check's body is named, not sent, at the second level; a function of such a name is sent", async () => {
  const files = {
    "src/foo.rs": [
      "pub struct Foo;", // 1
      "impl Foo {", // 2
      "    pub fn map_err(&self) -> Result<(), ()> { Ok(()) }", // 3
      "}", // 4
      "pub fn read(p: &str) -> Result<(), ()> { Ok(()) }", // 5
    ].join("\n"),
    "src/check.rs": "pub fn validate(r: R) -> Result<(), ()> {\n    r.map_err()?;\n    read(\"x\")?;\n    Ok(())\n}\n",
  };
  const bodies = await decisiveBodies(repo(files), ["validate"], { path: "src/run.rs", startLine: 1, endLine: 1 });
  assert.ok(!("hold" in bodies));
  if ("hold" in bodies) return;
  assert.deepEqual(bodies.sent.map((b) => b.name).sort(), ["read", "validate"]);
  assert.deepEqual(bodies.notSent, ["map_err"]);
});

test("a std-named method is a seed only when every call of it in the change settles alike", async () => {
  const oneWay = "use crate::foo::Foo;\nimpl Foo {\n    fn touch(&self) -> Result<(), ()> {\n        self.len()?;\n        crate::foo::helper()?;\n        Ok(())\n    }\n}\n";
  assert.deepEqual(await seedsOf(oneWay), ["helper", "len"], "self.len() settles to Foo's: a seed (the control)");
  const twoWays = "use crate::foo::Foo;\nimpl Foo {\n    fn touch(&self, v: Vec<u8>) -> Result<(), ()> {\n        self.len()?;\n        v.len();\n        crate::foo::helper()?;\n        Ok(())\n    }\n}\n";
  assert.deepEqual(await seedsOf(twoWays), ["helper"], "and v.len() on a Vec does not: len is no seed");
});

