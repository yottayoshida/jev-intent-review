import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eventOrigin, main, type Deps, type Io } from "../src/cli/main.ts";
import { CONFIG_PATH } from "../src/config/config.ts";
import type { GitHub } from "../src/intent/github.ts";
import { validateIntentSpec } from "../src/intent/schema.ts";
import { EXIT, type IntentSpec, type ReviewReport } from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { answer, formsProvider } from "./helpers/fakes.ts";
import { FIXTURES, fixtureRepo, tempRepo } from "./helpers/repo.ts";

const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "test-token" };

function io(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd, env };
  return { value, out: () => out.join(""), err: () => err.join("") };
}

// Written into the work tree but never committed: the tool reads git objects, so it cannot see it.
function specFile(dir: string, name = "missed-path"): string {
  const path = join(dir, "spec.json");
  writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(join(FIXTURES, name, "fixture.json"), "utf8")).spec));
  return path;
}

/** The Rust fixture's spec, as a path the run can read. */
const RUST_SPEC = join(FIXTURES, "integrity-rust", "spec.json");

/**
 * A pull_request event whose pull request is copied from one that exists (test/fixtures/events/):
 * the same repository's, another repository's, one whose fork has been deleted, and Dependabot's.
 * The envelope around it is written by hand, so what these pin is the reading, not the whole shape
 * of an event GitHub delivers.
 */
const EVENT = (name: string) => join(import.meta.dirname, "fixtures", "events", `${name}.json`);

/** No compiler: requirements come from a spec file or from an acceptance-criteria list. */
function fakeDeps(github?: Partial<GitHub>, jev: Parameters<typeof formsProvider>[0] = {}): Deps & { provider: ReturnType<typeof formsProvider> } {
  const provider = formsProvider(jev);
  return {
    provider,
    judges: () => ({ provider, sent: () => ({ requests: provider.calls.length, bytes: 0 }), origin: "https://api.cloudflare.com" }),
    github: async () => github as GitHub,
  };
}

