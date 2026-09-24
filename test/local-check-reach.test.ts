// Past the changed functions: the other callers of what the changed code calls (ADR 0005).
//
// One repository of strings, laid out so that each rule has something on both sides of it — a
// sibling that must be reached next to a function that must not be, so a run that reaches
// nothing cannot pass a test that says something is not reached.
//
//   - `load_settings` is changed: its read of `read_blob` now propagates instead of defaulting.
//   - `load_profile` calls `read_blob` too, swallows its failure, and calls nothing the change
//     touched: the sibling. Its first askable call is another one (`measure`), so a run that asks
//     a sibling's calls from the top does not reach the one that ties it.
//   - nine rarer names (`dist1`…`dist9`) are called in the changed body only; `dist1` is used in
//     one file more. (Names under three characters, and built-ins such as `parse`, are not read as
//     calls at all — `calledNames` — so the fixture avoids them.)
//   - `c21` calls the changed function and `read_blob`, and is past the one-hop cap of 20 callers.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/main.ts";
import { Discoverer } from "../src/discovery/discover.ts";
import { ProviderError } from "../src/judgments/client.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import { calleeOf } from "../src/plan/applicability.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { counts, requirementSection } from "../src/report/markdown.ts";
import type { ReviewReport } from "../src/types.ts";
import type { Git } from "../src/repository/git.ts";
import { DEFAULT_LOCAL_CHECK, runLocalCheck, type LocalCheckOptions } from "../src/review/local-check-run.ts";
import type { ChoiceAnswer, Requirement } from "../src/types.ts";
import { tempRepo } from "./helpers/repo.ts";

const DISTRACTORS = ["dist1", "dist2", "dist3", "dist4", "dist5", "dist6", "dist7", "dist8", "dist9"];

const STORE_BEFORE = `use std::path::Path;

pub fn load_settings(dir: &Path) -> Result<Settings, AppError> {
    let raw = read_blob(dir).unwrap_or_default();
    let clean = normalize(&raw)?;
${DISTRACTORS.map((d) => `    let _${d} = ${d}(dir)?;`).join("\n")}
    let present = dir.exists();
    let n = dup(dir)?;
    Ok(settle(clean))
}

pub fn normalize(raw: &str) -> Result<String, AppError> {
    Ok(raw.to_owned())
}

fn settle(raw: String) -> Settings {
    Settings::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads() {
        let blob = String::new();
        assert!(blob.is_empty());
    }
}
`;

const STORE = STORE_BEFORE.replace("let raw = read_blob(dir).unwrap_or_default();", "let raw = read_blob(dir)?;")
  .replace("Ok(raw.to_owned())", "Ok(raw.trim_start().to_owned())")
  .replace("let blob = String::new();", "let blob = fixture_blob().unwrap();");

/** The sibling, as the shipped code has it: it swallows the failure the change made propagate. */
const OTHER = `pub fn load_profile(dir: &Path) -> Result<Profile, AppError> {
    let size = measure(dir)?;
    let Ok(raw) = read_blob(dir) else {
        return Ok(Profile::default());
    };
    Ok(Profile::new(raw, size))
}

pub fn peek(dir: &Path) -> bool {
    read_blob(dir).is_ok()
}
`;

const CALLERS_A = Array.from({ length: 20 }, (_, i) => `pub fn c${i + 1}(dir: &Path) -> Result<(), AppError> {\n    load_settings(dir)?;\n    Ok(())\n}\n`).join("\n");

/** Past the one-hop cap: a caller of the changed function, which also calls the seed. */
const CALLERS_Z = `pub fn c21(dir: &Path) -> Result<(), AppError> {
    load_settings(dir)?;
    let _ = read_blob(dir);
    Ok(())
}
`;

const UNRELATED = `pub fn tidy(dir: &Path) -> Result<(), AppError> {
    let n = measure(dir)?;
    Ok(())
}

pub fn describe(dir: &Path) -> Result<String, AppError> {
    // read_blob(dir) is what load_settings uses
    let label = "read_blob";
    Ok(label.to_owned())
}
`;

