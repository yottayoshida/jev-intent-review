// The table `docs/local-check-cli.md` quotes, computed from the log and from nothing else, and the
// checks on the labelled set. Nothing here sends a request.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readOption } from "../../../src/plan/forms.ts";
import { BAR } from "../../../src/plan/local-check.ts";
import type { ChoiceAnswer } from "../../../src/types.ts";
import { keywordForm, type Label } from "./question.ts";

export type Kind = "tool" | "model" | "text" | "written";

export interface Sentence {
  id: string;
  label: Label;
  origin: { kind: Kind; file?: string; id?: string; case?: string; index?: number; ref?: string; url?: string; note?: string };
  text: string;
}

export interface SentenceSet {
  about: string;
  sentences: Sentence[];
}

export interface Reading {
  answer: ChoiceAnswer;
  ms: number;
}

export interface Log {
  conditions: { sentences: string; question: string; bar: number; runsPerSentence: number; provider: string };
  tool: { head: string; note: string };
  question: unknown;
  endpoint?: string;
  runs: Record<string, Reading[]>;
}

/** Case, runs of whitespace and trailing punctuation do not make two sentences different. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.。!?:;,'"”’]+$/, "");
}

/**
 * A sentence cut before its end: it does not close with a full stop or a semicolon (a list item's
 * closer); a quote, bracket or emphasis mark after one is fine.
 */
export function isFragment(text: string): boolean {
  return !/[.;。][)”’"'*_]*$/.test(text.trim());
}

/** The requirements a spec or fixture file holds, at its top or under `spec`. */
export function requirementsIn(doc: Record<string, unknown>): { id: string; text: string }[] {
  const list = doc.requirements ?? (doc.spec as Record<string, unknown> | undefined)?.requirements;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is { id: string; text: string } => !!r && typeof (r as { text?: unknown }).text === "string");
}

/**
 * Every requirement sentence the repository holds in a file: `requirements[]` at the top or under
 * `spec` of any JSON file, the golden's `cases`, and the candidates' `requirement` — under `bench/`
 * and `test/fixtures/`, leaving out `bench/logs/`, whose files are records of runs and copy the
 * specs those runs were given. What is left out is said here so that the set's claim to hold
 * "every sentence" can be read against it.
 */
export function requirementSentencesIn(root: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        // bench/decisive/outside: sentences written for the probe of the check form's words (#82),
        // each naming its form, so the form question is never put to them.
        if (entry.name === "node_modules" || rel === "bench/logs" || rel === "bench/decisive/outside") continue;
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
      const d = doc as Record<string, unknown>;
      for (const r of requirementsIn(d)) out.push({ file: rel, text: r.text });
      if (d.cases && typeof d.cases === "object" && !Array.isArray(d.cases)) {
        for (const items of Object.values(d.cases as Record<string, unknown>)) if (Array.isArray(items)) for (const it of items) if (it && typeof (it as { text?: unknown }).text === "string") out.push({ file: rel, text: (it as { text: string }).text });
      }
      if (Array.isArray(d.candidates)) for (const c of d.candidates) if (c && typeof (c as { requirement?: unknown }).requirement === "string") out.push({ file: rel, text: (c as { requirement: string }).requirement });
    }
  };
  for (const top of ["bench", "test/fixtures"]) walk(join(root, top));
  return out;
}

export function duplicates(sentences: readonly Sentence[]): string[][] {
  const byText = new Map<string, string[]>();
  for (const s of sentences) {
    const key = normalise(s.text);
    byText.set(key, [...(byText.get(key) ?? []), s.id]);
  }
  return [...byText.values()].filter((ids) => ids.length > 1);
}

export const LABELS: readonly Label[] = ["failure_propagation", "check_before_action", "neither"];
export const KINDS: readonly Kind[] = ["tool", "model", "text", "written"];

/**
 * Jev's reading of one answer at the bar: the option chosen, when its probability clears the bar,
 * else `under`; no answer, or an option the question did not offer, is `none`. The run's own
 * `readOption` does the reading, so the scorer and `chooseForm` cannot drift apart; here `neither`
 * is one of the options read.
 */
export function readAtBar(answer: ChoiceAnswer | undefined, bar = BAR): Label | "under" | "none" {
  const read = readOption(answer, LABELS, bar);
  return read.kind === "option" ? (read.option as Label) : read.kind;
}

export interface Row {
  id: string;
  label: Label;
  kind: Kind;
  fragment: boolean;
  readings: (Label | "under" | "none")[];
  probabilities: number[];
  /** Read as its label at the bar in every run. */
  rightEveryRun: boolean;
  /** Read as `check_before_action` at the bar in any run. */
  checkInAnyRun: boolean;
  keyword: Label;
}

export function rows(set: SentenceSet, log: Log): Row[] {
  return set.sentences.map((s) => {
    const runs = log.runs[s.id] ?? [];
    const readings = runs.map((r) => readAtBar(r.answer, log.conditions.bar));
    const probabilities = runs.map((r) => r.answer.probability);
    return {
      id: s.id,
      label: s.label,
      kind: s.origin.kind,
      fragment: isFragment(s.text),
      readings,
      probabilities,
      rightEveryRun: readings.length === log.conditions.runsPerSentence && readings.every((r) => r === s.label),
      checkInAnyRun: readings.some((r) => r === "check_before_action"),
      keyword: keywordForm(s.text),
    };
  });
}

