// From the places a run has found to the calls it will ask about.
//
// The **change** is what finds them: the functions holding changed lines, and one hop out, the
// functions that call them. It is a lead, not a statement that a requirement applies — this
// tool's founding idea is that a diff is where to look, not what to conclude.
//
// A second model used to pick calls out of files the requirement's words opened, and each pick
// carried a clause it claimed to check. It is gone: this tool asks Jev, and Jev answers typed
// questions rather than choosing from a list. Whether a requirement governs a call is asked of
// Jev, of every call the budget reaches, after the set is built.
//
// Around each function the set widens to every call in the body: the change says which body, and
// the defect is usually a different call in it (on the saved runs, the right function three times
// in three and the right call once).
//
// Then applicability, then one budget for the whole requirement — round-robin over functions, so a
// single busy body cannot take the run and so the file a function is in cannot either. Inside a
// function, the calls into a function the change touched take its turns first.
//
// Nothing here knows a function name, a helper name or an expected answer.

import type { CallCandidate, Candidates, FunctionCandidate } from "./candidates.ts";

/**
 * Whether a question can be put to a call, as the requirement's form decides it.
 *
 * What decides it differs by form (docs/adr/0006-question-forms-as-data.md); what this module
 * needs is only the answer, and the reason when it is no.
 */
export type Askability =
  | {
      ok: true;
      /**
       * Where the callee resolved to, as `path:line`, when the form resolves one. The failure
       * form does; the order inside a function reads it (`callsIntoChangedFirst`).
       */
      calleeDefinedAt?: string;
    }
  | { ok: false; kind: string; reason: string };

/**
 * Why this call is in the set: its function holds a changed line, its function calls one that
 * does, or its function calls what the changed code calls and nothing the change touched
 * (`shares_call`, `siblings.ts`, ADR 0005).
 */
export type SiteOrigin = "changed" | "calls_changed" | "shares_call";

/** How a *function* the change itself reached got into the set. A call inherits it. */
export type FunctionOrigin = "changed" | "calls_changed";

export interface Site {
  call: CallCandidate;
  fn: FunctionCandidate;
  origin: SiteOrigin;
  /** How the function got in. The packet's "changed by this pull request" is read off this. */
  fnOrigin: SiteOrigin;
  /** For a sibling: the name the changed code calls that tied it. */
  via?: string;
  applicability?: Askability;
}

/** One file's contribution: its listing, plus which of its functions the change reached. */
export interface SiteSource {
  candidates: Candidates;
  /** Ids of functions holding a line the change touched. */
  changed?: readonly string[];
  /** Ids of functions that call a function the change touched. */
  callsChanged?: readonly string[];
}

