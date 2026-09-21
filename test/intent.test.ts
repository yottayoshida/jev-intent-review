import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checklistItems, compileChecklist, isStatement, quoteIsIn, readModelJson, readRequirementText, toSpec } from "../src/intent/compiler.ts";
import { closedIssueNumbers, GitHub, NotFound, parseRepository } from "../src/intent/github.ts";
import { resolveIntent } from "../src/intent/resolver.ts";
import { JevClient, ProviderError } from "../src/judgments/client.ts";
import { EXIT, ToolError, type IntentSource } from "../src/types.ts";
import { tempRepo } from "./helpers/repo.ts";

const source = (id: string, type: IntentSource["type"], text: string, authority = 90): IntentSource => ({ id, type, authority, text });

test("checklistItems: only items under an acceptance-criteria heading; task lists elsewhere are not intent", () => {
  const issue = ["Users complain.", "", "## Acceptance criteria", "- Disabled users cannot sign in with a password", "- Disabled users cannot sign in through OAuth", "", "## Notes", "- this line is not a criterion at all", "- [ ] Sessions of disabled users are ended at once"].join("\n");
  assert.deepEqual(checklistItems(issue), ["Disabled users cannot sign in with a password", "Disabled users cannot sign in through OAuth"]);
  assert.deepEqual(checklistItems("- [x] I have searched the existing issues for duplicates\n- [x] I am using the latest release\n"), []);
  assert.deepEqual(checklistItems("**Requirements**\n1. Every deletion is written to the audit log\n2. short one\n"), ["Every deletion is written to the audit log", "short one"]);
  assert.deepEqual(checklistItems("Requirements are unclear to me.\n- Nobody knows what happens then\n"), [], "a sentence that starts with the word is not a heading");
  assert.deepEqual(checklistItems("requirements.txt was bumped\n- pinned the parser to a newer version\n"), []);
});

test("compileChecklist is used only when every source lists its criteria; otherwise nothing is left out", () => {
  const spec = compileChecklist([
    source("pr#2", "pr_description", "## Acceptance criteria\n- Something the author claims was done here", 50),
    source("issue#1", "github_issue", "## Acceptance criteria\n- Disabled users cannot sign in anywhere at all"),
  ]);
  assert.deepEqual(spec?.requirements.map((r) => [r.id, r.sourceRefs[0]?.sourceId]), [
    ["R1", "issue#1"],
    ["R2", "pr#2"],
  ]);
  assert.equal(compileChecklist([source("issue#1", "github_issue", "Please make login safer.")]), null);
  // A person wrote a short criterion under the heading on purpose; one word is not checkable, and is said.
  const short = compileChecklist([source("issue#1", "github_issue", "## Acceptance criteria\n- Rate limit logins\n- TBD\n")]);
  assert.deepEqual(short?.requirements.map((r) => r.text), ["Rate limit logins"]);
  assert.match(short?.ambiguities[0]?.text ?? "", /too short to check was left out: TBD/);
  // One source in prose: everything goes to the compiler together.
  assert.equal(compileChecklist([source("issue#1", "github_issue", "## Acceptance criteria\n- Disabled users cannot sign in anywhere at all"), source("cli", "cli", "Disabled users cannot authenticate by any login path.", 100)]), null);
});

test("quoteIsIn ignores case, spacing, Markdown marks and curly quotes, and refuses fragments", () => {
  const text = "## 1. `doctor`'s cannot-verify line packs diagnosis and remedy into ~150 characters";
  assert.ok(quoteIsIn("doctor's cannot-verify line packs diagnosis and remedy", text));
  assert.ok(quoteIsIn("DOCTOR’S   cannot-verify line", text));
  assert.ok(!quoteIsIn("remedy", text), "a single word is not a statement");
  assert.ok(!quoteIsIn("something that is not there", text));
  assert.ok(quoteIsIn("keeps the remediation_hint convention", "It keeps the remediation_hint convention."), "underscores inside words stay");
  assert.ok(isStatement("Disabled users cannot sign in") && !isStatement("kind"));
  // Japanese has no spaces between words; counted by characters instead.
  const ja = "## 要件\n無効化されたユーザーは、どの経路でもログインできないこと。";
  assert.ok(quoteIsIn("無効化されたユーザーは、どの経路でもログインできない", ja));
  assert.ok(isStatement("無効化されたユーザーはログインできない") && !isStatement("ログイン"));
  assert.equal(toSpec({ requirements: [{ text: "無効化されたユーザーはログインできない。", kind: "security", source: "issue#1", quote: "無効化されたユーザーは、どの経路でもログインできない" }] }, [source("issue#1", "github_issue", ja)]).requirements.length, 1);
});

