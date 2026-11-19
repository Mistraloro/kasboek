#!/usr/bin/env python3
"""Compares the React reference stills (ref-<case>-<theme>.png) with the Slint gallery stills (slint-<case>-<theme>.png).

Usage: python tools/parity.py <shotsDir> [case ...]        (needs numpy, pillow, scipy)
Per case and theme it prints
  - the share of differing pixels: pixelmatch-style YIQ delta (threshold 0.1, no anti-alias exclusion), the stricter
    "any channel off by more than 24", and the share of pixels that differ at all;
  - landmarks: bounding boxes of what is drawn on the background (text merged into words, boxes, bars), found by the
    same pixel analysis on both stills and paired by nearest centre; the largest offset of any edge, in px.
Gates (from the UI spike): differing pixels <= 3 %, landmark offsets <= 2 px, equal number of landmarks.
Writes <shotsDir>/side-<case>-<theme>.png (reference | slint | diff) and <shotsDir>/parity.txt. Exit code 1 if a gate fails.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

BG = {"light": (0xFA, 0xFA, 0xF8), "dark": (0x0E, 0x11, 0x0F)}
GATE_PIXELS = 3.0
GATE_BOX = 2


def yiq_delta(a, b):
    a, b = a.astype(np.float64), b.astype(np.float64)
    y = lambda p: p[..., 0] * 0.29889531 + p[..., 1] * 0.58662247 + p[..., 2] * 0.11448223
    i = lambda p: p[..., 0] * 0.59597799 - p[..., 1] * 0.2741761 - p[..., 2] * 0.32180189
    q = lambda p: p[..., 0] * 0.21147017 - p[..., 1] * 0.52261711 + p[..., 2] * 0.31114694
    dy, di, dq = y(a) - y(b), i(a) - i(b), q(a) - q(b)
    return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq


def landmarks(img, bg, grow=4):
    """Bounding boxes of connected non-background regions; glyphs of a word merge because the mask is grown first."""
    mask = np.any(np.abs(img.astype(int) - np.array(bg)) > 2, axis=2)
    grown = ndimage.binary_dilation(mask, structure=np.ones((3, 3), bool), iterations=grow)
    lab, _ = ndimage.label(grown)
    boxes = []
    for sl in ndimage.find_objects(lab):
        sub = mask[sl]
        ys, xs = np.nonzero(sub)
        if len(ys) < 4:
            continue
        y0, x0 = sl[0].start + ys.min(), sl[1].start + xs.min()
        boxes.append((int(x0), int(y0), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)))
    return sorted(boxes, key=lambda b: (b[1], b[0]))


def pair(ref, got):
    """Pairs every reference box with the nearest unused Slint box (by centre); returns pairs and the leftovers."""
    left = list(got)
    pairs = []
    for r in ref:
        if not left:
            break
        cx, cy = r[0] + r[2] / 2, r[1] + r[3] / 2
        j = min(range(len(left)), key=lambda k: abs(left[k][0] + left[k][2] / 2 - cx) + abs(left[k][1] + left[k][3] / 2 - cy))
        pairs.append((r, left.pop(j)))
    return pairs, left


def edges(b):
    return (b[0], b[1], b[0] + b[2], b[1] + b[3])


def compare(case, theme, d, out):
    ref = np.array(Image.open(d / f"ref-{case}-{theme}.png").convert("RGB"))
    got = np.array(Image.open(d / f"slint-{case}-{theme}.png").convert("RGB"))
    if ref.shape != got.shape:
        out.append(f"{case:13s} {theme:5s}  SIZE DIFFERS ref {ref.shape[1]}x{ref.shape[0]} slint {got.shape[1]}x{got.shape[0]}")
        return False
    delta = yiq_delta(ref, got)
    over = delta > 35215 * 0.1 * 0.1
    pm = float(over.mean() * 100)
    channel = np.abs(ref.astype(int) - got.astype(int)).max(axis=2)
    strict, anyd = float((channel > 24).mean() * 100), float((channel > 0).mean() * 100)
    side = np.concatenate([ref, got, np.where(over[..., None], np.array([255, 0, 0], np.uint8), (ref * 0.25 + 191).astype(np.uint8))], axis=1)
    Image.fromarray(side).save(d / f"side-{case}-{theme}.png")
    rb, gb = landmarks(ref, BG[theme]), landmarks(got, BG[theme])
    pairs, extra = pair(rb, gb)
    worst = max((max(abs(a - b) for a, b in zip(edges(r), edges(s))) for r, s in pairs), default=0)
    ok = pm <= GATE_PIXELS and worst <= GATE_BOX and len(rb) == len(gb)
    out.append(f"{case:13s} {theme:5s}  diff {pm:5.2f}%  >24: {strict:5.2f}%  any: {anyd:5.2f}%  landmarks ref {len(rb):2d} slint {len(gb):2d}  max offset {worst} px  {'PASS' if ok else 'FAIL'}")
    for r, s in pairs:
        off = max(abs(a - b) for a, b in zip(edges(r), edges(s)))
        if off > GATE_BOX:
            out.append(f"      box ref {r} slint {s} offset {off}")
    if len(rb) != len(gb):
        out.append(f"      landmark count differs: ref-only {max(len(rb) - len(gb), 0)}, slint-only {max(len(gb) - len(rb), 0)}")
    return ok


def main():
    d = Path(sys.argv[1])
    only = sys.argv[2:]
    cases = json.loads((Path(__file__).parent / "cases.json").read_text())
    out, ok = [], True
    for theme in ("light", "dark"):
        for c in cases:
            name = c["name"]
            if (only and name not in only) or not (d / f"ref-{name}-{theme}.png").exists() or not (d / f"slint-{name}-{theme}.png").exists():
                continue
            ok &= compare(name, theme, d, out)
    text = "\n".join(out)
    (d / "parity.txt").write_text(text + "\n")
    print(text)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