/** Every key at every depth of a JSON value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

// The pull requests the --pr tests hand to a fake GitHub differ only in the two commits they name.
const pullRequest = (headSha: string, baseSha: string, body = "## Acceptance criteria\n- Disabled users cannot authenticate by any path") => ({
  number: 7,
  title: "Block disabled users",
  body,
  author: "dev",
  url: "u",
  baseRefName: "main",
  baseSha,
  headSha,
  issues: [],
});

test("the CLI reads the calls of the functions the change touched, lists the one that swallows its failure, and states no verdict", async () => {
  const repo = fixtureRepo("integrity-rust");
  try {
    const run = io(repo.dir, CREDENTIALS);
    const deps = fakeDeps();
    const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json", "--trace"], run.value, deps);
    assert.equal(code, EXIT.ok, run.err());
    const report = JSON.parse(run.out()) as ReviewReport;
    assert.equal(report.version, 2);
    assert.equal(report.skipReason, undefined);
    const [r1] = report.requirements;
    assert.deepEqual(r1!.findings.map((f) => [f.function, f.call]), [["read_baseline", "crate::atomic_file::read_capped(&path, MAX)"]]);
    assert.deepEqual(r1!.counts.outcomes, { violates: 1, satisfies: 1, unknown: 0, aside: 0 });
    assert.equal(r1!.form, "failure_propagation");
    // Every request the fake answered is counted, the calls' and the changes', in one unit.
    assert.equal(report.sent.requests, deps.provider.calls.length);
    assert.equal(report.sent.answered, deps.provider.calls.length);
    assert.equal(report.sent.host, "cloudflare");
    // Nothing of the generic run's report is left: no verdict at the top, and none of its per-place
    // fields at any depth. (`mappings[].verdict` is the name of the mapping's answer, applies or
    // does_not_apply — Jev's reading of the requirement's words, not a verdict of the tool's.)
    assert.ok(!("verdict" in report), "no verdict in the JSON");
    for (const gone of ["discovery", "status", "coverage", "scope", "candidates"]) assert.ok(!keysOf(report).has(gone), `no ${gone} in the JSON`);
    assert.match(run.err(), /\[trace\] R1 -> 1 worth checking of 2 read/);

    const markdown = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC], markdown.value, fakeDeps()), EXIT.ok);
    assert.match(markdown.out(), /^# jev-intent-review\n\n\*\*Result: 1 call worth checking of 2 read\.\*\* 2 not checked, 1 note on what was not read, for the reasons under each requirement\. No requirement verdict is stated\./);
    assert.match(markdown.out(), /#### src\/integrity\.rs:\d+-\d+ · read_baseline — `crate::atomic_file::read_capped\(&path, MAX\)`/);
    for (const word of ["VERIFIED", "VIOLATION", "UNKNOWN"]) assert.ok(!markdown.out().includes(word), `${word} is not in the report`);
  } finally {
    repo.remove();
  }
});

test("--experimental-local-check changes nothing, and a requirement of the other form goes through the same run", async () => {
  const repo = fixtureRepo("integrity-rust");
  try {
    const plain = io(repo.dir, CREDENTIALS);
    const flagged = io(repo.dir, CREDENTIALS);
    for (const [run, extra] of [[plain, []], [flagged, ["--experimental-local-check"]]] as const) {
      assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json", ...extra], run.value, fakeDeps()), EXIT.ok);
    }
    assert.equal(flagged.out(), plain.out(), "the flag changes nothing in what is printed");
    assert.match(flagged.err(), /--experimental-local-check is the run now; the report and the exit code are the same without it/);
    assert.equal(plain.err(), "");

    // The set built and nothing sent: the report says that, not that two questions were put to Jev.
    const set = io(repo.dir, {});
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--candidates-only"], set.value, fakeDeps()), EXIT.ok);
    assert.match(set.out(), /\*\*Result: the set was built and nothing was asked\.\*\* 2 calls inside the budget, 2 calls not checked/);
    assert.match(set.out(), /^Nothing was asked: the set was built and the run stopped\./m);
    assert.ok(!set.out().includes("what the requirement requires of the call, and what the function does under an assumption"), "the opening that says two questions were put is not printed");
    assert.match(set.out(), /^Form: `failure_propagation` \(the default\)\. Nothing was asked; the form would ask this\./m);
    assert.match(set.out(), /### Inside the budget/);

    // Both forms in one spec: the check-before-action requirement is asked its own question, in the
    // same run, and nothing of the generic run's questions is ever sent.
    const deps = fakeDeps();
    const both = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", join(FIXTURES, "integrity-rust", "spec-both-forms.json"), "--json"], both.value, deps), EXIT.ok);
    const asked = deps.provider.calls.flatMap((c) => c.questions);
    const allowed = new Set(["requirement_governs", "on_error_result", "on_error_control", "in_forbidden_case", "justification"]);
    assert.deepEqual(asked.filter((k) => !allowed.has(k)), [], "only the forms' questions and the change question");
    for (const key of ["requirement_governs", "on_error_result", "in_forbidden_case", "justification"]) assert.ok(asked.includes(key), `${key} was asked`);
    const report = JSON.parse(both.out()) as ReviewReport;
    assert.deepEqual(report.requirements.map((r) => r.form), ["failure_propagation", "check_before_action"]);
  } finally {
    repo.remove();
  }
});

test("exit codes follow policy.fail_on: 0 by default with a call worth checking, 1 when finding is named, and violation is read as finding", async () => {
  const repo = fixtureRepo("integrity-rust");
  try {
    // The configuration is read at the base commit, so each case is a base with the file and the
    // same head laid over it.
    const withConfig = (yaml: string | null) => {
      repo.git("checkout", "-q", repo.base);
      if (yaml !== null) repo.write({ [CONFIG_PATH]: yaml });
      const base = repo.commit("config");
      repo.git("checkout", "-q", repo.head, "--", "src");
      const head = repo.commit("the change");
      return { base, head };
    };
    const run = async (yaml: string | null, args: string[] = []) => {
      const { base, head } = withConfig(yaml);
      const out = io(repo.dir, CREDENTIALS);
      const code = await main(["--base", base, "--head", head, "--intent-spec", RUST_SPEC, "--json", ...args], out.value, fakeDeps());
      const report = JSON.parse(out.out()) as ReviewReport;
      assert.equal(report.requirements[0]!.findings.length, 1, "the call worth checking is there in every case");
      return { code, notes: report.metadata.notes.join("\n") };
    };
    assert.equal((await run(null)).code, EXIT.ok);
    assert.equal((await run("policy:\n  fail_on: [finding]\n")).code, EXIT.finding);
    const alias = await run("policy:\n  fail_on: [violation]\n");
    assert.equal(alias.code, EXIT.finding);
    assert.match(alias.notes, /policy\.fail_on in .* says `violation`, which is read as `finding`/);
    const stale = await run("policy:\n  unknown: fail\ndiscovery:\n  lexical_search: false\n");
    assert.equal(stale.code, EXIT.ok);
    assert.match(stale.notes, /policy\.unknown in .* no longer applies/);
    assert.match(stale.notes, /discovery\.lexical_search in .* no longer applies/);

    // No call worth checking: naming finding changes nothing.
    repo.git("checkout", "-q", repo.base);
    repo.write({ [CONFIG_PATH]: "policy:\n  fail_on: [finding]\n" });
    const base = repo.commit("config");
    repo.write({ "docs/note.md": "a change outside any function\n" });
    const head = repo.commit("docs");
    const quiet = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", base, "--head", head, "--intent-spec", RUST_SPEC, "--json"], quiet.value, fakeDeps()), EXIT.ok);
    assert.equal((JSON.parse(quiet.out()) as ReviewReport).requirements[0]!.findings.length, 0);
  } finally {
    repo.remove();
  }
});

test("with no credentials the run is skipped (exit 0), or fails with exit 12 when the base commit's config says so", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const skipped = io(repo.dir, {});
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir), "--json"], skipped.value, fakeDeps()), EXIT.ok);
    const report = JSON.parse(skipped.out()) as ReviewReport;
    assert.equal(report.version, 2);
    assert.match(report.skipReason ?? "", /No credentials for the judgments/);
    assert.deepEqual(report.requirements, []);

    repo.git("checkout", "-q", repo.base);
    repo.write({ [CONFIG_PATH]: "policy:\n  missing_credentials: fail\n" });
    const base = repo.commit("config");
    repo.write({ "docs/note.md": "a change to review\n" });
    const after = repo.commit("a change");
    const strict = io(repo.dir, {});
    assert.equal(await main(["--base", base, "--head", after, "--intent-spec", specFile(repo.dir)], strict.value, fakeDeps()), EXIT.provider);
    assert.match(strict.err(), /CLOUDFLARE_ACCOUNT_ID/);
  } finally {
    repo.remove();
  }
});

// The event decides which of the reasons a run without credentials gives, so the run is measured
// from the payload, not from `eventOrigin` alone: the sentence a person reads and the kind the
// Action switches on are both taken out of the JSON one run printed.
test("a run without credentials names the reason the event gives, in the sentence and in the kind", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const cases = [
      ["same-repository", "no_credentials", /No credentials for the judgments/],
      ["cross-repository", "fork", /comes from another repository/],
      ["deleted-fork", "fork", /comes from another repository/],
      ["dependabot", "dependabot", /Dependabot's pull requests/],
    ] as const;
    for (const [event, kind, sentence] of cases) {
      const run = io(repo.dir, { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: EVENT(event) });
      assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir), "--json"], run.value, fakeDeps()), EXIT.ok);
      const report = JSON.parse(run.out()) as ReviewReport;
      assert.equal(report.version, 2);
      assert.equal(report.skipKind, kind, `${event} should be ${kind}`);
      assert.match(report.skipReason ?? "", sentence);
    }
  } finally {
    repo.remove();
  }
});

test("with no intent the run is skipped (exit 0), or fails with exit 11 when the config says so", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const skipped = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--json"], skipped.value, fakeDeps()), EXIT.ok);
    const noIntent = JSON.parse(skipped.out()) as ReviewReport;
    assert.match(noIntent.skipReason ?? "", /No statement of intent was found/);
    assert.equal(noIntent.skipKind, "no_intent");

    repo.git("checkout", "-q", repo.base);
    repo.write({ [CONFIG_PATH]: "policy:\n  no_intent: fail\n" });
    const base = repo.commit("config");
    repo.write({ "docs/note.md": "a change to review\n" });
    const after = repo.commit("a change");
    const strict = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", base, "--head", after], strict.value, fakeDeps()), EXIT.intent);

    // A pull request whose only link is to another repository's issue: nothing is read, and that issue is named either way.
    const foreignOnly = { ...pullRequest(after, base, ""), title: "", foreignIssues: ["attacker/evil#5"] };
    const env = { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" };
    const named = /The pull request closes attacker\/evil#5, an issue in another repository; it was not read/;
    const stopped = io(repo.dir, env);
    assert.equal(await main(["--pr", "7", "--base", base, "--head", after], stopped.value, fakeDeps({ pullRequest: async () => foreignOnly })), EXIT.intent);
    assert.match(stopped.out(), named);
    assert.match(stopped.err(), /no intent was found: nothing was read from an issue, the pull request's description or --intent \(The pull request closes attacker\/evil#5/);
    const lenient = io(repo.dir, env); // the base before the config: no_intent is skip
    assert.equal(await main(["--pr", "7", "--base", repo.base, "--head", repo.head, "--json"], lenient.value, fakeDeps({ pullRequest: async () => ({ ...foreignOnly, headSha: repo.head, baseSha: repo.base }) })), EXIT.ok);
    assert.match((JSON.parse(lenient.out()) as ReviewReport).metadata.notes.join("\n"), named);
  } finally {
    repo.remove();
  }
});

test("--intent is read as written when it is a list, and prose is refused with the forms that work", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const viaList = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent", "Acceptance criteria:\n* Disabled users cannot authenticate by any path", "--json"], viaList.value, fakeDeps()), EXIT.ok);
    assert.deepEqual((JSON.parse(viaList.out()) as ReviewReport).sources.map((s) => s.id), ["cli"]);

    // No model writes requirements any more, so prose in none of the forms stops the run. It names
    // the source it read and why that could not be taken, on stderr and in the report on stdout,
    // and says which forms do work. It used to be handed to a general instruct model.
    const viaProse = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent", "Prevent disabled users from authenticating."], viaProse.value, fakeDeps()), EXIT.intent);
    assert.match(viaProse.err(), /no requirement could be read as written from cli \(no requirements section .* and no Property: paragraph\)/);
    assert.match(viaProse.err(), /--intent-spec/);
    assert.match(viaProse.err(), /'Acceptance criteria' heading/);
    assert.match(viaProse.out(), /^## Intent$/m);
    assert.match(viaProse.out(), /- cli was not read as requirements: no requirements section/);

    const event = join(repo.dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
    const pr = pullRequest(repo.head, repo.base);
    const viaEvent = io(repo.dir, { ...CREDENTIALS, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--json"], viaEvent.value, fakeDeps({ pullRequest: async () => pr })), EXIT.ok);
    const report = JSON.parse(viaEvent.out()) as ReviewReport;
    assert.deepEqual(report.sources.map((s) => [s.id, s.author]), [["pr#7", "dev"]]);
    assert.match(report.metadata.notes.join(" "), /only from the pull request's own description, written by its author dev/);
  } finally {
    repo.remove();
  }
});

test("every way a run that prints its report can end names what it read and what it did not (ADR 0004)", async () => {
  const repo = fixtureRepo("missed-path");
  // omamori #476 and the issue it closes, as frozen from GitHub: prose, in none of the forms.
  const frozen = JSON.parse(readFileSync(join(import.meta.dirname, "..", "bench", "corpus", "omamori-476.intent.json"), "utf8")) as { sources: { id: string; text: string }[] };
  const text = (id: string) => frozen.sources.find((s) => s.id === id)?.text ?? "";
  const issue = (number: number, body: string) => ({ number, title: "", body, author: "yottayoshida", url: "" });
  const pr = (body: string, issues: ReturnType<typeof issue>[], more: { foreignIssues?: string[]; issuesNotListed?: number } = {}) => ({ ...pullRequest(repo.head, repo.base, body), number: 476, author: "yottayoshida", issues, ...more });
  const FOREIGN = /The pull request closes attacker\/evil#5, an issue in another repository; it was not read/;
  const event = join(repo.dir, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { number: 476 } }));
  const onEvent = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "o/r" };
  const args = ["--base", repo.base, "--head", repo.head, "--json"];
  const deps = (p: ReturnType<typeof pr>) => fakeDeps({ pullRequest: async () => p });
  const parsed = (out: string) => JSON.parse(out) as ReviewReport;
  const ambiguities = (out: string) => parsed(out).intent.ambiguities.map((a) => a.text).join("\n");
  const notesOf = (out: string) => parsed(out).metadata.notes.join("\n");
  try {
    // The pull request also closes an issue in another repository, which is never read: every way
    // the run ends names it.
    const prose = pr(text("pr#476"), [issue(468, text("issue#468"))], { foreignIssues: ["attacker/evil#5"] });

    // With credentials: nothing could be read, so the run stops (exit 11), names both sources on
    // stdout and stderr, and asks Jev nothing. The report has the one shape every run prints.
    const stopped = io(repo.dir, { ...CREDENTIALS, ...onEvent });
    const stoppedDeps = deps(prose);
    assert.equal(await main(args, stopped.value, stoppedDeps), EXIT.intent);
    assert.equal(parsed(stopped.out()).exitCode, EXIT.intent);
    assert.match(ambiguities(stopped.out()), /issue#468 was not read as requirements/);
    assert.match(ambiguities(stopped.out()), /pr#476 was not read as requirements/);
    assert.match(notesOf(stopped.out()), FOREIGN);
    assert.match(stopped.err(), /issue#468 \(no requirements section/);
    assert.equal(stoppedDeps.provider.calls.length, 0, "Jev was asked nothing");
    const stoppedText = io(repo.dir, { ...CREDENTIALS, ...onEvent });
    assert.equal(await main(["--base", repo.base, "--head", repo.head], stoppedText.value, deps(prose)), EXIT.intent);
    assert.match(stoppedText.out(), /\*\*Result: nothing was checked\.\*\*/);
    assert.match(stoppedText.out(), /No requirement could be read as written\./);
    assert.match(stoppedText.out(), FOREIGN);

    // Without credentials: skipped, not failed — a fork's pull request in prose must not turn red —
    // and the skipped report names the same two sources, and the issue it did not read.
    const skipped = io(repo.dir, onEvent);
    assert.equal(await main(args, skipped.value, deps(prose)), EXIT.ok);
    assert.match(parsed(skipped.out()).skipReason ?? "", /No credentials/);
    assert.match(ambiguities(skipped.out()), /issue#468 was not read[\s\S]*pr#476 was not read/);
    assert.match(notesOf(skipped.out()), FOREIGN);
    const skippedText = io(repo.dir, onEvent);
    assert.equal(await main(["--base", repo.base, "--head", repo.head], skippedText.value, deps(prose)), EXIT.ok);
    assert.match(skippedText.out(), /^## Intent$/m);
    assert.match(skippedText.out(), /pr#476 was not read as requirements/);
    assert.match(skippedText.out(), FOREIGN);

    // Building the set names it too, before any credentials are needed — under the new flag and the old pair alike.
    const listed = pr("## Acceptance criteria\n- Disabled users cannot authenticate by any path", [], { foreignIssues: ["attacker/evil#5"] });
    for (const flags of [["--candidates-only"], ["--experimental-local-check", "--experimental-candidates-only"]]) {
      const local = io(repo.dir, onEvent);
      assert.equal(await main([...args, ...flags], local.value, deps(listed)), EXIT.ok);
      assert.match(notesOf(local.out()), FOREIGN);
      assert.equal(parsed(local.out()).sent.requests, 0);
      const localText = io(repo.dir, onEvent);
      assert.equal(await main(["--base", repo.base, "--head", repo.head, ...flags], localText.value, deps(listed)), EXIT.ok);
      assert.match(localText.out(), FOREIGN);
    }

    // An issue with a list and a pull request in prose: the issue is read, the pull request named —
    // once, in the intent, not again in the notes.
    const mixed = io(repo.dir, { ...CREDENTIALS, ...onEvent });
    assert.equal(await main(args, mixed.value, deps(pr(text("pr#476"), [issue(468, "## Acceptance\n- Disabled users cannot authenticate by any path")]))), EXIT.ok);
    const mixedReport = parsed(mixed.out());
    assert.deepEqual(mixedReport.intent.requirements.map((r) => [r.sourceRefs[0]?.sourceId, r.text]), [["issue#468", "Disabled users cannot authenticate by any path"]]);
    assert.match(mixedReport.intent.ambiguities.map((a) => a.text).join("\n"), /pr#476 was not read as requirements/);
    assert.doesNotMatch(mixedReport.metadata.notes.join("\n"), /was not read as requirements/);

    // Intent given on the command line is not dropped because something else could be read, and the
    // headline says that is why nothing was checked.
    const file = join(repo.dir, "intent.md");
    writeFileSync(file, "Please make disabled users unable to log in.");
    const explicit = io(repo.dir, { ...CREDENTIALS, ...onEvent });
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-file", file], explicit.value, deps(pr("## Acceptance criteria\n- Disabled users cannot authenticate by any path", []))), EXIT.intent);
    assert.match(explicit.err(), /the intent given on the command line could not be read as written: file:/);
    assert.match(explicit.out(), /The intent given on the command line could not be read as written\./);

    // The pull request's own Property read, the issue above it in prose: named in the notes, and the
    // changes are not checked against the author's own words.
    const own = io(repo.dir, { ...CREDENTIALS, ...onEvent });
    await main(args, own.value, deps(pr("Property: disabled users cannot authenticate by any path.", [issue(468, text("issue#468"))])));
    const ownReport = parsed(own.out());
    assert.match(ownReport.metadata.notes.join("\n"), /issue#468, which no source that was read outranks, was not read as requirements/);
    assert.match(ownReport.metadata.notes.join("\n"), /The changes were not checked against the requirements: every requirement came from the pull request's own description/);
    assert.match(ownReport.metadata.notes.join("\n"), /only from the pull request's own description/);
    // Whose claim a requirement is, is said from the pull request's author even when its description is not a source.
    assert.equal(ownReport.metadata.pullRequestAuthor, "yottayoshida");

    // An IntentSpec that lists no requirement is named as that, not as prose to rewrite in a form.
    const emptySpec = join(repo.dir, "empty-spec.json");
    writeFileSync(emptySpec, JSON.stringify({ ...(JSON.parse(readFileSync(specFile(repo.dir), "utf8")) as object), requirements: [] }));
    for (const extra of [[], ["--candidates-only"]]) {
      const empty = io(repo.dir, CREDENTIALS);
      assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", emptySpec, ...extra], empty.value, fakeDeps()), EXIT.intent);
      assert.match(empty.err(), /the IntentSpec file .*empty-spec\.json lists no requirement: list at least one in its requirements/);
    }

    // Intent that exists and was not checked is said in the notes, whoever wrote what was read (ADR
    // 0004, 0007): an issue in prose beside another issue that was read, requirements past the first
    // twenty, and issues past the ten GitHub lists.
    const noted = async (p: ReturnType<typeof pr>) => {
      const run = io(repo.dir, { ...CREDENTIALS, ...onEvent });
      assert.equal(await main(args, run.value, deps(p)), EXIT.ok);
      return notesOf(run.out());
    };
    const listItem = "## Acceptance\n- Disabled users cannot authenticate by any path";
    assert.match(await noted(pr("", [issue(468, listItem), issue(469, text("issue#468"))])), /issue#469, which no source that was read outranks, was not read as requirements/);
    const many = `## Acceptance\n${Array.from({ length: 21 }, (_, i) => `- Disabled users cannot authenticate by path ${i + 1}`).join("\n")}`;
    assert.match(await noted(pr("", [issue(468, many)])), /1 requirement\(s\) from issue#468 were read past the first 20 and not checked/);
    assert.match(await noted(pr("", [issue(468, listItem)], { issuesNotListed: 3 })), /closes 3 more issue\(s\) than GitHub listed \(the first 10\); they were not read/);
  } finally {
    repo.remove();
  }
});

test("--pr outside a pull_request workflow reviews the pull request's head, not what is checked out", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    repo.git("checkout", "-q", repo.base);
    const pr = pullRequest(repo.head, repo.base);
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--base", repo.base, "--json"], run.value, fakeDeps({ pullRequest: async () => pr })), EXIT.ok);
    assert.equal((JSON.parse(run.out()) as ReviewReport).metadata.head, repo.head);

    // A workflow run by a comment or by hand has the default branch checked out, not the pull request.
    const comment = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "issue_comment" });
    assert.equal(await main(["--pr", "7", "--base", repo.base, "--json"], comment.value, fakeDeps({ pullRequest: async () => pr })), EXIT.ok);
    assert.equal((JSON.parse(comment.out()) as ReviewReport).metadata.head, repo.head);

    const missing = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    const gone = { ...pr, headSha: "f".repeat(40) };
    assert.equal(await main(["--pr", "7", "--base", repo.base], missing.value, fakeDeps({ pullRequest: async () => gone })), EXIT.repository);
    assert.match(missing.err(), /git fetch origin pull\/7\/head/);
  } finally {
    repo.remove();
  }
});

test("--pr takes the base commit the pull request started from, not the branch as it is now", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    // A pull request merged with a merge commit, with the branch moved on afterwards: main now
    // contains the head, so the merge base of the branch name and the head is the head itself.
    repo.write({ "docs/later.md": "work that landed after the pull request\n" });
    repo.commit("main moved on");
    const pr = pullRequest(repo.head, repo.base);
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--json"], run.value, fakeDeps({ pullRequest: async () => pr })), EXIT.ok);
    const report = JSON.parse(run.out()) as ReviewReport;
    assert.deepEqual([report.metadata.base, report.metadata.head], [repo.base, repo.head]);

    // Without a base commit — an older GitHub response, or one this clone does not have — the run
    // stops instead of reporting on a commit compared with itself.
    const blind = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--json"], blind.value, fakeDeps({ pullRequest: async () => ({ ...pr, baseSha: "" }) })), EXIT.config);
    assert.match(blind.err(), /nothing to compare: the merge base of main and [0-9a-f]+ is the head commit itself/);
    assert.equal(blind.out(), "");
  } finally {
    repo.remove();
  }
});

