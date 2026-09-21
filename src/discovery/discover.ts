// Finding the places a requirement applies to (spec §12-13), in the repository after the change.
//
// Layer A→C: the calls made around the changed lines are what the change protects (a guard added
// before `createSession`); every other reference to them is a place the same guard may be missing.
// Layer B: the requirement's own words, its search hints, and identifiers written on the changed
// lines (`disabledAt`) find places that enforce or mention the same thing.
// Layer D (relevance) is asked of Jev together with satisfaction, after this list is capped.
//
// Only fixed-string, whole-word searches of the after commit; words that could be read as options
// or that are too short or too common are refused and recorded, never rewritten.

import { BlockIndex, defines } from "../change/blocks.ts";
import { isCode, type ChangeAnalysis } from "../change/seeds.ts";
import { isSensitivePath, redact } from "../evidence/redact.ts";
import type { Git, GrepHit } from "../repository/git.ts";
import { locationKey, type Candidate, type Requirement, type SearchRecord } from "../types.ts";

export interface DiscoveryOptions {
  include: (path: string) => boolean;
  maxCandidates: number;
  lexicalSearch: boolean;
  referenceSearch: boolean;
}

/**
 * What the search offered, and what it left. The three lists are kept apart because they do not
 * weigh the same: a lead the search declined to follow (a name too common to be the action a
 * requirement governs) and places found with no budget left to judge are scope — reported, and
 * handed to the completeness question. `blocking` is a path the search knows by name and never
 * judged, which withholds VERIFIED whatever the answers say.
 */
export interface Discovery {
  candidates: Candidate[];
  searches: SearchRecord[];
  found: number; // places offered before the cap
  notFollowed: string[];
  unjudged: string[];
  blocking: string[];
}

const HITS_PER_SEARCH = 200;
const MAX_SEEDS = 8;
const MAX_TERMS = 8;
// A symbol referenced from more files than this is infrastructure (a logger, a base class), not
// the action a requirement governs.
const COMMON_FILES = 40;

const WORD = /^[\p{L}_$][\p{L}\p{N}_$.-]*$/u;
const STOP_WORDS = new Set(
  "about above after again against all also and any are because been before being below between both but can cannot could did does doing down during each every few for from further had has have having here how into its itself just more most must need never not now off once only other our out over own same should some such than that the their them then there these they this those through too under until upon very was were what when where which while who whom why will with within without would you your".split(" "),
);
// A declaration that runs nothing (an interface, a type, a struct): a place a requirement about
// data or an interface can hold, but not one where a behavior happens. Measured: Jev answered
// `violates` (0.98) for a TypeScript interface listing a function among its fields.
const DECLARATION = /^\s*(?:export\s+)?(?:pub(?:\([\w:]+\))?\s+)?(?:declare\s+)?(?:interface|type|enum|struct|trait|union)\s+[\w$]+/;

// `new AuthError(...)` in a changed function is the guard's way out, and its other uses are every
// error site of the same kind. Measured on the missed-path fixture: following it brought in a
// helper that only throws on a failed exchange, and that alone withheld VERIFIED.
const ERROR_TYPE = /^[A-Z][\w$]*(Error|Exception)$/;

/** A line that only brings a name into scope: a reference, but not a place anything happens. */
export const IMPORT_LINE = /^\s*(import\b|export\s+\{[^}]*\}\s+from\b|from\s+\S+\s+import\b|use\s|using\s|#include\b|require\(|const\s+\{[^}]*\}\s*=\s*require\()/;

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|spec|__tests__|testdata|fixtures)\//i.test(path) || /[._-](test|spec)\.[a-z]+$/i.test(path) || /_test\.[a-z]+$/.test(path);
}

/**
 * Why a search word is refused, or null when it may be searched. Names of calls may be as short
 * as three characters (`pay`, `run`); free words need four to narrow anything.
 */
export function refuseWord(word: string, minLength = 4): string | null {
  if (word.startsWith("-")) return "starts with '-'";
  if (word.length < minLength) return `shorter than ${minLength} characters`;
  if (word.length > 80) return "longer than 80 characters";
  if (!WORD.test(word)) return "not a single word";
  return null;
}

/** Words of the requirement worth searching for: five letters or more, not common English. */
export function requirementWords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 5 && !STOP_WORDS.has(w)))];
}

type Hit = GrepHit;

