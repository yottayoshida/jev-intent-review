#!/usr/bin/env bash
# check_before_action on moltis-1064: each version at the PR head, the probe test added, one message.
T=${ACCEPTANCE_DIR:?set to the directory holding the clones}; C=$T/moltis; CARGO=/opt/homebrew/bin/cargo; W=$T/cba-moltis
D=$(cd "$(dirname "$0")" && pwd)
git -C "$T/moltis" worktree add -q --detach "$W" 4106d46dad04481a932597141739e42a5452cc86 2>/dev/null || true
for v in shipped defect rewrite hidden helper; do
  git -C $W checkout -q -- . ; git -C $W checkout -q --detach 4106d46dad04481a932597141739e42a5452cc86
  [ $v != shipped ] && git -C $W apply $D/$v.head.patch
  git -C $W apply $D/probe.patch
  (cd $W && CARGO_TARGET_DIR=$T/target-moltis $CARGO test -q -p moltis-gateway --no-default-features --features voice --lib acceptance_probe_one_message -- --nocapture > $T/probe-cba-moltis-$v.log 2>&1)
  echo "$v test_rc=$? $(grep -Eo 'acceptance-probe: one message -> .*' $T/probe-cba-moltis-$v.log | head -1)"
done
git -C $W checkout -q -- .
