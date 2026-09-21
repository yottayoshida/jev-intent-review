// Scoring the acceptance set: one target call at a time, stage by stage.
//
// The earlier scoring (bench/mapping-gate.ts) wrote its two targets and its expected table into the
// code. Here both come from each case's case.json, so the table is data that can be committed
// before the first request and the scoring code does not change when a case is added.
//
// Two mistakes of docs/candidate-set.md are ruled out by construction. A target is one call —
// file, function and the full expression — so another call in the same function being listed
// does not count as reaching it. And a call that is not a target is never scored: whether it is a
// real defect or a false one is not known without reading it, so it is counted and left.
//
// Nothing here reads a repository or sends anything. The log holds the enumeration of each branch
// and every answer of every run, and everything below is computed from it.

export type Place = "A" | "B" | "C";
export type Expected = "listed" | "not_listed" | "undetermined";

export interface Target {
  requirementId: string;
  file: string;
  function: string;
  /** The call as the enumeration prints it. A function name alone is not a place. */
  call: string;
}

export interface CaseVersion {
  base: string;
  head: string;
  /** Which kind of place this version's defect or change sits in; absent for the shipped code. */
  place?: Place;
  targets: Record<string, Target>;
  expected: Record<string, Expected>;
}

export interface CaseFile {
  id: string;
  repo: string;
  /** Measured before tuning anything, or used to tune it. Only unseen cases count as unseen. */
  role: "unseen" | "regression";
  versions: Record<string, CaseVersion>;
  /** How often each target occurs in the text of its own function at the version's head (`occurrences`). */
  existence?: Record<string, Record<string, number>>;
}

export interface CallRow {
  file: string;
  function: string;
  call: string;
}

export interface Enumeration {
  wouldAsk: CallRow[];
  unchecked: (CallRow & { why: string })[];
  notes: string[];
  /** For each target the tool held, why, as `applicabilityOf` put it — not read out of prose. */
  targetApplicability?: Record<string, { ok: boolean; kind?: string }>;
}

export interface RequirementRun {
  requirementId: string;
  observed: (CallRow & { result: { observation: string; probability: number } })[];
  unchecked: (CallRow & { why: string })[];
  mappings: (CallRow & { verdict: string; probability: number; governs: boolean })[];
  findings: (CallRow & { requirementId: string })[];
}

export interface RunRecord {
  /** False for a run that stopped: it is kept in the log and never counted. */
  finished: boolean;
  requirements: RequirementRun[];
}

export interface VersionLog {
  base: string;
  head: string;
  enumeration: Enumeration;
  runs: RunRecord[];
}

/** Where a target stopped before any run: the part of the funnel that needs no answer. */
export type Reach =
  | { stage: "not_enumerated"; capNoted: boolean }
  | { stage: "held"; kind: string }
  | { stage: "over_budget" }
  | { stage: "in_budget" };

/** What one run did with a target that was inside the budget. */
export interface RunReading {
  stage: "after_budget" | "no_answer" | "answered";
  mapping?: { verdict: string; probability: number; governs: boolean };
  observation?: { observation: string; probability: number };
  listed: boolean;
}

export interface Row {
  targetKey: string;
  target: Target;
  expected: Expected;
  reach: Reach;
  /** The first three finished runs; empty when the target was never inside the budget. */
  runs: RunReading[];
  /** Runs that match the expectation, of `runs.length`. */
  right: number;
  /** 3/3 only. Null when no run asked about the target — an unreached target agrees with nothing. */
  agrees: boolean | null;
}

export const BAR = 0.6;
export const RUNS = 3;

const same = (a: CallRow, b: CallRow) => a.file === b.file && a.function === b.function && a.call === b.call;

export class ScoringError extends Error {}

// A cap note names the file it fired in, or says the search as a whole stopped short. Either can
// have dropped the target, so an absent target under such a note is not "structurally absent".
function capNoted(target: Target, notes: readonly string[]): boolean {
  return notes.some(
    (n) =>
      (n.startsWith(`${target.file}:`) && /left out of the listing by its cap/.test(n)) ||
      /^only the first \d+ of \d+ changed functions/.test(n) ||
      /were not followed/.test(n),
  );
}

/** Where a target stood before any run, from the branch's enumeration alone. */
export function reachOf(targetKey: string, target: Target, enumeration: Enumeration, existence: number | undefined): Reach {
  if (existence !== undefined && existence !== 1) {
    throw new ScoringError(`${targetKey} (${target.file} · ${target.function} · ${target.call}) occurs ${existence} times in its file, not once`);
  }
  const asked = enumeration.wouldAsk.filter((c) => same(c, target));
  const held = enumeration.unchecked.filter((c) => same(c, target));
  const hits = asked.length + held.length;
  if (hits > 1) throw new ScoringError(`${targetKey} matches ${hits} calls in the enumeration, so which one was measured is not settled`);
  if (asked.length === 1) return { stage: "in_budget" };
  if (held.length === 1) {
    const applicability = enumeration.targetApplicability?.[targetKey];
    if (applicability?.ok === true) return { stage: "over_budget" };
    return { stage: "held", kind: applicability?.kind ?? "unrecorded" };
  }
  return { stage: "not_enumerated", capNoted: capNoted(target, enumeration.notes) };
}

