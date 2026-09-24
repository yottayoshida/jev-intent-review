// Shapes shared across stages. `ReviewReport` is what `--json` prints, so a change here is a
// change to the tool's output contract.

import type { Host, ModelIdentity } from "./judgments/client.ts";
import type { LocalCheckResult } from "./review/local-check-run.ts";

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

/**
 * What the local check asks of a call for this requirement (docs/adr/0006-question-forms-as-data.md).
 *
 * Experimental. A spec names it; a requirement read from an issue, a pull request or the command
 * line is asked of Jev, which form its sentence says, before its calls (docs/adr/0008).
 */
export const REQUIREMENT_FORMS = ["failure_propagation", "check_before_action"] as const;
export type RequirementForm = (typeof REQUIREMENT_FORMS)[number];

export interface Requirement {
  id: string;
  text: string;
  kind: RequirementKind;
  priority: Priority;
  sourceRefs: SourceRef[];
  searchHints: string[];
  /** Only a spec sets it. Absent: a spec's requirement is `failure_propagation`; one read from text is asked of Jev. */
  form?: RequirementForm;
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
  reasons: string[]; // why discovery picked it, e.g. "calls open_account"
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

/**
 * Why a run asked nothing, for a reader that is not a person: the Action's check run titles the run
 * from this, never from the wording of `skipReason` (ADR 0010). `fork` and `dependabot` are the
 * cases where a key cannot be given and so cannot be the fix.
 */
export type SkipKind = "no_credentials" | "fork" | "dependabot" | "no_intent";

/**
 * What `--json` prints, whichever way the run ended (ADR 0007): skipped, stopped for want of
 * readable requirements, the set built with nothing asked, or finished. No requirement verdict:
 * `requirements` holds the local check's readings per call, and the counts are in each one.
 */
export interface ReviewReport {
  version: 2;
  tool: { name: "jev-intent-review"; version: string };
  exitCode: number;
  skipReason?: string;
  skipKind?: SkipKind;
  intent: IntentSpec;
  sources: Omit<IntentSource, "text">[];
  requirements: LocalCheckResult[];
  unexpectedChanges: UnexpectedChange[];
  /**
   * `answered`: the requests Jev answered, in the same unit as `requests` (an observation request
   * carries two questions). `reused`: the requests answered from kept answers (`--answers`) instead
   * of being sent, in the same unit; they are in neither `requests` nor `answered` (ADR 0013).
   * `reusedFromEarlierRuns`: of those, the ones kept by an earlier run; the rest repeated a request
   * of this run.
   * `host`: which host `endpoint` is — `custom` when set by `JEV_API_URL`.
   */
  sent: { requests: number; bytes: number; answered: number; reused: number; reusedFromEarlierRuns: number; endpoint?: string; host?: Host };
  metadata: {
    repository: string;
    base: string;
    head: string;
    model: string;
    /** Which Jev answered: the alias sent and the versions the host named, counted (#84). */
    modelIdentity: ModelIdentity;
    questionsHash: string;
    configSource: string;
    notes: string[];
    /** The pull request's author, when there is one: whose own claims the requirements are is said by it. */
    pullRequestAuthor?: string;
  };
}

/** Spec §26. */
export const EXIT = {
  ok: 0,
  /** A call worth checking, when the configuration's `policy.fail_on` names `finding`. */
  finding: 1,
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
