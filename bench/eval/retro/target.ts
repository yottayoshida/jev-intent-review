// The defect's call of each case opened — the target — named from the later fix and frozen before any
// tool meets the case (#89, RETRO.md v7, "Opening and targets").
//
//   node bench/eval/retro/target.ts dev <clones> <records> <max runs>      dev's cases: prints the yield
//   node bench/eval/retro/target.ts sealed <clones> <records> <max runs>   the 17 opened: prints the sha256 only
//
// `<records>` is a clone's `batches` directory of the sandbox, which holds the batches' row records.
// For each case: F (the later fix) and its diff; O's range as it landed on the default branch; the files
// F changed as they stand at the head O is measured at; a namer (`TARGET_SYSTEM`) and a checker
// (`TARGET_CHECK_SYSTEM`), `claude -p` without tools. Only their answer is frozen, with the range, in
// `<records>/89-targets.json` (dev: `89-targets-dev-<n>.json`, three at most), whose sha256 goes on main in
// `frozen.json`.
// No tool is run on a case. **The sealed targets are named once**, and how many were named is never
// printed, nor the runs it took (RETRO.md v8): that number would bound the detections before anything is
// opened.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Split } from "../split.ts";
import { arrivedBetween, cloneInto, n1Problem, readAppended, workspaceState } from "./calibrate.ts";
import { ghApi, PIPED } from "./gh.ts";
import { fetchBundle, type Bundle } from "./material.ts";
import { annotate, TARGET_CHECK_SYSTEM, TARGET_PROMPTS_VERSION, TARGET_SYSTEM, WRITE_SYSTEM, writeRequest, type Answer } from "./prompts.ts";
import { batchProblem, overSize, type RowRecord } from "./screen.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** RETRO.md v7: 17 opened; namer and checker each asked up to four times. */
export const TARGETS = { opened: 17, retries: 3, worstPerCase: 2 * 4 } as const;

/** What O put on the default branch: from `base` to `head`, and how it was merged. */
export interface Landed {
  base: string;
  head: string;
  how: "merge" | "squash" | "rebase";
}

/**
 * O's range as it landed (RETRO.md v7, "A case is measured"): a merge commit's first parent to it; else
 * the last `commits` commits along first parents when their messages are O's own, in order (a rebase);
 * else the one commit (a squash).
 */
export function landedRange(git: { parents(sha: string): string[]; messages(head: string, n: number): string[] }, mergeCommit: string, prMessages: readonly string[]): Landed {
  const parents = git.parents(mergeCommit);
  if (parents.length >= 2) return { base: parents[0]!, head: mergeCommit, how: "merge" };
  const k = prMessages.length;
  if (k > 1) {
    const onBranch = git.messages(mergeCommit, k);
    const same = onBranch.length === k && onBranch.every((m, i) => m.trim() === prMessages[i]!.trim());
    if (same) {
      let base = mergeCommit;
      for (let i = 0; i < k; i++) base = git.parents(base)[0]!;
      return { base, head: mergeCommit, how: "rebase" };
    }
  }
  return { base: parents[0]!, head: mergeCommit, how: "squash" };
}

export interface Named {
  file: string;
  function: string;
  call: string;
  quote: string;
}

export type NotNamed =
  | "the checker does not agree"
  | "no call is named"
  | "a call without ("
  | "a request over the size"
  | "an answer never counted"
  | "no file of the fix at O's head";

export interface TargetRecord {
  row: number;
  ref: string;
  repo: string;
  origin: number;
  landed: Landed;
  target: Named | null;
  why?: NotNamed;
  answers: Answer[];
}

export interface TargetDeps {
  /** F: its bundle cut at its merge, and its diff. */
  fix(repo: string, number: number): { bundle: Bundle; diff: string };
  landed(repo: string, origin: number): Landed;
  /** A file's text at a commit, or null when it is not there. */
  fileAt(repo: string, commit: string, path: string): string | null;
  annotate(system: string, request: string): Answer;
}

