// The experimental path: from a change and a requirement to observations about particular calls.
//
// What the ordinary run does is ask, for each place discovery offers, whether the requirement
// holds there. Measured over ten real pull requests that never produced a VERIFIED. This path asks
// something smaller and answerable instead, about one call at a time — **when this call fails, does
// this function return a success?**, or **in a case the requirement forbids it, is this call still
// made?** Which of those is the requirement's form (`plan/forms.ts`, docs/adr/0006). The bench that
// settled the first wording is in `docs/`; what is new here is that a run can reach it from a pull
// request rather than from a person naming a function and a call.
//
// The shape:
//
//   1. the change offers the functions holding changed lines, and one hop out their callers
//   2. every call in every one of those functions is added — the diff says which body, and the
//      defect is usually a different call in it
//   3. the form says which calls are askable — for failures, a callee resolving here to something
//      returning a `Result` — and the rest are held, with the reason, in the report
//   4. **one** judgment budget for the requirement, spent round-robin over functions, so neither a
//      busy body nor a busy file can take the run
//   5. each of those calls gets the form's two Jev questions, asked separately: what the requirement
//      requires of the call, and what the function does under the form's assumption. One rule for
//      every form (`outcome.ts`) reads the two answers as holding, worth checking, not settled, or
//      not required of; a call read as going against the requirement is listed
//
// **Only Jev is asked anything.** A second model used to open files, pick calls and write the
// mapping's prose; the transport refuses every model but Jev now, and what that model was giving
// comes from the input and from the run's own record instead.
//
// Nothing in this file knows a function name, a helper name or an expected answer.
//
// **A local observation is not a requirement verdict.** A changed line says the work was done
// there; the form's condition makes a question askable. Neither makes the requirement apply — the
// mapping is what says that, it is asked separately, and it is never told what the code does. The
// four outcomes are readings of one call each. No requirement-level status is stated, and a finding
// does not make the run exit nonzero — a configuration, repository or provider failure still does.
// A finding is two readings that disagree, printed with everything needed to disagree with them.

import { analyzeChange, type ChangeAnalysis } from "../change/seeds.ts";
import { Discoverer } from "../discovery/discover.ts";
import { buildEvidence } from "../evidence/builder.ts";
import { redact } from "../evidence/redact.ts";
import { FATAL_KINDS, ProviderError } from "../judgments/client.ts";
import type { JudgmentProvider, Questions } from "../judgments/provider.ts";
import type { Git } from "../repository/git.ts";
import { EXIT, ToolError, type Candidate, type ChoiceAnswer, type Requirement, type RequirementForm } from "../types.ts";
import { applicabilityOf, definitionsOfName } from "../plan/applicability.ts";
import type { CallCandidate, FunctionCandidate } from "../plan/candidates.ts";
import { chooseForm, FORM_QUESTION, FORMS, formOf } from "../plan/forms.ts";
import { CandidateFiles, sitesFromChange } from "../plan/from-diff.ts";
import { BAR, describe, locateCall, type LocalResult } from "../plan/local-check.ts";
import { acceptMapping, MAPPING_BAR, type MappingAnswer, type MappingVerdict } from "../plan/mapping.ts";
import { selectSites, type Askability, type FunctionOrigin, type Site, type SiteSource } from "../plan/select.ts";
import { OUTCOMES, outcomeOf, type Outcome } from "./outcome.ts";
import { probabilityOf } from "./requirement.ts";

export interface LocalCheckOptions {
  /** How many calls a requirement may be judged at, over every file the change reached. */
  budget: number;
  maxPrimaryChars: number;
  maxRelatedChars: number;
  /**
   * Build the set and stop: no questions of any kind, no request of any kind.
   *
   * What it answers is whether a call is reachable and inside the budget, which is the question to
   * settle before spending anything.
   */
  candidatesOnly?: boolean;
  /**
   * Ask Jev which form each requirement's sentence says, once, before its calls (ADR 0008) — for
   * requirements read from an issue, a pull request or the command line, which name no form. A
   * requirement whose spec names a form is never asked, nor is a run that reads no function, nor
   * one that builds the set only; the result says which.
   */
  askForm?: boolean;
}

export const DEFAULT_LOCAL_CHECK: LocalCheckOptions = { budget: 20, maxPrimaryChars: 8000, maxRelatedChars: 0 };

