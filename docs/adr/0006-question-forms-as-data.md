# 0006. What a local check asks is a form, and one rule reads every form

Status: Accepted

## Context

The local check (`--experimental-local-check`) asks two questions about a call: whether the
requirement requires that a failure of this call not reach the caller as a success, and what the
function returns when the call fails. A call is listed when the first clears the bar saying
`applies` and the second clears it saying `returns_success`. Both questions, the condition that
decides which calls can be asked about (the callee returns a `Result`), the comparison that lists a
call, and every sentence of the report are about failure propagation.

So a requirement of any other shape has nowhere to go but a new algorithm. Issue #35 asks for the
opposite: requirement × evidence → small typed Jev judgments → a deterministic policy →
`satisfies` / `violates` / `unknown` / `aside`, where the requirement may change and the machinery
does not.

Measured before this decision (#36, `docs/local-check-cli.md`): on unseen pull requests the failure
questions read the fixed call right, three runs of three; with the deciding code moved into a
helper whose body is not sent, Jev still answered with confidence (0.92–0.96).

## Decision

- A **form** is data with five parts:
  1. the unit, which is one call in a function for every form so far;
  2. the condition under which a call can be asked about;
  3. builders for the two typed questions: the mapping (does the requirement require this of the
     call) and the observation (what the function does under an assumption);
  4. which observation answer goes against the requirement and which keeps it;
  5. the report's words: the opening sentence, the observation's label, the assumed condition, the
     reason for an observation and the reason a call is listed.
- **One rule** decides every call a question was put to, and it does not name a form:
  - mapping `applies` at or above the bar (0.6):
    - observation at or above the bar and the form's violating answer → `violates`;
    - at or above the bar and the form's keeping answer → `satisfies`;
    - anything else (`cannot_determine`, below the bar, no answer) → `unknown`;
  - mapping `does_not_apply` at or above the bar → `aside`;
  - anything else (`unknown`, below the bar, no answer) → `unknown`.

  A request that fails without ending the run is no answer, for the observation as for the mapping.
- Two forms:
  - **`failure_propagation`**, the questions, condition and words of v0.1 unchanged byte for byte.
    It violates on `returns_success` and keeps on `returns_error`.
  - **`check_before_action`**:
    - The mapping asks whether the requirement requires a check to run before call `X` in `f`.
    - The observation assumes the situation the requirement forbids and asks whether `f` reaches
      `X`: `reaches_it` violates, `does_not_reach` keeps.
    - The question does not quote the requirement. The packet already carries it, so the question
      text stays fixed whatever the input.
    - A call can be asked about when a word of its name meets a word of the requirement or of its
      `searchHints`. Both sides are split the same way (snake_case, CamelCase, and the whole
      identifier). The call's words come from its whole path and the receivers just before it.
      There is no five-letter floor here (words under three letters are dropped), and common
      English words are left out. Two words meet when they are equal, when one is the other with
      one letter more, or when they share their first five letters — so `rewrite` meets `rewritten`
      and `general` meets `generate`, while `write` does not meet `written` and `res` does not meet
      `restore`.
    - A call into a function this run reads on its own — the callee's one definition in the
      repository is at a function the change reached — is not asked about: a check before what it
      does is asked about inside it. A name two functions share resolves to neither.
- A requirement names its form in the spec, `form`, optional and experimental, defaulting to
  `failure_propagation`. An unknown value is refused when the spec is read. As decided here,
  requirements read from a pull request's acceptance-criteria list were all `failure_propagation`
  and Jev did not choose a form, pending a measurement that would also settle whether this field
  stays. ADR 0008 took that measurement and rules otherwise: Jev chooses the form of a requirement
  read from text — a sixth part, what its sentence says, is added to the five above, and the
  question is assembled from the forms — while the `form` field stays, a spec's word, and is not
  asked.
- The four values are **readings per call, not requirement verdicts.** No requirement-level status
  is stated, the Markdown report keeps "Nothing here is a requirement verdict" and no verdict word,
  and a listed call still leaves the exit code at 0. The JSON carries `outcome` and `form` per call.
- Whether a question can be put to a call is decided per requirement, since the check form's
  condition reads the requirement's words. Only what reads the repository and depends on the commit
  alone ("returns a `Result`") is decided once and shared.
- Which answers violate and which keep are sets of answer names, not functions, so a form cannot
  carry a rule of its own.

## Alternatives considered

- A decision function per form: that is the per-family algorithm #35 asks to remove, and nothing
  would keep two such functions reading the same answers the same way.
- Choosing the form from `kind`: `kind` already changes how the default run searches, and #35 keeps
  it to that. One field would carry two meanings.
- For `check_before_action`, every call can be asked about: the calls in the pull requests of #36
  number 68 to 633 against a budget of 20. The budget is spent from the top of each function, and
  the action a check guards comes after the check, so the calls that matter would be the ones
  crowded out.
- For `check_before_action`, taking calls from the end of each function: it reaches no larger share,
  and nothing says the last call is the guarded one.
- Asking Jev which calls are actions: a request per call before anything is judged, and a choice made
  by a model before its accuracy at making it is known.

## Consequences

- A new shape of requirement is a new form, not a new algorithm, and it is reported in the same four
  values.
- `satisfies` means two readings agreed, and nothing more. Where the deciding code is in a body that
  is not sent, #36 measured a confident agreement that was wrong. `docs/local-check-cli.md` says so
  next to the value.
- The report's sections change:
  - "Read as required by the requirement" is split into "Worth checking", "Read as holding" and
    "Not settled".
  - "Read, but not required of by the requirement" keeps its name and holds `aside` only; the
    mapping readings that were not `does_not_apply` over the bar move to "Not settled".
- `check_before_action` reaches only calls named in the requirement's words. A synonym, an action
  that is not a call (`return Ok(Session { .. })`), and `write` / `writeln` (never listed as calls)
  are not asked about. The report says why for each call it holds.
- The check itself and a lookup before it usually share the requirement's words, so they are asked
  about too. Under the forbidden situation they are always reached, and only the mapping keeps them
  out of "Worth checking". When more calls match than the budget holds, the budget is still spent
  from the top of each function.
- A check placed in another function is not in what is sent, so the local reading at `f` can
  disagree with the requirement read over the whole path. This is the same limit as the failure
  form's, and the reason no requirement-level verdict is stated.
- Sibling widening (#37) takes its seeds, and filters its siblings, by the form's condition rather
  than by a fixed "returns a `Result`". Its cap on seeds is applied per requirement, after that
  filter, so seeds that one requirement cannot ask about do not take another's places.
- The failure form's condition is whatever decides "returns a `Result`" (today `applicabilityOf`;
  #45 replaces how that is decided). The form only calls it.
