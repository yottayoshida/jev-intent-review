# The two mutations of `staging_info_from`

`docs/real-requirement-check.md` says the three branches are kept for a later regression. The
branches themselves were made in a scratch clone that a sweep empties, so what is kept is here:
the two patches, against a commit that is pinned and public. That is enough to rebuild all three.

```sh
git clone https://github.com/yottayoshida/omamori
cd omamori && git checkout 916d954607f1f22a4326feb59c76c2197f540bc9 -b correct
git checkout -b mutant  correct && git am < .../mutant.patch
git checkout -b variant correct && git am < .../variant.patch
```

| patch | what it does | what it costs |
|---|---|---|
| `mutant.patch` | `collect_listing(entries).map_err(…)?` becomes `Err(stop) => stop.seen`: a listing that stopped partway is returned as a success carrying what it saw. | `cargo test --lib`: 1457 passed, **1 failed** — `staging_listing_that_stops_partway_is_reported_as_unreadable`, panicking with `got "  [Staging] empty\n"`. That string is the defect issue #485 was filed about. |
| `variant.patch` | The `oldest_mtime` choice written as `map_or(mtime, \|prev\| prev.min(mtime))`. Nothing on the enumeration-failure path. | `cargo test --lib`: 1458 passed, 0 failed — identical to the unpatched commit. |
| `dep-mutant.patch` | **`src/util.rs` only**: `collect_listing`'s error arm becomes `Err(_) => continue`, so it returns `Ok(seen)` for a listing that stopped. `src/cli/doctor.rs` is untouched — `git diff` against the base for that file is empty. | The same targeted test fails with the same `got "  [Staging] empty\n"`, with `staging_info_from` byte-identical to the shipped one. |

`dep-mutant` is the case that settles what a packet without the dependency can and cannot do:
its `staging_info_from` and the shipped one are the same bytes, and the correct answers about them
are opposite. `bench/dependency-check.ts` checks that byte-identity on every run rather than
assuming it.

The unpatched commit is 1458 passed, 0 failed, 1 ignored. One test out of 1459 separates the
mutant, and it is the test for the property under measurement, which is what makes it a minimal
mutation rather than a broad break.

Both were applied to a clone, never to a checkout anyone works in, and neither is proposed for
omamori.
