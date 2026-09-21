# 0003. Jev through Cloudflare, TypeSafe or Vercel, named by JEV_PROVIDER

Status: Accepted

Amends [0001](0001-judgment-endpoint.md): its token pairing, URL checks, redirect handling and
stopping rules stand; its choice of one request shape for every endpoint does not.

## Context

0001 answered "work with any API that can call Jev" by making the URL replaceable while keeping
Workers AI's run request. Jev is served by three hosts, and two of them take a different request:

| Host | Endpoint | Request body | Jev's name |
|---|---|---|---|
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/<id>/ai/run` | `{"model", "input": {"state", "questions"}}` | `typesafe/jev` |
| TypeSafe | `https://api.typesafe.ai/v1/systemone` | `{"model", "state", "questions"}` | `jev-latest` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `{"model", "state", "questions"}` | `typesafe-ai/jev` |

So `JEV_API_URL` could not reach Jev on TypeSafe or Vercel, and users of either were shut out. The
maintainer uses Cloudflare; the tool must not lock out the others.

## Decision

- The three hosts are a closed table in the client module: URL, Jev's name, request shape and a
  display name for each. An `Endpoint` carries which host it is (`cloudflare`, `typesafe`,
  `vercel`, or `custom` for `JEV_API_URL`) and no model name. The client refuses a host outside the
  table, holds a named host to its fixed URL, and copies the endpoint when it is built, so no caller
  can send another model, or send a named host's key elsewhere.
- `JEV_PROVIDER` names the host: `cloudflare`, `typesafe` or `vercel`, exactly; blank is unset and
  anything else is a configuration error. The named host's key is `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_API_TOKEN`, `TYPESAFE_API_KEY`, or `AI_GATEWAY_API_KEY`. Without it the run has no
  credentials (`policy.missing_credentials`), whatever other hosts' keys are set. (`JEV_API_TOKEN`
  without `JEV_API_URL` is a configuration error either way: it is sent nowhere else.)
- Without `JEV_PROVIDER`, selection is what it was: `JEV_API_URL` with `JEV_API_TOKEN`, else the
  Cloudflare pair, else no credentials. `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` alone never
  select a host. `JEV_API_URL` together with `JEV_PROVIDER` is a configuration error.
- The transport refuses any model but the Jev name of the endpoint's host, before anything is sent.
- Every failure that comes back from a host names the host and its origin, including an answer of
  the wrong shape. (The run's own budget and a refused model name are not a host's answer.)
- An answer's probability for its choice is checked: `probabilities[choice]` when present, else
  `confidence`, finite and within 0..1; every kept probability is too. `confidence` is optional.
- 529 is retried like 429 and 5xx.
- The variable names read are one exported list, used for selection and for keeping them from git.

## Alternatives considered

- Select the host from whichever key is set, `JEV_PROVIDER` only when several are:
  `AI_GATEWAY_API_KEY` is Vercel's key for every model it routes, and a key kept for another use
  would, on upgrade, turn "nothing is sent" into "the repository's code is sent to Vercel and
  TypeSafe" without any setting having changed.
- Keys under names of this tool's own (`JEV_TYPESAFE_API_KEY`): a second name for each vendor's key.
- `JEV_API_URL` plus a request-format setting: users would look up three URLs and model names, and a
  key could be pointed at any URL again.
- Vercel's `/v1/evaluate`: a different answer shape; its TypeSafe-compatible route takes the same
  request as TypeSafe.

## Consequences

- A key goes only to its own host's fixed URL.
- Only Cloudflare has been called for real. TypeSafe and Vercel are built from their documentation
  and checked against a stand-in; the README says so, and a failure names the host so that a
  report is enough to act on. `jev-latest` may be a different version from the `typesafe/jev` the
  published measurements were taken with.
- Vercel AI Gateway routes each judgment to a provider of Jev; as of September 2026 that is
  TypeSafe only. This tool does not restrict the gateway's routing.
- The host is chosen from the environment only, never from `.jev-intent-review.yml`. A future
  GitHub Action discards every variable in the list from the environment it inherits (0001 named
  `JEV_API_*` and `CLOUDFLARE_*`; the list adds `JEV_PROVIDER`, `TYPESAFE_API_KEY` and
  `AI_GATEWAY_API_KEY`).
- Residual: an error Vercel passes through from TypeSafe could quote a TypeSafe key registered
  with Vercel (BYOK); only the user's own key is redacted.
