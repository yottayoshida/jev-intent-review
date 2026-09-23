// How much of what a run sends survives the next push of the same pull request. Answers decide
// nothing here, so they come from a stand-in on localhost and no request is billed: the packets a
// run sends do not depend on the answers it gets — `selectSites` finishes before the first request
// and asks no model, and the observation question is sent whatever the mapping question answered.
//
//   node bench/packet-reuse.ts --work <dir> [--refs owner/repo#n,...] [--out <file>]
//   node bench/packet-reuse.ts --work <dir> --requirement-positions owner/repo#n
//   node bench/packet-reuse.ts --work <dir> --fidelity owner/repo#n        # sends real requests
//   node bench/packet-reuse.ts --work <dir> --ledger [--refs ...] [--out <file>]   # the ledger itself (ADR 0013)
//
// The corpus is every entry of `bench/acceptance/candidates.json`; a pull request with more than
// one commit gives pairs, and a "push" here is a commit the author pushed, in order. Every ref is attempted; each
// one that cannot be measured is kept in the record with the reason, so the population is the list
// and not what happened to work.
//
// Every run is given the same requirement, in the documented `Property:` form. The code and its
// pushes are real; the requirement is not the one the author wrote, because most of these pull
// requests state none in a form this tool reads (#40). What that fixes is the same at both heads of
// a pair, which is what a share of unchanged evidence is measured against.
//
// `--requirement-positions` answers a different question on one ref: whether adding a requirement
// moves the packets of the requirements that were already there. It runs one head three times —
// one requirement, that one with a second appended, and that one with a second put in front — and
// compares the first's packets with its own packets in the other two.

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { STAND_IN_TOKEN, standIn } from "./stand-in.ts";
import type { ReviewReport } from "../src/types.ts";

const REQUIREMENT = "Property: If an operation fails, the failure must be returned to its caller rather than turned into a success.";
const SECOND_REQUIREMENT = "Property: A value read from outside this process must be checked before it is used.";
/** A clone or a run that takes longer than this is kept in the record as not measured, with the reason. */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 8 * 60 * 1000;
/** A `gh api` call or a fetch with no limit waited 13 hours on one stalled connection, and the record was never written. */
const NETWORK_TIMEOUT_MS = 2 * 60 * 1000;

interface Candidates {
  candidates: { ref: string }[];
}

interface TraceLine {
  request: { state: unknown; questions: unknown };
}

export interface Judgment {
  exact: string;
  loose: string;
  side: "calls" | "changes";
}

/** Every value under a key named `lines`, blanked: two packets that differ only in where the code sits become one. */
export function withoutLineNumbers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLineNumbers);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "lines" ? "" : withoutLineNumbers(v)]));
  }
  return value;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export function judgmentsOf(tracePath: string): Judgment[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const { request } = JSON.parse(line) as TraceLine;
      const pair = [request.state, request.questions];
      return {
        exact: digest(pair),
        loose: digest(withoutLineNumbers(pair)),
        // The change question's state holds the change; the local check's holds one requirement and a candidate.
        side: (request.state as { change?: unknown })?.change === undefined ? ("calls" as const) : ("changes" as const),
      };
    });
}

