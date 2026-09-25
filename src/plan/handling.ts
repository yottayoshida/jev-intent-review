// The observation question of `failure_handling` (#85): what a function does with a failure it is
// given — returns it, leaves a trace of it, or goes on as if nothing had failed.
//
// The assumption is `failure_propagation`'s, word for word (`conditionFor`, `preamble`): an event in
// the world, this call returns an error, and nothing about what the function should do (ADR 0020).
// Only the question after it and the four answers are this form's. The words were sent as they are
// here before the form was wired (`bench/handling/`), and `test/handling.test.ts` holds the probe's
// question to them.

import type { Questions } from "../judgments/provider.ts";
import type { CallCandidate, FunctionCandidate } from "./candidates.ts";
import type { Condition } from "./local-check.ts";
import { preamble } from "./local-check.ts";
import type { MappingAnswer } from "./mapping.ts";

export const HANDLING_KEY = "on_error_handling";

export const HANDLING_CRITERIA = {
  propagates: "It returns the failure to its caller: the caller receives an error, not a success.",
  reports_locally: "It does not return the failure, but leaves a trace of it: it writes the failure to a log, a warning or standard error, records it, or returns a value the caller can tell apart from a success.",
  continues_silently: "It leaves no trace of the failure: it goes on, or returns a success, as if the operation had succeeded. An empty, absent or default value the caller cannot tell from a success, with nothing logged or recorded, is this.",
  cannot_determine: "The code shown does not settle which of those three the function does under that condition.",
} as const;

export const handlingQuestionsFor = (c: Condition) =>
  ({
    [HANDLING_KEY]: {
      type: "choice",
      instructions: `${preamble(c)} Under that condition: what does \`${c.target}\` do with that failure? Not what any function under \`evidence.related\` does — what \`${c.target}\` does with it.`,
      criteria: HANDLING_CRITERIA,
    },
  }) as const;

/** What the mapping asks the requirement to require of the call, as a stable name for the record. */
export const HANDLING_PROPERTY = "call_failure_not_turned_silently_into_success" as const;

const HANDLING_MAPPING_CRITERIA = {
  applies: "The requirement requires it. Its text asks that a failure of that operation not be turned silently into a success: returned, logged or recorded, and not left without a trace.",
  does_not_apply: "The requirement does not require it of this call. It is about some other operation, or it explicitly allows this function to carry on without a trace when this one fails.",
  unknown: "The requirement does not settle it: it neither requires that nor allows the opposite for this call.",
} as const;

export function handlingMappingFor(fn: FunctionCandidate, call: CallCandidate, expression: string): Questions {
  return {
    requirement_governs: {
      type: "choice",
      instructions:
        `\`code\` is the body of \`${fn.name}\`, and \`requirement.text\` is one requirement written for this change. ` +
        `Assume nothing about what happens at run time. The question is about the requirement's words only: ` +
        `does it require that, when the call \`${expression}\` inside \`${fn.name}\` fails, \`${fn.name}\` does not go on as if it had succeeded without leaving a trace of the failure — returning it, logging it or recording it? ` +
        `Answer about that call. A requirement about a different operation, or one that allows this function to carry on here without a trace, does not require it.`,
      criteria: HANDLING_MAPPING_CRITERIA,
    },
  };
}

export function handlingWhyListed(target: string, mapping: MappingAnswer, observation: string, observed: number): string {
  return (
    `Jev answered \`${mapping.verdict}\` (${mapping.probability.toFixed(2)}) when asked whether the requirement requires that this call's failure not be turned silently into a success, ` +
    `and \`${observation}\` (${observed.toFixed(2)}) when asked what \`${target}\` does with that failure. ` +
    `Both are Jev's readings and neither checks the other.`
  );
}
