// The adjudication of #88 (bench/eval/BASELINE.md, "Adjudication"): the findings on a correct version
// (`shipped`, `rewrite-*`) that are neither a hit nor a known target are put into one sentence each by a
// rewriter, then labelled by three annotators who may read that version's source. Two of three decide;
// three different labels make `cannot_decide`, which is never counted false.
//
// The prompts below are fixed before the sealed set is opened: `run.ts` puts this file's sha256 in the
// opening line and refuses a run whose file differs.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RequirementRun, Target } from "../acceptance/score.ts";
import { EFFORT, MODEL, type Finding } from "./baseline.ts";
import { names } from "./compare.ts";
import type { Answer } from "./retro/prompts.ts";

export const ADJUDICATION_VERSION = 1;
export const LABELS = ["real_defect", "false", "duplicate", "cannot_decide"] as const;
export type AdjLabel = (typeof LABELS)[number];
/** The tools an annotator may use: reading the version's source, nothing else. */
export const ANNOTATOR_TOOLS = "Read,Grep,Glob";

export const REWRITE_SYSTEM = [
  "You rewrite review findings into one sentence each, all in the same shape, so that nobody can tell who wrote them.",
  'Each sentence is: "In `FUNCTION` of `FILE`, when `CALL` fails, WHAT HAPPENS." Keep the function, file and call as given. Say what happens in plain words, in at most 25 words, from the finding\'s own claim; do not add a judgment of your own.',
  'Answer only with a JSON array of objects {"n": number, "sentence": string}, one for every finding, in the order given.',
].join(" ");

export const ANNOTATE_SYSTEM = [
  "You check review findings about a Rust repository against one requirement. The repository's source at the version under review is in your working directory; read it with your tools.",
  "Label each numbered sentence: real_defect (the code at this version fails the requirement at that call as the sentence says), false (it does not: the failure reaches the caller as the requirement asks, or the call cannot fail as described), duplicate (it describes the same defect as an earlier sentence), or cannot_decide (the source does not settle it).",
  'Answer only with a JSON array of objects {"n": number, "label": "real_defect" | "false" | "duplicate" | "cannot_decide"}, one for every sentence.',
].join(" ");

export const rewriteRequest = (items: readonly { n: number; file: string; function: string; call: string; claim: string }[]) =>
  `Findings:\n${items.map((i) => `${i.n}. file: ${i.file}; function: ${i.function}; call: ${i.call}; claim: ${i.claim}`).join("\n")}`;

export const annotateRequest = (requirement: string, sentences: readonly { n: number; sentence: string }[]) =>
  `Requirement: ${requirement}\n\nSentences:\n${sentences.map((s) => `${s.n}. ${s.sentence}`).join("\n")}`;

/** One finding to adjudicate, and which systems made it. The systems never reach the rewriter or an annotator. */
export interface Item {
  n: number;
  file: string;
  function: string;
  call: string;
  claim: string;
  by: ("jev" | "baseline")[];
}

const collapse = (s: string) => s.replace(/\s+/g, "");
const keyOf = (f: { file: string; function: string; call: string }) => `${f.file.replace(/^(?:\.\/|[ab]\/)/, "")}\0${f.function.split("::").at(-1)!.trim()}\0${collapse(f.call)}`;

/**
 * The findings of a correct version that need a label: of jev's top five and the baseline's five, in the
 * first three counted runs of each, those that name no known target of the version. One item per call,
 * whichever system made it; the systems stay with the item, not with what is sent.
 */
export function itemsOf(targets: readonly Target[], jevRuns: readonly (readonly (RequirementRun["findings"][number] & { observation?: string })[])[], baselineRuns: readonly (readonly Finding[])[]): Item[] {
  const byKey = new Map<string, Item>();
  const add = (f: { file: string; function: string; call: string }, claim: string, by: "jev" | "baseline") => {
    if (targets.some((t) => names(f, t))) return; // a known target: false already, no label needed
    const k = keyOf(f);
    const had = byKey.get(k);
    if (had) {
      if (!had.by.includes(by)) had.by.push(by);
      if (had.claim === "" && claim !== "") had.claim = claim;
      return;
    }
    byKey.set(k, { n: byKey.size + 1, file: f.file, function: f.function, call: f.call, claim, by: [by] });
  };
  for (const run of jevRuns) for (const f of run) add(f, f.observation ?? "", "jev");
  for (const run of baselineRuns) for (const f of run) add(f, f.claim, "baseline");
  return [...byKey.values()];
}

