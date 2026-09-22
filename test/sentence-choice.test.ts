// The sentence-choice bench (#40, part 2): the sentences are what the issues give, the scoring is the
// arithmetic the rules state, and a record made with other files than the ones fixed is refused.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { labelsFrom, NOT_A_SENTENCE, packetProblems, packets, PARTS, parts } from "../bench/sentence-choice/annotate.ts";
import { DEFINITIONS, SENTENCE_QUESTIONS } from "../bench/sentence-choice/question.ts";
import { FIXED_FILES, fleissKappa, LABEL_FILE, labelsOf, score, sha256, verify, wilson, type Head, type Labels, type Log } from "../bench/sentence-choice/replay.ts";
import { buildRules, type Rules } from "../bench/sentence-choice/rules.ts";
import { allUnits, readIssues, type Unit } from "../bench/sentence-choice/units.ts";

const DIR = join(import.meta.dirname, "..", "bench", "sentence-choice");
const read = (file: string) => readFileSync(join(DIR, file), "utf8");

test("the sentences asked about are exactly what the frozen issues give, and the rules are what the sentences give", () => {
  const units = allUnits();
  assert.equal(readIssues().length, 64);
  assert.equal(units.length, 491);
  assert.equal(read("units.json"), `${JSON.stringify(units, null, 1)}\n`);
  assert.equal(read("rules.json"), `${JSON.stringify(buildRules(units), null, 1)}\n`);
  const rules = JSON.parse(read("rules.json")) as Rules;
  assert.equal(new Set(rules.order.ids).size, units.length, "every unit given once, in the fixed order");
  assert.ok(rules.order.ids.every((id) => units.some((u) => u.id === id)));
  // With three annotators and two needed, at most one label can have a majority.
  assert.deepEqual(rules.annotators, { count: 3, majority: 2, noMajority: "cannot_tell" });
  // The annotators read the question's own definitions, and have one label more.
  assert.deepEqual(Object.keys(SENTENCE_QUESTIONS.role.criteria), Object.keys(DEFINITIONS));
  assert.deepEqual(rules.labels, [...Object.keys(DEFINITIONS), "not_a_sentence"]);
});

// Two issues: A asks for behaviour in two sentences; B asks for none.
const unit = (id: string, heading: string, sentence: string): Unit => ({ id, issue: id.split(":")[0] as string, title: "t", heading, leadIn: "", paragraph: sentence, sentence });
const UNITS = [
  unit("o/r#1:1", "Expected behavior", "It returns an error"),
  unit("o/r#1:2", "", "The flag must be accepted"),
  unit("o/r#1:3", "Steps", "Run the command twice"),
  unit("o/r#1:4", "", "Version 1.2"),
  unit("o/r#2:1", "", "It should work, I think"),
  unit("o/r#2:2", "", "Why is this slow here?"),
];
const RULES = buildRules(UNITS) as Rules;
// Votes that make the labels: all agree, two of three, and (the last) no two alike.
const LABELS: Labels = {
  labeler: "three annotators",
  labelled: "2026-09-22",
  packets: {},
  votes: {
    "o/r#1:1": ["required_behavior", "required_behavior", "required_behavior"],
    "o/r#1:2": ["required_behavior", "neither", "required_behavior"],
    "o/r#1:3": ["neither", "neither", "neither"],
    "o/r#1:4": ["not_a_sentence", "neither", "not_a_sentence"],
    "o/r#2:1": ["neither", "required_behavior", "neither"],
    "o/r#2:2": ["neither", "non_goal", "cannot_tell"],
  },
};
const LABEL = { "o/r#1:1": "required_behavior", "o/r#1:2": "required_behavior", "o/r#1:3": "neither", "o/r#1:4": "not_a_sentence", "o/r#2:1": "neither", "o/r#2:2": "cannot_tell" };
const a = (choice: string, probability: number) => ({ choice, probability });
const run = (n: number, answers: Log["runs"][number]["answers"]) => ({ run: n, started: "", finished: "", requests: 6, bytes: 0, answers });
const LOG: Log = {
  head: {} as Head,
  runs: [
    // 0.6 exactly is a choice; 0.59 is not; an error is no answer; a "not a sentence" chosen is wrong.
    run(1, { "o/r#1:1": a("required_behavior", 0.9), "o/r#1:2": a("required_behavior", 0.6), "o/r#1:3": a("neither", 0.8), "o/r#1:4": a("required_behavior", 0.7), "o/r#2:1": a("required_behavior", 0.59), "o/r#2:2": { error: "server" } }),
    run(2, { "o/r#1:1": a("required_behavior", 0.95), "o/r#1:2": a("cannot_tell", 0.9), "o/r#1:3": a("neither", 0.8), "o/r#1:4": a("neither", 0.7), "o/r#2:1": a("required_behavior", 0.8), "o/r#2:2": a("non_goal", 0.7) }),
    run(3, { "o/r#1:1": a("required_behavior", 0.9), "o/r#1:2": a("required_behavior", 0.9), "o/r#1:3": a("neither", 0.9), "o/r#1:4": a("neither", 0.9), "o/r#2:1": a("neither", 0.9), "o/r#2:2": a("neither", 0.9) }),
  ],
};

