# The acceptance set (issue #36)

Which side of the evaluation protocol each of these cases is on — every one is dev — is decided by
`bench/eval/split.json`, not by a case's `role` (`bench/eval/PROTOCOL.md`).

Everything v0.1 claimed before this set rested on one measurement: omamori `#468`, two
requirements, five branches, one run each — and the wording of the questions was worked out on
those same functions. This directory holds cases that were **not** used to tune anything, and the
rules for choosing, building and scoring them. The rules are committed before the first request
and are not changed after it; a change makes a new version of the measurement.

## Choosing cases

`candidates.json` lists every candidate examined, in order, with the verdict and the reason. A
candidate counts as examined once its issue or pull request text is read. The requirement sentence
is written from that text **before the fix's diff is opened**, and committed; the commit history
shows the order.

A case is kept only if all four hold:

- **(a)** the requirement can be written as "a failure must reach the caller as an error, not as a
  success, an empty value or an absence" — the only property v0.1's two questions can express;
- **(b)** on the pull request's base..head, `--candidates-only` puts the fixed call on
  the side a question can be put to;
- **(c)** the behaviour difference of a defect can be observed in a throwaway clone, with no network
  and no credentials, through one crate's test or example;
- **(d)** a function outside the diff is governed by the same requirement.

The set is the first three that pass, from at least two repositories. If twenty examined
candidates do not yield three, the work stops there and says so, and goes on only on the owner's
ruling, recorded in `candidates.json` (`gateExtension`). This set went on twice: the cap was raised to
forty, and at forty, with two cases passing, the owner chose to measure those two. (The clause
about the owner's ruling and the sentence after it were added after the measurement; the rulings
they describe were given before the first request.) Candidates that fail are counted:
how often a real repository's failure handling fits v0.1's question is itself a result.

The same requirement on another function does not count as a second requirement. A case that is
used to fix anything becomes a regression case from then on and is never counted as unseen again.

Used so far:
- **moltis-1064 and grovedb-500, measured again after `#38`** (`bench/logs/acceptance-v4.json`,
  `docs/local-check-cli.md`, *The acceptance set after `#38`*): the check that every defect at A or
  B is asked about inside the default budget and answered in three runs of three. How the budget is
  split (ADR 0015) was chosen by where these cases' targets fell, so this is a regression check of
  it, not evidence for it. `run.ts measure` names its log since: `sibling` writes v3, whose claim is
  one sibling's defect (`#37`), and `again` writes v4.

- **The same 20 runs again, with grovedb-500 and whatsapp-rust-759 against Jev**, judged the cap of
  calls a function (`#38`, second part; `docs/local-check-cli.md`, *The calls of a function,
  measured*; `bench/logs/budget-by-origin-v2.json`, `bench/logs/calls-per-function-jev-v1.json`).
  `candidates.json` says grovedb-500's `apply_chunk` "lists exactly 40" and whatsapp-rust-759's
  fixed file hit the listing cap: both are true of the tool they were examined with, and the record
  is not rewritten.

- **kontor-385, again, with every case of the pre-check and omamori `#468`'s five branches**, chose
  how the budget is split (`#38`, ADR 0015; `docs/local-check-cli.md`, *The budget*): orders of one
  shared budget were compared on those 20 runs, with and without the listing's caps, by where the
  known targets fell and by what the diff's own calls lost, and the owner chose a budget of the
  callers' own after that comparison. Those runs are what the split was judged by
  (`bench/logs/budget-by-origin-v1.json`), and none of them is free evidence for it.

- **kontor-385** chose the order inside a function (the calls into a function the change touched
  first; `docs/local-check-cli.md`, *The order inside a function*). It has no `case.json` — it
  stopped at condition (c) and was never built or sent to Jev — so this line is the record.
- **moltis-1064, kontor-385 and grovedb-501** were what the whole-signature reading was built on
  (`#45`, first part; `docs/local-check-cli.md`, *Reading whole signatures*). moltis-1064's
  `case.json` says `regression` since the re-run after `#45` (`acceptance-v2.json`).
