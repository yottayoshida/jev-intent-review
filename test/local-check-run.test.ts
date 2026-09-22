// The experimental path end to end, on a repository of four strings with a real diff and one
// scripted Jev. No network, and nothing to script but Jev — there is no other model in the path.
//
// The repository is arranged the way the measured pull request is: the change is in a file the
// requirement's words never mention, so a run that followed the words would never reach it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOCAL_CHECK, runLocalCheck, type LocalCheckOptions, type LocalCheckResult } from "../src/review/local-check-run.ts";
import { LOCAL_CHECK_INTRO, requirementSection } from "../src/report/markdown.ts";

/** The requirements as the report prints them, without the report around them. */
const renderRequirements = (results: readonly LocalCheckResult[]) => [...LOCAL_CHECK_INTRO, ...results.flatMap((r) => requirementSection(r))].join("\n");
import type { Git } from "../src/repository/git.ts";
import { ProviderError } from "../src/judgments/client.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import { EXIT, ToolError, type ChoiceAnswer, type Requirement } from "../src/types.ts";

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

/** The same call, swallowing its failure — the shape a mutant has. */
const SWALLOWING = INTEGRITY.replace("let content = crate::atomic_file::read_capped(&path, MAX)?;", "let Ok(content) = crate::atomic_file::read_capped(&path, MAX) else { return Ok(None) };");

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

const FILES: Record<string, string> = { "src/integrity.rs": INTEGRITY, "src/util.rs": UTIL, "src/cli.rs": CLI };

const DIFF = `diff --git a/src/integrity.rs b/src/integrity.rs
--- a/src/integrity.rs
+++ b/src/integrity.rs
@@ -9 +9 @@ pub fn read_baseline(base_dir: &Path)
-    let content = read_plain(&path)?;
+    let content = crate::atomic_file::read_capped(&path, MAX)?;
`;

