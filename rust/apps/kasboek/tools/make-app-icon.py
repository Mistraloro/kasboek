#!/usr/bin/env python3
"""Builds the app icon: a K of Playfair Display (SIL OFL) on the plates of assets/brand/icon.svg (dark, accent #3FCF8E) and
icon-light.svg (light, accent #15803D). Weight 900 for the small sizes (16, 24, 32, 48 px), weight 800 from 64 px up.

Needs: pip install fonttools brotli cairosvg
Usage: make-app-icon.py <folder with playfair-display/files/, see crates/kb-ui/tools/make-fonts.py> [out folder, default assets/icons]
Writes into the out folder:
  icon-<dark|light>.svg, icon-small-<dark|light>.svg   the sources (weight 800 and 900)
  icon-<size>.png, icon-light-<size>.png               16 24 32 48 64 128 256 512 1024 (dark and light plate)
  kasboek.ico                                          dark plate, 16 24 32 48 64 128 256 (PNG-compressed entries)
  kasboek.icns                                         dark plate, 16 to 1024 (PNG elements)
The glyph is drawn from the font's outlines (the K only), so the SVGs need no font.
"""
import struct
import sys
from io import BytesIO
from pathlib import Path

import cairosvg
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

THEMES = {
    "dark": {"plate": "#0E110F", "edge": "#24302A", "ink": "#3FCF8E"},
    "light": {"plate": "#FAFAF8", "edge": "#E6E8E4", "ink": "#15803D"},
}
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
SMALL = 48  # up to this size the weight is 900, above it 800
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_TYPES = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08", 512: b"ic09", 1024: b"ic10"}
CAP_HEIGHT = 580  # of 1024


def letter(src: Path, weight: int) -> str:
    """Path data of K centred on the 1024 canvas, y down."""
    vf = TTFont(src / "playfair-display" / "files" / "playfair-display-latin-wght-normal.woff2")
    vf.flavor = None
    font = instancer.instantiateVariableFont(vf, {"wght": weight})
    gs = font.getGlyphSet()
    name = font.getBestCmap()[ord("K")]
    s = CAP_HEIGHT / font["OS/2"].sCapHeight
    bp = BoundsPen(gs)
    gs[name].draw(bp)
    x0, y0, x1, y1 = bp.bounds
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.1f}")
    gs[name].draw(TransformPen(pen, (s, 0, 0, -s, 512 - s * (x0 + x1) / 2, 512 + s * (y0 + y1) / 2)))
    return pen.getCommands()


def svg(d: str, c: dict) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f'<rect x="64" y="64" width="896" height="896" rx="208" fill="{c["plate"]}"/>'
        f'<rect x="70" y="70" width="884" height="884" rx="202" fill="none" stroke="{c["edge"]}" stroke-width="12"/>'
        f'<path d="{d}" fill="{c["ink"]}"/></svg>\n'
    )


def png(source: str, px: int) -> bytes:
    return cairosvg.svg2png(bytestring=source.encode(), output_width=px, output_height=px)


def ico(images: dict[int, bytes]) -> bytes:
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, data = b"", b""
    for px, img in images.items():
        entries += struct.pack("<BBBBHHII", px % 256, px % 256, 0, 0, 1, 32, len(img), offset + len(data))
        data += img
    return head + entries + data


def icns(images: dict[int, bytes]) -> bytes:
    body = b""
    for px, tag in ICNS_TYPES.items():
        body += tag + struct.pack(">I", 8 + len(images[px])) + images[px]
    return b"icns" + struct.pack(">I", 8 + len(body)) + body


def main() -> None:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / "assets" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    big, small = letter(src, 800), letter(src, 900)
    pngs: dict[str, dict[int, bytes]] = {}
    for theme, c in THEMES.items():
        sources = {"": svg(big, c), "small-": svg(small, c)}
        for prefix, text in sources.items():
            (out / f"icon-{prefix}{theme}.svg").write_text(text)
        pngs[theme] = {px: png(sources["small-" if px <= SMALL else ""], px) for px in SIZES}
        for px, data in pngs[theme].items():
            (out / (f"icon-{px}.png" if theme == "dark" else f"icon-light-{px}.png")).write_bytes(data)
    (out / "kasboek.ico").write_bytes(ico({px: pngs["dark"][px] for px in ICO_SIZES}))
    (out / "kasboek.icns").write_bytes(icns(pngs["dark"]))


if __name__ == "__main__":
    main()
