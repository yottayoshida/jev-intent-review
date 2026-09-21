// Choosing the target and the call by id, from a listing built at the pinned commit.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/typed-plan-check.ts <omamori-clone> [runs] [log path]
//
// `#21` left one wall: binding an original requirement to a real function and a real call. The
// generated plan in `#20` named a callee as the target and an operation the code does not call,
// and when it was replayed it answered the same on the shipped and the mutated branch — it runs,
// clears the bar, and cannot see the defect.
//
// Here both methods go through the same machinery and differ only in **who picks the ids**:
//
//   A  a person picks the function and the call
//   B  the model picks them from the listing
//
// Everything after the pick is generated: the condition is built by `conditionFrom`, so there is
// no field for a verdict to be written into, and the referent list comes from the failure's kind
// rather than from whoever wrote the plan. What a pick cannot do is name something that is not
// in the listing — that is checked before a request, and by stage, so "named a function that does
// not exist" and "named a call in another function" are counted apart.
//
// Scored on whether the plan **tells the versions apart**, not on whether it can be answered. A
// plan that answers `property_holds` on the shipped branch and on the mutated one is wrong however
// confident it is.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence, type Packet } from "../src/evidence/builder.ts";
import { readModelJson } from "../src/intent/compiler.ts";
import { SUPERSEDED_PLANNING_MODEL as COMPILER_MODEL } from "./superseded-models.ts";
import { CloudflareClient, endpointFromEnv } from "../src/judgments/cloudflare.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, score, verdictOfV3 } from "./check-questions-v3.ts";
import { questionsV5 } from "./check-questions-v5.ts";
import { enumerate, listingFor, type Candidates } from "./code-candidates.ts";
import { PROPERTIES, checkPlan, conditionFrom, locateCall, referentsFor, type TypedPlan } from "./typed-plan.ts";

const HERE = import.meta.dirname;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const comparison = JSON.parse(readFileSync(join(HERE, "plans/three-way-comparison.json"), "utf8")) as {
  cases: { id: string; requirement: { quote: string; primarySource: string; id: string } }[];
};

/** The two cases, their file, and what a person picks — expressed as a selector, not a line number. */
const CASES = [
  {
    id: "omamori-read-baseline",
    file: "src/integrity.rs",
    humanTarget: "read_baseline",
    humanCallee: "read_to_string_capped",
    branches: { correct: "correct", mutant: "m-read-baseline", variant: "v-read-baseline" },
  },
  {
    id: "omamori-raw-override-disables",
    file: "src/config.rs",
    humanTarget: "raw_override_disables",
    humanCallee: "read_to_string_capped",
    branches: { correct: "correct", mutant: "m-raw-override", variant: "v-raw-override" },
  },
] as const;

const TRUTH = { correct: "returns_error", mutant: "returns_success", variant: "returns_error" } as const;

const B_SCHEMA = {
  type: "object",
  properties: {
    property: { type: "string", enum: Object.keys(PROPERTIES) },
    targetId: { type: "string" },
    failure: {
      type: "object",
      properties: { kind: { type: "string", enum: ["call_result"] }, callId: { type: "string" }, result: { type: "string", enum: ["err"] } },
      required: ["kind", "callId", "result"],
    },
    notCovered: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
  },
  required: ["property", "targetId", "failure"],
};

const B_INSTRUCTIONS = `You are given one requirement and a listing of the functions and calls in one file, each with an id.

Pick, by id, the function whose behaviour the requirement governs, and the call inside it whose failure the requirement is about. Say what the check will leave unchecked.

- property: the shape of the check. Only one is offered.
- targetId: a function id from the listing.
- failure.callId: a call id from the listing, and it must be inside the function you chose.
- failure.kind and failure.result are fixed: the call returns an error.
- notCovered: what checking this one function leaves unchecked about the requirement.

Pick the function the requirement is about, not the helper it calls. Do not invent ids.`;

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/typed-plan-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "typed-plan.json";
const dry = process.env.DRY_RUN === "1";
const HARD_LIMIT = 50;

const endpoint = endpointFromEnv();
if (!endpoint && !dry) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const client = new CloudflareClient(endpoint ?? { url: "https://example.invalid/dry", token: "unused", source: "JEV_API_URL" }, { maxRetries: 0, maxRequests: dry ? 0 : HARD_LIMIT });
const provider = new JevProvider(client);
const git = new Git(repoDir);

const packets = new Map<string, unknown>();
const rows: Record<string, unknown>[] = [];
const planRecords: Record<string, unknown>[] = [];

