#!/usr/bin/env bash
# The Action's shell steps (ADR 0009). Nothing that npm, the command or finish.ts prints reaches the
# job log: their output goes to files in a directory made under RUNNER_TEMP, and every line this
# writes to the log is written here, from fixed words — or is finish.ts's log.txt, whose lines
# finish.ts makes the same way.
#
#   run.sh prepare   check the event and Node, make the working directory, install the dependency
#   run.sh review    run the command once, with --json
#   run.sh finish    run finish.ts, print its log lines, and set the Action's outputs
set -u

say() { printf 'jev-intent-review: %s\n' "$1"; }
output() { printf '%s=%s\n' "$1" "$2" >> "${GITHUB_OUTPUT:?}"; }
summary() { printf '%s\n' "$1" >> "${GITHUB_STEP_SUMMARY:?}"; }

# Stop before the command runs, with the Action's own configuration error (10). The sentence is said
# in the log and in the job summary.
stop() {
  say "$1"
  summary "# jev-intent-review"
  summary ""
  summary "**Result: not run.** $1"
  output ready false
  output exit-code 10
  exit 0
}

# Node 22.18 or later runs the command's TypeScript as it is.
node_is_recent() {
  local version major minor
  version="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  case "$major.$minor" in *[!0-9.]* | .* | *.) return 1 ;; esac
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }
}

case "${1:-}" in
  prepare)
    event="${GITHUB_EVENT_NAME:-}"
    case "$event" in *[!a-z_]* | '') event="another event" ;; esac
    if [ "$event" != "pull_request" ]; then
      stop "runs on pull_request events only, and this run is for ${event}. pull_request_target hands secrets to a workflow that checks out a stranger's code, so it is not supported."
    fi
    node_is_recent || stop "needs Node.js 22.18 or later on the runner. Add actions/setup-node with node-version 22 before this step."
    work="$(mktemp -d "${RUNNER_TEMP:?}/jev-intent-review.XXXXXX")" || stop "could not make its working directory."
    # The artifact's directory is finish.ts's to make: only what it redacts is uploaded.
    if ! (cd "${ACTION_PATH:?}" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund) > "$work/npm.txt" 2>&1; then
      stop "could not install its dependencies (npm ci failed). Its output is kept out of the log."
    fi
    output work "$work"
    output ready true
    ;;

  review)
    # The kept answers (ADR 0013): a restored cache may come back readable by others, and the command
    # refuses a directory that is, so it is made private again first. Empty when remember-answers is off.
    set --
    # A directory that is itself a symlink is left alone and not passed: chmod would change what it points to.
    if [ -n "${JEV_ANSWERS:-}" ] && [ ! -L "$JEV_ANSWERS" ]; then
      mkdir -p "$JEV_ANSWERS" && chmod 700 "$JEV_ANSWERS" && set -- --answers "$JEV_ANSWERS"
      # Not through a symlink: chmod would change what it points to. The command refuses a symlink.
      for kept in answers.jsonl sent.log; do
        if [ -f "$JEV_ANSWERS/$kept" ] && [ ! -L "$JEV_ANSWERS/$kept" ]; then chmod 600 "$JEV_ANSWERS/$kept"; fi
      done
    fi
    node "${ACTION_PATH:?}/src/cli/main.ts" --json "$@" > "${JEV_WORK:?}/stdout.json" 2> "$JEV_WORK/stderr.txt"
    code=$?
    printf '%s\n' "$code" > "$JEV_WORK/exit-code"
    say "the command exited ${code}."
    ;;

  finish)
    if ! node "${ACTION_PATH:?}/action/finish.ts" > "${JEV_WORK:?}/finish.txt" 2>&1; then
      say "finishing failed; what was written is in the job summary and the artifact."
    fi
    [ -f "$JEV_WORK/log.txt" ] && cat "$JEV_WORK/log.txt"
    code="$(cat "$JEV_WORK/exit-code" 2>/dev/null)"
    case "$code" in '' | *[!0-9]*) code=2 ;; esac
    checked="$(cat "$JEV_WORK/checked" 2>/dev/null)"
    [ "$checked" = "true" ] || checked=false
    output exit-code "$code"
    output checked "$checked"
    # Whether there is a ledger to save: a run that opened none leaves nothing, and a save of nothing warns.
    # What the pull request has sent (sent.log, ADR 0014) is kept too, even when no answer was.
    if [ -n "${JEV_ANSWERS:-}" ] && [ ! -L "$JEV_ANSWERS" ] && { [ -f "$JEV_ANSWERS/answers.jsonl" ] || [ -f "$JEV_ANSWERS/sent.log" ]; }; then output answers-kept true; else output answers-kept false; fi
    ;;

  *)
    say "run.sh takes prepare, review or finish."
    exit 10
    ;;
esac
