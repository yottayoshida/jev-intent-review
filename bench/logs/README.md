# Measurement logs

Every number quoted in `docs/local-check-design.md` and in the bench headers comes from a file
here. They are checked in because the records that cite them say things like "both logs are kept",
and a log that lives only in a scratch directory makes that false a week later.

Each file holds the whole run: the tool version and model, where the code was taken from, the
questions and their criteria as sent, the meaning table and the bar, and for every single run the
code, its hash, what was written down beforehand, every answer unrounded, the verdict and the
reason. Nothing is summarised. A claim in the prose can be recomputed rather than trusted.

`diff-reach-v1.json` is the exception and says so in its row: a run of the whole CLI holds every
call it enumerated, which is 235 KB per branch, and five of those would be more than this
directory is for. It keeps every answer unrounded and every count, and drops the text of the calls
it never asked about. The table below is also not a full index — several logs written after it are
not in it.

| file | experiment | runs | what it establishes |
|---|---|---|---|
| `form-choice-v1.json` | `bench/forms/choice/run.ts measure`, whether Jev reads which form a requirement's sentence has: 72 sentences labelled before the first request, with who wrote each (ADR 0008) | 216 | No failure sentence read as check (0 of 18; the two not read as failure in every run are the fixture's baseline sentence and the one read by hand from a real pull request); ten of eleven check sentences read as check in three runs of three; four of 43 neither sentences read as check, all of the shape "refuses / voids the run if …". Every option's probability, the sha256 of the set and of the question, and the host's origin are kept; `run.ts score` rebuilds the table in `docs/local-check-cli.md` from it and refuses another set or wording, and `test/form-choice.test.ts` holds it to these counts. |
| `check-before-action-v1.json` | `bench/forms/run.ts measure`, the constructed case for the `check_before_action` form (five versions of one function, `bench/forms/check-before-action/`) | 15 | With the requirement "A disabled API key must never create a session.": the defect listed at `create_session` three times of three, the shipped code and a behaviour-preserving rewrite listing nothing, the lookup and the check themselves read as not required of every time in those three versions. The check moved into a helper whose body does nothing: read as holding 3/3 (0.96–0.97) — the same miss #36 measured for the failure form. The check moved into the caller: `open_session` read alone is listed, as it does make the call. 90 requests, every one to Cloudflare. Every mapping and reading is kept with its number; the code is the committed files, built into a throwaway repository with fixed commits. |
| `check-before-action-v0.json` | the same, before `check_before_action` held a call into a function the run reads on its own | 15 | The reason for that condition: `login`'s call into `open_session`, which checks inside, was read from `login` as made in the forbidden case and listed in every run of every version but `caller` (whose `login` checks before calling) — the shipped code and the rewrite included (0.70–0.82 applies, 0.94–0.97 reaches_it). Every other row read as v1 does. 126 requests. |
| `acceptance-v1.json` | `bench/acceptance/run.ts measure`, the acceptance set of issue #36 (moltis#1064, grovedb#500) | 24 | Inside the diff, each defect listed at its own call and the shipped and rewritten code listing nothing, in three runs of three on both cases; with the decision hidden in a helper, a confident reading every time; no question put to the defects placed outside the diff (other calls in grovedb's unchanged caller were asked about). **Distilled**: each branch keeps the calls inside the budget, its notes and counts, and the held rows of the functions that hold a target — the rest of the enumeration depends on the commits alone and `run.ts precheck` takes it again with no request. Every packet hash and every answer is kept. `node bench/acceptance/replay.ts` rebuilds the table in `docs/local-check-cli.md` from it. |
| `stated-requirements-v1.json` | `--experimental-local-check`, five branches, two requirements that state how a failure must be handled | 5 | Every mutation is listed at its own target and nowhere else; the shipped and behaviour-preserving branches list nothing. Ten cells of ten agree with the table fixed before the runs. |
| `jev-only-v1.json` | `--experimental-local-check`, shipped branch, mapping asked of Jev | 1 | The first run with no model but Jev in it. Jev reads both measured targets as `does_not_apply` (0.51, 0.63) and the calls that perform the refusal itself as `applies` (0.90, 0.77). Every probability kept; nothing scored. |
| `diff-reach-v1.json` | `--experimental-local-check`, five branches of omamori `#468` | 5 | The diff reaches both target calls inside a budget of 20 on every branch, and the answers match what the program does in ten cells of ten. **Distilled**: counts, notes, the budgeted set and every observation with its probability — not the 700-odd calls that were held. |
| `order-first-pass-v1.json` | `bench/order-first-pass.ts`: the selection with and without the order inside a function, on the acceptance pre-check's eight cases (every version of moltis#1064 and grovedb#500) and omamori `#468`'s five branches, under today's check and a wider stand-in for `#45` | 20 × 2 | No request sent. Per run, which calls entered and left the budget, whether each function's count and the order in which functions take their turns are unchanged, and whether each defect inside the diff is inside the budget with and without the order. The tool is named by a hash of its `src/`, since the run came before its own commit. |
| `order-first-pass-jev-v1.json` | `bench/order-first-pass-jev.ts`: the two calls the order swaps in omamori `#468`'s `run_override_disable`, asked of Jev | 15 | Three runs per branch, both requirements: every mapping and observation unrounded, and no finding at either call. Every other question of the run was answered with nothing and not sent (120 sent). Not scored. |
| `result-type-v1.json` | `bench/result-type.ts`: whether each call can be asked about, with the tool before and after reading whole signatures and aliases (`#45`, first part), on the acceptance pre-check's eight cases and omamori `#468`'s five branches | 13 × 2 | No request sent. Per run, the counts by reason, the calls that became askable or held, the calls `#45` names, every "does not return a Result" after the change with its label (the same reason for the same callee in one function once, with the number of calls), and the scoring against `bench/result-type-expected.json` — agreements counted, disagreements listed with whether their cause is settled there. **Distilled**: the decisions themselves are not all kept; `node bench/result-type.ts` takes them again with no request. About 770 KB, most of it the reasons printed, which are what the labels are checked against. The "before" tool is named by its commit, the "after" by a hash of its `src/`. |
| `local-check.json` | `bench/local-check.ts` | 18 | The first plan on `collect_listing`: 18/18 as written down beforehand. |
| `local-check-propagation.json` | `bench/local-check-propagation.ts` | 18 | The same plan on the `show_entries` read loop: 12/18, and the six that miss are the shipped behaviour. |
| `stated-condition.json` | `bench/local-check-stated-condition.ts` | 24 | The 2×2. The wording decides, not the code form. |
| `stated-generalisation-v1.json` | `bench/local-check-stated-generalisation.ts` | 36 | The first `collect_listing` condition, the one that said "`seen` is empty". |
| `stated-generalisation-v2.json` | same file, rewritten condition | 36 | The re-run after that condition was rewritten — a confirmation of the new condition, not an independent measurement. |

`v1` is kept precisely because its `listing/stops-but-succeeds` runs disagree with the label that
was written down. They answer `a_success_with_nothing`; the condition never said where in the
iteration the error falls, so that is a reachable reading and not a wrong answer, and the verdict
was `violation` in all three either way. Deleting it would leave only the run that agrees.

One naming artefact: `local-check-propagation.json` calls its first case `shipped`. The case was
renamed `shipped-loop` in `8eb328a`, after the log was written, because the code judged is the
shipped read loop in a wrapper that returns the list rather than the shipped function. The log
predates the rename and is left as it was recorded.

To regenerate any of them, run the matching bench with the log path as its second argument. The
answers will not be identical — the model is sampled — so a regenerated file replaces nothing here.
