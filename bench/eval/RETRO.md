# The retrospective measurement, version 2 (issue #89)

**In the retrospective measurement, a requirement is written from material that existed before the
original pull request merged and from nothing else, by an annotator with no tools and a fixed prompt;
a second annotator checks it for anything only the later fix could tell, and it is frozen before the
tool is run. The denominator, the rule for a detection, the tool's version, the minimum sample, the
smallest effect of interest, the guards, the candidate cap and the stop rule are written here before
the first case is scored, and the gate is judged on this measurement's sealed cases alone.**

Changing any of it makes a new version, and a result is compared only with results of its own version.

**Version 2** (before any candidate was examined) added the screen of F — whether it fixed a
failure-handling defect at all; version 1 let through a pull request that only matched a search
phrase — put the steps in the order below, cheapest first, and wrote how the hindsight check is
calibrated and what that calibration cannot see. Nothing was examined under version 1. The
calibration writes one record per attempt, `retro/calibration-v<n>.json`, whatever its verdict; an
attempt that stopped is not taken again under its name, the next is the next number, and the runs
allowed are counted over every attempt. Three attempts on 2026-09-25: the first stopped after 5 runs
(`gh pr diff` refused a diff holding terminal escape sequences), the second after 5 more (`gh api`
refused it too — the change was not tried alone before the run), and the third **passed: 10 of 10
planted names left out, 0 of 10 clean**, after 151 runs, 161 in all of the 250 allowed. (Its record
says 15 were spent before it: the counting added the second record's total, which already held the
first's. 10 were; `nextAttempt` now reads the latest record.) Before the third, the steps that run no
annotator were run over the first 80 candidates alone, to find tool errors without spending a run.
No sealed candidate has been examined.

## The question

Would jev-intent-review, run on a pull request as it was when it merged, have listed a real
failure-handling defect that the repository's own review and CI let through, and that a later pull
request fixed?

This corpus is chosen for having such a defect. It does not estimate how often ordinary pull requests
have one; it estimates whether the tool recovers a share of the defects ordinary review demonstrably
missed that is worth its cost.

## A case

A pair: a later pull request **F** that fixed a failure-handling defect, and the original pull request
**O** that put the defect in. The tool runs on O's base and head — never on the repository after F.

**The gate is judged on sealed cases only.** Dev cases are for practising the procedure and checking
the tools; their rates may be reported, never as the gate. (Dev's candidates are the pull requests and
issues the tool was built and tuned on.)

F merged on or after **2026-07-01** (`retro/search.ts`, `EARLIEST_FIX`): after the training data of the
annotators' model ends, so that the model is less likely to know F. The margin is nil — the data ends
in June 2026 — and an O from before then may be known to the model in its later form. This is a limit
of the measurement and is reported with it.

## Candidates

- **Sealed** candidates come from this measurement's own search (`retro/search.ts`, recorded in
  `retro/search-v1.json` — not #80's `bench/eval/search-v1.json`): #80's four phrases, merged Rust pull
  requests, one range of merge dates at a time, back to 2026-07-01. Each range ends before every range
  already searched begins, so the rows' recorded order is newest first, and its last day is at least
  two days old, so the search index has it. `gh search` returns at most 100 results and says nothing
  when it stops there, so a range where any phrase returns 100 is split in two and searched again, down
  to a single day; a day that still returns 100 is recorded as cut. (Taken first by calendar month,
  September lost about three quarters of its rows to that silent limit: 116 rows kept where the split
  search keeps 451 to the 23rd.) A repository on
  `split.json` or in #80's search is left out: this measurement's repositories are none of #80's, so
  their counts of openings never mix. Only reference, title and merge time are recorded, before any row
  is read. A further range is recorded before any of its rows is read.
- The rows are examined in their recorded order. **One case per repository**: the first of a
  repository's rows to pass every step below is its case; later rows of the same repository are not
  examined.
- **The steps, in order** — those that run no annotator first:
  1. O is found (below, "The original pull request"); a row with none is left out.
  2. The bundle is built (below, "What the writer sees"); a gap makes the case one without a
     requirement.
  3. **F is screened**: F's title, description and the issues it closed, cut at F's merge the way O's
     bundle is, are read by three annotators with `LABEL_SYSTEM` (`retro/prompts.ts`), whose labels are
     `PROTOCOL.md`'s "Labels", word for word. Two of three decide; three different labels make
     `cannot_label`. F is kept when the label is `swallows_as_success`, `falls_back_or_degrades`,
     `logs_or_warns` or `records_or_handles_locally` — the code before F did not bring the failure to
     the caller — and left out, with the label, otherwise.
  4. Caught before the merge (below).
  5. The writer, then 6. the checker (below, "Writing and checking the requirement").
- An annotator's answer that cannot be counted — another model, not JSON, the run failing — is asked
  again up to three times; after that the run over the rows stops, and that row is decided neither way.
- A passed candidate's repository is placed by `split.ts`'s `sideOf`, the salt being the first main
  merge commit holding the batch's verdicts' hashes (below, "Where records live"). A repository that
  another measurement placed first keeps that side and is left out of this one.
- **Cap**: stop when sealed holds 17 repositories, or when 800 rows have been examined. **After the
  first 100 rows have been screened, the yield is measured, and compared with the rows there are**:
  every row of the date floor's ranges (2026-07-01 to the last day searched), searched and recorded
  before the yield is read. If those rows, at that yield, could not reach 17 sealed repositories, stop
  before annotating at scale and report "no evaluation verdict". (Expected yield is about 1 %: the (a)
  step's 27 % on #80, then O found, the checks, and three in four going to sealed; September 1 to 23
  alone has 451 rows.)
- Every examined row is kept with F, O, how O was found, the verdicts below, and why it was kept or
  left out. A hard case is not dropped silently.

## The original pull request

`retro/origin.ts`, in this order:

1. A pull request that F, F's issue or F's commits name as the origin ("regression from #N",
   "introduced in #N", "broken by #N") — when the number is a pull request of the same repository
   whose merge is on the default branch and came before F. "A bug reported in #123" names an issue,
   and a number followed by "of …" or "in …" ("#500 of the tokio crate", "#12 in serde") another
   project's, which is not read as named at all; such a number is passed over for step 2.
2. Otherwise, each line F removed or rewrote, blamed at F's base with `-w -M -C` past commits that
   change only whitespace, and taken to the merged pull request that brought that commit in and whose
   merge commit is on the default branch now (not its base's name: a repository that renamed `master`
   to `main` keeps the old name on older pull requests). **The pull request holding the most of the lines** is O (a tie: the one merged
   first), and its share of the blamed lines is recorded. Not the earliest of all: omamori #553 rewrote
   31 lines of its defect and 8 incidental lines of older code, and the earliest named the older code's
   pull request (#189) where the most names the one the defect came in with (#329, 65 %), measured on
   2026-09-25.
3. A fix that removes no line and names no origin has none; the row is left out, with that reason.

How O was found is recorded, and every result is also given for each way apart. **A case found by 2
has its defect inside O's diff by construction**, so these cases say nothing about whether the tool
reaches beyond the diff; the reach origin of a detection is reported, and read with this in mind.

## Caught before the merge

Three annotators (below) each read O's reviews, review comments, conversation comments and bot reviews
from before the merge, and its check results at the merge, with a one-paragraph description of the
defect, and answer whether any of them pointed at it: the failing call, or what happens when it fails,
in the code the defect is in. Two of three decide. A case caught before the merge is taken out of the
primary numerator and denominator and reported apart. A case whose checks cannot be read is kept, and
counted apart as "checks unknown".

## What the writer sees

`retro/material.ts` builds the one bundle a writer is given, from O as it stood at its merge time:

- the title, with renames after the merge undone;
- the description, as it stood at the merge — read back from its edit history if it was edited later;
  a version deleted from the history is not replaced by an older one;
- comments and review comments published before the merge (`publishedAt`), and reviews submitted
  before it (`submittedAt`, not when they were begun: a review begun before the merge and submitted
  after it was not there), each as it stood at the merge;
- the issues O connected before the merge, or said it closes in its description as it stood then —
  each issue's title, description and comments as they stood at the merge.

**Any gap leaves the case without a requirement**: a text with no recoverable version at the merge, a
list GitHub cut short (more comments or reviews than one query takes), or a number named before the
merge that cannot be read as an issue. The case counts as one whose requirement could not be written —
not detected, in the primary metric — and the gap is recorded (`unavailable`). A failure that is not a
fact about the case — a rate limit, the network — stops the fetch instead.

Nothing of F, F's issue, or anything made after the merge is in it. Every field the writer sees is a
field of the bundle (`BUNDLE_FIELDS`); a test holds the writer's request to them.

## Writing and checking the requirement

Every annotator is `claude -p` as the baseline of `BASELINE.md` runs — no tools, no MCP server, no user
settings, in an empty directory that is not a repository — with a fixed system prompt of
`retro/prompts.ts`, and the bytes each is sent are recorded. No annotator is a session with tools or
with this repository's context. (The adjudicators of the guards below, who may read the repository, are
the ones of `BASELINE.md`, and are not these.)

1. **The writer** is given the bundle and `WRITE_SYSTEM`: requirements about what must happen when an
   operation of the changed code fails, in the forms the tool reads (`docs/writing-requirements.md`),
   **at most three items**, each quoting the sentence of the material it rests on. No requirement that
   is only good practice, no generalisation past a quoted sentence. When the material says nothing about
   failure, the writer answers that no requirement can be written. The same prompt is used for every case.
   The answer is held to that mechanically (`acceptRequirements`): more than three items, an item
   without a quote, or a quote that is not in the bundle word for word (whitespace aside) leaves the
   case without a requirement.
2. **The checker** is another annotator, given the bundle, F and the requirement, and `CHECK_SYSTEM`:
   which words say what only F could tell. **Any such word leaves the case out** as one whose
   requirement could not be written; the requirement is not rewritten.
3. **The check is calibrated before any sealed candidate reaches it** (`retro/calibrate.ts`). The
   material is dev's: the later fixes of `pool.json` that #80 labelled with one of the four kept labels,
   pull requests merged on or after 2026-07-01, one per repository, in the pool's order, through steps
   1, 2 and 5 above (step 4 is not needed to calibrate a check that reads only the requirement and F).
   The first ten cases with a requirement written and a function name to plant are used. **The planted
   requirements are made, not written**: each of the ten written requirements, its first item ending
   "(the call in `name`)", `name` a function F changed (a hunk header of its diff, or a `fn` line it
   removed or added) that is not in the bundle. The twenty are shuffled and checked one by one. The check
   passes when it leaves out at least 9 of the 10 planted and at most 1 of the 10 written. Ten is a check
   that the step works, not an estimate of its rate (9 of 10 has a lower bound of 0.555). Until the check
   passes, no sealed candidate is checked. **What this cannot see**: a name makes hindsight visible, so
   the calibration shows the check catches a name F told; a requirement in the bundle's own words that
   picks the call F picked is not measured by it. Recorded beside it and never in the verdict: the
   twenty checked a second time (how often two runs agree), ten requirements written by an annotator
   shown F (`LEAK_SYSTEM`) and how many the check leaves out, and the screen of step 3 run on each used
   case's F against #80's label for it (the same model family labelled both, so it is no independent
   measure). A recorded answer that cannot be counted, or that the budget cuts, is given up on and
   counted as cut; it never stops the verdict. **Dev's extra material** is searched beforehand the same
   way, kept to the dev side of the split (`retro/search.ts --dev`, recorded in
   `retro/search-dev-v1.json`, never in the sealed search), and its rows are tried after the pool's in
   the same run; they have no label from #80, so for them the screen of step 3 decides, as it will for a
   sealed row. Fewer than ten cases after both, and the calibration stops as insufficient. A
   repository's case is the first of its rows to pass every step; a row that fails leaves its
   repository's next row to be tried. A calibration that cannot go on — an answer the verdict needs
   never counted, the budget reached, the network — stops, and still writes its record with the runs it
   spent. The rule of step 2 stays as
   it is — one checking, any word leaves the case out: checking twice and leaving out only on two would
   leave out fewer cases, and so move the primary metric in the tool's favour.
4. The requirement that passes is frozen before the tool runs on O.

## Scoring

- **The tool's version** is main at the commit the batch's requirements were frozen at, with Jev's
  alias and the versions the host named (`#84`'s `modelIdentity`), recorded with each run.
- **A detection**: the defect's call in O is listed in 3 runs of 3, as `PROTOCOL.md` counts.
- **The primary metric**: detections over **every case that was not caught before the merge —
  including those whose requirement could not be written or was left out by the check, counted as
  not detected** (owner, 2026-09-25). The tool does nothing without a requirement, so a case where one
  could not be written is a defect it would not have listed. The rate over only the cases with a
  requirement is reported beside it.
- **Stages**, with the same interval: the share of cases with a requirement, the share of those whose
  requirement covers the defect's call, and the share of those listed. A detection whose requirement
  does not cover the defect's call is counted apart; without such detections the primary metric is the
  product of the three, so a result below the gate says which stage it failed at.
- The interval is `metrics.ts`'s: each repository one observation, Clopper–Pearson at 95 %, two-sided.
- **Minimum sample**: 17 repositories, as `PROTOCOL.md`'s gates, counted over the primary denominator.

## The gate

**The smallest effect of interest: the lower bound of the primary metric is above 0.20** (owner,
2026-09-25). With one case a repository:

| repositories | 9 | 12 | 17 | 25 |
|---|---|---|---|---|
| detections needed | 5 | 6 | 8 | 10 |

**Why 0.20**: within the tool's own default limits for one pull request — 400 requests, 4 MB, 600
seconds, the provisional cost envelope of `BASELINE.md` — a tool that lists one in five of the
failure-handling defects that review let through is worth running on every pull request; one in ten is
a rate a team would not notice. A lower bound above 0 is never the criterion.

**Guards**, both needed: on the cases scored, the mean number of findings per pull request adjudicated
false (by `BASELINE.md`'s adjudication) is at most 1, and the listed precision — listed calls that are
the defect or adjudicated a real defect, over all listed calls — is at least 0.5, point estimates.

**Cost**: a detection bought beyond the provisional cost envelope is not counted as one.

**Stop rule**: unless the lower bound is above 0.20 and both guards hold, the roadmap does not go on to
#90, #91 or #92. A failed gate is a product result. It is not answered by rewriting a requirement with
what F showed, or by lowering the threshold after a sealed result.

Reported with every result: the primary rate and its interval, the rate over cases with a requirement,
the three stages, how O was found and the rates for each way, the reach origin of each detection, the
cases caught before the merge and those with checks unknown, the cases whose requirement could not be
written, false findings per pull request, listed precision, requests, bytes and time, and the
repositories, cases and runs behind every number.

## Where records live

Dev records are in `bench/eval/retro/`. **Sealed records — F, O, the bundle, the requirement, every
verdict — live on the `sealed` branch of `yottayoshida/jev-review-sandbox`**, as `PROTOCOL.md`'s sealed
cases do. This repository holds only their count and the sha256 of each batch's verdicts; the salt that
places a batch's repositories is the first main merge commit holding that hash.

Opening sealed retrospective cases goes through `bench/eval/run.ts --set sealed open`, on a line of its
own with `#89` in the reason, and is counted per repository with every other opening. **`run.ts` opens
every sealed repository of `split.json` on one line today**, and runs nothing yet (its run is wired with
the second part of #80). Opening only this measurement's repositories on a line of their own is added to
`run.ts` before the first sealed retrospective case is placed; until then no sealed retrospective case
is opened, and none exists.

## Annotator runs

The owner allowed running the annotators of this file with `claude -p` in the form above, which does not
load user-level hooks (2026-09-25). The count grows with the candidates: for each row that reaches it,
three for the screen of F, three for "caught before the merge", one writer and one checker. The yield
check under "Candidates" stops the runs before they go to scale when 17 repositories are out of reach.
**The calibration was allowed 250 runs** (owner, 2026-09-25; expected 136 to 216, answers asked again
included); `calibrate.ts` stops at 250, the N=1 run below counted in them. Before the first run of the
calibration, one writer's run is made, and the workspace's `origin/main`, the length of its `git
status` and the size of omamori's audit log are recorded before and after it. Other sessions work in
the same workspace, so a moved `origin/main` or a longer status is recorded, not taken for this run's;
the calibration does not start when the run left a mark only it could — an auto-backup commit (the
hook `claude -p` would fire if it loaded user settings), or the audit log naming the run's directory —
or gave no answer to count. The runs for sealed rows are asked for, as a number, before they start.
