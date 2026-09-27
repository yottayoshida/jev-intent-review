# Measurements

What the local check has been measured to do, and the working record of how v0.1 got here. How the
run behaves — what to give it, how to read what comes back, the exit codes — is in
[the local check](local-check-cli.md).

## What has been measured

Everything below is about `failure_propagation` except three parts: `check_before_action` on a
constructed case, the same form on the code of the acceptance set's pull requests, and, last, how Jev
reads which form a sentence has.

### Cases that were not used to tune anything

Forty merged pull requests from outside this project were examined in a fixed order
(`bench/acceptance/candidates.json`; the rules are in `bench/acceptance/README.md`), looking for one
that states how a failure must be handled, fixes it at a call v0.1 can put a question to, and lets
the defect be observed by running it. The plan asked for three; two passed, and how the others
failed is the first result. Twenty-eight of the forty do not fit v0.1's question at all. In many,
the fix logs the failure, warns, blocks, or reports it in the result instead of returning it, and a
question about whether a failure reaches the caller as a success cannot tell such a fix from the
defect; the rest are about something other than a failed call. Of the twelve that fit, the fixed
call could be asked about in three. Eight could not: the call goes to the standard library or
another crate, to a name defined more than once in the repository, or to a `Result` under another
name (`CostResult`), or it never entered the tool's listing at all — a cap on the fixed file and
methods the listing does not read in one case, a change the tool reports as touching no Rust
function in another. Three of the eight were settled from the definitions of the callee, the count
`applicabilityOf` uses, without running the tool. The twelfth, iota#10136, was not run through the
tool: cloning its 470 MB monorepo to run the pre-check, and building it for a probe, are both far
outside a one-crate test. Of the three, two could be built and
run to observe the defect; the third needs a WebAssembly toolchain to build at all. At forty
candidates, the cap, the owner chose to measure the two rather than stop
(`bench/acceptance/candidates.json`, `gateExtension`).

The two cases are moltis-org/moltis#1064 and dashpay/grovedb#500. Each has four versions: the
shipped code, a defect at the fixed call whose effect was observed by running it, a rewrite that
does not change behaviour, and a version where the decision is moved into a helper whose body is
not sent, so no confident reading is right. moltis also carries two defects outside the diff,
placed at the merge base so the pull request did not fix them: one in an unchanged caller of a
changed function — the README's example — and one in a function that neither changed nor calls one
that did. Every branch whose target is inside the budget was run three times.

<!-- acceptance:begin -->
Candidates examined: 40 (cap 40). Passed condition (a): 12, (b): 3, (c): 2. Measured: 2 requirements from 2 repositories.

| case | version | target | expected | reach | readings (mapping / behaviour) | result |
|---|---|---|---|---|---|---|
| grovedb-500 | shipped | A `finalize` | not listed | asked | applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 0.99; applies 1.00 / returns_error 0.99 | 3/3 agrees |
| grovedb-500 | defect-A | A `finalize` | listed | asked | applies 0.99 / returns_success 0.89 · listed; applies 0.99 / returns_success 0.92 · listed; applies 0.99 / returns_success 0.94 · listed | 3/3 agrees |
| grovedb-500 | rewrite-A | A `finalize` | not listed | asked | applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 1.00 | 3/3 agrees |
| grovedb-500 | hidden-A | A `finalize` | no confident reading | asked | applies 1.00 / returns_error 0.96; applies 1.00 / returns_error 0.94; applies 1.00 / returns_error 0.95 | 0/3 differs |
| moltis-1064 | shipped | A `generate_title_for_session` | not listed | asked | applies 0.99 / returns_error 0.99; applies 0.99 / returns_error 1.00; applies 1.00 / returns_error 0.99 | 3/3 agrees |
| moltis-1064 | shipped | B `dispatch_command` | not listed | held before any question (target_not_result) | — | not reached |
| moltis-1064 | shipped | C `generate_title` | not listed | not enumerated (a cap fired; cap or structure) | — | not reached |
| moltis-1064 | defect-A | A `generate_title_for_session` | listed | asked | applies 0.98 / returns_success 0.99 · listed; applies 0.98 / returns_success 1.00 · listed; applies 0.99 / returns_success 1.00 · listed | 3/3 agrees |
| moltis-1064 | rewrite-A | A `generate_title_for_session` | not listed | asked | applies 0.99 / returns_error 0.99; applies 1.00 / returns_error 1.00; applies 0.99 / returns_error 1.00 | 3/3 agrees |
| moltis-1064 | hidden-A | A `generate_title_for_session` | no confident reading | asked | applies 0.98 / returns_error 0.92; applies 0.98 / returns_error 0.92; applies 0.99 / returns_error 0.94 | 0/3 differs |
| moltis-1064 | defect-B | B `dispatch_command` | listed | held before any question (target_not_result) | — | not reached |
| moltis-1064 | defect-C | C `generate_title` | listed | not enumerated (a cap fired; cap or structure) | — | not reached |

Calls other than the targets that were listed in these runs, not scored: 0. Requests sent to Jev: 205, over 24 runs.
<!-- acceptance:end -->

What it shows, and no more than that:

- **Inside the diff, v0.1 read both unseen cases right.** Each defect was listed at its own call in
  three runs of three, and neither the shipped code nor the rewrite listed it, or anything else.
  That is two requirements from two repositories.
