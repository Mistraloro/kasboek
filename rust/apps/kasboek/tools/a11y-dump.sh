#!/usr/bin/env bash
# AT-SPI dump of the running app (as a Linux screen reader sees it), through kb-ui's a11y-dump.py.
# Needs Xvfb, dbus-run-session, at-spi2-core, python3-pyatspi. Usage: tools/a11y-dump.sh [binary] [kasboek args...]
#   tools/a11y-dump.sh target/release/kasboek                      the Lock screen
#   tools/a11y-dump.sh target/release/kasboek --state unlocked     the Overview
set -euo pipefail
bin=$(realpath "${1:?binary}")
shift
here=$(dirname "$(realpath "$0")")
Xvfb :${A11Y_DISPLAY:-96} -screen 0 1440x900x24 >/dev/null 2>&1 &
xpid=$!
trap 'kill $xpid' EXIT
sleep 2
DISPLAY=:${A11Y_DISPLAY:-96} dbus-run-session -- bash -c "
  /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
  sleep 1
  for prop in IsEnabled ScreenReaderEnabled; do
    dbus-send --session --dest=org.a11y.Bus --print-reply /org/a11y/bus org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:\$prop variant:boolean:true >/dev/null
  done
  $bin --data-dir \$(mktemp -d) --log /dev/null $* >/dev/null 2>&1 &
  app=\$!
  ${PYATSPI_PYTHON:-/usr/bin/python3} $here/../../../crates/kb-ui/tools/a11y-dump.py kasboek 4
  kill \$app
"
