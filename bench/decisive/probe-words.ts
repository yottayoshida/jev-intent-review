// The probe of the words for `check_before_action` (#82, ADR 0020): the old question, the case-only
// question and the two-step (the check's value from its own body, then the function's question under
// that value), on the same packets, interleaved request by request. What is sent, the lines and the
// rule choosing among the arms are in words-probe.json, committed before any request.
//
//   node bench/decisive/probe-words.ts send  <acceptance dir> <constructed repo> <limit>
//   node bench/decisive/probe-words.ts score [<acceptance dir> <constructed repo>]
//
// The packets are the wired run's: `buildEvidence` with the local check's limits, the checks the
// form names (`Form.decisive`) and their bodies (`decisiveBodies`) as ADR 0019 sends them. Arm 0's
// question is the one in src; arms 1 and 2 are built here from the templates in words-probe.json,
// with the three answers taken from arm 0's question so they are the same words in every arm.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/config/config.ts";
import { pathFilter } from "../../src/config/glob.ts";
import { Discoverer } from "../../src/discovery/discover.ts";
import { buildEvidence, DECISIVE_LIMITS, decisiveBodies, type SentBody } from "../../src/evidence/builder.ts";
import { redact } from "../../src/evidence/redact.ts";
import { parseIntentSpec } from "../../src/intent/schema.ts";
import { endpointFromEnv, JevClient, jevModel } from "../../src/judgments/client.ts";
import { JevProvider } from "../../src/judgments/jev.ts";
import type { Questions } from "../../src/judgments/provider.ts";
import { functionDefinitionsOf } from "../../src/plan/applicability.ts";
import { enumerate, type CallCandidate, type FunctionCandidate } from "../../src/plan/candidates.ts";
import { FORMS } from "../../src/plan/forms.ts";
import { Git } from "../../src/repository/git.ts";
import { DEFAULT_LOCAL_CHECK } from "../../src/review/local-check-run.ts";
import type { ChoiceAnswer, Requirement } from "../../src/types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
// The plan and its log: version 1 by default; a later version names both (`send … <plan> <log>`).
const argvPlan = process.argv[6] ?? process.argv[5];
const PLAN = process.argv[2] === "send" ? (process.argv[6] ? join(ROOT, process.argv[6]) : join(HERE, "words-probe.json")) : process.argv[5] ? join(ROOT, process.argv[5]) : join(HERE, "words-probe.json");
const LOG = process.argv[2] === "send" ? (process.argv[7] ? join(ROOT, process.argv[7]) : join(ROOT, "bench", "logs", "words-probe-v1.json")) : process.argv[6] ? join(ROOT, process.argv[6]) : join(ROOT, "bench", "logs", "words-probe-v1.json");
void argvPlan;

