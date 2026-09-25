// Comparing jev-intent-review with the frontier-model baseline (bench/eval/BASELINE.md).
//
// A hit is mechanical for both systems: a finding names the known defect's file, function and call
// (whitespace ignored), in each of three counted runs. The primary metric is the difference of hits
// per defect version, averaged over repositories; its interval maps d in [-1, 1] to (d + 1) / 2 and
// takes metrics.ts's Clopper–Pearson over the number of repositories — the same interval as every
// other rate of the protocol. Nothing here reads a repository or sends anything.

import type { RequirementRun, Target } from "../acceptance/score.ts";
import type { Finding } from "./baseline.ts";
import { MAX_FINDINGS } from "./baseline.ts";
import { clopperPearson, CONFIDENCE, estimateOver, GATES, requiredRepos, type RepoCount } from "./metrics.ts";

/** The smallest effect size of interest: 10 more defects found per 100 cases (owner, 2026-09-25). */
export const SESOI = 0.1;
/**
 * jev may list falsely no more often than the baseline plus this margin — point against point, since an
 * upper bound against a point fails even a perfect jev at 17 repositories (0.195 > 0 + 0.10) — and its
 * upper bound stays within #80's ceiling.
 */
export const GUARD_MARGIN = 0.1;
export const GUARD_CEILING = 0.2;
export const RUNS = 3;

const collapse = (s: string) => s.replace(/\s+/g, "");
const path = (p: string) => p.replace(/^(?:\.\/|[ab]\/)/, "");
/** `Restorer::finalize` and `finalize` are the same function; the listing writes the last. */
const lastSegment = (name: string) => name.split("::").at(-1)!.trim();

/**
 * Whether a finding names the target: same file, same function, and a call that contains the target's,
 * whitespace ignored. The target is written as the tool lists it, without a receiver or `.await`
 * (`rewrite_heights(grove_version)`, not `self.rewrite_heights(grove_version)`); a reviewer quoting the
 * code writes them, and on dev both defects inside the diff were quoted that way. jev's findings are
 * the listing's own rows, so for them this is the exact match it always was.
 */
export function names(f: { file: string; function: string; call: string }, t: Target): boolean {
  return path(f.file) === path(t.file) && lastSegment(f.function) === lastSegment(t.function) && collapse(f.call).includes(collapse(t.call));
}

/**
 * jev's findings of one requirement, cut to five as the baseline's are: highest probability of the
 * answer that listed them first, ties in the order jev listed them.
 */
