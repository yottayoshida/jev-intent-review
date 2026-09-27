# 0025. Resolving a call by its name: trusted nowhere yet, ambiguous for plain and path calls, unsupported for methods, macro arguments and callers

Status: Accepted (the owner's ruling of 2026-09-26: declare the boundary in stages, fix the causes next)

Numbered 0024 when it was merged (pull request #115, commit `92a2243`), beside another 0024 that reached
main first (`0024-the-sealed-set-is-opened-once-checked.md`); renumbered 0025.

## Context

The product settles a call's definition by its name (`calleeOf`) and a changed function's callers by
searching for its name (`sitesFromChange`). Nothing compiles the code. #83 asked where that can be
trusted, and #37 for a record of where a relation by name was wrong or voided.

`docs/resolution.md` is that record: rust-analyzer's SCIP index against the product on #81's nine dev
cases, 144,536 listed calls, 6,121 of them sampled per case and form, the changed functions' callers,
and a rename-and-`cargo check` of rust-analyzer's answers. The criteria were fixed in the plan before
measuring, over the *decided* calls (settled by rust-analyzer to one definition; the product's
`voided` counted in): trusted when the pooled upper bound of `wrong` is at most 1%, no repository over
5%, `voided` at most 20% and at least 300 decided calls; unsupported when `wrong` is over 5%;
ambiguous between. On the calls the product asks about:

| form | wrong, of decided | upper 95% | wrong, of the calls the product settled | voided | verdict |
|---|---|---|---|---|---|
| `foo(x)` | 1.4% | 2.6% | 1.7% | 14.8% | ambiguous |
| `a::foo(x)` | 2.5% | 4.0% | 6.5% | 61.6% | ambiguous |
| `x.foo()` | 10.4% | 12.5% | 38.1% | 72.7% | unsupported |
| inside a macro's arguments | 10.0% | 12.2% | 36.2% | 72.4% | unsupported |
| callers of a changed function | 26 of 72 (36%) | — | — | — | unsupported |

What is wrong has three shapes, one cause each. Of 312 wrong sampled calls, 307 are a
standard-library, dependency or generated method — `len`, `clone`, `map_err`, `unwrap`, a derived
`clone` — settled to the one handwritten function (or versions of one thing) of that name the
repository defines: the rule *a name defined once
is that definition*, which does not look at the receiver. Renaming the product's pick breaks none of
20 such calls; the call goes elsewhere. Four are a row of the table outside (ADR 0011) matched by
the call's last segments to another crate's function of that name (tokio's `fs::write` read as std's).
Between two of the repository's own functions, a relation by name was wrong once. Beside `wrong`,
10 asked calls are counted as `dispatch` and are as plainly wrong: a default method of a trait that
is not the repository's, settled to a function of the repository.

The callers' search takes a function in which the changed function's name appears as its caller: another function
of the same name (17 of 72 — a hasher's `finalize` in every crate), a comment (4), a string (3), a
parameter or a local closure of the same name (2).

`voided` is mostly a library callee the table does not hold, which the product declines to guess.
The rest — 295 of the asked 1,819 — are relations in the repository the product lost; renaming
rust-analyzer's definition breaks 20 of 20 of those checked (17 of them in one repository).

## Decision

1. **The boundary is declared per form, as measured.** Resolution by name is **trusted for no form**.
   Plain and path calls are **ambiguous**: of the plain calls the product settles, about 1 in 60 is
   another definition, of the path calls about 1 in 15. Method calls, calls inside a macro's
   arguments, and the callers found by name are **unsupported**: more than a third of the method and
   macro calls the product settles, and a third of the callers, are another function or none.
2. **`resolutionOf`** (`src/plan/applicability.ts`) reads `calleeOf`'s answer as `resolved` (one
   definition here, or a row of the table), `ambiguous` (versions of one thing, several and none
   chosen, or definitions compiled only for tests) or `unsupported` (none reached). The axis is where
   the callee settled, not whether it returns a `Result`. A `versions` location lists every
   definition in `all`. Nothing in the product reads either yet; the record does, and the next change
   will.
3. **The causes are fixed next, and measured with this record's bench** (`bench/resolution.ts`),
   whose classes, sample and criteria stay as they are:
   - a method call is not settled to the repository's one definition of its name on the name alone;
   - a row of the table outside matches only when the call names the row's crate, or nothing here
     brings another crate's function of that name in;
   - the callers' search takes a function as a caller only where a line naming the changed function
     refers to it — a call, or the function passed as a value — leaving out comments, strings, fields
     and a parameter or local of the same name (a local binding of the same name that is called stays:
     1 of the 9); a line the parser did not read as calls is taken as before. (Worded when the fix was
     made, in #83's third part: first written as "only where its listing holds a call of that name",
     which would have dropped the function passed as a value.)
   A fix is kept when `wrong` falls and neither `same` nor the callers rust-analyzer confirms falls.
4. **rust-analyzer is not built into the product.** It is the oracle here, and stays one.

## Alternatives Considered

- **Build rust-analyzer into the product.** It resolves what the product cannot. Indexing moltis took
  four minutes and 9 GB; the Action would need a toolchain and every dependency fetched and build
  scripts run (grovedb does not resolve its dependencies at all without a patch). Not ruled out for
  later; not the next step, while the measured errors have one cause each.
- **Document the numbers and change nothing.** Leaves more than a third of the method calls the
  product settles, and a third of the callers, pointing at the wrong function with no path to fewer.

## Consequences

- Reports and docs that say a call "reaches" a definition mean the name reading's answer, which this
  ADR calls ambiguous at best; `docs/local-check-cli.md` points to the record.
- The record covers eight repositories. Dev has 80 since #80's second batch; a fix measured here is
  measured on these eight.
- The rustc check reached four of the eight repositories (the others do not build here) and `same`
  broke on 18 of 20, under its bar of 95%: one a trait implementation's method, whose rename breaks the
  `impl` and not the call, one a call in `benches/`, which `cargo check --workspace` does not build.
  Neither is rust-analyzer naming another definition; a later use of the check should build
  `--all-targets` and leave trait implementations out of the frame, fixed before it runs.
