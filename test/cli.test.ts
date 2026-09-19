import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main, type Io } from "../src/cli/main.ts";
import { EXIT } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { FIXTURES, fixtureRepo, tempRepo } from "./helpers/repo.ts";

function io(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd, env };
  return { value, out: () => out.join(""), err: () => err.join("") };
}

// Written into the work tree but never committed: the tool reads git objects, so it cannot see it.
function specFile(dir: string): string {
  const path = join(dir, "spec.json");
  writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(join(FIXTURES, "missed-path", "fixture.json"), "utf8")).spec));
  return path;
}

test("the CLI reads the change and the intent, and says the review is incomplete in this build", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const spec = specFile(repo.dir);
    const run = io(repo.dir);
    const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", spec, "--json", "--trace"], run.value);
    assert.equal(code, EXIT.incomplete);
    const report = JSON.parse(run.out());
    assert.equal(report.verdict, "incomplete");
    assert.equal(report.metadata.base, repo.base);
    assert.equal(report.metadata.head, repo.head);
    assert.equal(report.metadata.configSource, "defaults");
    assert.deepEqual(report.requirements.map((r: { requirementId: string; status: string }) => [r.requirementId, r.status]), [["R1", "unknown"]]);
    assert.match(run.err(), /\[trace\] region src\/auth\/password\.ts:6-13 loginWithPassword, changed lines 11/);
    assert.match(run.err(), /\[trace\] calls around the changed lines: .*createSession/);
  } finally {
    repo.remove();
  }
});

test("the CLI runs when started through a symbolic link, as an npm bin would start it", () => {
  const repo = tempRepo();
  try {
    const link = join(repo.dir, "jev-intent-review");
    symlinkSync(join(import.meta.dirname, "..", "src", "cli", "main.ts"), link);
    assert.equal(execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" }), `${VERSION}\n`);
  } finally {
    repo.remove();
  }
});

test("the CLI's exit codes: help 0, bad option 10, no intent 11, no base outside Actions 10, unknown revision 13", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const spec = specFile(repo.dir);
    const help = io(repo.dir);
    assert.equal(await main(["--help"], help.value), EXIT.ok);
    assert.match(help.out(), /^Usage: jev-intent-review/);

    const cases: [string[], number, RegExp][] = [
      [["--nonsense"], EXIT.config, /nonsense/],
      [["--base", repo.base], EXIT.intent, /no intent/],
      [["--intent-spec", join(repo.dir, "missing.json"), "--base", repo.base], EXIT.intent, /cannot read/],
      [["--intent-spec", spec], EXIT.config, /pass --base/],
      [["--intent-spec", spec, "--base", "no-such-branch"], EXIT.repository, /cannot find commit 'no-such-branch'/],
    ];
    for (const [argv, expected, message] of cases) {
      const run = io(repo.dir);
      assert.equal(await main(argv, run.value), expected, argv.join(" "));
      assert.match(run.err(), message);
      assert.equal(run.out(), "");
    }
  } finally {
    repo.remove();
  }
});
