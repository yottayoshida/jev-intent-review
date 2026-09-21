# 0001. One replaceable endpoint for every model call

Status: Accepted, amended by [0003](0003-jev-on-three-hosts.md) (one request shape for every
endpoint no longer holds: TypeSafe and Vercel AI Gateway are named hosts with their own)

## Context

Every model call (Jev's judgments, and the model that writes requirements from prose) went to
`https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/ai/run`, with
`CLOUDFLARE_API_TOKEN` as the bearer token. The owner asked for the tool to work with any API
that can call Jev, keeping the request Workers AI's.

Measured against Workers AI on 2026-09-19:

- Jev answers only in the body form: `POST …/ai/run` with `{"model": "typesafe/jev", "input": …}`.
  `POST …/ai/run/typesafe/jev` is refused with 400 "No route for that URI", whether the body is
  `{"input": …}` or `{"state": …, "questions": …}`.
- The requirement-writing model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) answers in both
  forms, `POST …/ai/run/<model>` and `POST …/ai/run` with `{"model", "input"}`, with the same
  envelope: the same keys under `result`, and the JSON answer in `result.response`.
- Node's `fetch` follows redirects by default and, within one origin, resends the `Authorization`
  header to the new location.

## Decision

- One endpoint URL, the equivalent of `…/ai/run`. Every call POSTs `{"model", "input"}` to it,
  the requirement writer included.
- `JEV_API_URL` and `JEV_API_TOKEN` choose it, by this table. An empty or blank value counts as
  unset. The GitHub Action takes these names as inputs and follows this table. Each token goes
  only to the endpoint of its own pair, so forgetting the URL cannot send another service's token
  to Cloudflare.

  | `JEV_API_URL` | `JEV_API_TOKEN` | `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_API_TOKEN` | Result |
  |---|---|---|---|---|
  | set | set | any | any | that URL, with `JEV_API_TOKEN` |
  | set | unset | any | unset | no credentials (`policy.missing_credentials`) |
  | set | unset | any | set | configuration error: the Cloudflare token is never sent elsewhere |
  | unset | set | any | any | configuration error: that token has no endpoint of its own |
  | unset | unset | set | set | Cloudflare, with `CLOUDFLARE_API_TOKEN` (as before) |
  | unset | unset | not both | — | no credentials (as before) |

- The models are `typesafe/jev` (every judgment) and `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
  (writing requirements from prose only). An endpoint must accept both to serve every path. An
  answer is read with or without Workers AI's REST envelope (`{"result": …}`), so a proxy that
  returns what `env.AI.run()` gave it works too.
- The URL comes from the environment only, never from `.jev-intent-review.yml`, so the
  repository's content cannot choose where the token goes. It must be `https:` (`http:` only for a
  loopback host: `localhost`, `127.0.0.1` or `[::1]` exactly), must not carry credentials, and
  redirects are not followed.
- A wrong endpoint fails the run instead of making every place unknown. A 404, a 405, a redirect
  (taken with `redirect: "manual"` and read from the status), or a second answer the tool cannot
  use while it has read none is the endpoint's answer about itself: the run stops when one comes
  back and nothing is sent afterwards, though the requests already in flight cannot be recalled. A
  rate limit and a server error are not read that way. A run that sent judgments and got no answer
  it could read exits 12. A run with no candidates reaches
  nothing, and a run that stops on its own budget keeps its report.
- A URL without a token counts as no credentials (skipped or failed by
  `policy.missing_credentials`), so a fork's pull request, which sees the URL but not the secret,
  does not send unauthenticated requests.

## Alternatives considered

- A base URL with the model appended to the path, the form Cloudflare AI Gateway uses for Workers
  AI: Jev does not answer in that form (above). Whether a gateway can reach Jev at all is not
  known; the documentation does not name one.
- A pluggable request shape (a generic HTTP provider, an OpenAI-compatible endpoint for the
  requirement writer): offered to the owner and not chosen.
- A command line flag for the URL: the token is passed through the environment only, so the pair
  stays together there.

## Consequences

- Any endpoint that accepts the Workers AI run request for both models works, including a local
  stand-in for tests. Only Cloudflare itself has been tried; Cloudflare AI Gateway's Workers AI
  route puts the model in the path, which Jev refuses, so a gateway is not expected to work.
- An endpoint that does not host the requirement writer's model fails only the path that writes
  requirements from prose (`--intent`, issue and pull request text without an acceptance-criteria
  list); `--intent-spec` and acceptance-criteria lists do not call it.
- The report names the endpoint's origin, so a reader can see where the evidence went.
- Whoever controls the endpoint controls the verdict, so a report sent anywhere but the default
  says where at its top.
- The GitHub Action (a later change) passes the tool only the variables of the table it was given
  as inputs, and discards any `JEV_API_*` or `CLOUDFLARE_*` inherited from the environment: a
  workflow that writes to `$GITHUB_ENV` could otherwise point the token elsewhere.
