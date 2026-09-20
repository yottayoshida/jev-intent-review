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
import { EXIT, ToolError, type CandidateResult, type IntentSpec, type Scope } from "../src/types.ts";
import { answer, guardProvider, ScriptedProvider } from "./helpers/fakes.ts";
import { FIXTURES, fixtureRepo, tempRepo } from "./helpers/repo.ts";

const T = { violation: 0.7, satisfaction: 0.5, relevance: 0.6 };

test("decide: only a place Jev calls a path of the requirement decides it, and cut evidence is read by which part was cut", () => {
  const WHOLE = { own: false, context: false, ambiguous: false };
  const CONTEXT = { own: false, context: true, ambiguous: false };
  const AMBIGUOUS = { own: false, context: false, ambiguous: true };
  const OWN = { own: true, context: false, ambiguous: false };

  // Not a path: set aside with its reason, whatever the second answer says. The old rule let an
  // unsure one hold the requirement open, which is why VERIFIED never came out on real code.
  for (const [choice, p] of [["supporting", 0.7], ["unrelated", 0.7]] as const) {
    const d = decide(answer(choice, p), answer("violates", 0.9), WHOLE, T);
    assert.deepEqual([d.outcome, d.aside], ["aside", "not_a_path"], `${choice} ${p}`);
  }
  // Jev's own first answer decides what is set aside; the bar decides whether that was a confident
  // "not a path" or one it was unsure about, which is the number a reader of a VERIFIED needs.
  for (const [choice, p] of [["supporting", 0.5], ["cannot_tell", 0.5], ["unrelated", 0.31]] as const) {
    const d = decide(answer(choice, p), answer("violates", 0.9), WHOLE, T);
    assert.deepEqual([d.outcome, d.aside], ["aside", "unsure"], `${choice} ${p}`);
  }
  // Called a path, but too weakly to count as one: also set aside, and said so separately.
  // Measured on omamori #559: a CI script called a path at 0.54, doctor at 0.62.
  const weak = decide(answer("may_violate", 0.54), answer("violates", 0.81), WHOLE, T);
  assert.deepEqual([weak.outcome, weak.aside], ["aside", "unsure"]);
  assert.match(weak.notes[0] ?? "", /below judgment.relevance_probability/);
  assert.equal(decide(answer("may_violate", 0.62), answer("violates", 0.87), WHOLE, T).outcome, "unknown", "0.62 clears the relevance bar, so it is a path — but not at the violation bar");

  // A violation needs both answers at the violation bar, on evidence that was not cut.
  assert.equal(decide(answer("may_violate", 0.9), answer("violates", 0.69), WHOLE, T).outcome, "unknown");
  assert.equal(decide(answer("may_violate", 0.9), answer("violates", 0.9), WHOLE, T).outcome, "violates");
  assert.equal(decide(answer("directly_enforces", 0.7), answer("violates", 0.81), WHOLE, T).outcome, "violates", "both answers at the violation bar");

  // Missing surroundings can hide a check, so no violation can be claimed on them — but they
  // cannot remove a check that was seen, so the satisfying answer stands.
  const cutViolation = decide(answer("may_violate", 0.9), answer("violates", 0.9), CONTEXT, T);
  assert.equal(cutViolation.outcome, "unknown");
  assert.match(cutViolation.notes[0] ?? "", /the missing part could hold the check/);
  assert.equal(decide(answer("directly_enforces", 0.9), answer("satisfies", 0.55), CONTEXT, T).outcome, "satisfies");
  assert.equal(decide(answer("directly_enforces", 0.9), answer("satisfies", 0.55), WHOLE, T).outcome, "satisfies");
  assert.equal(decide(answer("directly_enforces", 0.9), answer("satisfies", 0.45), WHOLE, T).outcome, "unknown");

  // Unless the surroundings may belong to another definition of the same name: then the check
  // that was seen may not be on this path at all.
  const ambiguous = decide(answer("directly_enforces", 0.9), answer("satisfies", 0.9), AMBIGUOUS, T);
  assert.equal(ambiguous.outcome, "unknown");
  assert.match(ambiguous.notes[0] ?? "", /defined more than once/);

  // The place's own code missing voids every answer about it, including "not a path".
  for (const [rel, sat] of [["may_violate", "violates"], ["unrelated", "not_applicable"], ["directly_enforces", "satisfies"]] as const) {
    const d = decide(answer(rel, 0.9), answer(sat, 0.95), OWN, T);
    assert.deepEqual([d.outcome, d.aside], ["aside", "unreadable"], `${rel}/${sat}`);
    assert.match(d.notes[0] ?? "", /own code was cut/);
  }

  // Called a path and then not answered about: undecided, not excluded.
  assert.equal(decide(answer("may_violate", 0.9), answer("insufficient_evidence", 0.9), WHOLE, T).outcome, "unknown");
  assert.equal(decide(answer("may_violate", 0.9), answer("not_applicable", 0.9), WHOLE, T).outcome, "unknown");
});

