// The frontier-model baseline of #88 (bench/eval/BASELINE.md): the same requirement, diff and commit as
// jev-intent-review, with material gathered by a fixed rule up to the bytes jev-intent-review sent,
// given in one request to Claude Opus 5.5 through `claude -p` with no tools.
//
//   node bench/eval/baseline.ts dev <clones> [<case> [<version>]]   one run per defect, shipped and rewrite
//                                              version of the dev cases, into bench/eval/logs/baseline-dev-v1.json
//
// `<clones>` holds a clone per repository (`moltis`, `grovedb`, …) with every version's commits.
// Nothing here runs on the sealed set: that goes through `run.ts --set sealed` (BASELINE.md, "Sealed").

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedFunctions } from "../acceptance/changed-functions.ts";
import { loadCases } from "../acceptance/replay.ts";
import type { AcceptanceLog } from "../acceptance/replay.ts";
import type { CaseFile, Target } from "../acceptance/score.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const BASELINE_VERSION = 1;
export const MODEL = "claude-opus-5-5";
export const EFFORT = "high";
/** Findings kept per run, for both systems (BASELINE.md, "Findings"). */
export const MAX_FINDINGS = 5;

/** Words of a requirement that do not pick files (BASELINE.md, "Material", step 5). */
export const STOPWORDS = new Set(
  "the and for not must from into that this with when then than have has had was were are its it's any all only also each which what where while their them they there these those been being does done must should would could will shall may might can cannot error errors fail fails failed failure failures caller callers return returns returned result results success successful value values empty absence reach reaches".split(
    " ",
  ),
);

export const SYSTEM_PROMPT =
  "You review a code change against one requirement. You are given the requirement, the diff, and files of the repository after the change. " +
  "Report the places where the code after the change does not satisfy the requirement. Answer only with a JSON array, no prose.";

