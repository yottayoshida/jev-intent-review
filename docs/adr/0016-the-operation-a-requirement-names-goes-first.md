# 0016. Under `check_before_action`, the operation a requirement names goes first in its function

Status: Accepted

## Context

`check_before_action` asks about a call when its name and the requirement share a word: the call's
whole path and the receivers right before it (`self.ledgers.insert` gives `ledgers`). Inside a
function that the change touched, the askable calls were asked in the order they appear. On
moltis#1064 (#39) the call the sentence is about — "A title must not be generated for a session that
has fewer messages than the minimum." and `moltis_agents::title::generate_title(provider,
&chat_msgs)` — sits below five calls that meet it only through a receiver (`session_store.as_ref()`,
`session_metadata.as_ref()`, `session_store.read(session_key)`, `session_model.as_deref()` twice) and below one that meets it by
name (`values_to_chat_messages`).
Once the cap of calls a function went from 40 to 1,000 (#38), the changed functions had 76 askable
calls for a budget of 20, the function got six turns, and the guarded call was the seventh: outside
the budget in every version, so the second kind could not be measured there
(`bench/logs/check-before-action-real-v1.json`).

## Decision

In the budget of the functions the change touched, a call whose own name — the last part of its
path — meets the requirement's words takes its turn after the calls into a changed function and
before every other askable call. The form marks it (`names` on the askability); the failure form
marks none, so its order does not change. The callers' and the siblings' budgets keep their order.

## Alternatives considered

- **Order by how many words meet.** A finer scale is more to tune; with two tiers the named calls
  keep their line order, and on moltis#1064 the one named call above the guarded one does not push
  it out (the function has six turns).
- **Hold the calls met only through a receiver.** It changes which calls can be asked about, and
  gives up asking `self.ledgers.insert` under a sentence about ledgers.
- **A larger budget, or the same tier in the callers' and siblings' budgets.** The first moves the
  failure form's measurements (#38); the second has no case that needs it.

## Consequences

- moltis#1064's guarded call is inside the budget in every version (eighth of 29); grovedb#500's
  keeps its place. Measured with no request (`bench/forms/real.ts precheck`).
- The rule was made for the case it is shown on. Its reason is the form's definition (a sentence of
  this form names the operation), not the case's names; the opposite shape — a defect in a call met
  only through a receiver, beside a named call — is not measured.
