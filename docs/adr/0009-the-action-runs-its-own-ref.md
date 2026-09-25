# 0009. The Action runs its own ref, keeps the command's output out of the log, and reports in a check run

Status: Accepted, amended by [0021](0021-the-check-run-holds-what-decides.md) (the check run and
the job summary hold what decides, with the audit counted; the artifact holds the same report the
command prints)

## Context

`docs/SPEC.md` names "CLI + GitHub Actions" as the primary interface, and there was no Action (#41). The command already reads a pull request from the event, compares the pull request's merge commit with the commit before it, and loads its configuration from that earlier commit. What was missing is what makes a run mean something to a maintainer looking at the pull request: somewhere to read the result, and a mark that does not let a run that checked nothing pass for one that found nothing.

Three facts shape the choices below.

- The command's output carries text other people wrote: requirements from issues and pull requests, and excerpts of the repository. In a job log, a line beginning `::`, or containing an old-style `##[` command anywhere, is a workflow command, and `::stop-commands::` does not stop a problem matcher — a matcher that `actions/setup-node` or another step installed turns a line shaped like a compiler error into an annotation.
- GitHub Actions has no neutral job. A job that exits 0 shows ✓ in the checks list, whether it read a hundred calls or was skipped for want of credentials.
- The run reads calls only in Rust (0007). On a repository in another language, or a pull request whose change touches no call, the change question still asks and Jev answers, while no call is read.

## Decision

- **A composite action that runs the source at its own ref.** `action.yml` installs the one runtime dependency with `npm ci --omit=dev --ignore-scripts` and runs `src/cli/main.ts` with Node's type stripping (22.18 or later). The version of the command is the Action's ref; nothing waits for a publish to npm. Below Node 22.18 the Action stops and says so, rather than installing Node itself and leaving a problem matcher on the rest of the job.
- **The command runs once, with `--json`, and its output never reaches the log.** stdout, stderr and the install's output go to files under `$RUNNER_TEMP`. The Markdown report is drawn from the JSON by the same `renderMarkdown` the command uses, so it is the report a maintainer gets by running the command by hand on the same two commits. The log carries only sentences the Action writes. `finish.ts` catches every failure and logs its kind, never a message that could quote its input.
- **The result is a check run, and its conclusion follows the report's first line.** One function decides both: skipped, no requirement, nothing asked, no call read, or so many calls read of which so many are worth checking. The check run is `failure` when there is no report or the command's exit code is not 0; `success` only when the first line is "so many calls read", and no call was listed as worth checking, left not checked, or left without an answer (the budget, the time or the host), and no change came without being asked for; `neutral` otherwise. Which version of the Action ran — its ref and a hash of its `src` — goes in a file of its own beside the report, so the report stays what the command produced. The title says which, in fixed words and numbers. Annotations for findings go through the Checks API — never through the log — and only where the file is the same at the pull request's head and at the merge commit, so the line points where the finding is. Without `checks: write`, the Action says in the job summary that it could not create the check run, and warns in one fixed sentence when no call was read.
- **Keys come only from the Action's inputs.** The step that runs the command sets every name in `JUDGMENT_ENV` from an input, empty when the input is empty, so a key in the job's environment — a deploy token, say — is never used by accident.
- **`policy.missing_credentials` stays `skip`, and is no longer provisional.** Read by a maintainer on a pull request, `fail` turns every pull request from a fork red, since forks receive no secrets, and a contributor cannot fix that. `skip` with a neutral check run that says "Nothing was checked: skipped (no credentials)" cannot be read as a pass.

## Alternatives considered

- Running the published package (`npx jev-intent-review@<version>`): every Action version would need a publish to npm.
- A JavaScript action with a committed `dist/`: a second copy of the source that can drift from it.
- A Docker action: slow to start and Linux only.
- Printing the output to the log between `::stop-commands::` markers: stops workflow commands, not problem matchers.
- Deciding the conclusion from whether Jev answered anything (`sent.answered`): a run where only the change question answered would be `success` while its report says no call was read.
- Keeping the job green with only a warning: in the checks list a skipped run and a clean run both show ✓.
- Making the job fail when no call was read: every pull request from a fork, and every run on a repository in another language, would be red.
- A `--json-file` option on the command, to write the JSON beside the Markdown: a second output path in the command for what one JSON read and one render already give.

## Consequences

- The Action and the command cannot disagree about a report: there is one renderer and one classification.
- A run of the Action on a pull request that changes the Action itself (`uses: ./`) runs the pull request's own `run.sh` and `finish.ts`; its result says nothing about whether that change is sound. Two things follow from that, and only there: the pull request's own command could put a file — a link, even — where the artifact is uploaded from, and `npm ci --omit=dev` runs in the checkout, so a later step in the same job finds the development dependencies gone. Pinned to a commit of this repository, as a user does it, neither arises: the Action's directory is that commit's tree.
- Whether `neutral` beside a green job reads differently from a pass in the merge box and on the commit is measured on a real pull request, and the README says only what was seen.
- Pull requests from forks, pull requests with nothing to check (`policy.no_intent`), and a budget per pull request are #42.
