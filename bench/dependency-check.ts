// With the dependency in the packet, can the plan tell a defect in the target from a defect in
// the dependency?
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/dependency-check.ts <omamori-clone> [runs] [log path]
//
// The plan is `bench/plans/omamori-553-r2-dependency.json`, written before the first request. The
// requirement, the condition data and the target come from `bench/plans/omamori-553-r2.json` and
// are re-read rather than copied.
//
// The case this run is built around: a third branch whose `src/cli/doctor.rs` is byte-identical to
// the shipped commit, with `collect_listing` changed to swallow the per-entry error. The target's
// body cannot distinguish it from the shipped pair, and the correct answers are opposite. The run
// checks that byte-identity itself, before asking anything — if the two bodies ever differ, the
// case is not what the plan says it is and the numbers mean something else.
//
// Two question versions in one session: v3 as the baseline, v4 naming the target and saying what
// the related entries are for. Same criteria, same verdict rule, same bar; only `instructions`
// differ, which is still a change of contract.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence, type Packet, type Related } from "../src/evidence/builder.ts";
import { JevClient, endpointFromEnv } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, questionsV3, score, verdictOfV3, type ConditionV3 } from "./check-questions-v3.ts";
import { questionsV4, type ConditionV4 } from "./check-questions-v4.ts";
import { SELECTIONS, classify, referentsPresent, type Classified } from "./evidence-selection.ts";

const HERE = import.meta.dirname;
const TOOL_REPO = dirname(HERE);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const basePlanText = readFileSync(join(HERE, "plans/omamori-553-r2.json"), "utf8");
const planText = readFileSync(join(HERE, "plans/omamori-553-r2-dependency.json"), "utf8");
const basePlan = JSON.parse(basePlanText) as {
  requirement: { id: string; textSentToTheModel: string; primarySource: { url: string; quote: string } };
  target: { file: string; symbol: string; neededReferents: string[] };
  condition: ConditionV3 & Record<string, unknown>;
};
const plan = JSON.parse(planText) as {
  neededReferents: string[];
  cases: { id: string; branch: string; truth: string | null; sendsRequests: boolean; isDiagnostic?: boolean }[];
  requestBudget: { hardLimit: number };
};

const SYMBOL = basePlan.target.symbol;
// Declared by this run's plan, not the base one: which referent a question needs is a property of
// the question, and the base plan predates the idea.
const NEEDED = plan.neededReferents;
const conditionV3: ConditionV3 = {
  setup: basePlan.condition.setup,
  operation: basePlan.condition.operation,
  yields: basePlan.condition.yields,
  others: basePlan.condition.others,
  finite: basePlan.condition.finite,
};
const conditionV4: ConditionV4 = { target: SYMBOL, ...conditionV3 };
const VERSIONS = { v3: questionsV3(conditionV3), v4: questionsV4(conditionV4) } as const;
type VersionId = keyof typeof VERSIONS;

const requirement: Requirement = {
  id: basePlan.requirement.id,
  text: basePlan.requirement.textSentToTheModel,
  kind: "behavior",
  priority: "required",
  sourceRefs: [{ sourceId: basePlan.requirement.primarySource.url, quote: basePlan.requirement.primarySource.quote }],
  searchHints: [],
};

interface Built {
  commit: string;
  packet: Packet;
  entries: Classified[];
}

