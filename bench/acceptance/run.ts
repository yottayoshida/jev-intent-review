// Running the acceptance set: the enumeration of every branch, then three runs of each branch whose
// targets are inside the budget.
//
//   node bench/acceptance/run.ts precheck <case> <clone>          no request; writes case.json
//   node bench/acceptance/run.ts estimate                          no request; the planned total
//   node bench/acceptance/run.ts measure  <case> <clone> <limit> <sibling|again>
//                                                                  requests; appends to the log named
//
// It drives the built command (`dist/cli/main.js`, run `npm run build` first) through `main`, the
// same entry the installed binary uses, so the arguments, the configuration and the exit code are
// the ones a user gets. It does not spawn the binary because the binary's JSON holds neither the
// requests sent nor anything from a run that stopped: `main` takes its judges through `deps.judges`,
// and the ones built here are the default ones (src/cli/main.ts, `defaultJudges`), copied, with the
// provider wrapped so each packet and each answer is recorded as it happens.
//
// `dist/` is not in the repository and CI type-checks bench/ without building, so every value from
// it is imported at run time and only types come from src/. No test imports this file.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Main from "../../src/cli/main.ts";
import type * as Client from "../../src/judgments/client.ts";
import type * as Jev from "../../src/judgments/jev.ts";
import type * as Provider from "../../src/judgments/provider.ts";
import type * as Candidates from "../../src/plan/candidates.ts";
import type * as Applicability from "../../src/plan/applicability.ts";
import type * as Discover from "../../src/discovery/discover.ts";
import type * as GitModule from "../../src/repository/git.ts";
import type * as Config from "../../src/config/config.ts";
import type * as Glob from "../../src/config/glob.ts";
import type * as Redact from "../../src/evidence/redact.ts";
import type * as LocalCheck from "../../src/review/local-check-run.ts";
import { cutShort, isLive, keepForTargets, occurrences, type CaseFile, type Enumeration, type RunRecord, type Target, type VersionLog } from "./score.ts";
import type { AcceptanceLog } from "./replay.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = new URL("../../dist/", import.meta.url);
// v1 is the measurement of #36 and is not appended to: a later tool writes a later version.
/**
 * Where a measurement is written, named on the command line so that none is written by default,
 * with what it is about for `replay.ts` to state and to gate: `sibling` is the measurement of one
 * sibling's defect (`claim: "sibling"`, candidates-v2.json, #37), `again` the
 * acceptance set measured again with a later tool, of the same kind as v2 (#38).
 */
const LOGS = {
  sibling: { file: join(HERE, "..", "logs", "acceptance-v3.json"), claim: "sibling" },
  again: { file: join(HERE, "..", "logs", "acceptance-v4.json"), claim: undefined },
} as const;
type LogName = keyof typeof LOGS;
const RUNS = 3;
const ATTEMPTS = 5;
/** The copy of `defaultJudges` below, and where it was copied from. */
const JUDGES_COPIED_FROM = "src/cli/main.ts defaultJudges (JevClient, JevProvider, LimitedProvider concurrency 8, the client's identity)";

const load = async <T>(path: string): Promise<T> => (await import(new URL(path, DIST).href)) as T;

async function dist() {
  const [main, client, jev, provider, candidates, applicability, discover, git, config, glob, redact, local] = await Promise.all([
    load<typeof Main>("cli/main.js"),
    load<typeof Client>("judgments/client.js"),
    load<typeof Jev>("judgments/jev.js"),
    load<typeof Provider>("judgments/provider.js"),
    load<typeof Candidates>("plan/candidates.js"),
    load<typeof Applicability>("plan/applicability.js"),
    load<typeof Discover>("discovery/discover.js"),
    load<typeof GitModule>("repository/git.js"),
    load<typeof Config>("config/config.js"),
    load<typeof Glob>("config/glob.js"),
    load<typeof Redact>("evidence/redact.js"),
    load<typeof LocalCheck>("review/local-check-run.js"),
  ]);
  for (const [k, v] of Object.entries(BUDGETS)) {
    const built = (local.DEFAULT_LOCAL_CHECK as Record<string, unknown>)[k];
    if (built !== v) throw new Error(`the build's DEFAULT_LOCAL_CHECK.${k} is ${String(built)}, and this file counts requests with ${v}`);
  }
  return { main, client, jev, provider, candidates, applicability, discover, git, config, glob, redact, local };
}
type Dist = Awaited<ReturnType<typeof dist>>;

