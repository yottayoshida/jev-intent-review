# How far `check_before_action` reaches on real code, with no request

The constructed case (`../check-before-action/`) cannot show this: its names were chosen to meet the
requirement's words. So for each of the two pull requests of the acceptance set (`bench/acceptance/`,
issue #36), a check-before-action sentence was written for the changed function — before the count,
its sha256 recorded in the result — and `--experimental-candidates-only` was run on the clone at
the shipped commit. Nothing was sent. The results are `grovedb-500.json` and `moltis-1064.json`.

| case | sentence | calls in the set | can be asked | budget | the guarded call |
|---|---|---|---|---|---|
| dashpay/grovedb#500, `finalize` | "While a restore is being finalized, the tree heights must not be rewritten unless verifying the heights has failed." | 215 | 17 | 20 (none left over) | `rewrite_heights(grove_version)`, 10th of the 17 |
| moltis-org/moltis#1064, `generate_title_for_session` | "A title must not be generated for a session that has fewer messages than the minimum." | 170 | 22 | 20 (2 left over) | `moltis_agents::title::generate_title(provider, &chat_msgs)`, 18th of the 20 |

What held the rest: no word shared with the sentence (184 and 144 calls), a callee whose one
definition is a function the run reads on its own (14 and 4; the words are tested first, so a call
that shares none is held for that), the budget (0 and 2). The word test reads receivers on purpose: in moltis,
`session_store.as_ref()` and `session_metadata.get(session_key)` are asked about because of
`session`; in grovedb, calls on a `tree` in the test functions the change reached are asked about
because of `tree`. The first count of grovedb had 23 askable and the guarded call 16th of 20: six
`res.as_bytes()` calls in hashing functions were in because `res` begins `restore`. A short name
that merely begins a word of the sentence no longer meets it (`src/plan/forms.ts`, `termsMeet`);
the constructed case's askable calls are the same under both rules (`run.ts precheck`). Both
guarded calls came in under the budget on these two changes; a change with more functions sharing
the sentence's words, or with the guarded call later in a busier body, would push it out, and this
count says nothing about that. The positions are those of the budget's order at the tool commit
recorded in each result; a later change to how the budget is ordered moves them.
