import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isStatement, NOT_IN_A_FORM, onlyFromPullRequest, quoteIsIn, readModelJson, readRequirements, readRequirementText, readingBlockers, toSpec, unreadNotOutranked, visibleLines } from "../src/intent/compiler.ts";
import { closingReferences, GitHub, NotFound, parseRepository } from "../src/intent/github.ts";
import { resolveIntent } from "../src/intent/resolver.ts";
import { JevClient, ProviderError } from "../src/judgments/client.ts";
import { EXIT, ToolError, type IntentSource } from "../src/types.ts";
import { tempRepo } from "./helpers/repo.ts";

const source = (id: string, type: IntentSource["type"], text: string, authority = 90): IntentSource => ({ id, type, authority, text });

const texts = (text: string) => readRequirements([source("issue#1", "github_issue", text)]).spec.requirements.map((r) => r.text);

test("a requirements section: only items under its heading; task lists elsewhere are not intent", () => {
  const issue = ["Users complain.", "", "## Acceptance criteria", "- Disabled users cannot sign in with a password", "- Disabled users cannot sign in through OAuth", "", "## Notes", "- this line is not a criterion at all", "- [ ] Sessions of disabled users are ended at once"].join("\n");
  assert.deepEqual(texts(issue), ["Disabled users cannot sign in with a password", "Disabled users cannot sign in through OAuth"]);
  assert.deepEqual(texts("- [x] I have searched the existing issues for duplicates\n- [x] I am using the latest release\n"), []);
  assert.deepEqual(texts("**Requirements**\n1. Every deletion is written to the audit log\n2. two words\n"), ["Every deletion is written to the audit log", "two words"]);
  assert.deepEqual(texts("Requirements are unclear to me.\n- Nobody knows what happens then\n"), [], "a sentence that starts with the word is not a heading");
  assert.deepEqual(texts("requirements.txt was bumped\n- pinned the parser to a newer version\n"), []);
  // `Acceptance` on its own is a heading too, and a lead-in before the list does not end the section.
  assert.deepEqual(texts("## Acceptance\n\nPin one target for which:\n\n1. the default mode ends UNKNOWN\n2. the other mode reaches the same verdict\n"), ["the default mode ends UNKNOWN", "the other mode reaches the same verdict"]);
});

test("an item wrapped onto several lines is one item, and the items after it are not lost", () => {
  const wrapped = "## Acceptance criteria\n- Disabled users cannot sign in with a password,\n  even through the legacy form.\n- Disabled users cannot sign in through OAuth\nwhen the provider still says they may.\n- Sessions of disabled users end at once\n";
  assert.deepEqual(texts(wrapped), [
    "Disabled users cannot sign in with a password, even through the legacy form.",
    "Disabled users cannot sign in through OAuth when the provider still says they may.",
    "Sessions of disabled users end at once",
  ]);
  // CRLF, as an issue written in the web interface arrives.
  assert.deepEqual(texts(wrapped.replace(/\n/g, "\r\n")), texts(wrapped));
  // A nested item is an item of its own; a blank line ends an item, and a paragraph after the list ends the section.
  assert.deepEqual(texts("## Done when\n- The first thing holds\n  - A nested detail holds\n\n- The second thing holds\n\nSome closing remark here.\n- Not a criterion at all\n"), ["The first thing holds", "A nested detail holds", "The second thing holds"]);
});

