// The experimental path end to end, on a repository of four strings with a real diff, a planner
// that picks one call and a judge that answers from the body. No network.
//
// The repository is arranged the way the measured pull request is: the requirement's words name
// the symptom and open one file, while the change is in another file the words never mention. A
// run that only followed the words reaches the first and never the second.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOCAL_CHECK, runLocalCheck, renderLocalCheck, type LocalCheckOptions, type Planner } from "../src/review/local-check-run.ts";
import type { Git } from "../src/repository/git.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import type { ChoiceAnswer, Requirement } from "../src/types.ts";
import type { Mapper, MappingRequest } from "../src/plan/mapping.ts";

/** The changed file. Line 9 is the call the change introduced. */
const INTEGRITY = `use std::path::Path;

/// Read existing baseline from disk.
pub fn read_baseline(base_dir: &Path) -> Result<Option<Baseline>, AppError> {
    let path = baseline_path(base_dir);
    if !path.exists() {
        return Ok(None);
    }
    let content = crate::atomic_file::read_capped(&path, MAX)?;
    Ok(Some(content))
}

fn baseline_path(base_dir: &Path) -> PathBuf {
    base_dir.join(".integrity.json")
}
`;

const INTEGRITY_BEFORE = INTEGRITY.replace("crate::atomic_file::read_capped(&path, MAX)?", "read_plain(&path)?");

const UTIL = `pub(crate) fn read_capped(path: &Path, max: u64) -> io::Result<String> {
    Ok(String::new())
}
`;

/** One hop out from the changed function: nothing here changed. */
const CLI = `pub fn show(base_dir: &Path) -> Result<(), AppError> {
    let baseline = crate::integrity::read_baseline(base_dir)?;
    Ok(())
}
`;

/** What the requirement's own words open. The mechanism the change touched is not in here. */
const ACTIONS = `use std::path::Path;

/// Collect the listing summary for a report.
pub fn collect_summary(root: &Path) -> Result<String, AppError> {
    let summary = gather(root)?;
    Ok(summary)
}

fn gather(root: &Path) -> Result<String, AppError> {
    let client = connect(root, "0123456789abcdef0123456789abcdef0123456789abcdef");
    Ok(String::new())
}
`;

const FILES: Record<string, string> = { "src/integrity.rs": INTEGRITY, "src/util.rs": UTIL, "src/cli.rs": CLI, "src/actions.rs": ACTIONS };

const DIFF = `diff --git a/src/integrity.rs b/src/integrity.rs
--- a/src/integrity.rs
+++ b/src/integrity.rs
@@ -9 +9 @@ pub fn read_baseline(base_dir: &Path)
-    let content = read_plain(&path)?;
+    let content = crate::atomic_file::read_capped(&path, MAX)?;
`;

