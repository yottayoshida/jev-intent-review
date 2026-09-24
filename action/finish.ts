// The Action's last step (ADR 0009): reads the command's JSON and puts the report where a maintainer
// reads it — a check run, the job summary, and the files the artifact uploads — and writes nothing
// for the log but sentences made here.
//
//   node action/finish.ts                        run by action/run.sh, with the environment below
//   node action/finish.ts --source-hash <dir>    print the hash of <dir>/src, to compare a run with a ref
//
// Environment: JEV_WORK (the working directory run.sh made: stdout.json, stderr.txt, exit-code),
// GITHUB_STEP_SUMMARY, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_WORKSPACE,
// CHECK_TOKEN (the job's own token: only a GitHub App's token can create a check run),
// INPUT_GITHUB_TOKEN, ACTION_PATH, ACTION_REF, ARTIFACT_NAME, and the judgment keys under their own
// names, which are only ever read here to take them out of what is written.
//
// What this writes for the log goes to JEV_WORK/log.txt and run.sh prints it: every line there is
// made in this file from fixed words and numbers. Nothing from the report, the command's stderr or an
// API's answer is put in it, and a failure is said by the stage it happened in, never by its message
// (a JSON parse error, for one, quotes its input).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JUDGMENT_ENV } from "../src/judgments/client.ts";
import { codeBlock, leftParts, plural, renderMarkdown, resultKind, type ResultKind } from "../src/report/markdown.ts";
import { EXIT, type ReviewReport, type SkipKind } from "../src/types.ts";

export const CHECK_NAME = "jev-intent-review result";
/** The job summary's limit is 1 MiB, and a check run's summary 65,535; both are counted in bytes here. */
export const SUMMARY_LIMIT = 1024 * 1024 - 4096;
export const CHECK_SUMMARY_LIMIT = 65_535 - 1024;
export const ANNOTATIONS_PER_REQUEST = 50;

export type Conclusion = "success" | "neutral" | "failure";
export interface Outcome {
  conclusion: Conclusion;
  /** Fixed words and numbers only: it goes into the check run's title and, sometimes, the log. */
  title: string;
  /** Whether at least one call was read: the report's first line is "… of N read". */
  checked: boolean;
}

// What a run left is counted once, in the report's module, for its first line and this title (#38).
export { withoutAnswer } from "../src/report/markdown.ts";

/**
 * Why the run asked nothing, in the title's words. Read from `skipKind`, never from the wording of
 * `skipReason` (ADR 0010): three of these sentences begin the same way, and a title decided by their
 * first words would say "no credentials" for a pull request no key can help. A kind this does not
 * know — an older report, a newer command — falls through to the summary rather than guessing.
 */
function skipped(kind: SkipKind | undefined): string {
  switch (kind) {
    case "fork":
      return "this pull request is from another repository, which gets no secrets";
    case "dependabot":
      return "Dependabot pull requests get no secrets";
    case "no_credentials":
      return "no credentials";
    case "no_intent":
      return "no source of requirements";
    default:
      return "see the job summary";
  }
}

function titleOf(report: ReviewReport, kind: ResultKind, exitCode: number): string {
  if (exitCode === EXIT.intent) return "Requirements could not be read";
  switch (kind.kind) {
    case "skipped":
      return `Nothing was checked: skipped (${skipped(report.skipKind)})`;
    // Told apart from the skip above: there the sources were not there at all, here they were read
    // and hold no requirement in either documented form.
    case "no_requirement":
      return "Nothing was checked: no requirement in the sources";
    case "nothing_asked":
      return `Nothing was asked: ${plural(kind.inBudget, "call")} in the budget, ${kind.notChecked} not checked`;
    case "none_read":
      return kind.notChecked > 0 ? `No call was read: ${kind.notChecked} not checked` : "No call was read";
    case "read": {
      const parts = [kind.worthChecking > 0 ? `${plural(kind.worthChecking, "call")} worth checking of ${kind.read} read` : `${plural(kind.read, "call")} read, none worth checking`];
      parts.push(...leftParts(report));
      if (report.unexpectedChanges.length > 0) parts.push(`${plural(report.unexpectedChanges.length, "change")} no requirement asked for`);
      return parts.join(", ");
    }
  }
}

/**
 * The check run's conclusion, from the same reading of the report as its first line (ADR 0009): red
 * when the command did not exit 0, green only when calls were read and nothing is left to look at,
 * and neutral for everything else — above all for a run that read no call.
 */
