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
//   1. the change offers the functions holding changed lines, and one hop out their callers
//   2. every call in every one of those functions is added — the diff says which body, and the
//      defect is usually a different call in it
//   3. calls whose callee resolves here to something returning a `Result` are askable; the rest are
//      held, with the reason, in the report
//   4. **one** judgment budget for the requirement, spent round-robin over functions, so neither a
//      busy body nor a busy file can take the run
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
import { codeSpan, intentSection } from "../report/markdown.ts";
import type { Candidate, IntentSource, IntentSpec, Requirement } from "../types.ts";
import { applicabilityOf, type Applicability } from "../plan/applicability.ts";
import type { CallCandidate, FunctionCandidate } from "../plan/candidates.ts";
import { CandidateFiles, sitesFromChange } from "../plan/from-diff.ts";
import { BAR, conditionFor, describe, locateCall, questionsFor, type LocalResult } from "../plan/local-check.ts";
import { acceptMapping, mappingQuestionFor, MAPPING_BAR, MAPPING_PROPERTY, type MappingAnswer, type MappingVerdict, whyListed } from "../plan/mapping.ts";
import { selectSites, type FunctionOrigin, type Site, type SiteSource } from "../plan/select.ts";
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
}

export const DEFAULT_LOCAL_CHECK: LocalCheckOptions = { budget: 20, maxPrimaryChars: 8000, maxRelatedChars: 0 };

export interface Observed {
  file: string;
  function: string;
  call: string;
  origin: Site["origin"];
  result: LocalResult;
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

