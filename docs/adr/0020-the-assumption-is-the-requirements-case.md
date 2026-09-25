# 0020. Under `check_before_action`, the assumption is the requirement's case, with the checks' bodies sent, and not that "the check does not pass"

Status: Accepted (the decision below is the one measured and adopted on 2026-09-25; the two-step
this ADR was drafted for was measured in the same probe and not adopted — see *What was measured*)

## Context

`check_before_action`'s observation (ADR 0006) puts this to Jev: *assume the function is called in
a case where the requirement says the call must not be made, because the check it asks for does
not pass — does the function go on to make the call?* The failure form's observation assumes an
event with a value — *this call returns an error* — and what the function does next is in its body.
This form's assumption names no value: which call is "the check", and what it returns, is Jev's to
decide from the body it reads.

The acceptance material's hidden versions move the check into a helper whose body returns `true`
(moltis#1064 `has_enough_messages`, grovedb#500 `heights_need_rewrite`) or `Ok(())` (the
constructed case's `reject_disabled`). With the helper's body sent (ADR 0019), measured on
2026-09-25 under the words above (`bench/logs/check-before-action-real-v3.json`,
`bench/logs/check-before-action-v2.json`):

- the constructed case's hidden version — an eight-line function — turned from holding
  (`does_not_reach` 0.96–0.97 without the body) to the defect it is (`reaches_it` 0.80–0.83,
  three of three);
- moltis#1064's moved toward it and did not arrive: `does_not_reach` 1.00 without the body,
  0.83–0.88 with it, still holding three of three;
- grovedb#500's did not move: `cannot_determine` 0.50–0.57, with the body and without.

So the body is read when the function is small, and not when it is not. The plan's first
explanation — that the assumption "the check does not pass" overrides the body — does not fit the
constructed case, which was asked under the same words. What the two real functions have and the
constructed one has not is text beside the code: moltis#1064's other arm says
`debug!("auto-title: too few messages, skipping"); return Ok(None);`, nearly the requirement's
words; grovedb#500's has `// if height values are wrong, rewrite height` above the call and a doc
comment on the helper. A reader who skims goes by such text and by names; a reader who evaluates
`has_enough_messages(&h)` against `{ true }` does not. Jev evaluated the eight-line function and
skimmed the seventy-line one. Which of these is the cause is not settled by the data; what the data
settle is that sending the body is not enough on real code, and that a wording that only tells Jev
not to go by names leaves the comments and strings where they are.

## Decision

The function's question assumes the case the requirement describes — the one in which it says the
call must not be made — and nothing about any check: *assume exactly this and nothing else: `F` is
called in the case `requirement.text` describes, the one in which it says the call `X` must not be
made; every other operation the function reaches succeeds, unless the case itself decides it
otherwise. Under that condition: does `F` go on to make the call `X`?* — with the bodies of the
checks the form named above the call under `evidence.related` (ADR 0019), which the question now
says are "the bodies of functions `F` calls, given so that what those calls do can be read". The
three answers stay; the mapping question is unchanged; the rule (`review/outcome.ts`) reads the
same two answers. "Unless the case itself decides it otherwise" is for a check the rule did not
name — one that binds its result first, one whose name does not meet the words: it is Jev's to read
from the case, as before this decision, and not forced to succeed.

That is the case-only wording, the plan's first draft, which this ADR was drafted to reject for a
two-step (below) that reads each check's value from the check's own body first. Both were measured
on the same packets before either was wired, and the two-step failed a line the case-only wording
met, so the words above are the decision and the two-step is the record. What follows is the
two-step as it was drafted, kept because the probe measured it.

### The two-step, drafted and measured, not adopted

1. After the mapping has read the requirement as applying to the call, for each check the form
   named and sent (ADR 0019), one question of its own, with a packet of the check's body (and what
   it calls, as sent) and the requirement: *take the case the requirement describes, in which it
   says the call must not be made; in that case, what does `C(args)`, called from `F`, return:
   `true` or `Ok` / `false` or `Err` / it cannot be told.* A check whose value cannot be told, or
   comes back under the bar, holds the call (*Not checked* says so): the code the reading turns on
   was sent, and was not read. A check whose return type is neither `bool` nor a `Result` — an
   `Option`, an enum, a `Result<Option<T>>` whose `Ok(None)` and `Ok(Some)` the answers cannot tell
   apart — is not asked, and holds the call the same way.
2. The function's question assumes the case and the values read: *assume exactly this and nothing
   else: `F` is called in the case `requirement.text` describes, the one in which it says the call
   `X` must not be made; in that case `C(args)` returns `true` (as read); every other operation the
   function reaches succeeds, unless the case itself decides it otherwise. Under that condition:
   does `F` go on to make the call `X`?* — with no clause about a check when none was named (a call
   guarded by the standard library's `len()`, `exists()`, or by nothing, is asked under the case
   alone). "Unless the case itself decides it otherwise" is for a check the rule did not name — one
   that binds its result first, one whose name does not meet the words: it is Jev's to read from the
   case, as before this decision, and not forced to succeed. The bodies sent are read, not assumed:
   the clause is about what `F` does, not about what a sent body does. The three answers stay, and
   the rule (`review/outcome.ts`) reads this answer and the mapping's as before; the checks'
   readings go in the record beside them.

Which value stops the call is the function's to say — `if is_disabled(&r) { return Err }` stops on
`true`, `Ok(h) if has_enough_messages(&h)` proceeds on `true` — so the check's question asks for
the value, never for whether "the check passes". What passing the value removes is the polarity of
the function's use of it; a requirement written as a double negative (grovedb#500's "unless
verifying the heights has failed") is still read twice, by the check's question and the function's.

