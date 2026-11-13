"""The Comp space's Paint node in numpy: the twin of ``js/imageViewer_compPaint.js``.

A stroke is a list of points in pixels of the picture that comes into the node and a round brush (Paint's dab:
a disc with a smooth edge from ``hard`` out, ``spacing`` x its diameter apart). Each stroke keeps the most any of
its dabs gave a pixel, times its opacity, and lays colour (premultiplied over), erases, or mixes in a source
(clone: the picture before the stroke, or the input at ``dt`` frames; reveal: the second input) moved by its
``offset``. ``tests/test_comp_parity.py`` compares this with the page's code float for float, so keep the order
of the sums the same. Imports nothing of the viewer, so ``comp_model`` can load it on its own.
"""
from __future__ import annotations

import math

import numpy as np

PAINT_TOOLS = ["color", "clone", "reveal", "erase"]
PAINT_LIFE = ["all", "single", "from", "to", "range"]
STROKE_DEFAULTS = {"tool": "color", "size": 40, "hard": 0.6, "opacity": 1, "spacing": 0.1, "color": [1, 1, 1, 1],
                   "offset": [0, 0], "dt": 0, "life": "all", "f": 0}
MAX_POINTS = 20000


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _clamp(v, lo, hi, d):
    return min(hi, max(lo, v)) if _num(v) else d


def _round_js(x):
    return int(math.floor(x + 0.5))


def clean_stroke(s):
    """The page's ``cleanStroke``: a stroke with good numbers, or None without points."""
    if not isinstance(s, dict) or not isinstance(s.get("pts"), list):
        return None
    pts = []
    for p in s["pts"]:
        if len(pts) >= MAX_POINTS:
            break
        if isinstance(p, (list, tuple)) and len(p) >= 2 and _num(p[0]) and _num(p[1]):
            pts.append([float(p[0]), float(p[1])])
    if not pts:
        return None
    D = STROKE_DEFAULTS

    def vec(v, d):
        return [float(v[0]), float(v[1])] if isinstance(v, (list, tuple)) and len(v) >= 2 and _num(v[0]) and _num(v[1]) else list(d)
    c = s.get("color")
    if isinstance(c, (list, tuple)) and len(c) >= 3 and all(_num(x) for x in c[:4]):
        col = [float(c[0]), float(c[1]), float(c[2]), _clamp(c[3], 0, 1, 1) if len(c) > 3 else 1]
    else:
        col = list(D["color"])
    out = {
        "tool": s.get("tool") if s.get("tool") in PAINT_TOOLS else D["tool"],
        "pts": pts,
        "size": _clamp(s.get("size"), 0.5, 4000, D["size"]),
        "hard": _clamp(s.get("hard"), 0, 1, D["hard"]),
        "opacity": _clamp(s.get("opacity"), 0, 1, D["opacity"]),
        "spacing": _clamp(s.get("spacing"), 0.02, 2, D["spacing"]),
        "color": col,
        "offset": vec(s.get("offset"), D["offset"]),
        "dt": _round_js(s["dt"]) if _num(s.get("dt")) else 0,
        "life": s.get("life") if s.get("life") in PAINT_LIFE else D["life"],
        "f": _round_js(s["f"]) if _num(s.get("f")) else 0,
    }
    if out["life"] == "range":
        out["f1"] = _round_js(s["f1"]) if _num(s.get("f1")) else out["f"]
    if isinstance(s.get("link"), str) and s["link"]:
        out["link"] = s["link"]
    if s.get("off"):
        out["off"] = True
    return out


def stroke_live(s, f):
    if not s or s.get("off"):
        return False
    life = s["life"]
    if life == "single":
        return f == s["f"]
    if life == "from":
        return f >= s["f"]
    if life == "to":
        return f <= s["f"]
    if life == "range":
        return min(s["f"], s["f1"]) <= f <= max(s["f"], s["f1"])
    return True


def live_strokes(strokes, f):
    out = []
    for raw in strokes if isinstance(strokes, list) else []:
        s = clean_stroke(raw)
        if s and stroke_live(s, f):
            out.append(s)
    return out


def paint_frames(strokes, f):
    """The input frames besides f a Paint node reads at f: {"clone": [...], "reveal": [...]}."""
    clone, reveal = [], []
    for s in live_strokes(strokes, f):
        if s["tool"] == "clone" and s["dt"] and f + s["dt"] not in clone:
            clone.append(f + s["dt"])
        if s["tool"] == "reveal" and f + s["dt"] not in reveal:
            reveal.append(f + s["dt"])
    return {"clone": clone, "reveal": reveal}


