#!/usr/bin/env python3
"""Builds the static fonts Slint embeds, from open (SIL OFL 1.1) fonts.

Needs: pip install fonttools brotli
Input : tools/fonts.json (the one place that names the fonts) and the font packages, looked up as <package>/ in
        $KB_FONTSOURCE first, then in node_modules/@fontsource-variable/ and node_modules/ (a package folder as `npm pack`
        unpacks it, without the "package/" level):
        - a family with "package" only is a fontsource variable font: <package>/files/<package>-latin-wght-normal.woff2,
          instanced at each weight (Playfair Display: `npm pack @fontsource-variable/playfair-display@5.3.0`)
        - a family with "files" ({weight: path in the package}) is a set of static fonts, subset to Latin here
          (Lato 2.015: `npm pack lato-font@3.0.0`, which carries Medium and Semibold; fontsource has Lato 1 with 400/700 only)
        - a family with "same_as": "<role>" is that role's family under another role (no files of its own)
Output: assets/fonts/*.ttf, the licence texts, ui/fonts.slint (imports of the TTFs and the `Fonts` global with the family names)

Lato and Playfair Display reserve their names (OFL 1.1 section 3), and a subset or instance is a Modified Version, so
fonts.json gives them the names "Kasboek Sans" and "Kasboek Display". The copyright, licence and trademark records of the
name table stay. The licence text is the package's LICENSE file when it has one, else the text already in
assets/fonts/<"licence">: lato-font has none, so Lato-OFL.txt is the OFL text of its README under the copyright line of the
font's own name table.

Slint has no font-feature-settings. Lato's default figures are already tabular lining (all digits 1160/2000 em wide; `pnum`
makes them proportional), so the `num` role needs no frozen copy of the font.
"""
import json
import os
import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

KB_UI = Path(__file__).resolve().parents[1]
ROOT = KB_UI.parents[2]
OUT = KB_UI / "assets" / "fonts"
STYLE = {400: "Regular", 500: "Medium", 600: "SemiBold"}
# Latin as fontsource ships it, plus Latin Extended-A (Dutch ij, Polish and Czech names in imported data).
UNICODES = "U+0020-007E,U+00A0-00FF,U+0100-017F,U+0192,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215"


def package_dir(package: str) -> Path:
    extra = os.environ.get("KB_FONTSOURCE")
    candidates = ([Path(extra) / package] if extra else []) + [ROOT / "node_modules" / "@fontsource-variable" / package, ROOT / "node_modules" / package]
    for c in candidates:
        if c.is_dir():
            return c
    sys.exit(f"package {package} not found (set KB_FONTSOURCE, see the docstring)")


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


def variable_instance(src: Path, weight: int) -> TTFont:
    vf = TTFont(src)
    vf.flavor = None
    return instancer.instantiateVariableFont(vf, {"wght": weight})


def latin_subset(src: Path) -> TTFont:
    font = TTFont(src)
    font.flavor = None
    options = subset.Options()
    options.layout_features = ["*"]
    options.hinting = False
    options.notdef_outline = True
    options.name_IDs = ["*"]
    options.glyph_names = False
    sub = subset.Subsetter(options)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    return font


def main() -> None:
    config = json.loads((Path(__file__).parent / "fonts.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    families = {f["role"]: f for f in config["families"]}
    names = {role: (families[f["same_as"]] if "same_as" in f else f)["family"] for role, f in families.items()}
    files: list[str] = []
    for fam in config["families"]:
        if "same_as" in fam:
            continue
        family = fam["family"]
        stem = family.replace(" ", "")
        pkg = package_dir(fam["package"])
        for w in fam.get("weights") or [int(k) for k in fam["files"]]:
            if "files" in fam:
                font = latin_subset(pkg / fam["files"][str(w)])
            else:
                font = variable_instance(pkg / "files" / f"{fam['package']}-latin-wght-normal.woff2", w)
            rename(font, family, w)
            dst = OUT / f"{stem}-{STYLE[w]}.ttf"
            font.save(dst)
            files.append(dst.name)
        licence = OUT / fam["licence"]
        if (pkg / "LICENSE").exists():
            shutil.copy(pkg / "LICENSE", licence)
        elif not licence.exists():
            sys.exit(f"{fam['package']} has no LICENSE and {licence} does not exist")

    slint = [
        "// Generated by tools/make-fonts.py from tools/fonts.json. Do not edit.",
        *(f'import "../assets/fonts/{name}";' for name in files),
        "",
        "// The family names are the only place the rest of the design system learns them from.",
        "export global Fonts {",
        *(f'    out property <string> {role}: "{name}";' for role, name in names.items()),
        "}",
        "",
    ]
    (KB_UI / "ui" / "fonts.slint").write_text("\n".join(slint))
    for name in files:
        print(f"{name}\t{(OUT / name).stat().st_size}")


if __name__ == "__main__":
    sys.exit(main())