/** What one run did with a target that was inside the budget. */
export function readRun(target: Target, run: RunRecord): RunReading {
  const r = run.requirements.find((x) => x.requirementId === target.requirementId);
  if (!r) return { stage: "after_budget", listed: false };
  const listed = r.findings.some((f) => f.requirementId === target.requirementId && same(f, target));
  const observed = r.observed.find((o) => same(o, target));
  const mapping = r.mappings.find((m) => same(m, target));
  if (!observed && !mapping) return { stage: "after_budget", listed };
  const reading: RunReading = { stage: mapping?.verdict === "no_answer" ? "no_answer" : "answered", listed };
  if (mapping) reading.mapping = { verdict: mapping.verdict, probability: mapping.probability, governs: mapping.governs };
  if (observed) reading.observation = observed.result;
  return reading;
}

/** Whether one run's reading of a target matches what the table said beforehand. */
export function isRight(expected: Expected, reading: RunReading, bar = BAR): boolean {
  if (expected === "listed") return reading.listed;
  if (expected === "not_listed") return !reading.listed;
  // `undetermined`: the code the question needs was not sent, so no confident reading is right.
  if (reading.listed) return false;
  const o = reading.observation;
  return o === undefined || o.observation === "cannot_determine" || o.probability < bar;
}

/** Every target of one version, scored against the table in case.json. */
export function scoreVersion(caseFile: CaseFile, versionId: string, log: VersionLog): Row[] {
  const version = caseFile.versions[versionId];
  if (!version) throw new ScoringError(`${caseFile.id} has no version ${versionId}`);
  if (log.base !== version.base || log.head !== version.head) {
    throw new ScoringError(`${caseFile.id} ${versionId}: the log ran ${log.base.slice(0, 7)}..${log.head.slice(0, 7)}, case.json says ${version.base.slice(0, 7)}..${version.head.slice(0, 7)}`);
  }
  const finished = log.runs.filter((r) => r.finished).slice(0, RUNS);
  return Object.entries(version.expected).map(([targetKey, expected]) => {
    const target = version.targets[targetKey];
    if (!target) throw new ScoringError(`${caseFile.id} ${versionId} expects ${targetKey}, which it does not define`);
    const reach = reachOf(targetKey, target, log.enumeration, caseFile.existence?.[versionId]?.[targetKey]);
    if (reach.stage !== "in_budget") return { targetKey, target, expected, reach, runs: [], right: 0, agrees: null };
    const runs = finished.map((run) => readRun(target, run));
    const right = runs.filter((reading) => isRight(expected, reading)).length;
    return { targetKey, target, expected, reach, runs, right, agrees: runs.length === RUNS ? right === RUNS : null };
  });
}

/** A version is live when any of its targets is inside the budget: only those are sent to Jev. */
export function isLive(version: CaseVersion, enumeration: Enumeration): boolean {
  return Object.values(version.targets).some((t) => enumeration.wouldAsk.some((c) => same(c, t)));
}

/**
 * The old measurement, read through the same table: whether each target was listed, nothing else.
 *
 * `stated-requirements-v1.json` predates the enumeration being kept, so reach cannot be scored from
 * it; this is the part of the scoring that log can check.
 */
export function scoreListed(caseFile: CaseFile, versionId: string, run: RunRecord): { targetKey: string; listed: boolean; expected: Expected; agrees: boolean }[] {
  const version = caseFile.versions[versionId];
  if (!version) throw new ScoringError(`${caseFile.id} has no version ${versionId}`);
  return Object.entries(version.expected).map(([targetKey, expected]) => {
    const target = version.targets[targetKey];
    if (!target) throw new ScoringError(`${caseFile.id} ${versionId} expects ${targetKey}, which it does not define`);
    const listed = readRun(target, run).listed;
    return { targetKey, listed, expected, agrees: isRight(expected, { stage: "answered", listed }) };
  });
}

const collapse = (s: string) => s.replace(/\s+/g, "");

/**
 * The text of every function named `name` in a Rust file, found by the `fn` line and the braces
 * after it.
 *
 * ponytail: brace counting, not a parser — braces inside string and char literals are counted too.
 * It only has to find a target's own function well enough to count one expression in it, and it
 * is kept apart from `enumerate` on purpose: `enumerate` stops at 60 functions a file and 40 calls a
 * function, and existence must not depend on those caps.
 */
export function functionTexts(source: string, name: string): string[] {
  const lines = source.split("\n");
  const head = new RegExp(`\\bfn\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[(<]`);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i]!)) continue;
    let depth = 0;
    let opened = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j]!);
      for (const ch of lines[j]!) {
        if (ch === "{") (depth += 1), (opened = true);
        else if (ch === "}") depth -= 1;
      }
      if (opened && depth <= 0) break;
      if (!opened && lines[j]!.trimEnd().endsWith(";")) break; // a declaration with no body
    }
    out.push(body.join("\n"));
  }
  return out;
}

/** How often `call` occurs in the functions named `fn`, whitespace ignored. */
export function occurrences(source: string, fn: string, call: string): number {
  const needle = collapse(call);
  return functionTexts(source, fn).reduce((n, text) => n + collapse(text).split(needle).length - 1, 0);
}

/**
 * What the log keeps of a branch's enumeration: every call inside the budget, the notes and counts,
 * and the held rows of the functions that hold a target.
 *
 * The rest is not lost: the enumeration depends on the commits alone and `run.ts precheck` takes it
 * again, with no request. The held rows of a target's own function stay so that a target written
 * wrong can be matched again inside the function it names, which is the mistake the scoring guards.
 */
export function keepForTargets<E extends Enumeration>(enumeration: E, targets: readonly Target[]): E {
  const fns = new Set(targets.map((t) => `${t.file}\u0000${t.function}`));
  return { ...enumeration, unchecked: enumeration.unchecked.filter((u) => fns.has(`${u.file}\u0000${u.function}`)) };
}
