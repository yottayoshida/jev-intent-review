import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** No compiler: requirements come from a spec file or from an acceptance-criteria list. */
function fakeDeps(github?: Partial<GitHub>): Deps {
  const provider = guardProvider("createSession", "disabledAt");
  return {
    judges: () => ({ provider, sent: () => ({ requests: provider.calls.length, bytes: 0 }), origin: "https://api.cloudflare.com" }),
    github: async () => github as GitHub,
  };
}

// The pull requests the --pr tests hand to a fake GitHub differ only in the two commits they name.
const pullRequest = (headSha: string, baseSha: string, body = "## Acceptance criteria\n- Disabled users cannot authenticate by any path") => ({
  number: 7,
  title: "Block disabled users",
  body,
  author: "dev",
  url: "u",
  baseRefName: "main",
  baseSha,
  headSha,
  issues: [],
});

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
    assert.match(report.skipReason, /No credentials for the judgments/);

    repo.git("checkout", "-q", repo.base);
    repo.write({ [CONFIG_PATH]: "policy:\n  missing_credentials: fail\n" });
    const base = repo.commit("config");
    repo.write({ "docs/note.md": "a change to review\n" });
    const after = repo.commit("a change");
    const strict = io(repo.dir, {});
    assert.equal(await main(["--base", base, "--head", after, "--intent-spec", specFile(repo.dir)], strict.value, fakeDeps()), EXIT.provider);
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
    repo.write({ "docs/note.md": "a change to review\n" });
    const after = repo.commit("a change");
    const strict = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", base, "--head", after], strict.value, fakeDeps()), EXIT.intent);
  } finally {
    repo.remove();
  }
});

test("--intent is read as written when it is a list, and prose is refused with the forms that work", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const viaList = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent", "Acceptance criteria:\n* Disabled users cannot authenticate by any path", "--json"], viaList.value, fakeDeps()), EXIT.violation);
    assert.deepEqual(JSON.parse(viaList.out()).sources.map((s: { id: string }) => s.id), ["cli"]);

    // No model writes requirements any more, so prose that is not a list stops the run and says
    // which two forms do work. It used to be handed to a general instruct model.
    const viaProse = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent", "Prevent disabled users from authenticating."], viaProse.value, fakeDeps()), EXIT.intent);
    assert.match(viaProse.err(), /--intent-spec/);
    assert.match(viaProse.err(), /acceptance-criteria list/);

    const event = join(repo.dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
    const pr = pullRequest(repo.head, repo.base);
    const viaEvent = io(repo.dir, { ...CREDENTIALS, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--json"], viaEvent.value, fakeDeps({ pullRequest: async () => pr })), EXIT.violation);
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
    const pr = pullRequest(repo.head, repo.base);
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--base", repo.base, "--json"], run.value, fakeDeps({ pullRequest: async () => pr })), EXIT.violation);
    assert.equal(JSON.parse(run.out()).metadata.head, repo.head);

    // A workflow run by a comment or by hand has the default branch checked out, not the pull request.
    const comment = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "issue_comment" });
    assert.equal(await main(["--pr", "7", "--base", repo.base, "--json"], comment.value, fakeDeps({ pullRequest: async () => pr })), EXIT.violation);
    assert.equal(JSON.parse(comment.out()).metadata.head, repo.head);

    const missing = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    const gone = { ...pr, headSha: "f".repeat(40) };
    assert.equal(await main(["--pr", "7", "--base", repo.base], missing.value, fakeDeps({ pullRequest: async () => gone })), EXIT.repository);
    assert.match(missing.err(), /git fetch origin pull\/7\/head/);
  } finally {
    repo.remove();
  }
});

