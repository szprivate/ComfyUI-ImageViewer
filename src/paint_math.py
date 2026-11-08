"""Paint's arithmetic: how layers are laid over each other, what an adjustment layer does to the
picture under it, the filters, and the selection's shapes.

ONE arithmetic, twice: ``js/imageViewer_paintData.js`` draws the page with the same formulas,
in the same order, with the same rounding (``floor(x * 255 + 0.5)`` after every layer), so a
picture the server writes (an export, the agent's ``edit_image``, an .ora's merged image) is the
picture the user saw. A change here is a change there; ``tests/test_paint_parity.py`` runs both on
the same documents and compares them pixel by pixel.

Pictures are numpy ``uint8`` arrays ``(h, w, 4)``, straight (not premultiplied) RGBA; masks are
``uint8`` ``(h, w)``. No ComfyUI, no aiohttp in here.
"""
from __future__ import annotations

import math
import uuid

import numpy as np

# ── blend modes ──────────────────────────────────────────────────────────────
#
# The W3C compositing formulas (what a browser's canvas does for the separable modes), on straight
# colour 0..1: Cs' = (1 - ab) Cs + ab B(Cb, Cs); ao = as + ab (1 - as); Co = (as Cs' + (1 - as) ab Cb) / ao.
# "add" is Photoshop's Linear Dodge: B = min(1, Cb + Cs) (NOT the canvas's "lighter", which adds
# premultiplied colour and does not stop at the backdrop's alpha).

BLEND_MODES = ("normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "add",
               "color_dodge", "color_burn", "soft_light", "hard_light")
#: A group's blend: Pass Through (its layers straight onto what is under it) or one of the modes.
GROUP_BLENDS = ("pass_through",) + BLEND_MODES

#: Photoshop's four-letter key of each mode (PSD layer records).
PSD_BLEND = {"normal": b"norm", "multiply": b"mul ", "screen": b"scrn", "overlay": b"over",
             "darken": b"dark", "lighten": b"lite", "difference": b"diff", "add": b"lddg",
             "color_dodge": b"div ", "color_burn": b"idiv", "soft_light": b"sLit", "hard_light": b"hLit"}
PSD_BLEND_BACK = {v: k for k, v in PSD_BLEND.items()}
PSD_PASS = b"pass"
#: OpenRaster's composite-op names (``svg:*``); ours where there is no such name.
ORA_BLEND = {"normal": "svg:src-over", "multiply": "svg:multiply", "screen": "svg:screen", "overlay": "svg:overlay",
             "darken": "svg:darken", "lighten": "svg:lighten", "difference": "svg:difference", "add": "svg:plus",
             "color_dodge": "svg:color-dodge", "color_burn": "svg:color-burn", "soft_light": "svg:soft-light",
             "hard_light": "svg:hard-light"}
ORA_BLEND_BACK = {v: k for k, v in ORA_BLEND.items()}


def _hard_light(cb, cs):
    return np.where(cs <= 0.5, cb * 2 * cs, 1 - (1 - cb) * (1 - (2 * cs - 1)))


def blend_fn(mode, cb, cs):
    """B(Cb, Cs) on float arrays 0..1."""
    if mode == "multiply":
        return cb * cs
    if mode == "screen":
        return cb + cs - cb * cs
    if mode == "overlay":
        return _hard_light(cs, cb)
    if mode == "darken":
        return np.minimum(cb, cs)
    if mode == "lighten":
        return np.maximum(cb, cs)
    if mode == "difference":
        return np.abs(cb - cs)
    if mode == "add":
        return np.minimum(1.0, cb + cs)
    if mode == "color_dodge":
        return np.where(cb <= 0, 0.0, np.where(cs >= 1, 1.0, np.minimum(1.0, cb / np.maximum(1e-12, 1 - cs))))
    if mode == "color_burn":
        return np.where(cb >= 1, 1.0, np.where(cs <= 0, 0.0, 1 - np.minimum(1.0, (1 - cb) / np.maximum(1e-12, cs))))
    if mode == "soft_light":
        d = np.where(cb <= 0.25, ((16 * cb - 12) * cb + 4) * cb, np.sqrt(cb))
        return np.where(cs <= 0.5, cb - (1 - 2 * cs) * cb * (1 - cb), cb + (2 * cs - 1) * (d - cb))
    if mode == "hard_light":
        return _hard_light(cb, cs)
    return cs


