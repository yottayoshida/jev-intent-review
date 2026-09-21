// Shapes shared across stages. `ReviewReport` is what `--json` prints, so a change here is a
// change to the tool's output contract.

import type { Host } from "./judgments/client.ts";

export const REQUIREMENT_KINDS = [
  "behavior",
  "invariant",
  "compatibility",
  "security",
  "data",
  "interface",
  "test",
  "documentation",
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const PRIORITIES = ["required", "expected", "optional"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type SourceType =
  | "acceptance_criteria"
  | "github_issue"
  | "issue_comment"
  | "pr_description"
  | "commit_message"
  | "file"
  | "cli"
  | "spec";

/** Where intent came from. Text written by the pull request's author is marked as such. */
export interface IntentSource {
  id: string; // "issue#123", "pr#456", "cli", "file:task.md"
  type: SourceType;
  authority: number; // higher wins when sources disagree (spec §28)
  author?: string;
  url?: string;
  text: string;
}

/** A requirement's claim to come from a source. `quote` must appear verbatim in that source's text. */
export interface SourceRef {
  sourceId: string;
  quote: string;
}

export interface Requirement {
  id: string;
  text: string;
  kind: RequirementKind;
  priority: Priority;
  sourceRefs: SourceRef[];
  searchHints: string[];
}

export interface NonGoal {
  id: string;
  text: string;
  sourceRefs: SourceRef[];
}

export interface Ambiguity {
  id: string;
  text: string;
  sourceRefs: SourceRef[];
}

export interface IntentSpec {
  version: 1;
  title: string;
  summary: string;
  requirements: Requirement[];
  nonGoals: NonGoal[];
  ambiguities: Ambiguity[];
}

/**
 * `not_applicable` is deliberately absent: with only the places Jev calls paths deciding a
 * requirement, "the requirement does not apply here" cannot be told apart from "no place it
 * applies to was found", and a claim that cannot be told apart from ignorance is not made.
 */
export type Status = "verified" | "violation" | "unknown";
export type Coverage = "full" | "partial" | "weak" | "none";

/** Lines are 1-based and inclusive. */
export interface Location {
  path: string;
  startLine: number;
  endLine: number;
}

/** One key per place: discovery and the run tell candidates apart by it. */
export function locationKey(l: Location): string {
  return `${l.path}:${l.startLine}-${l.endLine}`;
}

export interface Candidate extends Location {
  symbol?: string;
  changed: boolean; // the pull request changed lines inside this region
  reasons: string[]; // why discovery picked it, e.g. "calls createSession"
  windowed?: boolean; // no enclosing function was found; a fixed window of lines stands in for it
}

export interface ChoiceAnswer {
  choice: string;
  /** The chosen option's probability, checked to be within 0..1: every decision reads this one. */
  probability: number;
  /** As the host gave it, when it did. */
  confidence?: number;
  probabilities: Record<string, number>;
}

/** `aside`: not a place the requirement holds or fails on, so it decides nothing either way. */
export type CandidateOutcome = "satisfies" | "violates" | "unknown" | "aside";

/** Why a place was set aside. Counted in the report and shown to the completeness question. */
export type AsideReason = "not_a_path" | "unsure" | "unreadable";

/**
 * How much of the evidence was cut, kept apart because the parts do not mean the same thing.
 * `own`: the place's own code. `context`: its callers and the bodies it calls. `ambiguous`: the
 * context may belong to another definition of the same name.
 */
export interface Cut {
  own: boolean;
  context: boolean;
  ambiguous: boolean;
}

export interface CandidateResult {
  candidate: Candidate;
  outcome: CandidateOutcome;
  aside?: AsideReason;
  relevance?: ChoiceAnswer;
  satisfaction?: ChoiceAnswer;
  truncated: boolean; // any of `cut`, for a reader; the parts are in `cut`
  cut: Cut;
  evidence: Location[]; // the lines a reader should look at, e.g. the call the requirement governs
  notes: string[]; // written by the policy, never by a model
}

/**
 * What a requirement's result is a statement about: how many places were judged of how many were
 * found, how many of those were paths, what was set aside, and what the search did not follow.
 * VERIFIED is a claim over `paths` alone, so these numbers travel with it.
 */
export interface Scope {
  found: number; // places discovery offered
  judged: number; // places a judgment was asked about
  paths: number; // places Jev called a path of this requirement
  setAside: number;
  notFollowed: string[]; // leads the search declined to follow, in its own words
  unjudged: string[]; // places found and not judged (a cap, a budget)
  blocking: string[]; // reasons VERIFIED is withheld whatever the answers say
}

export interface RequirementResult {
  requirementId: string;
  status: Status;
  coverage: Coverage;
  scope: Scope;
  candidates: CandidateResult[];
  notes: string[];
}

export type ChangeJudgment = "required" | "supporting" | "unrequested" | "cannot_tell";

export interface UnexpectedChange {
  id: string;
  location: Location;
  excerpt: string;
  judgment: ChangeJudgment;
  mappedRequirements: string[];
  confidence: number;
  notes: string[];
}

export interface SearchRecord {
  requirementId: string;
  layer: "A" | "B" | "C";
  query: string;
  hits: number;
  rejected?: string; // why the query was not run, or its results not followed
  skipped?: number; // hits in files this requirement's kind does not look at (prose for a behavior)
}

/**
 * The one-word outcome. `no_violation_found` is deliberately not "passed": the tool speaks only
 * about the places it found.
 */
export type Verdict = "violation" | "unknown" | "no_violation_found" | "skipped" | "incomplete";

export interface ReviewReport {
  version: 1;
  tool: { name: "jev-intent-review"; version: string };
  verdict: Verdict;
  exitCode: number;
  skipReason?: string;
  intent: IntentSpec;
  sources: Omit<IntentSource, "text">[];
  requirements: RequirementResult[];
  unexpectedChanges: UnexpectedChange[];
  discovery: {
    candidateCount: number;
    changedCandidates: number;
    unchangedCandidates: number;
    incompleteReasons: string[];
    searches: SearchRecord[];
  };
  /** `host`: which host `endpoint` is — `custom` when it was set by `JEV_API_URL`. */
  sent: { requests: number; bytes: number; locations: Location[]; endpoint?: string; host?: Host };
  metadata: {
    repository: string;
    base: string;
    head: string;
    model: string;
    questionsHash: string;
    configSource: string;
    notes: string[];
  };
}

/** Spec §26. */
export const EXIT = {
  ok: 0,
  violation: 1,
  incomplete: 2,
  config: 10,
  intent: 11,
  provider: 12,
  repository: 13,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error that ends the run with a specific exit code. */
export class ToolError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "ToolError";
    this.exitCode = exitCode;
  }
}
