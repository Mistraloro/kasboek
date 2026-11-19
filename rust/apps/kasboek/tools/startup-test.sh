#!/usr/bin/env bash
# Starts the app for a moment and checks that startup.log has the milestones of the plan (section 5) and that the process
# exits cleanly. On Linux it needs a display (xvfb-run); on Windows and macOS run it from a normal session.
# Usage: tools/startup-test.sh <binary> [kasboek args...]
set -euo pipefail
bin=$(realpath "${1:?binary}")
shift
dir=$(mktemp -d)
log="$dir/startup.log"
run=("$bin" --data-dir "$dir" --log "$log" --exit-after-ms 1500 "$@")
if [[ "$(uname -s)" == Linux && -z "${DISPLAY:-}" ]]; then xvfb-run -a "${run[@]}"; else "${run[@]}"; fi
for milestone in "main entered" "prefs read" "backend selected" "window created" "window shown" "first frame painted" "time-to-first-frame" "event loop ended"; do
  grep -q "$milestone" "$log" || { echo "missing milestone: $milestone"; cat "$log"; exit 1; }
done
cat "$log"
echo "startup test passed"
