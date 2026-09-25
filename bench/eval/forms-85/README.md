# Which form could each row's requirement be written in (#85)

Written and committed before any annotator ran and before any request with the new form was sent.
Nothing below changes after the first judgment is read; a change makes `forms-85-v2`.

## What is judged

For each of the 91 rows of `bench/eval/pool.json` that carry a `label`, two judgments, each by three
annotators, each a fresh session that reads only the pull request's text and the text of the issues it
names on GitHub — not the diff, not this repository, not the other annotators, not the row's `label`:

- **(a)** Could this row's requirement be written in the form `failure_propagation`?
- **(a′)** Could it be written in the form `failure_handling`?

(a) and (a′) are asked by different sessions, so no annotator answers one while comparing it with the
other. The existing `label` and `verdicts.a` are not changed (`PROTOCOL.md`, *Labels*): these are new
columns. (a) is judged again rather than taken from `verdicts.a` so that both sides of the comparison
are written by the same kind of reader; how often the annotators' (a) agrees with `verdicts.a` is
recorded beside it.

The two definitions, given to the annotators word for word:

- `failure_propagation`: "The sentence says what must happen when an operation fails: the failure must
  reach the caller as an error, and must not be returned as a success, an empty value or an absence."
- `failure_handling`: "The sentence says what must happen when an operation fails: the failure may be
  returned, logged or recorded, and must not be turned silently into a success. A failure is turned
  silently into a success when the code goes on as if the operation had succeeded and leaves no trace of
  the failure: nothing returned, logged or recorded. An empty or absent value a caller cannot tell from a
  success, with nothing logged or recorded, counts as no trace. A message on standard error counts as a
  trace."

## The prompt

Each annotator is given the rows (their `id`s) and this, with `<FORM>` and `<DEFINITION>` filled from one
of the two above:

> You are labelling pull requests for an evaluation. For each row, the id is `owner/repo#N`: read that
> pull request (`gh pr view N --repo owner/repo --json title,body,comments`; if it is not a pull request,
> `gh issue view N --repo owner/repo --json title,body,comments`) and every issue its text says it closes
> or fixes (`gh issue view`). Read nothing else: not the diff, not the code, not any file on disk.
>
> Decide one thing per row: could the requirement this pull request is about — what the code must do —
> be written as one sentence of this form?
>
> `<FORM>`: <DEFINITION>
>
> Answer `yes` if such a sentence would say what this pull request's fix requires. Answer `no` if the
> fix is about something else — the correctness of a value, a feature, a performance or build change,
> a failure the fix handles in a way the form's sentence would forbid — or if the form's sentence would
> call the fixed behaviour wrong. Answer `unclear` only when the text does not say what the fix does
> about the failure.
>
> Write one JSON object per row to the file you are given, as a JSON array:
> `{"id": "...", "answer": "yes" | "no" | "unclear", "quote": "<the sentence of the text your answer rests on>"}`.

## Counting (fixed before any judgment)

A judgment is decided by two of three; three different answers make `unclear`. `unclear` counts as
not writable.

- **The main count**: rows whose repository's primary language is Rust (`gh api repos/<repo> --jq
  .language`, taken on 2026-09-25: 51 of the 53 labelled repositories) and whose `label` is
  `swallows_as_success` — the defect the new form's `violates` answer names. 37 rows, 23 repositories.
  For these, the share writable in (a), and in (a) or (a′), by row and as the mean over repositories.
- **The side count**, recorded only: the same two shares over every row whose `label` is not
  `not_failure_handling`.

**The line**: in the main count, (a) or (a′) is writable in at least 3 more rows, and at least 10
points more, than (a) alone. It is a record, not the gate for wiring the form: on rows labelled as
swallowing a failure, a form whose sentence forbids swallowing is expected to be writable, so crossing
it is weak evidence (the plan's second review). It measures whether a sentence can be written, not
whether the tool reaches the call; that is measured with cases, later. Falling short of it is written in
the ADR as "not even the sentences increased".

## Result (2026-09-25)

`node bench/eval/forms-85/count.ts` on `../forms-85.json`:

- main (Rust, `swallows_as_success`): 37 rows, 23 repositories — (a) 21 (56.8 %, mean 52.7 %); (a) or (a′) 28 (75.7 %, mean 64.9 %)
- side (failure handling): 67 rows, 35 repositories — (a) 32 (47.8 %, mean 48.5 %); (a) or (a′) 43 (64.2 %, mean 56.4 %)
- the line: crossed (a record, not a gate)
- agreement: (a) unanimous 72, two to one 18, split 1; (a′) unanimous 81, two to one 10; the annotators' (a) and `verdicts.a` agree on 57 of 70

The six annotators ran as subagents in one directory, which one of them (an (a) annotator) used for its
working notes. Every other annotator's quotes match those notes on 14 to 31 rows of 91 and its answers
on 72 to 78: what quoting the same sentence of a pull request would give, and not a proof that none
read the notes.
