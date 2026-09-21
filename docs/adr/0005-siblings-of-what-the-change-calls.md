# 0005. Past the changed functions: the other callers of what the changed code calls, on a budget of their own

Status: Accepted

## Context

`--experimental-local-check` reads the functions a change touched and the functions that call them,
one hop out (`src/plan/from-diff.ts`). The README's first claim is about the case this cannot
reach: "a new rule may be implemented in one API path but missed in another." A sibling path — a
function that uses the same repository helper as the one the pull request fixed, and calls nothing
the pull request touched — is outside both lists by construction. Every published measurement of
this path placed its defects in changed functions (issue #37).

Starting from the requirement's words was tried and did not reach the mechanism: the calls chosen
for omamori PR `#476`'s requirement echoed its words (`read_link`, `reject_symlink`,
`is_symlink`) and never the shared read where the fix was (`docs/candidate-set.md`). The
requirement names a symptom; the code is organised by mechanism.

The ordinary review path already has a finder for this shape (`discover.ts`, the reference layer:
other callers of what the changed code calls), with seeds taken rarest first. Measured on the same
pull request, that order cannot reach a shared helper: of 125 followable names, the first eight were
each used in one file only, and the shared helper came 83rd. A shared helper is used in many files
by definition. 73 of the 125 had no definition in the repository, so a sibling tied to them would
have its tying call held before any question (`src/plan/applicability.ts`).

## Decision

- **The change is the bridge; the requirement decides.** Places are found from the calls the
  changed code makes. Whether the requirement governs a call stays the existing mapping question to
  Jev. Nothing is found by the requirement's words, and the report says so.
- **Seeds are callees a question can be put to.** A name called in a changed region outside tests
  (added lines, removed lines and the changed block's body), defined exactly once outside tests,
  returning a `Result`, whose definition is not itself a changed function. A helper the pull
  request adds is a changed function; its callers are read one hop out, not as siblings.
- **Seed order:** called on a changed line first, then called from more changed regions, then used
  in fewer files, then by name; at most 8. A name used in more than 20 files is not followed. Seeds
  left out are named in the notes.
- **A sibling** is a function whose enumerated calls include one whose callee ends in a seed's name,
  that returns a `Result`, and that calls no changed function by a name defined once in the
  repository. A changed function's name defined more than once (`open` in one type of several)
  does not rule out a caller of that name: the call may reach another definition. The changed
  names are those of the Rust functions the change touched outside tests. Text matches in comments
  and strings do not make a sibling; a function whose call list hit the enumeration's per-function
  cap is not a sibling, because what it calls is not fully known. At most 20 siblings.
- **A budget of its own.** The existing budget (20 per requirement) and the order within it are
  untouched, and every requirement's first budget is asked before siblings are even looked for —
  the run's own request, byte and time limits are shared by all requirements — so the calls asked
  about in changed functions and their callers are the same set as before. Siblings get a second
  budget (10 per requirement), spent one function at a time in seed order, and within a function
  the call that tied it to the seed first — that is where a missed path's defect sits, and it is
  askable by the conditions above.
- **Nothing new is asked of Jev during the search.**
- **A run that reaches its own request, byte or time limit still reports**, with the calls it did
  not ask listed as unchecked and the stop stated at the top of the report and as `stopped` in the
  JSON; it exits 0, as the ordinary path does for a run that stops on its own budget. Before this, a
  limit reached at the observation question ended the run with exit 12 and no report, and one
  reached at the mapping question was recorded as an unanswered mapping.

## Alternatives Considered

- **Search by the requirement's words.** Rejected by measurement (above).
- **Copy the ordinary path's seed order (rarest first).** Rejected by measurement: it cannot reach
  a shared helper.
- **Tie siblings by `git grep` hits.** Rejected: on the development case three functions matched
  only in a comment or a string literal and would have taken sibling budget.
- **One budget for everything, shared out by order.** Rejected: calls in changed functions would be
  crowded out, and the measurement this path's claims rest on would no longer describe it.
- **Spend the second budget on the near calls the first budget left over** (17 of 37 askable calls
  on the development case). Deferred to #38, whose question is exactly how near and far places
  share a budget and how the budget grows with the pool.
- **Two hops of callers; other definitions of a changed function's name.** Not in this change. The
  second found nothing on the development case and would add trait implementations as noise; the
  first spends on distant places while near ones are left unread.
- **A cheap first question to Jev over every candidate.** Deferred to #38 (ADR 0002 deferred it for
  the same reason: it changes the request profile and needs its own measurement).

## Consequences

- A sibling that shares only a function with no definition in the repository (a standard-library
  call) is not reached. The missed path of omamori PR `#476` is of that kind — the remaining direct
  calls to `fs::read_to_string` — and it is a missing guard before an action, which the failure
  question cannot ask about (#39).
- The requests per requirement can rise from 40 to 60. A run that hits its limit now reports and
  exits 0 instead of exiting 12; the report says it stopped.
- The order inside the second budget and how the two budgets combine are a first version. #38
  measures ordering against known defects as the pool grows and is expected to replace both.
- Relations are by name. The notes count, by kind, the names that could not be tied (no definition,
  several, not a `Result`, a changed function, only in tests, too common, over a cap) and the
  functions whose call list was cut. That record is what decides whether a parser is needed.
