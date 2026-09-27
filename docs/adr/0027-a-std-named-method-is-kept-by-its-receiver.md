# 0027. A method named like one of the standard library's is kept on a definition only through what it is called on

Status: Accepted (the owner's rulings of 2026-09-27: read the receiver's type; a few correct calls may become unsettled, and the rows are listed — 15 of them, over the 10 first set)

## Context

ADR 0025 named three causes of the name reading's wrong calls; this is the first and the largest.
A method call — `x.len()`, `x.clone()`, `x.map_err(…)` — whose name the standard library also uses was
settled to the one function of that name this repository defines, whatever `x` is. On the record's
sample (`docs/resolution.md`), 283 of the 307 wrong calls left after #83's third part were that, and
20 more were the same rule meeting generated code.

Rust settles a method by the type of what it is called on, the type's own methods before any trait's,
through `Deref` one step at a time. This tool does not infer types. What it can read is what is
written: the `impl` a call is in, a parameter's or a `let`'s written type, a called function's written
return type.

## Decision

1. **Only narrowing.** For a method call whose name is one of the standard library's public, stable
   method names (`src/plan/std-methods.ts`, read from rust-src by `bench/std-methods.ts`: methods taking `self`, bare or
   typed, that are `pub` in inherent `impl`s or declared in `pub trait`s, `#[unstable]` and `#[doc(hidden)]`
   left out — 1,268 names on 1.98.1; methods a macro writes, the integer types' `pow` and `count_ones`
   among them, are not in it, and a call of one is read by its name as before), the definition the name reading chose is kept only when what the call is made on is one of
   this repository's types and the definition is in that type's `impl` (inherent or of a trait; an
   alias of the type, either way, is the same type). Otherwise the call is not settled
   (`callee_unresolved`, the reason naming the type or saying it was not read). Nothing is settled that
   the name reading had not settled; a set of versions stays the set. Path calls (`Foo::len(&x)`) and
   names the standard library does not use are read as before. **No new wrong call can come of it.**
2. **What is read** (`src/syntax/rust.ts` records a method call's receiver and each function's
   bindings; `src/plan/receiver-type.ts` reads them, three steps deep): `self`; a name bound by a
   parameter or `let` with a written type, or by a `let` set from a call or a name; an enum's variant
   (`Fuel::AddFile`); a call — its definition's written return type, `Self` being the `impl`'s, a set
   of versions read by its first, and `T::f(…)` found in `impl T` when `fn f` is too common to search.
   **Not read**: fields, `?`, `.await`, indexes, closure parameters, `for`, `if let`, `match` and other
   patterns, and any type a wrapper holds (`Box`, `Rc`, `Arc`, `Cow`, cells and locks) — `Arc<Foo>`'s
   `clone` is `Arc`'s.
3. **A type is this repository's** when its name comes from the file's own crate (`crate`, `self`,
   `super`, or no `use` bringing it from elsewhere — a glob from elsewhere counts) or from another crate
   of this workspace (`use grovedb_costs::CostContext`, the crate found by its `Cargo.toml` name), and a
   `struct`, `enum`, `union`, `trait` or `type` of that name is defined in that crate — an alias only when
   what it names is this repository's too (`type Nodes = Vec<Node>` is a `Vec`), and followed only when
   it is the name's one definition: a name defined as two aliases is taken as this repository's
   without following either. A standard-library
   type is never one, so a repository's `impl Trait for Vec<…>` does not keep `v.len()`: `Vec`'s own
   `len` goes first.
4. **Where the answer is used, it takes that name away.** The siblings' seeds read every call of such a
   name in the change; calls of it that settle apart, or one that does not settle, leave the name
   unsettled. (A name taken away frees a place under `MAX_SEEDS`, and a sibling held frees one under
   `MAX_SIBLINGS`, so another name or sibling may come in that the cap had left out. A removed line has
   nothing left to read what a call is made on, so a name it calls as a method is not settled there; a
   name it calls as a function is read as before.) A decisive check (ADR 0019) of such a name is sent
   only where every call of it in the function settles to this repository's definition; otherwise the
   call is held, whatever kept the call from settling. At the second level, a name a check's body calls
   as a method is named under `notSent`, not sent; a name it calls as a function is sent as before. `defined()` in the run, `readHere` and the callers' search are
   unchanged — each already errs toward holding or taking more.
5. **The bar**, fixed before measuring and amended by the owner once measured: no new wrong call;
   wrong calls of this form fall; at most 15 correct calls (`same`, versions included) become
   unsettled, each listed in `docs/resolution.md`.

## Alternatives Considered

- **Settle only when the receiver is `self`.** Fixes as many wrong calls and loses about 53 correct
  ones. The owner chose to read the type.
- **Read the receiver's type and settle by it anew** — including calls the name reading had left
  unsettled. Reaches more, and can make wrong calls where the type is misread (242 unsettled calls on
  the sample were open to it). Not now; a separate promise.
- **Read fields, `?`, `.await` and patterns too.** Would keep a handful more correct calls (the
  sample's lost ones are mostly an inner call with several definitions of different return types,
  which fields would not settle either) and adds the most places to misread a type.

## Consequences

- On the sample: 254 wrong calls are unsettled, 12 more are counted as generated, none becomes wrong,
  and 15 correct calls are unsettled — nine where the inner call's name has several definitions
  returning different types, two closure parameters, and a `match`, a `?` and two bindings not read.
- A method the standard library names that a trait's default body or a blanket `impl<T: X> Ext for T`
  defines here is no longer settled: its `impl` is no one type's.
- A call held here frees its place in the budget, and ADR 0015 gives what the changed functions leave
  to their callers: on moltis#1064 the changed functions ask 11 calls where they asked 20 and the callers
  19 where they asked 10, the total unchanged at 30 (`bench/logs/budget-by-origin-v5.json`). So a run
  may ask about calls it did not before — never more than the budget — and the known targets of the
  acceptance runs came earlier (moltis#1064's B 22nd → 13th). The owner accepted it (2026-09-27).
- The table follows rust-src's version; `bench/std-methods.ts` writes it again.
