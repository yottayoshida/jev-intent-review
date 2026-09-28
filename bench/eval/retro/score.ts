// The retrospective's scoring (#89, RETRO.md v7-v9, "Opening and targets" and "Scoring"): whether each
// opened case's target was listed in three runs of three, the primary metric and its interval, the
// stages, the guards and what is reported. Pure: the runs, the targets and the adjudication are given.

import { keyOf } from "../adjudicate.ts";
import { clopperPearson } from "../metrics.ts";

/** A call as the tool lists it, or as an annotator named it. */
export interface Call {
  file: string;
  function: string;
  call: string;
}

/** What `RETRO.md` counts of a call's text: the tool keeps no more of one. */
export const CALL_CHARS = 200;

/**
 * A call brought to the one form both sides are compared in: spaces out, a final `?` or `.await`
 * dropped, a receiver before the called name taken off, a path before it cut to its last segment.
 * `path` says whether the call had a path, so that one side's path is dropped when the other has none.
 */
export function normalCall(call: string): { name: string; path: string | null } {
  let s = call.replace(/\s+/g, "");
  for (let changed = true; changed; ) {
    changed = false;
    if (s.endsWith("?")) (s = s.slice(0, -1)), (changed = true);
    if (s.endsWith(".await")) (s = s.slice(0, -".await".length)), (changed = true);
  }
  // The arguments are the last parenthesised group: in `a.b()?.c(x)` the call is `c(x)`, and `a.b()?`
  // is a receiver. The callee is what comes before that group; generics `<…>` are part of it.
  if (!s.endsWith(")")) return { name: s, path: null };
  let depth = 0;
  let open = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i]!;
    if (ch === ")") depth++;
    else if (ch === "(" && --depth === 0) {
      open = i;
      break;
    }
  }
  if (open <= 0) return { name: s, path: null };
  const callee = s.slice(0, open);
  const args = s.slice(open);
  // A receiver ends at the last top-level `.` of the callee: `self.x.foo` → `foo`.
  const dot = lastTopLevel(callee, ".");
  const afterDot = dot < 0 ? callee : callee.slice(dot + 1);
  // A path: `crate::a::Foo::new` → path `Foo`, name `new`.
  // A turbofish segment (`::<u8>`) belongs to the one before it; a path is compared without its generics.
  const segs = splitTopLevel(afterDot, "::").reduce<string[]>((out, seg) => (seg.startsWith("<") && out.length > 0 ? [...out.slice(0, -1), `${out.at(-1)!}::${seg}`] : [...out, seg]), []);
  const name = `${segs.at(-1)!.replace(/::<.*$/, "")}${args}`;
  const path = segs.length > 1 ? segs.at(-2)!.replace(/::<.*$/, "").replace(/<.*$/, "") : null;
  return { name, path };
}

function lastTopLevel(s: string, ch: string): number {
  // Only brackets nest: a `<` before the called name may be a comparison (`a.b(x < y).c()`), and a
  // generic holds no `.`.
  let depth = 0;
  let at = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === ch && depth === 0) at = i;
  }
  return at;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<") depth++;
    else if (c === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(from, i));
      from = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

// Only `./` is taken off: the tool lists paths as they are, and a real directory may be named `a` or `b`.
const segments = (p: string) => p.replace(/^\.\//, "").split("/").filter(Boolean);

/**
 * Whether two paths match: one ends, segment by segment, with the other; the shorter has at least two
 * segments unless `onlyOfName` says it names the only file of that name at the version.
 */
export function sameFile(a: string, b: string, onlyOfName: (name: string) => boolean): boolean {
  const [x, y] = [segments(a), segments(b)];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length === 0) return false;
  if (!short.every((s, i) => long[long.length - short.length + i] === s)) return false;
  return short.length >= 2 || onlyOfName(short[0]!);
}

/** Whether a listed call is the target (RETRO.md v7, "Matching the target"). */
export function matches(listed: Call, target: Call, onlyOfName: (name: string) => boolean): boolean {
  if (!target.call.includes("(")) return false;
  if (!sameFile(listed.file, target.file, onlyOfName)) return false;
  if (listed.function.split("::").at(-1)!.trim() !== target.function.split("::").at(-1)!.trim()) return false;
  const [l, t] = [normalCall(listed.call), normalCall(target.call)];
  if (l.path !== null && t.path !== null && l.path !== t.path) return false;
  return l.name.slice(0, CALL_CHARS) === t.name.slice(0, CALL_CHARS);
}

