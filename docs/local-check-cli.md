# The local check

This is the reference for the run: what to give it, how to read what comes back and what the exit
code means. What has been measured, and the working record of how v0.1 got here, are in
[measurements](measurements.md). Since [ADR 0007](adr/0007-the-run-is-the-local-check.md) the local
check *is* the run — `jev-intent-review` with no flag does what `--experimental-local-check` did; the
flag is accepted, the report and the exit code are the same without it, and one line on stderr says
so. The README says what the tool is for; this says exactly what it does.

## Writing a requirement

One checkable sentence per requirement. No file name, no function name, no expected answer. What
the sentence has to say depends on its **form** — what the check asks of each call
([ADR 0006](adr/0006-question-forms-as-data.md)):

| `form` | the sentence says | example |
|---|---|---|
| `failure_propagation` (the default) | what must happen when something fails | "If reading an existing integrity baseline fails, the baseline-loading operation must return an error to its caller. It must not return a successful result saying that no baseline exists." |
| `check_before_action` (experimental) | which action must not happen unless a check passes, naming the action by a word its call carries | "A disabled API key must never create a session." — `create_session(…)` is asked about; `audit(…)` is not |
| `failure_handling` (experimental, named in the spec only) | what must happen when something fails — the failure may be returned, logged or recorded, and must not be turned silently into a success. A call is worth checking when, under its failure, the function goes on as if it had succeeded and leaves no trace of the failure — an empty or absent value a caller cannot tell from a success, with nothing logged or recorded, counts as no trace | "A failure to write an entry to the audit log must be returned or logged; it must not be dropped." — asked in any function whose callee returns a `Result`, one that returns `()` included ([ADR 0023](adr/0023-a-failure-may-be-handled-not-silenced.md)) |

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