def dab_at(d, r, hard):
    """Paint's ``dabAt`` over an array of distances."""
    inner = r * hard
    t = (d - inner) / max(1e-6, r - inner)
    a = 1 - t * t * (3 - 2 * t)
    return np.where(d >= r, 0.0, np.where(d <= inner, 1.0, a))


def dabs_along(x0, y0, x1, y1, radius, spacing, carry=0.0):
    """Paint's ``dabsAlong``: the dabs along a segment and the distance left over."""
    step = max(0.5, radius * 2 * spacing)
    dx, dy = x1 - x0, y1 - y0
    ln = math.hypot(dx, dy)
    out = []
    t = step - carry
    if carry == 0 and ln == 0:
        return [[x0, y0]], 0.0
    while t <= ln:
        out.append([x0 + dx * (t / (ln or 1)), y0 + dy * (t / (ln or 1))])
        t += step
    return out, ln - (t - step)


def stroke_dabs(s, m=None):
    P = [[m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] for x, y in s["pts"]] if m else s["pts"]
    r = s["size"] / 2
    out = [[P[0][0], P[0][1]]]
    carry = 0.0
    for i in range(1, len(P)):
        (x0, y0), (x1, y1) = P[i - 1], P[i]
        if x0 == x1 and y0 == y1:
            continue
        dabs, carry = dabs_along(x0, y0, x1, y1, r, s["spacing"], carry)
        out.extend(dabs)
    return out


def stroke_cover(s, w, h, scale=1.0, m=None):
    """(cover [H, W] float64, x0, y0, x1, y1) or None: the page's ``strokeCover``."""
    dabs = stroke_dabs(s, m)
    r = (s["size"] / 2) * scale
    hard = s["hard"]
    boxes = []
    for x, y in dabs:
        cx, cy = x * scale, y * scale
        boxes.append((cx, cy, max(0, math.floor(cx - r)), max(0, math.floor(cy - r)),
                      min(w, math.ceil(cx + r)), min(h, math.ceil(cy + r))))
    bx0 = min([w] + [b[2] for b in boxes])
    by0 = min([h] + [b[3] for b in boxes])
    bx1 = max([0] + [b[4] for b in boxes])
    by1 = max([0] + [b[5] for b in boxes])
    if bx1 <= bx0 or by1 <= by0:
        return None
    cover = np.zeros((h, w), np.float64)
    for cx, cy, x0, y0, x1, y1 in boxes:
        if x1 <= x0 or y1 <= y0:
            continue
        px = np.arange(x0, x1, dtype=np.float64) + 0.5 - cx
        py = np.arange(y0, y1, dtype=np.float64)[:, None] + 0.5 - cy
        a = dab_at(np.hypot(px, py), r, hard)
        np.maximum(cover[y0:y1, x0:x1], a, out=cover[y0:y1, x0:x1])
    return cover, bx0, by0, bx1, by1


def paint_image(img, strokes, scale, source_of, matrix_of=lambda s: None):
    """The strokes laid on ``img`` (float32 [H, W, 4], premultiplied); ``source_of(stroke, current)`` gives a clone /
    reveal stroke's picture already moved by its offset (None: it does nothing)."""
    h, w = img.shape[:2]
    out = img.astype(np.float32, copy=True)
    for s in strokes:
        cv = stroke_cover(s, w, h, scale, matrix_of(s))
        if cv is None:
            continue
        cover, x0, y0, x1, y1 = cv
        S = None
        if s["tool"] in ("clone", "reveal"):
            S = source_of(s, out)
            if S is None:
                continue
        k = cover[y0:y1, x0:x1] * s["opacity"]
        on = (k > 0)[..., None]
        k = k[..., None]
        o = out[y0:y1, x0:x1].astype(np.float64)
        if s["tool"] == "color":
            c = s["color"]
            ca = c[3]
            cp = np.array([c[0] * ca, c[1] * ca, c[2] * ca, ca], np.float64)
            new = cp * k + o * (1 - ca * k)
        elif s["tool"] == "erase":
            new = o * (1 - k)
        else:
            new = o * (1 - k) + S[y0:y1, x0:x1].astype(np.float64) * k
        out[y0:y1, x0:x1] = np.where(on, new, o).astype(np.float32)
    return out
