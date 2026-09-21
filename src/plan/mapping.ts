// Whether a requirement requires anything of a particular call — asked of Jev, as a typed choice.
//
// This was the most Jev-shaped question in the tool and it was the one sent elsewhere. The answer
// is three options with fixed criteria; that is exactly what Jev returns, with a probability for
// each. Routing it to a general instruct model bought a free-text quote and a free-text reason,
// and cost the thing the rest of this path is built on: a number, and a bar fixed before the
// measurement.
//
// What that model was giving is not lost, it is taken from somewhere better:
//
//   - the **quote** is the requirement itself, copied from the input. A model choosing which
//     fragment to quote was the only reason a quote had to be checked against the text at all.
//   - the **reason** is assembled from what the run already knows — the requirement, the call, the
//     condition assumed, the two answers — rather than written. Nothing in the report is model
//     prose, so nothing in it has to be contained.
//
// And one class of defect stops existing rather than being checked: there is no call id in the
// answer to come back wrong. Jev answers the question it was sent, about the state it was sent.

import type { ChoiceAnswer } from "../types.ts";
import type { Questions } from "../judgments/provider.ts";
import { BAR } from "./local-check.ts";
import type { CallCandidate, FunctionCandidate } from "./candidates.ts";

/**
 * The only property this asks about, for now.
 *
 * It is the one the local check can observe: `#18`–`#23` settled its wording, and `#27` measured
 * that the observation tracks what the program does. A second property would need its own
 * question and its own measurement.
 */
export const MAPPING_PROPERTY = "call_failure_not_returned_as_success" as const;

export type MappingVerdict = "applies" | "does_not_apply" | "unknown";

/**
 * The bar a mapping has to clear to be acted on: the same 0.6 the observation clears, fixed here
 * before any measurement has been taken with it.
 */
export const MAPPING_BAR = BAR;

export const MAPPING_CRITERIA: Record<MappingVerdict, string> = {
  applies: "The requirement requires it. Its text asks that a failure of that operation not reach the caller as a success.",
  does_not_apply:
    "The requirement does not require it of this call. It is about some other operation, or it explicitly allows this function to carry on when this one fails.",
  unknown: "The requirement does not settle it: it neither requires that nor allows the opposite for this call.",
};

/**
 * The question, about the packet the observation is built from.
 *
 * Deliberately **not** in the same request as the observation: the observation is asked under an
 * assumed failure, and this one must not assume it. What the requirement asks of a call is a fact
 * about the sentence, and it is settled without knowing what the code does.
 */
export function mappingQuestionFor(fn: FunctionCandidate, call: CallCandidate, expression: string): Questions {
  return {
    requirement_governs: {
      type: "choice",
      instructions:
        `\`code\` is the body of \`${fn.name}\`, and \`requirement.text\` is one requirement written for this change. ` +
        `Assume nothing about what happens at run time. The question is about the requirement's words only: ` +
        `does it require that, when the call \`${expression}\` inside \`${fn.name}\` fails, \`${fn.name}\` does not return a success to its caller? ` +
        `Answer about that call. A requirement about a different operation, or one that allows this function to carry on here, does not require it.`,
      criteria: MAPPING_CRITERIA,
    },
  };
}

export interface MappingAnswer {
  verdict: MappingVerdict | "no_answer";
  probability: number;
  /** Every option's probability as Jev gave it, so a reading near the bar can be re-read later. */
  probabilities: Record<string, number>;
  /** Whether the run acts on it: `applies`, at or above the bar. */
  governs: boolean;
}

/** The rule, in one place, fixed before the measurement it will be read with. */
export function acceptMapping(answer: ChoiceAnswer | undefined): MappingAnswer {
  if (!answer) return { verdict: "no_answer", probability: 0, probabilities: {}, governs: false };
  const verdict = (Object.hasOwn(MAPPING_CRITERIA, answer.choice) ? answer.choice : "unknown") as MappingVerdict;
  const probability = answer.probability;
  return { verdict, probability, probabilities: { ...answer.probabilities }, governs: verdict === "applies" && probability >= MAPPING_BAR };
}

/**
 * Why a call is listed, built from the parts rather than written.
 *
 * Every clause names where it came from — the requirement's words, the assumed condition, the two
 * answers — so a reader can check each half separately. Nothing here is a model's sentence, and
 * nothing here claims the requirement is violated.
 */
export function whyListed(target: string, mapping: MappingAnswer, observation: string, observed: number): string {
  return (
    `Jev answered \`${mapping.verdict}\` (${mapping.probability.toFixed(2)}) when asked whether the requirement requires this call's failure not to reach the caller as a success, ` +
    `and \`${observation}\` (${observed.toFixed(2)}) when asked what \`${target}\` returns under that failure. ` +
    `Both are Jev's readings and neither checks the other.`
  );
}
