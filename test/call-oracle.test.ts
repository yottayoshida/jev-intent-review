// The call oracle's fixtures (#81, docs/call-oracle.md). No Rust toolchain: the oracle's output is
// committed with the sha of each fixture and of the oracle's sources, and checked against both.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { classify, isMethodCandidate, listings, testOnlyFiles, type FileResult, type OracleFile } from "../bench/call-oracle/classify.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "test/fixtures/call-oracle");
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const oracle = JSON.parse(readFileSync(join(DIR, "oracle.json"), "utf8")) as { sources: Record<string, string>; files: (OracleFile & { sha256: string })[] };
const baseline = JSON.parse(readFileSync(join(DIR, "baseline.json"), "utf8")) as FileResult[];
const source = (path: string) => readFileSync(join(DIR, path), "utf8");
const byPath = (path: string) => baseline.find((f) => f.path === path)!;

test("the committed oracle output was written from these fixtures by this oracle", () => {
  const regenerate = "run `node bench/call-oracle.ts fixtures` after building the oracle";
  for (const [file, sha] of Object.entries(oracle.sources)) assert.equal(sha256(readFileSync(join(ROOT, "bench/call-oracle", file))), sha, `${file} changed: ${regenerate}`);
  for (const f of oracle.files) assert.equal(sha256(readFileSync(join(DIR, f.path))), f.sha256, `${f.path} changed: ${regenerate}`);
  // A fixture added without writing the output again is not in oracle.json at all.
  const onDisk = readdirSync(DIR).filter((n) => n.endsWith(".rs")).sort();
  assert.deepEqual(oracle.files.map((f) => f.path).sort(), onDisk, regenerate);
  assert.deepEqual(baseline.map((f) => f.path).sort(), onDisk, regenerate);
});

test("a file a parent declares #[cfg(test)] mod …; is test-only, with everything under its directory", () => {
  const declared = oracle.files.find((f) => f.path === "tests_and_cfg.rs")!.mods;
  assert.deepEqual(declared, [{ name: "tests", path: null, test: true }]);
  const test = (name: string, path: string | null = null) => ({ name, path, test: true });
  const plain = (name: string, path: string | null = null) => ({ name, path, test: false });
  const files = [
    // moltis: crates/gateway/src/server/mod.rs declares `#[cfg(test)] mod tests_legacy;`
    { path: "crates/gateway/src/server/mod.rs", mods: [test("tests_legacy"), plain("routes")] },
    { path: "crates/gateway/src/server/tests_legacy/mod.rs", mods: [] },
    { path: "crates/gateway/src/server/tests_legacy/hooks.rs", mods: [] },
    { path: "crates/gateway/src/server/routes.rs", mods: [] },
    // `a.rs` keeps its modules under `a/`
    { path: "src/store.rs", mods: [test("tests")] },
    { path: "src/store/tests.rs", mods: [] },
    { path: "src/tests.rs", mods: [] },
    // moltis discord: a file loaded through `#[path]` keeps its children beside it
    { path: "crates/discord/src/handler.rs", mods: [plain("implementation", "handler/implementation.rs")] },
    { path: "crates/discord/src/handler/implementation.rs", mods: [test("tests")] },
    { path: "crates/discord/src/handler/tests.rs", mods: [] },
    { path: "crates/discord/src/handler/implementation/tests.rs", mods: [] },
    // moltis skill_tools: a test-only file's module without a `cfg` of its own, through `#[path]`
    { path: "crates/tools/src/skill_tools/mod.rs", mods: [test("tests")] },
    { path: "crates/tools/src/skill_tools/tests.rs", mods: [plain("read", "read.rs")] },
    { path: "crates/tools/src/skill_tools/read.rs", mods: [] },
    // `..` in a `#[path]`
    { path: "crates/setup/src/service/implementation.rs", mods: [test("tests", "../tests.rs")] },
    { path: "crates/setup/src/tests.rs", mods: [] },
  ];
  assert.deepEqual(
    [...testOnlyFiles(files)].sort(),
    [
      "crates/discord/src/handler/tests.rs",
      "crates/gateway/src/server/tests_legacy/hooks.rs",
      "crates/gateway/src/server/tests_legacy/mod.rs",
      "crates/setup/src/tests.rs",
      "crates/tools/src/skill_tools/read.rs",
      "crates/tools/src/skill_tools/tests.rs",
      "src/store/tests.rs",
    ],
  );
});

