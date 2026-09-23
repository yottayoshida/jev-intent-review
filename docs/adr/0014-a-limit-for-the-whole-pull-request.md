# 0014. A limit for the whole pull request, counted where its answers are kept

Status: Accepted

## Context

`limits.max_requests` holds one run. `synchronize` starts a run on every push, so a pull request pays up to that limit again each time. ADR 0013 stops the repeats; what is new at each push is still paid for, with no end. #42 asked for "a budget per pull request, not only per run".

## Decision

- **`limits.max_requests_per_pull_request`** in `.jev-intent-review.yml` caps what the runs of one pull request send to Jev together. Unset, there is none, and nothing changes.
- **It is counted in the `--answers` directory**, as `sent.log`, which the Action already carries from run to run in the pull request's cache (ADR 0013). The transport itself (`JevClient`'s `onRequest`, called where it counts `sent.requests`) writes one line synchronously just before each request leaves, a retry included, so a run stopped halfway — even killed — has still counted what it sent. A request whose line cannot be written is not sent — sending it uncounted would pass the limit without a word — and the run says how many it did not send for that reason, and where the repository gates on findings does not finish, as below.
- **It narrows the run's own limit.** At the start, what is left becomes the run's `max_requests` (never more than the configured one). What stops the run and how the questions it could not send read in the report are the existing budget's; there is no second way of stopping. Whether the pull request's limit is what stopped it is decided by what happened — the run sent as many requests as it was left — not by the kind of the failure, since the run's own time and bytes end a judgment the same way. A note says what the pull request had sent and what this run could send, and, when the limit cut the run short, how many judgments it could not send.
- **A run the limit left short does not pass a gate.** Where `policy.fail_on` names `finding`, such a run exits 2 (did not finish) unless it listed a finding, which exits 1 as before; either way the check is red: otherwise a pull request could push until the limit is spent and have its last change pass unasked, the neutral check of a run that read nothing counting as passed in a required check. Without that setting it exits 0, as a run held by its own limit does.
- **It is read from the commit before the change**, like every setting, so a pull request cannot raise its own.
- **It is opened where the kept answers are**, after the run has found its credentials. Without `--answers`, or where the directory or file is not private, the limit is not applied and the notes say so — never silently.

## Alternatives considered

- **Wrap the transport's `fetch` to count.** A failure to write would read as a network error and be retried; counting where the transport already counts lets a failure stop the request as a budget.
- **Write the total at the end of the run.** A run that stops early — its budget, a failure, a cancellation — would leave its requests uncounted, and the limit would be passed without a word.
- **Count the lines of the kept answers.** Failed requests and retries cost as much and would not be counted.
- **A default limit.** It would change what every existing workflow does; the README says how to set one.

## Consequences

- **The value is the maintainers', the count is the pull request's.** The value comes from the commit before the change; the count lives in the pull request's own cache and workflow. A same-repository author can set `remember-answers: false` (the limit is then said not to apply, and the workflow change is noted) or clear the cache (the count starts from 0, unsaid). This limits cost, not an author who means to spend.
- A cache GitHub has evicted starts the count from 0.
- A restore brings back the newest cache only. Overlapping runs of one pull request, the Action in two jobs of one pull request, and the legs of a matrix each save their own count, and one of them is lost: the limit can be passed. Under the README's `concurrency`, a run cancelled by a later push saves its count only as it stops; whether that lands before the next run restores the cache is not yet measured on GitHub, and until it is, the requests of a cancelled run may not reach the next one.
- #42 still has a documented way to hand over requirements and a public test repository.
