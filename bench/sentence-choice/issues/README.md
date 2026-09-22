# Issues the sentence-choice bench reads

These are 64 GitHub issues written by people, copied here so that the measurement in
`bench/logs/sentence-choice-v1.json` can be replayed without GitHub. **The text of each issue belongs
to its author.** It was copied from GitHub for this measurement, with the issue's URL and author in
each file, and it is not covered by this repository's licence (MIT OR Apache-2.0).

How they were chosen, by a rule fixed before any body was read:

- Repositories: BurntSushi/ripgrep, tokio-rs/tokio, clap-rs/clap, rust-lang/cargo, sharkdp/bat,
  alacritty/alacritty.
- Issues closed as completed, created from 2019-01-01 to 2022-10-31 — before text written by language
  models was common — whose last closing event is a merged pull request of the same repository.
- Newest first; in each repository, whole issues until its sentences reach 75.
- Left out: bot authors, bodies with a generation marker, non-English bodies, bodies the tool already
  reads requirements from (ADR 0004), bodies with no sentence or more than 45, a third issue by the
  same author, and the maintainer's own.

The pool is what GitHub's search returned on 2026-09-22. Every chosen body was last edited before
the end of 2022.

Two notes on the content: `BurntSushi-ripgrep-1703.json` is by a deleted account (`ghost`); and
`sharkdp-bat-2151.json` is almost all one code block, a published scanning script for an old
vulnerability, pasted there as a syntax-highlighting sample. Code blocks are not shown to Jev or to
the person labelling (`units.ts`), so only its one sentence is asked about.
