# Using the command

## Usage

Run against two revisions with an explicit intent spec:

```sh
jev-intent-review \
  --base <base> \
  --head <head> \
  --intent-spec spec.json
```

That is the whole run: the calls of the functions the change touched and their callers are read under each requirement's form, then every change the pull request made is asked about once. `--experimental-local-check`, which selected this run in 0.1, is still accepted: the report and the exit code are the same without it, and one line on stderr says so.

To inspect which calls would be analyzed without sending anything to Jev:

```sh
jev-intent-review \
  --candidates-only \
  --base <base> \
  --head <head> \
  --intent-spec spec.json
```

`--skip-change-check` reads the calls and leaves the changes unasked. `--pr`, `--issue`, `--intent` and `--intent-file` take the requirements from the issue, the pull request or the text given, in the forms described under [Intent](usage.md#intent).

Use `--json` for the full machine-readable report (`version: 2`; see [docs/local-check-cli.md](local-check-cli.md)). Its `metadata.modelIdentity` says which versions of Jev answered the run, as the host named them, beside the alias that was sent.

The report states no requirement verdict: each call it read is *worth checking*, *holding*, *not settled* or *not required of by the requirement*, and a call worth checking leaves the exit code at 0. A repository that wants CI to fail on one sets `policy.fail_on: [finding]` in `.jev-intent-review.yml`.

### Optional JevFuzz trace

Set `JEV_TRACE_FILE` to append one normalized JSONL record for each successful logical Jev judgment. Its parent directory and the file are owner-only (`0700` and `0600`); symlinks and non-private targets are rejected. Records contain provider-independent state, the Jev model name used for that host, typed questions, normalized choices, and a returned model version only when the gateway supplied one. They never include transport headers or API keys.

```sh
mkdir -m 700 /private/path/intent-review-jev
export JEV_TRACE_FILE=/private/path/intent-review-jev/trace.jsonl
jev-intent-review --base <base> --head <head> --intent-spec spec.json
```

## Intent

No model writes the requirements and no model picks them out of prose. They are read from two forms, as written: the items of a requirements section (`## Acceptance criteria`, `## Acceptance`, `## Requirements`, `## Definition of done`, `## Done when`), and a paragraph that begins `Property:`. [docs/writing-requirements.md](writing-requirements.md) has the details, an issue template and a pull request template to copy, and what to do about pull requests opened before them.

Which of the two things the check can ask — how a failure must propagate, or that a check passes before an action — a requirement's sentence says is Jev's one typed reading of the sentence, taken before its calls; when Jev reads neither or is not sure, the requirement is checked as failure propagation, as before, and the report says which form and who chose it ([ADR 0008](adr/0008-who-chooses-a-requirements-form.md)).

Whenever the tool prints its report, or stops because it could not read the requirements, every issue and pull request it read is either read into requirements as written — from a requirements section or a `Property:` paragraph, leaving out only HTML comments, code blocks, link reference definitions and characters that display as nothing — or named with the reason it was not. An issue the pull request closes and the tool does not read — in another repository, missing, or past the ten GitHub lists — is named too.

Intent that exists and was not checked is said in the report's notes: a source as high as any that was read and itself unread, requirements past the first twenty, and issues past the ten GitHub lists. Nothing is withheld for it, because no requirement verdict is stated ([ADR 0007](adr/0007-the-run-is-the-local-check.md)).

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

**Only Cloudflare has been called for real.** The TypeSafe and Vercel requests follow their documentation ([TypeSafe](https://docs.typesafe.ai/api), [Vercel](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)) and are tested against a stand-in, but the maintainer has no key for either: both addresses were checked with a deliberately invalid key, and each refused it with a JSON `authentication_error` (401) at the documented path and answered 404 one path segment off, but no judgment has been received from either. If a run fails there, the error names the host and what it answered; please [open an issue](https://github.com/yottayoshida/jev-intent-review/issues) with it. The published measurements were taken with `typesafe/jev` on Cloudflare; `jev-latest` may be a different version of Jev. Cloudflare named the version that answered as `jev-1.13.0` on 2026-09-25; from #84 on, every run records the versions named in `metadata.modelIdentity`, and the logs published before it record only the alias.

No other model is sent requests by this tool.

## Development

```sh
npm run typecheck
npm test
npm run build
```