function after(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    "src/blob.rs": "pub fn read_blob(dir: &Path) -> Result<String, AppError> {\n    Ok(String::new())\n}\n",
    "src/callers_a.rs": CALLERS_A,
    "src/callers_z.rs": CALLERS_Z,
    "src/dup_a.rs": "pub fn dup(dir: &Path) -> Result<u8, AppError> {\n    Ok(0)\n}\n",
    "src/dup_b.rs": "pub fn dup(dir: &Path) -> Result<u8, AppError> {\n    Ok(1)\n}\n",
    "src/extra.rs": "pub fn uses_dist1(dir: &Path) -> Result<(), AppError> {\n    let n = dist1(dir)?;\n    Ok(())\n}\n",
    "src/measure.rs": "pub fn measure(dir: &Path) -> Result<u64, AppError> {\n    Ok(0)\n}\n",
    "src/other.rs": OTHER,
    "src/store.rs": STORE,
    "src/support.rs": "pub fn fixture_blob() -> Result<String, AppError> {\n    Ok(String::new())\n}\n",
    "src/unrelated.rs": UNRELATED,
    ...extra,
  };
  for (const d of DISTRACTORS) files[`src/${d}.rs`] = `pub fn ${d}(dir: &Path) -> Result<u32, AppError> {\n    Ok(1)\n}\n`;
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

/** A unified diff of files that keep their line count: one hunk per differing line. */
function diffOf(path: string, before: string, afterText: string): string {
  const a = before.split("\n");
  const b = afterText.split("\n");
  assert.equal(a.length, b.length, "the fixture's change keeps the line count");
  const hunks: string[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) hunks.push(`@@ -${i + 1} +${i + 1} @@\n-${a[i]}\n+${b[i]}`);
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}\n`;
}

/**
 * `before` holds the changed files as they were; every other file is the same on both sides.
 * `overflowing` names searches that report more references than they return.
 */
function repo(files: Record<string, string> = after(), before: Record<string, string> = { "src/store.rs": STORE_BEFORE }, overflowing: ReadonlySet<string> = new Set()): Git {
  return {
    async readText(rev: string, path: string) {
      if (rev === "BEFORE" && path in before) return before[path]!;
      return files[path] ?? null;
    },
    async changedFiles() {
      return Object.keys(before).map((path) => ({ status: "modified" as const, oldPath: path, newPath: path }));
    },
    async diffText() {
      return Object.entries(before)
        .map(([path, text]) => diffOf(path, text, files[path]!))
        .join("");
    },
    // `git grep -F -w`: case-sensitive, fixed string, whole word, in path order.
    async grep(_rev: string, pattern: string) {
      const word = new RegExp(`(?<![\\w$])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
      const hits = Object.entries(files).flatMap(([path, text]) => text.split("\n").flatMap((line, i) => (word.test(line) ? [{ path, line: i + 1, text: line }] : [])));
      return { hits, more: overflowing.has(pattern) };
    },
  } as unknown as Git;
}

const requirement: Requirement = {
  id: "R1",
  text: "If reading a stored blob fails, the loading operation must return an error to its caller, not a default.",
  kind: "behavior",
  priority: "required",
  sourceRefs: [],
  searchHints: [],
  form: "failure_propagation",
};

/**
 * Jev, scripted: the requirement applies to every call, and the reading of the code comes from the
 * body — a call written with `?` returns the error, anything else is read as a success.
 * `failFrom` makes every request from that one on fail on the run's own limit, as the real client
 * does once it has sent its last allowed request.
 */
