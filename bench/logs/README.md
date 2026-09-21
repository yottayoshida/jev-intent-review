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
| `acceptance-v1.json` | `bench/acceptance/run.ts measure`, the acceptance set of issue #36 (moltis#1064, grovedb#500) | 24 | Inside the diff, each defect listed at its own call and the shipped and rewritten code listing nothing, in three runs of three on both cases; with the decision hidden in a helper, a confident reading every time; no question put to the defects placed outside the diff (other calls in grovedb's unchanged caller were asked about). **Distilled**: each branch keeps the calls inside the budget, its notes and counts, and the held rows of the functions that hold a target — the rest of the enumeration depends on the commits alone and `run.ts precheck` takes it again with no request. Every packet hash and every answer is kept. `node bench/acceptance/replay.ts` rebuilds the table in `docs/local-check-cli.md` from it. |
| `stated-requirements-v1.json` | `--experimental-local-check`, five branches, two requirements that state how a failure must be handled | 5 | Every mutation is listed at its own target and nowhere else; the shipped and behaviour-preserving branches list nothing. Ten cells of ten agree with the table fixed before the runs. |
| `jev-only-v1.json` | `--experimental-local-check`, shipped branch, mapping asked of Jev | 1 | The first run with no model but Jev in it. Jev reads both measured targets as `does_not_apply` (0.51, 0.63) and the calls that perform the refusal itself as `applies` (0.90, 0.77). Every probability kept; nothing scored. |
| `diff-reach-v1.json` | `--experimental-local-check`, five branches of omamori `#468` | 5 | The diff reaches both target calls inside a budget of 20 on every branch, and the answers match what the program does in ten cells of ten. **Distilled**: counts, notes, the budgeted set and every observation with its probability — not the 700-odd calls that were held. |
| `beyond-diff-v1.json` | `bench/beyond-diff.ts`: `--experimental-candidates-only`, five branches of omamori `#468`, the tool at `a9bed91` and with siblings (ADR 0005) | 10 | No request sent. On every branch and requirement the calls the budget of 20 selects are the same set with and without siblings; which seeds and siblings there are, and why every other name was not used. The tool is named by a hash of its `src/` (`newSrcDigest`), since the run came before its own commit. |
| `beyond-diff-jev-v1.json` | `bench/beyond-diff-jev.ts`: `--experimental-local-check`, shipped branch of omamori `#468`, with siblings | 1 | The siblings asked of the real Jev: how many findings they raise on shipped code. **Distilled** by that script: the CLI's JSON with `counts`, `seeds`, `stopped`, every mapping, every observation and every finding copied as they came out, unrounded — and without `unchecked` and `notes`, which need no request and are in `beyond-diff-v1.json`. Not scored. |
| `acceptance-37-v1.json` | `--experimental-candidates-only` with siblings (`a76c152`), place C of moltis#1064 in the acceptance set | 1 | No request sent. The one defect in a function the change did not touch and that calls nothing it touched is in the function the changed code calls, which the siblings do not read: not enumerated. **Distilled**: the seeds, counts and notes of the run, and the calls of the target's function (none). |
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