function result(outcome: CandidateResult["outcome"], cut = { own: false, context: false, ambiguous: false }): CandidateResult {
  return { candidate: { path: "a.ts", startLine: 1, endLine: 2, changed: false, reasons: [] }, outcome, truncated: cut.own || cut.context || cut.ambiguous, cut, evidence: [], notes: [] };
}

const NO_SCOPE: Omit<Scope, "found" | "judged" | "paths" | "setAside"> = { notFollowed: [], unjudged: [], blocking: [] };

test("aggregate: the paths decide the requirement; what was left travels with it and only a gap withholds VERIFIED", () => {
  const of = (candidates: CandidateResult[], scope = NO_SCOPE, found?: number) => aggregate("R1", candidates, scope, found ?? candidates.length);

  assert.equal(of([result("satisfies"), result("violates"), result("unknown")]).status, "violation");
  assert.equal(of([result("satisfies"), result("unknown")]).status, "unknown");
  assert.equal(of([result("satisfies"), result("aside")]).status, "verified");
  // A place set aside is not a path, so it neither verifies nor blocks; a requirement with none
  // at all is unknown, because nothing was found that it holds or fails on.
  assert.equal(of([result("aside")]).status, "unknown");
  assert.match(of([result("aside")]).notes[0] ?? "", /None of the 1 place\(s\) judged was called a path/);
  assert.equal(of([]).status, "unknown");

  // Only a gap withholds VERIFIED: a path known by name and never judged, or an edit to the
  // tool's own configuration. Leads the search declined to follow do not, on their own.
  assert.equal(of([result("satisfies")], { ...NO_SCOPE, blocking: ["3 callers of x were found and only 0 were judged"] }).status, "unknown");
  assert.equal(of([result("satisfies")], { ...NO_SCOPE, notFollowed: ["the word log is too common to search by"] }).status, "verified");
  assert.equal(of([result("satisfies")], { ...NO_SCOPE, unjudged: ["159 places were found and only the first 30 were judged"] }).status, "verified");

  // The scope travels with the result whatever the status.
  const scoped = of([result("satisfies"), result("aside"), result("aside")], { ...NO_SCOPE, notFollowed: ["a"] }, 90);
  assert.deepEqual([scoped.scope.found, scoped.scope.judged, scoped.scope.paths, scoped.scope.setAside], [90, 3, 1, 2]);

  // Coverage says how much the status is a statement about.
  assert.equal(of([]).coverage, "none");
  assert.equal(of([result("satisfies")]).coverage, "full");
  assert.equal(of([result("satisfies")], { ...NO_SCOPE, notFollowed: ["a"] }).coverage, "partial");
  assert.equal(of([result("satisfies")], NO_SCOPE, 90).coverage, "weak", "30 of 90 judged is not full coverage");
  assert.equal(of([result("satisfies"), result("satisfies"), result("unknown")]).coverage, "partial");
  assert.equal(of([result("satisfies"), result("unknown"), result("unknown")]).coverage, "weak", "more than half the paths undecided");
});

