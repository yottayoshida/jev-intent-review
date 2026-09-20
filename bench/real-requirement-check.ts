// One real requirement, one real function, read out of a real repository.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node bench/real-requirement-check.ts <omamori-clone> [runs] [log path]
//
// Everything before this file measured code written for the measurement: `collect_listing` copied
// into a bench, a read loop lifted into a wrapper. This one starts from the plan in
// `bench/plans/omamori-553-r2.json` — written and committed before anything was sent — and builds
// its evidence the way the tool does: `Git` over git objects at a pinned commit, `Discoverer` to
// find the definition, `buildEvidence` for the packet, the same redaction, `JevProvider` to ask.
// Nothing about the function is retyped here. If the extraction fails, that is the result.
//
// What is human-supplied, and says so: the file and symbol to look at, the condition, and which
// answer means which property. The plan calls that out; discovering the target and writing the
// plan are not what is being measured.
//
// The four cases come from the plan: the shipped function, a one-commit mutant that takes the
// listing failure as a success, a one-commit variant that changes nothing on that path, and the
// shipped function with its own body cut out of the packet. The last one is decided locally and
// spends no request — a model's confidence cannot restore a body nobody sent.
//
// Before any of this ran, `cargo test --lib` was run on all three branches of the clone:
// correct 1458 passed / 0 failed, variant 1458 / 0 — identical, which is what "behaviour
// preserving" has to mean — and the mutant fails
// `staging_listing_that_stops_partway_is_reported_as_unreadable` with `got "  [Staging] empty\n"`,
// which is the defect issue #485 was filed about, reproduced. The results are in the log.
//
// The request budget is the product's own: `CloudflareClient` counts what goes over the wire,
// retries included, and refuses past `maxRequests`. Nothing here counts separately.
//
// The log holds the redacted packet that was sent — once per distinct packet under `packets`, with
// every run naming its own by hash. The first version of this file recorded none of it, and the
// write-up said the failing packet was in the log in full, which was false; `bench/recount.ts` now
// prints `packets: NOT RECORDED` for that log rather than letting it read as if they were there.
// A packet rebuilt from the pinned commit afterwards is a reconstruction, not the run's record,
// and is not written back into it.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defines } from "../src/change/blocks.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { buildEvidence, type EvidenceLimits } from "../src/evidence/builder.ts";
import { CloudflareClient, endpointFromEnv } from "../src/judgments/cloudflare.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { Git } from "../src/repository/git.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Candidate, ChoiceAnswer, Requirement } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { BAR_V3, canAnswerLocally, questionsV3, score, verdictOfV3, type ConditionV3 } from "./check-questions-v3.ts";

const HERE = import.meta.dirname;
const TOOL_REPO = dirname(HERE);
const PLAN_PATH = join(HERE, "plans/omamori-553-r2.json");

/**
 * The same expression the earlier benches used — `JSON.stringify` first, strings included — so a
 * hash recorded in `bench/logs/local-check.json` can be checked against the string beside it.
 * Hashing the raw string instead makes every one of those checks fail, which is how this was found.
 */
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

interface PlanCase {
  id: string;
  branch: string;
  what: string;
  expectedResult: string | null;
  expectedControl: string | null;
  expectedVerdict: string;
  sendsRequests: boolean;
  why?: string;
}

const planText = readFileSync(PLAN_PATH, "utf8");
const plan = JSON.parse(planText) as {
  requirement: { id: string; textSentToTheModel: string; primarySource: { url: string; quote: string; retrievedAt: string } };
  target: { file: string; symbol: string; repository: string };
  condition: ConditionV3 & Record<string, unknown>;
  cases: PlanCase[];
  regression: { condition: ConditionV3 & Record<string, unknown>; cases: { id: string; expectedResult: string; expectedVerdict: string }[] };
  measurement: { runsPerCase: number; requestBudget: { hardLimit: number; planned: Record<string, number> } };
};

const condition: ConditionV3 = {
  setup: plan.condition.setup,
  operation: plan.condition.operation,
  yields: plan.condition.yields,
  others: plan.condition.others,
  finite: plan.condition.finite,
};
const regressionCondition: ConditionV3 = {
  setup: plan.regression.condition.setup,
  operation: plan.regression.condition.operation,
  yields: plan.regression.condition.yields,
  others: plan.regression.condition.others,
  finite: plan.regression.condition.finite,
};

