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
against code locations, each marked `VERIFIED`, `VIOLATION` or `UNKNOWN`.

VERIFIED means every place Jev judged, at `judgment.relevance_probability` or above, to be a path
of the requirement satisfies it. It is a claim over those paths and nothing wider, so the section
lists them and says what was set aside and what the search did not follow — including when there
is only one of them: `VERIFIED over 1 discovered path`, with `Coverage: weak — 30 of 159 place(s)
judged, 1 path(s), 29 set aside` under it.
A place Jev does not call a path, or calls one too weakly to count, decides nothing either way:
it is listed, not left to hold the requirement open.

It reads the other direction as well: every change the pull request made that carries behaviour is
held against the requirements, and the ones no requirement asked for are listed with their own
lines. What the report shows is the excerpt itself — never a sentence describing it. Left out
before anything is asked: a blank line, a line that opens a comment (`//`, `/*`, `# `, `-- `,
`;;`, `"""`, `<!--`) or continues one (`* `), an import, a file the tool does not read as code
(prose, JSON, YAML), and a path it never reads at all. A line inside a block comment that carries
no marker of its own is not recognised as a comment, and costs one question.

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

Judgments go to Cloudflare Workers AI by default, or to any HTTPS endpoint that runs the tool's
models from a Workers AI run request (`POST` with `model` and `input` in the body): set
`JEV_API_URL` and `JEV_API_TOKEN` instead. The models are `typesafe/jev` for every judgment and
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` when requirements are written from prose, so an
endpoint that serves only one of them serves only the paths that use it. An answer is read with
or without Workers AI's `{"result": …}` envelope, so a proxy that returns what its own
`env.AI.run()` gave it works too. Cloudflare AI Gateway's Workers AI route puts the model in the
URL, which Jev refuses, so a gateway is not expected to work; that has not been tried.

Each token goes only to the endpoint of its own pair — `JEV_API_TOKEN` with `JEV_API_URL`,
`CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID` — and a mismatched pair is refused (exit 10)
rather than sent. Keep secrets out of the URL itself: an endpoint that echoes the request it was
sent hands a key in the query string straight back, and this tool can only redact the part it
knows. The URL must be `https:`, or `http:` for `localhost`, `127.0.0.1` or `[::1]`
(with `NODE_USE_ENV_PROXY=1`, on the Node versions that honour it, even a loopback address can go
out through a proxy in the clear). It comes from the environment only, never from
`.jev-intent-review.yml`, redirects are never followed, and a report names the endpoint's origin
— which is written to the run's log, public for a public repository.

`--pr` and `--issue` read GitHub with `GITHUB_TOKEN`, `GH_TOKEN` or a logged-in `gh` (public
repositories also work without one). Outside a workflow, `--pr` also names the change: its head
commit, and the commit it started from — the latest commit the head still shares with the base
branch, with `origin`'s copy of it, or with the base commit GitHub recorded for the pull request.
A run whose two commits are the same stops with exit 10 rather than reporting on an empty change. `--intent-spec file.json` skips the requirement compiler
and takes requirements as written. `--json` prints the report as JSON, `--trace` prints every
search, candidate and answer to stderr, `--help` lists the rest.

Exit codes: 0 no confident violation, 1 violation, 2 analysis incomplete (unknown results when
`policy.unknown: fail`, or an unexpected error), 10 configuration error, 11 intent could not be
resolved, 12 the judgment provider failed — a refused token, an empty balance, a URL that does
not run models (a 404, a 405, a redirect, or a second answer the tool could not use while it has
read none), or a run that sent judgments and got no answer it could read — 13 the repository
could not be read. A run that stops on its own request, byte or time budget still reports what
it has, as before.

What it costs, measured: the `missed-path` fixture takes 8-11 requests (19-24 KB) and 2-4
seconds, of which one per changed region goes to the reverse direction. A real Rust pull request
(omamori #559, eight requirements from its issue, 30 places judged per requirement, 11 changed
regions) took 248 requests (1.5 MB) and 20 seconds in all — 8 of those requests, and 3%, for the
changes; turning an issue into requirements alone has taken up to 26 seconds.

## Differences from the spec

| Spec | This implementation | Why |
|---|---|---|
| §17 J3, §18, §27: `violation_confidence: 0.75` on Jev's confidence | `judgment.violation_probability: 0.7`, `satisfaction_probability: 0.5`, `relevance_probability: 0.6`, on the probability Jev gives the chosen answer | Measured: correct `violates` answers carried a `confidence` of 0.39-0.52, so 0.75 would have made every real violation UNKNOWN. On the fixtures the probabilities separate: 0.79-0.92 on violating paths, at most 0.04 on the others. On a real pull request they do not by themselves: places that were not violations drew `violates` at up to 0.87. What set those apart was the first answer (a path at 0.50-0.62, against 0.98-0.99 for real violations), so a violation needs `violation_probability` on both answers |
| §15, §27: 2,000 characters of code and 2,000 of context | 8,000 and 4,000 | Real functions are longer than 2,000 characters, and a cut function cannot be VERIFIED |
| §15: split long evidence by semantic region | Cut long evidence and report it | Splitting separates a guard from the call it guards, which reads as a violation |
| §14: ripgrep and the working tree | git objects only (`git grep <sha>`, `git cat-file blob`) | The before and after commits are read the same way, and nothing untracked or behind a symbolic link is read |
| §13 Layer D: relevance first, then satisfaction | Both in one request; relevance decides what counts, in both directions | One round trip. Only a place Jev calls a path at `relevance_probability` decides the requirement; everything else — supporting, unrelated, or a path named too weakly — is set aside with its reason and counted. Measured over 795 judged places on ten real pull requests: 19% were called paths at all, a median of 2 per requirement, so asking all ~30 to come back decided left VERIFIED at 0 of 38. A violation needs the path answer at `violation_probability` too: a CI script was called a path at 0.54 and drew `violates` at 0.81, where real violations were called paths at 0.98-0.99 |
| §21 J4: is a change asked for by a requirement | The same four answers, with tests, fixtures and the comments on code the change added counted as part of carrying a requirement out | Measured on real pull requests: of 32 changes the first wording called unasked-for, nearly all were a test of the change, a helper it needed, or a comment on a function the change itself added. Naming them in the question left 24 over the same regions, and a test written for an unasked-for change is still reported with it |
| §17 J5: a search-quality signal | Asked only when a requirement would be VERIFIED, and shown what the search left as well as what it found; anything but `likely_complete` at 0.5 or more withholds VERIFIED | It is never proof, but it can only make the result more cautious. Until this build no run reached the point of asking it on real code |
| §13: follow references of the changed code | Every call the changed functions make is followed (rarest first, at most 8), and the callers of anything Jev calls a mere wrapper are followed one hop further, with room of their own | A requirement is only as verified as the search that looked for its places |
| §20: "discovery confidence is adequate" | What the search left is reported and handed to J5, not each item blocking on its own. VERIFIED is withheld outright only for a path known by name and never judged, a run that stopped on its budget, or a change to this tool's configuration or workflows | Every one of 38 requirements on real pull requests carried at least one "not followed" reason (405 in all), so any-lead-blocks is unsatisfiable rather than strict. What is left is stated instead: the count of places found and not judged, of places set aside, and the leads themselves |
| §19: truncated evidence makes a place UNKNOWN | Read by which part was cut. The place's own code cut voids every answer; only its surroundings cut voids `violates` alone; surroundings that may belong to another definition of the same name void `satisfies` as well | Missing surroundings can hide a check, so no violation can be claimed on them, but they cannot remove a check that was seen. Measured: of 116 cut packets across five pull requests, 111 had the place's own code whole |
| §20: `NOT_APPLICABLE` as a requirement status | Removed | With only paths deciding a requirement, "does not apply here" cannot be told apart from "no place it applies to was found" (of 348 `not_applicable` answers, 3 were on a place called a path). A claim that cannot be told apart from ignorance is not made |
| §24: `jev-intent-review review` | `jev-intent-review` | There is one command |

## Development

Node.js 22.18 or later runs the TypeScript sources directly; there is no build step for tests.

```sh
npm ci
npm run typecheck
npm test
```

Two scripts ask the real model and are not part of CI; both take either pair of credentials
(`CLOUDFLARE_ACCOUNT_ID` with `CLOUDFLARE_API_TOKEN`, or `JEV_API_URL` with `JEV_API_TOKEN`) and
print which endpoint they used:

- `npm run probe:jev` sends hand-built evidence from the `missed-path` fixture and checks each
  answer.
- `node bench/fixtures.ts [runs]` runs every fixture end to end through the command line and
  checks the requirement status and each path it expects to be, or not to be, a violation.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
