// bench/eval/drift.ts (#87): the frozen pairs, the run, and the comparison's rule.

import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compare, devCases, distance, modal, outcomeOfPair, pairsFrom, Recorder, RULE, sendRun, type Pair, type PairAnswer, type Run } from "../bench/eval/drift.ts";
import { main } from "../src/cli/main.ts";
import { modelIdentityOf } from "../src/judgments/client.ts";
import type { JudgmentProvider } from "../src/judgments/provider.ts";
import { FORMS } from "../src/plan/forms.ts";
import type { Outcome } from "../src/review/outcome.ts";
import { FIXTURES, tempRepo } from "./helpers/repo.ts";

const FP = FORMS.failure_propagation;
const identity = (versions: string[] = ["jev-1.13.0"]) => () => modelIdentityOf("cloudflare", { returned: new Map(versions.map((v) => [v, 1])), notReturned: 0, unreadable: 0 });

/** A pair as the tool builds one, on a state of its own. */
function pair(i: number): Pair {
  const state = { evidence: { code: `fn f${i}() {}` } };
  return { id: `p${i}`, form: "failure_propagation", state, mapping: { requirement_governs: { type: "choice", instructions: "m", criteria: { applies: "", does_not_apply: "", unknown: "" } } }, observation: { [FP.observationKey]: { type: "choice", instructions: "o", criteria: { returns_error: "", returns_success: "", cannot_determine: "" } } }, askedBy: [i % 2 === 0 ? "grovedb-500/shipped" : "moltis-1064/shipped"] };
}

const PAIRS = Array.from({ length: 34 }, (_, i) => pair(i));
const IDS = PAIRS.map((p) => p.id);

function run(batch: string, outcomes: (id: string) => Outcome | "error", versions?: string[]): Run {
  const answers: Record<string, PairAnswer> = {};
  for (const id of IDS) answers[id] = { outcome: outcomes(id) };
  const day = { "day-1": "2026-09-25", "day-2": "2026-09-26" }[batch] ?? "2026-09-27";
  return { batch, at: `${day}T00:00:00Z`, order: [...IDS], answers, modelIdentity: identity(versions)() };
}

/** A seeded generator, so a count over many trials is the same every time. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each pair's outcome drawn from its own distribution: `p[id]` the chance it reads `satisfies`, else `unknown`. */
function drawn(rand: () => number, p: (id: string) => number) {
  return (id: string): Outcome => (rand() < p(id) ? "satisfies" : "unknown");
}

test("a mapping pairs with the next observation on its state; the form question is skipped", () => {
  const [a, b] = [pair(1), pair(2)];
  const form = { requirement_form: { type: "choice" as const, instructions: "", criteria: { failure: "" } } };
  const { pairs, unpaired } = pairsFrom([
    { state: { requirement: "r" }, questions: form },
    { state: a.state, questions: a.mapping },
    { state: a.state, questions: a.observation },
    { state: b.state, questions: b.mapping },
    { state: b.state, questions: b.observation },
  ], "case/v");
  assert.equal(unpaired, 0);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((p) => p.state), [a.state, b.state]);
  assert.ok(pairs.every((p) => p.form === "failure_propagation" && p.askedBy[0] === "case/v"));
});

test("two calls of one function share their state and still pair in the order they were asked", () => {
  const a = pair(1);
  const second = { ...a, mapping: { requirement_governs: { ...a.mapping.requirement_governs!, instructions: "m2" } }, observation: { [FP.observationKey]: { ...a.observation[FP.observationKey]!, instructions: "o2" } } };
  const { pairs, unpaired } = pairsFrom([
    { state: a.state, questions: a.mapping },
    { state: a.state, questions: a.observation },
    { state: a.state, questions: second.mapping },
    { state: a.state, questions: second.observation },
  ], "c/v");
  assert.equal(unpaired, 0);
  assert.deepEqual(pairs.map((p) => [p.mapping.requirement_governs!.instructions, p.observation[FP.observationKey]!.instructions]), [["m", "o"], ["m2", "o2"]]);
  assert.notEqual(pairs[0]!.id, pairs[1]!.id);
});

