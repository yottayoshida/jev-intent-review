// Was the referent needed at all?
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/referent-needed-check.ts <omamori-clone> [runs] [log path]
//
// `#20` scored the generated plan as failing partly because it declared no needed referent, and
// the runner stopped on an empty list before asking anything. Reading the two conditions back,
// that rule is stronger than the thing it was meant to enforce:
//
//   `#18`'s condition assumes the *iterator* yields `Err`. `collect_listing` stands between that
//   and the target, so what the target returns depends on a body that is not in the target.
//
//   `#20`'s condition assumes `read_to_string_capped(…)` **itself** returns `Err(io_error)`. The
//   callee's behaviour is already stipulated, so the target's own `?` — or the mutant's
//   `else { return Ok(None) }` — settles the answer without it.
//
// So the hand-written plan declared a referent it did not need, and the generated plan may have
// been right to declare none. This measures it rather than arguing it: the same condition, the
// same target bodies, with the referent taken out of the packet. If the answers hold, the gate
// was withholding a question it could have asked, and `#20`'s account of why B failed loses one
// of its four items.
//
// Written before the run: the shipped bodies should still answer `returns_error` and the mutants
// `returns_success`, all at or above the bar, because nothing in either body needs the callee once
// the callee's result is given. Being wrong would mean the referent is load-bearing after all.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence, type Packet } from "../src/evidence/builder.ts";
import { CloudflareClient, endpointFromEnv } from "../src/judgments/cloudflare.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, score, verdictOfV3 } from "./check-questions-v3.ts";
import { questionsV5, type ConditionV5 } from "./check-questions-v5.ts";

const HERE = import.meta.dirname;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const aPlansText = readFileSync(join(HERE, "plans/three-way-A-plans.json"), "utf8");
const comparisonText = readFileSync(join(HERE, "plans/three-way-comparison.json"), "utf8");
const aPlans = JSON.parse(aPlansText) as { cases: { id: string; file: string; symbol: string; condition: ConditionV5 }[] };
const comparison = JSON.parse(comparisonText) as { cases: { id: string; requirement: { quote: string; primarySource: string; id: string } }[] };

const BRANCHES: Record<string, { correct: string; mutant: string }> = {
  "omamori-read-baseline": { correct: "correct", mutant: "m-read-baseline" },
  "omamori-raw-override-disables": { correct: "correct", mutant: "m-raw-override" },
};
const TRUTH = { correct: "returns_error", mutant: "returns_success" } as const;

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/referent-needed-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "referent-needed.json";
const HARD_LIMIT = 20;

const endpoint = endpointFromEnv();
if (!endpoint) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const client = new CloudflareClient(endpoint, { maxRetries: 0, maxRequests: HARD_LIMIT });
const provider = new JevProvider(client);
const git = new Git(repoDir);

const packets = new Map<string, unknown>();
const rows: Record<string, unknown>[] = [];

console.log(`bar ${BAR_V3} · ${runs} run(s) per cell · hard limit ${HARD_LIMIT} · the packet is the target's body and nothing else\n`);

for (const c of aPlans.cases) {
  const r = comparison.cases.find((x) => x.id === c.id)!.requirement;
  const requirement: Requirement = { id: r.id, text: r.quote, kind: "behavior", priority: "required", sourceRefs: [{ sourceId: r.primarySource, quote: r.quote }], searchHints: [] };
  for (const [which, branch] of Object.entries(BRANCHES[c.id]!)) {
    const commit = await git.resolve(branch);
    const discoverer = new Discoverer(git, commit, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
    const { hits } = await discoverer.search(c.symbol);
    const definition = hits.filter((h) => defines(h.text, c.symbol) && h.path === c.file)[0];
    if (!definition) {
      console.log(`SKIP ${c.id}/${which}: ${c.symbol} not found in ${c.file}`);
      continue;
    }
    const index = await discoverer.index(definition.path);
    if (!index) continue;
    const block = index.enclosing(definition.line);
    const candidate: Candidate = { path: definition.path, startLine: block.startLine, endLine: block.endLine, symbol: c.symbol, changed: true, reasons: [`the plan names ${c.symbol}`], ...(block.windowed ? { windowed: true } : {}) };
    const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
    // The target's body and nothing else. `truncated` stays true: something was taken out.
    const state: Packet = { ...evidence.packet, evidence: { ...evidence.packet.evidence, related: [], truncated: true } };
    const stateHash = hash(state);
    packets.set(stateHash, state);
    const qs = questionsV5(c.condition);
    const truth = TRUTH[which as keyof typeof TRUTH];
    for (let run = 1; run <= runs; run++) {
      try {
        const answers = (await provider.judge(state, qs)) as Record<string, ChoiceAnswer | undefined>;
        const result = answers.on_error_result;
        const p = result ? probabilityOf(result, result.choice) : 0;
        const s = score(result?.choice ?? "none", p, truth);
        const { verdict } = verdictOfV3(result?.choice, p);
        rows.push({ case: c.id, which, branch, commit, run, truth, sentStateHash: stateHash, questionsHash: hash(qs), answers, result: { choice: result?.choice ?? "none", probability: p, choiceMatch: s.choiceMatch, counted: s.counted }, verdict });
        console.log(`${s.counted ? "READS" : "MISS "} ${`${c.id}/${which}`.padEnd(42)} run ${run}: ${result?.choice} ${p.toFixed(2)} → ${verdict}` + (s.counted ? "" : `  — the code returns ${truth}`));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        rows.push({ case: c.id, which, branch, run, truth, error: message });
        console.log(`FAIL  ${c.id}/${which} run ${run}: ${message}`);
      }
    }
  }
}

writeFileSync(
  out,
  JSON.stringify(
    {
      question: "Is the declared referent load-bearing when the condition already stipulates what it returns?",
      notAFirstMeasurementOfTheComparison: "Run after #20, to settle one of the four things that run said the generated plan was missing.",
      tool: { name: "jev-intent-review", version: VERSION, model: provider.model },
      questionVersion: "v5, the same conditions as bench/plans/three-way-A-plans.json",
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

const cells = new Map<string, { n: number; ok: number; truth: string }>();
for (const r of rows) {
  const key = `${r.case}/${r.which}`;
  const cur = cells.get(key) ?? { n: 0, ok: 0, truth: String(r.truth) };
  cur.n += 1;
  if ((r.result as { counted?: boolean } | undefined)?.counted) cur.ok += 1;
  cells.set(key, cur);
}
console.log("\ncell                                        the code returns   right without the referent");
for (const [k, v] of cells) console.log(`  ${k.padEnd(42)} ${v.truth.padEnd(17)} ${v.ok}/${v.n}`);
const all = [...cells.values()].every((v) => v.ok === v.n);
console.log(`\nrequests ${client.sent.requests}/${HARD_LIMIT} · ${(client.sent.bytes / 1024).toFixed(0)} KB · ${out}`);
console.log(all ? "the referent was not load-bearing: every cell reads correctly without it" : "at least one cell needs it");
process.exitCode = all ? 0 : 1;
