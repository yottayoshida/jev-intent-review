// The same plan, on a second pull request.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node bench/local-check-propagation.ts [runs] [log path]
//
// `QUESTIONS`, `MEANING`, `BAR` and the aggregation are imported from `local-check-plan.ts`
// unchanged — a set that had to reword a question would be a different plan, and whether the same
// one travels is the whole point of this file.
//
// The function here is `show_entries` (omamori#558's head), which walks the lines of the audit log
// and propagates a read failure with `?`. Different pull request, different file, same shape: an
// iterator whose items are each a value or an error.
//
// What this covers is narrow, and narrower than the requirement it is drawn from: that a read
// failure partway through the log does not leave the function as a successful list of the entries
// it had. What `show_entries` then prints, and every other path into the log, are not read here.
//
// **It does not carry over: 6 of 18 runs, and the six are the shipped code.** Jev answers
// `a_success_with_what_it_had` (0.87-0.93) about a function that propagates its read failure with
// `?`, because this function handles *two* failures in the same loop — the line it could not read,
// which it propagates, and the line it could not parse, which it skips — and the question says
// only "one item is an error". `collect_listing` had one kind and the question was unambiguous
// there. The expectations below are left as they were written, and the run exits non-zero: the
// plan travelling is what was being measured, and it did not.
//
// It fails towards calling correct code a violation, which is the direction that wastes a
// reviewer's time rather than the one that hides a defect — but a plan that does that is not
// ready to be pointed at anything. Rewording the question until this passes would be fitting the
// question to the answer; a revised plan has to name which failure it asks about, and be measured
// on both functions with its expectations written down first.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { CloudflareClient, endpointFromEnv } from "../src/judgments/cloudflare.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import { VERSION } from "../src/version.ts";
import type { ChoiceAnswer } from "../src/types.ts";
import { BAR, MEANING, QUESTIONS, verdictOf, type Local } from "./local-check-plan.ts";

const SOURCE = {
  requirement: "omamori#558 R1",
  quote: "The software should not drop checks that need no key, including tail-truncation detection, when a halt occurs.",
  covered: "Not that clause, but the contract this function keeps while reading the log for it: a line that cannot be read does not leave the function as a successful list of the lines before it.",
  notCovered: [
    "The clause itself: which checks keep running past a halt, and whether tail truncation is among them. That is the loop in `verify`, not this one.",
    "What `show_entries` prints for the entries it did read.",
    "Every other path that reads the same log.",
  ],
};

const SHIPPED_AT = { repository: "yottayoshida/omamori", commit: "a651d3c5e4fd9a38997df059e5442841c54049ae", path: "src/audit/verify.rs", lines: "1723-1732 of `show_entries`" };