test("each source is read on its own: a list is read even when another source is prose, and the prose one is named", () => {
  const reading = readRequirements([
    source("pr#2", "pr_description", "## Acceptance criteria\n- Something the author claims was done here", 50),
    source("issue#1", "github_issue", "## Acceptance criteria\n- Disabled users cannot sign in anywhere at all"),
    source("issue#3", "github_issue", "Please make login safer."),
  ]);
  assert.deepEqual(reading.spec.requirements.map((r) => [r.id, r.sourceRefs[0]?.sourceId]), [
    ["R1", "issue#1"],
    ["R2", "pr#2"],
  ]);
  assert.deepEqual(reading.unread.map((u) => u.sourceId), ["issue#3"]);
  assert.match(reading.spec.ambiguities[0]?.text ?? "", /^issue#3 was not read as requirements: no requirements section .* and no Property: paragraph\.$/);
  const prose = readRequirements([source("issue#1", "github_issue", "Please make login safer.")]);
  assert.deepEqual(prose.spec.requirements, []);
  assert.equal(prose.unread.length, 1);
  // A person wrote a short criterion under the heading on purpose; one word is not checkable, and is said.
  const short = readRequirements([source("issue#1", "github_issue", "## Acceptance criteria\n- Rate limit logins\n- TBD\n")]);
  assert.deepEqual(short.spec.requirements.map((r) => r.text), ["Rate limit logins"]);
  assert.match(short.spec.ambiguities[0]?.text ?? "", /too short to check was left out: TBD/);
  // A heading with nothing under it is said as such.
  assert.match(readRequirements([source("issue#1", "github_issue", "## Acceptance criteria\n\nSee the design doc.\n")]).unread[0]?.reason ?? "", /lists no items/);
});

test("a requirement over the length limit is left out and said to be, never cut", () => {
  const long = `Property: ${"The listing reports every entry it could not read by name. ".repeat(12)}`;
  const reading = readRequirements([source("pr#2", "pr_description", long, 50)]);
  assert.deepEqual(reading.spec.requirements, []);
  assert.match(reading.spec.ambiguities.map((a) => a.text).join("\n"), /A requirement of \d+ characters, over the limit of 600, was left out rather than cut/);
  assert.match(reading.unread[0]?.reason ?? "", /left out/);
});

test("past the first twenty, the rest are named by source; the issue's come first", () => {
  const items = (n: number, what: string) => `## Acceptance criteria\n${Array.from({ length: n }, (_, i) => `- ${what} number ${i + 1} holds`).join("\n")}\n`;
  const reading = readRequirements([source("pr#2", "pr_description", items(15, "The claim"), 50), source("issue#1", "github_issue", items(10, "The requirement"))]);
  assert.equal(reading.spec.requirements.length, 20);
  assert.equal(reading.spec.requirements.filter((r) => r.sourceRefs[0]?.sourceId === "issue#1").length, 10);
  assert.match(reading.spec.ambiguities.map((a) => a.text).join("\n"), /5 requirements beyond the first 20 were not checked: 5 from pr#2/);
});

test("where the requirements came from: only the pull request's description, and an issue left unread above it", () => {
  const sources = [source("issue#1", "github_issue", "Please make login safer."), source("pr#2", "pr_description", "Property: disabled users cannot sign in by any path.", 50)];
  const reading = readRequirements(sources);
  assert.ok(onlyFromPullRequest(reading.spec, sources));
  assert.deepEqual(unreadNotOutranked(reading, sources).map((u) => u.sourceId), ["issue#1"]);
  const both = [source("issue#1", "github_issue", "## Acceptance\n- Disabled users cannot sign in"), sources[1] as IntentSource];
  const fromBoth = readRequirements(both);
  assert.ok(!onlyFromPullRequest(fromBoth.spec, both));
  assert.deepEqual(unreadNotOutranked(fromBoth, both), []);
  // Nothing read: nothing outranks anything, and nothing is "only from the pull request".
  const none = readRequirements([sources[0] as IntentSource]);
  assert.ok(!onlyFromPullRequest(none.spec, [sources[0] as IntentSource]));
  assert.deepEqual(unreadNotOutranked(none, [sources[0] as IntentSource]), []);
});

test("visibleLines blanks what a reader of the page does not see, and joins what a comment ran across", () => {
  const text = "a\n<!-- one\ntwo -->\n```\ncode\n```\n[1]: https://example.com\nb <!-- hidden --> c\nd <!-- across\nlines --> e\n\n[^1]: https://example.com/a-footnote-is-shown\n\n[Note]: this is a sentence, shown\n~~~~\nunclosed";
  assert.deepEqual(visibleLines(text), ["a", "", "", "", "", "", "b  c", "d  e", "", "[^1]: https://example.com/a-footnote-is-shown", "", "[Note]: this is a sentence, shown", "", ""]);
  // A code span runs onto the next lines of its paragraph, not past it.
  assert.deepEqual(visibleLines("- a `span start\n  <!-- inside --> span end` here"), ["- a `span start", "  <!-- inside --> span end` here"]);
  assert.deepEqual(visibleLines("a `open\n\n<!-- hidden -->\nb`"), ["a `open", "", "", "b`"]);
  // A code block in a quotation closes at its own fence, and the quotation goes on.
  assert.deepEqual(visibleLines("> ```\n> code\n> ```\n> after the block"), ["", "", "", "> after the block"]);
});

test("the issues a pull request's text closes, without a token: another repository's named, and none from what the page hides", () => {
  const repo = { owner: "o", name: "r" };
  assert.deepEqual(closingReferences("Fixes #12, closes O/R#13 and resolves attacker/evil#5.", repo), { numbers: [12, 13], foreign: ["attacker/evil#5"] });
  assert.deepEqual(closingReferences("<!-- Fixes #40 -->\n```\nfixes #41\n```\nNothing else.", repo), { numbers: [], foreign: [] });
  // A code block quoted in a reply ends with the quotation; what follows is read.
  assert.deepEqual(closingReferences("> ```\n> log\n> ```\n\nFixes #7", repo), { numbers: [7], foreign: [] });
});

test("without a token, the repository's own issues are its own under the name GitHub gives it", async () => {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const body = String(url).endsWith("/pulls/9")
      ? { number: 9, title: "t", body: "Fixes O/renamed#5", html_url: "u", user: { login: "dev" }, base: { ref: "main", sha: "a", repo: { full_name: "O/renamed" } }, head: { sha: "b" } }
      : { number: 5, title: "t", body: "## Acceptance\n- it holds", html_url: "u", user: { login: "dev" } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  const pr = await new GitHub({ fetch }).pullRequest({ owner: "o", name: "old-name" }, 9);
  assert.deepEqual(pr.issues.map((i) => i.number), [5]);
  assert.equal(pr.foreignIssues, undefined);
});

test("reading that leaves intent unchecked blocks a review: as high as what was read and unread, or past the first twenty", () => {
  const two = [source("issue#1", "github_issue", "## Acceptance\n- Disabled users cannot sign in"), source("issue#2", "github_issue", "Please also make logins safer.")];
  assert.deepEqual(readingBlockers(readRequirements(two), two), ["issue#2, which no source that was read outranks, was not read as requirements (" + NOT_IN_A_FORM + ")"]);
  // A lower source unread blocks nothing: the issue was read, the pull request's prose was not.
  const lower = [two[0] as IntentSource, source("pr#3", "pr_description", "This PR tidies things up.", 50)];
  assert.deepEqual(readingBlockers(readRequirements(lower), lower), []);
  const many = [source("issue#1", "github_issue", `## Acceptance\n${Array.from({ length: 22 }, (_, i) => `- Requirement number ${i + 1} holds`).join("\n")}`)];
  assert.deepEqual(readingBlockers(readRequirements(many), many), ["2 requirement(s) from issue#1 were read past the first 20 and not checked"]);
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
  return { client: new JevClient({ url: "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/ai/run", token: "t", host: "cloudflare" }, { fetch, sleep: async () => {} }), bodies };
}

test("an issue in another repository that the pull request closes is named, not read as this repository's", async () => {
  const node = (number: number, repository: string, body: string) => ({ number, title: "t", body, url: "u", author: { login: "someone" }, repository: { nameWithOwner: repository } });
  const fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: 9, title: "t", body: "Fixes #5, fixes attacker/evil#5", url: "u", author: { login: "dev" }, baseRefName: "main", baseRefOid: "a", headRefOid: "b",
              closingIssuesReferences: { nodes: [node(5, "O/R", "## Acceptance\n- the real requirement holds"), node(5, "attacker/evil", "## Acceptance\n- a requirement someone else wrote")] },
            },
          },
        },
      }),
      { status: 200 },
    )) as typeof globalThis.fetch;
  const github = new GitHub({ token: "t", fetch });
  const pr = await github.pullRequest({ owner: "o", name: "r" }, 9);
  assert.deepEqual(pr.issues.map((i) => i.body), ["## Acceptance\n- the real requirement holds"]);
  assert.deepEqual(pr.foreignIssues, ["attacker/evil#5"]);
  const resolved = await resolveIntent({ pr: 9, repo: { owner: "o", name: "r" } }, { github: async () => github, includePrDescription: true, preferIssue: true });
  assert.deepEqual(resolved.sources.map((s) => s.id), ["issue#5", "pr#9"]);
  assert.match(resolved.notes.join("\n"), /closes attacker\/evil#5, an issue in another repository; it was not read/);
});

