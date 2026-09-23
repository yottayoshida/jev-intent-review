// The tables in docs/local-check-cli.md, rebuilt from what is committed and nothing else.
//
//   node bench/acceptance/replay.ts [bench/logs/acceptance-v1.json]
//   node bench/acceptance/replay.ts bench/logs/acceptance-v2.json
//
// No clone, no credentials, no request. The output is the exact block the document carries between
// its `acceptance:begin` and `acceptance:end` markers (v1) or `acceptance-v2:begin` and
// `acceptance-v2:end` (v2), and a test compares each with the document byte for byte, so a number
// typed into the document by hand, or left behind by a later run, fails the suite.
//
// Which cases a table covers is the log's, and so is each case's role: a case used to tune the tool
// after it was measured is still unseen in the table of that measurement. A log that records no role
// (v1) was measured on unseen cases only. A log that records roles says so in its table.
//
// It refuses to print a table the claim above that table would not hold of: fewer than two
// repositories, no target outside the diff, a branch sent to Jev fewer than three times, or a
// branch whose commits are not the ones its case.json fixed.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLive, RUNS, ScoringError, scoreVersion, type CaseFile, type Row, type VersionLog } from "./score.ts";

export interface AcceptanceLog {
  conditions: Record<string, unknown>;
  /** `role` is the case's role when it was measured; a log without it measured unseen cases only. */
  cases: Record<string, { role?: CaseFile["role"]; versions: Record<string, VersionLog> }>;
}

interface Candidates {
  candidates: { order: number; ref: string; a: string; b?: string; c?: string }[];
  gateResult?: { cap?: number };
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

export function loadCases(dir = join(HERE, "cases")): CaseFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      let text: string;
      try {
        text = readFileSync(join(dir, d.name, "case.json"), "utf8");
      } catch (error) {
        // A case directory with no case.json was examined and not built. Anything else is an error.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return [JSON.parse(text) as CaseFile];
    });
}

const EXPECTED_WORDS = { listed: "listed", not_listed: "not listed", undetermined: "no confident reading" } as const;

function reachWords(row: Row): string {
  const r = row.reach;
  if (r.stage === "in_budget") return "asked";
  if (r.stage === "over_budget") return "enumerated, over the budget";
  if (r.stage === "held") return `held before any question (${r.kind})`;
  return r.capNoted ? "not enumerated (a cap fired; cap or structure)" : "not enumerated";
}

function readings(row: Row): string {
  if (row.runs.length === 0) return "—";
  return row.runs
    .map((x) => {
      const m = x.mapping ? `${x.mapping.verdict} ${x.mapping.probability.toFixed(2)}` : x.stage;
      const o = x.observation ? `${x.observation.observation} ${x.observation.probability.toFixed(2)}` : "—";
      return `${m} / ${o}${x.listed ? " · listed" : ""}`;
    })
    .join("; ");
}

function result(row: Row): string {
  if (row.agrees === null) return row.runs.length === 0 ? "not reached" : `${row.right}/${row.runs.length} (fewer than ${RUNS} runs)`;
  return `${row.right}/${RUNS} ${row.agrees ? "agrees" : "differs"}`;
}

