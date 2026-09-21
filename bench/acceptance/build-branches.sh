#!/usr/bin/env bash
# Build one version of a case as commits in a clone, from the patches committed with the case.
#
#   bench/acceptance/build-branches.sh <clone> <merge-base> <pr-head> <case-dir> <base-patch|-> <head-patch|-> <label>
#
# Prints "<base> <head>". The commits carry a fixed author, committer and date, so the same patches
# on the same commits give the same SHAs on any machine: case.json's SHAs can be rebuilt, not only
# trusted.
#
# A base patch is a defect that was there before the pull request — one outside the diff. It is
# committed on the merge base, and the pull request's own diff is then applied on top of it, so the
# merge base of the new pair is the patched base and the defect never enters the diff. Built the
# other way round (base and head patched separately) the merge base falls back to the original and
# the defect's own line shows up as changed.
set -euo pipefail
clone=$1 mb=$2 prhead=$3 dir=$4 basepatch=$5 headpatch=$6 label=$7
export GIT_AUTHOR_NAME=acceptance GIT_AUTHOR_EMAIL=acceptance@invalid GIT_AUTHOR_DATE=2026-09-21T00:00:00Z
export GIT_COMMITTER_NAME=acceptance GIT_COMMITTER_EMAIL=acceptance@invalid GIT_COMMITTER_DATE=2026-09-21T00:00:00Z
work=$(mktemp -d "${TMPDIR:-/tmp}/acceptance-build.XXXXXX")
trap 'git -C "$clone" worktree remove --force "$work" >/dev/null 2>&1 || true' EXIT
git -C "$clone" worktree add -q --detach "$work" "$mb"
commit() { git -C "$work" add -A && git -C "$work" -c commit.gpgsign=false commit -q -m "$1"; }
if [ "$basepatch" != "-" ]; then
  git -C "$work" apply "$dir/$basepatch"
  commit "acceptance: $label, base"
  base=$(git -C "$work" rev-parse HEAD)
  git -C "$clone" diff --binary "$mb" "$prhead" | git -C "$work" apply --index
  commit "acceptance: $label, the pull request's diff"
else
  base=$mb
  git -C "$work" checkout -q --detach "$prhead"
fi
if [ "$headpatch" != "-" ]; then
  git -C "$work" apply "$dir/$headpatch"
  commit "acceptance: $label, head"
fi
head=$(git -C "$work" rev-parse HEAD)
# Keep the commits reachable in the clone after the worktree goes.
git -C "$clone" update-ref "refs/acceptance/$label" "$head"
echo "$base $head"