interface Target {
  set: "S" | "D" | "H";
  id: string;
  case: string;
  version: string;
  repo: string;
  head: string;
  file: string;
  function: string;
  call: string;
  spec: string;
  requirementId: string;
  values: Record<string, string>;
}
interface Outside {
  set: "outside-check" | "outside-none";
  id: string;
  repo: string;
  head: string;
  file: string;
  function: string;
  call: string;
  checks: string[];
  requirement: string;
  searchHints: string[];
}
interface Plan {
  wording: { function: string; value_clause: string; value_words: Record<string, string>; check: string; check_criteria: Record<string, string> };
  bar: number;
  runs: number;
  /** The arms sent. Version 1 sent all three; a later version may send fewer. */
  send?: (0 | 1 | 2)[];
  targets: Target[];
  outside: Outside[];
}
interface Record_ {
  id: string;
  run: number;
  arm: 0 | 1 | 2;
  packet: string;
  sent: string[];
  /** Arm 2: the check-value answers by check name, and a hold when one could not be read. */
  checks?: Record<string, ChoiceAnswer>;
  held?: string;
  answer?: ChoiceAnswer;
  error?: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const named = (call: CallCandidate) => redact(call.expression).text.replace(/`/g, "");
const repoOf = (acceptance: string, constructed: string, repo: string) => (repo === "constructed" ? constructed : join(acceptance, repo));

/** The item's requirement: the spec's, or the outside call's stand-in. */
function requirementOf(item: Target | Outside): Requirement {
  if ("spec" in item) return parseIntentSpec(readFileSync(join(ROOT, item.spec), "utf8"), item.spec).requirements.find((r) => r.id === item.requirementId)!;
  return { id: "P", text: item.requirement, kind: "behavior", priority: "required", sourceRefs: [], searchHints: item.searchHints, form: "check_before_action" };
}

/** The place as the wired run has it: function, call, the packet with the checks' bodies, and what was sent. */
async function packetOf(repo: string, item: Target | Outside, requirement: Requirement) {
  const git = await Git.open(repo);
  const source = await git.readText(item.head, item.file);
  if (source === null) throw new Error(`${item.id}: ${item.file} is not at ${item.head.slice(0, 7)}`);
  const listed = enumerate(item.file, source);
  const hits = listed.calls.filter((c) => listed.functions.find((f) => f.id === c.functionId)?.name === item.function && redact(c.expression).text === item.call);
  if (hits.length !== 1) throw new Error(`${item.id}: ${hits.length} calls \`${item.call}\` in ${item.function}`);
  const call = hits[0]!;
  const fn = listed.functions.find((f) => f.id === call.functionId)!;
  const cfg = defaultConfig();
  const discoverer = new Discoverer(git, item.head, { include: pathFilter(cfg.repository.include, cfg.repository.ignore), lexicalSearch: true, referenceSearch: true });
  const evidence = await buildEvidence(discoverer, requirement, { path: fn.path, startLine: fn.startLine, endLine: fn.endLine, symbol: fn.name, changed: true, reasons: [] }, { maxPrimaryChars: DEFAULT_LOCAL_CHECK.maxPrimaryChars, maxRelatedChars: DEFAULT_LOCAL_CHECK.maxRelatedChars });
  if (evidence.cut.own) throw new Error(`${item.id}: the body did not fit`);
  const defined = async (name: string) => {
    const { found, more } = await functionDefinitionsOf(discoverer, name);
    return found.length > 0 || more;
  };
  const decisive = await FORMS.check_before_action.decisive({ requirement, fn, call, body: evidence.packet.evidence.code, calls: listed.calls.filter((c) => c.functionId === fn.id), defined });
  if ("hold" in decisive) throw new Error(`${item.id}: held before any question: ${decisive.hold}`);
  let sent: SentBody[] = [];
  if (decisive.send.length > 0) {
    const bodies = await decisiveBodies(discoverer, decisive.send, fn, DECISIVE_LIMITS);
    if ("hold" in bodies) throw new Error(`${item.id}: ${bodies.hold}`);
    evidence.packet.evidence.related.push(...bodies.related);
    sent = bodies.sent;
  }
  return { fn, call, packet: evidence.packet, sent, calls: listed.calls.filter((c) => c.functionId === fn.id) };
}

// --- The arms -------------------------------------------------------------------------------------

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);

/** The function's question: arm 0 from src; arms 1 and 2 from the template, arm 2 with the values read. */
function functionQuestion(plan: Plan, arm: 0 | 1 | 2, fn: FunctionCandidate, call: CallCandidate, values: { expression: string; value: string }[]): Questions {
  if (arm === 0) return { in_forbidden_case: { type: "choice", instructions: fill(OLD_WORDING, { F: fn.name, X: named(call) }), criteria: REACH_CRITERIA } };
  const clause = arm === 2 ? values.map((v) => fill(plan.wording.value_clause, { C: v.expression, V: plan.wording.value_words[v.value]! })).join("") : "";
  return { in_forbidden_case: { type: "choice", instructions: fill(plan.wording.function, { F: fn.name, X: named(call), VALUES: clause }), criteria: REACH_CRITERIA } };
}

/**
 * Arm 0's words: src/plan/forms.ts at 8a0a82d, the commit version 1 was sent from, word for word.
 * Carried here so that the control stays the old question after src moves to the words adopted.
 */
const OLD_WORDING =
  "`code` is the body of `{F}`. The entries under `evidence.related` are other code it may call, given so that what those calls do can be worked out; they are not what this question is about. " +
  "Assume exactly this and nothing else: `{F}` is called in a case where `requirement.text` says the call `{X}` must not be made, because the check it asks for does not pass. " +
  "Under that condition: does `{F}` go on to make the call `{X}`?";

