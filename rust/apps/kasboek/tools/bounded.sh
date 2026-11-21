# Sourced by the start-up test scripts. `run_bounded SECONDS COMMAND...` runs the command and returns its exit status; a command
# that is still running after SECONDS is ended (TERM, then KILL) and the status is 124. Portable: no GNU timeout (macOS has none).
run_bounded() {
  local limit=$1 pid watcher flag rc=0 i
  shift
  flag=$(mktemp)
  "$@" &
  pid=$!
  (
    for ((i = 0; i < limit; i++)); do sleep 1; done
    echo "run_bounded: no end after ${limit} s, ending the process: $*" >&2
    echo hung >"$flag"
    kill "$pid" 2>/dev/null
    sleep 3
    kill -9 "$pid" 2>/dev/null
  ) &
  watcher=$!
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  [[ -s "$flag" ]] && rc=124
  rm -f "$flag"
  return "$rc"
}