test("--pr takes the base commit the pull request started from, not the branch as it is now", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    // A pull request merged with a merge commit, with the branch moved on afterwards: main now
    // contains the head, so the merge base of the branch name and the head is the head itself.
    repo.write({ "docs/later.md": "work that landed after the pull request\n" });
    repo.commit("main moved on");
    const pr = pullRequest(repo.head, repo.base);
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--json"], run.value, fakeDeps({ pullRequest: async () => pr })), EXIT.violation);
    const report = JSON.parse(run.out());
    assert.deepEqual([report.metadata.base, report.metadata.head], [repo.base, repo.head]);

    // Without a base commit — an older GitHub response, or one this clone does not have — the run
    // stops instead of reporting on a commit compared with itself.
    const blind = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--json"], blind.value, fakeDeps({ pullRequest: async () => ({ ...pr, baseSha: "" }) })), EXIT.config);
    assert.match(blind.err(), /nothing to compare: the merge base of main and [0-9a-f]+ is the head commit itself/);
    assert.equal(blind.out(), "");
  } finally {
    repo.remove();
  }
});

test("--pr keeps measuring against the base branch when the head took the branch in later", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    // An open pull request whose branch is behind: main moved on, the pull request took main in
    // (a rebase, or GitHub's "Update branch"), and the base commit GitHub recorded at the start is
    // now older than the point the two share. Measuring from it would call main's own commit a
    // change of this pull request.
    repo.git("checkout", "-q", "-b", "pr", repo.head);
    repo.git("checkout", "-q", "main");
    repo.git("reset", "-q", "--hard", repo.base);
    repo.write({ "docs/upstream.md": "someone else's work\n" });
    const later = repo.commit("main moved on");
    repo.git("update-ref", "refs/remotes/origin/main", later);
    repo.git("checkout", "-q", "pr");
    repo.git("merge", "-q", "--no-edit", "main");
    const head = repo.git("rev-parse", "HEAD").trim();

    const pr = pullRequest(head, repo.base);
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--json", "--trace"], run.value, fakeDeps({ pullRequest: async () => pr })), EXIT.violation);
    const report = JSON.parse(run.out());
    assert.deepEqual([report.metadata.base, report.metadata.head], [later, head]);
    // The upstream commit is not part of this pull request, so its file is not among the changed
    // ones. (The report's own list of unrequested changes cannot say this: the scripted provider
    // answers nothing for the change question, so that list is empty whatever the base is.)
    assert.match(run.err(), /changed files: \d+/);
    assert.ok(!run.err().includes("docs/upstream.md"), run.err());
  } finally {
    repo.remove();
  }
});

test("--pr takes the latest commit the head still shares with a candidate, so a stale origin does not widen the change", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    // A clone that has not fetched for a while: origin/main and the local branch both sit at an
    // older commit than the one the pull request started from, which the clone has only because
    // the head descends from it. Taking the branch would call the commit between them a change of
    // this pull request.
    repo.git("checkout", "-q", "-b", "upstream", repo.base);
    repo.write({ "docs/upstream.md": "someone else's work\n" });
    const startedFrom = repo.commit("main moved on");
    repo.git("checkout", "-q", "-b", "pr");
    repo.git("checkout", "-q", repo.head, "--", ".");
    const head = repo.commit("the pull request");
    repo.git("branch", "-q", "-f", "main", repo.base);
    repo.git("update-ref", "refs/remotes/origin/main", repo.base);

    const pr = pullRequest(head, startedFrom);
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--json", "--trace"], run.value, fakeDeps({ pullRequest: async () => pr })), EXIT.violation);
    assert.equal(JSON.parse(run.out()).metadata.base, startedFrom);
    assert.ok(!run.err().includes("docs/upstream.md"), run.err());
  } finally {
    repo.remove();
  }
});

test("--intent-spec cannot be combined with other intent, and trace lines cannot start a line of their own", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const combined = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--intent-spec", specFile(repo.dir), "--intent", "x", "--base", repo.base], combined.value, fakeDeps()), EXIT.config);

    const forged = join(repo.dir, "forged.json");
    writeFileSync(forged, JSON.stringify(validateIntentSpec({ version: 1, requirements: [{ id: "R1", text: "Disabled users cannot sign in.\n::error::forged" }] }, "t")));
    const traced = io(repo.dir, CREDENTIALS);
    await main(["--base", repo.base, "--head", repo.head, "--intent-spec", forged, "--trace"], traced.value, fakeDeps());
    assert.ok(traced.err().includes("forged"), "the text is still shown");
    assert.ok(!traced.err().split("\n").some((line) => line.startsWith("::")), "but never at the start of a line");
  } finally {
    repo.remove();
  }
});

