import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_PATH, defaultConfig, loadConfig } from "../src/config/config.ts";
import { validateIntentSpec } from "../src/intent/schema.ts";
import { ProviderError } from "../src/judgments/cloudflare.ts";
import { Git } from "../src/repository/git.ts";
import { aggregate, decide, verdictOf } from "../src/review/requirement.ts";
import { runReview } from "../src/review/run.ts";
import { EXIT, ToolError, type CandidateResult, type IntentSpec } from "../src/types.ts";
import { answer, guardProvider, ScriptedProvider } from "./helpers/fakes.ts";
import { FIXTURES, fixtureRepo, tempRepo } from "./helpers/repo.ts";

const T = { violation: 0.7, satisfaction: 0.5, relevance: 0.6 };

test("decide: supporting or unrelated code is not a path; a violation needs a path, the threshold and whole evidence", () => {
  assert.equal(decide(answer("supporting", 0.7), answer("violates", 0.9), false, T).outcome, "unrelated");
  assert.equal(decide(answer("unrelated", 0.7), answer("violates", 0.9), false, T).outcome, "unrelated");
  assert.equal(decide(answer("supporting", 0.5), answer("violates", 0.9), false, T).outcome, "unknown", "below the relevance threshold it is not excluded, but not a violation either");
  assert.equal(decide(answer("cannot_tell", 0.5), answer("violates", 0.9), false, T).outcome, "unknown");
  assert.equal(decide(answer("may_violate", 0.9), answer("violates", 0.69), false, T).outcome, "unknown");
  assert.equal(decide(answer("may_violate", 0.9), answer("violates", 0.9), true, T).outcome, "unknown");
  assert.equal(decide(answer("may_violate", 0.9), answer("violates", 0.9), false, T).outcome, "violates");
  // Called a path only weakly, as measured on omamori #559: a CI script at 0.54, doctor at 0.62.
  assert.equal(decide(answer("may_violate", 0.54), answer("violates", 0.81), false, T).outcome, "unknown");
  assert.equal(decide(answer("may_violate", 0.62), answer("violates", 0.87), false, T).outcome, "unknown");
  assert.equal(decide(answer("directly_enforces", 0.7), answer("violates", 0.81), false, T).outcome, "violates", "both answers at the violation bar");
  assert.equal(decide(answer("directly_enforces", 0.9), answer("satisfies", 0.55), false, T).outcome, "satisfies");
  assert.equal(decide(answer("directly_enforces", 0.9), answer("satisfies", 0.45), false, T).outcome, "unknown");
  assert.equal(decide(answer("may_violate", 0.9), answer("insufficient_evidence", 0.9), false, T).outcome, "unknown");
  assert.equal(decide(answer("cannot_tell", 0.5), answer("not_applicable", 0.9), false, T).outcome, "not_applicable");
  // Called a path, then "does not apply": contradictory, so unknown.
  assert.equal(decide(answer("may_violate", 0.9), answer("not_applicable", 0.9), false, T).outcome, "unknown");
  // On cut evidence no answer stands, whichever it is.
  for (const choice of ["satisfies", "violates", "not_applicable"]) {
    const d = decide(answer("cannot_tell", 0.5), answer(choice, 0.95), true, T);
    assert.equal(d.outcome, "unknown", choice);
    assert.match(d.notes[0] ?? "", /evidence was cut/);
  }
  // Not even "unrelated": the missing part could be the governed call itself.
  assert.equal(decide(answer("unrelated", 0.9), answer("not_applicable", 0.9), true, T).outcome, "unknown");
  assert.equal(decide(answer("supporting", 0.9), answer("not_applicable", 0.9), true, T).outcome, "unknown");
});

function result(outcome: CandidateResult["outcome"], truncated = false): CandidateResult {
  return { candidate: { path: "a.ts", startLine: 1, endLine: 2, changed: false, reasons: [] }, outcome, truncated, evidence: [], notes: [] };
}

