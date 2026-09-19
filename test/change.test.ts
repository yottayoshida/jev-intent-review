import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { definedName, enclosingBlock, looksLikeHeader } from "../src/change/blocks.ts";
import { parseDiff, unquotePath } from "../src/change/diff.ts";
import { analyzeChange, calledNames, isCode, regionsOf, splitWords } from "../src/change/seeds.ts";
import { pathFilter } from "../src/config/glob.ts";
import { Git } from "../src/repository/git.ts";
import { fixtureRepo, tempRepo } from "./helpers/repo.ts";

test("parseDiff reads what git diff -U0 prints for edits, additions, deletions, renames and binaries", async () => {
  const repo = tempRepo();
  try {
    repo.write({
      "edit.ts": "a\nb\nc\n",
      "gone.ts": "bye\n",
      "move.ts": "one\ntwo\nthree\nfour\nfive\n",
      "move-edit.ts": "1\n2\n3\n4\n5\n6\n7\n8\n",
      "with space.ts": "x\n",
      "café.ts": "x\n",
    });
    writeFileSync(join(repo.dir, "bin.dat"), Buffer.from([0, 1, 2]));
    const before = repo.commit("before");
    repo.write({ "edit.ts": "a\nB\nc\nd\n", "new.ts": "hello\n", "with space.ts": "y\n", "café.ts": "y\n" });
    repo.git("rm", "-q", "gone.ts");
    repo.git("mv", "move.ts", "moved.ts");
    repo.git("mv", "move-edit.ts", "moved-edit.ts");
    repo.write({ "moved-edit.ts": "1\n2\n3\n4\n5\n6\n7\nEIGHT\n" });
    writeFileSync(join(repo.dir, "bin.dat"), Buffer.from([0, 9, 9]));
    const after = repo.commit("after");

    const git = await Git.open(repo.dir);
    const files = parseDiff(await git.diffText(before, after));
    const byNew = new Map(files.map((f) => [f.newPath ?? `deleted:${f.oldPath}`, f]));

    const edit = byNew.get("edit.ts");
    assert.equal(edit?.status, "modified");
    assert.deepEqual(
      edit?.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines, h.removed, h.added]),
      [
        [2, 1, 2, 1, ["b"], ["B"]],
        [3, 0, 4, 1, [], ["d"]],
      ],
    );
    assert.equal(byNew.get("new.ts")?.status, "added");
    assert.equal(byNew.get("new.ts")?.oldPath, null);
    assert.equal(byNew.get("deleted:gone.ts")?.status, "deleted");
    assert.equal(byNew.get("moved.ts")?.oldPath, "move.ts");
    assert.equal(byNew.get("moved.ts")?.status, "renamed");
    assert.equal(byNew.get("moved-edit.ts")?.oldPath, "move-edit.ts");
    assert.deepEqual(byNew.get("moved-edit.ts")?.hunks[0]?.added, ["EIGHT"]);
    // Binary is decided by a NUL byte, not by git or an attribute; such a file is never diffed.
    const change = await analyzeChange(git, before, after, () => true);
    assert.deepEqual(change.skipped, [{ path: "bin.dat", reason: "binary, or larger than the read limit" }]);
    assert.ok(!change.regions.some((r) => r.path === "bin.dat"));
    assert.deepEqual(byNew.get("with space.ts")?.hunks[0]?.added, ["y"]);
    assert.deepEqual(byNew.get("café.ts")?.hunks[0]?.added, ["y"]);
  } finally {
    repo.remove();
  }
});

test("unquotePath undoes git's C-style quoting", () => {
  assert.equal(unquotePath('"a\\tb.ts"'), "a\tb.ts");
  assert.equal(unquotePath('"caf\\303\\251.ts"'), "café.ts");
  assert.equal(unquotePath('"q\\"uote.ts"'), 'q"uote.ts');
  assert.equal(unquotePath("plain.ts"), "plain.ts");
});

const TS = `import { x } from "y";

export class Service {
  private cache = new Map();

  async handle(request: Request): Promise<void> {
    const user = await load(request);
    if (user) {
      audit(user);
    }
    save(user);
  }

  other() {
    return 1;
  }
}

export const TTL = 24;
`;

