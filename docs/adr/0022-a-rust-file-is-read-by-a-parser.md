# 0022. A Rust file is read by a parser (tree-sitter-rust, shipped as WebAssembly), and a macro's arguments are read when they read as expressions

Status: Accepted (the owner's rulings of 2026-09-25: the dependency, and the macros twice — see
*Decision*)

## Context

The listing of a Rust file's functions and calls (`enumerate`) and the Rust side of `BlockIndex` read
lines with regular expressions and found a function's end by indentation. #81 measured that against a
parser (`docs/call-oracle.md`): on #80's dev material it dropped 2,071 in-scope calls with nothing said
— every call with a turbofish on its last name among them, none listed — and listed 26,876 candidates
that were not calls (comments, strings, patterns, `let (`, test code a parent declares). A call not
listed is a call nothing asks about, and the report does not say so.

#81's oracle is built on `syn`. The listing could not be: `syn` is a Rust library, and this tool is a
TypeScript package published to npm and run as a GitHub Action.

## Decision

1. **The parser is tree-sitter-rust**, loaded by `web-tree-sitter` (pinned exactly) from
   `vendor/tree-sitter-rust.wasm`, the file the npm package `tree-sitter-rust@0.24.0` ships, unchanged
   (`vendor/README.md` has its hashes; a test checks them). Installing the tool builds nothing native.
   The grammar is loaded once, when `src/syntax/rust.ts` is, so reading a file is synchronous and the
   callers keep their shapes (`enumerate`, `BlockIndex.enclosing`, `declaredForTestsOnly`).
   Owner's ruling.
2. **The listing and `BlockIndex` read a Rust file from one parse**, so the two cannot disagree on
   where a function ends (#74). `BlockIndex` answers `enclosing` from the ranges containing the line —
   the innermost function that fits, else the outermost construct that fits, else the window; the
   listing takes its test code from the parse, while `BlockIndex.testRegions`, which the definitions
   read, stays the indentation reader's until #83's second part. A file of another language is read
   by indentation as before.
3. **What the parser cannot read is left out and said so**: its ERROR nodes' lines, and a function
   whose name is on one, are not listed, and the run's notes say so the way they say a cap cut
   something (the Action does not count the run as fully read). This was #81's last item, moved here
   by the owner's ruling. Two gaps of the grammar that would otherwise fail whole expressions are
   rewritten, in what the parser is given only, to text of the same length: `&raw` not followed by
   `const`/`mut` (a variable named `raw`, 39 of the 44 dev files it could not read) and Rust 2024's
   `unsafe extern`. Every name is read from the file, never from the tree.
4. **A macro's arguments are read again as expressions, all or nothing**: a macro whose arguments read
   as expressions with no error anywhere has its calls listed, marked as inside a macro; one that does
   not, or one of the few whose arguments are patterns or code-as-data (`matches!`, `assert_matches!`,
   `stringify!`, `quote!`, …, by exact name), is counted and not read. The count is a note, not a
   "not read" note: a macro's calls were never the oracle's to grade. Owner's rulings: first "the
   expression macros only" — which measured a 90% fall in the macro calls a question could be put to,
   past the 20% the plan had set for asking — then "every macro that reads as expressions".
5. **A file a parent declares `#[cfg(test)] mod …;` lists nothing.** `declaredForTestsOnly` takes a
   `forListing` answer that also follows `#[path]`, a file loaded through `#[path]` keeping its children
   beside it, and every module of a test-only file. The definitions' answer is unchanged: which
   definition a call reaches is #83's second part.

## Alternatives considered

- **Native tree-sitter** (`tree-sitter` and `tree-sitter-rust` as native addons, prebuilt for six
  platforms): faster, but an install without a prebuild, or behind a proxy, compiles C. Rejected by the
  owner.
- **A hand-written lexer over comments, strings and brackets**: no dependency, but it cannot tell a
  pattern (`E::A(n) =>`) from a call, so the listing would keep listing non-calls. Rejected.
- **`syn` compiled to WebAssembly**: the same parser as the oracle, which the oracle exists to be
  independent of (`docs/call-oracle.md`). Rejected.
- **Declaring the old reader's unsupported shapes instead of reading them** (#81's second part as it
  was written): turbofish alone is in 27% of the dev files, and declaring it in the notes would have
  turned a large share of Action runs from green to not-green until this landed. Folded into this ADR
  by the owner's ruling.
- **An allowlist of expression macros only**: the first ruling; measured, it lost 605 of the 667 macro
  calls a question could be put to — 454 of them grovedb's own `cost_return_on_error!`, a `?` of its
  own. Replaced by decision 4.

## Consequences

- On #80's dev material, against #81's oracle unchanged (`bench/logs/call-oracle-dev.json`): no
  in-scope call dropped silently, none listed under the wrong function, no candidate outside a macro
  that is not a call, and more calls listed than before. The comparison with the reader it replaces is
  the committed record before and after, not a second reader kept alive.
- Where a call a question is put to sits changes: turbofish calls, calls below a string continuing at
  column 0, and a project's own macros are now listed. Kept answers (ADR 0013) are asked again once.
- Which definitions a name resolves to is not changed by this: `definedName` still reads the one line
  a search found, `BlockIndex.testRegions` — what the definitions leave out as test code — is still
  read by indentation, and the definitions' `declaredForTestsOnly` is the one it was. Whether a call
  reaches the right definition is the next part of #83, with #37's record of where names gave a wrong
  or voided answer.
- What is sent about a definition does change: a Rust function's range comes from the parse, so the
  bodies the evidence carries (and #82's `decisiveBodies`, which reads `enclosing` at a definition's
  line) are the function's own, where a string continuing at column 0 or a wrapped signature cut them
  short before. Kept answers for such a place are asked again once (ADR 0013).
- The package ships a 1.1 MB grammar and depends on `web-tree-sitter`: the Action installs two runtime dependencies where ADR 0009 says one. A newer grammar is taken by the
  steps in `vendor/README.md`, and the fixtures' baseline is written again with it.
