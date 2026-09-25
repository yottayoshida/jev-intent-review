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
// measurements in `docs/local-check-cli.md` were taken with them. `check_before_action` is newer, and
// measured on less: a constructed case and one real pull request's code (`bench/forms/`).

import { STOP_WORDS } from "../discovery/discover.ts";
import { redact } from "../evidence/redact.ts";
import type { Questions } from "../judgments/provider.ts";
import { REQUIREMENT_FORMS, type ChoiceAnswer, type Requirement, type RequirementForm } from "../types.ts";
import type { CallCandidate, FunctionCandidate } from "./candidates.ts";
import { checksBefore, occurrences, wrapperOf } from "./decisive.ts";
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

/** What a form is given to name the code that decides a reading (ADR 0019). */
export interface DecisiveContext {
  requirement: Requirement;
  fn: FunctionCandidate;
  call: CallCandidate;
  /** The function's body as the packet carries it. */
  body: string;
  /** Every call the listing has in the function, the target among them. */
  calls: readonly CallCandidate[];
  /** Whether the repository defines a function of this name outside the tests. */
  defined: (name: string) => Promise<boolean>;
}

/**
 * The code a reading turns on: not asked about, and why; or the names of the functions whose bodies
 * are sent with the packet — none when the body sent is all the reading needs.
 */
export type Decisive = { hold: string } | { send: readonly string[] };

