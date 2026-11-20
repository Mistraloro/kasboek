#!/usr/bin/env bash
# Start-up test of the real service path (kb-session + kb-core on a data folder, no fixtures): the app creates an account in a
# fresh temporary folder, reaches the unlocked Overview and logs the time of that first frame; a second start unlocks the same
# account again; a third start without credentials stays on the Lock screen. The password is made here, goes to the app through
# the environment and is never printed. On Linux it needs a display (xvfb-run).
# Usage: tools/startup-test-core.sh <binary>
set -euo pipefail
bin=$(realpath "${1:?binary}")
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
password="Kb-$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')-9z"

start() { # name, extra args...
  local name=$1
  shift
  local run=("$bin" --data-dir "$dir/data" --log "$dir/$name.log" --exit-after-ms 6000 "$@")
  if [[ "$(uname -s)" == Linux && -z "${DISPLAY:-}" ]]; then xvfb-run -a "${run[@]}"; else "${run[@]}"; fi
}
expect() { # log, text
  grep -q "$2" "$dir/$1.log" || { echo "missing in $1.log: $2"; cat "$dir/$1.log"; exit 1; }
}

echo "-- first start: creates the account (no account yet)"
KASBOEK_DEMO_PASSWORD="$password" start create --demo-setup
for m in "service: Core" "demo: auth.setup" "first frame painted" "first unlocked frame" "time-to-unlocked" "event loop ended"; do expect create "$m"; done
grep "time-to-first-frame\|time-to-unlocked" "$dir/create.log"
for f in account.json kasboek.db prefs.json; do [[ -s "$dir/data/$f" ]] || { echo "missing data file $f"; exit 1; }; done

echo "-- second start: unlocks the account that exists"
KASBOEK_DEMO_PASSWORD="$password" start unlock --demo-setup
for m in "demo: auth.unlock" "first unlocked frame" "time-to-unlocked"; do expect unlock "$m"; done
grep "time-to-unlocked" "$dir/unlock.log"

echo "-- third start: no credentials, stays locked"
start locked
expect locked "first frame painted"
if grep -q "first unlocked frame" "$dir/locked.log"; then echo "unlocked without credentials"; exit 1; fi

# The password is in none of the files the app wrote.
if grep -rqF -- "$password" "$dir"; then echo "the password was written to disk"; exit 1; fi
echo "core start-up test passed"
