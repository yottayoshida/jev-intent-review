// The question that asks Jev which form a requirement's sentence has, and the rule that reads the
// answer (ADR 0008). The run does not send this question; this bench measures it first. If the
// owner decides to let Jev choose, `SAYS` moves onto each form as its own criterion and the question
// is assembled from the forms — the hash of the question recorded in the log is what shows the
// moved text is the measured text.

import { createHash } from "node:crypto";
import type { Questions } from "../../../src/judgments/provider.ts";
import { DEFAULT_FORM } from "../../../src/plan/forms.ts";
import { BAR } from "../../../src/plan/local-check.ts";
import { REQUIREMENT_FORMS, type ChoiceAnswer, type RequirementForm } from "../../../src/types.ts";

/** What a sentence of each form says, as the criterion Jev reads. */
export const SAYS: Readonly<Record<RequirementForm, string>> = {
  failure_propagation:
    "The sentence says what must happen when an operation fails: the failure must reach the caller as an error, and must not be returned as a success, an empty value or an absence.",
  check_before_action:
    "The sentence says that an operation must not be performed unless a check passes, or must never be performed in some case, and it names the operation.",
};

/** Not a form: the option for every other sentence. */
export const NEITHER = "The sentence says something else: what a feature does or shows, what an output contains, what stays the same, a limit on data or an interface, or a task to do.";

export const FORM_QUESTION: Questions = {
  requirement_form: {
    type: "choice",
    instructions: "`requirement.text` is one requirement written for a change to a program. Which of these does its sentence say? Read its words only; assume nothing about the program.",
    criteria: { ...SAYS, neither: NEITHER },
  },
};

export const QUESTION_HASH = createHash("sha256").update(JSON.stringify(FORM_QUESTION)).digest("hex");

export type FormChoiceBy = "jev" | "default";

export interface FormChoice {
  form: RequirementForm;
  by: FormChoiceBy;
  /** Jev's choice as given, `no_answer` when there was none. */
  verdict: string;
  probability: number;
}

/**
 * The rule, fixed before the measurement: a form's option at the bar or above is that form;
 * `neither`, an answer under the bar, or no answer is the default.
 */
export function chooseForm(answer: ChoiceAnswer | undefined): FormChoice {
  if (!answer) return { form: DEFAULT_FORM, by: "default", verdict: "no_answer", probability: 0 };
  const named = (REQUIREMENT_FORMS as readonly string[]).includes(answer.choice);
  if (named && answer.probability >= BAR) return { form: answer.choice as RequirementForm, by: "jev", verdict: answer.choice, probability: answer.probability };
  return { form: DEFAULT_FORM, by: "default", verdict: answer.choice, probability: answer.probability };
}

export type Label = "failure_propagation" | "check_before_action" | "neither";

/**
 * A fixed keyword rule, scored beside Jev for scale and used by nothing: the check words are
 * tried first, since a check sentence can say what happens when a check "failed".
 */
export function keywordForm(text: string): Label {
  const t = text.toLowerCase();
  if (/\bmust not\b|\bnever\b|\bunless\b/.test(t)) return "check_before_action";
  if (/\bfail|\berror/.test(t)) return "failure_propagation";
  return "neither";
}
