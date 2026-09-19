import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseIntentSpec, validateIntentSpec } from "../src/intent/schema.ts";
import { codeBlock, codeSpan, renderJson, renderMarkdown } from "../src/report/markdown.ts";
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

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    version: 1,
    tool: { name: "jev-intent-review", version: VERSION },
    verdict: "violation",
    exitCode: 1,
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
    requirements: [
      {
        requirementId: "R1",
        status: "violation",
        coverage: "full",
        notes: [],
        candidates: [
          {
            candidate: { path: "src/auth/password.ts", startLine: 6, endLine: 13, symbol: "loginWithPassword", changed: true, reasons: [] },
            outcome: "satisfies",
            satisfaction: { choice: "satisfies", confidence: 0.99, probabilities: {} },
            truncated: false,
            evidence: [],
            notes: [],
          },
          {
            candidate: { path: "src/auth/oauth.ts", startLine: 16, endLine: 23, changed: false, reasons: [] },
            outcome: "violates",
            satisfaction: { choice: "violates", confidence: 0.47, probabilities: { violates: 0.61 } },
            truncated: false,
            evidence: [{ path: "src/auth/oauth.ts", startLine: 22, endLine: 22 }],
            notes: ["probability 0.61 <img src=x>"],
          },
          {
            candidate: { path: "src/ui/button.ts", startLine: 1, endLine: 9, changed: false, reasons: [] },
            outcome: "unrelated",
            truncated: false,
            evidence: [],
            notes: [],
          },
        ],
      },
      { requirementId: "R2", status: "verified", coverage: "full", notes: [], candidates: [] },
    ],
    unexpectedChanges: [],
    discovery: { candidateCount: 3, changedCandidates: 1, unchangedCandidates: 2, incompleteReasons: [], searches: [] },
    sent: { requests: 3, bytes: 12345, locations: [{ path: "src/auth/oauth.ts", startLine: 16, endLine: 23 }] },
    metadata: { repository: "o/r", base: "a".repeat(40), head: "b".repeat(40), model: "typesafe/jev", questionsHash: "abc", configSource: "defaults", notes: [] },
    ...overrides,
  };
}

test("the Markdown report leads with a result line drawn from the verdict alone", () => {
  assert.match(renderMarkdown(report()), /^# jev-intent-review\n\n\*\*Result: VIOLATION\.\*\* 1 of 2 requirements has a violation\./);
  assert.match(renderMarkdown(report({ verdict: "no_violation_found" })), /\*\*Result: no violation found\*\* in 3 discovered paths\. This is not proof that the change is correct\./);
  assert.match(renderMarkdown(report({ verdict: "skipped", skipReason: "No credentials." })), /\*\*Result: skipped\.\*\* No credentials\./);
});

test("the Markdown report shows each path, whether the change touched it, and the evidence lines", () => {
  const text = renderMarkdown(report());
  assert.match(text, /### R1 · VIOLATION/);
  assert.match(text, /- ✓ satisfies · `src\/auth\/password\.ts:6-13` · `loginWithPassword` · changed in this pull request · p 0\.99/);
  // The probability the policy used (0.61), not Jev's `confidence` field (0.47).
  assert.match(text, /- ✗ violates · `src\/auth\/oauth\.ts:16-23` · p 0\.61\n  - evidence: `src\/auth\/oauth\.ts:22`/);
  assert.match(text, /1 other candidate judged unrelated/);
  assert.match(text, /Repository candidates examined: 3 \(in changed files 1, in unchanged files 2\)/);
  assert.ok(!text.includes("<img"), "notes cannot carry HTML");
  assert.match(text, /&lt;img src=x&gt;/);
});

test("the report names the endpoint, and says so at the top when it is not the default", () => {
  const plain = renderMarkdown(report());
  assert.ok(!plain.includes("Endpoint:"), "nothing to say when the run did not record one");

  const cloudflare = renderMarkdown(report({ sent: { ...report().sent, endpoint: "https://api.cloudflare.com" } }));
  assert.match(cloudflare, /- Endpoint: `https:\/\/api\.cloudflare\.com`/);
  assert.ok(!cloudflare.includes("Judged by"), "the default endpoint needs no warning");

  // Whoever answers the judgments decides the verdict, so another endpoint is named up front.
  const other = renderMarkdown(report({ sent: { ...report().sent, endpoint: "https://judge.example.com" } }));
  assert.match(other, /Judged by `https:\/\/judge\.example\.com`, not `https:\/\/api\.cloudflare\.com`/);
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

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
});
