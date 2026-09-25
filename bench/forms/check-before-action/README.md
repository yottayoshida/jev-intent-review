# The constructed case for `check_before_action`

One requirement — "A disabled API key must never create a session." (`spec.json`) — against seven
versions of one file, `auth.rs`. `store.rs` is the same in every version. `base.rs` is the commit the
change is measured from: it calls `record_use` where the others call `audit`, so that every version
is a change to `open_session` and the run reaches it from the diff.

| version | what `open_session` does with a disabled key | `main.rs` (`rustc`, 2026-09-22) |
|---|---|---|
| `shipped` | refuses before `create_session` | `login(disabled)=refused` |
| `defect` | audits, then creates the session anyway | `login(disabled)=session` |
| `rewrite` | the same refusal, written as the other branch | `login(disabled)=refused` |
| `hidden` | calls `reject_disabled`, whose body does nothing | `login(disabled)=session` |
| `helper` | calls `reject_disabled`, whose body checks (`is_disabled`) — the same call sites as `hidden` | `login(disabled)=refused` (2026-09-25) |
| `caller` | creates the session; `login` refuses before calling it | `login(disabled)=refused`, `open_session(disabled)=session` |

`expected.json` was written before any request was sent and `run.ts` records its hash at the head of
the log. `shipped`, `defect`, `rewrite`, `hidden` and `helper` are scored since version 2 of the table (ADR 0020:
`hidden` is the defect it is once the check's body goes with the packet and the case is assumed (the words adopted; the check's value is not read apart); `helper` tells a check that
checks from one that does not); `caller` is recorded as the limit it is. The names were chosen so the requirement's words meet the calls, so this case does
not count as unseen: what it can show is whether the form separates a defect from the shipped code
and a rewrite on code written for it.

- `node bench/forms/run.ts precheck` — which calls each version would ask about; sends nothing.
- `node bench/forms/run.ts measure` — three runs of each version against real Jev
  (`JEV_PROVIDER` and that host's key), scored against the table. Log: `bench/logs/check-before-action-v1.json`;
  the first measurement, before a call into a function the run reads on its own was held, is `-v0.json`.

The same form on the code of the acceptance set's pull requests is `../real/` (`real.ts`, #39).
