import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadCases, render, type AcceptanceLog } from "../bench/acceptance/replay.ts";
import { occurrences, reachOf, readRun, scoreListed, scoreVersion, ScoringError, type CaseFile, type RunRecord, type Target, type VersionLog } from "../bench/acceptance/score.ts";

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;

// ---- 1. The old measurement, through the new table ---------------------------------------------

interface OldLog {
  branches: Record<string, { requirements: RunRecord["requirements"] }>;
}

test("the new scoring reproduces the ten cells of stated-requirements-v1.json", () => {
  const c = read<CaseFile>("../bench/acceptance/cases/omamori-468/case.json");
  const log = read<OldLog>("../bench/logs/stated-requirements-v1.json");
  const cells = Object.keys(c.versions).flatMap((v) => scoreListed(c, v, { finished: true, requirements: log.branches[v]!.requirements }));
  assert.equal(cells.length, 10);
  assert.deepEqual(cells.filter((x) => !x.agrees), []);
  // The two listings are the two mutations, each at its own target — not merely "two were listed".
  assert.deepEqual(
    cells.filter((x) => x.listed).map((x) => x.targetKey),
    ["R1", "R2"],
  );
});

test("one expected cell turned over makes exactly that cell differ", () => {
  const c = read<CaseFile>("../bench/acceptance/cases/omamori-468/case.json");
  const log = read<OldLog>("../bench/logs/stated-requirements-v1.json");
  c.versions["v-read-baseline"]!.expected.R1 = "listed";
  const differ = Object.keys(c.versions).flatMap((v) => scoreListed(c, v, { finished: true, requirements: log.branches[v]!.requirements }).filter((x) => !x.agrees).map((x) => `${v}/${x.targetKey}`));
  assert.deepEqual(differ, ["v-read-baseline/R1"]);
});

// ---- 2. One call at a time, stage by stage ------------------------------------------------------

const T: Target = { requirementId: "R1", file: "src/a.rs", function: "load", call: "read_all(&path)" };
const SIBLING = { file: "src/a.rs", function: "load", call: "exists(&path)" };
const OTHER = { file: "src/b.rs", function: "elsewhere", call: "fetch(x)" };

const run = (over: Partial<RunRecord["requirements"][number]> = {}): RunRecord => ({
  finished: true,
  requirements: [{ requirementId: "R1", observed: [], unchecked: [], mappings: [], findings: [], ...over }],
});

test("(a) another call in the same function being listed is not the target being listed", () => {
  const reading = readRun(T, run({ findings: [{ ...SIBLING, requirementId: "R1" }], observed: [{ ...T, result: { observation: "returns_error", probability: 0.9 } }] }));
  assert.equal(reading.listed, false);
  // Control: the target itself listed is read as listed.
  assert.equal(readRun(T, run({ findings: [{ ...T, requirementId: "R1" }] })).listed, true);
});

test("(b) a target held before the budget carries the kind applicabilityOf gave, not prose", () => {
  const reach = reachOf("A", T, { wouldAsk: [], unchecked: [{ ...T, why: "anything at all" }], notes: [], targetApplicability: { A: { ok: false, kind: "target_not_result" } } }, 1);
  assert.deepEqual(reach, { stage: "held", kind: "target_not_result" });
  // Applicable but not asked is the budget, not a hold.
  assert.deepEqual(reachOf("A", T, { wouldAsk: [], unchecked: [{ ...T, why: "" }], notes: [], targetApplicability: { A: { ok: true } } }, 1), { stage: "over_budget" });
});

test("(c) an absent target is told apart by whether a cap fired where it could have dropped it", () => {
  assert.deepEqual(reachOf("A", T, { wouldAsk: [], unchecked: [], notes: ["src/a.rs: 12 calls were left out of the listing by its cap"] }, 1), { stage: "not_enumerated", capNoted: true });
  assert.deepEqual(reachOf("A", T, { wouldAsk: [], unchecked: [], notes: ["src/other.rs: 12 calls were left out of the listing by its cap"] }, 1), { stage: "not_enumerated", capNoted: false });
  assert.deepEqual(reachOf("A", T, { wouldAsk: [], unchecked: [], notes: ["only the first 12 of 23 changed functions had their callers looked up"] }, 1), { stage: "not_enumerated", capNoted: true });
});

