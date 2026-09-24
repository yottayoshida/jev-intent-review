// Past the changed functions: the other callers of what the changed code calls (ADR 0005).
//
// The change's own functions and their callers one hop out cannot reach the case the README opens
// with — "a new rule may be implemented in one API path but missed in another". The path that was
// missed uses the same helper as the one that was fixed, and calls nothing the pull request
// touched. What ties the two is the helper, so the helper is the seed.
//
// A seed is a function of this repository that the changed code calls outside tests — on a line it
// added or kept, or on one it removed — and that returns a `Result`, and is not itself a changed
// function. Where a call settles, and whether what it reaches returns a `Result`, is decided by
// the same reading that decides whether a call can be asked about (`calleeOf`, `targetOf`): a
// second reading here would take seeds that one does not ask about, and drop ones it does.
// Seeds are taken in this order: called on a changed line, called from more changed functions,
// used in fewer files, then by name. Rarest first — the ordinary review's order — cannot reach a
// shared helper, which by definition is used in many files: measured on a real pull request, the
// helper came 83rd of 125.
//
// A sibling is a function outside tests, not already read, whose own call list has a call that
// settles at a seed; that returns a `Result`; and none of whose calls settles at a changed
// function — nor, by a changed function's name, settles nowhere, since such a call may be the one
// that reaches it. It is decided from `enumerate`'s calls and not from a search hit, which lands on
// comments and strings as readily as on calls.
//
// Every name that could not be tied, and every function turned away, is counted in the notes, by
// reason: that record is what says whether a parser is needed.

import { calledNames, type ChangeAnalysis } from "../change/seeds.ts";
import { isTestPath, refuseWord, type Discoverer } from "../discovery/discover.ts";
import { redact } from "../evidence/redact.ts";
import { calleeOf, functionDefinitionsOf, targetOf, type CalleeLocation } from "./applicability.ts";
import type { CallCandidate, Candidates, FunctionCandidate } from "./candidates.ts";
import { COMMON_FILES, isRust, type CandidateFiles } from "./from-diff.ts";
import { returnTypesFor } from "./result-type.ts";

/** How many seeds are followed. */
export const MAX_SEEDS = 8;
/** How many functions may be siblings, over every seed. */
export const MAX_SIBLINGS = 20;
/** How many names a note shows before it only counts. */
const SHOWN = 5;

export interface Seed {
  name: string;
  onChangedLine: boolean;
  /** How many changed functions outside tests call it, counting a removed line's once. */
  regions: number;
  /** How many files outside tests mention it. */
  files: number;
  /** Where its one definition is: `path:line`. */
  definedAt: string;
}

export interface Sibling {
  fn: FunctionCandidate;
  candidates: Candidates;
  /** The seed that tied it. */
  seed: string;
  /** Its calls that settle at that seed: the ones a missed path's defect sits at. */
  tying: CallCandidate[];
}

export interface SiblingSet {
  seeds: Seed[];
  siblings: Sibling[];
  notes: string[];
  /**
   * The notes that say something was not read or not followed — a cap, a file that could not be
   * read, a search that was refused — as against those that only explain (#38). A run with one
   * never reads as having checked everything.
   */
  unreached: string[];
}

/** A function the change touched, by where it is: a callee settled inside one is a changed function. */
export interface ChangedSpan {
  name: string;
  path: string;
  startLine: number;
  endLine: number;
}

/** A changed function the listing read, with its calls: where the seeds come from. */
export interface ChangedSite {
  fn: FunctionCandidate;
  candidates: Candidates;
}

const bareName = (callee: string) => callee.split("::").pop()!;
const inSpan = (at: CalleeLocation, spans: readonly ChangedSpan[]) =>
  at !== null && at.kind !== "outside" && spans.some((s) => s.path === at.path && at.line >= s.startLine && at.line <= s.endLine);

/** A note about names: the count, and the first few, redacted. */
function named(count: string, names: readonly string[]): string {
  const shown = names.slice(0, SHOWN).map((n) => redact(n).text);
  return `${names.length} ${count}: ${shown.join(", ")}${names.length > SHOWN ? `, and ${names.length - SHOWN} more` : ""}`;
}

/**
 * The siblings of a change, at the after commit.
 *
 * `changedSites` are the changed functions the one-hop listing read, outside tests. `known` holds
 * the ids of every function the change already reached (changed, or calling a changed one): they
 * keep that label. The spans of changed functions are taken from the change's regions, so a
 * changed function past the listing's cap is still one.
 */
