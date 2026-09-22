// How many pull requests the tool reads any requirement from, and how many of those it then has
// something to check in (#40, ADR 0004). No model is asked anything.
//
//   node bench/intent-coverage.ts <omamori clone> <sideeye clone> [log path]
//
// 1. The eleven frozen cases (`bench/corpus/*.intent.json`): the requirements read, the sources not
//    read, and — at the pull request's own revisions from `bench/corpus/*.revs` — how many calls the
//    local check would ask about. Those candidates come from the diff alone (Rust functions the
//    change touched and their callers), so "read" and "has something to check" are separate
//    numbers, and the second cannot move with how requirements are read.
// 2. Recent merged pull requests of the same two repositories that are not among the eleven, read
//    with the same function: the check that the forms were not fitted to the eleven. Their
//    descriptions only — the issues they close are not fetched.
//
// Before ADR 0004 the reader took nothing from any of the eleven: measured on 2026-09-21 with
// `compileChecklist` at a9bed91, 0 of 11. That function is gone; the number is recorded here.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRequirements } from "../src/intent/compiler.ts";
import { Git } from "../src/repository/git.ts";
import type { JudgmentProvider } from "../src/judgments/provider.ts";
import { DEFAULT_LOCAL_CHECK, runLocalCheck } from "../src/review/local-check-run.ts";
import type { IntentSource } from "../src/types.ts";
import { VERSION } from "../src/version.ts";

const HERE = import.meta.dirname;
const [omamori, sideeye, out = "intent-coverage.json"] = process.argv.slice(2);
if (!omamori || !sideeye) throw new Error("usage: node bench/intent-coverage.ts <omamori clone> <sideeye clone> [log path]");
const clones: Record<string, string> = { omamori, sideeye };

const asksNothing = {
  model: "none",
  judge: () => {
    throw new Error("this measurement reached a model");
  },
} as unknown as JudgmentProvider;

const frozen = [];
for (const file of readdirSync(join(HERE, "corpus")).filter((f) => f.endsWith(".intent.json")).sort()) {
  const name = file.replace(".intent.json", "");
  const c = JSON.parse(readFileSync(join(HERE, "corpus", file), "utf8")) as { sources: IntentSource[] };
  const reading = readRequirements(c.sources);
  const repo = name.split("-")[0] as string;
  let candidates: number | null = null;
  const revsFile = join(HERE, "corpus", `${name}.revs`);
  try {
    const [before, after] = readFileSync(revsFile, "utf8").trim().split(/\s+/);
    if (reading.spec.requirements.length > 0 && before && after) {
      const results = await runLocalCheck(new Git(clones[repo] as string), { before, after }, reading.spec.requirements, asksNothing, () => true, { ...DEFAULT_LOCAL_CHECK, candidatesOnly: true });
      candidates = Math.max(0, ...results.map((r) => r.wouldAsk.length));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  frozen.push({
    case: name,
    read: reading.spec.requirements.map((r) => ({ id: r.id, source: r.sourceRefs[0]?.sourceId, chars: r.text.length })),
    unread: reading.unread,
    leftOut: reading.spec.ambiguities.length - reading.unread.length,
    // Calls the local check would ask about for the first requirement (the same for every one).
    calls: candidates,
  });
}

const MEASURED = new Set(frozen.map((f) => f.case));
const holdout: { case: string; read: number; leftOut: number }[] = [];
for (const repo of ["omamori", "sideeye"]) {
  const list = JSON.parse(execFileSync("gh", ["pr", "list", "-R", `yottayoshida/${repo}`, "--state", "merged", "--limit", "40", "--json", "number,body,author"], { encoding: "utf8" })) as { number: number; body: string }[];
  for (const pr of list) {
    if (MEASURED.has(`${repo}-${pr.number}`)) continue;
    const reading = readRequirements([{ id: `pr#${pr.number}`, type: "pr_description", authority: 50, text: pr.body ?? "" }]);
    holdout.push({ case: `${repo}-${pr.number}`, read: reading.spec.requirements.length, leftOut: reading.spec.ambiguities.length - reading.unread.length });
  }
}

const measured = frozen.filter((f) => f.case !== "omamori-476");
const summary = {
  before: { read: 0, of: 11, how: "compileChecklist at a9bed91, measured 2026-09-21" },
  measuredTen: { read: measured.filter((f) => f.read.length > 0).length, withCallsToCheck: measured.filter((f) => (f.calls ?? 0) > 0).length, of: measured.length },
  omamori476: { read: frozen.find((f) => f.case === "omamori-476")?.read.length ?? null },
  holdout: { read: holdout.filter((h) => h.read > 0).length, leftOutOnly: holdout.filter((h) => h.read === 0 && h.leftOut > 0).length, of: holdout.length, byRepo: Object.fromEntries(["omamori", "sideeye"].map((r) => [r, { read: holdout.filter((h) => h.case.startsWith(r) && h.read > 0).length, of: holdout.filter((h) => h.case.startsWith(r)).length }])) },
};
// The day it ran, not the day this was written: the holdout is whatever was merged most recently.
writeFileSync(out, `${JSON.stringify({ tool: { version: VERSION }, measured: new Date().toISOString().slice(0, 10), summary, frozen, holdout }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 1));
