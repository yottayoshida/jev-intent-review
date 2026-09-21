// The experimental path: from a requirement to observations about particular calls.
//
// What the ordinary run does is ask, for each place discovery offers, whether the requirement
// holds there. Measured over ten real pull requests that never produced a VERIFIED. This path asks
// something smaller and answerable instead: **when this call fails, does this function return a
// success?** The bench that settled its wording is in `docs/`; what is new here is that a run can
// reach it from a requirement rather than from a person naming a function and a call.
//
// The shape:
//
//   1. the requirement's own words find files, through the same lexical search the tool already has
//   2. the planner picks calls in those files, by id, from a listing built at the commit
//   3. every call in the functions it picked is added — the picks say where the requirement was
//      recognised, and the defect is often a different call in the same body
//   4. calls whose callee resolves here to something returning a `Result` are askable; the rest are
//      held, with the reason, in the report
//   5. the judgment budget goes round-robin over functions, so one busy body cannot take the run
//
// Nothing in this file knows a function name, a helper name or an expected answer.
//
// **A local observation is not a requirement verdict.** An observation only bears on the
// requirement when the planner said which clause governs that call; resolving that a callee
// returns a `Result` makes a question askable, not applicable. The report keeps the two apart, and
// nothing here reports a violation.

import { Discoverer, requirementWords } from "../discovery/discover.ts";
import { buildEvidence } from "../evidence/builder.ts";
import type { JudgmentProvider } from "../judgments/provider.ts";
import type { Git } from "../repository/git.ts";
import type { Candidate, Requirement } from "../types.ts";
import { applicabilityOf } from "../plan/applicability.ts";
import { enumerate, listingFor, type Candidates } from "../plan/candidates.ts";
import { BAR, conditionFor, describe, locateCall, questionsFor, type LocalResult } from "../plan/local-check.ts";
import { selectSites, type Pick, type Site } from "../plan/select.ts";
import { probabilityOf } from "./requirement.ts";

export interface Planner {
  /** Picks calls from a listing. Given the requirement's text and the listing; never the answers. */
  pick(input: { requirement: string; file: string; listing: ReturnType<typeof listingFor> }): Promise<{ picks: Pick[]; notCovered?: string[] }>;
}

export interface LocalCheckOptions {
  /** How many calls a requirement may be judged at. */
  budget: number;
  /** How many files the requirement's words may open. */
  maxFiles: number;
  maxPrimaryChars: number;
  maxRelatedChars: number;
}

export const DEFAULT_LOCAL_CHECK: LocalCheckOptions = { budget: 5, maxFiles: 2, maxPrimaryChars: 8000, maxRelatedChars: 0 };

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
  why: string;
}

export interface LocalCheckResult {
  requirementId: string;
  requirementText: string;
  filesOpened: string[];
  /** What the planner picked, and what it said each call checks. */
  picks: { call: string; function: string; clause?: string }[];
  rejectedPicks: { callId: string; reason: string }[];
  observed: Observed[];
  unchecked: Unchecked[];
  notes: string[];
}

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