const fakeGit = {
  async readText(rev: string, path: string) {
    if (rev === "BEFORE" && path === "src/integrity.rs") return INTEGRITY_BEFORE;
    return FILES[path] ?? null;
  },
  async changedFiles() {
    return [{ status: "modified" as const, oldPath: "src/integrity.rs", newPath: "src/integrity.rs" }];
  },
  async diffText() {
    return DIFF;
  },
  async grep(_rev: string, pattern: string) {
    const hits = Object.entries(FILES).flatMap(([path, text]) =>
      text.split("\n").flatMap((line, i) => (new RegExp(`(?<![\\w$])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "i").test(line) ? [{ path, line: i + 1, text: line }] : [])),
    );
    return { hits, more: false };
  },
} as unknown as Git;

const REVISIONS = { before: "BEFORE", after: "AFTER" };

/** Names the symptom, as real requirements do. None of its words are in the changed file. */
const requirement: Requirement = {
  id: "R1",
  text: "A listing summary that cannot be collected is not reported as an empty summary.",
  kind: "behavior",
  priority: "required",
  sourceRefs: [],
  searchHints: [],
};

interface Asked {
  requirement: string;
  listing: string;
}

function scriptedPlanner(): { planner: Planner; asked: Asked[] } {
  const asked: Asked[] = [];
  const planner: Planner = {
    async pick({ requirement: text, listing }) {
      asked.push({ requirement: text, listing: JSON.stringify(listing) });
      const call = listing.calls.find((k) => k.text.includes("gather(root)"));
      return { picks: call ? [{ callId: call.id, clause: "a listing summary that cannot be collected" }] : [] };
    },
  };
  return { planner, asked };
}

/** A quote that is really in the requirement, so `checkMapping` accepts it. */
const QUOTE = "cannot be collected is not reported as an empty summary";

/**
 * Says the requirement governs every call it is asked about. The default for tests that are not
 * about the mapping; the ones that are pass their own.
 */
function scriptedMapper(answer?: (r: MappingRequest) => { raw?: unknown; failed?: string }): { mapper: Mapper; seen: MappingRequest[] } {
  const seen: MappingRequest[] = [];
  const mapper: Mapper = {
    async map(request) {
      seen.push(request);
      return answer ? answer(request) : { raw: { callId: request.callId, verdict: "applies", quote: QUOTE, reason: "the summary is what this call collects" } };
    },
  };
  return { mapper, seen };
}

/** Answers from the body: the condition's own call followed by `?` propagates. */
function scriptedJudge(): { judge: JudgmentProvider; seen: string[]; packets: { symbol?: string; changed: boolean }[] } {
  const seen: string[] = [];
  const packets: { symbol?: string; changed: boolean }[] = [];
  const judge: JudgmentProvider = {
    model: "test",
    async judge(state: unknown, questions: Questions) {
      const candidate = (state as { candidate: { symbol?: string; changed_by_pull_request: boolean } }).candidate;
      packets.push({ symbol: candidate.symbol, changed: candidate.changed_by_pull_request });
      const body = (state as { evidence: { code: string } }).evidence.code.replace(/\s+/g, " ");
      const instructions = (questions as unknown as { on_error_result: { instructions: string } }).on_error_result.instructions;
      const expression = /reaches the call `([^`]+)`/.exec(instructions)?.[1] ?? "";
      seen.push(expression);
      const choice = body.includes(`${expression}?`) ? "returns_error" : "returns_success";
      const out: Record<string, ChoiceAnswer> = {};
      for (const key of Object.keys(questions)) {
        const pick = key === "on_error_result" ? choice : "stops_there";
        out[key] = { choice: pick, confidence: 0.95, probabilities: { [pick]: 0.95 } };
      }
      return out;
    },
  };
  return { judge, seen, packets };
}

async function run(options?: Partial<LocalCheckOptions>) {
  const { planner, asked } = scriptedPlanner();
  const { mapper } = scriptedMapper();
  const { judge, seen, packets } = scriptedJudge();
  const results = await runLocalCheck(fakeGit, REVISIONS, [requirement], planner, mapper, judge, () => true, { ...DEFAULT_LOCAL_CHECK, ...options });
  return { result: results[0]!, results, asked, seen, packets };
}

test("the change reaches the call it introduced, in a file the requirement's words never open", async () => {
  const { result } = await run();
  assert.deepEqual(result.filesOpened, ["src/actions.rs"], "the words name the symptom, and the symptom is not where the work was done");
  const changed = result.observed.find((o) => o.call.includes("read_capped"));
  assert.ok(changed, `the changed call should have been asked about: ${JSON.stringify(result.observed)}`);
  assert.equal(changed.file, "src/integrity.rs");
  assert.equal(changed.function, "read_baseline");
  assert.equal(changed.origin, "changed");
  assert.equal(changed.result.observation, "returns_error");
  assert.equal(changed.result.bearsOnRequirement, false, "a changed line says where the work was done, not that the requirement applies");
});

test("one hop out: a caller of a changed function is a candidate too", async () => {
  const { result } = await run();
  const caller = result.observed.find((o) => o.function === "show");
  assert.ok(caller, `the caller should have been asked about: ${JSON.stringify(result.observed.map((o) => o.function))}`);
  assert.equal(caller.origin, "calls_changed");
  assert.equal(result.counts.functions.calls_changed, 1);
  assert.equal(result.counts.functions.changed, 1);
});

test("a changed function is told to the model as changed, even when the plan also named it", async () => {
  const { mapper } = scriptedMapper();
  // The packet's flag came from the *call's* origin, and a call the planner named has origin
  // `picked` wherever it sits — so a function the pull request rewrote was handed over as
  // untouched, to a model being asked what it returns.
  const { judge, packets } = scriptedJudge();
  const picksTheChangedCall: Planner = {
    async pick({ listing }) {
      const call = listing.calls.find((k) => k.text.includes("read_capped"));
      return { picks: call ? [{ callId: call.id, clause: "a baseline that cannot be read" }] : [] };
    },
  };
  // Open the file the change is in, so the planner is asked about it at all.
  const aboutTheMechanism = { ...requirement, searchHints: ["baseline"] };
  await runLocalCheck(fakeGit, REVISIONS, [aboutTheMechanism], picksTheChangedCall, mapper, judge, () => true, DEFAULT_LOCAL_CHECK);
  const sent = packets.find((p) => p.symbol === "read_baseline");
  assert.ok(sent, `read_baseline should have been judged: ${JSON.stringify(packets)}`);
  assert.equal(sent.changed, true);
  const untouched = packets.find((p) => p.symbol === "show");
  assert.equal(untouched?.changed, false, "and a caller the change did not touch is still not changed");
});

test("what the planner says its picks leave unchecked is reported", async () => {
  const { mapper } = scriptedMapper();
  const { judge } = scriptedJudge();
  const withGaps: Planner = {
    async pick() {
      return { picks: [], notCovered: ["every other call site of the same helper"] };
    },
  };
  const [r] = await runLocalCheck(fakeGit, REVISIONS, [requirement], withGaps, mapper, judge, () => true, DEFAULT_LOCAL_CHECK);
  assert.ok(r!.notes.some((n) => /every other call site of the same helper/.test(n)), r!.notes.join(" | "));
});

test("only a call the planner gave a clause is read against the requirement", async () => {
  const { result } = await run();
  const stated = result.observed.filter((o) => o.result.bearsOnRequirement);
  assert.equal(stated.length, 1);
  assert.equal(stated[0]!.call, "gather(root)");
  assert.equal(stated[0]!.origin, "picked");
});

test("the budget is spent once for the requirement, not once per file", async () => {
  const { result, seen } = await run({ budget: 2 });
  // Three applicable calls in three functions across three files; a per-file budget of 2 would
  // have asked twice in each file it reached.
  assert.equal(result.counts.applicable, 3);
  assert.equal(seen.length, 2, `two questions in all: ${seen.join(" | ")}`);
  assert.equal(result.counts.asked, 2);
  assert.equal(result.counts.overBudget, 1);
  assert.equal(result.unchecked.filter((u) => /budget of 2 was already spent/.test(u.why)).length, 1);
});

test("nothing secret-shaped leaves in a request, packet or question, nor in the report", async () => {
  const { mapper } = scriptedMapper();
  // A request is the packet *and* the questions. Only the packet was being cleaned, and the
  // question text carries the call expression — so a call with a secret-shaped argument went out
  // in the one field nothing touched. The hold that used to cover this was `locateCall` failing
  // to find the raw expression in a redacted body, which was itself a defect and is now fixed.
  const secretish = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const withSecret = INTEGRITY.replace("read_capped(&path, MAX)", `read_capped(&path, "${secretish}")`);
  const files: Record<string, string> = { ...FILES, "src/integrity.rs": withSecret };
  const git = { ...fakeGit, async readText(rev: string, path: string) {
      if (rev === "BEFORE" && path === "src/integrity.rs") return INTEGRITY_BEFORE;
      return files[path] ?? null;
    },
    async grep(_rev: string, pattern: string) {
      const hits = Object.entries(files).flatMap(([path, text]) =>
        text.split("\n").flatMap((line, i) => (new RegExp(`(?<![\\w$])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "i").test(line) ? [{ path, line: i + 1, text: line }] : [])),
      );
      return { hits, more: false };
    } } as unknown as Git;

  const sent: string[] = [];
  const recording: JudgmentProvider = {
    model: "test",
    async judge(state: unknown, questions: Questions) {
      sent.push(JSON.stringify({ state, questions }));
      const out: Record<string, ChoiceAnswer> = {};
      for (const key of Object.keys(questions)) out[key] = { choice: key === "on_error_result" ? "returns_error" : "stops_there", confidence: 0.9, probabilities: {} };
      return out;
    },
  };
  const { planner } = scriptedPlanner();
  const results = await runLocalCheck(git, REVISIONS, [requirement], planner, mapper, recording, () => true, DEFAULT_LOCAL_CHECK);
  assert.ok(sent.length > 0, "something was judged");
  const asked = sent.find((s) => s.includes("read_capped"));
  assert.ok(asked, "including the call that carries it");
  for (const request of sent) assert.ok(!request.includes(secretish), "no request carries it, in either half");
  assert.ok(!renderLocalCheck(results).includes(secretish), "and the report does not print it either");
});

test("what goes to the planner is redacted, the requirement's text and the listing alike", async () => {
  const { mapper } = scriptedMapper();
  const secretish = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const { planner, asked } = scriptedPlanner();
  const { judge } = scriptedJudge();
  await runLocalCheck(fakeGit, REVISIONS, [{ ...requirement, text: `${requirement.text} See ${secretish}.` }], planner, mapper, judge, () => true, DEFAULT_LOCAL_CHECK);
  assert.ok(asked.length > 0, "the planner was asked about at least one file");
  for (const a of asked) {
    assert.ok(!a.listing.includes(secretish), "a long opaque string in the source does not go out in the listing");
    assert.ok(!a.requirement.includes(secretish), "nor in the requirement's own text");
    assert.match(a.listing, /REDACTED LONG STRING/);
  }
});

test("a body that did not fit is held, not answered about half of itself", async () => {
  const { result, seen } = await run({ maxPrimaryChars: 40 });
  assert.equal(seen.length, 0, "nothing was asked");
  assert.equal(result.observed.length, 0);
  const held = result.unchecked.filter((u) => /did not fit the evidence limit/.test(u.why));
  assert.equal(held.length, 3, `every budgeted site is held with the reason: ${JSON.stringify(result.unchecked)}`);
});

test("candidates only: the set and the budget, with no model asked at all", async () => {
  const { mapper } = scriptedMapper();
  const { planner, asked } = scriptedPlanner();
  const { judge, seen } = scriptedJudge();
  const results = await runLocalCheck(fakeGit, REVISIONS, [requirement], planner, mapper, judge, () => true, { ...DEFAULT_LOCAL_CHECK, candidatesOnly: true });
  const r = results[0]!;
  assert.equal(asked.length, 0, "the planner was not consulted");
  assert.equal(seen.length, 0, "nothing was judged");
  assert.equal(r.counts.asked, 0);
  // The diff's own candidates stand without the planner: the changed function and its caller.
  assert.equal(r.counts.functions.changed, 1);
  assert.equal(r.counts.functions.calls_changed, 1);
  assert.equal(r.counts.applicable, 2);
  // The calls the budget selected are the answer this mode exists to give. Reporting only what was
  // held would list everything except them, which reads exactly like not having reached them.
  assert.deepEqual(
    r.wouldAsk.map((w) => `${w.function}:${w.call}`).sort(),
    ["read_baseline:crate::atomic_file::read_capped(&path, MAX)", "show:crate::integrity::read_baseline(base_dir)"],
  );
  const text = renderLocalCheck(results);
  assert.match(text, /the planner was not consulted/);
  assert.match(text, /### Inside the budget/);
  assert.match(text, /read_capped\(&path, MAX\)/);
});

test("calls whose callee is not resolvable here are unchecked, with the reason", async () => {
  const { result } = await run();
  const held = result.unchecked.find((u) => u.call.includes("exists"));
  assert.ok(held, `\`exists()\` has no definition here and should be unchecked: ${JSON.stringify(result.unchecked)}`);
  assert.match(held.why, /no definition in this repository/);
});

test("the report separates what was observed from what was not checked, and states no verdict", async () => {
  const { results } = await run();
  const text = renderLocalCheck(results);
  assert.match(text, /A local observation is not a statement about the requirement/);
  assert.match(text, /### Not checked/);
  assert.match(text, /Functions reached: 1 the change touched/);
  // What is ruled out is this tool concluding something about the requirement as a whole. A
  // finding, when there is one, is printed as two readings that disagree — see the tests below.
  assert.ok(!/violat/i.test(text), "no verdict of the tool's own");
  assert.ok(!/VERIFIED|NOT_VERIFIED/.test(text), "and no requirement-level status");
});

test("the plan's clause is model prose, and is contained before it reaches the report", async () => {
  const { mapper } = scriptedMapper();
  // Nothing enforces the schema on the way back: `readModelJson` parses and returns. The clause
  // was the one field where a model's sentence went into the Markdown untouched — which is also
  // the only field a verdict would fit in, on a path whose whole promise is that it states none.
  // Words rather than one long run: an unbroken run of 400 characters is secret-shaped, and
  // redaction — which runs first — would replace it before the length ever mattered.
  const hostile = `first line\nsecond line \`code span\` ${"long ".repeat(100)}`;
  const { judge } = scriptedJudge();
  const loud: Planner = {
    async pick({ listing }) {
      const call = listing.calls.find((k) => k.text.includes("gather(root)"));
      return { picks: call ? [{ callId: call.id, clause: hostile }] : [] };
    },
  };
  const results = await runLocalCheck(fakeGit, REVISIONS, [requirement], loud, mapper, judge, () => true, DEFAULT_LOCAL_CHECK);
  const clause = results[0]!.observed.find((o) => o.result.bearsOnRequirement)!.result.clause!;
  assert.ok(!clause.includes("\n"), "one line: a newline would end the bullet it sits in");
  assert.ok(!clause.includes("`"), "no code span to break out of");
  assert.ok(clause.length <= 300, `bounded, got ${clause.length}`);
  assert.ok(clause.startsWith("first line second line code span long"), clause);
  assert.ok(clause.endsWith("…"), "and says it was cut");
  // And it is attributed where it is printed, rather than read as this tool's own sentence.
  assert.match(renderLocalCheck(results), /The plan said this call checks: "first line second line/);
});

test("a planner that could not answer is not reported as a planner that found nothing", async () => {
  const { mapper } = scriptedMapper();
  // Both end in no call carrying a clause, and a report that shows them alike is a failed request
  // dressed as a decision — the same shape as the checks this path had to take apart.
  const { judge } = scriptedJudge();
  const quiet: Planner = { async pick() { return { picks: [] }; } };
  const broken: Planner = { async pick() { return { picks: [], failed: "the endpoint timed out" }; } };
  const [a] = await runLocalCheck(fakeGit, REVISIONS, [requirement], quiet, mapper, judge, () => true, DEFAULT_LOCAL_CHECK);
  const [b] = await runLocalCheck(fakeGit, REVISIONS, [requirement], broken, mapper, judge, () => true, DEFAULT_LOCAL_CHECK);
  assert.ok(a!.notes.some((n) => /named no call the requirement governs/.test(n)), a!.notes.join(" | "));
  assert.ok(b!.notes.some((n) => /did not answer about .*the endpoint timed out/.test(n)), b!.notes.join(" | "));
});

test("a planner that picks nothing still leaves the change's own candidates", async () => {
  const { mapper } = scriptedMapper();
  const nothing: Planner = {
    async pick() {
      return { picks: [] };
    },
  };
  const { judge } = scriptedJudge();
  const results = await runLocalCheck(fakeGit, REVISIONS, [requirement], nothing, mapper, judge, () => true, DEFAULT_LOCAL_CHECK);
  const r = results[0]!;
  assert.equal(r.picks.length, 0);
  assert.ok(
    r.observed.some((o) => o.call.includes("read_capped")),
    "the changed call is not dropped because the planner did not name it",
  );
  for (const o of r.observed) assert.equal(o.result.bearsOnRequirement, false);
});

// ---------------------------------------------------------------------------
// From an observation to something worth checking.
//
// A finding needs both halves: a requirement read as governing this call, and a reading of the
// call that contradicts it. These fix one half at a time and watch the other decide.
// ---------------------------------------------------------------------------

/** The same repository, with the changed call swallowing its failure — the shape a mutant has. */
const SWALLOWING = INTEGRITY.replace("let content = crate::atomic_file::read_capped(&path, MAX)?;", "let Ok(content) = crate::atomic_file::read_capped(&path, MAX) else { return Ok(None) };");

function swallowingGit(): Git {
  const files: Record<string, string> = { ...FILES, "src/integrity.rs": SWALLOWING };
  return {
    ...fakeGit,
    async readText(rev: string, path: string) {
      if (rev === "BEFORE" && path === "src/integrity.rs") return INTEGRITY_BEFORE;
      return files[path] ?? null;
    },
    async grep(_rev: string, pattern: string) {
      const hits = Object.entries(files).flatMap(([path, text]) =>
        text.split("\n").flatMap((line, i) => (new RegExp(`(?<![\\w$])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "i").test(line) ? [{ path, line: i + 1, text: line }] : [])),
      );
      return { hits, more: false };
    },
  } as unknown as Git;
}

async function findings(mapper: Mapper, git: Git = swallowingGit()) {
  const { planner } = scriptedPlanner();
  const { judge } = scriptedJudge();
  const results = await runLocalCheck(git, REVISIONS, [requirement], planner, mapper, judge, () => true, DEFAULT_LOCAL_CHECK);
  return { r: results[0]!, text: renderLocalCheck(results) };
}

test("a governed call that swallows its failure is reported, with everything needed to disagree", async () => {
  const { mapper } = scriptedMapper();
  const { r, text } = await findings(mapper);
  const f = r.findings.find((x) => x.function === "read_baseline");
  assert.ok(f, `the swallowing call should be worth checking: ${JSON.stringify(r.findings)}`);
  assert.equal(f.quote, QUOTE);
  assert.equal(f.observation, "returns_success");
  assert.match(f.condition, /Execution reaches the call/);
  assert.match(f.disagreement, /returning one/);
  assert.match(text, /### Worth checking/);
  assert.match(text, /\*\*The requirement says\*\*: "cannot be collected/);
  assert.match(text, /neither checks the other/);
});

test("the same call, with the requirement read as not governing it, is not reported", async () => {
  // The fixture for a requirement that allows carrying on: nothing about the code changed, and the
  // observation is the same `returns_success`. Only the mapping differs.
  const { mapper } = scriptedMapper((request) => ({ raw: { callId: request.callId, verdict: "does_not_apply", quote: "", reason: "the requirement allows this read to be skipped" } }));
  const { r, text } = await findings(mapper);
  assert.equal(r.findings.length, 0);
  assert.ok(r.observed.some((o) => o.result.observation === "returns_success"), "the observation is unchanged; only the mapping is");
  assert.match(text, /### Read, but not answered against the requirement/);
  assert.match(text, /does not govern this call: the requirement allows this read to be skipped/);
  assert.ok(!/### Worth checking/.test(text));
});

test("a requirement that does not settle the call, and a mapping that did not come back, are two different things", async () => {
  const unsure = await findings(scriptedMapper((r) => ({ raw: { callId: r.callId, verdict: "unknown", quote: "", reason: "the requirement says nothing about this read" } })).mapper);
  const broken = await findings(scriptedMapper(() => ({ failed: "the endpoint timed out" })).mapper);
  assert.equal(unsure.r.findings.length, 0);
  assert.equal(broken.r.findings.length, 0);
  assert.match(unsure.text, /does not settle this call/);
  assert.match(broken.text, /was not answered \(the endpoint timed out\)/);
});

test("a mapping is refused when it answers another call, or quotes what is not there", async () => {
  const elsewhere = await findings(scriptedMapper(() => ({ raw: { callId: "src/nowhere.rs:call-9", verdict: "applies", quote: QUOTE, reason: "…" } })).mapper);
  const invented = await findings(scriptedMapper((r) => ({ raw: { callId: r.callId, verdict: "applies", quote: "must never be swallowed under any circumstances", reason: "…" } })).mapper);
  assert.equal(elsewhere.r.findings.length, 0);
  assert.equal(invented.r.findings.length, 0);
  assert.match(elsewhere.text, /not about src\/integrity\.rs:call-\d+/);
  assert.match(invented.text, /the quote is not in the requirement's text/);
});

test("an answer about one call is not filed against another, even when both are being asked about", async () => {
  // The check used to be membership of this run's set, so an answer naming a *different* real
  // candidate passed every test and the finding was filed against whichever call was in hand.
  // Here every answer after the first repeats the first call's id, with a quote that really is in
  // the requirement and a reason really about that first call.
  let first: string | undefined;
  const crossed = scriptedMapper((r) => {
    const callId = first ?? r.callId;
    first ??= r.callId;
    return { raw: { callId, verdict: "applies", quote: QUOTE, reason: "an answer about the first call" } };
  });
  const { r, text } = await findings(crossed.mapper);
  const swallowing = r.mappings.find((m) => m.function === "read_baseline");
  assert.ok(swallowing, `read_baseline was asked about: ${JSON.stringify(r.mappings.map((m) => m.function))}`);
  assert.equal(swallowing.accepted, false);
  assert.equal(swallowing.refusedAs, "wrong_call");
  assert.notEqual(swallowing.returnedCallId, swallowing.askedCallId);
  assert.equal(r.findings.filter((f) => f.function === "read_baseline").length, 0, "the swallowing call gets no finding from an answer about another call");
  assert.match(text, /another call in this run's set/);
});

test("the mapping is recorded whether or not anything came of it", async () => {
  // A run on holding code finds nothing, and what has to be readable there is the mapping itself.
  const { mapper } = scriptedMapper();
  const { r, text } = await findings(mapper, fakeGit);
  assert.equal(r.findings.length, 0);
  assert.equal(r.counts.mapped, r.mappings.length, "one record per request");
  assert.equal(r.counts.governed, r.mappings.filter((m) => m.accepted && m.verdict === "applies").length);
  const kept = r.mappings.find((m) => m.accepted && m.verdict === "applies");
  assert.ok(kept, JSON.stringify(r.mappings));
  assert.equal(kept.quote, QUOTE);
  assert.equal(kept.askedCallId, kept.returnedCallId);
  assert.ok(kept.reason && kept.reason.length > 0);
  assert.match(text, /### Read as governed by the requirement/);
});

test("the mapping is asked before the judgment and is never told the answer", async () => {
  const { mapper, seen } = scriptedMapper();
  const { r } = await findings(mapper);
  assert.ok(seen.length > 0);
  assert.equal(r.counts.mapped, seen.length);
  for (const request of seen) {
    const fields = Object.keys(request);
    assert.deepEqual(fields.sort(), ["body", "call", "callId", "function", "requirementId", "requirementText"], "no answer and no probability is among them");
    assert.ok(!/returns_error|returns_success|probability/.test(JSON.stringify(request)), "nor anywhere inside them");
  }
});

test("a call the requirement governs that does propagate is not reported", async () => {
  // The shipped shape. Same mapping, same requirement; the code is what differs.
  const { mapper } = scriptedMapper();
  const { r } = await findings(mapper, fakeGit);
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  assert.ok(r.observed.every((o) => o.result.observation === "returns_error"));
});
