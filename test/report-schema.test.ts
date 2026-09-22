import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseIntentSpec, validateIntentSpec } from "../src/intent/schema.ts";
import { codeBlock, codeSpan, renderJson, renderMarkdown } from "../src/report/markdown.ts";
import type { LocalCheckResult } from "../src/review/local-check-run.ts";
import { EXIT, ToolError, type ReviewReport } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { FIXTURES } from "./helpers/repo.ts";

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
function localCheckResult(): LocalCheckResult {
  const mapping = (callId: string, verdict: "applies" | "does_not_apply", probability: number) => ({
    requirementId: "R1",
    callId,
    file: "src/auth.rs",
    function: "open_session",
    call: callId,
    verdict,
    probability,
    probabilities: { [verdict]: probability },
    governs: verdict === "applies" && probability >= 0.6,
    why: verdict === "applies" ? `the requirement is read as requiring this of the call (${probability.toFixed(2)})` : `read as \`${verdict}\` (${probability.toFixed(2)}), which is below the bar of 0.6 or not a requirement of this call`,
  });
  const observed = (callId: string, observation: string, probability: number, outcome: "violates" | "satisfies") => ({
    file: "src/auth.rs",
    function: "open_session",
    call: callId,
    origin: "changed" as const,
    callId,
    result: { observation, probability, probabilities: { [observation]: probability }, why: observation === "returns_success" ? "the failed call is returned to the caller as a success" : "the failed call is not returned as a success" },
    outcome,
  });
  return {
    requirementId: "R1",
    requirementText: "Disabled users cannot authenticate.",
    form: "failure_propagation",
    wouldAsk: [],
    observed: [observed("create_session(store, &record)", "returns_success", 0.61, "violates"), observed("load_key(store, key)", "returns_error", 0.99, "satisfies")],
    unchecked: [{ file: "src/auth.rs", function: "open_session", call: "audit(store)", origin: "changed", why: "audit has no definition in this repository, so what it returns is not established here" }],
    mappings: [mapping("create_session(store, &record)", "applies", 0.9), mapping("load_key(store, key)", "applies", 0.8)],
    findings: [
      {
        requirementId: "R1",
        file: "src/auth.rs",
        lines: "16-23",
        function: "open_session",
        call: "create_session(store, &record)",
        quote: "Disabled users cannot authenticate.",
        condition: "Execution reaches the call `create_session(store, &record)` inside `open_session`. There, `create_session(store, &record)` returns an error. Every other operation the function reaches succeeds.",
        property: "call_failure_not_returned_as_success",
        mapping: { verdict: "applies", probability: 0.9, probabilities: { applies: 0.9 }, governs: true },
        observation: "returns_success",
        probability: 0.61,
        why: "Jev answered `applies` (0.90) when asked whether the requirement requires this call's failure not to reach the caller as a success, and `returns_success` (0.61) when asked what `open_session` returns under that failure. Both are Jev's readings and neither checks the other.",
      },
    ],
    counts: { budget: 20, functions: { changed: 1, calls_changed: 0 }, calls: 3, applicable: 2, asked: 2, mapped: 2, governed: 2, overBudget: 0, notApplicable: 1, outcomes: { violates: 1, satisfies: 1, unknown: 0, aside: 0 } },
    notes: ["src/auth.rs: 2 calls were left out of the listing by its cap <img src=x>"],
  };
}

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    version: 2,
    tool: { name: "jev-intent-review", version: VERSION },
    exitCode: 0,
    intent: {
      version: 1,
      title: "t",
      summary: "",
      requirements: [
        { id: "R1", text: "Disabled users cannot authenticate.", kind: "security", priority: "required", sourceRefs: [], searchHints: [] },
        { id: "R2", text: "Sessions still work.", kind: "behavior", priority: "required", sourceRefs: [], searchHints: [] },
      ],
      nonGoals: [],
      ambiguities: [],
    },
    sources: [{ id: "issue#1", type: "github_issue", authority: 100, author: "alice" }],
    requirements: [localCheckResult()],
    unexpectedChanges: [],
    sent: { requests: 4, bytes: 12345, answered: 4 },
    metadata: { repository: "o/r", base: "a".repeat(40), head: "b".repeat(40), model: "typesafe/jev", questionsHash: "abc", configSource: "defaults", notes: [] },
    ...overrides,
  };
}

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
  assert.match(renderMarkdown(report({ requirements: [stopped], sent: { requests: 0, bytes: 0, answered: 0 } })), /\*\*Result: the set was built and nothing was asked\.\*\* 1 call inside the budget, 1 call not checked/);
  const heldLate = { ...stopped, unchecked: [...unread.unchecked, { ...inBudget, why: "the body of open_session did not fit the evidence limit, so an answer would be about part of it" }] };
  assert.match(renderMarkdown(report({ requirements: [heldLate], sent: { requests: 0, bytes: 0, answered: 0 } })), /\*\*Result: no call was read\.\*\* 2 calls not checked/);
  for (const word of ["VERIFIED", "VIOLATION", "UNKNOWN", "verdict:"]) assert.ok(!text.includes(word), `${word} is not in the report`);
  assert.ok(!/violat/i.test(text.replace(/`[^`]*`/g, "")), "no verdict word of the tool's own outside a code span");
});

test("the Markdown report shows each requirement's calls: worth checking with everything to disagree with, holding, and not checked", () => {
  const text = renderMarkdown(report());
  assert.match(text, /## R1\n\n> `Disabled users cannot authenticate\.`\n\nForm: `failure_propagation`\./);
  assert.match(text, /Of the 2 read: 1 worth checking, 1 holding, 0 not settled, 0 not required of\./);
  assert.match(text, /### Worth checking\n\n#### src\/auth\.rs:16-23 · open_session — `create_session\(store, &record\)`/);
  assert.match(text, /\*\*Jev, on what the function returns\*\*: returns_success \(0\.61\)/);
  assert.match(text, /### Read as holding\n\n[^\n]*\n\n- src\/auth\.rs · open_session — `load_key\(store, key\)`/);
  assert.match(text, /### Not checked\n\n- src\/auth\.rs · open_session — `audit\(store\)`/);
  assert.ok(!text.includes("<img"), "notes cannot carry HTML");
  assert.match(text, /&lt;img src=x&gt;/);
  assert.match(text, /- 4 requests, 4 answers, 12,345 bytes/);
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