/** The three answers, the same words in every arm (src/plan/forms.ts REACH_CRITERIA at 8a0a82d and since). */
const REACH_CRITERIA = {
  reaches_it: "Yes. In that case the function still makes that call.",
  does_not_reach: "No. In that case the function returns, fails or takes another path before making that call.",
  cannot_determine: "The code shown does not settle whether that call is made in that case.",
} as const;

/** The check-value question, on the check's own body. */
function checkQuestion(plan: Plan, fn: FunctionCandidate, call: CallCandidate, check: { name: string; expression: string }): Questions {
  return { check_value: { type: "choice", instructions: fill(plan.wording.check, { CNAME: check.name, C: check.expression, F: fn.name, X: named(call) }), criteria: plan.wording.check_criteria } };
}

/** The first call of the check's name in the function, as the wired run will name it in the assumption. */
function expressionOf(calls: readonly CallCandidate[], name: string): string {
  const c = calls.find((x) => (x.callee.split("::").pop() ?? x.callee) === name);
  return c ? named(c) : `${name}(…)`;
}

// --- send -----------------------------------------------------------------------------------------

async function send(acceptance: string, constructed: string, limit: number) {
  const endpoint = endpointFromEnv(process.env);
  if (endpoint?.host !== "cloudflare") throw new Error("the log records Cloudflare's model: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, JEV_PROVIDER unset or cloudflare, no JEV_API_URL");
  const git = await Git.open(ROOT);
  const dirty = (await git.text(["status", "--porcelain", "--", ".", `:(exclude)${LOG.slice(ROOT.length + 1)}`])).trim();
  if (dirty !== "") throw new Error(`commit first; the working tree has changes besides the log:\n${dirty}`);
  const plan = readJson<Plan>(PLAN);
  const conditions = { tool: (await git.text(["rev-parse", "HEAD"])).trim(), plan: sha256(readFileSync(PLAN, "utf8")), model: jevModel("cloudflare"), bar: plan.bar, runs: plan.runs, limits: DECISIVE_LIMITS };
  const log: { conditions: typeof conditions; records: Record_[] } = existsSync(LOG) ? readJson(LOG) : { conditions, records: [] };
  if (JSON.stringify(log.conditions) !== JSON.stringify(conditions)) throw new Error(`the log was started under other conditions:\n${JSON.stringify(log.conditions)}\nnow:\n${JSON.stringify(conditions)}`);
  const client = new JevClient(endpoint, { deadline: Date.now() + 3 * 3600_000, maxRequests: limit, maxBytes: 256 * 1024 * 1024 });
  const provider = new JevProvider(client);
  const done = (id: string, run: number, arm: number) => log.records.some((r) => r.id === id && r.run === run && r.arm === arm && r.error === undefined);
  const keep = (record: Record_) => {
    log.records = log.records.filter((r) => !(r.id === record.id && r.run === record.run && r.arm === record.arm));
    log.records.push(record);
    writeJson(LOG, log);
  };

  for (const item of [...plan.targets, ...plan.outside]) {
    const requirement = requirementOf(item);
    const { fn, call, packet, sent, calls } = await packetOf(repoOf(acceptance, constructed, item.repo), item, requirement);
    const packetSha = sha256(JSON.stringify(packet));
    const checks = sent.filter((s) => s.depth === 1).map((s) => ({ name: s.name, expression: expressionOf(calls, s.name), related: packet.evidence.related.find((r) => r.path === s.path && r.lines === s.lines)! }));
    const second = sent.filter((s) => s.depth === 2).map((s) => packet.evidence.related.find((r) => r.path === s.path && r.lines === s.lines)!);
    for (let run = 1; run <= plan.runs; run++) {
      for (const arm of plan.send ?? ([0, 1, 2] as const)) {
        if (done(item.id, run, arm)) continue;
        const record: Record_ = { id: item.id, run, arm, packet: packetSha, sent: sent.map((s) => `${s.name}@${s.depth}`) };
        try {
          const values: { expression: string; value: string }[] = [];
          if (arm === 2) {
            record.checks = {};
            for (const check of checks) {
              const checkPacket = { requirement: packet.requirement, candidate: { path: check.related.path, lines: check.related.lines, symbol: check.name, changed_by_pull_request: false }, evidence: { code: check.related.code, related: second, truncated: packet.evidence.truncated } };
              const a = (await provider.judge(checkPacket, checkQuestion(plan, fn, call, check))).check_value;
              if (a) record.checks[check.name] = a;
              const read = a && a.probability >= plan.bar && (a.choice === "returns_true_or_ok" || a.choice === "returns_false_or_err") ? a.choice : null;
              if (read === null) {
                record.held = `the value of the check \`${check.name}\` could not be read (${a ? `${a.choice} ${a.probability.toFixed(2)}` : "no answer"})`;
                break;
              }
              values.push({ expression: check.expression, value: read });
            }
          }
          if (record.held === undefined) record.answer = (await provider.judge(packet, functionQuestion(plan, arm, fn, call, values))).in_forbidden_case;
        } catch (error) {
          record.error = error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : String(error);
        }
        keep(record);
        const a = record.answer;
        console.log(`${item.set} ${item.id} run ${run} arm ${arm}: ${record.error ?? record.held ?? `${a?.choice} ${a?.probability.toFixed(2)}`}${record.checks ? ` [${Object.entries(record.checks).map(([n, c]) => `${n}: ${c.choice} ${c.probability.toFixed(2)}`).join("; ")}]` : ""} (${client.sent.requests}/${limit})`);
      }
    }
  }
}

