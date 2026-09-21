// From Jev's answers to findings (spec §18-20). Jev answers; this file decides. Thresholds come from
// the configuration and apply to the probability Jev puts on the chosen answer, not to its
// `confidence` field: in the first probe of the missed-path fixture, correct `violates` answers
// carried a `confidence` of 0.39-0.52 while `probabilities.violates` was 0.55-0.65 on violating
// paths and 0.00-0.04 on the others. Current measurements are with the defaults in config.ts.
//
// What decides a requirement is the places Jev calls paths of it, and only those. Measured over
// 795 judged places on ten real pull requests: 19% were called paths at all, a median of 2 per
// requirement at the configured probability, while 81% were supporting code or unrelated. Asking
// every one of ~30 places to come back decided — the old rule — is a conjunction a probabilistic
// judge does not satisfy, and it never did: VERIFIED came out 0 of 38 times.

import type { AsideReason, CandidateOutcome, ChoiceAnswer, Coverage, Cut, RequirementResult, CandidateResult, ReviewReport, Scope, Status, Verdict } from "../types.ts";
import { EXIT } from "../types.ts";

export interface Thresholds {
  violation: number;
  satisfaction: number;
  relevance: number;
}

export function probabilityOf(answer: ChoiceAnswer, choice: string): number {
  if (answer.choice === choice) return answer.probability;
  return answer.probabilities[choice] ?? 0;
}

const fixed = (n: number) => n.toFixed(2);
const PATH = new Set(["directly_enforces", "may_violate"]);

export interface Decision {
  outcome: CandidateOutcome;
  aside?: AsideReason;
  notes: string[];
}

/**
 * One place's outcome from Jev's two answers.
 *
 * The first answer decides whether this is a path of the requirement: a place Jev does not call a
 * path, or calls one too weakly to clear `relevance`, is set aside with its reason rather than
 * left to hold the requirement open. The bar does not change what is set aside — Jev's own first
 * choice does — but it separates a confident "not a path" from an unsure one, and the unsure ones
 * are counted where a reader and the completeness question can see them.
 *
 * Cut evidence is read by which part was cut. The place's own code missing voids every answer.
 * Missing surroundings can hide a check, so no violation can be claimed on them, but they cannot
 * remove a check that was seen. What was measured is that the split is worth making — of 116 cut
 * packets across five pull requests, 111 had the place's own code whole — not that a satisfying
 * answer read from surroundings is safe; that is what the `guard-in-one-caller` fixture and the
 * two `runReview` cases around this rule are for. Surroundings that may belong to another
 * definition of the same name void the satisfying answer as well, because then the check that was
 * seen may not be on this path at all.
 */
export function decide(relevance: ChoiceAnswer, satisfaction: ChoiceAnswer, cut: Cut, t: Thresholds): Decision {
  const relevanceP = probabilityOf(relevance, relevance.choice);
  const choice = satisfaction.choice;
  const p = probabilityOf(satisfaction, choice);
  const answered = `Jev answered ${choice} (${fixed(p)})`;
  // Unreadable is not the same as not a path: nothing about this place was established, including
  // whether it is one. It leaves the list of paths, but the run counts it among the places it
  // could not judge, which withholds VERIFIED — otherwise a `violates` on a function too long to
  // fit would disappear and the requirement would come out verified over the rest.
  if (cut.own) {
    return { outcome: "aside", aside: "unreadable", notes: [`the place's own code was cut, so no answer about it stands (Jev answered ${relevance.choice} and ${choice})`] };
  }
  if (!PATH.has(relevance.choice)) {
    const sure = relevanceP >= t.relevance;
    return {
      outcome: "aside",
      aside: sure ? "not_a_path" : "unsure",
      notes: [`Jev called this ${relevance.choice} (${fixed(relevanceP)}), not a path the requirement holds or fails on${sure ? "" : `, but only at ${fixed(relevanceP)} — below judgment.relevance_probability ${fixed(t.relevance)}`}`],
    };
  }
  if (relevanceP < t.relevance) {
    return { outcome: "aside", aside: "unsure", notes: [`Jev called this a path (${relevance.choice}) only at ${fixed(relevanceP)}, below judgment.relevance_probability ${fixed(t.relevance)}`] };
  }
  switch (choice) {
    case "violates":
      if (cut.context || cut.ambiguous) return { outcome: "unknown", notes: [`${answered}, but the evidence around it was cut and the missing part could hold the check`] };
      if (p < t.violation) return { outcome: "unknown", notes: [`${answered}, below judgment.violation_probability ${fixed(t.violation)}`] };
      // A violation rests on two answers, that this code is a path the requirement governs and that
      // it fails there, and both are held to the violation bar. Measured on omamori #559 (two runs,
      // the same eight requirements): places that were not violations drew `violates` at 0.80-0.87,
      // and were called paths at 0.50-0.62 (a CI script checking the README among them). Real
      // violations on the fixtures were called paths at 0.98-0.99.
      if (relevanceP < t.violation) {
        return { outcome: "unknown", notes: [`${answered}, but Jev called this code a path (${relevance.choice}) only at ${fixed(relevanceP)}, below judgment.violation_probability ${fixed(t.violation)}`] };
      }
      return { outcome: "violates", notes: [] };
    case "satisfies":
      if (cut.ambiguous) return { outcome: "unknown", notes: [`${answered}, but the name is defined more than once and the surroundings shown may be the other definition's`] };
      if (p < t.satisfaction) return { outcome: "unknown", notes: [`${answered}, below judgment.satisfaction_probability ${fixed(t.satisfaction)}`] };
      return { outcome: "satisfies", notes: [] };
    default:
      // Called a path the requirement governs, and then not answered about: `not_applicable` and
      // `insufficient_evidence` both leave the path undecided.
      return { outcome: "unknown", notes: [answered] };
  }
}

