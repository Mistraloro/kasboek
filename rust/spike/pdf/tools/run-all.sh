#!/usr/bin/env bash
# Builds the corpus of invented PDFs, reads each with pdf.js (the app's extractText) and with the Rust reader, compares.
# usage: WORK=/some/dir [BIN=path/to/kb-spike-pdf] [BACKEND=hayro] [PDF_DIR=dir of your own PDFs] tools/run-all.sh
# With PDF_DIR the invented corpus is not made and that directory is read instead (nothing is copied or written there).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
WORK=${WORK:?set WORK to a scratch directory outside the repo}
BIN=${BIN:-$HERE/../target/release/kb-spike-pdf}
BACKEND=${BACKEND:-hayro}
CORPUS=${PDF_DIR:-$WORK/corpus}
mkdir -p "$WORK/corpus" "$WORK/ref" "$WORK/rust-$BACKEND"
ln -sfn "$ROOT/node_modules" "$WORK/node_modules"
# 1. corpus
if [ -z "${PDF_DIR:-}" ]; then
  python3 "$HERE/gen_py.py" "$WORK/corpus"
  (cd "$ROOT" && CORPUS_DIR="$WORK/corpus" node_modules/.bin/vitest run --config "$HERE/vitest.config.mjs" corpus >/dev/null)
fi
# 2. pdf.js reference bundle (the app's own extract.ts / lines.ts / statement.ts)
(cd "$HERE" && "$ROOT/node_modules/.bin/rolldown" ref-entry.ts --format esm --platform node --file "$WORK/ref.mjs" --external 'pdfjs-dist/legacy/build/pdf.mjs' --external 'pdfjs-dist/legacy/build/pdf.worker.mjs' >/dev/null 2>&1)
# 3. read every file with both readers, one process each
for f in "$CORPUS"/*.pdf; do
  n=$(basename "$f" .pdf)
  node "$WORK/ref.mjs" "$f" "$WORK/ref/$n.json" > "$WORK/ref/$n.perf.json" || true
  "$BIN" "$BACKEND" "$f" > "$WORK/rust-$BACKEND/$n.json" 2> "$WORK/rust-$BACKEND/$n.perf.json" || echo "{\"error\":\"crash\"}" > "$WORK/rust-$BACKEND/$n.json"
done
# 4. compare
node "$HERE/compare.mjs" "$WORK/ref" "$WORK/rust-$BACKEND" "$WORK/ref.mjs"
