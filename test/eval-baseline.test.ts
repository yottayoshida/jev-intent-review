import assert from "node:assert/strict";
import test from "node:test";
import { claudeArgs, gather, readFindings, readRun, requirementWords, type Repo } from "../bench/eval/baseline.ts";
import { hit, judge, jevTopFindings, names, neededWins, uplift, type Pair } from "../bench/eval/compare.ts";
import type { RequirementRun, Target } from "../bench/acceptance/score.ts";

// A repository of five files, each 100 bytes once framed, so budgets can be counted by hand.
const body = (n: string) => `${n}\n`.padEnd(100 - `--- file: ${n}\n`.length - 1, "x");
const FILES: Record<string, string> = Object.fromEntries(["src/a.rs", "src/b.rs", "src/c.rs", "src/d.rs", "src/e.rs"].map((p) => [p, body(p)]));
const fake: Repo = {
  diff: () => "D".repeat(50),
  read: (_rev, p) => FILES[p] ?? null,
  // b calls the changed function; the requirement's words hit e twice and d once.
  grep: (_rev, w) => ({ title: ["src/b.rs"], session: ["src/e.rs", "src/d.rs"], generating: ["src/e.rs"] } as Record<string, string[]>)[w] ?? [],
  changed: () => ["src/a.rs · title", "src/a.rs · other"],
};
const REQ = "If generating a session title fails, the failure must reach the caller";

test("the requirement's words drop stop words and short words, once each", () => {
  assert.deepEqual(requirementWords(REQ), ["generating", "session", "title"]);
});

test("the material follows the fixed order, and a file that does not fit whole is skipped for the next", () => {
  const req = Buffer.byteLength(`--- requirement\n${REQ}\n`);
  const diff = Buffer.byteLength(`--- diff aaaaaaaaaaaa..bbbbbbbbbbbb\n${"D".repeat(50)}\n`);
  const file = 100;
  const all = gather(fake, REQ, "a".repeat(40), "b".repeat(40), 10_000);
  // Step 3 the changed file, step 4 its caller, step 5 by distinct words (e: 2, d: 1).
  assert.deepEqual(all.parts.map((p) => [p.step, p.path ?? null]), [[1, null], [2, null], [3, "src/a.rs"], [4, "src/b.rs"], [5, "src/e.rs"], [5, "src/d.rs"]]);
  assert.equal(all.parts.filter((p) => p.path).every((p) => p.bytes === file), true);
  const exact = req + diff + 4 * file;
  const fits = gather(fake, REQ, "a".repeat(40), "b".repeat(40), exact);
  assert.equal(fits.bytes, exact);
  assert.equal(fits.stoppedAt, undefined);
  // One byte less: the last file is left out whole.
  const short = gather(fake, REQ, "a".repeat(40), "b".repeat(40), exact - 1);
  assert.deepEqual(short.parts.map((p) => p.path ?? null), [null, null, "src/a.rs", "src/b.rs", "src/e.rs"]);
  assert.deepEqual(short.skipped, [{ step: 5, path: "src/d.rs", bytes: file }]);
  // A large file early on is skipped, and the smaller ones after it still go in.
  const big: Repo = { ...fake, read: (rev, p) => (p === "src/b.rs" ? "B".repeat(1000) : fake.read(rev, p)) };
  const around = gather(big, REQ, "a".repeat(40), "b".repeat(40), exact);
  assert.deepEqual(around.parts.map((p) => p.path ?? null), [null, null, "src/a.rs", "src/e.rs", "src/d.rs"]);
  assert.equal(around.skipped[0]!.path, "src/b.rs");
  // The diff not fitting gives nothing after it.
  assert.equal(gather(fake, REQ, "a".repeat(40), "b".repeat(40), req + 10).stoppedAt!.step, 2);
});

