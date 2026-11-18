#!/usr/bin/env python3
"""Builds the static font instances Slint embeds, from the variable fonts the Electron app bundles.

Needs: pip install fonttools brotli opentype-feature-freezer
Input : node_modules/@fontsource-variable/{inter,source-serif-4}/files/*-latin-wght-normal.woff2 (OFL-1.1)
Output: assets/fonts/*.ttf  (Latin subset as shipped by fontsource)

Inter 400/500/600      family "Inter"      plain static instance
Inter 400/500/600      family "Inter Num"  tnum frozen in (the `.num` class of the renderer)
Source Serif 4 500/600 family "Source Serif 4"

styles.css asks for cv11 and ss01, but the fontsource latin subset has no such features (its GSUB only has
calt, ccmp, dnom, frac, locl, numr, pnum, tnum), so Chromium renders neither today. Nothing to freeze for them.
"""
import subprocess
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parents[1] / "assets" / "fonts"
SRC = ROOT / "node_modules" / "@fontsource-variable"
STYLE = {400: "Regular", 500: "Medium", 600: "SemiBold"}


def rename(font: TTFont, family: str, weight: int) -> None:
    style = STYLE[weight]
    full = f"{family} {style}"
    for rec in list(font["name"].names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            font["name"].removeNames(nameID=rec.nameID)
    n = font["name"]
    ps = full.replace(" ", "")
    for nid, val in ((1, family), (2, "Regular"), (3, ps), (4, full), (6, ps), (16, family), (17, style)):
        n.setName(val, nid, 3, 1, 0x409)
        n.setName(val, nid, 1, 0, 0)
    font["OS/2"].usWeightClass = weight


def instance(woff2: Path, weight: int, tmp: Path) -> Path:
    vf = TTFont(woff2)
    vf.flavor = None
    inst = instancer.instantiateVariableFont(vf, {"wght": weight})
    path = tmp / f"{woff2.stem}-{weight}.ttf"
    inst.save(path)
    return path


def freeze(src: Path, features: str, dst: Path, family: str, weight: int) -> None:
    subprocess.run(["pyftfeatfreeze", "-f", features, str(src), str(dst)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    f = TTFont(dst)
    rename(f, family, weight)
    f.save(dst)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / ".tmp"
    tmp.mkdir(exist_ok=True)
    inter = SRC / "inter" / "files" / "inter-latin-wght-normal.woff2"
    serif = SRC / "source-serif-4" / "files" / "source-serif-4-latin-wght-normal.woff2"
    for w in (400, 500, 600):
        i = instance(inter, w, tmp)
        f = TTFont(i)
        rename(f, "Inter", w)
        f.save(OUT / f"Inter-{STYLE[w]}.ttf")
        freeze(i, "tnum", OUT / f"InterNum-{STYLE[w]}.ttf", "Inter Num", w)
    for w in (500, 600):
        i = instance(serif, w, tmp)
        f = TTFont(i)
        rename(f, "Source Serif 4", w)
        f.save(OUT / f"SourceSerif4-{STYLE[w]}.ttf")
    for p in tmp.iterdir():
        p.unlink()
    tmp.rmdir()
    for p in sorted(OUT.glob("*.ttf")):
        print(f"{p.name}\t{p.stat().st_size}")


if __name__ == "__main__":
    sys.exit(main())
