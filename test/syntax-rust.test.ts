// The parser the listing of a Rust file is read with (#83, ADR 0022): the grammar it ships, the calls
// it reads inside and outside macros, the grammar's gaps it works around, and the shapes the rest of
// the tool depends on. No repository, no model.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { parseRust } from "../src/syntax/rust.ts";

const ROOT = resolve(import.meta.dirname, "..");

test("the grammar shipped is the one vendor/README.md names", () => {
  const sha = createHash("sha256").update(readFileSync(join(ROOT, "vendor/tree-sitter-rust.wasm"))).digest("hex");
  assert.equal(sha, "f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57");
  assert.ok(readFileSync(join(ROOT, "vendor/README.md"), "utf8").includes(sha));
});

test("inside a macro whose arguments read as expressions, the calls are read, and a pattern is not a call", () => {
  // Counted by Rust's meaning, not by the rule: `matches!` takes a pattern, so `Foo(y)` in it is no
  // call; `|Foo(x)|` is a closure's pattern; `assert_matches!` takes a pattern and `stringify!` code as
  // text, so neither is read; a `tracing` field (`%id`) does not read as an expression, so that macro is
  // not read at all (ADR 0022). A project's own macro whose arguments read as expressions is read.
  const src = `fn f(x: E, v: Vec<E>, id: u8) {
    assert!(matches!(x, Foo(y)));
    assert!(v.iter().any(|Foo(x)| x > 0));
    assert_eq!(compute(1), expected());
    assert_matches!(x, Err(Bar(_)));
    info!(user = %id, "seen {}", label());
    let w = vec![make(1); count()];
    let v = cost_return_on_error!(cost, tree.get_value(pos));
    let s = stringify!(helper(1));
}
`;
  const listing = enumerate("src/m.rs", src);
  const names = listing.calls.map((c) => c.callee).sort();
  // Line 2: `matches!` is not in the list, so nothing inside it is read. Line 3: `iter`, `any`. Line 4:
  // `compute`, `expected`. Line 5: not read. Line 6: not read (`%id`). Line 7: `make`, `count`. Line 8:
  // `get_value`. Line 9: not read.
  assert.deepEqual(names, ["any", "compute", "count", "expected", "get_value", "iter", "make"]);
  assert.ok(!names.includes("Foo") && !names.includes("Bar") && !names.includes("Err"), "no pattern is a call");
  // `matches!` (inside `assert!`), `assert_matches!`, `info!` and `stringify!` are counted, not read.
  assert.equal(listing.omitted.macros, 4);
  assert.ok(!names.includes("helper"));
});

test("a variable named raw and Rust 2024's unsafe extern do not make the parser give up", () => {
  const src = `fn f(raw: &str) -> Result<String, E> {
    let clean = normalize(&raw)?;
    let p = &raw const x;
    Ok(clean)
}
unsafe fn g() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() }
}
`;
  const parsed = parseRust(src);
  assert.deepEqual(parsed.unread, []);
  const listing = enumerate("src/r.rs", src);
  const byName = new Map(listing.calls.map((c) => [c.callee, c]));
  assert.equal(byName.get("normalize")?.expression, "normalize(&raw)", "the expression is the file's text, not the parser's");
  assert.equal(listing.functions.find((f) => f.id === byName.get("geteuid")?.functionId)?.name, "g");
});

test("columns are UTF-16 and start where the callee is written; the expression is flattened and cut at 300", () => {
  const long = `x${"a".repeat(320)}`;
  const src = `fn f() {\n    let s = "é😀日本"; a::b::foo(1,\n        2);\n    bar(${long});\n}\n`;
  const listing = enumerate("src/u.rs", src);
  const foo = listing.calls.find((c) => c.callee === "a::b::foo")!;
  const line = src.split("\n")[1]!;
  assert.equal(foo.column, line.indexOf("a::b::foo"));
  assert.equal(foo.expression, "a::b::foo(1, 2)");
  assert.equal(foo.expressionComplete, true);
  const bar = listing.calls.find((c) => c.callee === "bar")!;
  assert.equal(bar.expressionComplete, false);
  assert.equal(bar.expression.length, 300);
});

test("enclosing gives a one-line function, and a short function under a doc comment, its own range (#82)", () => {
  const src = `impl Gate {
    /// Whether the gate is open.
    /// It is, today.
    fn is_open(&self) -> bool { true }

    /// The next one.
    fn next(&self) -> u8 {
        1
    }
}
`;
  const index = new BlockIndex(src.split("\n"), { path: "src/gate.rs" });
  assert.deepEqual([index.enclosing(4).startLine, index.enclosing(4).endLine, index.enclosing(4).name], [4, 4, "is_open"]);
  assert.deepEqual([index.enclosing(7).startLine, index.enclosing(7).endLine, index.enclosing(7).name], [7, 9, "next"]);
  assert.equal(index.enclosing(8).name, "next");
  // A string continuing at column 0 does not end the function: the parser knows where it ends (#81).
  const script = `fn run() -> String {\n    let s = r#"\nprint(1)\n"#;\n    go(s)\n}\n`;
  const b = new BlockIndex(script.split("\n"), { path: "src/run.rs" }).enclosing(5);
  assert.deepEqual([b.startLine, b.endLine, b.name], [1, 6, "run"]);
});

test("every BlockIndex src/ builds is told its path, so a Rust file is never read by indentation unseen", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(ROOT, "src"));
  const bare: string[] = [];
  for (const f of files) {
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
      if (/new BlockIndex\(/.test(line) && !/\{\s*path\s*\}|path ===|\bpath\b/.test(line)) bare.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(bare, []);
});