test("--pr keeps measuring against the base branch when the head took the branch in later", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    // An open pull request whose branch is behind: main moved on, the pull request took main in
    // (a rebase, or GitHub's "Update branch"), and the base commit GitHub recorded at the start is
    // now older than the point the two share. Measuring from it would call main's own commit a
    // change of this pull request.
    repo.git("checkout", "-q", "-b", "pr", repo.head);
    repo.git("checkout", "-q", "main");
    repo.git("reset", "-q", "--hard", repo.base);
    repo.write({ "docs/upstream.md": "someone else's work\n" });
    const later = repo.commit("main moved on");
    repo.git("update-ref", "refs/remotes/origin/main", later);
    repo.git("checkout", "-q", "pr");
    repo.git("merge", "-q", "--no-edit", "main");
    const head = repo.git("rev-parse", "HEAD").trim();

    const pr = pullRequest(head, repo.base);
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--json", "--trace"], run.value, fakeDeps({ pullRequest: async () => pr })), EXIT.ok);
    const report = JSON.parse(run.out()) as ReviewReport;
    assert.deepEqual([report.metadata.base, report.metadata.head], [later, head]);
    // The upstream commit is not part of this pull request, so its file is not among the changed ones.
    assert.match(run.err(), /changed files: \d+/);
    assert.ok(!run.err().includes("docs/upstream.md"), run.err());
  } finally {
    repo.remove();
  }
});

