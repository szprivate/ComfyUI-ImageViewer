"""Paint's smart layers, the server's half (``js/imageViewer_paintSmartLayer.js`` is the page's; the two
draw alike - ``tests/test_paint_parity.py`` compares them).

A smart layer is a pixel layer that keeps the picture it was made from (its SOURCE, at that picture's own
size, in ``doc.sources`` by id) and ``L["smart"] = {src, sw, sh, m}``: ``m`` the 3 x 3 projective matrix
from the source's pixels to the layer's own (the canvas less ``x, y``); ``cut`` when only the part over the
canvas is drawn. Its pixels are drawn again from the source whenever that matrix changes, so a scale, a
rotation or a Distort loses nothing. Written from the textbook definitions (homogeneous coordinates,
bilinear sampling, a 2 x 2 box filter per level of a mip chain).
"""
from __future__ import annotations

import math
import re

import numpy as np

MAX_SRC_SIDE = 16384
DRAW_LIMIT = 4096 * 4096
_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")


def _num(v, d, lo=None, hi=None):
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = float(d)
    if not math.isfinite(x):
        x = float(d)
    if lo is not None:
        x = max(lo, x)
    if hi is not None:
        x = min(hi, x)
    return x


def mul3(A, B):
    return [A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c] for r in range(3) for c in range(3)]


def det3(m):
    return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])


def inv3(m):
    d = det3(m)
    if not d or not math.isfinite(d):
        return None
    return [(m[4] * m[8] - m[5] * m[7]) / d, (m[2] * m[7] - m[1] * m[8]) / d, (m[1] * m[5] - m[2] * m[4]) / d,
            (m[5] * m[6] - m[3] * m[8]) / d, (m[0] * m[8] - m[2] * m[6]) / d, (m[2] * m[3] - m[0] * m[5]) / d,
            (m[3] * m[7] - m[4] * m[6]) / d, (m[1] * m[6] - m[0] * m[7]) / d, (m[0] * m[4] - m[1] * m[3]) / d]


def move3(dx, dy):
    return [1.0, 0.0, float(dx), 0.0, 1.0, float(dy), 0.0, 0.0, 1.0]


def scale3(kx, ky=None):
    return [float(kx), 0.0, 0.0, 0.0, float(kx if ky is None else ky), 0.0, 0.0, 0.0, 1.0]


def apply3(m, x, y):
    w = m[6] * x + m[7] * y + m[8]
    return ((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w)


def corners(m, sw, sh):
    return [apply3(m, 0, 0), apply3(m, sw, 0), apply3(m, sw, sh), apply3(m, 0, sh)]


def drawable(m, sw, sh):
    if not abs(det3(m)) > 1e-12:
        return False
    return all(m[6] * x + m[7] * y + m[8] > 1e-9 for x, y in ((0, 0), (sw, 0), (sw, sh), (0, sh)))


def clean_smart(s):
    """``L["smart"]`` held to what it may be (``cleanSmart``), or None."""
    if not isinstance(s, dict) or not _ID.fullmatch(str(s.get("src") or "")):
        return None
    sw, sh = int(_num(s.get("sw"), 0, 0, MAX_SRC_SIDE)), int(_num(s.get("sh"), 0, 0, MAX_SRC_SIDE))
    m = s.get("m")
    if sw < 1 or sh < 1 or not isinstance(m, (list, tuple)) or len(m) != 9:
        return None
    try:
        m = [float(v) for v in m]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in m) or not drawable(m, sw, sh):
        return None
    out = {"src": str(s["src"]), "sw": sw, "sh": sh, "m": m}
    if s.get("cut"):
        out["cut"] = True
    return out


def canvas_matrix(L):
    return mul3(move3(L["x"], L["y"]), L["smart"]["m"])


def min_scale(m, sw, sh):
    q = corners(m, sw, sh)

    def ln(a, b):
        return math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]))
    return min(ln(q[0], q[1]) / sw, ln(q[1], q[2]) / sh, ln(q[3], q[2]) / sw, ln(q[0], q[3]) / sh)


