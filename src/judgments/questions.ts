// The fixed questions (spec §17). Their wording is part of the measurement: change a sentence here
// and earlier results no longer apply, which is why the report carries QUESTIONS_HASH.
//
// Everything that varies — the requirement, the code, the pull request's text — goes into
// `state`, never into these instructions.
//
// The questions the local check puts to each call are its forms' (`plan/forms.ts`, ADR 0006). The
// relevance, satisfaction and completeness questions of the generic run went with it (ADR 0007);
// they are kept with the benches that sent them, in `bench/generic/questions.ts`.

import { createHash } from "node:crypto";
import { FORMS_FINGERPRINT } from "../plan/forms.ts";
import type { Questions } from "./provider.ts";

/**
 * J4: is a change the pull request made explained by any requirement? The second option carries
 * the work a requirement brings with it. Measured over ten real pull requests before this wording:
 * of 32 changes called `unrelated`, nearly all were a test, a helper a test needs, or the comment
 * on a function the change itself added — a report of those is a report about the work, not about
 * scope creep.
 */
export const CHANGE_QUESTIONS = {
  justification: {
    type: "choice",
    instructions:
      "`change` shows code before and after the pull request. Is this change in behavior asked for by any entry in `requirements`?",
    criteria: {
      clearly_required: "An entry in `requirements` asks for exactly this change",
      plausibly_required:
        "The change is a reasonable part of carrying out an entry in `requirements`: a test of what an entry asks for, a helper or fixture such a test needs, or the comments and documentation on code that carrying out an entry added",
      unrelated:
        "No entry in `requirements` asks for or needs this change in behavior, and it is not a test, a fixture or a comment for a change an entry does ask for",
      cannot_tell: "It cannot be told from `change` what behavior changed",
    },
  },
} as const satisfies Questions;

/** Everything a run can send: the change question and the two forms' questions, as their wording is. */
export const QUESTIONS_HASH = createHash("sha256")
  .update(JSON.stringify([CHANGE_QUESTIONS, FORMS_FINGERPRINT]))
  .digest("hex")
  .slice(0, 12);
