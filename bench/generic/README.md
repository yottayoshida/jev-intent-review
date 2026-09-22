# Benches of the generic run

Not to be confused with `bench/fixtures/`, the directory of patches the other benches apply.

The generic run — repository-wide discovery, a relevance and a satisfaction question per place, a
completeness question, a verdict per requirement — was retired in [ADR 0007](../../docs/adr/0007-the-run-is-the-local-check.md).
The two benches that drove it are kept here, with the questions they sent, because the logs they
produced are still in `bench/logs/` and the design record still quotes them:

- `fixtures.ts` — the harness that ran `main()` over the TypeScript fixtures and read the verdict.
- `probe-jev.ts` — the first probe of Jev on the missed-path fixture.
- `questions.ts` — `CANDIDATE_QUESTIONS` and `COMPLETENESS_QUESTIONS`, as they were sent.

This directory is outside the type check (`tsconfig.json`): these files run against a report shape
and functions that no longer exist, and are not maintained.
