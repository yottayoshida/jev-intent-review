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

`jev-intent-review` can surface that call even though the call itself is outside the diff.

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

[Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/) is used for small, fixed questions with probability distributions rather than open-ended review prose.

The evidence and judgments are kept visible so a finding can be inspected or rejected by a human.

## Current v0.1 scope

v0.1 is an experimental implementation of the broader intent-review model.

It currently supports:

* Rust repositories
* requirements describing how failures must propagate
* functions touched by the change and callers one hop out
* explicit requirements from an intent spec or acceptance-criteria list
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
  --experimental-local-check \
  --base <base> \
  --head <head> \
  --intent-spec spec.json
```

To inspect which calls would be analyzed without sending anything to Jev:

```sh
jev-intent-review \
  --experimental-local-check \
  --experimental-candidates-only \
  --base <base> \
  --head <head> \
  --intent-spec spec.json
```

`--pr` and `--issue` can also be used when the source contains an explicit acceptance-criteria list.

Use `--json` for the full machine-readable report.

## Jev endpoint

The current implementation calls `typesafe/jev` through Cloudflare Workers AI or another endpoint implementing the same run-request API.

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
```

or:

```sh
export JEV_API_URL=...
export JEV_API_TOKEN=...
```

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