export interface Observed {
  file: string;
  function: string;
  call: string;
  origin: Site["origin"];
  /** The same call's entry in `mappings`. */
  callId: string;
  result: LocalResult;
  /** What the one rule made of the mapping and this reading, for this call only. */
  outcome: Outcome;
}

export interface Unchecked {
  file: string;
  function: string;
  call: string;
  origin: Site["origin"];
  why: string;
}

/**
 * Something for a person to look at: a requirement read as governing this call, and an observation
 * that contradicts it.
 *
 * It is a candidate, not a verdict. Two model answers stand behind it — one about what the
 * sentence requires, one about what the function returns — and neither is checked by the other.
 * Everything a reader needs to disagree with it is in the record: which words, which code, what
 * was assumed, what was read, and why those two are taken to disagree.
 */
export interface Finding {
  requirementId: string;
  file: string;
  /** Where in the file, so a reader can open it rather than search for it. */
  lines: string;
  function: string;
  call: string;
  /** The requirement, as it was given. Not a fragment a model chose out of it. */
  quote: string;
  /** The condition that was assumed when the function was read. */
  condition: string;
  /** What the mapping asked the requirement to require of the call: the form's name for it. */
  property: string;
  mapping: MappingAnswer;
  observation: LocalResult["observation"];
  probability: number;
  /** Assembled from the parts above. No sentence here was written by a model. */
  why: string;
}

/**
 * What the mapping was asked and what came back, for every call that was asked — whether or not a
 * finding came out of it.
 *
 * A run on holding code produces no findings, and the thing that needs reading there is *the
 * mapping itself*: which words it quoted, why it said the requirement governs the call. Keeping it
 * only when it disagreed with the code left the successful case unreadable, which is the half the
 * next measurement has to check first.
 */
export interface MappingRecord {
  requirementId: string;
  callId: string;
  file: string;
  function: string;
  call: string;
  verdict: MappingVerdict | "no_answer";
  probability: number;
  /** Every option, as Jev gave it, so a reading near the bar can be re-read later. */
  probabilities: Record<string, number>;
  /** Whether the run acted on it: `applies`, at or above the bar. */
  governs: boolean;
  /** Said in the report's words, assembled rather than written. */
  why: string;
}

export interface LocalCheckResult {
  requirementId: string;
  requirementText: string;
  /** What was asked of each call: the requirement's form. */
  form: RequirementForm;
  /** Who chose it: the spec that named it, Jev's reading of the sentence, or the default. */
  formBy: "spec" | "default" | "jev";
  /**
   * Jev's reading of the sentence, when it was asked: its choice, that choice's probability, every
   * option's; and, when the question was not answered, what the failure was (the kind and the host).
   */
  formReading?: { verdict: string; probability: number; probabilities: Record<string, number>; failure?: string };
  /** Why the sentence was not put to Jev on a run that would have asked. */
  formNotAsked?: "candidates_only" | "no_function";
  /**
   * What the budget selected, before anything was asked.
   *
   * In a full run these are the calls that become observations, minus any held at the last moment
   * for a body that did not fit. With `candidatesOnly` they are the whole answer — and leaving
   * them out was a report that listed everything *except* the calls it had chosen, which reads
   * exactly like not having reached them.
   */
  wouldAsk: { file: string; function: string; call: string; origin: Site["origin"] }[];
  observed: Observed[];
  unchecked: Unchecked[];
  /** Every mapping asked for, accepted or not. The report's two mapping sections are read off this. */
  mappings: MappingRecord[];
  findings: Finding[];
  /** The set and the budget, so a report never leaves the size of either to be guessed. */
  counts: {
    budget: number;
    functions: Record<FunctionOrigin, number>;
    calls: number;
    applicable: number;
    asked: number;
    /** Mapping questions asked — one per call asked about, whatever came back. */
    mapped: number;
    /** Of those, the ones that cleared the bar saying the requirement governs the call. */
    governed: number;
    overBudget: number;
    notApplicable: number;
    /** The calls asked about, by outcome. They add up to `asked`. */
    outcomes: Record<Outcome, number>;
  };
  notes: string[];
}

/**
 * A call as the report prints it.
 *
 * The report is a deliverable — stdout, a file, a comment on a pull request — so an expression
 * with a secret-shaped argument does not belong in it any more than it belongs in a request.
 * The condition sent to the model is built from the same redacted text.
 */
const shown = (call: CallCandidate) => redact(call.expression).text;