  const out: LocalCheckResult[] = [];
  for (const requirement of requirements) {
    const notes = [...changeNotes];
    const observed: Observed[] = [];
    const unchecked: Unchecked[] = [];
    const mappings: MappingRecord[] = [];
    const findings: Finding[] = [];

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
      const condition = conditionFor(site.fn, site.call);
      const expression = condition.operation.replace(/`/g, "");
      const place = { file: site.fn.path, function: site.fn.name, call: shown(site.call), origin: site.origin };

      // Two questions, two requests. The mapping is about the requirement's words and must not be
      // asked under the failure the observation assumes — nor in the same breath as it.
      let unanswered = "the mapping question was not answered";
      const mappingAnswers = await judge.judge(evidence.packet, mappingQuestionFor(site.fn, site.call, expression)).catch((error: unknown) => {
        // A failure that ends the run ends it here. Any other is this call's alone, and the report
        // says what kind it was and which host it came from — never the host's own words, which
        // would be printed as Markdown.
        if (!(error instanceof ProviderError) || FATAL_KINDS.has(error.kind)) throw error;
        unanswered = `the mapping question was not answered (${error.kind}${error.where === undefined ? "" : ` from ${error.where}`})`;
        return {} as Record<string, never>;
      });
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

      const answers = await judge.judge(evidence.packet, questionsFor(condition));
      const answer = answers.on_error_result;
      const p = answer ? probabilityOf(answer, answer.choice) : 0;
      asked += 1;
      const result = describe(answer, p);
      observed.push({ ...place, result });

      // A finding needs both halves, each over the same bar: a requirement read as requiring this
      // of the call, and a reading of the call that returns a success anyway.
      if (mapping.governs && result.observation === "returns_success") {
        findings.push({
          requirementId: requirement.id,
          file: place.file,
          lines: `${site.fn.startLine}-${site.fn.endLine}`,
          function: place.function,
          call: place.call,
          quote,
          condition: `${condition.setup} ${condition.occurrence}, ${condition.operation} returns ${condition.yields}. ${condition.others}`,
          property: MAPPING_PROPERTY,
          mapping,
          observation: result.observation,
          probability: result.probability,
          why: whyListed(site.fn.name, mapping, result.observation, result.probability),
        });
      }
    }

    out.push({
      requirementId: requirement.id,
      requirementText: requirement.text,
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
      },
      // A file both the change and the requirement's words reached has its cap counted twice.
      notes: [...new Set(notes)],
    });
  }
  return out;
}

const ORIGIN_WORDS: Record<Site["origin"], string> = {
  changed: "in a function the change touched",
  calls_changed: "in a function that calls one the change touched",
};

/**
 * The report: what is worth checking, then what was read, then what was not checked and why.
 *
 * Every sentence in it is this file's or the input's. Nothing is a model's prose — the two model
 * answers appear as a choice and a number, named as Jev's, and the reasoning between them is
 * assembled from the parts. No requirement-level verdict appears anywhere.
 */
export function renderLocalCheck(results: readonly LocalCheckResult[], read?: { intent: IntentSpec; sources: readonly Omit<IntentSource, "text">[]; prAuthor?: string; notes?: readonly string[] }): string {
  const lines: string[] = [
    "# Local check (experimental)",
    "",
    `Two questions are put to Jev about each call, separately: whether the requirement requires that a failure of it not reach the caller as a success, and what the function returns when it does fail. The bar for each is ${BAR}.`,
    "",
    "**Nothing here is a requirement verdict.** A call is listed when both answers clear the bar and disagree; the two answers do not check each other, and everything either of them rests on is printed.",
    "",
    ...(read ? intentSection(read.intent, read.sources, read) : []),
  ];
  for (const r of results) {
    const c = r.counts;
    // The requirement is the author's text: a code span, so no line of it can become a heading, a
    // comment that hides the rest of the report, or a workflow command; and redacted for display.
    lines.push(`## ${r.requirementId}`, "", `> ${codeSpan(redact(r.requirementText).text)}`, "");
    lines.push(`Functions reached: ${c.functions.changed} the change touched, ${c.functions.calls_changed} calling one of those.`);
    lines.push(`Calls in them: ${c.calls}, of which ${c.applicable} could be asked about. Budget ${c.budget}: ${c.asked} read, ${c.mapped} mapped, ${c.governed} of those governed, ${c.overBudget} left over, ${c.notApplicable} not applicable.`, "");

    if (r.findings.length > 0) {
      lines.push("### Worth checking", "");
      for (const f of r.findings) {
        lines.push(`#### ${f.file}:${f.lines} · ${f.function} — \`${f.call}\``);
        lines.push(`- **Requirement ${f.requirementId}**: ${codeSpan(f.quote)}`);
        lines.push(`- **Assumed**: ${f.condition}`);
        lines.push(`- **Jev, on whether the requirement requires it here**: ${f.mapping.verdict} (${f.mapping.probability.toFixed(2)})`);
        lines.push(`- **Jev, on what the function returns**: ${f.observation} (${f.probability.toFixed(2)})`);
        lines.push(`- **Why it is listed**: ${f.why}`, "");
      }
    }

    if (r.observed.length === 0) {
      lines.push("_Nothing was read._", "");
      // Only the ones that are not already below with a reason of their own. A budgeted call every
      // one of which was held reads, otherwise, as a list of calls nothing was asked about for no
      // stated reason — while the real reasons sit in the next section.
      const withReason = new Set(r.unchecked.map((u) => `${u.function}\u0000${u.call}`));
      const silent = r.wouldAsk.filter((w) => !withReason.has(`${w.function}\u0000${w.call}`));
      if (silent.length > 0) {
        lines.push("### Inside the budget", "", "The calls the budget selected. Nothing was asked about them here.", "");
        for (const w of silent) lines.push(`- ${w.file} · ${w.function} — \`${w.call}\` _(${ORIGIN_WORDS[w.origin]})_`);
        lines.push("");
      }
    }
    for (const o of r.observed) {
      lines.push(`- **${o.file} · ${o.function}** — \`${o.call}\` _(${ORIGIN_WORDS[o.origin]})_`);
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
      for (const u of r.unchecked) lines.push(`- ${u.file} · ${u.function} — \`${u.call}\` _(${ORIGIN_WORDS[u.origin]})_: ${u.why}`);
    }
    if (r.notes.length > 0) {
      lines.push("", "### Notes", "");
      for (const n of r.notes) lines.push(`- ${n}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
