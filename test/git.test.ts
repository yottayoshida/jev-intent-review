import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeChange } from "../src/change/seeds.ts";
import { Git, isSafePath, MAX_BLOB_BYTES } from "../src/repository/git.ts";
import { resolveRevisions } from "../src/repository/revisions.ts";
import { EXIT, ToolError } from "../src/types.ts";
import { fixtureRepo, tempRepo } from "./helpers/repo.ts";

test("grep: fixed strings, whole words, and words that look like options are searched for, not obeyed", async () => {
  const repo = tempRepo();
  try {
    repo.write({
      "a.ts": "createSession(user)\ncreateSessionLater()\nconst flag = '--no-index';\n",
      "b.ts": "x.createSession()\n",
    });
    const sha = repo.commit("files");
    repo.write({ "untracked.ts": "createSession()\n" });
    const git = await Git.open(repo.dir);

    const words = await git.grep(sha, "createSession", { word: true, limit: 100 });
    assert.deepEqual(
      words.hits.map((h) => `${h.path}:${h.line}`),
      ["a.ts:1", "b.ts:1"],
    );
    const option = await git.grep(sha, "--no-index", { word: false, limit: 100 });
    assert.deepEqual(option.hits.map((h) => h.path), ["a.ts"]);
    const regexLike = await git.grep(sha, "create.*", { word: false, limit: 100 });
    assert.equal(regexLike.hits.length, 0);

    const limited = await git.grep(sha, "createSession", { word: false, limit: 1 });
    assert.equal(limited.hits.length, 1);
    assert.equal(limited.more, true);

    await assert.rejects(git.grep("HEAD", "x", { word: false, limit: 1 }), /commit id/);
    await assert.rejects(git.grep(sha, "a\nb", { word: false, limit: 1 }), /single non-empty line/);
  } finally {
    repo.remove();
  }
});

test("readText: tracked text only; binary, oversized, missing and untracked files read as null", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "text.ts": "hello\n", "big.txt": "x".repeat(MAX_BLOB_BYTES + 1) });
    writeFileSync(join(repo.dir, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const sha = repo.commit("files");
    writeFileSync(join(repo.dir, ".env"), "SECRET=1\n");
    const git = await Git.open(repo.dir);

    assert.equal(await git.readText(sha, "text.ts"), "hello\n");
    assert.equal(await git.readText(sha, "image.bin"), null);
    assert.equal(await git.readText(sha, "big.txt"), null);
    assert.equal(await git.readText(sha, "missing.ts"), null);
    assert.equal(await git.readText(sha, ".env"), null);
    assert.ok(!(await git.tree(sha)).has(".env"));
  } finally {
    repo.remove();
  }
});

test("a symbolic link is read as the link, never as the file it points to", async () => {
  const repo = tempRepo();
  try {
    writeFileSync(join(repo.dir, "outside.txt"), "the target's content\n");
    symlinkSync("outside.txt", join(repo.dir, "link.ts"));
    const sha = repo.commit("link");
    const git = await Git.open(repo.dir);
    assert.equal(await git.readText(sha, "link.ts"), "outside.txt");
  } finally {
    repo.remove();
  }
});

test("paths with control characters are left out of the tree", async () => {
  assert.ok(isSafePath("src/a b.ts"));
  assert.ok(!isSafePath("src/a\nb.ts"));
  assert.ok(!isSafePath("src/a\tb.ts"));
  const repo = tempRepo();
  try {
    repo.write({ "ok.ts": "1\n", "tab\tname.ts": "2\n" });
    const sha = repo.commit("names");
    const git = await Git.open(repo.dir);
    assert.deepEqual([...(await git.tree(sha)).keys()], ["ok.ts"]);
  } finally {
    repo.remove();
  }
});

