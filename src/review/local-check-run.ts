// The experimental path: from a change and a requirement to observations about particular calls.
//
// What the ordinary run does is ask, for each place discovery offers, whether the requirement
// holds there. Measured over ten real pull requests that never produced a VERIFIED. This path asks
// something smaller and answerable instead: **when this call fails, does this function return a
// success?** The bench that settled its wording is in `docs/`; what is new here is that a run can
// reach it from a pull request rather than from a person naming a function and a call.
//
// The shape:
//
//   1. the change offers the functions holding changed lines, and one hop out their callers; past
//      those, its siblings — functions that call what the changed code calls and nothing it
//      touched, where a path the pull request missed is (`plan/siblings.ts`, ADR 0005)
//   2. every call in every one of those functions is added — the diff says which body, and the
//      defect is usually a different call in it
//   3. calls whose callee resolves here to something returning a `Result` are askable; the rest are
//      held, with the reason, in the report
//   4. **one** judgment budget for the requirement, spent round-robin over functions, so neither a
//      busy body nor a busy file can take the run; the siblings have a budget of their own, so the
//      first one's calls do not depend on whether a sibling exists
//   5. each of those calls gets two Jev questions, asked separately: does the requirement require
//      that this call's failure not reach the caller as a success, and what does the function
//      return when it does fail. Where both clear the bar and disagree, the call is listed
//
// **Only Jev is asked anything.** A second model used to open files, pick calls and write the
// mapping's prose; the transport refuses every model but Jev now, and what that model was giving
// comes from the input and from the run's own record instead.
//
// Nothing in this file knows a function name, a helper name or an expected answer.
//
// **A local observation is not a requirement verdict.** A changed line says the work was done
// there; resolving that a callee returns a `Result` makes a question askable. Neither makes the
// requirement apply — the mapping is what says that, it is asked separately, and it is never told
// what the code does. No requirement-level status is stated, and a finding does not make the run
// exit nonzero — a configuration, repository or provider failure still does. A finding is two
// readings that disagree, printed with everything needed to disagree with them.

import { analyzeChange } from "../change/seeds.ts";
import { Discoverer } from "../discovery/discover.ts";
import { buildEvidence } from "../evidence/builder.ts";
import { redact } from "../evidence/redact.ts";
import { FATAL_KINDS, ProviderError } from "../judgments/client.ts";
import type { JudgmentProvider } from "../judgments/provider.ts";
import type { Git } from "../repository/git.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../types.ts";
import { applicabilityOf, type Applicability } from "../plan/applicability.ts";
import type { CallCandidate, FunctionCandidate } from "../plan/candidates.ts";
import { CandidateFiles, sitesFromChange } from "../plan/from-diff.ts";
import { BAR, conditionFor, describe, locateCall, questionsFor, type LocalResult } from "../plan/local-check.ts";
import { acceptMapping, mappingQuestionFor, MAPPING_BAR, MAPPING_PROPERTY, type MappingAnswer, type MappingVerdict, whyListed } from "../plan/mapping.ts";
import { selectSiblings, selectSites, type FunctionOrigin, type Site, type SiteOrigin, type SiteSource } from "../plan/select.ts";
import { siblingsOf } from "../plan/siblings.ts";
import { probabilityOf } from "./requirement.ts";

export interface LocalCheckOptions {
  /** How many calls a requirement may be judged at, over every file the change reached. */
  budget: number;
  /**
   * How many calls a requirement may be judged at in the siblings of the change — functions that
   * call what the changed code calls and nothing it touched (ADR 0005). A budget of its own, so
   * the calls above are the same set whether or not a sibling exists. Unset is the default.
   */
  beyondBudget?: number;
  maxPrimaryChars: number;
  maxRelatedChars: number;
  /**
   * Build the set and stop: no questions of any kind, no request of any kind.
   *
   * What it answers is whether a call is reachable and inside the budget, which is the question to
   * settle before spending anything.
   */
  candidatesOnly?: boolean;
}

