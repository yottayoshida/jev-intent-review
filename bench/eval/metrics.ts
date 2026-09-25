// The metrics of the evaluation protocol (bench/eval/PROTOCOL.md), their intervals and their gates.
//
// The unit of every rate is one target of one version (a row of bench/acceptance/score.ts), and the
// interval treats a repository as one observation: calls of the same repository are not independent,
// so the estimate is the mean over repositories of each repository's own rate, and the interval is
// Clopper–Pearson with x = the sum of those means and n = the number of repositories. That is the
// interval of the most correlated case — every call of a repository behaving as one — and it is used
// at every number of repositories: a bootstrap has width 0 when every repository scores 1, and would
// pass a gate at 20 repositories that this protocol says needs more.
//
// Nothing here reads a repository, a log or the network.

import type { Row } from "../acceptance/score.ts";

export const CONFIDENCE = 0.95;

// ---------------------------------------------------------------------------------------------
// The Beta distribution, for Clopper–Pearson with a fractional x.

function logGamma(z: number): number {
  // Lanczos, g = 7, n = 9. Accurate to about 15 digits for z > 0.
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The continued fraction of the incomplete Beta function (modified Lentz). */
function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-15) return h;
  }
  throw new Error(`the Beta continued fraction did not converge (x=${x}, a=${a}, b=${b})`);
}

