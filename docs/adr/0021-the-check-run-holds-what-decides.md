# 0021. The check run and the job summary hold what decides; the artifact holds the whole report

Status: Accepted

## Context

A report's size grows with the calls the listing reaches, not with what was found. On a large pull
request most of it is *Not checked*: one line per call the budgets took and held, each with its
reason (the listing change of #38 took pybun#428's set-built-only report from 153 KB to 821 KB,
most of it those lines). The Action puts that report, whole, in the check run — cut at about
64 KB — and in the job summary — cut at about 1 MiB (ADR 0009). A maintainer opening the check run
to learn whether anything is worth looking at scrolls through the audit to find out, and on a run
whose report the check run cut, may not reach a requirement's findings at all: the sections were
ordered by how the run went, not by what a reader decides from (#86).

ADR 0009 decided that the check run holds the same report the command prints, so that the Action
and the command cannot disagree about a run. That is worth keeping; what the check run holds does
not have to be all of it.

## Decision

- **One order, by what a reader decides from.** In each requirement's section: *Worth checking*;
  *Not settled* (each call with its probability and the bodies sent with it); the requirement's
  *Notes* (what the listing did not read); then the audit — *Read as holding*, *Read, but not
  required of by the requirement*, *Every call read* (the list of calls read, which had no heading),
  and *Not checked*. *Changes no requirement asked for* moves above the requirements' sections. The
  counts at the head of a section — the functions reached, the coverage line (#38), the budgets,
  the outcomes — stay where they are. The command's own Markdown takes this order too.
- **One renderer, two views.** `renderMarkdown(report)` prints everything, as before;
  `renderMarkdown(report, { audit: false })` runs the same section code and replaces the audit of a
  requirement with one line of counts — so many read as holding, so many not required of, so many
  not checked, each with its reason in the full report — counted from the same calls the full view
  lists. The report's first line says the reasons are in the full report where it said they were
  under each requirement. A requirement that read no call keeps its *Not checked* lines (and a
  `--candidates-only` run its *Inside the budget*) in both views: for that requirement the reasons are
  all there is to read, and a grey check run that counted them and dropped them would say nothing.
- **The Action writes the decision view to the check run and the job summary, and the full view to
  the artifact.** `report.md` and `report.json` in the artifact are the whole report; the check run
  and the job summary get the decision view with one fixed sentence naming the artifact, on a run
  that produced a report. The byte limits and the cut at a line stay, with a sentence of their own,
  for a run whose findings alone do not fit.

This amends ADR 0009 in two sentences: "the check run holds the same report" becomes "the check run
holds what decides, and the artifact holds the same report", and "it is the report a maintainer gets
by running the command by hand" holds of the artifact's `report.md`, and of the check run's view
up to the audit it counts instead of listing. Everything else in ADR 0009 stands: one renderer, one
classification, the conclusion decided from the report's first line, nothing of the command's output
in the log.

## Alternatives considered

- **Reorder only, and leave the cuts to do the rest.** The job summary's limit is 1 MiB, so a report
  of 821 KB is shown whole there: findings first, and then everything. The check run's 64 KB cut
  would drop the audit, but at a line chosen by the byte count, and a run with many findings would
  lose findings.
- **Fold the audit in `<details>`.** Bytes are unchanged, so the 64 KB cut falls where it fell; and
  whether the check run's summary renders `<details>` was not measured.
- **A second renderer for the summary.** Two functions that count the same calls can disagree; ADR
  0009's reason for one renderer is that they cannot.
- **A flag on the command for the decision view.** The command has no artifact to point at, and
  `--json` is there for a program. Not added.
- **Group *Not checked* by reason** ("200 return no `Result`, 50 over the budget"). `Unchecked` carries
  its reason as a sentence, not a kind; giving it one touches the eight places a call is held and
  adds a field to `--json`. The coverage line already counts what was held, over the budgets and
  could not be asked. Not done here.

## Consequences

- The check run and the job summary of a large run are the findings, the calls not settled and what
  was not read, in about the bytes those take; the whole is one artifact away, as before.
- `--json` does not change. The Markdown's order changes for the command as well as the Action, so
  a reader of the command's output finds the audit last.
- A quickstart (`docs/quickstart.md`) can say what the first report shows, in the order it shows it.
- What is not promised: that the decision view fits the check run's 64 KB on every run — a run with
  dozens of findings is cut as before, at a line, with a pointer to the artifact.