test("the working tree's .gitattributes and the repository's git config do not change what is read", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const git = await Git.open(repo.dir);
    const plain = await analyzeChange(git, repo.base, repo.head, () => true);
    const plainGrep = await git.grep(repo.head, "createSession", { word: true, limit: 100 });

    // Uncommitted, exactly as a pull request's checkout would carry it.
    writeFileSync(join(repo.dir, ".gitattributes"), "*.ts -diff\n*.ts binary\n");
    repo.git("config", "diff.interHunkContext", "5");
    repo.git("config", "grep.column", "true");
    repo.git("config", "diff.noprefix", "true");
    const again = new Git(git.dir);
    const tampered = await analyzeChange(again, repo.base, repo.head, () => true);
    const tamperedGrep = await again.grep(repo.head, "createSession", { word: true, limit: 100 });

    assert.equal(plain.regions.length, 1);
    assert.deepEqual(tampered.regions.map((r) => [r.path, r.changedLines]), plain.regions.map((r) => [r.path, r.changedLines]));
    assert.deepEqual(tampered.skipped, []);
    assert.ok(plainGrep.hits.length > 1);
    assert.deepEqual(tamperedGrep.hits, plainGrep.hits);
  } finally {
    repo.remove();
  }
});

// Found by searching seeded random edits: git's own -U0 output for these pairs differs between
// myers and histogram, and with the indent heuristic on and off.
const HISTOGRAM_CASE = {
  a: ["  }", "{", "const y = 1;", "{", "{", "", "  }", "}", "}", "}", "}", "function f() {", "  if (ok) {", "  return x;", "  b();", "{", "  }", "{", "const y = 1;", "{", "  return x;", "  if (ok) {", "function f() {", "const y = 1;"],
  b: ["  }", "const y = 1;", "{", "{", "", "  }", "}", "}", "}", "}", "function f() {", "  if (ok) {", "  return x;", "  b();", "{", "{", "  }", "  }", "{", "const y = 1;", "{", "{", "  return x;", "  if (ok) {", "function f() {", "const y = 1;"],
};
const INDENT_CASE = {
  a: ["  }", "", "  }", "", "}", "function f() {", "", "", "  if (ok) {", "const y = 1;", "function f() {", "function f() {", "  }", "  b();", "const y = 1;", "  return x;", "  }", "const y = 1;", "const y = 1;", "  }", "", "{", "  if (ok) {", "{"],
  b: ["  }", "", "  }", "", "}", "function f() {", "", "", "  if (ok) {", "const y = 1;", "function f() {", "  }", "  b();", "  return x;", "  }", "const y = 1;", "const y = 1;", "{", "  }", "", "{", "{"],
};

function shape(change: Awaited<ReturnType<typeof analyzeChange>>) {
  return {
    regions: change.regions.map((r) => [r.path, r.block.startLine, r.block.endLine, r.changedLines, r.added, r.removed]),
    calls: change.calledSymbols.map((s) => [s.name, s.onChangedLine]),
    skipped: change.skipped,
  };
}

test("git config cannot move what is read: diff algorithm and indent heuristic", async () => {
  for (const [label, pair, key, value] of [
    ["histogram", HISTOGRAM_CASE, "diff.algorithm", "histogram"],
    ["patience", HISTOGRAM_CASE, "diff.algorithm", "patience"],
    ["no indent heuristic", INDENT_CASE, "diff.indentHeuristic", "false"],
  ] as const) {
    const repo = tempRepo();
    try {
      repo.write({ "f.ts": `${pair.a.join("\n")}\n` });
      const before = repo.commit("a");
      repo.write({ "f.ts": `${pair.b.join("\n")}\n` });
      const after = repo.commit("b");
      const baseline = ["-c", "diff.algorithm=myers", "-c", "diff.indentHeuristic=true"];
      const setting = key === "diff.algorithm" ? ["-c", `${key}=${value}`, "-c", "diff.indentHeuristic=true"] : ["-c", "diff.algorithm=myers", "-c", `${key}=${value}`];
      if (label !== "patience") {
        // Otherwise this test would prove nothing: the setting must change git's own output here.
        assert.notEqual(repo.git(...baseline, "diff", "-U0", before, after), repo.git(...setting, "diff", "-U0", before, after), label);
      }
      const plain = shape(await analyzeChange(await Git.open(repo.dir), before, after, () => true));
      repo.git("config", key, value);
      assert.deepEqual(shape(await analyzeChange(await Git.open(repo.dir), before, after, () => true)), plain, label);
    } finally {
      repo.remove();
    }
  }
});