test("a mapping with no observation after it is counted as unpaired", () => {
  const a = pair(1);
  assert.equal(pairsFrom([{ state: a.state, questions: a.mapping }], "c/v").unpaired, 1);
  assert.equal(pairsFrom([{ state: a.state, questions: a.observation }], "c/v").unpaired, 1, "an observation with no mapping before it");
});

test("the tool run with the recorder sends nothing and freezes the same pairs twice", async () => {
  const repo = tempRepo();
  try {
    cpSync(join(FIXTURES, "integrity-rust", "base"), repo.dir, { recursive: true });
    const base = repo.commit("base");
    cpSync(join(FIXTURES, "integrity-rust", "head"), repo.dir, { recursive: true });
    const head = repo.commit("head");
    const take = async () => {
      const recorder = new Recorder();
      const deps = {
        judges: () => ({ provider: recorder, sent: () => ({ requests: recorder.sent.length, bytes: 0 }), origin: "recorder" }),
        fetch: (async () => { throw new Error("nothing may be sent"); }) as typeof fetch,
        github: async () => { throw new Error("GitHub may not be asked"); },
      };
      const env = { CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), CLOUDFLARE_API_TOKEN: "recorder-sends-nothing" };
      const code = await main(["--skip-change-check", "--base", base, "--head", head, "--intent-spec", join(FIXTURES, "integrity-rust", "spec.json"), "--json"], { stdout: () => {}, stderr: () => {}, cwd: repo.dir, env }, deps);
      assert.ok(code === 0 || code === 1, `exit ${code}`);
      return pairsFrom(recorder.sent, "fixture/v");
    };
    const one = await take();
    const two = await take();
    assert.equal(one.unpaired, 0);
    assert.ok(one.pairs.length > 0, "the fixture asks at least one call");
    assert.deepEqual(one.pairs.map((p) => p.id), two.pairs.map((p) => p.id));
  } finally {
    repo.remove();
  }
});

test("only dev cases are frozen, and a case on the sealed side stops it", () => {
  const cases = [{ id: "x-1", repo: "https://github.com/o/x", versions: { shipped: { base: "a", head: "b", targets: {} } }, precheck: { shipped: { live: true } } }];
  const split = (side: "dev" | "sealed") => ({ protocolVersion: 1, what: "", repos: [{ repo: "o/x", side, fixed: true, why: [] }] });
  assert.deepEqual(devCases(split("dev") as never, cases as never).map((c) => c.id), ["x-1"]);
  assert.throws(() => devCases(split("sealed") as never, cases as never), /not on the dev side/);
});

test("a pair's outcome is the report's rule; a failed request makes it an error", async () => {
  const a = (choice: string, p = 0.9) => ({ choice, probability: p, probabilities: { [choice]: p } });
  assert.equal(outcomeOfPair("failure_propagation", a("applies"), a(FP.violates[0]!)), "violates");
  assert.equal(outcomeOfPair("failure_propagation", a("does_not_apply"), a(FP.violates[0]!)), "aside");
  assert.equal(outcomeOfPair("failure_propagation", a("applies", 0.5), a(FP.violates[0]!)), "unknown");
  let n = 0;
  const judge: JudgmentProvider = {
    model: "fake",
    async judge(_state, questions) {
      n += 1;
      if (n === 3) throw new Error("the host failed");
      const key = Object.keys(questions)[0]!;
      return { [key]: key === "requirement_governs" ? a("applies") : a(FP.keeps[0]!) };
    },
  };
  const r = await sendRun([pair(1), pair(2)], judge, "day-1", identity(), (xs) => xs);
  assert.deepEqual(r.order, ["p1", "p2"]);
  assert.equal(r.answers.p1!.outcome, "satisfies");
  assert.equal(r.answers.p2!.outcome, "error");
  assert.equal(n, 3, "the second pair's observation is not asked after its mapping failed");
});

