# 0028. The bodies of what the change calls are read too, and a method on `dyn T` is `T`'s

Status: Accepted

## Context

The local check reads the functions a change touched, their callers one hop out, and the siblings:
the other callers of what the changed code calls (ADR 0005, amended by 0015). A defect inside a
function the changed code calls — the callee's own body — is in none of the three. moltis#1064's
defect-C is of that kind: `generate_title` turns the failure of `provider.complete(…)` into
`Ok(String::new())`, the pull request's `generate_title_for_session` calls `generate_title`, and the
run lists no call inside it (#38's close moved it to #37).

Reaching it would not be enough. `provider` is written `Arc<dyn LlmProvider>`, and `complete` is a
method of three traits here (`LlmProvider`, `LlmClient`, `LocalBackend`) and a free function, so the
name reading leaves it ambiguous and the call is set aside (ADR 0025).

Issue #37 asks for a search that starts from the requirement. ADR 0005 rejected finding places by
the requirement's words, by measurement (omamori PR `#476`): the change is the bridge, the
requirement decides through the mapping question.

## Decision

1. **The bodies of the siblings' seeds are places** (origin `called_by_changed`). A seed is what ADR
   0005 says it is — a function of this repository the changed code calls, whose call settles at one
   definition here that returns a `Result` and is not a changed function, used in at most 20 files,
   at most 8. The calls in its body are asked under a budget of their own, 10 per requirement, after
   every question the run asked before this and before the siblings, dealt one function at a time in
   seed order as the siblings' are. A function already listed one hop out (changed or a caller) is not
   added, and a body is no sibling as well: no call is listed by both budgets. `via` names the changed function that calls
   the seed, the first read when several do. A seed only a removed line calls is not read here: the
   changed code calls it no more. One step down only.
2. **A method called on `dyn T` or `impl T` is looked for in `T`.** When what a method call is made
   on is written — past `&`, `Box`, `Rc`, `Arc` — as `dyn T` or `impl T`, and `T` is a trait of this
   repository, the definitions are looked for from the trait's side, as `T`'s declaration and its
   `impl T for …`, where the name alone does not settle the call (more than one definition, or a
   search cut short). When they include the declaration, they are read as
   versions of one thing, as today: asked only when every version reads as returning a `Result`. One
   definition alone — a default body no `impl` overrides — is that definition, as the name reading would
   settle it. A
   name `T` does not declare, a definition in `impl dyn T`, or a search that was cut leaves the call to
   the name reading. A method named like one of the standard library's stays under ADR 0027.
3. **The change still finds; the requirement still decides.** No place is found by the requirement's
   words. The report says where each place came from (changed, a caller, a callee of the change, a
   sibling) and which leads were left.

## Alternatives Considered

- **Share the siblings' budget.** Adds no request, but the bodies would push the siblings out — the
  reason ADR 0015 gave the callers a budget of their own.
- **Ask when every definition a call may reach returns a `Result`**, without settling which. It
  would change ADR 0025's and 0027's "not settled, not asked" for every form, and
  `check_before_action` sends a body, which needs the definition.
- **Read a generic bound (`P: T`, `where`).** Needs the bounds of type parameters read; not needed
  for the case at hand. Later.
- **Find places by the requirement's words.** Rejected by ADR 0005's measurement; not re-opened.

## Consequences

- Up to 10 more calls a requirement — 20 more requests — asked before the siblings: a run cut by a request limit
  loses siblings first.
- A callee's body that turns a failure into a success is asked about wherever the change calls it,
  including where the requirement may not govern it; whether it is listed is the mapping question's.
- A defect in a function two calls down, in a trait's method whose versions do not all read as
  returning a `Result`, or in a helper the change calls from more than 20 files, is still not reached.
- #37's "which from the requirement" is answered by there being none: that part of the issue stays
  open.