export async function siblingsOf(files: CandidateFiles, discoverer: Discoverer, change: ChangeAnalysis, changedSites: readonly ChangedSite[], known: ReadonlySet<string>): Promise<SiblingSet> {
  const notes: string[] = [];
  const unreached: string[] = [];
  const left = (note: string) => {
    notes.push(note);
    unreached.push(note);
  };
  const spans: ChangedSpan[] = [];
  const changedNames = new Set<string>();
  const removedNames = new Set<string>();
  const onChanged = new Set<string>();
  const inTests = new Set<string>();
  for (const region of change.regions) {
    if (!region.code || !isRust(region.path)) continue;
    const index = await discoverer.index(region.path);
    const test = isTestPath(region.path) || (index?.testRegions.some((r) => region.block.startLine >= r.start && region.block.startLine <= r.end) ?? false);
    const names = new Set([...calledNames(region.added.join("\n")), ...calledNames(region.removed.join("\n"))]);
    if (test) {
      for (const n of names) inTests.add(n);
      continue;
    }
    if (region.block.name) {
      changedNames.add(region.block.name);
      spans.push({ name: region.block.name, path: region.path, startLine: region.block.startLine, endLine: region.block.endLine });
    }
    for (const n of calledNames(region.added.join("\n"))) onChanged.add(n);
    for (const n of calledNames(region.removed.join("\n"))) {
      removedNames.add(n);
      onChanged.add(n);
    }
  }
  for (const { fn } of changedSites) {
    changedNames.add(fn.name);
    spans.push({ name: fn.name, path: fn.path, startLine: fn.startLine, endLine: fn.endLine });
  }

  // The names the changed code calls, each settled once: by a call the listing read where there is
  // one, by the name alone where only a removed line held it.
  const settled = new Map<string, { at: CalleeLocation; returns: boolean; regions: number }>();
  for (const { fn, candidates } of changedSites) {
    const seen = new Set<string>();
    for (const call of candidates.calls.filter((c) => c.functionId === fn.id)) {
      const name = bareName(call.callee);
      if (seen.has(name)) continue;
      seen.add(name);
      const prior = settled.get(name);
      if (prior) {
        prior.regions += 1;
        continue;
      }
      const { result, at } = await calleeOf(discoverer, fn, call);
      settled.set(name, { at, returns: result.ok, regions: 1 });
    }
  }
  const reader = returnTypesFor(discoverer);
  for (const name of removedNames) {
    if (settled.has(name)) continue;
    const { found, more } = await functionDefinitionsOf(discoverer, name);
    if (more || found.length !== 1) {
      settled.set(name, { at: null, returns: false, regions: 1 });
      continue;
    }
    const def = found[0]!;
    const reading = await reader.at(def.path, def.line, name);
    settled.set(name, { at: { kind: "repository", path: def.path, line: def.line }, returns: reading.kind !== "not" && reading.kind !== "unknown", regions: 1 });
  }

  const refused: string[] = [];
  const changedFns: string[] = [];
  const unsettled: string[] = [];
  const outside: string[] = [];
  const versions: string[] = [];
  const notResult: string[] = [];
  const common: string[] = [];
  const beyondSearch: string[] = [];
  const candidates: Seed[] = [];
  for (const [name, entry] of [...settled.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (refuseWord(name, 3)) {
      refused.push(name);
      continue;
    }
    const at = entry.at;
    if (at === null) {
      unsettled.push(name);
      continue;
    }
    if (at.kind === "outside") {
      outside.push(name);
      continue;
    }
    if (inSpan(at, spans)) {
      changedFns.push(name);
      continue;
    }
    if (at.kind === "versions") {
      versions.push(name);
      continue;
    }
    if (!entry.returns) {
      notResult.push(name);
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
    candidates.push({ name, onChangedLine: onChanged.has(name), regions: entry.regions, files: spread, definedAt: `${at.path}:${at.line}` });
  }
  const onlyInTests = [...inTests].filter((n) => !settled.has(n)).sort();

  candidates.sort((a, b) => Number(b.onChangedLine) - Number(a.onChangedLine) || b.regions - a.regions || a.files - b.files || a.name.localeCompare(b.name));
  const seeds = candidates.slice(0, MAX_SEEDS);
  const leftOut = candidates.slice(MAX_SEEDS).map((s) => s.name);

  if (unsettled.length > 0) left(`siblings: ${named("names the changed code calls settle at no one definition here, so what they reach is not established", unsettled)}`);
  if (outside.length > 0) left(`siblings: ${named("names the changed code calls are functions outside this repository, whose other callers are not read", outside)}`);
  if (versions.length > 0) left(`siblings: ${named("names the changed code calls are one thing written several times (a trait's method, or a function per platform), whose callers are not read as siblings", versions)}`);
  if (notResult.length > 0) notes.push(`siblings: ${named("names the changed code calls do not return a Result, or what they return is not settled here", notResult)}`);
  if (changedFns.length > 0) notes.push(`siblings: ${named("names the changed code calls are changed functions, whose callers are read one hop out unless that search's own caps left them out (see its notes)", changedFns)}`);
  if (onlyInTests.length > 0) notes.push(`siblings: ${named("names are called only in the change's tests", onlyInTests)}`);
  if (common.length > 0) left(`siblings: ${named(`names are used in more than ${COMMON_FILES} files and were not followed`, common)}`);
  if (beyondSearch.length > 0) left(`siblings: ${named("names have more references than the search returns and were not followed", beyondSearch)}`);
  if (refused.length > 0) left(`siblings: ${named("names could not be searched", refused)}`);
  if (leftOut.length > 0) left(`siblings: ${named(`seeds over the cap of ${MAX_SEEDS} were not followed`, leftOut)}`);

  const siblings: Sibling[] = [];
  const taken = new Set<string>();
  // Why a function is turned away does not depend on which seed led to it, so it is counted once.
  const turnedAway = new Set<string>();
  const callsChanged: string[] = [];
  const mayCallChanged: string[] = [];
  const cut: string[] = [];
  const notResultSiblings: string[] = [];
  const overCap: string[] = [];
  const unreadable = new Set<string>();
  /** Files read for the siblings whose listing's cap left calls out, with how many. */
  const capped = new Map<string, number>();
  for (const seed of seeds) {
    const { hits } = await discoverer.search(seed.name);
    const lines = new Map<string, number[]>();
    for (const hit of hits) {
      if (isTestPath(hit.path) || !isRust(hit.path)) continue;
      lines.set(hit.path, [...(lines.get(hit.path) ?? []), hit.line]);
    }
    for (const [path, hitLines] of lines) {
      const listing = await files.of(path);
      const index = await discoverer.index(path);
      if (!listing || !index) {
        unreadable.add(path);
        continue;
      }
      // The listing's own caps, counted here as the one-hop search counts them for its files: a file
      // opened only for the siblings would otherwise be short without a word (#38).
      if (listing.omitted.calls > 0) capped.set(path, listing.omitted.calls);
      for (const fn of listing.functions) {
        if (`${fn.path}:${fn.startLine}` === seed.definedAt || known.has(fn.id) || taken.has(fn.id) || turnedAway.has(fn.id)) continue;
        if (index.testRegions.some((r) => fn.startLine >= r.start && fn.startLine <= r.end)) continue;
        // A changed function the one-hop listing's caps left out is not in `known`, and is still
        // changed: it is no sibling, whatever it calls.
        if (inSpan({ kind: "repository", path: fn.path, line: fn.startLine }, spans)) continue;
        const turnAway = (into: string[]) => {
          into.push(fn.name);
          turnedAway.add(fn.id);
        };
        const calls = listing.calls.filter((c) => c.functionId === fn.id);
        if (fn.callsCut) {
          // What it calls is not fully known: neither a call to the seed nor one to a changed
          // function can be ruled out.
          if (hitLines.some((l) => l >= fn.startLine && l <= fn.endLine)) turnAway(cut);
          continue;
        }
        const tying: CallCandidate[] = [];
        for (const call of calls.filter((c) => bareName(c.callee) === seed.name)) {
          const { at } = await calleeOf(discoverer, fn, call);
          if (at !== null && at.kind === "repository" && `${at.path}:${at.line}` === seed.definedAt) tying.push(call);
        }
        if (tying.length === 0) continue;
        let reachesChanged = false;
        let mayReachChanged = false;
        for (const call of calls.filter((c) => changedNames.has(bareName(c.callee)))) {
          const { at } = await calleeOf(discoverer, fn, call);
          if (inSpan(at, spans)) reachesChanged = true;
          else if (at === null) mayReachChanged = true;
        }
        if (reachesChanged) {
          turnAway(callsChanged);
          continue;
        }
        if (mayReachChanged) {
          turnAway(mayCallChanged);
          continue;
        }
        if ((await targetOf(discoverer, fn)) !== null) {
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
  if (mayCallChanged.length > 0) left(`siblings: ${named("functions call a seed and also call a changed function's name that settles nowhere here, so whether they call it is not known and they are not siblings", mayCallChanged)}`);
  if (cut.length > 0) left(`siblings: ${named("functions mention a seed but had their call list cut, so whether they call it is not known", cut)}`);
  if (notResultSiblings.length > 0) notes.push(`siblings: ${named("functions call a seed but do not return a Result, or what they return is not settled here, so nothing about them can be asked", notResultSiblings)}`);
  if (overCap.length > 0) left(`siblings: ${named(`more siblings were found than the cap of ${MAX_SIBLINGS} allows`, overCap)}`);
  if (unreadable.size > 0) left(`siblings: ${named("files mentioning a seed could not be read here", [...unreadable])}`);
  for (const [path, n] of capped) left(`siblings: ${path}: ${n} calls were left out of the listing by its cap`);

  return { seeds, siblings, notes, unreached };
}
