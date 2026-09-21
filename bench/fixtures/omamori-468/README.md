# Two targets for omamori#468 / PR#476

The requirement, quoted from [PR #476](https://github.com/yottayoshida/omamori/pull/476):

> A FIFO, directory or symlink planted at a path omamori reads is now refused by name instead of
> hanging the process, reading through to a link target, or being silently treated as an empty file.

Base commit `44f534ca0ae5088f7038561ad33363b48f7a3390`. Every patch applies cleanly to it, checked.

They apply cleanly to **`e58c04f6df082146969320b91f09aa7a0123ac1f`** too — the commit PR #476 was
squashed onto main as — and that is the base the CLI measurement uses, because a run that starts
from the diff needs the same base for every branch. Starting a mutant's diff at the shipped code
would hand the search the mutated line and nothing else. The table below was **taken again** at
that commit with the same two probes, and every cell holds (`bench/logs/diff-reach-v1.json`).

| patch | target | what it does |
|---|---|---|
| `m-read-baseline.patch` | `integrity::read_baseline` | the read failure becomes `Ok(None)` — a baseline that cannot be read comes back as "there is no baseline" |
| `v-read-baseline.patch` | same | the parsed value returned inline; nothing on the failure path |
| `m-raw-override.patch` | `config::raw_override_disables` | the read failure becomes `Ok(false)` — a config that cannot be read comes back as "this rule is not disabled" |
| `v-raw-override.patch` | same | `== Some(false)` written as `.is_some_and(\|enabled\| !enabled)` |

Both targets reach the caller through `crate::atomic_file::read_to_string_capped(…)?`, the shared
helper PR #476 introduced. `git log -S` puts each `?` in the commit that closed #468.

## The mutations are real, and no test in omamori catches them

`cargo test --lib` is **1482 passed / 1 failed on the shipped branch and on `m-read-baseline`
alike** — the same single failure,
`installer::tests::auto_setup_codex_rejects_implicit_dev_build_source`, which is unrelated and
fails on the unpatched commit too in a fresh clone. So the suite cannot tell the mutation from the
shipped code, and a test count is not the evidence here.

What is: `probe_baseline.rs` (an example, callable because `integrity` is `pub`) and
`probe_config.rs` (a test appended in the clone, because `raw_override_disables` is `pub(crate)`).
Both plant a directory where the file is read — #468's shape, and cheaper than a FIFO, which needs
a second process.

| | nothing planted | a directory planted |
|---|---|---|
| `read_baseline`, shipped | `Ok(None)` | **`Err(… is a directory, not a regular file)`** |
| `read_baseline`, mutant | `Ok(None)` | **`Ok(None)`** |
| `read_baseline`, variant | `Ok(None)` | `Err(…)` — as shipped |
| `raw_override_disables`, shipped | `Ok(false)` | **`Err(… is a directory, not a regular file)`** |
| `raw_override_disables`, mutant | `Ok(false)` | **`Ok(false)`** |
| `raw_override_disables`, variant | `Ok(false)` | `Err(…)` — as shipped |

The mutant makes the two columns identical: unreadable and absent stop being distinguishable,
which is the sentence the requirement is about. Neither probe is committed to a measured branch —
those stay one-file diffs, and the packet is built from git objects, which do not have the probes.

That no test covers either refusal path is a gap in omamori, noticed here and **not filed**: it is
outside this work, and nothing here measured whether the paths are covered elsewhere.