/** The loop as shipped, cut to the part the questions are about. */
const SHIPPED = `    for line in reader.lines() {
        let line = line?;
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

const wrap = (body: string) => `pub fn show_entries(
    path: &Path,
    opts: &ShowOptions,
) -> Result<VecDeque<AuditEvent>, AuditError> {
    let file = std::fs::File::open(path)?;
    let reader = std::io::BufReader::new(&file);
    let mut entries: VecDeque<AuditEvent> = VecDeque::new();
${body}
}`;

interface Case {
  id: string;
  what: string;
  code: string;
  expect: { control: string; result: keyof typeof MEANING; verdict: "violation" | "covered_holds" | "unknown" };
}

const CASES: Case[] = [
  {
    id: "shipped",
    what: "As shipped: `let line = line?;` hands the read failure back to the caller at once.",
    code: wrap(SHIPPED),
    expect: { control: "stops_there", result: "an_error", verdict: "covered_holds" },
  },
  {
    id: "skips-unreadable-lines",
    what: "The `?` becomes a skip, so a log that stopped being readable comes back as a shorter, successful list.",
    code: wrap(SHIPPED.replace("        let line = line?;", "        let Ok(line) = line else { continue };")),
    expect: { control: "keeps_going", result: "a_success_with_what_it_had", verdict: "violation" },
  },
  {
    id: "stops-but-succeeds",
    what: "Stops at the unreadable line, as the shipped one does, and returns what it had as a success.",
    code: wrap(SHIPPED.replace("        let line = line?;", "        let Ok(line) = line else { break };")),
    expect: { control: "stops_there", result: "a_success_with_what_it_had", verdict: "violation" },
  },
  {
    id: "fails-at-the-end",
    what: "Reads to the end and fails afterwards: never a successful list of a log it could not read, so the covered property holds. Whether the requirement wants the earlier stop is not read here.",
    code: wrap(`    let mut failure = None;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                failure.get_or_insert(e);
                continue;
            }
        };
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
    match failure {
        Some(e) => Err(AuditError::Io(e)),
        None => Ok(entries),
    }`),
    expect: { control: "keeps_going", result: "an_error", verdict: "covered_holds" },
  },
  {
    id: "skips-unparsable-lines",
    what: "Untouched behaviour that looks like the violation: a line that is not JSON is skipped, as shipped. Only a line that could not be *read* is the error the questions ask about.",
    code: wrap(SHIPPED.replace('            Err(_) => continue,', '            Err(_) => {\n                continue;\n            }')),
    expect: { control: "stops_there", result: "an_error", verdict: "covered_holds" },
  },
  {
    id: "no-body",
    what: "The evidence a run would have if the body did not fit.",
    code: `pub fn show_entries(
    path: &Path,
    opts: &ShowOptions,
) -> Result<VecDeque<AuditEvent>, AuditError> {
    // (body not shown)
}`,
    expect: { control: "cannot_determine", result: "cannot_determine", verdict: "unknown" },
  },
];

const runs = Number(process.argv[2] ?? 3);
const out = process.argv[3] ?? "local-check-propagation.json";
const endpoint = endpointFromEnv();
if (!endpoint) throw new Error("no credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
const provider = new JevProvider(new CloudflareClient(endpoint));
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const log: unknown[] = [];
let wrong = 0;
console.log(`questions ${hash(QUESTIONS)} (unchanged from the listing plan) · bar ${BAR} · ${runs} run(s) each`);
console.log(`covered: ${SOURCE.covered}`);
for (const c of CASES) {
  for (let run = 1; run <= runs; run++) {
    const answers = (await provider.judge({ code: c.code }, QUESTIONS)) as Record<string, ChoiceAnswer | undefined>;
    const locals: Local[] = Object.keys(QUESTIONS).map((q) => {
      const a = answers[q];
      const p = a ? probabilityOf(a, a.choice) : 0;
      return { question: q, choice: a?.choice ?? "none", probability: p, counted: p >= BAR };
    });
    const { verdict, why } = verdictOf(locals);
    const control = locals.find((l) => l.question === "on_error_control");
    const result = locals.find((l) => l.question === "on_error_result");
    const asExpected = verdict === c.expect.verdict && control?.choice === c.expect.control && result?.choice === c.expect.result;
    if (!asExpected) wrong += 1;
    console.log(
      `${asExpected ? "PASS" : "FAIL"} ${c.id.padEnd(22)} run ${run}: control ${control?.choice} ${control?.probability.toFixed(2)} · result ${result?.choice} ${result?.probability.toFixed(2)} · ${verdict}` +
        (asExpected ? "" : `  — expected ${c.expect.control} / ${c.expect.result} / ${c.expect.verdict}`),
    );
    log.push({ case: c.id, what: c.what, run, code: c.code, codeHash: hash(c.code), expected: c.expect, locals, verdict, why, asExpected, raw: answers });
  }
}
writeFileSync(
  out,
  JSON.stringify({ tool: { name: "jev-intent-review", version: VERSION, model: provider.model, questionsHash: hash(QUESTIONS) }, shippedAt: SHIPPED_AT, plan: { SOURCE, QUESTIONS, MEANING, BAR }, runs, log }, null, 2),
);
console.log(`\n${wrong === 0 ? `all ${CASES.length * runs} runs as expected` : `${wrong} of ${CASES.length * runs} runs not as expected`} · full answers in ${out}`);
console.log(`not covered by this plan: ${SOURCE.notCovered.join(" / ")}`);
process.exitCode = wrong === 0 ? 0 : 1;
