# 0004. Requirements are read from documented forms, as written

Status: Accepted

Amended by [0007](0007-the-run-is-the-local-check.md): the blockers below — intent that exists and
was not checked — are said in the report's notes, since no requirement verdict remains for them to
withhold. What is read, what is named, and what the change question is not given are unchanged.

## Context

Since 0.1.0 no model writes requirements: they come from `--intent-spec` or from the items under an
"Acceptance criteria"-style heading. On the ten pull requests of the first measurement and on
omamori PR `#476`, that reads nothing at all (0 of 11): no issue and no pull request has such a
list, and the reader also dropped a list that was there whenever another source was prose. A list
item that wrapped onto a second line was cut after the first, and the items after it were lost
without a word. When nothing was read, the run stopped and named the two forms that work, without
saying which sources it had read or why each was not used.

Two ways out were considered (#40): decide the forms an author writes and read them as written; or
split every source into sentences and have Jev choose which ones state a required behaviour.

## Decision

- Requirements are read from documented forms only, as written. No model writes them, and no model
  chooses them.
- The forms: the items of a requirements section (`Acceptance criteria`, `Acceptance`,
  `Requirements`, `Definition of done`, `Done when`, and 受け入れ条件 / 要件 / 完了条件), one requirement per
  item, continuation lines included; and a paragraph that begins `Property:` (or `**Property** —`,
  `Property —`, `Property (…):`), one requirement per paragraph. `docs/writing-requirements.md`
  documents them.
- Each source is read on its own. A source in one of the forms is read even when another is prose;
  a source that is not is named in the output with the reason.
- Left out, and only these: HTML comments, code blocks, link reference definitions, and characters
  that display as nothing (Unicode format characters, variation selectors, blank fillers). The
  reading follows the page as CommonMark renders it — `<!--` in a code span is text, an item holds
  the paragraphs indented under it, a deeper heading continues a section — rather than a line-by-line
  shortcut, because each shortcut the first review found either hid displayed items without a word
  or let hidden text through. Everything else is kept as written, HTML and image alt text included:
  the report shows each requirement as read, so what was read can be seen, and the characters that
  even the report cannot show are the ones removed. A requirement longer than 600 characters is left
  out and said to be, not cut.
- Reading asks no model, so it happens before the credentials gate. Whenever the tool prints its
  report, or stops because it could not read the requirements (exit 11), it names each source it
  read and whether it was read into requirements or why not, and each issue the pull request closes
  that it did not read (another repository's, a missing one, one past the ten GitHub lists). A run
  without credentials is still skipped, not failed, and its report says what would have been read.
- Where each requirement came from is shown, including whether its source's author is the pull
  request's author. In the review path, intent that exists and was not checked is a blocker, which
  withholds VERIFIED (SPEC §28): a source that no source read outranks and that was itself not read,
  requirements read past the first twenty, and issues closed past the ten GitHub lists. At equal
  authority too: otherwise an author who adds an issue of their own with one item, beside the real
  issue in prose, clears the blocker. `intent.pr_body_only: unknown` looks at the requirements'
  sources, and requirements read from the pull request's own description are not given to J4, so an
  author cannot justify a change with a description written after it. The local check shows the
  same and does not act on it.

## Alternatives considered

- Jev chooses sentences (B in #40): reads ordinary prose, but how reliably Jev tells a required
  behaviour from background has not been measured, it adds tens to hundreds of requests per pull
  request, and a sentence naming a symptom rather than its mechanism (`#476`) can lead to a
  confident reading of the wrong call. Deferred until a bench with owner-labelled sentences
  measures it (#40, part 2).
- Requiring every source to be in a form (the previous rule): it discarded forms that were there.
- Reading the first sentence of a pull request's summary without a label: not a form; guessing.
- Taking only the first sentence of a `Property` paragraph: drops the half of a property that says
  what happens on failure (omamori `#553`).

## Consequences

- On the ten measured pull requests, 7 are read (all from `Property` paragraphs; one also from an
  issue's `Acceptance` list). Of those, v0.1 has something to check in 2: its candidates are Rust
  calls in the diff, and the rest are Zig or change no Rust. On 70 other recent pull requests of the
  same two repositories, 25 carry a `Property` paragraph and none a requirements section: 21 are
  read, and 4 are over the length limit and left out (`bench/logs/intent-coverage-v1.json`). The
  forms were chosen from the measured ten; the 70 are the check that they were not fitted to them.
- A pull request described only in prose is still not checked; the report now says why.
- Whether a requirement written only by the pull request's author should change the local check's
  exit code is not decided here; it belongs to the GitHub Action (#41).
- Failures that print no report (exit 10, 12, 13) are outside this rule.
