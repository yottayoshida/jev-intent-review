// What a requirement's section rests on, and what the report's first line says a run left (#38): a
// run that left calls it could have asked never reads as having checked everything, in the report or
// in the Action's check run title, and the two say the same numbers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { conclude } from "../action/finish.ts";
import { coverageLine, leftParts, renderMarkdown } from "../src/report/markdown.ts";
import type { LocalCheckResult } from "../src/review/local-check-run.ts";
import type { ReviewReport } from "../src/types.ts";
import { localCheckResult, report } from "./helpers/reports.ts";

const at = (file: string, call: string) => ({ file, function: "open_session", call, origin: "changed" as const });
const budgeted = [at("src/auth.rs", "create_session(store, &record)"), at("src/auth.rs", "load_key(store, key)")];

/** Both calls that could be asked read and answered, nothing that could not be asked, no note. */
const whole = (): LocalCheckResult => {
  const r = localCheckResult();
  return { ...r, wouldAsk: budgeted, unchecked: [], notes: [], counts: { ...r.counts, notApplicable: 0 } };
};
const firstLine = (rep: ReviewReport) => renderMarkdown(rep).split("\n")[2] ?? "";

test("a requirement whose every call that could be asked was read and answered says so, and the first line adds nothing", () => {
  const r = whole();
  assert.equal(coverageLine(r), "All 2 calls that could be asked were read and answered.");
  assert.equal(firstLine(report({ requirements: [r] })), "**Result: 1 call worth checking of 2 read.** No requirement verdict is stated.");
  assert.ok(renderMarkdown(report({ requirements: [r] })).includes("\nAll 2 calls that could be asked were read and answered.\n"));
});

test("calls over the budgets are left, in the section and in the first line", () => {
  const r = whole();
  const over = [at("src/auth.rs", "a()"), at("src/auth.rs", "b()"), at("src/auth.rs", "c()")].map((u) => ({ ...u, why: "the budget of 20 was already spent" }));
  const left: LocalCheckResult = { ...r, unchecked: over, counts: { ...r.counts, applicable: 5, overBudget: 3 } };
  assert.equal(coverageLine(left), "Of the 5 calls that could be asked: 2 read and answered, 3 over the budgets.");
  assert.match(firstLine(report({ requirements: [left] })), /\*\* 3 not checked, for the reasons under each requirement\. No requirement verdict/);
});

test("a call asked about and left without an answer is not read: a run the request limit stopped never says all were read", () => {
  const r = whole();
  // What a limit of 0 requests leaves: every question failed, the observation withheld and the mapping `no_answer`.
  const stopped: LocalCheckResult = {
    ...r,
    observed: r.observed.map((o) => ({ ...o, outcome: "unknown" as const, result: { ...o.result, observation: "withheld" } })),
    mappings: r.mappings.map((m) => ({ ...m, verdict: "no_answer" as const, governs: false })),
    findings: [],
  };
  assert.equal(coverageLine(stopped), "Of the 2 calls that could be asked: 0 read and answered, 2 without an answer.");
  assert.doesNotMatch(coverageLine(stopped), /^All/);
  assert.match(firstLine(report({ requirements: [stopped] })), /\*\* 2 without an answer, for the reasons under each requirement\./);
});

test("a budgeted call held before its question, a call that could not be asked, and the listing's notes are each said", () => {
  const r = localCheckResult();
  const held: LocalCheckResult = { ...r, wouldAsk: [...budgeted, at("src/auth.rs", "big()")], unreached: r.notes, counts: { ...r.counts, applicable: 3 } };
  assert.equal(
    coverageLine(held),
    "Of the 3 calls that could be asked: 2 read and answered, 1 held before their question. 1 more call could not be asked. 1 note under *Notes* says what was not read.",
  );
  // Every call answered, but one could not be asked: not "all".
  const cannot: LocalCheckResult = { ...whole(), counts: { ...whole().counts, notApplicable: 1 } };
  assert.equal(coverageLine(cannot), "Of the 2 calls that could be asked: 2 read and answered. 1 more call could not be asked.");
});