def level_for(m, sw, sh):
    s = min_scale(m, sw, sh)
    k = 0
    while k < 12 and s * math.pow(2, k) < 0.5 and (sw >> (k + 1)) >= 1 and (sh >> (k + 1)) >= 1:
        k += 1
    return k


def halve(px):
    """Half the size (rounded up): each pixel the premultiplied mean of the 2 x 2 under it (``halveRGBA``)."""
    h, w = px.shape[:2]
    H, W = (h + 1) // 2, (w + 1) // 2
    p = np.zeros((H * 2, W * 2, 4), np.float64)
    p[:h, :w] = px
    there = np.zeros((H * 2, W * 2), np.float64)
    there[:h, :w] = 1
    r = g = b = al = n = None
    for j in (0, 1):
        for i in (0, 1):
            q = p[j::2, i::2]
            a = q[..., 3]
            t = (q[..., 0] * a, q[..., 1] * a, q[..., 2] * a, a, there[j::2, i::2])
            if r is None:
                r, g, b, al, n = t
            else:
                r, g, b, al, n = r + t[0], g + t[1], b + t[2], al + t[3], n + t[4]
    out = np.zeros((H, W, 4), np.float64)
    ok = al > 0
    safe = np.where(ok, al, 1)
    out[..., 0] = np.where(ok, r / safe, 0)
    out[..., 1] = np.where(ok, g / safe, 0)
    out[..., 2] = np.where(ok, b / safe, 0)
    out[..., 3] = al / n
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def level(px, k, cache=None):
    """Level *k* of a source's mip chain (kept in *cache*, a list, when given)."""
    chain = cache if cache is not None else []
    if not chain:
        chain.append(px)
    while len(chain) <= k:
        chain.append(halve(chain[-1]))
    return chain[k]


def box_of(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, y0 = math.floor(min(xs) + 1e-6), math.floor(min(ys) + 1e-6)
    return {"x": x0, "y": y0, "w": max(1, math.ceil(max(xs) - 1e-6) - x0), "h": max(1, math.ceil(max(ys) - 1e-6) - y0)}


def draw_box(cm, sw, sh, W, H):
    box = box_of(corners(cm, sw, sh))
    if box["w"] * box["h"] <= max(DRAW_LIMIT, 4 * W * H) and box["w"] <= MAX_SRC_SIDE and box["h"] <= MAX_SRC_SIDE:
        return box, False
    x0, y0 = max(box["x"], 0), max(box["y"], 0)
    x1, y1 = min(box["x"] + box["w"], W), min(box["y"] + box["h"], H)
    if x1 <= x0 or y1 <= y0:
        return {"x": 0, "y": 0, "w": 1, "h": 1}, True
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}, True


