/** The bar an answer has to clear to count. The experiment's value, not a product guarantee. */
export const BAR = 0.6;

// The questions Jev is asked, what its answers mean, and the rule that turns them into a verdict.
//
// One copy, imported by every case set. A second set that had to reword a question would be a
// different plan, and the point of applying it to a second pull request is that it does not.

export const QUESTIONS = {
  on_error_control: {
    type: "choice",
    instructions: "`code` is one function that walks an iterator whose items are each either a value or an error. Take the case where one item is an error. What does the function do with the items after it?",
    criteria: {
      stops_there: "It stops at that item; the ones after it are never taken from the iterator",
      keeps_going: "It goes on taking the items after it",
      cannot_determine: "The code does not say what happens to the items after an error",
    },
  },
  on_error_result: {
    type: "choice",
    instructions: "Still `code`, still the case where one item is an error. What does the function return to its caller?",
    criteria: {
      an_error: "A failure — whatever the caller does with it, it is not a successful list",
      a_success_with_what_it_had: "A success carrying the items it managed to take, without the failure",
      a_success_with_nothing: "A success carrying no items",
      cannot_determine: "The code does not say what is returned when an item is an error",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// The same questions with the condition stated. One template, filled from per-case data.
//
// `QUESTIONS` above leaves the condition to the reader ("the case where one item is an error"),
// which `local-check-propagation.ts` measured going wrong on a loop that has two kinds of failure.
// `statedQuestions` names the operation and the value it yields instead. The criteria are the ones
// above, verbatim, so `MEANING` and `verdictOf` decide exactly as before: the only thing that
// varies between the two sets is the `instructions` string.
//
// Nothing in `Condition` says what the function should do with the error. `yields` is the
// operation's returned value — the question's input, not its answer.
// ---------------------------------------------------------------------------

export interface Condition {
  /** What is already true when the loop is reached, e.g. "The file has been opened successfully." */
  setup: string;
  /** The operation whose items are each a value or an error, e.g. "`reader.lines()`". */
  iterator: string;
  /** What that operation returns at one iteration, e.g. "`Err(io_error)`". */
  yields: string;
  /** e.g. "Every other operation the function reaches succeeds." */
  others: string;
  /** e.g. "The iterator is finite." */
  finite: string;
}

const ask = (c: Condition, question: string) =>
  `Read \`code\`. Assume exactly this and nothing else: ${c.setup} ${c.iterator} returns ${c.yields} at one iteration. ${c.others} ${c.finite} Under that condition: ${question}`;

export const statedQuestions = (c: Condition) =>
  ({
    on_error_control: {
      type: "choice",
      instructions: ask(c, "what does the function do with the items the iterator would yield after that one?"),
      criteria: QUESTIONS.on_error_control.criteria,
    },
    on_error_result: {
      type: "choice",
      instructions: ask(c, "what does the function return to its caller?"),
      criteria: QUESTIONS.on_error_result.criteria,
    },
  }) as const;

/**
 * What an answer means for the property, and why. Only the result answer decides: a function that
 * reads to the end and then fails still never returns the failed listing as a success, so the
 * property this plan covers holds for it. Whether the requirement separately demands stopping at
 * the first error is in `notCovered` — this plan does not read that, either way.
 */
export const MEANING = {
  an_error: { property: "holds" as const, why: "the failed enumeration does not leave the function as a success" },
  a_success_with_what_it_had: { property: "breaks" as const, why: "the entries taken before the error are returned as though the listing were complete" },
  a_success_with_nothing: { property: "breaks" as const, why: "an enumeration that failed is returned as an empty listing" },
  cannot_determine: { property: "undecided" as const, why: "the code shown does not say what is returned" },
};


// ---------------------------------------------------------------------------
// Aggregation: the code decides, from the mapping above and nothing else.
// ---------------------------------------------------------------------------

export interface Local {
  question: string;
  choice: string;
  probability: number;
  counted: boolean; // cleared the bar
}

export function verdictOf(locals: Local[]): { verdict: "violation" | "covered_holds" | "unknown"; why: string } {
  const result = locals.find((l) => l.question === "on_error_result");
  if (!result || !result.counted) return { verdict: "unknown", why: `the result answer did not clear ${BAR} (${result?.choice ?? "none"} ${result?.probability.toFixed(2) ?? "-"})` };
  const meaning = MEANING[result.choice as keyof typeof MEANING];
  if (!meaning) return { verdict: "unknown", why: `no meaning is written for the answer ${result.choice}` };
  if (meaning.property === "breaks") return { verdict: "violation", why: meaning.why };
  if (meaning.property === "holds") return { verdict: "covered_holds", why: meaning.why };
  return { verdict: "unknown", why: meaning.why };
}

