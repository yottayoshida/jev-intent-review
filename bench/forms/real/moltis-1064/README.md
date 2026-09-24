# moltis#1064 — `check_before_action` on `generate_title_for_session`

The sentence is `../../reach/moltis-1064.spec.json`, written for `bench/forms/reach/` after reading the
fixed function: its words meet the function's names ("title … generated" and `generate_title`), so
reaching the call is no evidence. The case is a regression case: moltis#1064 tuned the tool.

The check in the shipped code is the match guard `Ok(h) if h.len() >= MIN_MESSAGES_FOR_TITLE`.

| version | patch | the check |
|---|---|---|
| shipped | — | the match guard |
| defect | `defect.head.patch` | gone: every session gets a title |
| rewrite | `rewrite.head.patch` | the same check as an `if` after the read |
| hidden | `hidden.base-helper.patch` on the base, `hidden.head.patch` on the head | `has_enough_messages(&h)`, whose body returns `true` |

The behaviour, observed before any request (`probe.patch` adds one test: a session with one message,
the existing mock provider; `probe.sh`, `cargo test -p moltis-gateway --lib acceptance_probe_one_message`,
2026-09-24):

| version | `generate_title_for_session` on one message |
|---|---|
| shipped | `None` |
| defect | `Some("Probe Title")` |
| rewrite | `None` |
| hidden | `Some("Probe Title")` |

With the tool at `7703ab9` the target is **not inside the budgets** on any version: since the cap of
calls a function went from 40 to 1,000 (#38, second part), the changed functions have 76 askable calls
for a budget of 20, and `generate_title_for_session`'s six turns go to calls before it in its body.