test("in a test-only file no call is in scope and every candidate is a false positive for being there", () => {
  const f = oracle.files.find((x) => x.path === "where_clause.rs")!;
  const text = source(f.path);
  const r = classify(f, text, listings(f.path, text), { testOnlyFile: true });
  assert.equal(r.calls.length, 0);
  assert.ok(r.candidates.length > 0);
  assert.ok(r.candidates.every((c) => c.class === "false_positive" && c.reason === "test_only"));
});

test("the oracle finds as many calls in each fixture as were counted by hand before it ran", () => {
  assert.ok(oracle.files.length >= 13);
  for (const f of oracle.files) {
    assert.ok(f.parsed, f.path);
    const counted = Number(/expected-oracle-calls: (\d+)/.exec(source(f.path))![1]);
    assert.equal(f.calls!.length, counted, f.path);
  }
});

test("classifying the fixtures with today's listing gives the committed baseline", () => {
  // #83 changes the listing and must change baseline.json with it: the difference is its record.
  for (const f of oracle.files) {
    const text = source(f.path);
    assert.deepEqual(classify(f, text, listings(f.path, text)), byPath(f.path), f.path);
  }
});

test("the known shapes appear by name in the baseline", () => {
  const call = (path: string, last: string) => byPath(path).calls.find((c) => c.last === last)!;
  const candidate = (path: string, callee: string) => byPath(path).candidates.find((c) => c.callee === callee)!;

  assert.equal(call("turbofish.rs", "foo").class, "silent_miss");
  assert.equal(call("turbofish.rs", "foo").turbofish, "last");
  assert.equal(call("turbofish.rs", "collect").class, "silent_miss");
  assert.equal(call("turbofish.rs", "new").turbofish, "inner");
  assert.equal(call("turbofish.rs", "new").class, "detected");

  assert.equal(candidate("comments.rs", "old_call").reason, "comment");
  assert.equal(candidate("comments.rs", "trailing_note").reason, "comment");
  assert.equal(candidate("comments.rs", "not_a_call").reason, "string");

  assert.deepEqual(byPath("one_line.rs").calls.map((c) => c.class), ["silent_miss", "silent_miss"]);
  assert.equal(call("multiline.rs", "compute").class, "silent_miss");

  assert.equal(call("macro_names.rs", "write").class, "silent_miss");
  assert.equal(call("macro_names.rs", "write").macroNameCollision, true);
  assert.equal(candidate("macro_names.rs", "compute").class, "in_macro");
  assert.equal(call("constructors.rs", "Ok").class, "declared_exclusion");
  assert.equal(call("constructors.rs", "A").capitalized, true);
  assert.equal(candidate("constructors.rs", "E::A").reason, "pattern");
  assert.equal(candidate("types.rs", "Fn").reason, "type");

  assert.equal(candidate("nested.rs", "inner").reason, "definition");
  assert.equal(byPath("nested.rs").candidates.filter((c) => c.callee === "deep").map((c) => c.reason ?? c.class).sort().join(), "duplicate,matched");
  assert.equal(call("nested.rs", "deep").fn.name, "inner");
  assert.equal(candidate("tests_and_cfg.rs", "check").reason, "test_only");
  assert.equal(call("raw.rs", "type").class, "detected");
});

test("taking the listing's method calls out moves exactly those calls from detected to silent_miss", () => {
  // Against a pairing that matched nothing, or matched on the wrong key, the counts would not move
  // together (docs/call-oracle.md, *Checking the oracle*).
  let moved = 0;
  let methods = 0;
  for (const f of oracle.files) {
    const text = source(f.path);
    const lines = text.split("\n");
    const l = listings(f.path, text);
    const isMethod = (c: { line: number; column: number }) => isMethodCandidate(lines, c);
    methods += l.capped.calls.filter(isMethod).length;
    const broken = classify(f, text, { ...l, capped: { ...l.capped, calls: l.capped.calls.filter((c) => !isMethod(c)) } });
    const before = byPath(f.path);
    before.calls.forEach((c, i) => {
      const after = broken.calls[i]!;
      if (c.class === after.class) return;
      assert.equal(c.class, "detected", `${f.path} ${c.last}`);
      assert.equal(after.class, "silent_miss", `${f.path} ${c.last}`);
      assert.equal(c.kind, "method", `${f.path} ${c.last}`);
      moved += 1;
    });
  }
  const detectedMethods = baseline.flatMap((f) => f.calls).filter((c) => c.kind === "method" && c.class === "detected").length;
  assert.ok(detectedMethods > 0);
  assert.equal(methods, detectedMethods);
  assert.equal(moved, detectedMethods);
});
