# The evaluation protocol, version 1 (issue #80)

**Through `bench/eval/run.ts`, a sealed evaluation sends no request until the line that opens it has
been committed to main. The sealed set has no case yet, and the rule by which the second batch chooses
its cases is written here first.** Nothing stops a sealed case from being run another way — the Action
on a pull request in the sandbox, or the command by hand; that is a rule people keep (*Contamination*).

Everything below was committed before any sealed result exists. Changing a metric, a threshold, the
interval, the split or the rules makes version 2; a sealed result is compared only with results of
its own version, and the count of openings (below) runs across versions.

## Files

| file | what it is |
|---|---|
| `pool.json` | every candidate the records of `bench/` name — examined, screened out by title or licence, excluded by a rule, or used to build and tune — with where it came from and what was decided. Built by `build-pool.ts` |
| `split.json` | the side of each repository. One entry per repository; **this file, not a case's `role`, is the source of which side a case is on** |
| `labels.json` | how the code before each fix handled its failure (*Labels*), merged into `pool.json` |
| `search-v1.json` | the raw results of the second batch's searches: reference, title, merge time. No body read |
| `sealed-access.jsonl` | every opening of the sealed set and every result. Lines are only ever added |
| `metrics.ts` | the metrics, the interval, the gates |
| `run.ts` | the one entry: `--set dev` and `--set sealed` |

## Dev and sealed

**Every repository in `pool.json` is dev**, and fixed there: each was read, run or used before this
protocol existed — the tool was run on it for condition (b), a case was built or pre-checked on it
(`bench/acceptance/cases/`), it was read for the siblings' conditions of `#37`, it is in
`bench/corpus/`, `bench/fixtures/` or `bench/sentence-choice/`, or it was examined for `#36`. The
dev set may be run and read as often as work needs.

**The sealed set is new repositories only.** It is chosen by the second batch, by this rule:

1. The candidates are `search-v1.json`'s rows, in its order, skipping a repository already in
   `pool.json`. If they run out before the stop below, one query is added and recorded in a new
   `search-v2.json` before any of its results is read.
2. A candidate is examined once its pull request or issue text is read. It is kept when (a) its
   requirement can be written as "a failure must reach the caller as an error, not as a success, an
   empty value or an absence", and (c) the behaviour difference of a defect can be observed in a
   throwaway clone, with no network and no credentials. **Condition (b) of `bench/acceptance/README.md`
   — the tool puts the fixed call where a question can be put — is not a condition here**: choosing by
   what the tool reaches would raise the reach rate it is meant to measure. It is a stage that is
   measured (*Scoring*, 1–3, of that README).
3. The requirement is written from the text before the fix's diff is opened, and committed.
4. A kept candidate's repository is placed by
   `sha256("<salt>:<owner/repo>")`'s first byte: below 192, sealed; otherwise dev (`split.ts`,
   `sideOf`). The salt is **the main merge commit that first contains the batch's verdicts** — a value
   that exists only once the verdicts are merged, so whoever wrote them could not know the side first.
   A test checks that every salt is a merge commit on main's first-parent line (`saltProblems`); it does
   not stop a merge commit made by hand and pushed straight to main, which main's missing protection
   allows, nor that the salt is the *first* merge commit with the verdicts rather than a later one —
   the rule rests on merging through pull requests and on the batch's own record of its commit. Three in four go to sealed because dev
   already has more than ten repositories. `build-pool.ts` keeps these entries when it rebuilds the split.
5. Every sealed repository gets a `defect`, a `shipped` and a `rewrite` version, so recall and false
   listing have the same repositories.
6. Stop when sealed holds 17 repositories and 17 requirements, or when 400 candidates have been
   examined; at 400, stop and say how far it got. From the pass rates so far — (a) about 27 %, (c) two
   of four — 17 sealed repositories need about 200 to 300 candidates, and `search-v1.json` has 238.

**Sealed cases do not live in this repository**: every session working on the tool can read it. They
live on the branch `sealed` of the private `yottayoshida/jev-review-sandbox`, pushed without a pull
request (that repository's workflow runs the Action on pull requests, which would be an evaluation the
access log never saw) and never on its `main`.

### Contamination

A sealed case that is read closely enough to influence an implementation decision — an algorithm, a
threshold, a question's words, a budget, how evidence is laid out, how syntax or names are resolved —
is contaminated from then on. Its repository moves to dev in `split.json` with the date and what it
was read for (`contaminated`), and is replaced before the next release judgment by the next candidate
of the same search, under the same rule.

No work may be checked against the sealed set. Named, because each is in flight: `#81`'s call
listing and its baseline, `#83`'s parser and whether it passes, `#82` and `#85`'s tuning — all of
them are measured on dev only. This is a rule people keep; nothing in the tool stops it.

## Labels

Every row whose text was read — examined, excluded by a rule, or used (91 rows; `bench/sentence-choice/`
aside, whose issues were read for their sentences and are not candidates for a case) — carries a label
of **how the code before the fix handled the failure the pull request is about**: the behaviour the
fix changed, not the one it asks for. One of `propagates`, `logs_or_warns`,
`records_or_handles_locally`, `falls_back_or_degrades`, `swallows_as_success`, `other`,
`cannot_label` (about failure handling, and the text does not say how), `not_failure_handling`.
Rows screened out by title or licence were never read and carry none.

