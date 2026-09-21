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
import { ProviderError } from "../src/judgments/client.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import type { Git } from "../src/repository/git.ts";
import { DEFAULT_LOCAL_CHECK, renderLocalCheck, runLocalCheck, type LocalCheckOptions } from "../src/review/local-check-run.ts";
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
};

/**
 * Jev, scripted: the requirement applies to every call, and the reading of the code comes from the
 * body — a call written with `?` returns the error, anything else is read as a success.
 * `failFrom` makes every request from that one on fail on the run's own limit, as the real client
 * does once it has sent its last allowed request.
 */
function jev(failFrom?: number): { judge: JudgmentProvider; asked: { keys: string[]; instructions: string; symbol?: string }[] } {
  const asked: { keys: string[]; instructions: string; symbol?: string }[] = [];
  let n = 0;
  const judge: JudgmentProvider = {
    model: "typesafe/jev",
    async judge(state: unknown, questions: Questions) {
      n += 1;
      if (failFrom !== undefined && n >= failFrom) throw new ProviderError("budget", `request limit reached (${failFrom - 1})`);
      const packet = state as { candidate: { symbol?: string }; evidence: { code: string } };
      const keys = Object.keys(questions);
      const q = questions as unknown as Record<string, { instructions: string }>;
      asked.push({ keys, instructions: q[keys[0]!]!.instructions, symbol: packet.candidate.symbol });
      if (keys.includes("requirement_governs")) return { requirement_governs: { choice: "applies", probability: 0.9, confidence: 0.9, probabilities: { applies: 0.9 } } };
      const flat = packet.evidence.code.replace(/\s+/g, " ");
      const expression = /reaches the call `([^`]+)`/.exec(q[keys[0]!]!.instructions)?.[1] ?? "";
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

async function run(options: Partial<LocalCheckOptions> = {}, files?: Record<string, string>, failFrom?: number, before?: Record<string, string>) {
  const { judge, asked } = jev(failFrom);
  const results = await runLocalCheck(repo(files, before), { before: "BEFORE", after: "AFTER" }, [requirement], judge, () => true, { ...DEFAULT_LOCAL_CHECK, ...options });
  return { r: results[0]!, asked, text: renderLocalCheck(results) };
}

const key = (w: { file: string; function: string; call: string }) => `${w.file} ${w.function} ${w.call}`;
const near = <T extends { origin: string }>(list: readonly T[]) => list.filter((w) => w.origin !== "shares_call");
const noteWith = (notes: readonly string[], pattern: RegExp) => notes.find((n) => pattern.test(n));

test("(a) a sibling that swallows the failure is listed, reached through the call that ties it, asked first", async () => {
  const { r, asked, text } = await run({ beyondBudget: 1 });
  const f = r.findings.find((x) => x.function === "load_profile");
  assert.ok(f, `the sibling should be listed: ${JSON.stringify(r.findings)}`);
  assert.equal(f.call, "read_blob(dir)");
  assert.equal(f.origin, "shares_call");
  assert.equal(f.via, "read_blob");
  // One call beyond the changed functions, and it is the tying one although `measure` comes first.
  const beyond = r.wouldAsk.filter((w) => w.origin === "shares_call");
  assert.deepEqual(beyond.map(key), ["src/other.rs load_profile read_blob(dir)"]);
  assert.ok(r.unchecked.some((u) => u.function === "load_profile" && u.call === "measure(dir)" && /beyond the changed functions/.test(u.why)), JSON.stringify(r.unchecked));
  assert.ok(asked.some((a) => a.symbol === "load_profile"));
  // The lists hold both budgets' calls; the top-level counts are the first budget's, and the
  // siblings' are under `beyond`. Together they account for every list entry.
  assert.equal(r.counts.mapped + r.counts.beyond.mapped, r.mappings.length);
  assert.equal(r.counts.asked + r.counts.beyond.asked, r.observed.length);
  assert.equal(r.counts.beyond.asked, 1);
  assert.match(text, /### Worth checking/);
  assert.match(text, /other\.rs:\d+-\d+ · load_profile/);
  assert.match(text, /calls `read_blob`, which is called on or around the lines the change touched/);
  assert.match(text, /No place was found from the requirement's words/);
});

test("(b) the helper on the changed line is a seed before nine rarer names; ties go by files, then by name", async () => {
  const { r } = await run({ candidatesOnly: true });
  assert.deepEqual(r.seeds, ["read_blob", "dist2", "dist3", "dist4", "dist5", "dist6", "dist7", "dist8"]);
  const over = noteWith(r.notes, /over the cap of 8/);
  assert.ok(over, r.notes.join("\n"));
  assert.match(over, /\bdist9\b/);
  assert.match(over, /\bdist1\b/, "dist1 is used in one file more, so it goes last");
  // A function reachable only through a seed that was left out is not reached.
  assert.ok(!r.wouldAsk.some((w) => w.function === "uses_dist1"));
  assert.ok(r.wouldAsk.some((w) => w.function === "load_profile"), "and the sibling of the helper is");
});

test("(c) a function tied by nothing, or only by a comment or a string, is not a sibling; the real one is", async () => {
  const { r } = await run({ candidatesOnly: true });
  const all = [...r.wouldAsk, ...r.unchecked];
  for (const name of ["tidy", "describe"]) assert.ok(!all.some((w) => w.function === name), `${name} is not reached`);
  assert.ok(all.some((w) => w.function === "load_profile" && w.origin === "shares_call"));
});

test("(d) names that cannot be seeds are counted with their reason", async () => {
  const { r } = await run({ candidatesOnly: true });
  assert.match(noteWith(r.notes, /no definition here/) ?? "", /\bexists\b/);
  assert.match(noteWith(r.notes, /defined more than once/) ?? "", /\bdup\b/);
  assert.match(noteWith(r.notes, /do not return a Result/) ?? "", /\bsettle\b/);
  assert.match(noteWith(r.notes, /changed functions/) ?? "", /\bnormalize\b/);
  assert.ok(!r.seeds.includes("normalize") && !r.seeds.includes("dup") && !r.seeds.includes("settle") && !r.seeds.includes("exists"));
});

test("(d) a name the search cannot return in full is counted as that, not as one used in too many files", async () => {
  const { judge } = jev();
  const [r] = await runLocalCheck(repo(after(), undefined, new Set(["dist5"])), { before: "BEFORE", after: "AFTER" }, [requirement], judge, () => true, { ...DEFAULT_LOCAL_CHECK, candidatesOnly: true });
  assert.match(noteWith(r!.notes, /more references than the search returns/) ?? "", /\bdist5\b/);
  assert.ok(!noteWith(r!.notes, /used in more than 20 files/), r!.notes.join("\n"));
  assert.ok(!r!.seeds.includes("dist5") && r!.seeds.includes("read_blob"));
});

test("the calls inside the budget are told apart by file: a sibling of the same name elsewhere does not hide one", async () => {
  // Two siblings with the same name and the same call; with a sibling budget of 1 the first is
  // inside it and the second is not.
  const { r, text } = await run({ candidatesOnly: true, beyondBudget: 1 }, after({ "src/other2.rs": OTHER }));
  assert.ok(r.wouldAsk.some((w) => w.file === "src/other.rs" && w.call === "read_blob(dir)"));
  assert.ok(r.unchecked.some((u) => u.file === "src/other2.rs" && u.function === "load_profile" && u.call === "read_blob(dir)"));
  const inside = text.split("### Inside the budget")[1]?.split("###")[0] ?? "";
  assert.match(inside, /src\/other\.rs · load_profile — `read_blob\(dir\)`/);
});

test("(e) a caller of a changed function is never a sibling, even past the one-hop cap", async () => {
  const { r } = await run({ candidatesOnly: true });
  assert.ok(noteWith(r.notes, /more callers were found than the cap of 20/), "c21 is past the one-hop cap");
  const all = [...r.wouldAsk, ...r.unchecked];
  assert.ok(!all.some((w) => w.function === "c21"), "and is not a sibling either");
  assert.match(noteWith(r.notes, /also call a changed function/) ?? "", /\bc21\b/);
  assert.ok(all.some((w) => w.function === "load_profile" && w.origin === "shares_call"));
});

test("(e) a function turned away is counted once, however many seeds lead to it", async () => {
  // `cy` calls the changed function, `read_blob` and every distractor, so eight seeds reach it. The
  // distractors all gain the same one file, so the seeds are the same eight as before.
  const every = DISTRACTORS.map((d) => `    let _${d} = ${d}(dir)?;`).join("\n");
  const { r } = await run({ candidatesOnly: true }, after({ "src/callers_y.rs": `pub fn cy(dir: &Path) -> Result<(), AppError> {\n    load_settings(dir)?;\n    let _ = read_blob(dir);\n${every}\n    Ok(())\n}\n` }));
  assert.deepEqual(r.seeds, ["read_blob", "dist2", "dist3", "dist4", "dist5", "dist6", "dist7", "dist8"]);
  const note = noteWith(r.notes, /also call a changed function/) ?? "";
  assert.match(note, /^siblings: 2 functions/, note);
  assert.equal(note.match(/\bcy\b/g)?.length, 1, note);
});

test("(e) a function that calls a changed function past the listing's cap is not a sibling either", async () => {
  // `late` is changed, and it is the 61st function in its file: past the listing's cap of 60, so
  // the one-hop search never sees it. `uses_late` calls it and the seed.
  const filler = Array.from({ length: 60 }, (_, i) => `pub fn filler${i + 1}() -> u8 {\n    0\n}\n`).join("\n");
  const bigBefore = `${filler}\npub fn late(dir: &Path) -> Result<(), AppError> {\n    let _ = String::new();\n    Ok(())\n}\n`;
  const big = bigBefore.replace("let _ = String::new();", "let _ = String::from(\"x\");");
  const files = after({ "src/big.rs": big, "src/uses_late.rs": "pub fn uses_late(dir: &Path) -> Result<(), AppError> {\n    late(dir)?;\n    let Ok(raw) = read_blob(dir) else {\n        return Ok(());\n    };\n    Ok(())\n}\n" });
  const { r } = await run({ candidatesOnly: true }, files, undefined, { "src/store.rs": STORE_BEFORE, "src/big.rs": bigBefore });
  const all = [...r.wouldAsk, ...r.unchecked];
  assert.ok(!all.some((w) => w.function === "uses_late"), "it calls a changed function");
  assert.match(noteWith(r.notes, /also call a changed function/) ?? "", /\buses_late\b/);
  assert.ok(all.some((w) => w.function === "load_profile" && w.origin === "shares_call"), "and the real sibling is still reached");
});

test("(e) a changed test function of a seed's name does not take the seed out", async () => {
  const renamed = (s: string) => s.replace("fn loads()", "fn read_blob()");
  const { r } = await run({ candidatesOnly: true }, after({ "src/store.rs": renamed(STORE) }), undefined, { "src/store.rs": renamed(STORE_BEFORE) });
  assert.ok(r.seeds.includes("read_blob"), `${r.seeds} / ${r.notes.join(" || ")}`);
  assert.ok(r.wouldAsk.some((w) => w.function === "load_profile" && w.origin === "shares_call"));
});

test("(e) a changed function in another language does not turn a Rust sibling away", async () => {
  // The change also touches a Python `def tag_blob`, defined nowhere else. `keep` calls a
  // `tag_blob` and the seed: nothing in Rust that the change touched.
  const py = { before: "def tag_blob():\n    return 1\n", after: "def tag_blob():\n    return 2\n" };
  const keep = "pub fn keep(dir: &Path) -> Result<(), AppError> {\n    let t = tag_blob();\n    let Ok(raw) = read_blob(dir) else {\n        return Ok(());\n    };\n    Ok(())\n}\n";
  const { r } = await run({ candidatesOnly: true }, after({ "src/keep.rs": keep, "tools/tag.py": py.after }), undefined, { "src/store.rs": STORE_BEFORE, "tools/tag.py": py.before });
  assert.ok(r.wouldAsk.some((w) => w.function === "keep" && w.origin === "shares_call"), [...r.wouldAsk.map((w) => w.function), ...r.notes].join(" || "));
});

test("(e) a call by a changed function's name turns a function away only when that name is defined once", async () => {
  // The change touches `pub fn open` in `src/made.rs`. `make` calls `Profile::open(…)` and the
  // seed. `open` is used in more than 20 files, so the one-hop search does not follow it: whether
  // `make` is reached at all is the siblings' call. (`fn new` would not do: this tool does not read
  // `new` as a function name at all — `NOT_NAMES` in `blocks.ts`.)
  const common = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`src/n${i + 1}.rs`, `pub fn n${i + 1}() -> Result<(), AppError> {\n    let _ = File::open("x");\n    Ok(())\n}\n`]));
  const madeBefore = "pub fn open(dir: &Path) -> Result<u8, AppError> {\n    Ok(0)\n}\n";
  const made = madeBefore.replace("Ok(0)", "Ok(1)");
  const make = "pub fn make(dir: &Path) -> Result<(), AppError> {\n    let p = Profile::open(dir)?;\n    let Ok(raw) = read_blob(dir) else {\n        return Ok(());\n    };\n    Ok(())\n}\n";
  const before = { "src/store.rs": STORE_BEFORE, "src/made.rs": madeBefore };
  const shared = await run({ candidatesOnly: true }, after({ ...common, "src/made.rs": made, "src/make.rs": make, "src/profile.rs": "pub fn open(dir: &Path) -> Result<u8, AppError> {\n    Ok(2)\n}\n" }), undefined, before);
  assert.ok(shared.r.wouldAsk.some((w) => w.function === "make" && w.origin === "shares_call"), `\`open\` is defined twice: calling it says nothing about the changed one / ${shared.r.notes.join(" || ")}`);
  assert.match(noteWith(shared.r.notes, /changed functions have a name defined more than once/) ?? "", /\bopen\b/);
  // The control: with one `open`, `make` does call the changed function and is turned away.
  const single = await run({ candidatesOnly: true }, after({ ...common, "src/made.rs": made, "src/make.rs": make }), undefined, before);
  assert.ok(![...single.r.wouldAsk, ...single.r.unchecked].some((w) => w.function === "make"));
  assert.match(noteWith(single.r.notes, /also call a changed function/) ?? "", /\bmake\b/);
});