function jev(failFrom?: number): { judge: JudgmentProvider; asked: { keys: string[]; symbol?: string }[] } {
  const asked: { keys: string[]; symbol?: string }[] = [];
  let n = 0;
  const judge: JudgmentProvider = {
    model: "typesafe/jev",
    async judge(state: unknown, questions: Questions) {
      n += 1;
      if (failFrom !== undefined && n >= failFrom) throw new ProviderError("budget", `request limit reached (${failFrom - 1})`);
      const packet = state as { candidate?: { symbol?: string }; evidence?: { code: string } };
      const keys = Object.keys(questions);
      asked.push({ keys, symbol: packet.candidate?.symbol });
      const q = questions as unknown as Record<string, { instructions?: string }>;
      const out: Record<string, ChoiceAnswer> = {};
      for (const key of keys) {
        if (key === "requirement_governs") {
          out[key] = { choice: "applies", probability: 0.9, confidence: 0.9, probabilities: { applies: 0.9 } };
          continue;
        }
        const flat = (packet.evidence?.code ?? "").replace(/\s+/g, " ");
        const expression = /reaches the call `([^`]+)`/.exec(q[key]?.instructions ?? "")?.[1] ?? "";
        const choice = key === "on_error_result" ? (flat.includes(`${expression}?`) ? "returns_error" : "returns_success") : "unknown";
        out[key] = { choice, probability: 0.95, confidence: 0.95, probabilities: { [choice]: 0.95 } };
      }
      return out;
    },
  };
  return { judge, asked };
}

async function run(options: Partial<LocalCheckOptions> = {}, files?: Record<string, string>, failFrom?: number, before?: Record<string, string>, requirements: Requirement[] = [requirement]) {
  const { judge, asked } = jev(failFrom);
  const result = await runLocalCheck(repo(files, before), { before: "BEFORE", after: "AFTER" }, requirements, judge, () => true, { ...DEFAULT_LOCAL_CHECK, ...options });
  // The callers one hop out are asked after the changed functions and before the siblings (ADR 0015).
  await result.askCallers();
  const firstPass = asked.length;
  await result.askSiblings();
  const r = result.requirements[0]!;
  return { r, all: result.requirements, asked, firstPass, text: requirementSection(r).join("\n") };
}

const key = (w: { file: string; function: string; call: string }) => `${w.file} ${w.function} ${w.call}`;
const near = <T extends { origin: string }>(list: readonly T[]) => list.filter((w) => w.origin !== "shares_call");
const noteWith = (notes: readonly string[], pattern: RegExp) => notes.find((n) => pattern.test(n));
const siblingsOf = (r: { wouldAsk: { origin: string; function: string }[]; unchecked: { origin: string; function: string }[] }) => new Set([...r.wouldAsk, ...r.unchecked].filter((w) => w.origin === "shares_call").map((w) => w.function));

test("(a) a sibling that swallows the failure is listed, reached through the call that ties it, asked first", async () => {
  const { r, text } = await run({ siblingBudget: 1 });
  const f = r.findings.find((x) => x.function === "load_profile");
  assert.ok(f, `the sibling should be listed: ${JSON.stringify(r.findings)}`);
  assert.equal(f.call, "read_blob(dir)");
  assert.equal(f.origin, "shares_call");
  assert.equal(f.via, "read_blob");
  // One call beyond the changed functions, and it is the tying one although `measure` comes first.
  assert.deepEqual(r.wouldAsk.filter((w) => w.origin === "shares_call").map(key), ["src/other.rs load_profile read_blob(dir)"]);
  assert.ok(r.unchecked.some((u) => u.function === "load_profile" && u.call === "measure(dir)" && /siblings' budget of 1/.test(u.why)), JSON.stringify(r.unchecked));
  // The lists hold both budgets' calls; the top-level counts are the first budget's, and the
  // siblings' are apart. Together they account for every list entry.
  assert.equal(r.counts.mapped + r.counts.siblings!.mapped, r.mappings.length);
  assert.equal(r.counts.asked + r.counts.siblings!.asked, r.observed.length);
  assert.equal(r.counts.siblings!.asked, 1);
  assert.equal(r.counts.siblings!.outcomes.violates, 1);
  // The result line counts what the lists hold: a sibling read is a call read, as its finding is
  // a call worth checking, so the line cannot say "worth checking of 0 read".
  const line = counts({ requirements: [r] } as unknown as ReviewReport);
  assert.equal(line.read, r.observed.length);
  assert.equal(line.worthChecking, r.findings.length);
  // A finding of the first budget carries no origin: its record is what it was.
  assert.ok(r.findings.filter((x) => x.function !== "load_profile").every((x) => !("origin" in x)));
  assert.match(text, /### Worth checking/);
  assert.match(text, /Reached as\*\*: a sibling of the change — it calls `read_blob`/);
  assert.match(text, /Siblings of the change: \d+ functions? calling what the changed code calls/);
});

test("(b) the helper on the changed line is a seed before nine rarer names; ties go by files, then by name", async () => {
  const { r } = await run({ candidatesOnly: true });
  assert.deepEqual(r.counts.siblings!.seeds, ["read_blob", "dist2", "dist3", "dist4", "dist5", "dist6", "dist7", "dist8"]);
  const over = noteWith(r.notes, /over the cap of 8/);
  assert.ok(over, r.notes.join("\n"));
  assert.match(over, /\bdist9\b/);
  assert.match(over, /\bdist1\b/, "dist1 is used in one file more, so it goes last");
  assert.ok(!r.wouldAsk.some((w) => w.function === "uses_dist1"));
  assert.ok(r.wouldAsk.some((w) => w.function === "load_profile"), "and the sibling of the helper is");
});

test("(c) a function tied by nothing, or only by a comment or a string, is not a sibling; the real one is", async () => {
  const { r } = await run({ candidatesOnly: true });
  const found = siblingsOf(r);
  for (const name of ["tidy", "describe"]) assert.ok(!found.has(name), `${name} is not reached`);
  assert.ok(found.has("load_profile"));
});

test("(e) a file read only for the siblings has its listing's cap counted, and the function it cut is no sibling", async () => {
  // `huge` calls the seed and 1,004 other things: past the cap of calls a function, so what it calls
  // is not fully known. Its file is opened for the siblings alone (#38).
  const huge = `pub fn huge(dir: &Path) -> Result<(), AppError> {\n    let raw = read_blob(dir)?;\n${Array.from({ length: 1004 }, (_, i) => `    step_${i + 1}()?;`).join("\n")}\n    Ok(())\n}\n`;
  const { r } = await run({ candidatesOnly: true }, after({ "src/huge.rs": huge }));
  assert.ok(r.notes.includes("siblings: src/huge.rs: 5 calls were left out of the listing by its cap"), r.notes.join("\n"));
  assert.match(noteWith(r.notes, /had their call list cut/) ?? "", /\bhuge\b/);
  assert.ok(!siblingsOf(r).has("huge"), "the function the cap cut is not a sibling");
  assert.ok(siblingsOf(r).has("load_profile"), "and the real one still is");
});

test("(d) names that cannot be seeds are counted with their reason", async () => {
  const { r } = await run({ candidatesOnly: true });
  const seeds = r.counts.siblings!.seeds;
  // `dir.exists()` and `dup` (defined twice, and nothing tells which) settle nowhere.
  assert.match(noteWith(r.notes, /settle at no one definition/) ?? "", /\bexists\b/);
  assert.match(noteWith(r.notes, /settle at no one definition/) ?? "", /\bdup\b/);
  assert.match(noteWith(r.notes, /do not return a Result/) ?? "", /\bsettle\b/);
  assert.match(noteWith(r.notes, /are changed functions/) ?? "", /\bnormalize\b/);
  for (const n of ["normalize", "dup", "settle", "exists"]) assert.ok(!seeds.includes(n), n);
});

test("(d) a name the search cannot return in full is counted as that, not as one used in too many files", async () => {
  const { judge } = jev();
  const result = await runLocalCheck(repo(after(), undefined, new Set(["dist5"])), { before: "BEFORE", after: "AFTER" }, [requirement], judge, () => true, { ...DEFAULT_LOCAL_CHECK, candidatesOnly: true });
  await result.askSiblings();
  const r = result.requirements[0]!;
  assert.match(noteWith(r.notes, /more references than the search returns/) ?? "", /\bdist5\b/);
  assert.ok(!noteWith(r.notes, /used in more than 20 files/), r.notes.join("\n"));
  assert.ok(!r.counts.siblings!.seeds.includes("dist5") && r.counts.siblings!.seeds.includes("read_blob"));
});

test("(e) a caller of a changed function is never a sibling, even past the one-hop cap", async () => {
  const { r } = await run({ candidatesOnly: true });
  assert.ok(noteWith(r.notes, /more callers were found than the cap of 20/), "c21 is past the one-hop cap");
  assert.ok(!siblingsOf(r).has("c21"), "and is not a sibling either");
  assert.match(noteWith(r.notes, /also call a changed function, so/) ?? "", /\bc21\b/);
  assert.ok(siblingsOf(r).has("load_profile"));
});

test("(e) a function turned away is counted once, however many seeds lead to it", async () => {
  const every = DISTRACTORS.map((d) => `    let _${d} = ${d}(dir)?;`).join("\n");
  const { r } = await run({ candidatesOnly: true }, after({ "src/callers_y.rs": `pub fn cy(dir: &Path) -> Result<(), AppError> {\n    load_settings(dir)?;\n    let _ = read_blob(dir);\n${every}\n    Ok(())\n}\n` }));
  const note = noteWith(r.notes, /also call a changed function, so/) ?? "";
  assert.equal(note.match(/\bcy\b/g)?.length, 1, note);
});

test("(e) a function that calls a changed function past the listing's cap is not a sibling either", async () => {
  // `late` is changed, and it is the 61st function in its file: past the listing's cap of 60, so
  // the one-hop search never sees it. `uses_late` calls it and the seed.
  const filler = Array.from({ length: 60 }, (_, i) => `pub fn filler${i + 1}() -> u8 {\n    0\n}\n`).join("\n");
  // `late` also calls the seed and swallows it: a changed function the listing left out must not
  // come back as a sibling either.
  const bigBefore = `${filler}\npub fn late(dir: &Path) -> Result<(), AppError> {\n    let _ = String::new();\n    let _ = read_blob(dir);\n    Ok(())\n}\n`;
  const big = bigBefore.replace("let _ = String::new();", "let _ = String::from(\"x\");");
  const files = after({ "src/big.rs": big, "src/uses_late.rs": "pub fn uses_late(dir: &Path) -> Result<(), AppError> {\n    late(dir)?;\n    let Ok(raw) = read_blob(dir) else {\n        return Ok(());\n    };\n    Ok(())\n}\n" });
  const { r } = await run({ candidatesOnly: true }, files, undefined, { "src/store.rs": STORE_BEFORE, "src/big.rs": bigBefore });
  assert.ok(!siblingsOf(r).has("uses_late"), "it calls a changed function");
  assert.ok(!siblingsOf(r).has("late"), "and the changed function itself is not a sibling");
  assert.match(noteWith(r.notes, /also call a changed function, so/) ?? "", /\buses_late\b/);
  assert.ok(siblingsOf(r).has("load_profile"), "and the real sibling is still reached");
});

test("(e) a function that calls a changed function returning () is not a sibling — the location decides, not the return", async () => {
  // `note_change` is changed and returns `()`: a call to it can never be asked about, and the
  // reading still has to say where it settled, or `logs_only` would pass for a sibling. Twenty
  // other callers come first, so the one-hop search leaves `logs_only` out and the siblings' rule
  // is the one that decides.
  const noteBefore = "pub fn note_change(dir: &Path) {\n    let _ = dir;\n}\n";
  const noted = noteBefore.replace("let _ = dir;", "let _ = dir.display();");
  const callers = Array.from({ length: 20 }, (_, i) => `pub fn n${i + 1}(dir: &Path) -> Result<(), AppError> {\n    note_change(dir);\n    Ok(())\n}\n`).join("\n");
  const logs = "pub fn logs_only(dir: &Path) -> Result<(), AppError> {\n    note_change(dir);\n    let Ok(raw) = read_blob(dir) else {\n        return Ok(());\n    };\n    Ok(())\n}\n";
  const { r } = await run({ candidatesOnly: true }, after({ "src/note.rs": noted, "src/callers_n.rs": callers, "src/logs.rs": logs }), undefined, { "src/store.rs": STORE_BEFORE, "src/note.rs": noteBefore });
  assert.ok(![...r.wouldAsk, ...r.unchecked].some((w) => w.function === "logs_only" && w.origin === "calls_changed"), "the one-hop search does not reach it");
  assert.ok(!siblingsOf(r).has("logs_only"), [...siblingsOf(r)].join(", "));
  assert.match(noteWith(r.notes, /also call a changed function, so/) ?? "", /\blogs_only\b/);
  assert.ok(siblingsOf(r).has("load_profile"));
});

test("(e) a call by a changed function's name that settles nowhere turns a function away; one that settles elsewhere does not", async () => {
  // The change touches `pub fn open` in `src/made.rs`, and `src/profile.rs` defines another `open`.
  // `open` is used in more than 20 files, so the one-hop search does not follow it: whether `make`
  // is reached at all is the siblings' call.
  const common = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`src/n${i + 1}.rs`, `pub fn n${i + 1}() -> Result<(), AppError> {\n    let _ = File::open("x");\n    Ok(())\n}\n`]));
  const madeBefore = "pub fn open(dir: &Path) -> Result<u8, AppError> {\n    Ok(0)\n}\n";
  const made = madeBefore.replace("Ok(0)", "Ok(1)");
  const profile = "pub fn open(dir: &Path) -> Result<u8, AppError> {\n    Ok(2)\n}\n";
  const caller = (call: string) => `pub fn make(dir: &Path) -> Result<(), AppError> {\n    let p = ${call}(dir)?;\n    let Ok(raw) = read_blob(dir) else {\n        return Ok(());\n    };\n    Ok(())\n}\n`;
  const before = { "src/store.rs": STORE_BEFORE, "src/made.rs": madeBefore };
  // `open(dir)`: two definitions, and nothing in the call picks one — it may be the changed one.
  const unsettled = await run({ candidatesOnly: true }, after({ ...common, "src/made.rs": made, "src/profile.rs": profile, "src/make.rs": caller("open") }), undefined, before);
  assert.ok(!siblingsOf(unsettled.r).has("make"), unsettled.r.notes.join(" || "));
  assert.match(noteWith(unsettled.r.notes, /settles nowhere here/) ?? "", /\bmake\b/);
  // `profile::open(dir)`: the path picks the other file's, which the change did not touch.
  const elsewhere = await run({ candidatesOnly: true }, after({ ...common, "src/made.rs": made, "src/profile.rs": profile, "src/make.rs": caller("profile::open") }), undefined, before);
  assert.ok(siblingsOf(elsewhere.r).has("make"), elsewhere.r.notes.join(" || "));
});

test("(e) a helper the change stopped calling is a seed, and its other callers are siblings", async () => {
  // The fix replaces `legacy_read` with `read_blob` in the changed function. `legacy_user` still
  // calls `legacy_read` and swallows its failure: the path the fix may have missed.
  const storeBefore = STORE_BEFORE.replace("let raw = read_blob(dir).unwrap_or_default();", "let raw = legacy_read(dir).unwrap_or_default();");
  const legacy = "pub fn legacy_read(dir: &Path) -> Result<String, AppError> {\n    Ok(String::new())\n}\n";
  const user = "pub fn legacy_user(dir: &Path) -> Result<(), AppError> {\n    let Ok(raw) = legacy_read(dir) else {\n        return Ok(());\n    };\n    Ok(())\n}\n";
  const { r } = await run({ candidatesOnly: true }, after({ "src/legacy.rs": legacy, "src/legacy_user.rs": user }), undefined, { "src/store.rs": storeBefore });
  assert.ok(r.counts.siblings!.seeds.includes("legacy_read"), r.notes.join(" || "));
  assert.ok(siblingsOf(r).has("legacy_user"));
});

test("(e) a changed function past the cap of changed functions is not a sibling, whatever it calls", async () => {
  // Forty changed functions fit the listing; `m41` is changed too, past that cap, so the one hop
  // never lists it. It calls the seed and swallows the failure — and it is still a changed function.
  const fns = (text: string) => Array.from({ length: 41 }, (_, i) => `pub fn m${i + 1}(dir: &Path) -> Result<(), AppError> {\n    let _ = ${text};\n${i === 40 ? "    let _ = read_blob(dir);\n" : ""}    Ok(())\n}\n`).join("\n");
  const manyBefore = fns("String::new()");
  const many = fns("String::from(\"x\")");
  const { r } = await run({ candidatesOnly: true }, after({ "src/zz_many.rs": many }), undefined, { "src/store.rs": STORE_BEFORE, "src/zz_many.rs": manyBefore });
  assert.ok(noteWith(r.notes, /more changed functions were found than the cap of 40/), r.notes.join(" || "));
  assert.ok(!siblingsOf(r).has("m41"), [...siblingsOf(r)].join(", "));
  assert.ok(siblingsOf(r).has("load_profile"), "and the real sibling is still reached");
});

test("(e) a changed test function of a seed's name does not take the seed out", async () => {
  const renamed = (s: string) => s.replace("fn loads()", "fn read_blob()");
  const { r } = await run({ candidatesOnly: true }, after({ "src/store.rs": renamed(STORE) }), undefined, { "src/store.rs": renamed(STORE_BEFORE) });
  assert.ok(r.counts.siblings!.seeds.includes("read_blob"), `${r.counts.siblings!.seeds} / ${r.notes.join(" || ")}`);
  assert.ok(siblingsOf(r).has("load_profile"));
});

test("(e) a changed function in another language does not turn a Rust sibling away", async () => {
  const py = { before: "def tag_blob():\n    return 1\n", after: "def tag_blob():\n    return 2\n" };
  const keep = "pub fn keep(dir: &Path) -> Result<(), AppError> {\n    let t = tag_blob();\n    let Ok(raw) = read_blob(dir) else {\n        return Ok(());\n    };\n    Ok(())\n}\n";
  const { r } = await run({ candidatesOnly: true }, after({ "src/keep.rs": keep, "tools/tag.py": py.after }), undefined, { "src/store.rs": STORE_BEFORE, "tools/tag.py": py.before });
  assert.ok(siblingsOf(r).has("keep"), [...siblingsOf(r), ...r.notes].join(" || "));
});

test("(f) a name called only in the change's tests is not a seed", async () => {
  const { r } = await run({ candidatesOnly: true });
  assert.ok(!r.counts.siblings!.seeds.includes("fixture_blob"));
  assert.match(noteWith(r.notes, /only in the change's tests/) ?? "", /\bfixture_blob\b/);
});

test("(g) the siblings' budget is their own: the first one's calls and counts do not move, and a sibling that returns no Result is counted", async () => {
  const none = await run({ candidatesOnly: true, siblingBudget: 0 });
  const some = await run({ candidatesOnly: true });
  assert.deepEqual(near(some.r.wouldAsk).map(key), near(none.r.wouldAsk).map(key));
  assert.ok(!none.r.wouldAsk.some((w) => w.origin === "shares_call"));
  assert.ok(some.r.wouldAsk.some((w) => w.origin === "shares_call"));
  assert.equal(some.r.counts.budget, DEFAULT_LOCAL_CHECK.budget + DEFAULT_LOCAL_CHECK.callerBudget);
  assert.equal(some.r.counts.siblings!.budget, DEFAULT_LOCAL_CHECK.siblingBudget);
  for (const k of ["applicable", "overBudget", "notApplicable", "calls"] as const) assert.equal(some.r.counts[k], none.r.counts[k], k);
  assert.match(noteWith(some.r.notes, /do not return a Result, or what they return is not settled here, so nothing about them/) ?? "", /\bpeek\b/);
});

test("(g) nothing about siblings is searched or asked until the run asks for them", async () => {
  const events: string[] = [];
  const inner = repo();
  const watched = { ...inner, grep: async (rev: string, pattern: string, o: unknown) => (events.push(`grep ${pattern}`), (inner as unknown as { grep: Function }).grep(rev, pattern, o)) } as unknown as Git;
  const { judge } = jev();
  const asking: JudgmentProvider = { model: judge.model, judge: async (s, q) => (events.push("judge"), judge.judge(s, q)) };
  const result = await runLocalCheck(watched, { before: "BEFORE", after: "AFTER" }, [requirement], asking, () => true, DEFAULT_LOCAL_CHECK);
  // `measure` is called only in the sibling and in an unrelated function: nothing but the siblings'
  // pass reads it. And no question is put after the first pass until the siblings' pass is asked for.
  const readsMeasure = (e: string) => e.startsWith("grep ") && /\bmeasure\b/.test(e);
  assert.ok(!events.some(readsMeasure), `no sibling's call is read before askSiblings: ${events.filter((e) => e.startsWith("grep")).join(", ")}`);
  const before = events.length;
  await result.askSiblings();
  assert.ok(events.slice(before).some(readsMeasure), "and it is read when asked");
  assert.ok(events.slice(before).includes("judge"), "and asked about");
});