test("--pr takes the latest commit the head still shares with a candidate, so a stale origin does not widen the change", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    // A clone that has not fetched for a while: origin/main and the local branch both sit at an
    // older commit than the one the pull request started from, which the clone has only because
    // the head descends from it. Taking the branch would call the commit between them a change of
    // this pull request.
    repo.git("checkout", "-q", "-b", "upstream", repo.base);
    repo.write({ "docs/upstream.md": "someone else's work\n" });
    const startedFrom = repo.commit("main moved on");
    repo.git("checkout", "-q", "-b", "pr");
    repo.git("checkout", "-q", repo.head, "--", ".");
    const head = repo.commit("the pull request");
    repo.git("branch", "-q", "-f", "main", repo.base);
    repo.git("update-ref", "refs/remotes/origin/main", repo.base);

    const pr = pullRequest(head, startedFrom);
    const run = io(repo.dir, { ...CREDENTIALS, GITHUB_REPOSITORY: "o/r" });
    assert.equal(await main(["--pr", "7", "--json", "--trace"], run.value, fakeDeps({ pullRequest: async () => pr })), EXIT.ok);
    assert.equal((JSON.parse(run.out()) as ReviewReport).metadata.base, startedFrom);
    assert.ok(!run.err().includes("docs/upstream.md"), run.err());
  } finally {
    repo.remove();
  }
});

