// Which kind of related evidence carried the wrong answer, and which kind the question needs.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/evidence-selection-check.ts <omamori-clone> [runs] [log path]
//
// The plan is `bench/plans/omamori-553-r2-evidence.json`, written before the first request. The
// question, the condition and the target are the ones already fixed for this requirement and are
// re-read from `bench/plans/omamori-553-r2.json` rather than copied, so they cannot drift.
//
// Phase A: two code versions × four selections × three runs. Phase B: the candidate rule on the
// behaviour-preserving variant, and on a packet whose needed referent has been taken out, which
// the referent gate has to withhold without spending a request.
//
// The clone is built from `bench/fixtures/omamori-553-r2/*.patch` on top of the pinned base. `git
// am` makes new commits every time, so the SHAs are recorded here rather than pinned in the plan;
// what is pinned is the base commit and the patches.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence, type Packet, type Related } from "../src/evidence/builder.ts";
import { CloudflareClient, endpointFromEnv } from "../src/judgments/cloudflare.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, canAnswerLocally, questionsV3, score, verdictOfV3, type ConditionV3 } from "./check-questions-v3.ts";
import { SELECTIONS, classify, referentsPresent, type Classified, type SelectionId } from "./evidence-selection.ts";

const HERE = import.meta.dirname;
const TOOL_REPO = dirname(HERE);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const basePlanText = readFileSync(join(HERE, "plans/omamori-553-r2.json"), "utf8");
const planText = readFileSync(join(HERE, "plans/omamori-553-r2-evidence.json"), "utf8");
const basePlan = JSON.parse(basePlanText) as {
  requirement: { id: string; textSentToTheModel: string; primarySource: { url: string; quote: string } };
  condition: ConditionV3 & Record<string, unknown>;
};
const plan = JSON.parse(planText) as {
  target: { file: string; symbol: string; neededReferents: string[] };
  selections: { id: SelectionId; isCandidateRule: boolean }[];
  requestBudget: { hardLimit: number };
};

const condition: ConditionV3 = {
  setup: basePlan.condition.setup,
  operation: basePlan.condition.operation,
  yields: basePlan.condition.yields,
  others: basePlan.condition.others,
  finite: basePlan.condition.finite,
};
const questions = questionsV3(condition);
const CANDIDATE = plan.selections.find((s) => s.isCandidateRule)!.id;
const NEEDED = plan.target.neededReferents;

const requirement: Requirement = {
  id: basePlan.requirement.id,
  text: basePlan.requirement.textSentToTheModel,
  kind: "behavior",
  priority: "required",
  sourceRefs: [{ sourceId: basePlan.requirement.primarySource.url, quote: basePlan.requirement.primarySource.quote }],
  searchHints: [],
};

/** The code's real behaviour, from `cargo test` on each branch — not from any answer. */
const TRUTH: Record<string, "returns_error" | "returns_success"> = { correct: "returns_error", mutant: "returns_success", variant: "returns_error" };

interface Built {
  commit: string;
  packet: Packet;
  entries: Classified[];
  ownCut: boolean;
  bodyFound: boolean;
}

/** One build per version, at the default limits. Everything else is a subset of it. */
async function build(git: Git, branch: string): Promise<Built> {
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
  // The same `testRegions` the product's own definition filter uses, asked per entry.
  const inTestRegion = async (path: string, line: number) => {
    const i = await discoverer.index(path);
    return (i?.testRegions ?? []).some((r) => line >= r.start && line <= r.end);
  };
  const flags = await Promise.all(evidence.packet.evidence.related.map((e) => inTestRegion(e.path, Number(e.lines.split("-")[0]))));
  const entries = classify(evidence.packet.evidence.related, NEEDED, (path, line) => {
    const i = evidence.packet.evidence.related.findIndex((e) => e.path === path && Number(e.lines.split("-")[0]) === line);
    return i >= 0 ? flags[i]! : false;
  });
  return { commit, packet: evidence.packet, entries, ownCut: evidence.cut.own, bodyFound: evidence.packet.evidence.code.length > 0 };
}

/** A subset of one built packet. `truncated` stays true whenever anything was dropped. */
function packetWith(built: Built, kept: readonly Classified[]): Packet {
  const related: Related[] = kept.map(({ path, lines, code }) => ({ path, lines, code }));
  return { ...built.packet, evidence: { ...built.packet.evidence, related, truncated: built.packet.evidence.truncated || related.length < built.entries.length } };
}