/** Two of three labels decide; three different make `cannot_decide`. */
export function majority(labels: readonly AdjLabel[]): AdjLabel {
  const counts = new Map<AdjLabel, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top !== undefined && top[1] >= 2 ? top[0] : "cannot_decide";
}

/** The sentences a rewriter answered, one for every item, or null. */
export function readSentences(json: unknown, items: readonly Item[]): { n: number; sentence: string }[] | null {
  if (!Array.isArray(json)) return null;
  const out = json.filter((x) => typeof x?.n === "number" && typeof x?.sentence === "string").map((x) => ({ n: x.n as number, sentence: x.sentence as string }));
  return items.every((i) => out.filter((o) => o.n === i.n).length === 1) && out.length === items.length ? items.map((i) => out.find((o) => o.n === i.n)!) : null;
}

/** The labels an annotator answered, one for every item, or null. */
export function readLabels(json: unknown, items: readonly Item[]): Map<number, AdjLabel> | null {
  if (!Array.isArray(json)) return null;
  const out = new Map<number, AdjLabel>();
  for (const x of json) {
    if (typeof x?.n !== "number" || !(LABELS as readonly string[]).includes(x?.label) || out.has(x.n)) return null;
    out.set(x.n, x.label as AdjLabel);
  }
  return items.every((i) => out.has(i.n)) && out.size === items.length ? out : null;
}

// ---------------------------------------------------------------------------------------------
// Running them.

/** An annotator's command line: the baseline's, with the tools to read the source and nothing else. */
export function annotatorArgs(request: string, system: string, tools: string): string[] {
  return ["-p", request, "--model", MODEL, "--effort", EFFORT, "--tools", tools, "--strict-mcp-config", "--system-prompt", system, "--setting-sources", "project", "--no-session-persistence", "--output-format", "json"];
}

/**
 * A copy of the version's source for the annotators to read: `git archive` of `head` (no `.git`), with
 * every `.claude/`, `CLAUDE.md` and `CLAUDE.local.md` at any depth removed, in a fresh directory under the
 * system's temporary directory. Nothing above it may hold a repository or settings either.
 */
export function sourceCopy(clone: string, head: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-adjudicate-"));
  execFileSync("sh", ["-c", `git -C "$1" archive --format=tar "$2" | tar -x -C "$3"`, "sh", clone, head, dir], { stdio: ["ignore", "ignore", "pipe"] });
  const strip = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      // A link could point outside the copy, where the sandbox and the logs are: none is kept.
      if (e.isSymbolicLink()) rmSync(p, { force: true });
      else if (e.isDirectory() && e.name === ".claude") rmSync(p, { recursive: true, force: true });
      else if (!e.isDirectory() && (e.name === "CLAUDE.md" || e.name === "CLAUDE.local.md")) rmSync(p, { force: true });
      else if (e.isDirectory() && !e.isSymbolicLink()) strip(p);
    }
  };
  strip(dir);
  assertNoSettings(dir);
  return dir;
}

/** What `sourceCopy` guarantees, checked: no settings in the copy, none above it. */
export function assertNoSettings(dir: string): void {
  const inside = (d: string): string | null => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink() || e.name === ".git" || e.name === ".claude" || e.name === "CLAUDE.md" || e.name === "CLAUDE.local.md") return p;
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const hit = inside(p);
        if (hit) return hit;
      }
    }
    return null;
  };
  const found = inside(dir);
  if (found) throw new Error(`the source copy holds ${found}, which would reach the annotators`);
  for (let d = resolve(dir); dirname(d) !== d; d = dirname(d)) {
    const up = dirname(d);
    for (const n of [".git", ".claude", "CLAUDE.md"]) if (existsSync(join(up, n)) && (n !== ".claude" || statSync(join(up, n)).isDirectory())) throw new Error(`the source copy is under ${up}, which holds ${n}`);
  }
}

/**
 * The JSON in an answer: the first fenced block, or else the text from the first `[` or `{` to the last
 * `]` or `}`. An annotator that may read the source often explains its label after the block (the
 * rehearsal on dev row 53 did, every time), which a parse of the whole answer rejects.
 */