test("scoring is the stated arithmetic: every choice counts, a bound is Wilson's, and the rule is scored the same way", () => {
  const s = score(UNITS, LABELS, LOG, RULES);
  assert.equal(s.positives, 2);
  assert.equal(s.issuesAskingNothing, 1);
  const [r1, r2, r3] = s.runs;
  assert.deepEqual([r1?.chosen, r1?.correct, r1?.unanswered, r1?.chooseInIssuesAskingNothing], [3, 2, 1, 0]);
  assert.equal(r1?.precision.value, 2 / 3);
  assert.equal(r1?.lenientPrecision, 1, "the chosen 'not a sentence' is left out of the lenient figure only");
  assert.equal(r1?.recall.value, 1);
  assert.deepEqual([r2?.chosen, r2?.correct, r2?.chooseInIssuesAskingNothing], [2, 1, 1]);
  assert.equal(r2?.lenientPrecision, 0.5, "a chosen sentence labelled 'neither' is wrong in both figures");
  assert.deepEqual(r2?.nonGoal, { answered: 1, labelled: 0, both: 0 });
  assert.deepEqual([r3?.chosen, r3?.correct], [2, 2]);
  assert.deepEqual(s.stable, { any: 4, every: 1 });
  // Fleiss' kappa on "states a required behaviour": yes-votes 3,2,0,0,1,0 of 3 give 7/9 observed
  // against 5/9 by chance, so (7/9 − 5/9) / (1 − 5/9) = 0.5.
  const { positiveKappa, ...counts } = s.agreement;
  assert.deepEqual(counts, { unanimous: 2, majority: 3, none: 1, of: 6, positiveUnanimous: 4 });
  assert.ok(Math.abs(positiveKappa - 0.5) < 1e-12, String(positiveKappa));
  // The model-free rule: "Expected behavior", "must", "should" — the last one wrongly.
  assert.deepEqual([s.rule.chosen, s.rule.correct], [3, 2]);
  // Published 95% Wilson interval for 2 of 3.
  assert.ok(Math.abs((r1?.precision.lo ?? 0) - 0.2077) < 5e-4 && Math.abs((r1?.precision.hi ?? 0) - 0.9385) < 5e-4, JSON.stringify(r1?.precision));
  assert.equal(s.decision, "undetermined", "wide intervals neither clear the bar nor fall below it");
});

