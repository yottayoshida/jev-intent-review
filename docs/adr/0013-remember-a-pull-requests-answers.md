# 0013. A pull request's answers are remembered, and a later push does not ask again

Status: Accepted

## Context

ADR 0012 measured that, across consecutive pushes of a pull request, most judgments ask Jev about evidence it has already answered: a median of 0.852 over 31 pairs from 12 pull requests, 0.616 on each pull request's first pair, every count above the 0.50 fixed beforehand. `synchronize` runs the whole review on each push, so a pull request pays for the same answers again every time.

## Decision

- **The command takes `--answers <dir>`**. It reads the answers kept there and appends each new one as it comes back, so a run that stops early keeps what it was given. A judgment whose key is already there is not sent; its answer is used and counted in `sent.reused`.
- **The key is what would be sent**: the SHA-256 of `[host, origin, model, state, questions]`. The questions are their words, so a version of the tool that changes a question misses on its own. The host and origin are in it because two hosts share the model name `typesafe/jev`. The file holds keys and answers only — never `state`, which is the repository's code.
- **The ledger wraps the provider in `main.ts`**, outside `LimitedProvider` (a remembered answer must not take a concurrency slot or be discarded at the deadline) and outside `deps.judges`. Two identical keys in flight in one run share one request.
- **The ledger is opened only after the run has decided it has credentials.** A run without them — a fork's pull request, Dependabot's, no keys — is skipped as before and never reads the ledger, so answers written into a pull request's cache cannot produce a report without Jev.
- **Counts keep their meaning.** `sent.answered` stays the requests Jev answered, the form question included; answers taken from the ledger are `sent.reused`, a new field, and `sent.reusedFromEarlierRuns` says how many of those an earlier run kept rather than this one (`--json` stays `version: 2`). A run stops with exit 12 when it sent at least one judgment (the form question aside) to Jev and got no answer to any, whatever it reused; one its own budget ended does not count, as without the ledger. The report's result line counts reused answers as asked, so a run answered entirely from the ledger does not read "Nothing was asked".
- **The Action keeps the directory with `actions/cache`**, pinned by commit: one key per run and job (`…-pr<number>-<run_id>-<run_attempt>-<job>`, so a save never collides), restored by a prefix that includes the pull request's number, saved with `if: always()` only when a ledger file exists. `remember-answers: false` turns it off. `actions/cache` writes its key and whether it hit to the job log; the key is numbers and fixed words, so nothing of the repository reaches the log (ADR 0009 is about what the Action itself writes).

## Alternatives considered

- **Sign each line with an HMAC of the API key.** A same-repository pull request's workflow can read the secrets, so it can read the HMAC key too and sign a forged line. It closes nothing.
- **Blank line numbers in the key.** ADR 0012: two points more (0.852 → 0.869), and "the same evidence" would mean something else.
- **Run the Action itself twice in this repository's CI.** The Action reads requirements from the pull request and its issues only, and most of this repository's pull requests hold none in a form the tool reads, so the job would be skipped. CI instead runs the command with `--answers` over a fixed case, twice across two jobs through `actions/cache`, against a stand-in endpoint, and a test holds `action.yml`'s cache key to the same shape.

## Consequences

- What is trusted: whoever can write the pull request's cache. A fork's cache stays in its own `refs/pull/N/merge` scope, whose runs have no secrets and never read it. **A same-repository author can add a workflow that saves forged answers and remove it in a later push; the later report uses them, and says nothing about a changed workflow.** Its only mark is the "M kept from earlier runs" count on the report's *Sent to the judgment model* line.
- Not guaranteed: a cache GitHub has evicted (7 days unused); a run answered entirely from the ledger does not notice a revoked key; parallel legs of a matrix share a key, and the second save only warns; whether a run cancelled by `concurrency` still saves is not yet measured on GitHub; runs of one pull request that overlap each restore the newest cache when they start, so one's additions may not reach the next. The Action restores the cache even for a run without credentials, which the command then does not open, and saves it back unchanged.
- The trace (`JEV_TRACE_FILE`) holds only what Jev answered in this run.
- #42 stays open: a budget per pull request, a documented way to hand over requirements, and a public test repository remain.
