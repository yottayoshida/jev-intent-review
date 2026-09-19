// From Jev's answers to findings (spec §18-20). Jev answers; this file decides. Thresholds come from
// the configuration and apply to the probability Jev puts on the chosen answer, not to its
// `confidence` field: in the first probe of the missed-path fixture, correct `violates` answers
// carried a `confidence` of 0.39-0.52 while `probabilities.violates` was 0.55-0.65 on violating
// paths and 0.00-0.04 on the others. Current measurements are with the defaults in config.ts.

import type { CandidateOutcome, ChoiceAnswer, Coverage, RequirementResult, CandidateResult, ReviewReport, Status, Verdict } from "../types.ts";
import { EXIT } from "../types.ts";

export interface Thresholds {
  violation: number;
  satisfaction: number;
  relevance: number;
}

export function probabilityOf(answer: ChoiceAnswer, choice: string): number {
  const p = answer.probabilities[choice];
  if (typeof p === "number") return p;
  return answer.choice === choice ? answer.confidence : 0;
}

const fixed = (n: number) => n.toFixed(2);

/** One candidate's outcome from Jev's two answers. `truncated`: the packet did not hold all of it. */
export function decide(
  relevance: ChoiceAnswer,
  satisfaction: ChoiceAnswer,
  truncated: boolean,
  t: Thresholds,
): { outcome: CandidateOutcome; notes: string[] } {
  const choice = satisfaction.choice;
  const p = probabilityOf(satisfaction, choice);
  const answered = `Jev answered ${choice} (${fixed(p)})`;
  const path = relevance.choice === "directly_enforces" || relevance.choice === "may_violate";
  const relevanceP = probabilityOf(relevance, relevance.choice);
  // On cut evidence no answer stands, not even "unrelated": the missing part could hold the check
  // (so no violation), or the governed action itself (so the code is not unrelated, and neither
  // "satisfies" nor "does not apply").
  if (truncated) return { outcome: "unknown", notes: [`${answered} (relevance ${relevance.choice}), but the evidence was cut and the missing part could change the answer`] };
  // J1 decides whether this is a path at all (spec §13 Layer D). Supporting code (a definition, a
  // helper, a test) is not a place the requirement holds or fails, so it counts neither towards a
  // violation nor towards VERIFIED. Measured: a data-access helper judged `supporting` still drew
  // a `violates` at 0.52 from the second question.
  if ((relevance.choice === "unrelated" || relevance.choice === "supporting") && relevanceP >= t.relevance) {
    return { outcome: "unrelated", notes: relevance.choice === "supporting" ? ["judged supporting code, not a path the requirement holds or fails on"] : [] };
  }
  switch (choice) {
    case "violates":
      if (p < t.violation) return { outcome: "unknown", notes: [`${answered}, below judgment.violation_probability ${fixed(t.violation)}`] };
      // A violation rests on two answers, that this code is a path the requirement governs and that
      // it fails there, and both are held to the violation bar. Measured on omamori #559 (two runs,
      // the same eight requirements): places that were not violations drew `violates` at 0.80-0.87,
      // and were called paths at 0.50-0.62 (a CI script checking the README among them). Real
      // violations on the fixtures were called paths at 0.98-0.99. A shell script judged
      // `unrelated` drew `violates` at 0.56 on an earlier run.
      if (!path) return { outcome: "unknown", notes: [`${answered}, but Jev did not judge this code a path the requirement governs (${relevance.choice})`] };
      if (relevanceP < t.violation) {
        return { outcome: "unknown", notes: [`${answered}, but Jev called this code a path (${relevance.choice}) only at ${fixed(relevanceP)}, below judgment.violation_probability ${fixed(t.violation)}`] };
      }
      return { outcome: "violates", notes: [] };
    case "satisfies":
      if (p < t.satisfaction) return { outcome: "unknown", notes: [`${answered}, below judgment.satisfaction_probability ${fixed(t.satisfaction)}`] };
      return { outcome: "satisfies", notes: [] };
    case "not_applicable":
      if (p < t.satisfaction) return { outcome: "unknown", notes: [`${answered}, below judgment.satisfaction_probability ${fixed(t.satisfaction)}`] };
      // Called a path the requirement governs, and then said the requirement does not apply to it.
      if (path) return { outcome: "unknown", notes: [`${answered}, but Jev also called this code a path the requirement governs (${relevance.choice})`] };
      return { outcome: "not_applicable", notes: [] };
    default:
      return { outcome: "unknown", notes: [answered] };
  }
}

/**
 * A requirement's status over its candidates. VERIFIED needs every relevant candidate satisfied on
 * complete evidence and nothing in `blockers` (reasons this run cannot vouch for completeness).
 */
export function aggregate(requirementId: string, candidates: CandidateResult[], blockers: string[], discoveryIncomplete: boolean): RequirementResult {
  const relevant = candidates.filter((c) => c.outcome !== "unrelated");
  const count = (o: CandidateOutcome) => relevant.filter((c) => c.outcome === o).length;
  const notes: string[] = [];
  let status: Status;
  if (count("violates") > 0) status = "violation";
  else if (relevant.length === 0) {
    status = "unknown";
    notes.push(candidates.length === 0 ? "No place this requirement applies to was found." : "Every place found was judged unrelated to this requirement.");
  } else if (count("unknown") > 0) status = "unknown";
  else if (count("not_applicable") === relevant.length) {
    // "Does not apply anywhere" is as much a claim about the whole search as VERIFIED is.
    for (const blocker of blockers) notes.push(`NOT_APPLICABLE is withheld: ${blocker}.`);
    status = blockers.length > 0 ? "unknown" : "not_applicable";
  }
  else {
    // Cut evidence never reaches here as satisfied: decide() makes it unknown.
    for (const blocker of blockers) notes.push(`VERIFIED is withheld: ${blocker}.`);
    status = blockers.length > 0 ? "unknown" : "verified";
  }

  let coverage: Coverage;
  if (candidates.length === 0) coverage = "none";
  else if (discoveryIncomplete || count("unknown") * 2 > relevant.length) coverage = "weak";
  else if (count("unknown") > 0) coverage = "partial";
  else coverage = "full";

  return { requirementId, status, coverage, candidates, notes };
}

export function verdictOf(requirements: RequirementResult[], policy: { fail_on: string[]; unknown: "warn" | "fail" }): { verdict: Verdict; exitCode: ReviewReport["exitCode"] } {
  if (requirements.some((r) => r.status === "violation")) return { verdict: "violation", exitCode: policy.fail_on.includes("violation") ? EXIT.violation : EXIT.ok };
  if (requirements.some((r) => r.status === "unknown")) return { verdict: "unknown", exitCode: policy.unknown === "fail" ? EXIT.incomplete : EXIT.ok };
  return { verdict: "no_violation_found", exitCode: EXIT.ok };
}