- **grovedb-500**, with moltis-1064, was what the order inside a function and the whole-signature
  reading were judged by: "every defect inside the diff stays inside the budget" named both cases'
  versions (`docs/local-check-cli.md`, *The order inside a function*, *Reading whole signatures*).
  Its `case.json` says `regression` since the same re-run.
- **cce-rust#168 and dataprof#370** — two pull requests outside this set — were what the narrowing
  of a name defined more than once was built on (`#45`, second part; `docs/local-check-cli.md`,
  *Names defined more than once*). They have no case here; this line is the record, and they are
  not free evidence for anything that narrowing decides from now on.

A case's role is also written into the log of each measurement, as it was when that measurement
was taken, and `replay.ts` reads it from there: `acceptance-v1.json` records none, because both of
its cases were unseen then, and its table is still the table of two unseen cases.

## Building a case

Each case is a directory under `cases/` with `case.json`, the requirement as a spec file, one patch
per version, and the record of each probe. Branches are built in a throwaway clone; nothing is
branched in a repository someone works in.

Four versions per requirement:

| version | what it is | expected |
|---|---|---|
| shipped | the pull request's head | the target is not listed |
| defect | a failure at the target call turned into a success; the difference observed by running it | the target is listed |
| rewrite | the target's code written differently, behaviour unchanged | the target is not listed |
| hidden | the decision moved into a helper that returns a `Result` and is returned with `?`, so the target's body alone allows either answer | `cannot_determine` or below the bar; a confident answer either way is wrong |

Defects sit in one of three kinds of place:

- **A** — a function the pull request changed. Applied to the head only.
- **B** — an unchanged function that calls one the pull request changed (the README's example, "an
  unchanged caller still converts the same failure into a successful result"). Applied to **both
  the base and the head**: a defect outside the diff is one the pull request did not fix, and one
  applied to the head alone puts its own line into the diff.
- **C** — a function that is neither. Applied to both. v0.1 enumerates changed functions and their
  callers one hop out, so C is outside its reach by construction; its result is settled by the
  pre-check and no request is spent on it.
- **S** — a sibling of the change (ADR 0005): a function that calls what the changed code calls and
  nothing the change touched. Applied to both. Its place is fixed by the rule `placeS` of
  `candidates-v2.json`, from the repository's text and `git grep`, before the tool is run on the
  candidate — so whether the tool reaches it would be measured, not chosen. No case has been built:
  the search of `candidates-v2.json` ended at its limit of 30 with none (its `outcome`). A case found
  later is measured in `acceptance-v3.json`, whose table claims one sibling's defect and no more
  (`replay.ts` refuses a version of that log placed anywhere else, and does not hold it to two
  repositories).

Every version must change the same set of functions — compared as `(path, name)`, since function
ids are positional — as the shipped version. That is checked from the diff before the branch SHAs
are fixed; a version that fails the check later is dropped and counted, not rebuilt. B and C
targets are fixed from call relations found with `grep`, before `--candidates-only`
is run, so a target cannot be chosen from what the tool already reaches.

## Scoring

A target is one call: file, function and the full expression. It must occur exactly once in the
whole file at the fixed commit, found with `enumerate`; if not, the case is not used. The stages,
each counted on its own:

1. enumerated by the tool (a target absent while a cap's note is present is "cap or structure,
   undetermined"; with no such note, "not enumerated")
2. a question could be put to it (the reason's kind, taken from `applicabilityOf`, not from prose)
3. inside the budget
4. its body fitted and the call was located (these happen after the budget)
5. an answer came back (`no_answer` is its own stage)
6. the answer cleared the bar of 0.6
7. the answer was right

Another call in the same function being listed does not count as reaching the target. Calls other
than the target that get listed are not scored — whether each is a real defect or a false one is
not known without reading it — and are counted with their place.

Each cell is written `k/3`, and only 3/3 counts as agreeing with the table. The first three runs
that finished are used; a run that stopped is recorded and not counted.