/** A stand-in for the judgment endpoint on this machine: answers like Workers AI, remembers what it was asked. */
async function localEndpoint(answer: (body: { model?: string }) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const seen: { auth: string | undefined; body: { model?: string; input?: unknown } }[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => void (text += chunk.toString("utf8")));
    request.on("end", () => {
      const body = JSON.parse(text || "{}") as { model?: string };
      seen.push({ auth: request.headers.authorization, body });
      const { status, body: answerBody, headers } = answer(body);
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(answerBody === undefined ? "" : JSON.stringify(answerBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { seen, url: `http://127.0.0.1:${port}/ai/run`, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const answers = (relevance: string, satisfaction: string, wrapped: boolean) => {
  const choice = (c: string) => ({ type: "choice", choice: c, confidence: 0.9, probabilities: { [c]: 0.9 } });
  const inner = { answers: { relevance: choice(relevance), satisfaction: choice(satisfaction), completeness: choice("likely_complete") } };
  return wrapped ? { result: { state: "Completed", result: inner } } : inner;
};

test("with JEV_API_URL every judgment goes there, with its own token, wrapped answer or not", async () => {
  const repo = fixtureRepo("missed-path");
  let wrapped = true;
  const endpoint = await localEndpoint(() => {
    wrapped = !wrapped;
    return { status: 200, body: answers("may_violate", "violates", wrapped) };
  });
  try {
    // The environment is built from nothing: a broken build must not reach api.cloudflare.com.
    const run = io(repo.dir, { JEV_API_URL: endpoint.url, JEV_API_TOKEN: "local-token" });
    const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir), "--json"], run.value);
    assert.equal(code, EXIT.violation);
    const report = JSON.parse(run.out()) as { sent: { requests: number; endpoint?: string } };
    assert.ok(endpoint.seen.length >= 1);
    assert.equal(report.sent.requests, endpoint.seen.length, "every request in the report reached this server");
    assert.equal(report.sent.endpoint, endpoint.origin);
    for (const request of endpoint.seen) {
      assert.equal(request.auth, "Bearer local-token");
      assert.equal(request.body.model, "typesafe/jev");
    }
  } finally {
    endpoint.close();
    repo.remove();
  }
});

test("an endpoint that redirects or has nothing there fails the run at once, and is not asked again", async () => {
  for (const wrong of [
    { status: 302, headers: { location: "https://elsewhere.example.com/" } },
    { status: 404, body: { error: "no route" } },
  ]) {
    const repo = fixtureRepo("missed-path");
    const endpoint = await localEndpoint(() => wrong);
    try {
      // Two requirements over the same places: without the stop, each would be judged on its own
      // (14 requests). Eight judgments are in flight at a time, so one wave can leave together,
      // and what was already in flight cannot be recalled — but no second wave follows.
      const spec = JSON.parse(readFileSync(join(FIXTURES, "missed-path", "fixture.json"), "utf8")).spec as IntentSpec;
      const first = spec.requirements[0]!;
      spec.requirements = [first, { ...first, id: "R2" }];
      const path = join(repo.dir, "two.json");
      writeFileSync(path, JSON.stringify(spec));

      const run = io(repo.dir, { JEV_API_URL: endpoint.url, JEV_API_TOKEN: "local-token" });
      const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", path], run.value);
      assert.equal(code, EXIT.provider, String(wrong.status));
      assert.equal(run.out(), "");
      // Counted after everything in flight has landed, so the number does not depend on timing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(endpoint.seen.length <= 8, `${endpoint.seen.length} requests reached the endpoint`);
    } finally {
      endpoint.close();
      repo.remove();
    }
  }
});

test("an endpoint that answers nothing usable fails the run instead of reporting unknown everywhere", async () => {
  // Refusing every request: the second refusal, with nothing ever answered, stops the run early.
  const refusing = fixtureRepo("missed-path");
  const wrongShape = await localEndpoint(() => ({ status: 400, body: { error: "not this shape" } }));
  try {
    const run = io(refusing.dir, { JEV_API_URL: wrongShape.url, JEV_API_TOKEN: "local-token" });
    assert.equal(await main(["--base", refusing.base, "--head", refusing.head, "--intent-spec", specFile(refusing.dir)], run.value), EXIT.provider);
    assert.match(run.err(), /the endpoint set by JEV_API_URL \(http:\/\/127\.0\.0\.1:\d+\) answered 400.*not a Jev endpoint/);
    assert.ok(wrongShape.seen.length <= 8, `${wrongShape.seen.length} requests`);
  } finally {
    wrongShape.close();
    refusing.remove();
  }

  // Answering 200 with nothing in it: each place is unknown, and a report of nothing but unknown
  // is not a review that ran.
  const empty = fixtureRepo("missed-path");
  const emptyAnswers = await localEndpoint(() => ({ status: 200, body: { result: {} } }));
  try {
    const run = io(empty.dir, { JEV_API_URL: emptyAnswers.url, JEV_API_TOKEN: "local-token" });
    assert.equal(await main(["--base", empty.base, "--head", empty.head, "--intent-spec", specFile(empty.dir)], run.value), EXIT.provider);
    assert.match(run.err(), /no judgment came back from http:\/\/127\.0\.0\.1:\d+/);
    assert.ok(emptyAnswers.seen.length >= 1);
  } finally {
    emptyAnswers.close();
    empty.remove();
  }
});

test("nothing the endpoint says can start a line of its own, in the trace or in the report", async () => {
  const repo = fixtureRepo("missed-path");
  const endpoint = await localEndpoint(() => ({ status: 500, body: { error: `broken\n::error::forged\ntoken local-token` } }));
  try {
    const run = io(repo.dir, { JEV_API_URL: endpoint.url, JEV_API_TOKEN: "local-token" });
    await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir), "--trace"], run.value);
    for (const stream of [run.err(), run.out()]) {
      assert.ok(!stream.split("\n").some((line) => line.startsWith("::")), stream.slice(0, 200));
      assert.ok(!stream.includes("local-token"), "the token is never echoed back into the output");
    }
  } finally {
    endpoint.close();
    repo.remove();
  }
});

