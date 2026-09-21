// Siblings (ADR 0005), checked on the development case without sending anything.
//
//   node bench/beyond-diff.ts --omamori <clone> --work <empty dir> [--old-rev a9bed91] [--out <log.json>]
//
// Two questions, both answered by `--experimental-candidates-only`, which asks no model:
//
//   1. Did adding siblings move anything the first budget asks about? For each of the five branches
//      of omamori #468 / PR #476 and each requirement, the calls inside the budget that come from
//      the change's own functions (`changed`, `calls_changed`) are compared, as (file, function,
//      call), between the tool at `--old-rev` and the tool in this checkout. They must be the same
//      set. This compares the calls, not the packets or the questions: those are built for each
//      call by code this change does not alter for them, which is read, not checked, here.
//   2. What do siblings add there: which seeds, how many siblings and askable calls, what was not
//      followed and why.
//
// This is a development case — it was used to tune the path before — so nothing here is a result
// about unseen code. The branches are built in a throwaway clone under `--work`, with a fixed author
// and date so their ids are the same on every run; the clone passed in is only read.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { srcDigest } from "./src-digest.ts";

const HERE = resolve(import.meta.dirname, "..");
const BASE = "52a58fa";
const SHIPPED = "e58c04f";
const PATCHES = ["m-read-baseline", "v-read-baseline", "m-raw-override", "v-raw-override"];
const SPEC = join(HERE, "bench/fixtures/omamori-468/stated-failure-handling.spec.json");

const { values } = parseArgs({ options: { omamori: { type: "string" }, work: { type: "string" }, "old-rev": { type: "string", default: "a9bed91" }, out: { type: "string" } } });
if (!values.omamori || !values.work) throw new Error("usage: node bench/beyond-diff.ts --omamori <clone> --work <empty dir> [--old-rev <rev>] [--out <log.json>]");
const work = resolve(values.work);
mkdirSync(work, { recursive: true });
if (readdirSync(work).length > 0) throw new Error(`${work} is not empty`);

const FIXED = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.com", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.com", GIT_AUTHOR_DATE: "2026-09-21T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-21T00:00:00Z" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...process.env, ...FIXED } }).trim();

// The branches: the shipped head, and each patch on it.
const clone = join(work, "omamori");
execFileSync("git", ["clone", "-q", "--no-hardlinks", resolve(values.omamori), clone]);
const base = git(clone, "rev-parse", BASE);
const branches: Record<string, string> = { correct: git(clone, "rev-parse", SHIPPED) };
for (const patch of PATCHES) {
  git(clone, "checkout", "-q", "--detach", SHIPPED);
  git(clone, "apply", join(HERE, "bench/fixtures/omamori-468", `${patch}.patch`));
  git(clone, "commit", "-q", "-am", patch);
  branches[patch] = git(clone, "rev-parse", "HEAD");
}

// The tool before this change, from git objects, beside this checkout's dependencies.
const oldTool = join(work, "tool-old");
mkdirSync(oldTool);
execFileSync("sh", ["-c", `git -C "${HERE}" archive "${values["old-rev"]}" | tar -x -C "${oldTool}"`]);
symlinkSync(join(HERE, "node_modules"), join(oldTool, "node_modules"));

interface Place {
  file: string;
  function: string;
  call: string;
  origin: string;
  via?: string;
}
interface Result {
  requirementId: string;
  wouldAsk: Place[];
  unchecked: (Place & { why: string })[];
  counts: { budget: number; applicable: number; overBudget: number; beyond?: Record<string, number> };
  seeds?: string[];
  notes: string[];
}

function candidates(tool: string, head: string): Result[] {
  const out = execFileSync("node", [join(tool, "src/cli/main.ts"), "--experimental-local-check", "--experimental-candidates-only", "--base", base, "--head", head, "--intent-spec", SPEC, "--json"], {
    cwd: clone,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(out) as { requirements: Result[] }).requirements;
}

const key = (p: Place) => `${p.file} · ${p.function} · ${p.call}`;
const near = (list: readonly Place[]) => list.filter((p) => p.origin === "changed" || p.origin === "calls_changed").map(key).sort();

const rows = [];
let same = true;
for (const [branch, head] of Object.entries(branches)) {
  const before = candidates(oldTool, head);
  const after = candidates(HERE, head);
  for (const r of after) {
    const old = before.find((b) => b.requirementId === r.requirementId);
    if (!old) throw new Error(`${branch}: ${r.requirementId} is missing from the old tool's output`);
    const nearBefore = near(old.wouldAsk);
    const nearAfter = near(r.wouldAsk);
    const equal = nearBefore.length === nearAfter.length && nearBefore.every((k, i) => k === nearAfter[i]);
    same &&= equal;
    const siblings = r.wouldAsk.filter((p) => p.origin === "shares_call");
    rows.push({
      branch,
      head,
      requirementId: r.requirementId,
      firstBudgetUnchanged: equal,
      firstBudget: nearAfter.length,
      seeds: r.seeds ?? [],
      beyond: r.counts.beyond ?? null,
      siblingsAsked: siblings.map((p) => `${key(p)} (via ${p.via})`),
      siblingsHeld: r.unchecked.filter((u) => u.origin === "shares_call").map((u) => `${key(u)}: ${u.why}`),
      siblingNotes: r.notes.filter((n) => n.startsWith("siblings:")),
      ...(equal ? {} : { onlyBefore: nearBefore.filter((k) => !nearAfter.includes(k)), onlyAfter: nearAfter.filter((k) => !nearBefore.includes(k)) }),
    });
  }
}

const log = {
  what: "siblings on the development case, candidates only (no request sent)",
  tool: { old: git(HERE, "rev-parse", values["old-rev"]!), newHead: git(HERE, "rev-parse", "HEAD"), newSrcDigest: srcDigest(HERE) },
  base,
  branches,
  spec: "bench/fixtures/omamori-468/stated-failure-handling.spec.json",
  firstBudgetUnchangedEverywhere: same,
  rows,
};
const text = `${JSON.stringify(log, null, 2)}\n`;
if (values.out) writeFileSync(values.out, text);
else process.stdout.write(text);
process.exitCode = same ? 0 : 1;
