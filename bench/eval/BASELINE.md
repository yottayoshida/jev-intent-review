# The frontier-model comparison, version 1 (issue #88)

**The comparison with a frontier model — the baseline, how its material is gathered, the budget, how
findings are normalised, scored and adjudicated, the primary metric, the smallest effect of interest,
the guard, the provisional cost envelope and the stop rule — is committed here before the sealed set
is opened.** Changing any of it makes version 2, and a result is compared only with its own version.
The sealed set has no case yet (`PROTOCOL.md`); nothing below has been measured on it.

## The question

On requirements of the form the tool supports — a failure must reach the caller as an error — does
jev-intent-review find the known defects that **a strong general model, given the same requirement,
the same diff, the same commit and the same amount of material in one request**, does not, by a
margin that matters in product terms?

"The same amount of material in one request" is what an ordinary user does instead: hand the pull
request and the requirement to a frontier model and ask what breaks it. The baseline is not handicapped
to the diff; it gets the files around the change, gathered by the rule below.

The two ideas the tool spends its complexity on answer on different defects, so the result is read
apart as well as together: **A**, a defect in a function the pull request changed (inside the diff), is
where small typed questions differ from one free-form review; **B**, a defect in an unchanged caller of
a changed function, is where reaching beyond the diff differs. `PROTOCOL.md` rule 6 builds both.

**The sealed set is chosen for the supported surface.** It is not a sample of code review in general,
and no claim here is about code review in general.

## The baseline

`bench/eval/baseline.ts`: Claude Opus 5.5 through `claude -p`, with no API key (none is held):

```
claude -p <prompt> --model claude-opus-5-5 --effort high --tools "" --strict-mcp-config \
  --system-prompt <fixed> --setting-sources project --no-session-persistence --output-format json
```

run in an empty directory that is not a repository, so no branch name, git status or `CLAUDE.md`
reaches the model and nothing it sees says which version it is reading. No tools, no MCP server, no
user settings — which also keeps the operator's user-level hooks from running, checked with `--debug`
on 2026-09-25 against a project-level hook that did run. The system prompt and the question are the
constants `SYSTEM_PROMPT` and `userPrompt` of `baseline.ts`; the first run took 436 input tokens for a
question of a few words (`logs/baseline-poc.json`), so no default system prompt or tool definition rode along.

A run counts when the one model asked answered (`modelUsage` names `claude-opus-5-5` and nothing else)
and the answer is a JSON array of `{file, function, call, claim}` (a code fence around it is removed).
A run that does not count is recorded with why and taken again, up to five attempts a version; a
version with fewer than three counted runs is no hit for the baseline.

## Material

Gathered by `gather`, in this order, each file once and whole, until the budget. **A file that does not
fit is skipped and the next tried** (stopping at the first left 7–35 % of the budget unused on dev); if the
requirement or the diff does not fit, nothing after it is given:

1. the requirement;
2. `git diff base..head`;
3. the whole text, at head, of each file holding a function the change touched
   (`bench/acceptance/changed-functions.ts`), by path;
4. the whole text of each Rust file that names a changed function as a whole word (`git grep -w`), the
   names that hit the fewest files first, each name's files by path (a changed function named `name` or `id`
   hits hundreds of files; by path alone they pushed moltis-1064's one caller out of the budget);
5. the whole text of each Rust file that holds a word of the requirement — three letters or more, not in
   `STOPWORDS` of `baseline.ts` — most distinct words first, then by path.

jev-intent-review's own list of calls is never used: it would hand the baseline jev's reach.

## Budget

**The same bytes** (owner, 2026-09-25): for each version, the baseline may be given as many bytes as
jev-intent-review sent to Jev on it, the median of its three runs. A version jev sent nothing on — it
held its target or had none inside its budget, so its enumeration settled it — gives the baseline the
median of the bytes jev sent on the run's other versions (owner, 2026-09-26): a defect jev did not reach is
one the baseline may still find, and d is then −1. Given 0 bytes the baseline could not run, and every such
version would be a tie in jev's favour (the rehearsal on dev row 143 was one). A version jev sent on but
finished no run of stops the run instead. The same bytes are not the same cost
— Opus and Jev are priced very differently — so cost in dollars, tokens and time are reported beside
every result. jev sends the same requirement and function more than once; the baseline gets that many
bytes with little repetition, which favours the baseline.

**Provisional cost envelope** (#91 makes it an enforced limit): a pull request's run within the tool's
own default limits (`src/config/config.ts`: 400 requests, 4 MB sent, 600 seconds). An uplift bought by
going beyond it is not counted as value; until #91 enforces it, each sealed case's recorded cost is
checked against it by hand and a case beyond it is reported as such.

## Findings and hits

Both systems keep **at most five findings** a run: the baseline is asked for five and a sixth is
dropped; jev's listed calls are ranked by the probability of the answer that listed them, ties in its
own order (`jevTopFindings` of `compare.ts`), and cut at five. How many each listed before the cut is
reported.

**A hit is mechanical and the same for both**: a finding with the known defect's file and function (a
function written with its type, `Restorer::finalize`, is `finalize`; a diff's `a/` or `b/` is dropped) whose
call contains the target's call, whitespace ignored, in each of the first three counted runs (`names`,
`hit`). The target is written as the tool lists calls, with no receiver or `.await`; a quote of the code has
them (`self.rewrite_heights(grove_version)` for `rewrite_heights(grove_version)` — on dev both defects
inside the diff were quoted so). jev's findings are the listing's rows, so for jev this is an exact match.
Another call in the same function is not the target, as in `bench/acceptance/README.md`. On a `shipped` or `rewrite` version a
finding that names a known target is false for either system.

