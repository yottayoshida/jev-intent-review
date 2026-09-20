# 0002. VERIFIED is a claim about the paths Jev named, not about every place found

Status: Accepted

## Context

Run against ten real merged pull requests (38 requirements, 795 places judged), the tool reported
`VERIFIED` for no requirement at all. It reported three violations, and `UNKNOWN` for everything
else. A reader could not tell "looked hard, found nothing wrong" from "barely looked".

Measured from the saved runs (scripts under `~/.cctmp/jevtrunc-rgMEye/`, all from the recorded
answers unless noted):

- **Every requirement carried at least one "the search was cut short" reason** (405 in all;
  the most common are the 8-word cap on 33 of 38, the 30-candidate cap on 24, the 8-seed cap on
  21, and "the callers of X were not followed, too common" on 21). Raising a cap moves the run
  into another cap: the rule that any unfollowed lead withholds VERIFIED is unsatisfiable on a
  real repository, not merely strict.
- **Of the 795 places judged, Jev called 19% a path of the requirement** (153; 42% `supporting`,
  38% `unrelated`). With the configured `relevance_probability` of 0.6, 97 count — a median of 2
  per requirement. Four fifths of the request budget goes to establishing irrelevance.
- **A place the pull request changed is a path 30% of the time (79 of 261); a place it did not
  change, 3.4% (18 of 534).** The tool's purpose — a requirement broken in code the pull request
  never touched — does happen (2 of the 3 violations were in unchanged code), but the search
  around it is mostly empty.
- Jev is not decisive on most places: `violates` has a median probability of 0.62 with 27% at or
  above 0.7, and `insufficient_evidence` was answered 186 times with a median of 0.56. Requiring
  every one of ~30 places to be decided is a conjunction that a probabilistic judge will not
  satisfy.
- **Tripling the evidence budget changes nothing.** Re-running omamori#551 with
  `max_primary_chars` 12000 and `max_related_chars` 12000 (from 8000 and 4000) gave the identical
  outcome — 30 places, 22 unknown — for 11 KB more. The indecision is not a packet-size problem.
- Replaying the recorded answers under other rules: counting only paths reaches VERIFIED on 1 of
  38; also accepting a non-violation answer when only the *surroundings* of the evidence were cut
  reaches 6 of 38, with the three violations unchanged. **Five of those ten runs compared a commit
  with itself** — `--pr` resolved the base of a merge-commit-merged pull request to its head — so
  the ten were measured again once that was fixed: 1140 places judged where there had been 795,
  six violations where there had been four, and the same replay then reaches 7 of 38.
- Deciding a place by the summed probability of both path answers rather than the first one was
  tried on that baseline: VERIFIED falls to 1 of 38 and violations rise from 6 to 11, which is the
  false-violation rate the two-answer rule was built to hold down. Not adopted.

## Decision

`VERIFIED` becomes a claim about the places Jev named as paths of the requirement, at
`judgment.relevance_probability` or above, and the report states the scope of that claim:

> VERIFIED means every place Jev judged, at `judgment.relevance_probability` or above, to be a
> path of the requirement satisfies it — the section lists those paths, and says what was set
> aside and not followed.

Concretely:

1. A place counts towards a requirement only when Jev calls it a path at that probability.
   Everything else — called supporting or unrelated, or named a path too weakly — is set aside
   with its reason and counted in the report. The threshold already existed to keep a real path
   from being excluded; it now decides membership in both directions.
2. Evidence that was cut splits three ways. The place's own code cut, or no block found, voids
   every answer about it — and the place is counted with the ones the run could not judge, which
   withholds VERIFIED, rather than set aside with the irrelevant ones. Only the surroundings cut
   voids `violates` alone: missing callers and callee bodies can hide a check, so a violation
   cannot be claimed, but they cannot remove a check that was seen. The name being defined more
   than once voids `satisfies` as well, because the surroundings shown may belong to the other
   definition — and that check now also covers the one-hop definitions (a middleware, a guard
   helper), where the guard itself usually lives, counting only definitions outside tests.
   The 111-of-116 measurement below says the split is worth making, not that a satisfying answer
   read from surroundings is safe: the `guard-in-one-caller` fixture, where the guard sits in one
   of two callers, is the check on that, and it comes out unverified.
3. Leads the search declined to follow, places it did not judge, and places it set aside are
   recorded and handed to J5, whose answer already gates VERIFIED, instead of each one blocking
   VERIFIED outright. Still hard blockers: callers of a wrapper that were themselves wrappers,
   callers found by name but judged zero times, a change to this tool's configuration, and a
   change to a workflow.
4. `NOT_APPLICABLE` is removed as a requirement status. Under a path-first rule it cannot be
   distinguished from "no place was found" (of 348 `not_applicable` answers, 3 were on a place
   called a path), and a claim that cannot be told apart from ignorance should not be made.

This is a return to the draft specification's §20 (`VERIFIED over 6 discovered paths` — the
claim names its scope) and a departure from its §19, which lists truncated evidence as a reason
for UNKNOWN.

## Alternatives Considered

- **Raise the caps (8 seeds, 8 words, 30 candidates).** Rejected: every requirement already hits
  at least one, and raising the search caps feeds the candidate cap, which is the paid one.
- **Send more evidence.** Rejected by measurement: three times the budget changed no outcome.
- **Count a place as a path whenever Jev names it one, however unsure.** Rejected: VERIFIED stays
  at 0 of 38, because the 56 answers below the bar block every requirement.
- **Also set aside a `violates` that rests on cut evidence** (7 of 38 on its own, 12 with a single
  0.7 bar). Rejected: `violates` is the positive signal this tool exists to raise, and setting it
  aside deletes it, where UNKNOWN keeps it audible. Count is not a reason to spend the safe side.
- **Withhold VERIFIED when only one path was found.** Rejected: the headline states the number,
  so a reader sees `VERIFIED over 1 discovered path (30 of 159 places judged)` and can weigh it.
- **A cheap first pass over every candidate for relevance, then the full question only on the
  paths.** Not rejected — deferred. It is the answer to the candidate cap (the reference layer
  alone offered 117 places where 30 were judged), but it only pays once the rules above are in,
  and it changes the request profile enough to want its own measurement.

## Consequences

- VERIFIED becomes reachable, and its meaning narrows: it is a statement about a listed handful of
  places, not about the repository. Readers who skip the scope line will over-read it. The
  headline and the JSON both carry the counts to make that as hard as possible.
- **False VERIFIED is the risk this takes on** (the draft's §36 calls its rate the most important
  metric): 56 of the 153 path answers sat below the bar and are now set aside. They are listed,
  counted, and shown to J5 — a question that has never run on real data, because no requirement
  ever reached the point of asking it.
- Roughly 18 of 38 requirements stay UNKNOWN, 15 of them because a `violates` answer did not reach
  0.7 or rested on cut evidence. That wall is untouched here and named as the next one.
- The numbers above will move: five of the ten runs compared a commit with itself
  (`--pr` resolved the base of a merge-commit-merged pull request to the head), which a separate
  change fixes first, and the ten are then measured again before and after.
