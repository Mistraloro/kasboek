#!/usr/bin/env bash
# Starts the app for a moment and checks that startup.log has the milestones of the plan (section 5) and that the process
# exits cleanly. On Linux it needs a display (xvfb-run); on Windows and macOS run it from a normal session.
# Usage: tools/startup-test.sh <binary> [kasboek args...]
set -euo pipefail
[[ -n "${CI:-}" ]] && set -x
# No realpath (not on every system); the folder of the binary is made absolute with cd and pwd.
arg=${1:?binary}
bin="$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")"
shift
[[ -f "$bin" ]] || { echo "binary not found: $bin"; exit 1; }
# shellcheck source=bounded.sh
source "$(dirname "${BASH_SOURCE[0]}")/bounded.sh"
dir=$(mktemp -d)
log="$dir/startup.log"
# A native Windows program gets Windows paths (C:/...), not the /tmp/... of Git Bash; grep below still reads $log.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
run=("$(native "$bin")" --data-dir "$(native "$dir")" --log "$(native "$log")" --exit-after-ms 1500 "$@")
if [[ "$(uname -s)" == Linux && -z "${DISPLAY:-}" ]]; then run=(xvfb-run -a "${run[@]}"); fi
rc=0
run_bounded 120 "${run[@]}" || rc=$?
echo "app exit status: $rc"
if [[ ! -f "$log" ]]; then echo "no log written: $log"; ls -la "$dir"; exit 1; fi
[[ $rc -eq 0 ]] || { echo "app failed"; cat "$log"; exit "$rc"; }
for milestone in "main entered" "prefs read" "backend selected" "window created" "window shown" "first frame painted" "time-to-first-frame" "event loop ended"; do
  grep -q "$milestone" "$log" || { echo "missing milestone: $milestone"; cat "$log"; exit 1; }
done
cat "$log"
echo "startup test passed"
