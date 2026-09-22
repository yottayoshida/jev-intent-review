// What the local check asks of a call, as data: a form (docs/adr/0006-question-forms-as-data.md).
//
// A form is five things:
//
//   1. the unit — one call in a function, for every form so far;
//   2. when a question can be put to a call;
//   3. the two typed questions: the mapping (does the requirement require this of the call) and the
//      observation (what the function does under an assumption);
//   4. which observation answers go against the requirement and which keep it — names, not code;
//   5. the report's words.
//
// What turns the answers into an outcome is not here. It is one rule (`review/outcome.ts`), the same
// for every form, and a form cannot carry a rule of its own: part 4 is two lists of answer names.
//
// `failure_propagation` is v0.1's questions, condition and words, unchanged byte for byte — the
// measurements in `docs/local-check-cli.md` were taken with them. `check_before_action` is new and
// has been measured only on the constructed cases in `bench/forms/`.

import { STOP_WORDS } from "../discovery/discover.ts";
import { redact } from "../evidence/redact.ts";
import type { Questions } from "../judgments/provider.ts";
import type { Requirement, RequirementForm } from "../types.ts";
import type { CallCandidate, FunctionCandidate } from "./candidates.ts";
import { BAR, conditionFor, questionsFor } from "./local-check.ts";
import { MAPPING_PROPERTY, mappingQuestionFor, type MappingAnswer, whyListed } from "./mapping.ts";
import type { Askability } from "./select.ts";

export const DEFAULT_FORM: RequirementForm = "failure_propagation";

export interface AskContext {
  requirement: Requirement;
  fn: FunctionCandidate;
  call: CallCandidate;
  /**
   * Whether the target and the callee return a `Result`, read from the repository.
   *
   * It depends on the commit alone, so the run decides it once and shares it. Everything else a
   * form decides can depend on the requirement, and is decided per requirement.
   */
  resultOf: (fn: FunctionCandidate, call: CallCandidate) => Promise<Askability>;
  /**
   * The function this run reads on its own that a callee resolves to — the callee has exactly one
   * definition in the repository, and it is one of the functions the change reached — or null. A
   * bare name two functions share resolves to neither: judged by the name alone, a call to the other
   * one was held for a reason that was not true of it.
   */
  readHere: (callee: string) => Promise<FunctionCandidate | null>;
}

export interface Form {
  name: RequirementForm;
  /** What the mapping asks the requirement to require of the call, as a stable name for the record. */
  property: string;
  askable(context: AskContext): Promise<Askability>;
  /** Always keyed `requirement_governs`, with the options `applies`, `does_not_apply`, `unknown`. */
  mappingQuestion(fn: FunctionCandidate, call: CallCandidate): Questions;
  /** The key of the observation answer the rule reads. The request may carry other, diagnostic ones. */
  observationKey: string;
  observationQuestions(fn: FunctionCandidate, call: CallCandidate): Questions;
  /** Observation answers that go against the requirement. */
  violates: readonly string[];
  /** Observation answers that keep it. */
  keeps: readonly string[];
  words: {
    /** What the two questions are, in one sentence, at the head of the requirement's section. */
    intro: string;
    /** The label of the observation's answer, in a listed call. */
    asks: string;
    /** The label of the observation's answer, in the list of calls read. */
    observed: string;
    /** The assumption the observation was asked under, for this call. */
    assumed(fn: FunctionCandidate, call: CallCandidate): string;
    /** Why an observation reads as it does, by answer. `cannot_determine` covers any other answer. */
    reading: Readonly<Record<string, string>>;
    /** Why a call is listed, assembled from the two answers. */
    whyListed(target: string, mapping: MappingAnswer, observation: string, probability: number): string;
  };
}

