# 0008. Whether Jev can read a requirement's form is measured before anyone lets it choose

Status: Accepted

## Context

ADR 0006 made what the local check asks of a call a form, and left one thing open: a requirement
names its form in the spec (`form`, defaulting to `failure_propagation`), Jev does not choose one,
and whether it should was to be measured first — a measurement that would also settle whether the
field stays (0006's Decision, the bullet on `form`, now rewritten to point here). Every
requirement read from an issue or a pull request (ADR 0004) is `failure_propagation`,
so a sentence such as "A disabled API key must never create a session." written in an issue is
asked the failure questions and reaches nothing — the case #35 opens with.

Only Jev may be asked anything, as a typed choice. A choice made by a model before its accuracy at
making it is known was the reason 0006 did not let Jev pick which calls are actions. The same
reason applies to letting it pick a form.

## Decision

**Measure first, in a pull request of its own, and let the owner decide with the numbers.**
Nothing chooses a form from a sentence until then; the `form` field stays whatever is decided,
as the author's explicit word.

The measurement (`bench/forms/choice/`, log `bench/logs/form-choice-v1.json`):

- **The sentences**: every requirement sentence this repository and issue #35 already hold, and
  three written from the text of issues among the forty examined for #36 whose fix was a check
  before an action (omamori #391, #75, #182) — written the way the acceptance set's sentences
  were, from the issue's text, and committed before the first request. Each is labelled
  `failure_propagation`, `check_before_action` or `neither`, and carries who wrote it, in four
  kinds: `tool` (written by this project for its own fixtures and benches), `model` (the
  requirement-writing model's first output, mechanically repaired — `bench/corpus/`, fourteen of
  whose thirty-two are fragments cut mid-sentence and are sent as they are), `text` (read by
  hand from a real issue or pull request, `bench/corpus/intent-golden.json`, and issue #35's
  examples) and `written` (the three above). Identical sentences count once; the set's hash is
  recorded at the head of the log before the first request, and no label is changed after it.
  The set's limit is stated with its numbers: fourteen of the eighteen failure sentences are this
  tool's own template, and of the check sentences only three are not in this project's words —
  issue #35's two and a model's fragment — with three more written from real issues for the
  measurement. The `model` sentences are kept because that is the shape a requirement read from
  text arrives in (`readRequirementText`); their numbers are shown apart from the rest.
- **The question**: one typed choice per sentence, over the sentence alone (`requirement.text`,
  redacted as every packet is; no code, no hints): which of the two forms its sentence says, or
  neither. `neither` is an option of the question, not a form. The question's text and the rule
  for reading an answer — a form's option at the bar (0.6) or above is that form; `neither`, an
  answer under the bar, or none is the default — are hashed into the log, and the scorer refuses
  a log whose question differs from the file's.
- **Three runs per sentence**, every option's probability kept, on Cloudflare. `score` recomputes
  every number the documentation quotes from the log and sends nothing.
- **A fixed keyword rule** (`must not` / `never` / `unless` → check, tried first; `fail` /
  `error` → failure; else neither) is scored on the same set and printed beside Jev, for scale.
  The tool does not use it: what a sentence means is Jev's to read, and the tool's own rules are
  structural (a word shared with a call's name, a callee that returns a `Result`).

What the numbers would have to show for Jev to be given the choice, written before they exist:

- **Failure sentences**: none read as `check_before_action` at the bar in any run. One read as
  `neither` or under the bar falls to the default and is asked what it is asked today — allowed.
  This is the line against a regression: a failure sentence handed the check questions reaches
  nothing. One sentence in one run is a miss: it is shown with its run, and the bar is not
  cleared.
- **Check sentences**: at least 80% of the distinct sentences read as `check_before_action` at
  the bar in three runs of three, and no fewer than the keyword rule gets right. One read as
  failure or neither is asked what it is asked today — no gain, no loss.
- **Neither sentences**: at most 10% read as `check_before_action` at the bar in any run. Such a
  requirement would be asked the check questions instead of the failure questions it is asked
  today — a different check, not merely a wasted request. Read as failure it is today's
  behaviour.
- The numbers of the sentences that are not this tool's (`text` and `written`) are shown on their
  own, and so are the `model` sentences' with how many of them are fragments. The keyword rule
  is shown for all three classes.

The owner's ruling on the numbers, and what it settles, is recorded here when it is given.

### The numbers and the ruling (2026-09-22)

72 sentences (failure 18, check 11, neither 43; tool 22, model 32, text 15, written 3; 14
fragments), three runs each, 216 requests to Cloudflare, log `bench/logs/form-choice-v1.json`,
set committed at e8d0406 before the first request. A first set of 69, committed at e04ff98, had
left out the requirements of three test fixtures; its measurement (207 requests, 38ee6ac in the
pull request's history) was set aside and the whole measurement taken again on the completed
set — the shared sentences read the same at the bar except two: the fixture's baseline sentence,
under the bar three times there and twice here, and the sentence read by hand from sideeye #602,
read as check in two runs of three there and one here. `verify` now enumerates every requirement sentence
in the repository's spec, fixture and golden files and a test fails when one is not in the set.
The table is in `docs/local-check-cli.md` ("How Jev reads the form of a sentence"),
`node bench/forms/choice/run.ts score` recomputes it, and `test/form-choice.test.ts` holds the
log to its counts.

- Failure sentences read as check at the bar in any run: **0 of 18** (bar 0 — met). Two are not
  read as failure in every run — the fixture's baseline sentence and the one read by hand from a
  real pull request, neither of which says "fails" the way the template does — and fall to the
  default when under the bar.
- Check sentences read as check at the bar in every run: **10 of 11** (91%; bar 80%, and the
  keyword rule's 8 — met). The one under the bar names no operation ("every session-creation path
  must enforce the same guard;", 0.52–0.55).
- Neither sentences read as check at the bar in any run: **4 of 43** (bar at most 4 — met, exactly).
  All four say what is refused or voided when a condition holds, and the fourth straddles the bar
  (0.65 in one run, 0.56 and 0.59 in the others; over it twice in the first measurement) — the
  cap is met by one reading at the edge, not with room to spare.
- Nothing was read as failure that was not labelled so.
- Of the eleven check sentences, five are this project's bench and fixture sentences, three were
  written from real issues for this measurement, two are issue #35's as written and one is a
  model's fragment; fourteen of the eighteen failure sentences are this tool's template. The
  numbers say how Jev reads sentences of these shapes, not how it would read an arbitrary issue.

**Ruling: Jev chooses.** For a requirement read from an issue, a pull request, `--intent` or
`--intent-file`, the run puts this question once, before the calls, and reads the answer by the
rule above; a spec's `form` stays its author's and is not asked; `--candidates-only` asks nothing
and says so. The `form` field stays.

**Landed** (2026-09-22, the pull request after #53). Each form carries what its sentence says
(`says`), and `src/plan/forms.ts` assembles the question from the forms in the measured order;
`test/forms.test.ts` holds the question's serialisation to this log's hash. `runLocalCheck` asks
it once per requirement that names no form, before the calls, on a run that reads at least one
function and is not building the set only — a run that read no function would otherwise send
requests where it sent none, and could fail on the host where it used to print a report. A
requirement that names a form is never asked, by the run's own guard; one that names none is asked
only when the caller says so, and the command line says so for every source but a spec
(`askForm: !resolved.spec`), so a spec's requirement without `form` is not asked either. The
requirement's own id is sent where the measurement sent `R1`; the question does not read it. `formBy`,
`formReading` and `formNotAsked` are in `--json`, and the report's form line says who chose. A
requirement Jev reads as `check_before_action` whose sentence shares a word with no call is checked
under that form and reads no call — the report says so for each call it held — rather than falling
back to the failure questions, which would send questions Jev did not read the sentence as asking.

## Alternatives considered

- Measuring and wiring in one pull request, the wiring conditional on the numbers: a pull request
  whose promise changes with its own result. Split.
- A keyword rule in the tool: the tool guessing what a sentence means. "…must not be rewritten
  unless verifying the heights has failed" is a check sentence that contains `failed`; the answer
  depends on the order the rule tries its words. Printed for scale, not used.
- Asking every requirement read from text under both forms: no choice to measure, but up to twice
  the requests per requirement and two sections in the report, and most sentences in real issues
  are neither form. Kept as an option for the wiring decision.
- The author marking the form in the list item: an issue's author does not know the forms. A spec
  is where someone who does says so, and it stays.
- Putting the question in `src/` now: the run does not send it. It moves there, as each form's own
  criterion, if the owner decides to wire it; the log's hash of the question is what shows the
  moved text is the measured text.

## Consequences

- One more measurement log and one more bench; no change to what the run sends or prints.
- If the numbers clear the bar and the owner says so, a later change asks the question once per
  requirement read from an issue, a pull request, `--intent` or `--intent-file`, before its calls;
  a spec's requirement keeps the spec's `form` and is not asked; `--candidates-only` asks nothing
  and says so; the report and `--json` say per requirement which form and who chose it. If not,
  the reading path stays `failure_propagation` and this record says why.
- Requirements read from text carry no `searchHints`, so for them the check form reaches only
  the calls whose names share a word with the sentence itself.
