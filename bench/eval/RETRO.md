# The retrospective measurement, version 9 (issue #89)

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

**Version 3** (before any sealed row was read) says what version 2 left open and moves where the
sealed records live. A row is a case once O is found, F's own material is complete and the screen
keeps F; the writer and the checker are not filters — a case whose requirement is not written or is
left out is still a case, not detected, as *Scoring* counts it. A case caught before the merge is its
repository's one case, placed like the others, and out of the primary denominator and the 17. The
yield is counted in repositories, and the rows it is compared with stop at the cap of 800. The inputs
of "Caught before the merge" are named, and the runs are allowed in whole rows. The sealed records
move from the sandbox's `sealed` branch to its `batches` branch, as `PROTOCOL.md` rule 5 keeps #80's.

**Version 4** (before any row of `b1` was decided; the dry pass of steps 1 and 2, which sends nothing to
a model, had been run and counted only) says what to do with a fix whose diff GitHub does not serve —
four of the first 100 rows answer HTTP 406, too large, every time: F's material is not complete, and
the row is left out (owner, 2026-09-27). It is found when F is fetched, before step 1, so such a row
is counted under that reason even when it has no O. The clones are full clones, and a clones directory
holding a partial one is refused: `blame -C` fetched a file at a time from a `blob:none` clone, and one
line's blame took 22 s against 0 s in a full clone.

**Version 5** (rows 1 to 18 of `b1` decided, row 19 not) caps what one request may send at
600,000 bytes: `claude -p` takes the request as an argument, the system's limit on one is 1 MB, and
row 19's check came to 1.4 MB, so the run stopped on it. A request over the cap is not sent, spends no
run, and counts against the tool (owner, 2026-09-27): the screen's leaves the row out, as a fix whose
material cannot be read; "caught before the merge" counts as not caught, so the case stays in the
primary denominator; the writer's or the checker's makes the case one whose requirement could not be
written. The largest request of rows 1 to 18 was 445,233 bytes, so none of them is decided differently.
A case counted as not caught this way counts as not caught in the yield check as well, where it leans
toward going on. The steps and bytes of a request not sent are kept in the row's record (`notSent`).
The cap is for the machine the annotators run on (macOS, whose limit is on all arguments together;
Linux limits one argument to 128 KB, and a run there needs its own cap).

**Version 9** (while the sealed targets were being named, eight named and none of them read) adds a
reason a target is not named: an O that GitHub no longer has. The naming stopped on it at its ninth case
— the pull request answers 404, so its range cannot be taken — and the screen had counted the same
thing as a gap in O's bundle. It is counted against the tool, as every other reason is, and the naming
goes on from the ninth case; the eight before it are not asked again (owner, 2026-09-28).

**Version 8** (before any target was named) takes out, for the sealed targets, the runs the command
printed: the number of answers that reached the checker could be worked out from them, and with it how
many targets were named. Nothing about scoring changes.

**Version 7** (after `b2` and its placing, before any target was named or any sealed case opened, and
before any tool was run on one) writes down how a case is scored, all of it before anything that could
show a result: which 17 are opened, the tool's one version, how the defect's call — the target — is
named from F and frozen, how it is matched against what the tool lists, how the guards and the cost are
counted, and what is reported (below, "Opening and targets" and "Scoring"). The target is named by an
annotator and checked by another (owner, 2026-09-28); only their answer is frozen, and the tool first
meets a sealed case inside its run.

**Version 6** (after `b1`, before any repository was placed) changes when this measurement's opening is
written and where its cases stay; nothing about how a row is examined. `run.ts` no longer opens every
sealed repository of `split.json`: #80's opening takes #80's repositories only (`sealed.ts`, `openSet`,
held by a test that places a #89 repository beside them), so placing this measurement's repositories
mixes nothing into #80's openings. Opening them is added to `run.ts` together with their run, not
before it: an opening written first would be checked against files the run then changes, and a
repository's openings are counted for good, so one spent that way is never given back (owner,
2026-09-27). The cases stay on the sandbox's `batches` branch, where the verdicts' sha256 on main
already holds them; version 3 had them moved to `sealed` or `dev` once placed, which added nothing.

