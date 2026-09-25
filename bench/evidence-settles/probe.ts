// Whether Jev can tell that an answer turns on code that was not sent (#82, ADR 0018), measured on the
// target calls alone before anything is wired.
//
//   node bench/evidence-settles/probe.ts plan  <acceptance dir> <constructed repo>          sends nothing; writes plan.json
//   node bench/evidence-settles/probe.ts send  <acceptance dir> <constructed repo> <limit>  requests; appends to the log
//   node bench/evidence-settles/probe.ts score                                               reads plan.json and the log
//
// `<acceptance dir>` holds the clones `grovedb` and `moltis` (as for bench/acceptance/run.ts and
// bench/forms/real.ts, whose refs under refs/bench/check-before-action/ it reads); `<constructed repo>`
// is a repository bench/forms/run.ts built, whose commits are fixed by its author and date.
//
// Each item is one call: its packet is built by `buildEvidence` with the local check's own limits,
// and one request carries the form's observation questions and `evidence_settles`, as the wired run
// will send them. The failure form's hidden versions are also asked `evidence_settles` alone, to see
// whether the observation's "every other operation succeeds" in the same request moves it. The sets,
// the rule choosing the controls and the lines are written to plan.json by `plan`, which is committed
// before `send` runs; `send` refuses a working tree with changes besides its log.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/config/config.ts";
import { pathFilter } from "../../src/config/glob.ts";
import { Discoverer } from "../../src/discovery/discover.ts";
import { buildEvidence } from "../../src/evidence/builder.ts";
import { redact } from "../../src/evidence/redact.ts";
import { parseIntentSpec } from "../../src/intent/schema.ts";
import { endpointFromEnv, JevClient, jevModel } from "../../src/judgments/client.ts";
import { JevProvider } from "../../src/judgments/jev.ts";
import { QUESTIONS_HASH } from "../../src/judgments/questions.ts";
import { enumerate } from "../../src/plan/candidates.ts";
import { FORMS, type Form } from "../../src/plan/forms.ts";
import { EVIDENCE_KEY, evidenceQuestion, NOT_SENT } from "./question.ts";
import { Git } from "../../src/repository/git.ts";
import { DEFAULT_LOCAL_CHECK } from "../../src/review/local-check-run.ts";
import type { ChoiceAnswer, Candidate } from "../../src/types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const PLAN = join(HERE, "plan.json");
const LOG = join(ROOT, "bench", "logs", "evidence-settles-probe-v1.json");
const RUNS = 3;
const BAR = 0.6;