test("aggregate: one violation decides; VERIFIED needs every relevant path satisfied, whole, and nothing blocking", () => {
  assert.equal(aggregate("R1", [result("satisfies"), result("violates"), result("unknown")], [], false).status, "violation");
  assert.equal(aggregate("R1", [result("satisfies"), result("unknown")], [], false).status, "unknown");
  assert.equal(aggregate("R1", [result("satisfies"), result("unrelated")], [], false).status, "verified");
  assert.equal(aggregate("R1", [result("satisfies")], ["the change edits this tool's configuration"], false).status, "unknown");
  assert.equal(aggregate("R1", [result("not_applicable"), result("unrelated")], [], false).status, "not_applicable");
  assert.equal(aggregate("R1", [result("not_applicable")], ["discovery was cut short (x)"], true).status, "unknown", "does not apply anywhere is a claim about the whole search");
  assert.equal(aggregate("R1", [result("unrelated")], [], false).status, "unknown");
  assert.equal(aggregate("R1", [], [], false).coverage, "none");
  assert.equal(aggregate("R1", [result("satisfies")], [], true).coverage, "weak");
  assert.equal(aggregate("R1", [result("satisfies"), result("satisfies"), result("unknown")], [], false).coverage, "partial");
});

test("verdictOf follows the policy: fail_on and unknown", () => {
  const v = (status: "violation" | "unknown" | "verified") => [{ requirementId: "R1", status, coverage: "full" as const, candidates: [], notes: [] }];
  assert.deepEqual(verdictOf(v("violation"), { fail_on: ["violation"], unknown: "warn" }), { verdict: "violation", exitCode: EXIT.violation });
  assert.deepEqual(verdictOf(v("violation"), { fail_on: [], unknown: "warn" }), { verdict: "violation", exitCode: EXIT.ok });
  assert.deepEqual(verdictOf(v("unknown"), { fail_on: ["violation"], unknown: "warn" }), { verdict: "unknown", exitCode: EXIT.ok });
  assert.deepEqual(verdictOf(v("unknown"), { fail_on: ["violation"], unknown: "fail" }), { verdict: "unknown", exitCode: EXIT.incomplete });
  assert.deepEqual(verdictOf(v("verified"), { fail_on: ["violation"], unknown: "fail" }), { verdict: "no_violation_found", exitCode: EXIT.ok });
});

/** The fixture's spec with every default filled in, as --intent-spec would read it. */
function intentOf(name: string): IntentSpec {
  return validateIntentSpec(JSON.parse(readFileSync(join(FIXTURES, name, "fixture.json"), "utf8")).spec, name);
}

async function review(name: string, after: "head" | "fixed", provider: ScriptedProvider, extra: Partial<Parameters<typeof runReview>[0]> = {}) {
  const repo = fixtureRepo(name);
  try {
    const git = await Git.open(repo.dir);
    const to = (after === "fixed" ? repo.fixed : repo.head) as string;
    const loaded = await loadConfig(git, repo.base, to);
    const intent = intentOf(name);
    const full = intent;
    return await runReview({
      git,
      revisions: { before: repo.base, after: to, how: "test" },
      loaded,
      intent: full,
      sources: [{ id: "fixture", type: "spec", authority: 100, text: "" }],
      prBodyOnly: false,
      provider,
      sent: () => ({ requests: provider.calls.length, bytes: 0 }),
      repository: "o/r",
      trace: () => {},
      ...extra,
    });
  } finally {
    repo.remove();
  }
}

test("runReview on the missed-path fixture: the untouched paths are violations and the evidence is the governed call", async () => {
  const report = await review("missed-path", "head", guardProvider("createSession", "disabledAt"));
  const r1 = report.requirements[0];
  assert.equal(r1?.status, "violation");
  assert.equal(report.verdict, "violation");
  assert.equal(report.exitCode, EXIT.violation);
  const violations = (r1?.candidates ?? []).filter((c) => c.outcome === "violates");
  assert.deepEqual(violations.map((c) => c.candidate.path).sort(), ["src/auth/oauth.ts", "src/auth/websocket.ts"]);
  const pointed = violations.flatMap((c) => c.evidence.map((e) => `${e.path}:${e.startLine}`));
  for (const line of ["src/auth/oauth.ts:22", "src/auth/websocket.ts:21"]) assert.ok(pointed.includes(line), `${line}, the createSession call`);
  assert.ok(violations.every((c) => !c.candidate.changed));
  assert.ok(report.discovery.unchangedCandidates > 0);
  assert.ok(report.sent.locations.some((l) => l.path === "src/auth/oauth.ts"));
});

