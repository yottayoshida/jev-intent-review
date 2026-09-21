// Does the question's wording matter, or the code's? Four cells, plus the violations that any
// usable question still has to catch.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node bench/local-check-stated-condition.ts [runs] [log path]
//
// `local-check-propagation.ts` recorded a loop that propagates its read failure with `?` being
// answered `a_success_with_what_it_had` at 0.87-0.93. Two readings were left open there:
//
//   (a) the question is ambiguous — the loop has a second failure (a line that is not JSON, which
//       it skips) and the question says only "one item is an error";
//   (b) `let line = line?;` is not read as returning to the caller at all.
//
// This file crosses them. The question axis is `current` (imported unchanged) against `stated`,
// which names the operation and the value it yields, so only one failure fits. The code axis is
// `implicit` (`?`) against `explicit` (`match` + `return Err(...)`). Same criteria, same `MEANING`,
// same `verdictOf` on both sides of the question axis: only the `instructions` string differs.
//
// The two code versions are the same function. `bench/rust/propagation-equivalence.rs` runs both
// over eleven inputs — error first, last, in the middle, beside an unparsable line, absent — and
// asserts they return the same thing, with a version that really differs asserted to differ on all
// eight inputs that contain an error. Compile it with `rustc --test` before trusting anything here.
//
// **What each outcome would mean, written before the run:**
//
//   - `explicit` answers `an_error` under *both* questions and `implicit` answers
//     `a_success_with_what_it_had` under both → the code form decides and the wording does not.
//     That is (b), and the repair is not in the question: `?` has to be made visible in the
//     evidence, not asked about differently.
//   - `stated` answers `an_error` for `implicit` → that is (a): the question was ambiguous, and
//     naming the operation is the repair.
//   - `stated` answers `an_error` for the two violation versions as well → the stated wording is
//     biased towards "error" and is useless, whatever it did for the correct ones. This is the
//     reason those two versions are in the run and not assumed.
//   - Neither axis moves anything → stop rewording and read what is actually in the packet sent to
//     Jev; the difference is not where this file is looking.
//
// The predictions below are the author's, written before the first request, and the run exits
// non-zero if any of them is wrong. Being wrong is the informative case: it says which reading was
// right. They are not adjusted afterwards.
//
// ---------------------------------------------------------------------------
// **Result: the wording decides, not the code form. 24 runs, three per cell.**
//
//   | code                        | current question                              | stated condition          |
//   |-----------------------------|-----------------------------------------------|---------------------------|
//   | `?`                         | a success with what it had 0.87-0.88 — wrong  | an error 1.00 — right     |
//   | `match` + `return Err(...)` | a success with what it had 0.49-0.59, under the bar, UNKNOWN — wrong | an error 1.00 — right |
//   | skips the read failure      | a success 1.00, violation — right             | a success 0.93-0.94, violation — right |
//   | stops and returns a success | a success 1.00, violation — right             | a success 0.95-0.97, violation — right |
//
// **What that settles, and what it does not.** Reading (b) is refuted: `?` *is* read as returning
// to the caller, at 1.00, as soon as the condition is named. Reading (a) is **not** confirmed by
// it. What the 24 runs support is that stating this condition got the returned-value answer right
// for both code forms — not that the earlier wrong answers were about the parse failure
// specifically. Some other property of the added wording could do the same work, and nothing here
// separates those. That is left alone rather than chased: the useful claim is the narrow one.
//
// The prediction recorded in `because` was (b), and it was wrong. Writing the return out did not
// help; it made the answer *less* decided, dropping it under the bar. That prediction came from
// `fails-at-the-end` in `local-check-propagation.ts` reading as `an_error` at 0.69-0.78, which was
// put down to its explicitness — but that version also collects its failure and returns it from the
// tail of the function, a different shape, so the attribution was never supported by anything.
//
// The pre-written guard held: `stated` did not simply answer `an_error` to everything. Both real
// violations stayed violations, which is what makes the two correct cells mean something.
//
// The cost, recorded rather than smoothed over: under `stated` the control question answered
// `stops_there` 0.54-0.67 for `skips-unreadable-lines`, which continues. `verdictOf` reads only the
// result answer, so the verdict stayed right — but the control is what shows the code was read at
// all, and it got worse. `local-check-stated-generalisation.ts` measures how far that goes.
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
// The question axis. `stated` reuses `current`'s criteria verbatim — the answers, their meanings
// and the verdict rule are held fixed, so the only difference measured is the wording of the ask.
// The template lives in `local-check-plan.ts`; only the data below belongs to this case.
// ---------------------------------------------------------------------------

