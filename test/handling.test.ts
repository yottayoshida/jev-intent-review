import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { questionHash } from "../bench/handling/probe.ts";
import { BlockIndex } from "../src/change/blocks.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { applicabilityOf, calleeOf } from "../src/plan/applicability.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { FORMS } from "../src/plan/forms.ts";
import { outcomeOf } from "../src/review/outcome.ts";
import { REQUIREMENT_FORMS, type Requirement } from "../src/types.ts";

// `failure_handling` (#85): the question wired is the one measured, its key is its own, and it asks
// what a function does with a failure whatever the function returns.

const form = FORMS.failure_handling;

test("the wired observation question is the one the probe sent, byte for byte", () => {
  const log = JSON.parse(readFileSync(new URL("../bench/logs/handling-probe-v1.json", import.meta.url), "utf8")) as { conditions: { question: string } };
  const fn = { name: "f" } as never;
  const call = { expression: "g(x)" } as never;
  assert.equal(questionHash(form.observationQuestions(fn, call)), log.conditions.question);
});

test("every form reads its observation under a key of its own", () => {
  // bench/eval/drift.ts and the run find a form by its observation key: two forms sharing one would
  // score one form's answers by the other's sides.
  const keys = REQUIREMENT_FORMS.map((name) => FORMS[name].observationKey);
  assert.equal(new Set(keys).size, keys.length, keys.join(", "));
});

test("the sides go by the answer: silence against the requirement, a return or a trace for it", () => {
  const rule = (observation: string) => outcomeOf({ choice: "applies", probability: 0.9 }, { choice: observation, probability: 0.9 }, form, { mapping: 0.6, observation: 0.6 });
  assert.equal(rule("continues_silently"), "violates");
  assert.equal(rule("propagates"), "satisfies");
  assert.equal(rule("reports_locally"), "satisfies");
  assert.equal(rule("cannot_determine"), "unknown");
});

// A function that returns nothing and logs a failure, and one that returns nothing and drops it: the
// failure form cannot ask either; this one asks both, and neither where the callee cannot fail.
const FILES: Record<string, string> = {
  "src/a.rs": "pub fn record(store: &Store) {\n    write_entry(store);\n    touch(store);\n}\n",
  "src/b.rs": "pub fn write_entry(store: &Store) -> Result<(), Error> {\n    store.put()\n}\n\npub fn touch(store: &Store) {\n    store.mark();\n}\n",
};
const discoverer = {
  async search(word: string) {
    const hits = Object.entries(FILES).flatMap(([path, text]) =>
      text.split("\n").flatMap((line, i) => (new RegExp(`(?<![\\w$])${word}(?![\\w$])`).test(line) ? [{ path, line: i + 1, text: line }] : [])),
    );
    return { hits, more: false };
  },
  async index(path: string) {
    return FILES[path] ? new BlockIndex(FILES[path]!.split("\n")) : null;
  },
} as unknown as Discoverer;

test("a function that returns nothing is asked about when its callee can fail, and not when it cannot", async () => {
  const listed = enumerate("src/a.rs", FILES["src/a.rs"]!);
  const fn = listed.functions.find((f) => f.name === "record")!;
  const call = (callee: string) => listed.calls.find((c) => c.callee === callee)!;
  const requirement: Requirement = { id: "R1", text: "A failure to write an entry is logged, not dropped.", kind: "behavior", priority: "required", sourceRefs: [], searchHints: [], form: "failure_handling" };
  const context = (name: string) => ({
    requirement,
    fn,
    call: call(name),
    resultOf: (f: typeof fn, c: ReturnType<typeof call>) => applicabilityOf(discoverer, f, c),
    readHere: async () => null,
    calleeResultOf: async (f: typeof fn, c: ReturnType<typeof call>) => (await calleeOf(discoverer, f, c)).result,
  });
  assert.equal((await form.askable(context("write_entry"))).ok, true, "record returns (), write_entry returns a Result: asked");
  const touch = await form.askable(context("touch"));
  assert.equal(touch.ok, false, "touch cannot fail: not asked");
  assert.equal(!touch.ok && touch.kind, "callee_not_result");
  // The control: the failure form holds the same call, because record does not return a Result.
  const failure = await FORMS.failure_propagation.askable(context("write_entry"));
  assert.equal(!failure.ok && failure.kind, "target_not_result");
});
