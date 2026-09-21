// One model, enforced where every request passes, and checked over a whole run.
//
// This tool asks Jev small typed questions. Three times a general instruct model was reached for
// instead — to compile requirements, to pick calls, to write a mapping's prose — and each reach
// looked locally reasonable. None of them was announced; they were noticed by reading the code.
//
// So the rule is not a convention. `JevClient.post` refuses any other model before the
// request is built, and the second test below runs the experimental path end to end against a
// capturing endpoint and reads the model out of every body that was actually sent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { JevClient, ONLY_MODEL, ProviderError } from "../src/judgments/client.ts";
import { JEV_MODEL } from "../src/judgments/jev.ts";
import { main, type Io } from "../src/cli/main.ts";
import { tempRepo } from "./helpers/repo.ts";

const ENDPOINT = { url: "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/ai/run", token: "t", source: "CLOUDFLARE_ACCOUNT_ID" as const };

test("the model this tool asks and the model the transport allows are one constant", () => {
  assert.equal(JEV_MODEL, ONLY_MODEL);
});

test("a request for any other model does not reach the network, and is not counted", async () => {
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  const client = new JevClient(ENDPOINT, { fetch });

  for (const model of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "typesafe/jev-preview", "", undefined]) {
    const error = await client.post({ model, input: {} }).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError, `${model} should have been refused`);
    assert.equal(error.kind, "refused");
    assert.match(error.message, /sends only typesafe\/jev/);
  }
  assert.equal(calls, 0, "nothing was sent");
  assert.deepEqual(client.sent, { requests: 0, bytes: 0 }, "and nothing was counted as sent");

  // The refusal is not a latch: the requests that are right still go.
  await client.post({ model: ONLY_MODEL, input: { state: {}, questions: {} } }).catch(() => {});
  assert.equal(calls, 1);
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

  const repo = tempRepo();
  try {
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

    const out: string[] = [];
    const io: Io = { stdout: (t) => void out.push(t), stderr: () => {}, cwd: repo.dir, env: { JEV_API_URL: `http://127.0.0.1:${port}/run`, JEV_API_TOKEN: "local-token" } };
    const code = await main(["--experimental-local-check", "--base", base, "--head", head, "--intent-spec", spec], io);

    assert.ok(models.length > 0, "the run sent something");
    assert.deepEqual([...new Set(models)], [ONLY_MODEL], `every request asks for Jev, got ${[...new Set(models)].join(", ")}`);
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
      const failed = await main(["--experimental-local-check", "--base", base, "--head", head, "--intent-spec", spec], failing);
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
