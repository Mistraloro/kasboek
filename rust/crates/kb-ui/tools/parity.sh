#!/usr/bin/env bash
# Parity of the Slint gallery with the real React components: renders every case with both and compares them.
# Usage: tools/parity.sh <outDir> [case ...]
# Needs, once: `npm ci` at the repo root (Playwright's Chromium comes with it), and a Python with numpy, pillow and scipy
#   python3 -m venv /tmp/kb-venv && /tmp/kb-venv/bin/pip install numpy pillow scipy   (then PY=/tmp/kb-venv/bin/python)
# Env: SKIP_REFERENCE=1 reuses the reference stills of an earlier run; GALLERY=path to kb-ui-gallery (default: cargo build --release of this crate), PY=python with the packages.
set -euo pipefail
out=$(realpath -m "${1:?outDir}")
shift || true
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
mkdir -p "$out"
if [ -z "${GALLERY:-}" ]; then
  (cd "$root/rust" && cargo build --release -p kb-ui)
  GALLERY=$root/rust/target/release/kb-ui-gallery
fi
cases=("$@")
[ ${#cases[@]} -gt 0 ] || mapfile -t cases < <("$GALLERY" --list-cases)
[ -n "${SKIP_REFERENCE:-}" ] || {
  node "$here/reference/build.mjs" "$out/harness"
  node "$here/reference/reference.mjs" "$out" "$out/harness" "$@"
}
for theme in light dark; do
  for c in "${cases[@]}"; do
    # Interaction that the reference page gets from Playwright, done here with synthetic input.
    extra=()
    case $c in
      date) extra=(--tab 1 --keys "9,9,/,9,9,/,2,0,2,6,Tab") ;;
      modal-ask) extra=(--keys Escape) ;;
      password) extra=(--hold 454,138) ;;
    esac
    "$GALLERY" --shot "$c" "$theme" "$out/slint-$c-$theme.png" "${extra[@]}"
  done
done
"${PY:-python3}" "$here/parity.py" "$out" "$@"