test("the siblings are counted in, and a run that sent nothing says what was inside the budgets", () => {
  const r = whole();
  // One sibling call budgeted and held before its question (its body did not fit), three over the siblings' budget.
  const siblings = { ...r.counts.byOrigin.changed, seeds: ["load"], applicable: 4, asked: 0, overBudget: 3, notApplicable: 0 };
  const withSiblings: LocalCheckResult = { ...r, wouldAsk: [...budgeted, at("src/other.rs", "load(x)")], counts: { ...r.counts, siblings } };
  assert.equal(coverageLine(withSiblings), "Of the 6 calls that could be asked: 2 read and answered, 1 held before their question, 3 over the budgets.");
  const built: LocalCheckResult = { ...r, observed: [], mappings: [], findings: [], counts: { ...r.counts, asked: 0, applicable: 5, overBudget: 3 } };
  assert.equal(coverageLine(built, { nothingSent: true }), "Of the 5 calls that could be asked: 2 inside the budgets, nothing asked, 3 over the budgets.");
  assert.doesNotMatch(coverageLine(built, { nothingSent: true }), /held before/);
  const nothing: LocalCheckResult = { ...r, observed: [], mappings: [], findings: [], wouldAsk: [], counts: { ...r.counts, asked: 0, applicable: 0, notApplicable: 2 } };
  assert.equal(coverageLine(nothing), "No call could be asked. 2 more calls could not be asked.");
});

test("the first line and the Action's check run title say the same numbers of what was left", () => {
  const r = whole();
  const cases: ReviewReport[] = [
    report({ requirements: [r] }),
    report(),
    report({ requirements: [{ ...r, observed: r.observed.map((o, i) => (i === 0 ? { ...o, result: { ...o.result, observation: "withheld" } } : o)) }] }),
  ];
  for (const rep of cases) {
    const parts = leftParts(rep);
    const title = conclude(rep, 0).title;
    const line = firstLine(rep);
    for (const p of parts) {
      assert.ok(title.includes(p), `${p} in ${title}`);
      assert.ok(line.includes(p), `${p} in ${line}`);
    }
    // And neither says more than was left.
    assert.equal(/not checked|without an answer|on what was not read/.test(title), parts.length > 0, title);
    assert.equal(/not checked|without an answer|on what was not read/.test(line), parts.length > 0, line);
  }
});

test("a note on what the listing did not read is left too: said in the section, the first line and the title, and the check run is not a success", () => {
  const cap = "src/auth.rs: 2 calls were left out of the listing by its cap";
  const r: LocalCheckResult = { ...whole(), notes: [cap], unreached: [cap] };
  assert.equal(coverageLine(r), "Of the 2 calls that could be asked: 2 read and answered. 1 note under *Notes* says what was not read.");
  const rep = report({ requirements: [{ ...r, observed: r.observed.map((o) => ({ ...o, outcome: "satisfies" as const })), findings: [] }] });
  assert.deepEqual(leftParts(rep), ["1 note on what was not read"]);
  assert.match(firstLine(rep), /\*\* 1 note on what was not read, for the reasons under each requirement\./);
  assert.deepEqual(conclude(rep, 0), { conclusion: "neutral", title: "2 calls read, none worth checking, 1 note on what was not read", checked: true });
  // The control: a note that only explains (a name that returns no Result) leaves nothing, and the same run is a success.
  const explained = report({ requirements: [{ ...whole(), notes: ["siblings: 1 names the changed code calls do not return a Result, or what they return is not settled here: x"], unreached: [], observed: r.observed.map((o) => ({ ...o, outcome: "satisfies" as const })), findings: [] }] });
  assert.equal(conclude(explained, 0).conclusion, "success");
  assert.equal(coverageLine(explained.requirements[0]!), "All 2 calls that could be asked were read and answered.");
});

test("a record from before `wouldAsk` and `unreached` reads as none held and none unread, and does not throw", () => {
  const { wouldAsk: _w, unreached: _u, ...old } = whole();
  assert.equal(coverageLine(old as LocalCheckResult), "All 2 calls that could be asked were read and answered.");
});
