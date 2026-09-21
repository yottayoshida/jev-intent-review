// What the generated plans do when the gate that stopped them is taken away.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/b-replay-check.ts <omamori-clone> [runs] [log path]
//
// `#20` said B failed on four counts, and one of them — declaring no needed referent — turned out
// to be the runner's rule rather than B's mistake: `bench/logs/referent-needed-v1.json` reads
// every cell 12/12 with the referent taken out, because the condition already stipulates what the
// callee returns. So B was stopped by a gate, and what its plans would have done was never
// measured.
//
// This measures it. The plans are **replayed from `bench/logs/three-way-v1.json`**, not generated
// again, so nothing drifts: the same symbols, the same conditions, the answer B wrote into
// `yields` included. Only the empty-referent stop is gone.
//
// Written before the run: B picked `read_to_string_capped` for the first case and `load_config`
// for the second. Neither is touched by either mutation, so both should answer the same for the
// shipped branch and the mutated one — which is the failure worth naming, and a different one from
// "the plan was rejected before it ran".

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence, type Packet } from "../src/evidence/builder.ts";
import { JevClient, endpointFromEnv } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, verdictOfV3 } from "./check-questions-v3.ts";
import { questionsV5, type ConditionV5 } from "./check-questions-v5.ts";

const HERE = import.meta.dirname;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const prior = JSON.parse(readFileSync(join(HERE, "logs/three-way-v1.json"), "utf8")) as {
  generatedPlans: Record<string, Record<string, unknown>>;
  plans: { comparison: { cases: { id: string; requirement: { quote: string; primarySource: string; id: string } }[] } };
};

const BRANCHES: Record<string, { correct: string; mutant: string }> = {
  "omamori-read-baseline": { correct: "correct", mutant: "m-read-baseline" },
  "omamori-raw-override-disables": { correct: "correct", mutant: "m-raw-override" },
};

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/b-replay-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "b-replay.json";
const HARD_LIMIT = 20;

const endpoint = endpointFromEnv();
if (!endpoint) throw new Error("no credentials: set JEV_PROVIDER (cloudflare, typesafe or vercel) with its key, the Cloudflare pair, or JEV_API_URL and JEV_API_TOKEN");
const client = new JevClient(endpoint, { maxRetries: 0, maxRequests: HARD_LIMIT });
const provider = new JevProvider(client);
const git = new Git(repoDir);

const packets = new Map<string, unknown>();
const rows: Record<string, unknown>[] = [];

console.log(`replaying the plans in bench/logs/three-way-v1.json · bar ${BAR_V3} · ${runs} run(s) per cell · hard limit ${HARD_LIMIT}\n`);

for (const [caseId, plan] of Object.entries(prior.generatedPlans)) {
  const r = prior.plans.comparison.cases.find((x) => x.id === caseId)!.requirement;
  const requirement: Requirement = { id: r.id, text: r.quote, kind: "behavior", priority: "required", sourceRefs: [{ sourceId: r.primarySource, quote: r.quote }], searchHints: [] };
  const symbol = String(plan.symbol ?? "");
  const condition: ConditionV5 = {
    target: symbol,
    setup: String(plan.setup ?? ""),
    occurrence: String(plan.occurrence ?? ""),
    operation: String(plan.operation ?? ""),
    yields: String(plan.yields ?? ""),
    others: String(plan.others ?? ""),
    extra: String(plan.extra ?? ""),
  };
  console.log(`-- ${caseId}: the generated plan targets \`${symbol}\` with operation \`${condition.operation}\``);
  const answers: Record<string, string[]> = {};
  for (const [which, branch] of Object.entries(BRANCHES[caseId]!)) {
    const commit = await git.resolve(branch);
    const discoverer = new Discoverer(git, commit, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
    const { hits } = await discoverer.search(symbol);
    const definitions = hits.filter((h) => defines(h.text, symbol));
    if (definitions.length !== 1) {
      console.log(`   SKIP ${which}: ${symbol} is defined ${definitions.length} times`);
      rows.push({ case: caseId, which, branch, symbol, problem: `defined ${definitions.length} times` });
      continue;
    }
    const definition = definitions[0]!;
    const index = await discoverer.index(definition.path);
    if (!index) continue;
    const block = index.enclosing(definition.line);
    const candidate: Candidate = { path: definition.path, startLine: block.startLine, endLine: block.endLine, symbol, changed: true, reasons: [`the generated plan names ${symbol}`], ...(block.windowed ? { windowed: true } : {}) };
    const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
    const state: Packet = { ...evidence.packet, evidence: { ...evidence.packet.evidence, related: [], truncated: true } };
    const stateHash = hash(state);
    packets.set(stateHash, state);
    const qs = questionsV5(condition);
    answers[which] = [];
    for (let run = 1; run <= runs; run++) {
      try {
        const got = (await provider.judge(state, qs)) as Record<string, ChoiceAnswer | undefined>;
        const result = got.on_error_result;
        const p = result ? probabilityOf(result, result.choice) : 0;
        const { verdict } = verdictOfV3(result?.choice, p);
        answers[which].push(`${result?.choice} ${p.toFixed(2)}`);
        rows.push({ case: caseId, which, branch, commit, run, symbol, targetPath: definition.path, targetLines: `${block.startLine}-${block.endLine}`, sentStateHash: stateHash, questionsHash: hash(qs), got, result: { choice: result?.choice ?? "none", probability: p }, verdict });
        console.log(`   ${which.padEnd(8)} run ${run}: ${result?.choice} ${p.toFixed(2)} → ${verdict}   (${definition.path}:${block.startLine})`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        rows.push({ case: caseId, which, branch, run, symbol, error: message });
        console.log(`   FAIL ${which} run ${run}: ${message}`);
      }
    }
  }
  const same = answers.correct && answers.mutant && JSON.stringify(answers.correct.map((a) => a.split(" ")[0])) === JSON.stringify(answers.mutant.map((a) => a.split(" ")[0]));
  console.log(`   → the shipped branch and the mutated one answer ${same ? "the SAME" : "differently"}\n`);
}

writeFileSync(
  out,
  JSON.stringify(
    {
      question: "With the empty-referent stop removed, what do the generated plans do on the shipped and the mutated branch?",
      notAFirstMeasurement: "The plans are replayed from bench/logs/three-way-v1.json rather than generated again.",
      tool: { name: "jev-intent-review", version: VERSION, model: provider.model },
      replayedPlans: prior.generatedPlans,
      bar: BAR_V3,
      runs,
      sent: { requests: client.sent.requests, bytes: client.sent.bytes, hardLimit: HARD_LIMIT },
      packets: Object.fromEntries(packets),
      log: rows,
    },
    null,
    2,
  ),
);
console.log(`requests ${client.sent.requests}/${HARD_LIMIT} · ${(client.sent.bytes / 1024).toFixed(0)} KB · ${out}`);
