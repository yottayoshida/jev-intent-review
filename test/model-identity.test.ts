// Which Jev answered (#84): the alias this tool sends moves, so a run records the versions the
// host named in its responses, counted at the transport every request passes through.

import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, type Io } from "../src/cli/main.ts";
import { JevClient, modelIdentityOf, unwrapModel, type Endpoint } from "../src/judgments/client.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import type { ReviewReport } from "../src/types.ts";
import { FIXTURES, tempRepo } from "./helpers/repo.ts";
import { report as sampleReport } from "./helpers/reports.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "test-token-for-model-identity" };
const ENDPOINT: Endpoint = { url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`, token: CREDENTIALS.CLOUDFLARE_API_TOKEN, host: "cloudflare" };
const RUST_SPEC = join(FIXTURES, "integrity-rust", "spec.json");

const respond = (body: unknown, status = 200, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });

/** Cloudflare's shape, as measured on 2026-09-25: the version two levels down, beside the answers. */
const cloudflare = (answers: unknown, model?: string) => ({ result: { state: "Completed", result: { ...(model === undefined ? {} : { model }), answers } }, success: true, errors: [], messages: [] });

test("the client counts each readable response by the version it names, and nothing else", async () => {
  const bodies: Response[] = [
    respond(cloudflare({}, "jev-1.13.0")),
    respond(cloudflare({}, "jev-1.13.0")),
    respond(cloudflare({}, "jev-1.14.0")),
    respond(cloudflare({})), // no version named
    respond(cloudflare({}, "typesafe/jev")), // the alias sent, echoed back: not a version
    respond(cloudflare({}, "jev\u001b[31m-evil")), // not a plain name: counted, never printed
    respond(cloudflare({}, "x".repeat(101))),
    respond(cloudflare({}, "jev-latest")), // another host's alias is not a version either
    respond({ result: { state: "Completed", result: { model: 13, answers: {} } } }), // not a string: unreadable
    respond("<html>not json</html>", 200, "text/html"), // 2xx, not an answer
    respond({ success: false, errors: [{ message: "no" }] }), // 2xx, a reported failure
    respond({ errors: [] }, 400), // not 2xx
  ];
  const client = new JevClient(ENDPOINT, { fetch: (async () => bodies.shift()!) as typeof fetch, maxRetries: 0 });
  for (let i = 0; i < 12; i++) await client.post(client.request({}, {})).catch(() => undefined);
  const identity = modelIdentityOf("cloudflare", client.identity(), 3);
  assert.deepEqual(identity, {
    host: "cloudflare",
    requested: "typesafe/jev",
    requestedIs: "floating",
    reusedFromEarlierRuns: 3,
    returned: [{ model: "jev-1.13.0", responses: 2 }, { model: "jev-1.14.0", responses: 1 }],
    notReturned: 3,
    unreadable: 3,
    named: "some",
  });
  assert.ok(!JSON.stringify(identity).includes("evil"), "an unreadable version is not carried");
});

test("a TypeSafe or Vercel response names its version at the top level", async () => {
  for (const host of ["typesafe", "vercel"] as const) {
    const url = host === "typesafe" ? "https://api.typesafe.ai/v1/systemone" : "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
    const client = new JevClient({ host, url, token: "t" }, { fetch: (async () => respond({ model: "jev-1.13.0", answers: {} })) as typeof fetch, maxRetries: 0 });
    await client.post(client.request({}, {}));
    assert.deepEqual(modelIdentityOf(host, client.identity()).returned, [{ model: "jev-1.13.0", responses: 1 }], host);
  }
});

test("a level that names only an alias does not hide the version named below it", async () => {
  const client = new JevClient(ENDPOINT, { fetch: (async () => respond({ result: { model: "typesafe/jev", result: { model: "jev-1.13.0", answers: {} } } })) as typeof fetch, maxRetries: 0 });
  await client.post(client.request({}, {}));
  assert.deepEqual(modelIdentityOf("cloudflare", client.identity()).returned, [{ model: "jev-1.13.0", responses: 1 }]);
});

test("the trace reads a response's version as the count does", () => {
  assert.equal(unwrapModel({ result: { model: "typesafe/jev", result: { model: "jev-1.13.0" } } }), "jev-1.13.0");
  assert.equal(unwrapModel({ model: "jev-latest" }), undefined, "an alias is not a version");
  assert.equal(unwrapModel({ model: "jev\u0000x" }), undefined, "nor is a name a report should not carry");
  assert.equal(unwrapModel({ answers: {} }), undefined);
});

test("named says whether every, some, none or no response named a version", () => {
  const tally = (returned: [string, number][], notReturned = 0, unreadable = 0) => ({ returned: new Map(returned), notReturned, unreadable });
  assert.equal(modelIdentityOf("cloudflare", tally([["jev-1", 2]])).named, "all");
  assert.equal(modelIdentityOf("cloudflare", tally([["jev-1", 2]], 1)).named, "some");
  assert.equal(modelIdentityOf("cloudflare", tally([], 1)).named, "none");
  assert.equal(modelIdentityOf("cloudflare", tally([], 0, 1)).named, "none");
  assert.equal(modelIdentityOf("cloudflare", tally([])).named, "no_responses");
  assert.equal(modelIdentityOf("cloudflare", undefined).named, "not_recorded");
  assert.equal(modelIdentityOf("typesafe", undefined).requested, "jev-latest");
});

/** The Rust fixture with the defect, as budget.test.ts builds it. */
function rustRepo() {
  const repo = tempRepo();
  cpSync(join(FIXTURES, "integrity-rust", "base"), repo.dir, { recursive: true });
  const base = repo.commit("base");
  cpSync(join(FIXTURES, "integrity-rust", "head"), repo.dir, { recursive: true });
  const head = repo.commit("head");
  return { ...repo, base, head };
}

/** The real transport against an endpoint answering every question with its first choice, naming `version(n)` on the n-th response. */
function endpoint(version: (n: number) => string | undefined) {
  let n = 0;
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const questions = (JSON.parse(String(init?.body)) as { input: { questions: Record<string, { criteria: Record<string, string> }> } }).input.questions;
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      const choices = Object.keys(q.criteria);
      return [k, { choice: choices[0], probabilities: Object.fromEntries(choices.map((c, i) => [c, i === 0 ? 0.9 : 0.1 / Math.max(1, choices.length - 1)])) }];
    }));
    return respond(cloudflare(answers, version(n++)));
  }) as typeof globalThis.fetch;
  return { fetch, count: () => n };
}

async function once(repo: ReturnType<typeof rustRepo>, version: (n: number) => string | undefined, json: boolean, env: NodeJS.ProcessEnv, extra: string[] = []) {
  const out: string[] = [];
  const io: Io = { stdout: (t) => void out.push(t), stderr: () => {}, cwd: repo.dir, env };
  const server = endpoint(version);
  const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--skip-change-check", ...(json ? ["--json"] : []), ...extra], io, { fetch: server.fetch });
  return { code, out: out.join(""), responses: server.count() };
}

async function run(version: (n: number) => string | undefined, json = true, env: NodeJS.ProcessEnv = CREDENTIALS) {
  const repo = rustRepo();
  try {
    return await once(repo, version, json, env);
  } finally {
    repo.remove();
  }
}

test("--json says which versions answered the run, and counts the responses that named none", async () => {
  const { code, out, responses } = await run((n) => (n === 0 ? "jev-1.13.0" : n === 1 ? "jev-1.14.0" : undefined));
  assert.equal(code, 0);
  assert.ok(responses >= 3, `the fixture sends at least 3 requests (sent ${responses})`);
  const report = JSON.parse(out) as ReviewReport;
  assert.equal(report.metadata.model, "typesafe/jev");
  assert.deepEqual(report.metadata.modelIdentity, {
    host: "cloudflare",
    requested: "typesafe/jev",
    requestedIs: "floating",
    reusedFromEarlierRuns: 0,
    returned: [{ model: "jev-1.13.0", responses: 1 }, { model: "jev-1.14.0", responses: 1 }],
    notReturned: responses - 2,
    unreadable: 0,
    named: "some",
  });
});

test("a host that echoes the alias it was sent has not named a version", async () => {
  const { out, responses } = await run(() => "typesafe/jev");
  const identity = (JSON.parse(out) as ReviewReport).metadata.modelIdentity;
  assert.deepEqual(identity.returned, []);
  assert.equal(identity.notReturned, responses);
  assert.equal(identity.named, "none");
});

test("the Markdown report says which versions answered", async () => {
  const { out, responses } = await run(() => "jev-1.13.0", false);
  assert.match(out, new RegExp(`model \`typesafe/jev\` \\(answered as \`jev-1\\.13\\.0\` ×${responses}\\)`));
});