/** One run of the tool on a case, as the score reads it. */
export interface ScoredRun {
  finished: boolean;
  /** Over the envelope of one pull request (400 requests, 4 MB): a run cut there does not finish. */
  requests: number;
  bytes: number;
  seconds: number | null;
  /** Every call listed, under the requirement it was listed under. */
  listed: (Call & { requirementId: string })[];
}

/** One opened case, as the score reads it. */
export interface ScoredCase {
  row: number;
  /** How O was found (`named`, `blame`). */
  originBy: string;
  hasRequirement: boolean;
  /** `null` when not named: the reason is `whyNotNamed`. */
  target: Call | null;
  whyNotNamed?: string;
  /** In the tool's enumeration at the run's version, under any requirement, a row matching the target is within the budget. */
  covered: boolean;
  runs: ScoredRun[];
  /** Each listed call that is not the target, as the adjudication decided it. */
  adjudicated: { call: Call; label: "real_defect" | "false" | "duplicate" | "cannot_decide" }[];
  /** Whether the target is in O's diff (reach origin), when detected. */
  inDiff?: boolean;
  /** `false` when the target named is not in O's head before measuring (RETRO.md v7): counted apart. */
  foundAtHead?: boolean;
}

/** The envelope of one pull request (RETRO.md, "Cost"). */
export const ENVELOPE = { requests: 400, bytes: 4 * 1024 * 1024 } as const;
export const RUNS = 3;
export const GATE = 0.2;

/** The first three finished runs; `null` when fewer than three finished. */
export function counted(c: ScoredCase): ScoredRun[] | null {
  const f = c.runs.filter((r) => r.finished).slice(0, RUNS);
  return f.length < RUNS ? null : f;
}

/** Whether a case is detected: its target listed in each of three counted runs, none over the envelope. */
export function detected(c: ScoredCase, onlyOfName: (name: string) => boolean): boolean {
  // A target not found in O's head is counted apart and not detected, as one not named (RETRO.md v7).
  if (!c.hasRequirement || c.target === null || c.foundAtHead === false) return false;
  const runs = counted(c);
  if (runs === null) return false;
  return runs.every((r) => r.requests <= ENVELOPE.requests && r.bytes <= ENVELOPE.bytes && r.listed.some((l) => matches(l, c.target!, onlyOfName)));
}

/** The union of a case's finished runs' calls, a call once, the target's matches kept apart. */
export function unionOf(c: ScoredCase, onlyOfName: (name: string) => boolean): { target: Call[]; other: (Call & { requirementId: string })[] } {
  // The adjudication's own key, so that a call it labelled once is found here once.
  const key = keyOf;
  const seen = new Set<string>();
  const target: Call[] = [];
  const other: (Call & { requirementId: string })[] = [];
  for (const r of c.runs.filter((x) => x.finished)) {
    for (const l of r.listed) {
      const k = key(l);
      if (seen.has(k)) continue;
      seen.add(k);
      if (c.target !== null && matches(l, c.target, onlyOfName)) target.push(l);
      else other.push(l);
    }
  }
  return { target, other };
}

export interface Result {
  cases: number;
  detected: number;
  primary: { rate: number; lower: number; upper: number };
  gate: { lowerAbove: number; guards: boolean; passed: boolean };
  withRequirement: { cases: number; detected: number; rate: number | null };
  /** Each stage's share is over the stage before it: requirement over every case, covered over those with a requirement, listed over those covered. */
  stages: { requirement: number; covered: number; listed: number; listedNotCovered: number; shares: Record<"requirement" | "covered" | "listed", { rate: number; lower: number; upper: number } | null> };
  guards: { falsePerPullRequest: number | null; precision: number | null; runCases: number };
  notNamed: Record<string, number>;
  noRequirement: number;
  notFoundAtHead: number;
  unfinished: number;
  byOrigin: Record<string, { cases: number; detected: number }>;
  reach: { inDiff: number; outsideDiff: number };
  cost: { requests: number; bytes: number; seconds: number; runs: number; longestRunSeconds: number; runsOver600Seconds: number };
}

