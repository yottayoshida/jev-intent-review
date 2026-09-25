// bench/eval/retro (#89): what the writer of a retrospective requirement may see, how the original
// pull request is found, and how the annotators are asked.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertEmptyDir, claudeArgs, SYSTEM_PROMPT } from "../bench/eval/baseline.ts";
import { clopperPearson } from "../bench/eval/metrics.ts";
import { BUNDLE_FIELDS, bundleAt, closesIn, cut, fetchBundle, textAt, titleAt, type RawItem, type RawPull, type Text } from "../bench/eval/retro/material.ts";
import { namedOrigins, originOf, removedLines, type OriginDeps } from "../bench/eval/retro/origin.ts";
import { acceptRequirements, CHECK_SYSTEM, checkRequest, MAX_ITEMS, readAnswer, WRITE_SYSTEM, writeRequest } from "../bench/eval/retro/prompts.ts";
import { EARLIEST_FIX, LIMIT, PHRASES, rangeProblem, rowsOf, searchRange, type Hit } from "../bench/eval/retro/search.ts";

const MERGED = "2026-08-10T12:00:00Z";
const JUST_BEFORE = "2026-08-10T11:59:59Z";
const JUST_AFTER = "2026-08-10T12:00:01Z";

const text = (body: string, createdAt: string | null = "2026-08-01T00:00:00Z", lastEditedAt: string | null = null, edits: Text["edits"] = []): Text => ({ createdAt, body, lastEditedAt, edits });

function pull(over: Partial<RawPull> = {}): RawPull {
  return { repo: "o/r", number: 7, title: "Read the config", renames: [], text: text("Reading must fail loudly."), comments: [], reviews: [], reviewComments: [], connected: [], mergedAt: MERGED, ...over };
}

test("a body edited after the merge is read back to its version at the merge", () => {
  const t = text("after: mentions the fix", "2026-08-01T00:00:00Z", JUST_AFTER, [
    { editedAt: JUST_AFTER, deletedAt: null, diff: "after: mentions the fix" },
    { editedAt: JUST_BEFORE, deletedAt: null, diff: "at merge" },
    { editedAt: "2026-08-01T00:00:00Z", deletedAt: null, diff: "first" },
  ]);
  assert.equal(textAt(t, MERGED), "at merge");
  assert.equal(textAt({ ...t, lastEditedAt: JUST_BEFORE }, MERGED), t.body, "not edited after the merge: read as it is");
});

test("a body edited after the merge with no usable history has no version at the merge", () => {
  assert.equal(textAt(text("now", "2026-08-01T00:00:00Z", JUST_AFTER, []), MERGED), null);
  assert.equal(textAt(text("now", "2026-08-01T00:00:00Z", JUST_AFTER, [{ editedAt: JUST_BEFORE, deletedAt: JUST_AFTER, diff: null }]), MERGED), null, "a deleted version is not a version");
  const b = bundleAt(pull({ text: text("now", "2026-08-01T00:00:00Z", JUST_AFTER, []) }), []);
  assert.deepEqual(b.unavailable, ["#7 body"]);
  assert.equal(b.pull.body, "");
});

test("a title renamed after the merge is renamed back; one renamed before stays", () => {
  const item = { title: "Fix the swallowed error in load", renames: [
    { createdAt: JUST_AFTER, previousTitle: "Read the config", currentTitle: "Read the config (see #9)" },
    { createdAt: "2026-08-20T00:00:00Z", previousTitle: "Read the config (see #9)", currentTitle: "Fix the swallowed error in load" },
    { createdAt: "2026-08-02T00:00:00Z", previousTitle: "WIP", currentTitle: "Read the config" },
  ] };
  assert.equal(titleAt(item, MERGED), "Read the config");
  assert.equal(titleAt({ title: "Read the config", renames: [] }, MERGED), "Read the config");
});

