# 0026. Whether Jev reads a handled-failure sentence as `failure_handling` is measured before the form is offered to sentences

Status: Proposed (the lines below were written before the first request; the numbers and the owner's
ruling are added under them)

## Context

ADR 0023 added `failure_handling` and offered it to no sentence: the question that asks Jev which form a
requirement's sentence has (ADR 0008) is built from the forms with `chosenBySentence`, and this one has it
false. So a requirement read from an issue, a pull request, `--intent` or `--intent-file` that says a
failure may be logged or recorded but must not be swallowed is still checked under `failure_propagation`,
and lists the fixed code — which logs and goes on — as worth checking. That is the complaint #85 opens
with, and it stands until the form is offered.

Offering it changes the question every such requirement is asked. The two forms' sentences share their
first half ("The sentence says what must happen when an operation fails:") and part in the second. A
requirement that says the failure must reach the caller, read as `failure_handling`, would stop listing a
function that logs and returns `Ok`. ADR 0008 measured before it let Jev choose; this does the same for the
third option, and, as there, measuring and wiring are separate pull requests.

## Decision

**Measure first, on set 3, with the lines below fixed before the first request; wire only on the
owner's ruling, in the next pull request.** This pull request changes no byte the run sends: `src/`
gains only `buildFormQuestion(names)`, which the run's `FORM_QUESTION` is now built with (value
unchanged, held by the v1 log's hash) and the bench builds set 3's question with — every form in
declared order, so what is measured is what the run would send with the flag set.

**The sentences.** The 79 of sets 1 and 2, labels unchanged, and sentences written from dev pull
requests (`bench/forms/choice/written-85/README.md`): the 41 Rust pull requests of `bench/eval/pool.json`
whose requirement #85's annotators judged writable in either failure form (43 rows; pool is all dev).
Two readers per pull request, who see neither each other nor the form question:

- **The truth is read from the diff**, by three annotators who see only the diff: after the change, does
  the code return the failure to its caller or handle it where it happens? Majority of three; `other`,
  `unclear` and three-way splits are left out. `pool.json`'s `label` says how the code *before* the fix
  handled the failure (ADR 0023), so it cannot say this.
- **The sentence is written from the text**, by one of three writers who see only the pull request's and
  its issues' text, asked for the requirement as the issue's author would write it. They are not shown the
  forms, so the sentences are not shaped to the options' words.

A sentence's label follows its truth (`handles_locally` → `failure_handling`, `returns_to_caller` →
`failure_propagation`). This deliberately does not separate how faithfully a writer carried "return an
error" from how Jev read it: what is measured is whether the complaint happens — whether a requirement
whose fixed code handles the failure locally is sent to `failure_handling`.

This is the routing of a sentence, not #85's precision on real pull requests, which is measured on #80's
sets under its protocol. `pool.json` and `forms-85.json` are read, not changed; the new readings are new
files under `bench/forms/choice/written-85/`, as #85's first pull request added `forms-85.json`.

**The question.** Set 3: the run's instructions, the forms' `says` in declared order —
`failure_propagation`, `check_before_action`, `failure_handling` — and `neither`. No other wording and no
other order is measured: picking the better of several after reading them would bias the numbers.

**Runs.** Three per sentence, every option's probability kept, on Cloudflare, read at the bar (0.6) by
`readOption` as `chooseForm` reads them; an answer not at the bar, `neither`, or none goes to the
default, `failure_propagation`. The same day, set `1c`: the question sent now, on the 79, three runs —
so that a change in how the old classes are read can be told from a change between days (#87 measured
about 5% of readings moving between runs).

**The lines** (`bench/forms/choice/v3.ts`, `barLines3`):

1. **Main**: of the sentences whose pull request handles the failure locally, at least 80% read as
   `failure_handling` in every run. Shown with the count, Wilson's 95% interval (rows taken as
   independent, which they are not: 22 of the 43 rows are one repository, and much of its text was
   written by the same model), the number of repositories, and the count outside `yottayoshida/omamori`.
   **Not read** — nothing sent — if fewer than 8 pull requests or fewer than 4 repositories hold such a
   sentence: `run.ts measure --set 3` refuses.
2. Of the 25 failure sentences of sets 1 and 2, the 21 that say the failure goes back (lower-cased,
   `caller`, `return an error` or `reach the client`; fixed by their words): none read as
   `check_before_action` in any run (ADR 0008's line), and at most 10% as `failure_handling` in any run.
   The other four (`fixture-integrity-rust-R1` and omamori #553's three) say what is shown or reported;
   `failure_handling` is not a wrong reading of them, and they are recorded only.
3. Check sentences: at least 80% read as check in every run, not below the keyword rule, and at most one
   fewer than set `1c` gets the same day; at most 10% read as `failure_handling` in any run.
4. Neither sentences: at most 10% read as check in any run (ADR 0008's line), and at most 10% as
   `failure_handling` in any run.
5. Recorded, with no line: sentences whose pull request returns the failure (a sentence that does not
   say "return" is not wrongly read as handled); the four failure sentences above; the main line's misses
   by where they went.

A keyword rule for set 3 is scored beside Jev and used by nothing (handling words `log`, `logged`,
`logging`, `record…`, `warn…`, tried after the check words and before the failure words). Sets 1 and 2
keep theirs, so their tables do not change.

### Limits

- The readers are subagents of a Claude Code session that injects the workspace's instructions and
  memory, in which #85 and a handled-failure form are named. Their prompts keep them to the diff or the
  text; what else they saw is not controlled. `claude -p` with project settings would not inject the
  memory, but runs the workspace's session-end hook, which pushes the workspace; it is not used for six
  readers.
- The main line's pull requests lean on one repository whose issues were largely written by a model.
- One wording and one order of the options.

## Alternatives considered

- **Labelling each sentence with the form question's own options**, by annotators who read the options:
  the labels become what a reader of that question says, and the main line measures agreement between two
  readers of the same question, not whether the complaint happens (the plan's first review, C-1).
- **Counting a failure sentence read as handling, and a handling sentence read as failure, alike**: a
  sentence written from a pull request whose fix returns the failure lists the same defect under either
  form; only a pull request whose fixed code handles the failure locally turns a wrong route into the
  complaint (C-2). The main line is on those.
- **Writing the sentences ourselves**: the sentence and its label from one head, shaped to the options.
- **Wiring in the same pull request, on the numbers**: a pull request whose promise changes with its own
  result (ADR 0008).

## Consequences

- One more set, two more logs (`form-choice-v3.json`, `form-choice-v1c.json`), `node bench/forms/choice/run.ts
  score --set 3` recomputes the table `docs/local-check-cli.md` quotes. The run sends and prints what it
  did.
- If the lines are met and the owner says so, the next pull request sets `failure_handling`'s
  `chosenBySentence`, moves `test/forms.test.ts`'s hash to set 3's log, and says in `CHANGELOG.md` which
  requirements are now asked what.
