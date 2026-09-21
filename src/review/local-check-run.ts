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
//   2. the requirement's own words open files, through the same lexical search the tool already
//      has, and the planner picks calls in those files by id, each with the clause it checks
//   3. every call in every function either finder reached is added — a finder says where to look,
//      and the defect is usually a different call in the same body
//   4. calls whose callee resolves here to something returning a `Result` are askable; the rest are
//      held, with the reason, in the report
//   5. **one** judgment budget for the requirement, spent round-robin over functions, so neither a
//      busy body nor a busy file can take the run
//   6. each of those calls is put to the mapping — does the requirement require anything of it? —
//      and where the answer is yes and the reading of the call contradicts it, the call is listed
//      as worth checking
//
// Nothing in this file knows a function name, a helper name or an expected answer.
//
// **A local observation is not a requirement verdict.** A changed line says the work was done
// there; resolving that a callee returns a `Result` makes a question askable. Neither makes the
// requirement apply — the mapping is what says that, it is asked separately, and it is never told
// what the code does. There is no requirement-level status here and no failing exit code: a
// finding is two readings that disagree, printed with everything needed to disagree with them.

import { analyzeChange } from "../change/seeds.ts";
import { Discoverer, requirementWords } from "../discovery/discover.ts";
import { buildEvidence } from "../evidence/builder.ts";
import { redact } from "../evidence/redact.ts";
import type { JudgmentProvider } from "../judgments/provider.ts";
import type { Git } from "../repository/git.ts";
import type { Candidate, Requirement } from "../types.ts";
import { applicabilityOf, type Applicability } from "../plan/applicability.ts";
import { listingFor, type CallCandidate, type FunctionCandidate } from "../plan/candidates.ts";
import { CandidateFiles, sitesFromChange } from "../plan/from-diff.ts";
import { BAR, conditionFor, describe, locateCall, questionsFor, type LocalResult } from "../plan/local-check.ts";
import { checkMapping, type Mapper, type Mapping } from "../plan/mapping.ts";
import { selectSites, type FunctionOrigin, type Pick, type Site, type SiteSource } from "../plan/select.ts";
import { probabilityOf } from "./requirement.ts";

export interface Planner {
  /** Picks calls from a listing. Given the requirement's text and the listing; never the answers. */
  /** `failed` separates "nothing here is governed" from "the request did not come back". */
  pick(input: { requirement: string; file: string; listing: ReturnType<typeof listingFor> }): Promise<{ picks: Pick[]; notCovered?: string[]; failed?: string }>;
}

export interface LocalCheckOptions {
  /** How many calls a requirement may be judged at, over every file it reached. */
  budget: number;
  /** How many files the requirement's words may open for the planner. */
  maxFiles: number;
  maxPrimaryChars: number;
  maxRelatedChars: number;
  /**
   * Build the set and stop: no planner, no judgments, no request of any kind.
   *
   * What it answers is whether a call is reachable and inside the budget, which is the question to
   * settle before spending anything. The planner is not consulted, so the picks that would share
   * the budget on a real run are absent — the report says so rather than implying the set is final.
   */
  candidatesOnly?: boolean;
}

export const DEFAULT_LOCAL_CHECK: LocalCheckOptions = { budget: 20, maxFiles: 2, maxPrimaryChars: 8000, maxRelatedChars: 0 };

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
  function: string;
  call: string;
  /** From the requirement's own text, checked to be in it. */
  quote: string;
  reason: string;
  /** The condition that was assumed when the function was read. */
  condition: string;
  observation: LocalResult["observation"];
  probability: number;
  disagreement: string;
}

export interface LocalCheckResult {
  requirementId: string;
  requirementText: string;
  filesOpened: string[];
  /** What the planner picked, and what it said each call checks. */
  picks: { call: string; function: string; clause?: string }[];
  rejectedPicks: { callId: string; reason: string }[];
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
  /** Calls that were observed but carry no usable mapping: not applicable, not settled, not answered. */
  unmapped: Unchecked[];
  findings: Finding[];
  /** The set and the budget, so a report never leaves the size of either to be guessed. */
  counts: {
    budget: number;
    functions: Record<FunctionOrigin, number>;
    calls: number;
    applicable: number;
    asked: number;
    mapped: number;
    overBudget: number;
    notApplicable: number;
  };
  notes: string[];
}