// ---------------------------------------------------------------------------

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/evidence-selection-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "evidence-selection.json";
const dry = process.env.DRY_RUN === "1";
const hardLimit = plan.requestBudget.hardLimit;

const endpoint = endpointFromEnv();
if (!endpoint && !dry) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const client = new CloudflareClient(endpoint ?? { url: "https://example.invalid/dry", token: "unused", source: "JEV_API_URL" }, { maxRetries: 0, maxRequests: dry ? 0 : hardLimit });
const provider = new JevProvider(client);
const git = new Git(repoDir);

const built = new Map<string, Built>();
for (const branch of ["correct", "mutant", "variant"]) built.set(branch, await build(git, branch));

const packets = new Map<string, unknown>();
const rows: Record<string, unknown>[] = [];
const tally = new Map<string, { runs: number; choiceMatch: number; counted: number; expected: string }>();

async function measure(phase: string, id: string, state: Packet, expected: string, extra: Record<string, unknown>): Promise<boolean> {
  const stateHash = hash(state);
  packets.set(stateHash, state);
  if (!tally.has(id)) tally.set(id, { runs: 0, choiceMatch: 0, counted: 0, expected });
  const t = tally.get(id)!;
  for (let run = 1; run <= runs; run++) {
    try {
      const answers = (await provider.judge(state, questions)) as Record<string, ChoiceAnswer | undefined>;
      const result = answers.on_error_result;
      const control = answers.on_error_control;
      const p = result ? probabilityOf(result, result.choice) : 0;
      const cp = control ? probabilityOf(control, control.choice) : 0;
      const s = score(result?.choice ?? "none", p, expected);
      const { verdict, why } = verdictOfV3(result?.choice, p);
      t.runs += 1;
      if (s.choiceMatch) t.choiceMatch += 1;
      if (s.counted) t.counted += 1;
      rows.push({ phase, case: id, run, ...extra, expected, sentStateHash: stateHash, answers, result: { choice: result?.choice ?? "none", probability: p, choiceMatch: s.choiceMatch, counted: s.counted }, control: { choice: control?.choice ?? "none", probability: cp }, verdict, why });
      console.log(`${s.counted ? "READS" : "MISS "} ${id.padEnd(30)} run ${run}: ${result?.choice} ${p.toFixed(2)} → ${verdict}` + (s.counted ? "" : `  — the code returns ${expected}`));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      t.runs += 1;
      rows.push({ phase, case: id, run, ...extra, expected, sentStateHash: stateHash, error: message });
      console.log(`FAIL  ${id.padEnd(30)} run ${run}: ${message}`);
      if (/budget|maxRequests|request limit/i.test(message)) return false;
    }
  }
  return true;
}

console.log(`plan ${hash(planText)} (base ${hash(basePlanText)}) · questions ${hash(questions)} · bar ${BAR_V3} · ${runs} run(s) per cell · hard limit ${hardLimit}`);
for (const [branch, b] of built) {
  console.log(`${branch} @ ${b.commit.slice(0, 7)} · body ${b.packet.evidence.code.length} chars · related ${b.entries.length}: ${b.entries.map((e) => `${e.kind}${e.defines ? `(${e.defines})` : ""} ${e.path.split("/").pop()}:${e.lines}`).join(" | ")}`);
}
console.log("");

if (dry) {
  console.log("DRY_RUN=1 — the subsets are printed and nothing is sent.\n");
  for (const [branch, b] of built) {
    for (const id of Object.keys(SELECTIONS) as SelectionId[]) {
      const kept = SELECTIONS[id](b.entries);
      const gate = referentsPresent(kept, NEEDED);
      console.log(`  ${branch.padEnd(8)} ${id.padEnd(12)} keeps ${kept.length}/${b.entries.length} (${kept.map((e) => e.kind).join(",") || "-"}) · referents ${gate.ok ? "present" : `MISSING: ${gate.reason}`}`);
    }
  }
  process.exit(0);
}

