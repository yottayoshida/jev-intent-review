# The call oracle (#81)

**Every in-scope call in the Rust evaluation material is classified, one by one and per function, by
what the listing did with it — listed, listed under another function, left out and said so, left out
by design, or dropped silently — and every candidate the listing produced outside a macro that is
not an in-scope call is counted as a false positive, with the reason.** The record is committed; the
syntax rewrite (#83) takes it as its acceptance test, unchanged.

The listing is `enumerate()` in `src/plan/candidates.ts`: the functions of a Rust file and the calls
inside each, which the run chooses its questions from. It reads lines with regular expressions. A
call it does not see is not asked about, and nothing says so — the listing only counts what its own
caps cut. This measures what it does not see.

This file was written before the first measurement, and the scope and the classes of calls have not
changed since. Two reasons for a false positive, `definition` and `keyword`, were split out of
`other` after the first run showed 1,226 `let` candidates there, and the files a parent declares
test-only were taken out of scope after the first review (*The material*); neither moved a call from
one class to another except out of scope. A later change makes a new version of the record.

## The oracle

`bench/call-oracle/` is a small Rust program built on [`syn`](https://docs.rs/syn) 2, the parser
Rust's procedural macros use, with `proc-macro2`'s `span-locations` for line and column. It reads one
file and writes, as JSON, the calls in scope, the ranges of the file's syntax (function bodies, macro
invocations, patterns, types, attributes, string literals, comments, code compiled only for tests),
the test modules it declares in other files, and the files it could not parse.

It is deliberately **not** tree-sitter, which #83 may use for the listing itself: an oracle built
from the same parser as the implementation cannot catch a mistake the two share. It is not
rust-analyzer either: which definition a call reaches is a question for #83's ADR, not for this one.

Comments are the characters no token covers, and `///` / `/** */` (which the parser turns into
`#[doc]` attributes). Nothing else is lexed by hand.

## What counts as a call

In scope, attributed to the innermost enclosing `fn`:

- every call expression whose callee is a path — `foo(x)`, `a::b::foo(x)`, `Foo(x)`, `Ok(x)`,
  `Self(x)` — in the body of a free function, an `impl` method, a trait's default method, a function
  nested in another, or a closure inside any of those; a callee that starts with a capital letter is
  marked `capitalized` (Rust cannot tell a tuple-struct or variant constructor from a function by
  syntax, so they are counted and marked, not decided);
- every method call — `x.foo(y)`;
- a call whose callee is some other expression — `(self.f)(x)`, `make()(x)` — as `other`;
- with a turbofish anywhere (`inner`: `Vec::<u8>::new()`; `last`: `foo::<T>()`,
  `.collect::<Vec<_>>()`), and over several lines.

The position of a call is the line and column of the last name of its callee — `foo` in
`a::b::foo(`, `collect` in `.collect::<…>()` — which is the position the listing records.

Out of scope. The oracle does not count the calls here; the listing's candidates here are counted,
as `in_macro` or as a false positive:

- **the inside of a macro invocation** (`format!`, `matches!`, `info!`, `json!`…). A macro's
  arguments are tokens, not syntax, until the macro is expanded. Reading them again as expressions
  counts the pattern in `matches!(e, Some(Foo(_)))` as a call to `Foo`, which is the listing's own
  mistake, so the two would agree and the error would be invisible. The listing's candidates inside
  a macro are the `in_macro` layer. How #83 treats macros is its ADR's decision; its pass/fail on
  this oracle is decided outside macros only.
- code compiled only for tests: an item under a `#[cfg(…)]` whose predicate can hold only when
  compiling tests (`test`, `all(test, …)`, `any(test, test)`), a function marked `#[test]` or
  `#[…::test]`, and a whole file that a parent declares `#[cfg(test)] mod name;` (see below);
- anything outside a function body: `const` and `static` initialisers, attributes, types.

## The material

For each case, at its head commit: every `.rs` file `git ls-files` lists that the product would read
— the repository configuration's include and ignore lists, not a sensitive name, and not a test path
(`isTestPath`: `tests/`, `fixtures/`, `*_test.rs`…). `Discoverer.index()` applies the first two;
the product leaves test paths out when it looks for callers. A file whose content is identical to
one already measured is measured once.

A file a parent declares `#[cfg(test)] mod name;` is test-only as a whole, and so is every file under
its directory and every module a test-only file declares, with or without a `cfg` of its own. The
declaration is in another file, so it is resolved across the material by Rust's rule for where a
module lives (`testOnlyFiles` in `bench/call-oracle/classify.ts`): a crate root, a `mod.rs` or a
file loaded through `#[path]` keeps its children beside it, `a.rs` keeps them under `a/`, and
`#[path]` names the file relative to the declaring file's directory.

A file the oracle cannot parse is taken out on both sides and reported: files, lines, and the
listing's candidates in them.

Only the **dev** part of #80's evaluation material is measured. Until #80 is merged the material is
provisional — the nine acceptance cases in `bench/acceptance/` over eight repositories
(`bench/call-oracle/material.provisional.json`), which #80 has placed in dev — and every file and
table that comes from it says so.

## The classes

The listing is run twice on each file: as the product runs it, and with no cap on the number of
functions, to know which functions the cap left out.

Oracle calls and candidates are paired in this order, each pairing taking what the one before left:

1. same function (the line its name is on), same line, same last name, same column;
2. same function, same line, same last name;
3. same line, same last name, any function.

Every oracle call is then exactly one of:

| Class | Meaning |
|---|---|
| `detected` | paired in 1 or 2 |
| `wrong_function` | paired in 3: the listing has the call under another function |
| `omitted_cap` | in a function the cap of 60 functions left out, which the listing counts under `omitted` |
| `declared_exclusion` | a name the listing refuses on purpose: `Ok`, `Err`, `Some` |
| `silent_miss` | none of the above |

A `silent_miss` whose name is one the listing refuses because it is also a macro's name — `write`,
`writeln`, `format`, `println`, `vec`, `assert`, `assert_eq`, `panic` — is marked
`macroNameCollision`. The listing's pattern cannot match `format!(` (the `!` stands between the name
and the parenthesis), so refusing those names only drops real calls such as `.write(buf)`. It is a
miss, not a decision.