def q8(x):
    """Back to 0..255 the one way both sides do it: floor(x * 255 + 0.5), held to 0..255."""
    return np.clip(np.floor(np.asarray(x, dtype=np.float64) * 255.0 + 0.5), 0, 255).astype(np.uint8)


def blend_over(back, src, alpha, mode="normal"):
    """*src* (h, w, 4 uint8) laid over *back* (same shape) with its alpha times *alpha* (h, w floats
    0..1: opacity x mask). Returns a new uint8 array."""
    cb = back[..., :3].astype(np.float64) / 255.0
    ab = back[..., 3].astype(np.float64) / 255.0
    cs = src[..., :3].astype(np.float64) / 255.0
    a_s = (src[..., 3].astype(np.float64) / 255.0) * alpha
    b = blend_fn(mode, cb, cs) if mode != "normal" else cs
    ab3, as3 = ab[..., None], a_s[..., None]
    cs2 = (1 - ab3) * cs + ab3 * b
    ao = a_s + ab * (1 - a_s)
    num = as3 * cs2 + (1 - as3) * ab3 * cb
    co = np.where(ao[..., None] > 0, num / np.maximum(ao[..., None], 1e-12), 0.0)
    out = np.empty_like(back)
    out[..., :3] = q8(co)
    out[..., 3] = q8(ao)
    return out


def clip_over(back, src, alpha, mode="normal"):
    """A clipped layer over its base (``paintData.layClipped``): Co = Cb + (B(Cb, Cs) - Cb) t with
    t = as x *alpha*, only where the base is (ab > 0); the base's alpha is kept. A new uint8 array."""
    cb = back[..., :3].astype(np.float64) / 255.0
    cs = src[..., :3].astype(np.float64) / 255.0
    t = (src[..., 3].astype(np.float64) / 255.0) * alpha
    t = np.where(back[..., 3] > 0, t, 0.0)
    b = blend_fn(mode, cb, cs) if mode != "normal" else cs
    out = back.copy()
    co = cb + (b - cb) * t[..., None]
    keep = (t == 0)[..., None]
    out[..., :3] = np.where(keep, back[..., :3], q8(co))
    return out


def mix_back(back, res, t):
    """*back* + (*res* - *back*) * *t* (h, w floats), premultiplied: a Pass Through group with an opacity
    under 1 or a mask (``paintData.mixBack``). Returns a new uint8 array."""
    ab = back[..., 3].astype(np.float64) / 255.0
    ar = res[..., 3].astype(np.float64) / 255.0
    ao = ab + (ar - ab) * t
    pb = (back[..., :3].astype(np.float64) / 255.0) * ab[..., None]
    pr = (res[..., :3].astype(np.float64) / 255.0) * ar[..., None]
    pc = pb + (pr - pb) * t[..., None]
    co = np.where(ao[..., None] > 0, pc / np.maximum(ao[..., None], 1e-12), 0.0)
    out = np.empty_like(back)
    out[..., :3] = q8(co)
    out[..., 3] = q8(ao)
    return out


# ── adjustments ──────────────────────────────────────────────────────────────
#
# An adjustment layer changes the colour of what is under it: R = f(Cb), then Co = Cb + (R - Cb) t with
# t = opacity x mask; the alpha stays. Every type is a table per channel (LUT) except hue/saturation,
# which is worked out per pixel in HSL.

ADJUST_TYPES = ("levels", "curves", "brightness_contrast", "exposure", "hue_saturation", "grade", "invert",
                "threshold")

ADJUST_DEFAULTS = {
    "levels": {"in_black": 0, "in_white": 255, "gamma": 1.0, "out_black": 0, "out_white": 255},
    "curves": {"rgb": [[0, 0], [255, 255]], "r": None, "g": None, "b": None},
    "brightness_contrast": {"brightness": 0, "contrast": 0},
    "exposure": {"exposure": 0.0, "offset": 0.0, "gamma": 1.0},
    "hue_saturation": {"hue": 0, "saturation": 0, "lightness": 0},
    "grade": {"lift": [0.0, 0.0, 0.0], "gamma": [1.0, 1.0, 1.0], "gain": [1.0, 1.0, 1.0]},
    "invert": {},
    "threshold": {"level": 128},
}

