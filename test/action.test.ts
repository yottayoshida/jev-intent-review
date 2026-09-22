// The GitHub Action (ADR 0009): what the check run concludes is what the report's first line says,
// the report is the command's own Markdown, nothing from the report or the command reaches the log,
// and the keys come from the Action's inputs and nowhere else.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { annotationsOf, CHECK_NAME, conclude, finish, gitSameAt, redact, secretsOf, sourceHash, truncate, withoutAnswer, type Deps } from "../action/finish.ts";
import { JUDGMENT_ENV } from "../src/judgments/client.ts";
import { renderJson, renderMarkdown } from "../src/report/markdown.ts";
import type { ReviewReport } from "../src/types.ts";
import { localCheckResult, report } from "./helpers/reports.ts";

const ROOT = join(import.meta.dirname, "..");
const scratch = () => mkdtempSync(join(tmpdir(), "jev-action-"));

// Text a pull request or an issue can carry, each one a workflow command or a problem-matcher line
// if it reached the log.
const FORGED = ["::warning::forged", "##[error]forged", "##[add-mask]secret", "src/auth.rs(10,1): error TS1: forged"];

// ---- the report's kinds, and what each concludes -------------------------------------------------

const none = { violates: 0, satisfies: 0, unknown: 0, aside: 0 };
const unread = () => ({ ...localCheckResult(), observed: [], findings: [], mappings: [], counts: { ...localCheckResult().counts, asked: 0, mapped: 0, governed: 0, outcomes: none } });
const inBudget = { file: "src/auth.rs", function: "open_session", call: "create_session(store, &record)", origin: "changed" as const };
/** Two calls read, both holding, none left out: the one report that is `success`. */
const clean = () => {
  const r = localCheckResult();
  return { ...r, unchecked: [], findings: [], observed: r.observed.map((o) => ({ ...o, outcome: "satisfies" as const })) };
};

const KINDS: Record<string, ReviewReport> = {
  finished: report(),
  clean: report({ requirements: [clean()] }),
  skipped: report({ skipReason: "No credentials for the judgments (CLOUDFLARE_API_TOKEN) were available, so nothing was judged.", skipKind: "no_credentials", requirements: [], sent: { requests: 0, bytes: 0, answered: 0 } }),
  fromFork: report({ skipReason: "This pull request comes from another repository, and GitHub gives such a run no secrets, so nothing was judged.", skipKind: "fork", requirements: [], sent: { requests: 0, bytes: 0, answered: 0 } }),
  fromDependabot: report({ skipReason: "Dependabot's pull requests are given no secrets, so nothing was judged.", skipKind: "dependabot", requirements: [], sent: { requests: 0, bytes: 0, answered: 0 } }),
  // A report from a command that knew a kind this Action does not, or from one that knew none.
  skippedUnknownKind: report({ skipReason: "Something else entirely.", skipKind: "a_kind_from_later" as never, requirements: [], sent: { requests: 0, bytes: 0, answered: 0 } }),
  skippedNoKind: report({ skipReason: "No credentials for the judgments (CLOUDFLARE_API_TOKEN) were available, so nothing was judged.", requirements: [], sent: { requests: 0, bytes: 0, answered: 0 } }),
  noIntent: report({ skipReason: "No statement of intent was found: no issue, no description.", skipKind: "no_intent", requirements: [], sources: [] }),
  stopped: report({ exitCode: 11, requirements: [], sent: { requests: 0, bytes: 0, answered: 0 } }),
  noRequirement: report({ requirements: [] }),
  // Only the change question answered: the J4-only run of a repository in another language.
  noneRead: report({ requirements: [unread()], sent: { requests: 1, bytes: 10, answered: 1 } }),
  // The budget refused every request before one was sent: `asked` still counts the calls tried.
  nothingAsked: report({ requirements: [{ ...unread(), wouldAsk: [inBudget], counts: { ...unread().counts, asked: 1 } }], sent: { requests: 0, bytes: 0, answered: 0 } }),
  unexpected: report({ requirements: [clean()], unexpectedChanges: [{ id: "C1", location: { path: "src/x.rs", startLine: 1, endLine: 2 }, excerpt: "x", judgment: "unrequested", mappedRequirements: [], confidence: 0.9, notes: [] }] }),
  hostCustom: report({ sent: { requests: 4, bytes: 1, answered: 4, endpoint: "https://jev.example", host: "custom" } }),
  prAuthor: report({ metadata: { ...report().metadata, pullRequestAuthor: "alice" } }),
};