async function build(git: Git, branch: string): Promise<Built> {
  const commit = await git.resolve(branch);
  const discoverer = new Discoverer(git, commit, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const { hits } = await discoverer.search(SYMBOL);
  const definitions = hits.filter((h) => defines(h.text, SYMBOL));
  if (definitions.length !== 1) throw new Error(`${SYMBOL} is defined ${definitions.length} times at ${branch}`);
  const definition = definitions[0]!;
  const index = await discoverer.index(definition.path);
  if (!index) throw new Error(`${definition.path} unreadable at ${branch}`);
  const block = index.enclosing(definition.line);
  const candidate: Candidate = {
    path: definition.path,
    startLine: block.startLine,
    endLine: block.endLine,
    symbol: SYMBOL,
    changed: true,
    reasons: [`the plan names ${SYMBOL}`],
    ...(block.windowed ? { windowed: true } : {}),
  };
  const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
  const flags = await Promise.all(
    evidence.packet.evidence.related.map(async (e) => {
      const i = await discoverer.index(e.path);
      const line = Number(e.lines.split("-")[0]);
      return (i?.testRegions ?? []).some((r) => line >= r.start && line <= r.end);
    }),
  );
  const entries = classify(evidence.packet.evidence.related, NEEDED, (path, line) =>
    flags[evidence.packet.evidence.related.findIndex((e) => e.path === path && Number(e.lines.split("-")[0]) === line)] ?? false,
  );
  return { commit, packet: evidence.packet, entries };
}

const withRelated = (built: Built, kept: readonly Classified[]): Packet => {
  const related: Related[] = kept.map(({ path, lines, code }) => ({ path, lines, code }));
  return { ...built.packet, evidence: { ...built.packet.evidence, related, truncated: true } };
};

// ---------------------------------------------------------------------------

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/dependency-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "dependency-check.json";
const dry = process.env.DRY_RUN === "1";
const hardLimit = plan.requestBudget.hardLimit;

const endpoint = endpointFromEnv();
if (!endpoint && !dry) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const client = new JevClient(endpoint ?? { url: "https://example.invalid/dry", token: "unused", source: "JEV_API_URL" }, { maxRetries: 0, maxRequests: dry ? 0 : hardLimit });
const provider = new JevProvider(client);
const git = new Git(repoDir);

const built = new Map<string, Built>();
for (const branch of ["correct", "mutant", "dep-mutant"]) built.set(branch, await build(git, branch));

/**
 * The premise of the whole run, checked rather than asserted: the shipped target and the
 * dependency-mutant target are the same bytes, so a packet without the dependency cannot tell them
 * apart and the correct answers are opposite.
 */
const sameBody = built.get("correct")!.packet.evidence.code === built.get("dep-mutant")!.packet.evidence.code;
const bodyCheck = {
  identical: sameBody,
  correctHash: hash(built.get("correct")!.packet.evidence.code),
  depMutantHash: hash(built.get("dep-mutant")!.packet.evidence.code),
  mutantHash: hash(built.get("mutant")!.packet.evidence.code),
  means: sameBody
    ? "One input, two correct answers, whenever the dependency is left out. Anything answered there is a guess."
    : "NOT IDENTICAL — the case is not what the plan describes and the numbers below mean something else.",
};

const packets = new Map<string, unknown>();
const rows: Record<string, unknown>[] = [];
const tally = new Map<string, { runs: number; choiceMatch: number; counted: number; truth: string }>();

async function measure(version: VersionId, id: string, state: Packet, truth: string, extra: Record<string, unknown>): Promise<boolean> {
  const key = `${version}/${id}`;
  const stateHash = hash(state);
  packets.set(stateHash, state);
  if (!tally.has(key)) tally.set(key, { runs: 0, choiceMatch: 0, counted: 0, truth });
  const t = tally.get(key)!;
  for (let run = 1; run <= runs; run++) {
    try {
      const answers = (await provider.judge(state, VERSIONS[version])) as Record<string, ChoiceAnswer | undefined>;
      const result = answers.on_error_result;
      const control = answers.on_error_control;
      const p = result ? probabilityOf(result, result.choice) : 0;
      const s = score(result?.choice ?? "none", p, truth);
      const { verdict, why } = verdictOfV3(result?.choice, p);
      const pTrue = result?.probabilities?.[truth] ?? (result?.choice === truth ? result.confidence : 0);
      t.runs += 1;
      if (s.choiceMatch) t.choiceMatch += 1;
      if (s.counted) t.counted += 1;
      rows.push({ version, case: id, run, ...extra, truth, sentStateHash: stateHash, answers, result: { choice: result?.choice ?? "none", probability: p, probabilityOfTruth: pTrue, choiceMatch: s.choiceMatch, counted: s.counted }, control: { choice: control?.choice ?? "none", probability: control ? probabilityOf(control, control.choice) : 0 }, verdict, why });
      console.log(`${s.counted ? "READS" : "MISS "} ${key.padEnd(28)} run ${run}: ${result?.choice} ${p.toFixed(2)} (p(true)=${pTrue.toFixed(2)}) → ${verdict}` + (s.counted ? "" : `  — the code returns ${truth}`));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      t.runs += 1;
      rows.push({ version, case: id, run, ...extra, truth, sentStateHash: stateHash, error: message });
      console.log(`FAIL  ${key.padEnd(28)} run ${run}: ${message}`);
      if (/budget|maxRequests|request limit/i.test(message)) return false;
    }
  }
  return true;
}

console.log(`plan ${hash(planText)} · v3 ${hash(VERSIONS.v3)} · v4 ${hash(VERSIONS.v4)} · bar ${BAR_V3} · ${runs} run(s) per cell · hard limit ${hardLimit}`);
console.log(`target body identical (correct vs dep-mutant): ${bodyCheck.identical} — ${bodyCheck.means}`);
for (const [b, v] of built) console.log(`  ${b.padEnd(11)} @ ${v.commit.slice(0, 7)} · body ${v.packet.evidence.code.length} chars (${hash(v.packet.evidence.code)}) · related ${v.entries.map((e) => e.kind).join(",")}`);
console.log("");

const withDependency = (branch: string) => {
  const b = built.get(branch)!;
  const kept = SELECTIONS["callee-only"](b.entries);
  return { built: b, kept, packet: withRelated(b, kept), referents: referentsPresent(kept, NEEDED) };
};

if (dry) {
  console.log("DRY_RUN=1 — packets are built and nothing is sent.\n");
  for (const c of plan.cases) {
    const w = withDependency(c.branch);
    const kept = c.id === "no-dependency" ? [] : w.kept;
    const state = withRelated(w.built, kept);
    const dep = state.evidence.related[0];
    console.log(`  ${c.id.padEnd(20)} body ${hash(state.evidence.code)} · dependency ${dep ? `${dep.path}:${dep.lines} ${hash(dep.code)}` : "(none)"} · referents ${referentsPresent(kept, NEEDED).ok ? "present" : "MISSING"}`);
  }
  console.log(`\nv4 asks: ${VERSIONS.v4.on_error_result.instructions}`);
  process.exit(0);
}

const local: Record<string, unknown>[] = [];
outer: for (const version of ["v4", "v3"] as const) {
  for (const c of plan.cases) {
    if (version === "v3" && c.isDiagnostic) continue; // the baseline is the three real cases
    const w = withDependency(c.branch);
    const kept = c.id === "no-dependency" ? [] : w.kept;
    const refs = referentsPresent(kept, NEEDED);
    if (!refs.ok && version === "v4") {
      local.push({ version, case: c.id, withheldByGate: refs.reason, alsoSentAsDiagnostic: true });
      console.log(`HELD  ${version}/${c.id.padEnd(22)} the referent gate withholds this shape: ${refs.reason}`);
    }
    const truth = c.truth ?? "returns_error"; // the diagnostic's packet is the shipped body; scored, but read as a guess
    const ok = await measure(version, c.id, withRelated(w.built, kept), truth, {
      branch: c.branch,
      commit: w.built.commit,
      dependencyInPacket: kept.length > 0,
      dependencyHash: kept[0] ? hash(kept[0].code) : null,
      referents: refs,
      isDiagnostic: c.isDiagnostic ?? false,
    });
    if (!ok) break outer;
  }
  console.log("");
}

// ---------------------------------------------------------------------------

writeFileSync(
  out,
  JSON.stringify(
    {
      tool: { name: "jev-intent-review", version: VERSION, commit: await new Git(TOOL_REPO).resolve("HEAD").catch(() => "unknown"), model: provider.model },
      plan: { path: "bench/plans/omamori-553-r2-dependency.json", hash: hash(planText), content: JSON.parse(planText) },
      basePlan: { path: "bench/plans/omamori-553-r2.json", hash: hash(basePlanText) },
      questions: VERSIONS,
      questionHashes: { v3: hash(VERSIONS.v3), v4: hash(VERSIONS.v4) },
      conditions: { v3: conditionV3, v4: conditionV4 },
      bar: BAR_V3,
      targetBodyCheck: bodyCheck,
      commits: Object.fromEntries([...built].map(([b, v]) => [b, v.commit])),
      runs,
      sent: { requests: client.sent.requests, bytes: client.sent.bytes, hardLimit },
      packets: Object.fromEntries(packets),
      log: rows,
      localDecisions: local,
    },
    null,
    2,
  ),
);

console.log("cell                         the code returns   answered                p(true)     over the bar");
for (const [key, t] of tally) {
  const cell = rows.filter((r) => `${r.version}/${r.case}` === key && r.result);
  const choices = [...new Set(cell.map((r) => (r.result as { choice: string }).choice))].join("/");
  const ps = cell.map((r) => (r.result as { probabilityOfTruth: number }).probabilityOfTruth);
  console.log(`  ${key.padEnd(28)} ${t.truth.padEnd(17)} ${choices.padEnd(22)} ${ps.length ? `${Math.min(...ps).toFixed(2)}-${Math.max(...ps).toFixed(2)}` : "-"}   ${t.counted}/${t.runs}`);
}
const real = [...tally.entries()].filter(([k]) => k.startsWith("v4/") && !k.endsWith("no-dependency"));
const passed = real.every(([, t]) => t.counted === t.runs);
console.log(`\nrequests ${client.sent.requests}/${hardLimit} · ${(client.sent.bytes / 1024).toFixed(0)} KB · full record in ${out}`);
console.log(passed ? "EXIT CONDITION MET under v4: a defect in the target and a defect in the dependency are both distinguished." : `exit condition not met under v4: ${real.filter(([, t]) => t.counted < t.runs).map(([k]) => k).join(", ")}`);
process.exitCode = passed ? 0 : 1;
