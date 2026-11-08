"""Paint's layer styles on the server: the same arithmetic as js/imageViewer_paintStyle.js (drop shadow,
outer glow, stroke, colour overlay), so an export, an .ora's merged image and the agent's result look as
the page drew them. Compared pixel by pixel by tests/test_paint_parity.py."""
from __future__ import annotations

import math

import numpy as np

from . import paint_math as M

STYLE_KINDS = ("shadow", "glow", "stroke", "overlay")
STYLE_DEFAULTS = {
    "shadow": {"on": True, "color": [0, 0, 0], "opacity": 0.75, "angle": 120, "distance": 10, "size": 10},
    "glow": {"on": True, "color": [255, 255, 190], "opacity": 0.75, "size": 20},
    "stroke": {"on": True, "color": [0, 0, 0], "opacity": 1, "size": 3},
    "overlay": {"on": True, "color": [255, 0, 0], "opacity": 1},
}
RANGES = {"opacity": (0, 1), "angle": (-180, 180), "distance": (0, 1000), "size": (0, 250)}
STROKE_MAX = 100


def _n(v, d, lo, hi):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return d
    if not math.isfinite(x):
        return d
    return min(hi, max(lo, x))


def _round(x):
    return int(math.floor(x + 0.5))


def clean_style(s):
    """A style held to what it may be (``paintStyle.cleanStyle``); None when nothing is left."""
    if not isinstance(s, dict):
        return None
    out = {}
    for k in STYLE_KINDS:
        e = s.get(k)
        if not isinstance(e, dict):
            continue
        d = STYLE_DEFAULTS[k]
        o = {"on": e.get("on") is not False}
        c = e.get("color") if isinstance(e.get("color"), list) else d["color"]
        o["color"] = [_round(_n(c[i] if i < len(c) else None, d["color"][i], 0, 255)) for i in range(3)]
        for f in d:
            if f in ("on", "color"):
                continue
            lo, hi = RANGES[f]
            o[f] = _n(e.get(f), d[f], lo, STROKE_MAX if (f == "size" and k == "stroke") else hi)
        if k == "stroke":
            o["size"] = max(1, _round(o["size"]))
        out[k] = o
    return out or None


def style_on(L):
    s = L.get("style") if L.get("kind") == "pixel" else None
    return bool(s) and any(isinstance(s.get(k), dict) and s[k].get("on") for k in STYLE_KINDS)


def dilate(m, r):
    """The largest of *m* (h, w uint8) within a disc of radius r about each pixel (``paintStyle.dilate``)."""
    r = _round(r)
    if r <= 0:
        return m.copy()
    hw = [int(math.floor(math.sqrt(r * r - dy * dy))) for dy in range(r + 1)]
    out = np.zeros_like(m)
    H = m.copy()
    for k in range(r + 1):
        if k > 0:
            G = H.copy()
            np.maximum(G[:, 1:], H[:, :-1], out=G[:, 1:])
            np.maximum(G[:, :-1], H[:, 1:], out=G[:, :-1])
            H = G
        for dy in range(r + 1):
            if hw[dy] != k:
                continue
            for s in ((dy, -dy) if dy else (0,)):
                if s >= 0:
                    np.maximum(out[:out.shape[0] - s], H[s:], out=out[:out.shape[0] - s])
                else:
                    np.maximum(out[-s:], H[:H.shape[0] + s], out=out[-s:])
    return out


def shift_mask(m, dx, dy):
    h, w = m.shape
    out = np.zeros_like(m)
    ys0, ys1 = max(0, dy), min(h, h + dy)
    xs0, xs1 = max(0, dx), min(w, w + dx)
    if ys1 > ys0 and xs1 > xs0:
        out[ys0:ys1, xs0:xs1] = m[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
    return out


def shadow_offset(angle, distance):
    a = angle * math.pi / 180
    return _round(-math.cos(a) * distance), _round(math.sin(a) * distance)


def _over_color(out, color, a, opacity):
    src = np.zeros_like(out)
    src[..., :3] = color
    src[..., 3] = 255
    return M.blend_over(out, src, a.astype(np.float64) / 255.0 * opacity, "normal")


def styled_pixels(W, H, L, px, maskv):
    """The layer with its style as a canvas-sized (H, W, 4) picture; *maskv* its mask's values (H, W) 0..1."""
    s = L.get("style") or {}
    A = np.zeros((H, W), np.uint8)
    C = np.zeros((H, W, 4), np.uint8)
    lx, ly = L.get("x", 0), L.get("y", 0)
    ph, pw = px.shape[:2]
    x0, y0, x1, y1 = max(0, lx), max(0, ly), min(W, lx + pw), min(H, ly + ph)
    ov = s.get("overlay") if s.get("overlay") and s["overlay"].get("on") else None
    if x1 > x0 and y1 > y0:
        src = px[y0 - ly:y1 - ly, x0 - lx:x1 - lx]
        A[y0:y1, x0:x1] = M.q8(src[..., 3] / 255.0 * maskv[y0:y1, x0:x1])
        if ov:
            cs = src[..., :3] / 255.0
            C[y0:y1, x0:x1, :3] = M.q8(cs + (np.array(ov["color"]) / 255.0 - cs) * ov["opacity"])
        else:
            C[y0:y1, x0:x1, :3] = src[..., :3]
        C[..., 3] = A
    out = np.zeros((H, W, 4), np.uint8)
    sh = s.get("shadow")
    if sh and sh.get("on"):
        dx, dy = shadow_offset(sh["angle"], sh["distance"])
        out = _over_color(out, sh["color"], M.feather_mask(shift_mask(A, dx, dy), sh["size"]), sh["opacity"])
    gl = s.get("glow")
    if gl and gl.get("on"):
        g = np.minimum(255, M.feather_mask(A, gl["size"]).astype(np.int32) * 2).astype(np.uint8)
        out = _over_color(out, gl["color"], g, gl["opacity"])
    st = s.get("stroke")
    if st and st.get("on"):
        out = _over_color(out, st["color"], dilate(A, st["size"]), st["opacity"])
    return M.blend_over(out, C, np.ones((H, W)), "normal")