test("nothing made or edited after the merge reaches the bundle; what came just before does", () => {
  const issue = (number: number, createdAt: string, comments: Text[] = []): RawItem => ({ number, title: `issue ${number}`, renames: [], text: text(`issue ${number} body`, createdAt), comments });
  const p = pull({
    comments: [text("before", JUST_BEFORE), text("after: this broke load()", JUST_AFTER), text("edited later", "2026-08-05T00:00:00Z", JUST_AFTER, [{ editedAt: "2026-08-05T00:00:00Z", deletedAt: null, diff: "as written" }])],
    reviews: [{ ...text("LGTM", JUST_BEFORE), state: "APPROVED" }, { ...text("post-merge: load swallows", JUST_AFTER), state: "COMMENTED" }],
    reviewComments: [text("inline before", JUST_BEFORE), text("inline after", JUST_AFTER)],
    // #4 existed before the merge and was linked only after it, as a bug report often is.
    connected: [{ number: 3, at: JUST_BEFORE }, { number: 9, at: JUST_AFTER }, { number: 4, at: JUST_AFTER }],
  });
  const b = bundleAt(p, [issue(3, "2026-07-20T00:00:00Z", [text("issue comment before", JUST_BEFORE), text("issue comment after: still broken", JUST_AFTER)]), issue(9, "2026-08-11T00:00:00Z"), issue(4, "2026-07-01T00:00:00Z")]);
  const seen = JSON.stringify(b);
  for (const later of ["after:", "post-merge", "inline after", "issue 9", "issue 4", "still broken", "edited later"]) assert.ok(!seen.includes(later), `${later} is not in the bundle`);
  assert.deepEqual(b.pull.comments, ["before", "as written"]);
  assert.deepEqual(b.pull.reviews, ["LGTM", "inline before"]);
  assert.deepEqual(b.issues.map((i) => [i.number, i.comments]), [[3, ["issue comment before"]]]);
  assert.deepEqual(Object.keys(b), [...BUNDLE_FIELDS]);
});

test("fetchBundle cuts what GitHub returns at the merge, and follows a closing keyword in the body as it stood then", () => {
  const asked: number[] = [];
  const edits = (nodes: unknown[] = []) => ({ nodes });
  const graph = (query: string, vars: Record<string, string | number>) => {
    if (query.includes("pullRequest")) {
      return { repository: { pullRequest: {
        number: 7, title: "Read the config (see #9)", mergedAt: MERGED, createdAt: "2026-08-01T00:00:00Z", lastEditedAt: JUST_AFTER,
        body: "Closes #5 and #9", userContentEdits: edits([{ editedAt: JUST_AFTER, deletedAt: null, diff: "Closes #5 and #9" }, { editedAt: "2026-08-01T00:00:00Z", deletedAt: null, diff: "Closes #5" }]),
        comments: { nodes: [] }, reviews: { nodes: [] },
        timelineItems: { nodes: [{ __typename: "RenamedTitleEvent", createdAt: JUST_AFTER, previousTitle: "Read the config", currentTitle: "Read the config (see #9)" }] },
      } } };
    }
    asked.push(Number(vars.n));
    return { repository: { issue: { number: vars.n, title: `issue ${vars.n}`, createdAt: "2026-07-01T00:00:00Z", lastEditedAt: null, body: "b", userContentEdits: edits(), comments: { nodes: [] }, timelineItems: { nodes: [] } } } };
  };
  const b = fetchBundle("o/r", 7, graph);
  assert.equal(b.pull.title, "Read the config");
  assert.equal(b.pull.body, "Closes #5");
  assert.deepEqual(asked, [5], "#9 was added to the body after the merge");
  assert.deepEqual(closesIn("fixes #12, Resolves: #13, see #14"), [12, 13]);
});

test("a list GitHub cut short is named, and a filtered timeline is compared by its filtered count", () => {
  assert.deepEqual(cut({ totalCount: 150, nodes: new Array(100) }, "#7 comments"), ["#7 comments: 100 of 150 fetched"]);
  assert.deepEqual(cut({ totalCount: 3, nodes: new Array(3) }, "#7 comments"), []);
  // Measured: a timeline filtered to renames and links reports every event in totalCount.
  assert.deepEqual(cut({ totalCount: 9, filteredCount: 0, nodes: [] }, "#7 renames and links"), []);
  assert.deepEqual(cut({ totalCount: 9, filteredCount: 2, nodes: [{}] }, "#7 renames and links"), ["#7 renames and links: 1 of 2 fetched"]);
});

test("an issue named before the merge that cannot be read, or a list cut short, leaves the bundle incomplete", () => {
  const graph = (query: string) => {
    if (query.includes("pullRequest")) {
      return { repository: { pullRequest: {
        number: 7, title: "t", mergedAt: MERGED, createdAt: "2026-08-01T00:00:00Z", lastEditedAt: null, body: "Closes #5", userContentEdits: { nodes: [] },
        comments: { totalCount: 120, nodes: [] }, reviews: { totalCount: 0, nodes: [] }, timelineItems: { filteredCount: 0, nodes: [] },
      } } };
    }
    throw new Error("Could not resolve to an Issue with the number of 5.");
  };
  assert.deepEqual(fetchBundle("o/r", 7, graph).unavailable, ["#7 comments: 0 of 120 fetched", "#5, named before the merge, could not be read as an issue (a pull request's number, or one that is gone)"]);
});