// gh's own message goes into the error, so a skipped ref says "Not Found (HTTP 404)" and not only "Command failed".
const gh = (path: string, jq: string) =>
  execFileSync("gh", ["api", path, "--jq", jq], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: NETWORK_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Why a ref was not measured, for the record: gh's own words ("Not Found (HTTP 404)"), and a time limit told apart from a failure. */
function whyNotMeasured(error: unknown): string {
  const said = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").at(-1) ?? "";
  const first = error instanceof Error ? (error.message.split("\n")[0] ?? "failed") : "failed";
  const timedOut = (error as { code?: unknown }).code === "ETIMEDOUT";
  // Not the seconds: a clone and a fetch have different limits and land in the same catch.
  return `${timedOut ? "timed out: " : ""}${first}${said && !first.includes(said) ? ` — ${said}` : ""}`.slice(0, 200);
}

function cloneOf(work: string, owner: string, repo: string, number: number): string {
  const dir = join(work, `${owner}__${repo}`);
  if (!existsSync(dir)) {
    // Not a partial clone: the tool reads blobs all over the repository, and a `blob:none` clone
    // turns each of those reads into a fetch. `--no-checkout` is fine — it reads git objects.
    execFileSync("git", ["clone", "--no-checkout", `https://github.com/${owner}/${repo}.git`, dir], { stdio: "ignore", timeout: CLONE_TIMEOUT_MS, killSignal: "SIGKILL" });
  }
  // The pull request's commits are not on any branch once it is closed.
  execFileSync("git", ["-C", dir, "fetch", "-q", "origin", `+refs/pull/${number}/head:refs/remotes/origin/pr-${number}`], { stdio: "ignore", timeout: NETWORK_TIMEOUT_MS, killSignal: "SIGKILL" });
  return dir;
}

/**
 * One run of the tool, with its judgments taken from the trace it wrote.
 *
 * Not `execFileSync`: the stand-in listens in this process, and a synchronous child blocks the
 * event loop, so the server never accepts the connection. The client then counts requests it sent
 * and the run ends with "none was answered" — which reads like a bad endpoint, not a blocked one.
 */
function runAt(dir: string, base: string, head: string, intents: string[], endpoint: string | null, tracePath: string, answers?: string): Promise<{ judgments: Judgment[]; exitCode: number; stderr: string; report: ReviewReport | null }> {
  rmSync(tracePath, { force: true });
  // One `--intent`, with a paragraph per requirement: the flag is not repeatable, so passing it
  // twice keeps only the last and quietly measures something else.
  const args = ["--base", base, "--head", head, "--json", "--intent", intents.join("\n\n"), ...(answers === undefined ? [] : ["--answers", answers])];
  // A null endpoint leaves whatever the environment already names, for the run that is not a stand-in.
  const endpointEnv = endpoint === null ? {} : { JEV_API_URL: endpoint, JEV_API_TOKEN: STAND_IN_TOKEN };
  return new Promise((done) => {
    const child = spawn("node", [join(import.meta.dirname, "..", "src", "cli", "main.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, ...endpointEnv, JEV_TRACE_FILE: tracePath, GITHUB_EVENT_NAME: "", GITHUB_EVENT_PATH: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    let stderr = "";
    let stopped = false;
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      stopped = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({
        judgments: judgmentsOf(tracePath),
        exitCode: code ?? 1,
        report: (() => {
          try {
            return JSON.parse(stdout) as ReviewReport;
          } catch {
            return null;
          }
        })(),
        stderr: stopped ? `the run was stopped after ${RUN_TIMEOUT_MS / 1000}s` : stderr.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400),
      });
    });
  });
}

/** What a push would not have to ask again, counted on the judgments the later head sent. */
export function comparePair(before: Judgment[], after: Judgment[], side?: Judgment["side"]) {
  const mine = side ? after.filter((j) => j.side === side) : after;
  const theirs = side ? before.filter((j) => j.side === side) : before;
  const exact = new Set(theirs.map((j) => j.exact));
  const loose = new Set(theirs.map((j) => j.loose));
  // Each judgment lands in the first of the three it fits, so they add up to `sent` by construction;
  // nothing records that as a check, because it cannot fail.
  let identical = 0;
  let onlyLinesMoved = 0;
  let isNew = 0;
  for (const j of mine) {
    if (exact.has(j.exact)) identical += 1;
    else if (loose.has(j.loose)) onlyLinesMoved += 1;
    else isNew += 1;
  }
  const mineExact = new Set(mine.map((j) => j.exact));
  return {
    sent: mine.length,
    identical,
    onlyLinesMoved,
    new: isNew,
    goneFromBefore: theirs.filter((j) => !mineExact.has(j.exact)).length,
  };
}

export interface Pair {
  /** Both heads' runs exited 0. A run that died leaves no trace, which reads as "sent nothing" and not as "did not run". */
  ran: boolean;
  all: { sent: number; identical: number; onlyLinesMoved: number };
}

/** One share per pair both of whose runs finished and whose later head sent something. */
export const sharesOf = (pairs: Pair[], loose: boolean) =>
  pairs.filter((p) => p.ran && p.all.sent > 0).map((p) => (p.all.identical + (loose ? p.all.onlyLinesMoved : 0)) / p.all.sent);

/**
 * Whether two runs sent the same packets, each as many times. The order is kept apart and does not
 * decide it: the change questions go out together and a trace line is written when an answer comes
 * back, so the order follows how fast each was answered.
 */
export function samePackets(a: string[], b: string[]) {
  const sorted = (xs: string[]) => [...xs].sort();
  const [sa, sb] = [sorted(a), sorted(b)];
  return {
    samePackets: sa.length === sb.length && sa.every((h, i) => h === sb[i]),
    sameOrder: a.length === b.length && a.every((h, i) => h === b[i]),
  };
}

export const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const half = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[half] as number) : (((s[half - 1] as number) + (s[half] as number)) / 2);
};

