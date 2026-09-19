# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
