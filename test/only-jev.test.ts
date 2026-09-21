// One model, enforced where every request passes, and checked over a whole run.
//
// This tool asks Jev small typed questions. Three times a general instruct model was reached for
// instead — to compile requirements, to pick calls, to write a mapping's prose — and each reach
// looked locally reasonable. None of them was announced; they were noticed by reading the code.
//
// So the rule is not a convention. `JevClient.post` refuses any other model before the
// request is built, and the tests below run the experimental path end to end — against a
// capturing endpoint, and against a stand-in for each named host — and read the model out of
// every body that was actually sent.
//
// Jev has a different name on each host. What a request may ask for is Jev's name on the host the
// endpoint is, from a closed table: an `Endpoint` carries which host it is and nothing else.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostName, jevModel, JevClient, PROVIDERS, ProviderError, type Endpoint, type Host, type Provider } from "../src/judgments/client.ts";
import { main, type Io } from "../src/cli/main.ts";
import { tempRepo } from "./helpers/repo.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENDPOINTS: Record<Host, Endpoint> = {
  cloudflare: { host: "cloudflare", url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`, token: "t" },
  typesafe: { host: "typesafe", url: "https://api.typesafe.ai/v1/systemone", token: "t" },
  vercel: { host: "vercel", url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone", token: "t" },
  custom: { host: "custom", url: "https://judge.example.com/ai/run", token: "t" },
};
// Jev's name on each host, as each host documents it. Written out rather than read from the table,
// so that the table cannot drift into allowing a fourth name.
const JEV_NAMES = { cloudflare: "typesafe/jev", typesafe: "jev-latest", vercel: "typesafe-ai/jev", custom: "typesafe/jev" } as const;
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

test("the only models this tool can ask for are Jev's names on the three hosts", () => {
  for (const host of Object.keys(ENDPOINTS) as Host[]) assert.equal(jevModel(host), JEV_NAMES[host], host);
  assert.deepEqual(new Set((Object.keys(ENDPOINTS) as Host[]).map(jevModel)), new Set(["typesafe/jev", "jev-latest", "typesafe-ai/jev"]));
});

test("on every host, a request for any other model — another host's Jev, llama, none — does not reach the network", async () => {
  for (const host of Object.keys(ENDPOINTS) as Host[]) {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const client = new JevClient(ENDPOINTS[host], { fetch });
    const others = [...new Set(Object.values(JEV_NAMES))].filter((name) => name !== JEV_NAMES[host]);
    for (const model of [...others, LLAMA, "typesafe/jev-preview", "", undefined]) {
      const error = await client.post({ model, input: {} }).catch((e: unknown) => e);
      assert.ok(error instanceof ProviderError, `${host}: ${model} should have been refused`);
      assert.equal(error.kind, "refused");
      assert.ok(error.message.includes(`sends only ${JEV_NAMES[host]} to ${hostName(host)}`), error.message);
    }
    assert.equal(calls, 0, `${host}: nothing was sent`);
    assert.deepEqual(client.sent, { requests: 0, bytes: 0 }, `${host}: and nothing was counted as sent`);

    // The refusal is not a latch: the requests that are right still go.
    await client.post(client.request({}, {})).catch(() => {});
    assert.equal(calls, 1, host);
  }
});

test("a named host is reached at its own fixed address, however the endpoint was built", () => {
  assert.throws(() => new JevClient({ host: "typesafe", url: "https://evil.example/v1/systemone", token: "t" }), /TypeSafe is only reached at https:\/\/api\.typesafe\.ai\/v1\/systemone/);
  assert.throws(() => new JevClient({ host: "vercel", url: "https://api.typesafe.ai/v1/systemone", token: "t" }), /Vercel AI Gateway is only reached at/);
  assert.throws(() => new JevClient({ host: "cloudflare", url: "https://judge.example.com/ai/run", token: "t" }), /Cloudflare Workers AI is only reached at/);
  for (const host of Object.keys(ENDPOINTS) as Host[]) assert.doesNotThrow(() => new JevClient(ENDPOINTS[host]), host);
  // A host the table does not hold has no Jev name and no address to be held to.
  for (const host of ["constructor", "__proto__", "toString", "Typesafe", ""]) {
    assert.throws(() => new JevClient({ host: host as Host, url: "https://attacker.example/x", token: "t" }), /one of the known hosts/, host);
  }
});

test("changing the endpoint object after the client is built does not move the key", async () => {
  const seen: { url: string; authorization: string }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? "" });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  const endpoint: Endpoint = { ...ENDPOINTS.typesafe, token: "the-typesafe-key" };
  const client = new JevClient(endpoint, { fetch });
  endpoint.url = "https://attacker.example/steal";
  endpoint.token = "another-key";
  endpoint.host = "custom";
  await client.post(client.request({}, {}));
  assert.deepEqual(seen, [{ url: "https://api.typesafe.ai/v1/systemone", authorization: "Bearer the-typesafe-key" }]);
  assert.equal(client.where, "TypeSafe (https://api.typesafe.ai)");
});

test("over a whole run of the experimental path, every request that is sent asks for Jev", async () => {
  // Not the client's own guard read back: a server that records what arrived.
  const models: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      models.push(String((JSON.parse(body || "{}") as { model?: unknown }).model));
      response.writeHead(200, { "content-type": "application/json" });
      // One answer shape that fits both questions this path asks.
      response.end(JSON.stringify({ result: { answers: { requirement_governs: { choice: "applies", confidence: 0.9, probabilities: { applies: 0.9 } }, on_error_result: { choice: "returns_success", confidence: 0.9, probabilities: { returns_success: 0.9 } }, on_error_control: { choice: "keeps_going", confidence: 0.9, probabilities: { keeps_going: 0.9 } } } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const { repo, args } = fixtureRepo();
  try {
    const out: string[] = [];
    const io: Io = { stdout: (t) => void out.push(t), stderr: () => {}, cwd: repo.dir, env: { JEV_API_URL: `http://127.0.0.1:${port}/run`, JEV_API_TOKEN: "local-token" } };
    const code = await main(args, io);

    assert.ok(models.length > 0, "the run sent something");
    assert.deepEqual([...new Set(models)], [JEV_NAMES.custom], `every request asks for Jev, got ${[...new Set(models)].join(", ")}`);
    // And the run really did both halves, so this is not a count of zero dressed as agreement.
    const text = out.join("");
    assert.match(text, /### Worth checking/);
    assert.match(text, /\*\*Requirement R1\*\*: "A baseline that cannot be read/);
    assert.match(text, /\*\*Jev, on what the function returns\*\*: returns_success/);
    assert.equal(code, 0, "a listed call does not change the exit code");
    assert.ok(!/VERIFIED/.test(text), "and no requirement-level status is introduced");

    // The other half of the sentence the README makes. A finding is not a failure, but a failure
    // still is one — saying only the first reads as "this command never fails", which it does not.
    // 401 rather than 500: a refused token is not retried, so this costs one request instead of
    // four and a backoff. Either is a provider failure; the point is the exit code.
    const broken = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: [{ message: "the token was refused" }] }));
    });
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    try {
      const errors: string[] = [];
      const failing: Io = { stdout: () => {}, stderr: (t) => void errors.push(t), cwd: repo.dir, env: { JEV_API_URL: `http://127.0.0.1:${(broken.address() as AddressInfo).port}/run`, JEV_API_TOKEN: "local-token" } };
      const failed = await main(args, failing);
      assert.notEqual(failed, 0, "a provider that cannot answer is a failure, and says so");
      assert.match(errors.join(""), /401/);
    } finally {
      await new Promise<void>((resolve) => broken.close(() => resolve()));
    }
  } finally {
    repo.remove();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Each named host as its documentation describes it: the address, the request body, Jev's name and
// the response. The stand-in refuses (422, as TypeSafe does for a request it cannot validate)
// anything that is not that host's documented request, so a request built for another host fails
// here rather than being answered.
//   Cloudflare: https://developers.cloudflare.com/ai/models/typesafe/jev/ (response shape as measured)
//   TypeSafe:   https://docs.typesafe.ai/api
//   Vercel:     https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe (TypeSafe's shapes; the
//               choice answers here leave out `confidence`, which that page does not show)
const KEYS: Record<Provider, string> = { cloudflare: "stand-in-cloudflare-key", typesafe: "stand-in-typesafe-key", vercel: "stand-in-vercel-key" };
const EVERY_KEY = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: KEYS.cloudflare, TYPESAFE_API_KEY: KEYS.typesafe, AI_GATEWAY_API_KEY: KEYS.vercel };
const DOCUMENTED: Record<Provider, { url: string; wrapped: boolean; reply: (answers: Record<string, unknown>) => unknown }> = {
  cloudflare: {
    url: ENDPOINTS.cloudflare.url,
    wrapped: true,
    reply: (answers) => ({ result: { state: "Completed", result: { model: "jev-1.13.0", answers, usage: { input_tokens: 296, output_tokens: 20 } } }, success: true, errors: [], messages: [] }),
  },
  typesafe: { url: ENDPOINTS.typesafe.url, wrapped: false, reply: (answers) => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 296, output_tokens: 20 } }) },
  vercel: {
    url: ENDPOINTS.vercel.url,
    wrapped: false,
    reply: (answers) => ({
      model: "typesafe-ai/jev",
      answers: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, { ...(a as object), confidence: undefined }])),
      usage: { input_tokens: 275, output_tokens: 20 },
      provider_metadata: { gateway: { routing: { originalModelId: "typesafe-ai/jev", resolvedProvider: "typesafe-ai", finalProvider: "typesafe-ai" } } },
    }),
  },
};
// One answer per question this path asks, in TypeSafe's choice shape.
const CHOSEN: Record<string, string> = { requirement_governs: "applies", on_error_result: "returns_success", on_error_control: "keeps_going" };

