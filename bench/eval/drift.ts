// Jev's drift on the dev set, measured against its own run-to-run and day-to-day variation (#87).
// The rule is bench/eval/drift/README.md; this file is what it describes.
//
//   node bench/eval/drift.ts capture <clones>                  freeze the dev set's questions; sends nothing
//   node bench/eval/drift.ts baseline --batch <day> --runs <n> send every frozen pair n times, one after another
//   node bench/eval/drift.ts replay <clones>                   send them once more and compare, in one command
//   node bench/eval/drift.ts compare <replay file>             the comparison of a replay already sent
//
// `<clones>` holds one clone per case, named by the case id, as `bench/eval/run.ts --set dev measure`
// takes them. What is frozen is what the tool would send, taken by running it with a provider that
// answers every question itself: the tool asks the same calls whatever the answers are (the places are
// chosen by the budget first, and a call's observation is asked whatever its mapping said), so nothing
// is sent to take it, a failing request cannot drop a pair, and a replay can take it again to see
// whether the tool still asks what was frozen.
//
// Only the dev side of split.json is read here. Sending a sealed case's questions again is a sealed
// evaluation, and goes through `bench/eval/run.ts --set sealed open`; nothing here reads a sealed case.

import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "../acceptance/replay.ts";
import type { Split } from "./split.ts";
import { main, type Deps } from "../../src/cli/main.ts";
import { JevClient, endpointFromEnv, modelIdentityOf, type Host, type ModelIdentity } from "../../src/judgments/client.ts";
import { JevProvider } from "../../src/judgments/jev.ts";
import type { JudgmentProvider, Questions } from "../../src/judgments/provider.ts";
import { QUESTIONS_HASH } from "../../src/judgments/questions.ts";
import { BAR } from "../../src/plan/local-check.ts";
import { FORM_QUESTION, FORMS } from "../../src/plan/forms.ts";
import { MAPPING_BAR } from "../../src/plan/mapping.ts";
import { outcomeOf, type Outcome } from "../../src/review/outcome.ts";
import type { ChoiceAnswer, RequirementForm } from "../../src/types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIR = join(HERE, "drift");
export const PACKETS = join(DIR, "packets-v1.jsonl");
export const MANIFEST = join(DIR, "packets-v1.manifest.json");
export const BASELINE = join(DIR, "baseline-v1.json");

/** The rule's floor: fewer batches (days) or fewer runs in one of them, and there is no verdict. */
export const RULE = { minBatches: 2, minRunsPerBatch: 5, host: "cloudflare" as Host } as const;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// ---- Freezing ----------------------------------------------------------------------------------

/** One call's two requests: the mapping and the observation, on the same state. */
export interface Pair {
  id: string;
  form: RequirementForm;
  state: unknown;
  mapping: Questions;
  observation: Questions;
  /** Where the tool asked it: case and version. One pair can be asked by several. */
  askedBy: string[];
}

interface Sent {
  state: unknown;
  questions: Questions;
}

const MAPPING_KEY = "requirement_governs";
const FORM_KEY = Object.keys(FORM_QUESTION)[0]!;
const formByObservation = new Map(Object.values(FORMS).map((f) => [f.observationKey, f.name]));

/**
 * The pairs in the order the tool sent them. A mapping waits for the next observation on the same
 * state; the form question is skipped, and anything else left over is counted as unpaired.
 * The tool sends a call's two requests one after the other and asks no two calls at once, so the
 * observation that follows a mapping on its state is that call's.
 */
export function pairsFrom(sent: readonly Sent[], where: string): { pairs: Pair[]; unpaired: number } {
  const waiting = new Map<string, Questions>();
  const pairs: Pair[] = [];
  let unpaired = 0;
  for (const { state, questions } of sent) {
    // The form question is about the requirement's sentence, not a call: asked at most once per requirement.
    if (Object.hasOwn(questions, FORM_KEY)) continue;
    const key = JSON.stringify(state);
    if (Object.hasOwn(questions, MAPPING_KEY)) {
      if (waiting.has(key)) unpaired += 1;
      waiting.set(key, questions);
      continue;
    }
    const form = Object.keys(questions).map((k) => formByObservation.get(k)).find((f) => f !== undefined);
    const mapping = waiting.get(key);
    if (form === undefined || mapping === undefined) {
      unpaired += 1;
      continue;
    }
    waiting.delete(key);
    pairs.push({ id: sha256(JSON.stringify([state, mapping, questions])), form, state, mapping, observation: questions, askedBy: [where] });
  }
  return { pairs, unpaired: unpaired + waiting.size };
}