ADJUST_LABELS = {"levels": "Levels", "curves": "Curves", "brightness_contrast": "Brightness/Contrast",
                 "exposure": "Exposure", "hue_saturation": "Hue/Saturation", "grade": "Grade",
                 "invert": "Invert", "threshold": "Threshold"}


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


def _triple(v, d, lo, hi):
    if isinstance(v, (int, float)):
        v = [v, v, v]
    if not isinstance(v, (list, tuple)) or len(v) != 3:
        v = [d, d, d]
    return [_num(x, d, lo, hi) for x in v]


def _points(v):
    if not isinstance(v, (list, tuple)):
        return None
    pts = []
    for p in v:
        if isinstance(p, (list, tuple)) and len(p) == 2:
            pts.append([_num(p[0], 0, 0, 255), _num(p[1], 0, 0, 255)])
    pts.sort(key=lambda p: p[0])
    clean = []
    for p in pts:
        if clean and abs(p[0] - clean[-1][0]) < 1:
            clean[-1] = p
        else:
            clean.append(p)
    return clean if len(clean) >= 2 else None


def clean_adjust(kind, params):
    """An adjustment's params held to their ranges (``paintData.cleanAdjust`` is the same)."""
    if kind not in ADJUST_TYPES:
        raise ValueError(f"unknown adjustment {kind!r} (one of {', '.join(ADJUST_TYPES)})")
    p = params if isinstance(params, dict) else {}
    d = ADJUST_DEFAULTS[kind]
    if kind == "levels":
        ib = _num(p.get("in_black"), d["in_black"], 0, 254)
        iw = _num(p.get("in_white"), d["in_white"], ib + 1, 255)
        return {"in_black": ib, "in_white": iw, "gamma": _num(p.get("gamma"), 1.0, 0.1, 9.99),
                "out_black": _num(p.get("out_black"), 0, 0, 255), "out_white": _num(p.get("out_white"), 255, 0, 255)}
    if kind == "curves":
        out = {"rgb": _points(p.get("rgb")) or [[0, 0], [255, 255]]}
        for ch in ("r", "g", "b"):
            out[ch] = _points(p.get(ch))
        return out
    if kind == "brightness_contrast":
        return {"brightness": _num(p.get("brightness"), 0, -100, 100), "contrast": _num(p.get("contrast"), 0, -100, 100)}
    if kind == "exposure":
        return {"exposure": _num(p.get("exposure"), 0, -10, 10), "offset": _num(p.get("offset"), 0, -0.5, 0.5),
                "gamma": _num(p.get("gamma"), 1, 0.1, 9.99)}
    if kind == "hue_saturation":
        return {"hue": _num(p.get("hue"), 0, -180, 180), "saturation": _num(p.get("saturation"), 0, -100, 100),
                "lightness": _num(p.get("lightness"), 0, -100, 100)}
    if kind == "grade":
        return {"lift": _triple(p.get("lift"), 0.0, -1, 1), "gamma": _triple(p.get("gamma"), 1.0, 0.1, 9.99),
                "gain": _triple(p.get("gain"), 1.0, 0, 4)}
    if kind == "threshold":
        return {"level": _num(p.get("level"), 128, 1, 255)}
    return {}


