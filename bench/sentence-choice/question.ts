// The one question the sentence-choice bench puts to Jev (#40, part 2), and what it is shown.
//
// The four options are the labels' definitions word for word: the annotators read the same
// definitions and the same five fields of each unit (annotate.ts). They have a fifth label, "not a
// sentence", for a unit the splitter got wrong; Jev has no such option, and a unit so labelled that
// Jev chooses counts against it (rules.json), because the product would meet the same unit.
//
// Fixed before any label existed, and never changed after an answer was seen: a question tuned to
// the labels would measure the labels.

import { createHash } from "node:crypto";
import type { Questions } from "../../src/judgments/provider.ts";
import type { Unit } from "./units.ts";

export const DEFINITIONS = {
  required_behavior:
    "The sentence itself states a behaviour the code should have once the issue is resolved — an expected result, or a proposed change described as behaviour — that the fixed code could be checked against.",
  non_goal: "The sentence itself says what the change should not do, or what is out of its scope.",
  neither:
    "The sentence describes the problem as it is now (what happens, how to reproduce it, logs, versions, environment), gives background, asks a question, introduces something shown elsewhere (a code block, an image), or describes an implementation step without stating a behaviour.",
  cannot_tell: "It cannot be told from what is shown whether the sentence asks for a behaviour.",
} as const;

export const SENTENCE_QUESTIONS = {
  role: {
    type: "choice",
    instructions:
      "`sentence` is one sentence of the GitHub issue titled `title`. `heading` is the heading it sits under, `lead_in` the line that leads into it, and `paragraph` the paragraph it is in (either may be empty). What does `sentence` itself state?",
    criteria: DEFINITIONS,
  },
} as const satisfies Questions;

/** What Jev is shown about one unit: the same as each annotator is shown, and nothing else. */
export function stateOf(unit: Unit): { title: string; heading: string; lead_in: string; paragraph: string; sentence: string } {
  return { title: unit.title, heading: unit.heading, lead_in: unit.leadIn, paragraph: unit.paragraph, sentence: unit.sentence };
}

export const QUESTION_HASH = createHash("sha256").update(JSON.stringify(SENTENCE_QUESTIONS)).digest("hex").slice(0, 12);
