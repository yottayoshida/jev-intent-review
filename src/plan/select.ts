// From the places a run has found to the calls it will ask about.
//
// Two things find places, and they are not the same kind of thing.
//
// The **change** knows where the work was done: the functions holding changed lines, and one hop
// out, the functions that call them. It is a lead, not a statement that the requirement applies —
// this tool's founding idea is that a diff is where to look, not what to conclude.
//
// The **planner** knows which calls a requirement talks about, and says so with a clause. Its picks
// are the only sites whose answers are read against the requirement at all.
//
// Neither may veto the other. A pick the change did not reach is still asked; a changed function
// the planner did not pick is still asked, because the planner chooses from files found by the
// requirement's words, and a requirement names the symptom far more often than the mechanism.
//
// Around each of those functions the set widens to every call in the body: the picks say where the
// requirement was recognised, and the defect is usually a different call in the same body (on the
// saved runs, the right function three times in three and the right call once).
//
// Then applicability, then one budget for the whole requirement — round-robin over functions, so a
// single busy body cannot take the run and so the file a function is in cannot either.
//
// Nothing here knows a function name, a helper name or an expected answer.

import type { Applicability } from "./applicability.ts";
import type { CallCandidate, Candidates, FunctionCandidate } from "./candidates.ts";

export interface Pick {
  callId: string;
  /** Which part of the requirement the planner says this call is governed by. */
  clause?: string;
}

/**
 * Why this call is in the set.
 *
 * `picked` is the planner naming it. `same_function` is widening around a pick. `changed` and
 * `calls_changed` come from the diff — a function holding changed lines, and a caller of one.
 */
export type SiteOrigin = "picked" | "same_function" | "changed" | "calls_changed";

/** How a *function* got into the set. A call inherits it unless the planner named the call. */
export type FunctionOrigin = "picked" | "changed" | "calls_changed";

export interface Site {
  call: CallCandidate;
  fn: FunctionCandidate;
  origin: SiteOrigin;
  /**
   * How the function got in, which is not the same as how the call did.
   *
   * A call the planner named inside a function the change touched has origin `picked`, and the
   * packet told the judgment model the place was not changed by the pull request because it read
   * the call's origin for it.
   */
  fnOrigin: FunctionOrigin;
  clause?: string;
  applicability?: Applicability;
}

/** One file's contribution: its listing, plus which of its functions each finder reached. */
export interface SiteSource {
  candidates: Candidates;
  /** What the planner picked here, if it was asked about this file. */
  picks?: readonly Pick[];
  /** Ids of functions holding a line the change touched. */
  changed?: readonly string[];
  /** Ids of functions that call a function the change touched. */
  callsChanged?: readonly string[];
}

export interface Selection {
  /** Picks that named a call in a listing. */
  picked: Site[];
  /** Picks that did not, with why — kept so a plan's misses are visible. */
  rejected: { callId: string; reason: string }[];
  /** Every call in every function the finders reached. The set, before any budget. */
  widened: Site[];
  /** Of those, the ones a question can be put to. */
  applicable: Site[];
  /** What the budget will ask about. */
  budgeted: Site[];
  /** Applicable and left out by the budget — unchecked, not absent. */
  overBudget: Site[];
  /** In the set and not askable, with why. */
  held: Site[];
  /**
   * How many functions each finder contributed. A function both the change and the planner
   * reached counts under the change: `picked` is the functions only the planner found.
   */
  functions: Record<FunctionOrigin, number>;
}

/**
 * One call per function at a time, in order, until the budget is full.
 *
 * A function with twenty calls would otherwise fill the run on its own, and the finders named more
 * than one function for a reason. Grouping is by the function's id, which carries its path — two
 * files' `function-1` are two functions.
 */
export function roundRobin(sites: readonly Site[], budget: number): { taken: Site[]; left: Site[] } {
  const byFunction = new Map<string, Site[]>();
  for (const s of sites) {
    const list = byFunction.get(s.fn.id) ?? [];
    list.push(s);
    byFunction.set(s.fn.id, list);
  }
  const taken: Site[] = [];
  let moved = true;
  while (taken.length < budget && moved) {
    moved = false;
    for (const list of byFunction.values()) {
      if (taken.length >= budget) break;
      const next = list.shift();
      if (!next) continue;
      taken.push(next);
      moved = true;
    }
  }
  const left = [...byFunction.values()].flat();
  return { taken, left };
}

