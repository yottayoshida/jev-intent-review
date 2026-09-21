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

/**
 * The one call a mutation changes.
 *
 * By expression, not by callee: `read(a)` and `read(b)` in one body are two calls and a patch
 * touches one of them. The earlier version matched on the callee's bare name and could not tell
 * them apart — which did not move the numbers for the two cases measured, and would as soon as a
 * set contains more than one call to the same helper in one function, which is exactly what
 * widening inside a function produces.
 */
export interface GroundTruth {
  /** The function the patch edits. */
  functionName: string;
  /** The call expression the patch changes the handling of, as it appears at the pinned commit. */
  callExpression: string;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** Whether the set contains the call the mutation changed — not merely its function. */
export function reachesTheDefect(sites: readonly { fn: FunctionCandidate; call: CallCandidate }[], truth: GroundTruth): { call: boolean; functionOnly: boolean } {
  const inFunction = sites.filter((s) => s.fn.name === truth.functionName);
  const wanted = flat(truth.callExpression);
  const exact = inFunction.filter((s) => flat(s.call.expression) === wanted);
  return { call: exact.length > 0, functionOnly: exact.length === 0 && inFunction.length > 0 };
}

// `applicability` used to live here and read the call's own line for `?`, `.map_err`, `.is_ok()`.
// It let `exists()` through in `if p.exists() || p.symlink_metadata().is_ok()` — the `.is_ok()`
// belongs to the call beside it — and it let `Option::unwrap_or` through, which is no Result at
// all. Syntax on one line does not say what a call returns, so the check moved to
// `src/plan/applicability.ts`, which resolves the callee's definition and reads its signature.

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
