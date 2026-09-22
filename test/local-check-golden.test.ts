// What the failure-propagation form sends, byte for byte, pinned before questions became forms.
//
// `test/fixtures/local-check-golden.json` was written by this file against the code of main
// (529b30a), before any of the form machinery existed. Every request the local check sends on the
// repository below — the packet and the questions, in order — has to stay exactly what it was: the
// measurements of #36 were taken with these questions, and they only carry over if nothing a
// failure-propagation requirement sends has moved.
//
// The repository is frozen with the file. A test that needs another shape of repository builds its
// own; adding a function here would change the packets and leave nothing to compare against.
//
// `WRITE_GOLDEN=1` rewrites the file. It is for a deliberate change of what is sent, never for a
// test that fails.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_LOCAL_CHECK, runLocalCheck, type LocalCheckOptions } from "../src/review/local-check-run.ts";
import type { Git } from "../src/repository/git.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import type { ChoiceAnswer, Requirement } from "../src/types.ts";

const GOLDEN = new URL("./fixtures/local-check-golden.json", import.meta.url);

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

const SWALLOWING = INTEGRITY.replace("let content = crate::atomic_file::read_capped(&path, MAX)?;", "let Ok(content) = crate::atomic_file::read_capped(&path, MAX) else { return Ok(None) };");

const UTIL = `pub(crate) fn read_capped(path: &Path, max: u64) -> io::Result<String> {
    Ok(String::new())
}
`;

const CLI = `pub fn show(base_dir: &Path) -> Result<(), AppError> {
    let baseline = crate::integrity::read_baseline(base_dir)?;
    Ok(())
}
`;

const DIFF = `diff --git a/src/integrity.rs b/src/integrity.rs
--- a/src/integrity.rs
+++ b/src/integrity.rs
@@ -9 +9 @@ pub fn read_baseline(base_dir: &Path)
-    let content = read_plain(&path)?;
+    let content = crate::atomic_file::read_capped(&path, MAX)?;
`;

function repo(integrity: string): Git {
  const files: Record<string, string> = { "src/integrity.rs": integrity, "src/util.rs": UTIL, "src/cli.rs": CLI };
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

const requirement: Requirement = {
  id: "R1",
  text: "A baseline that cannot be read is not reported as no baseline at all.",
  kind: "behavior",
  priority: "required",
  sourceRefs: [],
  searchHints: ["baseline"],
};

interface Sent {
  state: unknown;
  questions: Questions;
}

/** Answers every request the same way, and keeps what was sent. The answers shape nothing sent. */
function recording(mapping: ChoiceAnswer): { judge: JudgmentProvider; sent: Sent[] } {
  const sent: Sent[] = [];
  const judge: JudgmentProvider = {
    model: "typesafe/jev",
    async judge(state: unknown, questions: Questions) {
      sent.push({ state, questions });
      const out: Record<string, ChoiceAnswer> = {};
      for (const key of Object.keys(questions)) out[key] = key === "requirement_governs" ? mapping : { choice: "returns_success", probability: 0.9, confidence: 0.9, probabilities: { returns_success: 0.9 } };
      return out;
    },
  };
  return { judge, sent };
}

const APPLIES: ChoiceAnswer = { choice: "applies", probability: 0.9, confidence: 0.9, probabilities: { applies: 0.9 } };
const BELOW: ChoiceAnswer = { choice: "applies", probability: 0.5, confidence: 0.5, probabilities: { applies: 0.5 } };

const SCENARIOS: { name: string; integrity: string; mapping: ChoiceAnswer; options?: Partial<LocalCheckOptions> }[] = [
  { name: "shipped", integrity: INTEGRITY, mapping: APPLIES },
  { name: "swallowing", integrity: SWALLOWING, mapping: APPLIES },
  { name: "mapping below the bar", integrity: SWALLOWING, mapping: BELOW },
  { name: "budget of one", integrity: INTEGRITY, mapping: APPLIES, options: { budget: 1 } },
];

async function record(): Promise<Record<string, { sent: Sent[]; listed: string[] }>> {
  const out: Record<string, { sent: Sent[]; listed: string[] }> = {};
  for (const s of SCENARIOS) {
    const { judge, sent } = recording(s.mapping);
    const [r] = await runLocalCheck(repo(s.integrity), { before: "BEFORE", after: "AFTER" }, [requirement], judge, () => true, { ...DEFAULT_LOCAL_CHECK, ...s.options });
    // JSON round trip: what is compared is what a host would have received.
    out[s.name] = { sent: JSON.parse(JSON.stringify(sent)), listed: r!.findings.map((f) => `${f.function} · ${f.call}`) };
  }
  return out;
}

test("the failure-propagation form sends what it sent before forms existed, byte for byte", async () => {
  const now = await record();
  if (process.env.WRITE_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(Object.keys(now), Object.keys(golden));
  for (const name of Object.keys(golden)) {
    assert.equal(now[name]!.sent.length, golden[name].sent.length, `${name}: how many requests`);
    for (let i = 0; i < golden[name].sent.length; i++) assert.equal(JSON.stringify(now[name]!.sent[i]), JSON.stringify(golden[name].sent[i]), `${name}: request ${i + 1}`);
    assert.deepEqual(now[name]!.listed, golden[name].listed, `${name}: what is listed`);
  }
});
