# 0023. `failure_handling`: a failure may be returned, logged or recorded, and must not be turned silently into a success

Status: Accepted

## Context

`failure_propagation` (ADR 0006) asks one thing of a call: under its failure, does the function return
an error or a success. That is the requirement only when the failure has to reach the caller. Many
fixes do something else with a failure: they log it, warn, record it, and go on — and the defect they
fix is going on with no trace at all (#85). Written as `failure_propagation`, such a requirement lists
the fixed code, which returns a success after logging, as worth checking. And the form asks only in a
function that returns a `Result` (`target_not_result`), while code that logs and goes on is mostly in
functions that return `()`.

Of the 91 rows of the evaluation pool that carry a label (`bench/eval/PROTOCOL.md`, *Labels*), 38 are
labelled `swallows_as_success` — how the code before the fix handled its failure — and the orchestrator
judged 22 of them not writable as `failure_propagation` when it chose cases (`verdicts.a`).

## Decision

A third form, as data (ADR 0006), with the rule unchanged (`review/outcome.ts`):

- **Observation**, under `failure_propagation`'s assumption word for word (an event: this call returns
  an error; every other operation succeeds, ADR 0020), key `on_error_handling`: what does the function
  do with that failure — `propagates` (returns it), `reports_locally` (does not return it, but writes it
  to a log, a warning or standard error, records it, or returns a value the caller can tell from a
  success), `continues_silently` (leaves no trace: goes on or returns a success as if the call had
  succeeded; an empty, absent or default value the caller cannot tell from a success, with nothing
  logged or recorded, is this), `cannot_determine`. `violates: [continues_silently]`, `keeps:
  [propagates, reports_locally]`. A log line wins over an empty value: the failure is reported.
- **Mapping**: does the requirement require that this call's failure not be turned silently into a
  success.
- **Askable** when the callee returns a `Result` (`calleeOf`), whatever the calling function returns.
- **What decides the reading** (ADR 0019): as `failure_propagation` — a failure passed to this
  repository's own function before it is returned is that function's to handle, and the call is held.
- **Offered to no sentence.** The question that asks Jev which form a sentence says (ADR 0008) is built
  from the forms with `chosenBySentence`, and this one has it false: the measured question and its hash
  do not change, and an answer naming this form reads as the default. It is used when a spec names it.

The observation question was measured before it was wired, on the same packets the run builds
(`bench/handling/probe.json`, fixed first; `bench/logs/handling-probe-v1.json`): four places of two
acceptance cases, each in its shipped and rewritten versions and in versions that drop the failure,
drop it after logging something unrelated (decoy), log it and go on (reported), or — moltis#1064's
`generate_title` as its defect version has it — log it and record a metric before returning an empty
title. 17 versions × 3 runs: 51 of 51 answers as expected at the bar (the lowest 0.87), and no shipped
or rewritten version answered `continues_silently`.

## Alternatives considered

- **Widen `failure_propagation`'s answers.** Its measured questions and every result recorded under
  them would change meaning; a requirement that does want the failure returned would stop listing a
  function that logs and returns `Ok`.
- **Offer the form to sentences now.** The form question's 72-sentence measurement would have to be
  taken again, and this form's precision on real pull requests is not measured yet. Next.
- **Send the body of the function a failure is passed to** (`send: [wrapper]`): whether it logs is
  exactly what this form turns on, but none of the probe's places passes a failure that way, so it is
  not measured. Held, as for `failure_propagation`.
- **Count an empty value as a trace.** Then `Ok(None)` after a failure would keep the requirement, which
  is the swallowing the issue is about.

## Consequences

- `--json`'s `form` can be `failure_handling`; the report names it and its words. `metadata.questionsHash`
  moves (`FORMS_FINGERPRINT` holds every form's questions), but no kept answer (ADR 0013) is asked again:
  its key is the request, and the other two forms' requests do not change a byte.
- What is not claimed: how the question is answered in a function that returns `()` — all four functions
  of the probe return a `Result`, and the form asks in one that does not; that more of the tool's reach is covered on real pull requests, its precision
  there, or its stability over runs beyond the probe's three — those are measured on #80's sets. How
  many of the 91 rows' requirements the new sentence can write is recorded in `bench/eval/forms-85/`.
- A sibling of the change (ADR 0005) is still only a function that returns a `Result`, whatever the
  form: this form does not reach `()` functions there.