/** The files a diff changes, by their name before it (`a/`). */
export function changedFiles(diff: string): string[] {
  const out: string[] = [];
  for (const m of diff.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

const request = (fix: { bundle: Bundle; diff: string }, files: [string, string][], named?: Named) =>
  [
    `Later fix: ${fix.bundle.pull.title}\n\n${fix.bundle.pull.body}`,
    `Its diff:\n\n${fix.diff}`,
    ...files.map(([path, text]) => `File ${path} as it stood when the earlier pull request had merged:\n\n${text}`),
    ...(named ? [`The call named:\n\n${JSON.stringify(named, null, 2)}`] : []),
  ].join("\n\n");

const namedOf = (j: unknown): Named | "none" | null => {
  const o = j as Record<string, unknown> | null;
  if (o && typeof o.none === "string") return "none";
  if (o && ["file", "function", "call", "quote"].every((k) => typeof o[k] === "string" && (o[k] as string).trim() !== "")) return { file: o.file as string, function: o.function as string, call: o.call as string, quote: o.quote as string };
  return null;
};

/** One case's target: the namer, then the checker. Never throws for want of an answer. */
export function nameTarget(c: { row: number; ref: string; repo: string; origin: number }, deps: TargetDeps): TargetRecord {
  const answers: Answer[] = [];
  const landed = deps.landed(c.repo, c.origin);
  const rec = (target: Named | null, why?: NotNamed): TargetRecord => ({ row: c.row, ref: c.ref, repo: c.repo, origin: c.origin, landed, target, ...(why ? { why } : {}), answers });
  const fix = deps.fix(c.repo, Number(c.ref.split("#")[1]));
  // Rust files only: the tool reads Rust, and a defect elsewhere is one it cannot list (dev, 2026-09-28).
  const files = changedFiles(fix.diff).filter((p) => p.endsWith(".rs")).flatMap((p): [string, string][] => {
    const text = deps.fileAt(c.repo, landed.head, p);
    return text === null ? [] : [[p, text]];
  });
  if (files.length === 0) return rec(null, "no file of the fix at O's head");
  const ask = (system: string, req: string, read: (j: unknown) => unknown): unknown | "over" | "never" => {
    if (overSize(system, req) !== null) return "over";
    for (let attempt = 0; attempt <= TARGETS.retries; attempt++) {
      const a = deps.annotate(system, req);
      answers.push(a);
      if (a.counted) {
        const v = read(a.json);
        if (v !== null) return v;
      }
    }
    return "never";
  };
  const n = ask(TARGET_SYSTEM, request(fix, files), namedOf);
  if (n === "over") return rec(null, "a request over the size");
  if (n === "never") return rec(null, "an answer never counted");
  if (n === "none") return rec(null, "no call is named");
  const named = n as Named;
  if (!named.call.includes("(")) return rec(null, "a call without (");
  const agree = ask(TARGET_CHECK_SYSTEM, request(fix, files, named), (j) => (typeof (j as { agree?: unknown } | null)?.agree === "boolean" ? (j as { agree: boolean }).agree : null));
  if (agree === "over") return rec(null, "a request over the size");
  if (agree === "never") return rec(null, "an answer never counted");
  if (agree !== true) return rec(null, "the checker does not agree");
  return rec(named);
}

/** A case of this measurement: its row record and the batch it is in. */
export interface CaseRow {
  row: number;
  ref: string;
  repo: string;
  origin: number;
}

/**
 * The cases opened (RETRO.md v7): this measurement's repositories on `side` of the split whose case was
 * not caught before the merge, in the order of their case's row, the first `count` (all when null).
 */
export function casesToOpen(records: readonly RowRecord[], split: Pick<Split, "repos">, side: "sealed" | "dev", count: number | null): CaseRow[] {
  const onSide = new Set(split.repos.filter((e) => e.batch?.measurement === "#89" && e.side === side).map((e) => e.repo.toLowerCase()));
  const cases = records
    .filter((r) => r.outcome === "case" && r.caught?.caught === false && onSide.has(r.repo.toLowerCase()))
    .sort((a, b) => a.row - b.row)
    .map((r) => ({ row: r.row, ref: r.ref, repo: r.repo, origin: (r.origin as { number: number }).number }));
  return count === null ? cases : cases.slice(0, count);
}

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** The frozen file: every case's range and target, and the verdicts' sha256 it was taken from. */
export function frozenText(side: "sealed" | "dev", recs: readonly TargetRecord[], verdicts: Record<string, string>): string {
  return `${JSON.stringify({ measurement: "#89", retroVersion: 7, promptsVersion: TARGET_PROMPTS_VERSION, side, verdicts, cases: recs }, null, 2)}\n`;
}

// ---- The real run -------------------------------------------------------------------------------

/** GitHub's most results in one page of a list. */
const PAGE = 100;

function realDeps(clones: string, empty: string): TargetDeps {
  // One fetch a repository a run: `cloneInto` fetches each time it is called.
  const dirs = new Map<string, string>();
  const dir = (repo: string) => {
    if (!dirs.has(repo)) dirs.set(repo, cloneInto(clones, repo));
    return dirs.get(repo)!;
  };
  const git = (repo: string, args: string[]) => execFileSync("git", ["-C", dir(repo), ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: PIPED });
  return {
    fix(repo, number) {
      const diff = execFileSync("gh", ["api", "--allow-escape-sequences", "-H", "Accept: application/vnd.github.v3.diff", `repos/${repo}/pulls/${number}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: PIPED });
      return { bundle: fetchBundle(repo, number), diff };
    },
    landed(repo, origin) {
      const p = ghApi(`repos/${repo}/pulls/${origin}`) as { merge_commit_sha: string; commits: number; head: { sha: string }; base: { sha: string } };
      const messages: string[] = [];
      for (let page = 1; messages.length < p.commits; page++) {
        const got = ghApi(`repos/${repo}/pulls/${origin}/commits?per_page=${PAGE}&page=${page}`) as { commit: { message: string } }[];
        if (got.length === 0) break;
        messages.push(...got.map((c) => c.commit.message));
      }
      const parents = (sha: string) => git(repo, ["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).slice(1);
      // Fast-forwarded: the pull request's own head is what landed, a merge commit among its commits or
      // not. Its range is its own commits, from the base it was opened on.
      if (p.merge_commit_sha === p.head.sha) return { base: p.base.sha, head: p.head.sha, how: "rebase" };
      return landedRange(
        {
          parents,
          messages: (head, n) => git(repo, ["log", "--first-parent", "--format=%B%x00", "-n", String(n), head]).split("\u0000").map((m) => m.trim()).filter((m) => m !== "").reverse(),
        },
        p.merge_commit_sha,
        messages,
      );
    },
    fileAt(repo, commit, path) {
      try {
        return git(repo, ["show", `${commit}:${path}`]);
      } catch {
        return null;
      }
    },
    annotate: (system, req) => annotate(system, req, empty),
  };
}

/** Every row record of this measurement's batches, each checked against its batch's verdicts first. */
function readRecords(records: string, batches: readonly { id: string }[]): RowRecord[] {
  const out: RowRecord[] = [];
  for (const b of batches) {
    const problem = batchProblem(records, b.id);
    if (problem !== null) throw new Error(`batch #89 ${b.id}: ${problem}`);
    const v = JSON.parse(readFileSync(join(records, `89-${b.id}.json`), "utf8")) as { rows: { row: number }[] };
    for (const r of v.rows) out.push(JSON.parse(readFileSync(join(records, `89-${b.id}`, `${r.row}.json`), "utf8")) as RowRecord);
  }
  return out;
}

/** An answer as it is kept: what was sent, by its bytes and sha256 only — the text is F's and O's. */
export function kept(a: Answer): Answer {
  return { ...a, sent: { system: sha256(a.sent.system), request: sha256(a.sent.request), bytes: a.sent.bytes } };
}

/** Dev's attempts: the first, and `TARGET_SYSTEM` changed at most twice (RETRO.md v7). */
export const DEV_ATTEMPTS = 3;

/** A line of `frozen.json`: which targets, the file in the sandbox, and its sha256. Lines are only added. */
export interface FrozenLine {
  side: "sealed" | "dev";
  file: string;
  sha256: string;
}

/**
 * Why a naming may not start, or `null`, and the file it writes. A sealed naming that finished, or whose
 * line is on main, refuses another (RETRO.md v8); dev has `DEV_ATTEMPTS` attempts.
 */
export function refusalOf(side: "sealed" | "dev", exists: (name: string) => boolean, frozen: readonly FrozenLine[]): { refused: string } | { file: string } {
  if (side === "sealed") {
    if (exists("89-targets.json")) return { refused: "the sealed targets are named already; naming them again is a new version of RETRO.md" };
    if (frozen.some((l) => l.side === "sealed")) return { refused: "main holds the sealed targets' line already" };
    return { file: "89-targets.json" };
  }
  let n = 1;
  while (exists(`89-targets-dev-${n}.json`)) n++;
  if (n > DEV_ATTEMPTS) return { refused: `dev has had its ${DEV_ATTEMPTS} attempts` };
  return { file: `89-targets-dev-${n}.json` };
}

export function main(argv: readonly string[]) {
  const [side, clones, records, max] = argv;
  if ((side !== "dev" && side !== "sealed") || !clones || !records || !Number.isInteger(Number(max))) throw new Error("usage: target.ts dev|sealed <clones> <records> <max runs>");
  const maxRuns = Number(max);
  const frozen = (JSON.parse(readFileSync(join(HERE, "frozen.json"), "utf8")) as { lines: FrozenLine[] }).lines;
  const pre = refusalOf(side, (name) => existsSync(join(records, name)), frozen);
  if ("refused" in pre) throw new Error(pre.refused);
  const file = join(records, pre.file);
  const partial = `${file}.partial.jsonl`;
  const split = JSON.parse(readFileSync(join(HERE, "..", "split.json"), "utf8")) as Split;
  const batches = (JSON.parse(readFileSync(join(HERE, "..", "sealed-batches.json"), "utf8")) as { batches: { measurement: string; id: string; sha256: string }[] }).batches.filter((b) => b.measurement === "#89");
  const verdicts: Record<string, string> = {};
  for (const b of batches) {
    const got = sha256(readFileSync(join(records, `89-${b.id}.json`)));
    if (got !== b.sha256) throw new Error(`batch #89 ${b.id}'s verdicts are not the ones main holds`);
    verdicts[b.id] = got;
  }
  const cases = casesToOpen(readRecords(records, batches), split, side, side === "sealed" ? TARGETS.opened : null);
  if (side === "sealed" && cases.length < TARGETS.opened) throw new Error(`the sealed side holds ${cases.length} cases, not ${TARGETS.opened}`);
  // Cases named in an earlier run of this naming are kept and not asked again.
  const done: TargetRecord[] = existsSync(partial) ? readFileSync(partial, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TargetRecord) : [];
  const spentFile = `${file}.runs.json`;
  let runs = existsSync(spentFile) ? (JSON.parse(readFileSync(spentFile, "utf8")) as { runs: number }).runs : 0;
  const left = cases.filter((c) => !done.some((d) => d.row === c.row));
  if (runs + 1 + left.length * TARGETS.worstPerCase > maxRuns) throw new Error(`${left.length} cases need up to ${1 + left.length * TARGETS.worstPerCase} runs, the N=1 run included; ${maxRuns - runs} are left`);
  const empty = mkdtempSync(join(tmpdir(), "jir-annotator-"));
  const deps = realDeps(clones, empty);
  const spend = () => writeFileSync(spentFile, `${JSON.stringify({ runs }, null, 2)}\n`);
  const before = workspaceState();
  const probe = deps.annotate(WRITE_SYSTEM, writeRequest({ repo: "o/r", pull: { number: 1, title: "Read the config", body: "Reading the config must fail loudly when the file cannot be read.", comments: [], reviews: [] }, issues: [], unavailable: [] }));
  runs += 1;
  spend();
  const after = workspaceState();
  const problem = n1Problem(arrivedBetween(before.originMain, after.originMain), readAppended(before.auditBytes), empty, probe.counted);
  if (problem !== null) return console.log(JSON.stringify({ side, stopped: `N=1: ${problem}` }));
  const recs = [...done];
  for (const c of left) {
    // Its worst case reserved first: a naming stopped half way through a case never counts fewer runs than it spent.
    writeFileSync(spentFile, `${JSON.stringify({ runs: runs + TARGETS.worstPerCase }, null, 2)}\n`);
    const r = nameTarget(c, deps);
    runs += r.answers.length;
    const k: TargetRecord = { ...r, answers: r.answers.map(kept) };
    appendFileSync(partial, `${JSON.stringify(k)}\n`);
    spend();
    recs.push(k);
  }
  recs.sort((a, b) => a.row - b.row);
  const text = frozenText(side, recs, verdicts);
  writeFileSync(file, text);
  console.log(JSON.stringify(summaryOf(side, recs, runs, maxRuns, text)));
}

/**
 * What the command prints. On dev, the yield; on sealed, neither how many were named nor the runs, from
 * which the answers that reached the checker could be counted (RETRO.md v8) — whether the runs stayed
 * within those allowed, and the sha256.
 */
export function summaryOf(side: "sealed" | "dev", recs: readonly TargetRecord[], runs: number, maxRuns: number, text: string) {
  if (side === "sealed") return { side, cases: recs.length, withinRuns: runs <= maxRuns, sha256: sha256(text) };
  const why: Record<string, number> = {};
  for (const r of recs) if (r.why) why[r.why] = (why[r.why] ?? 0) + 1;
  return { side, cases: recs.length, named: recs.filter((r) => r.target !== null).length, notNamed: why, runs, sha256: sha256(text) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`target.ts stopped: ${error instanceof Error ? error.constructor.name : typeof error}`);
    process.exitCode = 1;
  }
}