**Batch `b1`** (rows 1 to 100, 2026-09-27; verdicts in the sandbox, sha256 in `sealed-batches.json`):
72 repositories read, 19 with a case — 1 of them caught before the merge — so `c = 18`, `r = 72`, and
with `M = 552` the projection is 103.5 repositories (64.3 at the lower bound of `c/r`): **the yield
check goes on**. Of the 19 cases, 14 had a requirement written and kept by the check, 3 had none the
writer could write, 1 had a gap in O's bundle and 1 a request over the size. Left out: 39 screened as
not failure handling, 5 as propagating and 1 as other, 17 without O, 7 whose fix's material was not
complete, and 12 later rows of a repository that had its case. 308 annotator runs of the 500 allowed
(owner), the N=1 runs and the diagnosis of rows 19 and 63 included. The run stopped four times — row
19's request over the argument limit (version 5), row 63's screen answering what was not JSON four
times, and two failures of GitHub or the network — and was resumed each time at the row it stopped on.
Its 19 case repositories are placed by the salt `52d60c0` (the merge of #127, the first main merge
commit holding the batch's sha256): **13 sealed, 6 dev**. The case caught before the merge is on the
sealed side, so 12 of the 13 count toward the 17. Sealed is short of 17, so the next batch reads on from
row 101.

**Batch `b2`** (rows 101 to 200, 2026-09-28): 77 repositories read, 23 with a case — 3 caught before
the merge. Of the 23, 16 had a requirement written and kept by the check, 6 had none the writer could
write, 1 had a gap in O's bundle. Left out: 33 screened as not failure handling, 6 as propagating, 2 as
other and 2 as `cannot_label`, 13 without O, 3 whose fix's material was not complete, 2 not pull
requests, 1 whose screen request was over the size, and 15 rows of a repository that had its case
(b1's among them). 339 annotator runs of the 500 allowed (owner); the run was stopped once by the owner
at row 172 and resumed there. Its repositories are placed by the salt `6924dc7` (the merge of #135):
**22 of its 23, 15 sealed and 7 dev**. The 23rd, `randomcash/ethpayserver`, had a row read in `b1` that
was no case and a row in `b2` that was; `PROTOCOL.md` rule 5 salts a repository by the first batch that
read one of its rows, so that its side is drawn once, and `b1` kept 19 without it. It is not placed and
its case is not used (owner, 2026-09-28): neither rule was changed to fit one repository, and its side
was not looked at before deciding. `b2` therefore has 22 of its `kept` 23 on the split, and
`screen.ts` refuses a next batch — which the cap does not call for.

**The sealed side now holds 24 repositories with a case not caught before the merge (b1's 12, b2's
15 less the 3 caught), over the 17 the cap stops at**, so no further batch is read. Which 17 are opened is
written in version 7 (below, "Opening and targets").

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
- The rows are examined in their recorded order, in batches (`retro/screen.ts`; the first, `b1`, is
  rows 1 to 100). **One case per repository**: the first of a repository's rows that is a case is its
  case — caught before the merge or not — and its later rows are skipped, recorded so and counted among
  the rows read. A row that is not a case leaves its repository's next row to be examined.
- **A case** is a row whose O is found (step 1), whose F's own material — F's bundle, built as O's is
  (below, "What the writer sees") and cut at F's merge — is complete, and whose F the screen keeps
  (step 3). What
  follows cannot take a case away: a gap in O's bundle, a writer that writes nothing or breaks the
  rules, and a requirement the checker leaves out each make a case "whose requirement could not be
  written", not detected (*Scoring*). Step 5 is run on every case in the batch — except one whose
  O's bundle has a gap, which has nothing complete to write from — and step 6 on every requirement
  step 5 writes, so that a batch's verdicts are final when they are hashed. An O that GitHub no longer has is such a gap.
- **The steps, in order** — those that run no annotator first:
  1. O is found (below, "The original pull request"); a row with none is left out.
  2. The bundle is built (below, "What the writer sees"); a gap makes the case one without a
     requirement.
  3. **F is screened**: F's bundle — its title, description, comments, reviews and the issues it
     connected, cut at F's merge the way O's bundle is (a gap in it, or a diff GitHub does not serve,
     leaves the row out: it falls before the side is known) — is read by three annotators with `LABEL_SYSTEM` (`retro/prompts.ts`), whose labels are
     `PROTOCOL.md`'s "Labels", word for word. Two of three decide; three different labels make
     `cannot_label`. F is kept when the label is `swallows_as_success`, `falls_back_or_degrades`,
     `logs_or_warns` or `records_or_handles_locally` — the code before F did not bring the failure to
     the caller — and left out, with the label, otherwise.
  4. Caught before the merge (below). It does not leave the row out.
  5. The writer, then 6. the checker (below, "Writing and checking the requirement"). Neither leaves
     the row out.
- A repository on `split.json` when the row is read — placed by another measurement — is left out,
  recorded so.
- An annotator's answer that cannot be counted — another model, not JSON, the run failing — is asked
  again up to three times; after that the run over the rows stops, and that row is decided neither way.
- A passed candidate's repository is placed by `split.ts`'s `sideOf`, the salt being the first main
  merge commit holding the batch's verdicts' hashes (below, "Where records live"). A repository that
  another measurement placed first keeps that side and is left out of this one.
- **Cap**: stop when sealed holds 17 repositories, or when 800 rows have been examined. **After the
  first 100 rows have been screened, the yield is measured, and compared with the rows there are**:
  every row of the date floor's ranges (2026-07-01 to the last day searched), searched and recorded
  before the yield is read. If those rows, at that yield, could not reach 17 sealed repositories, stop
  before annotating at scale and report "no evaluation verdict". In repositories, as the 17 are counted
  (version 3): of the `r` repositories batch `b1` read, `c` had a case not caught before the merge;
  `M` repositories are among the first 800 rows of the search in its recorded order, the cap. A
  repository on `split.json` — another measurement's, a fork's `readAs` included — is in neither. Go on
  when `c/r × M × 3/4` is at least 17 — read as `3·c·M ≥ 68·r` in integers — and stop otherwise. The
  point estimate decides; the same projection at the Clopper–Pearson lower bound of `c/r` is reported
  beside it. A batch that did not decide all its rows gives no verdict. (Expected yield is about 1 %: the (a)
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
from before the merge — those of O's bundle — and its check results at the merge — the check runs and
commit statuses of O's head that had finished when it merged (`retro/checks.ts`) — with the defect as
F's own bundle describes it, F's title and description as they stood at F's merge, and answer whether any of them pointed at it: the failing call, or what happens when it fails,
in the code the defect is in. Two of three decide. A case caught before the merge is taken out of the
primary numerator and denominator and reported apart. A case whose checks cannot be read is kept, and
counted apart as "checks unknown"; a pull request with no check at all is counted apart as "checks
none" (one whose checks had not finished by the merge is read, with none of them). Every run of a check
is read, not only the latest: a run again after the merge does not hide the one before it.

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

## Opening and targets

- **The cases opened** are this measurement's sealed repositories on `split.json` whose case was not
  caught before the merge, in the order of their case's row, the first 17 (owner, 2026-09-28). For
  this measurement this takes the place of `PROTOCOL.md` rule 7, which does not set cases caught before
  the merge aside first. The rest are not opened and not counted as opened. The run works the 17 out
  again from the verdicts and the split and refuses when they differ from the list frozen with the
  targets (`batches/89-targets.json`).
- **The target** of a case — the defect's call in O — is named by an annotator (`TARGET_SYSTEM`, the
  annotators of "Writing and checking the requirement": `claude -p`, no tools, a fixed prompt). It is
  given F's bundle (title and description), F's diff, and each Rust file F changed as it stands at the head
  O is measured at (below, "A case is measured") — under F's base name when F renamed it — and answers with one call as `{file, function, call, quote}`.
  Another annotator (`TARGET_CHECK_SYSTEM`) is given the same and the answer, and says whether that is
  the call F fixed. A request over the size of version 5 is not sent. An answer that cannot be counted is
  asked again three times; an answer never counted here makes the target not named (where the
  screen, above, stops instead: a target is one case's, and nothing downstream waits on it). **A case
  whose target is not named** — the checker does not agree, no call is named, a call without `(`, a
  request over the size, an answer never counted, or an O that GitHub no longer has (version 9) — is
  not detected in the primary metric, and
  counted apart. So is one whose target the run does not find in O's head before measuring: no file
  whose path ends, segment by segment, with the target's, no function of that name in it, or no call
  in that function that matches the target (below).
- **Only the answer is frozen.** No tool is run on a sealed case before its opening (`PROTOCOL.md` rule
  3). The answers go to the sandbox's `batches` branch as `batches/89-targets.json`, which also holds
  the sha256 of `b1`'s and `b2`'s verdicts; its sha256 goes on main in `bench/eval/retro/frozen.json`,
  lines only added. **The sealed targets are named once.** For the sealed ones the command prints the sha256 and
  whether the runs stayed within those allowed — not how many were named, nor its runs, from which the
  number of answers that reached the checker, and so how many could be named, can be worked out (version
  8); both are written in the sandbox. A case is named once: a run that stops keeps each case named so
  far and a later one goes on from the next, and a line of `frozen.json` for them refuses a new naming. Naming
  them again is a new version of this file. Before the sealed ones, the step is tried on this
  measurement's dev cases and its yield counted; below two in three named there, `TARGET_SYSTEM` is
  changed on dev before the sealed ones are named — at most twice; after that the sealed ones are
  named with it as it is. The first dev attempt (2026-09-28) named 7 of 13; of the six not named, three
  were defects outside Rust (a workflow, a shell script, a benchmark's configuration) that the tool
  cannot list, one was no failure-handling defect, one had its call in a file F created, one was over
  the size. The first change gives the annotators Rust files only and asks for a Rust call with its
  parentheses (`TARGET_PROMPTS_VERSION` 2). The second dev attempt named 6 of 13: the five not named for
  having no Rust file of F are the three defects outside Rust, the call in the file F created, and one
  the first attempt had named in TypeScript, which the tool could never have listed; the others are the
  one that was no failure-handling defect and the one over the size. So both attempts named the same six
  targets the tool can list. What stands in the way is not the prompt's wording, so the second change is
  not used, and the sealed targets are named with version 2 (owner, 2026-09-28).

## Scoring

- **The tool's version** is the head of the opening line (`run.ts`'s): the tool is built there, and
  enumerates and lists every case at that one version (version 7; up to version 6 it was main where each
  batch's requirements were frozen, which is two commits for two batches). Jev's alias and the versions
  the host named (`#84`'s `modelIdentity`) are recorded with each run.
- **A case is measured** on what O put on the default branch: from the parent of the first commit O
  brought onto it, following first parents, to the last — its merge commit when merged with one, its one
  commit when squashed, the last of its commits when rebased (a pull request merged with a merge commit
  has its head already on the branch, so a merge base with it would be O's head itself). A case without
  a requirement is not run.
- **Matching the target** against a run's list, at the run's version: the file when one path ends,
  segment by segment, with the other — the shorter of the two with at least two segments, unless it names
  the only file of that name at that version; the function by the last segment of its path; and the call
  once both calls are brought to the same form — spaces taken out, a final `?` or `.await` dropped, a
  receiver before the called name at the top level (such as `self.`) taken off, and a path before it cut
  to its last segment (`crate::a::Foo::new(x)` to `Foo::new(x)`), since the tool lists a call without its
  receiver and an annotator quotes it as written. When only one side has a path, the path is taken off
  that side. The two forms must then be equal on their first 200 characters (the tool keeps no more of a
  call), so `or(x)` does not match `unwrap_or(x)`, `a::f(x)` does not match `b::f(x)`, and the inner half
  of a nested call does not match the outer. A call with no `(` never matches. Every requirement's
  list counts, and all of it (not the first five, which `compare.ts` keeps for `#88`); a run in which two
  listed rows match is one hit.
- **A detection**: the defect's call in O is listed in 3 runs of 3 — under any requirement in each, not
  necessarily the same one. A case whose three runs did not all finish in five attempts is not
  detected, counted apart, and the run goes on to the next case: for this measurement this takes the
  place of `PROTOCOL.md`'s stopping the run, since a case's attempts are its own and the openings are
  counted for good.
- **The primary metric**: detections over **every case that was not caught before the merge —
  including those whose requirement could not be written or was left out by the check, counted as
  not detected** (owner, 2026-09-25) — a requirement not sent for its size (version 5) among them. The tool does nothing without a requirement, so a case where one
  could not be written is a defect it would not have listed. The rate over only the cases with a
  requirement is reported beside it.
- **Stages**, with the same interval: the share of cases with a requirement, the share of those whose
  requirement covers the defect's call — in the tool's own enumeration at the run's version, taken once
  a case for each of its requirements, a row that matches the target by the rule above is within the
  budget of what it asks — and the share of those listed. A detection whose requirement
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
Counted per case over the union of its finished runs' lists (three, or fewer when five attempts did not
finish three), a call once (`(file, function, call)`): the calls that match the target are the defect;
every other call is adjudicated by `BASELINE.md`'s adjudication with no baseline's findings, against the
first requirement, in the spec's order, it was listed under. False findings per pull request are over
the cases that were run — every case with a requirement, its target named or not; the precision is
over every case's calls together. A call the adjudicators could not decide counts against the tool in
both: as a false finding, and as not a real defect. A call the adjudication folds into another as the same sentence counts once, as the
adjudication does.

**Cost**: a detection bought beyond the provisional cost envelope is not counted as one. The tool's own
limits for one pull request are the envelope's 400 requests and 4 MB, and a run cut short there does
not finish, so it is not one of the three runs a detection needs. The run records each run's time, and
the 600 seconds are reported, not checked.

**Stop rule**: unless the lower bound is above 0.20 and both guards hold, the roadmap does not go on to
#90, #91 or #92. A failed gate is a product result. It is not answered by rewriting a requirement with
what F showed, or by lowering the threshold after a sealed result.

Reported with every result: the primary rate and its interval, the rate over cases with a requirement,
the three stages, how O was found and the rates for each way, the reach origin of each detection, the
cases caught before the merge and those with checks unknown (those not opened, by count), the cases
whose requirement could not be written, the cases whose target was not named, false findings per pull
request, listed precision, requests, bytes and time, and the repositories, cases and runs behind every
number.

## Where records live

Dev records are in `bench/eval/retro/`. **Sealed records — F, O, the bundle, the requirement, every
answer — live in the private `yottayoshida/jev-review-sandbox`, on its `batches` branch** (version 3;
version 2 said `sealed`): each row's record in `batches/89-<batch>/<row>.json`, and the batch's
verdicts in `batches/89-<batch>.json` — each row's outcome and the sha256 of each row's file — as
`PROTOCOL.md` rule 5 keeps #80's. A case stays there once its side is known (version 6). This
repository holds only the batch's line in `sealed-batches.json` — the rows read, `kept` (the
repositories with a case, those caught before the merge included: every one of them is placed) and the
sha256 of the verdicts file; the salt that places a batch's repositories is the first main merge commit
holding that hash. `retro/screen.ts` prints only counts; an error names the row, the step and the
error's kind, never the row's text.

Opening sealed retrospective cases goes through `bench/eval/run.ts --set sealed open`, on a line of its
own with `#89` in the reason, and is counted per repository with every other opening. #80's opening
takes #80's repositories only, so a placed retrospective repository is never opened by it. Opening this
measurement's repositories is added to `run.ts` with their run (version 6); until then no sealed
retrospective case is opened.

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
or gave no answer to count. The runs for sealed rows are asked for, as a number, before they start,
and are spent in whole rows: a row is begun only when its worst case — eight answers, each asked up to
four times, 32 runs — fits the runs left, so a batch stops between rows and a later run begins at the
first row not decided. Decided rows are never asked again.
