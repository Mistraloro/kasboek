#!/usr/bin/env python3
"""Compares the Electron reference screenshots (ref-*.png) with the Slint renders (slint-*.png).

Usage: python tools/compare.py <shotsDir>
Needs: numpy, pillow, scipy.
Writes <shotsDir>/side-<name>.png (reference | slint | diff) and prints, per screen:
  - percentage of differing pixels: pixelmatch-style YIQ delta (threshold 0.1, no anti-alias exclusion),
    and the stricter "any channel differs by more than 24"
  - landmark boxes found by the same pixel analysis on both images (components of non-background pixels).
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

BG = {"light": (0xFA, 0xFA, 0xF8), "dark": (0x0E, 0x11, 0x0F)}


def yiq_delta(a, b):
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    y = lambda p: p[..., 0] * 0.29889531 + p[..., 1] * 0.58662247 + p[..., 2] * 0.11448223
    i = lambda p: p[..., 0] * 0.59597799 - p[..., 1] * 0.2741761 - p[..., 2] * 0.32180189
    q = lambda p: p[..., 0] * 0.21147017 - p[..., 1] * 0.52261711 + p[..., 2] * 0.31114694
    dy, di, dq = y(a) - y(b), i(a) - i(b), q(a) - q(b)
    return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq


def boxes(img, bg, y0, x0, x1, min_w, min_h):
    """Bounding boxes of connected non-background regions (cards, panels, buttons) inside a window of the image."""
    non_bg = np.any(np.abs(img[y0:, x0:x1].astype(int) - np.array(bg)) > 2, axis=2)
    lab, n = ndimage.label(non_bg)
    out = []
    for sl in ndimage.find_objects(lab):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if w >= min_w and h >= min_h:
            out.append((sl[1].start + x0, sl[0].start + y0, w, h))
    return sorted(out, key=lambda b: (b[1], b[0]))


def column_edge(img, bg, y, x_from, x_to):
    """First x in [x_from, x_to) where the row at y leaves the background (the sidebar border)."""
    row = np.any(np.abs(img[y, x_from:x_to].astype(int) - np.array(bg)) > 2, axis=1)
    idx = np.flatnonzero(row)
    return int(x_from + idx[0]) if len(idx) else None


def compare(name, ref_path, slint_path, theme, out_dir):
    ref = np.array(Image.open(ref_path).convert("RGB"))
    got = np.array(Image.open(slint_path).convert("RGB"))
    delta = yiq_delta(ref, got)
    pm = float((delta > 35215 * 0.1 * 0.1).mean() * 100)
    strict = float((np.abs(ref.astype(int) - got.astype(int)).max(axis=2) > 24).mean() * 100)
    exact = float((np.abs(ref.astype(int) - got.astype(int)).max(axis=2) > 0).mean() * 100)
    diff = np.where((delta > 35215 * 0.1 * 0.1)[..., None], np.array([255, 0, 0], np.uint8), (ref * 0.25 + 191).astype(np.uint8))
    Image.fromarray(np.concatenate([ref, got, diff], axis=1)).save(out_dir / f"side-{name}.png")
    print(f"\n== {name} ({theme})  differing pixels: pixelmatch(0.1) {pm:.2f}%   >24/255 {strict:.2f}%   any {exact:.2f}%")
    bg = BG[theme]
    if name.startswith("overview"):
        # Sidebar border: the 1px line at x=223 over the full height; assistant panel border at x=940.
        for label, xs in (("sidebar border x", (200, 260)), ("assistant border x", (900, 960))):
            print(f"   {label}: ref {column_edge(ref, bg, 810, *xs)}  slint {column_edge(got, bg, 810, *xs)}")
        rb, sb = boxes(ref, bg, 44, 224, 930, 90, 30), boxes(got, bg, 44, 224, 930, 90, 30)
        print("   main-column boxes (x,y,w,h)  ref | slint | max offset")
        for r, s in zip(rb, sb):
            print(f"     {r}  |  {s}  |  {max(abs(a - b) for a, b in zip(r, s))}")
        if len(rb) != len(sb):
            print(f"     (box count differs: ref {len(rb)}, slint {len(sb)})")
    else:
        rb, sb = boxes(ref, bg, 150, 300, 980, 100, 20), boxes(got, bg, 150, 300, 980, 100, 20)
        print("   boxes (x,y,w,h)  ref | slint | max offset")
        for r, s in zip(rb, sb):
            print(f"     {r}  |  {s}  |  {max(abs(a - b) for a, b in zip(r, s))}")
        if len(rb) != len(sb):
            print(f"     (box count differs: ref {len(rb)}, slint {len(sb)})")


def main():
    d = Path(sys.argv[1])
    for theme in ("light", "dark"):
        for screen in ("lock-password", "lock-hello", "overview", "overview-bottom"):
            r, s = d / f"ref-{screen}-{theme}.png", d / f"slint-{screen}-{theme}.png"
            if r.exists() and s.exists():
                compare(f"{screen}-{theme}", r, s, theme, d)


if __name__ == "__main__":
    main()