test("the siblings are looked for only after every requirement's first budget has been asked", async () => {
  // `unwrap_or_default` is on a removed line only, so the sibling search is the one thing that
  // searches for it. Nothing about siblings may cost time before the first budget's questions.
  const events: string[] = [];
  const inner = repo();
  const watched = { ...inner, grep: async (rev: string, pattern: string, o: unknown) => (events.push(`grep ${pattern}`), (inner as unknown as { grep: Function }).grep(rev, pattern, o)) } as unknown as Git;
  const { judge } = jev();
  const asking: JudgmentProvider = { model: judge.model, judge: async (s, q) => (events.push("judge"), judge.judge(s, q)) };
  await runLocalCheck(watched, { before: "BEFORE", after: "AFTER" }, [requirement], asking, () => true, { ...DEFAULT_LOCAL_CHECK, beyondBudget: 0 });
  const searched = events.indexOf("grep unwrap_or_default");
  assert.ok(searched > 0, "the sibling search ran");
  assert.ok(events.lastIndexOf("judge") < searched, "and every question of the first budget came before it");
});

test("(f) a name called only in the change's tests is not a seed", async () => {
  const { r } = await run({ candidatesOnly: true });
  assert.ok(!r.seeds.includes("fixture_blob"));
  assert.match(noteWith(r.notes, /only in the change's tests/) ?? "", /\bfixture_blob\b/);
  assert.ok(r.seeds.includes("read_blob"));
});

test("(g) the second budget is the siblings' own: the first one's calls do not move", async () => {
  const none = await run({ candidatesOnly: true, beyondBudget: 0 });
  const some = await run({ candidatesOnly: true });
  assert.deepEqual(near(some.r.wouldAsk).map(key), near(none.r.wouldAsk).map(key));
  assert.ok(!none.r.wouldAsk.some((w) => w.origin === "shares_call"));
  assert.ok(some.r.wouldAsk.some((w) => w.origin === "shares_call"));
  assert.equal(some.r.counts.budget, DEFAULT_LOCAL_CHECK.budget);
  assert.equal(some.r.counts.beyond.budget, DEFAULT_LOCAL_CHECK.beyondBudget);
  // The first budget's counts are about the first budget's calls only.
  assert.equal(some.r.counts.applicable, none.r.counts.applicable);
  assert.equal(some.r.counts.overBudget, none.r.counts.overBudget);
  // A sibling that returns no Result is counted, not asked about.
  assert.match(noteWith(some.r.notes, /return no Result/) ?? "", /\bpeek\b/);
});

test("(g) siblings do not spend the run's own limit before a later requirement's first budget", async () => {
  // Three requirements under a request limit that three first budgets fit in and siblings do not.
  const three = ["R1", "R2", "R3"].map((id) => ({ ...requirement, id }));
  const ask = async (beyondBudget: number) => {
    const { judge } = jev(3 * 2 * 20 + 1);
    return runLocalCheck(repo(), { before: "BEFORE", after: "AFTER" }, three, judge, () => true, { ...DEFAULT_LOCAL_CHECK, beyondBudget });
  };
  const without = await ask(0);
  const withSiblings = await ask(DEFAULT_LOCAL_CHECK.beyondBudget);
  for (const [i, r] of withSiblings.entries()) {
    assert.equal(r.counts.asked, without[i]!.counts.asked, `${r.requirementId}: the first budget is asked in full either way`);
    assert.deepEqual(near(r.observed).map(key), near(without[i]!.observed).map(key));
  }
  assert.ok(without.every((r) => r.stopped === undefined));
  // What the limit left unasked is the siblings, and each requirement that lost some says so.
  assert.ok(withSiblings.every((r) => r.stopped !== undefined && r.counts.beyond.asked === 0));
});

test("(h) stopped after a mapping and before any reading: the report does not say nothing was read", async () => {
  const { r, text } = await run({}, undefined, 2);
  assert.equal(r.observed.length, 0);
  assert.equal(r.mappings.length, 1);
  assert.ok(!text.includes("_Nothing was read._"), text.slice(0, 1500));
  assert.match(text, /### Read as required by the requirement/);
});

for (const [at, what] of [
  [3, "a mapping question"],
  [4, "an observation question"],
] as const) {
  test(`(h) the run's own limit reached at ${what}: the report still comes out, and what was not asked says why`, async () => {
    const { r, text } = await run({}, undefined, at);
    assert.match(r.stopped ?? "", /request limit reached/);
    assert.equal(r.mappings.length, at === 3 ? 1 : 2, "a mapping cut off by the limit is not recorded as unanswered");
    assert.ok(!r.mappings.some((m) => /budget|limit/.test(m.why)), JSON.stringify(r.mappings));
    assert.ok(r.unchecked.some((u) => /the run stopped at its own limit/.test(u.why)));
    // A call whose mapping was answered before the limit says that only its reading was not asked.
    assert.equal(r.unchecked.some((u) => /the mapping was asked, but not what the function returns/.test(u.why)), at === 4);
    assert.equal(r.observed.length, 1);
    assert.match(text, /stopped at its own limit/);
  });
}

test("(h) from the command line, a run that reaches its own limit reports and exits 0", async () => {
  const repoDir = tempRepo();
  try {
    const files = after();
    repoDir.write({ ...files, "src/store.rs": STORE_BEFORE });
    const base = repoDir.commit("before");
    repoDir.write({ "src/store.rs": STORE });
    const head = repoDir.commit("propagate the read");
    const spec = join(repoDir.dir, "spec.json");
    writeFileSync(spec, JSON.stringify({ version: 1, title: "t", summary: "", requirements: [requirement], nonGoals: [], ambiguities: [] }));
    const { judge } = jev(4);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["--experimental-local-check", "--base", base, "--head", head, "--intent-spec", spec, "--json"],
      { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: repoDir.dir, env: { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "test-token" } },
      { judges: () => ({ provider: judge, sent: () => ({ requests: 0, bytes: 0 }), origin: "https://api.cloudflare.com" }) },
    );
    assert.equal(code, 0, err.join(""));
    const report = JSON.parse(out.join("")) as { requirements: { stopped?: string; unchecked: { why: string }[] }[] };
    assert.match(report.requirements[0]!.stopped ?? "", /request limit reached/);
  } finally {
    repoDir.remove();
  }
});
