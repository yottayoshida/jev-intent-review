import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main, type Deps, type Io } from "../src/cli/main.ts";
import { CONFIG_PATH } from "../src/config/config.ts";
import type { GitHub } from "../src/intent/github.ts";
import { validateIntentSpec } from "../src/intent/schema.ts";
import { EXIT, type IntentSpec } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { guardProvider } from "./helpers/fakes.ts";
import { FIXTURES, fixtureRepo, tempRepo } from "./helpers/repo.ts";

const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "test-token" };

function io(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd, env };
  return { value, out: () => out.join(""), err: () => err.join("") };
}

// Written into the work tree but never committed: the tool reads git objects, so it cannot see it.
function specFile(dir: string, name = "missed-path"): string {
  const path = join(dir, "spec.json");
  writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(join(FIXTURES, name, "fixture.json"), "utf8")).spec));
  return path;
}

function fakeDeps(compiled?: IntentSpec, github?: Partial<GitHub>): Deps {
  const provider = guardProvider("createSession", "disabledAt");
  return {
    judges: () => ({
      provider,
      compiler: {
        name: "fake",
        compile: async () => {
          if (!compiled) throw new Error("the compiler was not expected to run");
          return compiled;
        },
      },
      sent: () => ({ requests: provider.calls.length, bytes: 0 }),
    }),
    github: async () => github as GitHub,
  };
}

test("the CLI reviews the change against the intent and exits 1 on a violation in an untouched path", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const run = io(repo.dir, CREDENTIALS);
    const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir), "--json", "--trace"], run.value, fakeDeps());
    assert.equal(code, EXIT.violation);
    const report = JSON.parse(run.out());
    assert.equal(report.verdict, "violation");
    assert.equal(report.requirements[0].status, "violation");
    assert.ok(report.requirements[0].candidates.some((c: { outcome: string; candidate: { path: string; changed: boolean } }) => c.outcome === "violates" && c.candidate.path === "src/auth/oauth.ts" && !c.candidate.changed));
    assert.match(run.err(), /\[trace\] R1 search \[C\] createSession: \d+ hits/);
    assert.match(run.err(), /\[trace\] R1 -> violation/);

    const markdown = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir)], markdown.value, fakeDeps()), EXIT.violation);
    assert.match(markdown.out(), /^# jev-intent-review\n\n\*\*Result: VIOLATION\.\*\*/);
    assert.match(markdown.out(), /✗ violates · `src\/auth\/oauth\.ts:16-23` · `completeOAuthLogin`/);
  } finally {
    repo.remove();
  }
});

test("with no credentials the review is skipped (exit 0), or fails with exit 12 when the base commit's config says so", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const skipped = io(repo.dir, {});
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir), "--json"], skipped.value, fakeDeps()), EXIT.ok);
    const report = JSON.parse(skipped.out());
    assert.equal(report.verdict, "skipped");
    assert.match(report.skipReason, /No Workers AI credentials/);

    repo.git("checkout", "-q", repo.base);
    repo.write({ [CONFIG_PATH]: "policy:\n  missing_credentials: fail\n" });
    const base = repo.commit("config");
    const strict = io(repo.dir, {});
    assert.equal(await main(["--base", base, "--head", base, "--intent-spec", specFile(repo.dir)], strict.value, fakeDeps()), EXIT.provider);
    assert.match(strict.err(), /CLOUDFLARE_ACCOUNT_ID/);
  } finally {
    repo.remove();
  }
});

test("with no intent the review is skipped (exit 0), or fails with exit 11 when the config says so", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const skipped = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--json"], skipped.value, fakeDeps()), EXIT.ok);
    assert.equal(JSON.parse(skipped.out()).verdict, "skipped");

    repo.git("checkout", "-q", repo.base);
    repo.write({ [CONFIG_PATH]: "policy:\n  no_intent: fail\n" });
    const base = repo.commit("config");
    const strict = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", base, "--head", base], strict.value, fakeDeps()), EXIT.intent);
  } finally {
    repo.remove();
  }
});

