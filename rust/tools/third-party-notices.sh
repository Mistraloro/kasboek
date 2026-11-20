#!/usr/bin/env bash
# Writes THIRD-PARTY-NOTICES (the licences of all dependencies of the native app) with cargo-about.
# Usage: rust/tools/third-party-notices.sh [output file]   (default: THIRD-PARTY-NOTICES.txt in the current directory)
# Needs: cargo install cargo-about --locked --features cli. Fails when a dependency has a licence that is not accepted in
# rust/about.toml, so a new dependency cannot ship without its notice.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(realpath -m "${1:-THIRD-PARTY-NOTICES.txt}")"
mkdir -p "$(dirname "$out")"
cd "$here"
cargo about generate --locked --workspace --fail --config about.toml --manifest-path Cargo.toml --output-file "$out" about.hbs
echo "wrote $out"