test("the check run concludes from the report's first line: success only when calls were read and nothing is left to look at", () => {
  const is = (name: string, exitCode: number, conclusion: string, title: RegExp, checked: boolean) => {
    const got = conclude(KINDS[name], exitCode);
    assert.equal(got.conclusion, conclusion, name);
    assert.match(got.title, title, name);
    assert.equal(got.checked, checked, name);
  };
  is("clean", 0, "success", /^2 calls read, none worth checking$/, true);
  is("finished", 0, "neutral", /^1 call worth checking of 2 read, 1 not checked$/, true);
  is("finished", 1, "failure", /^1 call worth checking of 2 read/, true);
  is("skipped", 0, "neutral", /^Nothing was checked: skipped \(no credentials\)$/, false);
  is("noIntent", 0, "neutral", /^Nothing was checked: skipped \(no source of requirements\)$/, false);
  // A key cannot be the fix for either of these, and the title says so instead of naming credentials.
  is("fromFork", 0, "neutral", /^Nothing was checked: skipped \(this pull request is from another repository, which gets no secrets\)$/, false);
  is("fromDependabot", 0, "neutral", /^Nothing was checked: skipped \(Dependabot pull requests get no secrets\)$/, false);
  // A kind this Action does not know, and a report from before there were kinds: neither may borrow
  // another reason's words.
  for (const name of ["skippedUnknownKind", "skippedNoKind"]) is(name, 0, "neutral", /^Nothing was checked: skipped \(see the job summary\)$/, false);
  is("stopped", 11, "failure", /^Requirements could not be read$/, false);
  is("noRequirement", 0, "neutral", /^Nothing was checked: no requirement in the sources$/, false);
  // Jev answered — the change question — and no call was read: not a pass.
  is("noneRead", 0, "neutral", /^No call was read: 1 not checked$/, false);
  // `counts.read` is 1 here, and nothing was sent: not a pass either.
  is("nothingAsked", 0, "neutral", /^Nothing was asked: 1 call in the budget, 1 not checked$/, false);
  is("unexpected", 0, "neutral", /^2 calls read, none worth checking, 1 change no requirement asked for$/, true);
  // No report at all: exit 12, 13, or the command did not start.
  assert.deepEqual(conclude(undefined, 12), { conclusion: "failure", title: "Stopped before a report (exit 12)", checked: false });
});

test("a call asked about and left without an answer keeps the run from success", () => {
  const r = clean();
  const unanswered = report({ requirements: [{ ...r, observed: r.observed.map((o, i) => (i === 0 ? { ...o, result: { ...o.result, observation: "withheld" } } : o)) }] });
  assert.equal(withoutAnswer(unanswered), 1);
  assert.deepEqual(conclude(unanswered, 0), { conclusion: "neutral", title: "2 calls read, none worth checking, 1 without an answer", checked: true });
  const unmapped = report({ requirements: [{ ...r, mappings: r.mappings.map((m, i) => (i === 1 ? { ...m, verdict: "no_answer" as const } : m)) }] });
  assert.equal(withoutAnswer(unmapped), 1);
  assert.equal(conclude(unmapped, 0).conclusion, "neutral");
  // The control: the same report with every answer is the success above.
  assert.equal(withoutAnswer(report({ requirements: [r] })), 0);
});

test("the Markdown drawn from the JSON is the command's own Markdown, for every kind of report", () => {
  for (const [name, r] of Object.entries(KINDS)) assert.equal(renderMarkdown(JSON.parse(renderJson(r)) as ReviewReport), renderMarkdown(r), name);
});

// ---- writing it: limits, redaction, annotations --------------------------------------------------

test("a long report is cut in bytes at a line, with an open code block closed", () => {
  const short = "# r\n\nshort\n";
  assert.equal(truncate(short, 1000, "rest"), short);
  const text = ["# r", "", "```", ...Array.from({ length: 200 }, () => "日本語の行です"), "```", "after"].join("\n");
  const cut = truncate(text, 600, "The rest is in the artifact.");
  assert.ok(Buffer.byteLength(cut) <= 600, String(Buffer.byteLength(cut)));
  const fences = cut.split("\n").filter((l) => l === "```").length;
  assert.equal(fences % 2, 0, "every fence opened is closed");
  assert.match(cut, /\n\nThe rest is in the artifact\.\n$/);
});

