import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { JevClient, EndpointError, endpointFromEnv, fromEndpoint, ProviderError, type Endpoint } from "../src/judgments/client.ts";
import { JevProvider, readChoice, unwrapAnswers } from "../src/judgments/jev.ts";
import { LimitedProvider, type JudgmentProvider, type Questions } from "../src/judgments/provider.ts";
import { CANDIDATE_QUESTIONS, QUESTIONS_HASH } from "../src/judgments/questions.ts";

/** Every request the transport lets through asks for this model; the guard is tested in `only-jev`. */
const JEV = { model: "typesafe/jev" };

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "test-token-value-that-must-never-leak";
const CLOUDFLARE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`;
const ENDPOINT: Endpoint = { url: CLOUDFLARE_URL, token: TOKEN, source: "CLOUDFLARE_ACCOUNT_ID" };

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
  const c = new JevClient(ENDPOINT, { fetch: fake.fn, maxRetries, sleep: async (ms) => void sleeps.push(ms) });
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

test("endpointFromEnv: every combination of the four variables, and each token only to its own endpoint", () => {
  const OTHER = "https://judge.example.com/ai/run";
  const cf = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
  // A URL of one's own, with its token: any Cloudflare variable is beside the point.
  for (const extra of [{}, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, cf]) {
    assert.deepEqual(endpointFromEnv({ JEV_API_URL: OTHER, JEV_API_TOKEN: "t", ...extra }), { url: OTHER, token: "t", source: "JEV_API_URL" });
  }
  // A URL without its token is a fork's pull request: no credentials, not an error.
  assert.equal(endpointFromEnv({ JEV_API_URL: OTHER }), null);
  assert.equal(endpointFromEnv({ JEV_API_URL: OTHER, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }), null);
  // The URL is still checked: a bad one is said now, not when a token is added months later.
  assert.throws(() => endpointFromEnv({ JEV_API_URL: "http://example.com/ai/run" }), EndpointError);
  // But the Cloudflare token is never sent to another URL, and JEV_API_TOKEN never to Cloudflare.
  assert.throws(() => endpointFromEnv({ JEV_API_URL: OTHER, CLOUDFLARE_API_TOKEN: TOKEN }), EndpointError);
  assert.throws(() => endpointFromEnv({ JEV_API_TOKEN: "t" }), EndpointError);
  assert.throws(() => endpointFromEnv({ JEV_API_TOKEN: "t", ...cf }), EndpointError);
  // Cloudflare, as before.
  assert.deepEqual(endpointFromEnv(cf), ENDPOINT);
  assert.equal(endpointFromEnv({}), null);
  assert.equal(endpointFromEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT }), null);
  assert.equal(endpointFromEnv({ CLOUDFLARE_API_TOKEN: TOKEN }), null);
  assert.throws(() => endpointFromEnv({ CLOUDFLARE_ACCOUNT_ID: "../../evil", CLOUDFLARE_API_TOKEN: TOKEN }), EndpointError);
  // An input a workflow did not fill arrives as "".
  assert.deepEqual(endpointFromEnv({ JEV_API_URL: "  ", JEV_API_TOKEN: "", ...cf }), ENDPOINT);
  assert.throws(() => endpointFromEnv({ JEV_API_URL: OTHER, JEV_API_TOKEN: "two words" }), EndpointError, "a value with whitespace inside it is not a token");
});

test("endpointFromEnv: https only, http for this machine only, and no URL in what it says", () => {
  const url = (JEV_API_URL: string) => endpointFromEnv({ JEV_API_URL, JEV_API_TOKEN: "t" })?.url;
  assert.equal(url("http://127.0.0.1:8787/ai/run"), "http://127.0.0.1:8787/ai/run");
  assert.equal(url("http://localhost:8787/ai/run"), "http://localhost:8787/ai/run");
  assert.equal(url("http://[::1]:8787/ai/run"), "http://[::1]:8787/ai/run");
  assert.equal(url("http://127.1:8787/ai/run"), "http://127.0.0.1:8787/ai/run", "the parser normalises it to loopback");
  assert.equal(url("https://judge.example.com/ai/run?key=secret-in-the-query"), "https://judge.example.com/ai/run?key=secret-in-the-query");
  for (const bad of ["http://example.com/ai/run", "http://localhost.attacker.com/ai/run", "http://127.0.0.1.nip.io/ai/run", "ftp://example.com/x", "not a url"]) {
    assert.throws(() => url(bad), EndpointError, bad);
  }
  // What it says names the origin and nothing else: a path or a query can hold the secret itself.
  const said = (raw: string) => {
    try {
      url(raw);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail(`${raw} was accepted`);
  };
  // https, so that what refuses it is the user name and not the scheme.
  const secret = said("https://alice:hunter2@example.com/ai/run/secret-path?key=secret-in-the-query");
  assert.match(secret, /user name or password/);
  for (const part of ["alice", "hunter2", "secret-path", "secret-in-the-query"]) assert.ok(!secret.includes(part), secret);
});

test("fromEndpoint flattens what the endpoint returns and never repeats the token back", () => {
  assert.equal(fromEndpoint(`line\n::error::forged\r\nmore`, ""), "line ::error::forged more");
  assert.equal(fromEndpoint(`your token ${TOKEN} is wrong`, TOKEN), "your token [REDACTED TOKEN] is wrong");
  assert.equal(fromEndpoint("x".repeat(500), "", 10), "x".repeat(10));
  // Characters that reorder what a reader sees are gone too.
  assert.equal(fromEndpoint("start‮middle⁦end", ""), "start middle end");
});

test("a key kept in the URL's query does not come back in what the endpoint says", async () => {
  const endpoint: Endpoint = { url: "https://judge.example.com/ai/run?key=secret-in-the-query", token: TOKEN, source: "JEV_API_URL" };
  const fake = fakeFetch([new Response("Cannot POST /ai/run?key=secret-in-the-query", { status: 404 })]);
  const c = new JevClient(endpoint, { fetch: fake.fn, maxRetries: 0 });
  const error = await providerError(c.post(JEV));
  assert.ok(!error.message.includes("secret-in-the-query"), error.message);
  assert.match(error.message, /\[REDACTED QUERY\]/);
});

test("the client posts to the account's endpoint with the token, and retries 429 and 5xx", async () => {
  const { c, calls, sleeps } = client([json({}, 429, { "retry-after": "2" }), json({}, 503), json({ result: { ok: 1 } })]);
  assert.deepEqual(await c.post({ ...JEV, a: 1 }), { result: { ok: 1 } });
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
    const error = await providerError(c.post(JEV));
    assert.equal(error.kind, kind);
    assert.equal(calls.length, 1);
  }
});

test("a redirect or a 404 is the endpoint's answer about itself: no retry, and nothing is sent after it", async () => {
  for (const first of [json({}, 302, { location: "https://elsewhere.example.com/" }), json({}, 404), json({}, 405)]) {
    const { c, calls } = client([first, json({ result: 1 }), json({ result: 1 })]);
    const error = await providerError(c.post(JEV));
    assert.equal(error.kind, "endpoint", String(first.status));
    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.init as RequestInit).redirect, "manual", "a redirect is never followed with the token attached");
    // The latch: the eight judgments in flight and the queue behind them stop too.
    const again = await providerError(c.post(JEV));
    assert.equal(again, error);
    assert.equal(calls.length, 1, "nothing was sent after the endpoint refused");
  }

  // A refused token and an empty balance latch the same way; one 400 is about one packet only.
  for (const [status, kind, after] of [
    [401, "auth", 1],
    [402, "payment", 1],
    [400, "bad_request", 2],
  ] as const) {
    const { c, calls } = client([json({}, status), json({ result: 1 })]);
    assert.equal((await providerError(c.post(JEV))).kind, kind);
    await c.post(JEV).catch(() => {});
    assert.equal(calls.length, after, `${status} ${kind}`);
  }
});

test("a second answer it cannot use, with none read yet, is the endpoint and not the packet", async () => {
  // However the answer is unusable: refused, not JSON, or a failure the endpoint reports itself.
  const unusable = [
    () => json({ errors: [] }, 400),
    () => new Response("<html>not an API</html>", { status: 200 }),
    () => json({ success: false, errors: [{ message: "nope" }] }),
  ];
  for (const [i, first] of unusable.entries()) {
    for (const second of unusable) {
      const { c, calls } = client([first(), second(), json({ result: 1 })], 0);
      await providerError(c.post({ ...JEV, a: 1 }));
      const error = await providerError(c.post({ ...JEV, b: 2 }));
      assert.equal(error.kind, "endpoint", `${i}`);
      assert.match(error.message, /not a Workers AI run endpoint/);
      await c.post({ ...JEV, c: 3 }).catch(() => {});
      assert.equal(calls.length, 2, "the rest of the run is not sent");
    }
  }

  // An answer that could be read, not merely a 200, is what makes the next failure one packet's.
  const working = client([json({ result: 1 }), json({ errors: [] }, 400), new Response("<html>", { status: 200 }), json({ result: 2 })], 0);
  await working.c.post(JEV);
  assert.equal((await providerError(working.c.post(JEV))).kind, "bad_request");
  assert.equal((await providerError(working.c.post(JEV))).kind, "bad_response");
  assert.deepEqual(await working.c.post(JEV), { result: 2 });
  assert.equal(working.calls.length, 4);

  // "Not now" is not "not here": a rate limit and a server error never stand for the endpoint.
  const busy = client([json({}, 429), json({}, 503), json({ result: 1 })], 0);
  assert.equal((await providerError(busy.c.post(JEV))).kind, "rate_limited");
  assert.equal((await providerError(busy.c.post(JEV))).kind, "server");
  assert.deepEqual(await busy.c.post(JEV), { result: 1 });
});

test("nothing the endpoint returns can forge a log line or hand the token back", async () => {
  const { c } = client([new Response(`{"broken"\n::error::forged\ntoken ${TOKEN}`, { status: 500 })], 0);
  const error = await providerError(c.post(JEV));
  assert.ok(!error.message.includes(TOKEN), error.message);
  assert.ok(!/[\r\n]/.test(error.message), error.message);
  assert.match(error.message, /https:\/\/api\.cloudflare\.com answered 500/);

  // A failure the endpoint reports in its own JSON goes through the same treatment.
  const reported = client([json({ success: false, errors: [{ message: `no\n::add-mask::${TOKEN}` }] })], 0);
  const second = await providerError(reported.c.post(JEV));
  assert.ok(!second.message.includes(TOKEN) && !/[\r\n]/.test(second.message), second.message);
});

test("the client gives up after its retries, and reports timeouts, non-JSON and success:false", async () => {
  const net = client([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
  assert.equal((await providerError(net.c.post(JEV))).kind, "network");
  assert.equal(net.calls.length, 3);

  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal((await providerError(client([timeout], 0).c.post(JEV))).kind, "timeout");
  assert.equal((await providerError(client([json({}, 500)], 0).c.post(JEV))).kind, "server");
  assert.equal((await providerError(client([new Response("<html>", { status: 200 })]).c.post(JEV))).kind, "bad_response");
  assert.equal((await providerError(client([json({ success: false, errors: [{ message: "nope" }] })]).c.post(JEV))).kind, "bad_response");
});

test("the client counts every request it actually sends, retries included", async () => {
  const { c } = client([json({}, 429), json({ result: 1 })]);
  await c.post({ ...JEV, a: 1 });
  assert.deepEqual(c.sent, { requests: 2, bytes: 2 * Buffer.byteLength(JSON.stringify({ ...JEV, a: 1 })) });
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
  assert.deepEqual(await c.post(JEV), { result: "second" });
  assert.equal(calls.length, 2);
});

test("the client starts nothing past its deadline and does not wait past it for a retry", async () => {
  const late = fakeFetch([json({})]);
  const past = new JevClient(ENDPOINT, { fetch: late.fn, deadline: 1000, now: () => 2000 });
  assert.equal((await providerError(past.post(JEV))).kind, "budget");
  assert.equal(late.calls.length, 0);

  const busy = fakeFetch([json({}, 503), json({ result: 1 })]);
  const tight = new JevClient(ENDPOINT, { fetch: busy.fn, deadline: 1500, now: () => 1000, sleep: async () => {} });
  assert.equal((await providerError(tight.post(JEV))).kind, "budget");
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
  const one = new JevClient(ENDPOINT, { fetch: busy.fn, maxRequests: 1, sleep: async () => {} });
  assert.equal((await providerError(one.post(JEV))).kind, "budget");
  assert.equal(busy.calls.length, 1);
  assert.equal(one.sent.requests, 1);

  const small = fakeFetch([json({})]);
  const tiny = new JevClient(ENDPOINT, { fetch: small.fn, maxBytes: 10 });
  assert.equal((await providerError(tiny.post({ ...JEV, big: "x".repeat(100) }))).kind, "budget");
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
