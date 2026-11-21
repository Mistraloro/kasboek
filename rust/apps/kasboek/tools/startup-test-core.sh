#!/usr/bin/env bash
# Start-up test of the real service path (kb-session + kb-core on a data folder, no fixtures): the app creates an account in a
# fresh temporary folder, reaches the unlocked Overview and logs the time of that first frame; a second start unlocks the same
# account again; a third start without credentials stays on the Lock screen. The password is made here, goes to the app through
# the environment and is never printed. On Linux it needs a display (xvfb-run).
# The binary must be built with the cargo feature dev-start (`cargo build --release -p kasboek --features dev-start`): only
# that build knows --demo-setup.
# Usage: tools/startup-test-core.sh <binary>
set -euo pipefail
[[ -n "${CI:-}" ]] && set -x
# No realpath (not on every system); the folder of the binary is made absolute with cd and pwd.
arg=${1:?binary}
bin="$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")"
[[ -f "$bin" ]] || { echo "binary not found: $bin"; exit 1; }
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
# A native Windows program gets Windows paths (C:/...), not the /tmp/... of Git Bash; grep below still reads $dir.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
password="Kb-$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 || true)-9z"

start() { # name, extra args...
  local name=$1
  shift
  local run=("$(native "$bin")" --data-dir "$(native "$dir")/data" --log "$(native "$dir")/$name.log" --exit-after-ms 6000 "$@")
  if [[ "$(uname -s)" == Linux && -z "${DISPLAY:-}" ]]; then run=(xvfb-run -a "${run[@]}"); fi
  local rc=0
  "${run[@]}" || rc=$?
  echo "app exit status ($name): $rc"
  if [[ $rc -ne 0 ]]; then echo "app failed"; cat "$dir/$name.log" 2>/dev/null || echo "no log written"; exit "$rc"; fi
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