def _monotone(points):
    """A monotone cubic through *points* (Fritsch-Carlson), as a table of 256: the Curves shape."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    n = len(xs)
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        m[i] = 0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = m[i + 1] = 0.0
            continue
        a, b = m[i] / d[i], m[i + 1] / d[i]
        s = a * a + b * b
        if s > 9:
            t = 3 / math.sqrt(s)
            m[i], m[i + 1] = t * a * d[i], t * b * d[i]
    lut = []
    for v in range(256):
        if v <= xs[0]:
            y = ys[0]
        elif v >= xs[-1]:
            y = ys[-1]
        else:
            k = 0
            while v > xs[k + 1]:
                k += 1
            h = xs[k + 1] - xs[k]
            t = (v - xs[k]) / h
            t2, t3 = t * t, t * t * t
            y = ((2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k]
                 + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1])
        lut.append(min(255.0, max(0.0, y)) / 255.0)
    return lut


def _srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lin_to_srgb(c):
    if c <= 0:
        return 0.0
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def adjust_luts(kind, params):
    """Three tables (R, G, B) of 256 floats 0..1, or None for hue/saturation (per pixel)."""
    p = clean_adjust(kind, params)
    vs = [i / 255.0 for i in range(256)]
    if kind == "levels":
        ib, iw, ob, ow = p["in_black"] / 255, p["in_white"] / 255, p["out_black"] / 255, p["out_white"] / 255
        g = 1 / p["gamma"]
        one = [ob + (ow - ob) * (min(1.0, max(0.0, (v - ib) / (iw - ib))) ** g) for v in vs]
        return [one, one, one]
    if kind == "curves":
        master = _monotone(p["rgb"])
        out = []
        for ch in ("r", "g", "b"):
            own = _monotone(p[ch]) if p[ch] else None
            out.append([own[int(math.floor(x * 255 + 0.5))] if own else x for x in master])
        return out
    if kind == "brightness_contrast":
        c = p["contrast"] / 100
        f = 1 / (1 - c * 0.99) if c >= 0 else 1 + c
        b = p["brightness"] / 200
        one = [min(1.0, max(0.0, (v - 0.5) * f + 0.5 + b)) for v in vs]
        return [one, one, one]
    if kind == "exposure":
        k = 2 ** p["exposure"]
        g = 1 / p["gamma"]
        one = []
        for v in vs:
            x = max(0.0, _srgb_to_lin(v) * k + p["offset"])
            one.append(min(1.0, max(0.0, _lin_to_srgb(x ** g))))
        return [one, one, one]
    if kind == "grade":
        out = []
        for ch in range(3):
            lift, gam, gain = p["lift"][ch], p["gamma"][ch], p["gain"][ch]
            row = []
            for v in vs:
                x = max(0.0, gain * (v + lift * (1 - v)))
                row.append(min(1.0, x ** (1 / gam)))
            out.append(row)
        return out
    if kind == "invert":
        one = [1 - v for v in vs]
        return [one, one, one]
    if kind == "threshold":
        return None
    return None


def _hsl_adjust(rgb, p):
    """Hue / saturation / lightness on (n, 3) floats 0..1 (paintData's hueSat, the same steps)."""
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    l = (mx + mn) / 2
    d = mx - mn
    s = np.where(d == 0, 0.0, d / np.maximum(1e-12, 1 - np.abs(2 * l - 1)))
    h = np.zeros_like(l)
    nz = d > 0
    rr = nz & (mx == r)
    gg = nz & (mx == g) & ~rr
    bb = nz & ~rr & ~gg
    h = np.where(rr, ((g - b) / np.where(nz, d, 1)) % 6, h)
    h = np.where(gg, (b - r) / np.where(nz, d, 1) + 2, h)
    h = np.where(bb, (r - g) / np.where(nz, d, 1) + 4, h)
    h = (h * 60 + p["hue"]) % 360
    sat = p["saturation"] / 100
    s = np.clip(s * (1 + sat), 0, 1)
    light = p["lightness"] / 100
    l = np.where(light > 0, l + (1 - l) * light, l * (1 + light))
    c = (1 - np.abs(2 * l - 1)) * s
    hp = h / 60
    x = c * (1 - np.abs(hp % 2 - 1))
    m = l - c / 2
    z = np.zeros_like(c)
    i = np.floor(hp).astype(np.int64) % 6
    rs = np.choose(i, [c, x, z, z, x, c])
    gs = np.choose(i, [x, c, c, x, z, z])
    bs = np.choose(i, [z, z, x, c, c, x])
    return np.stack([rs + m, gs + m, bs + m], axis=1)


def apply_adjust(back, kind, params, t):
    """An adjustment layer over *back* (h, w, 4 uint8); *t* (h, w floats) is opacity x mask."""
    p = clean_adjust(kind, params)
    cb = back[..., :3].astype(np.float64) / 255.0
    if kind == "hue_saturation":
        flat = cb.reshape(-1, 3)
        res = _hsl_adjust(flat, p).reshape(cb.shape)
    elif kind == "threshold":
        lum = (0.2126 * back[..., 0] + 0.7152 * back[..., 1] + 0.0722 * back[..., 2])
        one = (lum >= p["level"]).astype(np.float64)
        res = np.repeat(one[..., None], 3, axis=2)
    else:
        luts = adjust_luts(kind, p)
        res = np.empty_like(cb)
        for ch in range(3):
            res[..., ch] = np.asarray(luts[ch], dtype=np.float64)[back[..., ch]]
    co = cb + (res - cb) * t[..., None]
    out = back.copy()
    out[..., :3] = q8(co)
    return out


def adjust_pixels(pixels, kind, params):
    """An adjustment baked into one picture (merge an adjustment layer down onto a pixel layer)."""
    t = np.ones(pixels.shape[:2], dtype=np.float64)
    return apply_adjust(pixels, kind, params, t)


# ── filters ──────────────────────────────────────────────────────────────────
#
# A Gaussian blur as three box blurs (the sizes of boxesForGauss), each along x then y, with the
# edge pixel repeated; on premultiplied colour so a transparent edge does not bleed black.

def boxes_for_gauss(sigma, n=3):
    if sigma <= 0:
        return [1] * n
    w_ideal = math.sqrt((12 * sigma * sigma / n) + 1)
    wl = int(math.floor(w_ideal))
    if wl % 2 == 0:
        wl -= 1
    wu = wl + 2
    m_ideal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4)
    m = int(round(m_ideal))
    return [wl if i < m else wu for i in range(n)]


