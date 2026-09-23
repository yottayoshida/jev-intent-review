// The form-choice bench (ADR 0008): the rule that reads Jev's answer, the keyword rule scored beside
// it, and the scorer that turns a log into the table the documentation quotes — checked on a log
// written by hand, so that a table cannot be right for a wrong reason.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chooseForm, FORM_QUESTION, keywordForm } from "../bench/forms/choice/question.ts";
import { barLines, duplicates, isFragment, normalise, readAtBar, renderTables, requirementSentencesIn, rows, summarise, type Log, type SentenceSet } from "../bench/forms/choice/score.ts";
import { answer } from "./helpers/fakes.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const committedSet = (file = "sentences.json"): SentenceSet => JSON.parse(readFileSync(`${ROOT}bench/forms/choice/${file}`, "utf8")) as SentenceSet;

test("every requirement sentence in the repository's spec, fixture and golden files is in one of the labelled sets", () => {
  const have = new Set([...committedSet().sentences, ...committedSet("sentences-v2.json").sentences].map((s) => normalise(s.text)));
  const found = requirementSentencesIn(ROOT);
  assert.ok(found.length >= 60, `only ${found.length} sentences found in the repository`);
  const left = found.filter((f) => !have.has(normalise(f.text)));
  assert.deepEqual(left, []);
});

test("the committed log scores as the documentation says", () => {
  const log = JSON.parse(readFileSync(`${ROOT}bench/logs/form-choice-v1.json`, "utf8")) as Log;
  const all = rows(committedSet(), log);
  assert.equal(all.length, 72);
  assert.equal(Object.values(log.runs).reduce((n, r) => n + r.length, 0), 216);
  const f = summarise(all, "failure_propagation", "all");
  const c = summarise(all, "check_before_action", "all");
  const n = summarise(all, "neither", "all");
  assert.deepEqual([f.sentences, f.rightEveryRun, f.checkInAnyRun], [18, 16, 0]);
  assert.deepEqual([c.sentences, c.rightEveryRun, c.checkInAnyRun, c.keywordRight], [11, 10, 10, 8]);
  assert.deepEqual([n.sentences, n.rightEveryRun, n.checkInAnyRun], [43, 39, 4]);
  assert.ok(barLines(all).every((line) => line.endsWith("— met")), barLines(all).join("\n"));
});

test("an answer whose choice the question did not offer reads as none, not as a label", () => {
  assert.equal(readAtBar(answer("constructor", 0.99)), "none");
  assert.equal(readAtBar(answer("neither", 0.99)), "neither");
  assert.equal(readAtBar(answer("neither", 0.59)), "under");
  assert.equal(readAtBar(undefined), "none");
});

test("the form question offers the two forms and neither, and its text names no sentence", () => {
  assert.deepEqual(Object.keys(FORM_QUESTION), ["requirement_form"]);
  assert.deepEqual(Object.keys(FORM_QUESTION.requirement_form!.criteria), ["failure_propagation", "check_before_action", "neither"]);
  assert.match(FORM_QUESTION.requirement_form!.instructions, /requirement\.text/);
});

test("chooseForm: a form at the bar is that form; neither, under the bar and no answer are the default", () => {
  assert.deepEqual(chooseForm(answer("failure_propagation", 0.9)), { form: "failure_propagation", by: "jev", verdict: "failure_propagation", probability: 0.9 });
  assert.deepEqual(chooseForm(answer("check_before_action", 0.6)), { form: "check_before_action", by: "jev", verdict: "check_before_action", probability: 0.6 });
  assert.deepEqual(chooseForm(answer("check_before_action", 0.59)), { form: "failure_propagation", by: "default", verdict: "check_before_action", probability: 0.59 });
  assert.deepEqual(chooseForm(answer("neither", 0.95)), { form: "failure_propagation", by: "default", verdict: "neither", probability: 0.95 });
  assert.deepEqual(chooseForm(undefined), { form: "failure_propagation", by: "default", verdict: "no_answer", probability: 0 });
  // An option this tool did not offer decides nothing.
  assert.equal(chooseForm(answer("constructor", 0.99)).by, "default");
});

test("the keyword rule tries the check words first, so a check sentence that says 'failed' is still check", () => {
  assert.equal(keywordForm("While a restore is being finalized, the tree heights must not be rewritten unless verifying the heights has failed."), "check_before_action");
  assert.equal(keywordForm("If reading the baseline fails, the failure must reach the caller as an error."), "failure_propagation");
  assert.equal(keywordForm("The MCP explore tool exposes observation mode as an optional input."), "neither");
});