test("enclosingBlock finds the innermost function around a line, not the if or the class", () => {
  const lines = TS.split("\n");
  const block = enclosingBlock(lines, 9); // audit(user)
  assert.deepEqual([block.startLine, block.endLine, block.name, block.windowed], [6, 12, "handle", false]);
  assert.deepEqual([enclosingBlock(lines, 15).startLine, enclosingBlock(lines, 15).name], [14, "other"]);
  const constant = enclosingBlock(lines, 19);
  assert.deepEqual([constant.startLine, constant.endLine, constant.name], [19, 19, "TTL"]);
});

test("enclosingBlock across languages: Python, Go, arrow functions, wrapped parameters, brace on its own line", () => {
  const python = "class A:\n    def run(self, x):\n        if x:\n            go(x)\n        return x\n\n    def other(self):\n        pass\n";
  assert.deepEqual([enclosingBlock(python.split("\n"), 4).startLine, enclosingBlock(python.split("\n"), 4).endLine, enclosingBlock(python.split("\n"), 4).name], [2, 5, "run"]);

  const go = "package main\n\nfunc (s *Server) Handle(w http.ResponseWriter) {\n\tif s.ok {\n\t\ts.write(w)\n\t}\n}\n";
  const g = enclosingBlock(go.split("\n"), 5);
  assert.deepEqual([g.startLine, g.endLine, g.name], [3, 7, "Handle"]);

  const arrow = "export const handler = async (req) => {\n  const a = 1;\n  return send(a);\n};\n";
  const a = enclosingBlock(arrow.split("\n"), 3);
  assert.deepEqual([a.startLine, a.endLine, a.name], [1, 4, "handler"]);

  const wrapped = "export function create(\n  a: string,\n  b: string,\n): void {\n  persist(a, b);\n}\n";
  const w = enclosingBlock(wrapped.split("\n"), 5);
  assert.deepEqual([w.startLine, w.endLine, w.name], [1, 6, "create"]);

  const allman = "class C\n{\n    public void Save(Item item)\n    {\n        Store(item);\n    }\n}\n";
  const c = enclosingBlock(allman.split("\n"), 5);
  assert.deepEqual([c.startLine, c.endLine, c.name], [3, 6, "Save"]);
});

test("looksLikeHeader: definitions yes; calls and control flow no", () => {
  for (const line of ["function x() {", "  async handle(req) {", "def go(self):", "func main() {", "pub fn run() -> u8 {", "  public void Save(Item item)", "const f = (a) => {"]) {
    assert.ok(looksLikeHeader(line), line);
  }
  for (const line of ["  save(record)", "if (x) {", "  } else if (y) {", "for (const a of b) {", "while (true) {", "  return build(x);", "// function x() {"]) {
    assert.ok(!looksLikeHeader(line), line);
  }
});

test("a line that only closes brackets belongs to the block it closes", () => {
  const rust = ["mod tests {", "    #[test]", "    fn works() {", "        check(1);", "    }", "}"];
  const block = enclosingBlock(rust, 5);
  assert.deepEqual([block.startLine, block.endLine, block.name], [3, 5, "works"]);
});

test("a changed doc comment widens the function's region to cover it", () => {
  const lines = ["/// Says whether", "/// the thing holds.", "fn holds() -> bool {", "    probe()", "}"];
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, removed: ["/// old"], added: ["/// Says whether", "/// the thing holds."] };
  const regions = regionsOf({ oldPath: "a.rs", newPath: "a.rs", status: "modified", binary: false, hunks: [hunk] }, "a.rs", lines);
  assert.deepEqual(regions.map((r) => [r.block.startLine, r.block.endLine, r.block.name]), [[1, 5, "holds"]]);
});

test("enclosingBlock falls back to a window when the block is too long", () => {
  const lines = ["function huge() {", ...Array.from({ length: 500 }, (_, i) => `  step${i}();`), "}"];
  const block = enclosingBlock(lines, 250, 300, 10);
  assert.deepEqual([block.startLine, block.endLine, block.windowed], [240, 260, true]);
});

