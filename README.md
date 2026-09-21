# jev-intent-review

Write down what must happen when an operation fails, and this tells you which calls in the pull
request do something else — with the requirement's own words, the code, the failure it assumed,
and the two answers it got, so you can disagree with any of them.

It asks [Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/), a model that answers
fixed typed questions with a probability, and **nothing else**: any other model is refused before
the request leaves the process.

**v0.1 covers**: Rust, requirements that state how a failure must be handled, the functions a
change touched and the callers one hop out. You name no file, no function and no expected answer.
A run that lists nothing is not a claim that the requirement holds — see
[What it does not say](#what-it-does-not-say).

## Install

Not on npm yet. From a clone:

```
$ npm install && npm run build && npm pack
$ npm install -g ./jev-intent-review-0.1.0.tgz
$ jev-intent-review --version
```

Node 22.18 or newer.

## Credentials

Workers AI, or any endpoint that serves a Workers AI run request:

```
$ export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
# or
$ export JEV_API_URL=https://... JEV_API_TOKEN=...
```

## Use

**1. Write the requirement.** One checkable sentence per requirement, saying what must happen when
something fails. No file name, no function name.

```json
{
  "version": 1, "title": "", "summary": "", "nonGoals": [], "ambiguities": [],
  "requirements": [{
    "id": "R1",
    "text": "If reading an existing integrity baseline fails, the baseline-loading operation must return an error to its caller. It must not return a successful result saying that no baseline exists.",
    "kind": "behavior", "priority": "required", "sourceRefs": [], "searchHints": []
  }]
}
```

An acceptance-criteria list in the issue or the pull request works too — a heading like
`## Acceptance criteria` and one item per line, read as written. **Ordinary prose is not turned
into requirements**: no model writes them, so a description that is neither a spec file nor such a
list stops the run and says so.

**2. See what it would ask about, without sending anything.** No credentials needed.

```
$ cd /path/to/the/repository
$ jev-intent-review --experimental-local-check --experimental-candidates-only \
    --base <commit> --head <commit> --intent-spec spec.json
```

`--base` is the commit the change starts from, `--head` the commit after it. This prints the calls
inside the budget and every call it will not ask about, each with a reason.

**3. Run it.**

```
$ jev-intent-review --experimental-local-check \
    --base <commit> --head <commit> --intent-spec spec.json
```

Add `--json` for the whole record: every mapping, every reading, every probability.

## Reading the result

Two questions go to Jev about each call, in separate requests: whether the requirement requires
that a failure of that call not reach the caller as a success, and what the function returns when
it does fail. Both are read at 0.6.

```
### Worth checking

#### src/integrity.rs:210-220 · read_baseline — `crate::atomic_file::read_to_string_capped(&path, MAX)`
- **Requirement R1**: "If reading an existing integrity baseline fails, …"
- **Assumed**: Execution reaches the call … There, `…` returns an error. Every other operation …
- **Jev, on whether the requirement requires it here**: applies (0.96)
- **Jev, on what the function returns**: returns_success (1.00)
- **Why it is listed**: … Both are Jev's readings and neither checks the other.
```

The other sections are all "not that", kept apart because they mean different things:

| section | what it holds |
|---|---|
| **Worth checking** | both answers cleared the bar and disagree |
| **Read as required by the requirement** | Jev read the requirement as applying to this call. The behavior observation is reported separately — a call under *Worth checking* is in here too |
| **Read, but not required of by the requirement** | `does_not_apply`, `unknown`, below the bar, or no answer — each says which |
| **Not checked** | the callee has no definition here, the target returns no `Result`, the body did not fit, the call could not be located, **or the budget was spent** |
| **Notes** | caps that dropped candidates, files that could not be read, and what the change did not reach |

## What it does not say

**Exit 0 is not a verdict.** Findings do not cause a nonzero exit code. Configuration, repository
and provider failures can. Exit 0 does not establish that the requirement holds.

**Nothing listed** means no call met the conditions for being listed — both answers over the bar
and disagreeing. It covers calls whose mapping or whose behaviour came back undetermined, below
the bar, or unanswered, as well as calls that agreed. What was not reached is in *Not checked*
with a reason each, and the enumeration's own caps are counted in the notes.

A listed call rests on **two model readings that do not check each other**. Everything either of
them used is printed so you can throw it out.

## What has been measured

One repository (omamori `#468` / PR `#476`), two requirements, five branches, one run each: the
shipped code, two single-call mutations, two behaviour-preserving rewrites of the same calls. Each
mutation was listed at its own call and nowhere else; the shipped branch and both rewrites listed
nothing — ten cells of ten, against a table fixed before the first request. 76 requests per run.

That is the whole of it: **one repository, two requirements, one run per branch.** Nothing here
measures a second language, a second kind of requirement, or how stable a reading is across runs.

Details, and the earlier experiments that did not work, in
[docs/local-check-cli.md](docs/local-check-cli.md). The ordinary whole-repository review
(`jev-intent-review` without `--experimental-local-check`) is the older path and is not what v0.1
covers; its own record is in [docs/SPEC.md](docs/SPEC.md) and the sections below it.

## Development

```
$ npm run typecheck
$ npm test
$ npm run build
```

Tests need no credentials and reach no network. `test/only-jev.test.ts` checks both that another
model never reaches a socket and that a whole run asks for `typesafe/jev` in every body that
arrives at a capturing endpoint.

## License

MIT or Apache-2.0, at your option.