/** The regularized incomplete Beta function I_x(a, b). */
export function betaCdf(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new RangeError(`Beta(${a}, ${b}) needs a > 0 and b > 0`);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** The p-quantile of Beta(a, b), by bisection on the CDF (monotone, so bisection cannot miss). */
export function betaQuantile(p: number, a: number, b: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`a quantile needs 0 < p < 1, not ${p}`);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Clopper–Pearson, two-sided, for x successes of n; x may be fractional (a sum of means). */
export function clopperPearson(x: number, n: number, confidence = CONFIDENCE): { lower: number; upper: number } {
  if (!(n > 0) || x < 0 || x > n) throw new RangeError(`Clopper–Pearson needs 0 <= x <= n and n > 0, not x=${x}, n=${n}`);
  const alpha = 1 - confidence;
  return {
    lower: x === 0 ? 0 : betaQuantile(alpha / 2, x, n - x + 1),
    upper: x === n ? 1 : betaQuantile(1 - alpha / 2, x + 1, n - x),
  };
}

// ---------------------------------------------------------------------------------------------
// Rates over repositories.

/** One repository's count for one metric: `hits` of `units` (versions × targets). */
export interface RepoCount {
  repo: string;
  hits: number;
  units: number;
}

export interface Estimate {
  /** Mean over repositories of each repository's own rate. Null with no repository. */
  estimate: number | null;
  lower: number | null;
  upper: number | null;
  repos: number;
  units: number;
}

/** The estimate and its interval, a repository counted once whatever its number of units. */
export function estimateOver(counts: readonly RepoCount[], confidence = CONFIDENCE): Estimate {
  const byRepo = new Map<string, { hits: number; units: number }>();
  for (const c of counts) {
    if (c.hits < 0 || c.hits > c.units) throw new RangeError(`${c.repo}: ${c.hits} of ${c.units}`);
    const r = byRepo.get(c.repo.toLowerCase()) ?? { hits: 0, units: 0 };
    r.hits += c.hits;
    r.units += c.units;
    byRepo.set(c.repo.toLowerCase(), r);
  }
  const rates = [...byRepo.values()].filter((r) => r.units > 0).map((r) => r.hits / r.units);
  const units = [...byRepo.values()].reduce((n, r) => n + r.units, 0);
  if (rates.length === 0) return { estimate: null, lower: null, upper: null, repos: 0, units };
  const x = rates.reduce((s, r) => s + r, 0);
  const { lower, upper } = clopperPearson(x, rates.length, confidence);
  return { estimate: x / rates.length, lower, upper, repos: rates.length, units };
}

// ---------------------------------------------------------------------------------------------
// The gates.

export type MetricName = "precision" | "recall" | "falseListing" | "silentUnmeasured";

/** A gate: which bound is compared, and with what. Fixed in PROTOCOL.md v1 before any sealed result. */
export interface Gate {
  better: "higher" | "lower";
  threshold: number;
}

export const GATES: Record<MetricName, Gate> = {
  precision: { better: "higher", threshold: 0.8 },
  recall: { better: "higher", threshold: 0.5 },
  falseListing: { better: "lower", threshold: 0.2 },
  // 0.20, not 0.10: at 0.10 the gate needs 36 repositories and the sealed search stops at 17 (owner, 2026-09-25).
  silentUnmeasured: { better: "lower", threshold: 0.2 },
};

/** The fewest repositories with which a perfect score clears the gate's bound. */
export function requiredRepos(gate: Gate, confidence = CONFIDENCE): number {
  for (let n = 1; n <= 10_000; n++) {
    const { lower, upper } = clopperPearson(gate.better === "higher" ? n : 0, n, confidence);
    if (gate.better === "higher" ? lower >= gate.threshold : upper <= gate.threshold) return n;
  }
  throw new Error("no number of repositories up to 10,000 clears this gate");
}

export type GateResult =
  | { status: "pass" | "fail"; bound: number; estimate: Estimate }
  /** Fewer repositories than the gate needs: no release may rest on this metric, and none passes it. */
  | { status: "insufficient_repositories"; needed: number; estimate: Estimate };

export function judge(gate: Gate, estimate: Estimate, confidence = CONFIDENCE): GateResult {
  const needed = requiredRepos(gate, confidence);
  if (estimate.repos < needed || estimate.lower === null || estimate.upper === null) return { status: "insufficient_repositories", needed, estimate };
  const bound = gate.better === "higher" ? estimate.lower : estimate.upper;
  const pass = gate.better === "higher" ? bound >= gate.threshold : bound <= gate.threshold;
  return { status: pass ? "pass" : "fail", bound, estimate };
}

/** A release may cite the evaluation only when every gate passes; one short of repositories stops it. */
export function releaseVerdict(results: Record<MetricName, GateResult>): "pass" | "fail" | "no_evaluation_verdict" {
  const all = Object.values(results);
  if (all.some((r) => r.status === "insufficient_repositories")) return "no_evaluation_verdict";
  return all.every((r) => r.status === "pass") ? "pass" : "fail";
}

// ---------------------------------------------------------------------------------------------
// From scored rows to counts.

/** One scored row with the repository and the kind of version it came from. */
export interface EvalRow {
  repo: string;
  versionId: string;
  row: Row;
}

const listedInAny = (row: Row) => row.runs.some((r) => r.listed);

/**
 * The counts behind each metric, per repository.
 *
 * - reach: a known target that got inside the budget (Scoring 1–3 of bench/acceptance/README.md)
 * - recall: a target of a `defect-*` version listed in 3 runs of 3
 * - falseListing: a target expected `not_listed` that was listed in any run (the conservative side)
 * - precision (of the constructed versions): of the targets listed in any run, those expected `listed`.
 *   The mix of versions is set by how cases are built, so this is not the product's precision. Listed
 *   calls that are not targets carry no label and are counted apart (`unlabelledListed`)
 * - silentUnmeasured: a target that was not enumerated and no cap note says so
 * - cannotDetermine: runs that answered a target with `cannot_determine` or below the bar, of runs answered
 */
export function countsOf(rows: readonly EvalRow[], bar = 0.6): Record<"reach" | "recall" | "falseListing" | "precision" | "silentUnmeasured" | "cannotDetermine", RepoCount[]> {
  const out = { reach: [], recall: [], falseListing: [], precision: [], silentUnmeasured: [], cannotDetermine: [] } as Record<string, RepoCount[]>;
  const add = (metric: string, repo: string, hit: boolean, units = 1) => out[metric]!.push({ repo, hits: hit ? units : 0, units });
  for (const { repo, versionId, row } of rows) {
    add("reach", repo, row.reach.stage === "in_budget");
    add("silentUnmeasured", repo, row.reach.stage === "not_enumerated" && !row.reach.capNoted);
    if (versionId.startsWith("defect") && row.expected === "listed") add("recall", repo, row.agrees === true);
    if (row.expected === "not_listed") add("falseListing", repo, listedInAny(row));
    if (listedInAny(row)) add("precision", repo, row.expected === "listed");
    const answered = row.runs.filter((r) => r.stage === "answered");
    if (answered.length > 0) {
      const unsure = answered.filter((r) => r.observation === undefined || r.observation.observation === "cannot_determine" || r.observation.probability < bar).length;
      out.cannotDetermine!.push({ repo, hits: unsure, units: answered.length });
    }
  }
  return out as Record<"reach" | "recall" | "falseListing" | "precision" | "silentUnmeasured" | "cannotDetermine", RepoCount[]>;
}

// ---------------------------------------------------------------------------------------------
// Calibration, per family of questions.

export const CALIBRATION_BINS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;
/** Below either floor a family's calibration is reported as insufficient sample size, and nothing else. */
export const CALIBRATION_FLOOR = { judgments: 100, repos: 17 } as const;

export interface Judgment {
  repo: string;
  /** The probability the answer was given with, for the choice it made. */
  probability: number;
  /** Whether that choice was right by the label. */
  right: boolean;
}

export type Calibration =
  | { status: "insufficient_sample_size"; judgments: number; repos: number }
  | { status: "measured"; judgments: number; repos: number; brier: number; ece: number; bins: { from: number; to: number; count: number; meanProbability: number; accuracy: number }[] };

export function calibration(judgments: readonly Judgment[]): Calibration {
  const repos = new Set(judgments.map((j) => j.repo.toLowerCase())).size;
  if (judgments.length < CALIBRATION_FLOOR.judgments || repos < CALIBRATION_FLOOR.repos) return { status: "insufficient_sample_size", judgments: judgments.length, repos };
  const bins = CALIBRATION_BINS.slice(0, -1).map((from, i) => ({ from, to: CALIBRATION_BINS[i + 1]!, count: 0, meanProbability: 0, accuracy: 0 }));
  let brier = 0;
  for (const j of judgments) {
    brier += (j.probability - (j.right ? 1 : 0)) ** 2;
    // Each bin holds [from, to); the last also holds 1. 0.6 is an edge, so the bar sits between two bins.
    const b = bins.find((x) => j.probability >= x.from && (j.probability < x.to || (x.to === 1 && j.probability === 1)))!;
    b.meanProbability += j.probability;
    b.accuracy += j.right ? 1 : 0;
    b.count += 1;
  }
  let ece = 0;
  for (const b of bins) {
    if (b.count === 0) continue;
    b.meanProbability /= b.count;
    b.accuracy /= b.count;
    ece += (b.count / judgments.length) * Math.abs(b.accuracy - b.meanProbability);
  }
  return { status: "measured", judgments: judgments.length, repos, brier: brier / judgments.length, ece, bins };
}