test("(d) a target inside the budget whose body did not fit stops after the budget", () => {
  const reading = readRun(T, run({ unchecked: [{ ...T, why: "the body of load did not fit the evidence limit" }] }));
  assert.equal(reading.stage, "after_budget");
  assert.equal(reading.observation, undefined);
});

test("a run that sent no answer about the target is never counted as right, even where nothing was expected", () => {
  const c = oneCase("x", "r", { shipped: version({ A: "not_listed" }) });
  const unanswered = [
    run({ unchecked: [{ ...T, why: "the body of load did not fit the evidence limit" }] }),
    run({ mappings: [{ ...T, verdict: "no_answer", probability: 0, governs: false }] }),
    run({ observed: [{ ...T, result: { observation: "returns_error", probability: 0.9 } }], mappings: [{ ...T, verdict: "applies", probability: 0.9, governs: true }] }),
  ];
  const [row] = scoreVersion(c, "shipped", liveLog(unanswered));
  assert.equal(row!.right, 1);
  assert.equal(row!.agrees, false);
});

test("(e) a mapping that got no answer is its own stage, not a reading below the bar", () => {
  const noAnswer = readRun(T, run({ mappings: [{ ...T, verdict: "no_answer", probability: 0, governs: false }], observed: [{ ...T, result: { observation: "returns_error", probability: 0.95 } }] }));
  assert.equal(noAnswer.stage, "no_answer");
  const weak = readRun(T, run({ mappings: [{ ...T, verdict: "applies", probability: 0.4, governs: false }] }));
  assert.equal(weak.stage, "answered");
});

const version = (expected: CaseFile["versions"][string]["expected"], place?: "A" | "B" | "C") => ({ base: "b".repeat(40), head: "h".repeat(40), ...(place ? { place } : {}), targets: { A: T }, expected });
const oneCase = (id: string, repo: string, versions: CaseFile["versions"]): CaseFile => ({ id, repo, role: "unseen", versions, existence: Object.fromEntries(Object.keys(versions).map((v) => [v, { A: 1 }])) });
const liveLog = (runs: RunRecord[]): VersionLog => ({ base: "b".repeat(40), head: "h".repeat(40), enumeration: { wouldAsk: [T], unchecked: [], notes: [] }, runs });

test("(f) a call that is not a target, listed on the shipped code, is not scored as a false listing", () => {
  const c = oneCase("x", "r", { shipped: version({ A: "not_listed" }) });
  const three = [0, 1, 2].map(() => run({ findings: [{ ...OTHER, requirementId: "R1" }], observed: [{ ...T, result: { observation: "returns_error", probability: 0.9 } }] }));
  const [row] = scoreVersion(c, "shipped", liveLog(three));
  assert.equal(row!.agrees, true);
  assert.equal(row!.right, 3);
});

test("(g) a target that matches two calls in the enumeration is not scored at all", () => {
  assert.throws(() => reachOf("A", T, { wouldAsk: [T], unchecked: [{ ...T, why: "held" }], notes: [] }, 1), ScoringError);
});

test("(h) a target that is not in its file once is refused, not reported as unreached", () => {
  assert.throws(() => reachOf("A", T, { wouldAsk: [], unchecked: [], notes: [] }, 0), ScoringError);
  assert.throws(() => reachOf("A", T, { wouldAsk: [], unchecked: [], notes: [] }, 2), ScoringError);
});

test("existence is counted in the text of the target's own function, whatever the tool's caps", () => {
  // Forty-one calls before the target: the tool's listing stops at forty, the text does not.
  const filler = Array.from({ length: 41 }, (_, i) => `    step_${i}(&x)?;`).join("\n");
  const source = `fn apply_chunk(x: u8) -> Result<(), E> {\n${filler}\n    prefix_data.restorer\n        .finalize(grove_version)?;\n    Ok(())\n}\n\nfn other() -> Result<(), E> {\n    finalize(grove_version)?;\n    Ok(())\n}\n`;
  assert.equal(occurrences(source, "apply_chunk", "finalize(grove_version)"), 1);
  assert.equal(occurrences(source, "other", "finalize(grove_version)"), 1);
  assert.equal(occurrences(source, "apply_chunk", "finalize(version)"), 0);
  assert.equal(occurrences(`fn twice() {\n  a(1);\n  a(1);\n}\n`, "twice", "a(1)"), 2);
});