const caseDir = (id: string) => join(HERE, "cases", id);
const readCase = (id: string) => JSON.parse(readFileSync(join(caseDir(id), "case.json"), "utf8")) as CaseFile & { precheck?: Record<string, unknown> };
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** One call of `main`, with stdout and stderr kept rather than printed. */
async function callMain(d: Dist, clone: string, args: string[], env: NodeJS.ProcessEnv, deps: Main.Deps = {}) {
  let stdout = "";
  let stderr = "";
  const code = await d.main.main(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += `${t}\n`), cwd: clone, env }, deps);
  return { code, stdout, stderr };
}

const specArgs = (id: string, base: string, head: string) => ["--skip-change-check", "--base", base, "--head", head, "--intent-spec", join(caseDir(id), "spec.json"), "--json"];

/** The enumeration of one branch. It depends on the commits alone, so it is taken once. */
async function enumerationOf(d: Dist, id: string, clone: string, base: string, head: string): Promise<Enumeration & { counts: unknown }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(d.client.JUDGMENT_ENV as readonly string[]).includes(k)));
  const { code, stdout, stderr } = await callMain(d, clone, [...specArgs(id, base, head), "--candidates-only"], env);
  if (code !== 0) throw new Error(`candidates-only exited ${code}: ${stderr.trim()}`);
  const r = (JSON.parse(stdout) as { requirements: LocalCheck.LocalCheckResult[] }).requirements[0]!;
  const rows = <T extends { file: string; function: string; call: string }>(xs: T[]) => xs.map(({ file, function: fn, call, ...rest }) => ({ file, function: fn, call, ...rest }));
  return { wouldAsk: rows(r.wouldAsk), unchecked: rows(r.unchecked), notes: r.notes, counts: r.counts };
}

/**
 * How often a target occurs in its own function, and — when the tool held it — why, as
 * `applicabilityOf` puts it. The count is taken from the text, not from the tool's listing: a
 * target written wrong has to fail here, and a target beyond a cap must not look written wrong.
 */
async function targetFacts(d: Dist, clone: string, head: string, target: Target) {
  const git = await d.git.Git.open(clone);
  const source = await git.readText(head, target.file);
  if (source === null) return { existence: 0 };
  const existence = occurrences(source, target.function, target.call);
  if (existence !== 1) return { existence };
  const listed = d.candidates.enumerate(target.file, source);
  const hits = listed.calls.filter((c) => {
    const fn = listed.functions.find((f) => f.id === c.functionId);
    return fn?.name === target.function && d.redact.redact(c.expression).text === target.call;
  });
  // Present in the text and absent from the listing: dropped by a cap, never reached by applicabilityOf.
  if (hits.length !== 1) return { existence, listedBy: hits.length, omitted: listed.omitted };
  const call = hits[0]!;
  const fn = listed.functions.find((f) => f.id === call.functionId)!;
  const cfg = d.config.defaultConfig();
  const discoverer = new d.discover.Discoverer(git, head, { include: d.glob.pathFilter(cfg.repository.include, cfg.repository.ignore), maxCandidates: 20, lexicalSearch: true, referenceSearch: true });
  const a = await d.applicability.applicabilityOf(discoverer, fn, call);
  return { existence: 1, applicability: a.ok ? { ok: true } : { ok: false, kind: a.kind } };
}

async function precheck(id: string, clone: string) {
  const d = await dist();
  const c = readCase(id);
  c.existence = {};
  const pre: Record<string, unknown> = {};
  for (const [versionId, version] of Object.entries(c.versions)) {
    const enumeration = await enumerationOf(d, id, clone, version.base, version.head);
    const facts: Record<string, unknown> = {};
    c.existence[versionId] = {};
    for (const [key, target] of Object.entries(version.targets)) {
      const f = await targetFacts(d, clone, version.head, target);
      c.existence[versionId]![key] = f.existence;
      facts[key] = f;
    }
    pre[versionId] = { live: isLive(version, enumeration), counts: enumeration.counts, notes: enumeration.notes, targets: facts };
    console.log(`${id} ${versionId}: live=${isLive(version, enumeration)} ${JSON.stringify(facts)}`);
  }
  c.precheck = pre;
  writeJson(join(caseDir(id), "case.json"), c);
}

/**
 * The budgets of calls the command runs with, as `DEFAULT_LOCAL_CHECK` of the build it drives has them:
 * this file imports no value from `src/`, so `dist()` refuses a build whose defaults are not these.
 * The changed functions and their callers ask at most `budget + callerBudget` together (ADR 0015).
 */
const BUDGETS = { budget: 20, callerBudget: 10, siblingBudget: 10 } as const;

