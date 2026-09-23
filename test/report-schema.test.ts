import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseIntentSpec, validateIntentSpec } from "../src/intent/schema.ts";
import { codeBlock, codeSpan, renderJson, renderMarkdown, resultKind } from "../src/report/markdown.ts";
import { EXIT, ToolError } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { FIXTURES } from "./helpers/repo.ts";
import { localCheckResult, report } from "./helpers/reports.ts";

test("codeSpan cannot be broken out of, whatever the text holds", () => {
  assert.equal(codeSpan("plain"), "`plain`");
  assert.equal(codeSpan("a`b"), "``a`b``");
  assert.equal(codeSpan("`edge`"), "`` `edge` ``");
  assert.equal(codeSpan("two\nlines"), "`two lines`");
  assert.equal(codeSpan(""), "`(empty)`");
  const hostile = "x``` ](https://evil.example)<img src=x>";
  const span = codeSpan(hostile);
  const fence = span.match(/^`+/)?.[0] ?? "";
  assert.ok(fence.length > 3 && span.endsWith(fence) && !hostile.includes(fence));
});

test("codeBlock uses a fence longer than any inside the text", () => {
  assert.equal(codeBlock("a"), "```\na\n```");
  assert.equal(codeBlock("x\n```\ny"), "````\nx\n```\ny\n````");
});

test("code spans and blocks survive text with 200,000 backtick runs", () => {
  const text = "`a".repeat(200_000);
  assert.ok(codeSpan(text).startsWith("``"));
  assert.ok(codeBlock(text).startsWith("```\n"));
});

/** One requirement as the local check reports it: one call worth checking, one holding, one held. */
test("the Markdown report leads with a result line drawn from the counts alone, and states no verdict", () => {
  const text = renderMarkdown(report());
  assert.match(text, /^# jev-intent-review\n\n\*\*Result: 1 call worth checking of 2 read\.\*\* No requirement verdict is stated\./);
  assert.match(renderMarkdown(report({ skipReason: "No credentials." })), /\*\*Result: skipped\.\*\* No credentials\./);
  assert.match(renderMarkdown(report({ requirements: [] })), /\*\*Result: nothing was checked\.\*\*/);
  const unread = { ...localCheckResult(), observed: [], findings: [], mappings: [], counts: { ...localCheckResult().counts, asked: 0, mapped: 0, governed: 0, outcomes: { violates: 0, satisfies: 0, unknown: 0, aside: 0 } } };
  assert.match(renderMarkdown(report({ requirements: [unread] })), /\*\*Result: no call was read\.\*\* 1 call not checked/);
  // The set built and nothing sent: the budgeted calls are not under "Not checked", and the report
  // says the run stopped. A finished run whose budgeted call was held before its question (a body
  // that did not fit) has that call under "Not checked", and is not read as a run that stopped.
  const inBudget = { file: "src/auth.rs", function: "open_session", call: "create_session(store, &record)", origin: "changed" as const };
  const stopped = { ...unread, wouldAsk: [inBudget] };
  assert.match(renderMarkdown(report({ requirements: [stopped], sent: { requests: 0, bytes: 0, answered: 0, reused: 0, reusedFromEarlierRuns: 0 } })), /\*\*Result: the set was built and nothing was asked\.\*\* 1 call inside the budget, 1 call not checked/);
  const heldLate = { ...stopped, unchecked: [...unread.unchecked, { ...inBudget, why: "the body of open_session did not fit the evidence limit, so an answer would be about part of it" }] };
  assert.match(renderMarkdown(report({ requirements: [heldLate], sent: { requests: 0, bytes: 0, answered: 0, reused: 0, reusedFromEarlierRuns: 0 } })), /\*\*Result: no call was read\.\*\* 2 calls not checked/);
  for (const word of ["VERIFIED", "VIOLATION", "UNKNOWN", "verdict:"]) assert.ok(!text.includes(word), `${word} is not in the report`);
  assert.ok(!/violat/i.test(text.replace(/`[^`]*`/g, "")), "no verdict word of the tool's own outside a code span");
});

test("the Markdown report shows each requirement's calls: worth checking with everything to disagree with, holding, and not checked", () => {
  const text = renderMarkdown(report());
  assert.match(text, /## R1\n\n> `Disabled users cannot authenticate\.`\n\nForm: `failure_propagation` \(named in the spec\)\./);
  assert.match(text, /Of the 2 read: 1 worth checking, 1 holding, 0 not settled, 0 not required of\./);
  assert.match(text, /### Worth checking\n\n#### src\/auth\.rs:16-23 · open_session — `create_session\(store, &record\)`/);
  assert.match(text, /\*\*Jev, on what the function returns\*\*: returns_success \(0\.61\)/);
  assert.match(text, /### Read as holding\n\n[^\n]*\n\n- src\/auth\.rs · open_session — `load_key\(store, key\)`/);
  assert.match(text, /### Not checked\n\n- src\/auth\.rs · open_session — `audit\(store\)`/);
  assert.ok(!text.includes("<img"), "notes cannot carry HTML");
  assert.match(text, /&lt;img src=x&gt;/);
  assert.match(text, /- 4 requests, 4 answers, 12,345 bytes/);
});

test("the sent line says how many answers were reused and how many of those an earlier run kept, and a run answered from them all is not 'Nothing was asked'", () => {
  const base = report();
  const reused = report({ sent: { ...base.sent, requests: 1, answered: 1, reused: 3, reusedFromEarlierRuns: 2 } });
  assert.match(renderMarkdown(reused), /- 1 request, 1 answer, 3 answers reused \(2 kept from earlier runs, the rest repeats within this one\), /);
  assert.ok(!/reused/.test(renderMarkdown(base)), "nothing reused, nothing said");
  // Every request answered from kept answers: nothing was sent, and the run still read its calls.
  const allKept = report({ sent: { ...base.sent, requests: 0, answered: 0, reused: 4, reusedFromEarlierRuns: 4 } });
  const none = report({ sent: { ...base.sent, requests: 0, answered: 0, reused: 0, reusedFromEarlierRuns: 0 }, requirements: [{ ...base.requirements[0]!, wouldAsk: [{ file: "src/auth.rs", function: "open_session", call: "load_key(store, key)" } as never] }] });
  assert.notEqual(resultKind(allKept).kind, "nothing_asked");
  assert.equal(resultKind({ ...allKept, requirements: none.requirements }).kind === "nothing_asked", false, "reused answers count as asked");
  assert.equal(resultKind(none).kind, "nothing_asked", "the control: with nothing sent and nothing reused it is");
});

test("the report names the endpoint and its host, and says so at the top when it was set by JEV_API_URL", () => {
  const plain = renderMarkdown(report());
  assert.ok(!plain.includes("Endpoint:"), "nothing to say when the run did not record one");

  // The three named hosts are equals: each is named, none is warned about.
  for (const [host, endpoint, name] of [
    ["cloudflare", "https://api.cloudflare.com", "Cloudflare Workers AI"],
    ["typesafe", "https://api.typesafe.ai", "TypeSafe"],
    ["vercel", "https://ai-gateway.vercel.sh", "Vercel AI Gateway"],
  ] as const) {
    const text = renderMarkdown(report({ sent: { ...report().sent, endpoint, host } }));
    assert.ok(text.includes(`- Endpoint: \`${endpoint}\` (${name})`), text);
    assert.ok(!text.includes("Judged by"), `${host} needs no warning`);
  }

  // Whoever answers the judgments decides the verdict, so an endpoint the user pointed at by URL is
  // named up front — decided by how it was chosen, so a URL on Cloudflare's own origin still is.
  for (const endpoint of ["https://judge.example.com", "https://api.cloudflare.com"]) {
    const other = renderMarkdown(report({ sent: { ...report().sent, endpoint, host: "custom" } }));
    assert.ok(other.includes(`Judged by \`${endpoint}\`, an endpoint set by JEV_API_URL`), other);
  }
});

test("a note cannot become a link, whatever the text in it came from", () => {
  const withLink = report({ requirements: [{ ...report().requirements[0]!, notes: ["judgment failed: [click here](http://example.com/x)"] }] });
  const text = renderMarkdown(withLink);
  assert.ok(!text.includes("[click here](http://example.com/x)"), text.slice(0, 300));
  assert.match(text, /\\\[click here\\\]/);

  // A bare address is a link on GitHub with no brackets at all; as a code span it is not.
  const bare = report({ requirements: [{ ...report().requirements[0]!, notes: ["judgment failed: see http://example.com/x for why"] }] });
  assert.match(renderMarkdown(bare), /see `http:\/\/example\.com\/x` for why/);
});

test("renderJson is the report itself", () => {
  assert.deepEqual(JSON.parse(renderJson(report())), report());
});

function intentError(value: unknown): ToolError {
  try {
    validateIntentSpec(value, "spec.json");
  } catch (error) {
    assert.ok(error instanceof ToolError);
    assert.equal(error.exitCode, EXIT.intent);
    return error;
  }
  assert.fail("expected an intent error");
}

test("an IntentSpec gets defaults for what it leaves out", () => {
  const spec = validateIntentSpec({ version: 1, requirements: [{ id: "R1", text: "Do the thing." }] }, "s");
  assert.deepEqual(spec, {
    version: 1,
    title: "",
    summary: "",
    requirements: [{ id: "R1", text: "Do the thing.", kind: "behavior", priority: "required", sourceRefs: [], searchHints: [] }],
    nonGoals: [],
    ambiguities: [],
  });
});

test("an IntentSpec with unknown fields, repeated ids, bad values or too-long text is refused", () => {
  const r = (extra: object) => ({ version: 1, requirements: [{ id: "R1", text: "x", ...extra }] });
  intentError({ version: 2, requirements: [] });
  intentError(r({ severity: "high" }));
  intentError(r({ kind: "vibes" }));
  intentError(r({ text: "x".repeat(601) }));
  intentError(r({ id: "1bad" }));
  intentError({ version: 1, requirements: [{ id: "R1", text: "a" }, { id: "R1", text: "b" }] });
  intentError({ version: 1, requirements: "R1" });
  assert.throws(() => parseIntentSpec("{", "s"), ToolError);
});

test("the missed-path fixture's spec is a valid IntentSpec", () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, "missed-path", "fixture.json"), "utf8"));
  assert.equal(validateIntentSpec(fixture.spec, "fixture").requirements[0]?.id, "R1");
});

test("the report names a requirement's source as the pull request author's from the metadata, not only from the description", () => {
  const base = report();
  const withRefs = { ...base.intent, requirements: base.intent.requirements.map((r) => ({ ...r, sourceRefs: [{ sourceId: "issue#1", quote: r.text }] })) };
  const own = renderMarkdown(report({ intent: withRefs, metadata: { ...base.metadata, pullRequestAuthor: "alice" } }));
  assert.match(own, /R1 read from `issue#1` \(an issue, by `alice`, the pull request's author\): `Disabled users cannot authenticate\.`/);
  assert.doesNotMatch(renderMarkdown(report({ intent: withRefs })), /the pull request's author/);
});

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
});
