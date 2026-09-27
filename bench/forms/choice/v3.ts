// Set 3 (#85, ADR 0026): the form question with `failure_handling` offered as a third form, put to
// the 79 sentences of sets 1 and 2 and to sentences written from dev pull requests whose fixed
// code handles a failure where it happens — and, the same day, the question the run sends now put
// to the 79 (set `1c`), so a change in how the old classes are read can be told from a change
// between days.
//
// Sets 1 and 2 are scored by `score.ts` as before; nothing here changes their tables. The lines
// below are ADR 0026's, written before the first request.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFormQuestion, FORM_QUESTION, readOption } from "../../../src/plan/forms.ts";
import { BAR } from "../../../src/plan/local-check.ts";
import { REQUIREMENT_FORMS, type ChoiceAnswer } from "../../../src/types.ts";
import type { Kind, Reading } from "./score.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The question the run would send once `failure_handling` is `chosenBySentence`: every form, in declared order. */
export const FORM_QUESTION_V3 = buildFormQuestion(REQUIREMENT_FORMS);
export const QUESTION_V3_HASH = sha256(JSON.stringify(FORM_QUESTION_V3));

export type Label3 = "failure_propagation" | "check_before_action" | "failure_handling" | "neither";
export const LABELS3: readonly Label3[] = ["failure_propagation", "check_before_action", "failure_handling", "neither"];
/** The options the run's question offers now; set `1c` is read against these. */
export const LABELS_NOW: readonly Label3[] = ["failure_propagation", "check_before_action", "neither"];

/** How the fixed code handles the failure its pull request is about, read from the diff alone. */
export type Truth = "returns_to_caller" | "handles_locally" | "other" | "unclear";
export const TRUTHS: readonly Truth[] = ["returns_to_caller", "handles_locally", "other", "unclear"];

export type Kind3 = Kind | "written-85";
export const KINDS3: readonly Kind3[] = ["tool", "model", "text", "written", "written-85"];

export interface Sentence3 {
  id: string;
  label: Label3;
  origin: { kind: Kind3; file?: string; id?: string; case?: string; index?: number; ref?: string; url?: string; note?: string };
  text: string;
  /** `written-85` only: the pull request's repository, and how its fixed code handles the failure. */
  repo?: string;
  truth?: { decided: Truth; votes: Truth[] };
}

export interface Set3File {
  about: string;
  sentences: Sentence3[];
  /** `sentences-v3.json` only: the pull requests left out, and why. */
  dropped?: { ref: string; why: string }[];
}

export interface Log3 {
  conditions: { sentences: string[]; question: string; bar: number; runsPerSentence: number; provider: string };
  tool: { head: string; note: string };
  question: unknown;
  endpoint?: string;
  runs: Record<string, Reading[]>;
}

export const SETS3 = {
  "3": { files: ["sentences.json", "sentences-v2.json", "sentences-v3.json"], log: "bench/logs/form-choice-v3.json", question: FORM_QUESTION_V3, offered: LABELS3 },
  "1c": { files: ["sentences.json", "sentences-v2.json"], log: "bench/logs/form-choice-v1c.json", question: FORM_QUESTION, offered: LABELS_NOW },
} as const;
export type Set3Name = keyof typeof SETS3;

/** The sentences of a set and the sha256 of each file, in the order the set names them. */
export function readSet3(dir: string, name: Set3Name): { sentences: Sentence3[]; hashes: string[]; files: Set3File[] } {
  const files = SETS3[name].files.map((f) => readFileSync(join(dir, f), "utf8"));
  const parsed = files.map((raw) => JSON.parse(raw) as Set3File);
  return { sentences: parsed.flatMap((p) => p.sentences), hashes: files.map(sha256), files: parsed };
}

/**
 * The keyword rule for set 3, scored beside Jev and used by nothing. Sets 1 and 2 keep theirs
 * (`question.ts`), so their tables are unchanged. The handling words are tried after the check
 * words and before the failure words, and whole: `log` is not `login`.
 */
