// Past the changed functions: the other callers of what the changed code calls (ADR 0005).
//
// The change's own functions and their callers one hop out cannot reach the case the README opens
// with — "a new rule may be implemented in one API path but missed in another". The path that was
// missed uses the same helper as the one that was fixed, and calls nothing the pull request
// touched. What ties the two is the helper, so the helper is the seed.
//
// A seed is a name the changed code calls outside tests that a question can be put to: defined once
// in this repository, returning a `Result`, and not itself a changed function (a helper the pull
// request adds is one, and its callers are read one hop out). Seeds are taken in this order:
// called on a changed line, called from more changed regions, used in fewer files, then by name.
// Rarest first — the ordinary review's order — cannot reach a shared helper, which by definition
// is used in many files: measured on omamori PR #476, the helper came 83rd of 125.
//
// A sibling is a function whose own call list has a call to a seed, that returns a `Result`, and
// that calls no changed function — by a name defined once, since only then does a call by that
// name reach the changed function. It is decided from `enumerate`'s calls and not from a search
// hit, which lands on comments and strings as readily as on calls.
//
// Relations are by name. Every name that could not be tied, and why, is counted in the notes: that
// record is what says whether a parser is needed.

import { calledNames, type ChangeAnalysis } from "../change/seeds.ts";
import { isTestPath, refuseWord, type Discoverer } from "../discovery/discover.ts";
import { redact } from "../evidence/redact.ts";
import { definitionsOf, RETURNS_RESULT, resolveCallee } from "./applicability.ts";
import type { CallCandidate, Candidates, FunctionCandidate } from "./candidates.ts";
import { COMMON_FILES, isRust, type CandidateFiles } from "./from-diff.ts";

/** How many seeds are followed. */
export const MAX_SEEDS = 8;
/** How many functions may be siblings, over every seed. */
export const MAX_SIBLINGS = 20;
/** How many names a note shows before it only counts. */
const SHOWN = 5;

export interface Seed {
  name: string;
  onChangedLine: boolean;
  /** How many changed regions outside tests call it. */
  regions: number;
  /** How many files outside tests mention it. */
  files: number;
  definedAt: string;
}

export interface Sibling {
  fn: FunctionCandidate;
  candidates: Candidates;
  /** The seed that tied it. */
  seed: string;
  /** Its calls to that seed: the ones a missed path's defect sits at. */
  tying: CallCandidate[];
}

export interface SiblingSet {
  seeds: Seed[];
  siblings: Sibling[];
  notes: string[];
}

const bareName = (callee: string) => callee.split("::").pop()!;

/** A note about names: the count, and the first few, redacted. */
function named(count: string, names: readonly string[]): string {
  const shown = names.slice(0, SHOWN).map((n) => redact(n).text);
  return `${names.length} ${count}: ${shown.join(", ")}${names.length > SHOWN ? `, and ${names.length - SHOWN} more` : ""}`;
}

/**
 * The siblings of a change, at the after commit.
 *
 * `known` holds the ids of functions the change already reached (changed, or calling a changed
 * one): they keep that label. `listedChanged` are the names of the changed functions the one-hop
 * search listed; the names of every other Rust function the change touched outside tests are added
 * here, since a function past the listing's cap is changed all the same.
 */