test("(g) under a request limit, every requirement's first budget and the changes' questions are sent before any sibling's", async () => {
  // Two requirements, and a limit that their first budgets and the changes' questions fit in. From
  // the command line, so the order is the one a user's run has: calls, then changes, then siblings.
  const repoDir = tempRepo();
  try {
    repoDir.write({ ...after(), "src/store.rs": STORE_BEFORE });
    const base = repoDir.commit("before");
    repoDir.write({ "src/store.rs": STORE });
    const head = repoDir.commit("propagate the read");
    const spec = join(repoDir.dir, "spec.json");
    const two = [requirement, { ...requirement, id: "R2" }];
    writeFileSync(spec, JSON.stringify({ version: 1, title: "t", summary: "", requirements: two, nonGoals: [], ambiguities: [] }));
    const sent: string[] = [];
    const { judge } = jev();
    const recording: JudgmentProvider = {
      model: judge.model,
      judge: async (state, questions) => {
        const symbol = (state as { candidate?: { symbol?: string } }).candidate?.symbol;
        sent.push(`${Object.keys(questions).join(",")}@${symbol ?? ""}`);
        return judge.judge(state, questions);
      },
    };
    const out: string[] = [];
    const code = await main(["--base", base, "--head", head, "--intent-spec", spec, "--json"], { stdout: (t) => void out.push(t), stderr: () => {}, cwd: repoDir.dir, env: { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "test-token" } }, { judges: () => ({ provider: recording, sent: () => ({ requests: sent.length, bytes: 0 }), origin: "https://api.cloudflare.com" }) });
    assert.equal(code, 0);
    const report = JSON.parse(out.join("")) as { requirements: { counts: { siblings?: { asked: number } }; observed: { origin: string }[] }[] };
    const siblingSymbols = new Set(["load_profile", "keep"]);
    const firstSibling = sent.findIndex((s) => siblingSymbols.has(s.split("@")[1]!));
    assert.ok(firstSibling > 0, sent.join("\n"));
    assert.ok(sent.slice(firstSibling).every((s) => siblingSymbols.has(s.split("@")[1]!) || s.split("@")[1] === ""), "nothing but siblings after the first sibling");
    const changes = sent.filter((s) => !s.includes("requirement_governs") && !s.includes("on_error_result"));
    assert.ok(changes.length > 0, "the changes were asked about");
    assert.ok(sent.lastIndexOf(changes.at(-1)!) < firstSibling, "every question about the changes came before any sibling's");
    assert.ok(report.requirements.every((r) => (r.counts.siblings?.asked ?? 0) > 0), "and siblings were asked for both requirements");
  } finally {
    repoDir.remove();
  }
});