def _box_axis(a, r, axis):
    """Mean over a window of 2r+1 along *axis*, the edge value repeated (a float array)."""
    if r <= 0:
        return a
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode="edge")
    c = np.cumsum(p, axis=axis, dtype=np.float64)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return (hi - lo) / (2 * r + 1)


def blur_float(a, radius):
    """*a* (h, w) or (h, w, c) floats, blurred with sigma = radius / 2 (radius in pixels)."""
    sigma = max(0.0, float(radius)) / 2
    if sigma <= 0:
        return a
    out = a.astype(np.float64)
    for size in boxes_for_gauss(sigma):
        r = (size - 1) // 2
        out = _box_axis(out, r, 1)
        out = _box_axis(out, r, 0)
    return out


def blur_pixels(px, radius):
    f = px.astype(np.float64) / 255.0
    a = f[..., 3:4]
    pm = np.concatenate([f[..., :3] * a, a], axis=2)
    b = blur_float(pm, radius)
    ab = b[..., 3:4]
    rgb = np.where(ab > 0, b[..., :3] / np.maximum(ab, 1e-12), 0.0)
    out = np.empty_like(px)
    out[..., :3] = q8(rgb)
    out[..., 3] = q8(ab[..., 0])
    return out


def sharpen_pixels(px, radius, amount):
    f = px[..., :3].astype(np.float64) / 255.0
    b = blur_float(f, radius)
    out = px.copy()
    out[..., :3] = q8(f + (f - b) * float(amount))
    return out


# ── selections ───────────────────────────────────────────────────────────────
#
# A selection is a mask (h, w) uint8, 255 inside. Shapes are decided at pixel CENTRES, no
# antialiasing (both sides alike); feather blurs the mask.

def rect_mask(w, h, x, y, rw, rh):
    m = np.zeros((h, w), dtype=np.uint8)
    x0, y0 = int(round(max(0, x))), int(round(max(0, y)))
    x1, y1 = int(round(min(w, x + rw))), int(round(min(h, y + rh)))
    if x1 > x0 and y1 > y0:
        m[y0:y1, x0:x1] = 255
    return m


def ellipse_mask(w, h, x, y, rw, rh):
    if rw <= 0 or rh <= 0:
        return np.zeros((h, w), dtype=np.uint8)
    cx, cy, rx, ry = x + rw / 2, y + rh / 2, rw / 2, rh / 2
    yy, xx = np.mgrid[0:h, 0:w]
    inside = (((xx + 0.5 - cx) / rx) ** 2 + ((yy + 0.5 - cy) / ry) ** 2) <= 1
    return np.where(inside, 255, 0).astype(np.uint8)


def polygon_mask(w, h, pts):
    """Even-odd fill of a polygon [[x, y], ...] at pixel centres."""
    m = np.zeros((h, w), dtype=np.uint8)
    if not pts or len(pts) < 3:
        return m
    xs = np.array([p[0] for p in pts], dtype=np.float64)
    ys = np.array([p[1] for p in pts], dtype=np.float64)
    n = len(pts)
    for row in range(h):
        cy = row + 0.5
        hits = []
        for i in range(n):
            j = (i + 1) % n
            y0, y1 = ys[i], ys[j]
            if (y0 <= cy < y1) or (y1 <= cy < y0):
                hits.append(xs[i] + (cy - y0) * (xs[j] - xs[i]) / (y1 - y0))
        hits.sort()
        for k in range(0, len(hits) - 1, 2):
            a = int(math.ceil(hits[k] - 0.5))
            b = int(math.floor(hits[k + 1] - 0.5))
            a, b = max(0, a), min(w - 1, b)
            if b >= a:
                m[row, a:b + 1] = 255
    return m


