// Choosing a set of places to check, rather than one.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/candidate-set-check.ts <omamori-clone> [runs] [log path]
//
// `#22` left the target choice as the one wrong judgment, and `#23` made the chosen call carry its
// own identity. But "pick the one right place" is the wrong job: the place the generated plan
// picked — `load_config` — *is* governed by the requirement, and answering that it propagates
// there is right. What it cannot do is find the defect in `raw_override_disables`. That is a gap
// in scope as much as a wrong pick.
//
// So the model picks **several** call ids and says which clause each one checks, and a second
// method widens that mechanically to the other call sites of the same callee. Three selections are
// compared: the single pick from `#22`, the several picks, and the several picks widened.
//
// **The same callee is a lead, not a reason.** A function that records a failure in a diagnostic
// and carries on is handled differently, and whether this property is required at a site comes
// from the original text. So a site carries two things that are kept apart: that it is *related*
// (it calls the same helper) and that the property is *required* there (the model said which
// clause, in its own words). A site with no stated clause is reported unchecked rather than judged
// a violation.
//
// Each distinct site is judged **once** per branch and the methods are scored from their
// selections, because an answer depends on the site and the branch and not on who chose it.
//
// Counted apart, as the plan for this step says: whether the mutated site is in the set, whether
// the defect is then found, whether holding code draws violations, the requests, and what is left
// unchecked.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence, type Packet } from "../src/evidence/builder.ts";
import { readModelJson } from "../src/intent/compiler.ts";
import { SUPERSEDED_PLANNING_MODEL as COMPILER_MODEL } from "./superseded-models.ts";
import { JevClient, endpointFromEnv } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, score, verdictOfV3 } from "./check-questions-v3.ts";
import { questionsV5 } from "./check-questions-v5.ts";
import { enumerate, listingFor, type CallCandidate, type Candidates, type FunctionCandidate } from "./code-candidates.ts";
import { conditionFrom, locateCall } from "./typed-plan.ts";

const HERE = import.meta.dirname;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const comparison = JSON.parse(readFileSync(join(HERE, "plans/three-way-comparison.json"), "utf8")) as {
  cases: { id: string; requirement: { quote: string; primarySource: string; id: string } }[];
};

const CASES = [
  { id: "omamori-read-baseline", file: "src/integrity.rs", mutatedFunction: "read_baseline", branches: { correct: "correct", mutant: "m-read-baseline" } },
  { id: "omamori-raw-override-disables", file: "src/config.rs", mutatedFunction: "raw_override_disables", branches: { correct: "correct", mutant: "m-raw-override" } },
] as const;

/** What each branch's code does at the mutated site; every other site is unchanged. */
const TRUTH_AT_MUTATED = { correct: "returns_error", mutant: "returns_success" } as const;
const TRUTH_ELSEWHERE = { correct: "returns_error", mutant: "returns_error" } as const;

