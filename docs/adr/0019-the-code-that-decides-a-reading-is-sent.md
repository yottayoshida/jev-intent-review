# 0019. The code that decides a reading is sent, or the call is not asked about

Status: Accepted

## Context

The local check sends Jev the body of the function a call is in, and nothing else: its related
code is read only above a `max_related_chars` of 0, which no run uses. Jev still answers as if it
had read what the body calls. On the acceptance set's hidden versions (#36) — the decision moved
into a helper whose body is not sent — the failure form read `returns_error` at 0.91–0.96 in every
run of both cases, and the call was read as holding (`bench/logs/acceptance-v4.json`). The
check-before-action form read moltis#1064's hidden version as holding at 1.00, and the constructed
case's the same. The packet says `truncated: true` every time; that did not lower an answer.

The helpers in the failure form's hidden versions pass their argument through, so the reading was
right and had nothing under it: a helper that swallows the failure is the same packet.
`docs/dependency-check.md` measured the same on omamori#553.

**Asking Jev whether the code sent is enough was measured first, and failed** (#82's first
approach; `bench/evidence-settles/`, `bench/logs/evidence-settles-probe-v1.json`, 87 requests, lines
committed before any). Hidden versions read as turning on code not sent in 9 of 15 runs (the line
was 13): grovedb#500's failure form at 0.49–0.53 whether asked with the observation or alone,
moltis#1064's check-before-action as settled at 0.61–0.64. And it stopped 7 of 51 runs of code the
table said was settled — all of them grovedb#500's check-before-action, whose shipped code and
rewrite decide on `self.verify_height(grove_version)`, a body that was not sent either. Read again,
that answer was right and the table was not: with the check a call whose body is not sent, the
shipped code is not settled by what was sent any more than the hidden version is. What Jev could
not do was tell which unsent call decides.

## Decision

Which code decides a reading is found from the code, not asked of Jev. It differs by form, and
each form says it as data (ADR 0006), next to `askable`:

- **`failure_propagation`**: the failure decides the reading when the failure the call returns
  reaches repository code before it reaches `?` — a function that takes the call as an argument
  (`step_outcome(self.rewrite_heights(v))?`), whose name has a definition in the repository outside
  the tests and is not in a fixed table of names every repository has (`Ok`, `Some`, `Err`, `new`,
  `from`, `into`, `timeout`, `spawn`, `spawn_blocking`, `block_on`, `drop`). Such a call is not asked
  about: it is held before its question, and *Not checked* says through which function. A call whose
  failure is returned first (`extend(unpack(x)?)`), or passes through a method chained after it, is
  asked as before: grovedb#500 defines its own `map_err` and `map`, moltis#1064 its own `context`,
  `with_context`, `ok` and `timeout`, so whether a method's name is defined in the repository does
  not tell it from the standard library's. The expression is read with its whitespace collapsed, so
  one rustfmt split over lines is the same expression. Nothing is added to the packet.
- **`check_before_action`**: the check decides the reading. A check is a call before the target in
  its function that is in a condition (`if`, `while`, `match` and its guards, `ensure!` and
  `assert!`, `let … else`, or the outermost call of a statement that `?`-s its result — through
  methods chained on it — and binds nothing, `check(x)?;` or `let _ = check(x)?;` — a read such as
  `let v = get_version(..)?;` is not a check), whose own name meets the requirement's words (the rule ADR 0016
  orders by), that does not start with a capital (a variant or a tuple struct), and that is not a
  call of the target's own name. A function the change touched can be a check: a helper the pull
  request added is the likeliest place for a check that does nothing. Each check's body is sent
  with the packet when its name has exactly one definition outside the tests and the body fits
  (4,000 characters each, 8,000 in all). With more than one definition, or too long, the call is
  held before its question, and *Not checked* says which check could not be sent and why. With none
  (`path.exists()`, a dependency's check) there is nothing in the repository to send, and the call
  is asked as before, as the failure form treats a name the repository does not define. The functions a sent check calls, each with
  exactly one definition, are sent too while they fit — a second level, not required, and what did
  not go is named under the call (`notSent`): grovedb#500's
  `verify_height` hands the decision to `verify_tree_height`. A target with no check before it is
  asked as before.

The report lists, under a call read, each body that was sent with it. `--json` carries the same on
each observed call (`sent`), and a call held for this reason in `unchecked` with its `why`. A held
call is left to look at, so the Action's check run is not green (as for every call not checked).

Finding the one definition goes through one function in `src/evidence/builder.ts`, which uses the
repository search the builder already uses. It is by name. #82 says an approach that needs the exact
callee waits for #83's resolution contract; the owner chose not to wait (2026-09-25), so #83 is not
a prerequisite, and that function is where #83's contract replaces this lookup.

## Alternatives considered

- **Ask Jev whether the code sent is enough** (#82's first approach). Measured above; not adopted.
- **Find the check by its name alone** (any call before the target whose name meets the words).
  Tried on the three cases' code before measuring: it took grovedb#500's
  `Error::ChunkRestoringError`, moltis#1064's `values_to_chat_messages` (defined twice, once under
  `benches/`) and the constructed case's `load_key`, and would have held the shipped code and the
  only real defect of the form as *Not checked*. The condition position is what separates them.
- **Send every callee's body** (the builder's one hop, `max_related_chars` above 0). Every packet
  changes and grows, every measurement is taken again, and most of what is sent decides nothing.
- **Send the failure form's wrapper too**, instead of holding the call. It would settle the
  failure form's hidden versions (their helpers pass the failure through). Not now: the owner chose
  to decide the failure form from its shape (2026-09-25), and a wrapper sent is the same lookup by
  name that #83 may replace. Revisit with #83.
- **Hold every check-before-action call with any unsent call before its target.** Honest and
  simple, and it holds nearly every call of real code: moltis#1064's function reads a session store,
  metadata and a registry before its target, each a call whose body is not sent and decides nothing
  the requirement names.
- **Stop saying "holding".** It changes what the report is called, not what it rests on.
- **Wait for #80's dev set to compare.** The owner chose to go on (2026-09-25); #80's protocol
  measures this before #82 is closed.

## Consequences

- The failure form's hidden versions are not read confidently; they are *Not checked*. A decision
  hidden in a helper spread over several statements (`let r = call(); let s = wrap(r); s?`) is not
  found by a shape read in one expression, and is read as before. #83's parser is where that grows.
- Check-before-action readings rest on the check's body where one was named, and a hidden check
  that does nothing is read as what it is: the call is made where the requirement forbids it.
- The questions do not change, so no answer kept for a pull request (ADR 0013) is invalidated
  except those whose packet now carries a check's body.
- A check whose name does not meet the requirement's words is not found. The reading then rests on
  what was sent, as before this decision, and the report's warning under *Read as holding* stays.
