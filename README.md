# jev-intent-review

**Status: under construction. Nothing here is released yet; v0.1 is in progress. The command
line works; the GitHub Action is not written yet.**

jev-intent-review reports a requirement violation in code the pull request did not change,
and points to the file and lines as evidence.

A diff-only review sees the lines that changed. The usual miss is elsewhere: an issue asks that
disabled users can no longer sign in, the pull request adds the check to the password login, and
the OAuth callback and the WebSocket handshake, which the pull request never touched, still let
them in. jev-intent-review starts from the stated intent (an issue, acceptance criteria, or text
you pass in), searches the repository after the change for every place that intent applies to,
and asks [Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/) — a model that answers
fixed, typed questions — one small question per place. The result is a table of requirements
against code locations, each marked `VERIFIED`, `VIOLATION`, `UNKNOWN` or `NOT_APPLICABLE`.

It only speaks about the places it found. It never claims that finding nothing means the code is
correct.

The design is in [docs/SPEC.md](docs/SPEC.md).

## Using it from the command line

```sh
git clone https://github.com/yottayoshida/jev-intent-review && cd jev-intent-review && npm ci
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...   # a token with Workers AI permission

cd /path/to/your/repository
node /path/to/jev-intent-review/src/cli/main.ts --pr 123              # the issues it closes, then its description
node /path/to/jev-intent-review/src/cli/main.ts --base main --intent "Disabled users cannot sign in."
```

`--pr` and `--issue` read GitHub with `GITHUB_TOKEN`, `GH_TOKEN` or a logged-in `gh` (public
repositories also work without one). `--intent-spec file.json` skips the requirement compiler
and takes requirements as written. `--json` prints the report as JSON, `--trace` prints every
search, candidate and answer to stderr, `--help` lists the rest.

Exit codes: 0 no confident violation, 1 violation, 2 analysis incomplete (unknown results when
`policy.unknown: fail`, or an unexpected error), 10 configuration error, 11 intent could not be
resolved, 12 the judgment provider failed, 13 the repository could not be read.

What it costs, measured: the `missed-path` fixture takes 7-8 requests (18-19 KB) and 2-3
seconds. A real Rust pull request (omamori #559, one requirement from its issue, 30 places
judged) took 31 requests (172 KB) and 14 seconds in all; turning an issue into requirements
alone has taken up to 26 seconds.

## Differences from the spec

| Spec | This implementation | Why |
|---|---|---|
| §17 J3, §18, §27: `violation_confidence: 0.75` on Jev's confidence | `judgment.violation_probability: 0.7`, `satisfaction_probability: 0.5`, `relevance_probability: 0.6`, on the probability Jev gives the chosen answer | Measured: correct `violates` answers carried a `confidence` of 0.39-0.52, so 0.75 would have made every real violation UNKNOWN. On the fixtures the probabilities separate: 0.79-0.92 on violating paths, at most 0.04 on the others. On a real pull request they do not by themselves: places that were not violations drew `violates` at up to 0.87. What set those apart was the first answer (a path at 0.50-0.62, against 0.98-0.99 for real violations), so a violation needs `violation_probability` on both answers |
| §15, §27: 2,000 characters of code and 2,000 of context | 8,000 and 4,000 | Real functions are longer than 2,000 characters, and a cut function cannot be VERIFIED |
| §15: split long evidence by semantic region | Cut long evidence and report it | Splitting separates a guard from the call it guards, which reads as a violation |
| §14: ripgrep and the working tree | git objects only (`git grep <sha>`, `git cat-file blob`) | The before and after commits are read the same way, and nothing untracked or behind a symbolic link is read |
| §13 Layer D: relevance first, then satisfaction | Both in one request; relevance decides what counts | One round trip. A candidate Jev calls `supporting` or `unrelated` is not a path, so it is neither a violation nor a reason to withhold VERIFIED. A violation needs Jev to call the code a path at `violation_probability` or above: a CI script on a real pull request was called one at 0.54 and drew `violates` at 0.81, where real violations were called paths at 0.98-0.99 |
| §17 J5: a search-quality signal | Asked only when a requirement would be VERIFIED; anything but `likely_complete` at 0.5 or more withholds VERIFIED | It is never proof, but it can only make the result more cautious |
| §13: follow references of the changed code | Every call the changed functions make is followed (rarest first, at most 8), and the callers of anything Jev calls a mere wrapper are followed one hop further; whatever is not followed makes the search incomplete, which withholds VERIFIED | A requirement is only as verified as the search that looked for its places |
| §24: `jev-intent-review review` | `jev-intent-review` | There is one command |

## Development

Node.js 22.18 or later runs the TypeScript sources directly; there is no build step for tests.

```sh
npm ci
npm run typecheck
npm test
```

Two scripts ask the real model and are not part of CI; both need `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`:

- `npm run probe:jev` sends hand-built evidence from the `missed-path` fixture and checks each
  answer.
- `node bench/fixtures.ts [runs]` runs every fixture end to end through the command line and
  checks the requirement status and each path it expects to be, or not to be, a violation.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
