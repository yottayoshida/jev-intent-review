# 0007. The run is the local check, and it states no requirement verdict

Status: Accepted

Replaces [0002](0002-verified-is-about-paths.md): what VERIFIED was a claim about no longer arises,
because the run no longer states VERIFIED, VIOLATION or UNKNOWN for a requirement. 0002's finding
stands as a record: over ten real pull requests the generic review verified nothing and could not
tell "looked hard" from "barely looked".

## Context

Since 0.1.0 the tool has had two runs. Without a flag: discovery over the whole repository, a
relevance and a satisfaction question about each place found, a completeness question, and a
verdict per requirement — VERIFIED, VIOLATION or UNKNOWN — deciding the exit code. With
`--experimental-local-check`: the functions the change touched and their callers one hop out, a
form's two questions about each call, a reading per call, and no requirement verdict. Only the
second was measured on cases it was not tuned on (#36), and only the second reads requirements as
forms (0006). Issue #35 asks that the two not be kept as two products.

## Decision

- **There is one run.** `jev-intent-review` with no flag does what `--experimental-local-check`
  did. The flag is still accepted: the report and the exit code are the same without it, and one
  line on stderr says so. `--experimental-candidates-only` is `--candidates-only`, with the old
  name accepted.
- **No requirement verdict.** The report states, per call, one of worth checking / holding / not
  settled / not required of, as 0006 defines them, and counts them. Nothing in the report or the
  JSON says whether a requirement holds.
- **The exit code does not read the findings unless asked to.** A listed call leaves the exit
  code at 0. `policy.fail_on` defaults to `[]`; a repository that sets it to `[finding]` gets exit
  1 when any call is worth checking. `violation`, the old value, is read as `finding` when a
  configuration file says it, and the notes say so. `policy.unknown`, `intent.pr_body_only:
  unknown`, `discovery.*`, `judgment.satisfaction_probability`, `judgment.relevance_probability`
  and `evidence.max_related_chars` no longer apply; they are accepted, and the notes say so, for
  one more minor version. Configuration, intent, repository and provider failures keep their codes
  (10, 11, 13, 12).
- **The report is one shape for every way a run ends** (`--json`, `version: 2`): `exitCode`,
  `skipReason` when skipped, `intent`, `sources`, `requirements` (the local check's results, at the
  top level as the local check printed them), `unexpectedChanges`, `sent` (`requests`, `bytes`,
  `answered` — the requests Jev answered, in the same unit as `requests` — the endpoint and host)
  and `metadata` (with every note the run has to make, the
  reading of the intent included). `verdict`, `discovery` and the per-requirement status,
  coverage and scope are gone, and so is the separate shape a stopped run printed; a run that stops
  for want of readable requirements (exit 11) prints the same shape with no requirements checked.
- **The budget stays at 20 calls a requirement and no context code is sent** (the conditions of
  the measurements in `bench/logs/`); how the budget is spent and sized is #38's.
- **The changes are still checked against the requirements** (the other direction, spec §21):
  one typed question per changed region, after the calls have been read, as before. It is asked
  of the same requirements the local check read. `--skip-change-check` leaves it out: the benches
  that measure the local check pass it, so what they record stays the local check's requests and
  nothing else, and a user who wants only the calls read can pass it too.
- **Retired with the generic run**: the relevance, satisfaction and completeness questions,
  repository-wide discovery (lexical and reference search), the wrapper hop, and the
  per-requirement aggregation. The two benches that drove the generic run (`bench/fixtures.ts`,
  `bench/probe-jev.ts`) move to `bench/generic/` with the questions they sent, outside the type
  check, next to the logs they produced; the benches that only search and index the repository
  stay where they are.
  `metadata.questionsHash` now covers what the run can send: the change question and the two
  forms' questions.
- **Rust only, as the local check is.** A change in another language reaches no function to read
  calls in, and the report says so; the change question still runs. The generic run had read any
  language.

## Alternatives considered

- Keep the generic run as the default and the local check behind the flag: the two product
  semantics #35 names, one of them never verified on unseen code.
- Keep the generic run for languages the local check does not read: the same two semantics,
  chosen by file extension.
- Exit 1 whenever a call is worth checking: measured on the constructed case of 0006, the check
  hidden in a helper and the check in the caller both produce confident readings that are not
  defects. A candidate is not a verdict, and the owner chose not to fail CI on one by default.
- No exit-code knob at all, leaving the decision to the GitHub Action (#41): a repository using
  the command line alone would have no gate.
- Keep `version: 1` and drop fields: a reader could not tell the two contracts apart.
- Read `violation` as `finding` in the default too: a repository with no configuration file would
  fail on a listed call, the opposite of the default chosen.
- A `summary` of the counts in the JSON: every number is already in `requirements[].counts`.
- A configuration key for the budget: it would drift from the recorded conditions of the
  measurements, and the budget is #38's.

## Consequences

- One pipeline, one report, one set of questions (0006's forms and the change question). AC1, AC5
  and AC6 of #35 hold on the default run.
- Every number in the report is a count of calls read; "no violation found" and VERIFIED are gone
  from the vocabulary, and 0.1's `--json` readers must move to `version: 2`.
- The next release is a breaking one (0.2.0); whether and when to release is not decided here.
- What the local check does not reach — languages other than Rust, calls past the caps, callees
  outside the repository — is now what the tool does not reach at all. Widening it is #37, #38 and
  #45.
- `docs/SPEC.md` still describes the broader design with requirement-level results; this ADR is
  where v0.x says it does not state them.