test("the modal outcome: errors aside, a tie is unknown", () => {
  const runs = [run("a", () => "satisfies"), run("a", () => "violates"), run("a", () => "error")];
  assert.equal(modal(runs, "p0"), "unknown");
  assert.equal(modal([...runs, run("b", () => "violates")], "p0"), "violates");
  assert.equal(modal([run("a", () => "error")], "p0"), undefined);
});

test("below two batches of five runs the comparison is underpowered, whatever the replay says", () => {
  const same = () => "satisfies" as const;
  const flipped = () => "violates" as const;
  const oneDay = Array.from({ length: 10 }, () => run("day-1", same));
  assert.equal(compare(oneDay, run("replay", flipped), PAIRS).verdict, "underpowered");
  const fourOnOne = [...Array.from({ length: 5 }, () => run("day-1", same)), ...Array.from({ length: 4 }, () => run("day-2", same))];
  assert.equal(compare(fourOnOne, run("replay", flipped), PAIRS).verdict, "underpowered");
  assert.equal(RULE.minBatches, 2);
  assert.equal(RULE.minRunsPerBatch, 5);
});

test("a replay whose requests failed is not judged, even when every one failed", () => {
  const baseline = [...Array.from({ length: 5 }, () => run("day-1", () => "satisfies")), ...Array.from({ length: 5 }, () => run("day-2", () => "satisfies"))];
  const allFailed = compare(baseline, run("replay", () => "error"), PAIRS);
  assert.equal(allFailed.verdict, "underpowered");
  assert.equal(allFailed.moves.errors, 34);
  assert.equal(compare(baseline, run("replay", (id) => (id === "p0" ? "error" : "satisfies")), PAIRS).verdict, "underpowered");
  assert.equal(compare(baseline, run("replay", () => "satisfies"), PAIRS).verdict, "no_drift", "the same baseline judges a complete replay");
});

test("a baseline run with a failed pair is left out and not counted toward the floor", () => {
  const good = (batch: string) => run(batch, () => "satisfies");
  const failing = (batch: string) => run(batch, (id) => (id === "p0" ? "error" : "satisfies"));
  const four = [...Array.from({ length: 4 }, () => good("day-1")), failing("day-1"), ...Array.from({ length: 5 }, () => good("day-2"))];
  assert.equal(compare(four, run("replay", () => "violates"), PAIRS).verdict, "underpowered");
  // The runs that failed entirely would have lowered run to run to 0, and made any replay a drift.
  const drowned = [...Array.from({ length: 5 }, () => run("day-1", () => "error")), ...Array.from({ length: 5 }, () => run("day-2", () => "error"))];
  assert.equal(compare(drowned, run("replay", () => "satisfies"), PAIRS).verdict, "underpowered");
});

test("two batches taken on the same day are not two days", () => {
  const sameDay = [...Array.from({ length: 5 }, () => run("day-1", () => "satisfies")), ...Array.from({ length: 5 }, () => ({ ...run("day-2", () => "satisfies"), at: "2026-09-25T09:00:00Z" }))];
  const c = compare(sameDay, run("replay", () => "violates"), PAIRS);
  assert.equal(c.verdict, "underpowered");
  assert.match(c.why, /both taken on 2026-09-25/);
});

test("a batch that runs past UTC midnight stays on the day it began", () => {
  const late = (i: number) => ({ ...run("day-1", () => "satisfies"), at: i < 3 ? "2026-09-25T23:50:00Z" : "2026-09-26T00:10:00Z" });
  const nextDay = Array.from({ length: 5 }, () => ({ ...run("day-2", () => "satisfies"), at: "2026-09-26T05:00:00Z" }));
  const c = compare([...Array.from({ length: 5 }, (_, i) => late(i)), ...nextDay], run("replay", () => "satisfies"), PAIRS);
  assert.equal(c.verdict, "no_drift", c.why);
});

