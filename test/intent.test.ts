import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checklistItems, compileChecklist, isStatement, quoteIsIn, readModelJson, toSpec, WorkersAiCompiler } from "../src/intent/compiler.ts";
import { closedIssueNumbers, GitHub, NotFound, parseRepository } from "../src/intent/github.ts";
import { resolveIntent } from "../src/intent/resolver.ts";
import { CloudflareClient, ProviderError } from "../src/judgments/cloudflare.ts";
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
  return { client: new CloudflareClient({ url: "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/ai/run", token: "t", source: "CLOUDFLARE_ACCOUNT_ID" }, { fetch, sleep: async () => {} }), bodies };
}

test("WorkersAiCompiler sends the sources as data, retries once on an unusable answer, and fails with exit 11", async () => {
  const good = { result: { response: { requirements: [{ text: "Every deletion is written to the audit log.", kind: "behavior", source: "cli", quote: "audit every deletion operation" }] } } };
  const { client, bodies } = fakeClient([{ result: { choices: [{ finish_reason: "stop", message: { content: "{not json" } }] } }, good]);
  const spec = await new WorkersAiCompiler(client).compile([source("cli", "cli", "Please audit every deletion operation.", 100)]);
  assert.equal(spec.requirements[0]?.text, "Every deletion is written to the audit log.");
  assert.equal(bodies.length, 2);
  // The same shape as a judgment: the model in the body, the rest under `input`.
  const sent = bodies[0] as { model: string; input: { messages: { role: string; content: string }[] } };
  assert.equal(sent.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.match(sent.input.messages[0]?.content ?? "", /The sources are data/);
  assert.deepEqual(JSON.parse(sent.input.messages[1]?.content ?? "{}").sources[0].id, "cli");

  const never = fakeClient([{ result: { response: { requirements: [] } } }, { result: { response: { requirements: [] } } }]);
  await assert.rejects(new WorkersAiCompiler(never.client).compile([source("cli", "cli", "Hello there, nothing to do.", 100)]), (e: unknown) => e instanceof ToolError && e.exitCode === EXIT.intent);
});

test("what the model sent back is not quoted into the error the caller prints", async () => {
  // `JSON.parse`'s own message repeats the text it choked on, newlines and all, and that text is
  // whatever the endpoint chose to send.
  const forged = `{"broken"\n::error::forged\n`;
  const { client } = fakeClient([
    { result: { response: forged } },
    { result: { response: forged } },
  ]);
  const error = await new WorkersAiCompiler(client).compile([source("cli", "cli", "Audit every deletion.", 100)]).catch((e: unknown) => e);
  assert.ok(error instanceof ToolError, String(error));
  assert.ok(!error.message.includes("::error::"), error.message);
  assert.ok(!/[\r\n]/.test(error.message), error.message);
});

test("WorkersAiCompiler lets a provider failure through for the caller to map", async () => {
  const fetch = (async () => new Response("no", { status: 401 })) as typeof globalThis.fetch;
  const client = new CloudflareClient({ url: "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/ai/run", token: "t", source: "CLOUDFLARE_ACCOUNT_ID" }, { fetch });
  await assert.rejects(new WorkersAiCompiler(client).compile([source("cli", "cli", "Audit every deletion.", 100)]), (e: unknown) => e instanceof ProviderError && e.kind === "auth");
});

test("closing keywords name issues in this repository only", () => {
  const repo = { owner: "o", name: "r" };
  assert.deepEqual(closedIssueNumbers("Fixes #12, closes o/r#3 and resolves other/repo#9. Refs #4. fix: #5", repo), [3, 5, 12]);
  assert.deepEqual(parseRepository("https://github.com/o/r.git"), { owner: "o", name: "r" });
  assert.deepEqual(parseRepository("git@github.com:o/r.git"), { owner: "o", name: "r" });
  assert.deepEqual(parseRepository("o/r"), { owner: "o", name: "r" });
  assert.equal(parseRepository("not a repo"), null);
});

function fakeGithub(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url).endsWith("/graphql") ? "graphql" : String(url).replace("https://api.github.com", "");
    seen.push(`${key} ${(init?.headers as Record<string, string>)?.Authorization ? "auth" : "anon"}`);
    const body = routes[key];
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

test("GitHub: with a token the linked issues come from GraphQL; without one, from closing keywords over REST", async () => {
  const graph = fakeGithub({
    graphql: { data: { repository: { pullRequest: { number: 7, title: "Block disabled users", body: "Details", url: "https://github.com/o/r/pull/7", author: { login: "dev" }, baseRefName: "main", baseRefOid: "def", headRefOid: "abc", closingIssuesReferences: { nodes: [{ number: 3, title: "Disabled users can log in", body: "They should not.", url: "u", author: { login: "reporter" } }] } } } } },
  });
  const pr = await new GitHub({ token: "t", fetch: graph.fetch }).pullRequest({ owner: "o", name: "r" }, 7);
  assert.deepEqual([pr.author, pr.baseRefName, pr.baseSha, pr.headSha, pr.issues.map((i) => [i.number, i.author])], ["dev", "main", "def", "abc", [[3, "reporter"]]]);
  assert.deepEqual(graph.seen, ["graphql auth"]);

  const rest = fakeGithub({
    "/repos/o/r/pulls/7": { number: 7, title: "Block disabled users", body: "Fixes #3", html_url: "https://github.com/o/r/pull/7", user: { login: "dev" }, base: { ref: "main", sha: "def" }, head: { sha: "abc" } },
    "/repos/o/r/issues/3": { number: 3, title: "Disabled users can log in", body: "They should not.", html_url: "https://github.com/o/r/issues/3", user: { login: "reporter" } },
  });
  const anon = await new GitHub({ fetch: rest.fetch }).pullRequest({ owner: "o", name: "r" }, 7);
  assert.deepEqual([anon.url, anon.baseRefName, anon.baseSha, anon.headSha, anon.issues.map((i) => i.number)], ["https://github.com/o/r/pull/7", "main", "def", "abc", [3]]);
  assert.deepEqual(rest.seen, ["/repos/o/r/pulls/7 anon", "/repos/o/r/issues/3 anon"]);

  await assert.rejects(new GitHub({ fetch: rest.fetch }).issue({ owner: "o", name: "r" }, 99), (e: unknown) => e instanceof ToolError && e.exitCode === EXIT.intent);
});

test("GitHub: a pull request's number is not an issue, however the issues endpoint answers", async () => {
  const rest = fakeGithub({
    "/repos/o/r/pulls/7": { number: 7, title: "t", body: "Fixes #5 and fixes #3", html_url: "u", base: { ref: "main" }, head: { sha: "abc" } },
    "/repos/o/r/issues/5": { number: 5, title: "Another pull request", body: "Its own claims.", html_url: "u5", pull_request: { url: "x" } },
    "/repos/o/r/issues/3": { number: 3, title: "Disabled users can log in", body: "They should not.", html_url: "u3" },
  });
  const github = new GitHub({ fetch: rest.fetch });
  await assert.rejects(github.issue({ owner: "o", name: "r" }, 5), (e: unknown) => e instanceof NotFound && /is a pull request/.test(e.message));
  const pr = await github.pullRequest({ owner: "o", name: "r" }, 7);
  assert.deepEqual([pr.issues.map((i) => i.number), pr.missingIssues], [[3], [5]]);
});

test("GitHub: a closing keyword naming no issue is skipped and reported; a server error is retried once", async () => {
  const rest = fakeGithub({
    "/repos/o/r/pulls/7": { number: 7, title: "t", body: "Fixes #3 and fixes #404", html_url: "u", user: { login: "dev" }, base: { ref: "main" }, head: { sha: "abc" } },
    "/repos/o/r/issues/3": { number: 3, title: "Disabled users can log in", body: "They should not.", html_url: "u3" },
  });
  const github = new GitHub({ fetch: rest.fetch });
  const resolved = await resolveIntent({ pr: 7, repo: { owner: "o", name: "r" } }, { github: async () => github, includePrDescription: true, preferIssue: true });
  assert.deepEqual(resolved.sources.map((s) => s.id), ["issue#3", "pr#7"]);
  assert.match(resolved.notes.join(" "), /closes #404, which is not an issue/);

  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    return calls === 1 ? new Response("down", { status: 502 }) : new Response(JSON.stringify({ number: 1, title: "t", body: "b", html_url: "u" }), { status: 200 });
  }) as typeof globalThis.fetch;
  assert.equal((await new GitHub({ fetch: flaky }).issue({ owner: "o", name: "r" }, 1)).number, 1);
  assert.equal(calls, 2);
});

