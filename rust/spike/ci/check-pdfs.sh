#!/bin/sh
# Reads every PDF in a folder with the Rust reader and prints one line of numbers per file (no statement text).
# Usage: ./check-pdfs.sh /path/to/folder
[ -n "$1" ] || { echo "Usage: ./check-pdfs.sh /path/to/folder"; exit 1; }
exec "$(dirname "$0")/kb-spike-pdf" summary "$1"
