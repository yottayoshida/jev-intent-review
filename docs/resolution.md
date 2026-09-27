# Name resolution against rust-analyzer (#83)

**On #80's dev material, every call the listing holds is paired with rust-analyzer's index, and for a
fixed sample of them per form and for every caller of a changed function there is a record of whether
the definition the product settled by name is the one rust-analyzer settles, a different one, or none
(and why); which relations are trusted and which are ambiguous or unsupported is decided from that
record by ADR 0025.**

The product finds a call's definition by its name (`calleeOf` in `src/plan/applicability.ts`,
*Which definition a call reaches* in `docs/local-check-cli.md`) and a changed function's callers by
searching for its name (`sitesFromChange` in `src/plan/from-diff.ts`). Neither compiles anything.
This measures, against a reader that does, where that goes wrong. It is also #37's record of the
places a relation by name was wrong or voided.

The classes, the sample, the coverage floor and the criteria below were fixed in the plan before
the first measurement. Changed after the first run, each for a reason found in the record and none
moving a call between `same` and `wrong`:

- a symbol of the repository's own crate with no definition in the index — a `#[derive]`, a macro's
  output, or a definition in a file the index does not hold — was read as outside the repository. It
  is `oracle_generated` now, apart from the judgement, unless the product settled a definition in a
  file the index holds: generated code has no source, so that pick is another definition and `wrong`
  (the first and second reviews of the change);
- the plan gave a trait's method called on a concrete type as `same_in_versions`; rust-analyzer names
  the implementation's method there (`same` when the product settled it), and a default body by the
  trait (`dispatch`, below);
- `voided` is split by where rust-analyzer's answer is, and the wrong rate is also given over the
  calls the product settled;
