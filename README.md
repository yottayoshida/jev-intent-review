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
+ other callers of what the changed code calls
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
* requirements describing how failures must propagate
* functions touched by the change and callers one hop out, and the other callers of the repository functions the changed code calls — the path a fix may have missed
  (not yet measured on code the tool was not tuned on)
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