/** The whole score of the opened cases (RETRO.md, "Scoring" and "The gate"). */
export function score(cases: readonly ScoredCase[], onlyOfName: (row: number) => (name: string) => boolean): Result {
  const n = cases.length;
  const det = cases.filter((c) => detected(c, onlyOfName(c.row)));
  const ci = clopperPearson(det.length, n);
  const withReq = cases.filter((c) => c.hasRequirement);
  const withReqDet = withReq.filter((c) => det.includes(c));
  // The guards: over the cases that were run, every finished run's calls once.
  const run = withReq.filter((c) => c.runs.length > 0);
  let falseCount = 0;
  let good = 0;
  let total = 0;
  for (const c of run) {
    const u = unionOf(c, onlyOfName(c.row));
    const decided = new Map(c.adjudicated.map((a) => [keyOf(a.call), a.label]));
    // The target is one call, however many forms of it were listed: it counts once.
    good += Math.min(1, u.target.length);
    total += Math.min(1, u.target.length);
    for (const o of u.other) {
      const label = decided.get(keyOf(o)) ?? "cannot_decide";
      if (label === "duplicate") continue; // folded into another sentence: counted once, as the adjudication does
      total += 1;
      if (label === "real_defect") good += 1;
      // A call the adjudicators could not decide counts against the tool in both guards (RETRO.md v7).
      if (label === "false" || label === "cannot_decide") falseCount += 1;
    }
  }
  const falsePer = run.length === 0 ? null : falseCount / run.length;
  const precision = total === 0 ? null : good / total;
  const guards = falsePer !== null && falsePer <= 1 && precision !== null && precision >= 0.5;
  const notNamed: Record<string, number> = {};
  for (const c of cases) if (c.target === null && c.whyNotNamed) notNamed[c.whyNotNamed] = (notNamed[c.whyNotNamed] ?? 0) + 1;
  const byOrigin: Record<string, { cases: number; detected: number }> = {};
  for (const c of cases) {
    const b = (byOrigin[c.originBy] ??= { cases: 0, detected: 0 });
    b.cases += 1;
    if (det.includes(c)) b.detected += 1;
  }
  const covered = withReq.filter((c) => c.target !== null && c.covered);
  const listedNotCovered = det.filter((c) => !c.covered).length;
  const cost = { requests: 0, bytes: 0, seconds: 0, runs: 0, longestRunSeconds: 0, runsOver600Seconds: 0 };
  for (const c of cases) {
    for (const r of c.runs) {
      (cost.requests += r.requests), (cost.bytes += r.bytes), (cost.seconds += r.seconds ?? 0), (cost.runs += 1);
      cost.longestRunSeconds = Math.max(cost.longestRunSeconds, r.seconds ?? 0);
      if ((r.seconds ?? 0) > 600) cost.runsOver600Seconds += 1;
    }
  }
  const share = (k: number, of: number) => {
    if (of === 0) return null;
    const b = clopperPearson(k, of);
    return { rate: k / of, lower: b.lower, upper: b.upper };
  };
  const listedCovered = det.filter((c) => c.covered).length;
  return {
    cases: n,
    detected: det.length,
    primary: { rate: det.length / n, lower: ci.lower, upper: ci.upper },
    gate: { lowerAbove: GATE, guards, passed: ci.lower > GATE && guards },
    withRequirement: { cases: withReq.length, detected: withReqDet.length, rate: withReq.length === 0 ? null : withReqDet.length / withReq.length },
    stages: { requirement: withReq.length, covered: covered.length, listed: listedCovered, listedNotCovered, shares: { requirement: share(withReq.length, n), covered: share(covered.length, withReq.length), listed: share(listedCovered, covered.length) } },
    guards: { falsePerPullRequest: falsePer, precision, runCases: run.length },
    notNamed,
    noRequirement: n - withReq.length,
    notFoundAtHead: cases.filter((c) => c.foundAtHead === false).length,
    unfinished: withReq.filter((c) => c.runs.length > 0 && counted(c) === null).length,
    byOrigin,
    reach: { inDiff: det.filter((c) => c.inDiff === true).length, outsideDiff: det.filter((c) => c.inDiff === false).length },
    cost,
  };
}