export function conclude(report: ReviewReport | undefined, exitCode: number): Outcome {
  if (report === undefined) return { conclusion: "failure", title: `Stopped before a report (exit ${exitCode})`, checked: false };
  const kind = resultKind(report);
  const checked = kind.kind === "read";
  const title = titleOf(report, kind, exitCode);
  if (exitCode !== EXIT.ok) return { conclusion: "failure", title, checked };
  if (kind.kind !== "read") return { conclusion: "neutral", title, checked };
  // Nothing left: no call not checked, none without an answer, no note on what was not read (#38).
  const clean = kind.worthChecking === 0 && leftParts(report).length === 0 && report.unexpectedChanges.length === 0;
  return { conclusion: clean ? "success" : "neutral", title, checked };
}

/**
 * Cut `text` to at most `limit` bytes at a line boundary, closing a code block left open, and say
 * where the rest is.
 */
export function truncate(text: string, limit: number, rest: string): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const room = limit - Buffer.byteLength(rest) - 16;
  const kept: string[] = [];
  let used = 0;
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const size = Buffer.byteLength(line) + 1;
    if (used + size + (fence === undefined ? 0 : fence.length + 1) > room) break;
    kept.push(line);
    used += size;
    if (fence === undefined) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) fence = open[1];
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]?.[0] === fence[0] && (close[1]?.length ?? 0) >= fence.length) fence = undefined;
    }
  }
  if (fence !== undefined) kept.push(fence);
  return `${kept.join("\n")}\n\n${rest}\n`;
}

/**
 * The values to take out of everything written: every key and token the Action was given, as they
 * were written. A value the report holds in another form — encoded, or in pieces — is not found
 * this way; no path from a key to the report is known, and the report names the endpoint by its
 * origin alone (`src/judgments/client.ts`), which is why the host's name and URL stay readable.
 */
export function secretsOf(env: NodeJS.ProcessEnv): string[] {
  const named = new Set<string>(["JEV_PROVIDER", "JEV_API_URL"]);
  const values = [...JUDGMENT_ENV.filter((name) => !named.has(name)).map((name) => env[name]), env.INPUT_GITHUB_TOKEN, env.CHECK_TOKEN];
  // A value holding a quote or a backslash is spelled differently inside report.json, so both
  // spellings are taken out. Under four characters is not a key and would blank ordinary words.
  const both = values.flatMap((value) => {
    const v = value?.trim() ?? "";
    const escaped = JSON.stringify(v).slice(1, -1);
    return v === escaped ? [v] : [v, escaped];
  });
  // Longest first, so a value that contains another is taken out whole.
  return [...new Set(both.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("***");
  return out;
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "warning";
  title: string;
  message: string;
}

/**
 * One annotation per finding, on its function's lines — only where the file is the same at the pull
 * request's head as at the merge commit the lines were read from, so the mark lands where it points.
 */
export function annotationsOf(report: ReviewReport, sameFile: (path: string) => boolean): { annotations: Annotation[]; elsewhere: number } {
  const annotations: Annotation[] = [];
  let elsewhere = 0;
  // A function's name, a call's text and a path are as long as the repository makes them, and the
  // API refuses a message over 64 KB — one long name would cost the whole check run.
  const cut = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);
  for (const r of report.requirements) {
    for (const f of r.findings) {
      const lines = /^(\d+)-(\d+)$/.exec(f.lines);
      // A path git would read as a pathspec of its own (`:(exclude)…`) is not asked about.
      if (!lines || f.file.length > 512 || f.file.startsWith(":") || !sameFile(f.file)) {
        elsewhere += 1;
        continue;
      }
      annotations.push({
        path: f.file,
        start_line: Number(lines[1]),
        end_line: Number(lines[2]),
        annotation_level: "warning",
        title: "Worth checking",
        message: cut(`${cut(f.function, 200)} calls ${cut(f.call, 400)}, which requirement ${cut(f.requirementId, 60)} is read as governing. See the check run's summary for the readings.`, 4000),
      });
    }
  }
  return { annotations, elsewhere };
}

/** A hash of every file under `dir/src`, by path and content, so a run can be matched to a ref. */
export function sourceHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (at: string, rel: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const relative = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, relative);
      else {
        hash.update(`${relative}\0`);
        // A symbolic link is hashed by what it is, never followed: under `uses: ./` the tree is the
        // pull request's.
        hash.update(stat.isFile() ? readFileSync(path) : "(not a regular file)");
        hash.update("\0");
      }
    }
  };
  walk(join(dir, "src"), "");
  return hash.digest("hex");
}

/** The Action's inputs for the names the command's messages use. */
const INPUT_NAMES = JUDGMENT_ENV.map((name) => `\`${name.toLowerCase().replaceAll("_", "-")}\` for ${name}`).join(", ");