/** Requests one run can send at most: two questions per call, every budget of calls, and room for retries. */
function perRun(c: CaseFile, versionId: string): number {
  const requirements = new Set(Object.values(c.versions[versionId]!.targets).map((t) => t.requirementId)).size;
  return Math.ceil(requirements * 2 * (BUDGETS.budget + BUDGETS.callerBudget + BUDGETS.siblingBudget) * 1.1);
}

/** The cases a measurement can send for: built, and pre-checked. A regression case is measured again too. */
function precheckedCases(): (CaseFile & { precheck?: Record<string, { live?: boolean }> })[] {
  return readdirSync(join(HERE, "cases"))
    .filter((id) => existsSync(join(caseDir(id), "case.json")))
    .map(readCase)
    .filter((c) => c.precheck !== undefined) as (CaseFile & { precheck?: Record<string, { live?: boolean }> })[];
}

function estimate(only?: string): number {
  let total = 0;
  for (const c of precheckedCases().filter((x) => only === undefined || x.id === only)) {
    for (const versionId of Object.keys(c.versions)) {
      const live = c.precheck?.[versionId]?.live;
      if (live === undefined) throw new Error(`${c.id} ${versionId} has no pre-check; run precheck first`);
      if (live) total += RUNS * perRun(c, versionId);
    }
  }
  return total;
}

/** What is kept of one run: the answers, and the unchecked rows only for calls that were inside the budget. */
function distil(r: LocalCheck.LocalCheckResult) {
  const inBudget = (u: { file: string; function: string; call: string }) => r.wouldAsk.some((w) => w.file === u.file && w.function === u.function && w.call === u.call);
  return { requirementId: r.requirementId, observed: r.observed, mappings: r.mappings, findings: r.findings, unchecked: r.unchecked.filter(inBudget), counts: r.counts, notes: r.notes };
}