export async function siblingsOf(files: CandidateFiles, discoverer: Discoverer, change: ChangeAnalysis, known: ReadonlySet<string>, listedChanged: ReadonlySet<string>): Promise<SiblingSet> {
  const notes: string[] = [];
  const changedNames = new Set(listedChanged);

  // The names the changed code calls, outside tests and in tests.
  const inCode = new Map<string, { onChangedLine: boolean; regions: number }>();
  const inTests = new Set<string>();
  for (const region of change.regions) {
    if (!region.code || !isRust(region.path)) continue;
    const index = await discoverer.index(region.path);
    if (!index) continue;
    const changedText = [...region.added, ...region.removed].join("\n");
    const body = index.lines.slice(region.block.startLine - 1, region.block.endLine).join("\n");
    const onChanged = calledNames(changedText);
    const test = isTestPath(region.path) || index.testRegions.some((r) => region.block.startLine >= r.start && region.block.startLine <= r.end);
    // A test the change touched is not a function anything outside the tests calls: its name
    // standing among the changed ones would take a seed of the same name out, and turn away every
    // caller of that name.
    if (!test && region.block.name) changedNames.add(region.block.name);
    for (const name of new Set([...calledNames(body), ...onChanged])) {
      if (test) {
        inTests.add(name);
        continue;
      }
      const entry = inCode.get(name) ?? { onChangedLine: false, regions: 0 };
      entry.regions += 1;
      entry.onChangedLine ||= onChanged.has(name);
      inCode.set(name, entry);
    }
  }

  const refused: string[] = [];
  const changedFns: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  const notResult: string[] = [];
  const common: string[] = [];
  const beyondSearch: string[] = [];
  const candidates: Seed[] = [];
  for (const [name, entry] of [...inCode.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (refuseWord(name, 3)) {
      refused.push(name);
      continue;
    }
    if (changedNames.has(name)) {
      changedFns.push(name);
      continue;
    }
    const callee = await resolveCallee(discoverer, name);
    if (!callee.ok) {
      (callee.kind === "callee_unresolved" ? unresolved : callee.kind === "callee_ambiguous" ? ambiguous : notResult).push(name);
      continue;
    }
    const { hits, more } = await discoverer.search(name);
    const spread = new Set(hits.filter((h) => !isTestPath(h.path) && isRust(h.path)).map((h) => h.path)).size;
    if (more) {
      beyondSearch.push(name);
      continue;
    }
    if (spread > COMMON_FILES) {
      common.push(name);
      continue;
    }
    candidates.push({ name, ...entry, files: spread, definedAt: callee.definedAt });
  }
  const onlyInTests = [...inTests].filter((n) => !inCode.has(n)).sort();

  candidates.sort((a, b) => Number(b.onChangedLine) - Number(a.onChangedLine) || b.regions - a.regions || a.files - b.files || a.name.localeCompare(b.name));
  const seeds = candidates.slice(0, MAX_SEEDS);
  const leftOut = candidates.slice(MAX_SEEDS).map((s) => s.name);

  if (unresolved.length > 0) notes.push(`siblings: ${named("names the changed code calls have no definition here, so a call to them cannot be asked about", unresolved)}`);
  if (ambiguous.length > 0) notes.push(`siblings: ${named("names the changed code calls are defined more than once here", ambiguous)}`);
  if (notResult.length > 0) notes.push(`siblings: ${named("names the changed code calls do not return a Result", notResult)}`);
  if (changedFns.length > 0) notes.push(`siblings: ${named("names the changed code calls are changed functions, whose callers are read one hop out unless that search's own caps left them out (see its notes)", changedFns)}`);
  if (onlyInTests.length > 0) notes.push(`siblings: ${named("names are called only in the change's tests", onlyInTests)}`);
  if (common.length > 0) notes.push(`siblings: ${named(`names are used in more than ${COMMON_FILES} files and were not followed`, common)}`);
  if (beyondSearch.length > 0) notes.push(`siblings: ${named("names have more references than the search returns and were not followed", beyondSearch)}`);
  if (refused.length > 0) notes.push(`siblings: ${named("names could not be searched", refused)}`);
  if (leftOut.length > 0) notes.push(`siblings: ${named(`seeds over the cap of ${MAX_SEEDS} were not followed`, leftOut)}`);

  // A call by a changed function's name goes to that function only when the name is defined once.
  // `new` or `get` changed in one type says nothing about a call to another type's: such a name
  // does not turn a function away, and the notes say which names were set aside that way.
  const ruling = new Set<string>();
  const shared: string[] = [];
  for (const name of [...changedNames].sort()) {
    if (refuseWord(name, 3)) continue;
    const defs = await definitionsOf(discoverer, name);
    if (defs.length === 1) ruling.add(name);
    else if (defs.length > 1) shared.push(name);
  }
  if (shared.length > 0) notes.push(`siblings: ${named("changed functions have a name defined more than once here, so calling that name does not keep a function from being a sibling", shared)}`);

  const siblings: Sibling[] = [];
  const taken = new Set<string>();
  // Why a function is turned away does not depend on which seed led to it, so it is counted once:
  // a function several seeds reach was otherwise listed once per seed.
  const turnedAway = new Set<string>();
  const callsChanged: string[] = [];
  const cut: string[] = [];
  const notResultSiblings: string[] = [];
  const overCap: string[] = [];
  const unreadable = new Set<string>();
  for (const seed of seeds) {
    const { hits } = await discoverer.search(seed.name);
    const lines = new Map<string, number[]>();
    for (const hit of hits) {
      if (isTestPath(hit.path) || !isRust(hit.path)) continue;
      lines.set(hit.path, [...(lines.get(hit.path) ?? []), hit.line]);
    }
    for (const [path, hitLines] of lines) {
      const listing = await files.of(path);
      if (!listing) {
        unreadable.add(path);
        continue;
      }
      for (const fn of listing.functions) {
        if (fn.name === seed.name || known.has(fn.id) || taken.has(fn.id) || turnedAway.has(fn.id)) continue;
        const turnAway = (into: string[]) => {
          into.push(fn.name);
          turnedAway.add(fn.id);
        };
        if (fn.callsCut) {
          // What it calls is not fully known: neither a call to the seed nor one to a changed
          // function can be ruled out.
          if (hitLines.some((l) => l >= fn.startLine && l <= fn.endLine)) turnAway(cut);
          continue;
        }
        const calls = listing.calls.filter((c) => c.functionId === fn.id);
        const tying = calls.filter((c) => bareName(c.callee) === seed.name);
        if (tying.length === 0) continue;
        if (calls.some((c) => ruling.has(bareName(c.callee)))) {
          turnAway(callsChanged);
          continue;
        }
        if (!RETURNS_RESULT.test(fn.signature)) {
          turnAway(notResultSiblings);
          continue;
        }
        if (siblings.length >= MAX_SIBLINGS) {
          turnAway(overCap);
          continue;
        }
        taken.add(fn.id);
        siblings.push({ fn, candidates: listing, seed: seed.name, tying });
      }
    }
  }

  if (callsChanged.length > 0) notes.push(`siblings: ${named("functions call a seed and also call a changed function, so they are not siblings; they are read one hop out unless that search's own caps left them out (see its notes)", callsChanged)}`);
  if (cut.length > 0) notes.push(`siblings: ${named("functions mention a seed but had their call list cut, so whether they call it is not known", cut)}`);
  if (notResultSiblings.length > 0) notes.push(`siblings: ${named("functions call a seed but return no Result, so nothing about them can be asked", notResultSiblings)}`);
  if (overCap.length > 0) notes.push(`siblings: ${named(`more siblings were found than the cap of ${MAX_SIBLINGS} allows`, overCap)}`);
  if (unreadable.size > 0) notes.push(`siblings: ${named("files mentioning a seed could not be read here", [...unreadable])}`);

  return { seeds, siblings, notes };
}
