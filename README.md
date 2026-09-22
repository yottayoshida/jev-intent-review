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

* Rust repositories
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

`--pr`, `--issue`, `--intent` and `--intent-file` take the requirements from the issue, the pull request or the text given, in the forms described under [Intent](#intent).

Use `--json` for the full machine-readable report.

## Intent

No model writes the requirements and no model picks them out of prose. They are read from two forms, as written: the items of a requirements section (`## Acceptance criteria`, `## Acceptance`, `## Requirements`, `## Definition of done`, `## Done when`), and a paragraph that begins `Property:`. [docs/writing-requirements.md](docs/writing-requirements.md) has the details and an issue template to copy.

Whenever the tool prints its report, or stops because it could not read the requirements, every issue and pull request it read is either read into requirements as written — from a requirements section or a `Property:` paragraph, leaving out only HTML comments, code blocks, link reference definitions and characters that display as nothing — or named with the reason it was not. An issue the pull request closes and the tool does not read — in another repository, missing, or past the ten GitHub lists — is named too.

In the review, intent that exists and was not checked withholds VERIFIED: a source as high as any that was read and itself unread, requirements past the first twenty, and issues past the ten GitHub lists.

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