export const DEFAULT_LOCAL_CHECK = { budget: 20, beyondBudget: 10, maxPrimaryChars: 8000, maxRelatedChars: 0 } satisfies LocalCheckOptions;

export interface Observed {
  file: string;
  function: string;
  call: string;
  origin: Site["origin"];
  /** For a sibling: the name the changed code calls that tied it. */
  via?: string;
  result: LocalResult;
}

export interface Unchecked {
  file: string;
  function: string;
  call: string;
  origin: Site["origin"];
  via?: string;
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
  /** How the run reached the function: from the change, one hop out, or as a sibling. */
  origin: SiteOrigin;
  via?: string;
  /** The requirement, as it was given. Not a fragment a model chose out of it. */
  quote: string;
  /** The condition that was assumed when the function was read. */
  condition: string;
  property: typeof MAPPING_PROPERTY;
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
  origin: SiteOrigin;
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
  /**
   * What the budget selected, before anything was asked.
   *
   * In a full run these are the calls that become observations, minus any held at the last moment
   * for a body that did not fit. With `candidatesOnly` they are the whole answer — and leaving
   * them out was a report that listed everything *except* the calls it had chosen, which reads
   * exactly like not having reached them.
   */
  wouldAsk: { file: string; function: string; call: string; origin: Site["origin"]; via?: string }[];
  observed: Observed[];
  unchecked: Unchecked[];
  /** Every mapping asked for, accepted or not. The report's two mapping sections are read off this. */
  mappings: MappingRecord[];
  findings: Finding[];
  /**
   * The set and the budget, so a report never leaves the size of either to be guessed.
   *
   * The top-level counts are about the functions the change reached — changed, and one hop out —
   * and mean what they meant before siblings existed. The siblings are counted apart, under
   * `beyond`, against their own budget.
   */
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
    beyond: BeyondCounts;
  };
  /** The names the changed code calls that siblings were found from, in the order they were taken. */
  seeds: string[];
  /**
   * Set when the run's own request, byte or time limit left something of this requirement unasked:
   * the limit's message. What it did not ask is under `unchecked`, with that reason.
   */
  stopped?: string;
  notes: string[];
}