test("a skipped run says no response came back", async () => {
  const { code, out } = await run(() => "jev-1.13.0", true, {});
  assert.equal(code, 0);
  const report = JSON.parse(out) as ReviewReport;
  assert.ok(report.skipReason, "skipped for want of credentials");
  assert.equal(report.metadata.modelIdentity.named, "no_responses");
  assert.deepEqual(report.metadata.modelIdentity.returned, []);
});

// Which answers the ledger counts as kept from an earlier run, apart from repeats within a run, is
// remembered.test.ts's; this one holds the report to that count. A repeat within a run cannot be
// made from this fixture (each request carries its requirement's id), so it is not staged here.
test("an answer kept by an earlier run is counted as of unknown version, and every response sent once", async () => {
  const repo = rustRepo();
  const answers = mkdtempSync(join(tmpdir(), "jir-identity-"));
  chmodSync(answers, 0o700);
  try {
    const first = JSON.parse((await once(repo, () => "jev-1.13.0", true, CREDENTIALS, ["--answers", answers])).out) as ReviewReport;
    assert.equal(first.metadata.modelIdentity.reusedFromEarlierRuns, 0, "nothing kept yet");
    const second = await once(repo, () => "jev-1.14.0", true, CREDENTIALS, ["--answers", answers]);
    const report = JSON.parse(second.out) as ReviewReport;
    assert.ok(report.sent.reusedFromEarlierRuns > 0, "the second run reuses the first's answers");
    assert.equal(report.metadata.modelIdentity.reusedFromEarlierRuns, report.sent.reusedFromEarlierRuns);
    const identity = report.metadata.modelIdentity;
    assert.equal(identity.returned.reduce((n, r) => n + r.responses, 0) + identity.notReturned + identity.unreadable, second.responses, "every response sent is counted once");
  } finally {
    repo.remove();
    rmSync(answers, { recursive: true, force: true });
  }
});

test("the Markdown line names kept answers and unnamed responses", () => {
  const report = sampleReport();
  report.metadata.modelIdentity = modelIdentityOf("cloudflare", { returned: new Map([["jev-1.13.0", 3]]), notReturned: 1, unreadable: 1 }, 4);
  assert.match(renderMarkdown(report), /model `typesafe\/jev` \(answered as `jev-1\.13\.0` ×3, no version named for 2 responses, 4 answers kept from earlier runs, of unknown version\)/);
  report.metadata.modelIdentity = modelIdentityOf("cloudflare", undefined);
  assert.match(renderMarkdown(report), /\(answered as versions not recorded\)/);
});