def combine_masks(old, new, op):
    """replace / add / subtract / intersect."""
    if old is None or op == "replace":
        return new
    o, n = old.astype(np.int32), new.astype(np.int32)
    if op == "add":
        return np.maximum(o, n).astype(np.uint8)
    if op == "subtract":
        return np.clip(o - n, 0, 255).astype(np.uint8)
    if op == "intersect":
        return np.minimum(o, n).astype(np.uint8)
    raise ValueError(f"unknown selection op {op!r}")


def feather_mask(m, radius):
    if radius <= 0:
        return m
    return q8(blur_float(m.astype(np.float64) / 255.0, radius))


def mask_bbox(m):
    """(x, y, w, h) of the non-zero part of a mask, or None."""
    if m is None:
        return None
    ys, xs = np.nonzero(m)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)


# ── a quick fill from the surroundings ───────────────────────────────────────

def _shift(a, dy, dx):
    """*a* moved by (dy, dx) with zeros coming in (no wrap-around)."""
    out = np.zeros_like(a)
    h, w = a.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def heal(px, mask, iterations=None):
    """Fill the pixels under *mask* (255 = fill) from around them: the hole is pulled in from its
    edge, then smoothed by repeated averaging (a membrane fill). Not generative - the agent does
    that - but it takes a speck, a wire or a small object away without leaving a hole."""
    hole = mask > 127
    if not hole.any():
        return px.copy()
    f = px.astype(np.float64) / 255.0
    a = f[..., 3:4]
    pm = np.concatenate([f[..., :3] * a, a], axis=2)
    known = ~hole
    cur = np.where(known[..., None], pm, 0.0)
    weight = known.astype(np.float64)
    # Grow inwards: each pass fills the ring of hole pixels touching known ones with their mean.
    todo = hole.copy()
    while todo.any():
        s = np.zeros_like(cur)
        c = np.zeros_like(weight)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
            s += _shift(cur * weight[..., None], dy, dx)
            c += _shift(weight, dy, dx)
        ring = todo & (c > 0)
        if not ring.any():
            break
        cur[ring] = s[ring] / c[ring][..., None]
        weight[ring] = 1.0
        todo &= ~ring
    # Smooth the inside (the known pixels stay).
    n = iterations if iterations is not None else int(min(200, 20 + math.sqrt(hole.sum())))
    ones = np.ones(cur.shape[:2])
    cnt = _shift(ones, 1, 0) + _shift(ones, -1, 0) + _shift(ones, 0, 1) + _shift(ones, 0, -1)
    for _ in range(n):
        avg = (_shift(cur, 1, 0) + _shift(cur, -1, 0) + _shift(cur, 0, 1) + _shift(cur, 0, -1)) / cnt[..., None]
        cur = np.where(hole[..., None], avg, cur)
    ab = cur[..., 3:4]
    rgb = np.where(ab > 0, cur[..., :3] / np.maximum(ab, 1e-12), 0.0)
    out = px.copy()
    out[..., :3] = np.where(hole[..., None], q8(rgb), px[..., :3])
    out[..., 3] = np.where(hole, q8(ab[..., 0]), px[..., 3])
    return out


# ── paths (the pen) ──────────────────────────────────────────────────────────
# imageViewer_paintData.js's cleanPath / flattenPath / strokeMask: the same arithmetic.

MAX_PATHS = 100
MAX_PATH_POINTS = 4000


def clean_path(p):
    p = p if isinstance(p, dict) else {}
    f = lambda v, d: _num(v, d, -1e6, 1e6)
    pts = []
    for a in (p.get("pts") if isinstance(p.get("pts"), list) else [])[:MAX_PATH_POINTS]:
        if not isinstance(a, dict):
            continue
        x, y = f(a.get("x"), 0), f(a.get("y"), 0)
        pts.append({"x": x, "y": y, "ix": f(a.get("ix"), x), "iy": f(a.get("iy"), y),
                    "ox": f(a.get("ox"), x), "oy": f(a.get("oy"), y), "smooth": bool(a.get("smooth"))})
    return {"id": str(p.get("id") or uuid.uuid4().hex[:12])[:40], "name": str(p.get("name") or "Path")[:120],
            "closed": bool(p.get("closed")) and len(pts) > 2, "pts": pts}