test("splitWords breaks identifiers into lowercase words of four letters or more", () => {
  assert.deepEqual(splitWords("disabledAt"), ["disabled"]);
  assert.deepEqual(splitWords("SESSION_TTL_MS"), ["session"]);
  assert.deepEqual(splitWords("parseHTTPRequest"), ["parse", "http", "request"]);
});

test("analyzeChange on the missed-path fixture: the guard's function, and the call it guards", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, repo.base, repo.head, () => true);
    assert.deepEqual(change.changedPaths, ["src/auth/password.ts"]);
    assert.equal(change.regions.length, 1);
    const region = change.regions[0];
    assert.deepEqual([region?.path, region?.block.name, region?.changedLines], ["src/auth/password.ts", "loginWithPassword", [11]]);
    assert.deepEqual(change.definedSymbols, ["loginWithPassword"]);

    const calls = new Map(change.calledSymbols.map((s) => [s.name, s.onChangedLine]));
    assert.equal(calls.get("createSession"), false, "createSession is called around the change, not on it");
    assert.equal(calls.get("AuthError"), true);
    assert.ok(calls.has("findUserByEmail"));
    assert.ok(change.changedIdentifiers.includes("disabledAt"));
    assert.ok(change.concepts.includes("disabled"));
  } finally {
    repo.remove();
  }
});

test("analyzeChange: a removed guard is placed in the function it was removed from", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, repo.head, repo.base, () => true);
    const region = change.regions[0];
    assert.equal(region?.block.name, "loginWithPassword");
    assert.deepEqual(region?.removed, ["  if (user.disabledAt) throw new AuthError(\"account disabled\");"]);
    assert.equal(change.calledSymbols.find((s) => s.name === "createSession")?.onChangedLine, false);
  } finally {
    repo.remove();
  }
});

test("calledNames counts calls, not the definitions that look like them", () => {
  const text = [
    "class Hub {",
    "  constructor(ctx) {",
    "    this.store = createStore(ctx);",
    "  }",
    "  async handle(req) {",
    "    return route(req);",
    "  }",
    "}",
    "def test_cuts(self):",
    "    self.assertIn(cut(x), y)",
    "function build() { return make(); }",
  ].join("\n");
  assert.deepEqual([...calledNames(text)].sort(), ["assertIn", "createStore", "cut", "make", "route"]);
});

test("isCode goes by extension", () => {
  for (const path of ["src/a.ts", "lib/x.PY", "main.zig", "a/b/c.rs"]) assert.ok(isCode(path), path);
  for (const path of ["README.md", "Makefile", ".github/ci.yml", "dir.ts/file", "notes.txt"]) assert.ok(!isCode(path), path);
});

test("prose and config changes are regions of their own lines and give no call or identifier seeds", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "README.md": "# Title\n\nold words\n", "a.ts": "export function save() {\n  return persist();\n}\n" });
    const before = repo.commit("before");
    repo.write({ "README.md": "# Title\n\nthe words that describe(things)\nmore prose here\n", "a.ts": "export function save() {\n  validate();\n  return persist();\n}\n" });
    const after = repo.commit("after");
    const change = await analyzeChange(await Git.open(repo.dir), before, after, () => true);

    const readme = change.regions.find((r) => r.path === "README.md");
    assert.deepEqual([readme?.code, readme?.block.startLine, readme?.block.endLine, readme?.block.name], [false, 3, 4, undefined]);
    assert.deepEqual(change.changedIdentifiers, ["validate"]);
    assert.deepEqual(change.calledSymbols.map((s) => [s.name, s.onChangedLine]).sort(), [["persist", false], ["validate", true]]);
    assert.ok(!change.concepts.includes("describe"));
  } finally {
    repo.remove();
  }
});

test("changed lines that fall back to windows share one merged region", () => {
  const lines = ["function huge() {", ...Array.from({ length: 500 }, (_, i) => `  step${i}();`), "}"];
  const hunk = { oldStart: 250, oldLines: 3, newStart: 250, newLines: 3, removed: ["a", "b", "c"], added: ["x", "y", "z"] };
  const regions = regionsOf({ oldPath: "a.ts", newPath: "a.ts", status: "modified", binary: false, hunks: [hunk] }, "a.ts", lines);
  assert.equal(regions.length, 1);
  assert.deepEqual([regions[0]?.block.startLine, regions[0]?.block.endLine, regions[0]?.block.windowed], [210, 292, true]);
  assert.deepEqual(regions[0]?.changedLines, [250, 251, 252]);
  assert.deepEqual(regions[0]?.added, ["x", "y", "z"]);
});