export interface Selection {
  /** Every call in every function the change reached. The set, before any budget. */
  widened: Site[];
  /** Of those, the ones a question can be put to. */
  applicable: Site[];
  /** What the budget will ask about. */
  budgeted: Site[];
  /** Applicable and left out by the budget — unchecked, not absent. */
  overBudget: Site[];
  /** In the set and not askable, with why. */
  held: Site[];
  /** How many functions came from changed lines, and how many from one hop out. */
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
 * Where an askable call's callee resolved to, as `path:line`, when the form that decided it says.
 *
 * The failure form's answer carries it; the check-before-action form's does not — a call whose
 * callee resolves to a function this run reads is not askable there at all — and those calls are
 * not moved.
 */
export function resolvedTo(verdict: Askability | undefined): string | undefined {
  return verdict?.ok ? verdict.calleeDefinedAt : undefined;
}

/**
 * Within each function, the calls into a function the change touched first; the rest keep the
 * order they were found in. Functions keep theirs.
 *
 * When a function gets fewer turns than it has askable calls, this decides which calls they go
 * to; with more functions holding an askable call than the budget, a function reached at all gets
 * one, its first. In line order that is whatever comes first in the body. On Kontor#385, once more
 * calls can be asked about (#45), a query into a file the pull request never touched comes first
 * and takes the turn of `batch_to_decided(b)`, the decode the pull request changed, six lines
 * further down. A call into a changed function is where the change reaches the body, and it is
 * also why a caller one hop out is in the set at all.
 *
 * "Into a changed function" is decided by where the callee resolved to, as the check that decides
 * whether it can be asked about finds it: the one `fn` of its name, or the one the call's path or
 * form picks out of several, or — for a trait's method whose versions are read together — the
 * trait's declaration, which is not where the implementation the change touched is. A name nothing
 * settles resolves to nowhere, and a search cut at its cap settles nothing.
 *
 * ponytail: the evidence that this order is better than line order is that one case, and it is
 * the case the order was chosen from. The opposite shape — a defect in a call to an unchanged
 * function, beside a call into a changed one — is untested. Measuring orders against each other
 * is #38.
 */
export function callsIntoChangedFirst(sites: readonly Site[], changedAt: ReadonlySet<string>): Site[] {
  const intoChanged = (s: Site) => {
    const at = resolvedTo(s.applicability);
    return at !== undefined && changedAt.has(at);
  };
  const byFunction = new Map<string, Site[]>();
  for (const s of sites) {
    const list = byFunction.get(s.fn.id) ?? [];
    list.push(s);
    byFunction.set(s.fn.id, list);
  }
  return [...byFunction.values()].flatMap((list) => [...list.filter(intoChanged), ...list.filter((s) => !intoChanged(s))]);
}

/**
 * The selection over every source, under one budget.
 *
 * The budget is per requirement and not per file. Spending it once per file meant a requirement
 * that opened three files could ask three times its stated budget, and that the last file's calls
 * were never crowded out by the first's however many there were.
 *
 * `decide` is passed in rather than imported so this stays testable without a repository; the CLI
 * hands it the requirement's form, bound to that requirement and to the commit being read.
 */
export async function selectSites(
  sources: readonly SiteSource[],
  decide: (fn: FunctionCandidate, call: CallCandidate) => Promise<Askability>,
  budget: number,
): Promise<Selection> {
  // Which finder reached each function. A function the change touched keeps that label even when
  // a caller search also reached it: the label is a fact about the diff.
  const origins = new Map<string, FunctionOrigin>();
  for (const source of sources) for (const id of source.callsChanged ?? []) origins.set(id, "calls_changed");
  for (const source of sources) for (const id of source.changed ?? []) origins.set(id, "changed");

  // Functions in the order they will take their turns: the changed ones, then their callers. With
  // a budget large enough for one call each, the order does not decide what is asked; with a small
  // one it decides what is asked first.
  const seeds = new Map<string, { fn: FunctionCandidate; candidates: Candidates }>();
  const seed = (candidates: Candidates, id: string) => {
    const fn = candidates.functions.find((f) => f.id === id);
    if (!fn || seeds.has(id)) return;
    seeds.set(id, { fn, candidates });
  };
  for (const source of sources) for (const id of source.changed ?? []) seed(source.candidates, id);
  for (const source of sources) for (const id of source.callsChanged ?? []) seed(source.candidates, id);

  const widened: Site[] = [];
  const functions: Record<FunctionOrigin, number> = { changed: 0, calls_changed: 0 };
  for (const { fn, candidates } of seeds.values()) {
    const fnOrigin = origins.get(fn.id)!;
    functions[fnOrigin] += 1;
    for (const call of candidates.calls.filter((k) => k.functionId === fn.id)) widened.push({ call, fn, fnOrigin, origin: fnOrigin });
  }

  const applicable: Site[] = [];
  const held: Site[] = [];
  for (const site of widened) {
    const verdict = await decide(site.fn, site.call);
    const withVerdict = { ...site, applicability: verdict };
    (verdict.ok ? applicable : held).push(withVerdict);
  }

  // Where each changed function is defined, in the form a resolved callee carries.
  const changedAt = new Set<string>();
  for (const { fn } of seeds.values()) if (origins.get(fn.id) === "changed") changedAt.add(`${fn.path}:${fn.startLine}`);

  const { taken, left } = roundRobin(callsIntoChangedFirst(applicable, changedAt), budget);
  return { widened, applicable, budgeted: taken, overBudget: left, held, functions };
}

/** The siblings' selection: the same parts as `Selection`, counted apart (ADR 0005). */
export interface SiblingSelection {
  widened: Site[];
  applicable: Site[];
  budgeted: Site[];
  overBudget: Site[];
  held: Site[];
  /** How many siblings there were. */
  functions: number;
}

/**
 * The siblings, under a budget of their own (ADR 0005).
 *
 * Kept apart from `selectSites` so that the calls asked about in the functions the change reached
 * are the same set whether or not a sibling exists. Siblings take their turns in seed order, one
 * call each at a time, and inside each the calls that tied it to a seed come first: that is where
 * a missed path's defect sits, and without it first a sibling's other calls would spend the budget.
 */
export async function selectSiblings(
  siblings: readonly { fn: FunctionCandidate; candidates: Candidates; seed: string; tying: readonly CallCandidate[] }[],
  decide: (fn: FunctionCandidate, call: CallCandidate) => Promise<Askability>,
  budget: number,
): Promise<SiblingSelection> {
  const widened: Site[] = [];
  for (const sibling of siblings) {
    const tying = new Set(sibling.tying.map((c) => c.id));
    const calls = sibling.candidates.calls.filter((k) => k.functionId === sibling.fn.id);
    for (const call of [...calls.filter((k) => tying.has(k.id)), ...calls.filter((k) => !tying.has(k.id))]) {
      widened.push({ call, fn: sibling.fn, origin: "shares_call", fnOrigin: "shares_call", via: sibling.seed });
    }
  }
  const applicable: Site[] = [];
  const held: Site[] = [];
  for (const site of widened) {
    const verdict = await decide(site.fn, site.call);
    (verdict.ok ? applicable : held).push({ ...site, applicability: verdict });
  }
  const { taken, left } = roundRobin(applicable, budget);
  return { widened, applicable, budgeted: taken, overBudget: left, held, functions: siblings.length };
}
