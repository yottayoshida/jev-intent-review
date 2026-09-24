# 0017. A reading that turns on code not sent is not settled

Status: Accepted

## Context

The local check sends Jev the body of the function a call is in, and nothing else: its related
code is read only above a `max_related_chars` of 0, which no run uses. Jev is not told what a
function the body calls does, and it still answers as if it knew. On the acceptance set's two
hidden versions (#36) — the decision moved into a helper whose body is not sent, so the body alone
allows either answer — the failure form read `returns_error` at 0.91–0.96 in every run of both
cases, and the call was read as holding (`bench/logs/acceptance-v4.json`). The check-before-action
form did the same on moltis#1064's hidden version (`does_not_reach` 1.00, three runs of three) and
on the constructed case. The packet says `truncated: true` in every one of these runs; that flag
did not lower any answer.

The helpers in those versions pass their argument through unchanged, so `returns_error` is what
the code does. The reading was right and had nothing under it: the same body with a helper that
swallows the failure is the same packet, and would get the same answer. `docs/dependency-check.md`
measured the same thing on omamori#553: without the callee, two versions with opposite behaviour
are one input.

The report already warns that holding "can agree and be wrong" where what decides it was not sent.
A warning on every holding is not a reading of any one of them.

## Decision

Jev is asked, about each call it reads, a third question: whether what the function does with the
call, under the form's assumption, can be worked out from the code sent, or turns on what a
function whose body was not sent does. The question is one for every form: its wording takes from
the form only `words.case`, the form's assumption without "every other operation succeeds" — with
that sentence, what an unsent helper does would read as fixed by the assumption. It says that
`evidence.related` may be empty. It is sent in the same request as the observation, so a run sends
no more requests than before.

The rule (`review/outcome.ts`) reads it: a call that the mapping and the observation would put in
*worth checking* or *holding* is *not settled* when this answer says it turns on code not sent, at
or above the bar of 0.6. Under the bar, `cannot_determine` or no answer leaves the outcome as the
other two answers put it. The report prints the answer next to the observation, apart from it —
how sure Jev is of the behaviour, and whether the code sent settles it, are two readings.

A call not settled this way is not a finding, so it does not change the exit code under
`policy.fail_on: [finding]`. The Action counts it as left to look at: a run with one is not green,
so a call that was worth checking does not turn a check run green by dropping out.

This was chosen before #80's dev set exists and before #83's resolution contract, and is measured
first on the acceptance set's cases. It does not close #82: its Done-when evaluates on #80's
dev/sealed protocol.

## Alternatives considered

- **Decide it mechanically from the call graph** (#82's second approach): a call whose value
  passes through a repository function whose body is not in the packet is not settled. It needs to
  know which definition a call reaches; today that is the name heuristic #83 replaces, and the
  issue asks that it not be copied into this decision. Revisit once #83's contract is merged.
- **Send the callee's body** (#82's third approach): `buildEvidence` can already add one hop of
  definitions. It changes every packet — every measurement is taken again — and needs the same
  callee identity from #83; where the body does not fit, a rule like this one is still needed.
- **Choose after #80's dev set.** The issue's order. Deferred on the owner's ruling (2026-09-25):
  the typed question does not depend on #80 or #83, and a probe on the acceptance set decides
  whether it works before anything is wired.
- **Ask it in a request of its own.** Keeps the observation's request byte for byte what it was,
  at half again as many requests. Chosen against unless the probe shows the shared request moves
  the observation's answers, or that this question's answers differ when it is asked alone: the
  observation's question in the same request still says every other operation succeeds, which
  could read as fixing what an unsent helper does. The probe asks the hidden versions both ways.
- **Allow a holding or a finding only when the code sent is read as settling it** (at or above
  the bar). Stricter, and it would erase the other two readings whenever the answer to this
  question is merely unsure. Not chosen; the probe and the measurements record what it would have
  given beside what this rule gives.
- **Treat `truncated: true` in the packet as not settled.** It is true of every packet the local
  check sends, so it would leave nothing settled.

## Consequences

- The questions' fingerprint (`QUESTIONS_HASH`) moves, and every answer kept for a pull request
  (ADR 0013) is asked again once.
- The claim is one way: a call Jev reads as turning on code not sent is not settled. It does not
  claim the code sent was enough for every holding: Jev may read an answer as settled when it is
  not, as it read the behaviour, and the two answers come from one request. The report keeps its
  measured warning under *Read as holding*. What is left is for the mechanical check after #83.
- If the probe shows Jev reads almost every call as turning on code not sent, the check says
  little. That is what the probe measures on the shipped, defect and rewrite versions before this
  is wired.
