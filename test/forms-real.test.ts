// `check_before_action` on the code of the acceptance set's pull requests (#39): each case uses the
// sentence `bench/forms/reach/` recorded, unchanged; every file it names exists; and the score reads a
// version whose target is outside the budgets as not reached, never as a pass.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Distilled } from "../bench/forms/common.ts";
import { caseFiles, loadRealCases, score } from "../bench/forms/real.ts";

const REACH = new URL("../bench/forms/reach/", import.meta.url).pathname;

test("each case asks with the sentence bench/forms/reach recorded, byte for byte", () => {
  const cases = loadRealCases();
  assert.deepEqual(cases.map(({ c }) => c.id).sort(), ["grovedb-500", "moltis-1064"]);
  for (const { dir, c } of cases) {
    const reach = JSON.parse(readFileSync(join(REACH, `${c.id}.json`), "utf8")) as { spec: { sha256: string }; target: { function: string; call: string }; base: string; head: string };
    const spec = readFileSync(resolve(dir, c.spec), "utf8");
    assert.equal(createHash("sha256").update(spec).digest("hex"), reach.spec.sha256, c.id);
    assert.deepEqual(c.target, { function: reach.target.function, call: reach.target.call }, c.id);
    assert.deepEqual([c.base, c.head], [reach.base, reach.head], c.id);
  }
});

test("every file a case names exists, and the table scores shipped, defect and rewrite and records hidden", () => {
  for (const { dir, c } of loadRealCases()) {
    for (const name of Object.keys(caseFiles(dir, c))) if (!name.startsWith("spec: ")) assert.ok(existsSync(join(dir, name)), `${c.id} ${name}`);
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as { scored: Record<string, Record<string, string>>; recorded: Record<string, Record<string, string>> };
    const target = `${c.target.function} · ${c.target.call}`;
    assert.deepEqual(Object.keys(expected.scored).sort(), ["defect", "rewrite", "shipped"]);
    assert.equal(expected.scored.defect![target], "violates");
    assert.equal(expected.scored.shipped![target], "satisfies");
    assert.equal(expected.scored.rewrite![target], "satisfies");
    assert.deepEqual(Object.keys(expected.recorded), ["hidden"]);
  }
});

test("a version whose target is not inside the budgets is not reached, and the measurement does not pass", () => {
  const [one] = loadRealCases().filter(({ c }) => c.id === "grovedb-500");
  const target = `${one!.c.target.function} · ${one!.c.target.call}`;
  const run = (outcome: string): Distilled => ({ exit: 0, requests: 4, origins: [], observed: [{ key: target, outcome, mapping: "applies 0.9", observation: "x 0.9" }], findings: [], unchecked: [], wouldAsk: [target], counts: {} as Distilled["counts"], stderr: "" });
  const three = (outcome: string) => ({ base: "b", head: "h", runs: [run(outcome), run(outcome), run(outcome)] });
  const right = { conditions: { files: {}, runsPerVersion: 3, provider: "" }, tool: { head: "" }, cases: { "grovedb-500": { shipped: three("satisfies"), defect: three("violates"), rewrite: three("satisfies"), hidden: three("satisfies") } } };
  assert.equal(score(right, 3, [one!]).at(-1), "PASS: every scored version meets its row in each of 3 runs");
  const unreached = { ...right, cases: { "grovedb-500": { ...right.cases["grovedb-500"], defect: { base: "b", head: "h", runs: [], notInside: true as const } } } };
  const lines = score(unreached, 3, [one!]);
  assert.ok(lines.some((l) => l.includes("defect   not reached")), lines.join("\n"));
  assert.equal(lines.at(-1), "FAIL: every scored version meets its row in each of 3 runs");
  // One run of the defect read as holding: not a pass either.
  const once = { ...right, cases: { "grovedb-500": { ...right.cases["grovedb-500"], defect: { base: "b", head: "h", runs: [run("violates"), run("satisfies"), run("violates")] } } } };
  assert.equal(score(once, 3, [one!]).at(-1), "FAIL: every scored version meets its row in each of 3 runs");
});

test("the table in docs/local-check-cli.md is exactly what check-before-action-real-v1.json scores to", () => {
  const doc = readFileSync(new URL("../docs/local-check-cli.md", import.meta.url), "utf8");
  const begin = "<!-- check-before-action-real:begin -->\n```\n";
  const end = "\n```\n<!-- check-before-action-real:end -->";
  assert.equal(doc.split(begin).length - 1, 1, "exactly one table");
  const block = doc.slice(doc.indexOf(begin) + begin.length, doc.indexOf(end));
  const log = JSON.parse(readFileSync(new URL("../bench/logs/check-before-action-real-v1.json", import.meta.url), "utf8")) as Parameters<typeof score>[0];
  assert.equal(block, score(log, 3).join("\n"));
});

test("the table after ADR 0016 in docs/local-check-cli.md is exactly what check-before-action-real-v2.json scores to", () => {
  const doc = readFileSync(new URL("../docs/local-check-cli.md", import.meta.url), "utf8");
  const begin = "<!-- check-before-action-real-v2:begin -->\n```\n";
  const end = "\n```\n<!-- check-before-action-real-v2:end -->";
  assert.equal(doc.split(begin).length - 1, 1, "exactly one table");
  const block = doc.slice(doc.indexOf(begin) + begin.length, doc.indexOf(end));
  const log = JSON.parse(readFileSync(new URL("../bench/logs/check-before-action-real-v2.json", import.meta.url), "utf8")) as Parameters<typeof score>[0];
  assert.equal(block, score(log, 3).join("\n"));
  // Every version of both cases was asked this time: none is settled by the listing.
  for (const c of Object.values(log.cases)) for (const v of Object.values(c)) assert.ok(v && !v.notInside && v.runs.length === 3);
});
