#!/usr/bin/env bash
# Runs the kb-oseal real-OS tests (crates/kb-oseal/tests/real_os.rs) on Linux against a real, unlocked Secret Service:
# a private D-Bus session with gnome-keyring-daemon, its login keyring unlocked with a throw-away password.
# Needs: dbus-run-session, gnome-keyring, libsecret-tools (secret-tool). Fails when a test skips for want of a keyring.
# Usage: rust/tools/oseal-real-os-linux.sh   (from anywhere; the log goes to $OSEAL_LOG or a temporary file)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OSEAL_LOG="${OSEAL_LOG:-$(mktemp)}"
export OSEAL_MANIFEST="$here/Cargo.toml"
exec dbus-run-session -- bash -euo pipefail -c '
  eval "$(printf "%s" "kasboek-ci" | gnome-keyring-daemon --unlock --components=secrets)"
  export GNOME_KEYRING_CONTROL
  # The Secret Service answers and stores: the same check a person would make with secret-tool.
  printf "%s" "invented" | secret-tool store --label="kasboek ci probe" application kasboek-ci-probe
  [ "$(secret-tool lookup application kasboek-ci-probe)" = "invented" ]
  secret-tool clear application kasboek-ci-probe
  cargo test --locked --manifest-path "$OSEAL_MANIFEST" -p kb-oseal --test real_os -- --nocapture --test-threads=1 2>&1 | tee "$OSEAL_LOG"
  # (one test prints "SKIPPED: a Secret Service is running" on purpose: it needs none.)
  if grep -qE "SKIPPED: (no Secret Service|the Secret Service cannot)" "$OSEAL_LOG"; then
    echo "::error::a kb-oseal real-OS test skipped although the keyring is unlocked"
    exit 1
  fi
'
