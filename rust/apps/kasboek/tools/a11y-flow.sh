#!/usr/bin/env bash
# Drives the real app through its accessibility tree (see a11y-flow.py): creates an account in a temporary folder and walks the
# screens. Needs Xvfb, dbus-run-session, at-spi2-core, python3-pyatspi. Usage: tools/a11y-flow.sh <binary>
set -euo pipefail
bin=$(realpath "${1:?binary}")
here=$(dirname "$(realpath "$0")")
dir=$(mktemp -d)
Xvfb :${A11Y_DISPLAY:-97} -screen 0 1440x900x24 >/dev/null 2>&1 &
xpid=$!
trap 'kill $xpid; rm -rf "$dir"' EXIT
sleep 2
DISPLAY=:${A11Y_DISPLAY:-97} dbus-run-session -- bash -c "
  /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
  sleep 1
  for prop in IsEnabled ScreenReaderEnabled; do
    dbus-send --session --dest=org.a11y.Bus --print-reply /org/a11y/bus org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:\$prop variant:boolean:true >/dev/null
  done
  $bin --data-dir $dir --log $dir/startup.log >/dev/null 2>&1 &
  app=\$!
  sleep 3
  ${PYATSPI_PYTHON:-/usr/bin/python3} $here/a11y-flow.py 'Tulip-Harbour-Lantern-48'
  kill \$app
"
