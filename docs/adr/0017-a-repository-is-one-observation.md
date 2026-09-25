# 0017. A repository is one observation, and the sealed set is opened on main first

Status: Accepted

## Context

Everything measured so far was measured on cases the tool had been tuned on or chosen by, and every
Jev request was counted as if it were independent of the others. `#80` asks for a protocol that keeps
evidence for release decisions apart from development feedback, fixes the unit of analysis and the
uncertainty before the first sealed result, and records every look at the sealed set.

## Decision

- **The unit is a target of a version; the observation is a repository.** Each rate is the mean over
  repositories of their own rates, and its interval is Clopper–Pearson with x the sum of those rates
  and n the number of repositories (`bench/eval/metrics.ts`), at 95 %, two-sided, at every number of
  repositories.
- **A gate needs enough repositories to pass at all**; with fewer, no release may cite it. The
  repositories each gate needs follow from its threshold and are computed, not chosen.
- **Every repository seen before the protocol is dev.** The sealed set is new repositories, found by a
  search committed before any of its results is read, kept on conditions that do not ask the tool, and
  placed by a hash salted with a main merge commit that only exists after the verdicts are on main.
- **Opening the sealed set is two steps**: a line appended and merged to main, then the run, which
  refuses until that line is on main. Openings are counted per repository across versions.

## Alternatives considered

- **Repository-cluster bootstrap.** Width 0 when every repository scores 1, so a gate on its bound
  passes with too few repositories; and it estimates the pooled rate, not the mean of repositories.
- **Calls or requests as the unit of the interval.** Calls of one function or one repository are not
  independent; the interval would be far too narrow.
- **The existing acceptance cases as the sealed set.** moltis-1064 and grovedb-500 decided the budget's
  split (ADR 0015) and the order inside a function; they are regression cases.
- **One step: run, then record.** A run that stops half way leaves no record, and a branch's record
  disappears with its closed pull request.
- **A fixed public salt.** Whoever judges a candidate could compute its side first.

## Consequences

- Seventeen repositories are needed before most gates can pass; the second batch searches for them.
- The host and alias a sealed run asks are known when it is opened; the version that answered only
  from the answers (`#84`), so it is written when the run ends.
- The metrics are conservative: when calls of a repository are in fact independent, the interval is
  wider than it needs to be.