test("the undetermined version is right only when no confident reading came back", () => {
  const c = oneCase("x", "r", { hidden: version({ A: "undetermined" }) });
  const answers = [
    { observation: "cannot_determine", probability: 0.9 },
    { observation: "returns_error", probability: 0.5 },
    { observation: "returns_error", probability: 0.8 },
  ];
  const [row] = scoreVersion(c, "hidden", liveLog(answers.map((result) => run({ observed: [{ ...T, result }] }))));
  assert.equal(row!.right, 2);
  assert.equal(row!.agrees, false);
});

// ---- 3. The table refuses to print what the claim would not hold of -----------------------------

const good = (): { cases: CaseFile[]; log: AcceptanceLog } => {
  // Each run answers about the target, as a real run does: a listing needs both answers.
  const answered = (listed: boolean) =>
    run({
      mappings: [{ ...T, verdict: "applies", probability: 0.99, governs: true }],
      observed: [{ ...T, result: { observation: listed ? "returns_success" : "returns_error", probability: 0.95 } }],
      ...(listed ? { findings: [{ ...T, requirementId: "R1" }] } : {}),
    });
  const three = (listed: boolean) => [0, 1, 2].map(() => answered(listed));
  const cases = [
    oneCase("one", "https://example.com/one", { shipped: version({ A: "not_listed" }), "defect-B": version({ A: "listed" }, "B") }),
    oneCase("two", "https://example.com/two", { shipped: version({ A: "not_listed" }) }),
  ];
  const log: AcceptanceLog = {
    conditions: {},
    cases: {
      one: { versions: { shipped: liveLog(three(false)), "defect-B": liveLog(three(true)) } },
      two: { versions: { shipped: liveLog(three(false)) } },
    },
  };
  return { cases, log };
};
const candidates = { candidates: [{ order: 1, ref: "x", a: "pass", b: "pass", c: "pass" }] };

test("a set that meets every condition gets its table", () => {
  const { cases, log } = good();
  const out = render(cases, log, candidates);
  assert.match(out, /Measured: 2 requirements from 2 repositories/);
  assert.match(out, /\| one \| defect-B \| A `load` \| listed \| asked \| .* \| 3\/3 agrees \|/);
});

test("one repository, no target outside the diff, fewer than three runs, zero runs, or moved commits: no table", () => {
  const oneRepo = good();
  oneRepo.cases[1]!.repo = oneRepo.cases[0]!.repo;
  assert.throws(() => render(oneRepo.cases, oneRepo.log, candidates), /two or more/);

  const inside = good();
  delete inside.cases[0]!.versions["defect-B"];
  delete inside.log.cases.one!.versions["defect-B"];
  assert.throws(() => render(inside.cases, inside.log, candidates), /outside the diff/);

  const two = good();
  two.log.cases.two!.versions.shipped!.runs.pop();
  assert.throws(() => render(two.cases, two.log, candidates), /2 times to completion/);

  // A branch with every run removed is still a branch the enumeration put the target in budget for.
  const none = good();
  none.log.cases.two!.versions.shipped!.runs = [];
  assert.throws(() => render(none.cases, none.log, candidates), /0 times to completion/);

  const unmeasured = good();
  delete unmeasured.log.cases.two;
  assert.throws(() => render(unmeasured.cases, unmeasured.log, candidates), /no measurement in the log/);

  const extra = good();
  delete extra.cases[1]!.versions.shipped;
  extra.cases[1]!.versions.other = version({ A: "not_listed" });
  assert.throws(() => render(extra.cases, extra.log, candidates), /in the log and not in case\.json/);

  const moved = good();
  moved.log.cases.two!.versions.shipped!.base = "c".repeat(40);
  assert.throws(() => render(moved.cases, moved.log, candidates), /case\.json says/);
});

// ---- 3b. The document says what the committed record says, byte for byte ------------------------

test("the table in docs/local-check-cli.md is exactly what the committed log and cases produce", () => {
  const doc = readFileSync(new URL("../docs/local-check-cli.md", import.meta.url), "utf8");
  const begin = "<!-- acceptance:begin -->\n";
  const end = "\n<!-- acceptance:end -->";
  assert.equal(doc.split(begin).length, 2, "exactly one acceptance:begin marker");
  const block = doc.slice(doc.indexOf(begin) + begin.length, doc.indexOf(end));
  const log = read<AcceptanceLog>("../bench/logs/acceptance-v1.json");
  const candidates = read<Parameters<typeof render>[2]>("../bench/acceptance/candidates.json");
  assert.equal(block, render(loadCases(), log, candidates));
});