/** How many files outside tests the hits are in: what "too common" is measured on. */
function filesOutsideTests(hits: readonly Hit[]): number {
  return new Set(hits.filter((h) => !isTestPath(h.path)).map((h) => h.path)).size;
}

export class Discoverer {
  readonly #git: Git;
  readonly #after: string;
  readonly #options: DiscoveryOptions;
  readonly #grepCache = new Map<string, Promise<{ hits: Hit[]; more: boolean }>>();
  readonly #indexes = new Map<string, Promise<BlockIndex | null>>();

  constructor(git: Git, after: string, options: DiscoveryOptions) {
    this.#git = git;
    this.#after = after;
    this.#options = options;
  }

  #allowed(path: string): boolean {
    return this.#options.include(path) && !isSensitivePath(path);
  }

  /** Whole-word search, cached, limited to files the configuration lets us read. */
  search(word: string): Promise<{ hits: Hit[]; more: boolean }> {
    let result = this.#grepCache.get(word);
    if (!result) {
      result = this.#git.grep(this.#after, word, { word: true, limit: HITS_PER_SEARCH }).then(({ hits, more }) => ({
        hits: hits.filter((h) => this.#allowed(h.path)),
        more,
      }));
      this.#grepCache.set(word, result);
    }
    return result;
  }

  /**
   * The file's blocks, cached, or null — including for a path the configuration or the name rules
   * exclude.
   *
   * `redact.ts` states it as an invariant: files are excluded by name before they are read. That
   * held because every path reaching here had come through `search`, which filters. It stopped
   * holding when a path could arrive from the diff instead, which is filtered by the
   * configuration's include list alone. Refusing here makes it true of every caller rather than of
   * the callers that happen to come the long way round.
   */
  index(path: string): Promise<BlockIndex | null> {
    let index = this.#indexes.get(path);
    if (!index) {
      index = this.#allowed(path) ? this.#git.readText(this.#after, path).then((text) => (text === null ? null : new BlockIndex(text.split("\n")))) : Promise.resolve(null);
      this.#indexes.set(path, index);
    }
    return index;
  }

  /**
   * The candidate a search hit stands for: the block around it. Null for a hit that is not a place
   * (an import, the searched name's own definition, a declaration for a behavior), "noncode" for a
   * hit in a file this requirement's kind does not look at.
   *
   * A behavior happens in code. A changelog, a README or an issue template mentions the same
   * words but is not where the requirement can hold or fail (measured on a real pull request:
   * CHANGELOG sections and a YAML issue template filled a quarter of the candidates). Callers
   * count what is skipped this way in the search record.
   */
  async #place(hit: Hit, requirement: Requirement, changedLines: Map<string, Set<number>>, symbol?: string): Promise<Candidate | "noncode" | null> {
    if (IMPORT_LINE.test(hit.text)) return null;
    const anyFile = requirement.kind === "documentation" || requirement.kind === "data" || requirement.kind === "interface";
    if (!anyFile && !isCode(hit.path)) return "noncode";
    if (symbol && defines(hit.text, symbol)) return null; // its definition, not a use
    const index = await this.index(hit.path);
    if (!index) return null;
    const block = index.enclosing(hit.line);
    const behavioral = requirement.kind !== "data" && requirement.kind !== "interface";
    if (behavioral && !block.windowed && DECLARATION.test(index.lines[block.startLine - 1] ?? "")) return null;
    const lines = changedLines.get(hit.path);
    let changed = false;
    if (lines) for (let l = block.startLine; l <= block.endLine && !changed; l++) changed = lines.has(l);
    return {
      path: hit.path,
      startLine: block.startLine,
      endLine: block.endLine,
      ...(block.name ? { symbol: block.name } : {}),
      changed,
      reasons: [],
      ...(block.windowed ? { windowed: true } : {}),
    };
  }

  static changedLines(change: ChangeAnalysis): Map<string, Set<number>> {
    const changedLines = new Map<string, Set<number>>();
    for (const region of change.regions) {
      const set = changedLines.get(region.path) ?? new Set<number>();
      for (const line of region.changedLines) set.add(line);
      changedLines.set(region.path, set);
    }
    return changedLines;
  }

  /**
   * One hop further: the places that call `wrapper`, a candidate Jev judged mere supporting code
   * (a helper around the governed call). Without this, the callers of a wrapper would be left
   * unsearched with nothing to say so. `known` holds the keys of candidates already judged.
   */
  async callersOf(wrapper: Candidate, requirement: Requirement, change: ChangeAnalysis, known: Set<string>, limit: number): Promise<Discovery> {
    const searches: SearchRecord[] = [];
    const notFollowed: string[] = [];
    const blocking: string[] = [];
    const candidates: Candidate[] = [];
    const nothing = () => ({ candidates, searches, found: 0, notFollowed, unjudged: [], blocking });
    const name = wrapper.symbol;
    if (!name) return nothing();
    const refused = refuseWord(name, 3);
    if (refused) {
      searches.push({ requirementId: requirement.id, layer: "C", query: name, hits: 0, rejected: refused });
      notFollowed.push(`the callers of ${name}, judged supporting code, could not be searched (${refused})`);
      return nothing();
    }
    const { hits, more } = await this.search(name);
    const files = filesOutsideTests(hits);
    if (more || files > COMMON_FILES) {
      searches.push({ requirementId: requirement.id, layer: "C", query: name, hits: hits.length, rejected: "too common; its callers were not followed" });
      notFollowed.push(`the callers of ${name}, judged supporting code, were not followed (too common)`);
      return nothing();
    }
    searches.push({ requirementId: requirement.id, layer: "C", query: name, hits: hits.length });
    const changedLines = Discoverer.changedLines(change);
    for (const hit of hits) {
      if (hit.path === wrapper.path && hit.line >= wrapper.startLine && hit.line <= wrapper.endLine) continue;
      const placed = await this.#place(hit, requirement, changedLines, name);
      if (!placed || placed === "noncode") continue;
      const key = locationKey(placed);
      if (known.has(key)) continue;
      known.add(key);
      candidates.push({ ...placed, reasons: [`calls ${name}, which ${wrapper.reasons[0] ?? "is supporting code"}`] });
    }
    // Known by name and not judged: not scope but a gap, whatever the answers elsewhere say.
    if (candidates.length > limit) blocking.push(`${candidates.length} callers of ${name} were found and only ${limit} were judged`);
    return { candidates: candidates.slice(0, limit), searches, found: candidates.length, notFollowed, unjudged: [], blocking };
  }

  async discover(requirement: Requirement, change: ChangeAnalysis): Promise<Discovery> {
    const searches: SearchRecord[] = [];
    const notFollowed: string[] = [];
    const unjudged: string[] = [];
    const found = new Map<string, Candidate & { score: number }>();
    const changedLines = Discoverer.changedLines(change);
    let skippedNonCode = 0;
    const add = async (hit: Hit, reason: string, weight: number, symbol?: string) => {
      const placed = await this.#place(hit, requirement, changedLines, symbol);
      if (placed === "noncode") {
        skippedNonCode += 1;
        return;
      }
      if (!placed) return;
      const key = locationKey(placed);
      let candidate = found.get(key);
      if (!candidate) {
        candidate = { ...placed, score: (placed.changed ? 1 : 0) - (isTestPath(placed.path) ? 2 : 0) };
        found.set(key, candidate);
      }
      if (!candidate.reasons.includes(reason)) {
        candidate.reasons.push(reason);
        candidate.score += weight;
      }
    };

    // Layer A → C: references to every call the changed functions make. Every one, including calls
    // written on the changed lines: a pull request that rewrites `return createSession(...)`, or
    // adds a test calling it, still protects `createSession`, and leaving it out would leave its
    // other callers unsearched with nothing to say so. Anything not followed is recorded in
    // `notFollowed` and travels with the result.
    if (this.#options.referenceSearch) {
      const seeds: { name: string; files: number; hits: Hit[] }[] = [];
      for (const symbol of change.calledSymbols) {
        // Only an error the changed code makes (`throw new AuthError(`) is set aside, by name and
        // by construction: a Go or C# function called `WriteError(w, err)` is an ordinary call.
        if (symbol.constructed && ERROR_TYPE.test(symbol.name)) {
          searches.push({ requirementId: requirement.id, layer: "C", query: symbol.name, hits: 0, rejected: "an error type the changed code throws: how a guard stops a path, not the action it governs" });
          continue;
        }
        const refused = refuseWord(symbol.name, 3);
        if (refused) {
          searches.push({ requirementId: requirement.id, layer: "C", query: symbol.name, hits: 0, rejected: refused });
          notFollowed.push(`the callers of ${symbol.name} could not be searched (${refused})`);
          continue;
        }
        const { hits, more } = await this.search(symbol.name);
        const files = filesOutsideTests(hits);
        // A name used only in tests (an assertion, a mock) has no caller that could be a path.
        if (!more && files === 0) {
          searches.push({ requirementId: requirement.id, layer: "C", query: symbol.name, hits: hits.length, rejected: "used only in tests" });
          continue;
        }
        if (more || files > COMMON_FILES) {
          const why = more ? `more than ${HITS_PER_SEARCH} references` : `referenced from ${files} files outside tests`;
          searches.push({ requirementId: requirement.id, layer: "C", query: symbol.name, hits: hits.length, rejected: `${why}; its callers were not followed` });
          notFollowed.push(`the callers of ${symbol.name} were not followed (${why})`);
          continue;
        }
        seeds.push({ name: symbol.name, files, hits });
      }
      // The rarer a call, the more its callers have in common with the changed one.
      seeds.sort((a, b) => a.files - b.files || a.name.localeCompare(b.name));
      for (const [i, seed] of seeds.entries()) {
        if (i >= MAX_SEEDS) {
          notFollowed.push(`only the ${MAX_SEEDS} least common of ${seeds.length} calls in the changed code were followed`);
          for (const skipped of seeds.slice(MAX_SEEDS)) searches.push({ requirementId: requirement.id, layer: "C", query: skipped.name, hits: skipped.hits.length, rejected: `not followed: only the ${MAX_SEEDS} least common calls are` });
          break;
        }
        const before = skippedNonCode;
        for (const hit of seed.hits) await add(hit, `calls ${seed.name}`, 3, seed.name);
        searches.push({ requirementId: requirement.id, layer: "C", query: seed.name, hits: seed.hits.length, ...(skippedNonCode > before ? { skipped: skippedNonCode - before } : {}) });
      }
    }

    // Layer B: words.
    if (this.#options.lexicalSearch) {
      // Names called on the changed lines are the guard's own parts (a helper, an exception class)
      // and turn up everywhere the guard's kind of code does; the other identifiers there (the
      // field it checks) are what places enforcing the same thing share. The requirement's own
      // words are a fallback for when no search hints were given: they are English, not code.
      const calledOnChange = new Set(change.calledSymbols.filter((s) => s.onChangedLine).map((s) => s.name));
      const fromChange = change.changedIdentifiers.filter((id) => id.length >= 5 && !calledOnChange.has(id));
      const fromText = requirement.searchHints.length > 0 ? [] : requirementWords(requirement.text);
      const terms = [...new Set([...requirement.searchHints, ...fromChange, ...fromText])];
      let used = 0;
      let capped = false;
      for (const term of terms) {
        // A secret-shaped word on a changed line (an access key in a literal) is never searched, and
        // never written into the report's search records or the trace.
        if (redact(term).count > 0) {
          searches.push({ requirementId: requirement.id, layer: "B", query: "[REDACTED]", hits: 0, rejected: "shaped like a secret" });
          continue;
        }
        const refused = refuseWord(term);
        if (refused) {
          searches.push({ requirementId: requirement.id, layer: "B", query: term, hits: 0, rejected: refused });
          continue;
        }
        if (used >= MAX_TERMS) {
          searches.push({ requirementId: requirement.id, layer: "B", query: term, hits: 0, rejected: `not searched: only the first ${MAX_TERMS} words are` });
          if (!capped) notFollowed.push(`only the first ${MAX_TERMS} search words were searched`);
          capped = true;
          continue;
        }
        used += 1;
        const { hits, more } = await this.search(term);
        const files = filesOutsideTests(hits);
        if (more || files > COMMON_FILES) {
          searches.push({ requirementId: requirement.id, layer: "B", query: term, hits: hits.length, rejected: "too common to narrow the search" });
          notFollowed.push(`the word ${term} is too common to search by`);
          continue;
        }
        const before = skippedNonCode;
        for (const hit of hits) await add(hit, `mentions ${term}`, 1);
        searches.push({ requirementId: requirement.id, layer: "B", query: term, hits: hits.length, ...(skippedNonCode > before ? { skipped: skippedNonCode - before } : {}) });
      }
    }

    const ranked = [...found.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
    if (ranked.length > this.#options.maxCandidates) {
      unjudged.push(`${ranked.length} places were found and only the first ${this.#options.maxCandidates} were judged (discovery.max_candidates_per_requirement)`);
    }
    const candidates = ranked.slice(0, this.#options.maxCandidates).map(({ score: _score, ...candidate }) => candidate);
    return { candidates, searches, found: ranked.length, notFollowed, unjudged, blocking: [] };
  }
}