function requirementFor(id: string): Requirement {
  const r = comparison.cases.find((c) => c.id === id)!.requirement;
  return { id: r.id, text: r.quote, kind: "behavior", priority: "required", sourceRefs: [{ sourceId: r.primarySource, quote: r.quote }], searchHints: [] };
}

/** The target's body at a branch, with the related section emptied — the kind needs no referent. */
async function bodyPacket(branch: string, file: string, symbol: string, requirement: Requirement): Promise<{ commit: string; packet: Packet } | null> {
  const commit = await git.resolve(branch);
  const discoverer = new Discoverer(git, commit, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const { hits } = await discoverer.search(symbol);
  const definition = hits.filter((h) => defines(h.text, symbol) && (!file || h.path === file))[0];
  if (!definition) return null;
  const index = await discoverer.index(definition.path);
  if (!index) return null;
  const block = index.enclosing(definition.line);
  const candidate: Candidate = { path: definition.path, startLine: block.startLine, endLine: block.endLine, symbol, changed: true, reasons: [`the plan names ${symbol}`], ...(block.windowed ? { windowed: true } : {}) };
  const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
  return { commit, packet: { ...evidence.packet, evidence: { ...evidence.packet.evidence, related: [], truncated: true } } };
}

async function generate(caseId: string, file: string, candidates: Candidates): Promise<unknown> {
  const r = comparison.cases.find((c) => c.id === caseId)!.requirement;
  const body = {
    messages: [
      { role: "system", content: B_INSTRUCTIONS },
      { role: "user", content: JSON.stringify({ requirement: r.quote, source_of: r.primarySource, file, listing: listingFor(candidates) }) },
    ],
    response_format: { type: "json_schema", json_schema: B_SCHEMA },
    max_tokens: 900,
    temperature: 0,
  };
  try {
    return readModelJson(await client.post({ model: COMPILER_MODEL, input: body }, { timeoutMs: 120_000, maxRetries: 0 }));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

console.log(`bar ${BAR_V3} · ${runs} run(s) per cell · hard limit ${HARD_LIMIT} · the model picking ids is ${COMPILER_MODEL}\n`);

for (const c of CASES) {
  const requirement = requirementFor(c.id);
  const shipped = await git.resolve(c.branches.correct);
  const source = (await git.readText(shipped, c.file)) ?? "";
  const candidates = enumerate(c.file, source);
  const listing = listingFor(candidates);
  console.log(`-- ${c.id}: ${candidates.functions.length} functions, ${candidates.calls.length} calls (omitted ${JSON.stringify(candidates.omitted)})`);

  // A: a person's pick, as ids from the same listing.
  const aTarget = candidates.functions.find((f) => f.name === c.humanTarget);
  const aCall = aTarget ? candidates.calls.find((k) => k.functionId === aTarget.id && k.callee.endsWith(c.humanCallee)) : undefined;
  const aPlan: TypedPlan | null = aTarget && aCall ? { property: "call_failure_not_returned_as_success", targetId: aTarget.id, failure: { kind: "call_result", callId: aCall.id, result: "err" }, notCovered: ["every other call site of the same helper", "what the callers do with either answer"] } : null;

  // The dry run stands in for the model with the first ids of this listing. They are read from the
  // listing rather than written out: ids carry their file now, so a spelled-out `function-1` would
  // stop resolving and the dry run would quietly report a plan that failed its check.
  const first = candidates.calls[0];
  if (dry && !first) throw new Error(`${c.file} at ${shipped} has no call to stand in for the model's pick`);
  const bPlan = dry
    ? { property: "call_failure_not_returned_as_success", targetId: first!.functionId, failure: { kind: "call_result", callId: first!.id, result: "err" } }
    : await generate(c.id, c.file, candidates);
  console.log(`   B picked: ${JSON.stringify(bPlan).slice(0, 200)}`);

  for (const [method, plan] of [["A", aPlan] as const, ["B", bPlan] as const]) {
    const checked = plan ? checkPlan(plan, candidates) : ({ ok: false, stage: "shape", reason: "no plan" } as const);
    const record: Record<string, unknown> = { method, case: c.id, plan, passedCheck: checked.ok, ...(checked.ok ? { target: checked.target, call: checked.call } : { failedStage: checked.stage, reason: checked.reason }) };
    planRecords.push(record);
    if (!checked.ok) {
      console.log(`   ${method}: plan rejected at stage "${checked.stage}" — ${checked.reason}`);
      continue;
    }
    const condition = conditionFrom(checked.target, checked.call);
    record.condition = condition;
    record.referents = referentsFor(checked.call ? "call_result" : "call_result");
    console.log(`   ${method}: ${checked.target.name} / ${checked.call.text.slice(0, 60)}`);
    if (dry) continue;
    for (const [which, branch] of Object.entries(c.branches)) {
      const built = await bodyPacket(branch, checked.target.path, checked.target.name, requirement);
      if (!built) {
        rows.push({ method, case: c.id, which, branch, problem: `${checked.target.name} not found at ${branch}` });
        console.log(`   SKIP ${method}/${which}: ${checked.target.name} not found`);
        continue;
      }
      // The call the condition names has to be in *this* version's body, exactly once. None means
      // the version moved it and the question would be about something that is not there; more
      // than one means the condition does not say which. Decided before a request.
      const located = locateCall(built.packet.evidence.code, checked.call);
      if (!located.ok) {
        rows.push({ method, case: c.id, which, branch, commit: built.commit, withheld: located.reason, found: located.found, requestsSpent: 0 });
        console.log(`   HELD ${method}/${which.padEnd(8)} no request: ${located.reason}`);
        continue;
      }
      const stateHash = hash(built.packet);
      packets.set(stateHash, built.packet);
      const qs = questionsV5(condition);
      const truth = TRUTH[which as keyof typeof TRUTH];
      for (let run = 1; run <= runs; run++) {
        try {
          const got = (await provider.judge(built.packet, qs)) as Record<string, ChoiceAnswer | undefined>;
          const result = got.on_error_result;
          const p = result ? probabilityOf(result, result.choice) : 0;
          const s = score(result?.choice ?? "none", p, truth);
          const { verdict } = verdictOfV3(result?.choice, p);
          rows.push({ method, case: c.id, which, branch, commit: built.commit, run, truth, target: checked.target.name, sentStateHash: stateHash, questionsHash: hash(qs), got, result: { choice: result?.choice ?? "none", probability: p, choiceMatch: s.choiceMatch, counted: s.counted }, verdict });
          console.log(`   ${s.counted ? "READS" : "MISS "} ${method}/${which.padEnd(8)} run ${run}: ${result?.choice} ${p.toFixed(2)} → ${verdict}` + (s.counted ? "" : `  — the code returns ${truth}`));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          rows.push({ method, case: c.id, which, branch, run, truth, error: message });
          console.log(`   FAIL ${method}/${which} run ${run}: ${message}`);
        }
      }
    }
  }
  console.log("");
}

writeFileSync(
  out,
  JSON.stringify(
    {
      question: "With the target and the call chosen by id from the commit, and the condition generated, does the generated plan tell the versions apart?",
      tool: { name: "jev-intent-review", version: VERSION, jevModel: provider.model, planningModel: COMPILER_MODEL },
      questionVersion: "v5, with the condition built by conditionFrom rather than written",
      bar: BAR_V3,
      runs,
      plans: planRecords,
      sent: { requests: client.sent.requests, bytes: client.sent.bytes, hardLimit: HARD_LIMIT },
      packets: Object.fromEntries(packets),
      log: rows,
    },
    null,
    2,
  ),
);

// --- does it tell the versions apart? -------------------------------------------------------
console.log("cell                                             the code returns   right");
const cells = new Map<string, { n: number; ok: number; truth: string; choices: Set<string> }>();
for (const r of rows) {
  if (!r.result) continue;
  const key = `${r.method}/${r.case}/${r.which}`;
  const cur = cells.get(key) ?? { n: 0, ok: 0, truth: String(r.truth), choices: new Set<string>() };
  cur.n += 1;
  if ((r.result as { counted: boolean }).counted) cur.ok += 1;
  cur.choices.add((r.result as { choice: string }).choice);
  cells.set(key, cur);
}
for (const [k, v] of cells) console.log(`  ${k.padEnd(46)} ${v.truth.padEnd(17)} ${v.ok}/${v.n}  [${[...v.choices].join("/")}]`);
for (const method of ["A", "B"]) {
  for (const c of CASES) {
    const shippedCell = cells.get(`${method}/${c.id}/correct`);
    const mutantCell = cells.get(`${method}/${c.id}/mutant`);
    if (!shippedCell || !mutantCell) continue;
    const apart = [...shippedCell.choices].join() !== [...mutantCell.choices].join();
    console.log(`  ${method}/${c.id}: shipped and mutated answer ${apart ? "DIFFERENTLY — the versions come apart" : "the SAME — the defect is invisible from here"}`);
  }
}
console.log(`\nrequests ${client.sent.requests}/${HARD_LIMIT} · ${(client.sent.bytes / 1024).toFixed(0)} KB · ${out}`);
