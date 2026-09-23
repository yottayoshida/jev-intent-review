# Why, and what it is aiming at

Most code review starts from the diff:

```text
changed code → look for problems
```

`jev-intent-review` starts from the requirement:

```text
issue / acceptance criteria
        ↓
what behavior is required?
        ↓
where in the repository does it apply?
        ↓
does the repository after this PR satisfy it?
```

**The diff is a search hint, not the review boundary.**

## Why

Many PR bugs are omissions outside the diff.

A new rule may be implemented in one API path but missed in another.
A bug may be fixed for one caller while another caller still reaches the same failure mode.
A changed invariant may invalidate untouched code elsewhere in the repository.

A diff-only reviewer has no reason to inspect those locations.

`jev-intent-review` works in the opposite direction: it starts from the intended behavior and discovers the code that may satisfy or violate it.

## Example

Requirement:

```text
If loading an existing configuration file fails,
the operation must return an error to its caller.
```

Suppose the PR correctly fixes one path, but an unchanged caller still converts the same failure into a successful result.

`jev-intent-review` is meant to surface that call even though the call itself is outside the diff.

In v0.1.1 that is a goal, not yet a result. v0.1.1 lists the callers one hop out of the functions a change touched, and among the real pull requests examined that were not used for tuning, in all three where the fixed call could be asked about, the call from the unchanged caller to the changed function reached no question. Since then (unreleased), measured again on the same cases after `#45`, moltis#1064's defect in an unchanged caller was listed at its own call in three runs of three — on a case used to tune the tool by then — and the check also reads, past the callers, the other callers of what the changed code calls; a defect in such a function has not been measured on real code yet. See [what has been measured](local-check-cli.md#what-has-been-measured).

A finding contains the requirement, the relevant code, the assumed failure, and the typed judgments that caused it to be listed.

It does not generate a free-form AI code review.

## How it works

The current pipeline is intentionally narrow:

```text
requirements
    ↓
changed functions + nearby callers
    ↓
candidate calls
    ↓
small evidence packets
    ↓
typed Jev judgments
    ↓
calls worth checking
```

[Jev](https://docs.typesafe.ai/introduction) is used for small, fixed questions with probability distributions rather than open-ended review prose.

The evidence and judgments are kept visible so a finding can be inspected or rejected by a human.

## Current v0.1 scope

v0.1 is an experimental implementation of the broader intent-review model.

It currently supports:

* Rust repositories — in any other language no function is read and no call is asked about; only the change question runs
* two forms of requirement, read by one rule: how failures must propagate, and (experimental, measured only on a constructed case) that a check passes before an action — which form a sentence read from an issue says is Jev's reading, measured on 72 sentences ([ADR 0008](adr/0008-who-chooses-a-requirements-form.md))
* functions touched by the change and callers one hop out, and the other callers of the repository functions the changed code calls — the path a fix may have missed — chosen by returning a `Result`, last and under a budget of their own
* requirements written in a documented form — an intent spec, a requirements section, or a `Property:` paragraph (see [Intent](usage.md#intent))
* Jev as the only judgment model

It does **not** yet claim complete repository-wide verification or a requirement-level `VERIFIED` verdict.

No finding also does not prove that the requirement is satisfied.

See [docs/local-check-cli.md](local-check-cli.md) for the exact current behavior and measured experiments.

## What this is aiming at

The broader goal is an **Intent CI** for pull requests:

> derive the semantic surface of a change from its intent, rather than treating the git diff as the boundary of review.

The design is described in [docs/SPEC.md](SPEC.md).
