// The experimental path end to end, on a repository of two strings, a planner that picks one call
// and a judge that answers from a table. No network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runLocalCheck, renderLocalCheck, type Planner } from "../src/review/local-check-run.ts";
import type { Git } from "../src/repository/git.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import type { ChoiceAnswer, Requirement } from "../src/types.ts";

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

const UTIL = `pub(crate) fn read_capped(path: &Path, max: u64) -> io::Result<String> {
    Ok(String::new())
}
`;

const FILES: Record<string, string> = { "src/integrity.rs": INTEGRITY, "src/util.rs": UTIL };

const fakeGit = {
  async readText(_rev: string, path: string) {
    return FILES[path] ?? null;
  },
  async grep(_rev: string, pattern: string) {
    const hits = Object.entries(FILES).flatMap(([path, text]) =>
      text.split("\n").flatMap((line, i) => (new RegExp(`(?<![\\w$])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "i").test(line) ? [{ path, line: i + 1, text: line }] : [])),
    );
    return { hits, more: false };
  },
} as unknown as Git;

const requirement: Requirement = {
  id: "R1",
  text: "A baseline that cannot be read is not reported as no baseline.",
  kind: "behavior",
  priority: "required",
  sourceRefs: [],
  searchHints: ["baseline"],
};

/** Picks the one call that is not the early `exists()`, and says which clause it checks. */
const planner: Planner = {
  async pick({ listing }) {
    const call = listing.calls.find((k) => k.text.includes("read_capped"));
    return { picks: call ? [{ callId: call.id, clause: "a baseline that cannot be read" }] : [] };
  },
};

/** Answers from the body: `?` propagates, anything else is a success. */
const judge: JudgmentProvider = {
  model: "test",
  async judge(state: unknown, questions: Questions) {
    const body = (state as { evidence: { code: string } }).evidence.code;
    const choice = /read_capped\([^)]*\)\?/.test(body) ? "returns_error" : "returns_success";
    const out: Record<string, ChoiceAnswer> = {};
    for (const key of Object.keys(questions)) out[key] = { choice: key === "on_error_result" ? choice : "stops_there", confidence: 0.95, probabilities: { [key === "on_error_result" ? choice : "stops_there"]: 0.95 } };
    return out;
  },
};

test("a requirement reaches an observation about a particular call, with no name given by hand", async () => {
  const results = await runLocalCheck(fakeGit, "HEAD", [requirement], planner, judge, () => true);
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.ok(r.filesOpened.includes("src/integrity.rs"), `the requirement's words should open the file: ${r.filesOpened.join(",")}`);
  const read = r.observed.find((o) => o.call.includes("read_capped"));
  assert.ok(read, `the call should have been asked about: ${JSON.stringify(r.observed)}`);
  assert.equal(read.function, "read_baseline");
  assert.equal(read.result.observation, "returns_error");
  assert.equal(read.result.bearsOnRequirement, true, "the plan stated a clause for this call");
});

test("a call with no stated clause is an observation about code, not about the requirement", async () => {
  const results = await runLocalCheck(fakeGit, "HEAD", [requirement], planner, judge, () => true);
  const added = results[0]!.observed.filter((o) => o.origin === "same_function");
  for (const o of added) assert.equal(o.result.bearsOnRequirement, false, `${o.call} was added by widening and carries no clause`);
});

test("calls whose callee is not resolvable here are unchecked, with the reason", async () => {
  const results = await runLocalCheck(fakeGit, "HEAD", [requirement], planner, judge, () => true);
  const r = results[0]!;
  const held = r.unchecked.find((u) => u.call.includes("exists"));
  assert.ok(held, `\`exists()\` has no definition here and should be unchecked: ${JSON.stringify(r.unchecked)}`);
  assert.match(held.why, /no definition in this repository/);
});

test("the report separates what was observed from what was not checked, and reports no violation", async () => {
  const results = await runLocalCheck(fakeGit, "HEAD", [requirement], planner, judge, () => true);
  const text = renderLocalCheck(results);
  assert.match(text, /A local observation is not a statement about the requirement/);
  assert.match(text, /### Not checked/);
  assert.ok(!/violat/i.test(text), "this path does not report violations");
});

test("a planner that picks nothing produces no observations and says so", async () => {
  const nothing: Planner = { async pick() { return { picks: [] }; } };
  const results = await runLocalCheck(fakeGit, "HEAD", [requirement], nothing, judge, () => true);
  assert.equal(results[0]!.observed.length, 0);
  assert.match(renderLocalCheck(results), /_Nothing was asked\._/);
});
