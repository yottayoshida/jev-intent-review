// The observation question of `failure_handling` (#85): what a function does with a failure it is
// given — returns it, leaves a trace of it, or goes on as if nothing had failed.
//
// The assumption is `failure_propagation`'s, word for word (`conditionFor`, `preamble`): an event in
// the world, this call returns an error, and nothing about what the function should do (ADR 0020).
// Only the question after it and the four answers are this form's. The words were sent as they are
// here before the form was wired (`bench/handling/`), and `test/handling.test.ts` holds the probe's
// question to them.

import type { Condition } from "./local-check.ts";
import { preamble } from "./local-check.ts";

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
