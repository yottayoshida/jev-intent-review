// The table `docs/local-check-cli.md` quotes, computed from the log and from nothing else, and the
// checks on the labelled set. Nothing here sends a request.

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

/** Jev's reading of one answer at the bar: the option chosen, when its probability clears the bar, else `under`. */
export function readAtBar(answer: ChoiceAnswer | undefined, bar = BAR): Label | "under" | "none" {
  if (!answer) return "none";
  if (answer.probability < bar) return "under";
  return answer.choice as Label;
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
    const readings = (log.runs[s.id] ?? []).map((r) => readAtBar(r.answer, log.conditions.bar));
    const probabilities = (log.runs[s.id] ?? []).map((r) => r.answer.probability);
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
  missing: number;
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
    missing: picked.filter((r) => r.readings.length === 0).length,
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
  return [
    `failure sentences read as check_before_action at the bar in any run: ${f.checkInAnyRun} of ${f.sentences} (bar: 0)${f.checkInAnyRun === 0 ? " — met" : " — not met"}`,
    `check sentences read as check_before_action at the bar in every run: ${c.rightEveryRun} of ${c.sentences} (${(cShare * 100).toFixed(0)}%; bar: 80%, and not below the keyword rule's ${c.keywordRight})${cShare >= 0.8 && c.rightEveryRun >= c.keywordRight ? " — met" : " — not met"}`,
    `neither sentences read as check_before_action at the bar in any run: ${n.checkInAnyRun} of ${n.sentences} (bar: at most ${nCap})${n.checkInAnyRun <= nCap ? " — met" : " — not met"}`,
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
  out.push("| sentence | label | who wrote it | fragment | run 1 | run 2 | run 3 | keyword |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of all) {
    const cells = [0, 1, 2].map((i) => (r.readings[i] === undefined ? "–" : `${r.readings[i]} ${r.probabilities[i]!.toFixed(2)}`));
    out.push(`| ${r.id} | ${r.label} | ${r.kind} | ${r.fragment ? "yes" : ""} | ${cells.join(" | ")} | ${r.keyword} |`);
  }
  return `${out.join("\n")}\n`;
}
