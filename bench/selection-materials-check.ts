// Does more of the original text get the selection to the call the mutation changed?
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/selection-materials-check.ts <omamori-clone> [runs] [log path]
//
// **Selection only. Nothing is sent to Jev.** `#24` spent 62 judgment requests and could score
// none of them; what is wanted here is narrower — whether more material reaches the right call —
// and judging is a separate question that only matters once it does.
//
//   A  the property sentence, as `#24` sent it
//   B  the same sentence plus the first paragraph of the pull request's summary
//
// The paragraph is taken mechanically (`bench/plans/omamori-476-summary.json` records the rule),
// and **it does not name the helper**: it says "in one shared helper" and never
// `read_to_string_capped`. So B failing would not show that choosing from words is the wrong
// idea — the name is not there to match. That is written down before the run, not after it.
//
// Scored by `bench/set-scoring.ts`: the defect is reached when the **call** the patch changes is
// in the set, never when merely its function is. Sites the question cannot be put to, and sites
// whose behaviour nobody established, stay in the set and are counted in their own columns — a
// method that discarded what it cannot handle would otherwise look better than one that reports
// it.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readModelJson } from "../src/intent/compiler.ts";
import { SUPERSEDED_PLANNING_MODEL as COMPILER_MODEL } from "./superseded-models.ts";
import { CloudflareClient, endpointFromEnv } from "../src/judgments/cloudflare.ts";
import { Git } from "../src/repository/git.ts";
import { VERSION } from "../src/version.ts";
import { enumerate, listingFor, type CallCandidate, type Candidates, type FunctionCandidate } from "./code-candidates.ts";
import { reachesTheDefect, type GroundTruth } from "./set-scoring.ts";
import { applicabilityOf } from "../src/plan/applicability.ts";
import { Discoverer } from "../src/discovery/discover.ts";

const HERE = import.meta.dirname;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const comparison = JSON.parse(readFileSync(join(HERE, "plans/three-way-comparison.json"), "utf8")) as {
  cases: { id: string; requirement: { quote: string; primarySource: string; id: string } }[];
};
const summary = JSON.parse(readFileSync(join(HERE, "plans/omamori-476-summary.json"), "utf8")) as { text: string; rule: string; source: string; namesTheHelper: boolean };

const CASES = [
  { id: "omamori-read-baseline", file: "src/integrity.rs", target: { functionName: "read_baseline", callee: "read_to_string_capped" } },
  { id: "omamori-raw-override-disables", file: "src/config.rs", target: { functionName: "raw_override_disables", callee: "read_to_string_capped" } },
] as const;

const MAX_PICKS = 4;
const MAX_SET = 5;

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      maxItems: MAX_PICKS,
      items: { type: "object", properties: { callId: { type: "string" }, clause: { type: "string", maxLength: 300 } }, required: ["callId", "clause"] },
    },
    notCovered: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
  },
  required: ["picks"],
};

const INSTRUCTIONS = `You are given one requirement and a listing of the functions and calls in one file, each with an id.

Pick every call the requirement governs — the calls whose failure the requirement is about. For each, say in your own words which part of the requirement it checks.

- picks[].callId: a call id from the listing.
- picks[].clause: which part of the requirement that call is governed by, quoted or paraphrased from the requirement itself.
- notCovered: what checking these calls leaves unchecked about the requirement.

Pick the calls the requirement is about, not every call in the file, and not only one if several apply. Do not invent ids.`;

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/selection-materials-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "selection-materials.json";
const dry = process.env.DRY_RUN === "1";
const HARD_LIMIT = 20; // 2 cases × 2 materials × 3 runs = 12, and nothing is judged

const endpoint = endpointFromEnv();
if (!endpoint && !dry) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const client = new CloudflareClient(endpoint ?? { url: "https://example.invalid/dry", token: "unused", source: "JEV_API_URL" }, { maxRetries: 0, maxRequests: dry ? 0 : HARD_LIMIT });
const git = new Git(repoDir);

const rows: Record<string, unknown>[] = [];

interface Site {
  call: CallCandidate;
  fn: FunctionCandidate;
  related: "stated" | "same_callee";
  clause?: string;
}

function stagesOf(stated: Site[], candidates: Candidates, fnOf: (c: CallCandidate) => FunctionCandidate) {
  const callees = new Set(stated.map((s) => s.call.callee.split("::").pop()!));
  const siblings: Site[] = candidates.calls
    .filter((k) => callees.has(k.callee.split("::").pop()!) && !stated.some((s) => s.call.id === k.id))
    .map((k) => ({ call: k, fn: fnOf(k), related: "same_callee" as const }));
  const widened = [...stated, ...siblings];
  return { picked: stated, widened, withinBudget: widened.slice(0, MAX_SET), leftOver: Math.max(0, widened.length - MAX_SET) };
}

console.log(`selection only — nothing is judged · ${runs} run(s) per case per material · hard limit ${HARD_LIMIT} · ${COMPILER_MODEL}`);
console.log(`B adds: ${summary.text.slice(0, 96)}…`);
console.log(`the added paragraph names the helper: ${summary.namesTheHelper}\n`);

