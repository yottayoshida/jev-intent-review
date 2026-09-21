# grovedb#500 — a failed height rewrite during a restore's finalize

Requirement, written from the pull request text before its diff was opened (candidates.json, order 23):

> If loading the root node or rewriting tree heights fails while a restore is being finalized, the failure must reach the caller as an error. It must not be discarded and the restore reported as finished.

Pull request: https://github.com/dashpay/grovedb/pull/500 — merge base `43f4253`, head `c0e0281`. The patches in this directory contain excerpts of grovedb, MIT License, Copyright (c) 2021 Dash Core Group; the full license is in `LICENSE.upstream`.

## Versions

| version | patch | what it does to `finalize` |
|---|---|---|
| shipped | — | `self.rewrite_heights(grove_version)?;` |
| defect-A | `defect-A.head.patch` | `let _ = self.rewrite_heights(grove_version);` — the form before the pull request |
| rewrite-A | `rewrite-A.head.patch` | `if let Err(e) = self.rewrite_heights(grove_version) { return Err(e); }` |
| hidden-A | `hidden-A.base.patch`, `hidden-A.head.patch` | `step_outcome(self.rewrite_heights(grove_version))?;`, with `step_outcome` returning its argument, placed at the merge base so it is outside the diff |

Every version changes the same function, `merk/src/merk/restore.rs · finalize`, as the shipped one (`changed-functions.ts`).

## Behaviour, observed

Built in a throwaway clone with the workspace narrowed to `merk` and its path dependencies: grovedb has no `Cargo.lock`, and another member pulls a crate whose every 0.3 release is yanked. `probe.patch` makes `verify_height` and `rewrite_heights` fail when `ACCEPTANCE_PROBE` is set, so the rewrite branch runs and its failure is what the version handles. Test: `cargo test -p grovedb-merk --lib restore_single_chunk_20`.

| version | without the injection | with it |
|---|---|---|
| shipped | passes | fails at `finalize`: `ChunkRestoringError(InternalError("probe: injected rewrite failure"))` |
| defect-A | passes | **`finalize` returns `Ok`**; the test then finds the restored tree's stored child heights differ from the source (`restore.rs:1022`) |
| rewrite-A | passes | fails at `finalize` with the injected error |
| hidden-A | passes | fails at `finalize` with the injected error |
