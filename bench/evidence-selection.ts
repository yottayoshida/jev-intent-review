// Which of the related evidence a question of this kind should carry, and whether the packet has
// what the question needs.
//
// `bench/logs/real-requirement-v3.json` recorded the plan answering `returns_error` about a
// function that returns `Ok`. `bench/logs/real-requirement-v3-diagnostic.json` showed the answer
// changed when the related section was emptied — but emptying it removes four different things at
// once, and the correction in `#16` lists them: the caller, the callee, a test carrying the
// expected result, and that test's duplicate. This file exists to take them out one kind at a
// time.
//
// **Selection removes entries from a packet that was already built. It never rebuilds one.**
// Re-running `buildEvidence` with a smaller budget would let other code into the room that was
// freed, and the comparison would then be between two different collections rather than between
// what was kept. One build, four subsets of it.

import { defines } from "../src/change/blocks.ts";
import { isTestPath } from "../src/discovery/discover.ts";
import type { Related } from "../src/evidence/builder.ts";

/**
 * What one related entry is, decided once per entry and then only filtered on.
 *
 * `test` is the kind the correction found: `realDefinitions` keeps test regions out of the
 * definitions it fetches, but the caller collection (`builder.ts`'s `outside`) filters only the
 * candidate's own lines, definitions and imports — so a call inside `#[cfg(test)] mod tests` comes
 * in, carrying whatever that test asserts.
 */
export type EntryKind = "test" | "needed_callee" | "other";

export interface Classified extends Related {
  kind: EntryKind;
  /** The declared referent this entry defines, when it defines one. */
  defines?: string;
}

/**
 * `inTestRegion` answers whether a line of that file is inside a test region, from the same
 * `BlockIndex.testRegions` the product uses. It is passed in rather than computed here so this
 * file needs no repository.
 */
export function classify(entries: readonly Related[], neededReferents: readonly string[], inTestRegion: (path: string, line: number) => boolean): Classified[] {
  return entries.map((e) => {
    const start = Number(e.lines.split("-")[0]);
    if (isTestPath(e.path) || inTestRegion(e.path, start)) return { ...e, kind: "test" as const };
    const defined = neededReferents.find((name) => e.code.split("\n").some((line) => defines(line, name)));
    return defined ? { ...e, kind: "needed_callee" as const, defines: defined } : { ...e, kind: "other" as const };
  });
}

export const SELECTIONS = {
  /** Everything `buildEvidence` returned. What the first measurement sent. */
  "as-is": (all: readonly Classified[]) => [...all],
  /** The candidate rule: runtime code, no test expectations. */
  "no-tests": (all: readonly Classified[]) => all.filter((e) => e.kind !== "test"),
  /** Only what the question needs to be answerable. Narrower than the candidate rule. */
  "callee-only": (all: readonly Classified[]) => all.filter((e) => e.kind === "needed_callee"),
  /** Diagnostic. Drops the referent the question needs, so it is not a candidate rule. */
  none: (_all: readonly Classified[]) => [] as Classified[],
} as const;

export type SelectionId = keyof typeof SELECTIONS;

/**
 * Whether the packet holds what the question needs, decided locally and before a request.
 *
 * This is the part `canAnswerLocally` in `check-questions-v3.ts` does not do: it allows any cut in
 * the surroundings, on the grounds that what a function returns is in its own body. That is not
 * true here. Reading that a failure of `entries` becomes an `Err` needs `collect_listing`'s
 * behaviour, and a packet without it cannot answer however confident the model is.
 *
 * A referent named more than once in the kept entries is also withheld: two definitions of a name,
 * with no resolution of which one this path reaches, is not one answer.
 */
export function referentsPresent(kept: readonly Classified[], neededReferents: readonly string[]): { ok: boolean; reason?: string } {
  for (const name of neededReferents) {
    const found = kept.filter((e) => e.defines === name || e.code.split("\n").some((line) => defines(line, name)));
    if (found.length === 0) return { ok: false, reason: `the packet does not carry ${name}, which the question needs to be answerable` };
    if (found.length > 1) return { ok: false, reason: `${name} is defined ${found.length} times in the packet; which one this path reaches is not resolved` };
  }
  return { ok: true };
}
