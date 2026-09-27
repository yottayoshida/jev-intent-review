// Set 3 of the form-choice bench (#85, ADR 0026): the question with `failure_handling` offered is
// the one the run would build, the question the run sends is unchanged, and the lines fixed before
// the first request are computed as written — checked on logs written by hand.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keywordForm } from "../bench/forms/choice/question.ts";
import type { SentenceSet } from "../bench/forms/choice/score.ts";
import { barLines3, FORM_QUESTION_V3, isStrictFailure, keywordForm3, LABELS_NOW, majorityTruth, recordLines3, renderTables3, rows3, stopLine, wilson, type Log3, type Sentence3 } from "../bench/forms/choice/v3.ts";
import { buildFormQuestion, CHOSEN_FORMS, FORM_QUESTION, FORMS } from "../src/plan/forms.ts";
import { REQUIREMENT_FORMS } from "../src/types.ts";
import { answer } from "./helpers/fakes.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const committed = (file: string) => (JSON.parse(readFileSync(`${ROOT}bench/forms/choice/${file}`, "utf8")) as SentenceSet).sentences;

test("the question the run sends is built by the same function, and does not offer failure_handling", () => {
  assert.deepEqual(FORM_QUESTION, buildFormQuestion(CHOSEN_FORMS));
  assert.deepEqual(Object.keys(FORM_QUESTION.requirement_form!.criteria), ["failure_propagation", "check_before_action", "neither"]);
});

test("set 3's question is the run's with failure_handling's own sentence added third, before neither", () => {
  const v3 = FORM_QUESTION_V3.requirement_form!;
  const now = FORM_QUESTION.requirement_form!;
  assert.deepEqual(v3, buildFormQuestion(REQUIREMENT_FORMS).requirement_form);
  assert.deepEqual(Object.keys(v3.criteria), ["failure_propagation", "check_before_action", "failure_handling", "neither"]);
  assert.equal(v3.criteria.failure_handling, FORMS.failure_handling.says);
  assert.equal(v3.instructions, now.instructions);
  const { failure_handling: _, ...rest } = v3.criteria;
  assert.deepEqual(rest, now.criteria);
  // What the next pull request's flag would give: the run's order of declaration, every form offered.
  assert.deepEqual(JSON.stringify(buildFormQuestion(REQUIREMENT_FORMS.filter(() => true))), JSON.stringify(FORM_QUESTION_V3));
  assert.notDeepEqual(JSON.stringify(buildFormQuestion(["failure_propagation", "failure_handling", "check_before_action"])), JSON.stringify(FORM_QUESTION_V3));
});

test("set 3's keyword rule: check first, then whole handling words, then failure words; sets 1 and 2 keep theirs", () => {
  assert.equal(keywordForm3("If saving fails, the failure must be logged and the session kept."), "failure_handling");
  assert.equal(keywordForm3("A failed OAuth token exchange is retried once before the login fails."), "failure_propagation");
  assert.equal(keywordForm3("A key must not open a session unless it is enabled, and it is logged."), "check_before_action");
  assert.equal(keywordForm3("The doctor should report an error."), "failure_propagation");
  assert.equal(keywordForm3("The MCP explore tool exposes observation mode."), "neither");
  // Unchanged for sets 1 and 2, whose tables the documentation quotes.
  assert.equal(keywordForm("If saving fails, the failure must be logged and the session kept."), "failure_propagation");
});

test("the failure sentences that say the failure goes back are 21 of the 25, and the other four are named", () => {
  const all = [...committed("sentences.json"), ...committed("sentences-v2.json")] as unknown as Sentence3[];
  const failures = all.filter((s) => s.label === "failure_propagation");
  assert.equal(failures.length, 25);
  assert.equal(failures.filter(isStrictFailure).length, 21);
  assert.deepEqual(failures.filter((s) => !isStrictFailure(s)).map((s) => s.id).sort(), ["corpus-omamori-553-R1", "corpus-omamori-553-R2", "fixture-integrity-rust-R1", "golden-omamori-553-1"]);
  // A written-85 sentence is never one of them, whatever its words.
  assert.equal(isStrictFailure({ label: "failure_propagation", text: "It must reach the caller.", origin: { kind: "written-85" } }), false);
});