test("a token without its endpoint, or an endpoint the token does not belong to, is a setting to fix", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const cases: [NodeJS.ProcessEnv, number, RegExp][] = [
      [{ JEV_API_URL: "http://example.com/ai/run", JEV_API_TOKEN: "t" }, EXIT.config, /must be https/],
      [{ JEV_API_URL: "http://localhost.attacker.com/ai/run", JEV_API_TOKEN: "t" }, EXIT.config, /must be https/],
      [{ JEV_API_URL: "https://alice:hunter2@example.com/ai/run", JEV_API_TOKEN: "t" }, EXIT.config, /user name or password/],
      [{ JEV_API_URL: "https://judge.example.com/ai/run", ...CREDENTIALS }, EXIT.config, /CLOUDFLARE_API_TOKEN is only ever sent to Cloudflare/],
      [{ JEV_API_TOKEN: "t", ...CREDENTIALS }, EXIT.config, /JEV_API_TOKEN needs JEV_API_URL/],
    ];
    for (const [env, expected, message] of cases) {
      const run = io(repo.dir, env);
      assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir)], run.value, fakeDeps()), expected, JSON.stringify(env));
      assert.match(run.err(), message);
      assert.equal(run.out(), "");
      assert.ok(!run.err().includes("hunter2") && !run.err().includes("alice"), run.err());
    }

    // The URL without its token is a fork's pull request: skipped, not failed, and nothing is sent.
    const fork = io(repo.dir, { JEV_API_URL: "https://judge.example.com/ai/run" });
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir), "--json"], fork.value, fakeDeps()), EXIT.ok);
    const report = JSON.parse(fork.out()) as { verdict: string; sent: { requests: number; endpoint?: string } };
    assert.equal(report.verdict, "skipped");
    assert.equal(report.sent.requests, 0);
    assert.equal(report.sent.endpoint, undefined, "a skipped run names no endpoint");
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
