// What is left of discovery after the generic run went (ADR 0007): the word rules a search obeys,
// and the redaction and cutting every packet goes through. The search-and-rank tests went with
// `Discoverer.discover`; `search` and `index` are exercised by the local check's tests.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isTestPath, refuseWord } from "../src/discovery/discover.ts";
import { cut, isSensitivePath, redact } from "../src/evidence/redact.ts";

test("search words that look like options, are too short or are not one word are refused", () => {
  assert.equal(refuseWord("--no-index"), "starts with '-'");
  assert.equal(refuseWord("abc"), "shorter than 4 characters");
  assert.equal(refuseWord("two words"), "not a single word");
  assert.equal(refuseWord("createSession"), null);
  assert.ok(isTestPath("src/session/store.test.ts") && isTestPath("tests/a.rs") && isTestPath("pkg/a_test.go") && !isTestPath("src/testing.ts"));
});

test("redact replaces secret shapes and keeps the names around them", () => {
  const samples = [
    `const k = "AKIA${"A".repeat(16)}";`,
    `token: "${"ghp_"}${"x".repeat(36)}"`,
    `password = "hunter2hunter2"`,
    `-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`,
    `blob = "${"Zm9v".repeat(20)}"`,
  ];
  for (const sample of samples) {
    const { text, count } = redact(sample);
    assert.ok(count >= 1, sample);
    assert.match(text, /REDACTED/);
  }
  assert.equal(redact(`password = "hunter2hunter2"`).text, `password = "[REDACTED]"`);
  assert.deepEqual(redact("const createSession = () => 1;"), { text: "const createSession = () => 1;", count: 0 });
});

test("sensitive paths are recognised case-insensitively anywhere in the tree", () => {
  for (const path of [".env", "config/.env.production", "deploy/key.PEM", "infra/prod.tfvars", "home/.npmrc", "id_ed25519", "gcp/my-serviceAccount.json"]) assert.ok(isSensitivePath(path), path);
  for (const path of ["src/env.ts", "docs/keys.md", "src/tfvars.ts"]) assert.ok(!isSensitivePath(path), path);
});

test("cut keeps the head and the tail within the limit", () => {
  const { text, truncated } = cut("a".repeat(1000) + "TAIL", 200);
  assert.equal(truncated, true);
  assert.ok(text.length <= 200 && text.endsWith("TAIL") && text.startsWith("aaa"));
  assert.deepEqual(cut("short", 200), { text: "short", truncated: false });
});
