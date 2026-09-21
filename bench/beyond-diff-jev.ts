// Siblings (ADR 0005) asked of the real Jev once, on the shipped branch of the development case.
//
//   node bench/beyond-diff-jev.ts --omamori <clone holding 52a58fa and e58c04f> --out <log.json>
//
// Needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or another Jev endpoint the CLI
// accepts) in the environment. Asks about 112 questions (retries, if any, are not counted).
//
// What it answers: on the shipped code, do the siblings raise findings? The case has no defect in a
// sibling, so this counts noise and nothing else — and it is not scored, because whether a finding
// in a sibling is right is not settled without reading the function.
//
// The log is distilled from the CLI's JSON: `counts`, `seeds`, `stopped`, every mapping, every
// observation and every finding, copied as they came out and unrounded. `unchecked` and `notes`
// are left out; they need no request and `bench/beyond-diff.ts` records them.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { srcDigest } from "./src-digest.ts";

const HERE = resolve(import.meta.dirname, "..");
const BASE = "52a58fa";
const SHIPPED = "e58c04f";
const SPEC = "bench/fixtures/omamori-468/stated-failure-handling.spec.json";

const { values } = parseArgs({ options: { omamori: { type: "string" }, out: { type: "string" } } });
if (!values.omamori || !values.out) throw new Error("usage: node bench/beyond-diff-jev.ts --omamori <clone> --out <log.json>");

interface Counts {
  mapped: number;
  asked: number;
  beyond: { mapped: number; asked: number };
}
interface Result {
  requirementId: string;
  stopped?: string;
  seeds: string[];
  counts: Counts;
  findings: unknown[];
  mappings: unknown[];
  observed: unknown[];
}

const started = Date.now();
const out = execFileSync("node", [join(HERE, "src/cli/main.ts"), "--experimental-local-check", "--base", BASE, "--head", SHIPPED, "--intent-spec", join(HERE, SPEC), "--json"], {
  cwd: resolve(values.omamori),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const seconds = Math.round((Date.now() - started) / 1000);
const report = JSON.parse(out) as { revisions: { before: string; after: string }; requirements: Result[] };

const log = {
  what: "the shipped branch of the development case (omamori #468 / PR #476), one run with the real Jev, to count findings raised in siblings. Not scored. Distilled by bench/beyond-diff-jev.ts: counts, seeds, stopped, every mapping, every observation and every finding as the CLI gave them; unchecked and notes left out (bench/beyond-diff.ts records them).",
  toolSrcDigest: srcDigest(HERE),
  base: report.revisions.before,
  head: report.revisions.after,
  spec: SPEC,
  seconds,
  /** Questions asked and answered, from the report's counts: a retried request is one question. */
  questions: report.requirements.reduce((n, r) => n + r.counts.mapped + r.counts.asked + r.counts.beyond.mapped + r.counts.beyond.asked, 0),
  requirements: report.requirements.map((r) => ({ requirementId: r.requirementId, stopped: r.stopped ?? null, seeds: r.seeds, counts: r.counts, findings: r.findings, mappings: r.mappings, observed: r.observed })),
};
writeFileSync(values.out, `${JSON.stringify(log, null, 2)}\n`);
process.stdout.write(`${log.questions} questions, ${seconds} s, findings per requirement: ${log.requirements.map((r) => r.findings.length).join(", ")}\n`);