/** A provider that answers every question with its first option, and keeps what it was asked. */
export class Recorder implements JudgmentProvider {
  readonly model = "none: the questions are recorded, not sent";
  readonly sent: Sent[] = [];
  async judge(state: unknown, questions: Questions): Promise<Record<string, ChoiceAnswer>> {
    this.sent.push({ state: structuredClone(state), questions: structuredClone(questions) });
    return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { choice: Object.keys(q.criteria)[0]!, probability: 0.5, probabilities: {} }]));
  }
}

interface LiveCase {
  id: string;
  repo: string;
  versions: { id: string; base: string; head: string }[];
}

const caseRepo = (repo: string) => repo.replace(/^https:\/\/github\.com\//, "").toLowerCase();

/** The dev cases with a version the tool sends for; a case on the sealed side stops the capture. */
export function devCases(split: Split, cases = loadCases()): LiveCase[] {
  const side = new Map(split.repos.map((r) => [r.repo, r.side]));
  const out: LiveCase[] = [];
  for (const c of cases as (typeof cases[number] & { repo: string; precheck?: Record<string, { live?: boolean }> })[]) {
    const repo = caseRepo(c.repo);
    if (side.get(repo) !== "dev") throw new Error(`${c.id} (${repo}) is not on the dev side of split.json`);
    const versions = Object.entries(c.versions)
      .filter(([v]) => c.precheck?.[v]?.live === true)
      .map(([id, v]) => ({ id, base: v.base, head: v.head }));
    if (versions.length > 0) out.push({ id: c.id, repo, versions });
  }
  return out;
}

/** Runs the tool over every live dev version with the recorder, and returns the pairs, merged. */
export async function capture(clones: string, cases: readonly LiveCase[], run: typeof main = main): Promise<{ pairs: Pair[]; unpaired: number; missing: string[] }> {
  const byId = new Map<string, Pair>();
  let unpaired = 0;
  const missing: string[] = [];
  for (const c of cases) {
    const clone = join(clones, c.id);
    if (!existsSync(clone)) {
      missing.push(c.id);
      continue;
    }
    for (const v of c.versions) {
      const recorder = new Recorder();
      // `--answers` is never passed: a kept answer would stop a question before it reached the recorder.
      const deps: Deps = { judges: () => ({ provider: recorder, sent: () => ({ requests: recorder.sent.length, bytes: 0 }), origin: "recorder" }) };
      const env = { CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), CLOUDFLARE_API_TOKEN: "recorder-sends-nothing", PATH: process.env.PATH ?? "" };
      const args = ["--skip-change-check", "--base", v.base, "--head", v.head, "--intent-spec", join(HERE, "..", "acceptance", "cases", c.id, "spec.json"), "--json"];
      const code = await run(args, { stdout: () => {}, stderr: () => {}, cwd: clone, env }, deps);
      if (code !== 0 && code !== 1) throw new Error(`${c.id} ${v.id}: the tool exited ${code} while recording`);
      const found = pairsFrom(recorder.sent, `${c.id}/${v.id}`);
      unpaired += found.unpaired;
      for (const p of found.pairs) {
        const had = byId.get(p.id);
        if (had) had.askedBy.push(...p.askedBy);
        else byId.set(p.id, p);
      }
    }
  }
  return { pairs: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), unpaired, missing };
}

export interface Manifest {
  version: 1;
  capturedAt: string;
  toolCommit: string;
  questionsHash: string;
  split: string;
  pairs: number;
  /** The pairs each case's versions asked: a pair asked by two cases counts in both. */
  byCase: Record<string, number>;
  packets: string;
}

