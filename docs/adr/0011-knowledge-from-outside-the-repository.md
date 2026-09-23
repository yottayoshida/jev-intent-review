# 0011 — What this tool may know about code it cannot read

- Status: Accepted
- Date: 2026-09-22
- Issue: #45 (third part)

## Context

The local check asks about a call only when it has established that the callee returns a `Result`.
It establishes that from the callee's signature in this repository. A call into the standard
library or into a dependency has no signature here, so it is held: `read_to_string has no
definition in this repository, so what it returns is not established here`.

Measured on the fifteen runs of the pre-check's eight cases, omamori `#468`'s five branches and two
pull requests (`bench/logs/`, counted once per call rather than once per branch): **973 calls are
held for that reason.** Of those, 178 are written with a path (`std::fs::read_to_string(&p)`),
733 are method calls (`entry.file_type()`), and 62 are bare names, most of which are not calls
(`let (a, b)` patterns, `cfg(unix)`, words in strings). Three of the acceptance set's twelve
candidates have their fixed call held by exactly this: instruckt-tauri#9
(`serde_json::to_string_pretty`),
pybun#428 (`entry.file_type()`) and agentflare#229 (`flush`, `sync_all`, `fs::set_permissions`,
`fs::read_to_string`).

The question is whether this tool may hold knowledge about code that is not in the repository it
reads, and if so, in what form.

## Decision

**This tool may hold one table of functions outside the repository, keyed by the path a call
writes, and it may use that table only for calls that write such a path.**

- A row is `fs::read_to_string` → returns a `Result`, with where it comes from. How many segments a
  row matches on is decided by a scan, not by taste: if the local cargo registry has a definition
  with the same ending that does not return a `Result`, the row is written longer
  (`std::env::var`, because `gix-path`'s `env::var` returns an `Option`) or not written at all.
- **Method calls are not settled by the table.** Rust resolves a method by the type of its
  receiver, which this tool does not read, and a name is not unique even inside the standard
  library: `Metadata::file_type` returns a `FileType` and `DirEntry::file_type` an
  `io::Result<FileType>`; `std::sync::Mutex::lock` returns a `Result` and `tokio::sync::Mutex::lock`
  the guard itself; `std::sync::mpsc::Receiver::recv` returns a `Result` and tokio's an `Option`.
  All three shapes are in the corpus this is measured on.
- A path written `crate::`, `self::` or `super::` says it is inside this repository, so the table
  does not answer for it.
- A path written `std::` says it is the standard library, so the table answers before this
  repository's definitions of that name are looked at. Any other path is answered by the table only
  when the repository defines no function of that name.

## Alternatives considered

- **Read the call's own syntax** (`?`, `.map_err`), which #45's Work names. `?` applies to `Option`
  as well, so it is not evidence of a `Result`; and this tool already decided (in #45's first part)
  not to read what a call returns from how its line looks — `p.exists() || p.symlink_metadata().is_ok()`
  bound the `.is_ok()` to the wrong call.
- **Ask Jev whether the function returns a `Result`.** Knowledge of an external API from a model
  cannot be checked against this repository, and a wrong answer leaves no trace a reader could
  catch. The tool decides from signatures; Jev judges intent. Keeping that line is worth more than
  the calls it would unlock.
- **Read the dependency's source.** Not available where this runs: clones are not vendored and no
  request goes out. The registry on a laptop is used to *justify the table*, in a bench, and never
  at run time.
- **Ask about every call whose callee has no definition here.** Most of the 973 are calls that
  cannot fail — `to_string`, `map`, `len`, `clone`, enum variants. A budget of 20 questions per
  requirement would be spent on them.
- **A table of method names as well.** Dropped for the reasons above, after the first draft carried
  one. It would have opened 10 to 13 further calls, most of them in one repository.

## Consequences

- Calls into the standard library and into `serde_json` that are written with a path can be asked
  about: 40 of the 973, in five of the ten repositories measured, including instruckt-tauri#9's
  fixed call. 18 of the table's 61 rows opened them; the other 43 matched nothing here, and are
  kept — a table cut down to the calls these repositories happen to make would be fitted to them.
- **pybun#428's fixed call stays held, and so do the 733 method calls.** Opening them needs the
  receiver's type, which needs a parser — spec Phase 4. This ADR says plainly that they are not
  opened, rather than leaving the wall unexplained.
- The tool now states something it cannot check inside the repository it reads. The table is
  printed in `docs/local-check-cli.md` so a reader can disagree with a row, and the scan that
  justifies each row is kept as a bench.
- The scan's finding is "no counterexample in these 1,798 crates and in the standard library", not
  "every definition anywhere returns a `Result`".
- Sunset: if no finding comes from a call the table settled within twelve weeks (by 2026-12-15),
  the table and this decision go. A row is added only from the source of the library it names,
  through the scan, and never because a crate is widely used: `serde_json` is here because its
  functions are read out of its own source in the registry, as the standard library's are.