export function keywordForm3(text: string): Label3 {
  const t = text.toLowerCase();
  if (/\bmust not\b|\bnever\b|\bunless\b/.test(t)) return "check_before_action";
  if (/\blog(s|ged|ging)?\b|\brecord|\bwarn/.test(t)) return "failure_handling";
  if (/\bfail|\berror/.test(t)) return "failure_propagation";
  return "neither";
}

/**
 * A failure sentence of sets 1 and 2 that says the failure goes back: to the caller, the client, or
 * as a returned error. Fixed by its words before the first request; 21 of the 25. The other four
 * say what is shown or reported, and `failure_handling` is not a wrong reading of them.
 */
export function isStrictFailure(s: Pick<Sentence3, "label" | "text" | "origin">): boolean {
  return s.label === "failure_propagation" && s.origin.kind !== "written-85" && /caller|return an error|reach the client/.test(s.text.toLowerCase());
}

export function readAtBar3(answer: ChoiceAnswer | undefined, offered: readonly Label3[], bar = BAR): Label3 | "under" | "none" {
  const read = readOption(answer, offered, bar);
  return read.kind === "option" ? (read.option as Label3) : read.kind;
}

export interface Row3 {
  id: string;
  label: Label3;
  kind: Kind3;
  repo?: string;
  truth?: Truth;
  strictFailure: boolean;
  readings: (Label3 | "under" | "none")[];
  probabilities: number[];
  /** Read as its label at the bar in every run. */
  rightEveryRun: boolean;
  /** Read as each option at the bar in at least one run. */
  inAnyRun: Record<Label3, boolean>;
  /** Read as `neither`, under the bar, or not at all in at least one run: sent to the default. */
  defaultInAnyRun: boolean;
  keyword: Label3;
}

export function rows3(sentences: readonly Sentence3[], log: Pick<Log3, "conditions" | "runs">, offered: readonly Label3[]): Row3[] {
  return sentences.map((s) => {
    const runs = log.runs[s.id] ?? [];
    const readings = runs.map((r) => readAtBar3(r.answer, offered, log.conditions.bar));
    return {
      id: s.id,
      label: s.label,
      kind: s.origin.kind,
      repo: s.repo,
      truth: s.truth?.decided,
      strictFailure: isStrictFailure(s),
      readings,
      probabilities: runs.map((r) => r.answer.probability),
      rightEveryRun: readings.length === log.conditions.runsPerSentence && readings.every((r) => r === s.label),
      inAnyRun: Object.fromEntries(LABELS3.map((l) => [l, readings.some((r) => r === l)])) as Record<Label3, boolean>,
      defaultInAnyRun: readings.some((r) => r === "neither" || r === "under" || r === "none"),
      keyword: keywordForm3(s.text),
    };
  });
}

/** Wilson's 95% interval for k of n; rows are taken as independent, which they are not quite (ADR 0026). */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - r) / d, (c + r) / d];
}

/** The pull requests the main line reads, and whether there are enough of them to read it (ADR 0026). */
export function stopLine(sentences: readonly Sentence3[]): { prs: number; repos: number; enough: boolean } {
  const main = sentences.filter((s) => s.origin.kind === "written-85" && s.truth?.decided === "handles_locally");
  const repos = new Set(main.map((s) => s.repo)).size;
  return { prs: main.length, repos, enough: main.length >= 8 && repos >= 4 };
}

const OMAMORI = "yottayoshida/omamori";

/**
 * ADR 0026's lines, each with its number beside it. `now` is set `1c`'s rows, the same 79 sentences
 * read the same day under the question the run sends now; without it the check line is not met.
 * None of them decides anything: the owner reads them.
 */
