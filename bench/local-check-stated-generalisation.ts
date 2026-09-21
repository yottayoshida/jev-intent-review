// Does the stated template travel? Two things the wording was not written against.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node bench/local-check-stated-generalisation.ts [runs] [log path]
//
// `local-check-stated-condition.ts` found the wording, not the code form, to be what went wrong:
// naming the operation and the value it yields took both `?` and `match` + `return Err(...)` from
// wrong to `an_error` at 1.00, with both real violations still caught. That was measured on the one
// loop the wording was written for, which is the position `local-check-propagation.ts` was in
// before it failed to carry over. So it gets pointed at two things it was not written against.
// **Neither is a fresh real requirement** — one varies the condition data, the other the spelling
// of the propagation, and the result block below keeps that distinction:
//
//   - **`collect_listing`** — the function experiment one was built on, so not an unused case. What
//     is new is that the template is filled with *different data*: the iterator is the function's
//     own argument rather than `reader.lines()`, the types differ, and the loop has no second kind
//     of failure. That the template takes it at all is the generalisation being claimed here, and
//     no more than that.
//   - **`map-err`** — a third way of spelling the propagation, taken verbatim from `verify_chain`
//     (omamori `a651d3c5`, `src/audit/verify.rs:1051-1054`): `line.map_err(|e| ...)?`. Neither of
//     the two forms already measured. Only that line is real: it sits in the same simplified
//     wrapper as the other read-loop cases, so this is a new spelling and not a new function. Its
//     violation is the adversarial one — the same `map_err`, with the error it just built thrown
//     away by an `else { continue }`.
//
// Both question sets run, so the comparison is same-session rather than against numbers from
// another day. `current` on the four `collect_listing` versions is a repeat of the 18/18 in
// `local-check.ts` and is here to confirm that, not to discover it.
//
// **Predictions are the correct reading of each version's code**, written before the first request;
// PASS therefore means the plan read the code correctly, and the run exits non-zero if any cell did
// not. One failure is expected and is not news: under `stated`, the control question already
// answered `stops_there` 0.54-0.67 for a version that continues (`skips-unreadable-lines` in the
// 2x2). If the `keeps_going` versions below miss their control the same way, that is the same
// defect showing up again, and it belongs in the record as a cost of the stated wording — the
// verdict does not depend on the control answer, but the control is what shows the code was read.
//
// The size of the evidence is held constant on purpose. `verify_chain` itself is 762 lines
// (42 KB); only its read-failure line is taken, into the same wrapper as the other cases, so the
// axis being measured stays the wording and the code form rather than how much was sent.
//
// ---------------------------------------------------------------------------
// **Result: 36 runs — `current` 15/18, `stated` 18/18.**
//
//   - `collect_listing`, whose loop has one kind of failure: `current` reads all four versions
//     correctly, 12/12, which is the 18/18 in `local-check.ts` holding up in a second session.
//     `stated`, with its own condition data, also 12/12.
//   - `map-err/propagates`, a third spelling of the propagation in a loop that *does* have a second
//     kind of failure: `current` answers `a_success_with_what_it_had` 0.79-0.88 — wrong, 0/3, the
//     same failure as `?` and `match` + `return Err(...)`. `stated` answers `an_error` 0.99-1.00,
//     3/3.
//   - `map-err/discards`, where the error is built and thrown away: caught by both, 3/3 each.
//
// **What that is, stated narrowly.** Neither case is a fresh real requirement. `collect_listing`
// is the function experiment one was built on; what is new about it here is the template and a
// second set of condition data. `map-err` is not a whole shipped function either — it is the same
// simplified wrapper with one line taken verbatim from `verify_chain`, so what is new there is the
// spelling of the propagation. Both are worth measuring and neither is "it held on two unused real
// requirements". And the condition data is part of the question: `collect_listing`'s was rewritten
// after seeing an answer (above), so the 12/12 for it is a confirmation of the rewritten condition,
// not an untouched first measurement. The template was fixed throughout; the data was not.
//
// Taken with the 2x2 — 60 runs, against what each version's code actually does, recounted from the
// saved logs:
//
//   | metric                                | current | stated |
//   |---------------------------------------|---------|--------|
//   | verdict matches the code              | 21/30   | 30/30  |
//   | result answer matches                 | 21/30   | 30/30  |
//   | result answer matches and clears 0.6  | 21/30   | 30/30  |
//   | control answer matches                | 30/30   | 27/30  |
//   | control answer matches and clears 0.6 | 30/30   | 25/30  |
//   | correct code called correct           | 6/15    | 15/15  |
//   | real violation caught                 | 15/15   | 15/15  |
//
// The last two rows of the control are two different numbers and are kept apart on purpose: two
// `map-err/discards` runs chose `keeps_going`, which is right, at 0.51, which does not clear the
// bar. `verdictOf` reads only the result answer, so neither number moves a verdict today — it
// would, the moment the control is given any weight.
//
// Every one of `current`'s nine misses is a loop with two kinds of failure in it, and all three
// spellings of the propagation miss there. Where there is one kind, `current` is perfect. So the
// ambiguity was never in the wording alone — it is the wording against that shape of loop.
//
// `stated`'s three misses are all the control question on a version that continues, and all of
// them keep the right result and the right verdict. Naming the condition buys the answer that
// decides and costs the answer that shows the code was read; the cost is invisible in every
// verdict, which is exactly why it is written here.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { JevClient, endpointFromEnv } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import { VERSION } from "../src/version.ts";
import type { ChoiceAnswer } from "../src/types.ts";
import { BAR, MEANING, QUESTIONS, statedQuestions, verdictOf, type Condition, type Local } from "./local-check-plan.ts";

