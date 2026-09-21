// A hand-written plan, a generated one, and an ordinary review, on the same code.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/three-way-check.ts <omamori-clone> [runs] [log path]
//
// The plans are `bench/plans/three-way-comparison.json` (what is measured and how it is scored)
// and `bench/plans/three-way-A-plans.json` (what the person decided). Both were committed before
// any request of this run. **Method B never sees the second file.**
//
//   A  the hand-written plan + Jev
//   B  a plan the model writes from the requirement and the file + Jev
//   C  an ordinary review: one call that reads the requirement and the code and gives a verdict
//
// B and C use `COMPILER_MODEL`, the model the tool already uses to write requirements, on the same
// endpoint — so `JevClient.sent` counts every request of every method, plan generation
// included. No price is claimed: Workers AI bills by neuron and the answer carries none.
//
// The question is v5, not the frozen v4: v4's template hard-codes an iterator's shape and neither
// new target iterates. `bench/check-questions-v5.ts` says what that means. The case v4 met its
// exit condition on is re-measured here under v5 rather than carried over.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence, type Packet, type Related } from "../src/evidence/builder.ts";
import { readModelJson } from "../src/intent/compiler.ts";
import { SUPERSEDED_PLANNING_MODEL as COMPILER_MODEL } from "./superseded-models.ts";
import { JevClient, endpointFromEnv } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, score, verdictOfV3 } from "./check-questions-v3.ts";
import { questionsV5, type ConditionV5 } from "./check-questions-v5.ts";
import { SELECTIONS, classify, referentsPresent, type Classified } from "./evidence-selection.ts";

const HERE = import.meta.dirname;
const TOOL_REPO = dirname(HERE);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const comparisonText = readFileSync(join(HERE, "plans/three-way-comparison.json"), "utf8");
const aPlansText = readFileSync(join(HERE, "plans/three-way-A-plans.json"), "utf8");
const comparison = JSON.parse(comparisonText) as { cases: { id: string; requirement: { quote: string; primarySource: string; id: string } }[]; requestBudget: { hardLimit: number } };
const aPlans = JSON.parse(aPlansText) as {
  regression: { case: string; conditions: string[]; condition: ConditionV5; neededReferents: string[]; expected: Record<string, string> };
  cases: { id: string; file: string; symbol: string; neededReferents: string[]; condition: ConditionV5 }[];
};

const requirementOf = (id: string) => comparison.cases.find((c) => c.id === id)!.requirement;

/** What each branch's code actually does, from running it (bench/fixtures/omamori-468/README.md). */
const TRUTH: Record<string, "returns_error" | "returns_success"> = {
  correct: "returns_error",
  "m-read-baseline": "returns_success",
  "v-read-baseline": "returns_error",
  "m-raw-override": "returns_success",
  "v-raw-override": "returns_error",
  "r-correct": "returns_error",
  "r-mutant": "returns_success",
};

const BRANCHES: Record<string, { correct: string; mutant: string; variant: string }> = {
  "omamori-read-baseline": { correct: "correct", mutant: "m-read-baseline", variant: "v-read-baseline" },
  "omamori-raw-override-disables": { correct: "correct", mutant: "m-raw-override", variant: "v-raw-override" },
};

// ---------------------------------------------------------------------------

interface Built {
  commit: string;
  packet: Packet;
  entries: Classified[];
  found: boolean;
}

