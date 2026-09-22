// How a typed answer's number is read. The decision rules that used to live here — relevance and
// satisfaction into an outcome, outcomes into a requirement's status, statuses into a verdict —
// went with the generic run (ADR 0007). What is left is the one reading every remaining question
// shares.

import type { ChoiceAnswer } from "../types.ts";

/** The probability of `choice`: the answer's own when it is the choice, else from the distribution. */
export function probabilityOf(answer: ChoiceAnswer, choice: string): number {
  if (answer.choice === choice) return answer.probability;
  return answer.probabilities[choice] ?? 0;
}