test("a review begun before the merge and submitted after it, or never submitted, is not in the bundle", () => {
  const p = pull({ reviews: [{ ...text("begun early, sent late: load() swallows", JUST_AFTER), state: "COMMENTED" }, { ...text("pending", null), state: "PENDING" }], reviewComments: [text("drafted before", null)] });
  const b = bundleAt(p, []);
  assert.deepEqual(b.pull.reviews, []);
  // What fetchBundle takes as a review's time: submittedAt, not createdAt.
  const graph = () => ({ repository: { pullRequest: {
    number: 7, title: "t", mergedAt: MERGED, createdAt: "2026-08-01T00:00:00Z", lastEditedAt: null, body: "b", userContentEdits: { nodes: [] },
    comments: { totalCount: 1, nodes: [{ createdAt: JUST_BEFORE, publishedAt: JUST_AFTER, body: "comment published after", lastEditedAt: null, userContentEdits: { nodes: [] } }] },
    reviews: { totalCount: 1, nodes: [{ state: "COMMENTED", createdAt: JUST_BEFORE, submittedAt: JUST_AFTER, body: "review submitted after", lastEditedAt: null, userContentEdits: { nodes: [] }, comments: { totalCount: 1, nodes: [{ createdAt: JUST_BEFORE, publishedAt: JUST_AFTER, body: "inline published after", lastEditedAt: null, userContentEdits: { nodes: [] } }] } }] },
    timelineItems: { filteredCount: 0, nodes: [] },
  } } });
  const f = fetchBundle("o/r", 7, graph);
  assert.deepEqual([f.pull.comments, f.pull.reviews], [[], []]);
});

test("the version at the merge deleted from the history is not replaced by an older one", () => {
  const t = text("now", "2026-08-01T00:00:00Z", JUST_AFTER, [
    { editedAt: JUST_BEFORE, deletedAt: "2026-08-30T00:00:00Z", diff: null },
    { editedAt: "2026-08-01T00:00:00Z", deletedAt: null, diff: "first" },
  ]);
  assert.equal(textAt(t, MERGED), null);
});

test("a failure that is not about the case — a rate limit, the network — stops the fetch instead of deciding it", () => {
  const graph = (query: string) => {
    if (query.includes("pullRequest")) return { repository: { pullRequest: { number: 7, title: "t", mergedAt: MERGED, createdAt: "2026-08-01T00:00:00Z", lastEditedAt: null, body: "Closes #5", userContentEdits: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] }, timelineItems: { filteredCount: 0, nodes: [] } } } };
    throw new Error("API rate limit exceeded");
  };
  assert.throws(() => fetchBundle("o/r", 7, graph), /rate limit/);
});

const FIX = { base: "base", mergedAt: "2026-08-20T00:00:00Z" };
const pullNo = (number: number, mergedAt: string | null = "2026-07-10T00:00:00Z", mergeCommit: string | null = `m${number}`) => ({ number, mergedAt, mergeCommit });
const noGit = { blame: () => null, whitespaceOnly: () => false, parent: () => null, pullsOf: () => [], onDefault: () => true };

test("a named pull request comes before blame, when it is one merged into the default branch before the fix", () => {
  assert.deepEqual(namedOrigins(["This is a regression from #412.", "Introduced in PR #88; also see #90"]), [412, 88]);
  assert.deepEqual(namedOrigins(["See #5 for context"]), []);
  // Another project's number is not named, even when this repository has a pull request of that number.
  assert.deepEqual(namedOrigins(["A regression in #500 of the tokio crate.", "Broken by #12 in serde", "Introduced in #7 in this repository"]), [7]);
  const deps: OriginDeps = { ...noGit, blame: () => { throw new Error("not asked"); }, pull: (n) => (n === 412 ? pullNo(412) : null) };
  assert.deepEqual(originOf([412], FIX, "", deps), { number: 412, by: "named" });
});