// ---------------------------------------------------------------------------
// Case A: `collect_listing`, verbatim and whole, signature included.
// ---------------------------------------------------------------------------

const LISTING_AT = { repository: "yottayoshida/omamori", commit: "916d954607f1f22a4326feb59c76c2197f540bc9", path: "src/util.rs", lines: "317-328", derivation: "The whole function, verbatim." };

/**
 * `setup` was first written as "The function has been entered and `seen` is empty." All three runs
 * of `listing/stops-but-succeeds` answered `a_success_with_nothing` (0.67-0.75) under it, where the
 * label written down was `a_success_with_what_it_had`.
 *
 * That answer is **not wrong**, and calling it a false premise — as this comment first did — was
 * itself wrong. The condition never says *where* in the iteration the error falls, and
 * `Err(_) => return Ok(seen)` returns `Ok([])` when it falls first and `Ok(["before"])` when it
 * falls second (checked with `rustc`). Both are reachable under the condition as stated, and the
 * two answers overlap besides: a success carrying what it managed to take includes the case where
 * it managed to take nothing. What was defective was the condition's silence about *when*, and an
 * answer set whose options are not disjoint — not the truth of the premise.
 *
 * The verdict was `violation` in all three of those runs, which is what the code does. Nothing the
 * plan decides moved. What the re-run improved is agreement with the expected label.
 *
 * The condition was rewritten anyway and **every** `stated` cell re-run rather than the one that
 * moved, with both logs kept (`bench/logs/stated-generalisation-v1.json` and `-v2.json`, checked
 * in so this sentence stays true). That re-run is a confirmation of the
 * rewritten condition, not an independent measurement: the condition data is part of the question,
 * and this part of it was adjusted after seeing an answer. The template above it was not.
 *
 * `setup` now says only what is true when the loop is reached, and nothing about values the loop
 * changes. Pinning the error's position is left undone on purpose — it would change what the
 * question asks, and this file is not the place to find that out.
 */
const LISTING_CONDITION: Condition = {
  setup: "The function has just been entered.",
  iterator: "`entries`",
  yields: "`Err(io_error)`",
  others: "Every other operation the function reaches succeeds.",
  finite: "The iterator is finite.",
};

const LISTING = `pub(crate) fn collect_listing(
    entries: impl Iterator<Item = std::io::Result<OsString>>,
) -> Result<Vec<OsString>, ListingStopped> {
    let mut seen = Vec::new();
    for entry in entries {
        match entry {
            Ok(name) => seen.push(name),
            Err(err) => return Err(ListingStopped { seen, err }),
        }
    }
    Ok(seen)
}`;

// ---------------------------------------------------------------------------
// Case B: the third propagation form, in the same wrapper as the earlier read-loop cases.
// ---------------------------------------------------------------------------

