# Writing requirements the tool can read

jev-intent-review checks a change against requirements. No model writes them and no model picks
them out of prose: the tool reads the forms below, as they are written, from the issue a pull
request closes, from the pull request's description, or from `--intent` / `--intent-file`
(ADR 0004). Everything else is named in the output with the reason it was not read.

Whenever the tool prints its report, or stops because it could not read the requirements (exit
11), every issue and pull request it read is either read into requirements as written — leaving out
only what is listed under [What is read, exactly](#what-is-read-exactly) — or named with the reason
it was not. Failures that print no report — a setting to fix (exit 10), the judgment provider
(exit 12), the repository (exit 13) — are not covered.

## Form 1: a requirements section

A heading that is exactly one of `Acceptance criteria`, `Acceptance`, `Requirements`,
`Definition of done`, `Done when`, 受け入れ条件, 要件 or 完了条件 — as a Markdown heading (`## Acceptance`),
a line of bold text (`**Requirements:**`) or a line of the words alone (`Requirements:`) — followed
by a list. Each item is one requirement.

```markdown
## Acceptance criteria

- `omamori doctor` reports `[Staging] empty` or a file count only for a staging directory it
  read in full.
- A staging directory it could not read in full is reported as `cannot read`, with the reason.
```

- An item is everything the page shows in it: lines it wraps onto, and paragraphs indented under
  it after a blank line. Code inside it is not read.
- A sentence before the list (a lead-in) is not a requirement; a paragraph, a quotation or an HTML
  block after it ends the section.
- The section runs to the next heading of its level or above. A deeper heading inside it
  (`### Errors` under `## Acceptance criteria`), or a line of bold text under a `#` heading, continues
  it; under a heading of bold text, the next one ends it. Put what is not a requirement — out of
  scope, notes — under a heading of its own at the same level.
- A nested item is a requirement of its own. Task boxes (`- [ ]`) are dropped from the text.
- An item of one word is left out and said to be.

## Form 2: a `Property` paragraph

A paragraph that begins with the label `Property:` — or `**Property** —`, `Property —`,
`Property (anything):`, `**Property** (anything):`, `**Property:**` — is one requirement: the rest
of the paragraph, without the label, up to a blank line, a heading, a list or a quotation. The
label counts only where a paragraph begins; one wrapped into a list item is part of the item. Two
lines in a row that each begin with it are two requirements.

```markdown
Property: a shell command blocked by `hook-check --json-error` is recorded in the audit chain
exactly as in text mode, and stderr stays a single JSON object.
```

This is the form for a pull request that says, in one place, what becomes true when it merges.
A requirement read only from a pull request's own description is its author's claim about their
own change: the report says so, it is not used to justify the change's other lines, and an issue
that could not be read is named in the report's notes.

## What is read, exactly

- Left out, and only these: HTML comments, code blocks, link reference definitions
  (`[x]: https://…`, where the page hides one), and characters that display as nothing —
  zero-width and direction-control characters, tag characters, variation selectors. What is in them
  is not read, so a form written there is not a requirement.
- Everything else is kept as written, Markdown and HTML included (an image's alt text too); runs of
  whitespace become one space. The report shows each requirement as it was read.
- The reading follows the page: `<!--` inside a code span is text, a comment that is never closed
  inside a paragraph is text, and a comment across lines joins the words around it.
- Nothing is cut. A requirement over 600 characters is left out, and the report says so with its
  length. Past twenty left-out items in one source, the rest are counted.
- At most 20 requirements are checked, from the highest sources first — with the default
  `intent.prefer_issue`, the issue's before the pull request's; the rest are named.
- An issue the pull request closes and the tool does not read — in another repository, missing, or
  past the ten GitHub lists — is named.

Intent that exists and was not checked is said in the report's notes: a source as high as any that
was read and itself unread, requirements past the first twenty, and issues past the ten GitHub
lists. The run states no requirement verdict for it to withhold (ADR 0007), and its exit code does
not change for it.

## An issue template

To have issues arrive in a form the tool reads, a repository can add a template. Copy this into
`.github/ISSUE_TEMPLATE/change.md` of your repository:

```markdown
---
name: Change
about: A change with the behaviour it must have
---

## Problem

<!-- What is wrong, and where. -->

## Acceptance criteria

- <!-- One checkable statement per item: what must be true after the change. -->
```

The comments are not read, so the template's own guidance never becomes a requirement.

## Choosing requirement sentences out of prose: measured

Prose in neither form is not read as requirements. The other way would be to have Jev pick, sentence
by sentence, the ones that state a required behaviour; whether it can was measured before deciding,
on issues written before language models wrote many of them. The issues were chosen by a rule fixed
before any was read (`bench/sentence-choice/issues/README.md`), and split into sentences by
`bench/sentence-choice/units.ts`. One change came after a body had been read and before any label
or answer existed: the shortest sentence kept went from four words to two, because four dropped
short expected results such as "No errors". The stopping rule counts sentences, so the same rule
then took 64 issues (491 sentences) instead of 74 (463).

What the annotators read differs in two ways from the paragraph below that begins "The labels are
not a person's". Each sentence carried its id (repository, issue number and position), and each
annotator read a third of the sentences at once, so most sentences had others of the same issue
beside them — 146 to 153 of about 164 in each annotator's share. And each annotator ran as an agent
with the maintainer's workspace instructions and notes loaded, which name this project and say the
labels were to be a majority of Claude annotators; no answer of Jev's was among them, as none
existed yet. The agents could have opened other files; their transcripts show that each opened only
its own share. Jev was shown each sentence on its own, with its five fields.

The result is close to the bar in number, not in the labels. Of the sentences Jev chose and the
labels did not call a required behaviour — 11, 11 and 9 in the three runs — had 5, 6 and 4 of them
been labelled as one, every run would have cleared the bar and the decision would have been to
adopt. But only 1 of them in each run had even one annotator's vote for a required behaviour.

<!-- sentence-choice:begin -->
On 491 sentences of 64 issues that people wrote in six Rust projects between 2019 and 2022 (`bench/sentence-choice/issues/`), Jev was asked 3 times whether each sentence states a required behaviour (`bench/sentence-choice/question.ts`). The labels, the question and these rules were fixed in commits `69d58dc4415a` (question, rules, sentences) and `6e8461b11823` (labels), before the first request; typesafe/jev on cloudflare.

The labels are not a person's. At the maintainer's request, each sentence was labelled by 3 Claude annotators (claude-opus-5), a fresh agent for each of 3 parts of the sentences and each annotator, shown only the definitions and the five fields Jev is shown (`bench/sentence-choice/annotate.ts`). A sentence's label is the one at least 2 of the 3 gave; with none, it is "cannot tell". 54 sentences are labelled as stating a required behaviour. All 3 gave the same label to 435 of the 491 sentences, 2 of 3 to 56, and none agreed on 0; on whether a sentence states a required behaviour, all 3 agreed on 486 (Fleiss' kappa 0.97). Annotators of one model agreeing is not accuracy: they can share a mistake, and the figures below measure Jev against them, not against the people who wrote the issues.

A sentence counts as chosen when Jev answers `required_behavior` with a probability of at least 0.60. Precision counts every sentence chosen, including those labelled "cannot tell" or "not a sentence"; the lenient figure leaves those out. Ranges are 95% Wilson intervals.

| | chosen | right | precision | lenient | recall | no answer |
|---|---|---|---|---|---|---|
| Jev, run 1 | 62 | 51 | 0.82 (0.71–0.90) | 0.84 | 0.94 (0.85–0.98) | 0 |
| Jev, run 2 | 60 | 49 | 0.82 (0.70–0.89) | 0.83 | 0.91 (0.80–0.96) | 0 |
| Jev, run 3 | 59 | 50 | 0.85 (0.73–0.92) | 0.86 | 0.93 (0.82–0.97) | 0 |
| Headings and "should/must" (no model) | 76 | 35 | 0.46 (0.35–0.57) | 0.50 | 0.65 (0.51–0.76) | — |

- Chosen in every run: 58 of the 63 sentences chosen in any run.
- Issues that ask for no behaviour (no sentence labelled so): 24. Jev chose a sentence in 2 / 2 / 2 of them (per run).
- Not goals: labelled 0; Jev answered `non_goal` for 0 / 0 / 0, agreeing on 0 / 0 / 0. Not part of the decision.

The rule, fixed before the labels: adopt when, in every run, the lower bound of precision is at least 0.80 and the lower bound of recall at least 0.40; do not adopt when, in every run, an upper bound is below its bar; otherwise the result is not shown, which is taken as not adopting.

**Decision: not shown.** The runs neither clear the bar nor fall below it. That is taken as not adopting: prose is not read as requirements, and there is no second measurement on these issues.
<!-- sentence-choice:end -->
