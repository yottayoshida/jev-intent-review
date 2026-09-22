// How the sentence-choice bench is scored and decided, fixed before any label or answer (#40, part 2).
//
//   node bench/sentence-choice/rules.ts           rewrite rules.json from units.json
//   node bench/sentence-choice/rules.ts --check   exit 1 if rules.json is not what units.json gives
//
// rules.json holds, as data: the bar a choice has to clear, the number of runs, how precision and
// recall are bounded, the rule that decides whether Jev's choosing goes into the product, the
// model-free rule it is compared with, how the labels are made from independent annotators, and the
// order the units are given to them in. replay.ts reads it and nothing else for these; changing any
// of them after the labels exist is a new measurement.
//
// The labels are not a person's. The maintainer asked that Claude label the sentences rather than
// label them by hand; so three annotators, each a fresh Claude with no knowledge of the others or of
// Jev's answers (none existed), label every unit from the same definitions and the same context Jev
// is shown, and the label is the one at least two of them gave.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Unit } from "./units.ts";

const HERE = import.meta.dirname;

/** A small seeded generator (mulberry32): the same seed gives the same order on any machine. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const next = random(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export const ORDER_SEED = 40;

export function buildRules(units: readonly Unit[]) {
  const ids = units.map((u) => u.id);
  return {
    version: 1,
    // A choice is Jev's answer `required_behavior` with a probability of at least this.
    bar: 0.6,
    runs: 3,
    positive: "required_behavior",
    labels: ["required_behavior", "non_goal", "neither", "cannot_tell", "not_a_sentence"],
    // Precision counts every sentence Jev chose; these labels count as wrong when chosen. The
    // lenient figure, which leaves them out, is shown beside it and decides nothing.
    notCounted: ["cannot_tell", "not_a_sentence"],
    interval: { method: "wilson", level: 0.95, z: 1.959963984540054 },
    gate: {
      precision: 0.8,
      recall: 0.4,
      adopt: "in every run, the lower bound of precision is at least `precision` and the lower bound of recall is at least `recall`",
      reject: "in every run, the upper bound of precision is below `precision` or the upper bound of recall is below `recall`",
      otherwise: "undetermined, taken as not adopted; there is no second measurement on this corpus",
    },
    // Model-free: a unit is chosen when its heading, or the sentence itself, matches.
    baseline: { heading: "\\b(?:expect|solution|fix|propos|suggest|should)", sentence: "\\b(?:should|must|expected to)\\b", flags: "i" },
    // Each unit's label is the one at least `majority` of `count` annotators gave; with none, it is
    // `noMajority`, which counts against Jev when Jev chooses the unit.
    annotators: { count: 3, majority: 2, noMajority: "cannot_tell" },
    // The order the units are given to the annotators in: shuffled across issues, so no annotator
    // reads an issue's sentences one after another and builds up more than the unit shows.
    order: { seed: ORDER_SEED, ids: shuffled(ids, ORDER_SEED) },
  };
}

export type Rules = ReturnType<typeof buildRules>;

if (import.meta.url === `file://${process.argv[1]}`) {
  const units = JSON.parse(readFileSync(join(HERE, "units.json"), "utf8")) as Unit[];
  const text = `${JSON.stringify(buildRules(units), null, 1)}\n`;
  const path = join(HERE, "rules.json");
  if (process.argv.includes("--check")) {
    const same = readFileSync(path, "utf8") === text;
    console.log(same ? "rules.json is what units.json gives" : "rules.json differs from what units.json gives");
    process.exitCode = same ? 0 : 1;
  } else {
    writeFileSync(path, text);
    console.log(`rules.json: ${units.length} units in order`);
  }
}
