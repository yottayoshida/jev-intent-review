// The probe of `failure_handling`'s observation question (#85), before the form is wired: each
// version of an acceptance case's target — and a defect version with a line added that logs the
// failure (reported), a line that logs something else (decoy), or the log taken away (silent) — asked
// what the function does with the call's failure. The question is src's (`handlingQuestionsFor`), the
// packet is the wired run's (`buildEvidence` with the local check's limits). What is sent, the expected
// answers and the lines are in probe.json, committed before any request.
//
//   node bench/handling/probe.ts send  <clones dir> <limit>
//   node bench/handling/probe.ts score
//   node bench/handling/probe.ts check <clones dir>          builds every packet; sends nothing
//
// `<clones dir>` holds `grovedb-500` and `moltis-1064` with the acceptance refs built. A patched version
// is built as a commit with a fixed author and date, so the same patch gives the same commit.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/config/config.ts";
import { pathFilter } from "../../src/config/glob.ts";
import { Discoverer } from "../../src/discovery/discover.ts";
import { buildEvidence } from "../../src/evidence/builder.ts";
import { redact } from "../../src/evidence/redact.ts";
import { endpointFromEnv, JevClient, jevModel } from "../../src/judgments/client.ts";
import { JevProvider } from "../../src/judgments/jev.ts";
import { functionDefinitionsOf } from "../../src/plan/applicability.ts";
import { enumerate } from "../../src/plan/candidates.ts";
import { FORMS } from "../../src/plan/forms.ts";
import { HANDLING_KEY, handlingQuestionsFor } from "../../src/plan/handling.ts";
import { conditionFor } from "../../src/plan/local-check.ts";
import { Git } from "../../src/repository/git.ts";
import { DEFAULT_LOCAL_CHECK } from "../../src/review/local-check-run.ts";
import type { ChoiceAnswer, Requirement } from "../../src/types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const PLAN = join(HERE, "probe.json");
const LOG = join(ROOT, "bench", "logs", "handling-probe-v1.json");

export interface Target {
  id: string;
  repo: string;
  ref: string;
  patch?: string;
  file: string;
  function: string;
  call: string;
  expected: string;
}
export interface Plan {
  bar: number;
  runs: number;
  targets: Target[];
}
export interface Record_ {
  id: string;
  run: number;
  commit: string;
  packet: string;
  answer?: ChoiceAnswer;
  error?: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const FIXED = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid", GIT_AUTHOR_DATE: "2026-09-25T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-25T00:00:00Z" };
const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...FIXED } }).trim();

