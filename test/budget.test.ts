import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, type Io } from "../src/cli/main.ts";
import { CONFIG_PATH } from "../src/config/config.ts";
import { EXIT, type ReviewReport } from "../src/types.ts";
import { FIXTURES, tempRepo } from "./helpers/repo.ts";

const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "test-token-for-the-budget" };
const RUST_SPEC = join(FIXTURES, "integrity-rust", "spec.json");

function io(cwd: string, env: NodeJS.ProcessEnv = CREDENTIALS) {
  const out: string[] = [];
  const value: Io = { stdout: (t) => void out.push(t), stderr: () => {}, cwd, env };
  return { value, report: () => JSON.parse(out.join("")) as ReviewReport };
}

/** The Rust fixture with a config at the base commit, and optionally another at the head. */
function repoWith(baseConfig: string | null, headConfig: string | null = baseConfig) {
  const repo = tempRepo();
  cpSync(join(FIXTURES, "integrity-rust", "base"), repo.dir, { recursive: true });
  if (baseConfig !== null) repo.write({ [CONFIG_PATH]: baseConfig });
  const base = repo.commit("base");
  cpSync(join(FIXTURES, "integrity-rust", "head"), repo.dir, { recursive: true });
  if (headConfig !== null) repo.write({ [CONFIG_PATH]: headConfig });
  else rmSync(join(repo.dir, CONFIG_PATH), { force: true });
  const head = repo.commit("head");
  return { ...repo, base, head };
}

/**
 * The real transport, against a Workers AI endpoint that answers every question with its first
 * choice. `fail` makes a request fail after it has left, as a run killed while waiting would.
 */
