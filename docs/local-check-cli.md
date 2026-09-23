# The local check

This is the reference for the run: what to give it, how to read what comes back, what the exit
code means, and what has been measured. Since [ADR 0007](adr/0007-the-run-is-the-local-check.md)
the local check *is* the run — `jev-intent-review` with no flag does what `--experimental-local-check`
did; the flag is accepted, the report and the exit code are the same without it, and one line on
stderr says so. The README says what the tool is for; this says
exactly what it does. The sections after [the record](#record-of-the-experiments) are the working
record of how v0.1 got here, in Japanese; they name the flag as it was used.

## Writing a requirement

One checkable sentence per requirement. No file name, no function name, no expected answer. What
the sentence has to say depends on its **form** — what the check asks of each call
([ADR 0006](adr/0006-question-forms-as-data.md)):

| `form` | the sentence says | example |
|---|---|---|
| `failure_propagation` (the default) | what must happen when something fails | "If reading an existing integrity baseline fails, the baseline-loading operation must return an error to its caller. It must not return a successful result saying that no baseline exists." |
| `check_before_action` (experimental) | which action must not happen unless a check passes, naming the action by a word its call carries | "A disabled API key must never create a session." — `create_session(…)` is asked about; `audit(…)` is not |

```json
{
  "version": 1, "title": "", "summary": "", "nonGoals": [], "ambiguities": [],
  "requirements": [{
    "id": "R1",
    "text": "If reading an existing integrity baseline fails, the baseline-loading operation must return an error to its caller. It must not return a successful result saying that no baseline exists.",
    "kind": "behavior", "priority": "required", "sourceRefs": [], "searchHints": []
  }, {
    "id": "R2",
    "text": "A disabled API key must never create a session.",
    "form": "check_before_action", "searchHints": ["open_session"]
  }]
}
```

A spec names the form; a value outside the two stops the run. A requirement read from an issue, a
pull request, `--intent` or `--intent-file` names none, so before its calls the run asks Jev once,
over the sentence alone, which form it says ([ADR 0008](adr/0008-who-chooses-a-requirements-form.md);
measured first on every requirement sentence this repository holds in a spec, fixture or golden
file — [below](#how-jev-reads-the-form-of-a-sentence)): the form Jev says at the bar of 0.6,
`failure_propagation` or `check_before_action`; when Jev reads `neither`, is under the bar, or
gives no answer, the default, `failure_propagation`, as before. The report's form line says which form and who chose it
(`named in the spec`, `the default`, `Jev read the sentence as this, 0.91`, or the default with
what Jev read instead), and `--json` carries `formBy`, `formReading` and `formNotAsked` per
requirement. `--candidates-only` asks nothing and says so; a change that reached no function is
not asked either. A requirement read from text carries no `searchHints`, so under
`check_before_action` it reaches only the calls whose names share a word with the sentence
itself. For `check_before_action` the words of the sentence and of `searchHints` decide which
calls are asked about (below), so a requirement that names no action — "every session-creation
path must enforce the same guard" — reaches no call, and one whose action is not a call
(`return Ok(Session { .. })`) or is `write`/`writeln` (never listed as a call) reaches nothing
either. The report says why for each call it holds.

The issue and the pull request work too, in two ways of writing read as written (ADR 0004,
[writing-requirements.md](writing-requirements.md)): the items of a requirements section
(`## Acceptance criteria`, `## Acceptance`, …), one requirement per item, and a paragraph that begins
`Property:`. Every requirement read that way is asked its form (above). Each source is read on its
own. Ordinary prose is not turned into requirements — no model writes or picks them — so a source in
neither way is named in the report's Intent section with the reason, and a run that could read
nothing stops (exit 11) and prints that section too. The report and `--json` (its `intent`,
`sources` and `notes`) say where each requirement came from, whether that source's author is the
pull request's, and which issues the pull request closes were not read. That is shown, not acted
on: the exit code does not change for it, and there is no requirement verdict to withhold (whether
the GitHub Action should act on it is #41's).

## What it asks

For each requirement it takes the Rust functions the change touched and the functions that call
them, one hop out, and every call inside those functions. Which of those calls can be asked about,
and what is asked, is the requirement's form. Each askable call, up to a budget of 20 per
requirement, gets two questions to Jev, in separate requests: whether the requirement requires
something of this call (`applies` / `does_not_apply` / `unknown`), and what the function does under
an assumption.

A requirement that names no form — one read from text — is first asked which form its sentence
says: one request carrying `{ requirement: { id, text } }` and nothing else (the measurement sent
every sentence as `R1`; the run sends the requirement's own id), and its calls are then read under
the form Jev chose at the bar, or under `failure_propagation` when Jev read neither form or was not
sure. A spec's requirement is not asked; nor is one on a run that read no function.

| | `failure_propagation` | `check_before_action` |
|---|---|---|
| a call can be asked about when | its callee settles to something that returns a `Result` — one `fn` of its name in the repository, the one the call's path or form picks out of several, a trait's method whose versions all return one, or, for a call that writes a path, a function of the table in *Functions this repository does not define* — and the function returns a `Result` too (see *Whether a function returns a `Result`* below) | a word of its name (its path and the receivers before it, split at `_` and at case changes) is a word of the requirement or of `searchHints`; and its callee is not a function this run reads on its own |
| the requirement is asked whether it requires that | a failure of this call not reach the caller as a success | a check pass before this call is made |
| the function is asked, assuming that | this call returns an error and every other operation succeeds | the function is called in a case the requirement says this call must not be made |
| what the function does | `returns_error` / `returns_success` / `cannot_determine` | `does_not_reach` / `reaches_it` / `cannot_determine` |
| against the requirement | `returns_success` | `reaches_it` |

**Every call asked about is read by one rule, the same for both forms**, into one of four:

- the requirement `applies` at 0.6 or more, and the function's answer at 0.6 or more is the one
  against the requirement → **worth checking**; the one keeping it → **holding**; anything else
  (`cannot_determine`, under the bar, no answer) → **not settled**;
- the requirement `does_not_apply` at 0.6 or more → **not required of**;
- anything else from the mapping (`unknown`, under the bar, no answer) → **not settled**.

A request that fails without ending the run leaves its call unanswered and the run goes on; a run
that reached the host and got no answer at all fails (exit 12). `--candidates-only`
stops before the first question and prints which calls are inside the budget and which are not,
with a reason each; it needs no credentials.

The budget is dealt one call per function at a time — the functions the change touched first, then
their callers — so no single body takes it. Inside a function, the askable calls whose callee
resolved to a function the change touched are asked before its other calls, and the rest follow in
the order they appear. When a function gets fewer questions than it has askable calls, that decides
which calls they go to; when more functions hold an askable call than the budget, the functions late
in the order get none, and each of the others gets one, for its first call.

Where a callee resolved to is the `failure_propagation` form's answer: the one `fn` of that name the
repository defines, or, when it defines several, the one the call's path or form picks out — and for
a trait's method read as one thing, the trait's declaration, which is not where any implementation
is (*Which definition a call reaches*), and for a call into a function this repository does not
define, the table's row (`fs::read_to_string`), which is nowhere in this repository and so is never
a changed function. A name nothing settles is not asked about and resolves to nowhere. The
`check_before_action` form resolves no callee for a call it asks about — a call whose callee is a
function this run reads is not askable there — so its calls keep the order they appear in. A
changed function the listing's caps left out (see *Notes*) is not counted as one.

### Whether a function returns a `Result`

For `failure_propagation`, both the function and its callee must return a `Result`, and that is
read from each one's signature — never from how the call's line looks:

- The callee is a `fn <name>` the repository defines outside tests, found by searching for
  `fn <name>`; a definition in a file some module declares `#[cfg(test)] mod x;` does not count,
  because no shipped code reaches it. A name with no such line is not asked about **unless the call
  writes a path the table in *Functions this repository does not define* holds**, and a search
  stopped at its cap of 200 hits settles nothing. A JavaScript function, a `let` line or a snippet
  in a Markdown file is not a definition. When the name has more than one definition,
  *Which definition a call reaches* below says when one of them is settled.
- The return type is the signature's own, read past its generics and parameters up to the body, a
  `;` or `where` (at most 30 lines). No `->` is `()`.
- A name in it is followed: a rename in the same file's `use` (`Result as ChannelResult`), and an
  alias the repository defines (`type CostResult<T, E> = CostContext<Result<T, E>>`), three deep.
- It returns a `Result` when one appears anywhere in the type once its names are followed:
  `io::Result<T>`, `fmt::Result`, `Option<Result<T>>` and `CostContext<Result<T, E>>` all do.
- It is said **not** to return one only when every name in it is known not to be one: a primitive,
  `()`, a short list from the standard library (`Option`, `Vec`, `String`, `Box`, `HashMap`, …),
  or a struct, enum or union the repository defines under that name. Names are matched, not
  paths: `use dep::Response` beside a `struct Response` elsewhere in the repository reads as that
  struct. One capital letter that no rename or alias explains reads as a type parameter of the
  enclosing `impl` and settles nothing; a longer parameter name of an enclosing `impl` (`Ctx`) is
  matched like any other name, and meets a `struct Ctx` if the repository has one.
- Anything else is not settled, and the reason says what could not be read: a type from a
  dependency, `Self`, a type parameter, a trait of the repository after `impl`, aliases that
  disagree, a signature that did not end. Such a call is not asked about either.

A reason that says a function "does not return a Result" names the definition it read and quotes
its return type. The callee is still found by its name: `File::open(p)?` in a repository that
defines one `fn open(&self) -> bool` is held with "the one function named open in this repository
(…) returns `bool`" — true of that function, and the call is not asked about. A call that cannot
reach that one definition is held as having no definition here: a method call (`x.name(…)`) to a
function that takes no `self`, or a number of arguments the function does not take — counted only
where no closure, comparison, turbofish or character literal is among the arguments. So `"".to_string()` does not
meet a repository's `fn to_string(accessor, value)`. These checks can only rule a definition out,
never show that a call reaches it: a method call with the right number of arguments still meets the
one definition of its name, whatever type it is made on — grovedb's `x.value.map_err(…)`, a method
of the standard library's `Result`, meets `CostContext::map_err`. Calls whose callee is not defined
here at all are the next part of `#45`.

#### Functions this repository does not define

A callee with no `fn` here — every call into the standard library or into a dependency — used to
end the reading. One table now answers for some of them, and it is the only thing this tool claims
about code it cannot read (ADR 0011):

| written as | functions |
|---|---|
| `fs::…` | `canonicalize`, `copy`, `create_dir`, `create_dir_all`, `exists`, `hard_link`, `metadata`, `read`, `read_dir`, `read_link`, `read_to_string`, `remove_dir`, `remove_dir_all`, `remove_file`, `rename`, `set_permissions`, `set_permissions_nofollow`, `set_times`, `set_times_nofollow`, `soft_link`, `symlink_metadata`, `write` |
| `File::…` | `create`, `create_buffered`, `create_new`, `lock`, `lock_shared`, `open`, `open_buffered`, `set_len`, `set_modified`, `set_permissions`, `set_times`, `sync_all`, `sync_data`, `try_clone`, `try_lock`, `try_lock_shared`, `unlock` |
| `env::…` | `current_dir`, `current_exe`, `join_paths`, `set_current_dir` |
| `io::…` | `pipe`, `try_set_output_capture` |
| `serde_json::…` | `from_reader`, `from_slice`, `from_str`, `from_value`, `to_raw_value`, `to_string`, `to_string_pretty`, `to_value`, `to_vec`, `to_vec_pretty`, `to_writer`, `to_writer_pretty` |
| only written in full | `std::env::var`, `std::io::copy`, `std::io::read_to_string`, `fs::File::metadata` |

How it is read:

- **The path a call writes is what is matched**, by its ending: a row `fs::rename` matches
  `fs::rename(a, b)` and `std::fs::rename(a, b)`. The four rows in the last line are matched only
  at that length, because the shorter ending means something else somewhere:
  `gix-path`'s `env::var` returns an `Option`, tokio's `io::read_to_string` and futures-util's
  `io::copy` return a future, and a crate's `File::metadata` returns an `Option<&Metadata>`.
- **A method call is not matched, whatever the table holds.** Rust resolves a method by the type of
  its receiver, which this does not read; `Metadata::file_type` returns a `FileType` and
  `DirEntry::file_type` an `io::Result<FileType>`, and both are written `entry.file_type()`. This
  is why pybun#428's fixed call is still held.
- **`crate::`, `self::` and `super::` say the callee is in this repository**, so the table does not
  answer for them.
- **A path written `std::` is answered by the table before this repository's definitions are read**
  — the call said which library it means. Any other path is answered only when this repository
  defines no `fn` of that name, so a repository with its own `fs::read_to_string` keeps its own.
  Only the first word of a path is looked at for this repository: a module of its own written
  `util::fs::rename(a, b)`, with no `fn rename` anywhere here, is answered by the row `fs::rename`.
- **The ending is all that is matched**, so another library's function of the same path is taken
  for the one in the table: `tokio::fs::read_to_string(p)` matches `fs::read_to_string`. The scan
  read tokio's too: it is an `async fn` declared to return an `io::Result`, which the call gives
  once awaited.
- A few rows are functions the standard library has not stabilised — `File::create_buffered`,
  `File::open_buffered`, `fs::set_permissions_nofollow`, `fs::set_times`, `fs::set_times_nofollow`,
  `io::try_set_output_capture` — and match only code built for nightly. They are there because the
  scan read them in the standard library's source, not because a repository measured here calls
  them.
- The table says what a function returns, not how many arguments it takes: a call that passes the
  wrong number is not caught here.
- A repository that declares `mod std;` of its own would make `std::` mean something else; nothing
  here checks for that. A rename (`use std::fs as stdfs;`) is not followed, so `stdfs::read(p)`
  stays held.

Every row is there because `bench/outside-results-check.ts` read the standard library's own source
and a machine's cargo registry and found no definition a call could reach that way returning
anything but a `Result`. That finding is "no counterexample in those 1,798 crates", not "no
counterexample anywhere". The rows come from those sources, not from the repositories this tool is
measured on.

#### Which definition a call reaches

A name this repository defines more than once used to end the reading there. Three things narrow
it, in this order, and what none of them settles is held as before. A name defined **once** is
unchanged: the path is not read at all, and that one definition is the callee as it always was.

- **The path the call writes.** `SyncState::load_strict(root)` keeps the definitions inside an
  `impl SyncState`, `impl Trait for SyncState` or `trait SyncState`; `Self::path(root)` keeps those
  inside the `impl` the call itself is written in; `install::add_package(args)` keeps those written
  in `install.rs` or `install/mod.rs` **inside the crate the call is in** — a workspace has a
  `util.rs` in every crate. `crate::`, `super::` and `self::` are passed over. The item a
  definition sits in is read from indentation — the first line above it that is less indented and
  begins an item — so a `fn` written above it inside the same `impl` is not its header. A header
  spread over several lines (`impl<T>` / `Trait for` / `Q` / `{`) cannot be read, and then the call
  is held: nothing further may settle it, or the form below would pick the very definition the path
  was about to rule out.
- **The form of the call.** A method call reaches no definition that takes no `self`, and none that
  takes a different number of arguments (counted as above). When that leaves one, it is the one.
  Past 20 definitions after the path, their signatures are not read and the call is held.
- **Definitions that are versions of one thing.** A trait's method — the declaration
  `trait X { fn name(…); }` in *this* repository and the implementations of that same trait — or a
  function written once per platform (`#[cfg(unix)]` and `#[cfg(not(unix))]`, at the top of one
  file). Which version runs is not settled, so all of them must return a `Result`; one that does
  not holds the call, and the reason names it. The declaration must be here: two
  `impl TryFrom<A> for B` blocks do not make `try_from` this repository's method.

**A path that matches none of the definitions is held, never reported as "no definition here".** A
type brought in under another name (`use moltis_channels::Error as ChannelError`) and a function
re-exported from another file (`model::values_to_chat_messages`, written in `model/convert.rs`) are
both real definitions this does not follow; saying they are not defined would be false. For the
same reason, a name whose only definitions are in files declared `#[cfg(test)] mod x;` is held with
that as its reason. A module declared `#[cfg(test)]` in one file and plainly in another — a crate
whose `main.rs` declares it for tests and whose `lib.rs` declares it outright — is code.

When several versions are read together, the definition the report names — and the one the order
inside a function compares against (*The order inside a function*) — is the trait's declaration, or
the first of the platform versions. A pull request that changes an implementation rather than the
declaration is therefore not sorted first by that order.

## Reading the output

```
### Worth checking

#### src/integrity.rs:210-220 · read_baseline — `crate::atomic_file::read_to_string_capped(&path, MAX)`
- **Requirement R1**: "If reading an existing integrity baseline fails, …"
- **Assumed**: Execution reaches the call … There, `…` returns an error. Every other operation …
- **Jev, on whether the requirement requires it here**: applies (0.96)
- **Jev, on what the function returns**: returns_success (1.00)
- **Why it is listed**: … Both are Jev's readings and neither checks the other.
```

Each requirement's section names its form and, after the counts, how the calls read came out. Every
call read is in exactly one of the first four sections; the label of the function's answer
(`Jev, on what the function returns` / `Jev, on whether the function still makes the call`, and
`when that call fails` / `in a case the requirement forbids it` in the list of calls read) is the
form's.

| section | what it holds |
|---|---|
| **Worth checking** | the requirement read as applying, and the function's answer against it, both over the bar |
| **Read as holding** | the requirement read as applying, and the function's answer keeping it, both over the bar. **Two readings that agree, and nothing more**: where what decides it is in a body that was not sent, they can agree and be wrong — measured below, a decision moved into a helper read as holding with 0.92–0.96 six times of six, and a check moved into a helper the same |
| **Not settled** | a call read, and not settled either way: the mapping `unknown`, or under the bar, or unanswered; or the requirement applying and the function's answer `cannot_determine`, under the bar, or unanswered — each says which |
| **Read, but not required of by the requirement** | `does_not_apply` over the bar |
| **Not checked** | the form's condition held the call (no definition here, no `Result`, not settled whether there is one — the reason says what could not be read —, no word of the requirement, a callee read on its own), the body did not fit, the call could not be located, or the budget was spent |
| **Notes** | caps that dropped candidates, files that could not be read, and what the change did not reach |

None of the four is a requirement verdict: each is what two answers about one call came to. A
listed call rests on two Jev readings that do not check each other. Everything either of them used
is printed so it can be thrown out. `--json` carries the form, every mapping, every reading with its
`outcome` (`violates` / `satisfies` / `unknown` / `aside`), and every option's probability.

## Exit codes

A call worth checking does not change the exit code: it is a candidate, not a verdict. A repository
that wants one to fail CI sets `policy.fail_on: [finding]` in `.jev-intent-review.yml`, and the run
exits 1 when any call is worth checking (`violation`, the value 0.1 knew, is read as `finding` and
the notes say so). Configuration, intent, repository and provider failures exit 10, 11, 13 and 12.
**Exit 0 does not establish that the requirement holds.**

After the calls, every change the pull request made is asked about once — is it asked for by any
requirement? — and listed under *Changes no requirement asked for* when Jev is sure it is not.
`--skip-change-check` leaves that out. With `--json`, `sent.requests` is what was sent and
`sent.answered` what Jev answered, in the same unit (an observation request carries two questions).

"Nothing listed" means no call met the conditions for being listed — both answers over the bar and
disagreeing. It covers calls whose mapping or whose behaviour came back undetermined, below the
bar, or unanswered, as well as calls that agreed. What was not reached is under *Not checked*, and
the enumeration's own caps are counted in the notes.

## What has been measured

Everything below is about `failure_propagation` except two parts: the one measurement of
`check_before_action`, and, last, how Jev reads which form a sentence has.

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
- **No question reached a defect placed outside the diff.** The unchanged caller in moltis was held
  before any question: its return type is `ChannelResult<String>`, a `Result` alias the check did
  not recognise then, and the report said it did not return a `Result` (aliases are read since
  `#45`'s first part — *Reading whole signatures*). The other function is outside
  what v0.1 enumerates by construction; the table says "cap or structure" because the rule fixed
  beforehand gives that label whenever a cap fired in the run. Among the three candidates whose
  fixed call could be asked, the call from the unchanged caller to the changed function reached no
  question in any: held for the alias here, held for a callee signature wrapped past four lines in
  Kontor#385, and dropped by the forty-call cap of its function in grovedb#500
  (`bench/acceptance/precheck-shipped.json`). In grovedb#500 the unchanged caller itself was
  reached: three other calls in it were asked about in every run, and read as not governed by the
  requirement. In moltis#1064 and Kontor#385 every call in it was held before a question.
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
  that call was held before any question: its caller returns `ChannelResult<String>`, an alias.
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
  grovedb#500. Still outside: whatsapp-rust#759's, which the cap of calls per function drops before
  anything is decided; quebec#136's, whose change is inside a generic function the tool reports as
  touching no Rust function (both are in their file once, so they are not written differently);
  pybun#428's `entry.file_type()` and agentflare#229's four `flush()` and `sync_all()`, method calls
  the tool does not resolve outside the repository (*Functions this repository does not define*).
  Two more fixed calls are not asked: cce-rust#168's `KnowledgeSyncState::load_strict(root)` can be
  asked about and is outside the budget, and agentflare#229's `std::fs::read_to_string(&profile)` is
  held because the function it is in, `run`, returns `()` — true of that function.
- **The unchanged callers' calls**: moltis#1064's and grovedb#501's can be asked about and are
  inside the budget. **Kontor#385's can be asked about and is outside the budget of 20**, so it is
  still not asked; how the budget is spent is `#38`'s. grovedb#500's is past its function's cap of
  40 calls, as before.
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
the definition outside tests, because definitions in such files are not counted (see *Whether a
function returns a `Result`*) — the call is itself in that file, and reaches the one there. Both
return `()`, so what the reason says about the return type is still true.

Reproducible from what is committed, without sending anything:

```sh
node bench/acceptance/replay.ts bench/logs/acceptance-v2.json
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

### The one measurement of `check_before_action`

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
| hidden — the check in a helper whose body does nothing | session | holding 3/3 (applies 0.98, does_not_reach 0.96–0.97) — **wrong**, as the table said no confident reading would be right | the lookup not required of 3/3; the helper's call held, a callee the run reads on its own |
| caller — the check in `login`, which calls it | refused through `login`, session called directly | worth checking 3/3 — `open_session` read alone does make the call | in `login`, not required of 3/3; in `open_session`, the lookup not settled 3/3 (the mapping under the bar: `does_not_apply` 0.53 and 0.56, `unknown` 0.50); `login`'s call into `open_session` held |

So on code written for it the form separates the defect from the shipped code and a rewrite, and
misses a check whose body it is not shown, exactly as the failure form does. The first run of this
case (`-v0.json`) also listed, in every version, `login`'s call into `open_session` — from `login`,
the call is made whatever `open_session` checks inside — which is why a call into a function the
run reads on its own is now held and left to be asked about there.

How far the words reach on real code, with no request (`bench/forms/reach/`): a
check-before-action sentence written for the changed function of each acceptance case put the
guarded call inside the budget on both — grovedb#500's `rewrite_heights` 10th of 17 askable calls
among 215, moltis#1064's `generate_title` 18th of 20 among 170 (two left over). Whether Jev reads
those right is not measured.

### The order inside a function

The calls into a function the change touched go first in their function (see *What it asks*). What
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
  callee's definition found by `fn <name>` and held when that search is cut — which holds one call
  today's check asks about, `verify(...)` in grovedb#500's `finalize`), every
  defect inside the diff stays inside the budget — omamori's two targets, moltis#1064's and
  grovedb#500's in every version, Kontor#385's — and without the order Kontor#385's falls out.
  Kontor#385's unchanged caller is outside the budget either way.

The two calls the order swaps in omamori `#468`'s `run_override_disable` — the only swap there when
the order was chosen — were asked of Jev three times on every branch under both requirements
(`bench/logs/order-first-pass-jev-v1.json`, 120 questions): neither was listed in any run. The
swaps in the other four functions have not been asked of Jev.

### Reading whole signatures

Whether a function returns a `Result` is read from its whole signature and the repository's aliases
(see *What it asks*). It was built on the walls `#45` names — moltis#1064, Kontor#385 and
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

Which definition a call reaches, when its name has several (see *Which definition a call reaches*).
It was built on two pull requests whose fix was held by this — cce-rust#168, where
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
- 349 calls that are held before and after are held for a different reason. 133 of them are held
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
- Of 20 calls still held, sampled five per reason and labelled the same way: 9 reach something
  outside the repository and 6 reach a definition here that returns no `Result` — held rightly; 4
  are held as "not settled" where the labels say "not a `Result`", which holds them either way; and
  one — Kontor#385's `simulate(0, tx)` — reaches a definition that does return one, in a file
  declared `#[cfg(test)] mod x;`. That last one is what this deliberately stops asking about.

### Functions outside the repository

What the table of *Functions this repository does not define* opens. It was built from the standard
library's own source and a machine's cargo registry, not from the repositories below, and the two
pull requests it was aimed at are cce-rust#168's neighbours — instruckt-tauri#9, whose fixed call is
`serde_json::to_string_pretty`, and pybun#428, whose fixed call it deliberately does not open.
Measured without a request, before and after, on the same 15 runs as the two parts before it
(`bench/logs/outside-results-v1.json`, `node bench/outside-results.ts`; the scan behind the table is
`bench/logs/outside-results-check-v1.json`, `node bench/outside-results-check.ts`):

- **The wall, counted once per call** rather than once per branch of the same repository: 973 calls
  were held with "no definition in this repository". 178 of them write a path; 733 are method
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
  `entry.file_type()` is still held, as a method call the table does not answer for.
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

### How Jev reads the form of a sentence

Whether Jev can tell a sentence's form from its words alone was measured before anyone lets it
choose one (ADR 0008; `bench/forms/choice/`, log `bench/logs/form-choice-v1.json`; 216 requests,
every one to Cloudflare). Every requirement sentence this repository holds in a spec, fixture or
golden file — `run.ts verify` enumerates them and a test fails when one is not in the set — the
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

The owner's ruling on these numbers (2026-09-22, ADR 0008): Jev chooses the form of a requirement
read from an issue, a pull request, `--intent` or `--intent-file`; a spec's `form` stays its
author's. The run does so now ([Writing a requirement](#writing-a-requirement)): the question it
sends is the one above, held to the log's hash by `test/forms.test.ts`, and `metadata.questionsHash`
covers it from that change on — the records above carry the hash of their day, and a spec run's
hash moved with it though what it sends did not.

## Only Jev

The transport refuses any model but Jev's name on the host it sends to — `typesafe/jev` on
Cloudflare and for `JEV_API_URL`, `jev-latest` on TypeSafe, `typesafe-ai/jev` on Vercel AI Gateway —
before a request is built, so nothing else can be reached from this tool. `test/only-jev.test.ts`
checks it at the transport on every host, and over a whole run against a capturing endpoint and
against a stand-in for each named host.

## Record of the experiments

以下は v0.1 に至るまでの作業記録（日本語）。

---

### 実験用 CLI（2026-09-21）

`docs/selection-materials.md` の続き。もう一枚の選択成績表ではなく、**コードを渡すと根拠付きの
結果が返るコマンド**。

```sh
jev-intent-review --experimental-local-check --base <rev> --head <rev> --intent-spec <file>
jev-intent-review --experimental-local-check --experimental-candidates-only ...   # 何も問い合わせない
```

**利用者は対象ファイル・関数・call ID・期待回答を入力しない。** 製品コードに評価用の名前も
入っていない。

### 経路

候補を出すものが **2 つ**あり、性質が違う。

1. **差分**——変更行を含む関数と、その 1 ホップ先の呼び出し元（`src/plan/from-diff.ts`）。
   これは**探す手掛かり**であって、要件が当てはまるという主張ではない。
2. **要件の語**——既存の字句探索でファイルを開き、計画側のモデルがその中の呼び出しを
   **id で**選び、各選択に「原文のどの節か」を書く（`src/plan/planner.ts`）。

**どちらも他方を却下しない。** モデルが選ばなかったことを理由に差分由来の候補は落とさない。
逆も同じ。

3. どちらが届いた関数も、**中を機械的に広げる**——欠陥は同じ本体の別の呼び出しであることが
   多い（実測: 正しい関数に 3/3、正しい呼び出しに 1/3）
4. **問いを置ける候補だけ判定する**（`src/plan/applicability.ts`）。呼び先の**定義を引いて**
   `Result` を返すと確認できたものだけ
5. **予算は要件ごとに 1 回**、関数を 1 件ずつ回って配る（`roundRobin`）。ファイルごとに
   配っていたのを直した——3 ファイル開いた要件は予算の 3 倍を使えていた

**局所の観測は要件の判定ではない。** **変更行はそこで作業したことを言うだけ**で、要件が
当てはまるとは言わない。観測が要件にかかるかどうかは**対応付け**が決める（下の節）。
**要件全体の判定（VERIFIED）は出さない。指摘が出ても終了コードは 0 のまま**——ただし設定・リポジトリ・エンドポイントの失敗は 0 以外で終わる。
出るのは「**要確認の欠陥候補**」——根拠を全部添えて、読んだ人が否定できる形で。

### 実機の結果（omamori #468 / PR #476）

**base は 5 枝すべて `52a58fa`**——PR #476 が squash された先の親。正例から変異版への差分を
渡すと、変異した場所を探索器に教えることになるので、base を揃える。

変異・挙動不変の 4 パッチは PR #476 の head `e58c04f` にそのまま当たり、**期待挙動を
probe で取り直した**（`bench/fixtures/omamori-468/probe_*.rs`、ディレクトリを植えて観測）。

| 枝 | `read_baseline` の実挙動 | `raw_override_disables` の実挙動 | CLI の観測（同順） |
|---|---|---|---|
| correct | `Err(… is a directory …)` | `Err(…)` | returns_error 0.99 / returns_error 1.00 |
| m-read-baseline | **`Ok(None)`** | `Err(…)` | **returns_success 1.00** / returns_error 1.00 |
| v-read-baseline | `Err(…)` | `Err(…)` | returns_error 0.98 / returns_error 1.00 |
| m-raw-override | `Err(…)` | **`Ok(false)`** | returns_error 0.99 / **returns_success 0.99** |
| v-raw-override | `Err(…)` | `Err(…)` | returns_error 0.99 / returns_error 0.99 |

**10 マスすべて実挙動と一致。** 変異版はそれぞれ自分の対象だけを裏返し、挙動不変版は正例と
同じ。記録は `bench/logs/diff-reach-v1.json`。

到達のほうは**通信なし**で先に確かめられる（`--candidates-only`）。5 枝とも
関数 23（変更）+ 20（呼び出し元）、問いを置けるもの 37、予算 20 に**両方の対象呼び出しが
入る**。呼び出しの総数だけは枝で違う（correct・m-read-baseline・m-raw-override が 739、
v-read-baseline が 738、v-raw-override が 740）——挙動不変版は書き方を変えているので当然で、
ここを「5 枝とも同じ」と書いていたのは誤り。

| 枝 | 予算内に `read_baseline` | 予算内に `raw_override_disables` |
|---|---|---|
| 5 枝すべて | はい | はい |

#### 正例でも `returns_success` になるマスが 1 つある

`src/integrity.rs · generate_baseline` は **5 枝すべてで returns_success（0.94–0.97）**。
実際のコードが

```rust
if let Ok(content) = crate::atomic_file::read_to_string_capped(&path, MAX_TRACKED_FILE_BYTES) {
```

で、読めなかった hook ファイルを飛ばして続ける。**観測としては、関数が何を返すかについて
正しい。**

**ただしこれを「合法だから指摘しなくてよい」と採点してはいけない。** 実装がそう動くことと、
要件がそれを許すことは別の問いで、後者はここでは答えていない。原文から確定できなければ
`unknown` で残す。

### 途中で見つけて直したもの

**① モデルへ送る一覧が秘匿処理を通っていなかった。** `listingFor` は数百行のソース行を
そのまま出していた。定数に書かれた鍵がちょうどそこに来る。証拠パケットと同じ処理を通す。

**② 予算がファイルごとだった。** 「要件あたり 5 件」が 3 ファイルで 15 件になっていた。
要件全体で 1 回だけ配る。ついでに id をファイル込みにした（`src/config.rs:call-7`）——
素の `call-1` は**別ファイル同士が同じ id** になり、片方の選択がもう片方の一覧に解決する。

**③ 本体が切れていても答えを採っていた。** `evidence.cut.own` が真なら、半分だけの本体
についての答えになる。理由付きで保留する（実機で 1 件発火: `verify_chain`）。

**④ `#[cfg(all(test, unix))]` がテスト領域として認識されていなかった。**
`/^\s*#\[cfg\(test\)\]/` しか見ておらず、**プラットフォーム条件が付いた test モジュールが
製品コードとして読まれていた**。omamori では 1 箇所、しかも PR #476 が追加したファイル。
実機で気づいた——`a_fifo_is_refused_rather_than_waited_on` が候補に出ていた。
これは `enumerate` だけでなく `realDefinitions`（証拠の構築）と適用検査も使う関数なので、
通常のレビュー経路にも効く。

**最初の直し方は行き過ぎていた。** 「行のどこかに `test` があれば除外」にしたので、
`#[cfg(any(test, feature = "production"))]`——その feature が有効なら**通常ビルドで使われる
コード**——まで消していた。今は**テスト専用と確認できる式だけ**除外する:
`all(...)` はどれか 1 つがテスト専用なら全体もそう、`any(...)` は全部がそうでなければ違う、
`not(...)` と判別できない式は**残す**。消しすぎるほうが悪い——**無いものは誰も報告しない**。

**⑦ 質問文が秘匿処理を通っていなかった。** 1 回のリクエストは**パケットと質問の両方**だが、
清めていたのはパケットだけ。`conditionFor` は呼び出し式をそのまま質問文に埋めるので、
引数に機密らしい文字列があると**何も触らない欄から出ていく**。`locateCall` が生の式で
照合していた間は保留されて表に出なかっただけで、それ自体が別の欠陥だった。
条件も照合も同じ秘匿済みの式を使う。**レポートの印字も同じ**——レポートは配布物なので。

**⑤ 予算に入った呼び出しだけがレポートに出ていなかった。** `--candidates-only`
は「どれが予算に入るか」を答えるためにあるのに、**選ばれたものだけが印字されない**形に
なっていた。最初の実機確認で「対象に届いていない」と読み違えた——届いていた。

**⑥ 計画が答えなかったのか、該当なしと答えたのか区別できなかった。** `modelPlanner` の
`catch` が `{picks: []}` を返していた。今は理由を持って返す。**この修正が最初に出した答えが
これ**——

```
the planner did not answer about src/audit/mod.rs (… answered 429: … you have used up your
daily free allocation of 10,000 neurons …), so no call there carries a clause
```

### Jev 以外に何も送らない（2026-09-21）

**この道具は Jev に小さな型付きの問いを聞くもの**なのに、一般の instruct モデル（llama-3.3-70b）
を 3 箇所で使っていた。要件のコンパイル（元から）、計画（#26 で私が）、対応付け（#28 で私が）。
どれもその場では妥当に見え、**どれも宣言されていなかった**。

| 直し | 中身 |
|---|---|
| 送信境界で拒否 | `CloudflareClient.post` が `typesafe/jev` 以外を**組み立てる前に**拒む。CLI も bench も同じ経路を通る。件数にもバイト数にも数えない |
| 要件のコンパイル | モデルに書かせない。`--intent-spec` か、**コードで読める受け入れ条件の箇条書き**。それ以外の散文は理由と使える 2 つの形を案内して止まる |
| 計画 | **廃止**。候補は差分・参照探索・適用検査・予算配分だけで作る（要件の語でファイルを開く経路も消えた） |
| 対応付け | **Jev の 3 択**（`applies` / `does_not_apply` / `unknown`）。確率分布を全部保存し、採用規則は実測前に固定（`applies` かつ 0.6 以上） |
| 引用と説明 | **別モデルを残さない**。引用は入力原文そのもの、説明は原文・コード位置・仮定・2 つの答えから定型的に組み立てる。**モデルが書いたようには表示しない** |
| CI | 実 API を使わず、**送信された全ボディのモデル名**を読む。実験経路を通しで走らせて全件 Jev を確認 |

**消えた欠陥が 1 つある。** Jev の回答に `callId` は無いので、「別の呼び出しへの回答が結合する」
（#29）という形が**検査されるのではなく存在しなくなった**。Jev は送った state について、
送った問いに答える。

**引用を原文に照合する検査も要らなくなった。** モデルが断片を選ぶからこそ必要だった検査で、
引用が要件そのものなら照合するものが無い。

### 対応付けを Jev に聞いた最初の実測（2026-09-21、正例、PR #476 の原文）

```
asked 19, mapped 19, governed 3, findings 0
```

**既知の 2 対象は、どちらも `does_not_apply`**（0.51 / 0.63）。Jev が `applies` と読んだのは
`reject_non_regular`（0.90 / 0.77）——**拒否そのもの**を行う呼び出し。原文は
「a path omamori reads **is now refused by name**」と書いていて、拒否を受け取った側が何を返すかは
書いていない。**関門は NOT READY、残り 4 枝は送っていない。**

**この結果は変更しない。** 下は**別の評価入力**での測定で、原文の忠実な言い換えではないし、
原文からの推論が成功したとも主張しない。

### 失敗時の扱いを明示した要件での実測（2026-09-21）

確かめたのは「**利用者が失敗時の扱いを明示した要件を、この CLI が検査できるか**」。

入力（`bench/fixtures/omamori-468/stated-failure-handling.spec.json`、**関数名・ヘルパ名・
call ID・期待回答は書いていない**）:

> **R1** If reading an existing integrity baseline fails, the baseline-loading operation must
> return an error to its caller. It must not return a successful result saying that no baseline
> exists.
>
> **R2** If reading an existing configuration file fails while checking whether a rule override
> disables a rule, that check must return an error to its caller. It must not return a successful
> result saying that the rule is not disabled.

**条件と期待結果は最初の 1 リクエストより前に保存した**（ツール commit `ee35665`、base は 5 枝
とも `52a58fa`、予算 20、閾値 0.6、モデルは `typesafe/jev` のみ）。通信なしの候補確認で、
**両対象が 5 枝 × 2 要件すべてで予算内**にあることも先に確認した。

採点の単位は**要件 ID・ファイル・関数・呼び出し式**。関数名だけでは判定しない。

#### 結果: 10 マスすべて一致

| 枝 | R1 `read_baseline` | R2 `raw_override_disables` |
|---|---|---|
| correct | 指摘なし（applies 0.97 / returns_error 1.00） | 指摘なし（applies 1.00 / returns_error 1.00） |
| m-read-baseline | **指摘あり**（applies 0.96 / **returns_success 1.00**） | 指摘なし（applies 1.00 / returns_error 1.00） |
| v-read-baseline | 指摘なし（applies 0.98 / returns_error 1.00） | 指摘なし（applies 1.00 / returns_error 1.00） |
| m-raw-override | 指摘なし（applies 0.98 / returns_error 1.00） | **指摘あり**（applies 1.00 / **returns_success 0.99**） |
| v-raw-override | 指摘なし（applies 0.98 / returns_error 1.00） | 指摘なし（applies 1.00 / returns_error 1.00） |

**変異版はそれぞれ自分の対象にだけ指摘が出て、もう一方は静か。** 正例と挙動不変版は両方とも
静か。**採点対象外の指摘は 0 件**（他の呼び出しには 1 件も立たなかった）。

各 run は **76 要求**（2 要件 × 19 呼び出し × 2 問）、5 枝で **380**。
記録は `bench/logs/stated-requirements-v1.json`——入力 spec、実行前に固定した条件、
**5 枝 × 2 要件の全 38 呼び出しについて対応付けと観測（全選択肢の確率つき）**、全 finding、
種類別の未確認件数、note。**採点はこのファイルだけで再現できる**:

```sh
node bench/replay-scoring.ts bench/logs/stated-requirements-v1.json
```

証拠パケット（送った関数本体）は保存していない——固定コミットの git オブジェクトから
再構成できるため。秘匿処理は保存物にもそのまま効いている。

#### 関門で直したもの

正例の関門が **`requirements[0]` だけを読んでいた**。要件が 2 つある spec では R2 の対象が
R1 の答えで採点される。要件 ID ごとに照合する形に直した。

もう 1 つ、**正例に対象の指摘があっても、対応付けが usable なら READY になっていた**。
正例は他の 4 枝を比べる基準なので、そこで指摘が立っていれば表はもう壊れている。
**両方（使える対応付け・指摘なし）**を要求する形にし、手書きのログで回帰テストにした。

#### 言えること

**失敗時の扱いを明示した要件について、場所を利用者が指定せずに、既知の欠陥候補まで到達した。**

これは既知の 2 対象についての採点で、1 リポジトリ・2 要件・各枝 1 回。
`bench/logs/jev-only-v1.json` の原文による測定は NOT READY のまま残してある——
**原文の言い換えが成功したのではなく、別の入力で成立した**ということ。

### 列挙そのものが取りこぼしている量

上限を note に出すようにしたら、**1 関数 40 件の上限で 261 件の呼び出しが落ちていた**ことが
分かった（7 ファイル、`src/integrity.rs` だけで 80 件）。加えて、変更された関数への参照
**84 件**が「この経路が読む関数の中に無い」（`use` 行・`impl` のメソッド・マクロ本体）。
対象 2 件には届いているが、**列挙は完全ではない**。数えられていなかった間は、
短い一覧と短いファイルの区別が付かなかった。

### 節（clause）はモデルの文である

`clause` は**モデルの散文がそのまま Markdown に入る唯一の欄**だった。schema には
`maxLength: 300` があるが、`readModelJson` は `JSON.parse` するだけで**強制していない**。
改行 1 つで箇条書きが崩れるし、バッククォートでコードスパンを開ける。

そして**この経路が違反を出さないことを製品側で保証しているのは、`describe()` に判定の欄が
無いことだけ**——`clause` は判定の文がそのまま収まる欄だった。

意味で弾くことはできない（節は原文を引用するので「silently treated as…」のような語が正当に
入る）。なので**封じ込める**: 1 行・300 字・コードスパンなし、そして
`The plan said this call checks: "…"` と**引用して誰の文かを示す**。

### 測っていないこと

**節（clause）は今回 1 件も付かなかった。理由は 2 つあり、片方は確定している。**

**確定しているほう: 計画に対象のファイルを見せていない。** 計画へ渡すファイルは今も
`filesFor` だけで決めていて、渡したのは `src/audit/mod.rs` と `src/actions.rs`。
観測できた対象がある `src/config.rs` と `src/integrity.rs` は**渡していない**。
したがって**枠が戻って再実行するだけでは、対象の節は付かない**。

**もう片方: 5 回とも `picks: []` で、理由が記録されていない**（⑥ の修正より前）。理由を出す
ようにして再実行したら 429——その日の無料枠切れ。断ったのか落ちたのかは**分からない**。

判定側の要求は全部通っている（各実行 19 観測）ので、上の表は影響を受けない。
なお、散文の節が 1 つ付いたとしても、それ自体は**要件への対応が正しい証拠にはならない**。

したがって**この段階で示せたのは「欠陥箇所の挙動を自動で観測できる」ところまで**。
観測を根拠付きの指摘へ結ぶには、節が付くことを測る必要がある。

計画に聞くのは**要件の語が開いたファイルだけ**で、変更されたファイルには聞いていない
（要件との対応付けと候補列挙を分けるため）。今回そこは重ならなかった——原文は症状
（FIFO・ディレクトリ・symlink）を名指し、機構は共有の読み取りヘルパで、語では届かない。

**要件が N 件あると、差分由来の同じ呼び出しを N 回判定する。** 問い自体は要件を含まないが、
証拠パケットには要件が入っているので、答えを要件をまたいで使い回してよいかは**測っていない**。
問いを置けるかどうかの判定（`applicabilityOf`）は commit だけで決まるので 1 回にした。
残りを直すなら、差分由来の集合を 1 回だけ判定して各要件のレポートに付ける形になる。
今回の実測は要件 1 件なので、**この形はデータに出ていない**。

`--intent`（自由文）だと要件を書くモデルが毎回別の文に直すので、**開くファイルが run ごとに
変わる**。比較するときは `--intent-spec` で固定する。

### 終了条件に対して

| 条件 | 状態 |
|---|---|
| CLI から両ケースの変異した呼び出しへ届く | **満たす**（5 枝すべて、通信なしでも確認） |
| 正例・変異版・挙動不変版を区別できる | **満たす**（10 マス全部が実挙動と一致） |
| 対応付けから根拠付きの欠陥候補を返す | **通信なしで満たす**。実機は対応付けのモデルが 429 で未達 |
| 正例・挙動不変版に誤った違反を出さない | **検査していない**（下記） |
| 未対応・適用未確定・予算外が理由付きで残る | **満たす**（正例で 720 件、種類別に集計） |
| 個別の関数名・正解ラベルが製品側に無い | **満たす**（`src/plan/` と `src/review/local-check-run.ts` に固有名詞は無い） |

3 行目を「満たす——この経路は違反を報告しない」と書いていたが、**それは検査ではない**。
前件が構造上偽にならないので、何を測っても満たす。実データで誤検知に一番近いのは
`generate_baseline` の 5 枝 `returns_success` で、上に書いたとおり**観測としては正しい**。
誤った違反を出さないことを本当に測れるのは、観測が指摘に変わってから。