async function measure(id: string, clone: string, limit: number, which: LogName) {
  const LOG = LOGS[which].file;
  const d = await dist();
  // The log names Cloudflare's model; a run sent elsewhere (another JEV_PROVIDER, or JEV_API_URL)
  // would make that untrue. The environment's values are not repeated.
  const endpoint = d.client.endpointFromEnv(process.env);
  if (endpoint?.host !== "cloudflare") {
    throw new Error(`the log records Cloudflare's model and this environment sends judgments ${endpoint ? `to ${d.client.hostName(endpoint.host)}` : "nowhere"}; set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN and leave JEV_PROVIDER unset or cloudflare, with no JEV_API_URL`);
  }
  const self = await d.git.Git.open(join(HERE, "..", ".."));
  // The log names the commit its source was built from; changes beside the log itself would make that
  // untrue. The log is left out: measuring a second case, or resuming, writes to it before any commit.
  // What runs is the build in dist/, which this does not check — build from the committed source.
  const dirty = (await self.text(["status", "--porcelain", "--", ".", `:(exclude)${relative(join(HERE, "..", ".."), LOG)}`])).trim();
  if (dirty !== "") throw new Error(`the working tree has uncommitted changes besides the log; commit them first:\n${dirty}`);
  const c = readCase(id);
  const log: AcceptanceLog = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : { conditions: {}, cases: {} };
  const toolCommit = (await self.text(["rev-parse", "HEAD"])).trim();
  // Every file a question's words come from. `plan/forms.js` joined when questions became forms; a log
  // started before it names a different set, and is not appended to.
  const questions = Object.fromEntries(["plan/local-check.js", "plan/mapping.js", "plan/forms.js", "judgments/questions.js"].map((p) => [p, sha256(readFileSync(new URL(p, DIST)))]));
  const conditions = { ...(LOGS[which].claim === undefined ? {} : { claim: LOGS[which].claim }), tool: { repo: "yottayoshida/jev-intent-review", commit: toolCommit }, questionFiles: questions, model: d.client.jevModel("cloudflare"), settings: { ...d.local.DEFAULT_LOCAL_CHECK, bar: 0.6, mappingBar: 0.6 }, judges: JUDGES_COPIED_FROM, runsPerLiveBranch: RUNS };
  if (Object.keys(log.conditions).length > 0 && JSON.stringify(log.conditions) !== JSON.stringify(conditions)) {
    throw new Error(`the log was started under other conditions:\n${JSON.stringify(log.conditions)}\nnow:\n${JSON.stringify(conditions)}`);
  }
  log.conditions = conditions;
  let spent = 0;
  for (const cc of Object.values(log.cases)) for (const v of Object.values(cc.versions)) for (const run of v.runs as (RunRecord & { requests?: number })[]) spent += run.requests ?? 0;

  const entry = (log.cases[id] ??= { versions: {} });
  // The role the case had when it was measured: tuning with it later does not make this run tuned.
  if (entry.role !== undefined && entry.role !== c.role) throw new Error(`${id} was measured in this log as ${entry.role} and its case.json now says ${c.role}`);
  entry.role = c.role;
  for (const [versionId, version] of Object.entries(c.versions)) {
    const enumeration = await enumerationOf(d, id, clone, version.base, version.head);
    const targetApplicability: Record<string, { ok: boolean; kind?: string }> = {};
    for (const [key, target] of Object.entries(version.targets)) {
      const f = await targetFacts(d, clone, version.head, target);
      if ("applicability" in f && f.applicability) targetApplicability[key] = f.applicability;
    }
    const v: VersionLog = (entry.versions[versionId] ??= { base: version.base, head: version.head, enumeration: keepForTargets({ ...enumeration, targetApplicability }, Object.values(version.targets)), runs: [] });
    if (!isLive(version, enumeration)) {
      console.log(`${id} ${versionId}: no target inside the budget; settled by the enumeration, nothing sent`);
      writeJson(LOG, log);
      continue;
    }
    let attempts = v.runs.length;
    while (v.runs.filter((r) => r.finished).length < RUNS && attempts < ATTEMPTS) {
      attempts += 1;
      const room = limit - spent;
      if (room < perRun(c, versionId)) throw new Error(`stopping before ${id} ${versionId}: ${spent} of ${limit} requests spent, a run can take ${perRun(c, versionId)}`);
      const sent: { packet: string; questions: string[]; answers?: unknown; error?: string }[] = [];
      let client: Client.JevClient | undefined;
      const deps: Main.Deps = {
        judges: (endpoint, config, deadline) => {
          client = new d.client.JevClient(endpoint, { deadline, maxRequests: Math.min(config.limits.max_requests, room), maxBytes: config.limits.max_sent_bytes });
          const inner = new d.provider.LimitedProvider(new d.jev.JevProvider(client), { concurrency: 8, deadline });
          const provider: Provider.JudgmentProvider = {
            model: inner.model,
            async judge(state, qs) {
              const record: (typeof sent)[number] = { packet: sha256(JSON.stringify(state)), questions: Object.keys(qs) };
              sent.push(record);
              try {
                const answers = await inner.judge(state, qs);
                record.answers = answers;
                return answers;
              } catch (error) {
                record.error = error instanceof Error ? `${error.name}: ${(error as { kind?: string }).kind ?? ""}` : String(error);
                throw error;
              }
            },
          };
          return { provider, sent: () => ({ ...client!.sent }), origin: client.origin, identity: () => client!.identity() };
        },
      };
      const started = new Date().toISOString();
      const { code, stdout, stderr } = await callMain(d, clone, specArgs(id, version.base, version.head), process.env, deps);
      const counted = client?.sent ?? { requests: 0, bytes: 0 };
      spent += counted.requests;
      let requirements: RunRecord["requirements"] = [];
      let finished = false;
      try {
        requirements = (JSON.parse(stdout) as { requirements: LocalCheck.LocalCheckResult[] }).requirements.map(distil) as unknown as RunRecord["requirements"];
        // Exit 0 is not enough: the siblings are asked last, and a limit reached there cuts them alone.
        finished = code === 0 && !cutShort(requirements, sent);
      } catch {
        finished = false;
      }
      v.runs.push({ finished, requirements, ...({ started, exit: code, endpoint: client?.origin ?? null, requests: counted.requests, bytes: counted.bytes, modelIdentity: client ? d.client.modelIdentityOf(client.host, client.identity()) : null, sent, stderr: stderr.slice(0, 2000) } as object) } as RunRecord);
      writeJson(LOG, log);
      console.log(`${id} ${versionId} run ${v.runs.length}: exit ${code}, ${counted.requests} requests, finished=${finished}, ${spent}/${limit} spent`);
    }
  }
}

const [mode, id, clone, limit, which] = process.argv.slice(2);
if (mode === "precheck" && id && clone) await precheck(id, clone);
else if (mode === "estimate") console.log(`planned at most ${estimate(id)} requests across the live branches${id ? ` of ${id}` : ""}`);
else if (mode === "measure" && id && clone && limit && (which === "sibling" || which === "again")) await measure(id, clone, Number(limit), which);
else {
  console.error("usage: run.ts precheck <case> <clone> | estimate [<case>] | measure <case> <clone> <limit> <sibling|again>");
  process.exitCode = 2;
}