def render(src, cm, W, H, cache=None):
    """The source (RGBA h x w) drawn by the canvas matrix *cm* onto a W x H canvas: (pixels, box, m, cut)."""
    sh, sw = src.shape[:2]
    box, cut = draw_box(cm, sw, sh, W, H)
    k = level_for(cm, sw, sh)
    lv = level(src, k, cache)
    inv = inv3(mul3(cm, scale3(math.pow(2, k))))
    m = mul3(move3(-box["x"], -box["y"]), cm)
    out = np.zeros((box["h"], box["w"], 4), np.uint8)
    if inv is None:
        return out, box, m, cut
    s = lv.astype(np.float64)
    rows = max(1, (1 << 20) // box["w"])          # a million pixels at a time
    for y0 in range(0, box["h"], rows):
        y1 = min(box["h"], y0 + rows)
        out[y0:y1] = _sample_rows(s, inv, box, y0, y1)
    return out, box, m, cut


def _sample_rows(s, inv, box, y0, y1):
    """Rows y0..y1 of the box: each pixel's middle back through *inv*, bilinear, premultiplied (``render``)."""
    h, w = s.shape[:2]
    gx, gy = np.meshgrid(np.arange(box["w"], dtype=np.float64) + box["x"] + 0.5,
                         np.arange(y0, y1, dtype=np.float64) + box["y"] + 0.5)
    d = inv[6] * gx + inv[7] * gy + inv[8]
    front = d > 0
    sd = np.where(front, d, 1)
    u = (inv[0] * gx + inv[1] * gy + inv[2]) / sd
    v = (inv[3] * gx + inv[4] * gy + inv[5]) / sd
    fu, fv = u - 0.5, v - 0.5
    u0, v0 = np.floor(fu), np.floor(fv)
    du, dv = fu - u0, fv - v0
    u0 = np.clip(u0, -2, w + 1).astype(np.int64)
    v0 = np.clip(v0, -2, h + 1).astype(np.int64)
    r = g = b = al = None
    for j in (0, 1):
        vy = v0 + j
        wy = dv if j else 1 - dv
        for i in (0, 1):
            ux = u0 + i
            ok = front & (vy >= 0) & (vy < h) & (ux >= 0) & (ux < w)
            q = s[np.clip(vy, 0, h - 1), np.clip(ux, 0, w - 1)]
            pa = np.where(ok, q[..., 3] * (wy * (du if i else 1 - du)), 0.0)
            t = (q[..., 0] * pa, q[..., 1] * pa, q[..., 2] * pa, pa)
            if r is None:
                r, g, b, al = t
            else:
                r, g, b, al = r + t[0], g + t[1], b + t[2], al + t[3]
    seen = al > 0
    safe = np.where(seen, al, 1)
    res = np.zeros(gx.shape + (4,), np.float64)
    res[..., 0] = np.where(seen, r / safe, 0)
    res[..., 1] = np.where(seen, g / safe, 0)
    res[..., 2] = np.where(seen, b / safe, 0)
    res[..., 3] = np.where(seen, al, 0)
    return np.clip(np.round(res), 0, 255).astype(np.uint8)


def place_matrix(sw, sh, W, H, fit=True):
    k = min(1.0, W / sw, H / sh) if fit else 1.0
    w, h = sw * k, sh * k
    return mul3(move3(_round(( W - w) / 2), _round((H - h) / 2)), scale3(k))


def _round(x):
    """JavaScript's Math.round (half up), not Python's (half to even)."""
    return math.floor(x + 0.5)


def draw(doc, L, cm=None):
    """Draw the smart layer *L* of *doc* again from its source by the canvas matrix *cm* (else its own)."""
    src = doc.sources.get(L["smart"]["src"])
    if src is None:
        return False
    cm = cm or canvas_matrix(L)
    sh, sw = src.shape[:2]
    if not drawable(cm, sw, sh):
        raise ValueError("that would turn the smart layer inside out")
    px, box, m, cut = render(src, cm, doc.w, doc.h)
    doc.px[L["id"]] = px
    L.update(x=box["x"], y=box["y"], w=box["w"], h=box["h"])
    L["smart"] = dict(L["smart"], m=m)
    if cut:
        L["smart"]["cut"] = True
    else:
        L["smart"].pop("cut", None)
    drawn = getattr(doc, "_smart_drawn", None)
    if drawn is not None:
        drawn.add(L["id"])
    return True


def apply(doc, L, G):
    """A canvas transform *G* (3 x 3) laid on the smart layer *L*: drawn again from its source."""
    return draw(doc, L, mul3(G, canvas_matrix(L)))


def is_smart(doc, L):
    return L.get("kind") == "pixel" and bool(L.get("smart")) and L["smart"]["src"] in doc.sources


def describe(L):
    s = L["smart"]
    q = corners(canvas_matrix(L), s["sw"], s["sh"])

    def ln(a, b):
        return math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)
    return {"source": [s["sw"], s["sh"]],
            "scale": [round((ln(q[0], q[1]) + ln(q[3], q[2])) / 2 / s["sw"] * 100, 1),
                      round((ln(q[0], q[3]) + ln(q[1], q[2])) / 2 / s["sh"] * 100, 1)],
            "corners": [[round(x, 1), round(y, 1)] for x, y in q]}