type Set_ = "H" | "S" | "W";
interface Item {
  set: Set_;
  id: string;
  /** Which clone: a key of `<acceptance dir>`, or `constructed`. */
  repo: string;
  head: string;
  file: string;
  function: string;
  call: string;
  spec: string; // relative to the repository root
  requirementId: string;
  /** S only: the observation answer the earlier measurement gave in most of its runs. */
  earlier?: string;
  /** Asked `evidence_settles` alone as well (the failure form's hidden versions). */
  alone?: boolean;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const repoOf = (acceptance: string, constructed: string, item: Pick<Item, "repo">) => (item.repo === "constructed" ? constructed : join(acceptance, item.repo));
const majority = (xs: string[]) => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * The rule choosing the controls W, fixed before any request: after the call's closing parenthesis,
 * across whitespace, line breaks and `.await`, the next thing is `?` or one of these combinators.
 * Each keeps a failure a failure whatever the function it wraps does, so what was sent settles it.
 */
export const WRAP = /^(?:\s|\.await\b)*(\?|\.map_err\(|\.context\(|\.with_context\(|\.ok_or\(|\.ok_or_else\()/;

/**
 * The rule written without Jev, scored beside it and never gating: the answer turns on code not sent
 * when the call is an argument of another call (`step_outcome(x)?`). `Ok(`, `Some(` and `Err(` are
 * the language's own.
 */
export function wrappedByACall(body: string, call: string): boolean {
  const i = body.indexOf(call);
  if (i < 0) return false;
  const before = body.slice(0, i).replace(/\s+$/, "");
  const m = /([A-Za-z_][\w:]*)\s*\($/.exec(before);
  return m !== null && !["Ok", "Some", "Err"].includes(m[1]!.split("::").pop()!);
}

async function locate(repo: string, item: Item) {
  const g = await Git.open(repo);
  const source = await g.readText(item.head, item.file);
  if (source === null) throw new Error(`${item.id}: ${item.file} is not at ${item.head.slice(0, 7)}`);
  const listed = enumerate(item.file, source);
  const hits = listed.calls.filter((c) => listed.functions.find((f) => f.id === c.functionId)?.name === item.function && redact(c.expression).text === item.call);
  if (hits.length !== 1) throw new Error(`${item.id}: ${hits.length} calls \`${item.call}\` in ${item.function}`);
  const call = hits[0]!;
  const fn = listed.functions.find((f) => f.id === call.functionId)!;
  const cfg = defaultConfig();
  const discoverer = new Discoverer(g, item.head, { include: pathFilter(cfg.repository.include, cfg.repository.ignore), lexicalSearch: true, referenceSearch: true });
  return { fn, call, discoverer, body: source.split("\n").slice(fn.startLine - 1, fn.endLine).join("\n") };
}

// --- plan -----------------------------------------------------------------------------------------

type AcceptanceRun = { requirements: { observed: { file: string; function: string; call: string; outcome: string; result: { observation: string } }[] }[] };
type AcceptanceLog = { cases: Record<string, { versions: Record<string, { head: string; runs: AcceptanceRun[] }> }> };
type FormsRun = { observed: { key: string; observation: string }[] };

function plan(acceptance: string, constructed: string) {
  const items: Item[] = [];
  const v4 = readJson<AcceptanceLog>(join(ROOT, "bench/logs/acceptance-v4.json"));
  const acc = (id: string) => readJson<{ versions: Record<string, { head: string; targets: Record<string, { requirementId: string; file: string; function: string; call: string }> }> }>(join(ROOT, "bench/acceptance/cases", id, "case.json"));
  const earlierV4 = (id: string, v: string, fn: string, call: string) =>
    majority(v4.cases[id]!.versions[v]!.runs.flatMap((r) => r.requirements[0]!.observed.filter((o) => o.function === fn && o.call === call).map((o) => o.result.observation)));

  // The failure form: the acceptance set's cases, every target inside the budget in v4.
  for (const id of ["grovedb-500", "moltis-1064"]) {
    const c = acc(id);
    const repo = id.split("-")[0]!;
    for (const [v, version] of Object.entries(c.versions)) {
      for (const t of Object.values(version.targets)) {
        const earlier = v4.cases[id]!.versions[v] ? earlierV4(id, v, t.function, t.call) : undefined;
        if (earlier === undefined) continue; // not asked in v4 (defect-C: not enumerated)
        const base = { id: `${id} ${v} ${t.function}`, repo, head: version.head, file: t.file, function: t.function, call: t.call, spec: `bench/acceptance/cases/${id}/spec.json`, requirementId: t.requirementId };
        items.push(v.startsWith("hidden") ? { set: "H", ...base, alone: true } : { set: "S", ...base, earlier });
      }
    }
  }
  // check_before_action on the same pull requests' code (bench/forms/real/).
  const FILES: Record<string, string> = { "grovedb-500": "merk/src/merk/restore.rs", "moltis-1064": "crates/gateway/src/session/title.rs" };
  const real = readJson<{ cases: Record<string, Record<string, { head: string; runs: FormsRun[] }>> }>(join(ROOT, "bench/logs/check-before-action-real-v2.json"));
  for (const id of ["grovedb-500", "moltis-1064"]) {
    const dir = join(ROOT, "bench/forms/real", id);
    const c = readJson<{ clone: string; spec: string; target: { function: string; call: string } }>(join(dir, "case.json"));
    const spec = resolve(dir, c.spec).slice(ROOT.length + 1);
    const requirementId = parseIntentSpec(readFileSync(resolve(dir, c.spec), "utf8"), spec).requirements[0]!.id;
    for (const v of ["shipped", "defect", "rewrite", "hidden"]) {
      const head = git(join(acceptance, c.clone), ["rev-parse", `refs/bench/check-before-action/${id}/${v}/head`]);
      if (real.cases[id]![v]!.head !== head) throw new Error(`${id} ${v}: refs/bench says ${head.slice(0, 7)}, the v2 log ${real.cases[id]![v]!.head.slice(0, 7)}`);
      const key = `${c.target.function} · ${c.target.call}`;
      const earlier = majority(real.cases[id]![v]!.runs.flatMap((r) => r.observed.filter((o) => o.key === key).map((o) => o.observation.split(" ")[0]!)));
      const base = { id: `cba ${id} ${v}`, repo: c.clone, head, file: FILES[id]!, function: c.target.function, call: c.target.call, spec, requirementId };
      items.push(v === "hidden" ? { set: "H", ...base } : { set: "S", ...base, earlier });
    }
  }
  // The constructed case (bench/forms/check-before-action/), its commits as its log recorded them.
  const v1 = readJson<{ versions: Record<string, { head: string; runs: FormsRun[] }> }>(join(ROOT, "bench/logs/check-before-action-v1.json"));
  for (const v of ["shipped", "defect", "rewrite", "hidden"]) {
    const head = v1.versions[v]!.head;
    if (git(constructed, ["rev-parse", v]) !== head) throw new Error(`the constructed repository's ${v} is not the v1 log's ${head.slice(0, 7)}`);
    const key = "open_session · create_session(store, &record)";
    const earlier = majority(v1.versions[v]!.runs.flatMap((r) => r.observed.filter((o) => o.key === key).map((o) => o.observation.split(" ")[0]!)));
    const base = { id: `constructed ${v}`, repo: "constructed", head, file: "src/auth.rs", function: "open_session", call: "create_session(store, &record)", spec: "bench/forms/check-before-action/spec.json", requirementId: "R1" };
    items.push(v === "hidden" ? { set: "H", ...base } : { set: "S", ...base, earlier });
  }
  // W: every call v4 read in the shipped and rewrite versions, other than a target, that WRAP matches
  // in its function's body at that version's head.
  const targets = new Set(items.map((i) => `${i.repo}\u0000${i.file}\u0000${i.function}\u0000${i.call}`));
  const seen = new Set<string>();
  for (const id of ["grovedb-500", "moltis-1064"]) {
    const repo = id.split("-")[0]!;
    for (const v of ["shipped", "rewrite-A"]) {
      const version = v4.cases[id]!.versions[v]!;
      for (const run of version.runs) {
        for (const o of run.requirements[0]!.observed) {
          const k = `${repo}\u0000${o.file}\u0000${o.function}\u0000${o.call}`;
          if (targets.has(k) || seen.has(k)) continue;
          seen.add(k);
          const source = git(join(acceptance, repo), ["show", `${version.head}:${o.file}`]);
          const listed = enumerate(o.file, source);
          const fns = listed.functions.filter((f) => f.name === o.function);
          const bodies = fns.map((f) => source.split("\n").slice(f.startLine - 1, f.endLine).join("\n")).filter((b) => b.split(o.call).length === 2);
          if (bodies.length !== 1) continue;
          const after = bodies[0]!.slice(bodies[0]!.indexOf(o.call) + o.call.length);
          if (!WRAP.test(after)) continue;
          items.push({ set: "W", id: `${id} ${v} ${o.function} · ${o.call}`, repo, head: version.head, file: o.file, function: o.function, call: o.call, spec: `bench/acceptance/cases/${id}/spec.json`, requirementId: "R1" });
        }
      }
    }
  }
  const w = items.filter((i) => i.set === "W").length;
  const doc = {
    about: "#82 probe (ADR 0017), fixed before any request. H: the answer turns on a body that was not sent. S: the targets whose answer the code sent settles. W: calls chosen by WRAP (probe.ts), never by their answers.",
    lines: {
      check1: "H: turns_on_code_not_sent at or above 0.6 in at least 13 of 15 runs, and in at least 2 of 3 runs of every H item",
      check2: "S: turns_on_code_not_sent at or above 0.6 in none of the runs, and the observation on the same side as `earlier` in every run; W: turns_on_code_not_sent under 0.6 in at least 90% of runs",
      wFloor: "at least 4 distinct W calls, or nothing is sent",
      recordedNotGated: ["the rule wrappedByACall, scored on the same sets", "the stricter rule (settled_by_code_sent at or above 0.6 required)", "H items asked evidence_settles alone beside the shared request"],
    },
    wRule: WRAP.source,
    items,
  };
  if (w < 4) throw new Error(`W has ${w} calls, under the floor of 4: nothing is written or sent`);
  writeJson(PLAN, doc);
  console.log(`H ${items.filter((i) => i.set === "H").length}, S ${items.filter((i) => i.set === "S").length}, W ${w}; written ${PLAN}`);
}

// --- send -----------------------------------------------------------------------------------------

type Answers = Record<string, ChoiceAnswer>;
interface Record_ {
  id: string;
  run: number;
  shared?: Answers;
  alone?: Answers;
  error?: string;
}

async function send(acceptance: string, constructed: string, limit: number) {
  const endpoint = endpointFromEnv(process.env);
  if (endpoint?.host !== "cloudflare") throw new Error("the log records Cloudflare's model: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, with no JEV_PROVIDER other than cloudflare and no JEV_API_URL");
  const dirty = git(ROOT, ["status", "--porcelain", "--", ".", ":(exclude)bench/logs/evidence-settles-probe-v1.json"]);
  if (dirty !== "") throw new Error(`commit first; the working tree has changes besides the log:\n${dirty}`);
  const p = readJson<{ items: Item[] }>(PLAN);
  const conditions = { tool: git(ROOT, ["rev-parse", "HEAD"]), plan: sha256(readFileSync(PLAN, "utf8")), questionsHash: QUESTIONS_HASH, model: jevModel("cloudflare"), limits: { maxPrimaryChars: DEFAULT_LOCAL_CHECK.maxPrimaryChars, maxRelatedChars: DEFAULT_LOCAL_CHECK.maxRelatedChars }, runs: RUNS };
  const log: { conditions: typeof conditions; records: Record_[] } = existsSync(LOG) ? readJson(LOG) : { conditions, records: [] };
  if (JSON.stringify(log.conditions) !== JSON.stringify(conditions)) throw new Error(`the log was started under other conditions:\n${JSON.stringify(log.conditions)}\nnow:\n${JSON.stringify(conditions)}`);
  const client = new JevClient(endpoint, { deadline: Date.now() + 3600_000, maxRequests: limit, maxBytes: 64 * 1024 * 1024 });
  const provider = new JevProvider(client);
  for (const item of p.items) {
    const spec = parseIntentSpec(readFileSync(join(ROOT, item.spec), "utf8"), item.spec);
    const requirement = spec.requirements.find((r) => r.id === item.requirementId)!;
    const form: Form = FORMS[requirement.form ?? "failure_propagation"];
    const { fn, call, discoverer } = await locate(repoOf(acceptance, constructed, item), item);
    const candidate: Candidate = { path: fn.path, startLine: fn.startLine, endLine: fn.endLine, symbol: fn.name, changed: true, reasons: [`a call in ${fn.name}`] };
    const evidence = await buildEvidence(discoverer, requirement, candidate, { maxPrimaryChars: DEFAULT_LOCAL_CHECK.maxPrimaryChars, maxRelatedChars: DEFAULT_LOCAL_CHECK.maxRelatedChars });
    if (evidence.cut.own) throw new Error(`${item.id}: the body did not fit`);
    for (let run = 1; run <= RUNS; run++) {
      if (log.records.some((r) => r.id === item.id && r.run === run && r.error === undefined)) continue;
      const record: Record_ = { id: item.id, run };
      try {
        record.shared = await provider.judge(evidence.packet, { ...form.observationQuestions(fn, call), ...evidenceQuestion(form.name, fn, call) });
        if (item.alone) record.alone = await provider.judge(evidence.packet, evidenceQuestion(form.name, fn, call));
      } catch (error) {
        record.error = error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : String(error);
      }
      log.records = log.records.filter((r) => !(r.id === item.id && r.run === run));
      log.records.push(record);
      writeJson(LOG, log);
      const e = record.shared?.[EVIDENCE_KEY];
      console.log(`${item.set} ${item.id} run ${run}: ${record.error ?? `${form.observationKey} ${record.shared?.[form.observationKey]?.choice} · ${EVIDENCE_KEY} ${e?.choice} ${e?.probability.toFixed(2)}`} (${client.sent.requests}/${limit})`);
    }
  }
}

// --- score ----------------------------------------------------------------------------------------

const turns = (a: ChoiceAnswer | undefined) => a !== undefined && a.choice === NOT_SENT && a.probability >= BAR;

export function score(items: Item[], records: Record_[], bodies: Record<string, string> = {}): string[] {
  const out: string[] = [];
  const of = (item: Item) => records.filter((r) => r.id === item.id && r.shared !== undefined);
  const H = items.filter((i) => i.set === "H");
  const S = items.filter((i) => i.set === "S");
  const W = items.filter((i) => i.set === "W");
  const sideOf = (item: Item, choice: string | undefined) => {
    const form = FORMS[item.id.startsWith("cba") || item.id.startsWith("constructed") ? "check_before_action" : "failure_propagation"];
    return choice === undefined ? "none" : form.violates.includes(choice) ? "violates" : form.keeps.includes(choice) ? "keeps" : "neither";
  };
  const keyOf = (item: Item) => FORMS[item.id.startsWith("cba") || item.id.startsWith("constructed") ? "check_before_action" : "failure_propagation"].observationKey;

  let hTurns = 0;
  let hRuns = 0;
  let everyH = true;
  for (const item of H) {
    const rs = of(item);
    const k = rs.filter((r) => turns(r.shared![EVIDENCE_KEY])).length;
    hTurns += k;
    hRuns += rs.length;
    if (rs.length < RUNS || k < 2) everyH = false;
    out.push(`  H ${item.id}: ${k}/${rs.length} turns_on_code_not_sent — ${rs.map((r) => `${r.shared![EVIDENCE_KEY]?.choice} ${r.shared![EVIDENCE_KEY]?.probability.toFixed(2)}`).join("; ")}${item.alone ? ` | alone: ${rs.map((r) => `${r.alone?.[EVIDENCE_KEY]?.choice} ${r.alone?.[EVIDENCE_KEY]?.probability.toFixed(2)}`).join("; ")}` : ""}`);
  }
  const check1 = hRuns === H.length * RUNS && hTurns >= 13 && everyH;
  out.unshift(`check 1 (H): ${hTurns}/${hRuns} ${check1 ? "PASS" : "FAIL"}`);

  let sBlocked = 0;
  let sMoved = 0;
  let sRuns = 0;
  const sLines: string[] = [];
  for (const item of S) {
    for (const r of of(item)) {
      sRuns += 1;
      const e = r.shared![EVIDENCE_KEY];
      const o = r.shared![keyOf(item)];
      const blocked = turns(e);
      const moved = sideOf(item, o?.choice) !== sideOf(item, item.earlier);
      if (blocked) sBlocked += 1;
      if (moved) sMoved += 1;
      if (blocked || moved) sLines.push(`  S ${item.id} run ${r.run}: ${blocked ? `stopped (${e!.probability.toFixed(2)})` : ""}${moved ? ` observation ${o?.choice} where earlier ${item.earlier}` : ""}`);
    }
  }
  let wStopped = 0;
  let wRuns = 0;
  for (const item of W) for (const r of of(item)) {
    wRuns += 1;
    if (turns(r.shared![EVIDENCE_KEY])) wStopped += 1;
  }
  const wOk = wRuns > 0 && (wRuns - wStopped) / wRuns >= 0.9;
  const check2 = sRuns === S.length * RUNS && sBlocked === 0 && sMoved === 0 && wOk;
  out.push(`check 2 (S): ${sRuns - sBlocked}/${sRuns} not stopped, ${sRuns - sMoved}/${sRuns} same side; (W): ${wRuns - wStopped}/${wRuns} not stopped — ${check2 ? "PASS" : "FAIL"}`, ...sLines);

  // Recorded, not gating.
  const stricter = (set: Item[]) => set.reduce((n, item) => n + of(item).filter((r) => !(r.shared![EVIDENCE_KEY]?.choice === "settled_by_code_sent" && r.shared![EVIDENCE_KEY]!.probability >= BAR)).length, 0);
  out.push(`recorded: the stricter rule would not settle ${stricter(H)} of H's runs, ${stricter(S)} of S's, ${stricter(W)} of W's`);
  const control = (set: Item[]) => set.reduce((n, item) => n + of(item).filter((r) => r.shared![`on_error_control`] !== undefined).length, 0);
  out.push(`recorded: on_error_control answered in ${control([...H, ...S, ...W])} runs of the failure form`);
  if (Object.keys(bodies).length > 0) {
    const rule = (set: Item[]) => set.filter((i) => bodies[i.id] !== undefined && wrappedByACall(bodies[i.id]!, i.call)).length;
    out.push(`recorded: wrappedByACall says "turns on" for ${rule(H)}/${H.length} of H, ${rule(S)}/${S.length} of S, ${rule(W)}/${W.length} of W`);
  }
  out.push(check1 && check2 ? "PASS: wire it (plan step 3)" : "FAIL: do not wire; back to the owner");
  return out;
}

const [mode, acceptance, constructed, limit] = process.argv.slice(2);
if (mode === "plan" && acceptance && constructed) plan(acceptance, constructed);
else if (mode === "send" && acceptance && constructed && limit) await send(acceptance, constructed, Number(limit));
else if (mode === "score") {
  const p = readJson<{ items: Item[] }>(PLAN);
  const log = readJson<{ records: Record_[] }>(LOG);
  const bodies: Record<string, string> = {};
  if (acceptance && constructed) for (const item of p.items) bodies[item.id] = (await locate(repoOf(acceptance, constructed, item), item)).body;
  for (const line of score(p.items, log.records, bodies)) console.log(line);
} else if (mode !== undefined) {
  console.error("usage: probe.ts plan <acceptance dir> <constructed repo> | send <acceptance dir> <constructed repo> <limit> | score [<acceptance dir> <constructed repo>]");
  process.exitCode = 2;
}