/** What the schema asks the planner for; nothing enforces it on the way back. */
const MAX_CLAUSE = 300;

/**
 * A backtick or a control character. Built from a string of escapes rather than written as a
 * regular expression literal, because writing an escape for one of these into a source file
 * writes the character itself. The line and paragraph separators are not listed: the whitespace
 * pass below already covers them.
 */
const UNPRINTABLE = new RegExp("[`\\u0000-\\u001f\\u007f-\\u009f]", "g");

/**
 * The planner's own words, made safe to put in a report.
 *
 * A clause is model prose that goes straight into Markdown, and the only thing keeping a verdict
 * out of this path was that `describe` has no field one fits in. The clause field is a field one
 * fits in. It cannot be filtered for meaning — a clause quotes a requirement, and a requirement
 * may say "must not be silently treated as…" — so it is contained instead: one line, bounded, no
 * code span to break out of, and rendered in quotes as something the plan said rather than
 * something this tool concluded.
 */
export function statedClause(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const flat = redact(text)
    .text.replace(UNPRINTABLE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length === 0) return undefined;
  return flat.length > MAX_CLAUSE ? `${flat.slice(0, MAX_CLAUSE - 1)}…` : flat;
}

/**
 * A call as the report prints it.
 *
 * The report is a deliverable — stdout, a file, a comment on a pull request — so an expression
 * with a secret-shaped argument does not belong in it any more than it belongs in a request.
 * The condition sent to the model is built from the same redacted text.
 */
const shown = (call: CallCandidate) => redact(call.expression).text;

/** Files the requirement's own words find, most hits first. The tool's existing lexical search. */
async function filesFor(discoverer: Discoverer, requirement: Requirement, max: number): Promise<string[]> {
  const counts = new Map<string, number>();
  const words = [...new Set([...requirementWords(requirement.text), ...requirement.searchHints])];
  for (const word of words.slice(0, 8)) {
    const { hits } = await discoverer.search(word);
    for (const hit of hits) counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([path]) => /\.(rs)$/.test(path))
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([path]) => path);
}

export interface LocalCheckRevisions {
  before: string;
  after: string;
}

