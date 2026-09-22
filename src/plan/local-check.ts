// The local question, the condition built for it, and what an answer is allowed to mean.
//
// Moved here from the bench so the CLI and the bench ask the same thing. The wording and the rule
// are the ones `#18` and `#22`-`#23` settled:
//
//   - the target is named, and the answer is its return value and not a dependency's;
//   - the assumed result is a kind (`err`), not a sentence, so there is no field a verdict fits in;
//   - the condition carries the call **expression**, which survives a change in how the result is
//     handled and still tells two calls in one body apart;
//   - the verdict reads the result answer alone, at a bar fixed before any measurement.
//
// What an answer is *not* allowed to mean is the part that matters for a report: a local
// observation about one call is not a statement about the requirement. `describe` below keeps the
// two apart.

import { redact } from "../evidence/redact.ts";
import type { ChoiceAnswer } from "../types.ts";
import type { CallCandidate, FunctionCandidate } from "./candidates.ts";

/** The bar an answer has to clear to be acted on. Fixed before any measurement (`#13`). */
export const BAR = 0.6;

export const RESULT_CRITERIA = {
  returns_error: "A failure. Whatever the caller does with it, the function did not return a success.",
  returns_success: "A success. Whatever that success carries — a complete result, a partial one, or nothing — it is a success and not a failure.",
  cannot_determine: "The code shown does not settle which of those two the function returns under that condition.",
} as const;

/** Diagnostic only: nothing below reads these answers. */
export const CONTROL_CRITERIA = {
  stops_there: "It stops there; what comes after is not reached",
  keeps_going: "It goes on",
  cannot_determine: "The code does not say",
} as const;

export interface Condition {
  target: string;
  setup: string;
  occurrence: string;
  operation: string;
  yields: string;
  others: string;
  extra: string;
}

/**
 * The condition, built from the place rather than written by anyone.
 *
 * `setup` names the call and quotes no line: a line number and a source line are the two things a
 * change moves, and a condition has to hold across the versions being compared (`#22`).
 *
 * The expression is redacted. A request carries the packet and the questions, and only the packet
 * was being cleaned — so a call with a secret-shaped argument went out in the one field nothing
 * touched. `locateCall` searches with the same redacted text, so the two still agree, and when
 * redaction makes two calls in a body identical its uniqueness check withholds rather than
 * guessing which was meant.
 */
export function conditionFor(fn: FunctionCandidate, call: CallCandidate): Condition {
  const expression = redact(call.expression).text;
  return {
    target: fn.name,
    setup: `Execution reaches the call \`${expression}\` inside \`${fn.name}\`.`,
    occurrence: "There",
    operation: `\`${expression}\``,
    yields: "an error",
    others: "Every other operation the function reaches succeeds.",
    extra: "",
  };
}

const preamble = (c: Condition) =>
  `\`code\` is the body of \`${c.target}\`. The entries under \`evidence.related\` are other code it may call, given so that what those calls do can be worked out; they are not what this question is about. ` +
  `Assume exactly this and nothing else: ${c.setup} ${c.occurrence}, ${c.operation} returns ${c.yields}. ${c.others}${c.extra ? ` ${c.extra}` : ""}`;

export const questionsFor = (c: Condition) =>
  ({
    on_error_result: {
      type: "choice",
      instructions: `${preamble(c)} Under that condition: what does \`${c.target}\` return to its caller? Not what any function under \`evidence.related\` returns — what \`${c.target}\` does with it.`,
      criteria: RESULT_CRITERIA,
    },
    on_error_control: {
      type: "choice",
      instructions: `${preamble(c)} Under that condition: what does \`${c.target}\` do after that?`,
      criteria: CONTROL_CRITERIA,
    },
  }) as const;

/**
 * Where the call the condition names is in this body. Exactly one, or the question is withheld:
 * none means this version moved it, more than one means the condition does not say which.
 */
export function locateCall(body: string, call: CallCandidate): { ok: boolean; found: number; reason?: string } {
  if (!call.expressionComplete) return { ok: false, found: 0, reason: `the call does not close its parentheses within the scan, so it cannot be pointed at` };
  const flat = body.replace(/\s+/g, " ");
  // The body is the packet's, which is redacted; the expression is as the file has it. A call with
  // a long opaque argument matched nothing, and the reason given for withholding was "this version
  // moved it" — a true-sounding sentence about the wrong thing.
  const needle = redact(call.expression).text.replace(/\s+/g, " ");
  let found = 0;
  for (let i = flat.indexOf(needle); i >= 0; i = flat.indexOf(needle, i + 1)) found += 1;
  if (found === 0) return { ok: false, found, reason: `\`${needle}\` is not in this version of ${call.functionId}` };
  if (found > 1) return { ok: false, found, reason: `\`${needle}\` appears ${found} times here, so the condition does not say which` };
  return { ok: true, found };
}

/**
 * An observation answer's name, as the form's question offers it (`returns_success`, `reaches_it`…),
 * or `cannot_determine` for an answer under the bar, or `withheld` for none.
 */
export type Observation = string;

export interface LocalResult {
  /** What was observed about this one call, at this one place. */
  observation: Observation;
  probability: number;
  /** Every option's probability as Jev gave it, so a reading near the bar can be re-read later. */
  probabilities: Record<string, number>;
  /** Why, in the report's words. */
  why: string;
}

/**
 * The reading, with no claim about the requirement attached.
 *
 * Whether the requirement requires this of the call is a separate question, asked separately, and
 * joined to this one by the rule in `review/outcome.ts`.
 *
 * `reading` is the form's: why each answer reads as it does. An answer it has no sentence for reads
 * as its `cannot_determine`.
 */
export function describe(answer: ChoiceAnswer | undefined, probability: number, reading: Readonly<Record<string, string>>): LocalResult {
  if (!answer) return { observation: "withheld", probability: 0, probabilities: {}, why: "no answer was read" };
  const probabilities = { ...answer.probabilities };
  if (probability < BAR) return { observation: "cannot_determine", probability, probabilities, why: `the answer did not clear ${BAR} (${answer.choice} ${probability.toFixed(2)})` };
  const choice = answer.choice;
  return { observation: choice, probability, probabilities, why: reading[choice] ?? reading.cannot_determine ?? "the code shown does not settle it" };
}
