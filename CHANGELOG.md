# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Changes no requirement asked for are reported. Every changed region that carries behaviour is
  judged against the requirements, and the ones Jev calls unasked-for, at
  `judgment.violation_probability` or above, are listed with the lines that changed. Comments,
  blank lines, imports and files with no code are left out before anything is asked; regions that
  were judged and are not shown are counted in a note, so "nothing to report" reads differently
  from "nothing was looked at". Which requirement would have asked for a change is not guessed,
  and no sentence about a change is generated. A test of what a requirement asks for, a helper or
  fixture such a test needs, and the comments on code that carrying a requirement out added, all
  count as part of carrying it out. Measured on the five real pull requests that had anything to
  report, with the same requirements and the same commits on both sides: 32 reports became 24,
  over an identical number of regions judged (20, 42, 86, 48 and 41), and a test written for an
  unasked-for change is still reported with it. Per pull request the change is not uniform — one
  went from 9 to 3, one from 6 to 7 — so part of this is the model's own spread. The report's
  `questionsHash` is `05f56019f295`; the wording before it hashed to `0e38233a1edf`.
- The endpoint for the judgments can be any HTTPS endpoint that runs the tool's models from a
  Workers AI run request: set `JEV_API_URL` and `JEV_API_TOKEN`. Without them it is Cloudflare
  Workers AI from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, as before. Each token is
  sent only to the endpoint of its own pair, the URL comes from the environment and never from
  the configuration file, it must be `https:` (`http:` only for a loopback host) and carry no
  credentials, redirects are never followed, and the report names the endpoint's origin.

- Requirement verification from the command line. Intent comes from `--pr` (the issues a pull request closes, then its description, each with its author; outside a workflow, `--pr` also names the change: the pull request's base branch and head commit), `--issue`, `--intent`, `--intent-file`, or `--intent-spec` on its own. When every source lists its criteria under an "Acceptance criteria" style heading, those items become requirements as written (an item too short to check is listed as an ambiguity, not dropped); otherwise all sources go to a Workers AI model together, and every requirement it writes must quote a sentence of its source. For each requirement the tool searches the repository after the change — from every call the changed functions make, and from the words the change checks — and follows the callers of anything Jev calls a mere wrapper one hop further. It builds bounded, redacted evidence that includes how each place is reached and the bodies of what it calls, asks Jev whether each place is a path the requirement governs and whether it satisfies it, and reports a violation only when Jev both calls a place a path the requirement governs and says it fails there, each at `judgment.violation_probability` or above. VERIFIED needs every relevant place satisfied on evidence that was not cut, a search that was not cut short (every call followed, nothing too common to search), Jev judging the list of places likely complete, and no edit to the tool's configuration or workflows; otherwise UNKNOWN. With no credentials or no intent the run is skipped with exit 0, or fails, as `policy.missing_credentials` and `policy.no_intent` say.
- The groundwork for the command line tool: it reads the change between two commits from git
  objects, never from the working tree's files or `.gitattributes`, and passes every diff setting
  explicitly so git config does not change what is read. It finds the function around each
  changed line and the calls made around it, loads `.jev-intent-review.yml` from the commit
  before the change, reads requirements from `--intent-spec`, and renders the report as Markdown
  or JSON. A Jev client for Workers AI is included, with retries and a request, byte and time
  budget counted on what is actually sent; `npm run probe:jev` uses it to ask the real model. The
  command line does not call it yet. Requirement verification itself is not in this build: every
  requirement is reported as unknown and the run exits 2.

### Changed

- A run that sent judgments and got no answer it could read now exits 12 instead of reporting
  every place as unknown. A 404, a 405, a redirect, or a second unusable answer (refused, not
  JSON, or a failure the endpoint reports) while none has been read is taken as the endpoint
  rather than the request: the run stops as soon as one comes back, and nothing is sent after
  that, bar what was already in flight. A rate limit and a server error are never read that way. A run with no candidates, and a run that stops on its own
  request, byte or time budget, are unaffected and still report what they have.
- The requirement writer now sends its model in the body (`POST …/ai/run` with `{"model",
  "input"}`) rather than in the path, the same request as a judgment. Measured on Workers AI, both
  forms answer alike; this is the one change that reaches a run using only `CLOUDFLARE_*`.
- The endpoint's variables are read before anything else, so a malformed `CLOUDFLARE_ACCOUNT_ID`
  or `JEV_API_URL` now exits 10 even on a run that would have been skipped for want of an intent.
- Licensed under MIT OR Apache-2.0, at your option (it was MIT alone). The texts are in
  `LICENSE-MIT` and `LICENSE-APACHE`.
