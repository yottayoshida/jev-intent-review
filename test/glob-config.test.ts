import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_PATH, defaultConfig, loadConfig, parseConfig } from "../src/config/config.ts";
import { globToRegExp, pathFilter } from "../src/config/glob.ts";
import { Git } from "../src/repository/git.ts";
import { EXIT, ToolError } from "../src/types.ts";
import { tempRepo } from "./helpers/repo.ts";

test("globs match the whole path; * stays in one directory, **/ may match nothing", () => {
  const generated = globToRegExp("**/*.generated.*");
  assert.ok(generated.test("a/b/c.generated.ts"));
  assert.ok(generated.test("c.generated.ts"));
  assert.ok(!generated.test("a/c.ts"));
  assert.ok(globToRegExp("vendor/**").test("vendor/x/y.js"));
  assert.ok(!globToRegExp("vendor/**").test("src/vendor.js"));
  assert.ok(!globToRegExp("*.ts").test("src/a.ts"));
  assert.ok(globToRegExp("a+b(1).ts").test("a+b(1).ts"));
  assert.ok(!globToRegExp("a+b(1).ts").test("aab1.ts"));
});

test("pathFilter: empty include means everything, ignore wins over include", () => {
  const all = pathFilter([], ["dist/**"]);
  assert.ok(all("src/a.ts"));
  assert.ok(!all("dist/a.js"));
  const onlySrc = pathFilter(["src/**"], ["src/gen/**"]);
  assert.ok(onlySrc("src/a.ts"));
  assert.ok(!onlySrc("lib/a.ts"));
  assert.ok(!onlySrc("src/gen/a.ts"));
});

function configError(text: string): ToolError {
  try {
    parseConfig(text, "test.yml");
  } catch (error) {
    assert.ok(error instanceof ToolError);
    return error;
  }
  assert.fail("expected a config error");
}

test("parseConfig: empty file gives the defaults; set keys override them", () => {
  assert.deepEqual(parseConfig("", "t"), defaultConfig());
  const config = parseConfig("version: 1\njudgment:\n  violation_confidence: 0.9\nrepository:\n  include: [src/**]\n", "t");
  assert.equal(config.judgment.violation_confidence, 0.9);
  assert.equal(config.judgment.relevance_confidence, defaultConfig().judgment.relevance_confidence);
  assert.deepEqual(config.repository.include, ["src/**"]);
});

test("parseConfig: unknown keys, wrong types, out-of-range values and bad YAML are configuration errors", () => {
  for (const text of [
    "judgment:\n  violation_confidense: 0.9\n", // misspelt key
    "judgement:\n  violation_confidence: 0.9\n", // misspelt section
    "judgment:\n  violation_confidence: high\n",
    "judgment:\n  violation_confidence: 1.5\n",
    "policy:\n  fail_on: [everything]\n",
    "policy:\n  unknown: ignore\n",
    "repository:\n  ignore: dist/**\n",
    "version: 2\n",
    "- a list\n",
    "judgment: [\n",
    "__proto__:\n  toString: 1\n", // must not reach the prototype
    "constructor:\n  keys: 1\n",
    "judgment:\n  __proto__: 1\n",
    "judgment:\n  hasOwnProperty: 1\n",
  ]) {
    const error = configError(text);
    assert.equal(error.exitCode, EXIT.config, text);
    assert.match(error.message, /^test\.yml: /);
  }
  assert.equal(typeof Object.prototype.toString, "function");
  assert.equal(typeof Object.keys, "function");
});

test("loadConfig reads the file as it was before the change, and says when the change edits it", async () => {
  const repo = tempRepo();
  try {
    repo.write({ [CONFIG_PATH]: "judgment:\n  violation_confidence: 0.9\n", "a.ts": "x\n" });
    const before = repo.commit("config");
    repo.write({ [CONFIG_PATH]: "judgment:\n  violation_confidence: 0.1\nrepository:\n  ignore: ['**']\n" });
    const after = repo.commit("loosen the config");
    const git = await Git.open(repo.dir);

    const loaded = await loadConfig(git, before, after);
    assert.equal(loaded.config.judgment.violation_confidence, 0.9);
    assert.equal(loaded.changedInPullRequest, true);
    assert.match(loaded.source, /^\.jev-intent-review\.yml@[0-9a-f]{12}$/);

    const same = await loadConfig(git, after, after);
    assert.equal(same.changedInPullRequest, false);
  } finally {
    repo.remove();
  }
});

test("loadConfig: no file on either side gives the defaults; a file added by the change is not used", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "a.ts": "x\n" });
    const before = repo.commit("no config");
    const git = await Git.open(repo.dir);
    const none = await loadConfig(git, before, before);
    assert.equal(none.source, "defaults");
    assert.equal(none.changedInPullRequest, false);

    repo.write({ [CONFIG_PATH]: "policy:\n  fail_on: []\n" });
    const after = repo.commit("add a config");
    const added = await loadConfig(git, before, after);
    assert.deepEqual(added.config.policy.fail_on, ["violation"]);
    assert.equal(added.changedInPullRequest, true);
  } finally {
    repo.remove();
  }
});