async function measureRefs(work: string, refs: string[], outPath: string | undefined): Promise<void> {
  const endpoint = await standIn();
  const measured: Record<string, unknown>[] = [];
  const skipped: { ref: string; why: string }[] = [];

  for (const ref of refs) {
    const [repoPart, numberPart] = ref.split("#");
    const [owner, repo] = (repoPart ?? "").split("/");
    const number = Number(numberPart);
    if (!owner || !repo || !Number.isInteger(number)) {
      skipped.push({ ref, why: "the reference could not be read as owner/repo#number" });
      continue;
    }
    try {
      const base = gh(`/repos/${owner}/${repo}/pulls/${number}`, ".base.sha");
      const heads = gh(`/repos/${owner}/${repo}/pulls/${number}/commits`, "[.[].sha] | join(\" \")").split(" ").filter(Boolean);
      if (heads.length < 2) {
        skipped.push({ ref, why: `the pull request has ${heads.length} commit(s), so it has no pair of pushes` });
        continue;
      }
      const dir = cloneOf(work, owner, repo, number);
      const tracePath = join(work, "trace.jsonl");
      const runs: { head: string; judgments: Judgment[]; exitCode: number; stderr: string }[] = [];
      for (const head of heads) runs.push({ head, ...(await runAt(dir, base, head, [REQUIREMENT], endpoint.url, tracePath)) });
      const pairs = runs.slice(1).map((after, i) => {
        const before = runs[i] as (typeof runs)[number];
        return {
          from: before.head.slice(0, 12),
          to: after.head.slice(0, 12),
          ran: before.exitCode === 0 && after.exitCode === 0,
          all: comparePair(before.judgments, after.judgments),
          calls: comparePair(before.judgments, after.judgments, "calls"),
          changes: comparePair(before.judgments, after.judgments, "changes"),
        };
      });
      measured.push({
        ref,
        base: base.slice(0, 12),
        heads: heads.length,
        sentPerHead: runs.map((r) => r.judgments.length),
        exitCodes: runs.map((r) => r.exitCode),
        stderrTail: runs.filter((r) => r.exitCode !== 0).map((r) => r.stderr),
        pairs,
      });
      console.log(`${ref}: ${heads.length} heads, sent ${runs.map((r) => r.judgments.length).join("/")}, identical ${pairs.map((p) => `${p.all.identical}/${p.all.sent}`).join(" ")}`);
    } catch (error) {
      const why = whyNotMeasured(error);
      skipped.push({ ref, why });
      console.log(`${ref}: skipped — ${why}`);
    }
  }

  // Split before the numbers are seen: 17 of the 40 candidates name `yottayoshida/omamori`, a
  // repository of the person who wrote the tool. (All 17 turned out to be issues, so nothing of it
  // is measured and the external numbers equal the overall ones.)
  const pairsOf = (rows: Record<string, unknown>[]) => rows.flatMap((m) => m.pairs as Pair[]);
  const isOwn = (m: Record<string, unknown>) => String(m.ref).startsWith("yottayoshida/");
  const external = pairsOf(measured.filter((m) => !isOwn(m)));
  const all = pairsOf(measured);
  const shares = sharesOf(all, false);
  const loose = sharesOf(all, true);
  const record = {
    version: 1 as const,
    what: "the share of a push's judgments whose packet was already answered at the push before it",
    requirement: REQUIREMENT,
    standIn: true,
    requestsToTheStandIn: endpoint.requests(),
    corpus: refs,
    measured,
    skipped,
    pairs: shares.length,
    // Left out of the medians because a run of one of the two heads did not exit 0.
    pairsNotRun: all.filter((p) => !p.ran).length,
    medianIdenticalShare: median(shares),
    medianIdenticalOrLinesMovedShare: median(loose),
    // The same two numbers over the pull requests of repositories other than this tool's author's.
    externalRefs: measured.filter((m) => !isOwn(m)).map((m) => m.ref),
    externalPairs: sharesOf(external, false).length,
    externalMedianIdenticalShare: median(sharesOf(external, false)),
    externalMedianIdenticalOrLinesMovedShare: median(sharesOf(external, true)),
  };
  endpoint.close();

  console.log(`\npairs measured: ${record.pairs} · median identical ${record.medianIdenticalShare === null ? "n/a" : record.medianIdenticalShare.toFixed(3)} · with only-lines-moved ${record.medianIdenticalOrLinesMovedShare === null ? "n/a" : record.medianIdenticalOrLinesMovedShare.toFixed(3)}`);
  console.log(`skipped: ${record.skipped.length}`);
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
}

