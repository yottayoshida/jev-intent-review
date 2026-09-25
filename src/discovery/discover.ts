// Reading the repository after the change: whole-word searches and per-file block indexes, cached,
// limited to the files the configuration lets us read.
//
// The repository-wide discovery that used to live here — references to the calls the changed code
// makes, the requirement's words, the callers of a wrapper, a ranked and capped candidate list —
// went with the generic run (ADR 0007). What the local check needs is the two primitives below and
// the changed lines of the diff.
//
// Only fixed-string, whole-word searches of the after commit; words that could be read as options
// or that are too short or too common are refused and recorded, never rewritten.

import { BlockIndex } from "../change/blocks.ts";
import type { ChangeAnalysis } from "../change/seeds.ts";
import { isSensitivePath } from "../evidence/redact.ts";
import type { Git, GrepHit } from "../repository/git.ts";

export interface DiscoveryOptions {
  include: (path: string) => boolean;
  /** Read by the generic run, which is gone. Accepted so that older call sites still compile. */
  maxCandidates?: number;
  lexicalSearch?: boolean;
  referenceSearch?: boolean;
}

const HITS_PER_SEARCH = 200;

const WORD = /^[\p{L}_$][\p{L}\p{N}_$.-]*$/u;
export const STOP_WORDS = new Set(
  "about above after again against all also and any are because been before being below between both but can cannot could did does doing down during each every few for from further had has have having here how into its itself just more most must need never not now off once only other our out over own same should some such than that the their them then there these they this those through too under until upon very was were what when where which while who whom why will with within without would you your".split(" "),
);

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

type Hit = GrepHit;

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
      index = this.#allowed(path) ? this.#git.readText(this.#after, path).then((text) => (text === null ? null : new BlockIndex(text.split("\n"), { path }))) : Promise.resolve(null);
      this.#indexes.set(path, index);
    }
    return index;
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
}