test("--intent-spec cannot be combined with other intent, and trace lines cannot start a line of their own", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const combined = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--intent-spec", specFile(repo.dir), "--intent", "x", "--base", repo.base], combined.value, fakeDeps()), EXIT.config);

    const forged = join(repo.dir, "forged.json");
    writeFileSync(forged, JSON.stringify(validateIntentSpec({ version: 1, requirements: [{ id: "R1", text: "Disabled users cannot sign in.\n::error::forged" }] }, "t")));
    const traced = io(repo.dir, CREDENTIALS);
    await main(["--base", repo.base, "--head", repo.head, "--intent-spec", forged, "--trace"], traced.value, fakeDeps());
    assert.ok(traced.err().includes("forged"), "the text is still shown");
    assert.ok(!traced.err().split("\n").some((line) => line.startsWith("::")), "but never at the start of a line");
  } finally {
    repo.remove();
  }
});

/** A stand-in for the judgment endpoint on this machine: answers like Workers AI, remembers what it was asked. */
async function localEndpoint(answer: (body: { model?: string; input?: { questions?: Record<string, unknown> } }) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const seen: { auth: string | undefined; body: { model?: string; input?: { questions?: Record<string, unknown> } } }[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => void (text += chunk.toString("utf8")));
    request.on("end", () => {
      const body = JSON.parse(text || "{}") as { model?: string; input?: { questions?: Record<string, unknown> } };
      seen.push({ auth: request.headers.authorization, body });
      const { status, body: answerBody, headers } = answer(body);
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(answerBody === undefined ? "" : JSON.stringify(answerBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { seen, url: `http://127.0.0.1:${port}/ai/run`, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** One answer per question the request carries, as Workers AI would shape it, wrapped or not. */
const CHOSEN: Record<string, string> = { requirement_governs: "applies", on_error_result: "returns_success", on_error_control: "keeps_going", in_forbidden_case: "reaches_it", justification: "clearly_required" };
const answers = (questions: Record<string, unknown> | undefined, wrapped: boolean) => {
  const choice = (c: string) => ({ type: "choice", choice: c, confidence: 0.9, probabilities: { [c]: 0.9 } });
  const inner = { answers: Object.fromEntries(Object.keys(questions ?? {}).map((k) => [k, choice(CHOSEN[k] ?? "cannot_tell")])) };
  return wrapped ? { result: { state: "Completed", result: inner } } : inner;
};

test("with JEV_API_URL every judgment goes there, with its own token, wrapped answer or not", async () => {
  const repo = fixtureRepo("integrity-rust");
  let wrapped = true;
  const endpoint = await localEndpoint((body) => {
    wrapped = !wrapped;
    return { status: 200, body: answers(body.input?.questions, wrapped) };
  });
  try {
    // The environment is built from nothing: a broken build must not reach api.cloudflare.com.
    const run = io(repo.dir, { JEV_API_URL: endpoint.url, JEV_API_TOKEN: "local-token" });
    const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json"], run.value);
    assert.equal(code, EXIT.ok, run.err());
    const report = JSON.parse(run.out()) as ReviewReport;
    assert.ok(endpoint.seen.length >= 1);
    assert.equal(report.sent.requests, endpoint.seen.length, "every request in the report reached this server");
    assert.equal(report.sent.answered, endpoint.seen.length);
    assert.equal(report.sent.endpoint, endpoint.origin);
    // The stand-in answers `returns_success` for every call, so every governed call is listed.
    assert.equal(report.requirements[0]!.findings.length, 2, "and the run read the calls through it");
    for (const request of endpoint.seen) {
      assert.equal(request.auth, "Bearer local-token");
      assert.equal(request.body.model, "typesafe/jev");
    }
  } finally {
    endpoint.close();
    repo.remove();
  }
});

test("an endpoint that redirects or has nothing there fails the run at once, and is not asked again", async () => {
  for (const wrong of [
    { status: 302, headers: { location: "https://elsewhere.example.com/" } },
    { status: 404, body: { error: "no route" } },
  ]) {
    const repo = fixtureRepo("integrity-rust");
    const endpoint = await localEndpoint(() => wrong);
    try {
      const run = io(repo.dir, { JEV_API_URL: endpoint.url, JEV_API_TOKEN: "local-token" });
      const code = await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC], run.value);
      assert.equal(code, EXIT.provider, String(wrong.status));
      assert.equal(run.out(), "");
      // Counted after everything in flight has landed, so the number does not depend on timing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(endpoint.seen.length <= 8, `${endpoint.seen.length} requests reached the endpoint`);
    } finally {
      endpoint.close();
      repo.remove();
    }
  }
});

test("an endpoint that answers nothing usable fails the run instead of reporting nothing settled everywhere", async () => {
  // Refusing every request: the second refusal, with nothing ever answered, stops the run early.
  const refusing = fixtureRepo("integrity-rust");
  const wrongShape = await localEndpoint(() => ({ status: 400, body: { error: "not this shape" } }));
  try {
    const run = io(refusing.dir, { JEV_API_URL: wrongShape.url, JEV_API_TOKEN: "local-token" });
    assert.equal(await main(["--base", refusing.base, "--head", refusing.head, "--intent-spec", RUST_SPEC], run.value), EXIT.provider);
    assert.match(run.err(), /the endpoint set by JEV_API_URL \(http:\/\/127\.0\.0\.1:\d+\) answered 400.*not a Jev endpoint/);
    assert.ok(wrongShape.seen.length <= 8, `${wrongShape.seen.length} requests`);
  } finally {
    wrongShape.close();
    refusing.remove();
  }

  // Answering 200 with nothing in it: every call is left not settled, and a report of nothing but
  // that is not a run that judged. The same when only the changes were asked about, as on a
  // repository the local check reads no function in.
  for (const fixture of ["integrity-rust", "missed-path"]) {
    const empty = fixtureRepo(fixture);
    const emptyAnswers = await localEndpoint(() => ({ status: 200, body: { result: {} } }));
    try {
      const spec = fixture === "integrity-rust" ? RUST_SPEC : specFile(empty.dir);
      const run = io(empty.dir, { JEV_API_URL: emptyAnswers.url, JEV_API_TOKEN: "local-token" });
      assert.equal(await main(["--base", empty.base, "--head", empty.head, "--intent-spec", spec], run.value), EXIT.provider, fixture);
      assert.match(run.err(), /no judgment came back from .*http:\/\/127\.0\.0\.1:\d+/);
      assert.ok(emptyAnswers.seen.length >= 1);
    } finally {
      emptyAnswers.close();
      empty.remove();
    }
  }
});

test("nothing the endpoint says can start a line of its own, in the trace or in the report", async () => {
  const repo = fixtureRepo("integrity-rust");
  const endpoint = await localEndpoint(() => ({ status: 500, body: { error: `broken\n::error::forged\ntoken local-token` } }));
  try {
    const run = io(repo.dir, { JEV_API_URL: endpoint.url, JEV_API_TOKEN: "local-token" });
    await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--trace"], run.value);
    for (const stream of [run.err(), run.out()]) {
      assert.ok(!stream.split("\n").some((line) => line.startsWith("::")), stream.slice(0, 200));
      assert.ok(!stream.includes("local-token"), "the token is never echoed back into the output");
    }
  } finally {
    endpoint.close();
    repo.remove();
  }
});

test("a token without its endpoint, or an endpoint the token does not belong to, is a setting to fix", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const cases: [NodeJS.ProcessEnv, number, RegExp][] = [
      [{ JEV_API_URL: "http://example.com/ai/run", JEV_API_TOKEN: "t" }, EXIT.config, /must be https/],
      [{ JEV_API_URL: "http://localhost.attacker.com/ai/run", JEV_API_TOKEN: "t" }, EXIT.config, /must be https/],
      [{ JEV_API_URL: "https://alice:hunter2@example.com/ai/run", JEV_API_TOKEN: "t" }, EXIT.config, /user name or password/],
      [{ JEV_API_URL: "https://judge.example.com/ai/run", ...CREDENTIALS }, EXIT.config, /CLOUDFLARE_API_TOKEN is only ever sent to Cloudflare/],
      [{ JEV_API_TOKEN: "t", ...CREDENTIALS }, EXIT.config, /JEV_API_TOKEN needs JEV_API_URL/],
    ];
    for (const [env, expected, message] of cases) {
      const run = io(repo.dir, env);
      assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir)], run.value, fakeDeps()), expected, JSON.stringify(env));
      assert.match(run.err(), message);
      assert.equal(run.out(), "");
      assert.ok(!run.err().includes("hunter2") && !run.err().includes("alice"), run.err());
    }

    // The URL without its token is a fork's pull request: skipped, not failed, and nothing is sent.
    const fork = io(repo.dir, { JEV_API_URL: "https://judge.example.com/ai/run" });
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", specFile(repo.dir), "--json"], fork.value, fakeDeps()), EXIT.ok);
    const report = JSON.parse(fork.out()) as ReviewReport;
    assert.match(report.skipReason ?? "", /No credentials/);
    assert.equal(report.sent.requests, 0);
    assert.equal(report.sent.endpoint, undefined, "a skipped run names no endpoint");
  } finally {
    repo.remove();
  }
});