export function userPrompt(requirement: string, material: string): string {
  return [
    `Requirement: ${requirement}`,
    "",
    `List at most ${MAX_FINDINGS} places in the code after the change where this requirement is not met. For each, give the file path, the name of the function, the call expression whose failure is mishandled exactly as it is written in the code, and one sentence saying what happens when that call fails.`,
    'Answer with a JSON array of objects {"file": string, "function": string, "call": string, "claim": string}, most certain first. Answer [] if every place meets the requirement.',
    "",
    material,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Material.

/** What the material rule reads from a repository. A test puts a fake in. */
export interface Repo {
  diff(base: string, head: string): string;
  /** The text of `path` at `rev`, or null when it is not there. */
  read(rev: string, path: string): string | null;
  /** Paths at `rev` containing `word` as a whole word, among Rust files. */
  grep(rev: string, word: string): string[];
  /** `path · name` of each function the change touched. */
  changed(base: string, head: string): string[];
}

export interface Part {
  step: 1 | 2 | 3 | 4 | 5;
  path?: string;
  bytes: number;
}

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

/** The requirement's words that pick files in step 5: 3 letters or more, not stop words, once each. */
export function requirementWords(requirement: string): string[] {
  const words = (requirement.toLowerCase().match(/[a-z][a-z_]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * The material, in the order of BASELINE.md: the requirement, the diff, the files of the changed
 * functions, the files that name a changed function (the rarest names first), the files the requirement's words hit
 * (most distinct words first, then by path). Each file once and whole: a file that does not fit is
 * skipped and the next one tried, so a large file early on does not leave the rest of the budget unused
 * (on dev, stopping at the first one left 7-35 % of it). If the requirement or the diff does not fit,
 * nothing after it is given.
 */
export function gather(repo: Repo, requirement: string, base: string, head: string, budget: number): { text: string; parts: Part[]; bytes: number; skipped: Part[]; stoppedAt?: Part } {
  const chunks: string[] = [];
  const parts: Part[] = [];
  const skipped: Part[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  const put = (step: Part["step"], text: string, path?: string): boolean => {
    const b = byteLength(text);
    if (bytes + b > budget) return false;
    chunks.push(text);
    parts.push({ step, ...(path === undefined ? {} : { path }), bytes: b });
    bytes += b;
    return true;
  };
  const stop = (step: Part["step"], text: string, path?: string) => ({ text: chunks.join("\n"), parts, bytes, skipped, stoppedAt: { step, ...(path === undefined ? {} : { path }), bytes: byteLength(text) } });
  const file = (path: string) => {
    const t = repo.read(head, path);
    return t === null ? null : `--- file: ${path}\n${t}\n`;
  };

  const req = `--- requirement\n${requirement}\n`;
  if (!put(1, req)) return stop(1, req);
  const diff = `--- diff ${base.slice(0, 12)}..${head.slice(0, 12)}\n${repo.diff(base, head)}\n`;
  if (!put(2, diff)) return stop(2, diff);

  const changed = repo.changed(base, head).map((s) => {
    const [path, name] = s.split(" · ");
    return { path: path!, name: name! };
  });
  // Step 4 takes the names that hit the fewest files first, each name's files by path: a changed
  // function named `name` or `id` hits hundreds of files, and by path alone they pushed moltis-1064's
  // caller (`handle_title`, 2 files) out of the budget.
  const callers = [...new Set(changed.map((c) => c.name))]
    .map((name) => ({ name, files: [...new Set(repo.grep(head, name))].sort() }))
    .sort((a, b) => a.files.length - b.files.length || a.name.localeCompare(b.name))
    .flatMap((n) => n.files);
  const lists: [Part["step"], string[]][] = [
    [3, [...new Set(changed.map((c) => c.path))].sort()],
    [4, [...new Set(callers)]],
  ];
  const words = requirementWords(requirement);
  const hits = new Map<string, number>();
  for (const w of words) for (const p of repo.grep(head, w)) hits.set(p, (hits.get(p) ?? 0) + 1);
  lists.push([5, [...hits.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([p]) => p)]);

  for (const [step, paths] of lists) {
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const t = file(path);
      if (t === null) continue;
      if (!put(step, t, path)) skipped.push({ step, path, bytes: byteLength(t) });
    }
  }
  return { text: chunks.join("\n"), parts, bytes, skipped };
}

export const gitRepo = (clone: string): Repo => {
  const git = (args: string[]) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return {
    diff: (base, head) => git(["diff", "--no-color", base, head]),
    read: (rev, path) => {
      try {
        return git(["show", `${rev}:${path}`]);
      } catch {
        return null;
      }
    },
    grep: (rev, word) => {
      try {
        return git(["grep", "-l", "-w", "-F", word, rev, "--", "*.rs"])
          .split("\n")
          .filter(Boolean)
          .map((l) => l.slice(rev.length + 1));
      } catch {
        return []; // git grep exits 1 when nothing matches
      }
    },
    changed: (base, head) => changedFunctions(clone, base, head),
  };
};

// ---------------------------------------------------------------------------------------------
// One run.

export interface Finding {
  file: string;
  function: string;
  call: string;
  claim: string;
}

export interface BaselineRun {
  /** Counted: the model asked answered, and its answer was a readable array. */
  counted: boolean;
  why?: string;
  findings: Finding[];
  /** How many the answer listed before the cap of five. */
  listed: number;
  model: string[];
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
}

/** The array in a model's answer, with a code fence around it or not. */
export function readFindings(result: string): Finding[] | null {
  const body = result.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Finding[] = [];
  for (const x of parsed) {
    if (typeof x !== "object" || x === null) return null;
    const { file, function: fn, call, claim } = x as Record<string, unknown>;
    if (typeof file !== "string" || typeof fn !== "string" || typeof call !== "string" || typeof claim !== "string") return null;
    out.push({ file, function: fn, call, claim });
  }
  return out;
}

/** What `claude -p --output-format json` printed, read into a run. */
export function readRun(stdout: string): BaselineRun {
  let j: { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }; modelUsage?: Record<string, unknown> };
  try {
    j = JSON.parse(stdout);
  } catch {
    return { counted: false, why: "the output was not JSON", findings: [], listed: 0, model: [], costUsd: null, inputTokens: null, outputTokens: null, durationMs: null };
  }
  const model = Object.keys(j.modelUsage ?? {}).sort();
  // With prompt caching most of the input is in the cache fields: input_tokens alone was 2 on dev.
  const u = j.usage;
  const inputTokens = u?.input_tokens === undefined ? null : u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const base = { model, costUsd: j.total_cost_usd ?? null, inputTokens, outputTokens: j.usage?.output_tokens ?? null, durationMs: j.duration_ms ?? null };
  // A run another model answered is not a run of the baseline (BASELINE.md, "The baseline").
  if (model.length !== 1 || model[0] !== MODEL) return { counted: false, why: `answered by ${model.join(", ") || "no model"}, not ${MODEL}`, findings: [], listed: 0, ...base };
  if (j.is_error === true || typeof j.result !== "string") return { counted: false, why: "the run ended in an error", findings: [], listed: 0, ...base };
  const findings = readFindings(j.result);
  if (findings === null) return { counted: false, why: "the answer was not a JSON array of findings", findings: [], listed: 0, ...base };
  return { counted: true, findings: findings.slice(0, MAX_FINDINGS), listed: findings.length, ...base };
}

/**
 * The command line, in the empty directory `cwd`: no tools, no MCP, no user settings, a fixed system
 * prompt — the baseline's unless another is given (the annotators of `retro/prompts.ts`, #89, run the same way).
 */
export function claudeArgs(prompt: string, systemPrompt: string = SYSTEM_PROMPT): string[] {
  return ["-p", prompt, "--model", MODEL, "--effort", EFFORT, "--tools", "", "--strict-mcp-config", "--system-prompt", systemPrompt, "--setting-sources", "project", "--no-session-persistence", "--output-format", "json"];
}

/**
 * Refuses a directory where a repository or settings would reach the model: one that holds `.git` or
 * `.claude`, or that is inside a repository — `claude` finds a repository and its `CLAUDE.md` above the
 * directory it starts in.
 */
export function assertEmptyDir(cwd: string): void {
  if (existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".claude"))) throw new Error(`${cwd} must be an empty directory: a repository or settings there would reach the model`);
  for (let dir = resolve(cwd); dirname(dir) !== dir; dir = dirname(dir)) {
    const up = dirname(dir);
    if (existsSync(join(up, ".git"))) throw new Error(`${cwd} is inside a repository (${up}): its branch and CLAUDE.md would reach the model`);
    if (existsSync(join(up, "CLAUDE.md")) || existsSync(join(up, ".claude"))) throw new Error(`${cwd} is under ${up}, whose CLAUDE.md or .claude would reach the model`);
  }
}

export function runClaude(prompt: string, cwd: string): BaselineRun {
  assertEmptyDir(cwd);
  const r = spawnSync("claude", claudeArgs(prompt), { cwd, encoding: "utf8", input: "", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
  if (r.status !== 0) return { counted: false, why: `claude exited ${r.status}`, findings: [], listed: 0, model: [], costUsd: null, inputTokens: null, outputTokens: null, durationMs: null };
  return readRun(r.stdout);
}

// ---------------------------------------------------------------------------------------------
// Dev.

/** The bytes jev-intent-review sent for a version: the median of its finished runs. */
export function budgetOf(runs: readonly { finished: boolean; bytes?: number }[]): number | null {
  const b = runs.filter((r) => r.finished && typeof r.bytes === "number").map((r) => r.bytes!).sort((x, y) => x - y);
  if (b.length === 0) return null;
  const mid = Math.floor(b.length / 2);
  return b.length % 2 === 1 ? b[mid]! : Math.floor((b[mid - 1]! + b[mid]!) / 2);
}

/** The one requirement a version's targets name, from its case's spec.json (under `cases`, the acceptance cases by default). */
export const requirementOf = (c: CaseFile, targets: Record<string, Target>, cases = join(HERE, "..", "acceptance", "cases")): { id: string; text: string } => {
  const spec = JSON.parse(readFileSync(join(cases, c.id, "spec.json"), "utf8")) as { requirements: { id: string; text: string }[] };
  const ids = new Set(Object.values(targets).map((t) => t.requirementId));
  if (ids.size !== 1) throw new Error(`${c.id}: a version's targets name ${ids.size} requirements; the baseline asks one at a time`);
  const r = spec.requirements.find((x) => x.id === [...ids][0])!;
  return { id: r.id, text: r.text };
};

async function dev(clones: string, only?: string, onlyVersion?: string) {
  const log = JSON.parse(readFileSync(join(HERE, "..", "logs", "acceptance-v4.json"), "utf8")) as AcceptanceLog;
  const out = join(HERE, "logs", "baseline-dev-v1.json");
  mkdirSync(join(HERE, "logs"), { recursive: true });
  const book: Record<string, unknown> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { baselineVersion: BASELINE_VERSION, model: MODEL, effort: EFFORT, budgetFrom: "bench/logs/acceptance-v4.json", cases: {} };
  const cases = book.cases as Record<string, Record<string, unknown>>;
  // An empty directory that is not a repository: the model sees no branch name, git status or CLAUDE.md.
  const empty = mkdtempSync(join(tmpdir(), "jev-baseline-"));
  for (const c of loadCases().filter((x) => (only === undefined || x.id === only) && log.cases[x.id] !== undefined)) {
    const clone = join(clones, c.id.replace(/-\d+$/, ""));
    for (const [versionId, v] of Object.entries(c.versions)) {
      if (!/^(shipped|defect-[AB]|rewrite-[AB])$/.test(versionId) || (onlyVersion !== undefined && versionId !== onlyVersion)) continue;
      if ((cases[c.id] as Record<string, unknown> | undefined)?.[versionId] !== undefined) continue;
      const budget = budgetOf(log.cases[c.id]!.versions[versionId]?.runs ?? []);
      if (budget === null) continue;
      const req = requirementOf(c, v.targets);
      const material = gather(gitRepo(clone), req.text, v.base, v.head, budget);
      const run = runClaude(userPrompt(req.text, material.text), empty);
      (cases[c.id] ??= {})[versionId] = { base: v.base, head: v.head, requirementId: req.id, budget, material: { bytes: material.bytes, parts: material.parts, skipped: material.skipped.length, stoppedAt: material.stoppedAt ?? null }, runs: [run] };
      writeFileSync(out, `${JSON.stringify(book, null, 2)}\n`);
      console.log(`${c.id} ${versionId}: ${material.bytes}/${budget} bytes, counted=${run.counted}${run.why ? ` (${run.why})` : ""}, ${run.findings.length} findings, $${run.costUsd}`);
    }
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, clones, only, onlyVersion] = process.argv.slice(2);
  if (mode === "dev" && clones) await dev(clones, only, onlyVersion);
  else {
    console.error("usage: baseline.ts dev <clones> [<case> [<version>]]");
    process.exitCode = 2;
  }
}