/** The requirement as the tool would carry it. The text is the plan's, quoted from the pull request. */
const requirement: Requirement = {
  id: plan.requirement.id,
  text: plan.requirement.textSentToTheModel,
  kind: "behavior",
  priority: "required",
  sourceRefs: [{ sourceId: plan.requirement.primarySource.url, quote: plan.requirement.primarySource.quote }],
  searchHints: [],
};

const DEFAULT_LIMITS: EvidenceLimits = { maxPrimaryChars: 8000, maxRelatedChars: 4000 };
/** Below the function's length, so its own body does not fit and `cut.own` is set. */
const CUT_LIMITS: EvidenceLimits = { maxPrimaryChars: 800, maxRelatedChars: 4000 };

interface Built {
  state: unknown;
  cut: { own: boolean; context: boolean; ambiguous: boolean };
  gate: { send: boolean; reason?: string };
  located: { path: string; lines: string; symbol: string; commit: string } | null;
  note: string[];
  redactions: number;
  relatedPaths: string[];
}

/**
 * The target's evidence, found the way the tool finds it: grep the symbol at the commit, take the
 * hit that defines it, take the block around that line. No line number is written down anywhere,
 * so a commit that moved the function is followed rather than mis-cited — and a symbol that is
 * defined more than once is a target mismatch, reported, not resolved by picking one.
 */
