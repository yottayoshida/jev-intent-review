// The annotators of the retrospective measurement (#89, bench/eval/RETRO.md), and how each is asked.
//
// Every annotator is `claude -p` as the baseline of #88 runs (`baseline.ts`, `claudeArgs`): no tools,
// no MCP server, no user settings, a fixed system prompt, in an empty directory that is not a
// repository. What it is given is built here from named fields only, and the bytes sent are recorded,
// so what an annotator saw can be checked against what it was allowed to see.
//
// These texts are committed before any case is written. Changing one is a new version of RETRO.md.

import { spawnSync } from "node:child_process";
import { assertEmptyDir, claudeArgs, MODEL } from "../baseline.ts";
import { BUNDLE_FIELDS, type Bundle } from "./material.ts";

export const PROMPTS_VERSION = 1;

/** The most items a written requirement may have: more items, more chances for one to be listed. */
export const MAX_ITEMS = 3;

export const WRITE_SYSTEM = [
  "You read what a software team wrote about one pull request before it was merged: its title, description, review comments and the issues it said it addressed.",
  "Write the requirements that this material states about how the changed code must behave when an operation it performs fails.",
  `Write at most ${MAX_ITEMS} items. Each item is one sentence a reviewer could check against code, and each item quotes, word for word, the sentence of the material it rests on.`,
  "Use only what the material says. Do not add requirements that are merely good practice, and do not generalise beyond what a quoted sentence says.",
  "If the material says nothing about what must happen when something fails, answer that no requirement can be written.",
  'Answer with JSON only: {"requirements":[{"text":"...","quote":"..."}]} or {"requirements":[],"why":"..."}.',
].join("\n");

export const CHECK_SYSTEM = [
  "You are given material a team wrote before a pull request merged, a later pull request that fixed a defect the first one left, and requirements someone wrote from the first material alone.",
  "Find every word or claim in the requirements that is not supported by the earlier material and could only be known from the later fix: a function, a path, a condition, an error or a behaviour that the earlier material does not mention.",
  "A requirement that is a plain reading of a quoted sentence of the earlier material is not leaked, even when the later fix is about the same thing.",
  'Answer with JSON only: {"leaked":[{"requirement":1,"words":"...","found_in_fix":"..."}]}, with an empty list when nothing is leaked.',
].join("\n");

/** Writes requirements that use what the fix reveals: the planted cases of the check's calibration. */
export const LEAK_SYSTEM = [
  "You are given material a team wrote before a pull request merged, and a later pull request that fixed a defect the first one left.",
  `Write at most ${MAX_ITEMS} requirements for the first pull request that would have caught the defect the later fix fixed. Use what the fix shows — the function, the failing call, the condition — even where the earlier material does not say it. Quote a sentence of the earlier material for each, as if it were the source.`,
  'Answer with JSON only: {"requirements":[{"text":"...","quote":"..."}]}.',
].join("\n");

export const CAUGHT_SYSTEM = [
  "You are given the review comments, bot reviews and check results a pull request had before it merged, and a description of a defect found later.",
  "Say whether any of them pointed at that defect before the merge: the failing call, or what happens when it fails, in the code the defect is in. A general remark about error handling elsewhere does not count.",
  'Answer with JSON only: {"caught":true|false,"quote":"..."}.',
].join("\n");

export interface Requirement {
  text: string;
  quote: string;
}

/** The later fix, as the check and the planted cases are shown it. Never given to the writer. */
export interface Fix {
  ref: string;
  title: string;
  body: string;
  diff: string;
}

/** Only the bundle's own fields, in a fixed order: nothing else can ride along to the writer. */
function bundleText(bundle: Bundle): string {
  const extra = Object.keys(bundle).filter((k) => !(BUNDLE_FIELDS as readonly string[]).includes(k));
  if (extra.length > 0) throw new Error(`the bundle has fields the writer may not see: ${extra.join(", ")}`);
  return JSON.stringify(Object.fromEntries(BUNDLE_FIELDS.map((k) => [k, bundle[k]])), null, 2);
}

export const writeRequest = (bundle: Bundle) => `Material written before the merge:\n\n${bundleText(bundle)}`;