export interface Form {
  name: RequirementForm;
  /** What the mapping asks the requirement to require of the call, as a stable name for the record. */
  property: string;
  /**
   * What a sentence of this form says: the form's option in the question that asks Jev which form
   * a requirement's sentence has (`FORM_QUESTION`, ADR 0008). Measured wording — a word changed
   * here is a changed measurement, and `test/forms.test.ts` holds the question to the measured hash.
   */
  says: string;
  askable(context: AskContext): Promise<Askability>;
  /** The code the reading turns on, from the body's text (ADR 0019). Decided after the budget. */
  decisive(context: DecisiveContext): Promise<Decisive>;
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

/**
 * Why a call is held when the rules cannot tell it from another in the body they read (ADR 0019): the
 * code it turns on cannot be named, so it is not asked about. `locateCall` has already found it once
 * in the packet's body; this is the net for a reading of the text that makes two of it.
 */
const UNTOLD = (call: CallCandidate) => `\`${named(call)}\` could not be told apart from another call of the same text in the body, so the code its reading turns on could not be named`;

const failurePropagation: Form = {
  name: "failure_propagation",
  property: MAPPING_PROPERTY,
  says: "The sentence says what must happen when an operation fails: the failure must reach the caller as an error, and must not be returned as a success, an empty value or an absence.",
  askable: ({ fn, call, resultOf }) => resultOf(fn, call),
  // The failure decides the reading. Passed to this repository's own code before it is returned, what
  // the function returns is that code's to say, and its body is not sent: the call is not asked about.
  decisive: async ({ body, call, defined }) => {
    if (occurrences(body, call) !== 1) return { hold: UNTOLD(call) };
    const wrapper = wrapperOf(body, call);
    if (wrapper === null || !(await defined(wrapper))) return { send: [] };
    return { hold: `its failure is passed to \`${wrapper}\` before it is returned, and \`${wrapper}\` is this repository's own function, whose body is not sent: what the function returns is \`${wrapper}\`'s to say` };
  },
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
  says: "The sentence says that an operation must not be performed unless a check passes, or must never be performed in some case, and it names the operation.",
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
    // The operation a sentence of this form names is the call's own name: a call that meets the
    // words only through a receiver or the rest of its path takes its turn after a named one (#39).
    const names = [...calleeNameTerms(call)].some((c) => [...wanted].some((w) => termsMeet(c, w)));
    return { ok: true, names };
  },
  // The check decides the reading: a call above the target, in a condition, whose own name meets the
  // requirement. Its body goes with the packet. A function the change touched is not left out, as
  // `readHere` leaves out a target's: a helper the pull request added is where a check that does
  // nothing is likeliest to be.
  decisive: async ({ requirement, body, call, calls }) => {
    if (occurrences(body, call) !== 1) return { hold: UNTOLD(call) };
    const wanted = requirementTerms(requirement);
    const meets = (c: CallCandidate) => [...calleeNameTerms(c)].some((t) => [...wanted].some((w) => termsMeet(t, w)));
    return { send: checksBefore(body, call, calls, meets) };
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

// --- Which form a sentence says (ADR 0008) --------------------------------------------------------
//
// A requirement read from an issue, a pull request or the command line names no form. Before its
// calls, the run puts one typed choice to Jev over the sentence alone — `{ requirement: { id, text } }`,
// no code, no hints — and reads the answer by one rule. Measured first on 72 sentences
// (`bench/forms/choice/`, `bench/logs/form-choice-v1.json`); the log fingerprints this question's
// serialisation, and `test/forms.test.ts` holds it there, so the question sent is the question measured.

/** Not a form: the option for every other sentence. */
export const NEITHER_SAYS = "The sentence says something else: what a feature does or shows, what an output contains, what stays the same, a limit on data or an interface, or a task to do.";

/**
 * The question, assembled from the forms in the order they are declared and then `neither`. The
 * key order (`type`, `instructions`, `criteria`; the criteria in that order) is part of what the
 * measurement's hash covers, so it is fixed here on purpose.
 */
export const FORM_QUESTION: Questions = {
  requirement_form: {
    type: "choice",
    instructions: "`requirement.text` is one requirement written for a change to a program. Which of these does its sentence say? Read its words only; assume nothing about the program.",
    criteria: { ...Object.fromEntries(Object.entries(FORMS).map(([name, form]) => [name, form.says])), neither: NEITHER_SAYS },
  },
};

export type OptionReading = { kind: "option"; option: string; probability: number } | { kind: "under"; option: string; probability: number } | { kind: "none" };

/**
 * One answer read at a bar: the option chosen when the question offered it and its probability is
 * at the bar or above; `under` when it is below; `none` when there is no answer or the option was
 * not one of those offered. `chooseForm` and the bench's scorer both read through this, so there
 * is one line, not two.
 */
export function readOption(answer: ChoiceAnswer | undefined, offered: readonly string[], bar: number): OptionReading {
  if (!answer || !offered.includes(answer.choice)) return { kind: "none" };
  return { kind: answer.probability >= bar ? "option" : "under", option: answer.choice, probability: answer.probability };
}

export interface FormChoice {
  form: RequirementForm;
  by: "jev" | "default";
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
  const read = readOption(answer, REQUIREMENT_FORMS, BAR);
  return { form: read.kind === "option" ? (read.option as RequirementForm) : DEFAULT_FORM, by: read.kind === "option" ? "jev" : "default", verdict: answer.choice, probability: answer.probability };
}

/**
 * The wording of every question a form can send — each form's two, rendered on one fixed place, and
 * the one that asks which form a sentence says — so a report can carry a fingerprint of what was
 * asked (`QUESTIONS_HASH`). Change a criterion or a template and the fingerprint moves; change
 * nothing and it does not.
 */
export const FORMS_FINGERPRINT: Readonly<{ forms: Record<RequirementForm, { mapping: Questions; observation: Questions }>; choice: Questions }> = (() => {
  const fn = { id: "f", path: "src/f.rs", name: "f", startLine: 1, endLine: 1, signature: "fn f() -> Result<(), E>" } as FunctionCandidate;
  const call = { id: "src/f.rs:call-1", functionId: "f", line: 1, text: "g(x)?;", callee: "g", expression: "g(x)", expressionComplete: true } as CallCandidate;
  const forms = Object.fromEntries(Object.entries(FORMS).map(([name, form]) => [name, { mapping: form.mappingQuestion(fn, call), observation: form.observationQuestions(fn, call) }])) as Record<RequirementForm, { mapping: Questions; observation: Questions }>;
  return { forms, choice: FORM_QUESTION };
})();

// --- Words, for `check_before_action` -------------------------------------------------------------
//
// A call is asked about when its name and the requirement share a word. Both sides are split the
// same way, so `write_record` written in a requirement and `write_record(…)` in code meet, and
// so do `writeRecord` and "record". The call's side is its whole path (`Ledger::new` gives
// `ledger`) and the receivers right before it (`self.ledgers.insert` gives `ledgers`).
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

/** The receivers before the callee on its line: `self.ledgers.insert(` gives `self`, `ledgers`. */
function receivers(call: CallCandidate): string[] {
  const callee = call.callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chain = new RegExp(`((?:[A-Za-z_][\\w$]*\\s*\\.\\s*)+)${callee}\\s*\\(`).exec(call.text);
  return chain ? chain[1]!.split(".").map((s) => s.trim()).filter((s) => s !== "") : [];
}

/** The words of the call's own name: the last part of its path (`save` of `store::save`). */
export function calleeNameTerms(call: CallCandidate): Set<string> {
  return new Set(identifierWords(call.callee.split("::").pop() ?? ""));
}

export function callTerms(call: CallCandidate): Set<string> {
  return new Set([...call.callee.split("::"), ...receivers(call)].flatMap(identifierWords));
}

/**
 * Whether two words are the same word: equal; one is the other with one letter more (`key` /
 * `keys`, `send` / `sends`); or they share their first five letters (`create` / `creation`,
 * `rewrite` / `rewritten`). A short name that merely begins a longer word is not the same word:
 * `res` is not `restore`, `gen` is not `generate`: a call on a short name would otherwise be asked
 * about under any sentence whose words it begins.
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