async function buildForCommit(git: Git, commit: string, limits: EvidenceLimits): Promise<Built> {
  const note: string[] = [];
  const discoverer = new Discoverer(git, commit, { include: () => true, maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const { hits } = await discoverer.search(plan.target.symbol);
  const definitions = hits.filter((h) => defines(h.text, plan.target.symbol));
  if (definitions.length !== 1) {
    return {
      state: null,
      cut: { own: false, context: false, ambiguous: definitions.length > 1 },
      gate: { send: false, reason: `the symbol ${plan.target.symbol} is defined ${definitions.length} times at ${commit.slice(0, 7)}; the target is not uniquely identified` },
      located: null,
      note,
      redactions: 0,
      relatedPaths: [],
    };
  }
  const definition = definitions[0]!;
  if (definition.path !== plan.target.file) note.push(`the definition is at ${definition.path}, not the plan's ${plan.target.file}`);
  const index = await discoverer.index(definition.path);
  if (!index) {
    return { state: null, cut: { own: false, context: false, ambiguous: false }, gate: { send: false, reason: `${definition.path} could not be read at ${commit.slice(0, 7)}` }, located: null, note, redactions: 0, relatedPaths: [] };
  }
  const block = index.enclosing(definition.line);
  const candidate: Candidate = {
    path: definition.path,
    startLine: block.startLine,
    endLine: block.endLine,
    symbol: plan.target.symbol,
    changed: true,
    reasons: [`the plan names ${plan.target.symbol} as the function that returns the result of the enumeration`],
    ...(block.windowed ? { windowed: true } : {}),
  };
  const evidence = await buildEvidence(discoverer, requirement, candidate, limits);
  const bodyFound = evidence.packet.evidence.code.length > 0;
  return {
    state: evidence.packet,
    cut: evidence.cut,
    gate: canAnswerLocally(evidence.cut, bodyFound),
    located: { path: candidate.path, lines: evidence.packet.candidate.lines, symbol: plan.target.symbol, commit },
    note,
    redactions: evidence.redactions,
    relatedPaths: evidence.packet.evidence.related.map((r) => `${r.path}:${r.lines}`),
  };
}

/** The two regression cases, taken from the v1 log so the string cannot drift from what was measured. */
function regressionCode(): { id: string; code: string; codeHash: string }[] {
  const log = JSON.parse(readFileSync(join(HERE, "logs/local-check.json"), "utf8")) as { log: { case: string; code: string; codeHash: string }[] };
  const wanted = [
    { id: "regression/collect_listing-shipped", case: "shipped" },
    { id: "regression/collect_listing-stops-but-succeeds", case: "stops-but-succeeds" },
  ];
  return wanted.map(({ id, case: name }) => {
    const row = log.log.find((r) => r.case === name);
    if (!row) throw new Error(`bench/logs/local-check.json has no case '${name}'`);
    if (hash(row.code) !== row.codeHash) throw new Error(`the code for '${name}' does not match the hash recorded beside it`);
    return { id, code: row.code, codeHash: row.codeHash };
  });
}

// ---------------------------------------------------------------------------

const repoDir = process.argv[2];
if (!repoDir) throw new Error("usage: node bench/real-requirement-check.ts <omamori-clone> [runs] [log path]");
const runs = Number(process.argv[3] ?? plan.measurement.runsPerCase);
const out = process.argv[4] ?? "real-requirement-check.json";
const hardLimit = plan.measurement.requestBudget.hardLimit;

/**
 * `DRY_RUN=1` builds every packet and runs the local gate, and sends nothing. It is how the
 * extraction was checked before a single request was spent: a packet that turns out to be missing
 * the body, or to name the wrong lines, is a defect in this file and not a result about Jev.
 */
const dry = process.env.DRY_RUN === "1";

const endpoint = endpointFromEnv();
if (!endpoint && !dry) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
// The product's own budget: retries included, and it refuses rather than overrunning.
const client = new CloudflareClient(endpoint ?? { url: "https://example.invalid/dry", token: "unused", source: "JEV_API_URL" }, { maxRetries: 0, maxRequests: dry ? 0 : hardLimit });
const provider = new JevProvider(client);

const git = new Git(repoDir);
const toolGit = new Git(TOOL_REPO);
const toolCommit = await toolGit.resolve("HEAD").catch(() => "unknown");

const questions = questionsV3(condition);
const regressionQuestions = questionsV3(regressionCondition);

interface Row {
  group: "regression" | "target";
  case: string;
  run: number | null;
  commit?: string;
  located?: unknown;
  cut?: unknown;
  sent?: unknown;
  expected: { result: string | null; control: string | null; verdict: string };
  /**
   * The hash of the redacted packet this run actually sent. The body is under `packets` at the top
   * of the file, once per distinct packet rather than once per run.
   *
   * The first version of this file recorded none of it — `located`, `cut` and the paths in `sent`,
   * and nothing of what went over the wire — while `docs/real-requirement-check.md` said the
   * failing packet was in the log in full. It was not. A packet rebuilt afterwards is not the same
   * artefact as one that was recorded, so the fix is to record it, not to reconstruct it.
   */
  sentStateHash?: string;
  answers?: Record<string, ChoiceAnswer>;
  result?: { choice: string; probability: number; choiceMatch: boolean; counted: boolean };
  control?: { choice: string; probability: number; choiceMatch: boolean | null; counted: boolean | null };
  verdict?: string;
  why?: string;
  met?: boolean;
  skipped?: { reason: string };
  error?: string;
}

const rows: Row[] = [];
const tally = new Map<string, { runs: number; choiceMatch: number; counted: number; verdictMatch: number; expected: string | null }>();

function record(id: string, expectedResult: string | null) {
  if (!tally.has(id)) tally.set(id, { runs: 0, choiceMatch: 0, counted: 0, verdictMatch: 0, expected: expectedResult });
  return tally.get(id)!;
}

/** Every distinct redacted packet that was sent, by hash, so each run can name one without copying it. */
const packets = new Map<string, unknown>();

async function measure(group: "regression" | "target", id: string, state: unknown, qs: ReturnType<typeof questionsV3>, expected: Row["expected"], extra: Partial<Row>) {
  const t = record(id, expected.result);
  const stateHash = hash(state);
  packets.set(stateHash, state);
  for (let run = 1; run <= runs; run++) {
    try {
      const answers = (await provider.judge(state, qs)) as Record<string, ChoiceAnswer | undefined>;
      const result = answers.on_error_result;
      const control = answers.on_error_control;
      const rp = result ? probabilityOf(result, result.choice) : 0;
      const cp = control ? probabilityOf(control, control.choice) : 0;
      const rs = score(result?.choice ?? "none", rp, expected.result ?? "");
      const { verdict, why } = verdictOfV3(result?.choice, rp);
      t.runs += 1;
      if (rs.choiceMatch) t.choiceMatch += 1;
      if (rs.counted) t.counted += 1;
      if (verdict === expected.verdict) t.verdictMatch += 1;
      rows.push({
        group,
        case: id,
        run,
        ...extra,
        expected,
        sentStateHash: stateHash,
        answers: answers as Record<string, ChoiceAnswer>,
        result: { choice: result?.choice ?? "none", probability: rp, choiceMatch: rs.choiceMatch, counted: rs.counted },
        control: {
          choice: control?.choice ?? "none",
          probability: cp,
          choiceMatch: expected.control === null ? null : control?.choice === expected.control,
          counted: expected.control === null ? null : control?.choice === expected.control && cp >= BAR_V3,
        },
        verdict,
        why,
      });
      console.log(
        `${rs.counted ? "MET " : "MISS"} ${id.padEnd(44)} run ${run}: result ${result?.choice} ${rp.toFixed(2)} → ${verdict}` +
          `  · control ${control?.choice} ${cp.toFixed(2)}` +
          (rs.counted ? "" : `  — the code returns ${expected.result}`),
      );
    } catch (e) {
      t.runs += 1;
      const message = e instanceof Error ? e.message : String(e);
      rows.push({ group, case: id, run, ...extra, expected, sentStateHash: stateHash, error: message });
      console.log(`FAIL ${id.padEnd(44)} run ${run}: ${message}`);
      if (/budget|maxRequests|request limit/i.test(message)) {
        console.log("the request budget stopped the run; what was measured is written to the log");
        return false;
      }
    }
  }
  return true;
}

console.log(`plan ${hash(planText)} · questions ${hash(questions)} · bar ${BAR_V3} · ${runs} run(s) per case · hard limit ${hardLimit} requests`);
console.log(`requirement ${requirement.id}: ${requirement.text}`);
console.log(`condition: ${questions.on_error_result.instructions}\n`);

// --- regression: the new question contract on two cases measured under v1 --------------------
if (dry) console.log("DRY_RUN=1 — packets are built and the gate runs; nothing is sent.\n");
for (const { id, code, codeHash } of dry ? [] : regressionCode()) {
  const expected = plan.regression.cases.find((c) => c.id === id)!;
  const ok = await measure("regression", id, { code }, regressionQuestions, { result: expected.expectedResult, control: null, verdict: expected.expectedVerdict }, { sent: { kind: "code string from bench/logs/local-check.json", codeHash } });
  if (!ok) break;
}

// --- target: the real function out of the real repository -------------------------------------
console.log("");
const built = new Map<string, Built>();
for (const c of plan.cases) {
  const commit = await git.resolve(c.branch);
  const limits = c.sendsRequests ? DEFAULT_LIMITS : CUT_LIMITS;
  const b = await buildForCommit(git, commit, limits);
  built.set(c.id, b);
  const expected = { result: c.expectedResult, control: c.expectedControl, verdict: c.expectedVerdict };
  const extra = { commit, located: b.located, cut: b.cut, sent: { limits, related: b.relatedPaths, redactions: b.redactions, notes: b.note } };
  if (!b.gate.send) {
    const met = c.expectedVerdict === "unknown";
    rows.push({ group: "target", case: c.id, run: null, ...extra, expected, verdict: "unknown", why: b.gate.reason, skipped: { reason: b.gate.reason! }, met });
    record(c.id, c.expectedResult);
    console.log(`${met ? "MET " : "MISS"} ${c.id.padEnd(44)} no request: ${b.gate.reason}`);
    continue;
  }
  if (!c.sendsRequests) {
    rows.push({ group: "target", case: c.id, run: null, ...extra, expected, verdict: "unknown", why: "the plan expected this case to be withheld locally, and it was not", met: false });
    console.log(`MISS ${c.id.padEnd(44)} the plan expected no request here, but the evidence was judged sufficient`);
    continue;
  }
  if (dry) {
    const packet = b.state as { evidence: { code: string; related: unknown[]; truncated: boolean } };
    console.log(`DRY  ${c.id.padEnd(44)} ${b.located?.path}:${b.located?.lines} @ ${commit.slice(0, 7)} · body ${packet.evidence.code.length} chars · related ${packet.evidence.related.length} · truncated ${packet.evidence.truncated} · cut ${JSON.stringify(b.cut)}`);
    console.log(`     related: ${b.relatedPaths.join(", ") || "(none)"}`);
    console.log(`     first line of body: ${packet.evidence.code.split("\n")[0]}`);
    // Discriminating markers only. `stop.seen` is in both — the shipped error message says how
    // many entries were seen — so it names nothing. These two lines exist in one version each.
    const swallows = /Err\(stop\) => stop\.seen,/.test(packet.evidence.code);
    const propagates = /\.map_err\(\|stop\|/.test(packet.evidence.code) && /\}\)\?;/.test(packet.evidence.code);
    const minMtime = /map_or\(mtime/.test(packet.evidence.code);
    console.log(`     propagation: ${propagates ? "map_err(|stop| …)? — hands the failure back" : swallows ? "Err(stop) => stop.seen — takes it as a success" : "NEITHER MARKER FOUND (the extraction is wrong)"}${minMtime ? " · variant's map_or(mtime…) present" : ""}`);
    continue;
  }
  const ok = await measure("target", c.id, b.state, questions, expected, extra);
  if (!ok) break;
}

// ---------------------------------------------------------------------------

const summary = [...tally.entries()].map(([id, t]) => ({ case: id, ...t }));
writeFileSync(
  out,
  JSON.stringify(
    {
      tool: { name: "jev-intent-review", version: VERSION, commit: toolCommit, model: provider.model },
      plan: { path: "bench/plans/omamori-553-r2.json", hash: hash(planText), content: JSON.parse(planText) },
      questions: { target: questions, targetHash: hash(questions), regression: regressionQuestions, regressionHash: hash(regressionQuestions), bar: BAR_V3 },
      conditions: { target: condition, regression: regressionCondition },
      requirementSent: requirement,
      localTests: {
        command: "cargo test --lib (in the isolated clone, CARGO_TARGET_DIR outside the repo)",
        correct: "1458 passed; 0 failed; 1 ignored",
        variant: "1458 passed; 0 failed; 1 ignored — identical to correct, which is what behaviour-preserving has to mean",
        mutant: "1457 passed; 1 failed — exactly cli::doctor::tests::staging_listing_that_stops_partway_is_reported_as_unreadable, which panics with got \"  [Staging] empty\\n\"",
        meaning:
          "The injected failure really happens at the enumeration and really changes the observable result: one test out of 1459 separates the mutant, and it is the test for this property. The operator-visible string it produces is the one issue #485 was filed about.",
      },
      runs,
      sent: { requests: client.sent.requests, bytes: client.sent.bytes, hardLimit },
      summary,
      // What actually went over the wire, redacted by `buildEvidence` as the product does it, one
      // entry per distinct packet. Each run above names its own by hash.
      packets: Object.fromEntries(packets),
      log: rows,
    },
    null,
    2,
  ),
);

console.log("\ncase                                          runs  choice  choice+bar  verdict");
for (const s of summary) console.log(`  ${s.case.padEnd(44)} ${String(s.runs).padStart(2)}    ${s.choiceMatch}/${s.runs}     ${s.counted}/${s.runs}       ${s.verdictMatch}/${s.runs}`);
const sendingCases = summary.filter((s) => s.runs > 0);
const unmet = sendingCases.filter((s) => s.counted < s.runs);
console.log(`\nrequests ${client.sent.requests}/${hardLimit} · ${(client.sent.bytes / 1024).toFixed(0)} KB sent · full record in ${out}`);
console.log(unmet.length === 0 ? "every case that sent requests met the pass condition" : `${unmet.length} case(s) did not meet it: ${unmet.map((s) => s.case).join(", ")}`);
const localCases = rows.filter((r) => r.run === null);
for (const r of localCases) console.log(`  ${r.case}: ${r.met ? "withheld locally, as planned" : "NOT as planned"} — ${r.why}`);
process.exitCode = unmet.length === 0 && localCases.every((r) => r.met) ? 0 : 1;
