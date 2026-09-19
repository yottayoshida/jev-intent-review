import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { CloudflareClient, credentialsFromEnv, ProviderError } from "../src/judgments/cloudflare.ts";
import { JevProvider, readChoice, unwrapAnswers } from "../src/judgments/jev.ts";
import { LimitedProvider, type JudgmentProvider, type Questions } from "../src/judgments/provider.ts";
import { CANDIDATE_QUESTIONS, QUESTIONS_HASH } from "../src/judgments/questions.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "test-token-value-that-must-never-leak";

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(responses: (Response | Error)[], maxRetries = 2) {
  const fake = fakeFetch(responses);
  const sleeps: number[] = [];
  const c = new CloudflareClient({ accountId: ACCOUNT, apiToken: TOKEN }, { fetch: fake.fn, maxRetries, sleep: async (ms) => void sleeps.push(ms) });
  return { c, calls: fake.calls, sleeps };
}

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProviderError, String(error));
    return error;
  }
  assert.fail("expected a ProviderError");
}

test("credentialsFromEnv: both variables or nothing; a malformed account id is refused", () => {
  assert.equal(credentialsFromEnv({}), null);
  assert.equal(credentialsFromEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT }), null);
  assert.deepEqual(credentialsFromEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN }), { accountId: ACCOUNT, apiToken: TOKEN });
  assert.throws(() => credentialsFromEnv({ CLOUDFLARE_ACCOUNT_ID: "../../evil", CLOUDFLARE_API_TOKEN: TOKEN }), ProviderError);
});

