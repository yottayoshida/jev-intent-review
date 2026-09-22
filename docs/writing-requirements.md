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
own change: the report says so, it is not used to justify the change's other lines, and in the
review an issue that could not be read withholds VERIFIED.

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

In the review, intent that exists and was not checked withholds VERIFIED: a source as high as any
that was read and itself unread, requirements past the first twenty, and issues past the ten GitHub
lists. The local check shows the same in its Intent section and does not change its exit code for it.

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
