// The question the probe of #82's first approach sent (ADR 0019, not adopted): whether the code sent
// settles an answer. It was in src/plan/forms.ts at 131e218, where the probe's log was taken
// (`bench/logs/evidence-settles-probe-v1.json`, whose `questionsHash` is that commit's); it is kept
// here word for word, because the log is about these words, and nothing in src sends it.
// `plan.json` (and the line of `probe.ts` that wrote it) says "ADR 0017": the number this ADR had
// before main took 0017 for #80 and 0018 for #84; it is 0019 now. The file is what the log's sha256 is of, so it is left as written.

import { redact } from "../../src/evidence/redact.ts";
import type { Questions } from "../../src/judgments/provider.ts";
import type { CallCandidate, FunctionCandidate } from "../../src/plan/candidates.ts";
import { conditionFor } from "../../src/plan/local-check.ts";
import type { RequirementForm } from "../../src/types.ts";

export const EVIDENCE_KEY = "evidence_settles";
export const SETTLED = "settled_by_code_sent";
export const NOT_SENT = "turns_on_code_not_sent";

const named = (call: CallCandidate) => redact(call.expression).text.replace(/`/g, "");

/** The form's case without "every other operation succeeds": `words.case` at 131e218. */
function caseOf(form: RequirementForm, fn: FunctionCandidate, call: CallCandidate): string {
  if (form === "check_before_action") return `\`${fn.name}\` is called in a case where the requirement says \`${named(call)}\` must not be made, because the check it asks for does not pass.`;
  const c = conditionFor(fn, call);
  return `${c.setup} ${c.occurrence}, ${c.operation} returns ${c.yields}.`;
}

export function evidenceQuestion(form: RequirementForm, fn: FunctionCandidate, call: CallCandidate): Questions {
  return {
    [EVIDENCE_KEY]: {
      type: "choice",
      instructions:
        `\`code\` is the body of \`${fn.name}\`. Only what is shown here was sent: a function \`code\` calls was sent only if its body is under \`evidence.related\`, which may be empty. ` +
        `Take this case: ${caseOf(form, fn, call)} ` +
        `In that case, can what \`${fn.name}\` does about the call \`${named(call)}\` — what it returns, or whether it goes on to make the call — be worked out from what was sent?`,
      criteria: {
        [SETTLED]: "Yes. Every function it turns on was sent, or what that function does in this case is fixed by the case above or by the language and its standard library.",
        [NOT_SENT]: "No. It turns on what a function that was not sent returns or does, and the case above does not fix it.",
        cannot_determine: "It cannot be told from what was sent whether it does.",
      },
    },
  };
}