- on the callers' side, code compiled only for tests is taken out of rust-analyzer's callers (the
  listing leaves it out, so its callers were never the product's to find), and a caller rust-analyzer
  does not confirm is given a reason.

## The oracle

`bench/resolution-oracle/` reads [SCIP](https://github.com/sourcegraph/scip) indexes written by
`rust-analyzer scip` (rust-analyzer 1.97.1), which resolves names as the compiler does: types,
traits, imports, re-exports and macro expansions. For every place a name is used it gives the
symbol, and for every symbol the repository defines, where and over which lines. Columns are turned
from the index's UTF-8 into the product's UTF-16.

Each case is indexed at the commit the product reads. A repository with no manifest at its root
(Kontor) is indexed once per Cargo project. grovedb has no `Cargo.lock` and a git dependency asks for
versions of `core2` and `halo2_gadgets` that are all yanked, so `cargo metadata` fails and
rust-analyzer indexes a third of the files; the same versions are taken from their tags by a Cargo
config next to the clones, never in one (`CARGO_PATCH` in `bench/resolution.ts`).

A call is paired with the index at its callee's last name — the position of `load` in
`crate::a::load(x)` and in `x.load()`. A repository where fewer than 90% of the listed calls have any
symbol there is left out on both sides. None was: the lowest is grovedb-500 at 92.9%.

## What a call is classified as

The axis is where the product settled (`at`), not whether it could ask: a callee settled to the
right definition that does not return a `Result` is `same`, with its reason kept beside it.

| class | product | rust-analyzer |
|---|---|---|
| `same` | one definition here, or a row of the table outside | the same definition (the name's line inside the item it names), or the same crate and name |
| `same_in_versions` | several read as one thing | one of them |
| `wrong` | a definition | a different one |
| `voided` | none (`callee_unresolved`, `callee_ambiguous`, a cut search) | one |
| `both_unresolved` / `oracle_unresolved` | none / one | none |
| `dispatch` | anything | a method declared in a trait, with or without a default body |
| `macro_rules` | anything | a macro |
| `oracle_generated` | anything | a symbol of the repository's own crate with no source: a `#[derive]`, a macro's output |
| `oracle_not_fn` | anything | not a function: a tuple struct, an enum variant, a closure in a variable |
| `oracle_ambiguous` | anything | more than one function at the same place |

The trust judgement reads `same`, `same_in_versions`, `wrong` and `voided` (*decided*); the others are
counted beside them.

`dispatch` is not only a call through `dyn` or a generic: rust-analyzer names a trait's default method
by the trait even when it is called on a concrete type (`it.map(f)` on an iterator,
`Message::decode` of a dependency's trait). A callee the product settled in this repository for a
trait that is not this repository's is plainly wrong, and is counted as `dispatch`, not `wrong`: 10
of the asked calls, in the column below.

## The sample

144,536 calls are listed (moltis alone 78,661). Every one is paired for coverage; `calleeOf` is run
on up to 200 per case and form — `function` (`foo(x)`), `path` (`a::foo(x)`), `method`
(`x.foo()`), `macro` (inside a macro's arguments) — chosen by the hash of a fixed seed and the
call: 6,121 calls. `asked` is the subset in a function that returns a `Result`, where the product
puts questions.

## The record

`bench/logs/resolution-dev.json`; the `wrong` and `voided` rows are in
`bench/logs/resolution-dev-rows.jsonl`.

The calls the product puts questions on (`asked`). *Wrong* is over the decided calls, as the criteria
are; *wrong of settled* leaves `voided` out — what a callee the product did settle is worth:

| form | calls | decided | same | in versions | wrong | upper 95% | worst repository | wrong of settled | voided (rust-analyzer's answer here) | dispatch (settled here, trait outside) | generated | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| function | 769 | 690 | 573 | 5 | 10 (1.4%) | 2.6% | 5.8% | 1.7% of 588 | 102 (85) | 1 (0) | 3 | ambiguous |
| path | 887 | 640 | 227 | 3 | 16 (2.5%) | 4.0% | 9.8% | 6.5% of 246 | 394 (78) | 10 (4) | 37 | ambiguous |
| method | 1,114 | 983 | 162 | 4 | 102 (10.4%) | 12.5% | 24.6% | 38.1% of 268 | 715 (59) | 92 (3) | 23 | unsupported |
| macro | 906 | 840 | 145 | 3 | 84 (10.0%) | 12.2% | 22.9% | 36.2% of 232 | 608 (73) | 27 (3) | 8 | unsupported |

Every sampled call, asked or not, gives the same picture: `function` 1.0% wrong (upper 1.8%), `path`
2.1% (3.0%), `method` 10.6% (12.3%), `macro` 8.2% (9.8%).

**What is wrong.** Of the 312 `wrong` sampled calls, 283 are the product settling the one definition
in the repository of a name whose callee rust-analyzer finds outside it — `len`, `clone`, `display`,
`map_err`, `map`, `unwrap`, `iter`, `to_string` on a standard-library or dependency type. That is the
rule *a name defined once is that definition*, which does not look at the receiver. 20 more are the
same rule meeting generated code — a derived `clone`, `default`, a `wit` binding — settled to the
repository's handwritten function of that name; four more, versions of one thing with the same shape. Four are a row of the table outside
(ADR 0011) taken for another crate's function of the same last name — `tokio::fs::write` and tokio's
`File::open` read as std's — because a row is matched by the call's last segments only. One is a
choice between two definitions here (moltis `run_systemctl`, one per crate).

**What is voided.** Most `voided` calls are ones rust-analyzer settles outside the repository — a
library's method the table does not hold — and the product says so rather than guess. The ones it
settles here (`asked`: 295 of 1,819) are relations the product lost: a name defined several times and
not narrowed, a path through a re-export or a `use … as`. A further 71 asked calls reach something the
repository generates, or a definition in a file the index does not hold, and the product settled
nothing handwritten in an indexed file for them (`oracle_generated`).

### Callers

For the changed functions of the nine cases, the functions the product takes as their callers
against the functions rust-analyzer finds a reference in, outside tests on both sides. Of the 70
changed functions, 66 have a definition in rust-analyzer's index; four of instruckt-tauri's do not
(`resolve`, `get_source_location`, `get_component_stack`, `get_project_structure`), and their callers
are not on rust-analyzer's side.

| | |
|---|---|
| the product's callers | 72 |
| of which rust-analyzer confirms | 46 |
| of which the name there is another function's | 17 — grovedb-500's `finalize` alone gives 11, a hasher's `finalize` in every tree crate |
| of which the name is not the changed function's at all | 9 — in a comment (4), in a string (3: "Directory to analyze"), a parameter or a local closure of the same name (2) |
| rust-analyzer's callers the product did not reach, caps aside | 2 of 48 |
| behind a cap (`MAX_HOP_NAMES`, a name in more than 20 files, `MAX_CALLER_FUNCTIONS`) | 35 |

26 of 72 (36%) are not callers: verdict **unsupported**.

## The record after two of the fixes (#83, third part)

ADR 0025 named three causes. Two are fixed, and measured with the bench above unchanged — the same
sample, the same classes — row by row against the record before them:

- **A row of the table outside is matched only from its own crate** (`outsideResult` reads the
  file's `use` statements): the four calls that matched a row by their ending from tokio —
  `tokio::fs::write`, `tokio::fs::remove_file`, a `fs::create_dir_all` under `use tokio::{fs, …}`,
  a `File::open` under `use tokio::{fs::File, …}` — are `voided` now. A name no `use` brings in is
  matched by its ending as before, so no call the table matched correctly was lost. Asked path calls:
  wrong 16 → 13, wrong of settled 6.5% → 5.3%. No verdict changes.
- **A raw string ends at its own closing quote** (`codeOnly`, which reads signatures and definitions
  too): `r#"<?xml version="1.0" …"#` ended at its first inner `"` and the lines after it were blanked,
  so moltis's second `fn run_systemctl` was not seen and its one call settled to the other crate's.
  It is `voided` now — the one `wrong` between two of the repository's own definitions. Nothing else
  moved: of the 6,121 sampled calls, five changed class, all `wrong` to `voided`.
- **A caller is taken only where its line reads as a call** (`readsAsCall` in `from-diff.ts`): the
  product's callers 72 → 65 and those that are not callers 26 → 18 — the eight lines that named a
  changed function in a comment (4), a string (3) or a parameter (1) are gone; the ninth, a local
  binding of the same name that is called, stays. A line that passes the function as a value
  (`.map(name)`) is still a caller; one that uses a parameter or local of that name is not. The callers rust-analyzer confirms rose 46 → 47: in
  omamori, a line that was not a call had taken one of `MAX_CALLER_FUNCTIONS`' 20 places, and a real
  caller has it now. Still **unsupported** (18 of 65, 28%): 17 of the 18 are another function of the
  same name (grovedb-500's `finalize` alone 11), which this does not fix.

On the acceptance runs (`bench/budget-by-origin.ts`, `bench/logs/budget-by-origin-v4.json`, before = `5f2f922`), every known target is inside the budget where it was, and every check holds on all 20 runs; the callers' askable calls change with who is a caller — pybun#428 90 → 36, omamori `#468` 55 → 60 (a real caller in place of a line that was not a call), Kontor#385 24 → 23.

The third cause — a method called on a standard-library or dependency type settled to the one
function of that name here — is 283 of the 307 wrong calls left, and is the fourth part's.

## The record after the third fix (#83, fourth part, ADR 0027)

A method call whose name the standard library uses for a public method keeps the definition the name
reading chose only when what it is called on is one of this repository's types whose `impl` holds it.
Measured with the same bench, row by row against the record after the second and third fixes:

- **254 `wrong` calls are not settled** (method 147, macro 107), and 12 more reach code the repository
  generates, so are `oracle_generated`. **No call became `wrong`.**
- **15 `same` calls are not settled** (method 9, macro 6). The owner's bar: at most 10 before
  measuring, 15 once measured (ADR 0025, ADR 0027). Why each could not be read:

  | case | place | call | why |
  |---|---|---|---|
  | grovedb-501 | `merk/src/merk/restore.rs:209`, `:217` | `tree.hash().unwrap()` | `hash` has 12 definitions here, of different return types |
  | grovedb-501 | `merk/src/merk/restore.rs:265`, `:301` | `value_hash(…).unwrap()` | `value_hash` has 5 definitions, of different return types |
  | grovedb-501 | `merk/src/merk/restore.rs:440`, `:453` | `….walk(…).unwrap()` | `walk` has 4 definitions, of different return types |
  | grovedb-501 | `merk/src/merk/restore.rs:403` | `.storage.put(…).unwrap()` | `put` has 12 definitions, called on a field |
  | grovedb-500 | `grovedb/src/operations/auxiliary.rs:99` | `aux_storage.delete_aux(…).map_err(…)` | `delete_aux` has 13 definitions |
  | grovedb-500 | `grovedb-merkle-mountain-range/benches/mmr_benchmark.rs:17` | `mmr.push(…).unwrap()` | `push` has 2 definitions |
  | grovedb-500 | `grovedb/benches/branch_chunk_queries.rs:2447` | `latency_stats.max()` | the binding is not read |
  | grovedb-500 | `grovedb/src/batch/estimated_costs/average_case_costs.rs:377` | `k.as_slice()` | a closure's parameter |
  | quebec-136 | `src/config.rs:50` | `q.to_string()` | a closure's parameter |
  | omamori-468 | `src/engine/hook.rs:1474` | `logger.append(event)` | `let logger = match …` |
  | pybun-428 | `src/commands/install.rs:1193` | `project.path()` | `let mut project = …?` |
  | moltis-1064 | `crates/browser/src/detect.rs:583` | `command.display()` | the binding is not read |

- Of the `dispatch` calls the product had settled here, 6 macro and 5 method ones are not settled now —
  10 of them for a trait that is not this repository's, so no longer wrong in effect, and one method
  call that may have been right; they are outside the counts above, as `dispatch` always is.

The calls the product asks about:

| form | wrong | upper 95% | wrong of settled | voided | verdict |
|---|---|---|---|---|---|
| function | 10 (1.4%) | 2.6% | 1.7% | 103 (14.9%) | ambiguous |
| path | 13 (2.0%) | 3.4% | 5.3% | 397 (62.0%) | ambiguous |
| method | 5 (0.5%) | 1.2% | 3.0% (was 38.1%) | 813 (83.2%) | ambiguous (was unsupported) |
| macro | 2 (0.2%) | 0.9% | 1.4% (was 36.2%) | 693 (82.5%) | ambiguous (was unsupported) |

On the acceptance runs (`bench/budget-by-origin.ts`, `bench/logs/budget-by-origin-v5.json`, before = `139d2df`),
every check holds on all 20 runs and every known target is inside the budget, no later than before
(earlier on two: moltis#1064's B 22nd → 13th of 30, grovedb#500's B 7th → 5th). The places set-aside
calls leave go to the callers (ADR 0015): moltis#1064's changed functions ask 11 where they asked 20,
its callers 19 where they asked 10. `--candidates-only` on moltis#1064 took 31.0 s where it took
32.7 s (one run each, in the same log).

Method calls and calls inside a macro's arguments are ambiguous now, not unsupported: of what the
product settles there, about 1 in 30 is another definition. They are not trusted: the upper bound is
over 1%, and most such calls are not settled at all (`voided` 83%).

## Checks

- **The classes, by name**: `test/resolution.test.ts` runs rust-analyzer's committed index of
  `test/fixtures/resolution/crate` — two functions named `load`, a trait's method through `dyn` (with
  and without a default body) and on a concrete type (an implementation's, and a default body),
  `std::fs::read`, a tuple struct, a closure, a macro's arguments, a line with `é` before the call,
  and a caller of the other `load`. The product's answers there are written by hand; the pairing of
  real listings to the index is checked by the coverage (a wrong column pairs nothing) and by the next
  check.
- **The pairing moves when the reading is broken** (`bench/logs/resolution-dev-broken.json`): moving
  each settled answer to another definition moves exactly the 1,730 `same` calls that were settled
  in the repository to `wrong` (1,730 of 1,730); the 117 settled outside stay.
- **rust-analyzer against rustc** (`bench/logs/resolution-rustc-dev.json`): in a scratch clone, the
  definition rust-analyzer names is renamed and `cargo check --workspace` run; an error at the call,
  or an unresolved import of the name in the call's file, is a break. 20 rows per class, in the order
  of a hash of the seed, from the projects that build before any rename — omamori, pybun, quebec and
  instruckt-tauri; grovedb, Kontor, moltis and whatsapp-rust do not build here (a yanked dependency,
  a wasm target, a C++ build, a toolchain file this `cargo` does not read), and their 156 rows were
  passed over and counted. `voided`: 20 of 20 break — the relations the product lost are real — but
  17 of the 20 are quebec's, 12 of them two definitions of `col`, so the 20 are not 20 independent
  places. `wrong`, the other way round: renaming the product's own pick breaks 0 of 20 — the call does
  not go there; two of the 20 (`serde_yaml::from_str` settled to an `impl FromStr`'s, a `default`
  settled to an `impl Default`'s) could not have broken the call either way, as below. `same`: 18 of 20 break, under the bar of 95% fixed before; neither of the two is
  rust-analyzer naming another definition. One is `Self::default()` settled to the `default` of an
  `impl Default for …`, where a rename breaks the `impl` and not the call; the other is a call in
  `benches/`, which `cargo check --workspace` does not build. The check was not changed after it ran.

## What this does not say

- Only the nine cases of #81's material, eight repositories: dev has 80 since #80's second batch,
  and indexing the rest was not done (moltis took four minutes and 9 GB).
- Where the call reaches, not what it returns: a `same` call may still be one the product cannot
  ask about.
- The sample is at most 200 per case and form, so the pooled rates weigh small repositories as much
  as moltis. The worst repository is given beside each.