test("toSpec keeps quoted statements and drops the rest into ambiguities", () => {
  const sources = [source("issue#1", "github_issue", "Disabled users must not be able to sign in. Also refresh tokens should stop working for them.")];
  const spec = toSpec(
    {
      requirements: [
        { text: "Disabled users cannot sign in.", kind: "security", source: "issue#1", quote: "Disabled users must not be able to sign in", search_hints: ["disabled", "signIn"] },
        { text: "kind", kind: "behavior", source: "issue#1", quote: "Disabled users must not" },
        { text: "Admins get a new dashboard page.", kind: "behavior", source: "issue#1", quote: "Admins get a dashboard" },
        { text: "Refresh tokens stop working for disabled users.", kind: "vibes", source: "wrong-id", quote: "refresh tokens should stop working for them" },
      ],
      ambiguities: [{ text: "Which sign-in paths count is not said." }],
    },
    sources,
  );
  assert.deepEqual(spec.requirements.map((r) => [r.id, r.kind, r.sourceRefs[0]?.sourceId, r.searchHints]), [
    ["R1", "security", "issue#1", ["disabled", "signIn"]],
    ["R2", "behavior", "issue#1", []],
  ]);
  assert.equal(spec.ambiguities.length, 3);
});

test("readRequirementText takes the record the model wrote into the sentence", () => {
  // All four shapes are from the first real measurement: every one of 38 requirements over ten
  // pull requests came back with its hints in the sentence, and the field left empty, so the
  // search fell back to the sentence's words — `search_hints`, `quote` and `kind` among them.
  const hintsInProse = readRequirementText("Keep stderr output as a single JSON object when a command is blocked, with search hints: stderr, json object, error handling");
  assert.equal(hintsInProse.text, "Keep stderr output as a single JSON object when a command is blocked.");
  assert.deepEqual(hintsInProse.hints, ["stderr", "json object", "error handling"]);

  const fieldNames = readRequirementText("kind: behavior, quote: The refusal is a latch now, search_hints: [refusal, latch], source: pr#557");
  assert.equal(fieldNames.text, "The refusal is a latch now.");
  assert.deepEqual(fieldNames.hints, ["refusal", "latch"]);

  const debris = readRequirementText("The test-isolation-canary fails on a host with omamori installed.', 'search_hints': 'test-isolation-canary omamori installed'}], {");
  assert.equal(debris.text, "The test-isolation-canary fails on a host with omamori installed.");

  // What this tool cut at the requirement limit loses its fragment rather than carrying it into
  // every packet — and only that: the same sentence, if the model simply wrote it without a full
  // stop, keeps every word.
  const cut = readRequirementText("The function should fail the whole listing on the first per-entry error. It should not silently drop entries after the error and re", true);
  assert.equal(cut.text, "The function should fail the whole listing on the first per-entry error.");
  const unpunctuated = readRequirementText("The function should fail the whole listing on the first per-entry error. It should not silently drop entries after the error and re");
  assert.equal(unpunctuated.text, "The function should fail the whole listing on the first per-entry error. It should not silently drop entries after the error and re");
  // A single clause cut at the limit has nowhere to fall back to, and is left open. Closing it
  // with a full stop made `…and instead report an '未` read like a finished requirement — one of
  // these went into a measurement that way.
  const noSentence = readRequirementText("The function should fail the whole listing and not silently drop entries and instead report an '", true);
  assert.equal(noSentence.text, "The function should fail the whole listing and not silently drop entries and instead report an '");

  // A requirement written the way it was asked for is left alone — including one that quotes a
  // list. Cutting at `', '` as though it were a serialized field took two thirds of this away.
  for (const written of [
    "Disabled users cannot authenticate.",
    "The observation mode accepts 'wrappers', 'syscalls' and rejects everything else.",
    "The refusal is a latch. It stays until the file is rewritten",
    "Every deletion is written to the audit log, with the actor and the time.",
  ]) {
    assert.deepEqual(readRequirementText(written), { text: written, hints: [] }, written);
  }
});

test("readModelJson reads either shape the gateway returns, and says when the answer was cut off", () => {
  assert.deepEqual(readModelJson({ result: { response: { requirements: [] } } }), { requirements: [] });
  // A proxy that returns what its own `env.AI.run()` gave it: the same answer without the envelope.
  assert.deepEqual(readModelJson({ response: { requirements: [1] } }), { requirements: [1] });
  assert.deepEqual(readModelJson({ choices: [{ finish_reason: "stop", message: { content: '{"requirements":[2]}' } }] }), { requirements: [2] });
  assert.deepEqual(readModelJson({ result: { choices: [{ finish_reason: "stop", message: { content: '{"requirements":[1]}' } }] } }), { requirements: [1] });
  assert.throws(() => readModelJson({ result: { choices: [{ finish_reason: "length", message: { content: '{"requirements":[' } }] } }), /ran out of room/);
  assert.throws(() => readModelJson({ result: {} }), /no answer text/);
});

function fakeClient(responses: unknown[]) {
  const bodies: unknown[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof globalThis.fetch;
  return { client: new JevClient({ url: "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/ai/run", token: "t", source: "CLOUDFLARE_ACCOUNT_ID" }, { fetch, sleep: async () => {} }), bodies };
}