export function readFrozen(): { manifest: Manifest; pairs: Pair[] } {
  if (!existsSync(PACKETS) || !existsSync(MANIFEST)) throw new Error(`nothing is frozen yet: run \`drift.ts capture <clones>\` first (${relative(ROOT, PACKETS)})`);
  const text = readFileSync(PACKETS, "utf8");
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  if (sha256(text) !== manifest.packets) throw new Error(`${relative(ROOT, PACKETS)} is not the file its manifest names`);
  return { manifest, pairs: text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Pair) };
}

// ---- Sending -----------------------------------------------------------------------------------

export interface PairAnswer {
  mapping?: { choice: string; probability: number };
  observation?: { choice: string; probability: number };
  /** The rule's reading of the two, or `error` when a request failed. */
  outcome: Outcome | "error";
}

export interface Run {
  batch: string;
  at: string;
  order: string[];
  answers: Record<string, PairAnswer>;
  modelIdentity: ModelIdentity;
}

const reading = (a: ChoiceAnswer | undefined) => (a === undefined ? undefined : { choice: a.choice, probability: a.probabilities[a.choice] ?? a.probability });

/** The rule applied to one pair's answers, as the local check applies it to a call. */
export function outcomeOfPair(form: RequirementForm, mapping: ChoiceAnswer | undefined, observation: ChoiceAnswer | undefined): Outcome {
  const f = FORMS[form];
  return outcomeOf(reading(mapping), reading(observation), f, { mapping: MAPPING_BAR, observation: BAR });
}

/**
 * One run: every pair once, in a shuffled order, one request at a time — the same question is never
 * in flight twice, so a host that answers a repeat from a cache has to do it across runs.
 */
export async function sendRun(pairs: readonly Pair[], judge: JudgmentProvider, batch: string, identity: () => ModelIdentity, shuffle: <T>(xs: T[]) => T[] = shuffled): Promise<Run> {
  const at = new Date().toISOString();
  const order = shuffle(pairs.map((p) => p.id));
  const byId = new Map(pairs.map((p) => [p.id, p]));
  const answers: Record<string, PairAnswer> = {};
  for (const id of order) {
    const p = byId.get(id)!;
    try {
      const m = (await judge.judge(p.state, p.mapping))[MAPPING_KEY];
      const o = (await judge.judge(p.state, p.observation))[FORMS[p.form].observationKey];
      answers[id] = { ...(m ? { mapping: reading(m) } : {}), ...(o ? { observation: reading(o) } : {}), outcome: outcomeOfPair(p.form, m, o) };
    } catch {
      answers[id] = { outcome: "error" };
    }
  }
  return { batch, at, order, answers, modelIdentity: identity() };
}

function shuffled<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---- Comparing ---------------------------------------------------------------------------------