const MAP_ERR_AT = {
  repository: "yottayoshida/omamori",
  commit: "a651d3c5e4fd9a38997df059e5442841c54049ae",
  path: "src/audit/verify.rs",
  lines: "1051-1054 of `verify_chain`",
  derivation:
    "The read-failure line is verbatim; the loop and function around it are the same wrapper the other read-loop cases use, so the evidence stays the same size. `verify_chain` itself is 762 lines and does not fit in one packet.",
};

const READER_CONDITION: Condition = {
  setup: "The file has been opened successfully.",
  iterator: "`reader.lines()`",
  yields: "`Err(io_error)`",
  others: "Every other operation the function reaches succeeds.",
  finite: "The iterator is finite.",
};

const LOOP = (readFailure: string) => `    for line in reader.lines() {
${readFailure}
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event: AuditEvent = match serde_json::from_str(trimmed) {
            Ok(e) => e,
            Err(_) => continue,
        };
        entries.push_back(event);
    }
    Ok(entries)`;

/** Not the shipped signature: it returns the list, so only the body differs between cases. */
const wrap = (body: string) => `pub fn show_entries(
    path: &Path,
    opts: &ShowOptions,
) -> Result<VecDeque<AuditEvent>, AuditError> {
    let file = std::fs::File::open(path)?;
    let reader = std::io::BufReader::new(&file);
    let mut entries: VecDeque<AuditEvent> = VecDeque::new();
${body}
}`;

const MAP_ERR = `        let line = line.map_err(|e| AuditError::StoreInaccessible {
            kind: "log_read",
            reason: e.to_string(),
        })?;`;

const MAP_ERR_DISCARDED = `        let Ok(line) = line.map_err(|e| AuditError::StoreInaccessible {
            kind: "log_read",
            reason: e.to_string(),
        }) else {
            continue;
        };`;

// ---------------------------------------------------------------------------

type Expect = { control: string; result: keyof typeof MEANING; verdict: "violation" | "covered_holds" | "unknown" };

const holds: Expect = { control: "stops_there", result: "an_error", verdict: "covered_holds" };
const holdsLate: Expect = { control: "keeps_going", result: "an_error", verdict: "covered_holds" };
const breaksStopping: Expect = { control: "stops_there", result: "a_success_with_what_it_had", verdict: "violation" };
const breaksContinuing: Expect = { control: "keeps_going", result: "a_success_with_what_it_had", verdict: "violation" };

interface Case {
  id: string;
  what: string;
  code: string;
  condition: Condition;
  /** The correct reading of this version's code, written before the first request. */
  expect: Expect;
}

const CASES: Case[] = [
  {
    id: "listing/shipped",
    what: "`collect_listing` as shipped: the first error returns, carrying what was seen inside the failure.",
    code: LISTING,
    condition: LISTING_CONDITION,
    expect: holds,
  },
  {
    id: "listing/ignores-the-error",
    what: "The error arm continues, so the listing comes back short and successful.",
    code: LISTING.replace("Err(err) => return Err(ListingStopped { seen, err }),", "Err(_) => continue,"),
    condition: LISTING_CONDITION,
    expect: breaksContinuing,
  },
  {
    id: "listing/stops-but-succeeds",
    what: "Stops at the error, as the shipped one does, and returns what it had as a success.",
    code: LISTING.replace("Err(err) => return Err(ListingStopped { seen, err }),", "Err(_) => return Ok(seen),"),
    condition: LISTING_CONDITION,
    expect: breaksStopping,
  },
  {
    id: "listing/fails-at-the-end",
    what: "Reads to the end and fails afterwards: never a successful listing of an enumeration that failed, so the covered property holds.",
    code: `pub(crate) fn collect_listing(
    entries: impl Iterator<Item = std::io::Result<OsString>>,
) -> Result<Vec<OsString>, ListingStopped> {
    let mut seen = Vec::new();
    let mut failure = None;
    for entry in entries {
        match entry {
            Ok(name) => seen.push(name),
            Err(err) => {
                if failure.is_none() {
                    failure = Some(err);
                }
            }
        }
    }
    match failure {
        Some(err) => Err(ListingStopped { seen, err }),
        None => Ok(seen),
    }
}`,
    condition: LISTING_CONDITION,
    expect: holdsLate,
  },
  {
    id: "map-err/propagates",
    what: "The third spelling, verbatim from `verify_chain`: `line.map_err(|e| ...)?` turns the read failure into the crate's error and hands it back.",
    code: wrap(LOOP(MAP_ERR)),
    condition: READER_CONDITION,
    expect: holds,
  },
  {
    id: "map-err/discards",
    what: "The adversarial violation: the same `map_err` builds the error and `else { continue }` throws it away, so an unreadable log comes back as a shorter, successful list.",
    code: wrap(LOOP(MAP_ERR_DISCARDED)),
    condition: READER_CONDITION,
    expect: breaksContinuing,
  },
];

