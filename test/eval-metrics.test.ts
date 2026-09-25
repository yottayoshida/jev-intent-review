import assert from "node:assert/strict";
import test from "node:test";
import { betaQuantile, calibration, clopperPearson, countsOf, estimateOver, GATES, judge, releaseVerdict, requiredRepos, type EvalRow, type MetricName } from "../bench/eval/metrics.ts";
import type { Row } from "../bench/acceptance/score.ts";

// A reference made another way: the Beta density integrated by Simpson's rule and normalised by its
// own integral (no Gamma function), then inverted by bisection. It shares no code with metrics.ts.
// The density is integrated in u, with x = 1 - u^10: with b near 1 the density's slope is infinite at
// x = 1, and Simpson's rule in x missed 4.9/6's upper bound by more than 1e-6 (the substitution agrees
// with metrics.ts to 1e-14). Every case below has a > 1, so x = 0 needs no such care.
function referenceQuantile(p: number, a: number, b: number): number {
  const k = 10;
  const steps = 20_000;
  const f = (u: number) => (1 - u ** k) ** (a - 1) * u ** (k * (b - 1)) * k * u ** (k - 1);
  const from = (u0: number) => {
    const h = (1 - u0) / steps;
    let s = f(u0) + f(1);
    for (let i = 1; i < steps; i++) s += (i % 2 === 1 ? 4 : 2) * f(u0 + i * h);
    return (s * h) / 3;
  };
  const total = from(0);
  const cdf = (x: number) => from((1 - x) ** (1 / k)) / total;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

test("Clopper–Pearson with a fractional x matches the numerically integrated reference", () => {
  for (const [x, n] of [
    [7.5, 10],
    [3.2, 8],
    [12.25, 17],
    [4.9, 6],
  ] as const) {
    const { lower, upper } = clopperPearson(x, n);
    assert.ok(Math.abs(lower - referenceQuantile(0.025, x, n - x + 1)) < 1e-6, `lower of ${x}/${n}: ${lower}`);
    assert.ok(Math.abs(upper - referenceQuantile(0.975, x + 1, n - x)) < 1e-6, `upper of ${x}/${n}: ${upper}`);
  }
});

test("the edges: 0 of n and n of n have the closed forms", () => {
  assert.ok(Math.abs(clopperPearson(0, 10).upper - (1 - 0.025 ** (1 / 10))) < 1e-9);
  assert.ok(Math.abs(clopperPearson(10, 10).lower - 0.025 ** (1 / 10)) < 1e-9);
  assert.equal(clopperPearson(0, 10).lower, 0);
  assert.equal(clopperPearson(10, 10).upper, 1);
  assert.ok(Math.abs(betaQuantile(0.5, 2, 2) - 0.5) < 1e-9);
});

test("the repositories each gate needs with a perfect score: 17, 6, 17 and 17", () => {
  const needed = Object.fromEntries((Object.keys(GATES) as MetricName[]).map((m) => [m, requiredRepos(GATES[m])]));
  assert.deepEqual(needed, { precision: 17, recall: 6, falseListing: 17, silentUnmeasured: 17 });
});

test("a repository is one observation, however many units it has", () => {
  // One repository with 100 hits of 100 and one with 0 of 1: the mean over repositories is 0.5, not 100/101.
  const e = estimateOver([
    { repo: "a/big", hits: 100, units: 100 },
    { repo: "b/small", hits: 0, units: 1 },
  ]);
  assert.equal(e.estimate, 0.5);
  assert.equal(e.repos, 2);
  assert.equal(e.units, 101);
  // Names differing only in case are one repository.
  assert.equal(estimateOver([{ repo: "A/X", hits: 1, units: 1 }, { repo: "a/x", hits: 0, units: 1 }]).repos, 1);
});

test("a gate short of repositories does not pass, and stops the release verdict", () => {
  const perfect = (n: number) => estimateOver(Array.from({ length: n }, (_, i) => ({ repo: `r/${i}`, hits: 1, units: 1 })));
  assert.equal(judge(GATES.precision, perfect(16)).status, "insufficient_repositories");
  assert.equal(judge(GATES.precision, perfect(17)).status, "pass");
  const results = { precision: judge(GATES.precision, perfect(17)), recall: judge(GATES.recall, perfect(17)), falseListing: judge(GATES.falseListing, estimateOver([])), silentUnmeasured: judge(GATES.silentUnmeasured, estimateOver([])) };
  assert.equal(releaseVerdict(results), "no_evaluation_verdict");
});

const row = (over: Partial<Row>): Row => ({ targetKey: "A", target: { requirementId: "R1", file: "f.rs", function: "f", call: "g()" }, expected: "listed", reach: { stage: "in_budget" }, runs: [], right: 0, agrees: null, ...over });
const listedRun = { stage: "answered" as const, listed: true, observation: { observation: "returns_success", probability: 0.9 } };
const quietRun = { stage: "answered" as const, listed: false, observation: { observation: "returns_error", probability: 0.9 } };

test("the counts of each metric come from the rows as PROTOCOL.md defines them", () => {
  const rows: EvalRow[] = [
    { repo: "a/a", versionId: "defect-A", row: row({ runs: [listedRun, listedRun, listedRun], agrees: true }) },
    { repo: "a/a", versionId: "shipped", row: row({ expected: "not_listed", runs: [quietRun, listedRun, quietRun] }) },
    { repo: "b/b", versionId: "shipped", row: row({ expected: "not_listed", reach: { stage: "not_enumerated", capNoted: false } }) },
    { repo: "b/b", versionId: "defect-B", row: row({ reach: { stage: "not_enumerated", capNoted: true } }) },
  ];
  const c = countsOf(rows);
  assert.deepEqual(c.recall, [{ repo: "a/a", hits: 1, units: 1 }, { repo: "b/b", hits: 0, units: 1 }]);
  // Listed in one run of three is a false listing.
  assert.deepEqual(c.falseListing, [{ repo: "a/a", hits: 1, units: 1 }, { repo: "b/b", hits: 0, units: 1 }]);
  // Precision is of listed targets only: the defect is right, the shipped one listed once is wrong.
  assert.deepEqual(c.precision, [{ repo: "a/a", hits: 1, units: 1 }, { repo: "a/a", hits: 0, units: 1 }]);
  // Silent only when no cap note says so.
  assert.equal(c.silentUnmeasured.filter((x) => x.hits > 0).length, 1);
  assert.equal(c.reach.filter((x) => x.hits > 0).length, 2);
});

test("calibration below its floor says insufficient sample size and nothing else", () => {
  const few = Array.from({ length: 99 }, (_, i) => ({ repo: `r/${i % 20}`, probability: 0.7, right: true }));
  assert.deepEqual(calibration(few), { status: "insufficient_sample_size", judgments: 99, repos: 20 });
  const oneRepo = Array.from({ length: 500 }, () => ({ repo: "r/x", probability: 0.7, right: true }));
  assert.equal(calibration(oneRepo).status, "insufficient_sample_size");
  const enough = Array.from({ length: 100 }, (_, i) => ({ repo: `r/${i % 17}`, probability: i % 2 === 0 ? 0.6 : 0.9, right: i % 4 !== 0 }));
  const c = calibration(enough);
  assert.equal(c.status, "measured");
  if (c.status === "measured") {
    // 0.6 opens the [0.6, 0.8) bin: the bar is an edge, never the middle of a bin.
    assert.equal(c.bins.find((b) => b.from === 0.6)!.count, 50);
    assert.ok(c.ece >= 0 && c.ece <= 1);
  }
});