export interface LocalCheckRevisions {
  before: string;
  after: string;
}

/** A run over every requirement, with what it read and what it sent. */
export interface LocalCheckRun {
  requirements: LocalCheckResult[];
  /** The change as read once for the run, so the pass over the changes can read the same one. */
  change: ChangeAnalysis;
  /** Requests about the calls the host answered its own way, right or wrong, and requests it answered. */
  reached: number;
  answered: number;
  /**
   * The form questions (ADR 0008), counted apart: an answer about a sentence is not a judgment
   * about a call, so it does not stand in for one when the host answered nothing about the calls.
   */
  form: { reached: number; answered: number };
}

export async function runLocalCheck(
  git: Git,
  revisions: LocalCheckRevisions,
  requirements: readonly Requirement[],
  judge: JudgmentProvider,
  include: (path: string) => boolean,
  options: LocalCheckOptions = DEFAULT_LOCAL_CHECK,
): Promise<LocalCheckRun> {
  const discoverer = new Discoverer(git, revisions.after, { include });
  const files = new CandidateFiles(discoverer);

  // The change is read once: it does not depend on which requirement is being checked, and the
  // whole point of starting from it is that it is the same lead for all of them.
  const change = await analyzeChange(git, revisions.before, revisions.after, include);
  const fromChange = await sitesFromChange(files, discoverer, Discoverer.changedLines(change));
  const changeNotes = [...fromChange.notes];
  // A source exists as soon as a changed file is read, so counting sources said nothing about a
  // diff that only touched comments or imports in a Rust file: no function, and no note either.
  if (![...fromChange.sources.values()].some((s) => (s.changed?.length ?? 0) > 0)) changeNotes.push("the change touched no Rust function at this commit");

  // Whether the target and the callee return a `Result` depends on the commit and on nothing else,
  // and the change's candidates are the same for every requirement. Deciding it once is the
  // difference between one pass over the calls and one pass per requirement.
  //
  // Only that is shared. Whether a question can be put to a call is the form's to say and may read
  // the requirement's words, so it is decided per requirement: a shared answer let the second
  // requirement of a spec be judged by the first one's form, or by the first one's words.
  const resultAnswers = new Map<string, Promise<Askability>>();
  const resultOf = (fn: FunctionCandidate, call: CallCandidate): Promise<Askability> => {
    const key = `${fn.id}\u0000${call.id}`;
    let answer = resultAnswers.get(key);
    if (!answer) {
      answer = applicabilityOf(discoverer, fn, call);
      resultAnswers.set(key, answer);
    }
    return answer;
  };

  // A request that fails without ending the run leaves its call unanswered, and the run goes on. But
  // a host that answered nothing at all is not a run of "not settled": it is the host failing, as the
  // default review reads it too. A run that stopped on its own budget reached nothing, and keeps its
  // report.
  let hostReached = 0;
  let answered = 0;
  const formCount = { reached: 0, answered: 0 };
  let failedAt: string | undefined;
  const ask = async (packet: unknown, questions: Questions, about: "call" | "form" = "call"): Promise<{ answers: Record<string, ChoiceAnswer | undefined>; failure?: string }> => {
    const reached = () => (about === "call" ? (hostReached += 1) : (formCount.reached += 1));
    try {
      const answers = await judge.judge(packet, questions);
      reached();
      if (about === "call") answered += 1;
      else formCount.answered += 1;
      return { answers };
    } catch (error) {
      const failure = callsOwn(error);
      if (!(error instanceof ProviderError && error.kind === "budget")) reached();
      if (error instanceof ProviderError && error.where !== undefined) failedAt = error.where;
      return { answers: {}, failure };
    }
  };

  // The functions whose own calls this run enumerates: a form may leave a call into one of them to
  // be asked about inside it. A callee is one of them only when its one definition in the repository
  // is at one of them — by the name alone, a same-named function elsewhere in the change had the
  // call to the other one held for a reason that was not true of it. Definitions depend on the
  // commit alone, so a name is looked up once.
  const enumerated: FunctionCandidate[] = [];
  for (const source of fromChange.sources.values()) {
    const ids = new Set([...(source.changed ?? []), ...(source.callsChanged ?? [])]);
    for (const fn of source.candidates.functions) if (ids.has(fn.id)) enumerated.push(fn);
  }
  const definitions = new Map<string, ReturnType<typeof definitionsOfName>>();
  const readHere = async (callee: string): Promise<FunctionCandidate | null> => {
    let defs = definitions.get(callee);
    if (!defs) {
      defs = definitionsOfName(discoverer, callee);
      definitions.set(callee, defs);
    }
    // A search cut at its cap may have missed a definition: the one it found is then not known to
    // be the only one, and the call is asked about where it is.
    const { found, more } = await defs;
    if (more || found.length !== 1) return null;
    const def = found[0]!;
    return enumerated.find((fn) => fn.name === callee && fn.path === def.path && def.line >= fn.startLine && def.line <= fn.endLine) ?? null;
  };

  const out: LocalCheckResult[] = [];
  for (const requirement of requirements) {
    // The form: the spec's word when it named one; otherwise, on a run that asks, Jev's reading of
    // the sentence (ADR 0008) — one question over the sentence alone, before the calls, and only
    // when there is a function to read, since under no form could anything be asked otherwise. A
    // sentence Jev reads as neither form, or not surely, is checked as it was before: the default.
    let form = formOf(requirement);
    let formBy: LocalCheckResult["formBy"] = requirement.form === undefined ? "default" : "spec";
    let formReading: LocalCheckResult["formReading"];
    let formNotAsked: LocalCheckResult["formNotAsked"];
    if (options.askForm && requirement.form === undefined) {
      if (options.candidatesOnly) formNotAsked = "candidates_only";
      else if (enumerated.length === 0) formNotAsked = "no_function";
      else {
        const asking = await ask({ requirement: { id: requirement.id, text: redact(requirement.text).text } }, FORM_QUESTION, "form");
        const answer = asking.answers.requirement_form;
        const choice = chooseForm(answer);
        form = FORMS[choice.form];
        formBy = choice.by;
        formReading = { verdict: choice.verdict, probability: choice.probability, probabilities: { ...(answer?.probabilities ?? {}) }, ...(asking.failure === undefined ? {} : { failure: asking.failure }) };
      }
    }
    const notes = [...changeNotes];
    const observed: Observed[] = [];
    const unchecked: Unchecked[] = [];
    const mappings: MappingRecord[] = [];
    const findings: Finding[] = [];

    const decide = (fn: FunctionCandidate, call: CallCandidate) => form.askable({ requirement, fn, call, resultOf, readHere });
    const selection = await selectSites([...fromChange.sources.values()], decide, options.budget);
    for (const h of selection.held) unchecked.push({ file: h.fn.path, function: h.fn.name, call: shown(h.call), origin: h.origin, why: h.applicability && !h.applicability.ok ? h.applicability.reason : "held" });
    for (const o of selection.overBudget) unchecked.push({ file: o.fn.path, function: o.fn.name, call: shown(o.call), origin: o.origin, why: `the budget of ${options.budget} was already spent` });

    // The requirement as the report will quote it: the text that was given, not a fragment a model
    // picked out of it. A model choosing the fragment was the only reason a quote ever had to be
    // checked against the text.
    const quote = redact(requirement.text).text.replace(/\s+/g, " ").trim();

    let asked = 0;
    let mapped = 0;
    for (const site of options.candidatesOnly ? [] : selection.budgeted) {
      const candidate: Candidate = {
        path: site.fn.path,
        startLine: site.fn.startLine,
        endLine: site.fn.endLine,
        symbol: site.fn.name,
        changed: site.fnOrigin === "changed",
        reasons: [`a call in ${site.fn.name}, which the run reached by ${site.origin}`],
      };
      const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: options.maxPrimaryChars, maxRelatedChars: options.maxRelatedChars });
      // The body itself cut is not the same as its surroundings cut: an answer about a body that
      // arrived in two halves is an answer about neither of them.
      if (evidence.cut.own) {
        unchecked.push({ file: site.fn.path, function: site.fn.name, call: shown(site.call), origin: site.origin, why: `the body of ${site.fn.name} did not fit the evidence limit, so an answer would be about part of it` });
        continue;
      }
      const body = evidence.packet.evidence.code;
      const located = locateCall(body, site.call);
      if (!located.ok) {
        unchecked.push({ file: site.fn.path, function: site.fn.name, call: shown(site.call), origin: site.origin, why: located.reason ?? "the call could not be located in the body read here" });
        continue;
      }
      const place = { file: site.fn.path, function: site.fn.name, call: shown(site.call), origin: site.origin };

      // Two questions, two requests. The mapping is about the requirement's words and must not be
      // asked under the assumption the observation makes — nor in the same breath as it.
      const asking = await ask(evidence.packet, form.mappingQuestion(site.fn, site.call));
      const mappingAnswers = asking.answers;
      const unanswered = asking.failure ? `the mapping question was not answered (${asking.failure})` : "the mapping question was not answered";
      mapped += 1;
      const mapping = acceptMapping(mappingAnswers.requirement_governs);
      mappings.push({
        requirementId: requirement.id,
        callId: site.call.id,
        file: place.file,
        function: place.function,
        call: place.call,
        verdict: mapping.verdict,
        probability: mapping.probability,
        probabilities: mapping.probabilities,
        governs: mapping.governs,
        why:
          mapping.verdict === "no_answer"
            ? unanswered
            : mapping.governs
              ? `the requirement is read as requiring this of the call (${mapping.probability.toFixed(2)})`
              : `read as \`${mapping.verdict}\` (${mapping.probability.toFixed(2)}), which is below the bar of ${MAPPING_BAR} or not a requirement of this call`,
      });

      // The observation's failure is handled as the mapping's is: until it was, a failure the mapping
      // survived — a malformed answer, a spent budget — ended the whole run here instead.
      const reading = await ask(evidence.packet, form.observationQuestions(site.fn, site.call));
      const answer = reading.answers[form.observationKey];
      const p = answer ? probabilityOf(answer, answer.choice) : 0;
      asked += 1;
      const described = describe(answer, p, form.words.reading);
      const result = reading.failure ? { ...described, why: `the observation question was not answered (${reading.failure})` } : described;

      // The one rule, for every form. Its readings are the answers as the report records them: the
      // mapping's verdict and number, and the observation after the bar has been applied to it.
      const outcome = outcomeOf(
        mapping.verdict === "no_answer" ? undefined : { choice: mapping.verdict, probability: mapping.probability },
        result.observation === "withheld" ? undefined : { choice: result.observation, probability: result.probability },
        form,
        { mapping: MAPPING_BAR, observation: BAR },
      );
      observed.push({ ...place, callId: site.call.id, result, outcome });

      if (outcome === "violates") {
        findings.push({
          requirementId: requirement.id,
          file: place.file,
          lines: `${site.fn.startLine}-${site.fn.endLine}`,
          function: place.function,
          call: place.call,
          quote,
          condition: form.words.assumed(site.fn, site.call),
          property: form.property,
          mapping,
          observation: result.observation,
          probability: result.probability,
          why: form.words.whyListed(site.fn.name, mapping, result.observation, result.probability),
        });
      }
    }

    const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, observed.filter((x) => x.outcome === o).length])) as Record<Outcome, number>;
    out.push({
      requirementId: requirement.id,
      requirementText: requirement.text,
      form: form.name,
      formBy,
      ...(formReading === undefined ? {} : { formReading }),
      ...(formNotAsked === undefined ? {} : { formNotAsked }),
      wouldAsk: selection.budgeted.map((s) => ({ file: s.fn.path, function: s.fn.name, call: shown(s.call), origin: s.origin })),
      observed,
      unchecked,
      mappings,
      findings,
      counts: {
        budget: options.budget,
        functions: selection.functions,
        calls: selection.widened.length,
        applicable: selection.applicable.length,
        asked,
        mapped,
        governed: mappings.filter((m) => m.governs).length,
        overBudget: selection.overBudget.length,
        notApplicable: selection.held.length,
        outcomes,
      },
      // A file both the change and the requirement's words reached has its cap counted twice.
      notes: [...new Set(notes)],
    });
  }
  if (hostReached > 0 && answered === 0) {
    throw new ToolError(`no judgment came back from ${failedAt ?? "the judgment provider"}: ${hostReached} request(s) were sent and none was answered`, EXIT.provider);
  }
  return { requirements: out, change, reached: hostReached, answered, form: formCount };
}

/**
 * What a failed request was, for the report: the kind and the host, never the host's own words, which
 * would be printed as Markdown. A failure that ends the run is thrown on from here.
 */
function callsOwn(error: unknown): string {
  if (!(error instanceof ProviderError) || FATAL_KINDS.has(error.kind)) throw error;
  return `${error.kind}${error.where === undefined ? "" : ` from ${error.where}`}`;
}