/** The whole block, or a ScoringError naming the condition that does not hold. */
export function render(cases: readonly CaseFile[], log: AcceptanceLog, candidates: Candidates): string {
  const recordsRoles = Object.values(log.cases).some((c) => c.role !== undefined);
  const roleOf = (id: string) => log.cases[id]?.role ?? "unseen";
  // A table of unseen cases that leaves one out would read as covering them all. Only a log that
  // records no role is held to this: v1, whose cases were the only unseen ones. A case built unseen
  // later is measured into a later log, and this check would then refuse v1's table; whoever adds
  // one decides then how v1 names what it did not measure.
  if (!recordsRoles) {
    for (const c of cases) if (c.role === "unseen" && !log.cases[c.id]) throw new ScoringError(`${c.id} is an unseen case with no measurement in the log`);
  }
  const measured = Object.keys(log.cases).map((id) => {
    const c = cases.find((x) => x.id === id);
    if (!c) throw new ScoringError(`${id} is measured in the log but has no case.json, so it would drop out of the table unseen`);
    return c;
  });
  const repos = new Set(measured.map((c) => c.repo));
  if (repos.size < 2) throw new ScoringError(`the log covers ${repos.size} repository, and the claim needs two or more`);

  const lines: string[] = [];
  const table: string[] = recordsRoles
    ? ["| case | role | version | target | expected | reach | readings (mapping / behaviour) | result |", "|---|---|---|---|---|---|---|---|"]
    : ["| case | version | target | expected | reach | readings (mapping / behaviour) | result |", "|---|---|---|---|---|---|---|"];
  let outside = 0;
  let listedElsewhere = 0;
  let requests = 0;
  let runs = 0;
  for (const c of measured) {
    const versions = log.cases[c.id]!.versions;
    for (const versionId of Object.keys(versions)) {
      if (!c.versions[versionId]) throw new ScoringError(`${c.id} ${versionId} is in the log and not in case.json, so it would drop out of the table unseen`);
    }
    for (const [versionId, version] of Object.entries(c.versions)) {
      const v = versions[versionId];
      if (!v) throw new ScoringError(`${c.id} ${versionId} is in case.json and not in the log`);
      const finished = v.runs.filter((r) => r.finished).length;
      // Every run sent counts, finished or not: what was spent is what was sent.
      for (const run of v.runs as (typeof v.runs[number] & { requests?: number })[]) {
        requests += run.requests ?? 0;
        runs += 1;
      }
      if (isLive(version, v.enumeration) && finished < RUNS) {
        throw new ScoringError(`${c.id} ${versionId} was sent to Jev ${finished} times to completion, not ${RUNS}`);
      }
      if ((version.place === "B" || version.place === "C") && Object.values(version.expected).includes("listed")) outside += 1;
      const rows = scoreVersion(c, versionId, v);
      for (const row of rows) {
        table.push(`| ${c.id} |${recordsRoles ? ` ${roleOf(c.id)} |` : ""} ${versionId} | ${row.targetKey} \`${row.target.function}\` | ${EXPECTED_WORDS[row.expected]} | ${reachWords(row)} | ${readings(row)} | ${result(row)} |`);
      }
      const targets = Object.values(version.targets);
      const elsewhere = new Set<string>();
      for (const run of v.runs.filter((r) => r.finished).slice(0, RUNS)) {
        for (const r of run.requirements) {
          for (const f of r.findings) {
            if (!targets.some((t) => t.file === f.file && t.function === f.function && t.call === f.call)) elsewhere.add(`${f.file}\u0000${f.function}\u0000${f.call}`);
          }
        }
      }
      listedElsewhere += elsewhere.size;
    }
  }
  if (outside === 0) throw new ScoringError("no version places a defect outside the diff, and the claim is about one");

  const examined = candidates.candidates.length;
  const passed = (k: "a" | "b" | "c") => candidates.candidates.filter((x) => x[k] === "pass").length;
  // candidates.json's (b) is what the tool of the first measurement could reach; a later table does
  // not print it as if it were today's.
  const tool = (log.conditions.tool as { commit?: string } | undefined)?.commit?.slice(0, 7) ?? "unknown";
  const tuned = measured.filter((c) => roleOf(c.id) === "regression").map((c) => c.id);
  lines.push(
    recordsRoles
      ? `Measured again with the tool at ${tool}: ${measured.length} requirements from ${repos.size} repositories. Used to tune the tool before this measurement: ${tuned.length === 0 ? "none" : tuned.join(", ")}.`
      : `Candidates examined: ${examined} (cap ${candidates.gateResult?.cap ?? 20}). Passed condition (a): ${passed("a")}, (b): ${passed("b")}, (c): ${passed("c")}. Measured: ${measured.length} requirements from ${repos.size} repositories.`,
    "",
    ...table,
    "",
    `Calls other than the targets that were listed in these runs, not scored: ${listedElsewhere}. Requests sent to Jev: ${requests}, over ${runs} runs.`,
  );
  return lines.join("\n");
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
  const path = process.argv[2] ?? join(HERE, "..", "logs", "acceptance-v1.json");
  try {
    const log = JSON.parse(readFileSync(path, "utf8")) as AcceptanceLog;
    const candidates = JSON.parse(readFileSync(join(HERE, "candidates.json"), "utf8")) as Candidates;
    process.stdout.write(`${render(loadCases(), log, candidates)}\n`);
  } catch (error) {
    if (!(error instanceof ScoringError)) throw error;
    console.error(`no table: ${error.message}`);
    process.exitCode = 1;
  }
}