test("a run of short top-level statements is one region; a function after it stays its own", () => {
  const lines = ["import a", "import b", "", "const X = 1", "const Y = 2", "", "", "", "def run(x):", "    work(x)", "    more(x)", "    done(x)"];
  const hunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 12, removed: [], added: lines };
  const regions = regionsOf({ oldPath: null, newPath: "a.py", status: "added", binary: false, hunks: [hunk] }, "a.py", lines);
  assert.deepEqual(
    regions.map((r) => [r.block.startLine, r.block.endLine, r.block.name ?? null]),
    [
      [1, 5, null],
      [9, 12, "run"],
    ],
  );
});

test("two short neighbouring functions keep their own regions and names", () => {
  const lines = ["function login() {", "  return open();", "}", "", "function logout() {", "  return close();", "}"];
  const hunks = [
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, removed: ["  return x();"], added: ["  return open();"] },
    { oldStart: 6, oldLines: 1, newStart: 6, newLines: 1, removed: ["  return y();"], added: ["  return close();"] },
  ];
  const regions = regionsOf({ oldPath: "a.ts", newPath: "a.ts", status: "modified", binary: false, hunks }, "a.ts", lines);
  assert.deepEqual(regions.map((r) => [r.block.startLine, r.block.endLine, r.block.name]), [
    [1, 3, "login"],
    [5, 7, "logout"],
  ]);
});

test("a removed function belongs to neither neighbour; a removed line inside one belongs to it", () => {
  // After the change: a (1-3), blank, c (5-7). b stood between a and c.
  const lines = ["function a() {", "  one();", "}", "", "function c() {", "  three();", "}"];
  const between = { oldStart: 5, oldLines: 4, newStart: 4, newLines: 0, removed: ["function b() {", "  two();", "}", ""], added: [] };
  const [removed] = regionsOf({ oldPath: "a.ts", newPath: "a.ts", status: "modified", binary: false, hunks: [between] }, "a.ts", lines);
  assert.deepEqual([removed?.block.startLine, removed?.block.endLine, removed?.block.name], [4, 4, undefined]);
  assert.deepEqual(removed?.removed, ["function b() {", "  two();", "}", ""]);

  const inside = { oldStart: 3, oldLines: 1, newStart: 2, newLines: 0, removed: ["  guard();"], added: [] };
  const [kept] = regionsOf({ oldPath: "a.ts", newPath: "a.ts", status: "modified", binary: false, hunks: [inside] }, "a.ts", lines);
  assert.deepEqual([kept?.block.startLine, kept?.block.endLine, kept?.block.name], [1, 3, "a"]);
});

test("a comment added after the last function is a region of its own, not a window", () => {
  const lines = ["function a() {", "  one();", "}", "", "// trailing note"];
  const hunk = { oldStart: 4, oldLines: 0, newStart: 5, newLines: 1, removed: [], added: ["// trailing note"] };
  const regions = regionsOf({ oldPath: "a.ts", newPath: "a.ts", status: "modified", binary: false, hunks: [hunk] }, "a.ts", lines);
  assert.deepEqual(regions.map((r) => [r.block.startLine, r.block.endLine, r.block.windowed]), [[5, 5, false]]);
});