export const checkRequest = (bundle: Bundle, fix: Fix, requirements: readonly Requirement[]) =>
  `Earlier material:\n\n${bundleText(bundle)}\n\nLater fix ${fix.ref}: ${fix.title}\n\n${fix.body}\n\n${fix.diff}\n\nRequirements written from the earlier material:\n\n${JSON.stringify(requirements, null, 2)}`;

export const leakRequest = (bundle: Bundle, fix: Fix) => `Earlier material:\n\n${bundleText(bundle)}\n\nLater fix ${fix.ref}: ${fix.title}\n\n${fix.body}\n\n${fix.diff}`;

export const caughtRequest = (reviews: readonly string[], checks: readonly string[], defect: string) =>
  `Before the merge — reviews and comments:\n\n${JSON.stringify(reviews, null, 2)}\n\nChecks:\n\n${JSON.stringify(checks, null, 2)}\n\nThe defect found later:\n\n${defect}`;

const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();

/** Every text of the bundle, as the writer read it. */
function bundleWords(bundle: Bundle): string {
  const p = bundle.pull;
  return squeeze([p.title, p.body, ...p.comments, ...p.reviews, ...bundle.issues.flatMap((i) => [i.title, i.body, ...i.comments])].join("\n"));
}

/**
 * The writer's answer, held to what it was told: at most `MAX_ITEMS` items, each with a quote that is
 * in the bundle word for word (whitespace aside). `none` is the writer saying no requirement can be
 * written; `invalid` is an answer that breaks the rules, and the case is not written either.
 */
export function acceptRequirements(json: unknown, bundle: Bundle): { requirements: Requirement[] } | { none: string } | { invalid: string } {
  const r = (json as { requirements?: unknown; why?: unknown } | null)?.requirements;
  if (!Array.isArray(r)) return { invalid: "no list of requirements" };
  if (r.length === 0) return { none: typeof (json as { why?: unknown }).why === "string" ? (json as { why: string }).why : "no reason given" };
  if (r.length > MAX_ITEMS) return { invalid: `${r.length} items, more than ${MAX_ITEMS}` };
  const words = bundleWords(bundle);
  const out: Requirement[] = [];
  for (const [i, item] of r.entries()) {
    const { text, quote } = (item ?? {}) as { text?: unknown; quote?: unknown };
    if (typeof text !== "string" || text.trim() === "" || typeof quote !== "string" || quote.trim() === "") return { invalid: `item ${i + 1} lacks a text or a quote` };
    if (!words.includes(squeeze(quote))) return { invalid: `item ${i + 1} quotes words that are not in the material` };
    out.push({ text: text.trim(), quote });
  }
  return { requirements: out };
}

export interface Answer {
  counted: boolean;
  why?: string;
  /** The JSON the annotator answered, when it was JSON. */
  json?: unknown;
  /** What was sent: the system prompt and the request, byte for byte, to check what it saw. */
  sent: { system: string; request: string; bytes: number };
  model: string[];
}

/** What `claude -p --output-format json` printed, as one annotator's answer. */
export function readAnswer(stdout: string, sent: Answer["sent"]): Answer {
  let j: { result?: string; is_error?: boolean; modelUsage?: Record<string, unknown> };
  try {
    j = JSON.parse(stdout);
  } catch {
    return { counted: false, why: "the output was not JSON", sent, model: [] };
  }
  const model = Object.keys(j.modelUsage ?? {}).sort();
  if (model.length !== 1 || model[0] !== MODEL) return { counted: false, why: `answered by ${model.join(", ") || "no model"}, not ${MODEL}`, sent, model };
  if (j.is_error === true || typeof j.result !== "string") return { counted: false, why: "the run ended in an error", sent, model };
  const body = j.result.trim().replace(/^```(?:json)?\s*/, "").replace(/```$/, "").trim();
  try {
    return { counted: true, json: JSON.parse(body), sent, model };
  } catch {
    return { counted: false, why: "the answer was not JSON", sent, model };
  }
}

/** One annotator, once, in the empty directory `cwd`. */
export function annotate(system: string, request: string, cwd: string): Answer {
  assertEmptyDir(cwd);
  const sent = { system, request, bytes: Buffer.byteLength(system) + Buffer.byteLength(request) };
  const r = spawnSync("claude", claudeArgs(request, system), { cwd, encoding: "utf8", input: "", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
  if (r.status !== 0) return { counted: false, why: `claude exited ${r.status}`, sent, model: [] };
  return readAnswer(r.stdout, sent);
}
