// A report of every part the Markdown and the Action read, for tests that start from a report rather
// than from a run: one requirement, one call worth checking, one holding, one not checked.

import type { LocalCheckResult } from "../../src/review/local-check-run.ts";
import type { ReviewReport } from "../../src/types.ts";
import { VERSION } from "../../src/version.ts";

export function localCheckResult(): LocalCheckResult {
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

export function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
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