export interface BeyondCounts {
  budget: number;
  seeds: number;
  functions: number;
  calls: number;
  applicable: number;
  asked: number;
  mapped: number;
  governed: number;
  overBudget: number;
  notApplicable: number;
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

export async function runLocalCheck(
  git: Git,
  revisions: LocalCheckRevisions,
  requirements: readonly Requirement[],
  judge: JudgmentProvider,
  include: (path: string) => boolean,
  options: LocalCheckOptions = DEFAULT_LOCAL_CHECK,
): Promise<LocalCheckResult[]> {
  const discoverer = new Discoverer(git, revisions.after, { include, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const files = new CandidateFiles(discoverer);

  // The change is read once: it does not depend on which requirement is being checked, and the
  // whole point of starting from it is that it is the same lead for all of them.
  const change = await analyzeChange(git, revisions.before, revisions.after, include);
  const fromChange = await sitesFromChange(files, discoverer, Discoverer.changedLines(change));
  const changeNotes = [...fromChange.notes];
  // A source exists as soon as a changed file is read, so counting sources said nothing about a
  // diff that only touched comments or imports in a Rust file: no function, and no note either.
  if (![...fromChange.sources.values()].some((s) => (s.changed?.length ?? 0) > 0)) changeNotes.push("the change touched no Rust function at this commit");

  // What the siblings are found from (after the first budget has been asked, below): the functions
  // the change already reached keep their label, and whatever calls a changed function is not a
  // sibling.
  const known = new Set<string>();
  const changedNames = new Set<string>();
  for (const source of fromChange.sources.values()) {
    for (const id of [...(source.changed ?? []), ...(source.callsChanged ?? [])]) known.add(id);
    for (const id of source.changed ?? []) {
      const fn = source.candidates.functions.find((f) => f.id === id);
      if (fn) changedNames.add(fn.name);
    }
  }
  const beyondBudget = options.beyondBudget ?? DEFAULT_LOCAL_CHECK.beyondBudget;

  // Once the run reaches its own request, byte or time limit, nothing more is asked, and the report
  // still comes out with what was read.
  let stopped: string | undefined;

  // Whether a question can be put to a call depends on the commit and on nothing else, and the
  // change's candidates are the same for every requirement. Deciding it once is the difference
  // between one pass over the calls and one pass per requirement.
  const decided = new Map<string, Promise<Applicability>>();
  const decide = (fn: FunctionCandidate, call: CallCandidate): Promise<Applicability> => {
    const key = `${fn.id}\u0000${call.id}`;
    let answer = decided.get(key);
    if (!answer) {
      answer = applicabilityOf(discoverer, fn, call);
      decided.set(key, answer);
    }
    return answer;
  };

  interface Work {
    requirement: Requirement;
    /** The requirement as the report quotes it: the text that was given, not a fragment a model chose. */
    quote: string;
    selection: Awaited<ReturnType<typeof selectSites>>;
    /** Set once the first budget of every requirement has been asked. */
    beyond?: Awaited<ReturnType<typeof selectSiblings>>;
    observed: Observed[];
    unchecked: Unchecked[];
    mappings: MappingRecord[];
    findings: Finding[];
    /** The two budgets are counted apart, so the first one's numbers mean what they always meant. */
    tally: { near: { asked: number; mapped: number }; beyond: { asked: number; mapped: number } };
    /** Whether the run's own limit left something of this requirement unasked. */
    cutShort: boolean;
  }

  const works: Work[] = [];
  for (const requirement of requirements) {
    const selection = await selectSites([...fromChange.sources.values()], decide, options.budget);
    const unchecked: Unchecked[] = [];
    for (const h of selection.held) unchecked.push({ ...placeOf(h), why: h.applicability && !h.applicability.ok ? h.applicability.reason : "held" });
    for (const o of selection.overBudget) unchecked.push({ ...placeOf(o), why: `the budget of ${options.budget} was already spent` });
    works.push({
      requirement,
      quote: redact(requirement.text).text.replace(/\s+/g, " ").trim(),
      selection,
      observed: [],
      unchecked,
      mappings: [],
      findings: [],
      tally: { near: { asked: 0, mapped: 0 }, beyond: { asked: 0, mapped: 0 } },
      cutShort: false,
    });
  }

  const ask = async (work: Work, site: Site): Promise<void> => {
    const { requirement, unchecked } = work;
    const place = placeOf(site);
    const stop = (why: string) => {
      unchecked.push({ ...place, why });
      work.cutShort = true;
    };
    if (stopped !== undefined) return stop(stoppedWhy(stopped));
    const counted = site.origin === "shares_call" ? work.tally.beyond : work.tally.near;
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
      unchecked.push({ ...place, why: `the body of ${site.fn.name} did not fit the evidence limit, so an answer would be about part of it` });
      return;
    }
    const body = evidence.packet.evidence.code;
    const located = locateCall(body, site.call);
    if (!located.ok) {
      unchecked.push({ ...place, why: located.reason ?? "the call could not be located in the body read here" });
      return;
    }
    const condition = conditionFor(site.fn, site.call);
    const expression = condition.operation.replace(/`/g, "");

    // Two questions, two requests. The mapping is about the requirement's words and must not be
    // asked under the failure the observation assumes — nor in the same breath as it.
    let unanswered = "the mapping question was not answered";
    let mappingAnswers: Record<string, ChoiceAnswer>;
    try {
      mappingAnswers = await judge.judge(evidence.packet, mappingQuestionFor(site.fn, site.call, expression));
    } catch (error) {
      // The run's own limit is not this call's failure: nothing after it can be asked either.
      // Recording it as an unanswered mapping would say the call was asked about.
      if (isLimit(error)) {
        stopped = error.message;
        return stop(stoppedWhy(stopped));
      }
      // A failure that ends the run ends it here. Any other is this call's alone, and the report
      // says what kind it was and which host it came from — never the host's own words, which
      // would be printed as Markdown.
      if (!(error instanceof ProviderError) || FATAL_KINDS.has(error.kind)) throw error;
      unanswered = `the mapping question was not answered (${error.kind}${error.where === undefined ? "" : ` from ${error.where}`})`;
      mappingAnswers = {};
    }
    counted.mapped += 1;
    const mapping = acceptMapping(mappingAnswers.requirement_governs);
    work.mappings.push({
      requirementId: requirement.id,
      callId: site.call.id,
      file: place.file,
      function: place.function,
      call: place.call,
      origin: site.origin,
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

    let answers: Record<string, ChoiceAnswer>;
    try {
      answers = await judge.judge(evidence.packet, questionsFor(condition));
    } catch (error) {
      if (!isLimit(error)) throw error;
      stopped = error.message;
      // The mapping above was asked and is kept; what was not asked is the reading of the code.
      return stop(`the mapping was asked, but not what the function returns: the run stopped at its own limit (${stopped})`);
    }
    const answer = answers.on_error_result;
    const p = answer ? probabilityOf(answer, answer.choice) : 0;
    counted.asked += 1;
    const result = describe(answer, p);
    work.observed.push({ ...place, result });

    // A finding needs both halves, each over the same bar: a requirement read as requiring this
    // of the call, and a reading of the call that returns a success anyway.
    if (mapping.governs && result.observation === "returns_success") {
      work.findings.push({
        requirementId: requirement.id,
        file: place.file,
        lines: `${site.fn.startLine}-${site.fn.endLine}`,
        function: place.function,
        call: place.call,
        origin: site.origin,
        ...(place.via === undefined ? {} : { via: place.via }),
        quote: work.quote,
        condition: `${condition.setup} ${condition.occurrence}, ${condition.operation} returns ${condition.yields}. ${condition.others}`,
        property: MAPPING_PROPERTY,
        mapping,
        observation: result.observation,
        probability: result.probability,
        why: whyListed(site.fn.name, mapping, result.observation, result.probability),
      });
    }
  };

  // Every requirement's first budget before anything about siblings — before they are even looked
  // for. The run's own request, byte and time limits are shared by all the requirements, and
  // siblings searched for or asked about in between would spend them before a later requirement's
  // first budget: the calls that budget asks about would then depend on whether siblings exist,
  // which is the one thing keeping them apart is for (ADR 0005).
  if (!options.candidatesOnly) for (const work of works) for (const site of work.selection.budgeted) await ask(work, site);

  const siblings = await siblingsOf(files, discoverer, change, known, changedNames);
  // Which sibling calls are asked depends on the siblings and the budget, not on the requirement.
  const beyond = await selectSiblings(siblings.siblings, decide, beyondBudget);
  for (const work of works) {
    work.beyond = beyond;
    for (const h of beyond.held) work.unchecked.push({ ...placeOf(h), why: h.applicability && !h.applicability.ok ? h.applicability.reason : "held" });
    for (const o of beyond.overBudget) work.unchecked.push({ ...placeOf(o), why: `the budget of ${beyondBudget} for calls beyond the changed functions was already spent` });
  }
  if (!options.candidatesOnly) for (const work of works) for (const site of work.beyond!.budgeted) await ask(work, site);
  const notes = [...new Set([...changeNotes, ...siblings.notes])];

  return works.map((work) => {
    const { requirement, selection, mappings, tally } = work;
    const beyond = work.beyond!;
    return {
      requirementId: requirement.id,
      requirementText: requirement.text,
      wouldAsk: [...selection.budgeted, ...beyond.budgeted].map(placeOf),
      observed: work.observed,
      unchecked: work.unchecked,
      mappings,
      findings: work.findings,
      counts: {
        budget: options.budget,
        functions: selection.functions,
        calls: selection.widened.length,
        applicable: selection.applicable.length,
        asked: tally.near.asked,
        mapped: tally.near.mapped,
        governed: mappings.filter((m) => m.governs && m.origin !== "shares_call").length,
        overBudget: selection.overBudget.length,
        notApplicable: selection.held.length,
        beyond: {
          budget: beyondBudget,
          seeds: siblings.seeds.length,
          functions: beyond.functions,
          calls: beyond.widened.length,
          applicable: beyond.applicable.length,
          asked: tally.beyond.asked,
          mapped: tally.beyond.mapped,
          governed: mappings.filter((m) => m.governs && m.origin === "shares_call").length,
          overBudget: beyond.overBudget.length,
          notApplicable: beyond.held.length,
        },
      },
      seeds: siblings.seeds.map((s) => redact(s.name).text),
      ...(work.cutShort && stopped !== undefined ? { stopped } : {}),
      notes,
    };
  });
}

/** Where a site is, as every list in the result names it. */
function placeOf(site: Site): { file: string; function: string; call: string; origin: Site["origin"]; via?: string } {
  return { file: site.fn.path, function: site.fn.name, call: shown(site.call), origin: site.origin, ...(site.via === undefined ? {} : { via: redact(site.via).text }) };
}

/** The run's own request, byte or time limit — not a failure of the call being asked about. */
const isLimit = (error: unknown): error is ProviderError => error instanceof ProviderError && error.kind === "budget";

const stoppedWhy = (limit: string) => `not asked: the run stopped at its own limit (${limit})`;

const ORIGIN_WORDS: Record<Site["origin"], string> = {
  changed: "in a function the change touched",
  calls_changed: "in a function that calls one the change touched",
  shares_call: "in a sibling: a function that calls no changed function by a name defined once here",
};

/** How a place was reached, in the report's words: for a sibling, which name tied it. */
const originWords = (origin: Site["origin"], via?: string) => (via === undefined ? ORIGIN_WORDS[origin] : `${ORIGIN_WORDS[origin]} — calls \`${via}\`, which is called on or around the lines the change touched`);

/**
 * The report: what is worth checking, then what was read, then what was not checked and why.
 *
 * Every sentence in it is this file's or the input's. Nothing is a model's prose — the two model
 * answers appear as a choice and a number, named as Jev's, and the reasoning between them is
 * assembled from the parts. No requirement-level verdict appears anywhere.
 */
export function renderLocalCheck(results: readonly LocalCheckResult[]): string {
  const lines: string[] = [
    "# Local check (experimental)",
    "",
    `Two questions are put to Jev about each call, separately: whether the requirement requires that a failure of it not reach the caller as a success, and what the function returns when it does fail. The bar for each is ${BAR}.`,
    "",
    "**Nothing here is a requirement verdict.** A call is listed when both answers clear the bar and disagree; the two answers do not check each other, and everything either of them rests on is printed.",
    "",
  ];
  // Said before anything else: a run that stopped short reads, otherwise, like one that looked
  // everywhere and found nothing.
  const stop = results.find((r) => r.stopped !== undefined)?.stopped;
  if (stop !== undefined) lines.push(`**This run stopped at its own limit** (${stop}). What it did not ask about is under *Not checked* with that reason.`, "");
  for (const r of results) {
    const c = r.counts;
    const b = c.beyond;
    lines.push(`## ${r.requirementId}`, "", `> ${r.requirementText}`, "");
    lines.push(`Functions reached: ${c.functions.changed} the change touched, ${c.functions.calls_changed} calling one of those.`);
    lines.push(`Calls in them: ${c.calls}, of which ${c.applicable} could be asked about. Budget ${c.budget}: ${c.asked} read, ${c.mapped} mapped, ${c.governed} of those governed, ${c.overBudget} left over, ${c.notApplicable} not applicable.`);
    lines.push(
      r.seeds.length === 0
        ? "Beyond the changed functions: no name the changed code calls could lead to a sibling (see the notes)."
        : `Beyond the changed functions: ${b.functions} functions that call a function called on or around the lines the change touched (${r.seeds.map((s) => `\`${s}\``).join(", ")}), and nothing the change touched. Calls in them: ${b.calls}, of which ${b.applicable} could be asked about. Budget ${b.budget}: ${b.asked} read, ${b.mapped} mapped, ${b.governed} of those governed, ${b.overBudget} left over, ${b.notApplicable} not applicable.`,
    );
    lines.push("No place was found from the requirement's words: this path does not search by them.", "");

    if (r.findings.length > 0) {
      lines.push("### Worth checking", "");
      for (const f of r.findings) {
        lines.push(`#### ${f.file}:${f.lines} · ${f.function} — \`${f.call}\``);
        lines.push(`- **Reached**: ${originWords(f.origin, f.via)}`);
        lines.push(`- **Requirement ${f.requirementId}**: "${f.quote}"`);
        lines.push(`- **Assumed**: ${f.condition}`);
        lines.push(`- **Jev, on whether the requirement requires it here**: ${f.mapping.verdict} (${f.mapping.probability.toFixed(2)})`);
        lines.push(`- **Jev, on what the function returns**: ${f.observation} (${f.probability.toFixed(2)})`);
        lines.push(`- **Why it is listed**: ${f.why}`, "");
      }
    }

    if (r.observed.length === 0) {
      // A run stopped at its own limit can have read a mapping and no reading of the code: that is
      // not "nothing", and the mappings are printed below.
      lines.push(r.mappings.length === 0 ? "_Nothing was read._" : "_What a function returns was not read for any call._", "");
      // Only the ones that are not already below with a reason of their own. A budgeted call every
      // one of which was held reads, otherwise, as a list of calls nothing was asked about for no
      // stated reason — while the real reasons sit in the next section.
      const withReason = new Set(r.unchecked.map((u) => `${u.file}\u0000${u.function}\u0000${u.call}`));
      const silent = r.wouldAsk.filter((w) => !withReason.has(`${w.file}\u0000${w.function}\u0000${w.call}`));
      if (silent.length > 0) {
        lines.push("### Inside the budget", "", "The calls the budget selected. Nothing was asked about them here.", "");
        for (const w of silent) lines.push(`- ${w.file} · ${w.function} — \`${w.call}\` _(${originWords(w.origin, w.via)})_`);
        lines.push("");
      }
    }
    for (const o of r.observed) {
      lines.push(`- **${o.file} · ${o.function}** — \`${o.call}\` _(${originWords(o.origin, o.via)})_`);
      lines.push(`  - when that call fails: **${o.result.observation}** (${o.result.probability.toFixed(2)}) — ${o.result.why}`);
    }
    // Both sections come off the same list, so a call cannot be in one reading and not the other.
    const governed = r.mappings.filter((m) => m.governs);
    const rest = r.mappings.filter((m) => !m.governs);
    if (governed.length > 0) {
      lines.push("", "### Read as required by the requirement", "", "Whether or not the reading of the call agreed with it. A run that lists nothing still read something, and this is what it read.", "");
      for (const m of governed) lines.push(`- ${m.file} · ${m.function} — \`${m.call}\`: ${m.why}`);
    }
    if (rest.length > 0) {
      lines.push("", "### Read, but not required of by the requirement", "");
      for (const m of rest) lines.push(`- ${m.file} · ${m.function} — \`${m.call}\`: ${m.why}`);
    }
    if (r.unchecked.length > 0) {
      lines.push("", "### Not checked", "");
      for (const u of r.unchecked) lines.push(`- ${u.file} · ${u.function} — \`${u.call}\` _(${originWords(u.origin, u.via)})_: ${u.why}`);
    }
    if (r.notes.length > 0) {
      lines.push("", "### Notes", "");
      for (const n of r.notes) lines.push(`- ${n}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
