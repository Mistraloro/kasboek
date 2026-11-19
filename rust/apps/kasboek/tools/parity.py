#!/usr/bin/env python3
"""Compares screenshots of the native app with the Electron screenshots of the release branch, in the style of kb-ui's parity.py.

Usage: python parity.py <dir> <ref-dir>
  <dir>      holds <screen>-<theme>.png written by `kasboek shot <screen> <theme> ... --scale 2` (1440x900 at 2x)
  <ref-dir>  holds the Electron stills `<case>-<theme>.png` (git show claude/focused-pasteur-oeugzy:docs/screenshots/<name>.png)
Cases: overview (app: overview), lock (app: lock-password). Prints differing pixels (gate 3 %) and landmark offsets (gate 2 px, in
the 2880x1800 stills, so 1 css px = 2 px here) per case and theme, writes side-<case>-<theme>.png and parity.txt.
Needs numpy, pillow, scipy (a venv).
"""
import importlib.util
import shutil
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("kbparity", Path(__file__).parents[3] / "crates/kb-ui/tools/parity.py")
kb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kb)

CASES = {"overview": "overview", "lock": "lock-password"}


def main():
    d, ref = Path(sys.argv[1]), Path(sys.argv[2])
    out, ok = [], True
    for theme in ("light", "dark"):
        for case, screen in CASES.items():
            src, mine = ref / f"{case}-{theme}.png", d / f"{screen}-{theme}.png"
            if not src.exists() or not mine.exists():
                continue
            shutil.copy(src, d / f"ref-{case}-{theme}.png")
            shutil.copy(mine, d / f"slint-{case}-{theme}.png")
            ok &= kb.compare(case, theme, d, out)
    text = "\n".join(out)
    (d / "parity.txt").write_text(text + "\n")
    print(text)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
