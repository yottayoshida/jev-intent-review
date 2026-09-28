// The retrospective's opening and run (#89, RETRO.md v7-v9), through `run.ts --set sealed … --measurement
// "#89"`: the checks before an opening, the cases laid out as #80's are, the tool run three times on each
// case with a requirement, every requirement enumerated, the calls that are not the target adjudicated,
// and the score. Nothing of a case is printed or written into the repository: the report holds numbers.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceLog } from "../../acceptance/replay.ts";
import { adjudicate, itemsOf, keyOf, StopRun, type Item } from "../adjudicate.ts";
import { assertEmptyDir } from "../baseline.ts";
import { prepareClone, stopRule, type CheckedCase, type SandboxView, type Work } from "../sealed.ts";
import type { Split } from "../split.ts";
import type { RowRecord } from "./screen.ts";
import { casesToOpen, type NotNamed, type TargetRecord } from "./target.ts";
import { matches, normalCall, sameFile, score, type Call, type ScoredCase, type ScoredRun } from "./score.ts";

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** RETRO.md's version these runs follow. */
export const RETRO_VERSION = 9;
export const OPENED = 17;

/** A case of this measurement laid out for a run: #80's shape, and what only the score reads. */
export interface RetroCase extends CheckedCase {
  clone: string;
  target: Call | null;
  whyNotNamed?: string;
  requirements: { id: string; text: string }[];
  originBy: string;
  landed: { base: string; head: string } | null;
}

/** Why the sandbox's records are not the ones main holds, or `null`. */
export function recordsProblem(view: SandboxView, commit: string, lines: readonly { measurement: string; id: string; sha256: string }[]): string | null {
  for (const l of lines.filter((x) => x.measurement === "#89")) {
    const v = view.file(commit, `batches/89-${l.id}.json`);
    if (v === null) return `batch #89 ${l.id} has no verdicts in the sandbox`;
    if (sha256(v) !== l.sha256) return `batch #89 ${l.id}'s verdicts are not the ones main holds`;
    for (const r of (JSON.parse(v.toString("utf8")) as { rows: { row: number; sha256: string }[] }).rows) {
      const f = view.file(commit, `batches/89-${l.id}/${r.row}.json`);
      if (f === null || sha256(f) !== r.sha256) return `batch #89 ${l.id} row ${r.row}'s record is not the one its verdicts list`;
    }
  }
  return null;
}

/** Every row record of this measurement's batches, from the sandbox (checked first by `recordsProblem`). */
export function recordsOf(view: SandboxView, commit: string, lines: readonly { measurement: string; id: string }[]): RowRecord[] {
  const out: RowRecord[] = [];
  for (const l of lines.filter((x) => x.measurement === "#89")) {
    const v = JSON.parse(view.file(commit, `batches/89-${l.id}.json`)!.toString("utf8")) as { rows: { row: number }[] };
    for (const r of v.rows) out.push(JSON.parse(view.file(commit, `batches/89-${l.id}/${r.row}.json`)!.toString("utf8")) as RowRecord);
  }
  return out;
}

/**
 * The frozen targets of `side`, checked: on sealed, `frozen.json`'s line names the file and its sha256;
 * the verdicts it was taken from are main's; its cases are the ones worked out again from the verdicts and
 * the split. Returns them, or why not.
 */
export function frozenProblem(frozenFile: Buffer | null, frozenLine: { file: string; sha256: string } | undefined, verdicts: Record<string, string>, expected: readonly number[]): string | TargetRecord[] {
  if (frozenFile === null) return "the frozen targets are not in the sandbox";
  if (frozenLine !== undefined && sha256(frozenFile) !== frozenLine.sha256) return "the frozen targets are not the ones main holds";
  const f = JSON.parse(frozenFile.toString("utf8")) as { verdicts: Record<string, string>; cases: TargetRecord[] };
  for (const [id, sha] of Object.entries(verdicts)) if (f.verdicts[id] !== sha) return `the frozen targets were taken from other verdicts of batch #89 ${id}`;
  const rows = f.cases.map((c) => c.row);
  if (JSON.stringify(rows) !== JSON.stringify([...expected])) return "the frozen cases are not the ones the verdicts and the split give";
  return f.cases;
}

