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
the existing mock provider; `probe.sh`, `cargo test -p moltis-gateway --no-default-features --features voice --lib acceptance_probe_one_message -- --nocapture`,
2026-09-24):

| version | `generate_title_for_session` on one message |
|---|---|
| shipped | `None` |
| defect | `Some("Probe Title")` |
| rewrite | `None` |
| hidden | `Some("Probe Title")` |

`probe.sh`, as it printed:

```
shipped test_rc=0 acceptance-probe: one message -> None
defect test_rc=0 acceptance-probe: one message -> Some("Probe Title")
rewrite test_rc=0 acceptance-probe: one message -> None
hidden test_rc=0 acceptance-probe: one message -> Some("Probe Title")
```

With the tool the measurement ran (`14ec498`, whose source differs from `7703ab9` in comments only)
the target is **not inside the budgets** on any version: since the cap of calls a function went from
40 to 1,000 (#38, second part), the changed functions have 76 askable calls for a budget of 20, and
`generate_title_for_session`'s six turns go to calls before it in its body — the six are
`as_ref()` twice, `read(session_key)`, `as_deref()` twice and
`moltis_agents::model::values_to_chat_messages(&history)`. `node bench/forms/real.ts precheck
<acceptance dir>`, sending nothing, printed for every version:

```
moltis-1064 shipped  exit 0, requests 0; inside the budgets 29, could be asked 85; target NOT inside
moltis-1064 defect   exit 0, requests 0; inside the budgets 29, could be asked 85; target NOT inside
moltis-1064 rewrite  exit 0, requests 0; inside the budgets 29, could be asked 85; target NOT inside
moltis-1064 hidden   exit 0, requests 0; inside the budgets 29, could be asked 85; target NOT inside
```

(85 askable counts the callers' and the siblings' too; the log records only that nothing was sent.)

Since the operation a requirement names takes its turn first in its function (ADR 0016), the target
is inside in every version, eighth of the 29 asked, and was measured against Jev
(`bench/logs/check-before-action-real-v2.json`).
