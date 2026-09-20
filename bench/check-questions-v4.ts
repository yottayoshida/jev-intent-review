// Version 4: name the function being asked about, and say what the other code is for.
//
// v3 asks `Read \`code\`. … what does the function return to its caller?` — "the function" is
// never named, and the related entries arrive with no stated role. A packet carrying
// `collect_listing`, which returns `Err`, then holds two plausible answers to "what does the
// function return" and nothing in the question says which function is meant.
//
// v4 states three things the packet leaves implicit:
//
//   - the answer is about the named target, whose body is `code`;
//   - the entries under `evidence.related` are there so that what the target's calls do can be
//     worked out — they are not the subject;
//   - the answer is the target's return value, not a dependency's.
//
// **The criteria are v3's, verbatim.** `MEANING_V3`, `verdictOfV3`, `score` and the bar are
// unchanged, so the only difference between the two versions is the `instructions` string — and
// v3's numbers are still not v4's, because the instructions are part of the contract. Both are
// measured in the same run.
//
// This version exists to be tested against a pair that no amount of re-reading one body can
// separate: the shipped target with a dependency that propagates, and the *same* shipped target
// with a dependency that swallows. Their `code` is byte-identical and the correct answers are
// opposite.

import { RESULT_CRITERIA_V3, CONTROL_CRITERIA_V3 } from "./check-questions-v3.ts";

export interface ConditionV4 {
  /** The function the answer is about, e.g. "staging_info_from". */
  target: string;
  /** What is already true when the enumeration is reached. */
  setup: string;
  /** The operation whose items are each a value or an error, e.g. "`entries`". */
  operation: string;
  /** What that operation returns at one iteration, e.g. "`Err(io_error)`". */
  yields: string;
  others: string;
  finite: string;
}

const preamble = (c: ConditionV4) =>
  `\`code\` is the body of \`${c.target}\`. The entries under \`evidence.related\` are other code it may call, given so that what those calls do can be worked out; they are not what this question is about. ` +
  `Assume exactly this and nothing else: ${c.setup} ${c.operation} returns ${c.yields} at one iteration. ${c.others} ${c.finite}`;

export const questionsV4 = (c: ConditionV4) =>
  ({
    on_error_result: {
      type: "choice",
      instructions: `${preamble(c)} Under that condition: what does \`${c.target}\` return to its caller? Not what any function under \`evidence.related\` returns — what \`${c.target}\` does with it.`,
      criteria: RESULT_CRITERIA_V3,
    },
    on_error_control: {
      type: "choice",
      instructions: `${preamble(c)} Under that condition: what does \`${c.target}\` do with the items the iterator would yield after that one?`,
      criteria: CONTROL_CRITERIA_V3,
    },
  }) as const;
