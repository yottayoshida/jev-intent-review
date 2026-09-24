# grovedb#500 — `check_before_action` on `finalize`

The sentence is `../../reach/grovedb-500.spec.json`, written for `bench/forms/reach/` after reading the
fixed function: its words meet the function's names ("heights … rewritten / verifying the heights" and
`rewrite_heights` / `verify_height`), so reaching the call is no evidence. grovedb#500 is a regression
case, and this sentence also tuned how a call's name meets a requirement's words (`res` is not
`restore`, `src/plan/forms.ts`).

The check in the shipped code is `if self.verify_height(grove_version).is_err()`.

| version | patch | the check |
|---|---|---|
| shipped | — | `if self.verify_height(..).is_err()` |
| defect | `defect.head.patch` | gone: the heights are rewritten on every finalize |
| rewrite | `rewrite.head.patch` | `if let Err(_) = self.verify_height(..)` |
| hidden | `hidden.base-helper.patch` on the base, `hidden.head.patch` on the head | `self.heights_need_rewrite(..)`, whose body returns `true` |

The behaviour, observed before any request (`probe.patch` prints a line when `rewrite_heights` runs;
`probe.sh`, `cargo test -p grovedb-merk --lib restore_multi_chunk_20_no_limit`, 2026-09-24). That
test is a restore that ends with the heights right — measured: `verify_height` is `Ok` at its
finalize, where `restore_single_chunk_20`'s is not:

| version | `rewrite_heights` ran |
|---|---|
| shipped | 0 times |
| defect | 1 time |
| rewrite | 0 times |
| hidden | 1 time |

Rewriting heights that are right gives the same heights: the test passes on every version, and a user
sees no difference but the work. The defect is a check skipped, not a wrong result.