test("wilson's interval", () => {
  const [lo, hi] = wilson(8, 10);
  assert.ok(Math.abs(lo - 0.49) < 0.01 && Math.abs(hi - 0.943) < 0.01, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

const w85 = (id: string, repo: string, truth: "handles_locally" | "returns_to_caller"): Sentence3 => ({
  id,
  label: truth === "handles_locally" ? "failure_handling" : "failure_propagation",
  origin: { kind: "written-85", file: "x", ref: id },
  text: `sentence ${id}.`,
  repo,
  truth: { decided: truth, votes: [truth, truth, truth] },
});

test("the stop line needs 8 pull requests from 4 repositories", () => {
  const seven = Array.from({ length: 7 }, (_, i) => w85(`h${i}`, `o/r${i % 4}`, "handles_locally"));
  assert.deepEqual(stopLine(seven), { prs: 7, repos: 4, enough: false });
  const eightInThree = Array.from({ length: 8 }, (_, i) => w85(`h${i}`, `o/r${i % 3}`, "handles_locally"));
  assert.equal(stopLine(eightInThree).enough, false);
  const enough = [...Array.from({ length: 8 }, (_, i) => w85(`h${i}`, `o/r${i % 4}`, "handles_locally")), w85("r1", "o/r9", "returns_to_caller")];
  assert.deepEqual(stopLine(enough), { prs: 8, repos: 4, enough: true });
});

const reads = (...rs: [string, number][]) => rs.map(([c, p]) => ({ answer: answer(c, p), ms: 1 }));
const tool = (id: string, label: Sentence3["label"], text: string): Sentence3 => ({ id, label, origin: { kind: "tool" }, text });

const sentences: Sentence3[] = [
  ...Array.from({ length: 8 }, (_, i) => w85(`h${i}`, i < 5 ? "yottayoshida/omamori" : `o/r${i}`, "handles_locally")),
  w85("r0", "o/x", "returns_to_caller"),
  tool("f1", "failure_propagation", "If reading fails, the failure must reach the caller as an error."),
  tool("f2", "failure_propagation", "A baseline that cannot be read is not reported as no baseline at all."),
  tool("c1", "check_before_action", "A key must not open a session unless it is enabled."),
  tool("n1", "neither", "The refusal is a latch now."),
];
const H = "failure_handling";
const log: Log3 = {
  conditions: { sentences: ["a", "b", "c"], question: "q", bar: 0.6, runsPerSentence: 3, provider: "test" },
  tool: { head: "h", note: "" },
  question: FORM_QUESTION_V3,
  runs: {
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`h${i}`, i < 7 ? reads([H, 0.9], [H, 0.8], [H, 0.7]) : reads([H, 0.9], ["neither", 0.8], [H, 0.7])])),
    r0: reads(["failure_propagation", 0.9], [H, 0.7], ["failure_propagation", 0.9]),
    f1: reads(["failure_propagation", 0.9], [H, 0.61], ["failure_propagation", 0.9]),
    f2: reads([H, 0.9], [H, 0.9], [H, 0.9]),
    c1: reads(["check_before_action", 0.9], ["check_before_action", 0.9], ["check_before_action", 0.9]),
    n1: reads(["neither", 0.9], [H, 0.59], ["neither", 0.9]),
  },
};

