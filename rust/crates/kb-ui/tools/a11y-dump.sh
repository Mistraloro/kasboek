#!/usr/bin/env bash
# AT-SPI dump of the running gallery: roles, names, states, focusable, as a Linux screen reader (Orca) sees them.
# Needs: dbus-run-session, Xvfb, at-spi2-core, python3-pyatspi (apt). Python path: PYATSPI_PYTHON (default /usr/bin/python3).
# Usage: tools/a11y-dump.sh [case] [binary] [extra gallery args, e.g. --open modal]
set -euo pipefail
case_name=${1:-all}
bin=$(realpath "${2:-$(dirname "$0")/../../../target/release/kb-ui-gallery}")
shift $(( $# > 2 ? 2 : $# )) || true
here=$(dirname "$(realpath "$0")")
Xvfb :${A11Y_DISPLAY:-97} -screen 0 1280x900x24 >/dev/null 2>&1 &
xpid=$!
trap 'kill $xpid' EXIT
sleep 3
DISPLAY=:${A11Y_DISPLAY:-97} dbus-run-session -- bash -c "
  /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
  sleep 1
  for prop in IsEnabled ScreenReaderEnabled; do
    dbus-send --session --dest=org.a11y.Bus --print-reply /org/a11y/bus org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:\$prop variant:boolean:true >/dev/null
  done
  $bin --case $case_name $* >/dev/null 2>&1 &
  app=\$!
  ${PYATSPI_PYTHON:-/usr/bin/python3} $here/a11y-dump.py kb-ui-gallery 3
  kill \$app
"