// --- score ----------------------------------------------------------------------------------------

const at = (a: ChoiceAnswer | undefined, choice: string, bar: number) => a !== undefined && a.choice === choice && a.probability >= bar;

export function score(plan: Plan, records: Record_[], bodies: Record<string, { params: string[]; body: string }[]> = {}): { lines: string[]; adopt: 0 | 1 | 2 | null } {
  const out: string[] = [];
  const bar = plan.bar;
  const of = (id: string, arm: number) => records.filter((r) => r.id === id && r.arm === arm && r.error === undefined);
  const results: Record<1 | 2, { values: boolean; hidden: boolean; defect: boolean; settled: boolean; outside: boolean }> = { 1: { values: true, hidden: true, defect: true, settled: true, outside: true }, 2: { values: true, hidden: true, defect: true, settled: true, outside: true } };

  for (const arm of plan.send ?? ([0, 1, 2] as const)) {
    out.push(`arm ${arm}:`);
    // The check values (arm 2 only).
    if (arm === 2) {
      for (const t of plan.targets) {
        for (const [name, want] of Object.entries(t.values)) {
          const rs = of(t.id, 2);
          const k = rs.filter((r) => at(r.checks?.[name], want, bar)).length;
          const ok = rs.length === plan.runs && k >= 2;
          if (!ok) results[2].values = false;
          out.push(`  ${ok ? "ok  " : "MISS"} value ${t.id} ${name}: ${k}/${rs.length} ${want} — ${rs.map((r) => `${r.checks?.[name]?.choice ?? "none"} ${r.checks?.[name]?.probability.toFixed(2) ?? ""}`).join("; ")}`);
        }
      }
    }
    for (const t of plan.targets) {
      const rs = of(t.id, arm);
      const reaches = rs.filter((r) => at(r.answer, "reaches_it", bar)).length;
      const holds = rs.filter((r) => at(r.answer, "does_not_reach", bar)).length;
      const held = rs.filter((r) => r.held !== undefined).length;
      let ok: boolean;
      if (t.set === "H") ok = rs.length === plan.runs && reaches >= 2 && holds === 0;
      else if (t.set === "D") ok = rs.length === plan.runs && reaches >= 2;
      else ok = rs.length === plan.runs && reaches === 0 && holds >= 2;
      if (arm !== 0 && !ok) results[arm][t.set === "H" ? "hidden" : t.set === "D" ? "defect" : "settled"] = false;
      out.push(`  ${ok ? "ok  " : "MISS"} ${t.set} ${t.id}: reaches ${reaches}, holds ${holds}, held ${held} of ${rs.length} — ${rs.map((r) => r.held ? "held" : `${r.answer?.choice ?? "none"} ${r.answer?.probability.toFixed(2) ?? ""}`).join("; ")}`);
    }
    // Outside: against arm 0's holds.
    if (arm !== 0) {
      let base = 0;
      let turned = 0;
      let unsettled = 0;
      for (const o of plan.outside) {
        for (const r0 of of(o.id, 0)) {
          if (!at(r0.answer, "does_not_reach", bar)) continue;
          base++;
          const r = of(o.id, arm).find((x) => x.run === r0.run);
          if (!r) {
            unsettled++;
            continue;
          }
          if (at(r.answer, "reaches_it", bar)) turned++;
          else if (r.held !== undefined || !at(r.answer, "does_not_reach", bar)) unsettled++;
        }
      }
      const ok = base >= 10 && turned === 0 && unsettled / Math.max(1, base) <= 0.3;
      if (!ok) results[arm].outside = false;
      out.push(`  ${ok ? "ok  " : "MISS"} outside: of ${base} runs arm 0 read as holding, ${turned} turned to reaches_it, ${unsettled} to cannot_determine/under the bar/held`);
    }
  }
  // The net, recorded: a check whose body reads none of its parameters.
  for (const [id, checks] of Object.entries(bodies)) {
    for (const c of checks) {
      const reads = c.params.some((p) => new RegExp(`(?<![\\w])${p.replace(/^&|^mut /g, "")}\\b`).test(c.body));
      out.push(`  net ${id}: ${reads ? "reads a parameter" : "reads none of its parameters"}`);
    }
  }
  const arms = plan.send ?? [0, 1, 2];
  const r2 = results[2];
  const r1 = results[1];
  if (plan.targets.length === 0) {
    // A later version that re-measures the outside line alone: the target lines are version 1's.
    const passing = ([2, 1] as const).filter((a) => arms.includes(a) && results[a].outside);
    out.push(`outside line: ${passing.length > 0 ? `PASS for arm ${passing.join(" and ")}` : "FAIL for every arm sent"}; the target lines are the earlier version's`);
    return { lines: out, adopt: passing[0] ?? null };
  }
  const adopt: 0 | 1 | 2 | null = r2.values && r2.hidden && r2.defect && r2.settled && r2.outside ? 2 : r1.hidden && r1.defect && r1.settled && r1.outside ? 1 : null;
  out.push(adopt === 2 ? "ADOPT arm 2 (two-step)" : adopt === 1 ? "ADOPT arm 1 (case only): arm 2 failed a line" : "ADOPT nothing: both arms failed a line; back to the owner");
  return { lines: out, adopt };
}

