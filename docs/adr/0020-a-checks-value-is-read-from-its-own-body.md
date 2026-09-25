# 0020. Under `check_before_action`, a check's value is read from its own body, and assumed by name in the function's question

Status: Accepted

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

The check's value is read where there is nothing to skim, and the function is asked under that
value — the failure form's shape.

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

The words are measured before they are wired: the three cases' twelve targets, the old words, the
case-only words (the plan's first draft) and this two-step, on the same packets, the arms
interleaved request by request so the host's version cannot tell them apart, with the lines and
the rule choosing among the arms committed first (`bench/decisive/words-probe.json`). This
two-step is the decision if it meets its lines; the case-only words are adopted instead, and this
ADR amended, only if the two-step fails and they pass; if both fail, nothing is wired and the
numbers go to the owner.

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

- One request more per check per call asked under this form. `metadata.questionsHash` moves; every
  answer kept for a pull request (ADR 0013) under this form is asked again once.
- `--json` carries, on an observed call and a finding under this form, `checks`: each check's
  name, the value read and its probability. The report's *Assumed* line says the case and the
  values.
- The form's earlier measurements (`check-before-action-v1.json`, `-v2.json`,
  `check-before-action-real-v1.json`, `-v2.json`, `-v3.json`) are of the old words and are not
  appended to.
- What the function's question still rests on: that Jev reads the requirement's case from the
  sentence (the mapping question reads the same words), and that, given a concrete value for the
  check, it follows the function's control flow rather than its strings. The probe measures the
  second on three functions; the dev set (#80) measures it on more.