test("a named number that is an issue, unmerged, off the default branch, or merged after the fix is passed over for blame", () => {
  // "a bug reported in #123" names an issue; "in #500 of the tokio crate" names another repository's.
  const pulls: Record<number, ReturnType<typeof pullNo>> = { 7: pullNo(7, null, null), 8: pullNo(8, "2026-07-01T00:00:00Z", "offmain"), 9: pullNo(9, "2026-09-01T00:00:00Z") };
  const diff = "--- a/x.rs\n+++ b/x.rs\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const deps: OriginDeps = { ...noGit, pull: (n) => pulls[n] ?? null, onDefault: (sha) => sha !== "offmain", blame: () => "s".repeat(40), pullsOf: () => [pullNo(3)] };
  assert.deepEqual(originOf([123, 7, 8, 9], FIX, diff, deps), { number: 3, by: "blame", share: 1 });
});

test("a fix that removes no line, with nothing usable named, has no origin", () => {
  const add = "--- a/src/x.rs\n+++ b/src/x.rs\n@@ -3,0 +4,2 @@\n+    check()?;\n+    ok\n";
  assert.equal(removedLines(add).size, 0);
  assert.equal(originOf([], FIX, add, { ...noGit, pull: () => null }).number, null);
});

test("a removed line that begins with '-- ' is a removed line, not the next file's header", () => {
  const diff = ["--- a/m.sql", "+++ b/m.sql", "@@ -1,3 +1,1 @@", "--- drop this comment", "-select 1;", " end;", "+", "--- a/x.rs", "+++ b/x.rs", "@@ -4,1 +4,1 @@", "-old", "+new", ""].join("\n");
  assert.deepEqual([...removedLines(diff)], [["m.sql", [1, 2]], ["x.rs", [4]]]);
});

test("the pull request holding most of the removed lines is the origin, not the oldest one touched", () => {
  // As omamori #553: the defect's lines from one pull request, incidental lines of older code from another.
  const diff = ["--- a/src/doctor.rs", "+++ b/src/doctor.rs", "@@ -10,3 +10,1 @@", "-a", "-b", "-c", "+x", "--- a/src/hook.rs", "+++ b/src/hook.rs", "@@ -5,1 +5,1 @@", "-old", "+new", ""].join("\n");
  const shaOf: Record<string, string> = { "src/doctor.rs": "d".repeat(40), "src/hook.rs": "h".repeat(40) };
  const deps: OriginDeps = { ...noGit, pull: () => null, blame: (_rev, file) => shaOf[file] ?? null, pullsOf: (sha) => (sha === shaOf["src/doctor.rs"] ? [pullNo(329, "2026-06-16T00:00:00Z")] : [pullNo(189, "2026-04-25T00:00:00Z")]) };
  assert.deepEqual(originOf([], FIX, diff, deps), { number: 329, by: "blame", share: 0.75 });
});