test("set 3's lines: the main line, the failure sentences that say it goes back, and the old classes against the same day", () => {
  const all = rows3(sentences, log, ["failure_propagation", "check_before_action", H, "neither"]);
  const now = rows3(sentences.filter((s) => s.origin.kind !== "written-85"), { ...log, runs: { c1: reads(["check_before_action", 0.9], ["check_before_action", 0.9], ["check_before_action", 0.9]) } }, LABELS_NOW);
  const lines = barLines3(all, now);
  assert.match(lines[0]!, /^main: .* 7 of 8 \(88%; Wilson 95% 0\.53–0\.98.*; 4 repositories; outside yottayoshida\/omamori 2 of 3\) .* — met$/);
  // f1 read as failure_handling once, over the bar: 1 of 1 against a cap of 0. f2 does not say the failure goes back and is not counted.
  assert.match(lines[1]!, /check_before_action at the bar in any run: 0 of 1 \(bar: 0\) — met$/);
  assert.match(lines[2]!, /failure_handling at the bar in any run: 1 of 1 \(bar: at most 0\) — not met$/);
  assert.match(lines[3]!, /1 of 1 \(100%; bar: 80%, not below the keyword rule's 1, and at most one fewer than the same day's 1 under the question sent now\) — met$/);
  // n1's failure_handling reading is under the bar.
  assert.match(lines[6]!, /neither sentences read as failure_handling .* 0 of 1 \(bar: at most 0\) — met$/);
  // Without the same day's rows, the check line cannot be met.
  assert.match(barLines3(all)[3]!, /\(not measured\).* — not met$/);
  const records = recordLines3(all);
  assert.match(records[0]!, /returns the failure: read as failure_propagation in every run 0 of 1, as failure_handling in any run 1$/);
  assert.match(records[1]!, /\(fixture-integrity-rust-R1\)|\(f2\): read as failure_handling in any run 1 of 1$/);
  assert.match(records[2]!, /sent to failure_propagation or the default in any run 1, read as check_before_action in any run 0$/);
});

test("the main line is not read below 8 pull requests or 4 repositories, whatever the share", () => {
  const few = sentences.filter((s) => s.id !== "h7");
  const lines = barLines3(rows3(few, log, ["failure_propagation", "check_before_action", H, "neither"]));
  assert.match(lines[0]!, /7 of 7 .* — not enough pull requests to read$/);
});

test("under the question sent now, a failure_handling answer is not an option and reads as none", () => {
  const [r] = rows3([tool("x", "failure_propagation", "x.")], { ...log, runs: { x: reads([H, 0.99], [H, 0.99], [H, 0.99]) } }, LABELS_NOW);
  assert.deepEqual(r!.readings, ["none", "none", "none"]);
  assert.equal(r!.inAnyRun.failure_handling, false);
});

test("set 3's table has a row per class and author, the lines, the main line by repository, and every sentence", () => {
  const md = renderTables3(sentences, log, ["failure_propagation", "check_before_action", H, "neither"]);
  assert.match(md, /\| failure_handling \| all \| 8 \| 7\/8 \| 0\/8 \| 8\/8 \| 1\/8 \| 0\/8 \|/);
  assert.match(md, /\| yottayoshida\/omamori \| 5 \| 5 \|/);
  assert.match(md, /\| f1 \| failure_propagation \(goes back\) \| tool \| {2}\| failure_propagation 0\.90 \| failure_handling 0\.61 \| failure_propagation 0\.90 \| failure_propagation \|/);
  assert.doesNotMatch(md, /not fully measured/);
});

test("a pull request's truth is the answer two of three give; a split, a missing or an unknown answer is none", () => {
  assert.deepEqual(majorityTruth(["handles_locally", "returns_to_caller", "handles_locally"]), { decided: "handles_locally" });
  assert.deepEqual(majorityTruth(["other", "other", "unclear"]), { decided: "other" });
  assert.match((majorityTruth(["handles_locally", "returns_to_caller", "other"]) as { why: string }).why, /^split/);
  assert.match((majorityTruth(["handles_locally", undefined, "handles_locally"]) as { why: string }).why, /gave no answer/);
  assert.match((majorityTruth(["handles_locally", "handled", "handles_locally"]) as { why: string }).why, /not one of the four/);
});

test("sentences-v3.json is what combine.ts builds from the six readers' files, and its main line is enough to read", () => {
  assert.match(execFileSync(process.execPath, [`${ROOT}bench/forms/choice/written-85/combine.ts`, "--check"], { encoding: "utf8" }), /is what combine\.ts builds/);
  const v3 = JSON.parse(readFileSync(`${ROOT}bench/forms/choice/sentences-v3.json`, "utf8")) as { sentences: Sentence3[]; dropped: unknown[] };
  assert.deepEqual([v3.sentences.length, v3.dropped.length], [23, 18]);
  assert.deepEqual(stopLine(v3.sentences), { prs: 10, repos: 8, enough: true });
});