def clean_paths(lst):
    out, seen = [], set()
    for p in (lst if isinstance(lst, list) else [])[:MAX_PATHS]:
        c = clean_path(p)
        if not c["pts"] or c["id"] in seen:
            continue
        seen.add(c["id"])
        out.append(c)
    return out


def segment_steps(a, b):
    if a["ox"] == a["x"] and a["oy"] == a["y"] and b["ix"] == b["x"] and b["iy"] == b["y"]:
        return 1
    ln = (math.hypot(a["ox"] - a["x"], a["oy"] - a["y"]) + math.hypot(b["ix"] - a["ox"], b["iy"] - a["oy"])
          + math.hypot(b["x"] - b["ix"], b["y"] - b["iy"]))
    return max(1, min(128, math.ceil(ln / 3)))


def bezier_at(a, b, t):
    u = 1 - t
    A, B, C, E = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
    return [A * a["x"] + B * a["ox"] + C * b["ix"] + E * b["x"], A * a["y"] + B * a["oy"] + C * b["iy"] + E * b["y"]]


def flatten_path(path):
    pts, out = path["pts"], []
    if not pts:
        return out
    out.append([pts[0]["x"], pts[0]["y"]])
    segs = len(pts) if path.get("closed") else len(pts) - 1
    for i in range(segs):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        n = segment_steps(a, b)
        for k in range(1, n + 1):
            if path.get("closed") and i == segs - 1 and k == n:
                break
            out.append([b["x"], b["y"]] if k == n else bezier_at(a, b, k / n))
    return out


def path_mask(w, h, path):
    return polygon_mask(w, h, flatten_path(path))


def stroke_mask(w, h, line, closed, width):
    """A line ``width`` px wide along the polyline: coverage = width / 2 - distance + 0.5, held to 0..1."""
    m = np.zeros((h, w), dtype=np.uint8)
    n, r = len(line), max(0.5, width / 2)
    if not n:
        return m
    segs = [(line[0], line[0])] if n == 1 else []
    segs += [(line[i], line[i + 1]) for i in range(n - 1)]
    if closed and n > 2:
        segs.append((line[-1], line[0]))
    for p, q in segs:
        x0 = max(0, math.floor(min(p[0], q[0]) - r - 1)); x1 = min(w - 1, math.ceil(max(p[0], q[0]) + r + 1))
        y0 = max(0, math.floor(min(p[1], q[1]) - r - 1)); y1 = min(h - 1, math.ceil(max(p[1], q[1]) + r + 1))
        if x1 < x0 or y1 < y0:
            continue
        dx, dy = q[0] - p[0], q[1] - p[1]
        ll = dx * dx + dy * dy
        cx = np.arange(x0, x1 + 1, dtype=np.float64)[None, :] + 0.5 - p[0]
        cy = np.arange(y0, y1 + 1, dtype=np.float64)[:, None] + 0.5 - p[1]
        t = np.clip((cx * dx + cy * dy) / ll, 0, 1) if ll > 0 else np.zeros_like(cx * cy)
        ex, ey = cx - t * dx, cy - t * dy
        c = np.clip(r - np.sqrt(ex * ex + ey * ey) + 0.5, 0, 1)
        v = np.clip(np.floor(c * 255 + 0.5), 0, 255).astype(np.uint8)
        sub = m[y0:y1 + 1, x0:x1 + 1]
        np.maximum(sub, v, out=sub)
    return m


def move_paths(paths, dx=0.0, dy=0.0, kx=1.0, ky=1.0):
    """Every anchor and handle scaled by kx, ky, then moved by dx, dy (a crop, canvas size, resize)."""
    out = []
    for q in paths or []:
        pts = [{**a, "x": a["x"] * kx + dx, "y": a["y"] * ky + dy, "ix": a["ix"] * kx + dx, "iy": a["iy"] * ky + dy,
                "ox": a["ox"] * kx + dx, "oy": a["oy"] * ky + dy} for a in q["pts"]]
        out.append({**q, "pts": pts})
    return out
