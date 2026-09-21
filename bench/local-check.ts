// The first check plan, end to end, over one function's in-function contract
// (docs/local-check-design.md, "最初の実装範囲").
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node bench/local-check.ts [runs] [log path]
//
// Jev answers what the code does under a fixed condition. Nothing here asks it whether the
// requirement holds: the mapping from an answer to a property, and from properties to a verdict,
// is the code below, and it is deterministic.
//
// What this covers is one clause of omamori#553 R1 — that a listing whose enumeration failed is
// not returned as a success — over one function. The rest of that requirement (what the callers
// then report) is **not** covered, and the verdict says so rather than standing in for it.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { JevClient, endpointFromEnv } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import { VERSION } from "../src/version.ts";
import type { ChoiceAnswer } from "../src/types.ts";
import { BAR, MEANING, QUESTIONS, verdictOf, type Local } from "./local-check-plan.ts";

// ---------------------------------------------------------------------------
// The plan. Written before anything ran; the answers below never change it.
// ---------------------------------------------------------------------------

const SOURCE = {
  requirement: "omamori#553 R1",
  quote:
    "The function should fail the whole listing on the first per-entry error when reading a directory, and not silently drop entries after the error and report the directory as empty or with a truncated count",
  covered: "Of that clause: a listing whose enumeration produced an error is not returned as a success.",
  notCovered: [
    "What the callers report for a listing that failed (\"empty\", a truncated count): a different function each time.",
    "Whether every caller that needs the whole set refuses it.",
    "Whether stopping *at the first* error is required. The quote says `on the first per-entry error`; this plan reads only what is returned, so an implementation that reads to the end and then fails is neither cleared nor faulted here.",
  ],
};

/** Where the shipped function is, so a later run can tell what these cases were derived from. */
const SHIPPED_AT = { repository: "yottayoshida/omamori", commit: "916d954607f1f22a4326feb59c76c2197f540bc9", path: "src/util.rs", lines: "317-328" };

// ---------------------------------------------------------------------------
// The cases. Each is the shipped function with one edit, and each edit's intended
// difference is written here — before running — so a run cannot be read backwards.
// ---------------------------------------------------------------------------

const SHIPPED = `pub(crate) fn collect_listing(
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

interface Case {
  id: string;
  what: string; // the intended difference, read from the edit; not compiled
  code: string;
  expect: { control: keyof typeof QUESTIONS.on_error_control.criteria; result: keyof typeof MEANING; verdict: "violation" | "covered_holds" | "unknown" };
}

const CASES: Case[] = [
  {
    id: "shipped",
    what: "As shipped: the first error returns, carrying what was seen inside the failure.",
    code: SHIPPED,
    expect: { control: "stops_there", result: "an_error", verdict: "covered_holds" },
  },
  {
    id: "ignores-the-error",
    what: "The error arm continues, so the listing comes back short and successful.",
    code: SHIPPED.replace("Err(err) => return Err(ListingStopped { seen, err }),", "Err(_) => continue,"),
    expect: { control: "keeps_going", result: "a_success_with_what_it_had", verdict: "violation" },
  },
  {
    id: "stops-but-succeeds",
    what: "Stops at the error, as the shipped one does, and returns what it had as a success.",
    code: SHIPPED.replace("Err(err) => return Err(ListingStopped { seen, err }),", "Err(_) => return Ok(seen),"),
    expect: { control: "stops_there", result: "a_success_with_what_it_had", verdict: "violation" },
  },
  {
    id: "fails-at-the-end",
    what: "Reads to the end and fails afterwards. It never returns the failed listing as a success, so the property this plan covers holds; whether the requirement also demands stopping at the *first* error is outside this plan, and left in notCovered rather than decided here.",
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
    expect: { control: "keeps_going", result: "an_error", verdict: "covered_holds" },
  },
  {
    id: "extra-logging",
    what: "The shipped behaviour with a line of logging added: a change that is not a change in what is returned.",
    code: SHIPPED.replace(
      "Err(err) => return Err(ListingStopped { seen, err }),",
      'Err(err) => {\n                eprintln!("listing stopped after {} entries", seen.len());\n                return Err(ListingStopped { seen, err });\n            }',
    ),
    expect: { control: "stops_there", result: "an_error", verdict: "covered_holds" },
  },
  {
    id: "no-body",
    what: "The evidence a run would have if the body did not fit: the signature and nothing else.",
    code: `pub(crate) fn collect_listing(
    entries: impl Iterator<Item = std::io::Result<OsString>>,
) -> Result<Vec<OsString>, ListingStopped> {
    // (body not shown)
}`,
    expect: { control: "cannot_determine", result: "cannot_determine", verdict: "unknown" },
  },
];

// ---------------------------------------------------------------------------

const runs = Number(process.argv[2] ?? 3);
const out = process.argv[3] ?? "local-check.json";
const endpoint = endpointFromEnv();
if (!endpoint) throw new Error("no credentials: set JEV_PROVIDER (cloudflare, typesafe or vercel) with its key, the Cloudflare pair, or JEV_API_URL and JEV_API_TOKEN");
const provider = new JevProvider(new JevClient(endpoint));
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const log: unknown[] = [];
let wrong = 0;
console.log(`plan ${hash({ SOURCE, QUESTIONS, MEANING })} · questions ${hash(QUESTIONS)} · bar ${BAR} · ${runs} run(s) each`);
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
      `${asExpected ? "PASS" : "FAIL"} ${c.id.padEnd(20)} run ${run}: control ${control?.choice} ${control?.probability.toFixed(2)} · result ${result?.choice} ${result?.probability.toFixed(2)} · ${verdict}` +
        (asExpected ? "" : `  — expected ${c.expect.control} / ${c.expect.result} / ${c.expect.verdict}`),
    );
    log.push({ case: c.id, what: c.what, run, code: c.code, codeHash: hash(c.code), expected: c.expect, locals, verdict, why, asExpected, raw: answers });
  }
}
writeFileSync(
  out,
  JSON.stringify(
    {
      tool: { name: "jev-intent-review", version: VERSION, model: provider.model, questionsHash: hash(QUESTIONS), planHash: hash({ SOURCE, QUESTIONS, MEANING }) },
      shippedAt: SHIPPED_AT,
      plan: { SOURCE, QUESTIONS, MEANING, BAR },
      runs,
      log,
    },
    null,
    2,
  ),
);
console.log(`\n${wrong === 0 ? `all ${CASES.length * runs} runs as expected` : `${wrong} of ${CASES.length * runs} runs not as expected`} · full answers in ${out}`);
console.log(`not covered by this plan: ${SOURCE.notCovered.join(" / ")}`);
process.exitCode = wrong === 0 ? 0 : 1;