test("the listing's test-only answer and the definitions' are cached apart: neither order changes either", async () => {
  const { tempRepo } = await import("./helpers/repo.ts");
  const { Discoverer } = await import("../src/discovery/discover.ts");
  const { Git } = await import("../src/repository/git.ts");
  const { declaredForTestsOnly } = await import("../src/plan/applicability.ts");
  const repo = tempRepo();
  try {
    repo.write({
      "src/lib.rs": "pub mod server;\n",
      "src/server/mod.rs": "#[cfg(test)]\nmod tests_legacy;\npub mod routes;\n",
      "src/server/tests_legacy/mod.rs": "mod hooks;\n",
      "src/server/tests_legacy/hooks.rs": "fn write_config_hook() { std::fs::write(\"a\", \"b\").unwrap(); }\n",
      "src/server/routes.rs": "pub fn route() {}\n",
    });
    const head = repo.commit("tree");
    const answers = async (deepFirst: boolean) => {
      const d = new Discoverer(new Git(repo.dir), head, { include: () => true });
      const path = "src/server/tests_legacy/hooks.rs";
      const ask = (forListing: boolean) => declaredForTestsOnly(d, path, { forListing });
      const [a, b] = deepFirst ? [await ask(true), await ask(false)] : [await ask(false), await ask(true)];
      const deep = deepFirst ? a : b;
      const shallow = deepFirst ? b : a;
      return { deep, shallow, routes: await declaredForTestsOnly(d, "src/server/routes.rs", { forListing: true }) };
    };
    // The child of a test-only module is test-only for the listing; the definitions' answer, one level
    // up only, is unchanged by #83 (its change is the next plan's).
    assert.deepEqual(await answers(true), { deep: true, shallow: false, routes: false });
    assert.deepEqual(await answers(false), { deep: true, shallow: false, routes: false });
  } finally {
    repo.remove();
  }
});

test("the listing's test-only answer follows #[path]: a file it loads keeps its children beside it", async () => {
  const { tempRepo } = await import("./helpers/repo.ts");
  const { Discoverer } = await import("../src/discovery/discover.ts");
  const { Git } = await import("../src/repository/git.ts");
  const { declaredForTestsOnly } = await import("../src/plan/applicability.ts");
  const repo = tempRepo();
  try {
    // moltis's discord crate: `handler.rs` loads `handler/implementation.rs` through `#[path]`, and that
    // file declares `#[cfg(test)] mod tests;`, which is `handler/tests.rs`, beside it (#83's review).
    repo.write({
      "src/lib.rs": "pub mod handler;\npub mod skill_tools;\n",
      "src/handler.rs": "#[path = \"handler/implementation.rs\"]\nmod implementation;\n",
      "src/handler/implementation.rs": "pub fn run() {}\n\n#[cfg(test)]\nmod tests;\n",
      "src/handler/tests.rs": "fn check() { super::run(); }\n",
      // skill_tools: a test-only file loads another through `#[path]`, with no `cfg` of its own.
      "src/skill_tools/mod.rs": "#[cfg(test)]\nmod tests;\npub fn helpers() {}\n",
      "src/skill_tools/tests.rs": "#[path = \"read.rs\"]\nmod read;\n",
      "src/skill_tools/read.rs": "fn read_all() { std::fs::read(\"x\").unwrap(); }\n",
    });
    const head = repo.commit("tree");
    const d = new Discoverer(new Git(repo.dir), head, { include: () => true });
    const listing = (path: string) => declaredForTestsOnly(d, path, { forListing: true });
    assert.equal(await listing("src/handler/tests.rs"), true);
    assert.equal(await listing("src/skill_tools/read.rs"), true);
    assert.equal(await listing("src/handler/implementation.rs"), false, "the file #[path] loads is not test code");
    assert.equal(await listing("src/handler.rs"), false);
  } finally {
    repo.remove();
  }
});

test("a macro outside every function is counted when it holds a call, and nothing in it is listed", () => {
  const src = `cfg_if::cfg_if! {
    if #[cfg(unix)] {
        fn plat() -> u8 { real() }
    }
}
impl S {
    delegate! { fn f(&self) { self.g() } }
}
lazy_static! { static ref N: u8 = 1; }
`;
  const listing = enumerate("src/p.rs", src);
  assert.deepEqual(listing.functions, []);
  assert.deepEqual(listing.calls, []);
  // `cfg_if!` and `delegate!` hold calls; `lazy_static!` here does not.
  assert.equal(listing.omitted.macros, 2);
});

test("when the parser cannot read a nested function, the calls around it stay the outer function's", () => {
  // `@@` is not Rust: `inner`'s signature is unread, so `inner` is not listed and its body is a hole
  // in `outer`; `h()` after it is still `outer`'s call.
  const src = "fn outer() {\n    fn inner(x: u8 @@) {\n        g();\n    }\n    h();\n}\n";
  const parsed = parseRust(src);
  assert.ok(parsed.unread.some((u) => u.startLine <= 2 && u.endLine >= 2), JSON.stringify(parsed.unread));
  const listing = enumerate("src/n.rs", src);
  assert.deepEqual(listing.functions.map((f) => f.name), ["outer"]);
  assert.equal(listing.calls.find((c) => c.callee === "h")?.functionId, listing.functions[0]!.id);
  assert.ok(!listing.calls.some((c) => c.callee === "g" && c.functionId === listing.functions[0]!.id), "g() is not outer's");
});

test("a line the parser completed with a token the file lacks is counted as not read", () => {
  const listing = enumerate("src/m.rs", "fn outer() {\n    one(1;\n}\nfn two() { three() }\n");
  assert.deepEqual(listing.unread.map((u) => u.startLine), [2]);
  assert.ok(!listing.calls.some((c) => c.callee === "one"));
  assert.ok(listing.calls.some((c) => c.callee === "three"), "the rest of the file is read");
});
