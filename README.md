# jev-intent-review

**Intent-aware review beyond the diff.**

`jev-intent-review` checks whether a pull request actually satisfies the intent behind it — including code the diff did not touch.

Most code review starts from the diff:

```text
changed code → look for problems
```

`jev-intent-review` starts from the requirement:

```text
issue / acceptance criteria
        ↓
what behavior is required?
        ↓
where in the repository does it apply?
        ↓
does the repository after this PR satisfy it?
```

**The diff is a search hint, not the review boundary.**

## Why

Many PR bugs are omissions outside the diff.

A new rule may be implemented in one API path but missed in another.
A bug may be fixed for one caller while another caller still reaches the same failure mode.
A changed invariant may invalidate untouched code elsewhere in the repository.

A diff-only reviewer has no reason to inspect those locations.

`jev-intent-review` works in the opposite direction: it starts from the intended behavior and discovers the code that may satisfy or violate it.

## Example

Requirement:

```text
If loading an existing configuration file fails,
the operation must return an error to its caller.
```

Suppose the PR correctly fixes one path, but an unchanged caller still converts the same failure into a successful result.

`jev-intent-review` is meant to surface that call even though the call itself is outside the diff.

In v0.1 that is a goal, not yet a result. v0.1 lists the callers one hop out of the functions a change touched, so such a caller can be asked about — but among the real pull requests examined so far that were not used for tuning, in all three where the fixed call could be asked about, the call from the unchanged caller to the changed function reached no question: a `Result` alias, a callee signature wrapped past what v0.1 reads, and a per-function cap each stopped it first. See [what has been measured](docs/local-check-cli.md#what-has-been-measured).

A finding contains the requirement, the relevant code, the assumed failure, and the typed judgments that caused it to be listed.

It does not generate a free-form AI code review.

## How it works

The current pipeline is intentionally narrow:

```text
requirements
    ↓
changed functions + nearby callers
    ↓
candidate calls
    ↓
small evidence packets
    ↓
typed Jev judgments
    ↓
calls worth checking
```

[Jev](https://docs.typesafe.ai/introduction) is used for small, fixed questions with probability distributions rather than open-ended review prose.

The evidence and judgments are kept visible so a finding can be inspected or rejected by a human.

## Current v0.1 scope

v0.1 is an experimental implementation of the broader intent-review model.

It currently supports:

* Rust repositories — in any other language no function is read and no call is asked about; only the change question runs
* two forms of requirement, read by one rule: how failures must propagate, and (experimental, measured only on a constructed case) that a check passes before an action
* functions touched by the change and callers one hop out
* requirements written in a documented form — an intent spec, a requirements section, or a `Property:` paragraph (see [Intent](#intent))
* Jev as the only judgment model

It does **not** yet claim complete repository-wide verification or a requirement-level `VERIFIED` verdict.

No finding also does not prove that the requirement is satisfied.

See [docs/local-check-cli.md](docs/local-check-cli.md) for the exact current behavior and measured experiments.

## Install

Node.js 22.18+ is required.

Until the package is published to npm, use the release tarball or build it locally:

```sh
npm install
npm run build
npm pack
npm install -g ./jev-intent-review-*.tgz
```

## Usage

Run against two revisions with an explicit intent spec:

```sh
jev-intent-review \
  --base <base> \
  --head <head> \
  --intent-spec spec.json
```

That is the whole run: the calls of the functions the change touched and their callers are read under each requirement's form, then every change the pull request made is asked about once. `--experimental-local-check`, which selected this run in 0.1, is still accepted: the report and the exit code are the same without it, and one line on stderr says so.

To inspect which calls would be analyzed without sending anything to Jev:

```sh
jev-intent-review \
  --candidates-only \
  --base <base> \
  --head <head> \
  --intent-spec spec.json
```

`--skip-change-check` reads the calls and leaves the changes unasked. `--pr`, `--issue`, `--intent` and `--intent-file` take the requirements from the issue, the pull request or the text given, in the forms described under [Intent](#intent).

Use `--json` for the full machine-readable report (`version: 2`; see [docs/local-check-cli.md](docs/local-check-cli.md)).

The report states no requirement verdict: each call it read is *worth checking*, *holding*, *not settled* or *not required of by the requirement*, and a call worth checking leaves the exit code at 0. A repository that wants CI to fail on one sets `policy.fail_on: [finding]` in `.jev-intent-review.yml`.

### Optional JevFuzz trace

Set `JEV_TRACE_FILE` to append one normalized JSONL record for each successful logical Jev judgment. Its parent directory and the file are owner-only (`0700` and `0600`); symlinks and non-private targets are rejected. Records contain provider-independent state, the Jev model name used for that host, typed questions, normalized choices, and a returned model version only when the gateway supplied one. They never include transport headers or API keys.

```sh
mkdir -m 700 /private/path/intent-review-jev
export JEV_TRACE_FILE=/private/path/intent-review-jev/trace.jsonl
jev-intent-review --base <base> --head <head> --intent-spec spec.json
```

## GitHub Action

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

Pin the Action to a commit: there is no tag yet, and `@main` would change under you. The version of
the command is the Action's own — it runs the source at that commit, not a published package.

The `if:` and the name are the table below: a pull request from another repository is given no
secrets, so there is nothing to ask Jev with, and the job is skipped under a name that says so.
Keep the condition on the **job**. On a step it would leave the job green, which reads as a review
that found nothing.

**Inputs.** `jev-provider`, `cloudflare-account-id`, `cloudflare-api-token`, `typesafe-api-key`,
`ai-gateway-api-key`, `jev-api-url`, `jev-api-token` — the same choice of host as the command
([Jev endpoint](#jev-endpoint)), one key per host. `github-token` (default `github.token`) reads the
pull request and its issues; `artifact-name` (default `jev-intent-review`) names the artifact.
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
that came from `secrets` shows as `***` and one written into the workflow file does not.

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
| with no requirement in either form, or none anywhere | The job runs and judges nothing. | The check run's title, and the job summary. |
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
Action's entry. A budget per pull request is
[#42](https://github.com/yottayoshida/jev-intent-review/issues/42).
A pull request with no requirement in either form is skipped
(`policy.no_intent`), and one whose requirements cannot be read stops with exit 11, which makes the
job red — as does the Action's own stop (exit 10) on an event other than `pull_request` or a runner
whose Node is older than 22.18. That stop is the backstop for a workflow that reaches the Action
another way: under the workflow above, a job of any other event has no pull request to read a head
repository from, so the condition skips it before the Action starts. A change the change question could not judge — the budget, the host — is said in the
report's notes and does not make the check run neutral. Requirements the pull request's author wrote
in its own description are used and said to be theirs; the Action does not treat that as a reason to
fail. The runner needs Node.js 22.18 or later — `ubuntu-latest` carries it today, and on an older
image add `actions/setup-node` (with `node-version: 22`) before this step yourself; the Action does
not install Node, because `setup-node` leaves a problem matcher on the rest of the job.

Running the command directly in a workflow instead is fine, but its output is then yours to keep out
of the log — redirect stdout and stderr to files.

## Intent

No model writes the requirements and no model picks them out of prose. They are read from two forms, as written: the items of a requirements section (`## Acceptance criteria`, `## Acceptance`, `## Requirements`, `## Definition of done`, `## Done when`), and a paragraph that begins `Property:`. [docs/writing-requirements.md](docs/writing-requirements.md) has the details and an issue template to copy.

Whenever the tool prints its report, or stops because it could not read the requirements, every issue and pull request it read is either read into requirements as written — from a requirements section or a `Property:` paragraph, leaving out only HTML comments, code blocks, link reference definitions and characters that display as nothing — or named with the reason it was not. An issue the pull request closes and the tool does not read — in another repository, missing, or past the ten GitHub lists — is named too.

Intent that exists and was not checked is said in the report's notes: a source as high as any that was read and itself unread, requirements past the first twenty, and issues past the ten GitHub lists. Nothing is withheld for it, because no requirement verdict is stated ([ADR 0007](docs/adr/0007-the-run-is-the-local-check.md)).

A pull request described only in prose is therefore not checked: the report names it and says why, and a run with credentials stops with exit 11 rather than guess. A run without credentials is skipped, as before, and still says what it would have read. Failures that print no report (exit 10, 12, 13) are outside this.

## Jev endpoint

Jev is served by Cloudflare Workers AI, by TypeSafe itself, and by Vercel AI Gateway. Set `JEV_PROVIDER` to `cloudflare`, `typesafe` or `vercel` and that host's key, and this tool sends every judgment in that host's documented request form to that host's fixed URL, and to no other (Vercel AI Gateway then routes it to a provider of Jev; as of September 2026 that is TypeSafe only).

| `JEV_PROVIDER` | Key | Sent to | Jev's name there |
|---|---|---|---|
| `cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | `https://api.cloudflare.com/client/v4/accounts/<id>/ai/run` | `typesafe/jev` |
| `typesafe` | `TYPESAFE_API_KEY` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| `vercel` | `AI_GATEWAY_API_KEY` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` |

```sh
export JEV_PROVIDER=typesafe
export TYPESAFE_API_KEY=...
```

Without `JEV_PROVIDER`, the Cloudflare pair alone still selects Cloudflare, as before, and `JEV_API_URL` with `JEV_API_TOKEN` selects an endpoint of your own that serves the Workers AI run request. `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` on its own selects nothing: a key kept in the environment for something else does not start sending your code anywhere.

**Only Cloudflare has been called for real.** The TypeSafe and Vercel requests follow their documentation ([TypeSafe](https://docs.typesafe.ai/api), [Vercel](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)) and are tested against a stand-in, but the maintainer has no key for either: both addresses were checked with a deliberately invalid key, and each refused it with a JSON `authentication_error` (401) at the documented path and answered 404 one path segment off, but no judgment has been received from either. If a run fails there, the error names the host and what it answered; please [open an issue](https://github.com/yottayoshida/jev-intent-review/issues) with it. The published measurements were taken with `typesafe/jev` on Cloudflare; `jev-latest` may be a different version of Jev.

No other model is sent requests by this tool.

## What this is aiming at

The broader goal is an **Intent CI** for pull requests:

> derive the semantic surface of a change from its intent, rather than treating the git diff as the boundary of review.

The design is described in [docs/SPEC.md](docs/SPEC.md).

## Development

```sh
npm run typecheck
npm test
npm run build
```

## License

MIT OR Apache-2.0