test("a label is what two of the three annotators gave, and votes that do not fit the rules are refused", () => {
  assert.deepEqual(labelsOf(LABELS, RULES), LABEL);
  const one = (votes: string[]) => () => labelsOf({ ...LABELS, votes: { "o/r#1:1": votes } }, RULES);
  assert.throws(one(["neither", "neither"]), /has 2 votes; each unit needs 3/);
  assert.throws(one(["neither", "neither", "neither", "neither"]), /has 4 votes/);
  assert.throws(one(["neither", "neither", "required"]), /a vote "required"/);
  assert.equal(fleissKappa([], 3), Number.NaN);
  assert.equal(fleissKappa([0, 0, 0], 3), Number.NaN, "no one ever says yes: chance agreement is total, kappa says nothing");
  assert.equal(fleissKappa([3, 0, 3, 0], 3), 1);
});

test("every annotator reads one part of the fixed order, with the definitions and the fields Jev is shown, and nothing more", () => {
  const units = allUnits();
  const rules = JSON.parse(read("rules.json")) as Rules;
  const split = parts(rules);
  assert.deepEqual(split.map((p) => p.length), [164, 164, 163]);
  assert.deepEqual(split.flat(), rules.order.ids, "the parts are the fixed order cut in three, every unit in one");
  const all = packets(units, rules);
  assert.equal(all.length, PARTS * rules.annotators.count);
  for (const p of all) {
    const part = split[p.part - 1] as string[];
    assert.deepEqual([...p.ids].sort(), [...part].sort(), p.id);
    const lines = p.text.split("\n").filter((l) => l.startsWith("{"));
    assert.deepEqual(lines.map((l) => (JSON.parse(l) as { id: string }).id), p.ids, "each unit once, in the packet's own order");
    // Exactly the five fields Jev is shown, beside the id.
    assert.deepEqual(Object.keys(JSON.parse(lines[0] as string)), ["id", "title", "heading", "lead_in", "paragraph", "sentence"]);
    for (const text of [...Object.values(DEFINITIONS), NOT_A_SENTENCE]) assert.ok(p.text.includes(text), `${p.id} carries every definition`);
  }
  const orders = all.filter((p) => p.part === 1).map((p) => p.ids.join(" "));
  assert.equal(new Set(orders).size, rules.annotators.count, "each annotator of a part reads it in an order of its own");
});

test("labels.json is made only from one complete answer per packet, and records the packets it was made from", () => {
  const units = allUnits();
  const rules = JSON.parse(read("rules.json")) as Rules;
  const all = packets(units, rules);
  const answer = (p: (typeof all)[number], label = (i: number) => (i === 0 && p.annotator === 1 ? "required_behavior" : "neither")) => ({ packet: p.id, labels: p.ids.map((id, i) => ({ id, label: label(i) })) });
  const answers = all.map((p) => answer(p));
  const labels = labelsFrom(answers, units, rules, "l", "t");
  assert.equal(Object.keys(labels.votes).length, units.length);
  assert.ok(Object.values(labels.votes).every((v) => v.length === 3 && v.every((x) => x !== "")));
  // Annotator 1's first unit of each part: its vote is first, and the other two outvote it.
  const first = all.find((p) => p.part === 2 && p.annotator === 1)?.ids[0] as string;
  assert.deepEqual(labels.votes[first], ["required_behavior", "neither", "neither"]);
  assert.equal(labelsOf(labels, rules)[first], "neither");
  assert.deepEqual(packetProblems(labels, units, rules), []);
  assert.match(packetProblems({ ...labels, packets: { ...labels.packets, "part1-annotator1": "0" } }, units, rules).join(), /packet part1-annotator1/);

  const p1 = all[0] as (typeof all)[number];
  const otherPart = all.find((p) => p.part === 2) as (typeof all)[number];
  const without = (i: number) => answers.filter((_, j) => j !== i);
  assert.throws(() => labelsFrom(without(0), units, rules, "", ""), /part1-annotator1 was answered 0 times/);
  assert.throws(() => labelsFrom([...answers, answers[0] as (typeof answers)[number]], units, rules, "", ""), /part1-annotator1 was answered 2 times/);
  const change = (labelsOfP1: { id: string; label: string }[]) => labelsFrom([{ packet: p1.id, labels: labelsOfP1 }, ...without(0)], units, rules, "", "");
  assert.throws(() => change(answer(p1).labels.slice(1)), /leaves 1 units unlabelled/);
  assert.throws(() => change([...answer(p1).labels, answer(p1).labels[0] as { id: string; label: string }]), /twice/);
  assert.throws(() => change([...answer(p1).labels.slice(1), { id: p1.ids[0] as string, label: "required" }]), /the label "required"/);
  assert.throws(() => change([...answer(p1).labels, { id: otherPart.ids[0] as string, label: "neither" }]), /did not show/);
  assert.throws(() => labelsFrom([...answers, { packet: "part4-annotator1", labels: [] }], units, rules, "", ""), /packets that do not exist: part4-annotator1/);
});