/** Does adding a requirement move the packets of the one that was already there? */
async function measureRequirementPositions(work: string, ref: string, outPath: string | undefined): Promise<void> {
  const endpoint = await standIn();
  const [repoPart, numberPart] = ref.split("#");
  const [owner, repo] = (repoPart ?? "").split("/");
  const number = Number(numberPart);
  const base = gh(`/repos/${owner}/${repo}/pulls/${number}`, ".base.sha");
  const head = gh(`/repos/${owner}/${repo}/pulls/${number}`, ".head.sha");
  const dir = cloneOf(work, owner as string, repo as string, number);
  const tracePath = join(work, "trace-positions.jsonl");

  const alone = await runAt(dir, base, head, [REQUIREMENT], endpoint.url, tracePath);
  const appended = await runAt(dir, base, head, [REQUIREMENT, SECOND_REQUIREMENT], endpoint.url, tracePath);
  const inserted = await runAt(dir, base, head, [SECOND_REQUIREMENT, REQUIREMENT], endpoint.url, tracePath);

  const record = {
    version: 1 as const,
    what: "whether a second requirement moves the packets of the first, by where it is put",
    ref,
    head: head.slice(0, 12),
    alone: { sent: alone.judgments.length, exitCode: alone.exitCode },
    appended: { exitCode: appended.exitCode, ...comparePair(alone.judgments, appended.judgments) },
    inserted: { exitCode: inserted.exitCode, ...comparePair(alone.judgments, inserted.judgments) },
    callsAppended: comparePair(alone.judgments, appended.judgments, "calls"),
    callsInserted: comparePair(alone.judgments, inserted.judgments, "calls"),
    changesAppended: comparePair(alone.judgments, appended.judgments, "changes"),
    changesInserted: comparePair(alone.judgments, inserted.judgments, "changes"),
    requestsToTheStandIn: endpoint.requests(),
  };
  endpoint.close();

  console.log(`${ref} at ${record.head}: alone sent ${record.alone.sent}`);
  console.log(`  appended: ${record.callsAppended.identical}/${record.callsAppended.sent} of the calls' packets were already there; changes ${record.changesAppended.identical}/${record.changesAppended.sent}`);
  console.log(`  inserted: ${record.callsInserted.identical}/${record.callsInserted.sent} of the calls' packets were already there; changes ${record.changesInserted.identical}/${record.changesInserted.sent}`);
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
}

/**
 * Whether the stand-in measures the same packets the real endpoint is sent. What can differ is a
 * retry and the run's time limit, not an answer, so this compares the hashes of one head's
 * judgments taken both ways, as a multiset. It sends real requests: run it with the credentials already in the
 * environment, on one pull request, once.
 */
