# Measurement logs

Every number quoted in `docs/local-check-design.md` and in the bench headers comes from a file
here. They are checked in because the records that cite them say things like "both logs are kept",
and a log that lives only in a scratch directory makes that false a week later.

Each file holds the whole run: the tool version and model, where the code was taken from, the
questions and their criteria as sent, the meaning table and the bar, and for every single run the
code, its hash, what was written down beforehand, every answer unrounded, the verdict and the
reason. Nothing is summarised. A claim in the prose can be recomputed rather than trusted.

| file | experiment | runs | what it establishes |
|---|---|---|---|
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
