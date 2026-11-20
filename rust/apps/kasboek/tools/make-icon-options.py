#!/usr/bin/env python3
"""Draws the Kasboek icon as a K of Playfair Display (SIL OFL) on the plates of assets/brand/icon.svg (dark, accent #3FCF8E)
and icon-light.svg (light, accent #15803D): options at weight 700, 800 and 900. Writes SVG and PNG (1024, 256, 32, 16) per option.

Needs: pip install fonttools brotli cairosvg
Usage: make-icon-options.py <folder with playfair-display/files/, see crates/kb-ui/tools/make-fonts.py> <out folder>
"""
import sys
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
CAP_HEIGHT = 580  # of 1024


def letter(src: Path, weight: int) -> tuple[str, float, float]:
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
    dx, dy = 512 - s * (x0 + x1) / 2, 512 + s * (y0 + y1) / 2
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.1f}")
    gs[name].draw(TransformPen(pen, (s, 0, 0, -s, dx, dy)))
    return pen.getCommands(), s * (x1 - x0), s * (y1 - y0)


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for weight in (700, 800, 900):
        d, _, _ = letter(src, weight)
        for theme, c in THEMES.items():
            svg = (
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
                f'<rect x="64" y="64" width="896" height="896" rx="208" fill="{c["plate"]}"/>'
                f'<rect x="70" y="70" width="884" height="884" rx="202" fill="none" stroke="{c["edge"]}" stroke-width="12"/>'
                f'<path d="{d}" fill="{c["ink"]}"/></svg>'
            )
            stem = out / f"icon-k{weight}-{theme}"
            stem.with_suffix(".svg").write_text(svg)
            for px in (1024, 256, 32, 16):
                cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{stem}-{px}.png", output_width=px, output_height=px)


if __name__ == "__main__":
    main()
