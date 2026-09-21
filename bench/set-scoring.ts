// Scoring a selected set, and deciding which of its sites a question can even be put to.
//
// `#24` got both of these wrong in prose, after the answers had arrived:
//
//   - reaching the defect was decided at function granularity, so a different call inside the
//     mutated function counted as reaching it;
//   - every site that is not the mutated one was scored against an assumed `returns_error`,
//     although nobody had read those functions.
//
// Both now live here, in code, with tests. A rule that decides what counts is the one part of a
// measurement that must not be prose.
//
// There is also a step `#24` did not have. Passing the id check means the call exists; it does not
// mean this question can be asked about it. `exists()` and `is_symlink()` return `bool`, and
// "assume it returns an error" is not a condition that can be placed on them — two of the ten
// sites judged in `#24` were of that kind. So a site is now **related**, then **applicable**, then
// judged, and the three are recorded apart.

import type { CallCandidate, FunctionCandidate } from "./code-candidates.ts";

/** The one call a mutation changes, at the granularity the patch touches. */
export interface GroundTruth {
  /** The function the patch edits. */
  functionName: string;
  /** The callee whose handling the patch changes, bare (no `::` path). */
  callee: string;
}

/** Whether the set contains the call the mutation changed — not merely its function. */
export function reachesTheDefect(sites: readonly { fn: FunctionCandidate; call: CallCandidate }[], truth: GroundTruth): { call: boolean; functionOnly: boolean } {
  const inFunction = sites.filter((s) => s.fn.name === truth.functionName);
  const exact = inFunction.filter((s) => s.call.callee.split("::").pop() === truth.callee);
  return { call: exact.length > 0, functionOnly: exact.length === 0 && inFunction.length > 0 };
}

export type Applicability = { ok: true } | { ok: false; reason: string };

/** A call whose result is handled as a `Result` at the call site: `?`, `Ok(`/`Err(`, `map_err`, … */
const HANDLED_AS_RESULT = /\?\s*[;,)]|\?$|\.map_err\(|\.unwrap_or|\.ok\(\)|\.is_ok\(\)|\.is_err\(\)|\.expect\(|\.unwrap\(\)|Ok\(|Err\(/;
/** A signature that returns something the property's two options can sort. */
const RETURNS_RESULT = /->\s*[^{]*\b(Result|io::Result)\s*</;

/**
 * Whether `call_failure_not_returned_as_success` can be asked about this site.
 *
 * Two things have to hold and neither follows from the id existing:
 *
 *   - the call's result must be able to be an error, or "assume it returns an error" describes
 *     nothing. Decided from how the call site handles it, because there are no types here;
 *   - the target must return something the two options can sort. A function returning `bool` has
 *     no success and no failure to tell apart, and `#24` asked about two of those.
 *
 * Deciding the first from syntax is a guess in one direction only: a call handled as a `Result`
 * is one, and a call not handled as one may still return a `Result` that the site ignores. That
 * errs towards refusing to ask, which is the safe side of this particular question.
 */
export function applicability(fn: FunctionCandidate, call: CallCandidate, callLine: string): Applicability {
  if (!RETURNS_RESULT.test(fn.signature)) return { ok: false, reason: `${fn.name} does not return a Result, so "a success" and "an error" do not sort what it returns` };
  if (!HANDLED_AS_RESULT.test(callLine)) return { ok: false, reason: `\`${call.expression}\` is not handled as a Result where it is called, so it may not have an error to assume` };
  return { ok: true };
}

export type SiteOutcome =
  /** Judged, and the answer matched what the code does. */
  | { kind: "right" }
  /** Judged, and it did not. */
  | { kind: "wrong" }
  /** Judged, but nobody established what the code does there, so it counts neither way. */
  | { kind: "unverified" }
  /** Not judged: the question could not be put to it. */
  | { kind: "not_applicable"; reason: string }
  /** Not judged: something else withheld it. */
  | { kind: "withheld"; reason: string };

export interface SetScore {
  sites: number;
  /** The call the mutation changed is in the set. */
  reachesDefect: boolean;
  /** Only another call inside that function is — which is not reaching it. */
  reachesFunctionOnly: boolean;
  right: number;
  wrong: number;
  unverified: number;
  notApplicable: number;
  withheld: number;
}

/**
 * The tally. `unverified` and `not_applicable` are their own columns and are counted into neither
 * `right` nor `wrong`: a site whose behaviour nobody established cannot be a pass, and a site the
 * question cannot be put to cannot be a false violation.
 */
export function scoreSet(outcomes: readonly SiteOutcome[], reach: { call: boolean; functionOnly: boolean }): SetScore {
  const count = (k: SiteOutcome["kind"]) => outcomes.filter((o) => o.kind === k).length;
  return {
    sites: outcomes.length,
    reachesDefect: reach.call,
    reachesFunctionOnly: reach.functionOnly,
    right: count("right"),
    wrong: count("wrong"),
    unverified: count("unverified"),
    notApplicable: count("not_applicable"),
    withheld: count("withheld"),
  };
}
