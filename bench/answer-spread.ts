// How much the same question about the same packet moves between runs, counted from records already
// taken. The acceptance bench runs every version three times over the same `(base, head)`, so each
// place was asked once per run with byte-identical input; what differs between the three is the
// endpoint's answer and nothing else. No request is sent here.
//
//   node bench/answer-spread.ts [--log <file>] [--window <n>] [--out <file>]
//
// `--window` is how close to the bar a reading counts as near it (default 0.1, either side).
//
// Counted per place, from `requirements[].observed[]`. NOT from `sent[].packet`: that hash covers a
// requirement and a candidate *function*, so every call in one function shares it and the calls
// cannot be told apart there — counting on it reports differences between calls as differences
// between runs.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BAR } from "../src/plan/local-check.ts";

interface Observed {
  file: string;
  function: string;
  call: string;
  result?: { observation?: string; probability?: number };
}

interface Log {
  cases: Record<string, { versions: Record<string, { base?: string; head?: string; runs?: { requirements?: { requirementId: string; observed?: Observed[] }[] }[] }> }>;
}

interface Reading {
  run: number;
  observation: string;
  probability: number;
}

export interface Place {
  case: string;
  version: string;
  requirement: string;
  file: string;
  function: string;
  call: string;
  readings: Reading[];
}

/** Every place of every version, with one reading per run. */
export function placesOf(log: Log): Place[] {
  const places = new Map<string, Place>();
  for (const [caseName, c] of Object.entries(log.cases ?? {})) {
    for (const [version, v] of Object.entries(c.versions ?? {})) {
      for (const [run, r] of (v.runs ?? []).entries()) {
        for (const requirement of r.requirements ?? []) {
          for (const o of requirement.observed ?? []) {
            const key = [caseName, version, requirement.requirementId, o.file, o.function, o.call].join("\u0000");
            const place = places.get(key) ?? { case: caseName, version, requirement: requirement.requirementId, file: o.file, function: o.function, call: o.call, readings: [] };
            place.readings.push({ run, observation: o.result?.observation ?? "(none)", probability: o.result?.probability ?? Number.NaN });
            places.set(key, place);
          }
        }
      }
    }
  }
  return [...places.values()];
}

const differs = (place: Place) => new Set(place.readings.map((r) => r.observation)).size > 1;
const nearBar = (probability: number, window: number) => Number.isFinite(probability) && Math.abs(probability - BAR) <= window;

export interface Spread {
  bar: number;
  window: number;
  places: number;
  runsPerPlace: number[];
  placesAskedMoreThanOnce: number;
  placesWhoseReadingMoved: number;
  readings: number;
  readingsNearTheBar: number;
  moved: {
    case: string;
    version: string;
    requirement: string;
    function: string;
    call: string;
    readings: { observation: string; probability: number }[];
    everyReadingNearTheBar: boolean;
  }[];
}

/** What the readings of every place say when the same question was put more than once. */
export function spreadOf(places: Place[], window: number): Spread {
  const repeated = places.filter((p) => p.readings.length > 1);
  const moved = repeated.filter(differs);
  const readings = places.flatMap((p) => p.readings);
  return {
    bar: BAR,
    window,
    places: places.length,
    runsPerPlace: [...new Set(places.map((p) => p.readings.length))].sort((a, b) => a - b),
    placesAskedMoreThanOnce: repeated.length,
    placesWhoseReadingMoved: moved.length,
    readings: readings.length,
    readingsNearTheBar: readings.filter((r) => nearBar(r.probability, window)).length,
    moved: moved.map((p) => ({
      case: p.case,
      version: p.version,
      requirement: p.requirement,
      function: p.function,
      call: p.call,
      readings: p.readings.map((r) => ({ observation: r.observation, probability: r.probability })),
      // Written here, not read off the table afterwards: whether a place that moved was at the bar.
      everyReadingNearTheBar: p.readings.every((r) => nearBar(r.probability, window)),
    })),
  };
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { log: { type: "string" }, window: { type: "string" }, out: { type: "string" } },
  });
  const logPath = values.log ?? "bench/logs/acceptance-v1.json";
  const window = values.window === undefined ? 0.1 : Number(values.window);
  if (!Number.isFinite(window) || window < 0) throw new Error(`--window must be a number at or above 0, got ${values.window}`);

  const places = placesOf(JSON.parse(readFileSync(logPath, "utf8")) as Log);
  // The record carries the settings it was taken with, so a later run can be compared with it.
  const record = { version: 1 as const, log: logPath, ...spreadOf(places, window) };

  console.log(`log: ${record.log} · bar ${record.bar} · near means within ${record.window} of it`);
  console.log(`places: ${record.places} (readings per place: ${record.runsPerPlace.join(", ")})`);
  console.log(`places asked more than once: ${record.placesAskedMoreThanOnce}`);
  console.log(`of those, the reading moved between runs: ${record.placesWhoseReadingMoved}`);
  console.log(`readings near the bar: ${record.readingsNearTheBar} of ${record.readings}`);
  for (const m of record.moved) {
    console.log(`  ${m.case}/${m.version} ${m.requirement} ${m.function} — ${m.readings.map((r) => `${r.observation} ${r.probability.toFixed(2)}`).join(" | ")}${m.everyReadingNearTheBar ? " (every reading near the bar)" : ""}`);
  }

  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${values.out}`);
  }
}

if (import.meta.filename === process.argv[1]) main(process.argv.slice(2));