test("with nothing changed a replay is seldom drift; with 5 of 34 pairs flipped it always is", () => {
  const rand = mulberry32(87);
  const k = 10;
  const baselineOf = (p: (id: string) => number) => [...Array.from({ length: k / 2 }, () => run("day-1", drawn(rand, p))), ...Array.from({ length: k / 2 }, () => run("day-2", drawn(rand, p)))];
  const spread = (id: string) => 0.3 + (Number(id.slice(1)) % 5) * 0.1; // every pair moves
  const still = (id: string) => (id === "p0" || id === "p1" ? 0.5 : 1); // two pairs of 34 move, as measured
  for (const [name, p] of [["spread", spread], ["still", still]] as const) {
    let drift = 0;
    for (let t = 0; t < 2000; t++) if (compare(baselineOf(p), run("replay", drawn(rand, p)), PAIRS).verdict === "drift") drift += 1;
    assert.ok(drift / 2000 <= 1 / (k + 1) + 0.02, `${name}: ${drift} of 2000 called drift`);
  }
  let caught = 0;
  const flip = new Set(["p2", "p3", "p4", "p5", "p6"]);
  for (let t = 0; t < 2000; t++) {
    const r = run("replay", (id) => (flip.has(id) ? (drawn(rand, still)(id) === "satisfies" ? "violates" : "satisfies") : drawn(rand, still)(id)));
    if (compare(baselineOf(still), r, PAIRS).verdict === "drift") caught += 1;
  }
  assert.ok(caught / 2000 >= 0.99, `${caught} of 2000 flipped replays called drift`);
});

test("a difference no larger than one day from the other is not drift", () => {
  // Day 2 reads three pairs differently from day 1, which has one run more, so the baseline's most
  // frequent outcome is day 1's and a replay that reads them as day 2 did differs on three. Every run
  // of each day agrees with its own day: compared with its own day alone, nothing would vary.
  const shifted = new Set(["p0", "p1", "p2"]);
  const day1 = () => "satisfies" as const;
  const day2 = (id: string) => (shifted.has(id) ? ("unknown" as const) : ("satisfies" as const));
  const baseline = [...Array.from({ length: 6 }, () => run("day-1", day1)), ...Array.from({ length: 5 }, () => run("day-2", day2))];
  const c = compare(baseline, run("replay", day2), PAIRS);
  assert.equal(c.replay, 3 / 34);
  assert.equal(c.dayToDay, 3 / 34, "the day-to-day difference is seen");
  assert.equal(c.verdict, "no_drift");
  // Three more pairs than a day ever moved is drift.
  const further = new Set(["p3", "p4", "p5"]);
  assert.equal(compare(baseline, run("replay", (id) => (further.has(id) ? "violates" : day2(id))), PAIRS).verdict, "drift");
});

test("a tie between the replay and the baseline's own spread is not drift", () => {
  const baseline = [...Array.from({ length: 5 }, () => run("day-1", () => "satisfies")), ...Array.from({ length: 5 }, () => run("day-2", () => "satisfies"))];
  const c = compare(baseline, run("replay", () => "satisfies"), PAIRS);
  assert.equal(c.replay, 0);
  assert.equal(c.verdict, "no_drift");
  assert.equal(c.baselineVariation, "none observed");
});

test("a replay names what changed: the versions the host named, and the frozen set against the tool", () => {
  const baseline = [...Array.from({ length: 5 }, () => run("day-1", () => "satisfies")), ...Array.from({ length: 5 }, () => run("day-2", () => "satisfies"))];
  const c = compare(baseline, run("replay", () => "satisfies", ["jev-1.14.0"]), PAIRS, { added: 1, removed: 0 });
  assert.deepEqual(c.versions, { baseline: ["jev-1.13.0"], replay: ["jev-1.14.0"], changed: true });
  assert.deepEqual(c.frozenVsTool, { added: 1, removed: 0 });
  assert.deepEqual(c.repositories, ["grovedb-500", "moltis-1064"]);
  assert.equal(compare(baseline, run("replay", () => "satisfies"), PAIRS).versions.changed, false);
});

test("D counts the pairs that differ from the others' most frequent outcome, errors aside", () => {
  const others = [run("a", () => "satisfies"), run("a", () => "satisfies")];
  const mine = run("b", (id) => (id === "p0" ? "violates" : id === "p1" ? "error" : "satisfies"));
  assert.equal(distance(mine, others, IDS), 1 / 33);
});
