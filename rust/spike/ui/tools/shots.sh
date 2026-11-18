#!/usr/bin/env bash
# Renders every screen with Slint (software renderer, offscreen) into <outDir>/slint-<screen>-<theme>.png.
# Usage: tools/shots.sh <outDir> [path/to/kasboek-ui]
set -euo pipefail
out=${1:?outDir}
bin=${2:-$(dirname "$0")/../target/release/kasboek-ui-spike}
mkdir -p "$out"
for theme in light dark; do
  for screen in lock-password lock-hello overview; do
    "$bin" shot "$screen" "$theme" "$out/slint-$screen-$theme.png"
  done
  "$bin" shot overview "$theme" "$out/slint-overview-bottom-$theme.png" 1000000
done