test("blame skips a whitespace-only commit and takes the pull request whose merge is on the default branch", () => {
  const repo = mkdtempSync(join(tmpdir(), "jir-origin-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "x.rs"), "fn a() {}\nfn load() { let _ = read(); }\n");
    git("add", "."), git("commit", "-q", "-m", "introduce");
    const introduced = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "x.rs"), "fn a() {}\nfn load() {   let _ = read();   }\n");
    git("commit", "-qam", "fmt");
    const fmt = git("rev-parse", "HEAD");
    const diff = "--- a/x.rs\n+++ b/x.rs\n@@ -2,1 +2,1 @@\n-fn load() {   let _ = read();   }\n+fn load() -> Result<()> { read()?; Ok(()) }\n";
    assert.deepEqual(removedLines(diff).get("x.rs"), [2]);
    // #30 merged earliest, into a branch that never reached main; #11 never merged; #12 is main's.
    const pulls: Record<string, ReturnType<typeof pullNo>[]> = {
      [introduced]: [pullNo(30, "2026-07-05T00:00:00Z", "release-merge"), pullNo(12, "2026-07-10T00:00:00Z", introduced), pullNo(11, null, null)],
      [fmt]: [pullNo(40, "2026-07-01T00:00:00Z", fmt)],
    };
    const deps: OriginDeps = {
      pull: () => null,
      onDefault: (sha) => sha !== "release-merge",
      blame: (rev, file, line) => /^[0-9a-f]{40}/.exec(execFileSync("git", ["-C", repo, "blame", "--porcelain", "-L", `${line},${line}`, rev, "--", file], { encoding: "utf8" }))?.[0] ?? null,
      whitespaceOnly: (sha) => execFileSync("git", ["-C", repo, "show", "-w", "--format=", "--stat", sha], { encoding: "utf8" }).trim() === "",
      parent: (sha) => git("rev-parse", `${sha}^`),
      pullsOf: (sha) => pulls[sha] ?? [],
    };
    // Plain blame (no -w) names the fmt commit; the step past it finds the one that put the call there.
    assert.deepEqual(originOf([], { base: fmt, mergedAt: FIX.mergedAt }, diff, deps), { number: 12, by: "blame", share: 1 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the writer is shown the bundle and nothing else; the fix reaches only the check", () => {
  const b = bundleAt(pull(), []);
  const request = writeRequest(b);
  assert.ok(request.includes("Reading must fail loudly."));
  assert.throws(() => writeRequest({ ...b, fix: "the later diff" } as never), /fields the writer may not see: fix/);
  const fix = { ref: "o/r#20", title: "Stop swallowing read errors", body: "load() ignored the error", diff: "-let _ = read();\n+read()?;" };
  const check = checkRequest(b, fix, [{ text: "Reading the config fails when read fails.", quote: "Reading must fail loudly." }]);
  assert.ok(check.includes("load() ignored the error"));
  assert.ok(!request.includes("swallowing"));
});

test("an annotator runs as the baseline does, with its own system prompt", () => {
  const args = claudeArgs("the request", WRITE_SYSTEM);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project");
  assert.equal(args[args.indexOf("--system-prompt") + 1], WRITE_SYSTEM);
  assert.equal(claudeArgs("q")[claudeArgs("q").indexOf("--system-prompt") + 1], SYSTEM_PROMPT, "the baseline's own call is unchanged");
  assert.ok(WRITE_SYSTEM.includes(`at most ${MAX_ITEMS} items`));
  assert.ok(!/fix|defect|bug/i.test(WRITE_SYSTEM), "the writer's prompt does not say a defect was found later");
  assert.ok(CHECK_SYSTEM.includes("could only be known from the later fix"));
});

test("a written requirement is held to three items, each quoting the material word for word", () => {
  const b = bundleAt(pull({ text: text("Reading the config\n  must fail loudly.") }), []);
  const ok = { requirements: [{ text: "load() returns the read error.", quote: "Reading the config must fail loudly." }] };
  assert.deepEqual(acceptRequirements(ok, b), { requirements: ok.requirements });
  assert.deepEqual(acceptRequirements({ requirements: [], why: "nothing about failure" }, b), { none: "nothing about failure" });
  const four = { requirements: Array.from({ length: MAX_ITEMS + 1 }, () => ok.requirements[0]) };
  assert.match((acceptRequirements(four, b) as { invalid: string }).invalid, /more than 3/);
  const invented = { requirements: [{ text: "x", quote: "load() must propagate the error" }] };
  assert.match((acceptRequirements(invented, b) as { invalid: string }).invalid, /not in the material/);
  assert.match((acceptRequirements({ nope: 1 }, b) as { invalid: string }).invalid, /no list/);
});

test("an annotator's directory is refused when it, or any directory above it, is a repository", () => {
  const home = mkdtempSync(join(tmpdir(), "jir-empty-"));
  try {
    const inside = join(home, "a", "b");
    mkdirSync(inside, { recursive: true });
    assert.doesNotThrow(() => assertEmptyDir(inside));
    writeFileSync(join(home, "CLAUDE.md"), "instructions");
    assert.throws(() => assertEmptyDir(inside), /CLAUDE\.md or \.claude would reach the model/);
    rmSync(join(home, "CLAUDE.md"));
    mkdirSync(join(home, "a", ".git"));
    assert.throws(() => assertEmptyDir(inside), /inside a repository/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an answer counts only from the one model, as JSON", () => {
  const sent = { system: "s", request: "r", bytes: 2 };
  const out = (model: string, result: string) => JSON.stringify({ result, modelUsage: { [model]: {} } });
  assert.equal(readAnswer(out("claude-opus-5-5", '```json\n{"requirements":[]}\n```'), sent).counted, true);
  assert.equal(readAnswer(out("claude-haiku-4-5", '{"requirements":[]}'), sent).counted, false);
  assert.equal(readAnswer(out("claude-opus-5-5", "no requirement"), sent).counted, false);
});

test("RETRO.md's table of detections needed is what the interval gives for a lower bound above 0.20", () => {
  const doc = readFileSync(new URL("../bench/eval/RETRO.md", import.meta.url), "utf8");
  const row = (label: string) => doc.split("\n").find((l) => l.startsWith(`| ${label}`))!.split("|").slice(2, -1).map((c) => Number(c.trim()));
  const repos = row("repositories");
  const needed = row("detections needed");
  assert.equal(repos.length, needed.length);
  repos.forEach((n, i) => {
    const x = needed[i]!;
    assert.ok(clopperPearson(x, n).lower > 0.2, `${x}/${n} clears 0.20`);
    assert.ok(clopperPearson(x - 1, n).lower <= 0.2, `${x - 1}/${n} does not`);
  });
});

test("a range where a phrase reaches the search's limit is split until none does, and a full single day is recorded as cut", () => {
  // One result per phrase per day, except "ignored error": 40 a day from the 1st to the 4th, and 120 on the 3rd.
  const perDay = (phrase: string, d: string) => (phrase !== "ignored error" ? 1 : d === "2026-09-03" ? 120 : Number(d.slice(8)) <= 4 ? 40 : 1);
  const asked: string[] = [];
  const run = (phrase: string, from: string, to: string): Hit[] => {
    asked.push(`${phrase}@${from}..${to}`);
    const out: Hit[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      for (let i = 0; i < perDay(phrase, d); i++) out.push({ number: Number(d.slice(8)) * 1000 + i, title: "t", repository: { nameWithOwner: `o/${phrase.length}` }, closedAt: `${d}T01:00:00Z` });
    }
    return out.slice(0, LIMIT);
  };
  const { windows, hits } = searchRange("2026-09-01", "2026-09-08", run);
  for (const w of windows) for (const p of PHRASES) if (!w.cut.includes(p)) assert.ok(w.found[p]! < LIMIT, `${w.from}..${w.to} ${p} below the limit`);
  assert.deepEqual(windows.filter((w) => w.cut.length > 0).map((w) => [w.from, w.to, w.cut]), [["2026-09-03", "2026-09-03", ["ignored error"]]]);
  assert.deepEqual([windows[0]!.from, windows.at(-1)!.to], ["2026-09-01", "2026-09-08"], "the windows cover the range");
  // Every day's results are there, the cut day's first 100 aside.
  assert.equal(hits.get("ignored error")!.length, 40 * 3 + 100 + 4);
  assert.equal(hits.get("swallow error")!.length, 8);
});

test("a range is searched only after its days have settled, and only older than every range before it", () => {
  const today = "2026-09-25";
  assert.equal(rangeProblem("2026-09-01", "2026-09-23", today, []), null);
  assert.match(rangeProblem("2026-09-01", "2026-09-24", today, [])!, /less than 2 days old/);
  assert.match(rangeProblem("2026-06-20", "2026-07-10", today, [])!, /before 2026-07-01/);
  assert.equal(rangeProblem("2026-08-01", "2026-08-31", today, [{ from: "2026-09-01" }]), null);
  assert.match(rangeProblem("2026-09-10", "2026-09-12", "2026-10-01", [{ from: "2026-09-01" }])!, /newest first/);
  assert.match(rangeProblem("2026-09-24", "2026-09-26", "2026-10-01", [{ from: "2026-09-01" }])!, /newest first/, "a newer range after an older one breaks the order");
});

test("the search keeps its own repositories and later fixes only, newest first", () => {
  const hit = (repo: string, number: number, closedAt: string) => ({ number, title: `t${number}`, repository: { nameWithOwner: repo }, closedAt });
  const hits = new Map([
    ["ignored error", [hit("New/A", 1, "2026-09-10T00:00:00Z"), hit("Dev/B", 2, "2026-09-11T00:00:00Z"), hit("New/C", 3, "2026-09-20T00:00:00Z")]],
    ["swallow error", [hit("New/A", 1, "2026-09-10T00:00:00Z"), hit("Of80/D", 4, "2026-09-12T00:00:00Z"), hit("New/E", 5, "2026-06-30T00:00:00Z")]],
  ]);
  const { rows, left } = rowsOf(hits, new Set(["dev/b"]), new Set(["of80/d"]), 10);
  assert.deepEqual(rows.map((r) => [r.order, r.ref, r.queries]), [[11, "New/C#3", ["ignored error"]], [12, "New/A#1", ["ignored error", "swallow error"]]]);
  assert.deepEqual(left, { onSplit: 1, inSearchOf80: 1, beforeEarliest: 1 });
  assert.equal(EARLIEST_FIX, "2026-07-01");
});