for (const c of CASES) {
  const r = comparison.cases.find((x) => x.id === c.id)!.requirement;
  const shipped = await git.resolve("correct");
  const source = (await git.readText(shipped, c.file)) ?? "";
  const candidates = enumerate(c.file, source);
  const fnOf = (call: CallCandidate) => candidates.functions.find((f) => f.id === call.functionId)!;
  const theCall = candidates.calls.find((k) => fnOf(k).name === c.target.functionName && k.callee.split("::").pop() === c.target.callee);
  // The ground truth is the call expression at this commit, not the callee name (`#25` review).
  const truth: GroundTruth = { functionName: c.target.functionName, callExpression: theCall?.expression ?? "" };
  const discoverer = new Discoverer(git, shipped, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  console.log(`-- ${c.id}: the call the patch changes is ${theCall ? `${theCall.id} (${theCall.expression.slice(0, 50)})` : "NOT IN THE LISTING"}`);

  for (const material of ["A", "B"] as const) {
    const requirementText = material === "A" ? r.quote : `${r.quote}\n\n${summary.text}`;
    for (let run = 1; run <= runs; run++) {
      if (dry) {
        console.log(`   DRY ${material}/run ${run}`);
        continue;
      }
      const body = {
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: JSON.stringify({ requirement: requirementText, source_of: r.primarySource, file: c.file, listing: listingFor(candidates) }) },
        ],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        max_tokens: 1200,
        temperature: 0,
      };
      let picked: { picks?: { callId?: string; clause?: string }[]; notCovered?: string[] } = {};
      let error: string | undefined;
      try {
        picked = readModelJson(await client.post({ model: COMPILER_MODEL, input: body }, { timeoutMs: 120_000, maxRetries: 0 })) as typeof picked;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const stated: Site[] = [];
      const rejected: { callId: string; why: string }[] = [];
      for (const p of (picked.picks ?? []).slice(0, MAX_PICKS)) {
        const call = candidates.calls.find((k) => k.id === p.callId);
        if (!call) {
          rejected.push({ callId: String(p.callId), why: "not a call in the listing" });
          continue;
        }
        if (stated.some((s) => s.call.id === call.id)) continue;
        stated.push({ call, fn: fnOf(call), related: "stated", clause: p.clause });
      }
      const stages = stagesOf(stated, candidates, fnOf);
      const reach = {
        picked: reachesTheDefect(stages.picked, truth),
        widened: reachesTheDefect(stages.widened, truth),
        withinBudget: reachesTheDefect(stages.withinBudget, truth),
      };
      // Every site stays in the set; this only records which of them a question could be put to.
      const applicable = await Promise.all(
        stages.withinBudget.map(async (s) => {
          const a = await applicabilityOf(discoverer, s.fn, s.call);
          return { callId: s.call.id, function: s.fn.name, expression: s.call.expression, related: s.related, hasClause: s.clause !== undefined, applicable: a.ok, reason: a.ok ? null : a.reason };
        }),
      );
      rows.push({
        case: c.id,
        material,
        run,
        requirementChars: requirementText.length,
        sentHash: hash(body),
        answer: picked,
        rejectedPicks: rejected,
        error,
        stages: {
          picked: stages.picked.map((s) => s.call.id),
          widened: stages.widened.map((s) => s.call.id),
          withinBudget: stages.withinBudget.map((s) => s.call.id),
          leftOver: stages.leftOver,
        },
        reach,
        applicable,
      });
      const mark = (x: { call: boolean; functionOnly: boolean }) => (x.call ? "IN" : x.functionOnly ? "fn-only" : "no");
      console.log(
        `   ${material}/run ${run}: picked ${stages.picked.length} → widened ${stages.widened.length} → within budget ${stages.withinBudget.length}` +
          ` · the call: picked ${mark(reach.picked)}, widened ${mark(reach.widened)}, budget ${mark(reach.withinBudget)}` +
          ` · a question can be put to ${applicable.filter((a) => a.applicable).length}/${applicable.length}` +
          (error ? ` · ERROR ${error}` : ""),
      );
    }
  }
  console.log("");
}

writeFileSync(
  out,
  JSON.stringify(
    {
      question: "Does adding the pull request's summary paragraph get the selection to the call the patch changes?",
      judging: "none — this run sends nothing to Jev",
      tool: { name: "jev-intent-review", version: VERSION, pickingModel: COMPILER_MODEL },
      materials: { A: "the property sentence", B: "the property sentence plus the summary paragraph", paragraph: summary },
      maxPicks: MAX_PICKS,
      maxSet: MAX_SET,
      runs,
      sent: { requests: client.sent.requests, bytes: client.sent.bytes, hardLimit: HARD_LIMIT },
      log: rows,
    },
    null,
    2,
  ),
);

console.log("case                             material  the call in the budgeted set");
for (const c of CASES) {
  for (const material of ["A", "B"] as const) {
    const mine = rows.filter((r) => r.case === c.id && r.material === material);
    const hit = mine.filter((r) => (r.reach as { withinBudget: { call: boolean } }).withinBudget.call).length;
    console.log(`  ${c.id.padEnd(32)} ${material}         ${hit}/${mine.length}`);
  }
}
const bAll = CASES.every((c) => {
  const mine = rows.filter((r) => r.case === c.id && r.material === "B");
  return mine.length > 0 && mine.every((r) => (r.reach as { withinBudget: { call: boolean } }).withinBudget.call);
});
console.log(`\nrequests ${client.sent.requests}/${HARD_LIMIT} · ${(client.sent.bytes / 1024).toFixed(0)} KB · ${out}`);
console.log(bAll ? "PASSES: B reaches the call in every run of both cases" : "does not pass: B does not reach the call in every run of both cases");
process.exitCode = bAll ? 0 : 1;