test("git config cannot move what is read: hunk context, rename limit, prefixes", async () => {
  const repo = tempRepo();
  try {
    const lines = Array.from({ length: 10 }, (_, i) => `step${i}();`);
    repo.write({ "a.ts": `${lines.join("\n")}\n`, "b/x.ts": "first();\n", "one.ts": "alpha();\nbeta();\ngamma();\ndelta();\n", "two.ts": "one();\ntwo();\nthree();\nfour();\n" });
    const before = repo.commit("before");
    lines[1] = "changed1();";
    lines[5] = "changed5();"; // three unchanged lines apart from the first change
    repo.write({ "a.ts": `${lines.join("\n")}\n`, "b/x.ts": "second();\n" });
    repo.git("mv", "one.ts", "uno.ts");
    repo.git("mv", "two.ts", "dos.ts");
    repo.write({ "uno.ts": "alpha();\nbeta();\ngamma();\nDELTA();\n", "dos.ts": "one();\ntwo();\nthree();\nFOUR();\n" });
    const after = repo.commit("after");
    assert.ok(!/^R/m.test(repo.git("-c", "diff.renameLimit=1", "diff", "--name-status", "-M", before, after)), "the limit really stops rename detection");

    for (const [key, value] of [["diff.interHunkContext", "5"], ["diff.renameLimit", "1"], ["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"], ["diff.relative", "true"]]) {
      repo.git("config", key as string, value as string);
    }
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, before, after, () => true);
    assert.deepEqual(change.regions.filter((r) => r.path === "a.ts").flatMap((r) => r.changedLines), [2, 6]);
    assert.ok(change.regions.some((r) => r.path === "b/x.ts"), "a path starting with b/ keeps its b/");
    assert.deepEqual(
      (await git.changedFiles(before, after)).filter((f) => f.status === "renamed").map((f) => `${f.oldPath}>${f.newPath}`).sort(),
      ["one.ts>uno.ts", "two.ts>dos.ts"],
    );
  } finally {
    repo.remove();
  }
});

test("a large binary next to a one-line change is skipped, not diffed", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "a.ts": "export function f() {\n  return 1;\n}\n" });
    const before = repo.commit("before");
    repo.write({ "a.ts": "export function f() {\n  return 2;\n}\n" });
    const blob = Buffer.alloc(70 * 1024 * 1024, 7);
    blob[0] = 0;
    writeFileSync(join(repo.dir, "asset.bin"), blob);
    const after = repo.commit("after");
    const change = await analyzeChange(await Git.open(repo.dir), before, after, () => true);
    assert.deepEqual(change.regions.map((r) => [r.path, r.block.name]), [["a.ts", "f"]]);
    assert.deepEqual(change.skipped, [{ path: "asset.bin", reason: "binary, or larger than the read limit" }]);
  } finally {
    repo.remove();
  }
});

test("grep: hits in files over the read limit do not use up the limit", async () => {
  const repo = tempRepo();
  try {
    repo.write({
      "aa-generated.ts": "session();\n".repeat(130_000),
      "long-line.ts": `${"y".repeat(3 * 1024 * 1024)} session();\n`,
      "zz-real.ts": "session();\n",
    });
    const sha = repo.commit("files");
    const result = await (await Git.open(repo.dir)).grep(sha, "session", { word: true, limit: 10 });
    assert.deepEqual(result.hits.map((h) => h.path), ["zz-real.ts"]);
  } finally {
    repo.remove();
  }
});

test("grep drops hits in binary files and honours its limit", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "many.ts": Array.from({ length: 3000 }, (_, i) => `session(${i});`).join("\n") });
    writeFileSync(join(repo.dir, "blob.bin"), Buffer.concat([Buffer.from("session("), Buffer.from([0, 1, 2])]));
    const sha = repo.commit("files");
    const git = await Git.open(repo.dir);
    const few = await git.grep(sha, "session", { word: true, limit: 5 });
    assert.deepEqual([few.hits.length, few.more], [5, true]);
    const all = await git.grep(sha, "session", { word: true, limit: 5000 });
    assert.equal(all.hits.length, 3000);
    assert.ok(all.hits.every((h) => h.path === "many.ts"));
  } finally {
    repo.remove();
  }
});

test("a word with more than 64 MB of matches does not fail the run", async () => {
  const repo = tempRepo();
  try {
    const line = `${"x".repeat(90)} session();\n`;
    writeFileSync(join(repo.dir, "huge.ts"), line.repeat(Math.ceil((70 * 1024 * 1024) / line.length)));
    const sha = repo.commit("huge");
    const git = await Git.open(repo.dir);
    const result = await git.grep(sha, "session", { word: true, limit: 10 });
    // The file is over the 1 MB read limit, so its hits never count; what matters is no exit 13.
    assert.deepEqual([result.hits.length, result.more], [0, false]);
  } finally {
    repo.remove();
  }
});

