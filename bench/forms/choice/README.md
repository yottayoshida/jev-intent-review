# Does Jev read which form a requirement's sentence has?

A requirement read from an issue or a pull request is checked under `failure_propagation`; only a
spec can name `check_before_action`. Before anyone lets Jev choose the form from the sentence,
this measures whether it can (ADR 0008). Nothing here changes what the run sends.

- `question.ts` — the question: one typed choice over the sentence alone, `failure_propagation` /
  `check_before_action` / `neither`, and the rule that reads the answer (a form's option at the bar,
  0.6, is that form; `neither`, under the bar or no answer is the default). Also the keyword rule
  scored beside Jev for scale.
- `sentences.json` — the labelled set. `run.ts verify` checks it against the files it names.
- `run.ts verify | measure [runs] | score` — see the file's head. `measure` needs `JEV_PROVIDER` and
  that host's key; the log is `bench/logs/form-choice-v1.json`.
- `score.ts` — the table `docs/local-check-cli.md` quotes, from the log.

## The set

Every requirement sentence this repository and issue #35 held on 2026-09-22, and three written
for this measurement — none rewritten, none dropped. Each carries its label and who wrote it:

| who wrote it (`origin.kind`) | what | sentences |
|---|---|---|
| `tool` | this project, for its fixtures and benches: the acceptance set's specs and the four more sentences written for #36's candidates (`bench/acceptance/`), the stated pair of omamori #468, the `integrity-rust` fixture, the constructed case and the two reach sentences (`bench/forms/`) | 19 (failure 15, check 4) |
| `model` | the requirement-writing model's first output, mechanically repaired (`bench/corpus/*.spec.json`); fourteen are fragments cut mid-sentence and are sent as they are | 32 (failure 2, check 1, neither 29) |
| `text` | read by hand from a real issue or pull request (`bench/corpus/intent-golden.json`), and the four examples in issue #35's Problem section as written | 15 (failure 1, check 2, neither 12) |
| `written` | written from the text of three omamori issues among #36's candidates whose fix was a check before an action (#391, #75, #182), the way the acceptance set's sentences were written from theirs; committed before the first request | 3 (check 3) |

69 sentences: failure 18, check 10, neither 41. Identical sentences count once (the
`integrity-rust` fixture's first requirement appears in two spec files and is here once). Near
paraphrases are kept as separate sentences: the constructed case's "A disabled API key must never
create a session." and issue #35's "disabled API keys must never authenticate;" are the same
example in two wordings.

The labels are one reader's, given before any request and not changed after it. The borderline
ones, so a reader can disagree: `corpus-sideeye-602-R1` ("The judge refuses a report whose digest
does not match …", a fragment) is labelled check, its sibling `-R2` neither, since R1's main claim
is the refusal and R2's is where the outputs are read from; `golden-sideeye-602-1`, which ends in
the same refusal after a longer claim, is neither for the same reason; issue #35's "every
session-creation path must enforce the same guard;" is check, as `docs/local-check-cli.md` already
treats it (a check sentence that names no call).

The seven sentences from issues (`origin.url`) were compared with the issue text by hand on
2026-09-22; the other 62 are checked by `verify` against their files.

**What this set is not.** Fifteen of the eighteen failure sentences are this tool's own template
("If X fails, the failure must reach the caller as an error. It must not …"). The check sentences
not written by this project are three, one of them a model's fragment; the three `written` ones
are from real defects but in this project's words. So the table says how Jev reads sentences of
these shapes, and the rows by author say which shapes; it does not say how Jev would read an
arbitrary issue.

## What is sent

`{ requirement: { id: "R1", text } }` — the text redacted as every packet's is, the id fixed, no
code and no hints: nothing in the request says what the sentence was labelled or who wrote it.
The log records every option's probability for every run, the sha256 of the set and of the
question before the first request, and the host's origin. `score` refuses a log taken on another
set or with another wording.

## Reading the numbers

ADR 0008 says, before the numbers, what they would have to show for Jev to be given the choice:
no failure sentence read as check at the bar in any run; at least 80% of the check sentences read
as check in every run, and no fewer than the keyword rule gets right; at most 10% of the neither
sentences read as check in any run. `score` prints each with its number. The decision is the
owner's, and is recorded in ADR 0008.
