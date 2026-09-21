// The gate before the other four branches, and the score against the expected table.
//
//   node bench/mapping-gate.ts gate  <correct.json>
//   node bench/mapping-gate.ts score <branch>=<run.json> ...
//
// Two things the gate is not.
//
// It is not "the run produced some mapping". A run can read an `applies` about a call nobody is
// measuring and look ready while both targets went unanswered; `governed` counts the whole run.
// Each target is read on its own, under its own requirement id — the spec has two, and reading
// `requirements[0]` would score R2's target against R1's answers.
//
// It is not only about the mapping. A run of the shipped code that *lists* a target is a run whose
// expected table is already broken, and letting it through because the mapping was usable would
// hand the four remaining branches a baseline that disagrees with itself. READY needs both: a
// usable mapping, and nothing listed.
//
// The target names and the expected table live here and not in `src/`: they are what this
// evaluation happens to be about, and the product has no business knowing them.

import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Target {
  requirementId: string;
  file: string;
  function: string;
  /** The call expression, in full. A function name alone is not a place. */
  call: string;
}

/** The two calls `#27` measured, each under the requirement written for it. */
export const TARGETS: Target[] = [
  { requirementId: "R1", file: "src/integrity.rs", function: "read_baseline", call: "crate::atomic_file::read_to_string_capped(&path, MAX_TRACKED_FILE_BYTES)" },
  { requirementId: "R2", file: "src/config.rs", function: "raw_override_disables", call: "crate::atomic_file::read_to_string_capped(path, MAX_CONFIG_FILE_BYTES)" },
];

interface MappingRow {
  callId: string;
  file: string;
  function: string;
  call: string;
  verdict: string;
  probability: number;
  probabilities: Record<string, number>;
  governs: boolean;
  why: string;
}

interface FindingRow {
  requirementId: string;
  file: string;
  function: string;
  call: string;
}

interface ObservedRow {
  file: string;
  function: string;
  call: string;
  result: { observation: string; probability: number };
}

export interface RequirementRun {
  requirementId: string;
  requirementText: string;
  mappings: MappingRow[];
  findings: FindingRow[];
  observed: ObservedRow[];
  counts: { asked: number; mapped: number; governed: number };
}

export interface Run {
  requirements: RequirementRun[];
}

export interface TargetRow {
  target: Target;
  /** Absent when the run never asked about this call under this requirement. */
  mapping?: MappingRow;
  observation?: ObservedRow["result"];
  listed: boolean;
  usable: boolean;
  why: string;
}

const at = (r: RequirementRun | undefined, t: Target) => r?.mappings.find((m) => m.file === t.file && m.function === t.function && m.call === t.call);

/** One row per target: what the run said about exactly that call, under exactly that requirement. */
export function readTargets(run: Run, targets: readonly Target[] = TARGETS): TargetRow[] {
  return targets.map((target) => {
    const r = run.requirements.find((x) => x.requirementId === target.requirementId);
    if (!r) return { target, listed: false, usable: false, why: `the run holds no ${target.requirementId}` };
    const mapping = at(r, target);
    const observed = r.observed.find((o) => o.file === target.file && o.function === target.function && o.call === target.call);
    const listed = r.findings.some((f) => f.requirementId === target.requirementId && f.file === target.file && f.function === target.function && f.call === target.call);
    if (!mapping) return { target, listed, ...(observed ? { observation: observed.result } : {}), usable: false, why: "the run never asked about this call under this requirement" };
    return { target, mapping, ...(observed ? { observation: observed.result } : {}), listed, usable: mapping.governs, why: mapping.why };
  });
}

/**
 * The gate on the shipped branch: every target mapped and usable, and none of them listed.
 *
 * A listed target here is the expected table already broken — the shipped code is the branch every
 * other reading is compared against.
 */
export function gate(run: Run): { ready: boolean; rows: TargetRow[] } {
  const rows = readTargets(run);
  return { ready: rows.every((row) => row.usable && !row.listed), rows };
}

const EXPECTED: Record<string, Record<string, boolean>> = {
  correct: { R1: false, R2: false },
  "m-read-baseline": { R1: true, R2: false },
  "v-read-baseline": { R1: false, R2: false },
  "m-raw-override": { R1: false, R2: true },
  "v-raw-override": { R1: false, R2: false },
};

export function score(branch: string, run: Run): { rows: TargetRow[]; agrees: boolean; lines: string[] } {
  const rows = readTargets(run);
  const want = EXPECTED[branch];
  const lines: string[] = [];
  let agrees = true;
  for (const row of rows) {
    const expected = want?.[row.target.requirementId];
    const ok = expected === undefined ? undefined : row.listed === expected;
    if (ok === false) agrees = false;
    lines.push(
      `   ${row.target.requirementId} ${row.target.function.padEnd(22)} listed:${row.listed ? "yes" : "no "} expected:${expected === undefined ? "?" : expected ? "yes" : "no "} ${ok === undefined ? "" : ok ? "AGREES" : "DIFFERS"}` +
        `  mapping:${row.mapping ? `${row.mapping.verdict} ${row.mapping.probability.toFixed(2)}` : "none"}` +
        `  reading:${row.observation ? `${row.observation.observation} ${row.observation.probability.toFixed(2)}` : "none"}`,
    );
  }
  return { rows, agrees, lines };
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "gate" && rest[0]) {
    const run = JSON.parse(readFileSync(rest[0], "utf8")) as Run;
    const { ready, rows } = gate(run);
    console.log(`== gate on ${rest[0]}`);
    for (const row of rows) {
      console.log(`   ${row.target.requirementId} ${row.target.function.padEnd(22)} ${row.usable ? "USABLE" : "NOT USABLE"}${row.listed ? " · LISTED on the shipped branch" : ""} — ${row.why}`);
      if (row.mapping) console.log(`      every option: ${JSON.stringify(row.mapping.probabilities)}`);
      if (row.observation) console.log(`      reading: ${row.observation.observation} (${row.observation.probability.toFixed(2)})`);
    }
    console.log(ready ? "\nREADY: every target has a usable mapping and none is listed on the shipped branch" : "\nNOT READY: record this and stop");
    process.exitCode = ready ? 0 : 1;
  } else if (mode === "score" && rest.length > 0) {
    let all = true;
    for (const pair of rest) {
      const [branch, path] = pair.split("=");
      const run = JSON.parse(readFileSync(path as string, "utf8")) as Run;
      const { agrees, lines } = score(branch as string, run);
      console.log(`== ${branch}`);
      for (const line of lines) console.log(line);
      all &&= agrees;
    }
    console.log(all ? "\nEVERY BRANCH AGREES with the table fixed before the runs" : "\nAT LEAST ONE BRANCH DIFFERS from the table fixed before the runs");
    process.exitCode = all ? 0 : 1;
  } else {
    console.error("usage: node bench/mapping-gate.ts gate <correct.json> | score <branch>=<run.json> ...");
    process.exit(2);
  }
}
