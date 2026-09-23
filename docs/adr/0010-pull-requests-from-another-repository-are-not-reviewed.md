# 0010. A pull request from another repository is not reviewed, and says so where it is read

Status: Accepted

## Context

The Action (0009) runs on a pull request and asks Jev about the calls the change touches. GitHub gives a workflow started by a pull request from another repository — a fork — no secrets, and a `GITHUB_TOKEN` with read-only permissions. So such a run has no key to ask Jev with, and cannot create a check run to say anything in.

What that leaves today: the run is skipped for want of credentials, exits 0, and the job is green. A maintainer reads "Nothing was checked: skipped (no credentials)" in the job summary, adds the secrets, and nothing changes — the secrets were never the reason. A pull request opened by Dependabot reads the same way and has the same non-answer, though it comes from the repository itself.

Issue #42 asks for pull requests of an ordinary repository to end in a state a maintainer reads correctly without opening the logs.

## Decision

- **A pull request from another repository is not reviewed.** The workflow in the README runs its job only when the head repository is this repository, and the job is named for that condition, so the pull request's checks list shows a skipped job whose name says why. Nothing is run, no request is sent, and no runner time is spent.
- **The condition belongs to the job, not to a step.** A step-level condition leaves the job green, which is the reading 0009 set out to remove.
- **The reason a run asked nothing is decided once, in the command.** The report carries `skipKind` — `fork`, `dependabot`, `no_credentials`, `no_intent` — beside the sentence a person reads. The Action's check-run title switches on that value, never on the sentence's wording, and an unknown or absent value falls through to "see the job summary".
- **Where a pull request came from is read from the event's head and base repositories**, never from a repository's own `fork` flag, which is true of a pull request opened inside a fork against that fork — a run that does get the secrets. A head repository GitHub answers with nothing is another repository too: it is a fork that has been deleted, and a repository cannot be deleted while it holds its own open pull request.
- **The command's comparison and the workflow's condition are not the same rule.** GitHub's expressions compare without regard to case; the command compares exactly. Both are handed the names GitHub writes, which are one spelling, so the two agree on every event seen — but the condition is the one that decides whether anything runs, and the command's answer is only read when something did.
- **`policy.no_intent` stays `skip`.** A pull request with no requirement in either documented form is not the contributor's mistake to fix, and failing it would make every such pull request red.
- **This settles #42's third Done when** — that no configuration lets a pull request from a fork make a run with secrets do anything but send redacted packets — by removing the run: with the README's workflow there is no run with secrets on such a pull request, and `pull_request_target`, the event that would give one, is refused at the Action's entry (0009).

## Alternatives considered

- **Two workflows**: an unprivileged run on the pull request collects the evidence packets, and a privileged `workflow_run` sends them. The privileged side would then send what the pull request's own code assembled, to an endpoint the pull request's configuration can reach. That is the shape #42's third Done when exists to prevent.
- **A maintainer starts the run by label or comment**: it settles who starts a run, not what runs — the code and the packets are still the pull request's.
- **Refuse in the Action and make the job red**: a contributor cannot fix a red they did not cause; the repository's owner would be the only one who could.
- **Say the reason only in the Action** (a check-run title built from the event): the title would then say "from a fork" while the job summary, `report.md` and the artifact, all drawn from the command's report, said "no credentials" — two readings of one run on one page, which 0009 exists to prevent.

## Consequences

- A repository that copies the README's workflow reviews its own pull requests and leaves everyone else's plainly unreviewed. A repository that wants fork pull requests reviewed cannot have it from this Action, and the README says so rather than leaving it to be discovered.
- **A check run carries two of the four titles.** The token a fork's run holds, and the one Dependabot's run holds, cannot write checks, so the check run is refused and the Action says so instead; the two reasons a check run does carry are `no_credentials` and `no_intent`. Under the workflow above a fork's pull request does not run at all and its reason is the job's name in the checks list; Dependabot's runs, and reads its reason in the job summary and the warning annotation. The `fork` title is for the run that reaches the Action another way — a workflow without the condition — and for reports read later.
- What is quoted from GitHub's documentation, not measured here: that a fork's `pull_request` run receives no secrets and a read-only token — unless the repository turns on *Send write tokens to workflows from pull requests* — and that Dependabot's receives neither the repository's secrets nor a token that can write, whoever re-runs it. What is measured: the reason the command gives and the title the Action makes of it, against four pull requests that exist — a same-repository one, a cross-repository one (`cli/cli#14474`), one whose fork has been deleted (`cli/cli#14393`, where GitHub answers `head.repo` with nothing) and a Dependabot one (`cli/cli#14486`). Their `pull_request` objects are copied from the API's answer for those pull requests into the envelope a `pull_request` event has (`action`, `number`, `repository`), and kept in `test/fixtures/events/`: what they pin is the reading, not the whole shape of a delivered event. What is neither: this repository has no fork of its own to open a pull request from, so the condition has never been seen to skip a job in a live run.
- `skipKind` is one more field in `--json` (still `version: 2`). A reader that does not know a value gets the fallback.
