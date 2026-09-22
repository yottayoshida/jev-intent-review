// The one rule that turns two answers about a call into what the report says about it
// (docs/adr/0006-question-forms-as-data.md).
//
// It is the same for every form. A form says which observation answers go against the requirement
// and which keep it — as sets of answer names, not as code — and this reads them. Nothing here
// knows what any form asks, and nothing here may: a rule that looked at which form it was reading
// would be a second rule.
//
// What comes out is a reading of one call, not a requirement verdict.

/** One call, read: held against the requirement, kept by it, not settled, or not required of. */
export type Outcome = "satisfies" | "violates" | "unknown" | "aside";

export const OUTCOMES: readonly Outcome[] = ["violates", "satisfies", "unknown", "aside"];

/** An answer as the rule reads it. Absent is no answer: none came back, or the request failed. */
export interface Reading {
  choice: string;
  probability: number;
}

/** What a form contributes to the rule: the names of the observation answers on each side. */
export interface Sides {
  violates: readonly string[];
  keeps: readonly string[];
}

/** The bar each answer has to clear. The run passes the mapping's and the observation's, as each is fixed. */
export interface Bars {
  mapping: number;
  observation: number;
}

/**
 * The rule.
 *
 * - The mapping says `applies` at or above its bar: the observation decides. Its violating answer
 *   at or above its bar is `violates`, its keeping answer at or above its bar is `satisfies`, and
 *   anything else — `cannot_determine`, a number under the bar, no answer — is `unknown`.
 * - The mapping says `does_not_apply` at or above its bar: `aside`, whatever the observation said.
 * - Anything else from the mapping — `unknown`, a number under the bar, no answer — is `unknown`.
 */
export function outcomeOf(mapping: Reading | undefined, observation: Reading | undefined, sides: Sides, bars: Bars): Outcome {
  if (!mapping || mapping.probability < bars.mapping) return "unknown";
  if (mapping.choice === "does_not_apply") return "aside";
  if (mapping.choice !== "applies") return "unknown";
  if (!observation || observation.probability < bars.observation) return "unknown";
  if (sides.violates.includes(observation.choice)) return "violates";
  if (sides.keeps.includes(observation.choice)) return "satisfies";
  return "unknown";
}