async function measureFidelity(work: string, ref: string, outPath: string | undefined): Promise<void> {
  const endpoint = await standIn();
  const [repoPart, numberPart] = ref.split("#");
  const [owner, repo] = (repoPart ?? "").split("/");
  const number = Number(numberPart);
  const base = gh(`/repos/${owner}/${repo}/pulls/${number}`, ".base.sha");
  const head = gh(`/repos/${owner}/${repo}/pulls/${number}`, ".head.sha");
  const dir = cloneOf(work, owner as string, repo as string, number);

  const withStandIn = await runAt(dir, base, head, [REQUIREMENT], endpoint.url, join(work, "trace-stand-in.jsonl"));
  endpoint.close();
  // A null endpoint leaves the one the environment already names: this run is billed.
  const realRun = await runAt(dir, base, head, [REQUIREMENT], null, join(work, "trace-real.jsonl"));

  const standInHashes = withStandIn.judgments.map((j) => j.exact);
  const realHashes = realRun.judgments.map((j) => j.exact);
  const record = {
    version: 1 as const,
    what: "whether the packets sent to a stand-in are the packets sent to the real endpoint, each as often",
    ref,
    head: head.slice(0, 12),
    standIn: { sent: standInHashes.length, exitCode: withStandIn.exitCode },
    real: { sent: realHashes.length, exitCode: realRun.exitCode },
    ...samePackets(standInHashes, realHashes),
  };
  console.log(`${ref} at ${record.head}: stand-in sent ${record.standIn.sent}, real sent ${record.real.sent}`);
  console.log(`same packets, each as often: ${record.samePackets} · same order: ${record.sameOrder}`);
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
}

/**
 * How many of a push's requests kept answers should cover, counted from the trace of a run without
 * them: those already sent at any earlier push of the pull request, and every repeat of one sent
 * earlier in this run. It is counted from the packets, not from the ledger's key, so the two are
 * not the same computation.
 */
export function expectedReused(earlier: ReadonlySet<string>, now: readonly string[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const packet of now) {
    if (earlier.has(packet) || seen.has(packet)) n += 1;
    seen.add(packet);
  }
  return n;
}

/**
 * The ledger as it is built (ADR 0013), on the same pull requests' pushes: each head is run without
 * kept answers and with them, against a stand-in whose answers follow each request's hash, so an
 * answer returned for the wrong request would change the report. A push passes when the reused
 * count equals `expectedReused` and both reports read the same.
 */
