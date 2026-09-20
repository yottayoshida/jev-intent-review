# The ten pull requests this tool is measured on

Ten merged pull requests, chosen mechanically before anything was run (the rule and the list are in
`.claude/plans/2026-09-19-jev-intent-review-pr-corpus.md` in the owner's workspace): merged, with a
closing keyword naming an issue, 1-20 changed files, five from `yottayoshida/omamori` and five from
`yottayoshida/sideeye`, newest first.

Each case is two files:

- `<repo>-<number>.revs` — the two commits, `base head`, as `--pr` resolves them. Fixed so that a
  measurement compares rules rather than revisions.
- `<repo>-<number>.spec.json` — the requirements, so the requirement-writing model cannot move the
  ground between two runs (`--intent-spec`).

```sh
read -r base head < bench/corpus/omamori-553.revs
cd ~/path/to/omamori
node ~/path/to/jev-intent-review/src/cli/main.ts \
  --base "$base" --head "$head" \
  --intent-spec ~/path/to/jev-intent-review/bench/corpus/omamori-553.spec.json --json
```

## Where these requirements come from, and what was done to them

They are what the tool's own requirement-writing model produced on the first pass, **repaired**.
All 38 of them came back with the record written into the sentence rather than into the fields:
every one had its search hints in prose (`…, with search hints: stderr, json object`) and the
`searchHints` field empty, nine began with `kind: behavior, quote: …`, and some carried fragments
of a serialized structure (`…installed.', 'search_hints': '…'}], {`). Each was then cut to the
requirement length limit, which hid the tail and left something that read like a long requirement.
Because the hints never reached the field, the search fell back to the words of the sentence —
`search_hints`, `quote` and `kind` among them.

The repair is mechanical and adds nothing: the field names are stripped from the front, the hints
are moved from the sentence into `searchHints`, and the serialized fragments are cut from the end.
Requirements that repaired to the same sentence are kept once: 38 became 32, and `omamori-553`'s
eight became two. `readRequirementText` in `src/intent/compiler.ts` does the same thing at the
source, with these shapes as its tests.

**Fourteen of the 32 do not end in a full stop, and are left that way.** They were cut at the
requirement limit with no earlier sentence to fall back to, so what is there is a clause that
stops mid-phrase: `…and instead report an '未`, `…a path-free reason, and a`. An earlier version
of this repair closed them with a full stop, which made them read like finished requirements — the
same trick the truncation played, and two of them went into a measurement that way. A requirement
that is visibly unfinished is more use than one that looks finished and is not.

The unrepaired originals are the first measurement's record; they are not kept here, because a
measurement run against them measures the compiler's output of that day and not the tool.

## What this set is not

It is not labelled. Nobody has said, for each requirement, which places in the repository it
governs or whether it holds there. Until that exists, a run over this corpus can be compared with
another run over it, and nothing here says whether an answer is right.