/** The call as the questions name it: redacted, and with no backtick left to close a code span. */
const named = (call: CallCandidate) => redact(call.expression).text.replace(/`/g, "");

const failurePropagation: Form = {
  name: "failure_propagation",
  property: MAPPING_PROPERTY,
  askable: ({ fn, call, resultOf }) => resultOf(fn, call),
  mappingQuestion: (fn, call) => mappingQuestionFor(fn, call, named(call)),
  observationKey: "on_error_result",
  observationQuestions: (fn, call) => questionsFor(conditionFor(fn, call)),
  violates: ["returns_success"],
  keeps: ["returns_error"],
  words: {
    intro: `Two questions are put to Jev about each call, separately: whether the requirement requires that a failure of it not reach the caller as a success, and what the function returns when it does fail. The bar for each is ${BAR}.`,
    asks: "Jev, on what the function returns",
    observed: "when that call fails",
    assumed: (fn, call) => {
      const c = conditionFor(fn, call);
      return `${c.setup} ${c.occurrence}, ${c.operation} returns ${c.yields}. ${c.others}`;
    },
    reading: {
      returns_success: "the failed call is returned to the caller as a success",
      returns_error: "the failed call is not returned as a success",
      cannot_determine: "the code shown does not settle what is returned",
    },
    whyListed,
  },
};

const CHECK_MAPPING_CRITERIA = {
  applies: "The requirement requires it. Its text asks that a check pass before that operation is performed.",
  does_not_apply: "The requirement does not require it of this call. It is about some other operation, or it asks for no check before this one.",
  unknown: "The requirement does not settle it: it neither asks for a check before this call nor rules one out.",
} as const;

const REACH_CRITERIA = {
  reaches_it: "Yes. In that case the function still makes that call.",
  does_not_reach: "No. In that case the function returns, fails or takes another path before making that call.",
  cannot_determine: "The code shown does not settle whether that call is made in that case.",
} as const;

const checkBeforeAction: Form = {
  name: "check_before_action",
  property: "check_passes_before_call",
  askable: async ({ requirement, call, readHere }) => {
    // The words first: they cost nothing, and only a call they let through needs its callee's
    // definitions looked up.
    const wanted = requirementTerms(requirement);
    const shared = [...callTerms(call)].filter((c) => [...wanted].some((w) => termsMeet(c, w)));
    if (shared.length === 0) return { ok: false, kind: "name_not_in_requirement", reason: `no word of \`${named(call)}\`'s name is in the requirement or its search hints, so a check before it is not asked about` };
    // A call into a function this run reads on its own is asked about there, where the check is or
    // is not. Asked here, the question sees the call and not the body behind it: measured on the
    // constructed case (bench/forms/, first log), a caller of a function that checks inside was
    // read as making the forbidden call in every run of the shipped code.
    const inside = await readHere(call.callee.split("::").pop()!);
    if (inside) return { ok: false, kind: "callee_read_here", reason: `\`${inside.name}\` (${inside.path}:${inside.startLine}) is read on its own in this run, so a check before what it does is asked about inside it` };
    return { ok: true };
  },
  mappingQuestion: (fn, call) => ({
    requirement_governs: {
      type: "choice",
      instructions:
        `\`code\` is the body of \`${fn.name}\`, and \`requirement.text\` is one requirement written for this change. ` +
        `Assume nothing about what happens at run time. The question is about the requirement's words only: ` +
        `does it require that a check pass before the call \`${named(call)}\` inside \`${fn.name}\` is made, so that when the check does not pass, \`${fn.name}\` does not make that call? ` +
        `Answer about that call. A requirement about a different operation, or one that asks for no check before this call, does not require it.`,
      criteria: CHECK_MAPPING_CRITERIA,
    },
  }),
  observationKey: "in_forbidden_case",
  // The case is the requirement's: the packet carries its text, and the question points at it rather
  // than restating it. Nothing here writes what the check is — that would be this tool guessing.
  observationQuestions: (fn, call) => ({
    in_forbidden_case: {
      type: "choice",
      instructions:
        `\`code\` is the body of \`${fn.name}\`. The entries under \`evidence.related\` are other code it may call, given so that what those calls do can be worked out; they are not what this question is about. ` +
        `Assume exactly this and nothing else: \`${fn.name}\` is called in a case where \`requirement.text\` says the call \`${named(call)}\` must not be made, because the check it asks for does not pass. ` +
        `Under that condition: does \`${fn.name}\` go on to make the call \`${named(call)}\`?`,
      criteria: REACH_CRITERIA,
    },
  }),
  violates: ["reaches_it"],
  keeps: ["does_not_reach"],
  words: {
    intro: `Two questions are put to Jev about each call, separately: whether the requirement requires that a check pass before the call is made, and whether the function still makes the call in a case the requirement forbids it. The bar for each is ${BAR}.`,
    asks: "Jev, on whether the function still makes the call",
    observed: "in a case the requirement forbids it",
    assumed: (fn, call) => `\`${fn.name}\` is called in a case where the requirement says \`${named(call)}\` must not be made, because the check it asks for does not pass.`,
    reading: {
      reaches_it: "the call is made in a case the requirement forbids it",
      does_not_reach: "the call is not made in a case the requirement forbids it",
      cannot_determine: "the code shown does not settle whether the call is made in that case",
    },
    whyListed: (target, mapping, observation, probability) =>
      `Jev answered \`${mapping.verdict}\` (${mapping.probability.toFixed(2)}) when asked whether the requirement requires a check to pass before this call, ` +
      `and \`${observation}\` (${probability.toFixed(2)}) when asked whether \`${target}\` still makes the call in a case the requirement forbids it. ` +
      `Both are Jev's readings and neither checks the other.`,
  },
};

