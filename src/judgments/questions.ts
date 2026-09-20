// The fixed questions (spec §17). Their wording is part of the measurement: change a sentence here
// and earlier results no longer apply, which is why the report carries QUESTIONS_HASH.
//
// Everything that varies — the requirement, the code, the pull request's text — goes into
// `state`, never into these instructions.

import { createHash } from "node:crypto";
import type { Questions } from "./provider.ts";

/** J1 + J2, asked together about one candidate (one request, two answers). */
export const CANDIDATE_QUESTIONS = {
  relevance: {
    type: "choice",
    instructions:
      "How does the code in `evidence.code` relate to `requirement`? `evidence.related` only shows how that code is reached.",
    criteria: {
      directly_enforces: "The code itself performs the check or behavior that `requirement` asks for",
      may_violate:
        "The code performs, or leads straight to, an action that `requirement` restricts or governs, or hands the ability to perform it to other code (a callback, plugin or dynamically loaded module), so whether the requirement holds depends on this code",
      supporting:
        "The code is a definition, helper, constant or test that the requirement's behavior uses, but not itself a path on which the requirement can hold or fail",
      unrelated: "The code has nothing to do with `requirement`",
      cannot_tell: "The evidence is too incomplete to tell how the code relates to `requirement`",
    },
  },
  satisfaction: {
    type: "choice",
    instructions:
      "Judging only from `evidence`, does this code path meet `requirement`? A required check counts when it runs on this path before the governed action, whether it is in `evidence.code` or in a caller, route or middleware shown in `evidence.related`.",
    criteria: {
      satisfies: "The evidence shows the required check or behavior happens on this path",
      violates:
        "The path performs the governed action, and neither `evidence.code` nor `evidence.related` shows the required check or behavior on this path",
      insufficient_evidence:
        "Whether the path meets `requirement` depends on code that `evidence` does not show, including code this path hands the governed action to (a callback, plugin or dynamically loaded module)",
      not_applicable: "`requirement` does not apply to this code",
    },
  },
} as const satisfies Questions;

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

/**
 * J5: a search-quality signal only; never read as proof that the search was complete. It is asked
 * only where the answer can change the outcome — a requirement whose every path is satisfied — and
 * it now sees what the search left as well as what it found, because that is what the question is
 * about. Until this build no run ever reached the point of asking it on real code.
 */
export const COMPLETENESS_QUESTIONS = {
  completeness: {
    type: "choice",
    instructions:
      "`found` lists the code locations judged to be paths of `requirement`, and `not_looked_at` says how much the search left: places found and not judged, places set aside as not paths, and leads it did not follow. Does `found` look like it covers the kinds of places the requirement names?",
    criteria: {
      likely_complete: "Every kind of place the requirement names has at least one location in `found`, and nothing in `not_looked_at` names another kind of place it would apply to",
      likely_incomplete: "The requirement names a kind of place that has no location in `found`, or something in `not_looked_at` is one",
      cannot_tell: "It cannot be told from the requirement which places it covers",
    },
  },
} as const satisfies Questions;

export const QUESTIONS_HASH = createHash("sha256")
  .update(JSON.stringify([CANDIDATE_QUESTIONS, CHANGE_QUESTIONS, COMPLETENESS_QUESTIONS]))
  .digest("hex")
  .slice(0, 12);
