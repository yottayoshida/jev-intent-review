// The candidates the change itself offers: the functions holding changed lines, and one hop out,
// the functions that call them.
//
// This is the tool's founding idea put back where it belongs. The ordinary review already starts
// from the diff; the experimental local check did not — it opened files by the requirement's own
// words, and a requirement names the symptom ("a FIFO, a directory or a symlink") while the fix is
// a shared helper the sentence never mentions. Measured on a real pull request: the words opened
// two files, neither of which held the changed call, on both the shipped and the mutated branch.
//
// A changed line is a lead, not a verdict. Nothing here says a requirement applies to a function;
// it says the change was done here, which is where to look first. Whether a requirement governs a
// call is the planner's clause, and it is kept separate all the way to the report.
//
// One hop out because a change often protects its callers: the guard goes into the helper, and the
// functions that call the helper are where the behaviour the requirement describes is observed.

import { isTestPath, refuseWord, type Discoverer } from "../discovery/discover.ts";
import { declaredForTestsOnly } from "./applicability.ts";
import { emptyCandidates, enumerate, type Candidates } from "./candidates.ts";
import type { SiteSource } from "./select.ts";

/** How many functions the changed lines may contribute. */
const MAX_CHANGED_FUNCTIONS = 40;
/** How many changed functions have their callers looked up. */
const MAX_HOP_NAMES = 12;
/** How many caller functions the hop may contribute. */
const MAX_CALLER_FUNCTIONS = 20;
/**
 * A name referenced from more files than this is infrastructure rather than the thing the change
 * protects, and its callers are not a lead. `Discoverer` draws the same line at 40 for the whole
 * review; here the hop is one of several finders, so it is drawn tighter.
 */
export const COMMON_FILES = 20;

/**
 * The listing of a file at the after commit, from the reading its `BlockIndex` already holds, so a
 * file is parsed once (#83). A file a parent declares `#[cfg(test)] mod …;` lists nothing: it is test
 * code, and the listing leaves test code out as it does a `#[cfg(test)]` block inside a file.
 */
export async function readListing(discoverer: Discoverer, path: string): Promise<Candidates | null> {
  const index = await discoverer.index(path);
  if (index === null) return null;
  if (await declaredForTestsOnly(discoverer, path, { forListing: true })) return emptyCandidates(path);
  return enumerate(path, index.lines.join("\n"), index.rust ? { parsed: index.rust } : {});
}

/** `enumerate` for a path at one commit, read once. Shared with whatever else opens the file. */
export class CandidateFiles {
  readonly #discoverer: Discoverer;
  readonly #cache = new Map<string, Promise<Candidates | null>>();

  constructor(discoverer: Discoverer) {
    this.#discoverer = discoverer;
  }

