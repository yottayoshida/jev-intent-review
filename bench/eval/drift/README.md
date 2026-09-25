# Drift: the dev set's questions sent again (issue #87)

**`drift.ts replay` says drift only when the outcomes of a replay of the frozen dev questions differ
from the baseline by more than any baseline run differs from all the other runs, those of the other
days among them; while the baseline has fewer complete runs than the rule below, or the replay has a pair that
failed, it says `underpowered`, neither drift nor no drift.**

This rule was committed before the baseline was taken. Changing it is a new version of this file and
a new baseline.

A model name that stays the same is not evidence that its judgments stay the same. `#84` records the
version the host names in each answer (`modelIdentity`); a host can change what answers without
changing that name, and the same name can answer differently from one day to the next. This is what
the replay looks for.

## What is frozen

`drift.ts capture <clones>` runs the tool over every live version of every case of `bench/acceptance/cases/`
whose repository is on the dev side of `split.json`, with a provider that answers every question
itself, and keeps what the tool would have sent: for each call, the **pair** of its mapping request
and its observation request, on the same evidence. Nothing is sent to take it.

- The tool asks the same calls whatever the answers are: the places are chosen by the budget before
  anything is asked, and a call's observation is asked whatever its mapping said (`askSite`). For a
  requirement written as a spec — every case today — a pair's outcome is the outcome the tool reports
  for that call.
- The recorder is not stopped by `limits.max_requests` or a deadline, so it can freeze more pairs than
  one real run would reach.
- `--answers` is never passed while recording: a kept answer would stop a question before the recorder.
- The tool runs with `--skip-change-check`, as `bench/eval/run.ts --set dev measure` does: the
  change question is not frozen, and not replayed.
- Which versions are run is `case.json`'s pre-check (`live`), as recorded; a version the tool would
  reach now but did not when it was pre-checked is not run, and not counted by the replay's capture.
- A request that does not pair (a mapping with no observation after it on its state) stops the capture;
  nothing is written.
- The frozen set is `packets-v1.jsonl`, one pair per line, and `packets-v1.manifest.json`: the tool's
  commit, `questionsHash`, the hash of `split.json`, the number of pairs by case, and the file's
  sha256. It is never taken again under the same name.

**It rests on two repositories.** On 2026-09-25 the live dev versions were those of `grovedb-500` and
`moltis-1064`: 57 pairs on 17 evidence packets. One pair is 1.8 % of D, so with a baseline that barely
moves, one pair that moves once can be a drift.

**Nothing sealed is read here.** Sending a sealed case's questions again is a sealed evaluation: it
goes through `bench/eval/run.ts --set sealed open`, is merged, and is counted in the access log. Its
questions are not kept in this repository.

## The baseline

`drift.ts baseline --batch <name> --runs <n>` sends every frozen pair once per run: mapping, then
observation, in a new random order each run, one request at a time, so the same question is never in
flight twice. Every answer of every run is kept (`baseline-v1.json`), with the run's `modelIdentity`.
Only Cloudflare is asked; a baseline or a replay on another host is refused.

**The rule's floor: 2 batches, on different days (a batch's day is the UTC date its first run began;
no two batches begin on the same date), of 5 complete runs each** — a run in which a pair failed is left out of the comparison and not counted.
Below it, `underpowered`. Take a batch's runs in one sitting: runs added to a batch on a later day
are counted in the batch they are named for.

## The comparison

A pair's **outcome** is the rule every report uses (`src/review/outcome.ts`): `violates`,
`satisfies`, `unknown` or `aside` — worth checking, holding, not settled, not required of. A request
that failed makes the pair `error` in that run: a baseline run with one is left out, and a replay
with one is not judged (`underpowered`) — a replay whose requests all failed would otherwise read as
no difference at all.

For a run *r* and a set of other runs, **D** is the share of pairs whose outcome in *r* differs from
the most frequent outcome in the others (errors aside; a tie at the top, or no answer, counts as
`unknown`).

- **Run to run**: the largest D of a baseline run against every other run, the replay included.
  With two batches of the same size, more than half of a run's others are the other day's, so this
  holds the difference between days as well.
- **Drift** when the replay's D against the baseline is larger than that. A tie is not drift.
- **Day to day** is reported beside it: the largest D of a baseline run against the other batches'
  runs alone. (A first version of this rule also required the replay to exceed it; it never changed a
  verdict, because run to run already holds it, and was left out before the baseline was taken.)

**No false-alarm rate is claimed.** The runs of one day are not exchangeable with a run on a later
day, so where a replay ranks among them does not bound how often a replay with nothing changed is
called drift. Taking the baseline on two days puts one day's difference from another inside run to
run, so a replay that differs no more than a day did is not drift; with two batches that is one pair
of days, not an estimate of a rate.

Every replay also reports, without judging on them: how many pairs changed their mapping or
observation choice, or the side of 0.6 either is on, against the most frequent in the baseline; the
mean distance of each probability from the baseline's median; the pairs that failed; whether the
baseline varied at all (`none observed` when every run answered every pair identically); and two
attributions:

- **Versions**: the versions the host named in the replay against those of the baseline.
- **The frozen set against the tool**: the replay takes the capture again the same way, sending
  nothing, and counts pairs the tool asks now that are not frozen and the reverse. The verdict is
  still on the frozen pairs; a count that is not zero says the frozen set is behind the tool.

`drift.ts replay <clones>` is one command: it takes the capture, sends the frozen pairs once, compares,
and writes `replay-<time>.json` with the tool's commit, the frozen set's hash, the run and the
comparison.

**Every replay against the same baseline is another chance of a false drift.** A drift is recorded as
it came, the baseline is not retaken to make it go away, and the versions and the frozen set's count
are the first things to look at.

## Not here yet

- Calibration: the pairs carry no label. `bench/eval/metrics.ts`'s `calibration` needs 100 labelled
  judgments and 17 repositories in a family; this is added once the labelled dev set reaches that.
- A schedule: whether the replay runs on its own, and with what key, is not decided (`#87` stays open
  on it).
