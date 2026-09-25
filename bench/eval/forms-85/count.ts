// Counts #85's judgments as README.md fixed them before any was made: two of three decide, three
// different answers or `unclear` are not writable; the main count is Rust rows labelled
// `swallows_as_success`, the side count every row not labelled `not_failure_handling`.
//
//   node bench/eval/forms-85/count.ts merge <dir holding a-1.json … b-3.json>   writes ../forms-85.json
//   node bench/eval/forms-85/count.ts                                             counts ../forms-85.json
//
// Rows are matched by position in rows.txt, which is pool.json's labelled rows in order: two ids
// occur twice there (a row per source), so an id alone does not name a row.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = join(HERE, "..", "forms-85.json");
type Answer = "yes" | "no" | "unclear";
interface Vote { answer: Answer; quote: string }
export interface Row { id: string; label: string; language: string; verdictA: string | null; a: { decided: Answer; votes: Vote[] }; b: { decided: Answer; votes: Vote[] } }

/** Two of three decide; three different answers make `unclear`. */
export function decide(votes: readonly Vote[]): Answer {
  for (const a of ["yes", "no", "unclear"] as const) if (votes.filter((v) => v.answer === a).length >= 2) return a;
  return "unclear";
}

function merge(dir: string) {
  const ids = readFileSync(join(HERE, "rows.txt"), "utf8").trim().split("\n");
  const languages = new Map(readFileSync(join(HERE, "languages.tsv"), "utf8").trim().split("\n").map((l) => l.split("\t") as [string, string]));
  const pool = (JSON.parse(readFileSync(join(HERE, "..", "pool.json"), "utf8")).rows as { id: string; repo: string; label?: { label: string }; verdicts?: { a?: string } }[]).filter((r) => r.label);
  const read = (name: string) => {
    const rows = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as { id: string; answer: Answer; quote: string }[];
    if (rows.length !== ids.length || rows.some((r, i) => r.id !== ids[i])) throw new Error(`${name}: not the ${ids.length} rows of rows.txt in order`);
    return rows;
  };
  const a = ["a-1", "a-2", "a-3"].map(read);
  const b = ["b-1", "b-2", "b-3"].map(read);
  const rows: Row[] = ids.map((id, i) => {
    if (pool[i]!.id !== id) throw new Error(`row ${i + 1}: rows.txt says ${id}, pool.json ${pool[i]!.id}`);
    const va = a.map((x) => ({ answer: x[i]!.answer, quote: x[i]!.quote }));
    const vb = b.map((x) => ({ answer: x[i]!.answer, quote: x[i]!.quote }));
    return { id, label: pool[i]!.label!.label, verdictA: pool[i]!.verdicts?.a ?? null, language: languages.get(pool[i]!.repo) ?? "?", a: { decided: decide(va), votes: va }, b: { decided: decide(vb), votes: vb } };
  });
  writeFileSync(OUT, `${JSON.stringify({ what: "#85: could each labelled row's requirement be written in failure_propagation (a) or failure_handling (b); three annotators each, fixed by README.md", rows }, null, 2)}\n`);
}

/** Share writable in (a), and in (a) or (b), by row and as the mean over repositories. */
export function shares(rows: readonly Row[]) {
  const repoOf = (id: string) => id.split("#")[0]!;
  const byRepo = new Map<string, Row[]>();
  for (const r of rows) byRepo.set(repoOf(r.id), [...(byRepo.get(repoOf(r.id)) ?? []), r]);
  const rate = (rs: readonly Row[], f: (r: Row) => boolean) => rs.filter(f).length / rs.length;
  const aOnly = (r: Row) => r.a.decided === "yes";
  const either = (r: Row) => r.a.decided === "yes" || r.b.decided === "yes";
  const mean = (f: (r: Row) => boolean) => [...byRepo.values()].reduce((s, rs) => s + rate(rs, f), 0) / byRepo.size;
  return { rows: rows.length, repositories: byRepo.size, a: rows.filter(aOnly).length, either: rows.filter(either).length, aShare: rate(rows, aOnly), eitherShare: rate(rows, either), aMean: mean(aOnly), eitherMean: mean(either) };
}

export function count(rows: readonly Row[]) {
  const main = shares(rows.filter((r) => r.language === "Rust" && r.label === "swallows_as_success"));
  const side = shares(rows.filter((r) => r.label !== "not_failure_handling"));
  const line = main.either - main.a >= 3 && main.eitherShare - main.aShare >= 0.1;
  // How often the annotators' (a) says what the orchestrator's `verdicts.a` said, where it said one.
  const judged = rows.filter((r) => r.verdictA === "pass" || r.verdictA === "fail");
  const agree = judged.filter((r) => (r.a.decided === "yes") === (r.verdictA === "pass")).length;
  return { main, side, line, agreement: { rows: judged.length, agree } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "merge") merge(process.argv[3]!);
  const rows = (JSON.parse(readFileSync(OUT, "utf8")) as { rows: Row[] }).rows;
  const { main, side, line, agreement } = count(rows);
  const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
  for (const [name, s] of [["main (Rust, swallows_as_success)", main], ["side (failure handling)", side]] as const) {
    console.log(`${name}: ${s.rows} rows, ${s.repositories} repositories — (a) ${s.a} (${pct(s.aShare)}, mean ${pct(s.aMean)}); (a) or (b) ${s.either} (${pct(s.eitherShare)}, mean ${pct(s.eitherMean)})`);
  }
  console.log(`line (a record, not a gate): ${line ? "crossed" : "not crossed"}`);
  console.log(`the annotators' (a) and verdicts.a agree on ${agreement.agree} of ${agreement.rows} rows that have one`);
}