test("every key and token given is taken out, and the provider's name is not a secret", () => {
  const env = { JEV_PROVIDER: "cloudflare", CLOUDFLARE_API_TOKEN: "cf-token-123456", CLOUDFLARE_ACCOUNT_ID: "acct-9876", INPUT_GITHUB_TOKEN: "github-token-abcdef", CHECK_TOKEN: "check-token-abc", JEV_API_TOKEN: "jev-token-abcdef", JEV_API_URL: "https://jev.example/run" };
  const secrets = secretsOf(env);
  // The host's name and the endpoint's URL are what the report names the judge by: not secrets.
  assert.ok(!secrets.includes("cloudflare") && !secrets.includes("https://jev.example/run"));
  assert.deepEqual(redact("cloudflare https://jev.example/run cf-token-123456 acct-9876 github-token-abcdef check-token-abc jev-token-abcdef", secrets), "cloudflare https://jev.example/run *** *** *** *** ***");
});

test("a finding is marked on its lines only where the file is the same at the head and the merge", () => {
  const r = report();
  assert.deepEqual(annotationsOf(r, () => true).annotations.map((a) => [a.path, a.start_line, a.end_line, a.annotation_level]), [["src/auth.rs", 16, 23, "warning"]]);
  assert.deepEqual(annotationsOf(r, () => false), { annotations: [], elsewhere: 1 });

  // A name and a call as long as the repository cares to make them: the API refuses a message over
  // 64 KB, and one refusal costs the whole check run.
  const long = { ...localCheckResult(), findings: [{ ...localCheckResult().findings[0]!, function: "f".repeat(5000), call: "c".repeat(9000) }] };
  const [annotation] = annotationsOf(report({ requirements: [long] }), () => true).annotations;
  assert.ok((annotation?.message.length ?? 0) <= 4001, String(annotation?.message.length));
  assert.match(annotation?.message ?? "", /^f{200}… calls c{400}…, which requirement/);
  // A path is checked before git is asked about it, and before it becomes an annotation: too long,
  // or spelled as a pathspec of git's own.
  for (const file of [`${"d/".repeat(300)}x.rs`, ":(exclude)src/auth.rs", ":/src/auth.rs"]) {
    const odd = { ...localCheckResult(), findings: [{ ...localCheckResult().findings[0]!, file }] };
    assert.deepEqual(annotationsOf(report({ requirements: [odd] }), () => true), { annotations: [], elsewhere: 1 }, file);
  }
});

test("only a pair of commits reaches git, so neither can be read as an option of its own", () => {
  const asked: string[][] = [];
  const same = gitSameAt("/nowhere", (args) => void asked.push(args));
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  assert.equal(same(a, b, "src/x.rs"), true);
  assert.deepEqual(asked, [["diff", "--quiet", a, b, "--", "src/x.rs"]]);
  for (const bad of ["--output=/tmp/x", "-q", "", `${a} ${b}`, "HEAD", a.toUpperCase()]) {
    assert.equal(same(bad, b, "src/x.rs"), false, bad);
    assert.equal(same(a, bad, "src/x.rs"), false, bad);
  }
  assert.equal(asked.length, 1, "git was asked once, for the pair that is two commits");
});

// ---- finish: the log carries only its own sentences ----------------------------------------------

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function workDir(stdout: string, exitCode: number, stderr = "") {
  const at = scratch();
  const work = join(at, "work");
  mkdirSync(work);
  writeFileSync(join(work, "stdout.json"), stdout);
  writeFileSync(join(work, "stderr.txt"), stderr);
  writeFileSync(join(work, "exit-code"), `${exitCode}\n`);
  const event = join(at, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: "c".repeat(40) } } }));
  const summary = join(at, "summary.md");
  const action = join(at, "action");
  mkdirSync(join(action, "src"), { recursive: true });
  writeFileSync(join(action, "src", "main.ts"), "export {};\n");
  const env = { JEV_WORK: work, GITHUB_STEP_SUMMARY: summary, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "o/r", CHECK_TOKEN: "check-token-value", INPUT_GITHUB_TOKEN: "input-token-value", CLOUDFLARE_API_TOKEN: "cf-secret-value", ACTION_PATH: action, ACTION_REF: "0123abc" };
  return { work, summary, env };
}