test("a place whose own code was cut is not counted as irrelevant: it is one the run could not judge", async () => {
  // The whole reason this is not `aside: "not_a_path"` with the rest: Jev called it a path at 0.99
  // and answered `violates`, and nothing of that stands when the place's own code was cut. Dropping
  // it quietly would leave the other paths to carry a VERIFIED.
  const cut = { own: true, context: false, ambiguous: false };
  const d = decide(answer("directly_enforces", 0.99), answer("violates", 0.95), cut, T);
  assert.deepEqual([d.outcome, d.aside], ["aside", "unreadable"]);
  const withIt = aggregate("R1", [result("satisfies"), { ...result("aside"), aside: "unreadable" }], { ...NO_SCOPE, blocking: ["1 place(s) could not be read in full, so no answer about them stands"] }, 2);
  assert.equal(withIt.status, "unknown");
  assert.match(withIt.notes.join(" "), /could not be read in full/);
});

test("verdictOf follows the policy: fail_on and unknown", () => {
  const v = (status: "violation" | "unknown" | "verified") => [{ requirementId: "R1", status, coverage: "full" as const, scope: { found: 0, judged: 0, paths: 0, setAside: 0, ...NO_SCOPE }, candidates: [], notes: [] }];
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

test("runReview: a place too long to read in full withholds VERIFIED, and the report says why", async () => {
  // One of the two places that create a session is a function no block can be taken from (over
  // three hundred lines), so nothing Jev answers about it stands. Setting it aside as irrelevant
  // would leave the other place to carry a VERIFIED — which is what it used to do.
  const repo = tempRepo();
  try {
    const filler = Array.from({ length: 360 }, (_, i) => `  const step${i} = ${i};`).join("\n");
    repo.write({
      "src/session/store.ts": "export function createSession(id: string) {\n  return { id };\n}\n",
      "src/big.ts": `import { createSession } from "./session/store.ts";\n\nexport function bigPath(user: { id: string }) {\n${filler}\n  return createSession(user.id);\n}\n`,
    });
    const base = repo.commit("base");
    repo.write({
      "src/login.ts": 'import { createSession } from "./session/store.ts";\n\nexport function login(user: { id: string; disabledAt?: string }) {\n  if (user.disabledAt) throw new Error("account disabled");\n  return createSession(user.id);\n}\n',
    });
    const head = repo.commit("add a guarded login");
    const git = await Git.open(repo.dir);
    const loaded = await loadConfig(git, base, head);
    const provider = guardProvider("createSession", "disabledAt");
    const intent: IntentSpec = {
      version: 1,
      title: "t",
      summary: "",
      requirements: [{ id: "R1", text: "Disabled users cannot authenticate.", kind: "security", priority: "required", sourceRefs: [], searchHints: ["disabled"] }],
      nonGoals: [],
      ambiguities: [],
    };
    const report = await runReview({
      git,
      revisions: { before: base, after: head, how: "test" },
      loaded,
      intent,
      sources: [{ id: "fixture", type: "spec", authority: 100, text: "" }],
      prBodyOnly: false,
      provider,
      sent: () => ({ requests: provider.calls.length, bytes: 0 }),
      repository: "o/r",
      trace: () => {},
    });
    const r1 = report.requirements[0];
    assert.ok(r1?.candidates.some((c) => c.aside === "unreadable"), JSON.stringify(r1?.candidates.map((c) => [c.candidate.path, c.outcome, c.aside])));
    assert.match(r1?.scope.blocking.join(" ") ?? "", /could not be read in full/);
    assert.equal(r1?.status, "unknown");
    assert.match(r1?.notes.join(" ") ?? "", /VERIFIED is withheld: .*could not be read in full/);
  } finally {
    repo.remove();
  }
});

test("runReview: with no room for the surroundings, a satisfying answer still counts but a violation does not", async () => {
  // The room for context cut to nothing, so every packet is the place's own code alone — and says
  // so, which is the point: a check the place performs itself still counts, while a violation
  // cannot be claimed when the guard could be in a caller that was never shown.
  const withoutContext = async (after: "head" | "fixed") => {
    const repo = fixtureRepo("missed-path");
    try {
      repo.git("checkout", "-q", repo.base);
      repo.write({ [CONFIG_PATH]: "evidence:\n  max_related_chars: 0\n" });
      const base = repo.commit("no room for context");
      const git = await Git.open(repo.dir);
      const to = (after === "fixed" ? repo.fixed : repo.head) as string;
      const loaded = await loadConfig(git, base, to);
      const provider = guardProvider("createSession", "disabledAt");
      return await runReview({
        git,
        revisions: { before: base, after: to, how: "test" },
        loaded,
        intent: intentOf("missed-path"),
        sources: [{ id: "fixture", type: "spec", authority: 100, text: "" }],
        prBodyOnly: false,
        provider,
        sent: () => ({ requests: provider.calls.length, bytes: 0 }),
        repository: "o/r",
        trace: () => {},
      });
    } finally {
      repo.remove();
    }
  };

  const head = await withoutContext("head");
  const violations = head.requirements[0]?.candidates.filter((c) => c.outcome === "violates") ?? [];
  assert.deepEqual(violations, [], "the guard could be in a caller that was not shown");
  assert.match(head.requirements[0]?.candidates.flatMap((c) => c.notes).join(" ") ?? "", /the missing part could hold the check/);

  // The same cut does not take away a check the place performs on itself.
  const fixed = await withoutContext("fixed");
  const satisfied = fixed.requirements[0]?.candidates.filter((c) => c.outcome === "satisfies") ?? [];
  assert.ok(satisfied.length > 0, JSON.stringify(fixed.requirements[0]?.candidates.map((c) => [c.candidate.path, c.outcome])));
  assert.ok(satisfied.every((c) => c.cut.context), "every one of them was judged on its own code alone");
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

test("runReview: a run that stops on its own budget keeps its report; one that reached the endpoint and read nothing does not", async () => {
  // Every judgment refused by this run's own limits: nothing reached the endpoint, so the report
  // stands as it did before, with the budget written in it.
  const overBudget = new ScriptedProvider(() => {
    throw new ProviderError("budget", "request limit reached (0)");
  });
  const report = await review("missed-path", "head", overBudget, { endpoint: "https://judge.example.com" });
  assert.equal(report.requirements[0]?.status, "unknown");
  assert.ok(report.discovery.incompleteReasons.some((r) => /budget ran out/.test(r)));

  // The endpoint itself answering nothing usable is a different thing, and ends the run.
  const unusable = new ScriptedProvider(() => {
    throw new ProviderError("bad_response", "Jev's response has no answers");
  });
  await assert.rejects(
    review("missed-path", "head", unusable, { endpoint: "https://judge.example.com" }),
    (e: unknown) => e instanceof ToolError && e.exitCode === EXIT.provider && /no judgment came back from https:\/\/judge\.example\.com/.test(e.message),
  );
});

test("runReview: a change in a path this tool never reads is not analysed, judged or reported", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "src/secrets.ts": "export const dbPassword = 'hunter2';\n", "src/login.ts": "export function login(user) {\n  return createSession(user.id);\n}\n" });
    const base = repo.commit("base");
    // The pull request takes the key out of the repository: its old lines still hold it.
    repo.write({ "src/secrets.ts": "export const dbPassword = process.env.DB_PASSWORD;\n", "src/login.ts": "export function login(user) {\n  if (user.disabledAt) throw new Error('disabled');\n  return createSession(user.id);\n}\n" });
    const head = repo.commit("head");
    const git = await Git.open(repo.dir);
    const provider = guardProvider("createSession", "disabledAt");
    const report = await runReview({
      git,
      revisions: { before: base, after: head, how: "test" },
      loaded: await loadConfig(git, base, head),
      intent: { version: 1, title: "", summary: "", requirements: [{ id: "R1", text: "Disabled users cannot sign in.", kind: "behavior", priority: "required", sourceRefs: [], searchHints: [] }], nonGoals: [], ambiguities: [] },
      sources: [],
      prBodyOnly: false,
      provider,
      sent: () => ({ requests: provider.calls.length, bytes: 0 }),
      repository: "o/r",
      trace: () => {},
    });
    assert.ok(!JSON.stringify(provider.calls).includes("hunter2"), "nothing from that file was sent");
    assert.ok(!JSON.stringify(report).includes("hunter2"), "and nothing from it is reported");
    assert.ok(!report.sent.locations.some((l) => l.path === "src/secrets.ts"));
    assert.ok(report.sent.locations.some((l) => l.path === "src/login.ts"), "the rest of the change is still read");
  } finally {
    repo.remove();
  }
});

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
