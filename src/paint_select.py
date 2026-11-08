"""Paint's Select > Modify (expand, contract, smooth, border) and Select > Colour range: the same arithmetic as
js/imageViewer_paintSelect.js, compared pixel by pixel by tests/test_paint_parity.py. Written from what the
commands do, not from any other program's code."""
from __future__ import annotations

import numpy as np

from . import paint_math as M
from .paint_style import _round, dilate

MODIFY = ("expand", "contract", "smooth", "border")


def expand_mask(m, r):
    return dilate(m, r)


def contract_mask(m, r):
    return (255 - dilate((255 - m).astype(np.uint8), r)).astype(np.uint8)


def border_mask(m, width):
    """A band *width* wide along the edge: half outside, half inside (``borderMask``)."""
    a = _round(width / 2)
    b = max(0, _round(width) - a)
    out = expand_mask(m, a).astype(np.int16) - contract_mask(m, b).astype(np.int16)
    return np.clip(out, 0, 255).astype(np.uint8)


def smooth_mask(m, r):
    f = M.feather_mask(m, r)
    return np.where(f >= 128, 255, 0).astype(np.uint8)


def modify(m, kind, r):
    return {"expand": expand_mask, "contract": contract_mask, "smooth": smooth_mask, "border": border_mask}[kind](m, r)


def color_range(px, color, fuzz):
    """How near each pixel lies to *color* (RGB distance averaged over the channels): 1 at it, 0 at *fuzz* or
    more, times the pixel's alpha (``colorRange``). *px* is (h, w, 4) uint8."""
    f = max(1.0, float(fuzz))
    d = px[..., :3].astype(np.float64) - np.asarray(color[:3], np.float64)
    dist = np.sqrt((d * d).sum(-1) / 3)
    v = 1 - dist / f
    out = M.q8(v * (px[..., 3].astype(np.float64) / 255))
    return np.where(v <= 0, 0, out).astype(np.uint8)