test("--intent goes through the compiler; the pull request comes from the Actions event when --pr is not given", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const compiled: IntentSpec = JSON.parse(readFileSync(join(FIXTURES, "missed-path", "fixture.json"), "utf8")).spec;
    compiled.nonGoals = [];
    compiled.ambiguities = [];
    compiled.requirements = compiled.requirements.map((r) => ({ ...r, kind: "security", priority: "required", sourceRefs: r.sourceRefs ?? [], searchHints: r.searchHints ?? [] }));
    const viaText = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent", "Prevent disabled users from authenticating.", "--json"], viaText.value, fakeDeps(compiled)), EXIT.violation);
    assert.deepEqual(JSON.parse(viaText.out()).sources.map((s: { id: string }) => s.id), ["cli"]);

    const event = join(repo.dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
    const pr = { number: 7, title: "Block disabled users", body: "Blocks disabled users at password login.", author: "dev", url: "u", baseRefName: "main", headSha: repo.head, issues: [] };
    const viaEvent = io(repo.dir, { ...CREDENTIALS, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--json"], viaEvent.value, fakeDeps(compiled, { pullRequest: async () => pr })), EXIT.violation);
    const report = JSON.parse(viaEvent.out());
    assert.deepEqual(report.sources.map((s: { id: string; author: string }) => [s.id, s.author]), [["pr#7", "dev"]]);
    assert.match(report.metadata.notes.join(" "), /only from the pull request's own description, written by its author dev/);
  } finally {
    repo.remove();
  }
});

test("--pr outside a pull_request workflow reviews the pull request's head, not what is checked out", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    repo.git("checkout", "-q", repo.base);
    const pr = { number: 7, title: "Block disabled users", body: "## Acceptance criteria\n- Disabled users cannot authenticate by any path", author: "dev", url: "u", baseRefName: "main", headSha: repo.head, issues: [] };
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--base", repo.base, "--json"], run.value, fakeDeps(undefined, { pullRequest: async () => pr })), EXIT.violation);
    assert.equal(JSON.parse(run.out()).metadata.head, repo.head);

    // A workflow run by a comment or by hand has the default branch checked out, not the pull request.
    const comment = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "issue_comment" });
    assert.equal(await main(["--pr", "7", "--base", repo.base, "--json"], comment.value, fakeDeps(undefined, { pullRequest: async () => pr })), EXIT.violation);
    assert.equal(JSON.parse(comment.out()).metadata.head, repo.head);

    const missing = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    const gone = { ...pr, headSha: "f".repeat(40) };
    assert.equal(await main(["--pr", "7", "--base", repo.base], missing.value, fakeDeps(undefined, { pullRequest: async () => gone })), EXIT.repository);
    assert.match(missing.err(), /git fetch origin pull\/7\/head/);
  } finally {
    repo.remove();
  }
});

test("--intent-spec cannot be combined with other intent, and trace lines cannot start a line of their own", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const combined = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--intent-spec", specFile(repo.dir), "--intent", "x", "--base", repo.base], combined.value, fakeDeps()), EXIT.config);

    const compiled = validateIntentSpec({ version: 1, requirements: [{ id: "R1", text: "Disabled users cannot sign in.\n::error::forged" }] }, "t");
    const traced = io(repo.dir, CREDENTIALS);
    await main(["--base", repo.base, "--head", repo.head, "--intent", "anything at all here", "--trace"], traced.value, fakeDeps(compiled));
    assert.ok(traced.err().includes("forged"), "the text is still shown");
    assert.ok(!traced.err().split("\n").some((line) => line.startsWith("::")), "but never at the start of a line");
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

test("the CLI's exit codes for bad input: help 0, bad option 10, bad number 10, bad repo 10, missing file 11, no base 10, unknown revision 13", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const spec = specFile(repo.dir);
    const help = io(repo.dir);
    assert.equal(await main(["--help"], help.value), EXIT.ok);
    assert.match(help.out(), /^Usage: jev-intent-review/);

    const cases: [string[], number, RegExp][] = [
      [["--nonsense"], EXIT.config, /nonsense/],
      [["--pr", "seven"], EXIT.config, /--pr must be a number/],
      [["--repo", "not a repo", "--intent-spec", spec, "--base", repo.base], EXIT.config, /--repo must look like owner\/name/],
      [["--intent-spec", join(repo.dir, "missing.json"), "--base", repo.base], EXIT.intent, /cannot read/],
      [["--intent-spec", spec], EXIT.config, /pass --base/],
      [["--intent-spec", spec, "--base", "no-such-branch"], EXIT.repository, /cannot find commit 'no-such-branch'/],
    ];
    for (const [argv, expected, message] of cases) {
      const run = io(repo.dir, CREDENTIALS);
      assert.equal(await main(argv, run.value, fakeDeps()), expected, argv.join(" "));
      assert.match(run.err(), message);
      assert.equal(run.out(), "");
    }
  } finally {
    repo.remove();
  }
});