async function measureLedger(work: string, refs: string[], outPath: string | undefined): Promise<void> {
  const endpoint = await standIn("hashed");
  const measured: Record<string, unknown>[] = [];
  const skipped: { ref: string; why: string }[] = [];
  for (const ref of refs) {
    const [repoPart, numberPart] = ref.split("#");
    const [owner, repo] = (repoPart ?? "").split("/");
    const number = Number(numberPart);
    if (!owner || !repo || !Number.isInteger(number)) {
      skipped.push({ ref, why: "the reference could not be read as owner/repo#number" });
      continue;
    }
    try {
      const base = gh(`/repos/${owner}/${repo}/pulls/${number}`, ".base.sha");
      const heads = gh(`/repos/${owner}/${repo}/pulls/${number}/commits`, "[.[].sha] | join(\" \")").split(" ").filter(Boolean);
      if (heads.length < 2) {
        skipped.push({ ref, why: `the pull request has ${heads.length} commit(s), so it has no pair of pushes` });
        continue;
      }
      const dir = cloneOf(work, owner, repo, number);
      const answers = join(work, `answers-${owner}__${repo}-${number}`);
      rmSync(answers, { recursive: true, force: true });
      mkdirSync(answers, { mode: 0o700 });
      const earlier = new Set<string>();
      const pushes: Record<string, unknown>[] = [];
      for (const head of heads) {
        const plain = await runAt(dir, base, head, [REQUIREMENT], endpoint.url, join(work, "trace-plain.jsonl"));
        const kept = await runAt(dir, base, head, [REQUIREMENT], endpoint.url, join(work, "trace-kept.jsonl"), answers);
        const packets = plain.judgments.map((j) => j.exact);
        const expected = expectedReused(earlier, packets);
        // Of those, the ones an earlier push kept: every request of a packet already sent before this push.
        const expectedFromEarlier = packets.filter((p) => earlier.has(p)).length;
        for (const p of packets) earlier.add(p);
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
        pushes.push({
          head: head.slice(0, 12),
          ran: plain.exitCode === 0 && kept.exitCode === 0 && plain.report !== null && kept.report !== null,
          sent: packets.length,
          expectedReused: expected,
          reused: kept.report?.sent.reused ?? null,
          expectedFromEarlierRuns: expectedFromEarlier,
          reusedFromEarlierRuns: kept.report?.sent.reusedFromEarlierRuns ?? null,
          requestsWithout: plain.report?.sent.requests ?? null,
          requestsWith: kept.report?.sent.requests ?? null,
          sameRequirements: same(plain.report?.requirements, kept.report?.requirements),
          sameChanges: same(plain.report?.unexpectedChanges, kept.report?.unexpectedChanges),
          notes: (kept.report?.metadata.notes ?? []).filter((n) => n.includes("kept") || n.includes("--answers")),
        });
      }
      measured.push({ ref, base: base.slice(0, 12), heads: heads.length, pushes });
      console.log(`${ref}: ${pushes.map((p) => `${p.reused}/${p.expectedReused}${p.sameRequirements && p.sameChanges ? "" : " DIFFERS"}`).join(" ")}`);
    } catch (error) {
      const why = whyNotMeasured(error);
      skipped.push({ ref, why });
      console.log(`${ref}: skipped — ${why}`);
    }
  }
  endpoint.close();
  type Push = { ran: boolean; sent: number; expectedReused: number; reused: number | null; expectedFromEarlierRuns: number; reusedFromEarlierRuns: number | null; requestsWithout: number | null; requestsWith: number | null; sameRequirements: boolean; sameChanges: boolean };
  const all = measured.flatMap((m) => m.pushes as Push[]);
  const ran = all.filter((p) => p.ran);
  // The first push of each pull request has nothing earlier: its share is left out, as a pair's was.
  const later = measured.flatMap((m) => (m.pushes as Push[]).slice(1)).filter((p) => p.ran && p.sent > 0);
  const record = {
    version: 1 as const,
    what: "the ledger on consecutive pushes: requests answered from kept answers, against the count expected from the packets, and whether the report reads the same",
    requirement: REQUIREMENT,
    standIn: "hashed",
    corpus: refs,
    measured,
    skipped,
    pushes: all.length,
    pushesNotRun: all.length - ran.length,
    reusedMatchesExpected: ran.filter((p) => p.reused === p.expectedReused).length,
    fromEarlierRunsMatchesExpected: ran.filter((p) => p.reusedFromEarlierRuns === p.expectedFromEarlierRuns).length,
    requestsAddUp: ran.filter((p) => p.requestsWithout !== null && p.requestsWith !== null && p.reused !== null && p.requestsWith + p.reused === p.requestsWithout).length,
    reportsSame: ran.filter((p) => p.sameRequirements && p.sameChanges).length,
    medianReusedShareOfLaterPushes: median(later.map((p) => (p.reused ?? 0) / p.sent)),
    reusedOfLaterPushes: { reused: later.reduce((n, p) => n + (p.reused ?? 0), 0), sent: later.reduce((n, p) => n + p.sent, 0) },
  };
  console.log(`\npushes ${record.pushes} (not run ${record.pushesNotRun}) · reused = expected ${record.reusedMatchesExpected}/${ran.length} · from earlier runs = expected ${record.fromEarlierRunsMatchesExpected}/${ran.length} · requests add up ${record.requestsAddUp}/${ran.length} · same report ${record.reportsSame}/${ran.length} · median share ${record.medianReusedShareOfLaterPushes?.toFixed(3) ?? "n/a"}`);
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { work: { type: "string" }, refs: { type: "string" }, out: { type: "string" }, "requirement-positions": { type: "string" }, fidelity: { type: "string" }, ledger: { type: "boolean", default: false } },
  });
  const work = values.work;
  if (!work) throw new Error("--work <dir> is required: the clones and the trace files go there");
  mkdirSync(work, { recursive: true });

  if (values["requirement-positions"]) {
    await measureRequirementPositions(work, values["requirement-positions"], values.out);
    return;
  }
  if (values.fidelity) {
    await measureFidelity(work, values.fidelity, values.out);
    return;
  }
  const refs = values.refs
    ? values.refs.split(",").map((r) => r.trim()).filter(Boolean)
    : (JSON.parse(readFileSync(join(import.meta.dirname, "acceptance", "candidates.json"), "utf8")) as Candidates).candidates.map((c) => c.ref);
  if (values.ledger) await measureLedger(work, refs, values.out);
  else await measureRefs(work, refs, values.out);
}

if (import.meta.filename === process.argv[1]) await main(process.argv.slice(2));
