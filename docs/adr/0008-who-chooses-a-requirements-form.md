# 0008. Whether Jev can read a requirement's form is measured before anyone lets it choose

Status: Accepted

## Context

ADR 0006 made what the local check asks of a call a form, and left one thing open: a requirement
names its form in the spec (`form`, defaulting to `failure_propagation`), Jev does not choose one,
and "whether it should is to be measured first, and that decision also settles whether this field
stays". Every requirement read from an issue or a pull request (ADR 0004) is `failure_propagation`,
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
  The set's limit is stated with its numbers: fifteen of the eighteen failure sentences are this
  tool's own template, and the check sentences that are not this tool's are four — one as its
  author wrote it, three written from an issue's text — with one more that is a model's
  fragment. The `model` sentences are kept because that is the shape a requirement read from
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