test("the repository's own issues are its own under the name GitHub gives it, and issues past the ten listed are counted", async () => {
  // A clone whose remote still has the name from before a rename: GitHub answers under the new one.
  const fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          repository: {
            nameWithOwner: "O/renamed",
            pullRequest: {
              number: 9, title: "t", body: "b", url: "u", author: { login: "dev" }, baseRefName: "main", baseRefOid: "a", headRefOid: "b",
              closingIssuesReferences: { totalCount: 12, nodes: [5, 6].map((number) => ({ number, title: "t", body: "## Acceptance\n- it holds", url: "u", author: { login: "dev" }, repository: { nameWithOwner: "O/renamed" } })) },
            },
          },
        },
      }),
      { status: 200 },
    )) as typeof globalThis.fetch;
  const pr = await new GitHub({ token: "t", fetch }).pullRequest({ owner: "o", name: "old-name" }, 9);
  assert.deepEqual(pr.issues.map((i) => i.number), [5, 6]);
  assert.equal(pr.foreignIssues, undefined);
  assert.equal(pr.issuesNotListed, 10);
  const resolved = await resolveIntent({ pr: 9, repo: { owner: "o", name: "old-name" } }, { github: async () => new GitHub({ token: "t", fetch }), includePrDescription: true, preferIssue: true });
  assert.match(resolved.notes.join("\n"), /closes 10 more issue\(s\) than GitHub listed \(the first 10\); they were not read/);
});