export const FORMS: Readonly<Record<RequirementForm, Form>> = {
  failure_propagation: failurePropagation,
  check_before_action: checkBeforeAction,
};

export const formOf = (requirement: Requirement): Form => FORMS[requirement.form ?? DEFAULT_FORM];

// --- Words, for `check_before_action` -------------------------------------------------------------
//
// A call is asked about when its name and the requirement share a word. Both sides are split the
// same way, so `create_session` written in a requirement and `create_session(…)` in code meet, and
// so do `createSession` and "session". The call's side is its whole path (`Session::new` gives
// `session`) and the receivers right before it (`self.sessions.insert` gives `sessions`).
//
// There is no five-letter floor here: `send`, `save`, `open` and `pay` are the names of actions.
// Words under three letters are dropped, and so are common English words and the words every Rust
// call can carry.

const RUST_NOISE = new Set(["self", "super", "crate"]);

/** An identifier's words: the whole of it, and its snake_case and CamelCase parts, lowercased. */
export function identifierWords(identifier: string): string[] {
  const whole = identifier.replace(/^_+|_+$/g, "").toLowerCase();
  const parts = identifier
    .split(/_+/)
    .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .map((p) => p.toLowerCase())
    .filter((p) => p !== "");
  return [...new Set([whole, ...parts])].filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !RUST_NOISE.has(w));
}

export function requirementTerms(requirement: Pick<Requirement, "text" | "searchHints">): Set<string> {
  const tokens = [requirement.text, ...requirement.searchHints].join(" ").split(/[^\p{L}\p{N}_]+/u);
  return new Set(tokens.filter((t) => t !== "").flatMap(identifierWords));
}

/** The receivers before the callee on its line: `self.sessions.insert(` gives `self`, `sessions`. */
function receivers(call: CallCandidate): string[] {
  const callee = call.callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chain = new RegExp(`((?:[A-Za-z_][\\w$]*\\s*\\.\\s*)+)${callee}\\s*\\(`).exec(call.text);
  return chain ? chain[1]!.split(".").map((s) => s.trim()).filter((s) => s !== "") : [];
}

export function callTerms(call: CallCandidate): Set<string> {
  return new Set([...call.callee.split("::"), ...receivers(call)].flatMap(identifierWords));
}

/**
 * Whether two words are the same word: equal; one is the other with one letter more (`key` /
 * `keys`, `send` / `sends`); or they share their first five letters (`create` / `creation`,
 * `rewrite` / `rewritten`). A short name that merely begins a longer word is not the same word:
 * `res` is not `restore`, `gen` is not `generate` — measured on grovedb#500, `res.as_bytes()` was
 * asked about under a sentence about a restore.
 *
 * Five letters is a line, not a stemmer: `write` and `written` share four and do not meet, while
 * `general` and `generate` share five and do. `searchHints` is where a requirement names the exact
 * word when the sentence's inflection does not reach it.
 */
export function termsMeet(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.startsWith(short) && long.length - short.length <= 1) return true;
  let same = 0;
  while (same < short.length && short[same] === long[same]) same += 1;
  return same >= 5;
}