test("the CLI runs when started through a symbolic link, as an npm bin would start it", () => {
  const repo = tempRepo();
  try {
    const link = join(repo.dir, "jev-intent-review");
    symlinkSync(join(import.meta.dirname, "..", "src", "cli", "main.ts"), link);
    assert.equal(execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" }), `${VERSION}\n`);
  } finally {
    repo.remove();
  }
});

test("the CLI's exit codes for bad input: help 0, bad option 10, bad number 10, bad repo 10, missing file 11, no base 10, unknown revision 13", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const spec = specFile(repo.dir);
    const help = io(repo.dir);
    assert.equal(await main(["--help"], help.value), EXIT.ok);
    assert.match(help.out(), /^Usage: jev-intent-review/);
    assert.match(help.out(), /--candidates-only/);
    assert.match(help.out(), /--skip-change-check/);

    const cases: [string[], number, RegExp][] = [
      [["--nonsense"], EXIT.config, /nonsense/],
      [["--pr", "seven"], EXIT.config, /--pr must be a number/],
      [["--repo", "not a repo", "--intent-spec", spec, "--base", repo.base], EXIT.config, /--repo must look like owner\/name/],
      [["--intent-spec", join(repo.dir, "missing.json"), "--base", repo.base], EXIT.intent, /cannot read/],
      [["--intent-spec", spec], EXIT.config, /pass --base/],
      [["--intent-spec", spec, "--base", "no-such-branch"], EXIT.repository, /cannot find commit 'no-such-branch'/],
    ];
    for (const [argv, expected, message] of cases) {
      const run = io(repo.dir, CREDENTIALS);
      assert.equal(await main(argv, run.value, fakeDeps()), expected, argv.join(" "));
      assert.match(run.err(), message);
      assert.equal(run.out(), "");
    }
  } finally {
    repo.remove();
  }
});