function stoppedReport(exitCode: number, stderr: string): string {
  return ["# jev-intent-review", "", `**Result: the command stopped before a report (exit ${exitCode}).**`, "", "What it wrote to stderr:", "", codeBlock(stderr.trim() === "" ? "(nothing)" : stderr.trim()), ""].join("\n");
}

const printable = (value: string | undefined) => (value && /^[\w.\-/@]{1,200}$/.test(value) ? value : undefined);

export interface Deps {
  fetch: typeof fetch;
  /** Whether a path is the same at two commits: `git diff --quiet a b -- path`. */
  sameAt: (a: string, b: string, path: string) => boolean;
}

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Whether a path is the same at two commits. Both commits are checked before git sees them: they
 * come from the event file and from the report, and a value beginning with `-` in front of `--`
 * would be read as an option of git's.
 */
export const gitSameAt =
  (cwd: string, run: (args: string[]) => void = (args) => execFileSync("git", args, { cwd, stdio: "ignore" })) =>
  (a: string, b: string, path: string) => {
    if (!COMMIT.test(a) || !COMMIT.test(b)) return false;
    try {
      run(["diff", "--quiet", a, b, "--", path]);
      return true;
    } catch {
      return false;
    }
  };

/** What became of the check run. `partial` is created, with some annotations left off. */
type CheckRunResult = "created" | "partial" | "not_permitted" | "not_sent" | "failed";