/**
 * A requirement's status over the places judged to be its paths. VERIFIED is a claim about those
 * paths and nothing else — `scope` says how many they were of how many places were found, what was
 * set aside, and what the search did not follow — and it is withheld outright only for a reason in
 * `blocking` (a path the search knows by name and never judged, an edit to this tool's own
 * configuration or workflow).
 */
export function aggregate(requirementId: string, candidates: CandidateResult[], scope: Omit<Scope, "found" | "judged" | "paths" | "setAside">, found: number): RequirementResult {
  const paths = candidates.filter((c) => c.outcome !== "aside");
  const count = (o: CandidateOutcome) => paths.filter((c) => c.outcome === o).length;
  const notes: string[] = [];
  // A place whose own code could not be read was judged about nothing, not judged irrelevant, so
  // it counts with what the run could not judge. Derived here rather than by the caller: this is
  // where a status is decided, and a caller that forgot would verify over the rest in silence.
  const unreadable = candidates.filter((c) => c.aside === "unreadable").length;
  const blocking = unreadable > 0 ? [...scope.blocking, `${unreadable} place(s) could not be read in full, so no answer about them stands`] : scope.blocking;
  const full: Scope = { ...scope, blocking, found, judged: candidates.length, paths: paths.length, setAside: candidates.length - paths.length };
  let status: Status;
  if (count("violates") > 0) status = "violation";
  else if (paths.length === 0) {
    status = "unknown";
    notes.push(candidates.length === 0 ? "No place this requirement applies to was found." : `None of the ${candidates.length} place(s) judged was called a path of this requirement.`);
  } else if (count("unknown") > 0) status = "unknown";
  else status = full.blocking.length > 0 ? "unknown" : "verified";
  // Every reason, whatever the status. Listing them only where they were the deciding one told a
  // reader that an undecided place was the whole story, when four more things also had to change.
  if (status !== "violation") {
    for (const blocker of full.blocking) notes.push(`VERIFIED is withheld: ${blocker}.`);
    const undecided = count("unknown");
    if (undecided > 0) notes.push(`VERIFIED is withheld: ${undecided} of ${paths.length} path(s) came back undecided.`);
  }

  let coverage: Coverage;
  if (candidates.length === 0) coverage = "none";
  else if (full.blocking.length > 0 || full.unjudged.length > 0 || full.judged < found || count("unknown") * 2 > paths.length) coverage = "weak";
  else if (count("unknown") > 0 || full.notFollowed.length > 0) coverage = "partial";
  else coverage = "full";

  return { requirementId, status, coverage, scope: full, candidates, notes };
}

export function verdictOf(requirements: RequirementResult[], policy: { fail_on: string[]; unknown: "warn" | "fail" }): { verdict: Verdict; exitCode: ReviewReport["exitCode"] } {
  if (requirements.some((r) => r.status === "violation")) return { verdict: "violation", exitCode: policy.fail_on.includes("violation") ? EXIT.violation : EXIT.ok };
  if (requirements.some((r) => r.status === "unknown")) return { verdict: "unknown", exitCode: policy.unknown === "fail" ? EXIT.incomplete : EXIT.ok };
  return { verdict: "no_violation_found", exitCode: EXIT.ok };
}