Three Claude annotators, each a fresh session that read only the pull request's and its issue's text
on GitHub — not the diff, not this repository, not each other — labelled every row on 2026-09-25.
Two of three decide; three different labels make `cannot_label`. Each label keeps the three votes and
the sentence each rests on (`labels.json`). Agreement: 78 unanimous, 12 two to one, 1 split three ways;
Fleiss' κ 0.865. The disagreements sit mostly between `swallows_as_success` and
`falls_back_or_degrades`.

| label | rows |
|---|---|
| swallows_as_success | 38 |
| not_failure_handling | 24 |
| falls_back_or_degrades | 11 |
| propagates | 6 |
| logs_or_warns | 4 |
| other | 3 |
| cannot_label | 3 |
| records_or_handles_locally | 2 |

`#85` evaluates on these labels and does not relabel. Whether they give `#85` enough handled-failure
rows is not known yet; the second batch labels its candidates the same way.

## Opening the sealed set

```sh
node bench/eval/run.ts --set sealed open --reason "<why>"   # appends one line, sends nothing
# commit bench/eval/sealed-access.jsonl, merge it to main
node bench/eval/run.ts --set sealed run <run id>
```

`open` refuses without a reason, without a sealed case, in a tree that is not clean, and where the
environment sends judgments nowhere. It appends the time, the commit, the protocol version, the hash
of `split.json` and `pool.json`, the host and the Jev alias it will ask, the reason, the repositories,
and how many times each has been opened, this time included — counted over main's lines and the
tree's together, so a branch behind main does not count low. `run` refuses unless that line is on
origin/main (a branch whose pull request is closed would take the record with it), no result line for
it is on main or in the tree, the tree is clean, `split.json` and `pool.json` are what it was opened
with, and the environment asks the same host and alias. It builds `dist/` from the tree, sends the
requests, and appends a result line: the commit it ran, the manifest, the build's hash, each run's
`modelIdentity` (`#84`: the versions the host named in its answers), and the result file's sha256. A
run that stops half way has already left its opening on main; it has no result line, so `run` would
accept the same opening again and send its requests a second time under one count. **After a run that
stopped, open again** rather than rerun.

**Commit and merge the result line too.** A result line that never reaches main is not seen by a later
`run` from another clone, and the same opening could be run twice; the log would then undercount.

The count of openings is per repository and runs across versions: a sealed result opened for the
fifth time says so, whatever version wrote it. A test checks that this branch's
`sealed-access.jsonl` begins with main's.

## What is measured

The unit is **one target of one version** — a row of `bench/acceptance/score.ts`. Each rate is
reported with the repositories and units it rests on, and the report (`run.ts --set dev report`) states
once the repositories, requirements, cases, targets and runs behind all of them.

| metric | a unit counts when | better |
|---|---|---|
| reach | the target got inside the budget (Scoring 1–3) | — (reported) |
| known-defect recall | a target of a `defect` version was listed in 3 runs of 3 | higher |
| false listing | a target expected not listed was listed in any run (`hidden` versions are not in it) | lower |
| precision of the constructed versions | of the targets listed in any run, it was expected listed (a `hidden` version's target listed is wrong) | higher |
| silent unmeasured | the target was not enumerated and no note says a cap cut it | lower |
| `cannot_determine` | of the runs that answered, the answer was `cannot_determine` or under 0.6 | — (reported) |

**Precision here is of the versions a case is built with**, whose mix is set by how cases are built;
it is not the precision of the product on real pull requests. A listed call that is not a target
carries no label and is counted apart (`unlabelledListed`), not in the denominator; `#88` decides such
findings.

Cost is reported per case: requests, bytes sent and runs. Reused answers and time are not in the logs
`measure` writes today, and are added to the report with the first sealed case.

**Calibration** is per family of questions (a form and a question), never pooled: bins
[0, 0.2), [0.2, 0.4), [0.4, 0.6), [0.6, 0.8), [0.8, 1] — 0.6 is an edge — Brier score, and the ECE of
those bins. Below 100 labelled judgments or 17 repositories in a family, the result is *insufficient
sample size* and nothing else. The 100 rests on nothing better than a round number, and is revised,
in version 2, once the second batch shows what a family actually gets. `metrics.ts` computes it
(`calibration`); the report does not call it yet — no family is near the floor — and does with the
first sealed case.

## The interval and the gates

Calls of one repository are not independent. **Each rate is the mean over repositories of each
repository's own rate**, and its interval is Clopper–Pearson at 95 %, two-sided, with x the sum of the
repositories' rates and n the number of repositories — the interval of the case where every call of a
repository behaves as one. It is used at every number of repositories: a bootstrap has width 0 when
every repository scores 1.

| gate | bound compared | threshold | repositories a perfect score needs |
|---|---|---|---|
| precision of the constructed versions | lower | ≥ 0.80 | 17 |
| known-defect recall | lower | ≥ 0.50 | 6 |
| false listing | upper | ≤ 0.20 | 17 |
| silent unmeasured | upper | ≤ 0.20 | 17 |

(Silent unmeasured was 0.10; that needs 36 repositories, which the stop of 17 never reaches. The owner
chose 0.20 on 2026-09-25, before any result.) `metrics.ts` recomputes the last column and a test holds
it.

**A gate with fewer repositories than it needs does not pass.** While any gate is short, a release
cannot cite the evaluation: it says "no evaluation verdict", not "the gates it had passed". Today
every gate is short, because sealed is empty.
