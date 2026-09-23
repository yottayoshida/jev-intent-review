# 0005. Past the changed functions: the other callers of what the changed code calls, on a budget of their own

Status: Accepted

Amended by [0015](0015-the-callers-have-a-budget-of-their-own.md): what this record calls the first
budget is two budgets since — the functions the change touched and their callers one hop out — and
the siblings' is the third. Siblings are still asked last and are still counted apart.

## Context

The local check reads the functions a change touched and the functions that call them, one hop out
(`src/plan/from-diff.ts`). The README's first claim is about the case this cannot reach: "a new
rule may be implemented in one API path but missed in another." A sibling path — a function that
uses the same repository helper as the one the pull request fixed, and calls nothing the pull
request touched — is outside both lists by construction (issue #37).

Starting from the requirement's words was tried and did not reach the mechanism: the calls chosen
for omamori PR `#476`'s requirement echoed its words (`read_link`, `reject_symlink`,
`is_symlink`) and never the shared read where the fix was (`docs/candidate-set.md`). The
requirement names a symptom; the code is organised by mechanism.

A first version of this decision was built on the tool of `#36` (draft PR #46). Since then, whether
a call can be asked about came to be read from whole signatures, `Result` aliases, the narrowing
of a name defined more than once and a table of functions outside the repository (`#45`). A second
reading of "what does this call reach, and does it return a `Result`" for the siblings alone would
have taken seeds that reading does not ask about and dropped ones it does. This version is built on
the tool of `#45`.

## Decision

- **The change is the bridge; the requirement decides.** Places are found from the calls the
  changed code makes. Whether the requirement governs a call stays the existing mapping question to
  Jev. Nothing is found by the requirement's words.
- **One reading of a call.** `applicabilityOf` is split into `targetOf` (whether the calling
  function returns a `Result`) and `calleeOf` (where the callee settled — one definition here,
  several read as one thing, a row of the outside table, or nowhere — and whether it returns a
  `Result`), and composed of the two with every kind and reason unchanged. Seeds, the calls that tie
  a sibling, a sibling's own return type and "calls no changed function" are all decided by these.
- **Seeds are functions of this repository a question can be put to.** A name the changed code
  calls outside tests whose call settles at one definition here that returns a `Result` and is not a
  changed function. A name on a removed line counts too — a fix that replaced one helper with
  another may have missed the old helper's other callers — and is settled by its definitions at the
  after commit, since that is where its siblings are. A function outside the repository, or one
  written several times as one thing (a trait's method, a function per platform), is not a seed.
- **Seed order:** called on a changed line first, then called from more changed functions, then
  used in fewer files, then by name; at most 8. A name used in more than 20 files is not followed.
  Seeds left out are named in the notes.
- **A sibling** is a function outside tests, not already read one hop out, with a call that settles
  at a seed, that returns a `Result`, and none of whose calls settles inside a changed function — nor
  settles nowhere under a changed function's name, since that call may be the one that reaches it.
  A function whose call list hit the per-function cap is not a sibling, because what it calls is not
  fully known. At most 20.
- **Only the failure form's shape.** Seeds and siblings are chosen by returning a `Result`. A
  requirement that a check pass before an action is asked about siblings chosen that way too, and a
  helper that returns `()` — a delete, say — is no seed for it. How that form should choose its
  places is #39's (owner's ruling, 2026-09-23).
- **Last, on a budget of its own.** The first budget (20 per requirement) and the order within it
  are untouched. Siblings get a second budget, 10 per requirement, spent one function at a time in
  seed order and, within a function, the calls that tied it first. They are asked after everything
  else the run asks — every requirement's first budget and the changes' questions — because they
  share the run's request and time limits with both (owner's ruling, 2026-09-23).
- **Nothing new is asked of Jev during the search.**

## Alternatives Considered

- **Search by the requirement's words.** Rejected by measurement (above).
- **Copy the ordinary path's seed order (rarest first).** Rejected by measurement: on PR `#476`
  the shared helper came 83rd of 125 names.
- **Keep draft PR #46's own reading** (a name defined once, and a pattern over its signature).
  Rejected: two readings of the same question, one of which the rest of the tool no longer uses.
- **Rule out a sibling by a changed function's name defined once, as draft PR #46 did.** Rejected:
  where the call settles is known now, and a call that settles nowhere under that name is exactly
  the one that cannot be ruled out.
- **Siblings before the changes' questions**, as draft PR #46 had them. Rejected by the owner: they
  would take requests and time from a question the tool already ships.
- **Choose places per form.** Deferred to #39 (above).
- **Tie siblings by `git grep` hits.** Rejected: on the development case three functions matched
  only in a comment or a string literal.
- **One budget for everything.** Rejected: calls in changed functions would be crowded out.
- **Two hops of callers; a cheap first question to Jev over every candidate.** Deferred to #38.

## Consequences

- A sibling that shares only a function outside the repository is not reached. The missed path of
  omamori PR `#476` is of that kind — the remaining direct calls to `fs::read_to_string` — and it
  is a missing guard before an action (#39).
- A function that calls a changed `impl` of a trait's method, or a changed platform version of a
  function, can be a sibling: such a call settles at the versions as one thing, not at the changed
  one.
- Up to 20 more requests a requirement. They are the last the run sends, so a run that reaches its
  limit there has asked everything it asked before this. A sibling's call the limit left without an
  answer is read as the first budget's are — withheld, not settled — and one the budget did not
  reach is under *Not checked*.
- A sibling's calls that were held or left out are under *Not checked*. The GitHub Action's check
  run is green only when nothing is left there, so a pull request whose run was green before can be
  neutral now. A finding in a sibling is a finding: under `policy.fail_on: [finding]` it exits 1.
- The report's first line and the check run's title count the siblings with everything else: a
  call read in a sibling is a call read, so a finding there is never "worth checking of 0 read".
  The per-requirement counts in `--json` keep the first budget's meaning, with the siblings'
  under `counts.siblings`.
- The order inside the second budget and how the two budgets combine are a first version. #38
  measures ordering against known defects as the pool grows.
- Relations are settled by the same reading as everything else, and the notes count, by kind, the
  names that could not be tied and the functions turned away. That record is what decides whether
  a parser is needed.