test("the decision needs every run: all clear is adopt, all below is reject, anything else is undetermined", () => {
  const z = RULES.interval.z;
  assert.deepEqual(wilson(0, 0, z), { value: Number.NaN, lo: 0, hi: 1 });
  // Many sentences, all positives: precision k of n chosen, recall k of 100.
  const many = (n: number) => Array.from({ length: n }, (_, i) => unit(`o/r#9:${i + 1}`, "", "a sentence here"));
  const units = many(200);
  const labels: Labels = { labeler: "", labelled: "", packets: {}, votes: Object.fromEntries(units.map((u, i) => [u.id, Array<string>(3).fill(i < 100 ? "required_behavior" : "neither")])) };
  const answers = (right: number, wrong: number) => Object.fromEntries(units.map((u, i) => [u.id, a(i < right || (i >= 100 && i < 100 + wrong) ? "required_behavior" : "neither", 0.9)]));
  const log = (...runs: [number, number][]) => ({ head: {} as Head, runs: runs.map(([r, w], i) => run(i + 1, answers(r, w))) });
  const rules = buildRules(units) as Rules;
  assert.equal(score(units, labels, log([95, 2], [95, 2], [95, 2]), rules).decision, "adopt");
  assert.equal(score(units, labels, log([95, 2], [95, 2], [60, 40]), rules).decision, "undetermined");
  assert.equal(score(units, labels, log([50, 50], [50, 50], [50, 50]), rules).decision, "reject");
  assert.equal(score(units, labels, log([95, 2], [95, 2]), rules).decision, "undetermined", "fewer runs than the rules ask for decide nothing");
});

test("a record is scored only with the files and commits it was made with, the question fixed before the labels", () => {
  const files = Object.fromEntries([...FIXED_FILES, LABEL_FILE].map((f) => [f, `content of ${f}`]));
  const head = { commits: { fixed: "c1", labels: "c2" }, sha256: Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha256(t)])) } as unknown as Head;
  const committed = { c1: Object.fromEntries(FIXED_FILES.map((f) => [f, files[f]])), c2: files } as Record<string, Record<string, string>>;
  const atCommit = (c: string, f: string) => {
    const text = committed[c]?.[f];
    if (text === undefined) throw new Error("not in this clone");
    return text;
  };
  const ancestor = (x: string, y: string) => x === "c1" && y === "c2";
  assert.deepEqual(verify(head, (f) => files[f] as string, atCommit, ancestor), []);
  // One label changed after the record was made.
  assert.match(verify(head, (f) => (f === LABEL_FILE ? "a label changed" : (files[f] as string)), atCommit, ancestor).join("; "), /labels\.json is not the file the record was made with/);
  // The labels committed before the question.
  assert.match(verify(head, (f) => files[f] as string, atCommit, () => false).join("; "), /is not before commit c2/);
  // A clone without the history cannot vouch for the order, and says so instead of passing.
  assert.match(verify(head, (f) => files[f] as string, () => {
    throw new Error("shallow");
  }, ancestor).join("; "), /cannot be read at commit/);
});