// ---------------------------------------------------------------------------

const runs = Number(process.argv[2] ?? 3);
const out = process.argv[3] ?? "local-check-stated-generalisation.json";
const endpoint = endpointFromEnv();
if (!endpoint) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const provider = new JevProvider(new JevClient(endpoint));
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const log: unknown[] = [];
/**
 * `controlRight` counts the control answer matching the code; `controlCounted` also requires it to
 * clear the bar. Two different numbers — a 0.51 that happens to name the right behaviour is not a
 * read the plan would be entitled to use — and `verdictOf` looks at neither, so they are only
 * visible if printed.
 */
const tally: Record<string, { asExpected: number; controlRight: number; controlCounted: number; total: number }> = {};
let wrong = 0;
console.log(`current ${hash(QUESTIONS)} · bar ${BAR} · ${runs} run(s) per cell`);
console.log(`listing condition: ${statedQuestions(LISTING_CONDITION).on_error_result.instructions}\n`);

for (const set of ["current", "stated"] as const) {
  for (const c of CASES) {
    const questions = set === "current" ? QUESTIONS : statedQuestions(c.condition);
    const key = `${set}/${c.id}`;
    tally[key] = { asExpected: 0, controlRight: 0, controlCounted: 0, total: 0 };
    for (let run = 1; run <= runs; run++) {
      const answers = (await provider.judge({ code: c.code }, questions)) as Record<string, ChoiceAnswer | undefined>;
      const locals: Local[] = Object.keys(questions).map((q) => {
        const a = answers[q];
        const p = a ? probabilityOf(a, a.choice) : 0;
        return { question: q, choice: a?.choice ?? "none", probability: p, counted: p >= BAR };
      });
      const { verdict, why } = verdictOf(locals);
      const control = locals.find((l) => l.question === "on_error_control");
      const result = locals.find((l) => l.question === "on_error_result");
      const asExpected = verdict === c.expect.verdict && control?.choice === c.expect.control && result?.choice === c.expect.result;
      tally[key].total += 1;
      if (asExpected) tally[key].asExpected += 1;
      else wrong += 1;
      if (control?.choice === c.expect.control) {
        tally[key].controlRight += 1;
        if (control.counted) tally[key].controlCounted += 1;
      }
      console.log(
        `${asExpected ? "PASS" : "FAIL"} ${key.padEnd(33)} run ${run}: control ${control?.choice} ${control?.probability.toFixed(2)} · result ${result?.choice} ${result?.probability.toFixed(2)} · ${verdict}` +
          (asExpected ? "" : `  — code does ${c.expect.control} / ${c.expect.result} / ${c.expect.verdict}`),
      );
      log.push({ questionSet: set, case: c.id, what: c.what, condition: set === "stated" ? c.condition : null, run, code: c.code, codeHash: hash(c.code), correctReading: c.expect, locals, verdict, why, asExpected, raw: answers });
    }
  }
}

writeFileSync(
  out,
  JSON.stringify(
    { tool: { name: "jev-intent-review", version: VERSION, model: provider.model, currentHash: hash(QUESTIONS) }, sources: { listing: LISTING_AT, mapErr: MAP_ERR_AT }, conditions: { listing: LISTING_CONDITION, reader: READER_CONDITION }, meaning: MEANING, bar: BAR, runs, log },
    null,
    2,
  ),
);

console.log("\ncell                              as the code reads   control right   control right and over the bar");
for (const [key, t] of Object.entries(tally))
  console.log(`  ${key.padEnd(33)} ${t.asExpected}/${t.total}                 ${t.controlRight}/${t.total}             ${t.controlCounted}/${t.total}`);
console.log(`\n${wrong === 0 ? `all ${Object.keys(tally).length * runs} runs read correctly` : `${wrong} of ${Object.keys(tally).length * runs} runs not read correctly`} · full answers in ${out}`);
process.exitCode = wrong === 0 ? 0 : 1;