const [mode, acceptance, constructed, limit] = process.argv.slice(2);
// score: `score [<acceptance dir> <constructed repo>] [<plan> <log>]` — the plan and log are argv[5] and argv[6] above.
if (mode === "send" && acceptance && constructed && limit) await send(acceptance, constructed, Number(limit));
else if (mode === "score") {
  const plan = readJson<Plan>(PLAN);
  const log = readJson<{ records: Record_[] }>(LOG);
  const bodies: Record<string, { params: string[]; body: string }[]> = {};
  if (acceptance && constructed) {
    for (const t of plan.targets) {
      const { packet, sent } = await packetOf(repoOf(acceptance, constructed, t.repo), t, requirementOf(t));
      bodies[t.id] = sent.filter((s) => s.depth === 1).map((s) => {
        const code = packet.evidence.related.find((r) => r.path === s.path && r.lines === s.lines)!.code;
        const sig = /\(([^)]*)\)/.exec(code)?.[1] ?? "";
        const params = sig.split(",").map((p) => p.trim().split(":")[0]!.trim()).filter((p) => p !== "" && p !== "&self" && p !== "self" && p !== "&mut self" && !p.startsWith("_"));
        return { params, body: code.slice(code.indexOf("{") + 1) };
      });
    }
  }
  for (const line of score(plan, log.records, bodies).lines) console.log(line);
} else if (mode !== undefined) {
  console.error("usage: probe-words.ts send <acceptance dir> <constructed repo> <limit> [<plan> <log>] | score [<acceptance dir> <constructed repo>] [<plan> <log>]");
  process.exitCode = 2;
}
