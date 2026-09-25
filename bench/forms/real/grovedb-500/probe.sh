#!/usr/bin/env bash
# check_before_action on grovedb-500: each version at the PR head, rewrite_heights prints when it runs,
# restore_multi_chunk_20_no_limit (a restore that ends with the heights right; measured: verify_height ok at finalize).
T=${ACCEPTANCE_DIR:?set to the directory holding the clones}; CARGO=/opt/homebrew/bin/cargo; W=$T/cba-grovedb
D=$(cd "$(dirname "$0")" && pwd)
git -C "$T/grovedb" worktree add -q --detach "$W" c0e02819ac99a545e70a858208f2095c5fb461c7 2>/dev/null || true
for v in shipped defect rewrite hidden helper; do
  git -C $W checkout -q -- . ; git -C $W checkout -q --detach c0e02819ac99a545e70a858208f2095c5fb461c7
  python3 - "$W/Cargo.toml" <<'PY'
import re,sys
p=sys.argv[1]; s=open(p).read()
s=re.sub(r'members = \[[^\]]*\]', 'members = ["costs","merk","storage","visualize","path","grovedb-version","grovedb-element","grovedb-query"]', s, count=1)
open(p,"w").write(s)
PY
  [ $v != shipped ] && git -C $W apply $D/$v.head.patch
  git -C $W apply $D/probe.patch
  (cd $W && CARGO_TARGET_DIR=$T/target-grovedb $CARGO test -q -p grovedb-merk --lib restore_multi_chunk_20_no_limit -- --nocapture > $T/probe-cba-grovedb-$v.log 2>&1)
  echo "$v test_rc=$? rewrite_heights_ran=$(grep -c 'acceptance-probe: rewrite_heights ran' $T/probe-cba-grovedb-$v.log) $(grep -Eo 'test result: [a-zA-Z]+\. [0-9]+ passed; [0-9]+ failed' $T/probe-cba-grovedb-$v.log | head -1)"
done
git -C $W checkout -q -- .