export function jevTopFindings(r: RequirementRun, cap = MAX_FINDINGS): RequirementRun["findings"] {
  const p = (f: RequirementRun["findings"][number]) => r.observed.find((o) => o.file === f.file && o.function === f.function && o.call === f.call)?.result.probability ?? 0;
  return r.findings
    .map((f, i) => ({ f, i, p: p(f) }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .slice(0, cap)
    .map((x) => x.f);
}

/** A hit: the target named in each of the first three counted runs. Fewer than three counted is no hit. */
export function hit(runs: readonly (readonly { file: string; function: string; call: string }[])[], target: Target): boolean {
  const counted = runs.slice(0, RUNS);
  return counted.length === RUNS && counted.every((findings) => findings.some((f) => names(f, target)));
}

export const baselineFindings = (runs: readonly { counted: boolean; findings: Finding[] }[]) => runs.filter((r) => r.counted).map((r) => r.findings);

export interface Pair {
  repo: string;
  place: "A" | "B";
  jev: boolean;
  baseline: boolean;
}

export interface Uplift {
  /** Mean over repositories of the mean difference in each. Null with no pair. */
  estimate: number | null;
  lower: number | null;
  upper: number | null;
  repos: number;
  cases: number;
  wins: number;
  losses: number;
  ties: number;
}

/** The difference jev − baseline, one repository counted once. */
export function uplift(pairs: readonly Pair[], confidence = CONFIDENCE): Uplift {
  const byRepo = new Map<string, number[]>();
  for (const p of pairs) (byRepo.get(p.repo.toLowerCase()) ?? byRepo.set(p.repo.toLowerCase(), []).get(p.repo.toLowerCase())!).push(Number(p.jev) - Number(p.baseline));
  const wins = pairs.filter((p) => p.jev && !p.baseline).length;
  const losses = pairs.filter((p) => !p.jev && p.baseline).length;
  const counts = { cases: pairs.length, wins, losses, ties: pairs.length - wins - losses };
  const means = [...byRepo.values()].map((ds) => ds.reduce((s, d) => s + d, 0) / ds.length);
  if (means.length === 0) return { estimate: null, lower: null, upper: null, repos: 0, ...counts };
  const x = means.reduce((s, d) => s + (d + 1) / 2, 0);
  const { lower, upper } = clopperPearson(x, means.length, confidence);
  return { estimate: means.reduce((s, d) => s + d, 0) / means.length, lower: 2 * lower - 1, upper: 2 * upper - 1, repos: means.length, ...counts };
}

/** With `repos` repositories, one case each and no loss, the fewest wins whose lower bound clears SESOI. */
export function neededWins(repos: number, sesoi = SESOI): number | null {
  for (let wins = 0; wins <= repos; wins++) {
    const pairs: Pair[] = Array.from({ length: repos }, (_, i) => ({ repo: `r/${i}`, place: "A", jev: i < wins, baseline: false }));
    const u = uplift(pairs);
    if (u.lower !== null && u.lower > sesoi) return wins;
  }
  return null;
}

/** One version on which a system could list falsely: shipped or rewrite. */
export interface FalseVersion {
  repo: string;
  /** Whether any finding of the version was false: a known target of a correct version, or judged false. */
  jev: boolean;
  baseline: boolean;
  /**
   * #80's false listing on this version, counted as `countsOf` of metrics.ts counts it: of the version's
   * targets, how many jev listed in any run, before the cut to five. The ceiling is on this quantity.
   */
  jevKnown: { listed: number; targets: number };
}

export interface Verdict {
  /** `no_verdict`: too few repositories — for any number of wins to clear SESOI, or for the false-listing ceiling. */
  status: "pass" | "fail" | "no_verdict";
  uplift: { all: Uplift; A: Uplift; B: Uplift };
  guard: { jevEstimate: number | null; jevUpper: number | null; baselineEstimate: number | null; holds: boolean };
  why: string[];
}

/**
 * The gate of #88: the lower bound of the difference over every defect version above SESOI, and jev
 * listing falsely no more often than the baseline plus the margin, with an upper bound within #80's ceiling.
 */
export function judge(pairs: readonly Pair[], falseVersions: readonly FalseVersion[]): Verdict {
  const all = uplift(pairs);
  const count = (side: "jev" | "baseline"): RepoCount[] => falseVersions.map((v) => ({ repo: v.repo, hits: v[side] ? 1 : 0, units: 1 }));
  const j = estimateOver(count("jev"));
  const b = estimateOver(count("baseline"));
  const known = estimateOver(falseVersions.map((v) => ({ repo: v.repo, hits: v.jevKnown.listed, units: v.jevKnown.targets })));
  // Point against point for every false finding, both sides; the ceiling on #80's own quantity only.
  const holds = j.estimate !== null && b.estimate !== null && known.upper !== null && j.estimate <= b.estimate + GUARD_MARGIN && known.upper <= GUARD_CEILING;
  const why: string[] = [];
  if (all.lower === null || all.lower <= SESOI) why.push(`the lower bound of the difference is ${all.lower?.toFixed(3) ?? "not measured"}, not above ${SESOI}`);
  if (!holds) why.push(`jev's false findings ${j.estimate?.toFixed(3) ?? "not measured"} against the baseline's ${b.estimate?.toFixed(3) ?? "not measured"} + ${GUARD_MARGIN}, and the upper bound of its false listing of known targets ${known.upper?.toFixed(3) ?? "not measured"} against ${GUARD_CEILING}`);
  // Too few repositories to pass either part is no verdict, not a product result (PROTOCOL.md's gates).
  const tooFew = neededWins(all.repos) === null || known.repos < requiredRepos(GATES.falseListing);
  if (neededWins(all.repos) === null) why.unshift(`${all.repos} repositories: no number of wins clears ${SESOI}`);
  if (known.repos < requiredRepos(GATES.falseListing)) why.unshift(`${known.repos} repositories for false listing: ${requiredRepos(GATES.falseListing)} are needed`);
  return {
    status: tooFew ? "no_verdict" : why.length === 0 ? "pass" : "fail",
    uplift: { all, A: uplift(pairs.filter((p) => p.place === "A")), B: uplift(pairs.filter((p) => p.place === "B")) },
    guard: { jevEstimate: j.estimate, jevUpper: known.upper, baselineEstimate: b.estimate, holds },
    why,
  };
}