test("git runs without the secrets in this process's environment", async () => {
  const repo = tempRepo();
  process.env.JIR_TEST_API_TOKEN = "must-not-reach-git";
  // Not a secret by its name, but a key can be kept in its query string.
  process.env.JEV_API_URL = "https://judge.example.com/ai/run?key=must-not-reach-git-either";
  try {
    const git = await Git.open(repo.dir);
    const env = await git.text(["-c", "alias.envdump=!env", "envdump"]);
    assert.ok(env.includes("GIT_CONFIG_NOSYSTEM=1"), "the alias did run");
    assert.ok(!env.includes("must-not-reach-git"));
    assert.ok(!env.includes("JEV_API_URL"), env.split("\n").filter((l) => l.startsWith("JEV")).join(" "));
  } finally {
    delete process.env.JIR_TEST_API_TOKEN;
    delete process.env.JEV_API_URL;
    repo.remove();
  }
});

function toolError(exitCode: number) {
  return (error: unknown) => error instanceof ToolError && error.exitCode === exitCode;
}

test("revisions: --base uses the merge base with the head", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "a.ts": "1\n" });
    const start = repo.commit("start");
    repo.git("switch", "-q", "-c", "feature");
    repo.write({ "a.ts": "2\n" });
    const head = repo.commit("feature");
    repo.git("switch", "-q", "main");
    repo.write({ "b.ts": "main moved on\n" });
    repo.commit("main moves");
    const git = await Git.open(repo.dir);
    const r = await resolveRevisions(git, { base: "main", head: "feature", env: {} });
    assert.equal(r.before, start);
    assert.equal(r.after, head);
  } finally {
    repo.remove();
  }
});

test("revisions: in GitHub Actions a merge commit is compared with its first parent", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "a.ts": "1\n" });
    repo.commit("start");
    repo.git("switch", "-q", "-c", "feature");
    repo.write({ "a.ts": "2\n" });
    repo.commit("feature");
    repo.git("switch", "-q", "main");
    repo.write({ "b.ts": "main\n" });
    const mainTip = repo.commit("main moves");
    repo.git("merge", "-q", "--no-ff", "-m", "merge", "feature");
    const merge = repo.git("rev-parse", "HEAD").trim();
    const git = await Git.open(repo.dir);

    const actions = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: merge };
    const r = await resolveRevisions(git, { env: actions });
    assert.equal(r.before, mainTip);
    assert.equal(r.after, merge);

    // A two-parent HEAD is not enough: it must be this event's merge commit.
    await assert.rejects(resolveRevisions(git, { env: { ...actions, GITHUB_SHA: mainTip } }), toolError(EXIT.config));
    await assert.rejects(resolveRevisions(git, { env: { ...actions, GITHUB_EVENT_NAME: "push" } }), toolError(EXIT.config));
    await assert.rejects(resolveRevisions(git, { env: { ...actions, GITHUB_EVENT_NAME: "pull_request_target" } }), toolError(EXIT.config));
    await assert.rejects(resolveRevisions(git, { head: mainTip, env: actions }), toolError(EXIT.config));
    await assert.rejects(resolveRevisions(git, { env: {} }), toolError(EXIT.config));
  } finally {
    repo.remove();
  }
});

test("revisions: a shallow clone without the needed history is a repository error that says how to fix it", async () => {
  const origin = tempRepo();
  const clone = tempRepo();
  try {
    origin.write({ "a.ts": "1\n" });
    origin.commit("one");
    origin.write({ "a.ts": "2\n" });
    origin.commit("two");
    clone.remove();
    origin.git("clone", "-q", "--depth", "1", `file://${origin.dir}`, clone.dir);
    const git = await Git.open(clone.dir);

    await assert.rejects(resolveRevisions(git, { base: "HEAD~1", env: {} }), (error: unknown) => toolError(EXIT.repository)(error) && /fetch-depth/.test(String(error)));
    const head = clone.git("rev-parse", "HEAD").trim();
    const actions = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: head };
    await assert.rejects(resolveRevisions(git, { env: actions }), (error: unknown) => toolError(EXIT.repository)(error) && /fetch-depth/.test(String(error)));
  } finally {
    origin.remove();
    clone.remove();
  }
});
