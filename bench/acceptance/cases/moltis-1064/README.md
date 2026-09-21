# moltis#1064 — a failed title generation

Requirement, written from the pull request text before its diff was opened (candidates.json, order 19):

> If generating a session's automatic title fails, the failure must reach the caller as an error. It must not return a successful result with no label.

Pull request: https://github.com/moltis-org/moltis/pull/1064 — merge base `a30a6b6`, head `4106d46`. The patches in this directory contain excerpts of moltis, MIT License, Copyright (c) 2025 Fabien Penso.

This case also carries the defects outside the diff (candidates.json, `whichCaseCarriesBAndC` in targets-fixed.json).

## Versions

| version | patch | what it does |
|---|---|---|
| shipped | — | `generate_title_for_session`: `let title = moltis_agents::title::generate_title(provider, &chat_msgs).await?;` |
| defect-A | `defect-A.head.patch` | `let Ok(title) = …generate_title(…).await else { return Ok(None); };` |
| rewrite-A | `rewrite-A.head.patch` | `match …generate_title(…).await { Ok(title) => title, Err(e) => return Err(e) }` |
| hidden-A | `hidden-A.base.patch`, `hidden-A.head.patch` | `settle_step(…generate_title(…).await)?`, with `settle_step<T, E>` returning its argument, placed at the merge base |
| defect-B | `defect-B.base.patch` | `dispatch_command`, a caller of the changed `handle_title` that the pull request did not touch: `.or_else(\|_\| Ok(String::new()))` on the `"title"` arm — at the merge base, so the pull request did not fix it |
| defect-C | `defect-C.base.patch` | `moltis_agents::title::generate_title`, called by nothing the pull request changed and changing nothing: the `Err` arm of the model call returns `Ok(String::new())` — at the merge base |

Every version changes the same seven functions as the shipped one (`changed-functions.ts`).

## Behaviour, observed

Built with `cargo test -p moltis-gateway --no-default-features --features voice`: the default features build llama.cpp from C++ with cmake, which title generation does not use, and with no features at all the crate does not compile (`moltis_voice` is imported unconditionally).

| version | test | result |
|---|---|---|
| shipped | the pull request's `generate_title_for_session_returns_provider_errors` | passes |
| defect-A | same | **fails**: the provider's error comes back as `Ok(None)` |
| rewrite-A | same | passes |
| hidden-A | same | passes |
| shipped | `probe-C.patch`: `generate_title` with a provider that always fails | passes — `Err` |
| defect-C | same | **fails**: `generate_title returned Ok("")` |
| defect-B | — | **not run.** Reaching `dispatch_command` needs a gateway state, a channel binding and a session holding two messages, which no existing test builds. The defect is one line whose effect is read from the code, not observed. Its measured result does not depend on it: the target is held before any question is put. |