test("the client posts to the account's endpoint with the token, and retries 429 and 5xx", async () => {
  const { c, calls, sleeps } = client([json({}, 429, { "retry-after": "2" }), json({}, 503), json({ result: { ok: 1 } })]);
  assert.deepEqual(await c.post("ai/run", { a: 1 }), { result: { ok: 1 } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`);
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.equal(sleeps[0], 2000, "Retry-After is honoured");
});

test("the client does not retry auth, payment or bad requests, and names what went wrong", async () => {
  for (const [status, kind] of [
    [401, "auth"],
    [403, "auth"],
    [402, "payment"],
    [400, "bad_request"],
  ] as const) {
    const { c, calls } = client([json({ errors: [] }, status)]);
    const error = await providerError(c.post("ai/run", {}));
    assert.equal(error.kind, kind);
    assert.equal(calls.length, 1);
  }
});

test("the client gives up after its retries, and reports timeouts, non-JSON and success:false", async () => {
  const net = client([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
  assert.equal((await providerError(net.c.post("ai/run", {}))).kind, "network");
  assert.equal(net.calls.length, 3);

  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal((await providerError(client([timeout], 0).c.post("ai/run", {}))).kind, "timeout");
  assert.equal((await providerError(client([json({}, 500)], 0).c.post("ai/run", {}))).kind, "server");
  assert.equal((await providerError(client([new Response("<html>", { status: 200 })]).c.post("ai/run", {}))).kind, "bad_response");
  assert.equal((await providerError(client([json({ success: false, errors: [{ message: "nope" }] })]).c.post("ai/run", {}))).kind, "bad_response");
});

test("the client counts every request it actually sends, retries included", async () => {
  const { c } = client([json({}, 429), json({ result: 1 })]);
  await c.post("ai/run", { a: 1 });
  assert.deepEqual(c.sent, { requests: 2, bytes: 2 * Buffer.byteLength(JSON.stringify({ a: 1 })) });
});

test("a body that times out while being read is retried like any other timeout", async () => {
  const failing = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new Error("body timed out"), { name: "TimeoutError" }));
      },
    }),
  );
  const { c, calls } = client([failing, json({ result: "second" })]);
  assert.deepEqual(await c.post("ai/run", {}), { result: "second" });
  assert.equal(calls.length, 2);
});

test("the client starts nothing past its deadline and does not wait past it for a retry", async () => {
  const late = fakeFetch([json({})]);
  const past = new CloudflareClient({ accountId: ACCOUNT, apiToken: TOKEN }, { fetch: late.fn, deadline: 1000, now: () => 2000 });
  assert.equal((await providerError(past.post("ai/run", {}))).kind, "budget");
  assert.equal(late.calls.length, 0);

  const busy = fakeFetch([json({}, 503), json({ result: 1 })]);
  const tight = new CloudflareClient({ accountId: ACCOUNT, apiToken: TOKEN }, { fetch: busy.fn, deadline: 1500, now: () => 1000, sleep: async () => {} });
  assert.equal((await providerError(tight.post("ai/run", {}))).kind, "budget");
  assert.equal(busy.calls.length, 1, "the retry would wait at least 1 s; only 0.5 s were left");
});

test("the token does not show when the client is printed or serialised", () => {
  const { c } = client([]);
  assert.ok(!inspect(c, { depth: 5, showHidden: true }).includes(TOKEN));
  assert.ok(!JSON.stringify(c).includes(TOKEN));
});

test("unwrapAnswers finds the answers however deep the gateway nests them", () => {
  const answers = { relevance: { choice: "unrelated" } };
  assert.deepEqual(unwrapAnswers({ answers }), answers);
  assert.deepEqual(unwrapAnswers({ result: { state: "Completed", result: { answers } } }), answers);
  assert.equal(unwrapAnswers({ result: { nothing: 1 } }), null);
  assert.equal(unwrapAnswers("text"), null);
});

test("readChoice accepts only an offered choice with a confidence between 0 and 1", () => {
  const criteria = { yes: "y", no: "n" };
  assert.deepEqual(readChoice("q", { choice: "yes", confidence: 0.8, probabilities: { yes: 0.8, no: 0.2, other: 1 } }, criteria), {
    choice: "yes",
    confidence: 0.8,
    probabilities: { yes: 0.8, no: 0.2 },
  });
  for (const bad of [
    undefined,
    { choice: "maybe", confidence: 0.5 },
    { choice: "constructor", confidence: 0.5 },
    { choice: "toString", confidence: 0.5 },
    { choice: "yes", confidence: 1.5 },
    { choice: "yes", confidence: Number.NaN },
    { choice: "yes" },
  ]) {
    assert.throws(() => readChoice("q", bad, criteria), (e: unknown) => e instanceof ProviderError && e.kind === "bad_response", JSON.stringify(bad));
  }
});

test("JevProvider sends state and the constant questions, and returns one checked answer per question", async () => {
  const answer = (choice: string) => ({ type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } });
  const { c, calls } = client([json({ result: { result: { answers: { relevance: answer("may_violate"), satisfaction: answer("violates") } } } })]);
  const jev = new JevProvider(c);
  const result = await jev.judge({ requirement: "r" }, CANDIDATE_QUESTIONS);
  assert.equal(result.relevance?.choice, "may_violate");
  assert.equal(result.satisfaction?.choice, "violates");
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.model, "typesafe/jev");
  assert.deepEqual(body.input.questions, CANDIDATE_QUESTIONS);
  assert.deepEqual(body.input.state, { requirement: "r" });

  const missing = client([json({ answers: { relevance: answer("unrelated") } })]);
  assert.equal((await providerError(new JevProvider(missing.c).judge({}, CANDIDATE_QUESTIONS))).kind, "bad_response");
});

test("QUESTIONS_HASH is stable and short", () => {
  assert.match(QUESTIONS_HASH, /^[0-9a-f]{12}$/);
});

class SlowFake implements JudgmentProvider {
  readonly model = "fake";
  inFlight = 0;
  maxInFlight = 0;
  async judge(_state: unknown, questions: Questions) {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.inFlight -= 1;
    return Object.fromEntries(Object.keys(questions).map((k) => [k, { choice: "x", confidence: 1, probabilities: {} }]));
  }
}

test("LimitedProvider never runs more than `concurrency` calls at once", async () => {
  const inner = new SlowFake();
  const limited = new LimitedProvider(inner, { concurrency: 3, deadline: Date.now() + 60_000 });
  await Promise.all(Array.from({ length: 20 }, () => limited.judge({}, CANDIDATE_QUESTIONS)));
  assert.equal(inner.maxInFlight, 3);

  const late = new LimitedProvider(inner, { concurrency: 1, deadline: 0 });
  assert.equal((await providerError(late.judge({}, CANDIDATE_QUESTIONS))).kind, "budget");
});

test("the request and byte budget counts what is actually sent, retries included", async () => {
  // One judgment that the server keeps refusing: four attempts, and a budget of one request.
  const busy = fakeFetch([json({}, 503), json({}, 503), json({}, 503), json({ result: 1 })]);
  const one = new CloudflareClient({ accountId: ACCOUNT, apiToken: TOKEN }, { fetch: busy.fn, maxRequests: 1, sleep: async () => {} });
  assert.equal((await providerError(one.post("ai/run", {}))).kind, "budget");
  assert.equal(busy.calls.length, 1);
  assert.equal(one.sent.requests, 1);

  const small = fakeFetch([json({})]);
  const tiny = new CloudflareClient({ accountId: ACCOUNT, apiToken: TOKEN }, { fetch: small.fn, maxBytes: 10 });
  assert.equal((await providerError(tiny.post("ai/run", { big: "x".repeat(100) }))).kind, "budget");
  assert.equal(small.calls.length, 0, "refused before sending");
});

test("LimitedProvider checks the deadline again after waiting for a slot", async () => {
  let clock = 0;
  const sent: number[] = [];
  const stepping: JudgmentProvider = {
    model: "fake",
    async judge(_state, questions) {
      sent.push(clock);
      await new Promise((resolve) => setTimeout(resolve, 1));
      clock += 100; // each call takes 100 of the fake clock
      return Object.fromEntries(Object.keys(questions).map((k) => [k, { choice: "x", confidence: 1, probabilities: {} }]));
    },
  };
  const limited = new LimitedProvider(stepping, { concurrency: 1, deadline: 150 }, () => clock);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => limited.judge({}, CANDIDATE_QUESTIONS)));
  assert.deepEqual(sent, [0, 100], "calls queued behind the deadline are not sent");
  assert.equal(results.filter((r) => r.status === "rejected").length, 8);
});
