# 0024. The sealed set is opened on 17 repositories, checked before the line is written

Status: Accepted

## Context

`#80`'s two batches put 26 repositories on the sealed side; rule 7 stops the set at 17. `run.ts --set
sealed` could append an opening and refuse a run, but nothing fetched the cases from the private sandbox,
checked them against main's records, or ran `#88`'s baseline and adjudication on them. `PROTOCOL.md`
promised that `run.ts` checks every sealed case against its batch's hashes before it opens the sealed set,
and said the check was done by hand until then.

## Decision

- **The set opened**: the first 17 of `#80`'s sealed repositories, ordered by the number of the first
  kept row of each (owner, 2026-09-25/26). The other 9 stay unopened, the replacements a contaminated
  repository needs.
- **Checked before the line is written**: `open` checks, sending nothing, that each batch file's sha256
  is main's, that each case's files are exactly the batch's `files_sha256`, that the repository (or the
  fork it was read on, `readAs`) is one of the 17, that each version rebuilds from its patches — at
  case.json's SHAs when the case records it was built with `build-branches.sh`; a case built another way
  cannot reproduce its commits' author and date, so the rebuilt commits are its version and the line
  records them (found on the rehearsal: dev row 143) — and — with two `claude -p` runs — that the annotators can read their directory and
  nothing outside it. Any failure refuses before the line exists, so a failed check does not spend an
  opening. `run` checks again, at the commits the line recorded.
- **Both systems and the adjudication under one opening**: jev, then the baseline on the same bytes (on a
  version jev sent nothing on, the median of what it sent on the run's other versions, owner 2026-09-26), then
  BASELINE.md's adjudication (one rewriter, three annotators, about 184 runs, owner 2026-09-26), whose
  prompts are fixed and hashed in the opening line.
- **Where results live**: what holds a case's content (the three logs) goes to the sandbox's `results`
  branch; main gets the result line with their sha256 and a report of numbers only.
- **Stopping**: a baseline or adjudication run that cannot be counted is taken again; the same version
  failing twice, or five failures in all, stops the run, as does jev finishing fewer than three runs of a
  version in its own five attempts. A stopped run writes no result line and is opened again (a second
  `run` of it in the same directory is refused); only the last opening that wrote a result line counts.
- **Rehearsal**: the same path runs on one case of the sandbox's `dev` branch, which has the same form
  and hash chain and may be read at will.

## Alternatives Considered

- All 26: 342 baseline runs, beyond the 255 allowed.
- The check in `run` only: a failure after the line is on main spends an opening of all 17.
- Adjudication after the run: its prompts would be written after the hit counts were seen.
- Resuming a stopped run: one opening would send twice.

## Consequences

The sealed evaluation can be run once, end to end, from a clean tree. It takes about 409 `claude -p`
runs and a jev measurement of 17 cases, likely most of a day. The 9 unopened repositories stay usable
only while no one reads them.
