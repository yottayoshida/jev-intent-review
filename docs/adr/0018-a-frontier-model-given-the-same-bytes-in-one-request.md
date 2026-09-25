# 0018. The baseline is a frontier model given the same bytes in one request

Status: Accepted

## Context

#88 asks whether the architecture — typed questions and reaching beyond the diff — adds value over a
simple review by a strong general model at the same budget, before more is spent on adoption. No API key
is held for any frontier model. The budget chosen is the bytes sent (owner, 2026-09-25).

## Decision

- **The baseline is Claude Opus 5.5 through `claude -p`, with no tools, one request**, in an empty
  directory, with a fixed system prompt, no MCP server and no user settings (`bench/eval/baseline.ts`).
- **Its material is gathered by a fixed rule** — requirement, diff, the changed files, the files that call
  a changed function, the files the requirement's words hit — **up to the bytes jev sent on that version**,
  whole files only.
- **Hits are mechanical and the same for both**: the known defect's file, function and call, in three
  counted runs of three; both keep five findings.
- **The gate is the lower bound of the per-case difference**, repositories counted once, above 10 per 100
  cases, with a guard on false findings; the result is also read for defects inside the diff (A) and in an
  unchanged caller (B), which `PROTOCOL.md` version 2 builds for every sealed repository.

## Alternatives considered

- **A baseline with tools (read, grep) and a turn limit.** Closest to an agent, but what it reads cannot be
  held to a byte budget; left out of the gate.
- **Codex through a ChatGPT account.** Requests, tokens and cost are not reported, so no budget can be held.
- **Giving the baseline jev's list of calls.** That hands it jev's reach, the thing compared.
- **An equal cost in dollars.** Jev's price per request has not been measured; at Opus's price the baseline
  would read a few thousand bytes.
- **Hits decided by adjudicators.** Their noise would fall on the baseline's side only, three times over.

## Consequences

- At 17 repositories the gate needs about 11 wins with no loss; fewer repositories cannot pass it at all.
- The comparison says nothing about code review in general, only about the supported requirement form.
- The baseline, rewriter and annotators share a model family; that bias is stated, not removed.
