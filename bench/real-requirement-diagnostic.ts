// Why the mutant was read as returning an error. A diagnostic, run after seeing that result.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/real-requirement-diagnostic.ts <omamori-clone> [runs] [log path]
//
// **This is not a first measurement and does not count as one.** `bench/logs/real-requirement-v3.json`
// is the first measurement and stands as it was recorded: on the real function, the plan answered
// `returns_error` 0.51-0.60 about a mutant that returns `Ok(StagingInfo)`, and one of the three
// runs cleared the bar and called the property held. Nothing below changes that log, that plan, or
// the question. It varies what is in the packet, to find out which part of it carries the wrong
// answer.
//
// Two parts of the packet could:
//
//   - **The requirement.** Every packet carries it, and this one says a failure is reported. An
//     answer copied from it would say `returns_error` whatever the code does. The mutant was put
//     in the plan as the detector for exactly this, and the detector fired.
//   - **The related evidence.** `buildEvidence` brings in `collect_listing` (which does return
//     `Err`) and `staging_info_at` (which returns `Err` on several paths). An answer about those
//     would also say `returns_error`.
//
// So: the mutant packet with the requirement blanked, the mutant packet with the related section
// emptied, and — as the control that keeps this from being a one-way test — the correct packet
// with the requirement blanked. If blanking the requirement flipped everything to
// `returns_success`, that would be a question that stops reading the code rather than a leak.
//
// Written before the first request of this run:
//
//   | case                        | if the requirement leaks | if the related code leaks | if neither |
//   |-----------------------------|--------------------------|---------------------------|------------|
//   | mutant, requirement blanked | returns_success          | returns_error             | returns_error |
//   | mutant, related emptied     | returns_error            | returns_success           | returns_error |
//   | correct, requirement blanked| returns_error            | returns_error             | returns_error |
//
// The third is the control: it must stay `returns_error`. A run where it does not says the blanked
// requirement moved the answer on its own, and the other two cells cannot be read.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence } from "../src/evidence/builder.ts";
import { JevClient, endpointFromEnv } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, questionsV3, score, verdictOfV3, type ConditionV3 } from "./check-questions-v3.ts";

const HERE = import.meta.dirname;
const TOOL_REPO = dirname(HERE);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const plan = JSON.parse(readFileSync(join(HERE, "plans/omamori-553-r2.json"), "utf8")) as {
  requirement: { id: string; textSentToTheModel: string; primarySource: { url: string; quote: string } };
  target: { file: string; symbol: string };
  condition: ConditionV3 & Record<string, unknown>;
};
const condition: ConditionV3 = {
  setup: plan.condition.setup,
  operation: plan.condition.operation,
  yields: plan.condition.yields,
  others: plan.condition.others,
  finite: plan.condition.finite,
};
const questions = questionsV3(condition);

/** What replaces the requirement. It states no direction and names no behaviour. */
const BLANK_REQUIREMENT = "(not shown)";

const requirement: Requirement = {
  id: plan.requirement.id,
  text: plan.requirement.textSentToTheModel,
  kind: "behavior",
  priority: "required",
  sourceRefs: [{ sourceId: plan.requirement.primarySource.url, quote: plan.requirement.primarySource.quote }],
  searchHints: [],
};

interface Packet {
  requirement: { id: string; text: string };
  candidate: unknown;
  evidence: { code: string; related: unknown[]; truncated: boolean };
}