async function createCheckRun(deps: Deps, env: NodeJS.ProcessEnv, headSha: string, outcome: Outcome, summary: string, annotations: Annotation[]): Promise<CheckRunResult> {
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const repository = env.GITHUB_REPOSITORY;
  const token = env.CHECK_TOKEN;
  // Nothing was sent, so nothing was refused: said apart from a refusal, which is the reader's cue
  // to look at the workflow rather than at their permissions.
  if (!repository || !token || !COMMIT.test(headSha)) return "not_sent";
  const call = (method: string, path: string, body: unknown) =>
    deps.fetch(`${api}/repos/${repository}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const output = (chunk: Annotation[]) => ({ title: outcome.title, summary, annotations: chunk });
  const created = await call("POST", "check-runs", { name: CHECK_NAME, head_sha: headSha, status: "completed", conclusion: outcome.conclusion, output: output(annotations.slice(0, ANNOTATIONS_PER_REQUEST)) });
  if (created.status === 403 || created.status === 404) return "not_permitted";
  if (created.status !== 201) return "failed";
  const id = ((await created.json()) as { id?: unknown }).id;
  if (typeof id !== "number") return "failed";
  // The rest of the annotations, fifty at a time: each update adds to the ones already there. The
  // check run exists from here on, so a failed update leaves it standing with fewer marks — it is
  // not "not created".
  for (let at = ANNOTATIONS_PER_REQUEST; at < annotations.length; at += ANNOTATIONS_PER_REQUEST) {
    const updated = await call("PATCH", `check-runs/${id}`, { output: output(annotations.slice(at, at + ANNOTATIONS_PER_REQUEST)) });
    if (updated.status !== 200) return "partial";
  }
  return "created";
}

const escapeData = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** What became of the check run, said the same way in the job summary and in the log. */
const CHECK_RUN_SAID: Record<CheckRunResult, string> = {
  created: `The check run "${CHECK_NAME}" holds the same report.`,
  partial: `The check run "${CHECK_NAME}" holds the same report; GitHub refused some of its marks on lines, which are in the report itself.`,
  not_permitted: "No check run was created: the workflow does not grant `checks: write`, or this pull request's token cannot write checks (a fork, Dependabot).",
  not_sent: "No check run was asked for: the pull request's head commit could not be read from the event.",
  failed: "No check run was created: GitHub did not accept it.",
};

export async function finish(env: NodeJS.ProcessEnv, deps: Deps): Promise<void> {
  const work = env.JEV_WORK;
  if (!work) throw new Error("JEV_WORK is not set");
  // The directory the artifact is uploaded from is made here and written only by this file: what is
  // in it has been through `redact`. run.sh does not make it, so nothing else can leave a file there.
  const out = join(work, "artifact");
  const log: string[] = [];
  const say = (line: string) => log.push(`jev-intent-review: ${line}`);
  let stage = "reading the command's output";
  let checked = false;
  try {
    mkdirSync(out, { recursive: true });
    const exitText = readFileSync(join(work, "exit-code"), "utf8").trim();
    const exitCode = /^\d{1,3}$/.test(exitText) ? Number(exitText) : EXIT.incomplete;
    const stdout = existsSync(join(work, "stdout.json")) ? readFileSync(join(work, "stdout.json"), "utf8") : "";
    const stderr = existsSync(join(work, "stderr.txt")) ? readFileSync(join(work, "stderr.txt"), "utf8") : "";
    let report: ReviewReport | undefined;
    let markdown: string;
    try {
      const parsed = JSON.parse(stdout) as ReviewReport;
      if (parsed?.version !== 2) throw new Error("not a version 2 report");
      markdown = renderMarkdown(parsed);
      report = parsed;
    } catch {
      report = undefined;
      markdown = stoppedReport(exitCode, stderr);
    }

    stage = "deciding the result";
    const outcome = conclude(report, exitCode);
    checked = outcome.checked;
    const secrets = secretsOf(env);
    const ref = printable(env.ACTION_REF) ?? "the workflow's own copy";
    const source = env.ACTION_PATH ? sourceHash(env.ACTION_PATH) : "unknown";

    // Only the redacted copies are written where the artifact is uploaded from: if anything below
    // fails, what is there has already been through `redact`.
    stage = "writing the artifact's files";
    const shown = redact(markdown, secrets);
    writeFileSync(join(out, "report.md"), shown);
    if (stdout !== "") writeFileSync(join(out, "report.json"), redact(stdout, secrets));
    writeFileSync(join(out, "stderr.txt"), redact(stderr, secrets));
    writeFileSync(join(out, "action.json"), `${JSON.stringify({ ref: env.ACTION_REF ?? "", sourceHash: source, exitCode, conclusion: outcome.conclusion, title: outcome.title, checked }, null, 2)}\n`);

    stage = "preparing the check run";
    const artifact = printable(env.ARTIFACT_NAME) ?? "jev-intent-review";
    const headSha = (() => {
      try {
        const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8")) as { pull_request?: { head?: { sha?: unknown } } };
        return typeof event.pull_request?.head?.sha === "string" ? event.pull_request.head.sha : "";
      } catch {
        return "";
      }
    })();
    const merge = report?.metadata.head ?? "";
    const { annotations, elsewhere } = report ? annotationsOf(report, (path) => headSha !== "" && merge !== "" && deps.sameAt(headSha, merge, path)) : { annotations: [], elsewhere: 0 };
    const moved = elsewhere > 0 ? `\n\n${plural(elsewhere, "call")} worth checking ${elsewhere === 1 ? "is" : "are"} in a file the merge commit changes from the pull request's head, so ${elsewhere === 1 ? "it is" : "they are"} listed above and not marked on a line.` : "";
    const rest = `The rest of the report is in the artifact \`${artifact}\`.`;
    const checkSummary = truncate(shown, CHECK_SUMMARY_LIMIT - Buffer.byteLength(moved), rest) + moved;
    const safeAnnotations = annotations.map((a) => ({ ...a, message: redact(a.message, secrets), path: redact(a.path, secrets) }));
    stage = "creating the check run";
    let run: CheckRunResult;
    try {
      run = await createCheckRun(deps, env, headSha, outcome, redact(checkSummary, secrets), safeAnnotations);
    } catch {
      run = "failed";
    }

    stage = "writing the job summary";
    const footer = [
      "",
      "---",
      "",
      `Action: ${ref}, source \`${source.slice(0, 16)}\`. ${CHECK_RUN_SAID[run]}`,
      "",
      `The Action's inputs for the names above: ${INPUT_NAMES}.`,
      "",
    ].join("\n");
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${truncate(shown, SUMMARY_LIMIT - Buffer.byteLength(footer), rest)}${footer}`);

    stage = "saying the result";
    say(`${outcome.title}.`);
    say(CHECK_RUN_SAID[run]);
    // The warning stands in for the check run's mark: only where there is none to read.
    if (run !== "created" && run !== "partial" && !checked) log.push(`::warning title=jev-intent-review::${escapeData(`${outcome.title}. See the job summary.`)}`);
  } catch {
    say(`finishing failed while ${stage}; what was written is in the job summary and the artifact.`);
  }
  writeFileSync(join(work, "checked"), `${checked}\n`);
  writeFileSync(join(work, "log.txt"), `${log.join("\n")}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const at = process.argv.indexOf("--source-hash");
  if (at !== -1) {
    console.log(sourceHash(process.argv[at + 1] ?? "."));
  } else {
    await finish(process.env, { fetch, sameAt: gitSameAt(process.env.GITHUB_WORKSPACE ?? process.cwd()) });
  }
}
