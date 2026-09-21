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
  const { judge, seen, packets } = scriptedJudge();
  const results = await runLocalCheck(fakeGit, REVISIONS, [requirement], planner, judge, () => true, { ...DEFAULT_LOCAL_CHECK, ...options });
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
  await runLocalCheck(fakeGit, REVISIONS, [aboutTheMechanism], picksTheChangedCall, judge, () => true, DEFAULT_LOCAL_CHECK);
  const sent = packets.find((p) => p.symbol === "read_baseline");
  assert.ok(sent, `read_baseline should have been judged: ${JSON.stringify(packets)}`);
  assert.equal(sent.changed, true);
  const untouched = packets.find((p) => p.symbol === "show");
  assert.equal(untouched?.changed, false, "and a caller the change did not touch is still not changed");
});

test("what the planner says its picks leave unchecked is reported", async () => {
  const { judge } = scriptedJudge();
  const withGaps: Planner = {
    async pick() {
      return { picks: [], notCovered: ["every other call site of the same helper"] };
    },
  };
  const [r] = await runLocalCheck(fakeGit, REVISIONS, [requirement], withGaps, judge, () => true, DEFAULT_LOCAL_CHECK);
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

test("what goes to the planner is redacted, the requirement's text and the listing alike", async () => {
  const secretish = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const { planner, asked } = scriptedPlanner();
  const { judge } = scriptedJudge();
  await runLocalCheck(fakeGit, REVISIONS, [{ ...requirement, text: `${requirement.text} See ${secretish}.` }], planner, judge, () => true, DEFAULT_LOCAL_CHECK);
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
  const { planner, asked } = scriptedPlanner();
  const { judge, seen } = scriptedJudge();
  const results = await runLocalCheck(fakeGit, REVISIONS, [requirement], planner, judge, () => true, { ...DEFAULT_LOCAL_CHECK, candidatesOnly: true });
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

test("the report separates what was observed from what was not checked, and reports no violation", async () => {
  const { results } = await run();
  const text = renderLocalCheck(results);
  assert.match(text, /A local observation is not a statement about the requirement/);
  assert.match(text, /### Not checked/);
  assert.match(text, /Functions reached: 1 the change touched/);
  assert.ok(!/violat/i.test(text), "this path does not report violations");
});

test("the plan's clause is model prose, and is contained before it reaches the report", async () => {
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
  const results = await runLocalCheck(fakeGit, REVISIONS, [requirement], loud, judge, () => true, DEFAULT_LOCAL_CHECK);
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
  // Both end in no call carrying a clause, and a report that shows them alike is a failed request
  // dressed as a decision — the same shape as the checks this path had to take apart.
  const { judge } = scriptedJudge();
  const quiet: Planner = { async pick() { return { picks: [] }; } };
  const broken: Planner = { async pick() { return { picks: [], failed: "the endpoint timed out" }; } };
  const [a] = await runLocalCheck(fakeGit, REVISIONS, [requirement], quiet, judge, () => true, DEFAULT_LOCAL_CHECK);
  const [b] = await runLocalCheck(fakeGit, REVISIONS, [requirement], broken, judge, () => true, DEFAULT_LOCAL_CHECK);
  assert.ok(a!.notes.some((n) => /named no call the requirement governs/.test(n)), a!.notes.join(" | "));
  assert.ok(b!.notes.some((n) => /did not answer about .*the endpoint timed out/.test(n)), b!.notes.join(" | "));
});

test("a planner that picks nothing still leaves the change's own candidates", async () => {
  const nothing: Planner = {
    async pick() {
      return { picks: [] };
    },
  };
  const { judge } = scriptedJudge();
  const results = await runLocalCheck(fakeGit, REVISIONS, [requirement], nothing, judge, () => true, DEFAULT_LOCAL_CHECK);
  const r = results[0]!;
  assert.equal(r.picks.length, 0);
  assert.ok(
    r.observed.some((o) => o.call.includes("read_capped")),
    "the changed call is not dropped because the planner did not name it",
  );
  for (const o of r.observed) assert.equal(o.result.bearsOnRequirement, false);
});
