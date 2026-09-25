# The evaluation protocol, version 4 (issues #80, #88, #89)

**Through `bench/eval/run.ts`, a sealed evaluation sends no request until the line that opens it has
been committed to main. The sealed set has no case yet, and the rule by which the second batch chooses
its cases is written here first.** Nothing stops a sealed case from being run another way — the Action
on a pull request in the sandbox, or the command by hand; that is a rule people keep (*Contamination*).

Everything below was committed before any sealed result exists. Changing a metric, a threshold, the
interval, the split or the rules makes a new version; a sealed result is compared only with results of
its own version, and the count of openings (below) runs across versions.

**Version 2** (#88, before any sealed case was built or opened) changed what is now rule 6 below: a sealed
repository gets a defect in a changed function (A) and, where one exists, in an unchanged caller of one (B),
and the gates count both. Version 1 had one defect of any place. Nothing was measured under version 1.

**Version 3** (#89, before any sealed case was built or opened) added a second way into the sealed
set: the retrospective measurement's own search and rule (`RETRO.md`, "Candidates"). Its repositories
are none of this set's — a repository on the split or in this set's `search-v1.json` is left out of its
search (`retro/search-v1.json`), and a repository in that search is left out of this set's (rule 1) —
they are placed by the same `sideOf` with its own salt, and a sealed retrospective case is opened by
`run.ts --set sealed open` on a line of its own, with `#89` in the reason, once `run.ts` can open one
measurement's repositories alone (`RETRO.md`, "Where records live"). Nothing here changed for this
set's cases. No sealed case was built or opened under version 2.

**Version 4** (#80, before any sealed case was built or opened) set how the sealed set is chosen in
batches: the second search (`search-v2.json`, taken before this version's first row is read), screening
by licence, fork and one case per repository, dependencies fetched to build but not to observe, an hour
a candidate, batches recorded as counts and sha256 in `sealed-batches.json` with the salt found by that
hash, and a cap of 800 rows where version 3 had 400. No sealed case was built or opened under version 3.

## Files

| file | what it is |
|---|---|
| `pool.json` | every candidate the records of `bench/` name — examined, screened out by title or licence, excluded by a rule, or used to build and tune — with where it came from and what was decided. Built by `build-pool.ts` |
| `split.json` | the side of each repository. One entry per repository; **this file, not a case's `role`, is the source of which side a case is on** |
| `labels.json` | how the code before each fix handled its failure (*Labels*), merged into `pool.json` |
| `search-v1.json` | the raw results of the second batch's searches: reference, title, merge time. No body read |
| `search-v2.json`, `search-v2.ts` | the same four phrases over 2026-01-01 to 2026-06-30, ranges split until none stops at 100; taken before any row is read |
| `sealed-batches.json` | each batch of sealed candidates, #80's and #89's: the range of rows read, rows kept, and the sha256 of its verdicts in the sandbox. Lines are only ever added |
| `sealed-access.jsonl` | every opening of the sealed set and every result. Lines are only ever added |
| `metrics.ts` | the metrics, the interval, the gates |
| `run.ts` | the one entry: `--set dev` and `--set sealed` |
| `drift.ts`, `drift/` | Jev's drift on the dev set: its questions frozen, sent again, and compared with a baseline taken on two days (`#87`, rule in `drift/README.md`). Dev only; a sealed replay is a sealed opening |
| `BASELINE.md`, `baseline.ts`, `compare.ts` | the comparison with a frontier model (`#88`): a baseline given the same bytes in one request, scored the same way, and the gate on the difference |
| `RETRO.md`, `retro/` | the retrospective measurement (`#89`): real defects that escaped review, their original pull requests found, requirements rewritten from what existed before the merge by isolated annotators, and the gate on the detection rate. Its sealed cases live with this set's, outside this repository |

## Dev and sealed

**Every repository in `pool.json` is dev**, and fixed there: each was read, run or used before this
protocol existed — the tool was run on it for condition (b), a case was built or pre-checked on it
(`bench/acceptance/cases/`), it was read for the siblings' conditions of `#37`, it is in
`bench/corpus/`, `bench/fixtures/` or `bench/sentence-choice/`, or it was examined for `#36`. The
dev set may be run and read as often as work needs.

**The sealed set is new repositories only.** It is chosen in batches, by this rule (version 4):

1. The candidates are `search-v1.json`'s rows, in its order, then `search-v2.json`'s — the same four
   phrases over 2026-01-01 to 2026-06-30, every range split until no phrase reaches `gh search`'s silent
   limit of 100 (`search-v2.ts`), taken and committed before any row of either is read. `search-v1.json`
   is a best-match sample: three of its four phrases stopped at 100, and which 100 is not reproducible;
   the committed file, not the command, is the list. Skipped: a repository already in `pool.json`, on the
   split, or in the retrospective's search (`retro/search-v1.json`, version 3), which already takes these
   phrases from 2026-07-01 on.
2. Before any text is read, a candidate is screened out, and recorded so, when its repository **has no
   licence** (any licence will do, GPL and MPL included: the cases are kept private and never distributed;
   owner, 2026-09-25); when it is a **fork or a copy of a repository already met** — GitHub's `parent` or
   `source` is in the pool, the split, an earlier batch or an earlier row — which counts as the same
   repository; or when an **earlier row of the same repository was kept** (one case per repository). A
   fork not screened out (its source not met yet) is examined as its source: the split holds the source,
   with the fork in `readAs`, and the side is drawn for the source's name.
3. A candidate is examined once its pull request or issue text is read. It is kept when (a) its
   requirement can be written as "a failure must reach the caller as an error, not as a success, an
   empty value or an absence", and (c) the behaviour difference of a defect can be observed in a
   throwaway clone: dependencies may be fetched to build, and the test or example that shows it runs
   with no network and no credentials. **One hour a candidate**: a candidate not settled by then fails
   (c), recorded as timed out — it falls before the side is known, so on both sides alike. A candidate
   that fails because `changed-functions.ts` or `occurrences` misread its syntax is counted apart.
   **Condition (b) of `bench/acceptance/README.md` — the tool puts the fixed call where a question can be
   put — is not a condition here**: choosing by what the tool reaches would raise the reach rate it is
   meant to measure. It is a stage that is measured (*Scoring*, 1–3, of that README). The tool is never
   run on a candidate, `--candidates-only` included.
4. The requirement is written from the text before the fix's diff is opened, and pushed to the sandbox
   first; the push event's id and time are recorded (a commit's date can be set by hand; the push's
   cannot).
5. **A batch's verdicts are one file in the sandbox, and its sha256 is added to `sealed-batches.json`**
   (with the range of rows read — a measurement's batches run on from row 1, so no row is judged twice
   to draw a side again — and the rows kept; lines are only ever added, #80's and #89's alike, checked
   against origin/main, which a push straight to main would get round). A kept
   candidate's repository is placed by `sha256("<salt>:<owner/repo>")`'s first byte: below 192, sealed;
   otherwise dev (`split.ts`, `sideOf`). **The salt is the first main merge commit holding the batch's
   sha256** — found by the hash, not by the batch's name, so verdicts swapped and rehashed afterwards do
   not pass; a test asks git for that commit and compares it with every salt of the split
   (`batchSaltProblems`), and that each repository names the first batch that read one of its rows. Pull requests that add a batch are merged with a merge commit (`gh pr merge
   --merge`): a squash or a rebase leaves no merge commit to be the salt. A merge commit pushed to main
   by hand would still pass — main has no working protection — so the rule rests on merging through pull
   requests. Three in four go to sealed because dev already has more than ten repositories. A repository
   another measurement placed first keeps that side. `build-pool.ts` keeps these entries.
6. Every sealed repository gets a `defect-A` — the defect in a function the pull request changed — and,
   where a function the pull request did not change calls one it did, a `defect-B` in that caller; one
   `shipped`, and a `rewrite` for each defect's target (`rewrite-A`, `rewrite-B`): at most five versions.
   A defect version must give a different result from `shipped` in the recorded observation, and a
   rewrite the same. Places A and B are those of `bench/acceptance/README.md`. **The gates below count
   every version of both places** (owner, 2026-09-25): the tool says it looks beyond the diff, and B is
   where that is tested — which makes the gates stricter than version 1's, since B is where the tool has
   been weakest (#36). The frontier-model comparison (`BASELINE.md`) reads the two places apart as well
   as together.
7. **Yield and cap**: once the first 100 rows are screened, the yield is measured and multiplied by every
   row of `search-v1.json` and `search-v2.json` — all recorded before the yield is read. If that could not
   reach 17 sealed repositories, stop and say so ("no evaluation verdict"). Otherwise stop when sealed
   holds 17 repositories and 17 requirements, or when 800 rows have been examined.

**Nothing of a candidate lives in this repository — verdicts, requirements, patches, observations —
only each batch's counts and sha256.** They live in the private `yottayoshida/jev-review-sandbox`,
pushed without a pull request (its workflow runs the Action on pull requests, which would be an
evaluation the access log never saw) and never on its `main`: each candidate on a branch of its own
(`cand/<row>`), each batch's verdicts on `batches`, and once the side is known the sealed cases on
`sealed` and the dev cases on `dev`. The verdicts file holds the sha256 of every file of every case, so a
case changed after the batch is found. The sandbox is private and this repository's CI cannot read it:
**`run.ts` checks every sealed case against its batch's hashes before it opens the sealed set** (wired
with the opening itself); until then the check is done by hand and its result written in the pull
request that places a batch.

**A candidate is examined and its case built by a session that keeps nothing of it**: a fresh subagent per
candidate, and one more that gathers a batch's verdicts, return the orchestrator only a row's reference,
whether it was kept, the conditions it failed, and a batch's counts and sha256. Neither writes memory,
and no plan, memory or note of the orchestrator holds a requirement, a function name or a patch of a
candidate. Clones are thrown away at the end of the batch.

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

**Added 2026-09-25, owner ruling (#85).** Two more judgments per labelled row, in their own file and
not in `label`: whether the row's requirement could be written in the form `failure_propagation` (a) or
`failure_handling` (a′), each by three fresh annotators in separate sessions, reading the same text as
the labels (`bench/eval/forms-85/`, fixed before any was made). `label` and `verdicts.a` are not changed.
They record which requirements a form's sentence can write; they are no gate and change no metric,
threshold, interval, split or rule of choosing cases, so the version stays 4 (as for the fork sentence
of rule 2).

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
in a later version, once the second batch shows what a family actually gets. `metrics.ts` computes it
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
