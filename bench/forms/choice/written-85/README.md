# Sentences written from dev pull requests, and how their fixed code handles the failure (#85, ADR 0026)

Written and committed before any subagent below ran. Nothing here changes after the first output is
read; a change makes `written-85-v2`.

## The pull requests

`prs.txt`: every row of `bench/eval/pool.json` (all of it dev, `bench/eval/PROTOCOL.md`, *Dev and
sealed*) whose repository's language is Rust and for which #85's annotators judged the requirement
writable as `failure_propagation` or as `failure_handling` (`bench/eval/forms-85.json`, `a` or `b`
decided `yes`): 43 rows, **41 pull requests** (omamori #468 and #553 are two rows each), 20
repositories, sorted. 22 rows are `yottayoshida/omamori`.

## Two readings, by readers who do not see each other or the form question

**How the fixed code handles the failure** — the truth the main line is read against. Three annotators
(`truth-a.json`, `truth-b.json`, `truth-c.json`), each a fresh subagent that reads **the diff only**
of every one of the 41, and nothing else — not the pull request's text, not the issues, not the forms or
their sentences. A pull request's truth is the answer at least two give; three different answers make it
`split`, and a pull request whose truth is `other`, `unclear` or `split` is left out of the set.

**The sentence** — what is sent to Jev. Three writers (`drafts-a.json`, `drafts-b.json`,
`drafts-c.json`), each a fresh subagent given every third pull request of `prs.txt` (the first, fourth,
… to `a`; the second, fifth, … to `b`; the rest to `c`: 14, 14, 13), that reads **the pull request's
text and the issues it closes** only — not the diff, not the code, not the forms or their sentences.

A sentence's label follows its pull request's truth: `handles_locally` → `failure_handling`,
`returns_to_caller` → `failure_propagation`. `run.ts verify` checks it.

The readers are subagents of a Claude Code session, which injects the workspace's `CLAUDE.md` and
memory: they can see that #85 and a form for handled failures exist. The prompts keep them to what they
are told to read; what they saw besides is not controlled (ADR 0026, *Limits*).

## The truth annotators' prompt

With `<LIST>` the 41 ids and `<PATH>` the file:

> You are labelling pull requests for an evaluation. For each id `owner/repo#N` below, read that pull
> request's diff and nothing else: `gh pr diff N --repo owner/repo`. Do not read the pull request's
> title, body or comments, any issue, any file on disk, or any other command's output. Do not run any
> command that changes anything, and write nothing but the one file named below.
>
> Each of these pull requests changes how some operation's failure is handled. For each, decide what
> the code does with that failure **after** the change:
>
> - `returns_to_caller` — it returns the failure to its caller as an error (with `?`, `Err(..)`, or by
>   making the command exit with an error status);
> - `handles_locally` — it does not return it: it logs it, warns, writes it to standard error, records
>   it, or goes on with a value or a message the user or the caller can tell from a success;
> - `other` — the change is not about how a failure is handled, or it does both for the same failure;
> - `unclear` — the diff does not show it.
>
> If a pull request changes several failures, answer for the one the change is mostly about.
>
> Write one JSON array to `<PATH>`, one object per id, in the order given:
> `{"ref": "owner/repo#N", "answer": "returns_to_caller" | "handles_locally" | "other" | "unclear", "quote": "<at most three lines of the diff your answer rests on>"}`.
>
> <LIST>

## The writers' prompt

With `<LIST>` the writer's pull requests and `<PATH>` the file:

> You are writing requirements for an evaluation. For each id `owner/repo#N` below, read that pull
> request's text — `gh pr view N --repo owner/repo --json title,body,comments` — and the text of every
> issue it says it closes or fixes — `gh issue view M --repo owner/repo --json title,body,comments`.
> Read nothing else: not the diff, not the code, not any file on disk. Do not run any command that
> changes anything, and write nothing but the one file named below.
>
> For each pull request, write the requirement its fix meets — what the program must do — as one
> English sentence, the way the author of the issue would write it in the issue. Use their words where
> the text gives them. Name the operation the requirement is about. Do not describe how the fix is
> implemented, and do not name functions or files the text does not name. End the sentence with a full
> stop.
>
> Write one JSON object to `<PATH>`: `{"drafts": [{"ref": "owner/repo#N", "sentence": "..."}]}`, one
> entry per id, in the order given.
>
> <LIST>

## What the readers found (2026-09-27, after the files were read)

Recorded, not a change to the rule above. 17 of the 41 ids are `yottayoshida/omamori` *issues*, not
pull requests (the pool's rows name an issue where a pull request fixed one). `gh pr diff` found none,
all three annotators answered `unclear`, and the rule left them out. The writers read those issues'
text, as the prompt's `gh issue view` allowed; their sentences are in the draft files and are not in
the set. The annotators agreed on every one of the 41. `combine.ts`: 23 sentences, 10
`handles_locally` from 8 repositories, 13 `returns_to_caller`; 18 left out.