/**
 * The selection over every source, under one budget.
 *
 * The budget is per requirement and not per file. Spending it once per file meant a requirement
 * that opened three files could ask three times its stated budget, and that the last file's calls
 * were never crowded out by the first's however many there were.
 *
 * `decide` is passed in rather than imported so this stays testable without a repository; the CLI
 * hands it `applicabilityOf` bound to the commit being read.
 */
export async function selectSites(
  sources: readonly SiteSource[],
  decide: (fn: FunctionCandidate, call: CallCandidate) => Promise<Applicability>,
  budget: number,
): Promise<Selection> {
  const picked: Site[] = [];
  const rejected: { callId: string; reason: string }[] = [];
  const pickedCallIds = new Set<string>();
  // Which finder reached each function. A function the change touched keeps that label even when
  // the planner also named a call in it: the label is a fact about the diff, and reading it off
  // whoever got there first told the judgment model a changed place was unchanged.
  const origins = new Map<string, FunctionOrigin>();
  for (const source of sources) for (const id of source.callsChanged ?? []) origins.set(id, "calls_changed");
  for (const source of sources) for (const id of source.changed ?? []) origins.set(id, "changed");

  // Functions in the order they will take their turns: the planner's first, then the changed
  // functions, then their callers. With a budget large enough for one call each, the order does
  // not decide what is asked; with a small one it decides what is asked first.
  const seeds = new Map<string, { fn: FunctionCandidate; candidates: Candidates }>();
  const seed = (candidates: Candidates, id: string) => {
    const fn = candidates.functions.find((f) => f.id === id);
    if (!fn || seeds.has(id)) return;
    if (!origins.has(id)) origins.set(id, "picked");
    seeds.set(id, { fn, candidates });
  };

  for (const source of sources) {
    for (const p of source.picks ?? []) {
      const call = source.candidates.calls.find((k) => k.id === p.callId);
      if (!call) {
        rejected.push({ callId: String(p.callId), reason: "not a call in the listing" });
        continue;
      }
      if (pickedCallIds.has(call.id)) continue;
      pickedCallIds.add(call.id);
      const fn = source.candidates.functions.find((f) => f.id === call.functionId)!;
      seed(source.candidates, fn.id);
      picked.push({ call, fn, origin: "picked", fnOrigin: origins.get(fn.id)!, ...(p.clause !== undefined ? { clause: p.clause } : {}) });
    }
  }
  for (const source of sources) for (const id of source.changed ?? []) seed(source.candidates, id);
  for (const source of sources) for (const id of source.callsChanged ?? []) seed(source.candidates, id);

  // Every call in every seeded function. A call the planner named keeps its origin and its clause;
  // the rest inherit how their function was found.
  const byPickedCall = new Map(picked.map((s) => [s.call.id, s]));
  const widened: Site[] = [];
  const functions: Record<FunctionOrigin, number> = { picked: 0, changed: 0, calls_changed: 0 };
  for (const { fn, candidates } of seeds.values()) {
    const fnOrigin = origins.get(fn.id)!;
    functions[fnOrigin] += 1;
    const calls = candidates.calls.filter((k) => k.functionId === fn.id);
    // The picks first, so a small budget spends its turn on the call a clause was written for.
    for (const call of [...calls].sort((a, b) => Number(byPickedCall.has(b.id)) - Number(byPickedCall.has(a.id)))) {
      widened.push(byPickedCall.get(call.id) ?? { call, fn, fnOrigin, origin: fnOrigin === "picked" ? "same_function" : fnOrigin });
    }
  }
  // A pick whose function was dropped by the listing cap would otherwise vanish; it cannot happen
  // today (a call is listed only under a listed function) and is cheap to keep true.
  for (const s of picked) if (!widened.some((w) => w.call.id === s.call.id)) widened.push(s);

  const applicable: Site[] = [];
  const held: Site[] = [];
  for (const site of widened) {
    const verdict = await decide(site.fn, site.call);
    const withVerdict = { ...site, applicability: verdict };
    (verdict.ok ? applicable : held).push(withVerdict);
  }

  const { taken, left } = roundRobin(applicable, budget);
  return { picked, rejected, widened, applicable, budgeted: taken, overBudget: left, held, functions };
}
