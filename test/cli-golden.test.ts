// What the command line sends for the local check, byte for byte, pinned before the default run
// became the local check.
//
// `test/fixtures/local-check-cli-golden.json` was written by this file against main 18ac68c with
// `--experimental-local-check`, on a real git repository built from `test/fixtures/integrity-rust`
// (the same three files as `test/local-check-golden.test.ts`, but a real diff read by git — the two
// records are not comparable). At that commit the flagged path returned before the change question
// ran, so the record holds the local check's requests and nothing else.
//
// After the change the default run has to send exactly these, in this order, before anything
// else. `WRITE_GOLDEN=1` rewrites the record, for a deliberate change only.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main, type Deps } from "../src/cli/main.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import type { ChoiceAnswer } from "../src/types.ts";
import { FIXTURES, fixtureRepo } from "./helpers/repo.ts";

const GOLDEN = new URL("./fixtures/local-check-cli-golden.json", import.meta.url);
const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "test-token" };

interface Sent {
  state: unknown;
  questions: Questions;
}

/** Answers every question the same way and keeps what was sent; the answers shape nothing sent. */
function recording(): { deps: Deps; sent: Sent[] } {
  const sent: Sent[] = [];
  const answers: Record<string, ChoiceAnswer> = {
    requirement_governs: { choice: "applies", probability: 0.9, confidence: 0.9, probabilities: { applies: 0.9 } },
    on_error_result: { choice: "returns_success", probability: 0.9, confidence: 0.9, probabilities: { returns_success: 0.9 } },
    on_error_control: { choice: "keeps_going", probability: 0.9, confidence: 0.9, probabilities: { keeps_going: 0.9 } },
    in_forbidden_case: { choice: "reaches_it", probability: 0.9, confidence: 0.9, probabilities: { reaches_it: 0.9 } },
    justification: { choice: "clearly_required", probability: 0.9, confidence: 0.9, probabilities: { clearly_required: 0.9 } },
  };
  const provider: JudgmentProvider = {
    model: "typesafe/jev",
    async judge(state: unknown, questions: Questions) {
      sent.push({ state, questions });
      const out: Record<string, ChoiceAnswer> = {};
      for (const key of Object.keys(questions)) out[key] = answers[key] ?? { choice: "unknown", probability: 0.9, confidence: 0.9, probabilities: { unknown: 0.9 } };
      return out;
    },
  };
  return { deps: { judges: () => ({ provider, sent: () => ({ requests: sent.length, bytes: 0 }), origin: "https://api.cloudflare.com" }) }, sent };
}

test("the local check's requests through the command line are what they were before the default run became the local check", async () => {
  const repo = fixtureRepo("integrity-rust");
  try {
    const { deps, sent } = recording();
    const out: string[] = [];
    const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", join(FIXTURES, "integrity-rust", "spec.json"), "--experimental-local-check", "--json"], { stdout: (t) => void out.push(t), stderr: () => {}, cwd: repo.dir, env: CREDENTIALS }, deps);
    assert.equal(code, 0);
    // JSON round trip: what is compared is what a host would have received.
    const now = JSON.parse(JSON.stringify(sent)) as Sent[];
    if (process.env.WRITE_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Sent[];
    assert.ok(golden.length > 0, "the record holds requests");
    assert.equal(now.length, golden.length, "how many requests");
    for (let i = 0; i < golden.length; i++) assert.equal(JSON.stringify(now[i]), JSON.stringify(golden[i]), `request ${i + 1}`);
  } finally {
    repo.remove();
  }
});
