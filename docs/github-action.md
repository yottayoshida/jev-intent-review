# GitHub Action

On a pull request, the Action runs the command once and puts the report where the people looking at
the pull request are: a check run, the job summary, and an artifact. Add the workflow and the keys,
and nothing else:

```yaml
name: intent-review
on: pull_request
permissions:
  contents: read
  pull-requests: read
  issues: read
  checks: write
concurrency:
  group: intent-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    name: intent review (same-repository pull requests only)
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: yottayoshida/jev-intent-review@<the full 40-character commit>
        with:
          jev-provider: cloudflare
          cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

`concurrency` stops a pull request's earlier run when a later push starts one, so pushing several
times in a row pays for the last push rather than for every one.

Pin the Action to a commit: there is no tag yet, and `@main` would change under you. The version of
the command is the Action's own — it runs the source at that commit, not a published package.

The `if:` and the name are the table below: a pull request from another repository is given no
secrets, so there is nothing to ask Jev with, and the job is skipped under a name that says so.
Keep the condition on the **job**. On a step it would leave the job green, which reads as a review
that found nothing.

**Inputs.** `jev-provider`, `cloudflare-account-id`, `cloudflare-api-token`, `typesafe-api-key`,
`ai-gateway-api-key`, `jev-api-url`, `jev-api-token` — the same choice of host as the command
([Jev endpoint](usage.md#jev-endpoint)), one key per host. `github-token` (default `github.token`) reads the
pull request and its issues; `artifact-name` (default `jev-intent-review`) names the artifact;
`remember-answers` (default `true`) keeps this pull request's answers between runs, below.
Everything else stays in `.jev-intent-review.yml`, which is read from the commit before the change,
so a pull request cannot loosen the rules it is checked under. A key set in the job's environment is
never used: the step that runs the command takes every key name from these inputs.

**What a run leaves.** A check run, "jev-intent-review result", with the report and — for each call
worth checking whose file the merge commit does not change — a mark on its lines. The same report in
the job summary. An artifact with `report.md`, the command's `stderr.txt`, `action.json` (which ref
ran and a hash of its `src`), and `report.json` when the command printed one. The check run's copy
is cut at about 64 KB and the summary's at about 1 MiB, each at a line, with a pointer to the
artifact, which always holds the whole report. **Nothing the command prints goes
to the job log**: requirements and code excerpts carry text that a log would read as a workflow
command or as a compiler error, so what this Action adds to the log is a handful of fixed sentences.
Around them the runner writes its own lines — the step headers and each step's `env:`, where a key
that came from `secrets` shows as `***` and one written into the workflow file does not — and
`actions/cache`'s own lines, which name the cache key (numbers and fixed words) and whether it was
found.

**What a later push asks again.** When the Action runs again on the same pull request, a judgment
whose evidence and questions are byte-identical to one already answered for that pull request is
taken from that answer instead of being sent to Jev, and the report counts it as reused ([ADR
0013](adr/0013-remember-a-pull-requests-answers.md)). The answers are kept in the Actions cache
under a key that names the pull request — never another pull request's, nor the default branch's —
and the cache holds each request's hash and Jev's answer, never the code. A run without
credentials, a fork's among them, is skipped, and the command never opens them. The report's *Sent
to the judgment model* line says how many answers were reused and how many of those an earlier run
kept, and `--json` has them in `sent.reused` and `sent.reusedFromEarlierRuns`;
`sent.answered` is still what Jev answered in this run. What is not guaranteed, and how much it saved
on real pull requests, is in [docs/local-check-cli.md](local-check-cli.md#what-a-later-push-asks-again).
Set `remember-answers: false` to ask everything every time.

**A limit for the whole pull request.** With `limits.max_requests_per_pull_request` set in
`.jev-intent-review.yml` and `remember-answers` on, the runs of one pull request together send at
most that many requests to Jev, as far as the count carried in its cache goes; a run the limit
leaves short says so, and where `policy.fail_on` names `finding` it fails (exit 2, or 1 when it
listed a finding), so spending the limit cannot make a change pass unasked ([ADR 0014](adr/0014-a-limit-for-the-whole-pull-request.md)).
The value is read from the commit before the change, but the count lives in the pull request's own
cache, which its author can clear; what that leaves unguarded is in
[docs/local-check-cli.md](local-check-cli.md#a-limit-for-the-whole-pull-request). Unset, there
is no such limit; `limits.max_requests` still holds each run.

**How a run reads at a glance.** The check run is green only when at least one call was read and
nothing is left to look at; red when the command did not exit 0; and neutral — grey — for everything
else: a run that was skipped, found no requirement, asked nothing, read no call, left a call without
an answer, met a change no requirement asked for, or listed a call worth checking while
`policy.fail_on` leaves the exit code at 0 (the common one).
Its title says which. A neutral check run does not block a required check, and the job itself stays
green, so a run that checked nothing is told apart by the check run, not by the job's own mark.
Without `checks: write` — a workflow that does not grant it, Dependabot, or a fork's run if you drop
the condition above and have not turned on *Send write tokens to workflows from pull requests* — no
check run is created: the report is in the job summary, and a run that read no call also writes one
warning.

**Which pull requests are reviewed.**

| The pull request | What the workflow above does | Where the reason is |
|---|---|---|
| from a branch of this repository | Reviewed. | — |
| from another repository — a fork | The job is skipped. Nothing runs, so no runner time is spent and no request is sent. | The job's name, in the checks list. A skipped job has no summary, no check run and no log to open. |
| from a fork that has since been deleted | The same: GitHub answers `head.repo` with nothing, which is not this repository's name. | The same. |
| opened by Dependabot | The job runs — the branch is this repository's — and is given no secrets, so nothing is judged. | The job summary, and one warning annotation. Dependabot's token cannot write checks, so there is no check run. |
| with no requirement in either form — its description empty or in prose, and no issue it closes that has one | The job runs, judges nothing and fails: exit 11, *Requirements could not be read*. Add a section to its description and push or re-run the job ([how](writing-requirements.md#pull-requests-opened-before-a-template)). | The check run's title, and the job summary. |
| from a first-time contributor | If the repository asks for approval of their workflow runs, GitHub waits for a maintainer. Approving changes nothing here: the pull request is still from a fork, so the job is skipped. | The job's name, as above. |

Where each of those sentences can be read is above because it differs: only a run that happens, with
a token that may write checks, gets a check run. The command decides the reason once and every
place shows that one decision.

Quoted from GitHub's documentation, not measured here: that secrets are
["not passed to the runner when a workflow is triggered from a forked repository"](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#using-secrets-in-a-workflow),
that such a run uses ["a `GITHUB_TOKEN` with read-only permission, and with no access to
secrets"](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
unless the repository turns on *Send write tokens to workflows from pull requests* on that same
settings page, and that for Dependabot the token is ["read-only and secrets are not available …
even if the workflow is re-run by a different
actor"](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions).
Measured here, against pull requests that exist — a same-repository one, a cross-repository one, one
whose fork has been deleted and a Dependabot one, whose payloads are kept in
`test/fixtures/events/` — : which reason the command gives, and the title the Action makes of it.
Neither quoted nor measured, because this repository has no fork to open a pull request from: that
the condition above skips the job in a live run. What the condition does with a name it cannot read
is the safe direction either way — anything that is not this repository's name does not run.

There is no way to have fork pull requests reviewed with this Action. The two shapes that would —
sending the evidence a fork's own code assembled, or running the fork's code with the secrets —
are the thing [#42](https://github.com/yottayoshida/jev-intent-review/issues/42) asked to keep out.

**What it does not do yet.** It runs on `pull_request` only; `pull_request_target` is refused at the
Action's entry.
A pull request with no requirement in either form stops with exit 11 (*Requirements could not be
read*), which makes the job red: its description is read, so there is something that did not read
as requirements. `policy.no_intent` applies only when there is nothing to read at all — a pull
request that closes no issue, under `intent.include_pr_description: false`. The Action's own stop
(exit 10) also makes the job red, on an event other than `pull_request` or a runner whose Node is older than 22.18. That stop is the backstop for a workflow that reaches the Action
another way: under the workflow above, a job of any other event has no pull request to read a head
repository from, so the condition skips it before the Action starts. A change the change question could not judge — the budget, the host — is said in the
report's notes and does not make the check run neutral. Requirements the pull request's author wrote
in its own description are used and said to be theirs; the Action does not treat that as a reason to
fail. The runner needs Node.js 22.18 or later — `ubuntu-latest` carries it today, and on an older
image add `actions/setup-node` (with `node-version: 22`) before this step yourself; the Action does
not install Node, because `setup-node` leaves a problem matcher on the rest of the job.

Running the command directly in a workflow instead is fine, but its output is then yours to keep out
of the log — redirect stdout and stderr to files.
