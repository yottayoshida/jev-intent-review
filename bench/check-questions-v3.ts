// Version 3 of the local check questions: the returned result, as three options that do not
// overlap.
//
// Version 2 (`statedQuestions` in `local-check-plan.ts`) offered `an_error`,
// `a_success_with_what_it_had`, `a_success_with_nothing` and `cannot_determine`. Two of those are
// both successes, so an answer could be right about the property and still be scored wrong for
// picking the other one — which is what happened on `listing/stops-but-succeeds` under the first
// `collect_listing` condition, where the condition did not say where in the iteration the error
// falls and `Ok([])` and `Ok([before])` are both reachable. The property under test never depended
// on which: a success is a success.
//
// So v3 asks only what version 2's aggregation actually read:
//
//   returns_error / returns_success / cannot_determine
//
// Version 2 is left exactly as it was, and its numbers are not this version's numbers. A question
// set is a contract; changing the options changes what an answer means, so nothing measured under
// v2 carries over and the regression cases in `bench/real-requirement-check.ts` re-measure it.
//
// The control question is kept, with the same condition, and is **diagnostic only**: `verdictOf`
// below never reads it, and no weight or majority is built on it. It is here because an answer
// about what the loop does is how a reader sees whether the code was read at all — under v2 that
// answer weakened on versions that continue (25/30 once the bar is applied), and that is worth
// watching rather than dropping.

/** The bar an answer has to clear to be counted. Fixed before any measurement, as in v2. */
export const BAR_V3 = 0.6;

/**
 * The condition, as data. A fixed template below fills it, so the wording is the same for every
 * target and only these fields vary.
 *
 * Nothing here says what the function should do with the error: `yields` is the operation's
 * returned value, which is the question's input. `setup` states what is true when the enumeration
 * is reached and never describes a value the function changes — under v2 a `setup` that said
 * "`seen` is empty" read as a claim about the moment of the error, which it is not.
 */
export interface ConditionV3 {
  /** What is already true when the enumeration is reached. */
  setup: string;
  /** The operation whose items are each a value or an error, e.g. "`entries`". */
  operation: string;
  /** What that operation returns at one iteration, e.g. "`Err(io_error)`". */
  yields: string;
  /** e.g. "Every other operation the function reaches succeeds." */
  others: string;
  /** e.g. "The iterator is finite." */
  finite: string;
}

/** One template. Both questions carry the whole condition, so neither depends on the other. */
const ask = (c: ConditionV3, question: string) =>
  `Read \`code\`. Assume exactly this and nothing else: ${c.setup} ${c.operation} returns ${c.yields} at one iteration. ${c.others} ${c.finite} Under that condition: ${question}`;

/**
 * Exclusive. A success is a success whether it carries a complete result, a partial one or
 * nothing, and whether it is a list, a struct or a count — the property is about failure against
 * success, and the shape of the success value is not part of it.
 */
export const RESULT_CRITERIA_V3 = {
  returns_error: "A failure. Whatever the caller does with it, the function did not return a success.",
  returns_success: "A success. Whatever that success carries — a complete result, a partial one, or nothing — it is a success and not a failure.",
  cannot_determine: "The code shown does not settle which of those two the function returns under that condition.",
} as const;

/** Diagnostic only. Nothing below reads these answers. */
export const CONTROL_CRITERIA_V3 = {
  stops_there: "It stops at that item; the ones after it are never taken from the iterator",
  keeps_going: "It goes on taking the items after it",
  cannot_determine: "The code does not say what happens to the items after an error",
} as const;

export const questionsV3 = (c: ConditionV3) =>
  ({
    on_error_result: {
      type: "choice",
      instructions: ask(c, "what does the function return to its caller?"),
      criteria: RESULT_CRITERIA_V3,
    },
    on_error_control: {
      type: "choice",
      instructions: ask(c, "what does the function do with the items the iterator would yield after that one?"),
      criteria: CONTROL_CRITERIA_V3,
    },
  }) as const;

export type ResultChoice = keyof typeof RESULT_CRITERIA_V3;

/** What a result answer means for the property. The only mapping the verdict uses. */
export const MEANING_V3: Record<ResultChoice, { property: "holds" | "breaks" | "undecided"; why: string }> = {
  returns_error: { property: "holds", why: "the failed enumeration does not leave the function as a success" },
  returns_success: { property: "breaks", why: "an enumeration that failed is returned as a success" },
  cannot_determine: { property: "undecided", why: "the code shown does not settle what is returned" },
};

export type Verdict = "property_holds" | "property_breaks" | "unknown";

export interface Scored {
  /** The answer named the behaviour the code actually has. */
  choiceMatch: boolean;
  /** …and cleared the bar, so the plan would be entitled to use it. Never the same number. */
  counted: boolean;
  probability: number;
}

/**
 * The two are recorded apart on purpose: under v2, two runs named the right behaviour at 0.51,
 * which is a match the plan may not act on. Collapsing them would have shown 27/30 where 25/30 was
 * true.
 */
export function score(choice: string, probability: number, expected: string): Scored {
  const choiceMatch = choice === expected;
  return { choiceMatch, counted: choiceMatch && probability >= BAR_V3, probability };
}

/** The verdict reads the result answer and nothing else — not the control, not the confidence. */
export function verdictOfV3(choice: string | undefined, probability: number): { verdict: Verdict; why: string } {
  if (choice === undefined) return { verdict: "unknown", why: "there is no result answer" };
  if (probability < BAR_V3) return { verdict: "unknown", why: `the result answer did not clear ${BAR_V3} (${choice} ${probability.toFixed(2)})` };
  const meaning = MEANING_V3[choice as ResultChoice];
  if (!meaning) return { verdict: "unknown", why: `no meaning is written for the answer ${choice}` };
  if (meaning.property === "breaks") return { verdict: "property_breaks", why: meaning.why };
  if (meaning.property === "holds") return { verdict: "property_holds", why: meaning.why };
  return { verdict: "unknown", why: meaning.why };
}

/**
 * Whether the evidence can answer the question at all, decided locally and before any request.
 *
 * `cut.own` is the function's own body being short of what is there: an answer about what it
 * returns would be about code nobody sent. No model probability lifts that, and asking anyway
 * spends a request on a question whose answer cannot be used, so the run does not ask.
 *
 * `cut.context` and `cut.ambiguous` are not grounds to withhold the question here: the first can
 * only hide a check in the surroundings and the second is about which definition of a name was
 * taken, and neither removes the target's own body.
 */
export function canAnswerLocally(cut: { own: boolean; context: boolean; ambiguous: boolean }, bodyFound: boolean): { send: boolean; reason?: string } {
  if (!bodyFound) return { send: false, reason: "the target function's body was not found at the pinned commit" };
  if (cut.own) return { send: false, reason: "the target function's own body did not fit in the evidence packet (cut.own)" };
  return { send: true };
}
