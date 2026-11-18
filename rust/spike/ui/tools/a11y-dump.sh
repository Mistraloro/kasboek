#!/usr/bin/env bash
# AT-SPI dump of the running window. Needs: dbus-run-session, Xvfb, at-spi2-core, python3-pyatspi (apt).
# Usage: tools/a11y-dump.sh [screen] [binary]
set -euo pipefail
screen=${1:-overview}
bin=$(realpath "${2:-$(dirname "$0")/../target/release/kasboek-ui-spike}")
here=$(dirname "$(realpath "$0")")
Xvfb :96 -screen 0 1280x820x24 >/dev/null 2>&1 &
xpid=$!
trap 'kill $xpid' EXIT
sleep 1
DISPLAY=:96 dbus-run-session -- bash -c "
  /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
  sleep 1
  for prop in IsEnabled ScreenReaderEnabled; do
    dbus-send --session --dest=org.a11y.Bus --print-reply /org/a11y/bus org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:\$prop variant:boolean:true >/dev/null
  done
  $bin --screen $screen >/dev/null 2>&1 &
  app=\$!
  /usr/bin/python3.12 $here/a11y-dump.py kasboek 3
  kill \$app
"
