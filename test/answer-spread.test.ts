import assert from "node:assert/strict";
import { test } from "node:test";
import { placesOf, spreadOf } from "../bench/answer-spread.ts";
import { BAR } from "../src/plan/local-check.ts";

/** One case, one version, `runs` readings of the same two places. */
const log = (readings: { observation: string; probability: number }[][]) => ({
  cases: {
    "a-case": {
      versions: {
        shipped: {
          runs: readings.map((run) => ({
            requirements: [
              {
                requirementId: "R1",
                observed: run.map((r, i) => ({ file: "src/a.rs", function: `fn${i}`, call: `call${i}()`, result: r })),
              },
            ],
          })),
        },
      },
    },
  },
});

test("a place is one file, function and call of one requirement, with one reading per run", () => {
  const places = placesOf(
    log([
      [{ observation: "returns_error", probability: 0.9 }, { observation: "returns_success", probability: 0.8 }],
      [{ observation: "returns_error", probability: 0.91 }, { observation: "returns_success", probability: 0.82 }],
    ]),
  );
  assert.equal(places.length, 2, "two calls, not four readings");
  assert.deepEqual(
    places.map((p) => p.readings.length),
    [2, 2],
  );
  assert.deepEqual(places[0]?.readings.map((r) => r.run), [0, 1]);
});

test("a reading that moved between runs is counted, and whether it sat at the bar is written with it", () => {
  // The first place moves across the bar; the second is steady and far from it.
  const moved = { observation: "returns_success", probability: BAR + 0.02 };
  const back = { observation: "cannot_determine", probability: BAR - 0.03 };
  const steady = { observation: "returns_error", probability: 0.99 };
  const spread = spreadOf(placesOf(log([[moved, steady], [back, steady]])), 0.1);

  assert.equal(spread.places, 2);
  assert.equal(spread.placesAskedMoreThanOnce, 2);
  assert.equal(spread.placesWhoseReadingMoved, 1);
  assert.equal(spread.moved[0]?.function, "fn0");
  assert.equal(spread.moved[0]?.everyReadingNearTheBar, true);
  assert.equal(spread.readings, 4);
  assert.equal(spread.readingsNearTheBar, 2, "only the two readings of the place that moved are near it");
  assert.equal(spread.bar, BAR);
});

test("a place asked once is not counted as one that agreed with itself", () => {
  const spread = spreadOf(placesOf(log([[{ observation: "returns_error", probability: 0.9 }]])), 0.1);
  assert.equal(spread.places, 1);
  assert.equal(spread.placesAskedMoreThanOnce, 0);
  assert.equal(spread.placesWhoseReadingMoved, 0);
});

test("the window decides what counts as near the bar, and a wider one counts more", () => {
  const readings = [[{ observation: "returns_error", probability: BAR + 0.15 }]];
  assert.equal(spreadOf(placesOf(log(readings)), 0.1).readingsNearTheBar, 0);
  assert.equal(spreadOf(placesOf(log(readings)), 0.2).readingsNearTheBar, 1);
});

test("the numbers the record carries are the ones the acceptance log gives", async () => {
  // The record in the repository is what the document quotes; this pins the count that produced it.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  // From the repository root whatever the working directory, and a missing record fails rather than passes.
  const root = join(import.meta.dirname, "..");
  const record = JSON.parse(readFileSync(join(root, "bench/logs/answer-spread-v1.json"), "utf8")) as ReturnType<typeof spreadOf> & { log: string };
  const fresh = spreadOf(placesOf(JSON.parse(readFileSync(join(root, record.log), "utf8"))), record.window);
  assert.equal(fresh.places, record.places);
  assert.equal(fresh.placesWhoseReadingMoved, record.placesWhoseReadingMoved);
  assert.equal(fresh.readingsNearTheBar, record.readingsNearTheBar);
  assert.deepEqual(
    fresh.moved.map((m) => m.everyReadingNearTheBar),
    record.moved.map((m) => m.everyReadingNearTheBar),
  );
});