test("(h) every requirement's changed functions are asked before any requirement's callers, and the counts say which budget", async () => {
  const two = [requirement, { ...requirement, id: "R2" }];
  const { all, asked, firstPass } = await run({}, undefined, undefined, undefined, two);
  const r = all[0]!;
  const changed = new Set(r.observed.filter((o) => o.origin === "changed").map((o) => o.function));
  const callers = new Set(r.observed.filter((o) => o.origin === "calls_changed").map((o) => o.function));
  assert.ok(changed.size > 0 && callers.size > 0, `both budgets asked something: ${[...changed]} / ${[...callers]}`);
  const symbols = asked.slice(0, firstPass).map((a) => a.symbol ?? "");
  const lastChanged = symbols.findLastIndex((x) => changed.has(x));
  const firstCaller = symbols.findIndex((x) => callers.has(x));
  assert.ok(lastChanged < firstCaller, `both requirements' changed functions first: ${symbols.join(", ")}`);
  for (const one of all) {
    const c = one.counts;
    assert.equal(c.budget, DEFAULT_LOCAL_CHECK.budget + DEFAULT_LOCAL_CHECK.callerBudget);
    assert.equal(c.byOrigin.changed.budget, DEFAULT_LOCAL_CHECK.budget);
    const left = DEFAULT_LOCAL_CHECK.budget - one.wouldAsk.filter((w) => w.origin === "changed").length;
    assert.equal(c.byOrigin.calls_changed.budget, DEFAULT_LOCAL_CHECK.callerBudget + left, "the callers get their own and what the first left");
    for (const k of ["calls", "applicable", "asked", "mapped", "governed", "overBudget", "notApplicable"] as const) {
      assert.equal(c.byOrigin.changed[k] + c.byOrigin.calls_changed[k], c[k], k);
    }
    for (const o of ["violates", "satisfies", "unknown", "aside"] as const) assert.equal(c.byOrigin.changed.outcomes[o] + c.byOrigin.calls_changed.outcomes[o], c.outcomes[o], o);
    assert.equal(c.byOrigin.calls_changed.functions, c.functions.calls_changed);
    const callersLeft = one.unchecked.filter((u) => u.origin === "calls_changed" && /budget/.test(u.why));
    assert.equal(callersLeft.length, c.byOrigin.calls_changed.overBudget);
    assert.ok(callersLeft.every((u) => u.why === `the callers' budget of ${c.byOrigin.calls_changed.budget} was already spent`), callersLeft.map((u) => u.why).join("; "));
  }
  assert.ok(all.every((one) => one.counts.byOrigin.calls_changed.overBudget > 0), "the callers' budget was spent, so the reason above was read");
});

test("calleeOf settles a call from a function that returns no Result, and says where", async () => {
  // The first half of applicabilityOf stops at such a function; the second half, read alone, is
  // what the siblings use, and it has to say where the call went even when that returns `()`.
  const files = { "src/a.rs": "pub fn quiet(dir: &Path) {\n    note_change(dir);\n}\n", "src/n.rs": "pub fn note_change(dir: &Path) {\n    let _ = dir;\n}\n" };
  const git = repo(files, {});
  const discoverer = new Discoverer(git, "AFTER", { include: () => true });
  const listed = enumerate("src/a.rs", files["src/a.rs"]);
  const fn = listed.functions.find((f) => f.name === "quiet")!;
  const call = listed.calls.find((c) => c.functionId === fn.id)!;
  const { result, at } = await calleeOf(discoverer, fn, call);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "callee_not_result");
  assert.deepEqual(at, { kind: "repository", path: "src/n.rs", line: 1 });
});