test("a change to a workflow, or to this tool's configuration, is said in the notes of every report that read the change", async () => {
  const repo = fixtureRepo("integrity-rust");
  try {
    repo.write({ ".github/workflows/review.yml": "on: pull_request\n", [CONFIG_PATH]: "policy:\n  fail_on: [finding]\n" });
    const head = repo.commit("a workflow and a configuration");
    for (const flags of [[], ["--candidates-only"]]) {
      const run = io(repo.dir, CREDENTIALS);
      assert.equal(await main(["--base", repo.base, "--head", head, "--intent-spec", RUST_SPEC, "--json", ...flags], run.value, fakeDeps()), EXIT.ok, flags.join(" "));
      const notes = (JSON.parse(run.out()) as ReviewReport).metadata.notes.join("\n");
      assert.match(notes, /The change edits a GitHub Actions workflow, which may run this tool differently\./);
      assert.match(notes, /The change edits \.jev-intent-review\.yml; the version before the change was used\./);
    }
    // And the configuration the change added was not the one used: exit 0, not 1, with the call worth checking.
    const text = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", head, "--intent-spec", RUST_SPEC], text.value, fakeDeps()), EXIT.ok);
    assert.match(text.out(), /^## Notes$/m);
    assert.match(text.out(), /- The change edits a GitHub Actions workflow/);
  } finally {
    repo.remove();
  }
});

test("--skip-change-check leaves the changes unasked and says so; without it every change is asked about once", async () => {
  const repo = fixtureRepo("integrity-rust");
  try {
    const asked = fakeDeps();
    const full = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json"], full.value, asked), EXIT.ok);
    assert.ok(asked.provider.calls.some((c) => c.questions.includes("justification")), "the changes were asked about");

    const skipped = fakeDeps();
    const calls = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json", "--skip-change-check"], calls.value, skipped), EXIT.ok);
    assert.ok(!skipped.provider.calls.some((c) => c.questions.includes("justification")), "nothing about the changes was sent");
    const report = JSON.parse(calls.out()) as ReviewReport;
    assert.match(report.metadata.notes.join("\n"), /The changes were not checked against the requirements \(--skip-change-check\)/);
    assert.equal(report.requirements[0]!.findings.length, 1, "the calls were still read");
    assert.deepEqual(report.unexpectedChanges, []);
    assert.equal(report.sent.requests, 4);
  } finally {
    repo.remove();
  }
});

test("a requirement read from text is asked its form first, over the sentence alone; a spec's is not; the set built only asks nothing and says so", async () => {
  const repo = fixtureRepo("integrity-rust");
  const parsed = (out: string) => JSON.parse(out) as ReviewReport;
  try {
    const file = join(repo.dir, "intent.md");
    writeFileSync(file, "## Acceptance criteria\n- A baseline that cannot be read is not reported as no baseline at all.\n");
    const args = ["--base", repo.base, "--head", repo.head, "--intent-file", file, "--skip-change-check", "--json"];

    // Jev reads the sentence as the check form: the first request is the form question, carrying the
    // requirement and nothing else, and every question after it is the check form's.
    const asChecked = fakeDeps(undefined, { form: answer("check_before_action", 0.9) });
    const checked = io(repo.dir, CREDENTIALS);
    assert.equal(await main(args, checked.value, asChecked), EXIT.ok);
    assert.deepEqual(asChecked.provider.calls[0]?.questions, ["requirement_form"]);
    assert.deepEqual(Object.keys(asChecked.provider.calls[0]!.state), ["requirement"]);
    assert.equal(asChecked.provider.calls.filter((c) => c.questions.includes("requirement_form")).length, 1);
    const later = asChecked.provider.calls.slice(1).flatMap((c) => c.questions);
    assert.ok(later.includes("in_forbidden_case") && !later.includes("on_error_result"), later.join(","));
    const checkedReport = parsed(checked.out());
    assert.deepEqual([checkedReport.requirements[0]!.form, checkedReport.requirements[0]!.formBy, checkedReport.requirements[0]!.formReading?.verdict], ["check_before_action", "jev", "check_before_action"]);
    assert.equal(checkedReport.sent.requests, asChecked.provider.calls.length, "the form question is counted with the rest");
    assert.equal(checkedReport.sent.answered, asChecked.provider.calls.length, "and among the answers");

    // The scripted `neither` every other test runs with: the default form, and the reading kept.
    const asNeither = fakeDeps();
    const plain = io(repo.dir, CREDENTIALS);
    assert.equal(await main(args, plain.value, asNeither), EXIT.ok);
    const plainReport = parsed(plain.out());
    assert.deepEqual([plainReport.requirements[0]!.form, plainReport.requirements[0]!.formBy, plainReport.requirements[0]!.formReading?.verdict], ["failure_propagation", "default", "neither"]);
    assert.ok(asNeither.provider.calls.slice(1).some((c) => c.questions.includes("on_error_result")));
    const plainText = io(repo.dir, CREDENTIALS);
    await main(args.filter((a) => a !== "--json"), plainText.value, fakeDeps());
    assert.match(plainText.out(), /Form: `failure_propagation` \(the default: Jev read the sentence as `neither`, 0\.90\)\./);

    // A spec names the form: no question about it, whatever the fake would answer.
    const fromSpec = fakeDeps(undefined, { form: answer("check_before_action", 0.9) });
    const spec = io(repo.dir, CREDENTIALS);
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--skip-change-check", "--json"], spec.value, fromSpec), EXIT.ok);
    assert.ok(!fromSpec.provider.calls.some((c) => c.questions.includes("requirement_form")), "a spec's requirement is never asked its form");
    assert.deepEqual([parsed(spec.out()).requirements[0]!.formBy, parsed(spec.out()).requirements[0]!.formReading], ["default", undefined]);

    // Building the set only: no request of any kind, and the report says the form was not asked.
    const building = fakeDeps(undefined, { form: answer("check_before_action", 0.9) });
    const built = io(repo.dir, {});
    assert.equal(await main([...args, "--candidates-only"], built.value, building), EXIT.ok);
    assert.equal(building.provider.calls.length, 0);
    const builtReport = parsed(built.out());
    assert.equal(builtReport.sent.requests, 0);
    assert.deepEqual([builtReport.requirements[0]!.formBy, builtReport.requirements[0]!.formNotAsked], ["default", "candidates_only"]);
    const builtText = io(repo.dir, {});
    await main([...args.filter((a) => a !== "--json"), "--candidates-only"], builtText.value, fakeDeps());
    assert.match(builtText.out(), /the default: the form was not asked — `--candidates-only` asks nothing/);
  } finally {
    repo.remove();
  }
});

// ---- where a pull request came from (ADR 0010) ---------------------------------------------------

// The payloads under EVENT are copied from real pull requests. The ones made here are the cases no
// real pull request of this repository can show: a pull request opened inside a fork (which the
// `fork` flag gets wrong, and which does get the secrets), and a fork that has been deleted.
const scratched: string[] = [];
const scratchFile = (name: string, text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "jir-event-"));
  scratched.push(dir);
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
const scratchEvent = (name: string, event: unknown) => scratchFile(name, JSON.stringify(event));