/** The most frequent outcome among `runs` for a pair, errors aside; a tie, or none, is `unknown`. */
export function modal(runs: readonly Run[], id: string): Outcome | undefined {
  const counts = new Map<Outcome, number>();
  for (const r of runs) {
    const o = r.answers[id]?.outcome;
    if (o !== undefined && o !== "error") counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const top = Math.max(...counts.values());
  const at = [...counts].filter(([, n]) => n === top);
  return at.length === 1 ? at[0]![0] : "unknown";
}

/** D: the share of pairs whose outcome in `run` differs from the modal outcome of `others`. */
export function distance(run: Run, others: readonly Run[], ids: readonly string[]): number {
  let n = 0;
  let differ = 0;
  for (const id of ids) {
    const mine = run.answers[id]?.outcome;
    const theirs = modal(others, id);
    if (mine === undefined || mine === "error" || theirs === undefined) continue;
    n += 1;
    if (mine !== theirs) differ += 1;
  }
  return n === 0 ? 0 : differ / n;
}

export interface Comparison {
  verdict: "drift" | "no_drift" | "underpowered";
  why: string;
  pairs: number;
  repositories: string[];
  replay: number;
  /**
   * The largest D of a baseline run against every other run, the replay included. The others of a
   * run are more than half the other days', so this already holds the difference between days.
   */
  runToRun: number;
  /** Reported, not judged: the largest D of a baseline run against the runs of the other days alone. */
  dayToDay: number;
  /** Reported, not judged: moves that are not the outcome. */
  moves: { mappingChoice: number; observationChoice: number; mappingSide: number; observationSide: number; meanProbabilityShift: number; errors: number };
  versions: { baseline: string[]; replay: string[]; changed: boolean };
  /** Whether the tool still asks what was frozen: pairs it asks now that are not frozen, and the reverse. */
  frozenVsTool?: { added: number; removed: number };
  baselineVariation: "none observed" | "observed";
}

/** The UTC date a batch began on: its earliest run's. */
export const batchDay = (runs: readonly Run[]) => runs.map((r) => r.at).sort()[0]!.slice(0, 10);

const versionsOf = (runs: readonly Run[]) => [...new Set(runs.flatMap((r) => r.modelIdentity.returned.map((v) => v.model)))].sort();

/**
 * The rule (bench/eval/drift/README.md): drift when the replay's D is larger than every baseline
 * run's D against all the other runs — the other days' among them. No false-alarm
 * rate is claimed: the runs of one day are not exchangeable with a later one, so a rank among them
 * does not bound it.
 */
export function compare(taken: readonly Run[], replay: Run, pairs: readonly Pair[], frozenVsTool?: { added: number; removed: number }): Comparison {
  const ids = pairs.map((p) => p.id);
  // A run with a failed pair measured less than every pair: it is left out, and not counted toward the floor.
  const complete = (r: Run) => ids.every((id) => r.answers[id] !== undefined && r.answers[id]!.outcome !== "error");
  const baseline = taken.filter(complete);
  const all = [...baseline, replay];
  const batches = new Map<string, Run[]>();
  for (const r of baseline) batches.set(r.batch, [...(batches.get(r.batch) ?? []), r]);
  // Batches on different days: a batch's day is its first run's (a batch that runs past midnight stays
  // on the day it began), and a day that two batches share makes them one.
  const days = new Map<string, Set<string>>();
  for (const [name, runs] of batches) {
    const day = batchDay(runs);
    days.set(day, (days.get(day) ?? new Set()).add(name));
  }
  const sharedDay = [...days].find(([, b]) => b.size > 1)?.[0];
  const repositories = [...new Set(pairs.flatMap((p) => p.askedBy.map((w) => w.split("/")[0]!)))].sort();

  const replayD = distance(replay, baseline, ids);
  const runToRun = Math.max(0, ...baseline.map((r) => distance(r, all.filter((x) => x !== r), ids)));
  const dayToDay = Math.max(0, ...baseline.map((r) => distance(r, baseline.filter((x) => x.batch !== r.batch), ids)));
  const vb = versionsOf(baseline);
  const vr = versionsOf([replay]);
  const identical = ids.every((id) => {
    const seen = new Set(baseline.map((r) => JSON.stringify(r.answers[id] ?? null)));
    return seen.size <= 1;
  });

  const moves = { mappingChoice: 0, observationChoice: 0, mappingSide: 0, observationSide: 0, meanProbabilityShift: 0, errors: 0 };
  let shifts = 0;
  let shiftSum = 0;
  for (const id of ids) {
    const mine = replay.answers[id];
    if (!mine || mine.outcome === "error") {
      moves.errors += 1;
      continue;
    }
    for (const part of ["mapping", "observation"] as const) {
      const theirs = baseline.map((r) => r.answers[id]?.[part]).filter((x): x is { choice: string; probability: number } => x !== undefined);
      const own = mine[part];
      if (!own || theirs.length === 0) continue;
      const most = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]![0];
      const bar = part === "mapping" ? MAPPING_BAR : BAR;
      if (own.choice !== most(theirs.map((t) => t.choice))) moves[`${part}Choice`] += 1;
      if (String(own.probability >= bar) !== most(theirs.map((t) => String(t.probability >= bar)))) moves[`${part}Side`] += 1;
      const sorted = theirs.map((t) => t.probability).sort((a, b) => a - b);
      const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
      shiftSum += Math.abs(own.probability - median);
      shifts += 1;
    }
  }
  moves.meanProbabilityShift = shifts === 0 ? 0 : shiftSum / shifts;

  const base = {
    pairs: ids.length,
    repositories,
    replay: replayD,
    runToRun,
    dayToDay,
    moves,
    versions: { baseline: vb, replay: vr, changed: vr.some((v) => !vb.includes(v)) },
    ...(frozenVsTool ? { frozenVsTool } : {}),
    baselineVariation: identical ? ("none observed" as const) : ("observed" as const),
  };
  const short = [...batches.values()].filter((b) => b.length < RULE.minRunsPerBatch).length;
  const left = taken.length - baseline.length;
  if (ids.length === 0 || batches.size < RULE.minBatches || short > 0 || sharedDay !== undefined) {
    const shared = sharedDay === undefined ? "" : `; batches ${[...days.get(sharedDay)!].join(" and ")} were both taken on ${sharedDay}`;
    const failed = left === 0 ? "" : ` (${left} run(s) with a failed pair left out)`;
    return { verdict: "underpowered", why: `the baseline has ${batches.size} batch(es) with ${[...batches.values()].map((b) => b.length).join(", ") || "no"} complete run(s)${failed}${shared}; the rule needs ${RULE.minBatches} batches on different days with ${RULE.minRunsPerBatch} complete runs each`, ...base };
  }
  if (!complete(replay)) {
    return { verdict: "underpowered", why: `the replay has ${moves.errors} pair(s) that failed; a replay is judged only when every pair was answered`, ...base };
  }
  const drift = replayD > runToRun;
  return {
    verdict: drift ? "drift" : "no_drift",
    why: drift
      ? `the replay differs from the baseline on ${(replayD * 100).toFixed(1)}% of the pairs, more than any baseline run differs from all the others (${(runToRun * 100).toFixed(1)}%; from the other days alone ${(dayToDay * 100).toFixed(1)}%)`
      : `the replay differs on ${(replayD * 100).toFixed(1)}% of the pairs, within the baseline's own variation (runs ${(runToRun * 100).toFixed(1)}%, days ${(dayToDay * 100).toFixed(1)}%)`,
    ...base,
  };
}