function endpoint(fail = false) {
  let requests = 0;
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    if (fail) throw new TypeError("fetch failed");
    const questions = (JSON.parse(String(init?.body)) as { input: { questions: Record<string, { criteria: Record<string, string> }> } }).input.questions;
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      const choices = Object.keys(q.criteria);
      return [k, { choice: choices[0], probabilities: Object.fromEntries(choices.map((c, i) => [c, i === 0 ? 0.9 : 0.1 / Math.max(1, choices.length - 1)])) }];
    }));
    return new Response(JSON.stringify({ result: { state: "Completed", result: { answers } } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { deps: { fetch }, requests: () => requests };
}

const kept = () => {
  const dir = mkdtempSync(join(tmpdir(), "jir-budget-"));
  return { dir, lines: () => (existsSync(join(dir, "sent.log")) ? readFileSync(join(dir, "sent.log"), "utf8").trim().split("\n").filter(Boolean).length : 0), remove: () => rmSync(dir, { recursive: true, force: true }) };
};

const args = (repo: { base: string; head: string }, answers?: string) => ["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json", "--skip-change-check", ...(answers ? ["--answers", answers] : [])];

test("the runs of one pull request together send no more than its limit; the next run sends only what is left", async () => {
  const repo = repoWith("limits:\n  max_requests_per_pull_request: 3\n");
  const d = kept();
  try {
    // The control: without the limit this run sends 4.
    const free = repoWith(null);
    const unlimited = endpoint();
    assert.equal(await main(args(free), io(free.dir).value, unlimited.deps), EXIT.ok);
    assert.equal(unlimited.requests(), 4);
    free.remove();

    const first = endpoint();
    const one = io(repo.dir);
    assert.equal(await main(args(repo, d.dir), one.value, first.deps), EXIT.ok);
    assert.equal(first.requests(), 3, "the first run stops at the pull request's limit");
    assert.equal(d.lines(), 3);
    assert.ok(one.report().metadata.notes.some((n) => n === "This pull request had sent 0 requests of its 3 before this run, so this run could send 3."));

    const second = endpoint();
    const two = io(repo.dir);
    assert.equal(await main(args(repo, d.dir), two.value, second.deps), EXIT.ok);
    assert.equal(second.requests(), 0, "nothing is left for the second run");
    assert.equal(d.lines(), 3, "and the pull request has still sent 3");
    const report = two.report();
    assert.ok(report.metadata.notes.some((n) => n === "This pull request had sent 3 requests of its 3 before this run, so this run could send 0."));
    assert.equal(report.sent.reused, 3, "what the first run was answered is still used");
    // The request left over is left without an answer, for the budget, as under the run's own limit.
    const withheld = report.requirements.flatMap((r) => r.observed.filter((o) => o.result.observation === "withheld").map((o) => o.result.why));
    assert.deepEqual(withheld, ["the observation question was not answered (budget)"]);
  } finally {
    d.remove();
    repo.remove();
  }
});

test("a pull request cannot raise its own limit: the config at the commit before the change applies", async () => {
  const repo = repoWith("limits:\n  max_requests_per_pull_request: 2\n", "limits:\n  max_requests_per_pull_request: 200\n");
  const d = kept();
  try {
    const e = endpoint();
    assert.equal(await main(args(repo, d.dir), io(repo.dir).value, e.deps), EXIT.ok);
    assert.equal(e.requests(), 2);
  } finally {
    d.remove();
    repo.remove();
  }
});

test("a request is counted before it leaves, so one that never came back still counts", async () => {
  const repo = repoWith("limits:\n  max_requests_per_pull_request: 50\n");
  const d = kept();
  try {
    const failing = endpoint(true);
    await main(args(repo, d.dir), io(repo.dir).value, failing.deps);
    assert.ok(failing.requests() > 0);
    assert.equal(d.lines(), failing.requests(), "every attempt, retries included, was written before it was made");
    const next = io(repo.dir);
    await main(args(repo, d.dir), next.value, endpoint().deps);
    assert.ok(next.report().metadata.notes.some((n) => n.startsWith(`This pull request had sent ${failing.requests()} requests of its 50`)));
  } finally {
    d.remove();
    repo.remove();
  }
});

test("a limit that cannot be counted is said not to apply, and nothing is counted without one", async () => {
  const repo = repoWith("limits:\n  max_requests_per_pull_request: 3\n");
  const free = repoWith(null);
  const d = kept();
  try {
    const noDir = io(repo.dir);
    const e = endpoint();
    assert.equal(await main(args(repo), noDir.value, e.deps), EXIT.ok);
    assert.equal(e.requests(), 4, "only the run's own limit held it");
    assert.ok(noDir.report().metadata.notes.some((n) => n.startsWith("limits.max_requests_per_pull_request (3) was not applied: what a pull request has sent is counted in the --answers directory")));

    chmodSync(d.dir, 0o755);
    const open = io(repo.dir);
    await main(args(repo, d.dir), open.value, endpoint().deps);
    assert.ok(open.report().metadata.notes.some((n) => n.includes("the count in --answers could not be used (its directory is readable by others)")));
    chmodSync(d.dir, 0o700);

    const plain = io(free.dir);
    assert.equal(await main(args(free, d.dir), plain.value, endpoint().deps), EXIT.ok);
    assert.equal(d.lines(), 0, "no limit, no count");
    assert.ok(!plain.report().metadata.notes.some((n) => n.includes("max_requests_per_pull_request") || n.includes("This pull request had sent")));
  } finally {
    d.remove();
    repo.remove();
    free.remove();
  }
});


test("where the repository gates on findings, a run the pull request's limit left short does not finish; elsewhere it says so and exits 0", async () => {
  const gated = repoWith("limits:\n  max_requests_per_pull_request: 3\npolicy:\n  fail_on: [finding]\n");
  const open = repoWith("limits:\n  max_requests_per_pull_request: 3\n");
  const d1 = kept();
  const d2 = kept();
  try {
    const a = io(gated.dir);
    assert.equal(await main(args(gated, d1.dir), a.value, endpoint().deps), EXIT.incomplete);
    assert.ok(a.report().metadata.notes.some((n) => n.startsWith("The pull request's limit of 3 requests was reached: 1 judgment of this run could not be sent. policy.fail_on names finding")));
    const b = io(open.dir);
    assert.equal(await main(args(open, d2.dir), b.value, endpoint().deps), EXIT.ok);
    assert.ok(b.report().metadata.notes.some((n) => n === "The pull request's limit of 3 requests was reached: 1 judgment of this run could not be sent."));
    // The control: a limit the run does not reach changes nothing.
    const roomy = repoWith("limits:\n  max_requests_per_pull_request: 50\npolicy:\n  fail_on: [finding]\n");
    const d3 = kept();
    const c = io(roomy.dir);
    const code = await main(args(roomy, d3.dir), c.value, endpoint().deps);
    assert.notEqual(code, EXIT.incomplete);
    assert.ok(!c.report().metadata.notes.some((n) => n.includes("was reached")));
    d3.remove();
    roomy.remove();
  } finally {
    d1.remove();
    d2.remove();
    gated.remove();
    open.remove();
  }
});

test("a request whose count cannot be written is not sent, and the run says so rather than that the limit was reached", async () => {
  for (const limit of [50, 5000]) {
    const repo = repoWith(`limits:\n  max_requests_per_pull_request: ${limit}\npolicy:\n  fail_on: [finding]\n`);
    const d = kept();
    try {
      // Private, readable, and not writable: the count so far reads as 0 and no line can be added.
      writeFileSync(join(d.dir, "sent.log"), "", { mode: 0o400 });
      chmodSync(join(d.dir, "sent.log"), 0o400);
      const e = endpoint();
      const out = io(repo.dir);
      assert.equal(await main(args(repo, d.dir), out.value, e.deps), EXIT.incomplete, `limit ${limit}: nothing was asked, and the gate does not pass it`);
      assert.equal(e.requests(), 0, "nothing left uncounted");
      const notes = out.report().metadata.notes;
      assert.ok(notes.some((n) => n.startsWith("Not sent: 4 requests of this run, because the pull request's count in --answers could not be written.")), notes.join(" | "));
      assert.ok(!notes.some((n) => n.includes("was reached")), `limit ${limit}: the limit was not what stopped it`);
    } finally {
      chmodSync(join(d.dir, "sent.log"), 0o600);
      d.remove();
      repo.remove();
    }
  }
});

test("a run killed while it waits for an answer has already counted the request", async () => {
  const repo = repoWith("limits:\n  max_requests_per_pull_request: 50\n");
  const d = kept();
  // An endpoint that takes the request and never answers.
  let arrived: () => void = () => {};
  const firstArrived = new Promise<void>((r) => (arrived = r));
  const server = createServer(() => arrived());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const child = spawn("node", [join(import.meta.dirname, "..", "src", "cli", "main.ts"), ...args(repo, d.dir)], {
      cwd: repo.dir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", JEV_API_URL: `http://127.0.0.1:${port}/run`, JEV_API_TOKEN: "a-token-long-enough-not-to-appear-in-any-packet-0123456789" },
      stdio: "ignore",
    });
    await firstArrived;
    child.kill("SIGKILL");
    await new Promise((r) => child.on("close", r));
    assert.ok(d.lines() >= 1, "the line was on disk before the request left");
  } finally {
    server.closeAllConnections();
    server.close();
    d.remove();
    repo.remove();
  }
});

test("a limit left exactly at the run's own still says it cut the run short", async () => {
  const repo = repoWith("limits:\n  max_requests: 3\n  max_requests_per_pull_request: 3\n");
  const d = kept();
  try {
    const out = io(repo.dir);
    assert.equal(await main(args(repo, d.dir), out.value, endpoint().deps), EXIT.ok);
    assert.ok(out.report().metadata.notes.some((n) => n === "The pull request's limit of 3 requests was reached: 1 judgment of this run could not be sent."));
  } finally {
    d.remove();
    repo.remove();
  }
});