export async function runLocalCheck(
  git: Git,
  revisions: LocalCheckRevisions,
  requirements: readonly Requirement[],
  planner: Planner,
  mapper: Mapper,
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
    const picks: LocalCheckResult["picks"] = [];
    const observed: Observed[] = [];
    const unchecked: Unchecked[] = [];
    const unmapped: Unchecked[] = [];
    const findings: Finding[] = [];

    // The change's sources are shared between requirements, so each requirement gets its own
    // shallow copy to hang its picks on.
    const sources = new Map<string, SiteSource>([...fromChange.sources].map(([path, source]) => [path, { ...source }]));

    const opened = options.candidatesOnly ? [] : await filesFor(discoverer, requirement, options.maxFiles);
    if (options.candidatesOnly) notes.push("the planner was not consulted (candidates only), so no call carries a clause and the picks that would share this budget are absent");
    else if (opened.length === 0) notes.push("the requirement's own words found no Rust file at this commit");

    for (const file of opened) {
      const candidates = await files.of(file);
      if (!candidates) {
        notes.push(`${file} could not be read at this commit`);
        continue;
      }
      if (candidates.omitted.functions > 0) notes.push(`${file}: ${candidates.omitted.functions} functions were left out of the listing by its cap`);
      if (candidates.omitted.calls > 0) notes.push(`${file}: ${candidates.omitted.calls} calls were left out of the listing by its cap`);
      // The requirement's text goes out with the listing; both are redacted on the way, the same
      // as an evidence packet is.
      const chosen = await planner.pick({ requirement: redact(requirement.text).text, file, listing: listingFor(candidates) });
      if (chosen.failed) notes.push(`the planner did not answer about ${file} (${chosen.failed}), so no call there carries a clause`);
      else if (chosen.picks.length === 0) notes.push(`the planner read ${file} and named no call the requirement governs`);
      // What the planner says its own picks leave unchecked. It was asked for, schema and all,
      // and then read by nobody.
      for (const gap of chosen.notCovered ?? []) notes.push(`the planner says its picks in ${file} leave this unchecked: ${gap}`);
      const picked = chosen.picks.map((p) => {
        const clause = statedClause(p.clause);
        return { callId: p.callId, ...(clause !== undefined ? { clause } : {}) };
      });
      const source = sources.get(file);
      if (source) source.picks = picked;
      else sources.set(file, { candidates, picks: picked });
    }

    const selection = await selectSites([...sources.values()], decide, options.budget);
    for (const p of selection.picked) picks.push({ call: shown(p.call), function: p.fn.name, ...(p.clause ? { clause: p.clause } : {}) });
    for (const h of selection.held) unchecked.push({ file: h.fn.path, function: h.fn.name, call: shown(h.call), origin: h.origin, why: h.applicability && !h.applicability.ok ? h.applicability.reason : "held" });
    for (const o of selection.overBudget) unchecked.push({ file: o.fn.path, function: o.fn.name, call: shown(o.call), origin: o.origin, why: `the budget of ${options.budget} was already spent` });

    // Every call this run offers the mapping. A mapping naming anything else is refused.
    const offered = new Set(selection.budgeted.map((s) => s.call.id));
    let asked = 0;
    let mapped = 0;
    for (const site of options.candidatesOnly ? [] : selection.budgeted) {
      const candidate: Candidate = {
        path: site.fn.path,
        startLine: site.fn.startLine,
        endLine: site.fn.endLine,
        symbol: site.fn.name,
        // The function's own origin, not the call's: a call the planner named inside a changed
        // function is `picked`, and reading it for this told the model the place was untouched.
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

      // The mapping is asked **before** the judgment and is given no part of it. An answer that
      // knew what the code does would be free to agree with it, and the whole value of the link is
      // that it is about the sentence rather than about the code's behaviour.
      const answered = await mapper.map({
        requirementId: requirement.id,
        requirementText: requirement.text,
        callId: site.call.id,
        call: condition.operation.replace(/`/g, ""),
        function: site.fn.name,
        body,
      });
      mapped += 1;
      const place = { file: site.fn.path, function: site.fn.name, call: shown(site.call), origin: site.origin };
      let mapping: Mapping | undefined;
      if (answered.failed) unmapped.push({ ...place, why: `the mapping was not answered (${answered.failed})` });
      else {
        const checked = checkMapping(answered.raw, { callIds: offered, requirementId: requirement.id, requirementText: requirement.text });
        if (!checked.ok) unmapped.push({ ...place, why: `the mapping was refused: ${checked.reason}` });
        else if (checked.mapping.verdict !== "applies") unmapped.push({ ...place, why: `the mapping says the requirement ${checked.mapping.verdict === "does_not_apply" ? "does not govern this call" : "does not settle this call"}: ${checked.mapping.reason}` });
        else mapping = checked.mapping;
      }

      const answers = await judge.judge(evidence.packet, questionsFor(condition));
      const answer = answers.on_error_result;
      const p = answer ? probabilityOf(answer, answer.choice) : 0;
      asked += 1;
      const result = describe(answer, p, site.clause);
      observed.push({ ...place, result });

      // A finding needs both halves: a requirement that governs this call, and an observation that
      // contradicts what it requires. Either alone is not one, and neither is a reading below the
      // bar — that is an unread answer, not a disagreement.
      if (mapping && result.observation === "returns_success") {
        findings.push({
          requirementId: requirement.id,
          ...place,
          quote: mapping.quote,
          reason: mapping.reason,
          condition: `${condition.setup} ${condition.occurrence}, ${condition.operation} returns ${condition.yields}. ${condition.others}`,
          observation: result.observation,
          probability: result.probability,
          disagreement: `the requirement is read as requiring that this failure not come back as a success, and \`${site.fn.name}\` was read as returning one`,
        });
      }
    }

    out.push({
      requirementId: requirement.id,
      requirementText: requirement.text,
      filesOpened: opened,
      picks,
      rejectedPicks: selection.rejected,
      wouldAsk: selection.budgeted.map((s) => ({ file: s.fn.path, function: s.fn.name, call: shown(s.call), origin: s.origin })),
      observed,
      unchecked,
      unmapped,
      findings,
      counts: {
        budget: options.budget,
        functions: selection.functions,
        calls: selection.widened.length,
        applicable: selection.applicable.length,
        asked,
        mapped,
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
  picked: "the plan named this call",
  same_function: "in a function the plan named",
  changed: "in a function the change touched",
  calls_changed: "in a function that calls one the change touched",
};

/**
 * The report: what is worth checking, then what was observed, then what was not checked and why.
 *
 * No requirement-level verdict appears anywhere in it. A finding is about one call, and it is
 * printed as two model readings that disagree, with everything needed to disagree with them —
 * not as this tool concluding that a requirement is violated.
 */
export function renderLocalCheck(results: readonly LocalCheckResult[]): string {
  const lines: string[] = ["# Local check (experimental)", "", `Each line is one call, under the condition that the call fails. The bar is ${BAR}.`, "", "**A local observation is not a statement about the requirement.** It bears on the requirement only where the plan said which clause governs that call; everything else is an observation about code.", ""];
  for (const r of results) {
    const c = r.counts;
    lines.push(`## ${r.requirementId}`, "", `> ${r.requirementText}`, "");
    lines.push(`Files the requirement's words opened: ${r.filesOpened.join(", ") || "none"}`);
    lines.push(`Functions reached: ${c.functions.changed} the change touched, ${c.functions.calls_changed} calling one of those, ${c.functions.picked} only the plan named.`);
    lines.push(`Calls in them: ${c.calls}, of which ${c.applicable} could be asked about. Budget ${c.budget}: ${c.asked} asked, ${c.overBudget} left over, ${c.notApplicable} not applicable.`, "");

    if (r.findings.length > 0) {
      lines.push("### Worth checking", "", "Each of these is a requirement read as governing a call, and a reading of that call that contradicts it. **Two model answers stand behind each one, and neither checks the other** — what follows is everything needed to disagree with it.", "");
      for (const f of r.findings) {
        lines.push(`#### ${f.file} · ${f.function} — \`${f.call}\``);
        lines.push(`- **The requirement says**: "${f.quote}"`);
        lines.push(`- **Read as governing this call because**: ${f.reason}`);
        lines.push(`- **Assumed**: ${f.condition}`);
        lines.push(`- **Read as returning**: ${f.observation} (${f.probability.toFixed(2)})`);
        lines.push(`- **Why that disagrees**: ${f.disagreement}`, "");
      }
    }

    if (r.observed.length === 0) {
      lines.push("_Nothing was asked._", "");
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
      // The clause is the plan's sentence, not this tool's. It is quoted so a reader can see whose
      // words they are, and `statedClause` has already made it one line that cannot break out.
      const bears = o.result.bearsOnRequirement ? `bears on the requirement. The plan said this call checks: "${o.result.clause}"` : "an observation about code; no clause was stated for this call, so it is not read against the requirement";
      lines.push(`- **${o.file} · ${o.function}** — \`${o.call}\` _(${ORIGIN_WORDS[o.origin]})_`);
      lines.push(`  - when that call fails: **${o.result.observation}** (${o.result.probability.toFixed(2)}) — ${o.result.why}`);
      lines.push(`  - ${bears}`);
    }
    if (r.unmapped.length > 0) {
      lines.push("", "### Read, but not answered against the requirement", "");
      for (const u of r.unmapped) lines.push(`- ${u.file} · ${u.function} — \`${u.call}\`: ${u.why}`);
    }
    if (r.unchecked.length > 0) {
      lines.push("", "### Not checked", "");
      for (const u of r.unchecked) lines.push(`- ${u.file} · ${u.function} — \`${u.call}\` _(${ORIGIN_WORDS[u.origin]})_: ${u.why}`);
    }
    if (r.rejectedPicks.length > 0) {
      lines.push("", "### The plan named calls that are not in the listing", "");
      for (const p of r.rejectedPicks) lines.push(`- ${p.callId}: ${p.reason}`);
    }
    if (r.notes.length > 0) {
      lines.push("", "### Notes", "");
      for (const n of r.notes) lines.push(`- ${n}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
