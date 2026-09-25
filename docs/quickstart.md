# Quick start: a Rust repository's pull requests

One page from a Rust repository on GitHub to a check run on its pull requests. What it reads and what
it does not, first:

> - **Rust only.** Calls are read in Rust functions. In any other language only the change question
>   runs, and no call is read.
> - **Requirements in two shapes.** A requirements section (`## Acceptance criteria`, `## Done when`, …)
>   or a `Property:` paragraph, in the pull request or an issue it closes. Prose is not read.
> - **Two things it can ask of a call**: how a failure must reach the caller, or that a check passes
>   before an action.
> - **No verdict.** A call *worth checking* is a candidate for a person to look at, not a failing test.
> - **Pull requests from forks are not reviewed**: GitHub gives them no secrets.

## 1. What you need

- A Rust repository on GitHub whose pull requests you can open.
- One Jev host and its key. The workflow below uses Cloudflare Workers AI: an account ID and an API
  token with Workers AI access. TypeSafe and Vercel AI Gateway work too — change the inputs as in
  [Jev endpoint](usage.md#jev-endpoint).

## 2. Add the workflow

Save this as `.github/workflows/intent-review.yml`:

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

There is no tag yet, so pin the Action to a commit of `main`, all 40 characters. The commit `main`
is at now:

```sh
gh api repos/yottayoshida/jev-intent-review/commits/main --jq .sha
```

and the last commit that changed this page, the one these steps were checked against:

```sh
gh api 'repos/yottayoshida/jev-intent-review/commits?path=docs/quickstart.md&per_page=1' --jq '.[0].sha'
```

## 3. Add the secrets

In the repository's *Settings → Secrets and variables → Actions*, add `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`. Or from a terminal:

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set CLOUDFLARE_API_TOKEN
```

## 4. Write one requirement

In the pull request's description, or in an issue it closes, one sentence under a requirements
heading. A sentence about a failure:

```markdown
## Acceptance criteria

- If reading an existing integrity baseline fails, the baseline-loading operation must return an
  error to its caller. It must not return a successful result saying that no baseline exists.
```

or about a check before an action, naming the action by a word its call carries:

```markdown
## Acceptance criteria

- A disabled API key must never create a session.
```

No file name, no function name, no expected answer. More, and templates to copy:
[writing requirements](writing-requirements.md).

## 5. Open the pull request and read the check run

The check run is "jev-intent-review result", in the pull request's checks.

- **Green**: calls were read and nothing is left to look at.
- **Grey (neutral)**: anything else — a call worth checking, a call not checked, a cap the listing hit,
  a run that found no requirement to check, or nothing read. The title says which. On a real
  repository nearly every run is grey; the job itself stays green.
- **Red**: the command did not finish, or it read the pull request and its issues and found nothing
  in either shape to read as a requirement (exit 11).

After a first line of counts and the requirements it read, each requirement's section in the check
run starts with what decides: each call worth checking, with the requirement, the two answers and
the code sent with it; then the calls not settled; then what was not read. The calls read
as holding, the calls not required of and the calls not checked are counted there, and listed,
each with its reason, in `report.md` in the artifact `jev-intent-review` — on the run's summary
page. A requirement that read no call lists its calls not checked in the check run too. A call worth checking in a
file the merge commit does not change is also marked on its lines.

A call worth checking leaves the job green. To make it fail, add `.jev-intent-review.yml` with
`policy.fail_on: [finding]` ([exit codes](local-check-cli.md#exit-codes)). It is read from the commit
before the change, so it takes effect from the pull request after the one that adds it.

What each part of the report means: [reading the output](local-check-cli.md#reading-the-output).
Everything the Action does, and which pull requests it reviews: [GitHub Action](github-action.md).