test("step 4 takes the rarest changed name first, so a common name cannot push the caller out", () => {
  const many = Array.from({ length: 30 }, (_, i) => `src/aa${String(i).padStart(2, "0")}.rs`);
  const repo: Repo = {
    ...fake,
    read: (_rev, p) => (p === "src/a.rs" || many.includes(p) || p === "src/zz_caller.rs" ? body(p) : null),
    grep: (_rev, w) => (w === "a_common" ? ["src/a.rs", ...many] : w === "handle_title" ? ["src/a.rs", "src/zz_caller.rs"] : []),
    changed: () => ["src/a.rs · a_common", "src/a.rs · handle_title"],
  };
  const req = Buffer.byteLength(`--- requirement\n${REQ}\n`);
  const diff = Buffer.byteLength(`--- diff aaaaaaaaaaaa..bbbbbbbbbbbb\n${"D".repeat(50)}\n`);
  // Room for the changed file and two more: by path or by name the 30 `a_common` files would take it; by rarity the caller does.
  const g = gather(repo, REQ, "a".repeat(40), "b".repeat(40), req + diff + 3 * 100);
  assert.deepEqual(g.parts.filter((p) => p.step === 4).map((p) => p.path), ["src/zz_caller.rs", "src/aa00.rs"]);
});

test("the command gives the model no tools, no MCP, no user settings and a fixed system prompt", () => {
  const a = claudeArgs("x");
  for (const flag of ["--strict-mcp-config", "--no-session-persistence"]) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf("--tools") + 1], "");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "project");
  assert.equal(a[a.indexOf("--model") + 1], "claude-opus-5-5");
  assert.ok(a.includes("--system-prompt"));
});

const out = (result: string, model = "claude-opus-5-5") => JSON.stringify({ result, total_cost_usd: 0.1, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 2 }, modelUsage: { [model]: {} } });
const F = { file: "src/a.rs", function: "title", call: "generate_title(p)", claim: "returns Ok(None)" };

test("an answer is read with or without a code fence, cut to five, and a run of another model is not counted", () => {
  assert.deepEqual(readFindings("```json\n[]\n```"), []);
  assert.equal(readFindings('{"file":"x"}'), null);
  const cached = readRun(JSON.stringify({ result: "[]", usage: { input_tokens: 2, cache_creation_input_tokens: 30000, cache_read_input_tokens: 5, output_tokens: 1 }, modelUsage: { "claude-opus-5-5": {} } }));
  assert.equal(cached.inputTokens, 30007);
  const six = readRun(out(JSON.stringify(Array.from({ length: 6 }, () => F))));
  assert.equal(six.counted, true);
  assert.equal(six.findings.length, 5);
  assert.equal(six.listed, 6);
  const other = readRun(out("[]", "claude-sonnet-5"));
  assert.equal(other.counted, false);
  assert.match(other.why!, /claude-sonnet-5/);
  assert.equal(readRun("not json").counted, false);
});

const target: Target = { requirementId: "R1", file: "src/a.rs", function: "title", call: "generate_title(p)" };

test("a hit names the target's call, as quoted from the code, in each of three counted runs", () => {
  assert.ok(names({ ...F, call: "generate_title( p )" }, target));
  // The listing writes no receiver and no .await; a quote of the code does (both dev defects inside the diff).
  assert.ok(names({ ...F, call: "self.generate_title(p).await" }, target));
  assert.equal(names({ ...F, function: "other" }, target), false);
  // A function written with its type, or a path from a diff header, is the same place.
  assert.ok(names({ ...F, function: "Session::title", file: "b/src/a.rs" }, target));
  // Another call in the same function is not the target.
  assert.equal(names({ ...F, call: "load(p)" }, target), false);
  assert.ok(hit([[F], [F], [F]], target));
  assert.equal(hit([[F], [F], []], target), false);
  // Fewer than three counted runs is no hit.
  assert.equal(hit([[F], [F]], target), false);
});

test("jev's findings are cut to five by the probability of the answer that listed them", () => {
  const row = (i: number) => ({ file: "f.rs", function: "f", call: `c${i}()`, requirementId: "R1" });
  const r = {
    requirementId: "R1",
    observed: Array.from({ length: 7 }, (_, i) => ({ ...row(i), result: { observation: "returns_success", probability: i === 6 ? 0.99 : 0.7 } })),
    unchecked: [],
    mappings: [],
    findings: Array.from({ length: 7 }, (_, i) => row(i)),
  } as unknown as RequirementRun;
  assert.deepEqual(jevTopFindings(r).map((f) => f.call), ["c6()", "c0()", "c1()", "c2()", "c3()"]);
});