/** The version's commit: the ref, or the ref with the target's patch on it, kept under refs/bench/handling. */
function commitOf(repo: string, t: Target): string {
  const from = git(repo, ["rev-parse", t.ref]);
  if (!t.patch) return from;
  const box = join(homedir(), ".cctmp");
  mkdirSync(box, { recursive: true });
  const work = mkdtempSync(join(box, "handling-probe-"));
  git(repo, ["worktree", "add", "-q", "--detach", work, from]);
  try {
    git(work, ["apply", join(HERE, t.patch)]);
    git(work, ["commit", "-q", "-am", `handling probe: ${t.id}`]);
    const head = git(work, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", `refs/bench/handling/${t.id}`, head]);
    return head;
  } finally {
    git(repo, ["worktree", "remove", "--force", work]);
  }
}

/** The requirement the packet carries. The observation question does not read it; the packet does. */
const REQUIREMENT: Requirement = {
  id: "R1",
  text: "When an operation fails, the failure may be returned, logged or recorded, and must not be turned silently into a success.",
  kind: "behavior",
  priority: "required",
  sourceRefs: [],
  searchHints: [],
};

async function packetOf(repo: string, commit: string, t: Target) {
  const g = await Git.open(repo);
  const source = await g.readText(commit, t.file);
  if (source === null) throw new Error(`${t.id}: ${t.file} is not at ${commit.slice(0, 7)}`);
  const listed = enumerate(t.file, source);
  const hits = listed.calls.filter((c) => listed.functions.find((f) => f.id === c.functionId)?.name === t.function && redact(c.expression).text === t.call);
  if (hits.length !== 1) throw new Error(`${t.id}: ${hits.length} calls \`${t.call}\` in ${t.function}`);
  const call = hits[0]!;
  const fn = listed.functions.find((f) => f.id === call.functionId)!;
  const cfg = defaultConfig();
  const discoverer = new Discoverer(g, commit, { include: pathFilter(cfg.repository.include, cfg.repository.ignore), lexicalSearch: true, referenceSearch: true });
  const evidence = await buildEvidence(discoverer, REQUIREMENT, { path: fn.path, startLine: fn.startLine, endLine: fn.endLine, symbol: fn.name, changed: true, reasons: [] }, { maxPrimaryChars: DEFAULT_LOCAL_CHECK.maxPrimaryChars, maxRelatedChars: DEFAULT_LOCAL_CHECK.maxRelatedChars });
  if (evidence.cut.own) throw new Error(`${t.id}: the body did not fit`);
  const defined = async (name: string) => {
    const { found, more } = await functionDefinitionsOf(discoverer, name);
    return found.length > 0 || more;
  };
  // The form holds what `failure_propagation` holds (plan: ADR 0019 unchanged for this form).
  const decisive = await FORMS.failure_propagation.decisive({ requirement: REQUIREMENT, fn, call, body: evidence.packet.evidence.code, calls: listed.calls.filter((c) => c.functionId === fn.id), defined });
  if ("hold" in decisive) throw new Error(`${t.id}: held before any question: ${decisive.hold}`);
  return { fn, call, packet: evidence.packet };
}

/** The question sent, on a fixed place: the wired form's observation question must hash the same (test/handling.test.ts). */
export function questionHash(questions: unknown = handlingQuestionsFor(conditionFor({ name: "f" } as never, { expression: "g(x)" } as never))): string {
  return sha256(JSON.stringify(questions));
}

/** A fixed shuffle per run, so the order is the same on a rerun and differs between runs. */
function order<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed * 2654435761;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function check(clones: string) {
  for (const t of readJson<Plan>(PLAN).targets) {
    const repo = join(clones, t.repo);
    const commit = commitOf(repo, t);
    const { packet } = await packetOf(repo, commit, t);
    console.log(`${t.id.padEnd(20)} ${commit.slice(0, 8)} packet ${JSON.stringify(packet).length} chars`);
  }
}

async function send(clones: string, limit: number) {
  const endpoint = endpointFromEnv(process.env);
  if (endpoint?.host !== "cloudflare") throw new Error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, JEV_PROVIDER unset or cloudflare, no JEV_API_URL");
  const self = await Git.open(ROOT);
  const dirty = (await self.text(["status", "--porcelain", "--", ".", `:(exclude)${LOG.slice(ROOT.length + 1)}`])).trim();
  if (dirty !== "") throw new Error(`commit first; the working tree has changes besides the log:\n${dirty}`);
  const plan = readJson<Plan>(PLAN);
  const conditions = { tool: (await self.text(["rev-parse", "HEAD"])).trim(), plan: sha256(readFileSync(PLAN, "utf8")), model: jevModel("cloudflare"), bar: plan.bar, runs: plan.runs, question: questionHash() };
  const log: { conditions: typeof conditions; records: Record_[] } = existsSync(LOG) ? readJson(LOG) : { conditions, records: [] };
  if (JSON.stringify(log.conditions) !== JSON.stringify(conditions)) throw new Error(`the log was started under other conditions:\n${JSON.stringify(log.conditions)}\nnow:\n${JSON.stringify(conditions)}`);
  const provider = new JevProvider(new JevClient(endpoint, { deadline: Date.now() + 3 * 3600_000, maxRequests: limit, maxBytes: 256 * 1024 * 1024 }));

  const built = new Map<string, { commit: string; packet: unknown; questions: ReturnType<typeof handlingQuestionsFor>; state: unknown }>();
  for (const t of plan.targets) {
    const repo = join(clones, t.repo);
    const commit = commitOf(repo, t);
    const { fn, call, packet } = await packetOf(repo, commit, t);
    built.set(t.id, { commit, packet, questions: handlingQuestionsFor(conditionFor(fn, call)), state: packet });
  }
  for (let run = 1; run <= plan.runs; run++) {
    for (const t of order(plan.targets, run)) {
      if (log.records.some((r) => r.id === t.id && r.run === run && r.error === undefined)) continue;
      const b = built.get(t.id)!;
      const record: Record_ = { id: t.id, run, commit: b.commit, packet: sha256(JSON.stringify(b.packet)) };
      try {
        const answers = await provider.judge(b.state, b.questions);
        record.answer = answers[HANDLING_KEY];
      } catch (error) {
        record.error = (error as Error).message.slice(0, 300);
      }
      log.records = log.records.filter((r) => !(r.id === t.id && r.run === run));
      log.records.push(record);
      writeJson(LOG, log);
      console.log(`run ${run} ${t.id}: ${record.answer ? `${record.answer.choice} ${record.answer.probability.toFixed(2)}` : record.error}`);
    }
  }
  console.log(score(plan, log.records).join("\n"));
}

/** The lines of probe.json, read against the records. */
export function score(plan: Plan, records: readonly Record_[]): string[] {
  const out: string[] = [];
  let pairs = true;
  let noFalse = true;
  for (const t of plan.targets) {
    const rs = records.filter((r) => r.id === t.id).sort((a, b) => a.run - b.run);
    const seen = rs.map((r) => (r.answer ? `${r.answer.choice} ${r.answer.probability.toFixed(2)}` : `error`));
    const control = /-(shipped|rewrite)$/.test(t.id);
    const good = rs.filter((r) => r.answer && r.answer.choice === t.expected && r.answer.probability >= plan.bar).length;
    if (control) {
      if (rs.some((r) => r.answer?.choice === "continues_silently")) noFalse = false;
    } else if (good !== plan.runs || rs.length !== plan.runs) pairs = false;
    out.push(`${t.id.padEnd(20)} expected ${t.expected.padEnd(18)} ${good}/${plan.runs}  ${seen.join(", ")}`);
  }
  out.push(`pairs: ${pairs ? "PASS" : "FAIL"} — every non-control version gets its expected answer at the bar in ${plan.runs} of ${plan.runs}`);
  out.push(`no false listing: ${noFalse ? "PASS" : "FAIL"} — no shipped or rewrite version answered continues_silently`);
  return out;
}

const [mode, clones, n] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (mode === "send" && clones) await send(clones, Number(n ?? 60));
  else if (mode === "check" && clones) await check(clones);
  else if (mode === "score") console.log(score(readJson<Plan>(PLAN), readJson<{ records: Record_[] }>(LOG).records).join("\n"));
  else throw new Error("usage: node bench/handling/probe.ts send <clones dir> [limit] | score");
}
