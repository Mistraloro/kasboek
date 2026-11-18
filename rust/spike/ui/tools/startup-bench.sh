#!/usr/bin/env bash
# Wall-clock time from exec to process exit with --exit-after-first-frame, on a private Xvfb, plus the in-process milestones.
# Usage: tools/startup-bench.sh [binary] [runs] [screen]
set -euo pipefail
bin=${1:-$(dirname "$0")/../target/release/kasboek-ui-spike}
runs=${2:-10}
screen=${3:-lock-hello}
Xvfb :97 -screen 0 1280x820x24 >/dev/null 2>&1 &
xpid=$!
trap 'kill $xpid' EXIT
sleep 1
export DISPLAY=:97
"$bin" --screen "$screen" --exit-after-first-frame >/dev/null   # warm the file cache
for i in $(seq "$runs"); do
  s=$(date +%s%N)
  "$bin" --screen "$screen" --exit-after-first-frame --log /dev/null
  e=$(date +%s%N)
  echo "run $i: $(( (e - s) / 1000000 )) ms total process wall time"
done
"$bin" --screen "$screen" --exit-after-first-frame