The measurement carries a version made for this decision: **helper**, the check moved into a
helper that checks — the same call sites as the hidden version, the helper's body the only
difference, and `false` or `Err` the value in the case. Hidden and helper are told apart by the
check's body or not at all, so an answer that is always `true` fails one of them.

### What was measured (`bench/decisive/words-probe*.json`, `bench/logs/words-probe-v[1-4].json`)

The words were measured before they were wired, on the same packets, the arms interleaved request
by request so the host's version could not tell them apart, with the lines and the rule choosing
among the arms committed first. Arm 0 was the old words, arm 1 the case-only words, arm 2 the
two-step. The three cases carried five versions each — shipped, defect, rewrite, hidden, and
**helper**, made for this probe: the check moved into a helper that checks, the same call sites as
hidden and the helper the only difference — its body, and its parameter's name: hidden's helper
takes `_history` / `_grove_version` / `_record`, an underscore that says the parameter is unused,
a cue a reader could go by without the body (the hidden versions were measured with it before this
probe and are not rebuilt) — so hidden and helper are told apart by the helper, not by the function.

- **Version 1** (275 requests, 15 targets, three arms): arm 1 met every line — the three hidden
  versions read as reaching the call (0.79–0.99), the three helpers as not (0.88–1.00), every
  shipped, rewrite and defect as before. Arm 2 read ten of eleven check values right and one
  wrong: grovedb#500's hidden `heights_need_rewrite`, whose body is `true`, as `false` three
  times of three (0.91) — a three-line body under a doc comment ("whether the heights … have to
  be rewritten") and a double-negative sentence, and Jev went by those. Arm 0 read moltis#1064's
  hidden version as holding (0.86–0.89) and grovedb#500's as reaching in one run of three.
- The outside line — on calls of pull requests the rules were not written on, of the runs the old
  words read as holding, none turned into a listing and at most 30 % into not settled — needed ten
  such runs and got 6 of 33 (**version 1**, eleven calls under a stand-in sentence, beside the
  targets), 2 of 58 (**version 2**, the stand-in on more calls: 116 requests) and 4 of 141
  (**version 3**, one real sentence per pull request: 282 requests): under the old words, only
  the call the sentence's own check guards holds. **Version 4** (twelve sentences, each from a
  real guard in a changed function of four unseen pull requests; 174 requests) reached 25 such
  runs. Of them arm 1 held 21,
  read 2 under the bar as holding, 1 under the bar as reaching, and read **one as reaching at
  exactly 0.60**: the snapshot's `decode` under the sentence about mutations — a call the sentence
  does not govern, which the old words themselves held in only two runs of three. The line said
  none; the owner ruled (2026-09-25) that this one is the line's coarseness — it counted
  observations without the mapping, which would set that call aside — and adopted arm 1 with the
  exception written here and in `docs/local-check-cli.md`.

What the probe does not show: that Jev evaluates rather than skims in general. It shows that on
these three functions, given the checks' bodies and the case, it read the helper's body both ways;
and that on twelve sentences over four unseen pull requests the new words listed nothing the old
words held, at one reading at the bar. The dev set (#80) is where this is measured on more.

## Alternatives considered

- **Keep the words and send the check's body** (ADR 0019 alone). Measured above.
- **Change only the words: assume the case, not the check's failure.** The plan's first draft.
  It removes the clause that hands Jev the check, and adds "read each condition from the code, not
  from a name" — which also forbids the only reading available for a check that has no body here
  (`h.len() >= MIN`, a dependency's `exists()`), and leaves the comments and log strings a skimming
  reader goes by. Kept as an arm of the probe; adopted only as above.
- **A mechanical rule: a check whose body reads none of its parameters is no check.** Jev-free;
  it names all three hidden helpers, which use nothing they are given. It cannot see a helper that
  reads its input and ignores it (`let _ = h.len(); true`). Scored beside the arms in the probe as a
  record; not wired.
- **Strip comments and string literals from the evidence.** It removes what a skimming reader goes
  by and nothing a behaviour reading needs, but it also removes what a person reading the report's
  evidence uses, and whether it makes Jev evaluate is not known. Not measured; noted for the case
  the two-step's function question is still read by its strings.
- **Say the form cannot see a broken check.** True of the old words, and it leaves the likeliest
  way to hide a check — a helper the pull request adds — unread.

## Consequences

- No request is added: a call under this form still costs the mapping's request and the
  observation's. `metadata.questionsHash` moves; every answer kept for a pull request (ADR 0013)
  under this form is asked again once.
- `--json` and the report change only in the words: the *Assumed* line says the case the
  requirement describes and that every other operation succeeds unless the case decides it, where
  it said the check did not pass. The bodies sent are listed as ADR 0019 has them (`sent`,
  `notSent`); no field for a check's value exists, since none is read apart.
- The form's earlier measurements (`check-before-action-v1.json`, `-v2.json`,
  `check-before-action-real-v1.json`, `-v2.json`, `-v3.json`) are of the old words and are not
  appended to; `expected-v1.json` beside each real case keeps the table they were scored under.
- What the function's question rests on: that Jev reads the requirement's case from the sentence
  (the mapping question reads the same words), and that, given the case and the checks' bodies,
  it evaluates a check's body rather than going by its name or the text around the call. The probe
  measured the second on three functions and, for the old words' holds, on twelve sentences over
  four unseen pull requests; the dev set (#80) measures it on more. The two-step's misreading of
  a three-line body under a doc comment says the same reader can still go by the text when the body
  is all it is shown.