test("where a pull request came from is read from the event, and a repository's own fork flag decides nothing", (t) => {
  t.after(() => {
    for (const dir of scratched.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const env = (path: string) => ({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path }) as NodeJS.ProcessEnv;
  assert.equal(eventOrigin(env(EVENT("same-repository"))), "same_repository");
  assert.equal(eventOrigin(env(EVENT("cross-repository"))), "fork");
  assert.equal(eventOrigin(env(EVENT("dependabot"))), "dependabot");

  // Opened inside a fork: `head.repo.fork` is true, as it is for the cross-repository payload, but
  // head and base are one repository and the run is given the secrets.
  const insideAFork = scratchEvent("inside-a-fork.json", {
    action: "opened",
    number: 7,
    pull_request: { number: 7, user: { login: "someone" }, head: { repo: { full_name: "someone/cli", fork: true } }, base: { repo: { full_name: "someone/cli", fork: true } } },
    repository: { full_name: "someone/cli" },
  });
  assert.equal(eventOrigin(env(insideAFork)), "same_repository");

  // A deleted fork: GitHub leaves `head.repo` empty, which is not the same as the field being
  // absent — the pull request came from a repository that is gone, never from this one.
  assert.equal(eventOrigin(env(EVENT("deleted-fork"))), "fork");

  // Nothing to read from: another event, no file, a file that is not JSON, and one without the
  // repositories. None of them may claim a pull request came from somewhere.
  assert.equal(eventOrigin({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: EVENT("cross-repository") } as NodeJS.ProcessEnv), "unknown");
  assert.equal(eventOrigin({ GITHUB_EVENT_NAME: "pull_request" } as NodeJS.ProcessEnv), "unknown");
  assert.equal(eventOrigin(env(scratchFile("not-json.txt", "{"))), "unknown");
  assert.equal(eventOrigin(env(scratchEvent("no-repos.json", { pull_request: { number: 1, user: { login: "someone" } } }))), "unknown");
  // With the base missing, the repository the workflow runs in stands in for it.
  const noBase = scratchEvent("no-base.json", { pull_request: { number: 1, user: { login: "someone" }, head: { repo: { full_name: "someone/cli" } } } });
  assert.equal(eventOrigin({ ...env(noBase), GITHUB_REPOSITORY: "owner/cli" }), "fork");
  assert.equal(eventOrigin({ ...env(noBase), GITHUB_REPOSITORY: "someone/cli" }), "same_repository");
});