async function packetFor(git: Git, branch: string): Promise<{ commit: string; packet: Packet }> {
  const commit = await git.resolve(branch);
  const discoverer = new Discoverer(git, commit, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const { hits } = await discoverer.search(plan.target.symbol);
  const definitions = hits.filter((h) => defines(h.text, plan.target.symbol));
  if (definitions.length !== 1) throw new Error(`${plan.target.symbol} is defined ${definitions.length} times at ${branch}`);
  const definition = definitions[0]!;
  const index = await discoverer.index(definition.path);
  if (!index) throw new Error(`${definition.path} unreadable at ${branch}`);
  const block = index.enclosing(definition.line);
  const candidate: Candidate = {
    path: definition.path,
    startLine: block.startLine,
    endLine: block.endLine,
    symbol: plan.target.symbol,
    changed: true,
    reasons: [`the plan names ${plan.target.symbol}`],
    ...(block.windowed ? { windowed: true } : {}),
  };
  const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
  return { commit, packet: evidence.packet as unknown as Packet };
}

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/real-requirement-diagnostic.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "real-requirement-diagnostic.json";
const HARD_LIMIT = 15;

const endpoint = endpointFromEnv();
if (!endpoint) throw new Error("no credentials: set JEV_PROVIDER (cloudflare, typesafe or vercel) with its key, the Cloudflare pair, or JEV_API_URL and JEV_API_TOKEN");
const client = new JevClient(endpoint, { maxRetries: 0, maxRequests: HARD_LIMIT });
const provider = new JevProvider(client);
const git = new Git(repoDir);

const mutant = await packetFor(git, "mutant");
const correct = await packetFor(git, "correct");

const strip = (p: Packet, what: "requirement" | "related"): Packet =>
  what === "requirement"
    ? { ...p, requirement: { ...p.requirement, text: BLANK_REQUIREMENT } }
    : { ...p, evidence: { ...p.evidence, related: [], truncated: true } };

const CASES = [
  {
    id: "mutant/requirement-blanked",
    state: strip(mutant.packet, "requirement"),
    commit: mutant.commit,
    codeReallyReturns: "returns_success",
    reads: "the requirement is `(not shown)`; the related evidence is the one the tool built",
  },
  {
    id: "mutant/related-emptied",
    state: strip(mutant.packet, "related"),
    commit: mutant.commit,
    codeReallyReturns: "returns_success",
    reads: "the requirement is the real one; the related section is empty and the packet says it was cut",
  },
  {
    id: "control/correct-requirement-blanked",
    state: strip(correct.packet, "requirement"),
    commit: correct.commit,
    codeReallyReturns: "returns_error",
    reads: "the control: the shipped function with the requirement blanked, which must stay `returns_error`",
  },
];

const rows: unknown[] = [];
const tally = new Map<string, { runs: number; match: number; counted: number; choices: string[]; ps: number[] }>();

console.log(`DIAGNOSTIC — not a first measurement. questions ${hash(questions)} · bar ${BAR_V3} · ${runs} run(s) each · hard limit ${HARD_LIMIT}`);
console.log(`first measurement: bench/logs/real-requirement-v3.json (mutant answered returns_error 0.51-0.60)\n`);

for (const c of CASES) {
  tally.set(c.id, { runs: 0, match: 0, counted: 0, choices: [], ps: [] });
  const t = tally.get(c.id)!;
  for (let run = 1; run <= runs; run++) {
    try {
      const answers = (await provider.judge(c.state, questions)) as Record<string, ChoiceAnswer | undefined>;
      const result = answers.on_error_result;
      const p = result ? probabilityOf(result, result.choice) : 0;
      const s = score(result?.choice ?? "none", p, c.codeReallyReturns);
      const { verdict } = verdictOfV3(result?.choice, p);
      t.runs += 1;
      if (s.choiceMatch) t.match += 1;
      if (s.counted) t.counted += 1;
      t.choices.push(result?.choice ?? "none");
      t.ps.push(p);
      // `score` returns the same `probability` it was given, so the run that produced
      // `bench/logs/real-requirement-v3-diagnostic.json` recorded the same number either way; this
      // is written out in full so the field has one source.
      rows.push({ case: c.id, reads: c.reads, run, commit: c.commit, codeReallyReturns: c.codeReallyReturns, state: c.state, answers, result: { choice: result?.choice, probability: p, choiceMatch: s.choiceMatch, counted: s.counted }, verdict });
      console.log(`${s.choiceMatch ? "READ " : "MISS"} ${c.id.padEnd(38)} run ${run}: ${result?.choice} ${p.toFixed(2)} → ${verdict}  (the code returns ${c.codeReallyReturns})`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      rows.push({ case: c.id, run, error: message });
      console.log(`FAIL ${c.id.padEnd(38)} run ${run}: ${message}`);
    }
  }
}

writeFileSync(
  out,
  JSON.stringify(
    {
      kind: "diagnostic",
      notAFirstMeasurement: "Run after seeing bench/logs/real-requirement-v3.json. It varies the packet to locate which part carries the answer; it does not re-score the plan.",
      tool: { name: "jev-intent-review", version: VERSION, commit: await new Git(TOOL_REPO).resolve("HEAD").catch(() => "unknown"), model: provider.model },
      questions,
      questionsHash: hash(questions),
      condition,
      bar: BAR_V3,
      blankRequirement: BLANK_REQUIREMENT,
      runs,
      sent: { requests: client.sent.requests, bytes: client.sent.bytes, hardLimit: HARD_LIMIT },
      log: rows,
    },
    null,
    2,
  ),
);

console.log("\ncase                                   the code returns   answered                reads it");
for (const [id, t] of tally) {
  const c = CASES.find((x) => x.id === id)!;
  console.log(`  ${id.padEnd(38)} ${c.codeReallyReturns.padEnd(17)} ${[...new Set(t.choices)].join("/")} ${Math.min(...t.ps).toFixed(2)}-${Math.max(...t.ps).toFixed(2)}   ${t.match}/${t.runs}`);
}
console.log(`\nrequests ${client.sent.requests}/${HARD_LIMIT} · ${(client.sent.bytes / 1024).toFixed(0)} KB · full record in ${out}`);