- **No question reached a defect placed outside the diff.** The unchanged caller in moltis was set aside
  before any question: its return type is `ChannelResult<String>`, a `Result` alias the check did
  not recognise then, and the report said it did not return a `Result` (aliases are read since
  `#45`'s first part — *Reading whole signatures*). The other function is outside
  what v0.1 enumerates by construction; the table says "cap or structure" because the rule fixed
  beforehand gives that label whenever a cap fired in the run. Among the three candidates whose
  fixed call could be asked, the call from the unchanged caller to the changed function reached no
  question in any: set aside for the alias here, set aside for a callee signature wrapped past four lines in
  Kontor#385, and dropped by the forty-call cap of its function in grovedb#500
  (`bench/acceptance/precheck-shipped.json`). In grovedb#500 the unchanged caller itself was
  reached: three other calls in it were asked about in every run, and read as not governed by the
  requirement. In moltis#1064 and Kontor#385 every call in it was set aside before a question.
- **Jev reads through a helper it was not shown.** With the decision moved into a helper whose body
  was not sent, Jev answered `returns_error` at 0.92–0.96 in every run of both cases. The helpers do
  pass the failure through, so the reading happens to be right, but nothing Jev was sent
  established it. The version was fixed beforehand as "no confident reading", and it is scored
  against that.

Reproducible from what is committed, without sending anything:

```sh
node bench/acceptance/replay.ts
```

A test compares the table above with that output byte for byte, and the script refuses to print a
table for fewer than two repositories, no defect outside the diff, a branch sent to Jev fewer than
three times, or commits other than the ones each case fixed. The same two cases measured again with
the tool after `#45` are the next section.

### The acceptance set after `#45`

This table is the acceptance set measured with the tool shipped after `#45`'s three parts, and it
says which cases were used to tune the tool before it was taken. Both were: moltis-1064 is what
the whole-signature reading was built on, and both cases' versions were what the order inside a
function and that reading were judged by (`bench/acceptance/README.md`, *Used so far*). So this is
a regression check of the whole tool, not a second unseen measurement — and the wording of the
questions changed since the table above too (forms, `#35`), so a difference is not `#45`'s alone.
Every branch whose target is inside the budget was run three times, as before
(`bench/logs/acceptance-v2.json`; the rules are the same). The tool it names is the commit it was
measured at; the question that asks Jev which form a sentence says (ADR 0008) came after it, and
is not sent for these cases: their requirements are read from a spec file, and a spec's
requirements are never asked it.

<!-- acceptance-v2:begin -->
Measured again with the tool at ec1f706: 2 requirements from 2 repositories. Used to tune the tool before this measurement: moltis-1064, grovedb-500.

| case | role | version | target | expected | reach | readings (mapping / behaviour) | result |
|---|---|---|---|---|---|---|---|
| moltis-1064 | regression | shipped | A `generate_title_for_session` | not listed | asked | applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 0.99; applies 1.00 / returns_error 0.99 | 3/3 agrees |
| moltis-1064 | regression | shipped | B `dispatch_command` | not listed | asked | applies 0.90 / returns_error 0.95; applies 0.88 / returns_error 0.97; applies 0.88 / returns_error 0.91 | 3/3 agrees |
| moltis-1064 | regression | shipped | C `generate_title` | not listed | not enumerated (a cap fired; cap or structure) | — | not reached |
| moltis-1064 | regression | defect-A | A `generate_title_for_session` | listed | asked | applies 0.98 / returns_success 1.00 · listed; applies 0.97 / returns_success 1.00 · listed; applies 0.99 / returns_success 1.00 · listed | 3/3 agrees |
| moltis-1064 | regression | rewrite-A | A `generate_title_for_session` | not listed | asked | applies 1.00 / returns_error 1.00; applies 0.99 / returns_error 1.00; applies 1.00 / returns_error 1.00 | 3/3 agrees |
| moltis-1064 | regression | hidden-A | A `generate_title_for_session` | no confident reading | asked | applies 0.98 / returns_error 0.93; applies 0.99 / returns_error 0.91; applies 0.98 / returns_error 0.93 | 0/3 differs |
| moltis-1064 | regression | defect-B | B `dispatch_command` | listed | asked | applies 0.97 / returns_success 1.00 · listed; applies 0.95 / returns_success 1.00 · listed; applies 0.96 / returns_success 1.00 · listed | 3/3 agrees |
| moltis-1064 | regression | defect-C | C `generate_title` | listed | not enumerated (a cap fired; cap or structure) | — | not reached |
| grovedb-500 | regression | shipped | A `finalize` | not listed | asked | applies 1.00 / returns_error 0.99; applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 1.00 | 3/3 agrees |
| grovedb-500 | regression | defect-A | A `finalize` | listed | asked | applies 0.99 / returns_success 0.93 · listed; applies 0.99 / returns_success 0.93 · listed; applies 0.99 / returns_success 0.91 · listed | 3/3 agrees |
| grovedb-500 | regression | rewrite-A | A `finalize` | not listed | asked | applies 1.00 / returns_error 0.99; applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 0.99 | 3/3 agrees |
| grovedb-500 | regression | hidden-A | A `finalize` | no confident reading | asked | applies 1.00 / returns_error 0.95; applies 1.00 / returns_error 0.95; applies 1.00 / returns_error 0.93 | 0/3 differs |

Calls other than the targets that were listed in these runs, not scored: 0. Requests sent to Jev: 708, over 27 runs.
<!-- acceptance-v2:end -->

What it shows, and no more than that:

- **Inside the diff, both cases read as they did.** The six cells that agreed three of three
  before agree three of three again, and each defect-A was listed at its own call in every run.
- **A defect outside the diff was asked about, and listed.** moltis-1064's defect-B — an unchanged
  caller that turns the changed function's failure into a success — was listed at its own call in
  three runs of three, and the same call on the shipped code was not listed in any. Before `#45`
  that call was set aside before any question: its caller returns `ChannelResult<String>`, an alias.
  The defect in a function that neither changed nor calls one that did (defect-C) is still outside
  what the tool enumerates.
- **Jev still reads through a helper it was not shown** (hidden-A, `returns_error` at 0.91–0.95 in
  every run of both cases), and that is still scored against "no confident reading".
- 708 requests over 27 runs, about three and a half times what the table above spent: more calls can be asked
  about now, and a run of moltis sent 34 requests where it sent 4 to 6, one of grovedb 16 to 18
  where it sent 12 to 14.

Measured without a request, on the twelve candidates whose requirement fits the question, less
iota#10136 (not run through the tool in `#36` either: a 470 MB monorepo), and with the tool before
`#45` for comparison (`bench/logs/precheck-vs-8798e60.json`, `node bench/outside-results.ts
--before 8798e60`; `8798e60` is the commit before `#45`'s first part):

- **A fixed call is inside the budget in 8 of the 11 candidates, where it was 3.** A candidate
  counts once any call its pull request fixed is inside the budget, as condition (b) counted it:
  instruckt-tauri#9 (5 of its 5 fixed calls), grovedb#501, cce-rust#168 (2 of 3), dataprof#370 and
  agentflare#229 (2 of 7, both `std::fs::set_permissions`) joined moltis#1064, Kontor#385 and
  grovedb#500. Still outside then: whatsapp-rust#759's, which this count put down to the cap of calls
  per function — the cause was that its function's signature ends in a `where` clause, and the listing
  read the function as ending before its body; since #38's second part it is read and asked (*The calls
  of a function, measured*); quebec#136's, whose change is inside a generic function the tool reports as
  touching no Rust function (both are in their file once, so they are not written differently);
  pybun#428's `entry.file_type()` and agentflare#229's four `flush()` and `sync_all()`, method calls
  the tool does not resolve outside the repository ([*Functions this repository does not define*](local-check-cli.md#functions-this-repository-does-not-define)).
  Two more fixed calls are not asked: cce-rust#168's `KnowledgeSyncState::load_strict(root)` can be
  asked about and is outside the budget, and agentflare#229's `std::fs::read_to_string(&profile)` is
  set aside because the function it is in, `run`, returns `()` — true of that function.
- **The unchanged callers' calls**: moltis#1064's and grovedb#501's can be asked about and are
  inside the budget. **Kontor#385's can be asked about and was outside the budget of 20**, so it
  was not asked; since the callers have a budget of their own (`#38`, *The callers' budget,
  measured*) it is inside theirs. grovedb#500's was past its function's cap of 40 calls; since that
  cap is 1,000 it is listed and inside the budget (*The calls of a function, measured*).
- The same run with the tool of `#36` (`bench/logs/precheck-vs-529b30a.json`) gives 3 of 11, and
  its count of calls inside the budget equals what that tool's `--candidates-only` printed in
  `#36` (`bench/acceptance/precheck-shipped.json`, applicable less over the budget), in all eight
  candidates that were run then.

No report says a function does not return a `Result` when it does, on these runs: every reason with
those words in the listings of the pre-check's eight cases and omamori `#468`'s five branches — 541
distinct ones (`bench/logs/result-type-after-45.json`, `node bench/result-type.ts`) — was checked
against a label. 526 had one from the parts before that settles it; the other 15 — 13 with none,
and 2 whose earlier label said the name was ambiguous — were labelled by three fresh subagents who
were shown neither the tool's reasons nor the earlier labels, unanimously
(`bench/says-not-after-45-labels.json`). All 541 agree. One kind names a definition other than the
one the call reaches: a call to `shutdown` inside a file declared `#[cfg(test)] mod` is said to meet
the definition outside tests, because definitions in such files are not counted (see [*Whether a
function returns a `Result`*](local-check-cli.md#whether-a-function-returns-a-result)) — the call is itself in that file, and reaches the one there. Both
return `()`, so what the reason says about the return type is still true.

Reproducible from what is committed, without sending anything:

```sh
node bench/acceptance/replay.ts bench/logs/acceptance-v2.json
```

A test compares the table above with that output byte for byte, and fails if either is committed
without the other.

### The acceptance set after `#38`

The same two cases measured again with the tool after `#38`'s three parts and `#74`
(`bench/logs/acceptance-v4.json`, written by `node bench/acceptance/run.ts measure <case> <clone>
<limit> again`; the rules are the same). **Every defect placed where the run reads — in a function
the change touched (A) or in an unchanged caller of one (B) — was asked about inside the default
budget, and both of its questions came back answered, in three runs of three**: moltis-1064's
defect-A and defect-B and grovedb-500's defect-A (`node bench/acceptance/answered.ts
bench/logs/acceptance-v4.json`). Whether a call is inside the budget is settled by the commit
before any request is sent, and so is whether a budgeted call is set aside before its question (a body
that does not fit, a call that cannot be pointed at); what three runs add is that each target was
in fact asked, both questions came back each time, and what Jev read.

It is a regression check, not an unseen measurement, and less than that for the budget: both cases
were used to tune the tool, and how the budget is split (ADR 0015) was chosen by where these cases'
targets fell. What it shows is that nothing since `#45` moved them out.

<!-- acceptance-v4:begin -->
Measured again with the tool at 2682809: 2 requirements from 2 repositories. Used to tune the tool before this measurement: moltis-1064, grovedb-500.

| case | role | version | target | expected | reach | readings (mapping / behaviour) | result |
|---|---|---|---|---|---|---|---|
| moltis-1064 | regression | shipped | A `generate_title_for_session` | not listed | asked | applies 1.00 / returns_error 1.00; applies 0.99 / returns_error 0.99; applies 1.00 / returns_error 1.00 | 3/3 agrees |
| moltis-1064 | regression | shipped | B `dispatch_command` | not listed | asked | applies 0.88 / returns_error 0.93; applies 0.85 / returns_error 0.98; applies 0.88 / returns_error 0.96 | 3/3 agrees |
| moltis-1064 | regression | shipped | C `generate_title` | not listed | not enumerated (a cap fired; cap or structure) | — | not reached |
| moltis-1064 | regression | defect-A | A `generate_title_for_session` | listed | asked | applies 0.98 / returns_success 1.00 · listed; applies 0.98 / returns_success 1.00 · listed; applies 0.98 / returns_success 1.00 · listed | 3/3 agrees |
| moltis-1064 | regression | rewrite-A | A `generate_title_for_session` | not listed | asked | applies 0.99 / returns_error 1.00; applies 0.99 / returns_error 1.00; applies 1.00 / returns_error 1.00 | 3/3 agrees |
| moltis-1064 | regression | hidden-A | A `generate_title_for_session` | no confident reading | asked | applies 0.98 / returns_error 0.92; applies 0.99 / returns_error 0.93; applies 0.98 / returns_error 0.91 | 0/3 differs |
| moltis-1064 | regression | defect-B | B `dispatch_command` | listed | asked | applies 0.97 / returns_success 1.00 · listed; applies 0.97 / returns_success 1.00 · listed; applies 0.96 / returns_success 1.00 · listed | 3/3 agrees |
| moltis-1064 | regression | defect-C | C `generate_title` | listed | not enumerated (a cap fired; cap or structure) | — | not reached |
| grovedb-500 | regression | shipped | A `finalize` | not listed | asked | applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 0.99; applies 1.00 / returns_error 0.99 | 3/3 agrees |
| grovedb-500 | regression | defect-A | A `finalize` | listed | asked | applies 0.99 / returns_success 0.91 · listed; applies 0.99 / returns_success 0.91 · listed; applies 0.99 / returns_success 0.92 · listed | 3/3 agrees |
| grovedb-500 | regression | rewrite-A | A `finalize` | not listed | asked | applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 1.00 | 3/3 agrees |
| grovedb-500 | regression | hidden-A | A `finalize` | no confident reading | asked | applies 1.00 / returns_error 0.95; applies 1.00 / returns_error 0.95; applies 1.00 / returns_error 0.94 | 0/3 differs |

Calls other than the targets that were listed in these runs, not scored: 0. Requests sent to Jev: 786, over 27 runs.
<!-- acceptance-v4:end -->

- **Every cell reads as it did after `#45`.** The eight that agreed three of three agree again, and
  hidden-A still gets a confident `returns_error` (0.91–0.95) where no confident reading was expected.
- **moltis-1064's defect-C is still not reached**: it sits in a function that neither changed nor
  calls one that did, which the run does not read (`#37`). The acceptance set's claim is about A and
  B; C is `#37`'s — and reaching it is not all it takes: its call's callee is not settled at one
  definition here (`callee_ambiguous` in its `case.json`), so read, it would be set aside before its
  question. The table's "a cap fired" for it is a note that the callers of another function were
  not followed, not a cap on C's own file.
- 786 requests over 27 runs, where the measurement after `#45` sent 708: a run of moltis sent 28, one
  of grovedb 30 to 32.

```sh
node bench/acceptance/replay.ts bench/logs/acceptance-v4.json
```

A test compares the table above with that output byte for byte, and fails if either is committed
without the other.

### The case v0.1 was tuned on

One repository (omamori `#468` / PR `#476`), two requirements that state how a failure must be
handled, five branches, one run each: the shipped code, two single-call mutations and two
behaviour-preserving rewrites of the same calls. Each mutation was listed at its own call and
nowhere else; the shipped code and both rewrites listed nothing — ten cells of ten, against a table
fixed before the first request. 76 requests per run, 380 in all, every one to `typesafe/jev` on
Cloudflare Workers AI. TypeSafe's `jev-latest` and Vercel's `typesafe-ai/jev` were not measured, and
may be a different version of Jev.

Reproducible from what is committed, without sending anything:

```sh
node bench/replay-scoring.ts bench/logs/stated-requirements-v1.json
```

The wording of the questions was worked out on these same functions, so this case is a regression
check and does not count as unseen. The same targets asked under PR `#476`'s own sentence did
**not** pass — Jev read the refusal itself as the governed call, not the functions that receive it
(`bench/logs/jev-only-v1.json`). Nothing yet measures a second language.

### `check_before_action` on a constructed case

A constructed case, not an unseen one: one function, `open_session`, in five versions whose names
were chosen so the sentence "A disabled API key must never create a session." meets its calls
(`bench/forms/check-before-action/`, log `bench/logs/check-before-action-v1.json`). The table of
right readings was written before any request; three runs of each version against Jev on
Cloudflare, 90 requests.

| version | what it does with a disabled key (`rustc`) | `create_session` read as | the lookup and the check read as |
|---|---|---|---|
| shipped — refuses before creating | refused | holding 3/3 (applies 0.98, does_not_reach 0.99–1.00) | not required of, 3/3 each |
| defect — audits, then creates anyway | session | **worth checking 3/3** (applies 0.98–0.99, reaches_it 0.99–1.00) | not required of, 3/3 each |
| rewrite — the same refusal, other branch | refused | holding 3/3 (applies 1.00, does_not_reach 0.82–0.89) | not required of, 3/3 each |
| hidden — the check in a helper whose body does nothing | session | holding 3/3 (applies 0.98, does_not_reach 0.96–0.97) — **wrong**, as the table said no confident reading would be right | the lookup not required of 3/3; the helper's call set aside, a callee the run reads on its own |
| caller — the check in `login`, which calls it | refused through `login`, session called directly | worth checking 3/3 — `open_session` read alone does make the call | in `login`, not required of 3/3; in `open_session`, the lookup not settled 3/3 (the mapping under the bar: `does_not_apply` 0.53 and 0.56, `unknown` 0.50); `login`'s call into `open_session` set aside |

So on code written for it the form separates the defect from the shipped code and a rewrite, and
misses a check whose body it is not shown, exactly as the failure form does. The first run of this
case (`-v0.json`) also listed, in every version, `login`'s call into `open_session` — from `login`,
the call is made whatever `open_session` checks inside — which is why a call into a function the
run reads on its own is now set aside and left to be asked about there.

How far the words reach on real code, with no request (`bench/forms/reach/`): a
check-before-action sentence written for the changed function of each acceptance case put the
guarded call inside the budget on both — grovedb#500's `rewrite_heights` 10th of 17 askable calls
among 215, moltis#1064's `generate_title` 18th of 20 among 170 (two left over). Since the callers
have a budget of their own ([*The budget*](local-check-cli.md#the-budget)), 4th of 17 and 11th of 22, with none left over. Since the
cap of calls a function is 1,000 (#38, second part), moltis#1064's is outside the budget — below.

### `check_before_action` on the code of the acceptance set's pull requests

The same form measured on real code the way the failure form was (#39): each of the two pull requests
of the acceptance set in four versions — the shipped code, the check removed, the same check written
another way, and the check moved into a helper whose body does not check — with the table of right
readings committed before the first request, and three runs against Jev on Cloudflare of each version
whose guarded call is inside the budget: grovedb#500's four; none of moltis#1064's (below)
(`bench/forms/real/`, log `bench/logs/check-before-action-real-v1.json`, 396 requests). The defect's
behaviour difference was observed first, by one test in a throwaway clone: moltis#1064's function
gives a one-message session a title with the check removed and none without it; grovedb#500's
`finalize` runs `rewrite_heights` on a restore whose heights are right with the check removed and does
not without it (the rewrite is idempotent: a user sees only the work).

What it does not claim, as against the failure form's measurement: its place is the changed function
(A) only, with no defect outside the diff; it is measured with `bench/forms/real.ts`, not the
acceptance set's own table; both pull requests tuned the tool, and both sentences were written after
reading the fixed functions, with words that meet their names — so that the target is asked about is
no evidence. The table was fixed with a prediction: grovedb#500's sentence puts its check as "verifying
the heights has failed", so the assumption the question makes (the check does not pass) is a double
negative, and a reading of it the other way would list the shipped code.

<!-- check-before-action-real:begin -->
```
grovedb-500 scored:
  shipped  3/3
  defect   2/3
      finalize · rewrite_heights(grove_version): unknown, expected violates
  rewrite  3/3
grovedb-500 recorded, not scored:
  hidden   3/3
moltis-1064 scored:
  shipped  not reached: the target is not inside the budgets, nothing sent
  defect   not reached: the target is not inside the budgets, nothing sent
  rewrite  not reached: the target is not inside the budgets, nothing sent
moltis-1064 recorded, not scored:
  hidden   not reached: the target is not inside the budgets, nothing sent
FAIL: every scored version meets its row in each of 3 runs
```
<!-- check-before-action-real:end -->

- **grovedb#500 reads as the table says in eight of nine scored runs.** The shipped code and the rewrite
  are read as holding every time (applies 0.77–0.85, `does_not_reach` 0.73–0.80): the double negative
  was not read the other way. The defect is listed in two runs (applies 0.65, `reaches_it` 0.94–0.95);
  in the third the mapping came back at 0.59, under the bar of 0.6, so it is not settled.
- **The hidden check is not read confidently** — `cannot_determine` at 0.49–0.52 in every run, which is
  what the table calls right, where the constructed case drew a confident `satisfies`.
- **moltis#1064 is not reached.** With the cap of calls a function at 1,000, its changed functions have
  76 calls that can be asked about for a budget of 20, and the function's turns go to calls earlier in
  its body; the guarded call is over the budget in every version, so nothing was sent for it. Whether
  Jev reads it is not measured.

Measured again once a call whose own name meets the requirement's words takes its turn first in its function (ADR 0016;
the same cases, patches and table; log `bench/logs/check-before-action-real-v2.json`, 684 requests),
which puts moltis#1064's guarded call inside the budget in every version:

<!-- check-before-action-real-v2:begin -->
```
grovedb-500 scored:
  shipped  3/3
  defect   2/3
      finalize · rewrite_heights(grove_version): unknown, expected violates
  rewrite  3/3
grovedb-500 recorded, not scored:
  hidden   3/3
moltis-1064 scored:
  shipped  3/3
  defect   3/3
  rewrite  3/3
moltis-1064 recorded, not scored:
  hidden   0/3
      generate_title_for_session · moltis_agents::title::generate_title(provider, &chat_msgs): satisfies, expected unknown
      generate_title_for_session · moltis_agents::title::generate_title(provider, &chat_msgs): satisfies, expected unknown
      generate_title_for_session · moltis_agents::title::generate_title(provider, &chat_msgs): satisfies, expected unknown
FAIL: every scored version meets its row in each of 3 runs
```
<!-- check-before-action-real-v2:end -->

- **moltis#1064 reads as the table says in every scored run**: the shipped code and the rewrite as
  holding (applies 0.97–0.99, `does_not_reach` 0.98–1.00), the removed check listed at its call
  (applies 0.95–0.96, `reaches_it` 0.95–0.97). In the defect the call just above it,
  `values_to_chat_messages(&history)`, is listed too, in every run — with the check removed it also
  runs for a session with too few messages; it is read as holding in every other version.
- **The hidden check is read confidently as holding** on moltis#1064 (`does_not_reach` 1.00), the
  constructed case's miss — and as `cannot_determine` on grovedb#500 (0.50–0.53), as before.
- **grovedb#500 reads as it did**: the shipped code and the rewrite as holding every time, the defect
  listed in two runs of three (applies 0.61–0.62); in the other the mapping came back at 0.54.
- So on the code of both pull requests, the form separates the removed check from the shipped code
  and a rewrite in 17 of 18 scored runs; a check hidden in a helper it is not shown is, as for the
  failure form, not something it can see.

### The checks' bodies sent, and the words that assume the case (#82)

The hidden versions above were read as holding, or not settled, because the check's body was not
sent. Sent (ADR 0019: the checks above the call in a condition whose name meets the requirement,
one definition each, and what they call one level down), under the words above — "assume … the
check it asks for does not pass" — the constructed case's hidden version turned from holding to the
defect it is (`reaches_it` 0.80–0.83, three of three; `bench/logs/check-before-action-v2.json`),
moltis#1064's moved and stayed holding (`does_not_reach` 1.00 → 0.83–0.88;
`bench/logs/check-before-action-real-v3.json`), and grovedb#500's did not move
(`cannot_determine` 0.50–0.57). A body is read when the function is eight lines; a seventy-line
function with `debug!("auto-title: too few messages, skipping")` in its other arm is read by that.

So the words changed (ADR 0020): the question assumes the case the requirement describes, says the
bodies under `evidence.related` are those of functions the function calls, and that every other
operation succeeds unless the case itself decides it — nothing about a check. Measured before it
was wired, on the same packets, the old words as the control, the arms interleaved so the host's
version cannot tell them apart, the lines fixed first (`bench/decisive/words-probe*.json`,
`bench/logs/words-probe-v[1-4].json`, 848 requests over four versions): with a fifth version of each
case, **helper** — the check moved into a helper that checks, the same call sites as hidden and the
helper the only difference (its body, and its parameter's name: hidden's helper takes `_history`,
`_grove_version`, `_record`, an underscore that says the parameter is unused and a cue a reader
could go by without the body; the hidden versions were built and measured with it before this,
and are not rebuilt) — the new words read every hidden version as reaching the call
(0.79–0.99) and every helper as not (0.88–1.00), the shipped, rewrite and defect versions as before.
A two-step that reads each check's value from its own body first (the ADR's draft) read
grovedb#500's `heights_need_rewrite`, whose body is `true`, as `false` three times of three under
its doc comment and the sentence's double negative, and is not adopted. On twelve
check-before-action sentences written from real guards in four pull requests the rules were not
written on (`bench/decisive/outside/`), of 25 runs the old words read as holding, the new words read as holding
21, read 3 under the bar, and read one as reaching at exactly 0.60 — the snapshot's `decode` under
the sentence about mutations, a call the sentence does not govern and the old words themselves
read as holding in two runs of three. The line said none; the owner ruled it the line's coarseness (it counted
observations without the mapping, which sets that call aside) and adopted the words with this
written down. What the probe does not show is that Jev evaluates rather than skims in general.

Measured again under the adopted words, the same cases, patches and tables — with hidden scored as
the defect it is and helper as holding (version 2 of each `expected.json`; the tables the earlier
logs were scored under are kept as `expected-v1.json`) — three runs of every version
(`bench/logs/check-before-action-real-v4.json`, `bench/logs/check-before-action-v3.json`):

<!-- check-before-action-real-v4:begin -->
```
grovedb-500 scored:
  shipped  3/3
  defect   1/3
      finalize · rewrite_heights(grove_version): unknown, expected violates
      finalize · rewrite_heights(grove_version): unknown, expected violates
  rewrite  3/3
  hidden   3/3
  helper   3/3
grovedb-500 recorded, not scored:
moltis-1064 scored:
  shipped  3/3
  defect   3/3
  rewrite  3/3
  hidden   3/3
  helper   3/3
moltis-1064 recorded, not scored:
FAIL: every scored version meets its row in each of 3 runs
```
<!-- check-before-action-real-v4:end -->

- **Every hidden version is listed, every helper holds, in three runs of three** — grovedb#500's
  `heights_need_rewrite` and moltis#1064's `has_enough_messages` with a body of `true`, the
  constructed case's `reject_disabled` with `Ok(())`, each listed (`reaches_it` 0.81–0.99); the same
  call sites with a helper that checks, each holding (`does_not_reach` 0.86–1.00). The shipped code
  and the rewrite hold as before, moltis#1064's and the constructed case's defects are listed as
  before (`bench/logs/check-before-action-v3.json`: shipped, defect, rewrite, hidden and helper three
  of three, the caller version recorded as the table reads).
- **grovedb#500's defect is listed in one run of three**: the observation read `reaches_it`
  0.88–0.92 in every run — the line version 2 of `bench/decisive/expected.json` holds it to — and
  the mapping, which #82 did not change, came back `applies` 0.63, 0.58, 0.59: under the bar twice,
  as it had on 2026-09-25 under the old words (0.53–0.54) and had not the day before (0.61–0.62 in
  two of three). The scorer above reads outcomes, so it says 1/3 and FAIL; the row's own line is
  met. 832 requests over 30 runs, and 108 over 18 for the constructed case.

### The order inside a function

The calls into a function the change touched go first in their function (see [*What it asks*](local-check-cli.md#what-it-asks)). What
this rests on is one case, and it is the case the order was chosen from: in Kontor#385 the call the
pull request fixed, `batch_to_decided(b)`, sits six lines below a query into a file the pull
request never touched, and once more calls can be asked about (`#45`), that query takes the
function's only turn and the fixed call falls outside the budget. Kontor#385 is therefore a
regression case from here on. The opposite shape — a defect in a call to an unchanged function,
beside a call into a changed one — is not in any case measured, so whether this order is better
than line order in general is not known.

Measured without a request, on the eight cases of the acceptance set's pre-check (with every
version of moltis#1064 and grovedb#500) and the five branches of omamori `#468`, 20 runs
(`bench/logs/order-first-pass-v1.json`, `node bench/order-first-pass.ts`):

- how many calls each function gets, and in what order the functions take their turns, is the same
  as in line order in every run;
- with today's check (the `failure_propagation` form's), the order changes which call is asked in
  Kontor#385 (eight functions), in omamori `#468` (five functions on every branch, among them
  `run_override_disable`) and in pybun#428 (one); in the other six cases nothing changes, since
  every askable call fits in the budget. Kontor#385's fixed call is inside the budget with the order
  and outside it without. When the order was chosen this held only under the wider check below; the
  calls `#45`'s second and third parts made askable made it true of today's check;
- with a wider check standing in for `#45` (any type whose name ends in `Result` taken as one, and a
  callee's definition found by `fn <name>` and set aside when that search is cut — which sets aside one call
  today's check asks about, `verify(...)` in grovedb#500's `finalize`), every
  defect inside the diff stays inside the budget — omamori's two targets, moltis#1064's and
  grovedb#500's in every version, Kontor#385's — and without the order Kontor#385's falls out.
  Kontor#385's unchanged caller is outside the budget either way.

The two calls the order swaps in omamori `#468`'s `run_override_disable` — the only swap there when
the order was chosen — were asked of Jev three times on every branch under both requirements
(`bench/logs/order-first-pass-jev-v1.json`, 120 questions): neither was listed in any run. The
swaps in the other four functions have not been asked of Jev.

Under `check_before_action`, the calls named by the requirement come next (ADR 0016). This too rests
on one case, the one it was made for: moltis#1064's guarded call, `generate_title`, sits in its
function below five calls that meet the sentence's words only through a receiver (`session_store`,
`session_metadata`, `session_model`) and one named by it (`values_to_chat_messages`), and since the cap of calls a
function is 1,000 (#38) that function gets six of the changed functions' 20 turns — the guarded call
was seventh, outside the budget in every version (`bench/logs/check-before-action-real-v1.json`). With the order it is inside in every version, eighth of the 29 asked, and
grovedb#500's guarded call keeps its place (fourth, or third). The reason for the rule is the
form's own definition — a sentence of this form names the operation — and not moltis#1064's names;
the evidence that it helps is the case it was made for, and the opposite shape, a defect in a call
met only through a receiver beside a named one, is not in any case measured.

### The callers' budget, measured

How the budget is split ([*The budget*](local-check-cli.md#the-budget)) was chosen on the cases the order inside a function was
measured on — the acceptance pre-check's eight, every version of moltis#1064 and grovedb#500, and
omamori `#468`'s five branches, 20 runs — so it is a regression result, not an unseen one
(`bench/acceptance/README.md`, *Used so far*). Kontor#385's unchanged caller was the case that
decided it again. Orders of one shared budget of 20 were compared first, with the listing's caps as
they are and with every cap lifted: putting the calls into a changed function first everywhere
brought Kontor#385's caller in (14th) and left 7 of its 14 calls on a changed line outside the budget
and 7 of its 19 changed functions without a question; giving each changed function one turn first
left the caller 21st. No order of one budget kept both, and the owner chose a budget of the callers'
own.

Measured without a request, the tool before (`29bc114`) against the tool with the two budgets, on
the same 20 runs, capped and uncapped (`bench/logs/budget-by-origin-v1.json`,
`node bench/budget-by-origin.ts --before 29bc114`):

- **Every target the runs name is inside the budget**, capped and uncapped — omamori's two,
  moltis#1064's and grovedb#500's in every version, grovedb#501's fixed call and its caller,
  Kontor#385's fixed call and **Kontor#385's unchanged caller, 22nd of 30: second in the callers'
  budget, where it was outside the shared one**. grovedb#500's unchanged caller (`apply_chunk` →
  `finalize`), which the cap of forty calls per function dropped (until #38's second part), is 7th of 30 when the caps are
  lifted.
- **The callers are asked no less in any run**: 16 to 26 calls on moltis#1064's shipped code,
  1 to 10 on Kontor#385, 8 to 10 on omamori; the same where they fitted before (grovedb#500 capped,
  grovedb#501, instruckt-tauri#9).
- **Nothing on the diff's side got worse in any run**: the calls on a changed line left outside the
  budget are as many as before (2 on Kontor#385, 0 elsewhere) or fewer (pybun#428 uncapped, 1 to 0),
  and no changed function that had a question lost it. That the changed functions' share asks
  everything it asked before is also true by construction and pinned by a test
  (`test/select-order.test.ts`).
- Up to 10 more calls per requirement: on every run with more than 20 askable calls, as many as
  could be asked up to 30 (29 on moltis#1064's defect-B, 30 on the others).

Against real Jev, Kontor#385's shipped code three times (`bench/logs/kontor-385-callers-jev-v1.json`):
68 requests a run, all answered. The unchanged caller's call was asked in every run and read as
holding (`returns_error` 1.00) — the pull request fixed the function it calls, so that is the right
reading. Nine calls a run that the tool before did not reach — eight in callers, one in a changed
function — were read as holding in every run, and nothing was listed. Kontor#385 has no version with
a defect at that call (it stopped at condition (c)), so whether a defect there would be listed is
not measured.

The benches before this one that count one budget of 20 — `bench/order-first-pass.ts`,
`bench/outside-results.ts`, `bench/result-type.ts`, `bench/names-defined-twice.ts` — pass 0 for the
callers' budget, so the total is still 20; but the changed functions now take their turns before any
caller, so run again they no longer reproduce their logs, which name the tool they were taken with.
`bench/order-first-pass-jev.ts` asks the callers too now, on their own budget; `bench/intent-coverage.ts`
counts the calls inside the budget, which can be 30 where it was 20.

With more callers than their budget, the calls into a changed function take all of it: a defect in a
caller's other calls — the opposite shape the order inside a function left untested — is further
from a question in the callers than it was.

### The calls of a function, measured

The cap of calls a function was 40 and is 1,000, and a function whose body opens below a line of
its own signature — a `where` clause, a return type over several lines, `{` on a line of its own —
has its body read ([*The budget*](local-check-cli.md#the-budget)). The second was found while checking the first: the listing took
the line `) -> Result<…>` at the function's indent for the function's end, so the whole body was read
as no call at all, and nothing said so — whatsapp-rust#759's fixed function, quebec#136's changed
one and omamori `#468`'s `mutate_config` are written that way. The line the body opens on is looked
for at the function's own indent only, so a one-line function, a doc example and a pattern in the
parameters (`Json(Session {`) are read as before; on the `.rs` files of five of these repositories no
function's range narrowed, and every one that widened has its body opening below its signature. Measured without a request, the tool before (`6b90087`) against the tool
with both, on the same 20 runs as *The callers' budget, measured*
(`bench/logs/budget-by-origin-v2.json`, `node bench/budget-by-origin.ts --before 6b90087`), with the
command itself run set-built-only on the acceptance cases for the siblings and the time. The checks
read the tools with the other caps as they are; the copies with every cap lifted replace the same
constant in both, so for the cap they are one tool, and they are kept for reference.

- **Four walls moved.** grovedb#500's unchanged caller (`apply_chunk` → the changed `finalize`, past
  its fortieth call) is inside the budget in all four versions (7th of 18; 8th of 19 in hidden-A).
  whatsapp-rust#759's fixed function is read: its changed functions have 8 askable calls where they
  had none, and its callers 22. quebec#136's change, reported before as touching no Rust function, is
  read too: 13 askable calls where there were none, its fixed call
  `get_concurrency_constraint(args_ref, …)` among the ones asked. omamori `#468` reaches 13 changed
  functions where it reached 12, on every branch: `mutate_config`'s changed call was not listed at all.
- **Every other known target stays inside**, and no call on a changed line and no changed function
  lost its question in any run.
- **The check fixed beforehand that the callers are asked no less failed on moltis#1064, in all five
  versions**: its changed functions had askable calls past their fortieth (`send_impl` has 495), so
  they ask 18 or 19 where they asked 4 or 5, and the callers, who get 10 and what the changed
  functions leave, ask 11 or 12 where they asked 25 or 26. The total is 30 either way; that the diff's
  own calls go first is the split ADR 0015 chose, and the owner chose to keep it here. moltis#1064's
  unchanged caller's call (`dispatch_command` → `handle_title`) is 20th of 30 where it was 6th
  (21st where it was 7th in hidden-A) — second in the callers' budget, with less room than it had.
- **The siblings move**: a function the cap cut is not taken for a sibling, and fewer are cut now,
  while a changed function now read can make a sibling a caller. pybun#428 has 19 siblings where it
  had 5, quebec#136 9 where it had none, whatsapp-rust#759 none where it had 2. Their budget is still
  10, and a file read only for them has its cap counted in the notes as the others' files are.
- **Against Jev**, three runs each on the shipped code (`bench/logs/calls-per-function-jev-v1.json`):
  grovedb#500's unchanged caller's call was asked in every run and read as holding (`returns_error`
  1.00), the right reading for fixed code; of 3 calls a run newly asked there, none was listed.
  whatsapp-rust#759's fixed call was asked in every run and read as holding (1.00). Of its 19 calls a
  run newly asked, one was listed in every run: `download_external_blobs(&mut pl, download)` in
  `process_patch_lists`, which on a failed download marks the collection for a retry and returns
  `Ok` with that collection's mutations empty. Three fresh subagents, shown the requirement and the
  function and not the tool's answers, labelled it not violating two to one — all three said that
  reading "as an error" as `Err` alone makes it one. The case's own record had set this path aside
  when it was built (`bench/acceptance/targets-fixed.json`). It is counted as a false listing, and the
  owner chose to ship with it written down.
- **The command takes longer and prints more**: moltis#1064 30–34 s where it took 16–17, pybun#428
  22 s where it took 9, quebec#136 9 s where it took 1, the rest within a few seconds; the report of
  pybun#428 is 821 KB where it was 153 KB, most of it *Not checked*. The Action's check run keeps the
  first 64 KB of the report, so what a long report pushes past that is in the artifact and in the
  marks on the lines, not in the summary — as it already was for any report over 64 KB.

`BlockIndex.enclosing`, which the changes' question, the siblings' spans and the evidence read
functions through, got the same reading afterwards (#74), with three more shapes it missed before:
a bare `{ … }` block just inside such a body, a `where … {` on one line, and a function declared
`pub(in path)`. Measured without a request on the tracked `.rs`, `.ts`, `.tsx`, `.js`, `.jsx`, `.py`,
`.swift`, `.sql` and `.go` files of moltis, whatsapp-rust, grovedb, Kontor and pybun
(`bench/enclosing-lines.ts`, log `bench/logs/enclosing-lines-v1.json`):

- **Every body line of every function whose body opens below its signature is read as that
  function's**, checked against the bodies found by counting brackets rather than by the tool's own
  reading: 125,144 lines of 4,292 such functions, none read as anything wider; 1,859 more are in
  functions over the 300 lines a block is read whole, and are read as a window. Read by indent as in
  any function, and counted apart: 634 lines inside a string literal, and 56 lines of one moltis
  function that follow a string literal's closing line at column 0 (`"#,`). The listing ends six such
  functions early, each at a line of a string literal written at column 0 (a plist, an SVG, a Python
  script): a function's end is read by indent, before #74 and after.
- Against the tool before, no line outside Rust reads differently on these repositories. Of the Rust
  lines that do: 7,779 in such a body, read as the function's where they were read as the `impl`
  around it or as nothing; 188 in an `impl … where` block, whose nameless region now starts at the
  `impl` line; 2,178 in such a function whose end moved down to its closing brace; 64 its signature's
  own lines; 40 in a block now read whole and over 300 lines, read as a window; and 118 in functions
  over 300 lines, read as the bare block they are in where they were read as the block around it or
  a window. A Go table test's `{` rows would read as blocks of their own the same way, inside a
  function over 300 lines only; none changed here. A TypeScript return type that wraps to `> {`, and
  a JSX `>{…=> {`, would read differently too; neither occurs in these repositories.
- **A Rust function named `new`, `switch` or `with` is a function**: the names kept from reading
  JavaScript's `new Foo(` as a definition kept every `fn new` out of the listing. Of the functions
  above outside test code, in files under the listing's cap, 98 were not listed, each a `fn new`, and
  none is now; 6,600 lines keep their span and get the function's name, where they had none or a
  wrong one (`pub`, `Into`).
- The regions the changes' question asks about (`bench/change-regions.ts`, log
  `bench/logs/change-regions-v1.json`, 21 runs): 421 before, 418 after, 410 the same —
  whatsapp-rust#759's five nameless pieces, and the signature `download_external_blobs` was read as,
  are its three functions, and omamori `#468`'s nameless one is `mutate_config`; every other case is
  unchanged. A region whose span or name moved, here or in an `impl … where` block, is a packet a
  kept answer no longer covers, once (ADR 0013).
- The evidence the calls are asked with does not change: its callers and callees are read only above
  a `max_related_chars` of 0, which no run uses.

grovedb writes one method's `where {` at column 0: it opens that method's body, and the body ends
at the closing brace at the method's own indent, where #73's listing took the whole `impl` and
`enclosing` a window. A body line that starts with `*` — a dereference — is still read as a comment's continuation, in
functions of either shape; that is older than #73 and outside #74.

The benches that send a whole listing to a model (`bench/candidate-set-check.ts`,
`bench/selection-materials-check.ts`, `bench/typed-plan-check.ts`) read `enumerate` through
`bench/code-candidates.ts`, so run again they send other listings than their logs record.

### Reading whole signatures

Whether a function returns a `Result` is read from its whole signature and the repository's aliases
(see [*What it asks*](local-check-cli.md#what-it-asks)). It was built on the walls `#45` names — moltis#1064, Kontor#385 and
grovedb#501 — so those three are regression cases from here on. Measured without a request, before
and after this reading, on the acceptance pre-check's eight cases and omamori `#468`'s five
branches, 13 runs (`bench/logs/result-type-v1.json`, `node bench/result-type.ts`):

- The calls `#45` names can be asked about now: moltis#1064's unchanged caller
  (`dispatch_command` → `handle_title`), grovedb#501's fixed call (`set_base_root_key`) and the
  caller one hop out from it, all three inside the budget; Kontor#385's unchanged caller
  (`initiate_rollback` → `get_decided_from_anchor`), outside the budget of 20. Every defect inside
  the diff stays inside the budget.
- 98 calls can be asked about that could not before. Nine that could can no longer: grovedb#500's
  `verify(…)`, whose name has seven definitions that the bare-name search, stopped at 200 hits,
  used to hide; three `.parse()` calls in Kontor#385 that had been taken for a repository function
  taking no `self`; and, on each of omamori's five branches, text inside a string literal that the
  listing reads as a call.
- The runs said "does not return a Result" 2,794 times before and 2,316 times after. 284 decisions
  are now not settled, each with what could not be read: 265 of them said "does not return a
  Result" before, and 19 said there was no definition here.
- Scored against answers labelled by hand before this reading was written
  (`bench/result-type-expected.json`: 57 functions and 220 callees, by three fresh subagents given
  only the rules and the list), 808 decisions agree and none disagree for an unknown reason. 72
  disagree for a reason settled and recorded there, and none of them is about what a function
  returns: 49 are about which code counts as test code (a file declared under
  `#[cfg(test)] mod x;`, which the tool read as code at the time — a callee's definitions there no
  longer count, see *Names defined more than once*; an item marked `#[cfg(test)]` on its own),
  and 23 are calls the labels, which find a callee by name alone, matched to a definition the call
  cannot reach (a method call to a function that takes no `self`, or the wrong number of
  arguments). Nine callees outside the labelled items were labelled afterwards and are marked so.
- Before this reading, 436 of those decisions said "does not return a Result" of a call whose label
  says it returns one or is not settled.
- Deciding took 92 seconds in all, against 99 before (one run of each).

### Names defined more than once

Which definition a call reaches, when its name has several (see [*Which definition a call reaches*](local-check-cli.md#which-definition-a-call-reaches)).
It was built on two pull requests whose fixed call was set aside for this reason before — cce-rust#168, where
`SyncState::load_strict(root)` is one of two `load_strict`, and dataprof#370, where
`count_table_rows(query)` is a trait's method with three implementations — so those two are
regression cases from here on, and they are in the acceptance set's record as cases used to tune.
Measured without a request, before and after, on the acceptance pre-check's eight cases, omamori
`#468`'s five branches and those two pull requests, 15 runs (`bench/logs/names-defined-twice-v1.json`,
`node bench/names-defined-twice.ts`):

- Both pull requests' fixed calls can be asked about now, inside the budget of 20: cce-rust#168's
  `SyncState::load_strict` in `cmd_pull` and in `pull_workspace`, and dataprof#370's
  `count_table_rows`. cce-rust#168's third, `KnowledgeSyncState::load_strict` in
  `cmd_knowledge_pull`, is askable and outside the budget.
- 45 calls can be asked about that could not before (33 distinct calls; omamori's three repeat on
  its five branches). **None that could before can no longer** — the definitions that stopped
  counting, in files declared `#[cfg(test)] mod x;`, had settled no call that was asked about.
- 6 calls fell out of the budget of 20 and 20 entered it. **No call the acceptance set names moved
  across the budget**: those inside it stay inside, and Kontor#385's `get_decided_from_anchor` is
  outside it before and after, as *Reading whole signatures* already recorded. Four of the six that
  fell out are in a function where another call entered; the other two — cce-rust#168's `cmd_sync`
  and `ensure_index` — lost their function's turn to a function that became askable, so a function
  can lose its question to another function, not only to a call beside it.
- 349 calls that are set aside before and after are set aside for a different reason. 133 of them are set aside
  under a different kind: 63 are now "every definition here is in a file declared
  `#[cfg(test)] mod x;`" (55 of those used to be "does not return a Result" about a definition in
  such a file, 8 "not settled"), 42 moved from "defined N times" to what could not be read, 21 to
  "does not return a Result" with the definition named, and 7 to "this call does not reach any of
  them". The other 216 keep their kind and say what the narrowing found — which definitions the
  path left, or that none of them is written under it.
- Scored against what three fresh subagents said each call reaches, reading the calling code, its
  `use` lines and its re-exports with the narrowing rules withheld from them
  (`bench/names-defined-twice-expected.json`, the majority of three, 45 of 53 unanimous): **all 45
  calls that became askable reach a definition in the repository that returns a `Result`, and none
  disagrees.** Where a trait's method was settled, the labellers named the implementation and the
  tool names the declaration; that is the choice above, not a disagreement about what runs.
- Deciding took 110 seconds over the 15 runs, against 100 before (one run of each); an earlier pair
  measured 101 and 97, so the difference is not larger than what one run to the next varies by. The
  extra work is reading the module file above each definition's file, once per file.
- **There is no held-out repository here.** The rules were shaped by what the counts over these
  same 15 runs showed, and the two candidates of the acceptance set that nothing has used
  (`iotaledger/iota#10136`, `getappz/agentflare#229`) cannot serve as one: the first was dropped at
  the probe condition as a 470 MB monorepo, and every call the second fixes goes to the standard
  library, which this change does not touch. The labels are what stands in for a held-out set —
  they were written without the rules.
- Of 20 calls still set aside, sampled five per reason and labelled the same way: 9 reach something
  outside the repository and 6 reach a definition here that returns no `Result` — set aside rightly; 4
  are set aside as "not settled" where the labels say "not a `Result`", which sets them aside either way; and
  one — Kontor#385's `simulate(0, tx)` — reaches a definition that does return one, in a file
  declared `#[cfg(test)] mod x;`. That last one is what this deliberately stops asking about.

### Functions outside the repository

What the table of [*Functions this repository does not define*](local-check-cli.md#functions-this-repository-does-not-define) opens. It was built from the standard
library's own source and a machine's cargo registry, not from the repositories below, and the two
pull requests it was aimed at are cce-rust#168's neighbours — instruckt-tauri#9, whose fixed call is
`serde_json::to_string_pretty`, and pybun#428, whose fixed call it deliberately does not open.
Measured without a request, before and after, on the same 15 runs as the two parts before it
(`bench/logs/outside-results-v1.json`, `node bench/outside-results.ts`; the scan behind the table is
`bench/logs/outside-results-check-v1.json`, `node bench/outside-results-check.ts`):

- **The wall, counted once per call** rather than once per branch of the same repository: 973 calls
  were set aside with "no definition in this repository". 178 of them write a path; 733 are method
  calls, which this does not open; the other 62 are bare names, and at least 54 of those are not
  calls at all — `let (a, b)` patterns, attributes such as `cfg(unix)`, words in strings such as
  `file(s)` — which the call reader takes for calls and which were never asked about
  (`summary.wall`).
- **40 calls can be asked about that could not before**, in five of the ten repositories, 20 of
  them inside the budget of 20. **None that could before can no longer.** 18 of the table's 61 rows
  are what opened them — `serde_json::to_string_pretty` (5), `env::current_dir` (5),
  `serde_json::from_str` (4), `serde_json::to_string` (3), `fs::create_dir_all` (3),
  `std::env::var` (3), and 12 more with one or two each (`summary.askableCalls`). The other 43
  rows fired on nothing here.
- **instruckt-tauri#9's fixed call is askable and inside the budget.** pybun#428's
  `entry.file_type()` is still set aside, as a method call the table does not answer for.
- 14 calls fell out of the budget of 20 and 20 entered it. Every defect the acceptance set names
  stays where it was.
- Scored against what three fresh subagents said each of the 40 calls reaches, reading the calling
  code and its `use` lines with the table withheld from them
  (`bench/outside-results-expected.json`, all 40 unanimous): **every one goes where the table says
  — 26 into the standard library, 14 into `serde_json` — and every one returns a `Result`.** The
  labellers checked the two shapes that could have gone the other way: pybun declares a `pub mod
  env` of its own (the calls are written `std::env::`, so they do not reach it), and omamori's
  `use std::os::unix::fs::PermissionsExt;` brings in the trait, not the module, so `fs::` there is
  still the standard library's.
- The scan behind the table read 553 definitions a call could reach the way a row is written, in
  the standard library and in 1,798 crates; 3 of those hits were doc comments quoting
  `serde_json::to_value`, not definitions, and were not judged. Four of its 61 candidates had a
  counterexample and are written in full instead (`std::env::var`, `std::io::copy`,
  `std::io::read_to_string`, `fs::File::metadata`); none was dropped. A scan that reads nothing
  finds no counterexample either, so it prints what it read.

### The siblings of a change, measured

What [*The siblings of a change*](local-check-cli.md#the-siblings-of-a-change) adds, on the cases above, before any case with a defect in a
sibling has been built (`#37` stays open for that). Measured before the callers had a budget of
their own (#38, ADR 0015), when "the first budget" was one budget shared by the changed functions
and their callers; the siblings are still asked last and counted apart:

- **The first budget is the same set.** On the five branches of omamori `#468` under both of its
  requirements and on every version of moltis-1064 and grovedb-500, the calls the first budget asks
  about, as `--candidates-only` prints them, are the ones the tool before siblings printed
  (`bench/logs/siblings-first-budget-v1.json`, `node bench/siblings-first-budget.ts --before
  43d10d3`; no request sent). Siblings showed up on 9 of those 15 branches — omamori's five and
  grovedb-500's four, 10 and 4 sibling calls inside their budget; moltis-1064 has none.
- **Their questions are sent last.** Under a request limit, every requirement's first budget and
  the changes' questions are sent before any sibling's, and the siblings are what a limit leaves
  (`test/local-check-reach.test.ts`, through the command line with a recording provider).
- **One run against real Jev**, omamori `#468`'s shipped branch (`bench/logs/siblings-jev-v1.json`):
  112 requests, all answered, 54 s. Three siblings, `run_override_enable`, `run_config_command`
  and `regenerate_hooks_with_verifier`; 9 of their calls read per requirement, every one as not
  required of by the requirement, and nothing listed — on a branch with no defect, what that shows
  is that the siblings added no false finding there, and nothing about finding one.
- **No case with a defect in a sibling was found.** The rules for one were written before any
  candidate was opened (`bench/acceptance/candidates-v2.json`): a merged pull request outside the
  cases above whose text states a failure-handling requirement (a), where a grep-based rule written
  to the tool's definition finds a sibling (s) that the requirement governs (d), and whose defect can
  be observed by running it (c); at most 30 read. All 30 were read and none passed: 23 failed (a); of
  the 7 left, 4 had no sibling by the rule and 3 had siblings the requirement does not govern — they
  called a helper the requirement is not about (`remove_file`, `destroy_infra`, …). In one
  (oxicrab `#155`) the helper the requirement is about, `refresh_token_internal`, is a seed, but its
  other callers — `ensure_valid_token`, `chat`, `warmup` — are a changed function or call one
  (`self.ensure_valid_token()`), so none is a sibling; `warmup` drops the refresh's error and
  returns `Ok(())`, the defect the search was for, in a function the change reaches. The rule is
  narrower than the tool in one way: it takes a free or path call to the seed and not a method call,
  which the tool settles when the method takes `self`. That left out 4 functions, all in oxicrab
  `#155` and each out on another count as well (`chat` and `warmup` above, `action_delete` deletes a
  file, the fourth is a test). The rule did not see that count for `warmup`: it looks for calls by
  name and not `self.…()`, so its record gives the method call as the only reason, and a rule that
  took method calls would have chosen `warmup` — which the tool leaves out. Here the rule's
  narrowness happened to match the tool. No request was sent to Jev for the search, and what the
  siblings find in a defect is still not measured.

### What another push would not have to ask again

Whether keeping a pull request's answers would save anything, measured before anything keeps them
(ADR 0012; `bench/packet-reuse.ts`, log `bench/logs/packet-reuse-v1.json`). Answers decide nothing
about what is sent, so they came from a stand-in on localhost and no request was billed:
`selectSites` finishes before the first request and asks no model, and the observation question is
sent whatever the mapping question answered. Every number here was taken with the tool at `0029a95`,
before the table of *Functions outside the repository* (ADR 0011) was merged; that table changes
which calls are asked about, so the packets a run sends now can differ from the ones counted.

The corpus is every pull request in the acceptance set's candidates (`bench/acceptance/candidates.json`,
40 entries), each attempted. **12 were measured, over 31 pairs of consecutive pushes.** The 28 that
were not are in the log with the reason: **17 are not pull requests at all** — those entries name
issues of `yottayoshida/omamori`, another repository by this tool's author, and `/pulls/{n}`
answers 404 for each — and 11 have a single commit, which is no pair. Every run that was measured
exited 0; a pair is counted only when both of its runs did, because a run that dies leaves no trace
and would read as one that sent nothing (none was left out). A push here is a commit the author
pushed, in order; every run was given the same requirement, in the `Property:` form, because most of
these pull requests state none in a form this tool reads.

| pull request | heads | of each later push, the judgments already answered at the push before |
|---|---|---|
| `oxidezap/whatsapp-rust#759` | 2 | 9/13 |
| `moltis-org/moltis#1064` | 2 | 52/61 |
| `KontorProtocol/Kontor#385` | 4 | 49/52, 45/57, 54/58 |
| `TyRoXx/NonlocalityOS#433` | 3 | 5/13, 13/14 |
| `armaxri/termiHub#2751` | 4 | 7/25, 25/34, 34/34 |
| `armaxri/termiHub#2732` | 2 | 20/37 |
| `beboite/boite-legacy#187` | 12 | 10/41, 41/64, 64/64, 64/64, 64/64, 64/64, 64/78, 78/81, 81/85, 81/86, 79/89 |
| `Diogo-Esteves/polyVocal#60` | 2 | 53/72 |
| `TumbleOwlee/ferrowl#127` | 4 | 0/1, 1/14, 9/22 |
| `getappz/agentflare#229` | 2 | 11/11 |
| `Davidslv/cce-rust#168` | 3 | 4/41, 21/46 |
| `AndreaBozzo/dataprof#370` | 3 | 49/50, 50/55 |

**The median over the 31 pairs is 0.852**: in the median pair, 85% of the later push's judgments ask
again about the same evidence, byte for byte. By side: the calls' questions, 528 of 628; the change
question, 673 of 862.

One pull request carries 11 of the 31 pairs — `beboite/boite-legacy#187`, four of them 64/64 — so
the median of pairs leans on it. Counted other ways the share is lower, and every one is still above
the 0.50 the decision was fixed at: the median of each pull request's own median, 0.736; the 20
pairs without that pull request, 0.736; every judgment pooled, 1201 of 1490 (0.806); only each pull
request's first pair, 0.616.

**A packet that differs only in where its code sits is rare.** Blanking every `lines` value before
comparing — the function's start and end line, and the change's — moves 6 of the calls' 628 and 15
of the changes' 862, and the median from 0.852 to 0.869. The line numbers a packet carries were the
reason to expect little reuse; they are not what decides it. A key that ignored them would buy
about two points.

**Adding a requirement moves the packets of the requirements already there, unless it goes last.**
On `moltis-org/moltis#1064` at its head, with one requirement and then two
(`bench/logs/requirement-positions-v1.json`): a packet holds one requirement, so appending a second
leaves the first's packets as they were — 34 of the 68 sent were already there, which is all of the
first requirement's. Putting the second one *first* renumbers the ids the packets carry, and none of
the 68 was: 0. The change question's state holds every requirement at once, so its packets change
either way: 0 of 27.

**What a stored answer would change.** The acceptance bench asks every place three times with
byte-identical input (`bench/answer-spread.ts`, log `bench/logs/answer-spread-v1.json`, over
`bench/logs/acceptance-v1.json`). The reading differed between runs in 2 of 34 places, and 8 of the
102 readings sit within 0.1 of the bar of 0.6; both places that differed are among them. In both,
Jev chose `returns_success` every time; what moved was its probability, between 0.57 and 0.68, and a
reading below the bar is reported as `cannot_determine`. So a place that differs between runs is one
whose probability sits at the bar, by how the bar works. A stored answer would keep one of those
draws for every later push; asking again gives a fresh one each time. These places are not a real
pull request's: 8 of the 34 are pull request heads (`shipped`), and the other 26 are versions built
for the acceptance bench (`defect`, `rewrite`, `hidden`). One of the two that differed is a
`hidden` version, which is built so that its answer should be `cannot_determine` or below the bar
(`bench/acceptance/README.md`).

**The ledger, once built, measured the same way** (ADR 0013; `node bench/packet-reuse.ts --ledger`,
log `bench/logs/packet-reuse-ledger-v1.json`). The same 40 candidates, the same 12 measured and the
same 28 not; every push of each was run twice against a stand-in, once without kept answers and once
with them (`--answers`, one directory per pull request, carried from push to push). The stand-in's
answers follow each request's hash — choice and probability both — so an answer returned for the
wrong request would change the report. On all **43 pushes**: the reused count equals what the trace
of the run without them says should be covered — requests sent at any earlier push, and repeats
within the push — and so does the part of it kept from earlier runs; the requests sent plus those reused equal the requests of the run without them,
and the requirements and changes read are the same, probabilities included. No run failed. Of the
31 later pushes, the median share answered from kept answers is **0.855** (1241 of 1535 pooled),
with the tool as it is after the table of *Functions outside the repository* — against 0.852 for a
pair's identical packets above, which counts only the push just before.

What this does not measure:

- How a pull request's pushes are spread over time, and so whether a cache would still hold the
  earlier push's answers when the later one runs.
- Pushes as people make them. A push is counted here per commit; a push that carries several commits
  changes more between runs, so a share per real push would be lower than this. Of
  `beboite/boite-legacy#187`'s 12 commits, the first six landed within four minutes. History a
  force-push removed is not seen at all.
- Whether the stand-in is sent exactly what the real endpoint is, beyond one pull request. On
  `oxidezap/whatsapp-rust#759` at its head, one run against the stand-in and one against Jev
  (Cloudflare) sent the same 13 packets, each once (`bench/logs/fidelity-v1.json`, from
  `node bench/packet-reuse.ts --work <dir> --fidelity owner/repo#n`). Their order differed: the
  change questions go out together and a trace line is written when its answer comes back, so the
  comparison is of the packets and not of their order. The other eleven pull requests rest on the
  argument from the code above.
- Any pull request of this tool's author's repositories: the 17 entries of `yottayoshida/omamori`
  are issues.

### `failure_handling`, measured before it was wired (#85)

**The form's observation question tells a function that drops a failure from one that logs it and
goes on, and from one that returns it — on these four places, three runs of three each.** The question
is `src/plan/handling.ts`'s, sent on the packets the run builds, before the form was wired; the versions,
the expected answers and the lines were committed first (packets built as the run builds them, with one fixed requirement sentence; `bench/handling/probe.json`, log
`bench/logs/handling-probe-v1.json`, `typesafe/jev` on Cloudflare, 2026-09-25). *reported* is a
defect version with the failure logged where it is dropped; *decoy* is a defect version with a line
that logs something else in the same function, the failure still dropped; moltis#1064's
`generate_title`, as its defect version has it, already logs the failure and records a metric before
returning an empty title (*logged*), and *silent* takes those two away.

| place | shipped | rewrite | defect | reported | decoy |
|---|---|---|---|---|---|
| grovedb#500 `finalize` → `rewrite_heights` | propagates 3/3 (0.99) | propagates 3/3 (1.00) | continues_silently 3/3 (0.87–0.89) | reports_locally 3/3 (0.97) | continues_silently 3/3 (0.88–0.92) |
| moltis#1064 `generate_title_for_session` → `generate_title` | propagates 3/3 (0.99–1.00) | propagates 3/3 (1.00) | continues_silently 3/3 (0.90–0.95) | reports_locally 3/3 (1.00) | continues_silently 3/3 (0.93–0.95) |
| moltis#1064 `dispatch_command` → `handle_title` | propagates 3/3 (0.99) | — | continues_silently 3/3 (1.00) | reports_locally 3/3 (0.98–0.99) | continues_silently 3/3 (1.00) |
| moltis#1064 `generate_title` → `complete` | propagates 3/3 (0.98–0.99) | — | *logged*: reports_locally 3/3 (0.98) | — | *silent*: continues_silently 3/3 (0.99) |

Both lines hold: every version that is not shipped or rewritten got its expected answer at the bar in
three runs of three, and no shipped or rewritten version was answered `continues_silently`. What this
does not show: how it answers in a function that returns `()` — all four functions here return a
`Result`, and the form asks in one that does not, which the probe did not reach — nor how the form does on pull requests it was not built on, its mapping question (not sent
by the probe), or how often it lists a call that is not a defect there. Two repositories and four
places are the whole of it; the form is used only where a spec names it.

<!-- forms-85:begin -->
Which requirements the new sentence can write is recorded apart, and is no gate (`bench/eval/forms-85/`,
fixed before any judgment; `bench/eval/forms-85.json`): for each of the evaluation pool's 91 labelled
rows, three fresh annotators per form, in separate sessions, read the pull request's and its issues' text
and said whether its requirement could be written as `failure_propagation` (a) and, apart, as
`failure_handling` (a′). On the rows of Rust repositories whose code before the fix swallowed the
failure (`swallows_as_success`, 37 rows, 23 repositories), (a) could write 21 (56.8 %, mean over
repositories 52.7 %) and (a) or (a′) 28 (75.7 %, mean 64.9 %); on every row not labelled
`not_failure_handling` (67 rows, 35 repositories, `other` and `cannot_label` among them), 32 and 43. Agreement: (a) unanimous on 72 rows, (a′) on 81; the annotators'
(a) says what the case choice's own verdict said on 57 of the 70 rows that have one. This counts
sentences, not what the run reaches: whether the tool reaches the call in those pull requests is not
measured. The six annotators worked in one directory, and one kept its notes there; no other
annotator's quotes match those notes on more than 31 rows of 91, which the same sentence of a pull
request, quoted twice, would also give — that nothing was read across is not shown.
<!-- forms-85:end -->

### How Jev reads the form of a sentence

Whether Jev can tell a sentence's form from its words alone was measured before anyone lets it
choose one (ADR 0008; `bench/forms/choice/`, log `bench/logs/form-choice-v1.json`; 216 requests,
every one to Cloudflare). Every requirement sentence this repository held on 2026-09-22 in a spec,
fixture or golden file — `run.ts verify` enumerates them and a test fails when one is in neither
this set nor the second one below — the
four examples in issue #35, and three written from omamori issues whose fix was a check before an
action: 72 sentences, each labelled `failure_propagation`, `check_before_action` or `neither`
before the first request, with who wrote it — `tool` (this project, for its fixtures and benches),
`model` (the requirement-writing model's first output, repaired; fourteen are fragments cut
mid-sentence, sent as they are), `text` (read by hand from a real issue or pull request, and
issue #35's examples), `written` (the three). Jev was sent the sentence alone, three times each,
and asked which of the two forms its sentence says, or neither; an answer counts at the bar of
0.6. A fixed keyword rule (`must not` / `never` / `unless` → check, tried first; `fail` /
`error` → failure) is scored beside it for scale and used by nothing.
`node bench/forms/choice/run.ts score` recomputes this table from the log, and
`test/form-choice.test.ts` holds the log to these counts.

| label | who wrote it | sentences | fragments | read as its label in 3/3 | read as check in any run | neither / under the bar in any run | keyword rule right |
|---|---|---|---|---|---|---|---|
| failure_propagation | all | 18 | 2 | 16/18 | 0/18 | 2/18 | 3/18 |
| | tool | 15 | 0 | 14/15 | 0/15 | 1/15 | 0/15 |
| | model | 2 | 2 | 2/2 | 0/2 | 0/2 | 2/2 |
| | text + written | 1 | 0 | 0/1 | 0/1 | 1/1 | 1/1 |
| check_before_action | all | 11 | 1 | 10/11 | 10/11 | 1/11 | 8/11 |
| | tool | 5 | 0 | 5/5 | 5/5 | 0/5 | 4/5 |
| | model | 1 | 1 | 1/1 | 1/1 | 0/1 | 0/1 |
| | text + written | 5 | 0 | 4/5 | 4/5 | 1/5 | 4/5 |
| neither | all | 43 | 11 | 39/43 | 4/43 | 40/43 | 33/43 |
| | tool | 2 | 0 | 2/2 | 0/2 | 2/2 | 1/2 |
| | model | 29 | 11 | 26/29 | 3/29 | 26/29 | 24/29 |
| | text + written | 12 | 0 | 11/12 | 1/12 | 12/12 | 8/12 |

Read against what ADR 0008 said beforehand the numbers would have to show: no failure sentence
read as check at the bar in any run (0 of 18); at least 80% of the check sentences read as check
in every run, and no fewer than the keyword rule gets right (10 of 11; the rule 8); at most 10% of
the neither sentences read as check in any run (4 of 43, exactly the cap). All three met. What the
rows by author add:

- The two failure sentences not read as failure in every run are the fixture's "A baseline that
  cannot be read is not reported as no baseline at all." (0.55, 0.57 and 0.60 — under the bar
  twice, at it once) and the one read by hand from omamori #553, which says `"error"` only as a
  JSON value (0.51–0.54). Under the bar they fall to the default, which is what they are asked
  today. The fourteen template sentences and the two model fragments — the other two sentences not
  in the template, which do say "fail" and "error" — read at 0.95–1.00.
- The check sentence under the bar is issue #35's "every session-creation path must enforce the
  same guard;" (0.52–0.55), which names no operation. Its other example, "disabled API keys must
  never authenticate;", 0.99–1.00; the three written from issues, 1.00; the fixtures' "Disabled
  users cannot authenticate.", 0.95–0.97; the model's fragment, 0.98.
- The four neither sentences read as check are of one shape — "voiding the run if a match is
  found" (sideeye #594, two sentences, 0.88–0.94), "refuses rather than judging if …" (sideeye
  #602's second sentence, 0.72–0.73, and the one read by hand from it, 0.65 in one run of three
  and 0.56 and 0.59 in the others): sentences that say what is refused when a condition holds,
  which the one reader labelled neither. The cap of four is met by that last sentence, which
  straddles the bar — in the first measurement it was over it in two runs of three. Once Jev
  chooses, each is asked the check questions about the calls sharing its words instead of the
  failure questions it is asked today.
- No sentence of any class was read as `failure_propagation` that was not labelled so.

Fourteen of the eighteen failure sentences are this tool's own template; the other four are one
fixture sentence, two model fragments and one from a real pull request. Of the eleven check
sentences, five are this project's bench and fixture sentences, three were written from real
issues for this measurement, two are issue #35's as written and one is a model's fragment. The
table says how Jev reads sentences of these shapes, not how it would read an arbitrary issue.

Seven sentences came into the repository after the table, the requirements written by hand from
the pull requests `#37`'s search read (`bench/acceptance/candidates-v2.json`). The first log records
the sha256 of the set it was taken on and is not added to, so they are a second set
(`bench/forms/choice/sentences-v2.json`, all labelled `failure_propagation` and written `text`,
committed before the first request), measured the same way with its own log
(`bench/logs/form-choice-v2.json`; 21 requests to Cloudflare, `node bench/forms/choice/run.ts score
--set 2`). Each was read as `failure_propagation` in every run, at 1.00, and none as check; with
them, 0 of 25 failure sentences was read as check in any run. `run.ts verify` and the test check
the repository's sentences against the two sets together.

The owner's ruling on these numbers (2026-09-22, ADR 0008): Jev chooses the form of a requirement
read from an issue, a pull request, `--intent` or `--intent-file`; a spec's `form` stays its
author's. The run does so now ([Writing a requirement](local-check-cli.md#writing-a-requirement)): the question it
sends is the one above, held to the log's hash by `test/forms.test.ts`, and `metadata.questionsHash`
covers it from that change on — the records above carry the hash of their day, and a spec run's
hash moved with it though what it sends did not.

#### With `failure_handling` offered (set 3, #85)

`failure_handling` is not offered to sentences (ADR 0023): a requirement read from text that says a
failure may be logged or recorded but not swallowed is checked under `failure_propagation`. Whether
offering it would route such a requirement to it was measured first (ADR 0026). With
`failure_handling` offered as a third form, the numbers below are recomputed by
`node bench/forms/choice/run.ts score --set 3` from `bench/logs/form-choice-v3.json` — a log whose
sentences, their labels and the question were committed before its first request — beside the
current question measured the same day (`score --set 1c`, `bench/logs/form-choice-v1c.json`).

The question is the run's, built by the same function with every form offered, in declared order.
The sentences are the 79 above and 23 written from dev pull requests
(`bench/forms/choice/written-85/`): for each, one reader wrote the requirement from the pull
request's and its issues' text only, and three others read only its diff and said whether the fixed
code returns the failure or handles it where it happens — the sentence's label. 306 requests, and
237 for the same day's comparison, all to Cloudflare, all answered. The table keeps the rows the text
reads; `score --set 3` prints every row by author, the lines, the main line by repository and every
sentence's three readings.

| label | who wrote it | sentences | read as its label in 3/3 | as check in any run | as failure_handling in any run | neither / under the bar in any run | keyword rule right |
|---|---|---|---|---|---|---|---|
| failure_propagation | all | 38 | 32/38 | 1/38 | 3/38 | 3/38 | 21/38 |
| | written-85 (fix returns it) | 13 | 9/13 | 1/13 | 3/13 | 1/13 | 11/13 |
| check_before_action | all | 11 | 10/11 | 10/11 | 0/11 | 1/11 | 8/11 |
| failure_handling | written-85 (fix handles it) | 10 | 4/10 | 0/10 | 4/10 | 3/10 | 4/10 |
| neither | all | 43 | 35/43 | 2/43 | 3/43 | 38/43 | 27/43 |

Against ADR 0026's lines, written before the first request:

- **Not met — the main line.** Of the 10 sentences whose pull request's fixed code handles the
  failure locally (8 repositories), 4 were read as `failure_handling` in every run (bar 80%; Wilson
  95% 0.17–0.69, taking rows as independent). Three of the six others say what the issue asked in
  words of propagation — "surface the error", "must be propagated", "let the error reach the …
  backoff loop" — and were read as `failure_propagation` at 0.67–0.92; the other three (a message
  to a finished session, a staging directory's report, an audit record) are not sentences about a
  failure's handling and were under the bar, 0.42–0.54. Either way they go to `failure_propagation`,
  which is the complaint #85 opens with.
- Met — the rest. Of the 21 failure sentences that say the failure goes back, none was read as check
  or as `failure_handling` in any run. Check sentences: 10 of 11 in every run, as under the question
  sent now the same day. Neither sentences read as check in any run: 2 of 43 (4 under the question
  sent now, the same day); as `failure_handling`: 3 of 43 — "A failed OAuth token exchange is retried
  once before the login fails." and sideeye #626's two sentences on what a failing run prints and keeps.
- Recorded: of the 13 sentences whose fix returns the failure, three were read as `failure_handling`
  in some run — two in every run, at 0.60–0.68 (one says the isolate setup "must warn", one that a
  failed fetch "must be reported instead of being swallowed"), one in one run of three — and one,
  omamori #557's "append() must chain onto the log's last chain entry …", as check in every run
  (0.68–0.71). The same day's comparison does not include these 23 sentences, so whether offering
  the form moved them is not measured.

Offering the form would not, on these sentences, send most requirements whose fixed code handles a
failure to it: what decides the route is whether the issue's own words say how the failure is to be
handled, and more than half of these do not say it in the form's terms. `failure_handling` stays
offered to no sentence; the ruling is in ADR 0026.

## Record of the experiments

What follows is the working record of how v0.1 got here, translated from the Japanese it was first
written in. It names the flags as they were used then (`--experimental-local-check`,
`--experimental-candidates-only`), and describes paths since removed — the planner, the clause —
as they were.

---

### The experimental CLI (2026-09-21)

The continuation of `docs/selection-materials.md`. Not one more scorecard of selections, but **a
command that takes code and returns results with their grounds**.

```sh
jev-intent-review --experimental-local-check --base <rev> --head <rev> --intent-spec <file>
jev-intent-review --experimental-local-check --experimental-candidates-only ...   # asks nothing
```

**The user does not enter target files, functions, call IDs or expected answers.** No evaluation
name is in the product code either.

### The paths

There are **two** things that offer candidates, and they differ in kind.

1. **The diff** — the functions containing changed lines, and their callers one hop out
   (`src/plan/from-diff.ts`). This is **a hint for searching**, not a claim that the requirement
   applies.
2. **The requirement's words** — the existing lexical search opens files, and the planning model
   picks calls in them **by id**, writing for each pick "which clause of the original text"
   (`src/plan/planner.ts`).

**Neither overrules the other.** A candidate from the diff is not dropped because the model did not
pick it, and the same the other way round.

3. Whichever reached a function, **its inside is widened mechanically** — the defect is often
   another call in the same body (measured: the right function 3/3, the right call 1/3)
4. **Only candidates a question can be put to are judged** (`src/plan/applicability.ts`): only
   those whose callee's **definition is looked up** and confirmed to return a `Result`
5. **The budget is dealt once per requirement**, going round the functions one at a time
   (`roundRobin`). It used to be dealt per file — fixed: a requirement that opened three files could
   spend three times its budget

**A local observation is not a verdict on the requirement.** **A changed line only says work was
done there**; it does not say the requirement applies. Whether an observation bears on the
requirement is decided by **the mapping** (the section below). **No verdict on the whole requirement
(VERIFIED) is given, and the exit code stays 0 even when there is a finding** — though a failure of
the configuration, the repository or the endpoint ends with something other than 0. What comes out
is "**a defect candidate to check**" — with all its grounds attached, in a form the reader can
reject.

### Results on the real code (omamori #468 / PR #476)

**The base of all five branches is `52a58fa`** — the parent PR #476 was squashed onto. Handing over
the diff from the correct version to a mutant would tell the search where the mutation is, so the
base is the same for all.

The four patches — mutants and behaviour-preserving rewrites — applied unchanged to PR #476's head
`e58c04f`, and **the expected behaviour was taken again by probe**
(`bench/fixtures/omamori-468/probe_*.rs`, observed by planting a directory).

| branch | what `read_baseline` does | what `raw_override_disables` does | the CLI's observation (same order) |
|---|---|---|---|
| correct | `Err(… is a directory …)` | `Err(…)` | returns_error 0.99 / returns_error 1.00 |
| m-read-baseline | **`Ok(None)`** | `Err(…)` | **returns_success 1.00** / returns_error 1.00 |
| v-read-baseline | `Err(…)` | `Err(…)` | returns_error 0.98 / returns_error 1.00 |
| m-raw-override | `Err(…)` | **`Ok(false)`** | returns_error 0.99 / **returns_success 0.99** |
| v-raw-override | `Err(…)` | `Err(…)` | returns_error 0.99 / returns_error 0.99 |

**All ten cells match the real behaviour.** Each mutant flips only its own target, and the
behaviour-preserving versions match the correct one. The record is `bench/logs/diff-reach-v1.json`.

Reach can be checked first, **without any request** (`--candidates-only`). On all five branches:
23 functions (changed) + 20 (callers), 37 a question can be put to, and **both target calls fall
inside** the budget of 20. Only the total number of calls differs by branch (739 for correct,
m-read-baseline and m-raw-override; 738 for v-read-baseline; 740 for v-raw-override) — natural,
since the behaviour-preserving versions change how the code is written; writing "the same on all
five branches" here was a mistake.

| branch | `read_baseline` inside the budget | `raw_override_disables` inside the budget |
|---|---|---|
| all five branches | yes | yes |

#### One cell is `returns_success` even on the correct version

`src/integrity.rs · generate_baseline` is **returns_success (0.94–0.97) on all five branches**. The
actual code is

```rust
if let Ok(content) = crate::atomic_file::read_to_string_capped(&path, MAX_TRACKED_FILE_BYTES) {
```

and skips a hook file it could not read and carries on. **As an observation of what the function
returns, it is right.**

**But it must not be scored as "legitimate, so it need not be reported".** That the implementation
behaves so and that the requirement allows it are different questions, and the second is not
answered here. If it cannot be settled from the original text, it stays `unknown`.

### What was found and fixed on the way

**① The listing sent to the model did not go through redaction.** `listingFor` put out hundreds of
source lines as they were — exactly where a key written in a constant would land. It now goes
through the same processing as the evidence packet.

**② The budget was per file.** "5 per requirement" became 15 over three files. It is dealt once
over the whole requirement. The ids were also made to include the file (`src/config.rs:call-7`) — a
bare `call-1` **was the same id in different files**, so a pick in one resolved into the other's
listing.

**③ An answer was taken even when the body was cut.** If `evidence.cut.own` is true, the answer is
about half a body. It is set aside with a reason (fired once on the real code: `verify_chain`).

**④ `#[cfg(all(test, unix))]` was not recognised as test code.** Only `/^\s*#\[cfg\(test\)\]/` was
looked for, so **a test module with a platform condition was read as product code**. In omamori
there is one, in a file PR #476 added. Noticed on the real code —
`a_fifo_is_refused_rather_than_waited_on` came up as a candidate. The function is used not only by
`enumerate` but by `realDefinitions` (building the evidence) and the applicability check, so this
also affects the ordinary review path.

**The first fix went too far.** It excluded a line with `test` anywhere in it, which also removed
`#[cfg(any(test, feature = "production"))]` — **code used in an ordinary build** when that feature is
on. Now **only an expression confirmed to be test-only** is excluded: `all(...)` is test-only if any
of its parts is, `any(...)` only if all of its parts are, and `not(...)` and expressions it cannot
tell are **kept**. Removing too much is worse — **nobody reports what is not there**.

**⑦ The question text did not go through redaction.** One request is **both the packet and the
question**, but only the packet was cleaned. `conditionFor` puts the call expression into the
question as it is, so a secret-looking string in an argument **would leave through a field nothing
touched**. While `locateCall` matched on the raw expression, such calls were set aside and did not
show — that was a defect of its own. The condition and the matching use the same redacted
expression. **So does the printed report** — the report is something that gets passed around.

**⑤ Only the calls inside the budget were missing from the report.** `--candidates-only` exists to
answer "which calls are inside the budget", yet **only the ones chosen were not printed**. The first
check on the real code misread this as "the targets are not reached" — they were.

**⑥ Whether the planner did not answer or answered "none" could not be told apart.**
`modelPlanner`'s `catch` returned `{picks: []}`. It now returns with a reason. **The first answer
this fix produced was this** —

```
the planner did not answer about src/audit/mod.rs (… answered 429: … you have used up your
daily free allocation of 10,000 neurons …), so no call there carries a clause
```

### Nothing is sent to anything but Jev (2026-09-21)

**This tool asks Jev small typed questions**, yet it was using a general instruct model
(llama-3.3-70b) in three places: compiling the requirement (from the start), planning (added by me
in #26) and mapping (added by me in #28). Each looked reasonable at the time, and **none was
declared**.

| fix | what it is |
|---|---|
| refused at the sending boundary | `CloudflareClient.post` refuses anything but `typesafe/jev` **before building the request**. The CLI and the bench go through the same path. It is counted neither in requests nor in bytes |
| compiling the requirement | No model writes it. `--intent-spec`, or **an acceptance-criteria list the code can read**. Any other prose stops with the reason and the two forms that can be used |
| planning | **Removed.** Candidates are made only from the diff, the reference search, the applicability check and the budget (the path that opened files by the requirement's words is gone too) |
| mapping | **Jev's three options** (`applies` / `does_not_apply` / `unknown`). The whole probability distribution is kept, and the rule of adoption was fixed before measuring (`applies` at 0.6 or above) |
| quotes and explanations | **No other model is kept.** The quote is the input text itself; the explanation is assembled by rule from the original text, the code location, the assumption and the two answers. **Nothing is shown as if a model wrote it** |
| CI | Without the real API, it reads **the model name of every body sent**. The experimental path is run end to end and every request is confirmed to be Jev's |

**One defect disappeared.** Jev's answer has no `callId`, so the form "an answer to another call gets
joined to this one" (#29) **no longer exists, rather than being checked**. Jev answers the question
sent, about the state sent.

**The check that matched quotes against the original text is no longer needed either.** It was
needed because a model chose the fragments; when the quote is the requirement itself, there is
nothing to match.

### The first measurement asking Jev for the mapping (2026-09-21, correct version, PR #476's text)

```
asked 19, mapped 19, governed 3, findings 0
```

**Both known targets are `does_not_apply`** (0.51 / 0.63). What Jev read as `applies` is
`reject_non_regular` (0.90 / 0.77) — the call that **does the refusing itself**. The original text
says "a path omamori reads **is now refused by name**", and does not say what the side that receives
the refusal returns. **The gate is NOT READY, and the other four branches were not sent.**

**This result is not changed.** What follows is a measurement on **a different evaluation input**;
it is not a faithful paraphrase of the original text, and it does not claim that reasoning from the
original text succeeded.

### A measurement with requirements that state how a failure is handled (2026-09-21)

The question checked: "**can this CLI check a requirement in which the user states how a failure is
handled?**"

The input (`bench/fixtures/omamori-468/stated-failure-handling.spec.json`; **no function name,
helper name, call ID or expected answer is written in it**):

> **R1** If reading an existing integrity baseline fails, the baseline-loading operation must
> return an error to its caller. It must not return a successful result saying that no baseline
> exists.
>
> **R2** If reading an existing configuration file fails while checking whether a rule override
> disables a rule, that check must return an error to its caller. It must not return a successful
> result saying that the rule is not disabled.

**The conditions and the expected results were saved before the first request** (tool commit
`ee35665`, base `52a58fa` on all five branches, budget 20, threshold 0.6, the model `typesafe/jev`
only). A candidates check without requests also confirmed first that **both targets are inside the
budget on all 5 branches × 2 requirements**.

The unit of scoring is **requirement ID, file, function and call expression**. The function name
alone decides nothing.

#### Result: all ten cells match

| branch | R1 `read_baseline` | R2 `raw_override_disables` |
|---|---|---|
| correct | no finding (applies 0.97 / returns_error 1.00) | no finding (applies 1.00 / returns_error 1.00) |
| m-read-baseline | **finding** (applies 0.96 / **returns_success 1.00**) | no finding (applies 1.00 / returns_error 1.00) |
| v-read-baseline | no finding (applies 0.98 / returns_error 1.00) | no finding (applies 1.00 / returns_error 1.00) |
| m-raw-override | no finding (applies 0.98 / returns_error 1.00) | **finding** (applies 1.00 / **returns_success 0.99**) |
| v-raw-override | no finding (applies 0.98 / returns_error 1.00) | no finding (applies 1.00 / returns_error 1.00) |

**Each mutant has a finding on its own target only, and the other stays quiet.** The correct and the
behaviour-preserving versions are quiet on both. **Findings outside the scored targets: 0** (not one
on any other call).

Each run is **76 requests** (2 requirements × 19 calls × 2 questions), **380** over the five
branches. The record is `bench/logs/stated-requirements-v1.json` — the input spec, the conditions
fixed before the run, **the mapping and the observation (with every option's probability) for all 38
calls of 5 branches × 2 requirements**, every finding, the counts not checked by kind, and the
notes. **The scoring can be reproduced from this file alone**:

```sh
node bench/replay-scoring.ts bench/logs/stated-requirements-v1.json
```

The evidence packets (the function bodies sent) are not saved — they can be rebuilt from the git
objects of the fixed commits. Redaction applies to what is saved as well.

#### What was fixed in the gate

The correct version's gate **read only `requirements[0]`**. In a spec with two requirements, R2's
target was scored with R1's answer. It now matches by requirement ID.

Also, **the gate was READY whenever the mapping was usable, even with a finding on a target in the
correct version**. The correct version is the baseline the other four branches are compared with, so
a finding there already breaks the table. It now requires **both (a usable mapping and no
finding)**, with a hand-written log as a regression test.

#### What can be said

**For requirements that state how a failure is handled, the known defect candidates were reached
without the user naming the place.**

This is scoring on two known targets: one repository, two requirements, one run per branch. The
measurement on the original text in `bench/logs/jev-only-v1.json` is left NOT READY — **it is not
that a paraphrase of the original text succeeded, but that a different input worked**.

### How much the listing itself misses

Once the cap was put in the notes, it turned out that **the cap of 40 calls per function had dropped
261 calls** (7 files, 80 in `src/integrity.rs` alone). On top of that, **84** references to the
changed functions are "not inside a function this path reads" (`use` lines, `impl` methods, macro
bodies). The two targets are reached, but **the listing is not complete**. While this was not
counted, a short list could not be told from a short file.

### The clause is the model's sentence

`clause` was **the only field in which the model's prose went into the Markdown as it was**. The
schema has `maxLength: 300`, but `readModelJson` only does `JSON.parse` and **does not enforce it**.
One newline breaks the bullet list, and a backquote can open a code span.

And **the only thing on the product side guaranteeing that this path reports no violation was that
`describe()` has no field for a verdict** — while `clause` was a field a verdict's sentence fits into
as it is.

It cannot be filtered by meaning (a clause quotes the original text, so words like "silently treated
as…" legitimately appear). So it is **contained**: one line, 300 characters, no code span, and
**quoted to show whose sentence it is**, as `The plan said this call checks: "…"`.

### What was not measured

**No clause was attached this time. There are two reasons, and one of them is settled.**

**The settled one: the planner is not shown the target files.** The files passed to the planner are
still decided by `filesFor` alone, and what was passed was `src/audit/mod.rs` and `src/actions.rs`.
`src/config.rs` and `src/integrity.rs`, where the observable targets are, **were not passed**. So
**just re-running once the quota is back will not attach a clause to the targets**.

**The other: all five times it was `picks: []`, with no reason recorded** (before fix ⑥). Re-run with
the reason put out, it was 429 — the day's free quota used up. Whether it declined or failed is
**not known**.

Every request of the judging side went through (19 observations per run), so the tables above are
not affected. Even if one prose clause were attached, that by itself would **not be evidence that
the mapping to the requirement is right**.

So **what this stage showed goes as far as "the behaviour at the defect's place can be observed
automatically"**. To tie an observation to a grounded finding, whether clauses get attached has to
be measured.

The planner is asked only about **the files the requirement's words opened**, not about the changed
files (to keep the mapping to the requirement apart from listing candidates). They did not overlap
this time — the original text names the symptoms (FIFO, directory, symlink), while the mechanism is
a shared reading helper, which the words do not reach.

**With N requirements, the same call from the diff is judged N times.** The question itself does not
contain the requirement, but the evidence packet does, so whether an answer can be reused across
requirements is **not measured**. Whether a question can be put (`applicabilityOf`) depends only on
the commit, so it is done once. Fixing the rest would mean judging the diff's set once and attaching
it to each requirement's report. This measurement had one requirement, so **this shape does not show
in the data**.

With `--intent` (free text), the model writing the requirement rewrites it into a different sentence
each time, so **the files opened change from run to run**. To compare, fix it with `--intent-spec`.

### Against the exit conditions

| condition | state |
|---|---|
| the CLI reaches the mutated call of both cases | **met** (all five branches, confirmed without requests too) |
| the correct, mutant and behaviour-preserving versions can be told apart | **met** (all ten cells match the real behaviour) |
| a grounded defect candidate is returned from the mapping | **met without requests**. On the real code, not reached: the mapping model hit 429 |
| no false violation on the correct and behaviour-preserving versions | **not checked** (below) |
| what is unsupported, not settled for applicability, or over the budget is left with a reason | **met** (720 on the correct version, counted by kind) |
| no specific function name or correct label is in the product | **met** (no proper name in `src/plan/` or `src/review/local-check-run.ts`) |

The third row was once written as "met — this path reports no violation", but **that is not a
check**. Its premise cannot be false by construction, so it is met whatever is measured. The nearest
thing to a false positive in the real data is `generate_baseline`'s `returns_success` on all five
branches, which, as written above, **is right as an observation**. Whether no false violation is
given can only really be measured once observations turn into findings.
