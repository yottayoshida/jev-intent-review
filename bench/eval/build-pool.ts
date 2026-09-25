// Builds bench/eval/pool.json and bench/eval/split.json from the records that already exist, so the
// pool is every candidate those records name and nobody picks rows by hand.
//
//   node bench/eval/build-pool.ts            writes both files
//   node bench/eval/build-pool.ts --check    exits 1 when either file differs from what it would write
//
// The labels of how a failure was handled (PROTOCOL.md, "Labels") are read from labels.json and
// merged in; they are written by the annotators, not by this file.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type PoolRow, type Pool, type Split, type SplitEntry, LABELS, type LabelRecord } from "./split.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BENCH = join(HERE, "..");
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

interface Candidate {
  order: number;
  ref: string;
  a: string;
  why?: string;
  requirement?: string;
  [condition: string]: unknown;
}

const repoOf = (ref: string) => ref.split("#")[0]!.toLowerCase();
const verdictsOf = (c: Candidate) =>
  Object.fromEntries(Object.entries(c).filter(([k, v]) => /^[a-z]$/.test(k) && typeof v === "string")) as Record<string, string>;

export function buildPool(): Pool {
  const rows: PoolRow[] = [];
  const v1 = read<{ candidates: Candidate[]; sources: { "yottayoshida/omamori": { excluded: Record<string, string> }; external: { excludedByLicense: string[] } } }>(join(BENCH, "acceptance", "candidates.json"));
  for (const c of v1.candidates) {
    rows.push({ id: c.ref, repo: repoOf(c.ref), source: "acceptance-v1", stage: "examined", order: c.order, verdicts: verdictsOf(c), why: c.why ?? null, requirement: c.requirement ?? null });
  }
  for (const [n, why] of Object.entries(v1.sources["yottayoshida/omamori"].excluded)) {
    rows.push({ id: `yottayoshida/omamori#${n}`, repo: "yottayoshida/omamori", source: "acceptance-v1", stage: "excluded", order: null, verdicts: {}, why, requirement: null });
  }
  for (const entry of v1.sources.external.excludedByLicense) {
    const [ref, why] = [entry.split(" ")[0]!, entry.slice(entry.indexOf(" ") + 1)];
    rows.push({ id: ref, repo: repoOf(ref), source: "acceptance-v1", stage: "screened_out", order: null, verdicts: {}, why: `license ${why}`, requirement: null });
  }
  const v2 = read<{ candidates: Candidate[]; pool: { screenedByTitleOrLicense: Record<string, string> } }>(join(BENCH, "acceptance", "candidates-v2.json"));
  for (const c of v2.candidates) {
    rows.push({ id: c.ref, repo: repoOf(c.ref), source: "acceptance-v2", stage: "examined", order: c.order, verdicts: verdictsOf(c), why: c.why ?? null, requirement: c.requirement ?? null });
  }
  for (const [ref, why] of Object.entries(v2.pool.screenedByTitleOrLicense)) {
    rows.push({ id: ref, repo: repoOf(ref), source: "acceptance-v2", stage: "screened_out", order: null, verdicts: {}, why, requirement: null });
  }
  // bench/corpus: the ten pull requests of omamori and sideeye, chosen mechanically (corpus/README.md).
  for (const f of readdirSync(join(BENCH, "corpus")).filter((x) => x.endsWith(".revs")).sort()) {
    const [name, n] = [f.replace(/-\d+\.revs$/, ""), f.match(/-(\d+)\.revs$/)![1]!];
    rows.push({ id: `yottayoshida/${name}#${n}`, repo: `yottayoshida/${name}`, source: "corpus", stage: "used", order: null, verdicts: {}, why: "bench/corpus: requirements written by the tool's model and repaired (corpus/README.md)", requirement: null });
  }
  for (const f of readdirSync(join(BENCH, "fixtures")).sort()) {
    const n = f.match(/^omamori-(\d+)/)![1]!;
    rows.push({ id: `yottayoshida/omamori#${n}`, repo: "yottayoshida/omamori", source: "fixture", stage: "used", order: null, verdicts: {}, why: `bench/fixtures/${f}: a development case`, requirement: null });
  }
  for (const f of readdirSync(join(BENCH, "sentence-choice", "issues")).filter((x) => x.endsWith(".json")).sort()) {
    const issue = read<{ issue: string }>(join(BENCH, "sentence-choice", "issues", f)).issue;
    rows.push({ id: issue, repo: repoOf(issue), source: "sentence-choice", stage: "used", order: null, verdicts: {}, why: "bench/sentence-choice: an issue whose sentences were read to choose how requirements are read (#40)", requirement: null });
  }
  const labelsFile = join(HERE, "labels.json");
  const labels = existsSync(labelsFile) ? read<Record<string, LabelRecord>>(labelsFile) : {};
  for (const r of rows) {
    const key = `${r.source}:${r.id}`;
    const l = labels[key];
    if (l !== undefined) {
      if (!(LABELS as readonly string[]).includes(l.label)) throw new Error(`${key}: ${l.label} is not a label`);
      r.label = l;
    }
  }
  const unknown = Object.keys(labels).filter((k) => !rows.some((r) => `${r.source}:${r.id}` === k));
  if (unknown.length > 0) throw new Error(`labels.json names rows the pool does not have: ${unknown.join(", ")}`);
  return { protocolVersion: PROTOCOL_VERSION, what: "Every candidate the records of bench/ name, with where it came from and what was decided about it. Built by build-pool.ts; do not edit by hand.", rows };
}