test("runReview: every path fixed gives VERIFIED, unless the completeness signal says the list looks short", async () => {
  const fixed = await review("missed-path", "fixed", guardProvider("createSession", "disabledAt"));
  assert.equal(fixed.requirements[0]?.status, "verified");
  assert.equal(fixed.verdict, "no_violation_found");

  for (const signal of ["likely_incomplete", "cannot_tell"]) {
    const doubtful = await review("missed-path", "fixed", guardProvider("createSession", "disabledAt", signal));
    assert.equal(doubtful.requirements[0]?.status, "unknown", signal);
    assert.match(doubtful.requirements[0]?.notes.join(" ") ?? "", /did not judge the list of places likely complete/);
  }
});

test("runReview: the completeness question gets the requirement redacted, like every other packet", async () => {
  const key = `AKIA${"Q".repeat(16)}`;
  const intent = intentOf("missed-path");
  intent.requirements = intent.requirements.map((r) => ({ ...r, text: `${r.text} Rotate ${key} too.` }));
  const provider = guardProvider("createSession", "disabledAt");
  const report = await review("missed-path", "fixed", provider, { intent });
  assert.equal(report.requirements[0]?.status, "verified", "so the completeness question was asked");
  assert.ok(provider.calls.some((c) => c.questions.includes("completeness")));
  assert.ok(!provider.calls.some((c) => JSON.stringify(c.state).includes(key)));
});

test("runReview: a refused credential ends the run with exit 12; a budget running out makes paths unknown", async () => {
  const refused = new ScriptedProvider(() => {
    throw new ProviderError("auth", "Workers AI 401: bad token", 401);
  });
  await assert.rejects(review("missed-path", "head", refused), (e: unknown) => e instanceof ToolError && e.exitCode === EXIT.provider);

  let calls = 0;
  const budget = new ScriptedProvider((state, questions) => {
    calls += 1;
    if (calls > 2) throw new ProviderError("budget", "request limit reached (2)");
    return guardProvider("createSession", "disabledAt").judge(state, questions) as never;
  });
  const report = await review("missed-path", "fixed", budget);
  assert.equal(report.requirements[0]?.status, "unknown");
  assert.ok(report.discovery.incompleteReasons.some((r) => /budget ran out/.test(r)));
});

test("runReview follows the callers of a wrapper Jev calls supporting, and finds the unguarded one", async () => {
  // Below the relevance threshold too: supporting at 0.55 is not excluded, but it is not a path.
  for (const p of [0.9, 0.55]) await wrapperReview(p);
});