interface Seen {
  url: string;
  authorization: string;
  model: unknown;
  refused: boolean;
}

/** A stand-in for `host`: answers its documented request, refuses everything else, records all. */
type Asked = Record<string, { type?: unknown; instructions?: unknown; criteria?: unknown }>;

function standIn(host: Provider, answer: (questions: Asked) => Record<string, unknown> | null, status = 200): { fetch: typeof globalThis.fetch; seen: Seen[] } {
  const doc = DOCUMENTED[host];
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const inner = (doc.wrapped ? body.input : body) as Record<string, unknown> | undefined;
    const questions = inner?.questions as Asked | undefined;
    const documented =
      url === doc.url &&
      authorization === `Bearer ${KEYS[host]}` &&
      body.model === JEV_NAMES[host] &&
      (doc.wrapped ? !("state" in body) && !("questions" in body) : !("input" in body)) &&
      inner !== undefined &&
      "state" in inner &&
      questions !== undefined &&
      Object.values(questions).every((q) => q.type === "choice" && typeof q.instructions === "string" && typeof q.criteria === "object");
    seen.push({ url, authorization, model: body.model, refused: !documented });
    if (!documented) return new Response(JSON.stringify({ message: "not this host's request", error_type: "invalid_request" }), { status: 422 });
    if (status !== 200) return new Response("", { status, headers: { location: "https://elsewhere.example/" } });
    const answers = answer(questions);
    return new Response(JSON.stringify(answers === null ? { model: "jev-1.13.0", note: "no answers here" } : doc.reply(answers)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

// The local check's questions get the answers above; any other question (the review path asks
// several) gets its first option.
const documentedAnswers = (questions: Asked) =>
  Object.fromEntries(
    Object.entries(questions).map(([k, q]) => {
      const choice = CHOSEN[k] ?? Object.keys(q.criteria as object)[0]!;
      return [k, { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }];
    }),
  );

function fixtureRepo() {
  const repo = tempRepo();
  repo.write({
    "src/util.rs": "pub(crate) fn read_capped(path: &Path, max: u64) -> io::Result<String> {\n    Ok(String::new())\n}\n",
    "src/integrity.rs": "pub fn read_baseline(base_dir: &Path) -> Result<Option<Baseline>, AppError> {\n    let content = read_plain(base_dir)?;\n    Ok(Some(content))\n}\n",
  });
  const base = repo.commit("before");
  repo.write({
    "src/integrity.rs": "pub fn read_baseline(base_dir: &Path) -> Result<Option<Baseline>, AppError> {\n    let Ok(content) = crate::util::read_capped(base_dir, MAX) else {\n        return Ok(None);\n    };\n    Ok(Some(content))\n}\n",
  });
  const head = repo.commit("a read that carries on");
  const spec = join(repo.dir, "spec.json");
  writeFileSync(
    spec,
    JSON.stringify({ version: 1, title: "t", summary: "", requirements: [{ id: "R1", text: "A baseline that cannot be read is not reported as no baseline at all.", kind: "behavior", priority: "required", sourceRefs: [], searchHints: [] }], nonGoals: [], ambiguities: [] }),
  );
  return { repo, args: ["--experimental-local-check", "--base", base, "--head", head, "--intent-spec", spec] };
}

test("without the named host's key, or with a setting to fix, nothing is sent at all", async () => {
  const { repo, args } = fixtureRepo();
  try {
    for (const [env, exit, why] of [
      [{ JEV_PROVIDER: "vercel", TYPESAFE_API_KEY: KEYS.typesafe, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: KEYS.cloudflare }, 0, "Vercel named, its key missing: no credentials, whatever else is set"],
      [{ TYPESAFE_API_KEY: KEYS.typesafe, AI_GATEWAY_API_KEY: KEYS.vercel }, 0, "TypeSafe's and Vercel's keys alone select nothing"],
      [{ JEV_PROVIDER: "Vercel", ...EVERY_KEY }, 10, "a value that names no host"],
      [{ JEV_PROVIDER: "typesafe", JEV_API_URL: "https://judge.example.com/ai/run", JEV_API_TOKEN: "t", TYPESAFE_API_KEY: KEYS.typesafe }, 10, "two ways of choosing at once"],
    ] as const) {
      let sent = 0;
      const fetch = (async () => {
        sent += 1;
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch;
      const out: string[] = [];
      const code = await main(args, { stdout: (t) => void out.push(t), stderr: () => {}, cwd: repo.dir, env: { ...env } }, { fetch });
      assert.equal(code, exit, why);
      assert.equal(sent, 0, `${why}: nothing sent`);
      if (exit === 0) assert.match(out.join(""), /No credentials for the judgments/, why);
    }
    // A named host whose key is missing is said by name: a mistyped secret in a workflow is
    // otherwise a green run that judged nothing.
    const out: string[] = [];
    await main([...args, "--json"], { stdout: (t) => void out.push(t), stderr: () => {}, cwd: repo.dir, env: { JEV_PROVIDER: "vercel", AI_GATEWAY_API_KEYS: "a typo" } });
    assert.match(out.join(""), /AI_GATEWAY_API_KEY, which JEV_PROVIDER=vercel needs/);
    // And the skipped report names the model the named host would have been asked for.
    const skipped = JSON.parse(out.join("")) as { verdict: string; metadata: { model: string } };
    assert.equal(skipped.verdict, "skipped");
    assert.equal(skipped.metadata.model, "typesafe-ai/jev");
  } finally {
    repo.remove();
  }
});

test("the review path, too: JEV_PROVIDER decides where it goes, and the report says which host judged", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("the real network was reached");
  }) as typeof globalThis.fetch;
  const { repo, args } = fixtureRepo();
  try {
    const { fetch, seen } = standIn("typesafe", documentedAnswers);
    const out: string[] = [];
    const err: string[] = [];
    const reviewArgs = args.filter((a) => a !== "--experimental-local-check");
    const code = await main([...reviewArgs, "--json"], { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: repo.dir, env: { JEV_PROVIDER: "typesafe", ...EVERY_KEY } }, { fetch });
    const report = JSON.parse(out.join("")) as { verdict: string; sent: { requests: number; endpoint?: string; host?: string }; metadata: { model: string } };
    assert.ok(code === 0 || code === 1 || code === 2, `a review result, not a failure: ${code} ${err.join("")}`);
    assert.notEqual(report.verdict, "skipped");
    assert.ok(seen.length > 0 && seen.every((s) => !s.refused && s.url === DOCUMENTED.typesafe.url && s.authorization === `Bearer ${KEYS.typesafe}`), JSON.stringify(seen.slice(0, 2)));
    assert.equal(report.sent.requests, seen.length);
    assert.equal(report.sent.endpoint, "https://api.typesafe.ai");
    assert.equal(report.sent.host, "typesafe");
    assert.equal(report.metadata.model, "jev-latest");
  } finally {
    globalThis.fetch = realFetch;
    repo.remove();
  }
});

test("JEV_PROVIDER and that host's key: every request goes to that host only, in its documented shape, and each host reaches the same result", async () => {
  // Nothing in this test may reach the real network: a host this code does not route through the
  // stand-in fails the run loudly instead of being called.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("the real network was reached");
  }) as typeof globalThis.fetch;
  const { repo, args } = fixtureRepo();
  try {
    const outputs: string[] = [];
    for (const host of PROVIDERS) {
      const { fetch, seen } = standIn(host, documentedAnswers);
      const out: string[] = [];
      const err: string[] = [];
      // Every host's key is set; only the named one may be sent anywhere.
      const io: Io = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: repo.dir, env: { JEV_PROVIDER: host, ...EVERY_KEY } };
      const code = await main(args, io, { fetch });
      const text = out.join("");

      assert.ok(seen.length > 0, `${host}: the run sent something (${err.join("")})`);
      assert.deepEqual(seen.filter((s) => s.refused), [], `${host}: every request was that host's documented request`);
      assert.ok(seen.every((s) => s.url === DOCUMENTED[host].url && s.authorization === `Bearer ${KEYS[host]}`), `${host}: that host's address and key, and no other`);
      assert.equal(code, 0, `${host}: ${err.join("")}`);
      assert.ok(!/skipped|No credentials/i.test(text), `${host}: not skipped`);
      assert.match(text, /### Worth checking/, host);
      assert.match(text, /\*\*Jev, on what the function returns\*\*: returns_success/, host);
      outputs.push(text);
    }
    assert.equal(outputs[1], outputs[0], "TypeSafe reaches the result Cloudflare does");
    assert.equal(outputs[2], outputs[0], "Vercel AI Gateway reaches the result Cloudflare does");

    for (const host of PROVIDERS) {
      // An answer this tool cannot read: the run fails, and says which host gave it.
      const wrong = standIn(host, () => null);
      const err: string[] = [];
      const code = await main(args, { stdout: () => {}, stderr: (t) => void err.push(t), cwd: repo.dir, env: { JEV_PROVIDER: host, ...EVERY_KEY } }, { fetch: wrong.fetch });
      assert.equal(code, 12, `${host}: ${err.join("")}`);
      assert.ok(err.join("").includes(`${hostName(host)} (${new URL(DOCUMENTED[host].url).origin})`), `${host} is named: ${err.join("")}`);

      // A redirect: the run stops at once, names the host, and sends nothing after it.
      const moved = standIn(host, documentedAnswers, 307);
      const movedErr: string[] = [];
      const movedCode = await main(args, { stdout: () => {}, stderr: (t) => void movedErr.push(t), cwd: repo.dir, env: { JEV_PROVIDER: host, ...EVERY_KEY } }, { fetch: moved.fetch });
      assert.equal(movedCode, 12, host);
      assert.equal(moved.seen.length, 1, `${host}: nothing is sent after a redirect`);
      assert.ok(movedErr.join("").includes(hostName(host)), `${host} is named: ${movedErr.join("")}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    repo.remove();
  }
});