## Adjudication

Only findings that are not hits and not known targets are adjudicated. One rewriter — a fresh Claude
session — puts every such finding of both systems into one sentence of the same shape ("In `function` of
`file`, when `call` fails, …"), and the source is removed. Three Claude annotators, each a fresh session
that may read the repository at that version, label each sentence *a real defect*, *false*, *a
duplicate* or *cannot decide*; two of three decide, and three different labels make *cannot decide*.
*Cannot decide* is reported apart and never counted false. A real defect not in the frozen labels goes
into an addendum; the primary metric's labels do not change.

**A known limit**: the baseline, the rewriter and the annotators are all Claude; a preference for its own
wording may remain after the rewriting. No other family is available to adjudicate.

## The primary metric and the gate

For each defect version, d = (jev hit) − (baseline hit), in {−1, 0, 1}. d is averaged within each
repository, the repositories are averaged, and the interval maps d to (d + 1) / 2 and takes the
Clopper–Pearson interval of `metrics.ts` over the number of repositories, 95 % two-sided (`uplift`).

**The smallest effect size of interest is 10 more defects found per 100 cases** (owner, 2026-09-25). With
one case a repository and no loss, the wins needed for a lower bound above 0.10 (`neededWins`):

| repositories | 6 | 8 | 10 | 12 | 14 | 17 | 20 | 25 | 30 |
|---|---|---|---|---|---|---|---|---|---|
| wins needed | none suffice | 8 | 8 | 9 | 10 | **11** | 12 | 14 | 15 |

At 17 repositories, 10 wins give a lower bound of 0.066 and fail, 11 give 0.131 and pass, and 11 wins
with 1 loss fail. The difference is also reported for A and for B alone. On dev, jev listed every
defect at A and B in three runs of three (`bench/logs/acceptance-v4.json`), one finding a run, so
also after the cut to five; if it does the same on
sealed, the gate passes only when the baseline misses on about two thirds of the cases. A result below
the gate says which it is: the baseline found as much, or too few repositories to tell — `judge`
returns `no_verdict` when no number of wins could clear SESOI (fewer than 7 repositories).

**The guard**, on every `shipped` and `rewrite` version: jev's rate of versions with at least one false
finding — a known target named, or a finding adjudicated false — is no more than the baseline's plus 0.10,
point estimate against point estimate; and the upper bound of jev's false listing of known targets —
`PROTOCOL.md`'s quantity, counted as `metrics.ts` counts it: per target of a correct version, listed in any
run, before the cut to five — is no more than 0.20, its line. With fewer than the 17 repositories that
line needs, `judge` returns `no_verdict`, as `PROTOCOL.md` does for a gate short of repositories. (An upper bound against a point estimate
would fail even a jev with no false finding at 17 repositories: 0.195 > 0 + 0.10. And a ceiling on every
adjudicated finding would fail jev for one of about fifty versions, a bar the baseline never faces.)

**Stop rule**: unless the lower bound over every defect version is above 0.10 and the guard holds, the
roadmap does not go on to #90, #91 or #92. A failed gate is a product result. It is not answered by
changing the baseline, the SESOI, the question or the sealed set; a later version measured again is a
different measurement and says so.

## Reported with every result

The difference (all, A, B) with its interval; each system's recall; each system's false-version rate;
*cannot decide* counts; overlap — defects both found, and those only one found; cost, tokens and time;
and the repositories, cases and runs behind every number.

## Sealed

Opening the sealed set runs both systems and the adjudication under one opening of `run.ts --set sealed`
(`PROTOCOL.md`, ADR 0024); the opening line records the baseline's host (`claude-code`), model, effort and
version, and the sha256 of `baseline.ts`, `compare.ts` and `adjudicate.ts`, whose prompts are fixed
before the set is opened. Up to about 255 runs of `claude -p` for the baseline (17 repositories, up to
five versions, three runs) and about 184 for the adjudication (46 correct versions, a rewriter and three
annotators) are allowed on the condition that user-level hooks are not loaded (owner, 2026-09-25 and
2026-09-26). The rewriter runs with no tools; the annotators with `Read,Grep,Glob` only, in a copy of the
version's source (`git archive`, with every `.claude/`, `CLAUDE.md` and `CLAUDE.local.md` removed) under the
system's temporary directory, so the sandbox's labels and the systems' logs are outside what they may
read. Before the opening line is written, two `claude -p` runs with the annotators' tools check that a
file in their directory is read and a file in the run's own directory is not (`probeConfinement`). They
are the first `claude -p`, and the workspace's `origin/main` and omamori's audit log are recorded around
them (`retro/calibrate.ts`, `n1Problem`): an auto-backup commit arriving in between refuses the opening.
The audit log shows nothing of these runs whatever happens — with `Read,Grep,Glob` no Bash hook runs —
so it is recorded, not checked.

## Dev

`node bench/eval/baseline.ts dev <clones>` runs the baseline once on each defect, shipped and rewrite
version of the dev cases. It is a check that the baseline runs, not evidence: dev may be read and run
at will, and one run a version is not three. `logs/baseline-dev-v0.json` is the first pass (seven
versions), taken while the material stopped at the first file that did not fit; it is what showed that
rule leaving the budget unused, and that the listing's form of a call (no receiver, no `.await`) missed
the baseline's quotes. `logs/baseline-dev-v1.json` is two versions again with whole files skipped rather than stopping. Its
moltis-1064 `defect-B` was gathered before step 4 took the rarest names first; under the rule above the
caller's file (`dispatch.rs`) is the first of step 4 and in the material — checked by `gather` alone, with
no request, because the runs allowed for dev (about ten) were spent.