export interface ClassSummary {
  label: Label;
  kinds: Kind[] | "all";
  sentences: number;
  fragments: number;
  rightEveryRun: number;
  checkInAnyRun: number;
  /** Read as `neither` or under the bar in any run. */
  defaultInAnyRun: number;
  keywordRight: number;
}

export function summarise(all: Row[], label: Label, kinds: Kind[] | "all"): ClassSummary {
  const picked = all.filter((r) => r.label === label && (kinds === "all" || kinds.includes(r.kind)));
  return {
    label,
    kinds,
    sentences: picked.length,
    fragments: picked.filter((r) => r.fragment).length,
    rightEveryRun: picked.filter((r) => r.rightEveryRun).length,
    checkInAnyRun: picked.filter((r) => r.checkInAnyRun).length,
    defaultInAnyRun: picked.filter((r) => r.readings.some((x) => x === "neither" || x === "under" || x === "none")).length,
    keywordRight: picked.filter((r) => r.keyword === r.label).length,
  };
}

/**
 * What the numbers would have to show for Jev to be given the choice (ADR 0008), each as a line
 * with the number beside the bar. None of them decides anything: the owner reads them.
 */
export function barLines(all: Row[]): string[] {
  const f = summarise(all, "failure_propagation", "all");
  const c = summarise(all, "check_before_action", "all");
  const n = summarise(all, "neither", "all");
  const cShare = c.sentences === 0 ? 0 : c.rightEveryRun / c.sentences;
  const nCap = Math.floor(n.sentences / 10);
  const verdict = (count: number, met: boolean) => (count === 0 ? " — no sentences" : met ? " — met" : " — not met");
  return [
    `failure sentences read as check_before_action at the bar in any run: ${f.checkInAnyRun} of ${f.sentences} (bar: 0)${verdict(f.sentences, f.checkInAnyRun === 0)}`,
    `check sentences read as check_before_action at the bar in every run: ${c.rightEveryRun} of ${c.sentences} (${(cShare * 100).toFixed(0)}%; bar: 80%, and not below the keyword rule's ${c.keywordRight})${verdict(c.sentences, cShare >= 0.8 && c.rightEveryRun >= c.keywordRight)}`,
    `neither sentences read as check_before_action at the bar in any run: ${n.checkInAnyRun} of ${n.sentences} (bar: at most ${nCap})${verdict(n.sentences, n.checkInAnyRun <= nCap)}`,
  ];
}

const pct = (a: number, b: number) => (b === 0 ? "–" : `${a}/${b}`);

/** The Markdown the documentation quotes. */
export function renderTables(set: SentenceSet, log: Log): string {
  const all = rows(set, log);
  const out: string[] = [];
  out.push(`| label | who wrote it | sentences | fragments | read as its label in ${log.conditions.runsPerSentence}/${log.conditions.runsPerSentence} | read as check in any run | neither / under the bar in any run | keyword rule right |`);
  out.push("|---|---|---|---|---|---|---|---|");
  for (const label of LABELS) {
    const whole = summarise(all, label, "all");
    out.push(`| ${label} | all | ${whole.sentences} | ${whole.fragments} | ${pct(whole.rightEveryRun, whole.sentences)} | ${pct(whole.checkInAnyRun, whole.sentences)} | ${pct(whole.defaultInAnyRun, whole.sentences)} | ${pct(whole.keywordRight, whole.sentences)} |`);
    for (const kinds of [["tool"], ["model"], ["text", "written"]] as Kind[][]) {
      const s = summarise(all, label, kinds);
      if (s.sentences === 0) continue;
      out.push(`| | ${kinds.join(" + ")} | ${s.sentences} | ${s.fragments} | ${pct(s.rightEveryRun, s.sentences)} | ${pct(s.checkInAnyRun, s.sentences)} | ${pct(s.defaultInAnyRun, s.sentences)} | ${pct(s.keywordRight, s.sentences)} |`);
    }
  }
  out.push("");
  for (const line of barLines(all)) out.push(`- ${line}`);
  const missing = all.filter((r) => r.readings.length < log.conditions.runsPerSentence);
  if (missing.length > 0) out.push(`- not fully measured: ${missing.map((r) => r.id).join(", ")}`);
  out.push("");
  const runColumns = Array.from({ length: log.conditions.runsPerSentence }, (_, i) => i);
  out.push(`| sentence | label | who wrote it | fragment | ${runColumns.map((i) => `run ${i + 1}`).join(" | ")} | keyword |`);
  out.push(`|---|---|---|---|${runColumns.map(() => "---|").join("")}---|`);
  for (const r of all) {
    const cells = runColumns.map((i) => (r.readings[i] === undefined ? "–" : `${r.readings[i]} ${r.probabilities[i]!.toFixed(2)}`));
    out.push(`| ${r.id} | ${r.label} | ${r.kind} | ${r.fragment ? "yes" : ""} | ${cells.join(" | ")} | ${r.keyword} |`);
  }
  return `${out.join("\n")}\n`;
}