export function barLines3(v3: readonly Row3[], now?: readonly Row3[]): string[] {
  const verdict = (n: number, met: boolean) => (n === 0 ? " — no sentences" : met ? " — met" : " — not met");
  const count = (rs: readonly Row3[], f: (r: Row3) => boolean) => rs.filter(f).length;
  const cap = (n: number) => Math.floor(n / 10);
  const pctOf = (k: number, n: number) => (n === 0 ? "–" : `${((k / n) * 100).toFixed(0)}%`);

  const main = v3.filter((r) => r.kind === "written-85" && r.truth === "handles_locally");
  const mainRight = count(main, (r) => r.rightEveryRun);
  const [lo, hi] = wilson(mainRight, main.length);
  const repos = new Set(main.map((r) => r.repo)).size;
  const outside = main.filter((r) => r.repo !== OMAMORI);
  const enough = main.length >= 8 && repos >= 4;
  const mainMet = enough && main.length > 0 && mainRight / main.length >= 0.8;

  const strict = v3.filter((r) => r.strictFailure);
  const strictC = count(strict, (r) => r.inAnyRun.check_before_action);
  const strictH = count(strict, (r) => r.inAnyRun.failure_handling);

  const c = v3.filter((r) => r.label === "check_before_action");
  const cRight = count(c, (r) => r.rightEveryRun);
  const cKeyword = count(c, (r) => r.keyword === r.label);
  const cNow = now ? count(now.filter((r) => r.label === "check_before_action"), (r) => r.rightEveryRun) : undefined;
  const cH = count(c, (r) => r.inAnyRun.failure_handling);

  const n = v3.filter((r) => r.label === "neither" && r.kind !== "written-85");
  const nC = count(n, (r) => r.inAnyRun.check_before_action);
  const nH = count(n, (r) => r.inAnyRun.failure_handling);

  return [
    `main: sentences from pull requests whose fixed code handles the failure locally, read as failure_handling at the bar in every run: ${mainRight} of ${main.length} (${pctOf(mainRight, main.length)}; Wilson 95% ${lo.toFixed(2)}–${hi.toFixed(2)}, rows taken as independent; ${repos} repositories; outside ${OMAMORI} ${count(outside, (r) => r.rightEveryRun)} of ${outside.length}) (bar: 80%, with at least 8 pull requests from 4 repositories)${enough ? verdict(main.length, mainMet) : " — not enough pull requests to read"}`,
    `failure sentences that say the failure goes back, read as check_before_action at the bar in any run: ${strictC} of ${strict.length} (bar: 0)${verdict(strict.length, strictC === 0)}`,
    `failure sentences that say the failure goes back, read as failure_handling at the bar in any run: ${strictH} of ${strict.length} (bar: at most ${cap(strict.length)})${verdict(strict.length, strictH <= cap(strict.length))}`,
    `check sentences read as check_before_action at the bar in every run: ${cRight} of ${c.length} (${pctOf(cRight, c.length)}; bar: 80%, not below the keyword rule's ${cKeyword}, and at most one fewer than the same day's ${cNow ?? "(not measured)"} under the question sent now)${verdict(c.length, c.length > 0 && cRight / c.length >= 0.8 && cRight >= cKeyword && cNow !== undefined && cRight >= cNow - 1)}`,
    `check sentences read as failure_handling at the bar in any run: ${cH} of ${c.length} (bar: at most ${cap(c.length)})${verdict(c.length, cH <= cap(c.length))}`,
    `neither sentences read as check_before_action at the bar in any run: ${nC} of ${n.length} (bar: at most ${cap(n.length)})${verdict(n.length, nC <= cap(n.length))}`,
    `neither sentences read as failure_handling at the bar in any run: ${nH} of ${n.length} (bar: at most ${cap(n.length)})${verdict(n.length, nH <= cap(n.length))}`,
  ];
}

/** Recorded beside the lines, with no bar (ADR 0026). */
export function recordLines3(v3: readonly Row3[]): string[] {
  const returns = v3.filter((r) => r.kind === "written-85" && r.truth === "returns_to_caller");
  const loose = v3.filter((r) => r.label === "failure_propagation" && r.kind !== "written-85" && !r.strictFailure);
  const main = v3.filter((r) => r.kind === "written-85" && r.truth === "handles_locally");
  const n = (rs: Row3[], f: (r: Row3) => boolean) => rs.filter(f).length;
  return [
    `sentences from pull requests whose fixed code returns the failure: read as failure_propagation in every run ${n(returns, (r) => r.rightEveryRun)} of ${returns.length}, as failure_handling in any run ${n(returns, (r) => r.inAnyRun.failure_handling)}`,
    `failure sentences that say what is shown or reported (${loose.map((r) => r.id).join(", ")}): read as failure_handling in any run ${n(loose, (r) => r.inAnyRun.failure_handling)} of ${loose.length}`,
    `main line's misses: sent to failure_propagation or the default in any run ${n(main, (r) => r.inAnyRun.failure_propagation || r.defaultInAnyRun)}, read as check_before_action in any run ${n(main, (r) => r.inAnyRun.check_before_action)}`,
  ];
}

