// The question that asks Jev which form a requirement's sentence has, and the rule that reads the
// answer, are the run's now (`src/plan/forms.ts`, ADR 0008): each form carries what its sentence
// says, and the question is assembled from the forms. This bench measured them first, and re-exports
// them so its log, its scorer and its tests read the same objects the run sends. The hash of the
// question recorded in `bench/logs/form-choice-v1.json` is held to that object by `test/forms.test.ts`.

import { createHash } from "node:crypto";
import { FORM_QUESTION, type FormChoice } from "../../../src/plan/forms.ts";

export { chooseForm, FORM_QUESTION, type FormChoice } from "../../../src/plan/forms.ts";
export type FormChoiceBy = FormChoice["by"];

export const QUESTION_HASH = createHash("sha256").update(JSON.stringify(FORM_QUESTION)).digest("hex");

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
