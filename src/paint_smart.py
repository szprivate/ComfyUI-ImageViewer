"""Paint's smart filters: filters kept as settings on a pixel layer (``filters``), drawn in the composite. The
same arithmetic as js/imageViewer_paintSmart.js, compared pixel by pixel by tests/test_paint_parity.py.
Written from what the feature does, not from any other program's code."""
from __future__ import annotations

import numpy as np

from . import paint_math as M

MAX_SMART = 20
SMART_FIELDS = {"blur": (("radius", 0.1, 250, 4),), "sharpen": (("radius", 0.1, 100, 2), ("amount", 0, 10, 1))}


def smart_types():
    return ("blur", "sharpen") + tuple(M.ADJUST_TYPES)


def clean_smart(f):
    if not isinstance(f, dict) or f.get("type") not in smart_types():
        return None
    p = f.get("params") if isinstance(f.get("params"), dict) else {}
    t = f["type"]
    if t in SMART_FIELDS:
        params = {k: M._num(p.get(k), d, lo, hi) for k, lo, hi, d in SMART_FIELDS[t]}
    else:
        params = M.clean_adjust(t, p)
    return {"type": t, "on": f.get("on") is not False, "params": params}


def clean_filters(lst):
    if not isinstance(lst, list):
        return None
    out = [c for c in (clean_smart(f) for f in lst[:MAX_SMART]) if c]
    return out or None


def smart_on(L):
    return L.get("kind") == "pixel" and isinstance(L.get("filters"), list) and any(f.get("on") for f in L["filters"])


def smart_pixels(W, H, L, px):
    """The layer's pixels through its filters, in order, as a canvas-sized (H, W, 4) picture (``smartPixels``)."""
    buf = np.zeros((H, W, 4), np.uint8)
    lx, ly = int(L.get("x", 0)), int(L.get("y", 0))
    ph, pw = px.shape[:2]
    x0, y0, x1, y1 = max(0, lx), max(0, ly), min(W, lx + pw), min(H, ly + ph)
    if x1 > x0 and y1 > y0:
        buf[y0:y1, x0:x1] = px[y0 - ly:y1 - ly, x0 - lx:x1 - lx]
    for f in L["filters"]:
        if not f.get("on"):
            continue
        p = f["params"]
        if f["type"] == "blur":
            buf = M.blur_pixels(buf, p["radius"])
        elif f["type"] == "sharpen":
            buf = M.sharpen_pixels(buf, p["radius"], p["amount"])
        else:
            buf = M.adjust_pixels(buf, f["type"], p)
    return buf


def smart_layer(W, H, L, px):
    """(the layer as drawn, its pixels): a smart-filtered layer becomes canvas-sized (``smartLayer``)."""
    if px is None or not smart_on(L):
        return L, px
    return dict(L, x=0, y=0, w=W, h=H), smart_pixels(W, H, L, px)