const frac = (a: number, b: number) => (b === 0 ? "–" : `${a}/${b}`);

/** The Markdown the documentation quotes: classes by author, the lines, the main line by repository, and every sentence. */
export function renderTables3(sentences: readonly Sentence3[], log: Log3, offered: readonly Label3[], now?: Log3): string {
  const all = rows3(sentences, log, offered);
  const nowRows = now ? rows3(sentences.filter((s) => s.origin.kind !== "written-85"), now, LABELS_NOW) : undefined;
  const runs = log.conditions.runsPerSentence;
  const out: string[] = [];
  out.push(`| label | who wrote it | sentences | read as its label in ${runs}/${runs} | as check in any run | as failure_handling in any run | neither / under the bar in any run | keyword rule right |`);
  out.push("|---|---|---|---|---|---|---|---|");
  const line = (label: Label3, who: string, rs: Row3[]) =>
    `| ${label} | ${who} | ${rs.length} | ${frac(rs.filter((r) => r.rightEveryRun).length, rs.length)} | ${frac(rs.filter((r) => r.inAnyRun.check_before_action).length, rs.length)} | ${frac(rs.filter((r) => r.inAnyRun.failure_handling).length, rs.length)} | ${frac(rs.filter((r) => r.defaultInAnyRun).length, rs.length)} | ${frac(rs.filter((r) => r.keyword === r.label).length, rs.length)} |`;
  for (const label of LABELS3) {
    const whole = all.filter((r) => r.label === label);
    if (whole.length === 0) continue;
    out.push(line(label, "all", whole));
    for (const kinds of [["tool"], ["model"], ["text", "written"], ["written-85"]] as Kind3[][]) {
      const part = whole.filter((r) => kinds.includes(r.kind));
      if (part.length > 0 && part.length < whole.length) out.push(line(label, kinds.join(" + "), part));
    }
  }
  out.push("");
  for (const l of barLines3(all, nowRows)) out.push(`- ${l}`);
  for (const l of recordLines3(all)) out.push(`- (record) ${l}`);
  const missing = all.filter((r) => r.readings.length < runs);
  if (missing.length > 0) out.push(`- not fully measured: ${missing.map((r) => r.id).join(", ")}`);
  out.push("");
  const main = all.filter((r) => r.kind === "written-85" && r.truth === "handles_locally");
  const byRepo = new Map<string, Row3[]>();
  for (const r of main) byRepo.set(r.repo ?? "?", [...(byRepo.get(r.repo ?? "?") ?? []), r]);
  out.push(`| repository (main line) | pull requests | read as failure_handling in ${runs}/${runs} |`);
  out.push("|---|---|---|");
  for (const [repo, rs] of [...byRepo].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) out.push(`| ${repo} | ${rs.length} | ${rs.filter((r) => r.rightEveryRun).length} |`);
  out.push("");
  const cols = Array.from({ length: runs }, (_, i) => i);
  out.push(`| sentence | label | who wrote it | fixed code | ${cols.map((i) => `run ${i + 1}`).join(" | ")} | keyword |${nowRows ? " same day, question sent now |" : ""}`);
  out.push(`|---|---|---|---|${cols.map(() => "---|").join("")}---|${nowRows ? "---|" : ""}`);
  const nowById = new Map(nowRows?.map((r) => [r.id, r]));
  for (const r of all) {
    const cells = cols.map((i) => (r.readings[i] === undefined ? "–" : `${r.readings[i]} ${r.probabilities[i]!.toFixed(2)}`));
    const n = nowById.get(r.id);
    out.push(`| ${r.id} | ${r.label}${r.strictFailure ? " (goes back)" : ""} | ${r.kind} | ${r.truth ?? ""} | ${cells.join(" | ")} | ${r.keyword} |${nowRows ? ` ${n ? n.readings.join(", ") : ""} |` : ""}`);
  }
  return `${out.join("\n")}\n`;
}