test("removing the last line of a Python or Ruby body stays in that function; removing a method does not", () => {
  const python = ["def a():", "    one()", "", "def b():", "    two()"];
  const pyHunk = { oldStart: 3, oldLines: 1, newStart: 2, newLines: 0, removed: ["    audit()"], added: [] };
  const [py] = regionsOf({ oldPath: "p.py", newPath: "p.py", status: "modified", binary: false, hunks: [pyHunk] }, "p.py", python);
  assert.deepEqual([py?.block.startLine, py?.block.endLine, py?.block.name], [1, 2, "a"]);

  const ruby = ["def a", "  one", "end", "", "def b", "  two", "end"];
  const rbHunk = { oldStart: 3, oldLines: 1, newStart: 2, newLines: 0, removed: ["  audit"], added: [] };
  const [rb] = regionsOf({ oldPath: "r.rb", newPath: "r.rb", status: "modified", binary: false, hunks: [rbHunk] }, "r.rb", ruby);
  assert.deepEqual([rb?.block.startLine, rb?.block.endLine, rb?.block.name], [1, 3, "a"]);

  const klass = ["class K:", "    def a(self):", "        one()", "", "def top():", "    pass"];
  const methodHunk = { oldStart: 5, oldLines: 2, newStart: 4, newLines: 0, removed: ["    def b(self):", "        two()"], added: [] };
  const [gone] = regionsOf({ oldPath: "k.py", newPath: "k.py", status: "modified", binary: false, hunks: [methodHunk] }, "k.py", klass);
  assert.deepEqual([gone?.block.startLine, gone?.block.endLine, gone?.block.name], [4, 4, undefined]);
});

test("calledNames stays linear on a long run of word characters", () => {
  const started = performance.now();
  assert.deepEqual([...calledNames(`const blob = "${"ab12".repeat(20_000)}";`)], []);
  assert.ok(performance.now() - started < 200, `took ${performance.now() - started} ms`);
});

test("a hunk of 150,000 lines does not overflow, and stays fast", () => {
  const added = Array.from({ length: 150_000 }, (_, i) => `word${i}`);
  const started = performance.now();
  const regions = regionsOf(
    { oldPath: null, newPath: "words.txt", status: "added", binary: false, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: added.length, removed: [], added }] },
    "words.txt",
    added,
  );
  assert.deepEqual([regions.length, regions[0]?.block.startLine, regions[0]?.block.endLine], [1, 1, 150_000]);
  assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
});

test("a hunk that removes 150,000 lines does not overflow either, in prose or in code", () => {
  const removed = Array.from({ length: 150_000 }, (_, i) => `old${i}();`);
  for (const path of ["words.txt", "gone.ts"]) {
    const hunk = { oldStart: 2, oldLines: removed.length, newStart: 1, newLines: 0, removed, added: [] };
    const regions = regionsOf({ oldPath: path, newPath: path, status: "modified", binary: false, hunks: [hunk] }, path, ["kept();"]);
    assert.equal(regions[0]?.removed.length, 150_000, path);
  }
});

test("every line of a 20,000-line wrapper is placed without quadratic time", () => {
  const lines = ["describe('all', () => {", ...Array.from({ length: 20_000 }, (_, i) => `  check(${i});`), "});"];
  const hunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, removed: [], added: lines };
  const started = performance.now();
  const regions = regionsOf({ oldPath: null, newPath: "big.test.ts", status: "added", binary: false, hunks: [hunk] }, "big.test.ts", lines);
  const took = performance.now() - started;
  assert.ok(regions.length > 0);
  assert.ok(took < 3000, `took ${took} ms`);
});

test("a very long crafted line is judged quickly", () => {
  const line = `${"a".repeat(24_000)}(`;
  const started = performance.now();
  looksLikeHeader(line);
  definedName(line);
  assert.ok(performance.now() - started < 100);
});

// parseDiff on its own: analyzeChange never diffs a binary file, so git never prints this line to
// it, but the parser must still read the header right.
test("a quoted path containing a quote and a space is read whole", () => {
  const text = ['diff --git "a/q\\" b.bin" "b/q\\" b.bin"', "index 1..2 100644", 'Binary files "a/q\\" b.bin" and "b/q\\" b.bin" differ', ""].join("\n");
  const [file] = parseDiff(text);
  assert.deepEqual([file?.oldPath, file?.newPath, file?.binary], ['q" b.bin', 'q" b.bin', true]);
});

test("analyzeChange skips files outside repository.include / ignore", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, repo.base, repo.head, pathFilter([], ["src/auth/**"]));
    assert.equal(change.regions.length, 0);
    assert.deepEqual(change.skipped, [{ path: "src/auth/password.ts", reason: "excluded by repository.include / ignore" }]);
  } finally {
    repo.remove();
  }
});