function deps(status = 201, sent: Sent[] = [], answer: unknown = { id: 7 }): Deps {
  return {
    sameAt: () => true,
    fetch: (async (url: string, init: { method: string; body: string }) => {
      sent.push({ method: init.method, url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify(status === 201 ? answer : { message: FORGED.join(" ") }), { status });
    }) as unknown as typeof fetch,
  };
}

const logLines = (work: string) => readFileSync(join(work, "log.txt"), "utf8").trim().split("\n");
const onlyOwnLines = (lines: string[]) => {
  for (const line of lines) {
    assert.match(line, /^(jev-intent-review: |::warning title=jev-intent-review::)/, line);
    for (const forged of FORGED) assert.ok(!line.includes(forged), `${forged} in ${line}`);
    assert.ok(!line.includes("cf-secret-value"), line);
  }
};

/** A report whose requirement, notes and stderr carry every forged line and a key. */
function hostile(): ReviewReport {
  const base = report();
  const text = `Property: ${FORGED.join("\n")} cf-secret-value`;
  return { ...base, intent: { ...base.intent, requirements: [{ ...base.intent.requirements[0]!, text }] }, metadata: { ...base.metadata, notes: [...FORGED, "cf-secret-value"] } };
}

test("finish puts the report in a check run and the summary, and writes the log only from its own words", async () => {
  const { work, summary, env } = workDir(renderJson(hostile()), 0, `${FORGED.join("\n")}\ncf-secret-value\n`);
  const sent: Sent[] = [];
  await finish(env, deps(201, sent));
  onlyOwnLines(logLines(work));
  assert.deepEqual(logLines(work), ["jev-intent-review: 1 call worth checking of 2 read, 1 not checked.", `jev-intent-review: The check run "${CHECK_NAME}" holds the same report.`]);
  // The check run: completed once, on the pull request's head, with the report and one annotation.
  assert.equal(sent.length, 1);
  const body = sent[0]!.body as { name: string; head_sha: string; status: string; conclusion: string; output: { title: string; summary: string; annotations: unknown[] } };
  assert.deepEqual([sent[0]!.method, sent[0]!.url, body.name, body.head_sha, body.status, body.conclusion], ["POST", "https://api.github.com/repos/o/r/check-runs", CHECK_NAME, "c".repeat(40), "completed", "neutral"]);
  assert.equal(body.output.annotations.length, 1);
  // Everything written is redacted, and the report is really there — it was not simply not read.
  const md = readFileSync(join(work, "artifact", "report.md"), "utf8");
  assert.ok(md.includes("::warning::forged"), "the report holds the forged text");
  for (const written of [md, readFileSync(join(work, "artifact", "report.json"), "utf8"), readFileSync(join(work, "artifact", "stderr.txt"), "utf8"), readFileSync(summary, "utf8"), JSON.stringify(sent)]) {
    assert.ok(!written.includes("cf-secret-value") && !written.includes("check-token-value"), "no key in what is written");
  }
  assert.ok(readFileSync(summary, "utf8").startsWith(md), "the summary starts with the report");
  assert.deepEqual(JSON.parse(readFileSync(join(work, "artifact", "action.json"), "utf8")).ref, "0123abc");
  assert.equal(readFileSync(join(work, "checked"), "utf8"), "true\n");
  assert.deepEqual(readdirSync(join(work, "artifact")).sort(), ["action.json", "report.json", "report.md", "stderr.txt"]);
});

test("a report that cannot be read, or an API that refuses, still leaves only the Action's words in the log", async () => {
  // Broken JSON: V8's parse error quotes it. The run is a failure with the stderr in the summary.
  const broken = workDir(`{"Property: ${FORGED[1]}`, 0, FORGED.join("\n"));
  const sent: Sent[] = [];
  await finish(broken.env, deps(201, sent));
  onlyOwnLines(logLines(broken.work));
  assert.equal((sent[0]!.body as { conclusion: string }).conclusion, "failure");
  assert.match(readFileSync(join(broken.work, "artifact", "report.md"), "utf8"), /stopped before a report \(exit 0\)/);

  // No `checks: write`: the API answers 403 with text of its own. A run that read no call warns.
  const skipped = workDir(renderJson(KINDS.skipped!), 0);
  await finish(skipped.env, deps(403));
  onlyOwnLines(logLines(skipped.work));
  assert.deepEqual(logLines(skipped.work), [
    "jev-intent-review: Nothing was checked: skipped (no credentials).",
    "jev-intent-review: No check run was created: the workflow does not grant `checks: write`, or this pull request's token cannot write checks (a fork, Dependabot).",
    "::warning title=jev-intent-review::Nothing was checked: skipped (no credentials). See the job summary.",
  ]);
  assert.match(readFileSync(skipped.summary, "utf8"), /does not grant `checks: write`/);
  assert.match(readFileSync(skipped.summary, "utf8"), /`cloudflare-api-token` for CLOUDFLARE_API_TOKEN/);

  // A 500 and a throw: no warning for a run that read calls, and the log is still the Action's.
  for (const failing of [deps(500), { ...deps(), fetch: (async () => { throw new Error(FORGED.join(" ")); }) as unknown as typeof fetch }]) {
    const read = workDir(renderJson(report()), 0);
    await finish(read.env, failing);
    onlyOwnLines(logLines(read.work));
    assert.ok(!logLines(read.work).some((l) => l.startsWith("::warning")), "calls were read: no warning");
  }
});

test("what became of the check run is said as it happened: created, created with fewer marks, refused, or never asked for", async () => {
  // Fifty-one findings: the first fifty go with the POST, the rest in an update GitHub refuses.
  const many = { ...localCheckResult(), findings: Array.from({ length: 51 }, (_, i) => ({ ...localCheckResult().findings[0]!, requirementId: `R${i}` })) };
  const partial = workDir(renderJson(report({ requirements: [many] })), 0);
  const sent: Sent[] = [];
  let first = true;
  await finish(partial.env, {
    sameAt: () => true,
    fetch: (async (url: string, init: { method: string; body: string }) => {
      sent.push({ method: init.method, url, body: JSON.parse(init.body) as Record<string, unknown> });
      const answer = new Response(JSON.stringify(first ? { id: 7 } : { message: "no" }), { status: first ? 201 : 500 });
      first = false;
      return answer;
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(sent.map((s) => s.method), ["POST", "PATCH"]);
  const said = logLines(partial.work).join("\n");
  assert.match(said, /holds the same report; GitHub refused some of its marks/);
  assert.ok(!said.includes("No check run"), said);
  assert.match(readFileSync(partial.summary, "utf8"), /refused some of its marks/);

  // No head commit in the event: nothing was sent, which is not the same as being refused.
  const headless = workDir(renderJson(report()), 0);
  writeFileSync(join(headless.env.GITHUB_EVENT_PATH, ""), JSON.stringify({ pull_request: {} }));
  const none: Sent[] = [];
  await finish(headless.env, deps(201, none));
  assert.equal(none.length, 0, "nothing was sent");
  assert.match(logLines(headless.work).join("\n"), /No check run was asked for: the pull request's head commit could not be read/);
  onlyOwnLines(logLines(headless.work));
});

test("a key that holds a quote is taken out of the JSON as the JSON spells it", async () => {
  const quoted = 'cf"secret\\value';
  const base = report();
  const withKey = { ...base, metadata: { ...base.metadata, notes: [`the key is ${quoted} here`] } };
  const { work, summary, env } = workDir(renderJson(withKey), 0);
  await finish({ ...env, CLOUDFLARE_API_TOKEN: quoted }, deps());
  const json = readFileSync(join(work, "artifact", "report.json"), "utf8");
  assert.ok(json.includes("***"), "the escaped spelling was found");
  for (const written of [json, readFileSync(join(work, "artifact", "report.md"), "utf8"), readFileSync(summary, "utf8")]) {
    assert.ok(!written.includes(quoted) && !written.includes(JSON.stringify(quoted).slice(1, -1)), "neither spelling is left");
  }
});

test("a failure inside finish is said by its stage, never by its message", async () => {
  // The job summary's path is a directory whose name is a workflow command: writing to it throws,
  // and the error's message quotes the path.
  const { work, env } = workDir(renderJson(report()), 0);
  const trap = join(scratch(), `x${FORGED[0]}`);
  mkdirSync(trap);
  await finish({ ...env, GITHUB_STEP_SUMMARY: trap }, deps());
  onlyOwnLines(logLines(work));
  assert.deepEqual(logLines(work), ["jev-intent-review: finishing failed while writing the job summary; what was written is in the job summary and the artifact."]);
  // The control: the same run with a file there finishes.
  const ok = workDir(renderJson(report()), 0);
  await finish(ok.env, deps());
  assert.match(logLines(ok.work)[0] ?? "", /^jev-intent-review: 1 call worth checking/);
});

test("the source hash follows the files under src, and does not follow a link", () => {
  const at = scratch();
  mkdirSync(join(at, "src"));
  writeFileSync(join(at, "src", "a.ts"), "one");
  const first = sourceHash(at);
  writeFileSync(join(at, "src", "a.ts"), "two");
  assert.notEqual(sourceHash(at), first);
  assert.equal(sourceHash(at), sourceHash(at));
  // A link to a file outside: its target's content is never read, so changing it changes nothing.
  const outside = join(at, "outside.txt");
  writeFileSync(outside, "before");
  symlinkSync(outside, join(at, "src", "link"));
  const linked = sourceHash(at);
  writeFileSync(outside, "after");
  assert.equal(sourceHash(at), linked);
});

// ---- action.yml and run.sh -----------------------------------------------------------------------

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
const ACTION = parse(readFileSync(join(ROOT, "action.yml"), "utf8")) as { inputs: Record<string, unknown>; runs: { using: string; steps: Step[] } };
const input = (name: string) => name.toLowerCase().replaceAll("_", "-");

test("action.yml gives every key name an input's value where the command runs, and an empty one to npm", () => {
  assert.equal(ACTION.runs.using, "composite");
  const step = (id: string) => ACTION.runs.steps.find((s) => s.id === id)!;
  for (const name of JUDGMENT_ENV) {
    assert.ok(input(name) in ACTION.inputs, `input ${input(name)}`);
    assert.equal(step("prepare").env?.[name], "", `prepare: ${name} is empty`);
    assert.equal(step("review").env?.[name], `\${{ inputs.${input(name)} }}`, `review: ${name} from its input`);
    assert.equal(step("finish").env?.[name], `\${{ inputs.${input(name)} }}`, `finish: ${name} from its input`);
  }
  assert.equal(step("review").env?.GITHUB_TOKEN, "${{ inputs.github-token }}");
  assert.equal(step("review").env?.GH_TOKEN, "");
  assert.equal(step("finish").env?.CHECK_TOKEN, "${{ github.token }}");
  // The report is written and uploaded even when the command failed.
  assert.match(step("finish").if ?? "", /always\(\)/);
  const upload = ACTION.runs.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
  assert.match(upload.if ?? "", /always\(\)/);
  // From the working directory finish.ts redacted into — never from the Action's own directory,
  // which under `uses: ./` is the pull request's checkout.
  assert.equal(upload.with?.path, "${{ steps.prepare.outputs.work }}/artifact");
  // Actions pinned by commit, in the Action and in this repository's own workflows.
  for (const s of ACTION.runs.steps.filter((x) => x.uses)) assert.match(s.uses!, /@[0-9a-f]{40}$/);
  for (const file of readdirSync(join(ROOT, ".github", "workflows"))) {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", file), "utf8");
    for (const [, used] of workflow.matchAll(/uses: (\S+)/g)) if (used !== undefined && !used.startsWith("./")) assert.match(used, /@[0-9a-f]{40}$/, `${file}: ${used}`);
  }
  assert.ok(!("intent-spec" in ACTION.inputs), "a pull request cannot choose its own requirements");
});

function runSh(stage: string, env: Record<string, string>) {
  const at = scratch();
  const out = join(at, "output");
  const summary = join(at, "summary");
  writeFileSync(out, "");
  writeFileSync(summary, "");
  const result = spawnSync("bash", [join(ROOT, "action", "run.sh"), stage], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: at, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, ...env } });
  return { ...result, outputs: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8"), at };
}

/**
 * Stand-ins put first on PATH, with a scratch directory for the Action. `npm` is always one of
 * them and the Action's directory is never this repository: a test must not run the real `npm ci`
 * here (a mutant that let a run past its checks once did, and took the dev dependencies with it).
 */
function stubs(npm: "succeeds" | "must not run", node?: string) {
  const at = scratch();
  const bin = join(at, "bin");
  mkdirSync(bin);
  const marker = join(at, "npm-ran");
  writeFileSync(join(bin, "npm"), npm === "succeeds" ? `#!/bin/sh\necho '${FORGED[0]}'\nexit 0\n` : `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(join(bin, "npm"), 0o755);
  if (node !== undefined) {
    writeFileSync(join(bin, "node"), `#!/bin/sh\necho ${node}\n`);
    chmodSync(join(bin, "node"), 0o755);
  }
  const action = join(at, "action");
  mkdirSync(action);
  return { PATH: `${bin}:${process.env.PATH ?? ""}`, ACTION_PATH: action, marker };
}

test("run.sh stops before running anything on another event or an old Node, in its own words", () => {
  const other = stubs("must not run");
  const push = runSh("prepare", { GITHUB_EVENT_NAME: "pull_request_target", ACTION_PATH: other.ACTION_PATH, PATH: other.PATH });
  assert.equal(push.status, 0);
  assert.match(push.stdout, /^jev-intent-review: runs on pull_request events only, and this run is for pull_request_target\./);
  assert.equal(push.stderr, "");
  assert.match(push.outputs, /^ready=false\nexit-code=10\n$/);
  assert.match(push.summary, /\*\*Result: not run\.\*\*/);
  assert.ok(!existsSync(other.marker), "npm did not run");

  const aged = stubs("must not run", "22.17.0");
  const old = runSh("prepare", { GITHUB_EVENT_NAME: "pull_request", ACTION_PATH: aged.ACTION_PATH, PATH: aged.PATH });
  assert.match(old.stdout, /needs Node\.js 22\.18 or later/);
  assert.match(old.outputs, /ready=false/);
  assert.ok(!existsSync(aged.marker), "npm did not run");
});

test("run.sh keeps npm's and the command's output out of the log, and keeps the exit code", () => {
  const ok = stubs("succeeds");
  // The job log takes stderr as well as stdout: both are checked at every stage.
  const prepared = runSh("prepare", { GITHUB_EVENT_NAME: "pull_request", ACTION_PATH: ok.ACTION_PATH, PATH: ok.PATH });
  assert.equal(prepared.stdout, "", "a prepared run says nothing");
  assert.equal(prepared.stderr, "");
  const work = /^work=(.*)$/m.exec(prepared.outputs)?.[1] ?? "";
  assert.ok(readFileSync(join(work, "npm.txt"), "utf8").includes(FORGED[0]!), "npm's output went to a file");
  assert.ok(!existsSync(join(work, "artifact")), "only finish.ts makes the directory the artifact is uploaded from");

  // A stand-in for the command that prints forged text on both streams and exits 3.
  const fake = scratch();
  mkdirSync(join(fake, "src", "cli"), { recursive: true });
  writeFileSync(join(fake, "src", "cli", "main.ts"), `process.stdout.write(${JSON.stringify(FORGED.join("\n"))}); process.stderr.write(${JSON.stringify(FORGED.join("\n"))}); process.exit(3);\n`);
  const reviewed = runSh("review", { ACTION_PATH: fake, JEV_WORK: work });
  assert.equal(reviewed.stdout, "jev-intent-review: the command exited 3.\n");
  assert.equal(reviewed.stderr, "");
  assert.equal(readFileSync(join(work, "exit-code"), "utf8"), "3\n");
  assert.ok(readFileSync(join(work, "stderr.txt"), "utf8").includes(FORGED[1]!));

  // A finish.ts that crashes with forged text: the log is run.sh's sentence, the outputs still set.
  mkdirSync(join(fake, "action"));
  writeFileSync(join(fake, "action", "finish.ts"), `console.error(${JSON.stringify(FORGED.join("\n"))}); process.exit(1);\n`);
  const finished = runSh("finish", { ACTION_PATH: fake, JEV_WORK: work });
  assert.equal(finished.stdout, "jev-intent-review: finishing failed; what was written is in the job summary and the artifact.\n");
  assert.equal(finished.stderr, "");
  assert.equal(finished.outputs, "exit-code=3\nchecked=false\n");
});
