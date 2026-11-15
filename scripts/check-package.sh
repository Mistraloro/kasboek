#!/usr/bin/env bash
# Fails when an app package (app.asar) holds sources, tests, tools, scripts or old releases.
# Usage: scripts/check-package.sh <folder with the built app>
set -euo pipefail
found=0
while IFS= read -r a; do
  found=1
  if npx --no-install asar list "$a" | grep -vE '[/\\]node_modules[/\\]' | grep -E '^[/\\](src|tests|tools|scripts|release)([/\\]|$)|\.ts$'; then
    echo "Unexpected files (above) in $a"
    exit 1
  fi
  echo "ok: $a"
done < <(find "${1:-release}" -name app.asar)
if [ "$found" = 0 ]; then echo "No app.asar found"; exit 1; fi