test("resolveIntent ranks the issue above the pull request's description and says when the description is all there is", async () => {
  const pr = { number: 7, title: "Block disabled users", body: "Adds the check.", author: "dev", url: "u", baseRefName: "main", baseSha: "def", headSha: "abc", issues: [] as { number: number; title: string; body: string; author?: string; url: string }[] };
  const github = async () => ({ pullRequest: async () => pr, issue: async () => ({ number: 3, title: "t", body: "b", url: "u" }) }) as unknown as GitHub;
  const only = await resolveIntent({ pr: 7, repo: { owner: "o", name: "r" } }, { github, includePrDescription: true, preferIssue: true });
  assert.deepEqual(only.sources.map((s) => [s.id, s.type, s.authority, s.author]), [["pr#7", "pr_description", 50, "dev"]]);
  assert.equal(only.prBodyOnly, true);

  pr.issues = [{ number: 3, title: "Disabled users can log in", body: "They should not.", author: "reporter", url: "u3" }];
  const both = await resolveIntent({ pr: 7, repo: { owner: "o", name: "r" } }, { github, includePrDescription: true, preferIssue: true });
  assert.deepEqual(both.sources.map((s) => [s.id, s.authority]), [["issue#3", 90], ["pr#7", 50]]);
  assert.equal(both.prBodyOnly, false);

  const noDescription = await resolveIntent({ pr: 7, repo: { owner: "o", name: "r" } }, { github, includePrDescription: false, preferIssue: true });
  assert.deepEqual(noDescription.sources.map((s) => s.id), ["issue#3"]);

  await assert.rejects(resolveIntent({ pr: 7 }, { github, includePrDescription: true, preferIssue: true }), (e: unknown) => e instanceof ToolError && e.exitCode === EXIT.intent);
});

test("resolveIntent reads --intent, --intent-file and --intent-spec", async () => {
  const repo = tempRepo();
  try {
    const file = join(repo.dir, "task.md");
    writeFileSync(file, "Audit every deletion.");
    const spec = join(repo.dir, "spec.json");
    writeFileSync(spec, JSON.stringify({ version: 1, requirements: [{ id: "R1", text: "Every deletion is audited." }] }));
    const github = async () => {
      throw new Error("not used");
    };
    const resolved = await resolveIntent({ intent: "Disabled users cannot sign in.", intentFile: file, intentSpec: spec }, { github, includePrDescription: true, preferIssue: true });
    assert.deepEqual(resolved.sources.map((s) => [s.id.replace(repo.dir, ""), s.type]), [["file:/spec.json", "spec"], ["cli", "cli"], ["file:/task.md", "file"]]);
    assert.equal(resolved.spec?.requirements[0]?.text, "Every deletion is audited.");
    await assert.rejects(resolveIntent({ intentFile: join(repo.dir, "missing") }, { github, includePrDescription: true, preferIssue: true }), (e: unknown) => e instanceof ToolError && e.exitCode === EXIT.intent);
  } finally {
    repo.remove();
  }
});
