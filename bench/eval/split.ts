// The pool, the split and the rule that puts a new repository on one side (bench/eval/PROTOCOL.md).

import { createHash } from "node:crypto";

export const PROTOCOL_VERSION = 2;

/**
 * How the code before the fix handled the failure the pull request is about (PROTOCOL.md, "Labels").
 * The last two are not the same: `cannot_label` is a failure-handling candidate whose text does not
 * settle it, `not_failure_handling` is a candidate about something else.
 */
export const LABELS = ["propagates", "logs_or_warns", "records_or_handles_locally", "falls_back_or_degrades", "swallows_as_success", "other", "cannot_label", "not_failure_handling"] as const;
export type Label = (typeof LABELS)[number];

export interface LabelRecord {
  label: Label;
  /** The three annotators' labels, in the order they were asked. */
  votes: Label[];
  /** The sentence of the pull request or issue each label rests on. */
  quotes: string[];
}

export interface PoolRow {
  /** `owner/repo#N` as the record names it. */
  id: string;
  /** Lower case: one repository is one name. */
  repo: string;
  source: "acceptance-v1" | "acceptance-v2" | "corpus" | "fixture" | "sentence-choice";
  /** examined: its text was read; screened_out: by title or licence, unread; excluded: by a rule; used: built or tuned on. */
  stage: "examined" | "screened_out" | "excluded" | "used";
  order: number | null;
  verdicts: Record<string, string>;
  why: string | null;
  requirement: string | null;
  label?: LabelRecord;
}

export interface Pool {
  protocolVersion: number;
  what: string;
  rows: PoolRow[];
}

export interface SplitEntry {
  repo: string;
  side: "dev" | "sealed";
  /** Fixed: on its side for a reason, not by the hash. Every fixed entry is dev. */
  fixed: boolean;
  why: string[];
  /** For an entry placed by the hash: the salt it was placed with (a main merge commit, PROTOCOL.md). */
  salt?: string;
  /** For a sealed repository moved to dev: when, and what it was read for. */
  contaminated?: { on: string; why: string };
}

export interface Split {
  protocolVersion: number;
  what: string;
  repos: SplitEntry[];
}

/** Of 256 values of the first byte, those below this go to sealed: three in four new repositories. */
export const SEALED_BELOW = 192;

/** The side the hash puts a repository on, for the salt of the batch it was judged in. */
export function sideOf(repo: string, salt: string): "dev" | "sealed" {
  const first = createHash("sha256").update(`${salt}:${repo.toLowerCase()}`).digest()[0]!;
  return first < SEALED_BELOW ? "sealed" : "dev";
}

/**
 * What must hold of a split, whatever it holds: one entry per repository, every fixed entry dev,
 * every hashed entry on the side its salt puts it (a contaminated one aside, which is dev), and no
 * repository of the pool missing. Returns the problems, empty when there are none.
 */
export function checkSplit(split: Split, poolRepos: Iterable<string>): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const e of split.repos) {
    if (e.repo !== e.repo.toLowerCase()) problems.push(`${e.repo}: not lower case`);
    seen.set(e.repo.toLowerCase(), (seen.get(e.repo.toLowerCase()) ?? 0) + 1);
    if (e.fixed) {
      if (e.side !== "dev") problems.push(`${e.repo}: fixed entries are dev, this one is ${e.side}`);
      continue;
    }
    if (e.salt === undefined) {
      problems.push(`${e.repo}: neither fixed nor placed by a salt`);
      continue;
    }
    const expected = e.contaminated ? "dev" : sideOf(e.repo, e.salt);
    if (e.side !== expected) problems.push(`${e.repo}: the rule puts it on ${expected}, the split says ${e.side}`);
  }
  for (const [repo, n] of seen) if (n > 1) problems.push(`${repo}: on the split ${n} times`);
  for (const repo of poolRepos) if (!seen.has(repo.toLowerCase())) problems.push(`${repo}: in the pool and not on the split`);
  return problems;
}

/**
 * Whether each hashed entry's salt is a merge commit on main's first-parent line — the rule's "a main
 * merge commit". `isMainMerge` asks git; a salt that is any other string is a problem. That main is
 * not protected means a merge commit pushed straight to main would still pass: the rule rests on
 * merging through pull requests (PROTOCOL.md, "Dev and sealed").
 */
export function saltProblems(split: Split, isMainMerge: (sha: string) => boolean): string[] {
  return split.repos.filter((e) => !e.fixed && e.salt !== undefined && !isMainMerge(e.salt)).map((e) => `${e.repo}: salt ${e.salt} is not a merge commit on main's first-parent line`);
}