/** A case's `case.json` and `spec.json`, #80's shape: the target once for each requirement, the score's own match. */
export function caseFiles(t: TargetRecord, rec: RowRecord, side: "sealed" | "dev") {
  const requirements = rec.requirement === "written" && rec.requirements ? rec.requirements.map((r, i) => ({ id: `R${i + 1}`, text: r.text })) : [];
  const targets = t.target === null ? {} : Object.fromEntries(requirements.map((r) => [`T-${r.id}`, { requirementId: r.id, file: t.target!.file, function: t.target!.function, call: t.target!.call }]));
  const id = `c89-${t.row}`;
  const caseFile = { id, repo: t.repo, role: side === "sealed" ? "unseen" : "regression", pr: t.origin, versions: { shipped: { base: t.landed?.base ?? "", head: t.landed?.head ?? "", targets, expected: Object.fromEntries(Object.keys(targets).map((k) => [k, "listed"])) } } };
  return { id, caseFile, spec: { requirements } };
}

/** Lays out and clones every opened case; a case whose O cannot be read is laid out without a clone. */
export function layOut(targets: readonly TargetRecord[], records: readonly RowRecord[], side: "sealed" | "dev", work: Work): RetroCase[] {
  const byRow = new Map(records.map((r) => [r.row, r]));
  return targets.map((t) => {
    const rec = byRow.get(t.row)!;
    const { id, caseFile, spec } = caseFiles(t, rec, side);
    const dir = join(work.cases, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "case.json"), `${JSON.stringify(caseFile, null, 2)}\n`);
    writeFileSync(join(dir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
    const base: RetroCase = { repo: t.repo.toLowerCase(), order: t.row, id, caseFile: caseFile as unknown as CheckedCase["caseFile"], clone: "", target: t.target, ...(t.why ? { whyNotNamed: t.why } : {}), requirements: spec.requirements, originBy: (rec.origin as { by?: string } | undefined)?.by ?? "unknown", landed: t.landed };
    if (t.landed === null || spec.requirements.length === 0) return base;
    return { ...base, clone: prepareClone(base, work).clone };
  });
}

/** The number of files of each name at `head`, for the one-segment file rule. */
export function namesAt(clone: string, head: string): (name: string) => boolean {
  const files = execFileSync("git", ["-C", clone, "ls-tree", "-r", "--name-only", head], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
  const count = new Map<string, number>();
  for (const f of files) count.set(f.split("/").at(-1)!, (count.get(f.split("/").at(-1)!) ?? 0) + 1);
  return (name) => count.get(name) === 1;
}

export interface RetroMeasured {
  jev: AcceptanceLog;
  cases: ScoredCase[];
  failures: string[];
}

type Measure = (id: string, clone: string, limit: number, log: { file: string; cases: string }, opts: { always?: boolean; perRun?: number }) => Promise<void>;
type Enumerate = (clone: string, base: string, head: string, specFile: string) => Promise<{ requirementId: string; wouldAsk: Call[] }[]>;

/**
 * The run: the tool three times on every case with a requirement (`always`: a target outside the budget,
 * or none, is run all the same), every requirement enumerated, then the calls that are not the target
 * adjudicated against the first requirement they were listed under.
 */
export async function measureRetro(work: Work, cases: readonly RetroCase[], limit: number, measure: Measure, enumerate: Enumerate, adj: typeof adjudicate = adjudicate): Promise<RetroMeasured> {
  const jevFile = join(work.root, "jev.json");
  writeFileSync(jevFile, `${JSON.stringify({ conditions: {}, cases: {} })}\n`);
  const run = cases.filter((c) => c.requirements.length > 0 && c.clone !== "");
  // A run's most requests is its spec's requirements', targets or not: a case without a named target has none.
  const { perRunOf } = await import("../../acceptance/run.ts");
  for (const c of run) await measure(c.id, c.clone, limit, { file: jevFile, cases: work.cases }, { always: true, perRun: perRunOf(c.requirements.length) });
  const jev = JSON.parse(readFileSync(jevFile, "utf8")) as AcceptanceLog;
  const empty = mkdtempSync(join(tmpdir(), "jev-retro-empty-"));
  assertEmptyDir(empty);
  const { fail, failures } = stopRule();
  const scored: ScoredCase[] = [];
  const adjFile = join(work.root, "adjudication.json");
  const adjBook: Record<string, unknown> = {};
  for (const c of cases) {
    const base: ScoredCase = { row: c.order, originBy: c.originBy, hasRequirement: c.requirements.length > 0, target: c.target, ...(c.whyNotNamed ? { whyNotNamed: c.whyNotNamed } : {}), covered: false, runs: [], adjudicated: [] };
    if (!run.includes(c)) {
      scored.push(base);
      continue;
    }
    const v = jev.cases[c.id]?.versions.shipped;
    if (v === undefined) throw new StopRun(`${c.id} was not measured`);
    const only = namesAt(c.clone, c.landed!.head);
    const runs: ScoredRun[] = (v.runs as (typeof v.runs[number] & { requests?: number; bytes?: number; started?: string; ended?: string })[]).map((r) => ({
      finished: r.finished,
      requests: r.requests ?? 0,
      bytes: r.bytes ?? 0,
      seconds: r.started && r.ended ? (Date.parse(r.ended) - Date.parse(r.started)) / 1000 : null,
      listed: r.requirements.flatMap((q) => q.findings.map((f) => ({ file: f.file, function: f.function, call: f.call, requirementId: q.requirementId }))),
    }));
    const specFile = join(work.cases, c.id, "spec.json");
    const enumeration = await enumerate(c.clone, c.landed!.base, c.landed!.head, specFile);
    const covered = c.target !== null && enumeration.some((e) => e.wouldAsk.some((w) => matches(w, c.target!, only)));
    // The calls to adjudicate: the union over finished runs, not the target, each under the first requirement it was listed under.
    const firstReq = new Map<string, { call: Call; requirementId: string; claim: string }>();
    const order = c.requirements.map((r) => r.id);
    for (const r of v.runs.filter((x) => x.finished)) {
      for (const q of r.requirements) {
        for (const f of q.findings) {
          if (c.target !== null && matches(f, c.target, only)) continue;
          const k = keyOf(f);
          const had = firstReq.get(k);
          if (had === undefined || order.indexOf(q.requirementId) < order.indexOf(had.requirementId)) {
            const obs = q.observed.find((o) => o.file === f.file && o.function === f.function && o.call === f.call)?.result.observation ?? "";
            firstReq.set(k, { call: { file: f.file, function: f.function, call: f.call }, requirementId: q.requirementId, claim: obs });
          }
        }
      }
    }
    const adjudicated: ScoredCase["adjudicated"] = [];
    const book: Record<string, unknown> = {};
    for (const req of c.requirements) {
      const mine = [...firstReq.values()].filter((x) => x.requirementId === req.id);
      if (mine.length === 0) continue;
      const items: Item[] = itemsOf([], [mine.map((m) => ({ ...m.call, requirementId: req.id, observation: m.claim }))], []);
      const out = adj(items, req.text, c.clone, c.landed!.head, empty, fail(`${c.id} ${req.id} adjudication`));
      book[req.id] = out;
      for (const it of items) adjudicated.push({ call: { file: it.file, function: it.function, call: it.call }, label: out.decided[it.n] ?? "cannot_decide" });
    }
    adjBook[c.id] = book;
    writeFileSync(adjFile, `${JSON.stringify(adjBook, null, 2)}\n`);
    const foundAtHead = c.target === null ? undefined : foundAt(c.clone, c.landed!.head, c.target, only);
    const inDiff = c.target === null ? undefined : execFileSync("git", ["-C", c.clone, "diff", "--name-only", c.landed!.base, c.landed!.head], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean).some((p) => sameFile(p, c.target!.file, only));
    scored.push({ ...base, covered, runs, adjudicated, ...(inDiff === undefined ? {} : { inDiff }), ...(foundAtHead === undefined ? {} : { foundAtHead }) });
  }
  writeFileSync(join(work.root, "scored.json"), `${JSON.stringify(scored, null, 2)}\n`);
  return { jev, cases: scored, failures };
}

/**
 * Whether the target is in O's head before measuring (RETRO.md v7): a file whose path ends with the
 * target's, `fn <name>` in it, and the call in it. ponytail: the call is looked for in the file, not in
 * that function's body; a parse of the function would narrow it. It only sorts a case into a count.
 */
export function foundAt(clone: string, head: string, target: Call, only: (name: string) => boolean): boolean {
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const fn = target.function.split("::").at(-1)!.trim();
  const call = normalCall(target.call).name;
  return git("ls-tree", "-r", "--name-only", head)
    .split("\n")
    .filter((p) => p !== "" && sameFile(p, target.file, only))
    .some((p) => {
      const text = git("show", `${head}:${p}`);
      return new RegExp(`\\bfn\\s+${fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text) && text.replace(/\s+/g, "").includes(call);
    });
}

/** The strings a report may hold: its own words, never a case's. Every key and string is one of these or a number's key. */
const NOT_NAMED: readonly NotNamed[] = ["the checker does not agree", "no call is named", "a call without (", "a request over the size", "an answer never counted", "no file of the fix at O's head", "O cannot be read"];
const ORIGIN_BY = ["named", "blame", "unknown"];
const VALUES = ["#89", "sealed", "dev"];

/** Screening counts of a side (RETRO.md "Reported with every result"): its cases caught before the merge, and with checks unknown. */
export function screenedOf(records: readonly RowRecord[], split: Pick<Split, "repos">, side: "sealed" | "dev") {
  const onSide = new Set(split.repos.filter((e) => e.batch?.measurement === "#89" && e.side === side).map((e) => e.repo.toLowerCase()));
  const cases = records.filter((r) => r.outcome === "case" && onSide.has(r.repo.toLowerCase()));
  return { cases: cases.length, caughtBeforeMerge: cases.filter((r) => r.caught?.caught === true).length, checksUnknown: cases.filter((r) => r.caught?.checks === "unknown").length };
}

/**
 * The report: the score's numbers and what they rest on, nothing of a case. It is built from numbers and
 * fixed words only; every string in it is checked against those words, so a case's text cannot get in.
 */
export function reportOf(m: RetroMeasured, cases: readonly RetroCase[], side: "sealed" | "dev", onlyOfName: (row: number) => (name: string) => boolean, screened: ReturnType<typeof screenedOf> | null = null) {
  const out = { measurement: "#89", retroVersion: RETRO_VERSION, side, repositories: new Set(cases.map((c) => c.repo)).size, score: score(m.cases, onlyOfName), screened, adjudicationFailures: m.failures.length };
  const bad: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") {
      if (!VALUES.includes(v)) bad.push(at);
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (at === "score.notNamed" && !(NOT_NAMED as readonly string[]).includes(k)) bad.push(at);
        if (at === "score.byOrigin" && !ORIGIN_BY.includes(k)) bad.push(at);
        walk(x, at === "" ? k : `${at}.${k}`);
      }
    }
  };
  walk(out, "");
  if (bad.length > 0) throw new Error(`the report holds words that are not its own at ${[...new Set(bad)].join(", ")}; nothing is written`);
  return out;
}

/** The opened rows worked out again: sealed (or dev), not caught before the merge, by row, the first 17 (dev: all). */
export function expectedRows(records: readonly RowRecord[], split: Pick<Split, "repos">, side: "sealed" | "dev"): number[] {
  return casesToOpen(records, split, side, side === "sealed" ? OPENED : null).map((c) => c.row);
}

/** The files a #89 opening and its run are held to. */
export const DECIDING = ["bench/eval/run.ts", "bench/eval/sealed.ts", "bench/eval/adjudicate.ts", "bench/eval/metrics.ts", "bench/eval/split.ts", "bench/eval/baseline.ts", "bench/eval/compare.ts", "bench/eval/json-in.ts", "bench/eval/n1.ts", "bench/eval/sealed-batches.json", "bench/eval/retro/frozen.json", "bench/eval/retro/run89.ts", "bench/eval/retro/score.ts", "bench/eval/retro/target.ts", "bench/eval/retro/screen.ts", "bench/acceptance/run.ts", "bench/acceptance/score.ts", "bench/acceptance/replay.ts"] as const;