export async function runLocalCheck(
  git: Git,
  commit: string,
  requirements: readonly Requirement[],
  planner: Planner,
  judge: JudgmentProvider,
  include: (path: string) => boolean,
  options: LocalCheckOptions = DEFAULT_LOCAL_CHECK,
): Promise<LocalCheckResult[]> {
  const discoverer = new Discoverer(git, commit, { include, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const out: LocalCheckResult[] = [];

  for (const requirement of requirements) {
    const notes: string[] = [];
    const files = await filesFor(discoverer, requirement, options.maxFiles);
    const picks: LocalCheckResult["picks"] = [];
    const rejectedPicks: LocalCheckResult["rejectedPicks"] = [];
    const observed: Observed[] = [];
    const unchecked: Unchecked[] = [];

    if (files.length === 0) notes.push("the requirement's own words found no Rust file at this commit");

    for (const file of files) {
      const source = await git.readText(commit, file);
      if (source === null) {
        notes.push(`${file} could not be read at this commit`);
        continue;
      }
      const candidates: Candidates = enumerate(file, source);
      if (candidates.omitted.calls > 0) notes.push(`${file}: ${candidates.omitted.calls} calls were left out of the listing the planner chose from`);

      const chosen = await planner.pick({ requirement: requirement.text, file, listing: listingFor(candidates) });
      const selection = await selectSites(candidates, chosen.picks, (fn, call) => applicabilityOf(discoverer, fn, call), options.budget);
      for (const p of selection.picked) picks.push({ call: p.call.expression, function: p.fn.name, ...(p.clause ? { clause: p.clause } : {}) });
      rejectedPicks.push(...selection.rejected);
      for (const h of selection.held) unchecked.push({ file, function: h.fn.name, call: h.call.expression, why: h.applicability && !h.applicability.ok ? h.applicability.reason : "held" });
      for (const o of selection.overBudget) unchecked.push({ file, function: o.fn.name, call: o.call.expression, why: `the budget of ${options.budget} was already spent` });

      for (const site of selection.budgeted) {
        const candidate: Candidate = {
          path: file,
          startLine: site.fn.startLine,
          endLine: site.fn.endLine,
          symbol: site.fn.name,
          changed: false,
          reasons: [`a call the plan selected is in ${site.fn.name}`],
        };
        const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: options.maxPrimaryChars, maxRelatedChars: options.maxRelatedChars });
        const body = evidence.packet.evidence.code;
        const located = locateCall(body, site.call);
        if (!located.ok) {
          unchecked.push({ file, function: site.fn.name, call: site.call.expression, why: located.reason ?? "the call could not be located in the body read here" });
          continue;
        }
        const condition = conditionFor(site.fn, site.call);
        const answers = await judge.judge(evidence.packet, questionsFor(condition));
        const answer = answers.on_error_result;
        const p = answer ? probabilityOf(answer, answer.choice) : 0;
        observed.push({ file, function: site.fn.name, call: site.call.expression, origin: site.origin, result: describe(answer, p, site.clause) });
      }
    }

    out.push({ requirementId: requirement.id, requirementText: requirement.text, filesOpened: files, picks, rejectedPicks, observed, unchecked, notes });
  }
  return out;
}

/** The report. Observations first, then what was not checked and why; never a violation verdict. */
export function renderLocalCheck(results: readonly LocalCheckResult[]): string {
  const lines: string[] = ["# Local check (experimental)", "", `Each line is one call, under the condition that the call fails. The bar is ${BAR}.`, "", "**A local observation is not a statement about the requirement.** It bears on the requirement only where the plan said which clause governs that call; everything else is an observation about code.", ""];
  for (const r of results) {
    lines.push(`## ${r.requirementId}`, "", `> ${r.requirementText}`, "");
    lines.push(`Files the requirement's words opened: ${r.filesOpened.join(", ") || "none"}`, "");
    if (r.observed.length === 0) lines.push("_Nothing was asked._", "");
    for (const o of r.observed) {
      const bears = o.result.bearsOnRequirement ? `bears on the requirement — the plan's clause: ${o.result.clause}` : "an observation about code; no clause was stated for this call, so it is not read against the requirement";
      lines.push(`- **${o.file} · ${o.function}** — \`${o.call}\`${o.origin === "same_function" ? " _(added from the same function)_" : ""}`);
      lines.push(`  - when that call fails: **${o.result.observation}** (${o.result.probability.toFixed(2)}) — ${o.result.why}`);
      lines.push(`  - ${bears}`);
    }
    if (r.unchecked.length > 0) {
      lines.push("", "### Not checked", "");
      for (const u of r.unchecked) lines.push(`- ${u.file} · ${u.function} — \`${u.call}\`: ${u.why}`);
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