// --- phase A -----------------------------------------------------------------
outer: for (const branch of ["correct", "mutant"] as const) {
  const b = built.get(branch)!;
  for (const id of Object.keys(SELECTIONS) as SelectionId[]) {
    const kept = SELECTIONS[id](b.entries);
    const state = packetWith(b, kept);
    const ok = await measure("A", `${branch}/${id}`, state, TRUTH[branch]!, {
      branch,
      selection: id,
      commit: b.commit,
      kept: kept.map((e) => ({ path: e.path, lines: e.lines, kind: e.kind })),
      referents: referentsPresent(kept, NEEDED),
    });
    if (!ok) break outer;
  }
}

// --- phase B: the candidate rule ---------------------------------------------
console.log("");
const local: Record<string, unknown>[] = [];
{
  const b = built.get("variant")!;
  const kept = SELECTIONS[CANDIDATE](b.entries);
  const gate = canAnswerLocally({ own: b.ownCut, context: true, ambiguous: false }, b.bodyFound);
  const refs = referentsPresent(kept, NEEDED);
  if (gate.send && refs.ok) {
    await measure("B", `candidate/variant`, packetWith(b, kept), TRUTH.variant!, { branch: "variant", selection: CANDIDATE, commit: b.commit, kept: kept.map((e) => ({ path: e.path, lines: e.lines, kind: e.kind })), referents: refs });
  } else {
    local.push({ phase: "B", case: "candidate/variant", withheld: gate.reason ?? refs.reason, met: false });
    console.log(`MISS  candidate/variant           withheld, which the plan did not expect: ${gate.reason ?? refs.reason}`);
  }
}
{
  // The candidate packet with the needed referent taken out. The gate has to withhold it, and the
  // run has to spend nothing on it.
  const b = built.get("correct")!;
  const kept = SELECTIONS[CANDIDATE](b.entries).filter((e) => e.kind !== "needed_callee");
  const refs = referentsPresent(kept, NEEDED);
  const met = !refs.ok;
  local.push({ phase: "B", case: "candidate/referent-missing", kept: kept.map((e) => ({ path: e.path, lines: e.lines, kind: e.kind })), withheld: refs.reason, met });
  console.log(`${met ? "HELD " : "MISS "} candidate/referent-missing   ${met ? `no request: ${refs.reason}` : "the gate let it through, which the plan did not expect"}`);
}

// ---------------------------------------------------------------------------

writeFileSync(
  out,
  JSON.stringify(
    {
      tool: { name: "jev-intent-review", version: VERSION, commit: await new Git(TOOL_REPO).resolve("HEAD").catch(() => "unknown"), model: provider.model },
      plan: { path: "bench/plans/omamori-553-r2-evidence.json", hash: hash(planText), content: JSON.parse(planText) },
      basePlan: { path: "bench/plans/omamori-553-r2.json", hash: hash(basePlanText) },
      questions,
      questionsHash: hash(questions),
      condition,
      bar: BAR_V3,
      candidateRule: CANDIDATE,
      neededReferents: NEEDED,
      commits: Object.fromEntries([...built].map(([b, v]) => [b, v.commit])),
      relatedAsBuilt: Object.fromEntries([...built].map(([b, v]) => [b, v.entries.map((e) => ({ path: e.path, lines: e.lines, kind: e.kind, defines: e.defines, chars: e.code.length }))])),
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

console.log("\ncell                            expected          answered        reads it");
for (const [id, t] of tally) {
  const cell = rows.filter((r) => r.case === id && r.result);
  const choices = [...new Set(cell.map((r) => (r.result as { choice: string }).choice))].join("/");
  const ps = cell.map((r) => (r.result as { probability: number }).probability);
  console.log(`  ${id.padEnd(30)} ${t.expected.padEnd(17)} ${choices} ${ps.length ? `${Math.min(...ps).toFixed(2)}-${Math.max(...ps).toFixed(2)}` : "-"}   ${t.counted}/${t.runs}`);
}
console.log(`\nrequests ${client.sent.requests}/${hardLimit} · ${(client.sent.bytes / 1024).toFixed(0)} KB · full record in ${out}`);
const unmet = [...tally.entries()].filter(([, t]) => t.counted < t.runs).map(([id]) => id);
console.log(unmet.length === 0 ? "every cell read the code correctly" : `cells that did not: ${unmet.join(", ")}`);
process.exitCode = unmet.length === 0 && local.every((l) => l.met) ? 0 : 1;