async function wrapperReview(p: number) {
  const repo = tempRepo();
  try {
    repo.write({
      "src/store.ts": "export function createSession(id) {\n  return { id };\n}\n",
      "src/open.ts": "export function openSession(user) {\n  return createSession(user.id);\n}\n",
      "src/password.ts": "export function loginWithPassword(user) {\n  return createSession(user.id);\n}\n",
      "src/oauth.ts": "export function loginWithOAuth(user) {\n  return openSession(user);\n}\n",
    });
    const base = repo.commit("base");
    repo.write({ "src/password.ts": "export function loginWithPassword(user) {\n  if (user.disabledAt) throw new Error('disabled');\n  return createSession(user.id);\n}\n" });
    const head = repo.commit("head");
    const provider = new ScriptedProvider((state, questions): Record<string, ReturnType<typeof answer>> => {
      if ("completeness" in questions) return { completeness: answer("likely_complete") };
      const code = state.evidence?.code ?? "";
      if (code.includes("function openSession")) return { relevance: answer("supporting", p), satisfaction: answer("not_applicable") };
      if (code.includes("disabledAt")) return { relevance: answer("directly_enforces"), satisfaction: answer("satisfies") };
      if (code.includes("function loginWithOAuth")) return { relevance: answer("may_violate"), satisfaction: answer("violates") };
      return { relevance: answer("unrelated"), satisfaction: answer("not_applicable") };
    });
    const git = await Git.open(repo.dir);
    const requirement = { id: "R1", text: "Disabled users cannot sign in.", kind: "behavior" as const, priority: "required" as const, sourceRefs: [], searchHints: [] };
    const report = await runReview({
      git,
      revisions: { before: base, after: head, how: "test" },
      loaded: await loadConfig(git, base, head),
      intent: { version: 1, title: "", summary: "", requirements: [requirement], nonGoals: [], ambiguities: [] },
      sources: [],
      prBodyOnly: false,
      provider,
      sent: () => ({ requests: 0, bytes: 0 }),
      repository: "o/r",
      trace: () => {},
    });
    assert.equal(report.requirements[0]?.status, "violation", `supporting at ${p}`);
    const oauth = report.requirements[0]?.candidates.find((c) => c.candidate.path === "src/oauth.ts");
    assert.equal(oauth?.outcome, "violates");
    assert.match(oauth?.candidate.reasons[0] ?? "", /^calls openSession, which calls createSession/);
  } finally {
    repo.remove();
  }
}

test("runReview: a bad request is about one packet and makes that place unknown, not the run fail", async () => {
  const provider = new ScriptedProvider((state, questions) => {
    if ((state.candidate?.path ?? "") === "src/auth/oauth.ts") throw new ProviderError("bad_request", "Workers AI 413: too large", 413);
    return guardProvider("createSession", "disabledAt").judge(state, questions) as never;
  });
  const report = await review("missed-path", "head", provider);
  const oauth = report.requirements[0]?.candidates.find((c) => c.candidate.path === "src/auth/oauth.ts" && c.candidate.symbol === "completeOAuthLogin");
  assert.equal(oauth?.outcome, "unknown");
  assert.equal(report.requirements[0]?.status, "violation", "the WebSocket path is still a violation");
});

test("runReview: a change that edits this tool's configuration cannot be VERIFIED", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    repo.git("checkout", "-q", repo.fixed as string);
    repo.write({ [CONFIG_PATH]: "discovery:\n  max_candidates_per_requirement: 30\n" });
    const edited = repo.commit("edit the config");
    const git = await Git.open(repo.dir);
    const provider = guardProvider("createSession", "disabledAt");
    const report = await runReview({
      git,
      revisions: { before: repo.base, after: edited, how: "test" },
      loaded: await loadConfig(git, repo.base, edited),
      intent: intentOf("missed-path"),
      sources: [],
      prBodyOnly: false,
      provider,
      sent: () => ({ requests: 0, bytes: 0 }),
      repository: "o/r",
      trace: () => {},
    });
    assert.equal(report.requirements[0]?.status, "unknown");
    assert.match(report.requirements[0]?.notes.join(" ") ?? "", /edits this tool's configuration/);
  } finally {
    repo.remove();
  }
});

test("runReview: the pull request's own description as the only intent is said, and can withhold VERIFIED", async () => {
  const sources = [{ id: "pr#1", type: "pr_description" as const, authority: 50, author: "someone", text: "x" }];
  const allowed = await review("missed-path", "fixed", guardProvider("createSession", "disabledAt"), { sources, prBodyOnly: true });
  assert.equal(allowed.requirements[0]?.status, "verified");
  assert.match(allowed.metadata.notes.join(" "), /written by its author someone/);

  const strict = defaultConfig();
  strict.intent.pr_body_only = "unknown";
  const withheld = await review("missed-path", "fixed", guardProvider("createSession", "disabledAt"), { sources, prBodyOnly: true, loaded: { config: strict, source: "test", changedInPullRequest: false } });
  assert.equal(withheld.requirements[0]?.status, "unknown");
  assert.match(withheld.requirements[0]?.notes.join(" ") ?? "", /pr_body_only/);
});