Every candidate is exactly one of `matched`, `in_macro`, or `false_positive`, whose reason is read
from the oracle's ranges, the first that holds: `comment`, `string`, `test_only`, `attribute`,
`type` (a type can sit inside a pattern: `let g: &dyn Fn(u8) = …`), `pattern`, `definition` (a
function's own name on the line that defines it: `fn inner() {`), `keyword` (`let (a, b) = …`,
`for x in (…)`: the listing's pattern allows a space before the parenthesis), `outside_fn`,
`duplicate` (a second candidate for a call already paired — a nested function's calls are also
scanned as its parent's), `other`.

The cap of 1,000 calls per function has never been reached (the largest function measured had 495,
`docs/local-check-cli.md`); a measurement stops if a file reaches it, rather than classify what it
would cut.

A file with a byte-order mark: the parser drops it and the listing counts it as a character, so the
first line's columns differ by one. Pairing step 2 absorbs it; `columnDisagreements` counts it.

## Checking the oracle

- The fixtures in `test/fixtures/call-oracle/` each state, in their first line, how many in-scope
  calls they hold, counted by hand before the oracle ran on them. The oracle must agree on every
  fixture.
- On the material, a seeded random sample — 20 `detected`, 20 `silent_miss`, 20 `false_positive`,
  10 `wrong_function`, 10 `declared_exclusion` (all of them when fewer) — is shown to three
  annotators who are not shown the class, and each answers whether the name at that position is
  the callee of a call in scope, in that function. **If the majority disagrees with the oracle on 5%
  of the sample or more, the record is not committed and the scope is revisited.**
- The listing is broken on purpose — every method call taken out — and exactly the detected method
  calls must move to `silent_miss`, and no other form move.
- `npm test` needs no Rust toolchain: the oracle's output for the fixtures is committed with the
  sha256 of each fixture and of the oracle's `main.rs`, `Cargo.toml` and `Cargo.lock`, and the test
  fails when either changed without the output, or when a fixture is added without it.

## Reproducing

```sh
cargo build --release --manifest-path bench/call-oracle/Cargo.toml
node bench/call-oracle.ts measure bench/call-oracle/material.provisional.json
node bench/call-oracle.ts measure bench/call-oracle/material.provisional.json --broken
node bench/call-oracle.ts fixtures      # rewrites test/fixtures/call-oracle/oracle.json and baseline.json
```

## The record (provisional material)

`bench/logs/call-oracle-provisional.json`: 1,816 files, 827,921 lines, every file parsed. It holds
the sha256 of the listing's code it was made with (`src/plan/candidates.ts`, `src/change/blocks.ts`)
and of the oracle, and every file's blob and counts; the line-by-line classification (60 MB) is
written again by the same command from the pinned commits and is not committed. **Provisional:
measured on the acceptance cases before #80's dev material exists. #81 closes when #80's dev
material is measured.**

76 files are test-only because a parent declares them so, or a test-only file declares them; their 2,576 calls are out of scope.

Of **160,118 calls in scope**, the listing has 136,914 under the right function (85.5%), none under
another function, and says it left out 4,957 (the cap of 60 functions). 16,176 are `Ok` / `Err` /
`Some`, refused by design. **2,071 are dropped with nothing said (1.29%)**:

| Why the listing drops them | Calls |
|---|---:|
| a turbofish on the last name — `foo::<T>(`, `.collect::<Vec<_>>()` — which the pattern cannot match | 1,143 |
| a name the listing refuses as a macro's (`.write(buf)`, `format(`) | 718 |
| other shapes, 158 in all; see below | 158 |
| in a function the listing does not list at all | 30 |
| a callee that is not a path (`(self.f)(x)`, `make()(x)`) | 22 |

The 158 sit in 18 functions (by case, file and function). Four of them, read by hand — pybun `init_project` (30),
moltis `stream_generate_python` (29) and `api_build_image_handler` (22), grovedb's `build.rs` `main`
(14): 95 calls — each hold a string literal over several lines whose continuation lines start at
column 0 (an embedded Python script, a Dockerfile, a URL). The listing finds a function's end by
indentation and takes that line for it, so every call below is outside the function it lists. 15
more are a method named `None` (quebec), which the listing refuses by name. The rest were not read one
by one.

By the form of the call:

| Form | Calls | detected | omitted_cap | declared_exclusion | silent_miss |
|---|---:|---:|---:|---:|---:|
| path | 45,749 | 31,500 | 1,240 | 12,820 | 189 |
| method | 98,093 | 94,330 | 3,064 | 0 | 699 |
| method, over lines | 5,195 | 4,927 | 258 | 0 | 10 |
| path, over lines | 9,717 | 6,074 | 298 | 3,337 | 8 |
| turbofish on the last name | 1,257 | **0** | 95 | 19 | 1,143 |
| turbofish on an earlier segment (`Vec::<u8>::new()`) | 83 | 83 | 0 | 0 | 0 |
| other callee | 24 | 0 | 2 | 0 | 22 |

Of **175,107 candidates**, 136,914 are paired, 11,317 are inside a macro, and **26,876 are not
in-scope calls (16.4% of those outside macros)**: 19,889 in test-only code (`#[test]` functions, and
every candidate in the 76 files declared test-only — the listing reads one file and does not
see the declaration), 3,346 in a pattern (`E::A(n) =>`), 1,220 a keyword (`let (a, b)`), 1,227 in an
attribute, 590 in a string, 493 duplicates of a nested function's calls, 61 a function's own
definition line, 37 in a comment, 5 in a type, 8 other.

| Case | Files | Calls in scope | detected | omitted_cap | declared_exclusion | silent_miss | Candidates | false_positive |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| grovedb-500 | 264 | 16,939 | 14,489 | 260 | 1,975 | 215 | 26,558 | 10,074 |
| grovedb-501 | 1 (+263 already measured) | 243 | 220 | 0 | 23 | 0 | 263 | 36 |
| instruckt-tauri-9 | 12 | 306 | 270 | 0 | 33 | 3 | 306 | 4 |
| kontor-385 | 128 | 9,224 | 7,833 | 256 | 992 | 143 | 9,774 | 863 |
| moltis-1064 | 962 | 84,292 | 75,684 | 367 | 7,116 | 1,125 | 91,879 | 11,320 |
| omamori-468 | 44 | 5,161 | 4,521 | 0 | 600 | 40 | 5,483 | 371 |
| pybun-428 | 61 | 9,815 | 8,737 | 125 | 842 | 111 | 10,012 | 316 |
| quebec-136 | 53 | 9,479 | 6,039 | 2,510 | 686 | 244 | 6,787 | 172 |
| whatsapp-rust-759 | 291 | 24,659 | 19,121 | 1,439 | 3,909 | 190 | 24,045 | 3,720 |

The files are not independent observations — one repository's style repeats across its files, and
moltis alone is 53% of the calls. The rates above are counts over this material, not estimates with
an interval; #80 decides how uncertainty is stated for the dev material.

### Is the oracle right?

- **Fixtures**: the oracle's count equals the hand count in all 13.
- **Broken on purpose** (`bench/logs/call-oracle-provisional-broken.json`): taking every method call
  out of the listing moves exactly the 99,257 detected method calls to `silent_miss` (detected
  136,914 → 37,657, silent 2,071 → 101,328) and no other form. A pairing that matched on the wrong
  key would move other forms too, or not all of these. Its first run moved 322 more — `..Default::default()`,
  whose `..` the check read as a method's dot, and `.r#type(` — which is how the check itself was
  corrected.
- **Annotated sample** (`bench/logs/call-oracle-labels-provisional.json`, seed 81): 70 items — 20
  `detected`, 20 `silent_miss`, 20 `false_positive`, 10 `declared_exclusion`; no `wrong_function` to
  draw. Three annotators agreed with the oracle on all 70, unanimously. An annotator who answered
  "yes" to everything would have agreed on 50. The sample was drawn from the first run, before the files declared
  test-only were taken out of scope; none of the 70 changed class with it, but `sample` run on
  today's rows draws a different 70. The annotators were not shown the parent's declaration either,
  so the sample could not have caught that.