async function build(git: Git, branch: string, file: string, symbol: string, needed: readonly string[], requirement: Requirement): Promise<Built> {
  const commit = await git.resolve(branch);
  const discoverer = new Discoverer(git, commit, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const { hits } = await discoverer.search(symbol);
  const definitions = hits.filter((h) => defines(h.text, symbol));
  if (definitions.length !== 1) return { commit, packet: null as unknown as Packet, entries: [], found: false };
  const definition = definitions[0]!;
  if (file && definition.path !== file) return { commit, packet: null as unknown as Packet, entries: [], found: false };
  const index = await discoverer.index(definition.path);
  if (!index) return { commit, packet: null as unknown as Packet, entries: [], found: false };
  const block = index.enclosing(definition.line);
  const candidate: Candidate = {
    path: definition.path,
    startLine: block.startLine,
    endLine: block.endLine,
    symbol,
    changed: true,
    reasons: [`the plan names ${symbol}`],
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
  const entries = classify(evidence.packet.evidence.related, needed, (path, line) =>
    flags[evidence.packet.evidence.related.findIndex((e) => e.path === path && Number(e.lines.split("-")[0]) === line)] ?? false,
  );
  return { commit, packet: evidence.packet, entries, found: true };
}

const withRelated = (b: Built, kept: readonly Classified[]): Packet => ({
  ...b.packet,
  evidence: { ...b.packet.evidence, related: kept.map(({ path, lines, code }): Related => ({ path, lines, code })), truncated: true },
});

// ---------------------------------------------------------------------------

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/three-way-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "three-way.json";
const dry = process.env.DRY_RUN === "1";
const hardLimit = comparison.requestBudget.hardLimit;

const endpoint = endpointFromEnv();
if (!endpoint && !dry) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const client = new JevClient(endpoint ?? { url: "https://example.invalid/dry", token: "unused", source: "JEV_API_URL" }, { maxRetries: 0, maxRequests: dry ? 0 : hardLimit });
const provider = new JevProvider(client);
const git = new Git(repoDir);

const packets = new Map<string, unknown>();
const rows: Record<string, unknown>[] = [];
const notes: Record<string, unknown>[] = [];

function requirementFor(id: string): Requirement {
  const r = requirementOf(id);
  return { id: r.id, text: r.quote, kind: "behavior", priority: "required", sourceRefs: [{ sourceId: r.primarySource, quote: r.quote }], searchHints: [] };
}

async function judge(method: "A" | "B" | "regression", caseId: string, branch: string, state: Packet, condition: ConditionV5, truth: string, extra: Record<string, unknown>) {
  const qs = questionsV5(condition);
  const stateHash = hash(state);
  packets.set(stateHash, state);
  for (let run = 1; run <= runs; run++) {
    try {
      const answers = (await provider.judge(state, qs)) as Record<string, ChoiceAnswer | undefined>;
      const result = answers.on_error_result;
      const p = result ? probabilityOf(result, result.choice) : 0;
      const s = score(result?.choice ?? "none", p, truth);
      const { verdict } = verdictOfV3(result?.choice, p);
      rows.push({ method, case: caseId, branch, run, ...extra, truth, questionsHash: hash(qs), sentStateHash: stateHash, answers, result: { choice: result?.choice ?? "none", probability: p, choiceMatch: s.choiceMatch, counted: s.counted }, verdict });
      console.log(`${s.counted ? "READS" : "MISS "} ${method}/${caseId}/${branch}`.padEnd(52) + ` run ${run}: ${result?.choice} ${p.toFixed(2)} → ${verdict}` + (s.counted ? "" : `  — the code returns ${truth}`));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      rows.push({ method, case: caseId, branch, run, ...extra, truth, error: message });
      console.log(`FAIL  ${method}/${caseId}/${branch} run ${run}: ${message}`);
      if (/budget|maxRequests|request limit/i.test(message)) return false;
    }
  }
  return true;
}

// --- B: the model writes the plan ------------------------------------------------------------

const B_SCHEMA = {
  type: "object",
  properties: {
    symbol: { type: "string" },
    setup: { type: "string", maxLength: 200 },
    occurrence: { type: "string", maxLength: 80 },
    operation: { type: "string", maxLength: 200 },
    yields: { type: "string", maxLength: 80 },
    others: { type: "string", maxLength: 200 },
    extra: { type: "string", maxLength: 200 },
    needed_referents: { type: "array", maxItems: 4, items: { type: "string" } },
    not_covered: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
  },
  required: ["symbol", "setup", "occurrence", "operation", "yields", "others", "needed_referents"],
};

const B_INSTRUCTIONS = `You are given one requirement and the non-test source of one Rust file.

Pick the single function in that file whose behaviour the requirement governs, and write a check plan for it:

- symbol: the function's name, exactly as it is defined in the file.
- The condition under which the requirement could be broken, as separate fields. setup: what is already true when the failing operation is reached. occurrence: how the failure arises ("When it is called", "At one iteration"). operation: what fails, written as it appears in the code. yields: what it returns then. others: what else holds ("Every other operation the function reaches succeeds."). extra: anything else, or "".
- needed_referents: the names of functions defined elsewhere whose behaviour someone must know to answer what the chosen function returns under that condition. Empty if none.
- not_covered: what a check of this one function would leave unchecked about the requirement.

Do not say what the function should do, and do not name the answer. The condition is the situation, not the verdict.`;

async function generatePlan(caseId: string, file: string, source: string): Promise<Record<string, unknown> | { error: string }> {
  const r = requirementOf(caseId);
  const body = {
    messages: [
      { role: "system", content: B_INSTRUCTIONS },
      { role: "user", content: JSON.stringify({ requirement: r.quote, source_of: r.primarySource, file, source }) },
    ],
    response_format: { type: "json_schema", json_schema: B_SCHEMA },
    max_tokens: 1200,
    temperature: 0,
  };
  try {
    const payload = await client.post({ model: COMPILER_MODEL, input: body }, { timeoutMs: 120_000, maxRetries: 0 });
    const plan = readModelJson(payload) as Record<string, unknown>;
    return plan;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// --- C: an ordinary review -------------------------------------------------------------------

const C_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["violates", "holds", "cannot_tell"] },
    why: { type: "string", maxLength: 400 },
  },
  required: ["verdict", "why"],
};

const C_INSTRUCTIONS = `You are reviewing one Rust function against one requirement.

Answer whether the code as shown violates the requirement, holds to it, or whether what is shown does not settle it. Be brief about why.`;

async function review(caseId: string, branch: string, state: Packet, truth: string, extra: Record<string, unknown>) {
  const r = requirementOf(caseId);
  const stateHash = hash(state);
  packets.set(stateHash, state);
  const body = {
    messages: [
      { role: "system", content: C_INSTRUCTIONS },
      { role: "user", content: JSON.stringify({ requirement: r.quote, code: state.evidence.code, other_code_it_calls: state.evidence.related }) },
    ],
    response_format: { type: "json_schema", json_schema: C_SCHEMA },
    max_tokens: 500,
    temperature: 0,
  };
  const wanted = truth === "returns_success" ? "violates" : "holds";
  for (let run = 1; run <= runs; run++) {
    try {
      const payload = await client.post({ model: COMPILER_MODEL, input: body }, { timeoutMs: 120_000, maxRetries: 0 });
      const answer = readModelJson(payload) as { verdict?: string; why?: string };
      const right = answer.verdict === wanted;
      rows.push({ method: "C", case: caseId, branch, run, ...extra, truth, wanted, sentStateHash: stateHash, answer, right });
      console.log(`${right ? "READS" : "MISS "} C/${caseId}/${branch}`.padEnd(52) + ` run ${run}: ${answer.verdict} — ${String(answer.why).slice(0, 70)}` + (right ? "" : `  (wanted ${wanted})`));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      rows.push({ method: "C", case: caseId, branch, run, ...extra, truth, error: message });
      console.log(`FAIL  C/${caseId}/${branch} run ${run}: ${message}`);
      if (/budget|maxRequests|request limit/i.test(message)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------

console.log(`comparison ${hash(comparisonText)} · A plans ${hash(aPlansText)} · bar ${BAR_V3} · ${runs} run(s) per cell · hard limit ${hardLimit} · B and C use ${COMPILER_MODEL}\n`);

// --- regression: v5 on the case v4 met its exit condition on ---------------------------------
{
  const reg = aPlans.regression;
  for (const which of reg.conditions) {
    const branch = which === "correct" ? "r-correct" : "r-mutant";
    const b = await build(git, branch, "src/cli/doctor.rs", "staging_info_from", reg.neededReferents, requirementFor("omamori-read-baseline"));
    if (!b.found) {
      notes.push({ method: "regression", branch, problem: "staging_info_from was not found uniquely" });
      console.log(`SKIP  regression/${branch}: staging_info_from not found uniquely`);
      continue;
    }
    const kept = SELECTIONS["callee-only"](b.entries);
    const refs = referentsPresent(kept, reg.neededReferents);
    if (!refs.ok) {
      notes.push({ method: "regression", branch, withheld: refs.reason });
      console.log(`HELD  regression/${branch}: ${refs.reason}`);
      continue;
    }
    if (dry) {
      console.log(`DRY   regression/${branch} body ${hash(b.packet.evidence.code)} dep ${kept.length}`);
      continue;
    }
    await judge("regression", "staging_info_from", branch, withRelated(b, kept), reg.condition, TRUTH[branch]!, { commit: b.commit, note: "v5 on the case v4 was measured on" });
  }
  console.log("");
}

// --- A and B, then C ---------------------------------------------------------------------------
const bPlans: Record<string, unknown> = {};
for (const c of aPlans.cases) {
  const branches = BRANCHES[c.id]!;
  const requirement = requirementFor(c.id);

  // B writes its plan from the requirement and the non-test source of the file, at the shipped commit.
  const shipped = await git.resolve(branches.correct);
  const whole = (await git.readText(shipped, c.file)) ?? "";
  const testsAt = whole.indexOf("\n#[cfg(test)]");
  const source = (testsAt > 0 ? whole.slice(0, testsAt) : whole).slice(0, 48_000);
  const bPlan = dry ? { symbol: "(dry)", needed_referents: [] } : ((await generatePlan(c.id, c.file, source)) as Record<string, unknown>);
  bPlans[c.id] = { ...bPlan, sourceChars: source.length, wholeFileChars: whole.length, truncated: source.length < (testsAt > 0 ? testsAt : whole.length) };
  console.log(`B plan for ${c.id}: ${JSON.stringify(bPlan).slice(0, 220)}`);

  for (const [which, branch] of Object.entries(branches)) {
    const truth = TRUTH[branch]!;

    // --- A ---
    const aBuilt = await build(git, branch, c.file, c.symbol, c.neededReferents, requirement);
    if (!aBuilt.found) {
      notes.push({ method: "A", case: c.id, branch, problem: `${c.symbol} was not found uniquely in ${c.file}` });
    } else {
      const kept = SELECTIONS["callee-only"](aBuilt.entries);
      const refs = referentsPresent(kept, c.neededReferents);
      if (!refs.ok) {
        notes.push({ method: "A", case: c.id, branch, withheld: refs.reason });
        console.log(`HELD  A/${c.id}/${which}: ${refs.reason}`);
      } else if (dry) {
        console.log(`DRY   A/${c.id}/${which} body ${hash(aBuilt.packet.evidence.code)} dep ${kept.map((e) => e.path).join(",")}`);
      } else {
        await judge("A", c.id, branch, withRelated(aBuilt, kept), c.condition, truth, { commit: aBuilt.commit, which });
      }
    }

    // --- B: its own symbol, its own condition, its own referents ---
    const bSymbol = typeof bPlan.symbol === "string" ? bPlan.symbol : "";
    const bNeeded = Array.isArray(bPlan.needed_referents) ? (bPlan.needed_referents as string[]) : [];
    const bCondition: ConditionV5 = {
      target: bSymbol,
      setup: String(bPlan.setup ?? ""),
      occurrence: String(bPlan.occurrence ?? ""),
      operation: String(bPlan.operation ?? ""),
      yields: String(bPlan.yields ?? ""),
      others: String(bPlan.others ?? ""),
      extra: String(bPlan.extra ?? ""),
    };
    const bBuilt = bSymbol ? await build(git, branch, "", bSymbol, bNeeded, requirement) : { found: false, commit: "", packet: null as unknown as Packet, entries: [] };
    if (!bBuilt.found) {
      notes.push({ method: "B", case: c.id, branch, problem: `the generated plan names ${bSymbol || "(nothing)"}, which is not defined exactly once in the repository`, plan: bPlan });
      console.log(`FAILB B/${c.id}/${which}: generated symbol ${bSymbol || "(nothing)"} not found uniquely — B fails this cell`);
    } else {
      const kept = SELECTIONS["callee-only"](bBuilt.entries);
      const refs = referentsPresent(kept, bNeeded);
      if (bNeeded.length === 0) {
        notes.push({ method: "B", case: c.id, branch, withheld: "the generated plan declares no needed referent, so nothing makes it answerable", plan: bPlan });
        console.log(`FAILB B/${c.id}/${which}: the generated plan declares no needed referent`);
      } else if (!refs.ok) {
        notes.push({ method: "B", case: c.id, branch, withheld: refs.reason, plan: bPlan });
        console.log(`HELD  B/${c.id}/${which}: ${refs.reason}`);
      } else if (dry) {
        console.log(`DRY   B/${c.id}/${which} body ${hash(bBuilt.packet.evidence.code)} dep ${kept.map((e) => e.path).join(",")}`);
      } else {
        await judge("B", c.id, branch, withRelated(bBuilt, kept), bCondition, truth, { commit: bBuilt.commit, which, generatedSymbol: bSymbol });
      }
    }

    // --- C: the same code, one call, a free verdict ---
    if (aBuilt.found && !dry) {
      const kept = SELECTIONS["callee-only"](aBuilt.entries);
      await review(c.id, branch, withRelated(aBuilt, kept), truth, { which, dependencyInPacket: kept.length > 0 });
    }
  }

  // --- the shape A withholds and C does not: no dependency in the packet ---
  if (!dry) {
    const b = await build(git, branches.correct, c.file, c.symbol, c.neededReferents, requirement);
    if (b.found) {
      const none = withRelated(b, []);
      const refs = referentsPresent([], c.neededReferents);
      notes.push({ method: "A", case: c.id, branch: "correct", condition: "no-dependency", withheld: refs.reason, requestsSpent: 0 });
      console.log(`HELD  A/${c.id}/no-dependency: ${refs.reason} (no request)`);
      await review(c.id, "correct", none, TRUTH[branches.correct]!, { which: "no-dependency", dependencyInPacket: false });
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------

writeFileSync(
  out,
  JSON.stringify(
    {
      tool: { name: "jev-intent-review", version: VERSION, commit: await new Git(TOOL_REPO).resolve("HEAD").catch(() => "unknown"), jevModel: provider.model, planningAndReviewModel: COMPILER_MODEL },
      plans: { comparison: JSON.parse(comparisonText), comparisonHash: hash(comparisonText), aPlans: JSON.parse(aPlansText), aPlansHash: hash(aPlansText) },
      questionVersion: "v5",
      bar: BAR_V3,
      generatedPlans: bPlans,
      runs,
      sent: { requests: client.sent.requests, bytes: client.sent.bytes, hardLimit },
      packets: Object.fromEntries(packets),
      log: rows,
      notes,
    },
    null,
    2,
  ),
);

// --- the tables ------------------------------------------------------------------------------
const cells = new Map<string, { n: number; right: number; truth: string }>();
for (const r of rows) {
  const key = `${r.method}/${r.case}/${r.branch}`;
  const right = r.method === "C" ? r.right === true : (r.result as { counted?: boolean } | undefined)?.counted === true;
  const cur = cells.get(key) ?? { n: 0, right: 0, truth: String(r.truth) };
  cur.n += 1;
  if (right) cur.right += 1;
  cells.set(key, cur);
}
console.log("cell                                                the code returns   right");
for (const [key, v] of cells) console.log(`  ${key.padEnd(48)} ${v.truth.padEnd(17)} ${v.right}/${v.n}`);
console.log(`\nwithheld or failed before a request: ${notes.length}`);
for (const n of notes) console.log(`  ${n.method}/${n.case ?? ""}/${n.branch ?? ""}: ${n.withheld ?? n.problem}`);
console.log(`\nrequests ${client.sent.requests}/${hardLimit} · ${(client.sent.bytes / 1024).toFixed(0)} KB · full record in ${out}`);
