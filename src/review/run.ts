// The review itself, from a resolved intent to a report: change seeds, discovery, evidence, one
// judgment per requirement × candidate, and the policy that turns answers into findings. The
// command line does the I/O around it; tests drive it with a scripted provider.

import { analyzeChange } from "../change/seeds.ts";
import type { LoadedConfig } from "../config/config.ts";
import { pathFilter } from "../config/glob.ts";
import { Discoverer } from "../discovery/discover.ts";
import { buildEvidence } from "../evidence/builder.ts";
import { redact } from "../evidence/redact.ts";
import { ProviderError } from "../judgments/cloudflare.ts";
import type { JudgmentProvider } from "../judgments/provider.ts";
import { CANDIDATE_QUESTIONS, COMPLETENESS_QUESTIONS, QUESTIONS_HASH } from "../judgments/questions.ts";
import type { Git } from "../repository/git.ts";
import type { Revisions } from "../repository/revisions.ts";
import { EXIT, ToolError, locationKey, type Candidate, type CandidateResult, type IntentSource, type IntentSpec, type Location, type RequirementResult, type ReviewReport, type SearchRecord } from "../types.ts";
import { VERSION } from "../version.ts";
import { aggregate, decide, probabilityOf, verdictOf, type Thresholds } from "./requirement.ts";

export interface RunInput {
  git: Git;
  revisions: Revisions;
  loaded: LoadedConfig;
  intent: IntentSpec;
  sources: IntentSource[];
  prBodyOnly: boolean;
  provider: JudgmentProvider;
  sent: () => { requests: number; bytes: number };
  repository: string;
  trace: (line: string) => void;
  notes?: string[]; // from resolving the intent, for the report
  endpoint?: string; // where the judgments were sent: scheme, host and port
}

const BUDGET = "the run's request, byte or time budget ran out";

// These end the run: every further request would fail the same way. A bad request (400, 413) is
// about one packet, so it only makes that place unknown — unless a second one arrives with
// nothing yet answered, which the client reads as the endpoint and reports as one of these.
const FATAL = new Set(["auth", "payment", "endpoint"]);

function providerFailure(error: unknown): string {
  if (error instanceof ProviderError) {
    if (FATAL.has(error.kind)) throw new ToolError(`the judgment provider refused the request: ${error.message}`, EXIT.provider);
    return `judgment failed (${error.kind}): ${error.message.slice(0, 160)}`;
  }
  throw error;
}

