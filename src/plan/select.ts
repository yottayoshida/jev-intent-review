// From the calls a plan picked to the calls a run will ask about.
//
// The picks name places the requirement governs; they are not always the place a defect is. On the
// saved runs, the model reached the right *function* three times out of three and the right *call*
// once — the other two picked `exists()` inside it. Widening by callee spread away from the target;
// widening **inside the functions already picked** stays where the requirement was recognised and
// costs no further judgment about what is relevant.
//
// So: take the functions of the picks, enumerate their calls, keep those a question can be put to,
// and spend the judgment budget one call per function at a time so a single busy function cannot
// take the whole run.
//
// Nothing here knows a function name, a helper name or an expected answer. What it knows is which
// calls resolve to a definition that returns a `Result`.

import type { Applicability } from "./applicability.ts";
import type { CallCandidate, Candidates, FunctionCandidate } from "./candidates.ts";

export interface Pick {
  callId: string;
  /** Which part of the requirement the planner says this call is governed by. */
  clause?: string;
}

export type SiteOrigin = "picked" | "same_function";

export interface Site {
  call: CallCandidate;
  fn: FunctionCandidate;
  origin: SiteOrigin;
  clause?: string;
  applicability?: Applicability;
}

export interface Selection {
  /** Picks that named a call in the listing. */
  picked: Site[];
  /** Picks that did not, with why — kept so a plan's misses are visible. */
  rejected: { callId: string; reason: string }[];
  /** Every call in the picked functions, picks included. The set, before any budget. */
  widened: Site[];
  /** Of those, the ones a question can be put to. */
  applicable: Site[];
  /** What the budget will ask about. */
  budgeted: Site[];
  /** Applicable and left out by the budget — unchecked, not absent. */
  overBudget: Site[];
  /** In the set and not askable, with why. */
  held: Site[];
}

/**
 * One call per function at a time, in order, until the budget is full.
 *
 * A function with twenty calls would otherwise fill the run on its own, and the picks named more
 * than one function for a reason.
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
 * The selection, given the planner's picks and a way to decide applicability.
 *
 * `decide` is passed in rather than imported so this stays testable without a repository; the CLI
 * hands it `applicabilityOf` bound to the commit being read.
 */
export async function selectSites(
  candidates: Candidates,
  picks: readonly Pick[],
  decide: (fn: FunctionCandidate, call: CallCandidate) => Promise<Applicability>,
  budget: number,
): Promise<Selection> {
  const fnOf = (call: CallCandidate) => candidates.functions.find((f) => f.id === call.functionId)!;

  const picked: Site[] = [];
  const rejected: { callId: string; reason: string }[] = [];
  for (const p of picks) {
    const call = candidates.calls.find((k) => k.id === p.callId);
    if (!call) {
      rejected.push({ callId: String(p.callId), reason: "not a call in the listing" });
      continue;
    }
    if (picked.some((s) => s.call.id === call.id)) continue;
    picked.push({ call, fn: fnOf(call), origin: "picked", clause: p.clause });
  }

  // Every call in the functions the picks named, the picks first so they keep their clause.
  const functions = new Map(picked.map((s) => [s.fn.id, s.fn]));
  const widened: Site[] = [...picked];
  for (const fn of functions.values()) {
    for (const call of candidates.calls.filter((k) => k.functionId === fn.id)) {
      if (widened.some((s) => s.call.id === call.id)) continue;
      widened.push({ call, fn, origin: "same_function" });
    }
  }

  const applicable: Site[] = [];
  const held: Site[] = [];
  for (const site of widened) {
    const verdict = await decide(site.fn, site.call);
    const withVerdict = { ...site, applicability: verdict };
    (verdict.ok ? applicable : held).push(withVerdict);
  }

  const { taken, left } = roundRobin(applicable, budget);
  return { picked, rejected, widened, applicable, budgeted: taken, overBudget: left, held };
}
