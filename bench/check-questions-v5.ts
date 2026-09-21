// Version 5: the same question, with how the failure happens taken out of the template.
//
// **Why there is a v5 at all.** `docs/frozen-spec-v1.md` froze v4 as the spec the comparison would
// use. The first two requirements picked for that comparison broke it before a single request was
// sent: v4's template hard-codes `… returns … at one iteration` and takes a `finite` field, which
// are an iterator's shape. Both new targets fail on one call —
// `read_to_string_capped(&path, …)?` — and there is no iteration to speak of.
//
// So the frozen template did not travel to the first new kind of failure propagation it met. That
// is a result about the spec, not a problem to be worded around, and it is why this file exists
// rather than `occurrence` being smuggled into v4.
//
// What changes: `occurrence` ("At one iteration" / "When it is called") and `extra` (anything else
// that has to hold, empty when there is nothing) are data. What does not: the options, `MEANING`,
// `verdictOfV3`, the bar, and the three things v4 added — the target is named, the related entries
// are given a role, and the answer is the target's return value and not a dependency's.
//
// **v4's numbers are not v5's.** The wording differs, so the case v4 was measured on is measured
// again here rather than carried over.

import { CONTROL_CRITERIA_V3, RESULT_CRITERIA_V3 } from "./check-questions-v3.ts";

export interface ConditionV5 {
  /** The function the answer is about. */
  target: string;
  /** What is already true when the failing operation is reached. */
  setup: string;
  /** How the failure arises, e.g. "At one iteration" or "When it is called". */
  occurrence: string;
  /** What fails, e.g. "the iterator `entries`" or "`read_to_string_capped(&path, …)`". */
  operation: string;
  /** What it returns then, e.g. "`Err(io_error)`". The question's input, never its answer. */
  yields: string;
  /** e.g. "Every other operation the function reaches succeeds." */
  others: string;
  /** Anything else that has to hold. Empty when there is nothing — an iterator's finiteness, say. */
  extra: string;
}

const preamble = (c: ConditionV5) =>
  `\`code\` is the body of \`${c.target}\`. The entries under \`evidence.related\` are other code it may call, given so that what those calls do can be worked out; they are not what this question is about. ` +
  `Assume exactly this and nothing else: ${c.setup} ${c.occurrence}, ${c.operation} returns ${c.yields}. ${c.others}${c.extra ? ` ${c.extra}` : ""}`;

export const questionsV5 = (c: ConditionV5) =>
  ({
    on_error_result: {
      type: "choice",
      instructions: `${preamble(c)} Under that condition: what does \`${c.target}\` return to its caller? Not what any function under \`evidence.related\` returns — what \`${c.target}\` does with it.`,
      criteria: RESULT_CRITERIA_V3,
    },
    on_error_control: {
      type: "choice",
      instructions: `${preamble(c)} Under that condition: what does \`${c.target}\` do after that?`,
      criteria: CONTROL_CRITERIA_V3,
    },
  }) as const;