export function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text.trim(), text.slice(Math.min(...["[", "{"].map((c) => (text.indexOf(c) === -1 ? Infinity : text.indexOf(c)))), Math.max(text.lastIndexOf("]"), text.lastIndexOf("}")) + 1)];
  for (const c of candidates) {
    if (c === undefined || c.trim() === "") continue;
    try {
      return JSON.parse(c.trim());
    } catch {
      // the next reading
    }
  }
  return undefined;
}

/** What `claude -p --output-format json` printed, read into an answer: the model, then the JSON it gave. */
export function readAnswerJson(stdout: string, sent: Answer["sent"]): Answer {
  let j: { result?: string; is_error?: boolean; modelUsage?: Record<string, unknown> };
  try {
    j = JSON.parse(stdout);
  } catch {
    return { counted: false, why: "the output was not JSON", sent, model: [] };
  }
  const model = Object.keys(j.modelUsage ?? {}).sort();
  if (model.length !== 1 || model[0] !== MODEL) return { counted: false, why: `answered by ${model.join(", ") || "no model"}, not ${MODEL}`, sent, model };
  if (j.is_error === true || typeof j.result !== "string") return { counted: false, why: "the run ended in an error", sent, model };
  const json = jsonIn(j.result);
  return json === undefined ? { counted: false, why: "the answer held no JSON", sent, model } : { counted: true, json, sent, model };
}

/** One `claude -p` with `tools` in `cwd`. */
export function ask(system: string, request: string, cwd: string, tools: string): Answer {
  const sent = { system, request, bytes: Buffer.byteLength(system) + Buffer.byteLength(request) };
  const r = spawnSync("claude", annotatorArgs(request, system, tools), { cwd, encoding: "utf8", input: "", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
  if (r.status !== 0) return { counted: false, why: `claude exited ${r.status}`, sent, model: [] };
  return readAnswerJson(r.stdout, sent);
}

/** Runs one step takes at most, whatever `fail` does: a step that never answers stops here too. */
export const MAX_ATTEMPTS = 5;

export interface VersionAdjudication {
  items: Item[];
  sentences: { n: number; sentence: string }[];
  labels: AdjLabel[][];
  decided: Record<number, AdjLabel>;
  runs: { role: "rewriter" | "annotator"; counted: boolean; why?: string }[];
}

/** Thrown when a run could not be counted as many times as the stop rule allows. */
export class StopRun extends Error {}

/**
 * One version adjudicated: a rewriter with no tools in `empty`, then three annotators in a copy of the
 * source. A run that cannot be counted is taken again; `fail` is told of each such run and throws when
 * the stop rule is met.
 */
export function adjudicate(items: readonly Item[], requirement: string, clone: string, head: string, empty: string, fail: (why: string) => void, deps: { ask: typeof ask; sourceCopy: typeof sourceCopy } = { ask, sourceCopy }): VersionAdjudication {
  const out: VersionAdjudication = { items: [...items], sentences: [], labels: [], decided: {}, runs: [] };
  if (items.length === 0) return out;
  for (let attempt = 1; ; attempt++) {
    if (attempt > MAX_ATTEMPTS) throw new StopRun(`the rewriter gave no readable answer in ${MAX_ATTEMPTS} runs`);
    const a = deps.ask(REWRITE_SYSTEM, rewriteRequest(items), empty, "");
    const s = a.counted ? readSentences(a.json, items) : null;
    out.runs.push({ role: "rewriter", counted: s !== null, ...(s === null ? { why: a.why ?? "the answer was not one sentence for every finding" } : {}) });
    if (s !== null) {
      out.sentences = s;
      break;
    }
    fail(out.runs.at(-1)!.why!);
  }
  const src = deps.sourceCopy(clone, head);
  try {
    let attempts = 0;
    while (out.labels.length < 3) {
      if (++attempts > 3 + MAX_ATTEMPTS) throw new StopRun(`the annotators gave no readable answer in ${attempts - 1} runs`);
      const a = deps.ask(ANNOTATE_SYSTEM, annotateRequest(requirement, out.sentences), src, ANNOTATOR_TOOLS);
      const l = a.counted ? readLabels(a.json, items) : null;
      out.runs.push({ role: "annotator", counted: l !== null, ...(l === null ? { why: a.why ?? "the answer was not one label for every sentence" } : {}) });
      if (l === null) {
        fail(out.runs.at(-1)!.why!);
        continue;
      }
      out.labels.push(items.map((i) => l.get(i.n)!));
    }
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
  items.forEach((it, k) => (out.decided[it.n] = majority(out.labels.map((ls) => ls[k]!))));
  return out;
}