const CONDITION: Condition = {
  setup: "The file has been opened successfully.",
  iterator: "`reader.lines()`",
  yields: "`Err(io_error)`",
  others: "Every other operation the function reaches succeeds.",
  finite: "The iterator is finite.",
};

const STATED_QUESTIONS = statedQuestions(CONDITION);

const QUESTION_SETS = { current: QUESTIONS, stated: STATED_QUESTIONS } as const;
type SetName = keyof typeof QUESTION_SETS;

// ---------------------------------------------------------------------------
// The code axis.
// ---------------------------------------------------------------------------

const SHIPPED_AT = {
  repository: "yottayoshida/omamori",
  commit: "a651d3c5e4fd9a38997df059e5442841c54049ae",
  path: "src/audit/verify.rs",
  lines: "1723-1732 of `show_entries`",
  signature: "pub fn show_entries(config: &AuditConfig, opts: &ShowOptions, out: &mut impl Write) -> Result<(), AuditError>",
  derivation:
    "The loop is verbatim; the function around it is not. `wrap()` gives it a signature that returns the list, matching `local-check-propagation.ts` so the two files' numbers are comparable. Nothing here is a check of omamori#558 R1 on the code that shipped.",
  equivalence: "bench/rust/propagation-equivalence.rs — `implicit` and `explicit` return the same value on all eleven inputs; `skips-unreadable` differs on all eight that contain an error.",
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

type Expect = { control: string; result: keyof typeof MEANING; verdict: "violation" | "covered_holds" | "unknown" };

interface Case {
  id: string;
  what: string;
  code: string;
  /** Written before the first request. One per question set; the reason is in `because`. */
  expect: Record<SetName, Expect>;
  because: string;
}

const holds: Expect = { control: "stops_there", result: "an_error", verdict: "covered_holds" };
const breaksStopping: Expect = { control: "stops_there", result: "a_success_with_what_it_had", verdict: "violation" };
const breaksContinuing: Expect = { control: "keeps_going", result: "a_success_with_what_it_had", verdict: "violation" };

const CASES: Case[] = [
  {
    id: "implicit",
    what: "The read loop as shipped: `let line = line?;`.",
    code: wrap(LOOP("        let line = line?;")),
    expect: { current: breaksStopping, stated: breaksStopping },
    because:
      "current: reproduces the merged run (0.87-0.93). stated: predicted to stay wrong, because the one datum that moved the answer moved on the code axis — `fails-at-the-end` spells its error out and was read as `an_error` 0.69-0.78 with the parse-skip still in the loop.",
  },
  {
    id: "explicit",
    what: "The same function with the return written out: `match line { Ok(l) => l, Err(e) => return Err(AuditError::from(e)) }`.",
    code: wrap(
      LOOP(`        let line = match line {
            Ok(l) => l,
            Err(e) => return Err(AuditError::from(e)),
        };`),
    ),
    expect: { current: holds, stated: holds },
    because: "Predicted right under both questions, for the same reason: the code axis is where `fails-at-the-end` differed from the shipped loop.",
  },
  {
    id: "skips-unreadable-lines",
    what: "A real violation: the read failure becomes a skip, so an unreadable log comes back as a shorter, successful list.",
    code: wrap(LOOP("        let Ok(line) = line else { continue };")),
    expect: { current: breaksContinuing, stated: breaksContinuing },
    because: "In the run so far this was answered 1.00 under `current`. Here to catch a `stated` wording that answers `an_error` for everything.",
  },
  {
    id: "stops-but-succeeds",
    what: "A real violation that stops where the shipped loop stops: it returns what it had as a success.",
    code: wrap(LOOP("        let Ok(line) = line else { break };")),
    expect: { current: breaksStopping, stated: breaksStopping },
    because: "The pair `stops_there` + a success is a violation, not a contradiction to resolve. If `stated` calls this `an_error`, the wording has stopped reading the code.",
  },
];

// ---------------------------------------------------------------------------

const runs = Number(process.argv[2] ?? 3);
const out = process.argv[3] ?? "local-check-stated-condition.json";
const endpoint = endpointFromEnv();
if (!endpoint) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const provider = new JevProvider(new JevClient(endpoint));
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const log: unknown[] = [];
const tally: Record<string, { asExpected: number; total: number }> = {};
let wrong = 0;
console.log(`current ${hash(QUESTIONS)} · stated ${hash(STATED_QUESTIONS)} · bar ${BAR} · ${runs} run(s) per cell`);
console.log(`condition: ${STATED_QUESTIONS.on_error_result.instructions}\n`);

for (const set of Object.keys(QUESTION_SETS) as SetName[]) {
  for (const c of CASES) {
    const key = `${set}/${c.id}`;
    tally[key] = { asExpected: 0, total: 0 };
    for (let run = 1; run <= runs; run++) {
      const answers = (await provider.judge({ code: c.code }, QUESTION_SETS[set])) as Record<string, ChoiceAnswer | undefined>;
      const locals: Local[] = Object.keys(QUESTION_SETS[set]).map((q) => {
        const a = answers[q];
        const p = a ? probabilityOf(a, a.choice) : 0;
        return { question: q, choice: a?.choice ?? "none", probability: p, counted: p >= BAR };
      });
      const { verdict, why } = verdictOf(locals);
      const control = locals.find((l) => l.question === "on_error_control");
      const result = locals.find((l) => l.question === "on_error_result");
      const expect = c.expect[set];
      const asExpected = verdict === expect.verdict && control?.choice === expect.control && result?.choice === expect.result;
      tally[key].total += 1;
      if (asExpected) tally[key].asExpected += 1;
      else wrong += 1;
      console.log(
        `${asExpected ? "PASS" : "FAIL"} ${key.padEnd(31)} run ${run}: control ${control?.choice} ${control?.probability.toFixed(2)} · result ${result?.choice} ${result?.probability.toFixed(2)} · ${verdict}` +
          (asExpected ? "" : `  — predicted ${expect.control} / ${expect.result} / ${expect.verdict}`),
      );
      log.push({ questionSet: set, case: c.id, what: c.what, because: c.because, run, code: c.code, codeHash: hash(c.code), predicted: expect, locals, verdict, why, asExpected, raw: answers });
    }
  }
}

writeFileSync(
  out,
  JSON.stringify(
    {
      tool: { name: "jev-intent-review", version: VERSION, model: provider.model, currentHash: hash(QUESTIONS), statedHash: hash(STATED_QUESTIONS) },
      shippedAt: SHIPPED_AT,
      questionSets: QUESTION_SETS,
      condition: CONDITION,
      meaning: MEANING,
      bar: BAR,
      runs,
      log,
    },
    null,
    2,
  ),
);

console.log("\ncell                            as predicted");
for (const [key, t] of Object.entries(tally)) console.log(`  ${key.padEnd(31)} ${t.asExpected}/${t.total}`);
console.log(`\n${wrong === 0 ? `all ${Object.keys(tally).length * runs} runs as predicted` : `${wrong} of ${Object.keys(tally).length * runs} runs not as predicted`} · full answers in ${out}`);
process.exitCode = wrong === 0 ? 0 : 1;