/**
 * Every repository of the pool is dev in v1: each was read, run or used before the protocol existed.
 * The entries placed by the hash (`fixed: false`, from the second batch on) are not the pool's to
 * decide: they are carried over from `previous` as they are, and a repository cannot be both.
 */
export function buildSplit(pool: Pool, previous?: Split): Split {
  const why = new Map<string, Set<string>>();
  const note = (repo: string, reason: string) => (why.get(repo) ?? why.set(repo, new Set()).get(repo)!).add(reason);
  for (const r of pool.rows) {
    if (r.source === "corpus" || r.source === "fixture" || r.source === "sentence-choice") note(r.repo, `${r.source}: used to build or tune`);
    else if (r.stage === "examined" && r.verdicts.b !== undefined) note(r.repo, `${r.source}: the tool was run on it for (b)`);
    else if (r.stage === "examined" && (r.verdicts.s !== undefined || r.verdicts.d !== undefined)) note(r.repo, `${r.source}: read for (s)/(d), the wall of #37`);
    else note(r.repo, `${r.source}: in the pool before protocol v1`);
  }
  // A case directory is `<repository name>-<number>`; the pool row with that name and number is its repository.
  for (const id of readdirSync(join(BENCH, "acceptance", "cases"))) {
    const [, name, n] = id.match(/^(.+)-(\d+)$/) ?? [];
    const hits = pool.rows.filter((r) => r.id.endsWith(`#${n}`) && r.repo.split("/")[1] === name);
    const repos = new Set(hits.map((r) => r.repo));
    if (repos.size !== 1) throw new Error(`bench/acceptance/cases/${id} matches ${repos.size} repositories of the pool, not one`);
    note([...repos][0]!, `bench/acceptance/cases/${id}: built or pre-checked`);
  }
  const hashed = (previous?.repos ?? []).filter((e) => !e.fixed);
  const both = hashed.filter((e) => why.has(e.repo)).map((e) => e.repo);
  if (both.length > 0) throw new Error(`placed by the hash and already in the pool before v1 (so fixed to dev): ${both.join(", ")}`);
  const repos: SplitEntry[] = [...[...why.entries()].map(([repo, reasons]) => ({ repo, side: "dev" as const, fixed: true, why: [...reasons].sort() })), ...hashed].sort((a, b) => a.repo.localeCompare(b.repo));
  return { protocolVersion: PROTOCOL_VERSION, what: "Which side each repository is on. A repository is on one side only. Built by build-pool.ts from pool.json; sealed entries are added only by the rule of PROTOCOL.md.", repos };
}

const out = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = buildPool();
  const splitFile = join(HERE, "split.json");
  const split = buildSplit(pool, existsSync(splitFile) ? read<Split>(splitFile) : undefined);
  const files = [
    [join(HERE, "pool.json"), out(pool)],
    [join(HERE, "split.json"), out(split)],
  ] as const;
  if (process.argv.includes("--check")) {
    const stale = files.filter(([p, text]) => !existsSync(p) || readFileSync(p, "utf8") !== text).map(([p]) => p);
    if (stale.length > 0) {
      console.error(`not what build-pool.ts writes: ${stale.join(", ")}`);
      process.exitCode = 1;
    }
  } else {
    for (const [p, text] of files) writeFileSync(p, text);
    console.log(`pool: ${pool.rows.length} rows, ${new Set(pool.rows.map((r) => r.repo)).size} repositories; split: ${split.repos.filter((r) => r.side === "dev").length} dev, ${split.repos.filter((r) => r.side === "sealed").length} sealed`);
  }
}