const pairs = (repos: number, wins: number, losses = 0): Pair[] =>
  Array.from({ length: repos }, (_, i) => ({ repo: `r/${i}`, place: "A" as const, jev: i < wins, baseline: i >= repos - losses }));

test("the gate: 17 repositories with no loss fail at 10 wins and pass at 11; 11 wins and 1 loss fail", () => {
  const none = { listed: 0, targets: 1 };
  const clean = [{ repo: "r/0", jev: false, baseline: false, jevKnown: none }];
  const guardOk = Array.from({ length: 17 }, (_, i) => ({ repo: `r/${i}`, jev: false, baseline: false, jevKnown: none }));
  assert.equal(judge(pairs(17, 10), guardOk).status, "fail");
  assert.equal(judge(pairs(17, 11), guardOk).status, "pass");
  assert.equal(judge(pairs(17, 11, 1), guardOk).status, "fail");
  assert.equal(neededWins(17), 11);
  assert.equal(neededWins(6), null);
  // The guard: one repository is far too few to bound jev's false listing under 0.20.
  // One repository is far too few to bound the false listing: no verdict, not a fail.
  const v = judge(pairs(17, 11), clean);
  assert.equal(v.status, "no_verdict");
  assert.equal(v.guard.holds, false);
  assert.equal(judge(pairs(17, 11), guardOk.slice(0, 16)).status, "no_verdict");
  // jev listing falsely on 3 of 17 while the baseline does on none: 0.18 > 0 + 0.10.
  const worse = guardOk.map((g, i) => ({ ...g, jev: i < 3 }));
  assert.equal(judge(pairs(17, 11), worse).guard.holds, false);
  // A perfect jev at 17 repositories holds: its upper bound 0.195 is within 0.20.
  assert.equal(judge(pairs(17, 11), guardOk).guard.holds, true);
  // One adjudicated false finding of jev's, the baseline with two: the ceiling is on known targets only, so it holds.
  const judged = guardOk.map((g, i) => ({ ...g, jev: i === 0, baseline: i < 2 }));
  assert.equal(judge(pairs(17, 11), judged).guard.holds, true);
  // jev listing the one known target of a correct version in one repository of 17: upper bound 0.287 > 0.20.
  const oneKnown = judge(pairs(17, 11), guardOk.map((g, i) => ({ ...g, jev: i === 0, jevKnown: { listed: i === 0 ? 1 : 0, targets: 1 } })));
  assert.equal(oneKnown.guard.holds, false);
  assert.ok(Math.abs(oneKnown.guard.jevUpper! - 0.287) < 0.001);
  assert.equal(oneKnown.status, "fail");
  // Counted per target, as metrics.ts does: one of a version's two targets is half that version.
  const half = judge(pairs(17, 11), guardOk.map((g, i) => ({ ...g, jevKnown: { listed: i === 0 ? 1 : 0, targets: 2 } })));
  assert.ok(half.guard.jevUpper! < oneKnown.guard.jevUpper!);
  // Too few repositories for any number of wins: no verdict, not a fail.
  assert.equal(judge(pairs(6, 6), guardOk.slice(0, 6)).status, "no_verdict");
});

test("a repository is one observation in the difference, and places are reported apart", () => {
  const p: Pair[] = [
    { repo: "x/one", place: "A", jev: true, baseline: true },
    { repo: "x/one", place: "B", jev: true, baseline: false },
    { repo: "x/two", place: "A", jev: false, baseline: true },
  ];
  const u = uplift(p);
  // x/one: mean of 0 and +1 = 0.5; x/two: -1. Mean over repositories: -0.25.
  assert.equal(u.estimate, -0.25);
  assert.equal(u.repos, 2);
  assert.deepEqual([u.wins, u.losses, u.ties], [1, 1, 1]);
  const v = judge(p, []);
  assert.equal(v.uplift.B.wins, 1);
  assert.equal(v.uplift.A.losses, 1);
});