function repo(integrity: string = INTEGRITY): Git {
  const files: Record<string, string> = { ...FILES, "src/integrity.rs": integrity };
  return {
    async readText(rev: string, path: string) {
      if (rev === "BEFORE" && path === "src/integrity.rs") return INTEGRITY_BEFORE;
      return files[path] ?? null;
    },
    async changedFiles() {
      return [{ status: "modified" as const, oldPath: "src/integrity.rs", newPath: "src/integrity.rs" }];
    },
    async diffText() {
      return DIFF;
    },
    async grep(_rev: string, pattern: string) {
      const hits = Object.entries(files).flatMap(([path, text]) =>
        text.split("\n").flatMap((line, i) => (new RegExp(`(?<![\\w$])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "i").test(line) ? [{ path, line: i + 1, text: line }] : [])),
      );
      return { hits, more: false };
    },
  } as unknown as Git;
}

const REVISIONS = { before: "BEFORE", after: "AFTER" };

const requirement: Requirement = {
  id: "R1",
  text: "A baseline that cannot be read is not reported as no baseline at all.",
  kind: "behavior",
  priority: "required",
  sourceRefs: [],
  searchHints: [],
};

interface Asked {
  keys: string[];
  instructions: string;
  candidate: { symbol?: string; changed: boolean };
  body: string;
}

/**
 * One Jev, answering both questions.
 *
 * The mapping answer is scripted per call; the reading of the code comes from the body, so the
 * two never agree by construction.
 */
function jev(mapping: (asked: Asked) => ChoiceAnswer | undefined = () => ({ choice: "applies", probability: 0.9, confidence: 0.9, probabilities: { applies: 0.9 } })): { judge: JudgmentProvider; asked: Asked[] } {
  const asked: Asked[] = [];
  const judge: JudgmentProvider = {
    model: "typesafe/jev",
    async judge(state: unknown, questions: Questions) {
      const packet = state as { candidate: { symbol?: string; changed_by_pull_request: boolean }; evidence: { code: string } };
      const keys = Object.keys(questions);
      const q = questions as unknown as Record<string, { instructions: string }>;
      const entry: Asked = { keys, instructions: q[keys[0]!]!.instructions, candidate: { symbol: packet.candidate.symbol, changed: packet.candidate.changed_by_pull_request }, body: packet.evidence.code };
      asked.push(entry);
      if (keys.includes("requirement_governs")) {
        const answer = mapping(entry);
        return answer ? { requirement_governs: answer } : {};
      }
      const flat = packet.evidence.code.replace(/\s+/g, " ");
      const expression = /reaches the call `([^`]+)`/.exec(entry.instructions)?.[1] ?? "";
      const out: Record<string, ChoiceAnswer> = {};
      for (const key of keys) {
        const choice = key === "on_error_result" ? (flat.includes(`${expression}?`) ? "returns_error" : "returns_success") : "stops_there";
        out[key] = { choice, probability: 0.95, confidence: 0.95, probabilities: { [choice]: 0.95 } };
      }
      return out;
    },
  };
  return { judge, asked };
}

async function run(options?: Partial<LocalCheckOptions>, integrity?: string, mapping?: (a: Asked) => ChoiceAnswer | undefined) {
  const { judge, asked } = jev(mapping);
  const { requirements: results } = await runLocalCheck(repo(integrity), REVISIONS, [requirement], judge, () => true, { ...DEFAULT_LOCAL_CHECK, ...options });
  return { r: results[0]!, results, asked, text: renderRequirements(results) };
}

test("the change reaches the call it introduced, and its caller one hop out", async () => {
  const { r } = await run();
  const changed = r.observed.find((o) => o.call.includes("read_capped"));
  assert.ok(changed, `the changed call should have been read: ${JSON.stringify(r.observed)}`);
  assert.equal(changed.file, "src/integrity.rs");
  assert.equal(changed.function, "read_baseline");
  assert.equal(changed.origin, "changed");
  assert.equal(r.counts.functions.changed, 1);
  assert.equal(r.counts.functions.calls_changed, 1);
  assert.ok(r.observed.some((o) => o.function === "show"));
});

test("only Jev is asked, and the two questions are two separate requests", async () => {
  const { r, asked } = await run();
  const mappings = asked.filter((a) => a.keys.includes("requirement_governs"));
  const readings = asked.filter((a) => a.keys.includes("on_error_result"));
  assert.equal(mappings.length, r.counts.mapped);
  assert.equal(readings.length, r.counts.asked);
  for (const a of asked) assert.equal(a.keys.length === 1 || !a.keys.includes("requirement_governs"), true, "the mapping is never asked alongside the reading");
});

test("the mapping is not asked under the failure the reading assumes", async () => {
  const { asked } = await run();
  for (const a of asked.filter((x) => x.keys.includes("requirement_governs"))) {
    assert.match(a.instructions, /Assume nothing about what happens at run time/);
    assert.ok(!/Assume exactly this and nothing else/.test(a.instructions));
  }
});

test("a governed call that swallows its failure is listed, with everything needed to disagree", async () => {
  const { r, text } = await run(undefined, SWALLOWING);
  const f = r.findings.find((x) => x.function === "read_baseline");
  assert.ok(f, `the swallowing call should be listed: ${JSON.stringify(r.findings)}`);
  assert.equal(f.quote, requirement.text, "the requirement as given, not a fragment a model chose");
  assert.equal(f.observation, "returns_success");
  assert.equal(f.mapping.verdict, "applies");
  assert.match(f.lines, /^\d+-\d+$/);
  assert.match(f.condition, /Execution reaches the call/);
  assert.match(f.why, /Both are Jev's readings and neither checks the other/);
  assert.match(text, /### Worth checking/);
  assert.match(text, /\*\*Jev, on whether the requirement requires it here\*\*: applies/);
  assert.match(text, /\*\*Jev, on what the function returns\*\*: returns_success/);
});

test("the same call, read as not required by the requirement, is not listed", async () => {
  // The code does not change: same call, same `returns_success`. Only the mapping differs.
  const { r, text } = await run(undefined, SWALLOWING, () => ({ choice: "does_not_apply", probability: 0.95, confidence: 0.95, probabilities: { does_not_apply: 0.95 } }));
  assert.equal(r.findings.length, 0);
  assert.ok(r.observed.some((o) => o.result.observation === "returns_success"));
  assert.match(text, /### Read, but not required of by the requirement/);
  assert.ok(!/### Worth checking/.test(text));
});

test("a mapping below the bar is not acted on, and says its number", async () => {
  const { r, text } = await run(undefined, SWALLOWING, () => ({ choice: "applies", probability: 0.5, confidence: 0.5, probabilities: { applies: 0.5 } }));
  assert.equal(r.findings.length, 0);
  assert.equal(r.counts.governed, 0);
  assert.match(text, /read as `applies` \(0\.50\)/);
});

test("a mapping that was not answered is its own state, not a quiet no", async () => {
  const { r, text } = await run(undefined, SWALLOWING, () => undefined);
  assert.equal(r.findings.length, 0);
  assert.ok(r.mappings.every((m) => m.verdict === "no_answer"));
  assert.match(text, /the mapping question was not answered/);
});

test("a mapping question that failed says what kind of failure and which host; one that ends the run ends it", async () => {
  const failing = (error: unknown) => (): ChoiceAnswer | undefined => {
    throw error;
  };
  const where = "TypeSafe (https://api.typesafe.ai)";
  const { r, text } = await run(undefined, SWALLOWING, failing(new ProviderError("bad_response", `${where}: [the host's own words](https://evil.example)`, undefined, where)));
  assert.ok(r.mappings.length > 0);
  for (const m of r.mappings) {
    assert.equal(m.verdict, "no_answer");
    assert.equal(m.why, `the mapping question was not answered (bad_response from ${where})`);
  }
  assert.ok(text.includes(`bad_response from ${where}`), text);
  assert.ok(!text.includes("the host's own words"), "what the host said is not printed as Markdown");
  // Before this, every one of these was swallowed into "not answered" too.
  for (const error of [new ProviderError("auth", "refused", 401, where), new ProviderError("endpoint", "not a Jev endpoint", 404, where), new TypeError("a bug in this tool")]) {
    await assert.rejects(run(undefined, SWALLOWING, failing(error)), (e: unknown) => e === error);
  }
});

test("the mapping is recorded whether or not anything came of it", async () => {
  const { r, text } = await run();
  assert.equal(r.findings.length, 0, "the shipped shape propagates, so nothing is listed");
  assert.equal(r.counts.mapped, r.mappings.length);
  assert.equal(r.counts.governed, r.mappings.filter((m) => m.governs).length);
  const kept = r.mappings.find((m) => m.governs);
  assert.ok(kept, JSON.stringify(r.mappings));
  assert.equal(kept.probability, 0.9);
  assert.deepEqual(kept.probabilities, { applies: 0.9 });
  // A governed call whose reading keeps the requirement is read as holding — the section the
  // governed readings used to share with the ones that did not settle anything.
  assert.match(text, /### Read as holding/);
  assert.ok(!/### Read as required by the requirement/.test(text));
  assert.ok(r.observed.every((o) => o.outcome === "satisfies"), JSON.stringify(r.observed.map((o) => o.outcome)));
});

test("an observation that failed leaves its call not settled, says why, and the run goes on", async () => {
  const where = "Cloudflare Workers AI (https://api.cloudflare.com)";
  const { judge } = jev();
  const failing: JudgmentProvider = {
    model: judge.model,
    async judge(state, questions) {
      const packet = state as { candidate: { symbol?: string } };
      if (Object.hasOwn(questions, "on_error_result") && packet.candidate.symbol === "show") throw new ProviderError("bad_response", `${where}: [the host's own words](https://evil.example)`, undefined, where);
      return judge.judge(state, questions);
    },
  };
  const [r] = (await runLocalCheck(repo(), REVISIONS, [requirement], failing, () => true, DEFAULT_LOCAL_CHECK)).requirements;
  const show = r!.observed.find((o) => o.function === "show");
  assert.ok(show, JSON.stringify(r!.observed));
  assert.equal(show.outcome, "unknown");
  assert.equal(show.result.observation, "withheld");
  assert.equal(show.result.why, `the observation question was not answered (bad_response from ${where})`);
  assert.equal(r!.observed.find((o) => o.function === "read_baseline")?.outcome, "satisfies", "the other call is read as before");
  const text = renderRequirements([r!]);
  assert.match(text, /### Not settled/);
  assert.ok(!text.includes("the host's own words"));
});

test("a host that answered nothing at all fails the run and is named; a run stopped by its own budget does not", async () => {
  const where = "TypeSafe (https://api.typesafe.ai)";
  const nothing = (error: ProviderError): JudgmentProvider => ({
    model: "typesafe/jev",
    async judge() {
      throw error;
    },
  });
  await assert.rejects(runLocalCheck(repo(), REVISIONS, [requirement], nothing(new ProviderError("bad_response", "unreadable", undefined, where)), () => true, DEFAULT_LOCAL_CHECK), (e: unknown) => {
    assert.ok(e instanceof ToolError, String(e));
    assert.equal(e.exitCode, EXIT.provider);
    assert.match(e.message, new RegExp(`no judgment came back from ${where.replace(/[.()]/g, "\\$&")}: 4 request\\(s\\) were sent and none was answered`));
    return true;
  });
  // The run's own budget reached nothing: the calls are not settled, and the report stands.
  const [r] = (await runLocalCheck(repo(), REVISIONS, [requirement], nothing(new ProviderError("budget", "the run's request budget ran out")), () => true, DEFAULT_LOCAL_CHECK)).requirements;
  assert.ok(r!.observed.length > 0 && r!.observed.every((o) => o.outcome === "unknown"));
});

test("a changed function is told to the model as changed", async () => {
  const { asked } = await run();
  const sent = asked.find((a) => a.candidate.symbol === "read_baseline");
  assert.equal(sent?.candidate.changed, true);
  assert.equal(asked.find((a) => a.candidate.symbol === "show")?.candidate.changed, false);
});

test("calls whose callee is not resolvable here are unchecked, with the reason", async () => {
  const { r } = await run();
  const held = r.unchecked.find((u) => u.call.includes("exists"));
  assert.ok(held, JSON.stringify(r.unchecked));
  assert.match(held.why, /no definition in this repository/);
});

test("a body that did not fit is held, not answered about half of itself", async () => {
  const { r, asked } = await run({ maxPrimaryChars: 40 });
  assert.equal(asked.length, 0);
  assert.equal(r.observed.length, 0);
  assert.ok(r.unchecked.some((u) => /did not fit the evidence limit/.test(u.why)));
});

test("candidates only: the set and the budget, with nothing asked at all", async () => {
  const { r, asked, text } = await run({ candidatesOnly: true });
  assert.equal(asked.length, 0);
  assert.equal(r.counts.asked, 0);
  assert.equal(r.counts.mapped, 0);
  assert.equal(r.counts.functions.changed, 1);
  assert.equal(r.counts.applicable, 2);
  assert.deepEqual(
    r.wouldAsk.map((w) => `${w.function}:${w.call}`).sort(),
    ["read_baseline:crate::atomic_file::read_capped(&path, MAX)", "show:crate::integrity::read_baseline(base_dir)"],
  );
  assert.match(text, /### Inside the budget/);
});

test("the budget is spent once for the requirement, over every file the change reached", async () => {
  const { r, asked } = await run({ budget: 1 });
  assert.equal(r.counts.applicable, 2);
  assert.equal(r.counts.asked, 1);
  assert.equal(r.counts.overBudget, 1);
  assert.equal(asked.length, 2, "one mapping and one reading for the one call in budget");
});

test("the report states no verdict of its own and quotes no model prose", async () => {
  const { text } = await run(undefined, SWALLOWING);
  assert.ok(!/violat/i.test(text), "no verdict of the tool's own");
  assert.ok(!/VERIFIED|NOT_VERIFIED/.test(text), "and no requirement-level status");
  assert.match(text, /Nothing here is a requirement verdict/);
});
