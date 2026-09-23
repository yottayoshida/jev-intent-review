// #37: the calls the first budget asks about, from the command line's `--candidates-only`, with
// the tool before the siblings (`--before`) and this tree's; and how many sibling rows each branch
// gets. No request is sent.
//
//   node bench/siblings-first-budget.ts --acceptance <dir> --omamori <clone> --before <rev> [--out <file>]
//
// The siblings are asked last and under their own budget (ADR 0005), so the first budget is the
// same set by construction; this is the record that it is, on every branch of the development case
// and of the two built acceptance cases. A branch where no sibling shows up checks nothing of the
// kind, so the count of branches with sibling rows is printed with the result.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { acceptance: { type: "string" }, omamori: { type: "string" }, before: { type: "string" }, out: { type: "string" } } });
if (!values.acceptance || !values.omamori || !values.before) throw new Error("usage: node bench/siblings-first-budget.ts --acceptance <dir> --omamori <clone> --before <rev> [--out <file>]");
const ACC = resolve(values.acceptance);
const OMA = resolve(values.omamori);
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

const old = mkdtempSync(join(homedir(), ".cctmp", "siblings-first-budget-"));
execFileSync("sh", ["-c", `git -C "${HERE}" archive "${values.before}" src package.json | tar -x -C "${old}"`]);
symlinkSync(join(HERE, "node_modules"), join(old, "node_modules"));

interface Branch {
  name: string;
  clone: string;
  base: string;
  head: string;
  spec: string;
}
const branches: Branch[] = [];
const OMAMORI: Record<string, string> = {
  correct: "e58c04f6df082146969320b91f09aa7a0123ac1f",
  "m-read-baseline": "46cd434299a05ff8c6d2664f720f0606d7e11579",
  "v-read-baseline": "a3dae0a134cc70952fe467bad860a714e4c45792",
  "m-raw-override": "e8f2fdc8385e539aaffd6602ef869cfcbccd2bea",
  "v-raw-override": "6c96366a0ec6e0e5ef3092866d0a2d2da871e332",
};
for (const [version, head] of Object.entries(OMAMORI)) {
  branches.push({ name: `omamori-468/${version}`, clone: OMA, base: git(OMA, "merge-base", "52a58fa", head), head, spec: join(HERE, "bench/fixtures/omamori-468/stated-failure-handling.spec.json") });
}
for (const [id, clone] of [["moltis-1064", "moltis"], ["grovedb-500", "grovedb"]] as const) {
  const c = JSON.parse(readFileSync(join(HERE, `bench/acceptance/cases/${id}/case.json`), "utf8")) as { versions: Record<string, { base: string; head: string }> };
  for (const [version, v] of Object.entries(c.versions)) branches.push({ name: `${id}/${version}`, clone: join(ACC, clone), base: v.base, head: v.head, spec: join(HERE, `bench/acceptance/cases/${id}/spec.json`) });
}

interface Row {
  file: string;
  function: string;
  call: string;
  origin: string;
}
interface Report {
  requirements: { requirementId: string; wouldAsk: Row[]; counts: { siblings?: { functions: number; seeds: string[] } } }[];
}
const cli = (root: string, b: Branch): Report =>
  JSON.parse(execFileSync("node", [join(root, "src/cli/main.ts"), "--candidates-only", "--skip-change-check", "--base", b.base, "--head", b.head, "--intent-spec", b.spec, "--json"], { cwd: b.clone, encoding: "utf8", maxBuffer: 64 << 20 })) as Report;
const key = (w: Row) => [w.file, w.function, w.call, w.origin].join("\u0000");

const runs = [];
for (const b of branches) {
  const before = cli(old, b);
  const after = cli(HERE, b);
  const rows = before.requirements.map((r, i) => {
    const a = after.requirements[i]!;
    const near = a.wouldAsk.filter((w) => w.origin !== "shares_call");
    return {
      requirement: r.requirementId,
      firstBudgetSame: JSON.stringify(near.map(key)) === JSON.stringify(r.wouldAsk.map(key)),
      firstBudget: near.length,
      siblingRows: a.wouldAsk.length - near.length,
      siblingFunctions: a.counts.siblings?.functions ?? 0,
      seeds: a.counts.siblings?.seeds ?? [],
    };
  });
  runs.push({ branch: b.name, revisions: { base: b.base, head: b.head }, rows });
  console.log(b.name, JSON.stringify(rows.map((x) => [x.requirement, x.firstBudgetSame, x.firstBudget, x.siblingRows])));
}
const summary = {
  before: values.before,
  beforeCommit: git(HERE, "rev-parse", values.before),
  branches: runs.length,
  firstBudgetSameEverywhere: runs.every((r) => r.rows.every((x) => x.firstBudgetSame)),
  branchesWithSiblingRows: runs.filter((r) => r.rows.some((x) => x.siblingRows > 0)).length,
};
if (values.out) writeFileSync(values.out, `${JSON.stringify({ summary, runs }, null, 1)}\n`);
console.log(JSON.stringify(summary));