const MAX_PICKS = 4;
const MAX_SET = 5; // the union a run will pay to judge

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      maxItems: MAX_PICKS,
      items: {
        type: "object",
        properties: { callId: { type: "string" }, clause: { type: "string", maxLength: 300 } },
        required: ["callId", "clause"],
      },
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
if (!repoDir) throw new Error("usage: node bench/candidate-set-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "candidate-set.json";
const dry = process.env.DRY_RUN === "1";
const HARD_LIMIT = 100;

const endpoint = endpointFromEnv();
if (!endpoint && !dry) throw new Error("no credentials: set JEV_PROVIDER (cloudflare, typesafe or vercel) with its key, the Cloudflare pair, or JEV_API_URL and JEV_API_TOKEN");
const client = new JevClient(endpoint ?? { url: "https://example.invalid/dry", token: "unused", host: "custom" }, { maxRetries: 0, maxRequests: dry ? 0 : HARD_LIMIT });
const provider = new JevProvider(client);
const git = new Git(repoDir);

const packets = new Map<string, unknown>();
const rows: Record<string, unknown>[] = [];
const caseRecords: Record<string, unknown>[] = [];

function requirementFor(id: string): Requirement {
  const r = comparison.cases.find((c) => c.id === id)!.requirement;
  return { id: r.id, text: r.quote, kind: "behavior", priority: "required", sourceRefs: [{ sourceId: r.primarySource, quote: r.quote }], searchHints: [] };
}

async function bodyPacket(branch: string, file: string, symbol: string, requirement: Requirement): Promise<{ commit: string; packet: Packet } | null> {
  const commit = await git.resolve(branch);
  const discoverer = new Discoverer(git, commit, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const { hits } = await discoverer.search(symbol);
  const found = hits.filter((h) => defines(h.text, symbol) && (!file || h.path === file));
  // By name, and refused when the name is not unique in the file — `#23` left this as the next
  // collapse of the same class, and a set of sites is where two `default`s would finally meet it.
  if (found.length !== 1) return null;
  const definition = found[0]!;
  const index = await discoverer.index(definition.path);
  if (!index) return null;
  const block = index.enclosing(definition.line);
  const candidate: Candidate = { path: definition.path, startLine: block.startLine, endLine: block.endLine, symbol, changed: true, reasons: [`a selected site is in ${symbol}`], ...(block.windowed ? { windowed: true } : {}) };
  const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
  return { commit, packet: { ...evidence.packet, evidence: { ...evidence.packet.evidence, related: [], truncated: true } } };
}

interface Site {
  call: CallCandidate;
  fn: FunctionCandidate;
  /** Why it is in the set: the model said so, or it shares a callee with one the model said. */
  related: "stated" | "same_callee";
  /** The clause the model gave. Absent means the property is not argued for here. */
  clause?: string;
}

console.log(`bar ${BAR_V3} · ${runs} run(s) per site per branch · hard limit ${HARD_LIMIT} · picking model ${COMPILER_MODEL}\n`);

for (const c of CASES) {
  const requirement = requirementFor(c.id);
  const shipped = await git.resolve(c.branches.correct);
  const source = (await git.readText(shipped, c.file)) ?? "";
  const candidates: Candidates = enumerate(c.file, source);
  const fnOf = (call: CallCandidate) => candidates.functions.find((f) => f.id === call.functionId)!;

  // What the model picks, with a clause each.
  const r = comparison.cases.find((x) => x.id === c.id)!.requirement;
  const picked = dry
    ? { picks: [] }
    : ((await (async () => {
        const body = {
          messages: [
            { role: "system", content: INSTRUCTIONS },
            { role: "user", content: JSON.stringify({ requirement: r.quote, source_of: r.primarySource, file: c.file, listing: listingFor(candidates) }) },
          ],
          response_format: { type: "json_schema", json_schema: SCHEMA },
          max_tokens: 1200,
          temperature: 0,
        };
        try {
          return readModelJson(await client.post({ model: COMPILER_MODEL, input: body }, { timeoutMs: 120_000, maxRetries: 0 }));
        } catch (e) {
          return { picks: [], error: e instanceof Error ? e.message : String(e) };
        }
      })()) as { picks?: { callId?: string; clause?: string }[]; notCovered?: string[]; error?: string });

  const rawPicks = Array.isArray(picked.picks) ? picked.picks : [];
  const stated: Site[] = [];
  const rejected: Record<string, string>[] = [];
  for (const p of rawPicks.slice(0, MAX_PICKS)) {
    const call = candidates.calls.find((k) => k.id === p.callId);
    if (!call) {
      rejected.push({ callId: String(p.callId), why: "not a call in the listing" });
      continue;
    }
    if (stated.some((s) => s.call.id === call.id)) continue;
    stated.push({ call, fn: fnOf(call), related: "stated", clause: p.clause });
  }

  // Widening: the other call sites of the callees the model picked. A lead, not a reason — these
  // carry no clause, so nothing here argues the property is required at them.
  const callees = new Set(stated.map((s) => s.call.callee.split("::").pop()!));
  const siblings: Site[] = candidates.calls
    .filter((k) => callees.has(k.callee.split("::").pop()!) && !stated.some((s) => s.call.id === k.id))
    .map((k) => ({ call: k, fn: fnOf(k), related: "same_callee" as const }));

  const single: Site[] = stated.slice(0, 1);
  const multi: Site[] = stated;
  const expanded: Site[] = [...stated, ...siblings].slice(0, MAX_SET);
  const union = [...expanded];
  const overBudget = stated.length + siblings.length - expanded.length;

  const mutatedSites = union.filter((s) => s.fn.name === c.mutatedFunction);
  console.log(`-- ${c.id}: ${candidates.functions.length} functions, ${candidates.calls.length} calls`);
  console.log(`   picked ${stated.length} (${stated.map((s) => `${s.call.id}:${s.fn.name}`).join(", ") || "none"})${rejected.length ? `, rejected ${rejected.length}` : ""}`);
  console.log(`   same callee adds ${siblings.length}; the set judged is ${union.length}${overBudget > 0 ? `, ${overBudget} left over the budget` : ""}`);
  console.log(`   the mutated function is ${mutatedSites.length ? "IN" : "NOT in"} the set`);

  const record: Record<string, unknown> = {
    case: c.id,
    generated: picked,
    rejectedPicks: rejected,
    listing: { functions: candidates.functions.length, calls: candidates.calls.length, omitted: candidates.omitted },
    selections: {
      single: single.map((s) => s.call.id),
      multi: multi.map((s) => s.call.id),
      expanded: expanded.map((s) => s.call.id),
    },
    sites: union.map((s) => ({ callId: s.call.id, function: s.fn.name, expression: s.call.expression, related: s.related, clause: s.clause ?? null })),
    leftOverBudget: overBudget,
    mutatedFunctionInSet: mutatedSites.length > 0,
  };
  caseRecords.push(record);

  if (dry) {
    console.log("");
    continue;
  }

  for (const site of union) {
    for (const [which, branch] of Object.entries(c.branches)) {
      const built = await bodyPacket(branch, site.fn.path, site.fn.name, requirement);
      if (!built) {
        rows.push({ case: c.id, callId: site.call.id, function: site.fn.name, which, branch, problem: `${site.fn.name} is not defined exactly once in ${site.fn.path}` });
        console.log(`   HELD ${site.call.id}/${which}: ${site.fn.name} is not unique in the file`);
        continue;
      }
      const located = locateCall(built.packet.evidence.code, site.call);
      if (!located.ok) {
        rows.push({ case: c.id, callId: site.call.id, function: site.fn.name, which, branch, withheld: located.reason, requestsSpent: 0 });
        console.log(`   HELD ${site.call.id}/${which}: ${located.reason}`);
        continue;
      }
      const condition = conditionFrom(site.fn, site.call);
      const qs = questionsV5(condition);
      const stateHash = hash(built.packet);
      packets.set(stateHash, built.packet);
      const truth = (site.fn.name === c.mutatedFunction ? TRUTH_AT_MUTATED : TRUTH_ELSEWHERE)[which as "correct" | "mutant"];
      for (let run = 1; run <= runs; run++) {
        try {
          const got = (await provider.judge(built.packet, qs)) as Record<string, ChoiceAnswer | undefined>;
          const result = got.on_error_result;
          const p = result ? probabilityOf(result, result.choice) : 0;
          const s = score(result?.choice ?? "none", p, truth);
          const { verdict } = verdictOfV3(result?.choice, p);
          rows.push({ case: c.id, callId: site.call.id, function: site.fn.name, atMutatedFunction: site.fn.name === c.mutatedFunction, related: site.related, hasClause: site.clause !== undefined, which, branch, commit: built.commit, run, truth, sentStateHash: stateHash, questionsHash: hash(qs), got, result: { choice: result?.choice ?? "none", probability: p, choiceMatch: s.choiceMatch, counted: s.counted }, verdict });
          console.log(`   ${s.counted ? "READS" : "MISS "} ${site.call.id}/${site.fn.name.slice(0, 22).padEnd(22)}/${which.padEnd(7)} run ${run}: ${result?.choice} ${p.toFixed(2)} → ${verdict}`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          rows.push({ case: c.id, callId: site.call.id, which, branch, run, truth, error: message });
          console.log(`   FAIL ${site.call.id}/${which} run ${run}: ${message}`);
          if (/budget|maxRequests|request limit/i.test(message)) break;
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
      question: "Does choosing a set of places, and widening it to the same callee, put the defect in reach without drawing violations from code that holds?",
      tool: { name: "jev-intent-review", version: VERSION, jevModel: provider.model, pickingModel: COMPILER_MODEL },
      questionVersion: "v5, condition built by conditionFrom from the call expression",
      bar: BAR_V3,
      runs,
      maxPicks: MAX_PICKS,
      maxSet: MAX_SET,
      cases: caseRecords,
      sent: { requests: client.sent.requests, bytes: client.sent.bytes, hardLimit: HARD_LIMIT },
      packets: Object.fromEntries(packets),
      log: rows,
    },
    null,
    2,
  ),
);

// --- score each selection from the same answers ------------------------------------------------
console.log("selection        case                             in set  defect found  false violations  unchecked");
for (const rec of caseRecords) {
  const caseId = String(rec.case);
  const c = CASES.find((x) => x.id === caseId)!;
  const sel = rec.selections as Record<string, string[]>;
  for (const method of ["single", "multi", "expanded"] as const) {
    const ids = new Set(sel[method]);
    const mine = rows.filter((r) => r.case === caseId && ids.has(String(r.callId)) && r.result);
    const atMutated = mine.filter((r) => r.atMutatedFunction);
    const inSet = atMutated.length > 0;
    const found = atMutated.filter((r) => r.which === "mutant" && (r.result as { counted: boolean }).counted).length;
    const foundRuns = atMutated.filter((r) => r.which === "mutant").length;
    // A violation where the code holds: the shipped branch anywhere, or the mutated branch at a
    // site the mutation does not touch.
    const holding = mine.filter((r) => r.truth === "returns_error");
    const falseViolations = holding.filter((r) => (r.result as { choice: string }).choice === "returns_success").length;
    const unchecked = (rec.sites as { callId: string; clause: string | null }[]).filter((s) => ids.has(s.callId) && s.clause === null).length;
    console.log(
      `  ${method.padEnd(14)} ${caseId.padEnd(32)} ${(inSet ? "yes" : "NO").padEnd(7)} ${inSet ? `${found}/${foundRuns}` : "-".padEnd(3)}${" ".repeat(9)} ${String(falseViolations).padStart(2)}/${String(holding.length).padStart(2)}${" ".repeat(13)} ${unchecked}`,
    );
  }
  console.log(`  ${"".padEnd(14)} ${"".padEnd(32)} left over the set budget: ${rec.leftOverBudget}, omitted from the listing: ${JSON.stringify((rec.listing as { omitted: unknown }).omitted)}`);
}
console.log(`\nrequests ${client.sent.requests}/${HARD_LIMIT} · ${(client.sent.bytes / 1024).toFixed(0)} KB · ${out}`);