// ---- The command -------------------------------------------------------------------------------

const readSplit = () => JSON.parse(readFileSync(join(HERE, "split.json"), "utf8")) as Split;
const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** The tree the capture runs from must be the commit it names, the drift directory aside. */
function cleanHead(): string {
  const dirty = git("status", "--porcelain", "--", ".", `:(exclude)${relative(ROOT, DIR)}`);
  if (dirty !== "") throw new Error(`the working tree has uncommitted changes besides ${relative(ROOT, DIR)}; commit them first:\n${dirty}`);
  return git("rev-parse", "HEAD");
}

function judgeFor(): { judge: JudgmentProvider; identity: () => ModelIdentity } {
  const endpoint = endpointFromEnv(process.env);
  if (endpoint?.host !== RULE.host) throw new Error(`the baseline and every replay ask ${RULE.host}; this environment sends judgments ${endpoint ? `to ${endpoint.host}` : "nowhere"}`);
  const client = new JevClient(endpoint);
  // No trace, whatever the environment says: the frozen packets are already kept.
  return { judge: new JevProvider(client, { trace: null }), identity: () => modelIdentityOf(endpoint.host, client.identity()) };
}

async function captureCommand(clones: string) {
  if (existsSync(PACKETS) || existsSync(MANIFEST)) throw new Error(`${relative(ROOT, PACKETS)} exists; the frozen set is not taken again (a new version is a new file)`);
  const toolCommit = cleanHead();
  const cases = devCases(readSplit());
  const { pairs, unpaired, missing } = await capture(clones, cases);
  if (missing.length > 0) throw new Error(`no clone for ${missing.join(", ")} under ${clones}; every live dev case is frozen together`);
  if (unpaired > 0) throw new Error(`${unpaired} request(s) did not pair into a mapping and an observation; nothing was written`);
  mkdirSync(DIR, { recursive: true });
  const text = pairs.map((p) => JSON.stringify(p)).join("\n") + "\n";
  const byCase: Record<string, number> = {};
  for (const p of pairs) for (const c of new Set(p.askedBy.map((w) => w.split("/")[0]!))) byCase[c] = (byCase[c] ?? 0) + 1;
  writeFileSync(PACKETS, text);
  const manifest: Manifest = { version: 1, capturedAt: new Date().toISOString(), toolCommit, questionsHash: QUESTIONS_HASH, split: sha256(readFileSync(join(HERE, "split.json"), "utf8")), pairs: pairs.length, byCase, packets: sha256(text) };
  writeJson(MANIFEST, manifest);
  console.log(`froze ${pairs.length} pairs from ${Object.keys(byCase).length} case(s): ${JSON.stringify(byCase)}; nothing was sent`);
}