  of(path: string): Promise<Candidates | null> {
    let entry = this.#cache.get(path);
    if (!entry) {
      entry = readListing(this.#discoverer, path);
      this.#cache.set(path, entry);
    }
    return entry;
  }
}

export interface ChangeSites {
  /** One entry per file the change reached, keyed by path. */
  sources: Map<string, SiteSource>;
  /** What was not followed, and why. Never a silent cap. */
  notes: string[];
  /**
   * The notes that say something was not read or not followed — a cap, a file that could not be
   * read, a search that was refused — as against those that only explain (#38). A run with one
   * never reads as having checked everything.
   */
  unreached: string[];
}

export const isRust = (path: string) => path.endsWith(".rs");

/**
 * The sources the change contributes, at the after commit.
 *
 * `changedLines` is `Discoverer.changedLines(change)`: the lines the diff touched, per path, at
 * the after commit. It is passed rather than the analysis so a caller that already has it — every
 * caller does — does not compute it twice.
 */
export async function sitesFromChange(files: CandidateFiles, discoverer: Discoverer, changedLines: ReadonlyMap<string, ReadonlySet<number>>): Promise<ChangeSites> {
  const sources = new Map<string, SiteSource>();
  const notes: string[] = [];
  const unreached: string[] = [];
  // Every note this path writes says something was not read or not followed.
  const left = (note: string) => {
    notes.push(note);
    unreached.push(note);
  };

  const sourceFor = async (path: string): Promise<SiteSource | null> => {
    const existing = sources.get(path);
    if (existing) return existing;
    const candidates = await files.of(path);
    if (!candidates) return null;
    // `enumerate`'s own caps. They are counted there and were read nowhere: a listing short by
    // twenty calls looks exactly like a file that has twenty fewer.
    const { functions: fnCap, calls: callCap } = candidates.omitted;
    if (fnCap > 0) left(`${path}: ${fnCap} functions were left out of the listing by its cap`);
    if (callCap > 0) left(`${path}: ${callCap} calls were left out of the listing by its cap`);
    // What the parser could not read is not listed (#83): said the way a cap is, since calls may be
    // there that nothing asks about. The macros whose arguments are not read are only counted: their
    // calls were never promised (ADR 0022), and a count does not make a run look unread.
    const { unreadLines, macros } = candidates.omitted;
    if (unreadLines > 0) left(`${path}: ${unreadLines} lines the parser could not read were left out of the listing`);
    if (macros > 0) notes.push(`${path}: ${macros} macro invocations whose arguments were not read as code (nor any function defined inside them)`);
    const fresh: SiteSource = { candidates, changed: [], callsChanged: [] };
    sources.set(path, fresh);
    return fresh;
  };

  // The functions holding changed lines.
  const changedFunctions: { name: string; path: string }[] = [];
  let notRust = 0;
  let unreadable = 0;
  let overCap = 0;
  for (const [path, lines] of [...changedLines.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!isRust(path)) {
      notRust += 1;
      continue;
    }
    const source = await sourceFor(path);
    if (!source) {
      unreadable += 1;
      continue;
    }
    for (const fn of source.candidates.functions) {
      let touched = false;
      for (let l = fn.startLine; l <= fn.endLine && !touched; l++) touched = lines.has(l);
      if (!touched) continue;
      if (changedFunctions.length >= MAX_CHANGED_FUNCTIONS) {
        overCap += 1;
        continue;
      }
      (source.changed as string[]).push(fn.id);
      changedFunctions.push({ name: fn.name, path: fn.path });
    }
  }
  if (notRust > 0) left(`${notRust} changed files are not Rust and were not read for candidates (this path reads Rust)`);
  if (unreadable > 0) left(`${unreadable} changed files could not be read at this commit`);
  if (overCap > 0) left(`${overCap} more changed functions were found than the cap of ${MAX_CHANGED_FUNCTIONS} allows`);

  // One hop: the functions that call a changed one.
  let callers = 0;
  let dropped = 0;
  let outsideAnyFunction = 0;
  const unreadableCallers = new Set<string>();
  const names = [...new Map(changedFunctions.map((f) => [f.name, f])).values()];
  for (const [i, fn] of names.entries()) {
    if (i >= MAX_HOP_NAMES) {
      left(`only the first ${MAX_HOP_NAMES} of ${names.length} changed functions had their callers looked up`);
      break;
    }
    const refused = refuseWord(fn.name, 3);
    if (refused) {
      left(`the callers of ${fn.name} could not be searched (${refused})`);
      continue;
    }
    const { hits, more } = await discoverer.search(fn.name);
    const outside = hits.filter((h) => !isTestPath(h.path) && isRust(h.path));
    const spread = new Set(outside.map((h) => h.path)).size;
    if (more || spread > COMMON_FILES) {
      left(`the callers of ${fn.name} were not followed (${more ? "more references than the search returns" : `referenced from ${spread} files outside tests`})`);
      continue;
    }
    for (const hit of outside) {
      // Test code by a parent's declaration (#83) is left out as a test path is: its listing is empty,
      // and a caller there is no caller the requirement governs.
      if (await declaredForTestsOnly(discoverer, hit.path, { forListing: true })) continue;
      const source = await sourceFor(hit.path);
      if (!source) {
        unreadableCallers.add(hit.path);
        continue;
      }
      const enclosing = source.candidates.functions.find((f) => hit.line >= f.startLine && hit.line <= f.endLine);
      if (!enclosing) {
        // A `use` line or a module-level item is a reference and not a call site — but so is a
        // hit in anything `enumerate` did not list: a macro body outside a function, a function past
        // the cap, a place the parser could not read. They are counted rather than described,
        // because from here they look alike.
        outsideAnyFunction += 1;
        continue;
      }
      if (enclosing.name === fn.name) continue; // its own definition
      if (source.changed?.includes(enclosing.id) || source.callsChanged?.includes(enclosing.id)) continue;
      if (callers >= MAX_CALLER_FUNCTIONS) {
        dropped += 1;
        continue;
      }
      (source.callsChanged as string[]).push(enclosing.id);
      callers += 1;
    }
  }
  if (dropped > 0) left(`${dropped} more callers were found than the cap of ${MAX_CALLER_FUNCTIONS} functions allows`);
  if (outsideAnyFunction > 0) left(`${outsideAnyFunction} references to a changed function are in no function this reads (a use line, a macro body, a function past the cap)`);
  if (unreadableCallers.size > 0) left(`${unreadableCallers.size} files referencing a changed function could not be read here: ${[...unreadableCallers].slice(0, 5).join(", ")}`);

  return { sources, notes, unreached };
}
