import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JevClient } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import type { Questions } from "../src/judgments/provider.ts";
import { TraceWriter, traceFromEnv } from "../src/judgments/trace.ts";
import { main, type Io } from "../src/cli/main.ts";
import { fixtureRepo } from "./helpers/repo.ts";

const questions: Questions = { relation: { type: "choice", instructions: "Does it apply?", criteria: { no: "no", yes: "yes" } } };
const answer = { result: { model: "jev-1.13.0", result: { answers: { relation: { choice: "yes", confidence: 0.8, probabilities: { yes: 0.8, no: 0.2 } } } } } };

function entry(index = 0) {
  return {
    version: 1 as const,
    source: "jev-intent-review" as const,
    timestamp: new Date(index).toISOString(),
    request: { state: { index }, model: "typesafe/jev", questions },
    response: { answers: {} },
  };
}

test("traceFromEnv is opt-in, creates private output, and keeps the observed model only when supplied", async () => {
  assert.equal(traceFromEnv({}), null);
  const dir = await mkdtemp(join(tmpdir(), "jir-trace-"));
  const target = join(dir, "jev.jsonl");
  const client = new JevClient({ host: "custom", url: "https://judge.example/run", token: "private-token" }, {
    fetch: async () => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } }),
  });
  const provider = new JevProvider(client, { env: { JEV_TRACE_FILE: target, JEV_API_TOKEN: "private-token" } });
  assert.equal((await provider.judge({ subject: "r" }, questions)).relation?.choice, "yes");
  const line = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
  assert.equal(line.version, 1);
  assert.equal(line.source, "jev-intent-review");
  assert.equal((line.request as Record<string, unknown>).model, "typesafe/jev");
  assert.deepEqual((line.request as Record<string, unknown>).questions, questions);
  assert.equal((line.response as Record<string, unknown>).model, "jev-1.13.0");
  assert.equal(JSON.stringify(line).includes("private-token"), false);
  assert.equal((await lstat(dir)).mode & 0o077, 0);
  assert.equal((await lstat(target)).mode & 0o077, 0);
});

test("the production CLI path creates traces only when its Io environment enables them", async () => {
  const repo = fixtureRepo("integrity-rust");
  const dir = await mkdtemp(join(tmpdir(), "jir-trace-"));
  const target = join(dir, "trace.jsonl");
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input?: { questions?: Questions }; questions?: Questions };
    const sentQuestions = body.input?.questions ?? body.questions ?? {};
    const answers = Object.fromEntries(Object.entries(sentQuestions).map(([key, question]) => {
      const choice = Object.keys(question.criteria)[0]!;
      return [key, { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }];
    }));
    return new Response(JSON.stringify({ result: { answers } }), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const args = ["--base", repo.base, "--head", repo.head, "--intent-spec", join(import.meta.dirname, "fixtures", "integrity-rust", "spec.json"), "--json"];
  const makeIo = (env: NodeJS.ProcessEnv): Io => ({ stdout: () => {}, stderr: () => {}, cwd: repo.dir, env });
  try {
    assert.equal(await main(args, makeIo({ JEV_API_URL: "https://judge.example/run", JEV_API_TOKEN: "private-token" }), { fetch }), 0);
    await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
    assert.equal(await main(args, makeIo({ JEV_API_URL: "https://judge.example/run", JEV_API_TOKEN: "private-token", JEV_TRACE_FILE: target }), { fetch }), 0);
    const lines = (await readFile(target, "utf8")).trim().split("\n");
    assert.ok(lines.length > 0, "the production client made successful logical judgments");
    for (const line of lines) {
      const parsed = JSON.parse(line) as { request: { model: string }; response: Record<string, unknown> };
      assert.equal(parsed.request.model, "typesafe/jev");
      assert.equal(Object.hasOwn(parsed.response, "model"), false);
      assert.equal(line.includes("private-token"), false);
    }
  } finally {
    repo.remove();
  }
});

test("trace rejects every raw and transport-trimmed credential alias", async () => {
  for (const name of ["JEV_API_TOKEN", "CLOUDFLARE_API_TOKEN", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "jir-trace-"));
    const writer = new TraceWriter(join(dir, "trace.jsonl"), { [name]: " private-token " });
    await assert.rejects(writer.append({ ...entry(), request: { ...entry().request, state: { unsafe: "private-token" } } }), /credential/i, name);
  }
});

test("one logical judgment that retries appends exactly one complete trace line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jir-trace-"));
  const target = join(dir, "trace.jsonl");
  let calls = 0;
  const client = new JevClient({ host: "custom", url: "https://judge.example/run", token: "t" }, {
    maxRetries: 1,
    sleep: async () => {},
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
    },
  });
  await new JevProvider(client, { trace: new TraceWriter(target) }).judge({}, questions);
  const lines = (await readFile(target, "utf8")).trim().split("\n");
  assert.equal(calls, 2);
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]!));
});

test("trace appends independent lines and rejects unsafe targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jir-trace-"));
  const target = join(dir, "trace.jsonl");
  const writer = new TraceWriter(target);
  await Promise.all(Array.from({ length: 20 }, (_, index) => writer.append(entry(index))));
  const lines = (await readFile(target, "utf8")).trim().split("\n");
  assert.equal(lines.length, 20);
  assert.deepEqual(new Set(lines.map((line) => (JSON.parse(line) as { request: { state: { index: number } } }).request.state.index)).size, 20);
  await chmod(target, 0o644);
  await assert.rejects(writer.append(entry()), /trace file is not private/i);
  const link = join(dir, "link.jsonl");
  await symlink(target, link);
  await assert.rejects(new TraceWriter(link).append(entry()), /symlink/i);
});

test("trace refuses a symlink in any caller-controlled parent component", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jir-trace-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "jir-trace-"));
  const link = join(dir, "redirect");
  await symlink(elsewhere, link);
  await assert.rejects(new TraceWriter(join(link, "nested", "trace.jsonl")).append(entry()), /symlink/i);
});