test("a fragment is a sentence that does not close with a full stop", () => {
  assert.equal(isFragment("…and instead report an '未"), true);
  assert.equal(isFragment("…and the judge's verdict on"), true);
  assert.equal(isFragment("It must not return a successful result."), false);
  assert.equal(isFragment("the CI step uploads `failed/` when it is red.',"), true);
  assert.equal(isFragment("with values 'wrappers' and 'syscalls'.”"), false);
  assert.equal(isFragment("the judge refuses rather than judging.*"), false);
  assert.equal(isFragment("disabled API keys must never authenticate;"), false);
});

const set: SentenceSet = {
  about: "hand-written",
  sentences: [
    { id: "f1", label: "failure_propagation", origin: { kind: "tool" }, text: "If reading fails, the failure must reach the caller as an error." },
    { id: "c1", label: "check_before_action", origin: { kind: "written" }, text: "A key must not open a session unless it is enabled." },
    { id: "c2", label: "check_before_action", origin: { kind: "text" }, text: "disabled API keys must never authenticate;" },
    { id: "n1", label: "neither", origin: { kind: "model" }, text: "The refusal is a latch now." },
    { id: "n2", label: "neither", origin: { kind: "model" }, text: "It now walks backwards from the end of the file, and" },
  ],
};

const log: Log = {
  conditions: { sentences: "x", question: "y", bar: 0.6, runsPerSentence: 3, provider: "test" },
  tool: { head: "h", note: "" },
  question: FORM_QUESTION,
  runs: {
    f1: [answer("failure_propagation", 0.9), answer("failure_propagation", 0.7), answer("failure_propagation", 0.61)].map((a) => ({ answer: a, ms: 1 })),
    c1: [answer("check_before_action", 0.8), answer("check_before_action", 0.9), answer("neither", 0.7)].map((a) => ({ answer: a, ms: 1 })),
    c2: [answer("check_before_action", 0.8), answer("check_before_action", 0.9), answer("check_before_action", 0.95)].map((a) => ({ answer: a, ms: 1 })),
    n1: [answer("neither", 0.9), answer("check_before_action", 0.55), answer("neither", 0.8)].map((a) => ({ answer: a, ms: 1 })),
    n2: [answer("check_before_action", 0.7), answer("neither", 0.8), answer("neither", 0.8)].map((a) => ({ answer: a, ms: 1 })),
  },
};

test("the scorer reads each run at the bar and counts per class and per author", () => {
  const all = rows(set, log);
  assert.deepEqual(all.map((r) => r.rightEveryRun), [true, false, true, false, false]);
  assert.deepEqual(all.map((r) => r.checkInAnyRun), [false, true, true, false, true]);
  assert.deepEqual(all.map((r) => r.fragment), [false, false, false, false, true]);
  const c = summarise(all, "check_before_action", "all");
  assert.deepEqual([c.sentences, c.rightEveryRun, c.checkInAnyRun, c.defaultInAnyRun, c.keywordRight], [2, 1, 2, 1, 2]);
  const n = summarise(all, "neither", ["model"]);
  // n1's check reading is under the bar, so only n2 counts as read as check.
  assert.deepEqual([n.sentences, n.fragments, n.checkInAnyRun], [2, 1, 1]);
  assert.equal(summarise(all, "neither", ["text", "written"]).sentences, 0);
});

test("the bar lines carry the number beside the bar and say whether it is met", () => {
  const lines = barLines(rows(set, log));
  assert.match(lines[0]!, /^failure sentences .* 0 of 1 \(bar: 0\) — met$/);
  assert.match(lines[1]!, /^check sentences .* 1 of 2 \(50%; bar: 80%, and not below the keyword rule's 2\) — not met$/);
  assert.match(lines[2]!, /^neither sentences .* 1 of 2 \(bar: at most 0\) — not met$/);
});

test("the rendered table is Markdown with one row per class and author and one per sentence", () => {
  const md = renderTables(set, log);
  assert.match(md, /\| failure_propagation \| all \| 1 \| 0 \| 1\/1 \| 0\/1 \| 0\/1 \| 1\/1 \|/);
  assert.match(md, /\| check_before_action \| all \| 2 \| 0 \| 1\/2 \| 2\/2 \| 1\/2 \| 2\/2 \|/);
  assert.match(md, /\| \| text \+ written \| 2 \|/);
  assert.match(md, /\| n2 \| neither \| model \| yes \| check_before_action 0\.70 \| neither 0\.80 \| neither 0\.80 \| neither \|/);
  assert.doesNotMatch(md, /not fully measured/);
});

test("duplicates are found by normalised text", () => {
  assert.deepEqual(duplicates([...set.sentences, { id: "c2b", label: "check_before_action", origin: { kind: "tool" }, text: "Disabled API keys must never authenticate;" }]), [["c2", "c2b"]]);
  assert.deepEqual(duplicates(set.sentences), []);
});
