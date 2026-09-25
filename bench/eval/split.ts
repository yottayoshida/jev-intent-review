// The pool, the split and the rule that puts a new repository on one side (bench/eval/PROTOCOL.md).

import { createHash } from "node:crypto";

export const PROTOCOL_VERSION = 4;

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
  /** For an entry placed by the hash: the batch of `sealed-batches.json` whose verdicts it was judged in. */
  batch?: { measurement: SealedBatch["measurement"]; id: string };
  /** For a repository whose pull request was read on a fork: the fork, whose rows count as this repository's. */
  readAs?: string;
  /** For a sealed repository moved to dev: when, and what it was read for. */
  contaminated?: { on: string; why: string };
}

export interface Split {
  protocolVersion: number;
  what: string;
  repos: SplitEntry[];
}

/**
 * One batch of sealed candidates (PROTOCOL.md rule 5, RETRO.md "Where records live"): the verdicts
 * live in the sandbox; this repository holds how many rows were read, how many were kept, and the sha256
 * of the verdicts file. Lines of `sealed-batches.json` are only ever added.
 */
export interface SealedBatch {
  measurement: "#80" | "#89";
  id: string;
  /**
   * The rows the batch read, by their `order` in that measurement's committed searches — public already,
   * so nothing leaks. A measurement's batches cover consecutive ranges from row 1, so a row cannot be
   * judged again in a later batch to draw its repository's side a second time.
   */
  from: number;
  to: number;
  rows: number;
  kept: number;
  sha256: string;
}

export interface SealedBatches {
  what: string;
  batches: SealedBatch[];
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

/**
 * The salt of each hashed entry is the first main merge commit whose `sealed-batches.json` holds its
 * batch's sha256 — found by that hash, not by the batch's id, so a batch whose verdicts were swapped and
 * rehashed later does not pass on its id's first commit. `firstMergeWith` asks git; it returns null when
 * main has never held the hash. An entry with a salt and no batch, or a batch not in the file, is a problem.
 */
export function batchSaltProblems(
  split: Split,
  batches: readonly SealedBatch[],
  firstMergeWith: (sha256: string) => { commit: string; merge: boolean } | null,
  /** The `order` of every row of `repo` in the measurement's committed searches — public, so nothing leaks. */
  rowsOf: (measurement: SealedBatch["measurement"], repo: string) => readonly number[],
): string[] {
  const problems: string[] = [];
  for (const e of split.repos.filter((x) => !x.fixed)) {
    if (e.batch === undefined) {
      problems.push(`${e.repo}: placed by the hash and names no batch`);
      continue;
    }
    const b = batches.find((x) => x.measurement === e.batch!.measurement && x.id === e.batch!.id);
    if (b === undefined) {
      problems.push(`${e.repo}: batch ${e.batch.measurement} ${e.batch.id} is not in sealed-batches.json`);
      continue;
    }
    // The batch must be the first of its measurement that read a row of this repository: a repository cannot
    // be hung on an earlier batch with room to spare in `kept`, or a later one, once both salts are known.
    const rows = [e.repo, ...(e.readAs === undefined ? [] : [e.readAs.toLowerCase()])].flatMap((r) => rowsOf(b.measurement, r));
    const firstReading = batches.find((x) => x.measurement === b.measurement && rows.some((r) => x.from <= r && r <= x.to));
    if (firstReading === undefined) problems.push(`${e.repo}: no batch of ${b.measurement} read a row of it`);
    else if (firstReading.id !== b.id) problems.push(`${e.repo}: names batch ${b.measurement} ${b.id}, but ${firstReading.id} read its first row`);
    const first = firstMergeWith(b.sha256);
    if (first === null) problems.push(`${e.repo}: main has never held the sha256 of batch ${b.measurement} ${b.id}`);
    else if (!first.merge) problems.push(`${e.repo}: batch ${b.measurement} ${b.id} reached main in ${first.commit}, which is not a merge commit (a squash, a rebase or a direct push): there is no salt`);
    else if (e.salt !== first.commit) problems.push(`${e.repo}: salt ${e.salt} is not ${first.commit}, the first main merge commit holding batch ${b.measurement} ${b.id}`);
  }
  for (const b of batches) {
    const placed = split.repos.filter((e) => !e.fixed && e.batch?.measurement === b.measurement && e.batch.id === b.id).length;
    if (placed > b.kept) problems.push(`batch ${b.measurement} ${b.id} kept ${b.kept} and ${placed} repositories name it`);
  }
  return problems;
}

/**
 * What must hold of the batches themselves: one line per measurement and id, a sha256 of 64 hex digits,
 * kept no more than read, rows equal to the range read, and each measurement's ranges consecutive from row 1
 * in the order the lines were added — so no row is read twice and none is skipped.
 */
export function batchRecordProblems(batches: readonly SealedBatch[]): string[] {
  const problems: string[] = [];
  const next = new Map<string, number>();
  const seen = new Set<string>();
  for (const b of batches) {
    const key = `${b.measurement} ${b.id}`;
    if (seen.has(key)) problems.push(`batch ${key} is written twice`);
    seen.add(key);
    if (!/^[0-9a-f]{64}$/.test(b.sha256)) problems.push(`batch ${key}: sha256 is not 64 hex digits`);
    if (b.kept < 0 || b.kept > b.rows) problems.push(`batch ${key}: kept ${b.kept} of ${b.rows} rows`);
    if (b.to - b.from + 1 !== b.rows) problems.push(`batch ${key}: rows ${b.rows} but read ${b.from}..${b.to}`);
    const want = next.get(b.measurement) ?? 1;
    if (b.from !== want) problems.push(`batch ${key} starts at row ${b.from}; the rows before it end at ${want - 1}`);
    next.set(b.measurement, b.to + 1);
  }
  return problems;
}

/**
 * Whether `now` only adds batches to `before`: every earlier line the same, in the same place. Compared
 * with origin/main, so a line rewritten by a push straight to main is compared with itself and passes —
 * main has no working protection (PROTOCOL.md rule 5), and the rule rests on pull requests.
 */
export function batchesOnlyGrow(before: readonly SealedBatch[], now: readonly SealedBatch[]): boolean {
  return before.length <= now.length && before.every((b, i) => JSON.stringify(b) === JSON.stringify(now[i]));
}
