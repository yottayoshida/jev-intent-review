# 0015. The callers one hop out have a budget of their own

Status: Accepted

## Context

A requirement's budget was one pool of 20 calls, shared by the functions the change touched and the
unchanged functions that call them, dealt one call per function at a time with the changed
functions first (issue #38). On Kontor#385 the call the README's example is about — an unchanged
caller, `initiate_rollback`, calling `get_decided_from_anchor`, a function the pull request changed
— could be asked about and was 53rd of 75: outside the budget, so `#45` stayed open on it.

Measured without a request on the acceptance pre-check's eight cases, every version of moltis#1064
and grovedb#500 and omamori `#468`'s five branches (20 runs), with the listing's caps and without
them, no order of the shared pool reached both sides:

- the calls into a changed function first, in whatever function they are: Kontor's caller call
  14th, but 7 of the 14 calls on a changed line fell outside the budget and 7 of the 19 changed
  functions got no question at all (the tool as it was: 2 and 0). A caller is in the set because it
  calls a changed function, so nearly every caller holds such a call; with up to 20 callers
  (`MAX_CALLER_FUNCTIONS`) and a budget of 20 they can fill it before the diff's own lines;
- one turn for each changed function first, then that order: nothing on the diff side lost, and
  the caller call 21st — outside.

## Decision

- **Two budgets for the calls the change reached**: 20 per requirement for the functions the change
  touched, in the order they were asked in before; for the functions that call them, one hop out,
  10 plus the places the first budget left — so together they never ask more than 30, and the callers get
  at least 10. Not never fewer than the shared pool gave them: one changed function with twenty calls
  and nineteen callers with one each gave the callers 19 then and 10 now. The owner chose a budget of its own for the callers
  over keeping one pool (2026-09-23); a fixed 10 was dropped because, where the change touched few
  calls, it gave the callers fewer than the shared pool had (moltis#1064: 16 then, 10).
- **Every requirement's changed functions are asked first, then the changes' questions, then every
  requirement's callers, then the siblings**, so a limit reached in the middle of a run —
  `max_requests`, the pull request's (0014), the time — stops at the callers and never at a later
  requirement's changed functions or at a question about a change, and what is asked before the
  callers is the same whether or not a caller exists. Asking the callers before the changes'
  questions was the first version: it let the callers push the changes' questions out under a limit,
  from seven requirements under the default `max_requests` of 400 where it had been ten.
- **In the callers' budget the calls into a function the change touched go first, whichever caller
  they are in**; then the rest. Each group is dealt one call per function at a time, and the groups
  are joined in that order — dealing the joined list again would put a caller's second call ahead of
  another caller's first call into a changed function.
- A call is "into a function the change touched" when its callee resolved to one, as the order
  inside a function already reads it (`resolvedTo`); under a form that resolves no callee
  (`check_before_action`) every caller's call is in the second group, dealt one per caller at a time
  in the order the callers were found, each caller's in the order they appear.
- The siblings (0005) keep their budget and stay last.
- In `--json`, `counts` keeps its totals over both budgets, so `budget` is 30, and gains
  `counts.byOrigin.changed` and `counts.byOrigin.calls_changed`; still `version: 2`.
- No configuration key, for the reason 0007 gave: a key would drift from the conditions the
  measurements were taken under.

## Alternatives considered

- One pool of 20, the calls into a changed function first everywhere: loses the diff's own lines
  (above).
- One pool of 20, one turn per changed function first: the caller call stays outside.
- A cheap first question to Jev about relevance, to order by: more requests, and the relevance
  answers measured in 0002 were weak (19% of 795 places read as a path, 56 of those 153 below the
  bar).
- A budget that grows with the pool: how it should grow is not measured yet (#38's next part).

## Consequences

- Up to 10 more calls asked per requirement — 20 more requests — where callers exist. The limit for
  the whole pull request (0014) still bounds a pull request.
- With more than ten callers, the calls into a changed function can take the whole callers' budget,
  and a defect in a caller's other calls is not asked about.
- The order was chosen with Kontor#385 in view, the case the order inside a function was chosen
  from too; it is a regression case, and the other runs show only that nothing got worse there.
- `counts.budget` changes value; a reader that compared it with 20 must read `byOrigin`.