async function baselineCommand(batch: string, runs: number) {
  const { manifest, pairs } = readFrozen();
  const book: { packets: string; runs: Run[] } = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { packets: manifest.packets, runs: [] };
  if (book.packets !== manifest.packets) throw new Error("the baseline was taken on other frozen pairs");
  const own = book.runs.filter((r) => r.batch === batch);
  const day = own.length > 0 ? batchDay(own) : new Date().toISOString().slice(0, 10);
  const other = [...new Set(book.runs.filter((r) => r.batch !== batch).map((r) => r.batch))].find((b) => batchDay(book.runs.filter((r) => r.batch === b)) === day);
  if (other) throw new Error(`batch ${other} began on ${day} too; the rule's batches are on different days`);
  for (let i = 0; i < runs; i++) {
    const { judge, identity } = judgeFor();
    const run = await sendRun(pairs, judge, batch, identity);
    book.runs.push(run);
    writeJson(BASELINE, book);
    console.log(`batch ${batch} run ${i + 1}/${runs}: ${Object.values(run.answers).filter((a) => a.outcome === "error").length} error(s), versions ${run.modelIdentity.returned.map((v) => v.model).join(", ") || "none named"}`);
  }
}

async function replayCommand(clones: string) {
  const { manifest, pairs } = readFrozen();
  const book = JSON.parse(readFileSync(BASELINE, "utf8")) as { packets: string; runs: Run[] };
  if (book.packets !== manifest.packets) throw new Error("the baseline was taken on other frozen pairs");
  // What the tool asks now, taken the same way and sent nowhere: a pair it no longer asks, or a new one,
  // says the frozen set is behind the tool. The verdict is still on the frozen pairs.
  const now = await capture(clones, devCases(readSplit()));
  if (now.missing.length > 0) throw new Error(`no clone for ${now.missing.join(", ")} under ${clones}; the capture against the tool needs every live dev case`);
  if (now.unpaired > 0) throw new Error(`${now.unpaired} request(s) of the tool as it is now did not pair; nothing was sent`);
  const frozen = new Set(pairs.map((p) => p.id));
  const current = new Set(now.pairs.map((p) => p.id));
  const frozenVsTool = { added: [...current].filter((id) => !frozen.has(id)).length, removed: [...frozen].filter((id) => !current.has(id)).length };
  const { judge, identity } = judgeFor();
  const run = await sendRun(pairs, judge, "replay", identity);
  const result = compare(book.runs, run, pairs, frozenVsTool);
  const file = join(DIR, `replay-${run.at.replace(/[:.]/g, "-")}.json`);
  writeJson(file, { toolCommit: git("rev-parse", "HEAD"), packets: manifest.packets, run, comparison: result });
  console.log(JSON.stringify(result, null, 2));
  console.log(`written to ${relative(ROOT, file)}`);
}

function compareCommand(file: string) {
  const { manifest, pairs } = readFrozen();
  const book = JSON.parse(readFileSync(BASELINE, "utf8")) as { packets: string; runs: Run[] };
  const saved = JSON.parse(readFileSync(file, "utf8")) as { packets: string; run: Run; comparison: Comparison };
  if (book.packets !== manifest.packets || saved.packets !== manifest.packets) throw new Error("the baseline or the replay was taken on other frozen pairs");
  console.log(JSON.stringify(compare(book.runs, saved.run, pairs, saved.comparison.frozenVsTool), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };
  if (mode === "capture" && rest[0]) await captureCommand(rest[0]);
  else if (mode === "baseline" && flag("batch") && Number(flag("runs")) > 0) await baselineCommand(flag("batch")!, Number(flag("runs")));
  else if (mode === "replay" && rest[0]) await replayCommand(rest[0]);
  else if (mode === "compare" && rest[0]) compareCommand(rest[0]);
  else {
    console.error("usage: drift.ts capture <clones> | baseline --batch <day> --runs <n> | replay <clones> | compare <replay file>");
    process.exitCode = 2;
  }
}