A spec names the form; a value outside the three stops the run. A requirement read from an issue, a
pull request, `--intent` or `--intent-file` names none, so before its calls the run asks Jev once,
over the sentence alone, which form it says ([ADR 0008](adr/0008-who-chooses-a-requirements-form.md);
measured first on every requirement sentence this repository holds in a spec, fixture or golden
file — [the measurement](measurements.md#how-jev-reads-the-form-of-a-sentence)): the form Jev says at the bar of 0.6,
`failure_propagation` or `check_before_action` — `failure_handling` is not offered, and an answer naming it reads as the default; when Jev reads `neither`, is under the bar, or
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
either. The report says why for each call it sets aside.

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
them, one hop out, and every call inside those functions — and, last and under a budget of their
own, the other callers of the repository functions the changed code calls (*The siblings of a
change* below). Which of those calls can be asked about, and what is asked, is the requirement's
form. Each askable call, up to the budgets below — 20 per requirement in the functions the change
touched, and 10 and what those left in their callers — gets two questions to Jev, in separate requests: whether the requirement requires
something of this call (`applies` / `does_not_apply` / `unknown`), and what the function does under
an assumption.

A caller is found by searching for the changed function's name, and a function is taken as one only
where that line refers to it: a line where the name is in a comment or a string, is a field, or is a
parameter or local of the function that shadows it, is not a caller; a call, or the function passed as
a value (`.map(name)`), is. A line the parser did not read as calls — inside a macro whose arguments
are not read, or code it could not read, or a function whose calls were cut — is taken as before: not
read is not "no call" (#83, `docs/resolution.md`). How many lines were passed over is a note.

**A Rust file is read by a parser (tree-sitter-rust, ADR 0022): every call outside a macro is listed
under the function it is written in, and nothing that is not a call is listed; what the parser cannot
read is left out and said so.** Inside a macro, the calls are listed when the macro's arguments read as
expressions with no error anywhere; a macro whose arguments do not, or whose arguments are a pattern
or code handled as text (`matches!`, `assert_matches!`, `stringify!`, `quote!`), is counted in the notes
and not read. Test code lists nothing: a `#[cfg(test)]` item, a `#[test]` function, and a file a parent
declares `#[cfg(test)] mod …;`. Measured against #81's oracle on #80's dev material in
`docs/call-oracle.md`, *The record after #83: the parser (dev)*.

A requirement that names no form — one read from text — is first asked which form its sentence
says: one request carrying `{ requirement: { id, text } }` and nothing else (the measurement sent
every sentence as `R1`; the run sends the requirement's own id), and its calls are then read under
the form Jev chose at the bar, or under `failure_propagation` when Jev read neither form or was not
sure. A spec's requirement is not asked; nor is one on a run that read no function.

| | `failure_propagation` | `check_before_action` | `failure_handling` (a spec names it) |
|---|---|---|---|
| a call can be asked about when | its callee settles to something that returns a `Result` — one `fn` of its name in the repository, the one the call's path or form picks out of several, a trait's method whose versions all return one, or, for a call that writes a path, a function of the table in *Functions this repository does not define* — and the function returns a `Result` too (see *Whether a function returns a `Result`* below) | a word of its name (its path and the receivers before it, split at `_` and at case changes) is a word of the requirement or of `searchHints`; and its callee is not a function this run reads on its own | its callee settles as for `failure_propagation`, whatever the function returns — one that returns `()` included (a sibling of the change still returns a `Result`) |
| the requirement is asked whether it requires that | a failure of this call not reach the caller as a success | a check pass before this call is made | a failure of this call not be turned silently into a success |
| the function is asked, assuming that | this call returns an error and every other operation succeeds | the function is called in the case the requirement describes, in which it says this call must not be made, and every other operation succeeds unless the case itself decides it — with the bodies of the checks named above the call sent along (ADR 0019, ADR 0020) | as for `failure_propagation`, word for word |
| what the function does | `returns_error` / `returns_success` / `cannot_determine` | `does_not_reach` / `reaches_it` / `cannot_determine` | `propagates` / `reports_locally` / `continues_silently` / `cannot_determine` |
| against the requirement | `returns_success` | `reaches_it` | `continues_silently` |

**Every call asked about is read by one rule, the same for every form**, into one of four:

- the requirement `applies` at 0.6 or more, and the function's answer at 0.6 or more is the one
  against the requirement → **worth checking**; the one keeping it → **holding**; anything else
  (`cannot_determine`, under the bar, no answer) → **not settled**;
- the requirement `does_not_apply` at 0.6 or more → **not required of**;
- anything else from the mapping (`unknown`, under the bar, no answer) → **not settled**.

A request that fails without ending the run leaves its call unanswered and the run goes on; a run
that reached the host and got no answer at all fails (exit 12). `--candidates-only`
stops before the first question and prints which calls are inside the budget and which are not,
with a reason each; it needs no credentials.

### The siblings of a change

The path a fix may have missed calls the same helper the fixed code calls, and calls nothing the
change touched: it is neither a changed function nor one hop out (ADR 0005). After everything else
the run asks — every requirement's calls and the changes' questions — it reads those functions and
asks about their calls under a budget of its own, 10 per requirement:

- **A seed** is a function of this repository that the changed code calls outside tests, on a line
  it kept, added or removed: the call settles at one definition here (the reading of *Whether a
  function returns a `Result`* and *Which definition a call reaches*), which returns a `Result` and
  is not a changed function. A name only on a removed line is settled by its definitions at the head
  commit; a helper the change deleted has none and is no seed. At most 8, called on a changed line
  first, then called from more changed functions, then used in fewer files, then by name; a name
  used in more than 20 files is not followed.
- **A sibling** is a function outside tests that the change did not reach one hop out, with a call
  that settles at a seed, that returns a `Result`, and none of whose calls settles inside a changed
  function or, under a changed function's name, settles nowhere. A function whose calls were cut by
  the per-function cap is not one. At most 20. Its calls are dealt one function at a time in seed
  order, the calls that tied it first.
- **Seeds and siblings are chosen by returning a `Result`,** under every form. A requirement that a
  check pass before an action is asked about the same siblings, and a helper that returns `()` is no
  seed for it (#39); under `failure_handling`, which asks in a function that returns `()` elsewhere,
  a sibling still returns a `Result`.
- **Not reached:** a sibling that shares only a function outside the repository (`fs::…`), or only a
  function written several times as one thing — a trait's method, a function per platform; two hops
  out; a function whose call to a changed trait `impl` settles at the trait's versions, which can be
  taken for a sibling.
- Everything the siblings' pass could not use is in the notes, by reason: names that settle nowhere,
  are outside the repository, return no `Result`, are changed functions, are only in tests, are too
  common, or were over a cap; functions that also call a changed function, may call one, had their
  calls cut, or return no `Result`.

The two budgets besides the siblings' (*The budget* below) ask the same set whether or not a sibling
exists, and are counted in `counts` as they are with no sibling; the siblings are counted apart, in `--json` under `counts.siblings` and in the report in its own lines.
Their calls carry `origin: shares_call` and `via`, the seed that tied them, and so does a finding in
a sibling — a finding of the other two budgets carries neither, as before. The report's first line and
the Action's check run count the siblings with everything else: a sibling's call read is a call
read. A sibling's set-aside and left-over calls are under *Not checked*, so the check run can be neutral
where it was green, and a finding in a sibling is a finding for `policy.fail_on`.

### The budget

**The functions the change touched and the functions that call them have a budget each — 20 calls
per requirement, and at least 10 plus what the first leaves — and in the callers' budget the calls
into a function the change touched are asked first, whichever caller they are in** (ADR 0015).
Together the two ask at most 30 calls a requirement; the siblings' 10 are apart from both.

**Every function the run reads — changed, a caller one hop out, or a sibling — has its calls listed
up to 1,000 before any budget orders them, and what that cap leaves out is counted in the notes**
(#38). It was 40, and a call past the fortieth in its function was gone before either order saw it
([*The calls of a function, measured*](measurements.md#the-calls-of-a-function-measured)). A function whose calls the cap did cut is still not taken
for a sibling.

**A line in the body of a function whose body opens below its signature is read as that function's,
by the listing and by the evidence and the changes' question alike — up to the 300 lines a block is
read whole, as for any function** (#74). The two read a function's end from one place: the line
its body opens on, and the closing brace at the function's own indent — so a `where {` written at
column 0 opens the method's body and does not take the `impl` around it ([*The calls of a function,
measured*](measurements.md#the-calls-of-a-function-measured)).

- **The functions the change touched** take their 20 one call per function at a time, so no single
  body takes it. Inside a function, the askable calls whose callee resolved to a function the change
  touched are asked before its other calls; under `check_before_action`, the calls whose own name
  — the last part of their path — meets the requirement's words come next, **a call whose own name
  meets the words taking its turn before a call that meets them only through a receiver or the rest
  of its path** — the operation a sentence of this form names is meant, and a noun in the name meets
  the words as well as a verb; and the rest follow in the order they appear. The failure form marks no
  call named, so its order is the one before. When a
  function gets fewer questions than it has askable calls, that decides which calls they go to; when
  more functions contain an askable call than the budget, the functions late in the order get none, and
  each of the others gets one, for its first call. This is the order they had when they shared the
  budget with their callers, with the callers taken out: every call it reached then it reaches now.
- **Their callers** take 10 and whatever the changed functions left of their 20 — places in the
  budget, so a changed function's call that takes a place and is then set aside (a body too long, a call
  it cannot point at) keeps it: first the calls
  into a changed function, one per caller at a time, then the rest, one per caller at a time. A
  caller is in the set because it calls a changed function, so with more callers than their budget
  those calls take all of it, and a caller's other calls are not asked about. Where the changed
  functions touched few calls the callers used to get more of the shared 20 than 10; they now get 10
  and the rest of the 20. That can still be fewer than the shared pool gave them — one changed
  function with twenty calls and nineteen callers with one each gave the callers 19 then, 10 now.
- **Every requirement's changed functions are asked first, then the changes' questions (*Exit
  codes*), then every requirement's callers, then the siblings.** A limit reached in the middle of a
  run — `max_requests`, the pull request's (*A limit for the whole pull request*), the time — stops
  at the callers, never at a later requirement's changed functions or at a question about a change.

`--json` counts both under `counts` (`budget` is what the two could ask together) and each under
`counts.byOrigin.changed` and `counts.byOrigin.calls_changed`, in the terms `counts.siblings` uses;
the callers' `budget` there is 10 plus what the first left, so the two add up to more than `budget`
when the first left some. The report prints one line for each. A caller's call left over is under
*Not checked* as "the callers' budget of N was already spent".

Where a callee resolved to is the `failure_propagation` form's answer: the one `fn` of that name the
repository defines, or, when it defines several, the one the call's path or form picks out — and for
a trait's method read as one thing, the trait's declaration, which is not where any implementation
is (*Which definition a call reaches*), and for a call into a function this repository does not
define, the table's row (`fs::read_to_string`), which is nowhere in this repository and so is never
a changed function. A name nothing settles is not asked about and resolves to nowhere. The
`check_before_action` form resolves no callee for a call it asks about — a call whose callee is a
function this run reads is not askable there — so none of its calls goes first for that; what orders
them is whether their own name is what the requirement names (#39, ADR 0016). That order is in the
changed functions' budget only: the callers' and the siblings' budgets keep their order. A
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
defines one `fn open(&self) -> bool` is set aside with "the one function named open in this repository
(…) returns `bool`" — true of that function, and the call is not asked about. A call that cannot
reach that one definition is set aside as having no definition here: a method call (`x.name(…)`) to a
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
  `fs::rename(a, b)` and `std::fs::rename(a, b)` — **and never another crate's function of that name**
  (#83). A call written from another crate (`tokio::fs::write`), or whose first name a `use` brings in
  from another crate (`use tokio::fs;`, `use tokio::{fs::File, …};`), matches nothing. A `use` is read
  in the block the call is in — the file, a function, a `mod { … }`, which a `use` outside reaches only
  through `use super::*` — and an alias is read as what it names (`use std::fs::File as F;`). A first
  name no `use` in the block brings in — through a glob, a `use super::*` from a parent file, a `use`
  inside a macro — is matched by its ending as before. The four rows in the last line are matched only
  at that length, because the shorter ending means something else somewhere:
  `gix-path`'s `env::var` returns an `Option`, tokio's `io::read_to_string` and futures-util's
  `io::copy` return a future, and a crate's `File::metadata` returns an `Option<&Metadata>`.
- **A method call is not matched, whatever the table holds.** Rust resolves a method by the type of
  its receiver, which this does not read; `Metadata::file_type` returns a `FileType` and
  `DirEntry::file_type` an `io::Result<FileType>`, and both are written `entry.file_type()`. This
  is why pybun#428's fixed call is still set aside.
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
  stays set aside.

Every row is there because `bench/outside-results-check.ts` read the standard library's own source
and a machine's cargo registry and found no definition a call could reach that way returning
anything but a `Result`. That finding is "no counterexample in those 1,798 crates", not "no
counterexample anywhere". The rows come from those sources, not from the repositories this tool is
measured on.

#### Which definition a call reaches

A name this repository defines more than once used to end the reading there. Three things narrow
it, in this order, and what none of them settles is set aside as before. A name defined **once** is
unchanged: the path is not read at all, and that one definition is the callee as it always was.

- **The path the call writes.** `SyncState::load_strict(root)` keeps the definitions inside an
  `impl SyncState`, `impl Trait for SyncState` or `trait SyncState`; `Self::path(root)` keeps those
  inside the `impl` the call itself is written in; `install::add_package(args)` keeps those written
  in `install.rs` or `install/mod.rs` **inside the crate the call is in** — a workspace has a
  `util.rs` in every crate. `crate::`, `super::` and `self::` are passed over. The item a
  definition sits in is read from indentation — the first line above it that is less indented and
  begins an item — so a `fn` written above it inside the same `impl` is not its header. A header
  spread over several lines (`impl<T>` / `Trait for` / `Q` / `{`) cannot be read, and then the call
  is set aside: nothing further may settle it, or the form below would pick the very definition the path
  was about to rule out.
- **The form of the call.** A method call reaches no definition that takes no `self`, and none that
  takes a different number of arguments (counted as above). When that leaves one, it is the one.
  Past 20 definitions after the path, their signatures are not read and the call is set aside.
- **Definitions that are versions of one thing.** A trait's method — the declaration
  `trait X { fn name(…); }` in *this* repository and the implementations of that same trait — or a
  function written once per platform (`#[cfg(unix)]` and `#[cfg(not(unix))]`, at the top of one
  file). Which version runs is not settled, so all of them must return a `Result`; one that does
  not sets the call aside, and the reason names it. The declaration must be here: two
  `impl TryFrom<A> for B` blocks do not make `try_from` this repository's method.

**A path that matches none of the definitions is set aside, never reported as "no definition here".** A
type brought in under another name (`use moltis_channels::Error as ChannelError`) and a function
re-exported from another file (`model::values_to_chat_messages`, written in `model/convert.rs`) are
both real definitions this does not follow; saying they are not defined would be false. For the
same reason, a name whose only definitions are in files declared `#[cfg(test)] mod x;` is set aside with
that as its reason. A module declared `#[cfg(test)]` in one file and plainly in another — a crate
whose `main.rs` declares it for tests and whose `lib.rs` declares it outright — is code.

When several versions are read together, the definition the report names — and the one the order
inside a function compares against ([*The order inside a function*](measurements.md#the-order-inside-a-function)) — is the trait's declaration, or
the first of the platform versions. A pull request that changes an implementation rather than the
declaration is therefore not sorted first by that order.

How often each of these settles the definition rust-analyzer settles, and where it does not, is recorded
in `docs/resolution.md`; which relations are trusted is ADR 0025's.

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

**A requirement's section states how many of the calls that could be asked were read and how many
were left, and a run that left calls never reads as having checked everything** — in the report and
in the Action's check run (#38). Right below the functions reached, one line:

```
Of the 22 calls that could be asked: 15 read and answered, 7 set aside before their question. 266 more calls could not be asked. 4 notes under *Notes* say what was not read.
```

(grovedb#500 as shipped, against Jev: seven budgeted calls appear twice in their function or do not
close their parentheses, so none of them could be pointed at.) "Could be asked" is the calls the
budgets chose from: those taken and those over. A call asked about and left without an answer — the
request limit, the time or the host — is counted apart from those read and answered, and the first
line and the check run's title say how many there were. "Held before their question" is a budgeted
call whose body did not fit, or that could not be pointed at in it; a run that sent nothing
(`--candidates-only`) says what was inside the budgets instead. The line says "All … were read and
answered" only when that is every call and none could not be asked. A note says what was not read
when something was not read or not followed — a listing's cap, a file that could not be read, a
search not followed — and not when it only explains, as "do not return a Result" does. When a run
left anything, the report's first line says how many calls were not checked, how many came back
without an answer and how many notes say what was not read, in the same numbers as the check run's
title, and the check run is not green. `--json` carries the counts these are drawn from, and per
requirement `unreached`: the notes, of `notes`, that say something was not read.

Each requirement's section names its form and, after the counts, how the calls read came out, in the
order a reader decides from ([ADR 0021](adr/0021-the-check-run-holds-what-decides.md)): *Worth
checking*, *Not settled*, the requirement's *Notes*, and then the audit — *Read as holding*, *Read,
but not required of by the requirement*, *Every call read* and *Not checked*. Every call read is in
exactly one of *Worth checking*, *Not settled*, *Read as holding* and *Read, but not required of*; the
label of the function's answer
(`Jev, on what the function returns` / `Jev, on whether the function still makes the call`, and
`when that call fails` / `in the case the requirement forbids it` in the list of calls read) is the
form's.

| section | what it holds |
|---|---|
| **Worth checking** | the requirement read as applying, and the function's answer against it, both over the bar |
| **Not settled** | a call read, and not settled either way: the mapping `unknown`, or under the bar, or unanswered; or the requirement applying and the function's answer `cannot_determine`, under the bar, or unanswered — each says which, with both answers and the bodies sent with it |
| **Notes** | caps that dropped candidates, files that could not be read, and what the change did not reach |
| **Read as holding** | the requirement read as applying, and the function's answer keeping it, both over the bar. **Two readings that agree, and nothing more**: where what decides it is in a body that was not sent, they can agree and be wrong — measured ([measurements](measurements.md#cases-that-were-not-used-to-tune-anything)), a decision moved into a helper read as holding with 0.92–0.96 six times of six, and a check moved into a helper the same |
| **Read, but not required of by the requirement** | `does_not_apply` over the bar |
| **Every call read** | each call read, with the function's answer and the bodies sent with it |
| **Not checked** | the form's condition set the call aside (no definition here, no `Result`, not settled whether there is one — the reason says what could not be read —, no word of the requirement, a callee read on its own), the body did not fit, the call could not be located, the code the reading turns on could not be sent (below), or the budget was spent |

The command prints all of it. The GitHub Action's check run and job summary print everything up to
the audit, and in its place one line of counts — so many read as holding, so many not required of,
so many not checked — and the report's first line says the reasons are in the full report, which is
`report.md` in the Action's artifact. A requirement that read no call keeps its *Not checked* lines
in both.

None of the four is a requirement verdict: each is what two answers about one call came to. A
listed call rests on two Jev readings that do not check each other. Everything either of them used
is printed so it can be thrown out. `--json` carries the form, every mapping, every reading with its
`outcome` (`violates` / `satisfies` / `unknown` / `aside`), and every option's probability.

### The code a reading turns on

**A call is read as worth checking or as holding only when the code its form names as deciding the
reading was sent to Jev. A call whose deciding code could not be sent is not asked about: it is under
*Not checked*, which says what was not sent** (ADR 0019). Jev is sent the body of the function a call
is in; each form names, from that body's text and without asking Jev, what else the reading turns on:

- **`failure_propagation`**: a failure passed to this repository's own function before it reaches `?`
  — `step_outcome(self.rewrite_heights(v))?` — is that function's to return, and its body is not
  sent, so the call is not asked about. The function is one the call is an argument of, whose name
  the repository defines outside its tests and is not one every repository has (`Ok`, `Some`, `Err`,
  `new`, `from`, `into`, `timeout`, `spawn`, `spawn_blocking`, `block_on`, `drop`).
- **`check_before_action`**: the checks above the call — calls in an `if`, `while` or `match` (and its
  guards), in an `ensure!`, `assert!` or `debug_assert!`, in a `let … else`, or the whole of a
  statement that `?`-s its result, through methods chained on it, and binds nothing (`check(x)?;`,
  `check(x).map_err(E::from)?;`, `let _ = check(x)?;`), whose own name meets the requirement's words
  and does not start with a capital — are sent with the packet: each body when its name has exactly
  one definition outside the tests and it fits 4,000 characters (8,000 for all of them). A check with
  more than one definition, or too long, sets the call aside; one defined inside the function asked about
  is already in the packet. A report lists under each call the bodies that went with it.

Beyond the checks, the functions a sent check calls, one level down, go with it while there is room
and their names have one definition — grovedb#500's `verify_height` decides in `verify_tree_height`.
**That second level is not promised**: what did not go is named under the call (`not sent: …`), and
the call is asked all the same.

What it does not name, and so does not promise: a failure passed on through a method
(`.map_err(…)`, `.ok()`: the repositories measured define their own `map_err`, `context`, `ok`, so a
method's name does not tell theirs from the standard library's), through a constructor, a tuple, an
array or a macro first (`wrap(Some(call()))`), or through a variable over several statements; a check
that is not in a condition — a `?` statement whose chain has a `?` before its last, a method
argument with a `;` in it (a closure with a block), or a typed `let _: T =` is not read as one —,
whose name does not meet the words, or that the repository does not
define (a dependency's, the standard library's), and whatever decides from the second level down.
Those readings rest on what was sent, as before, and *Read as holding*'s warning holds for them.
Which definition a name reaches is found by the name alone, among the files the run reads
(`repository.include`): #83 is where that is resolved. A name the repository shares with a library
(`join`, `retry`) is taken for the repository's, which sets aside a call that could have been asked — the
cautious side. `--json` carries, on an observed call and on a finding, `sent` (each body's `name`,
`path`, `lines` and `depth`) and `notSent` (the names of the second level that did not go), each
absent when empty; a call set aside is in `unchecked` with its `why`.

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

Which Jev answered is `metadata.modelIdentity`. `metadata.model` is the name this tool sent, and
on every host it is an alias that moves (`typesafe/jev`, `jev-latest`, `typesafe-ai/jev`), so two
runs under the same name may have been answered by different versions. The host names the version
in each response (Cloudflare wrote `jev-1.13.0` on 2026-09-25), and the run counts responses by it:
`returned` is `[{model, responses}]` in name order, `notReturned` counts responses that named no
version or only an alias, `unreadable` those whose version was not a plain name (at
most 100 of `A-Z a-z 0-9 . _ : / @ + -`, or not a string; never printed), and
`reusedFromEarlierRuns` the answers `--answers` kept from an earlier run, whose version is not known
(a repeat within the run is not among them: the response it repeats was counted). `named` is `all`,
`some`, `none`, `no_responses` (a skipped run, or nothing readable came back) or `not_recorded`.
`requestedIs` is `floating`: what this tool sends is its table's name for Jev, never a version,
whichever endpoint it goes to. A response naming any host's name for Jev — the one sent or another —
has named an alias, not a version, and a level that names only an alias does not hide a version
named below it. These count responses, not
answers — a response the report could not read is counted too — and the version is what the host
said, not a promise that the model behind that name does not change. The report prints the same
after the model's name: ``model `typesafe/jev` (answered as `jev-1.13.0` ×12)``.

"Nothing listed" means no call met the conditions for being listed — both answers over the bar and
disagreeing. It covers calls whose mapping or whose behaviour came back undetermined, below the
bar, or unanswered, as well as calls that agreed. What was not reached is under *Not checked*, and
the enumeration's own caps are counted in the notes.

## What a later push asks again

**When the Action runs again on the same pull request, a judgment whose evidence and questions are
byte-identical to one already answered for that pull request is taken from that answer instead of
being sent to Jev, and the report counts it as reused** ([ADR 0013](adr/0013-remember-a-pull-requests-answers.md)).

The command does it with `--answers <dir>`; the Action passes a directory it keeps in the Actions
cache, one per pull request (`remember-answers`, default `true`).

- **What counts as the same.** A request's key is the SHA-256 of the host, the endpoint's origin (its
  port included), the model, the evidence packet and the questions' words. A tool whose questions
  changed, another host, another endpoint and another model all ask again. The directory holds each
  key and Jev's answer, never the packet: nothing of the repository's code is kept.
- **When it is read.** Only once the run has decided it has credentials. A run without them — a fork's
  pull request, Dependabot's, no keys — is skipped as before and the command never opens the
  directory. (The Action still restores the cache for such a run and saves it back unchanged; the
  command does not read it.)
- **How it is read.** A directory or file that others can read, or that is reached through a symlink,
  is not used and the notes say so; the Action makes the restored directory private again first. A
  restored directory that is itself a symlink is not passed to the command at all, so nothing is
  reused, no note says why, and it is not saved back. A
  kept answer that no longer fits its question — a key missing, a choice not offered, a probability
  outside 0 to 1 — is asked again, and the notes count it.
- **When it is written.** Each answer as it comes back, so a run stopped by its budget, a failure or a
  later push keeps what it was given. An answer that cannot be written is still used in the report,
  and the notes say it was not kept.
- **Two identical requests in one run** share one: the second waits for the first and is counted as
  reused. If the first fails, the second fails with it and is not counted — the same request is not
  paid for twice, where before it was.
- **How it is counted.** `sent.requests` and `sent.answered` are what went to Jev and what Jev
  answered in this run, as before; `sent.reused` is what was answered without being sent, and
  `sent.reusedFromEarlierRuns` how many of those an earlier run kept — the rest repeated a request of
  this run. The *Sent to the judgment model* line adds "N answers reused (M kept from earlier runs,
  the rest repeats within this one)" when there are any. A run answered entirely from the directory
  is not "Nothing was asked". A run stops with exit 12 when it sent at least one judgment (the form
  question aside) to Jev and none came back, whatever it reused; one the run's own budget ended — its
  time, requests or bytes, before it was sent or before a retry — does not count, as without kept
  answers. The trace (`JEV_TRACE_FILE`) holds only what Jev answered in this run.

What is not guaranteed:

- **Whoever can write the pull request's cache is trusted.** A fork's cache stays in its own pull
  request's scope, whose runs have no secrets and never read it. An author of a pull request from a
  branch of the repository can add a workflow that saves forged answers under the pull request's
  key and remove it in a later push: the later report uses them, and says nothing about a changed
  workflow. Its only mark is the "kept from earlier runs" count. Signing the answers would not
  stop it — that workflow can read the secrets a signature would use.
- A cache GitHub has evicted (after 7 days unused) is asked again. An endpoint set by `JEV_API_URL`
  whose port changes between runs is too.
- A run answered entirely from the directory sends nothing, so a revoked key goes unnoticed until a
  request is new.
- Parallel legs of a matrix share the key; the second save only warns. Whether a run that
  `concurrency` cancels still saves what it had is not yet measured on GitHub.
- Runs of one pull request that overlap each restore the newest cache there is when they start and
  save their own: what one of them adds may not reach the next, which asks it again.
- A kept answer is the one draw Jev gave; asking again would give a fresh one. Where the reading sits
  at the bar, the two can differ ([measured](measurements.md#what-another-push-would-not-have-to-ask-again)).

## A limit for the whole pull request

**With `limits.max_requests_per_pull_request` set, and the Action keeping the pull request's
answers, the runs of one pull request together send at most that many requests to Jev, as far as
the count carried in its cache goes; a run the limit leaves short says so**
([ADR 0014](adr/0014-a-limit-for-the-whole-pull-request.md)).

- **Where it is counted.** In the `--answers` directory, as `sent.log`: the transport writes one
  line just before each request leaves, a retry included, so a run stopped halfway — even killed —
  has counted what it sent. A request whose line cannot be written is not sent, and the notes say
  how many were not sent for that reason. The unit is the
  directory: the Action keeps one per pull request; from the command line, whatever shares a
  directory shares the count.
- **How it bounds a run.** At the start, what is left of the limit narrows the run's own
  `limits.max_requests`; a run with nothing left sends nothing. A question it could not send is
  left without an answer, with the budget as the reason — as under the run's own limit — and the
  notes say "This pull request had sent N requests of its M before this run, so this run could send
  K." and, when the limit cut the run short, how many judgments could not be sent. Kept answers are
  still used, since they send nothing.
- **Where the repository gates on findings** (`policy.fail_on: [finding]`), a run the limit left
  short — or that sent nothing because its count could not be written — exits 2, it did not
  finish, unless it listed a finding, which exits 1 as before. Either way the check is red: pushing
  until the limit is spent cannot make a change pass unasked. Without that setting it exits 0, as a
  run bounded by its own limit does. A run stopped by its own time or bytes is not said to have reached
  the pull request's limit.
- **Who sets it.** `.jev-intent-review.yml` at the commit before the change, like every other
  setting: a pull request that raises it in its own change is still bounded by the old value.
- **When it does not apply.** Without `--answers` there is nowhere to count, and a directory or file
  others can read is not used (the Action makes the restored ones private first); the notes say the
  limit was not applied, and `limits.max_requests` alone bounded the run.

Not guaranteed:

- **The count lives in the pull request's own workflow and cache.** An author of a pull request
  from a branch of the repository can set `remember-answers: false` in that workflow — the limit is
  then said not to apply — or clear the cache, which starts the count from 0. The workflow change is
  said in the notes (as any change to `.github/workflows/` is); clearing the cache is not.
- A cache GitHub has evicted starts from 0.
- A restore brings back one cache, the newest. Runs of one pull request that overlap, the Action in
  two jobs of one pull request, and the legs of a matrix each save their own count, and only one of
  them reaches the next run: the limit can be passed. Under the README's `concurrency`, a run a
  later push cancels saves its count only as it stops, and whether that lands before the next run
  restores the cache is not yet measured on GitHub.

## Only Jev

The transport refuses any model but Jev's name on the host it sends to — `typesafe/jev` on
Cloudflare and for `JEV_API_URL`, `jev-latest` on TypeSafe, `typesafe-ai/jev` on Vercel AI Gateway —
before a request is built, so nothing else can be reached from this tool. `test/only-jev.test.ts`
checks it at the transport on every host, and over a whole run against a capturing endpoint and
against a stand-in for each named host.