export async function runReview(input: RunInput): Promise<ReviewReport> {
  const { git, revisions, loaded, intent, provider, trace } = input;
  const config = loaded.config;
  const t: Thresholds = {
    violation: config.judgment.violation_probability,
    satisfaction: config.judgment.satisfaction_probability,
    relevance: config.judgment.relevance_probability,
  };
  const include = pathFilter(config.repository.include, config.repository.ignore);
  const change = await analyzeChange(git, revisions.before, revisions.after, include);
  trace(`changed files: ${change.changedPaths.length}`);
  for (const s of change.skipped) trace(`  skipped ${s.path}: ${s.reason}`);
  for (const r of change.regions) trace(`region ${r.path}:${r.block.startLine}-${r.block.endLine}${r.block.name ? ` ${r.block.name}` : ""}${r.block.windowed ? " (window)" : ""}`);
  trace(`calls around the changed lines: ${change.calledSymbols.filter((s) => !s.onChangedLine).map((s) => s.name).join(", ") || "(none)"}`);

  // Reasons this run cannot vouch that a requirement holds, whatever Jev answers.
  const blockers: string[] = [];
  const notes: string[] = [...(input.notes ?? [])];
  if (loaded.changedInPullRequest) {
    notes.push("The change edits .jev-intent-review.yml; the version before the change was used.");
    blockers.push("the change edits this tool's configuration");
  }
  if (change.changedPaths.some((p) => p.startsWith(".github/workflows/"))) {
    notes.push("The change edits a GitHub Actions workflow, which may run this tool differently.");
    blockers.push("the change edits a GitHub Actions workflow");
  }
  if (input.prBodyOnly) {
    const author = input.sources.find((s) => s.type === "pr_description")?.author;
    notes.push(`The requirements come only from the pull request's own description${author ? `, written by its author ${author}` : ""}.`);
    if (config.intent.pr_body_only === "unknown") blockers.push("the only statement of intent is the pull request's own description (intent.pr_body_only: unknown)");
  }

  const discoverer = new Discoverer(git, revisions.after, {
    include,
    maxCandidates: config.discovery.max_candidates_per_requirement,
    lexicalSearch: config.discovery.lexical_search,
    referenceSearch: config.discovery.reference_search !== "off",
  });

  const searches: SearchRecord[] = [];
  const incompleteReasons: string[] = [];
  const sentLocations = new Map<string, Location>();
  const requirements: RequirementResult[] = [];
  // Reached the endpoint and could not read one answer from it: the endpoint is wrong, or it is
  // not answering at all, and a report of nothing but "unknown" would pass for a review that ran.
  // A run that stopped on its own budget did reach nothing, and keeps its report.
  let reached = 0;
  let answered = 0;
  let candidateCount = 0;
  let changedCandidates = 0;

  for (const requirement of intent.requirements) {
    const found = await discoverer.discover(requirement, change);
    const incomplete = [...found.incomplete];
    const traceSearches = (list: SearchRecord[]) => {
      searches.push(...list);
      for (const s of list) trace(`${requirement.id} search [${s.layer}] ${s.query}: ${s.rejected ? `refused (${s.rejected})` : `${s.hits} hits`}${s.skipped ? `, ${s.skipped} in files not looked at` : ""}`);
    };
    traceSearches(found.searches);

    const judgeAll = (candidates: Candidate[]) => Promise.all(
      candidates.map(async (candidate): Promise<CandidateResult> => {
        const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: config.evidence.max_primary_chars, maxRelatedChars: config.evidence.max_related_chars });
        for (const location of evidence.sent) sentLocations.set(locationKey(location), location);
        const base = { candidate, truncated: evidence.truncated, evidence: [] as Location[], notes: [] as string[] };
        if (evidence.redactions > 0) base.notes.push(`${evidence.redactions} secret-shaped value(s) were redacted before sending`);
        try {
          const answers = await provider.judge(evidence.packet, CANDIDATE_QUESTIONS);
          reached += 1;
          answered += 1;
          const relevance = answers.relevance;
          const satisfaction = answers.satisfaction;
          if (!relevance || !satisfaction) throw new ProviderError("bad_response", "an answer is missing");
          const decision = decide(relevance, satisfaction, evidence.truncated, t);
          trace(
            `${requirement.id} ${candidate.path}:${candidate.startLine}-${candidate.endLine} relevance ${relevance.choice} ${probabilityOf(relevance, relevance.choice).toFixed(2)}, satisfaction ${satisfaction.choice} ${probabilityOf(satisfaction, satisfaction.choice).toFixed(2)} -> ${decision.outcome}`,
          );
          const pointTo = decision.outcome === "violates" ? (evidence.callSites.length > 0 ? evidence.callSites : [candidate]) : [];
          return { ...base, outcome: decision.outcome, relevance, satisfaction, evidence: pointTo.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })), notes: [...base.notes, ...decision.notes] };
        } catch (error) {
          const note = providerFailure(error);
          if (error instanceof ProviderError && error.kind === "budget") {
            if (!incomplete.includes(BUDGET)) incomplete.push(BUDGET);
          } else {
            reached += 1; // the endpoint, or the network to it, answered this one its own way
          }
          return { ...base, outcome: "unknown", notes: [...base.notes, note] };
        }
      }),
    );

    const results = await judgeAll(found.candidates);

    // One more hop through code judged a mere wrapper of a governed call: its callers are paths
    // too. Without this, `openSession(user) { return createSession(user.id) }` judged supporting
    // would hide every unguarded caller of openSession, with nothing to say so.
    const known = new Set(results.map((r) => locationKey(r.candidate)));
    // Whatever the probability and whatever the second answer: below the relevance threshold a
    // supporting candidate is not excluded, but it is not a path either, so its callers still are.
    const isWrapper = (r: CandidateResult) => r.relevance?.choice === "supporting" && r.candidate.reasons.some((x) => x.startsWith("calls "));
    for (const wrapper of results.filter(isWrapper)) {
      const room = Math.max(0, config.discovery.max_candidates_per_requirement - results.length);
      const more = await discoverer.callersOf(wrapper.candidate, requirement, change, known, room);
      traceSearches(more.searches);
      incomplete.push(...more.incomplete);
      const expanded = await judgeAll(more.candidates);
      if (expanded.some(isWrapper)) incomplete.push(`callers of a wrapper found through ${wrapper.candidate.symbol} were judged wrappers too; they were not followed further`);
      results.push(...expanded);
    }

    for (const reason of incomplete) incompleteReasons.push(`${requirement.id}: ${reason}`);
    candidateCount += results.length;
    changedCandidates += results.filter((r) => r.candidate.changed).length;
    const discoveryIncomplete = incomplete.length > 0;
    const requirementBlockers = [...blockers, ...incomplete.map((r) => `discovery was cut short (${r})`)];
    let result = aggregate(requirement.id, results, requirementBlockers, discoveryIncomplete);

    // J5, only where it could change the outcome: a signal about the search, never proof of it.
    // Anything but a clear "likely complete" withholds VERIFIED.
    if (result.status === "verified") {
      try {
        const state = { requirement: { id: requirement.id, text: redact(requirement.text).text }, found: results.filter((r) => r.outcome !== "unrelated").map((r) => ({ path: r.candidate.path, lines: `${r.candidate.startLine}-${r.candidate.endLine}`, ...(r.candidate.symbol ? { symbol: r.candidate.symbol } : {}) })) };
        const completeness = (await provider.judge(state, COMPLETENESS_QUESTIONS)).completeness;
        reached += 1;
        answered += 1;
        const p = completeness ? probabilityOf(completeness, completeness.choice) : 0;
        if (!completeness || completeness.choice !== "likely_complete" || p < 0.5) {
          result = aggregate(requirement.id, results, [...requirementBlockers, `Jev did not judge the list of places likely complete (${completeness ? `${completeness.choice} ${p.toFixed(2)}` : "no answer"})`], true);
        }
      } catch (error) {
        result = aggregate(requirement.id, results, [...requirementBlockers, providerFailure(error)], discoveryIncomplete);
      }
    }
    trace(`${requirement.id} -> ${result.status} (coverage ${result.coverage})`);
    requirements.push(result);
  }

  if (reached > 0 && answered === 0) {
    throw new ToolError(`no judgment came back from ${input.endpoint ?? "the judgment provider"}: ${reached} request(s) were sent and none was answered`, EXIT.provider);
  }

  const { verdict, exitCode } = verdictOf(requirements, config.policy);
  const sent = input.sent();
  return {
    version: 1,
    tool: { name: "jev-intent-review", version: VERSION },
    verdict,
    exitCode,
    intent,
    sources: input.sources.map(({ text: _text, ...source }) => source),
    requirements,
    unexpectedChanges: [],
    discovery: { candidateCount, changedCandidates, unchangedCandidates: candidateCount - changedCandidates, incompleteReasons, searches },
    sent: { requests: sent.requests, bytes: sent.bytes, locations: [...sentLocations.values()], ...(input.endpoint ? { endpoint: input.endpoint } : {}) },
    metadata: {
      repository: input.repository,
      base: revisions.before,
      head: revisions.after,
      model: provider.model,
      questionsHash: QUESTIONS_HASH,
      configSource: loaded.source,
      notes,
    },
  };
}
