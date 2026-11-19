#!/bin/sh
# Opens the Kasboek UI spike on the lock screen with the Touch ID button and the typing field.
# Options go after the command, for example:  ./start-ui.sh --lang de --theme dark --scale 2
# The log is startup.log, next to kasboek-ui-spike (the previous run is startup.prev.log).
cd "$(dirname "$0")" || exit 1
exec ./kasboek-ui-spike --screen lock-hello --typing "$@"
