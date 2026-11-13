"""Comp's finishing nodes in numpy: keying and matte finishing, time, colour, filters and the AI nodes.

The twin of ``js/imageViewer_compExtra.js`` (the table, ``make``) and ``js/imageViewer_compFilters.js`` (the
arithmetic), operation for operation and in the same order: ``tests/test_comp_parity.py`` compares the two
float for float, so change one, change the other. Everything in between is float64; results float32.

``comp_model`` merges ``EXTRA_TYPES`` into its table and hands ``make`` the nodes it does not know, with a small
``api`` (run, P, ex_of, scale, size, source, ocio). It imports nothing of this package, so ``comp_model`` stays
loadable on its own; the helpers it shares (blur, resample, flow) come through :func:`bind`.

Clean room: published maths only (ASC CDL, Rec. 709 weights, the camera makers' published log curves, the
guided filter of He, Sun and Tang, Sobel), written from the description.
"""
from __future__ import annotations

import math

import numpy as np

M = None   # comp_model, set by bind()


def bind(module):
    global M
    M = module


LUM = (0.2126, 0.7152, 0.0722)
DIFF_OUTPUTS = ["premultiplied", "matte"]
SPILL_SCREENS = ["green", "blue"]
SPILL_REPLACE = ["none", "grey", "colour"]
SPILL_OUTPUTS = ["despilled", "spill"]
EXTEND_OUTPUTS = ["premultiplied", "extended"]
WRAP_OUTPUTS = ["wrapped", "wrap only"]
CORE_OUTPUTS = ["core", "edge", "outside"]
CDL_DIRECTIONS = ["forward", "inverse"]
HUES = ["red", "yellow", "green", "cyan", "blue", "magenta"]
CLAMP_CHANNELS = ["rgb", "rgba", "a", "r", "g", "b"]
LOG_CURVES = ["cineon", "logc3", "slog3", "acescct"]
LOG_DIRECTIONS = ["lin to log", "log to lin"]
GRAIN_ANIM = ["on", "off"]
MEDIAN_CHANNELS = ["rgba", "rgb"]
MEDIAN_MAX = 4
EDGE_SOURCES = ["luminance", "rgb"]
RETIME_FLOW = {"smoothness": 0.04, "iterations": 30, "levels": 4, "detail": "half"}


def _n(kind, d, key=False, mn=None, mx=None, choices=None):
    out = {"kind": kind, "def": d}
    if key:
        out["key"] = True
    if mn is not None:
        out["min"] = mn
    if mx is not None:
        out["max"] = mx
    if choices is not None:
        out["choices"] = choices
    return out


_WRITE = _n("target", "rgba")
_RESULTS = _n("ai", None)
_ONOFF = ["off", "on"]


def _hue_params():
    out = {}
    for h in HUES:
        out["sat_" + h] = _n("num", 1, True, 0)
    for h in HUES:
        out["hue_" + h] = _n("num", 0, True)
    for h in HUES:
        out["lum_" + h] = _n("num", 1, True, 0)
    return out


def _cdl_params():
    out = {}
    for c in "rgb":
        out["slope_" + c] = _n("num", 1, True, 0)
    for c in "rgb":
        out["offset_" + c] = _n("num", 0, True)
    for c in "rgb":
        out["power_" + c] = _n("num", 1, True, 0.01)
    out["saturation"] = _n("num", 1, True, 0)
    out["direction"] = _n("enum", "forward", choices=CDL_DIRECTIONS)
    return out


AI_KINDS = {"ai_matte": "matte", "ai_depth": "depth", "ai_relight": "relight", "ai_inpaint": "inpaint", "ai_upscale": "upscale"}
_AI_DATA = {"matte", "depth"}

# The names the page shows (and the Python API uses) for these nodes.
EXTRA_LABELS = {"differencekeyer": "DifferenceKeyer", "despill": "Despill", "edgeextend": "EdgeExtend", "lightwrap": "LightWrap", "coreedge": "CoreEdge",
                "framehold": "FrameHold", "framerange": "FrameRange", "timeoffset": "TimeOffset", "appendclip": "AppendClip", "timeblur": "TimeBlur",
                "cdl": "CDL", "lut": "LUT", "huecurves": "HueCurves", "clamp": "Clamp", "loglin": "Log2Lin",
                "colormatch": "ColorMatch", "grain": "Grain", "denoise": "Denoise", "sharpen": "Sharpen", "median": "Median",
                "edgedetect": "EdgeDetect", "edgeblur": "EdgeBlur", "ai_matte": "AI Matte", "ai_depth": "AI Depth", "ai_relight": "AI Relight",
                "ai_inpaint": "AI Inpaint", "ai_upscale": "AI Upscale"}

# The per-pixel ones that take a mask input (the last) and a mix (the page's EXTRA_MASKABLE).
EXTRA_MASKABLE = ["differencekeyer", "despill", "edgeextend", "lightwrap", "coreedge", "cdl", "lut", "huecurves", "clamp",
                  "loglin", "colormatch", "grain", "denoise", "sharpen", "median", "edgedetect", "edgeblur"]
EXTRA_TYPES = {
    "differencekeyer": {"inputs": ["src", "clean"], "params": {
        "threshold": _n("num", 0.05, True, 0), "softness": _n("num", 0.1, True, 0),
        "invert": _n("enum", "off", choices=_ONOFF), "output": _n("enum", "premultiplied", choices=DIFF_OUTPUTS),
        "write": _WRITE}},
    "despill": {"inputs": ["src"], "params": {
        "screen": _n("enum", "green", choices=SPILL_SCREENS), "limit": _n("enum", "max", choices=["max", "average"]),
        "amount": _n("num", 1, True, 0, 1), "replace": _n("enum", "none", choices=SPILL_REPLACE),
        "replace_color": _n("color", [0.5, 0.5, 0.5, 1], True), "output": _n("enum", "despilled", choices=SPILL_OUTPUTS)}},
    "edgeextend": {"inputs": ["src"], "params": {
        "size": _n("num", 6, True, 0, 200), "threshold": _n("num", 0.95, True, 0, 0.999),
        "output": _n("enum", "premultiplied", choices=EXTEND_OUTPUTS)}},
    "lightwrap": {"inputs": ["fg", "bg"], "params": {
        "width": _n("num", 10, True, 0, 200), "diffuse": _n("num", 20, True, 0, 400), "intensity": _n("num", 1, True, 0),
        "threshold": _n("num", 0, True, 0), "output": _n("enum", "wrapped", choices=WRAP_OUTPUTS)}},
    "coreedge": {"inputs": ["src"], "params": {
        "size": _n("num", 3, True, 0, 100), "softness": _n("num", 1, True, 0, 100),
        "output": _n("enum", "edge", choices=CORE_OUTPUTS), "write": _WRITE}},
    "framehold": {"inputs": ["src"], "params": {"frame": _n("int", 0), "every": _n("int", 0, mn=0)}},
    "framerange": {"inputs": ["src"], "params": {"first": _n("int", 0), "last": _n("int", 47),
                                                 "outside": _n("enum", "hold", choices=["hold", "black"])}},
    "timeoffset": {"inputs": ["src"], "params": {"offset": _n("int", 0)}},
    "appendclip": {"inputs": ["A", "B"], "params": {"a_first": _n("int", 0), "a_last": _n("int", 23), "b_first": _n("int", 0),
                                                    "dissolve": _n("int", 0, mn=0)}},
    "timeblur": {"inputs": ["src"], "params": {"shutter": _n("num", 0.5, False, 0, 8), "samples": _n("int", 5, mn=1, mx=32),
                                               "offset": _n("enum", "centred", choices=["centred", "start", "end"])}},
    "cdl": {"inputs": ["src"], "params": _cdl_params()},
    "lut": {"inputs": ["src"], "params": {"file": _n("lutfile", ""), "unpremult": _n("enum", "on", choices=["on", "off"])}},
    "huecurves": {"inputs": ["src"], "params": _hue_params()},
    "clamp": {"inputs": ["src"], "params": {
        "minimum": _n("num", 0, True), "maximum": _n("num", 1, True), "min_on": _n("enum", "on", choices=["on", "off"]),
        "max_on": _n("enum", "on", choices=["on", "off"]), "channels": _n("enum", "rgb", choices=CLAMP_CHANNELS)}},
    "loglin": {"inputs": ["src"], "params": {"operation": _n("enum", "log to lin", choices=LOG_DIRECTIONS),
                                             "curve": _n("enum", "cineon", choices=LOG_CURVES)}},
    "colormatch": {"inputs": ["src", "reference"], "params": {"amount": _n("num", 1, True, 0, 1)}},
    "grain": {"inputs": ["src", "plate"], "params": {
        "amount": _n("num", 0.04, True, 0), "size": _n("num", 1, True, 0, 20), "saturation": _n("num", 0.3, True, 0, 1),
        "response": _n("num", 0.5, True, 0, 1), "seed": _n("int", 0), "animated": _n("enum", "on", choices=GRAIN_ANIM)}},
    "denoise": {"inputs": ["src"], "params": {"radius": _n("num", 3, False, 0, 30), "strength": _n("num", 0.05, True, 0, 1),
                                              "mix": _n("num", 1, True, 0, 1)}},
    "sharpen": {"inputs": ["src"], "params": {"amount": _n("num", 0.5, True, 0), "size": _n("num", 2, True, 0, 50)}},
    "median": {"inputs": ["src"], "params": {"radius": _n("num", 1, False, 0, MEDIAN_MAX),
                                             "channels": _n("enum", "rgba", choices=MEDIAN_CHANNELS)}},
    "edgedetect": {"inputs": ["src"], "params": {"size": _n("num", 1, True, 0, 50), "gain": _n("num", 1, True, 0),
                                                 "source": _n("enum", "luminance", choices=EDGE_SOURCES)}},
    "edgeblur": {"inputs": ["src"], "params": {"size": _n("num", 3, True, 0, 100), "width": _n("num", 3, True, 0, 100),
                                               "amount": _n("num", 1, True, 0, 1)}},
    "ai_matte": {"inputs": ["src"], "params": {"output": _n("enum", "premultiplied", choices=["premultiplied", "matte"]),
                                               "write": _WRITE, "results": _RESULTS}},
    "ai_depth": {"inputs": ["src"], "params": {"invert": _n("enum", "off", choices=_ONOFF), "results": _RESULTS}},
    "ai_relight": {"inputs": ["src"], "params": {"prompt": _n("prompt", "soft warm light from the left, as late afternoon sun"),
                                                 "results": _RESULTS}},
    "ai_inpaint": {"inputs": ["src", "mask"], "params": {"prompt": _n("prompt", ""), "results": _RESULTS}},
    "ai_upscale": {"inputs": ["src"], "params": {"factor": _n("enum", "2", choices=["2", "4"]), "results": _RESULTS}},
}
EXTRA_ORDER = list(EXTRA_TYPES)


# ── helpers ──────────────────────────────────────────────────────────────────

def _f64(img):
    return img.astype(np.float64)


def _clip01(x):
    return np.clip(x, 0.0, 1.0)


def _ramp_up(x, lo, soft):
    if soft > 0:
        return _clip01((x - lo) / soft)
    return np.where(x >= lo, 1.0, 0.0)


def _plane_pic(a):
    return np.repeat(np.asarray(a, np.float64)[..., None], 4, axis=2).astype(np.float32)


def _blur_plane(a, size):
    return M.blur_image(_plane_pic(a), size)[..., 0].astype(np.float64)


def _straight(d):
    a = d[..., 3]
    ok = a > 0
    c = np.where(ok[..., None], d[..., :3] / np.where(ok, a, 1.0)[..., None], 0.0)
    return c, a, ok


def _straight_map(img, fn):
    """Each straight colour through fn([..., 3] float64) -> [..., 3], premultiplied again; a = 0 pixels as they are."""
    d = _f64(img)
    c, a, ok = _straight(d)
    r = fn(c)
    out = d.copy()
    out[..., :3] = np.where(ok[..., None], r * a[..., None], d[..., :3])
    return out.astype(np.float32)


def _matte(m, w=None):
    out = np.empty(m.shape + (4,), np.float64)
    out[..., 0] = m
    out[..., 1] = m
    out[..., 2] = m
    out[..., 3] = 1.0 if w is None else w
    return out.astype(np.float32)


# ── keying and matte finishing ───────────────────────────────────────────────

def difference_key_image(img, clean, p):
    if clean is None:
        return img
    s, c = _f64(img), _f64(clean)
    dr, dg, db = s[..., 0] - c[..., 0], s[..., 1] - c[..., 1], s[..., 2] - c[..., 2]
    d = np.sqrt((dr * dr + dg * dg + db * db) / 3)
    m = _ramp_up(d, p["threshold"], p["softness"])
    if p["invert"] == "on":
        m = 1 - m
    if p["output"] == "matte":
        return _matte(m)
    return (s * m[..., None]).astype(np.float32)


def despill_image(img, p):
    s = _f64(img)
    k = 2 if p["screen"] == "blue" else 1
    j2 = 2 if k == 1 else 1
    o1, o2 = s[..., 0], s[..., j2]
    lim = (o1 + o2) / 2 if p["limit"] == "average" else np.maximum(o1, o2)
    spill = np.maximum(0, s[..., k] - lim)
    if p["output"] == "spill":
        return _matte(spill)
    t = p["amount"] * spill
    out = s.copy()
    out[..., k] = s[..., k] - t
    rc = p.get("replace_color") or [0, 0, 0, 1]
    if p["replace"] == "grey":
        for ch in range(3):
            out[..., ch] = out[..., ch] + t / 3
    elif p["replace"] == "colour":
        for ch in range(3):
            out[..., ch] = out[..., ch] + t * rc[ch]
    return out.astype(np.float32)


def edge_extend_image(img, p):
    s = _f64(img)
    c, a, _ = _straight(s)
    thr = p["threshold"]
    span = max(1e-6, 1 - thr)
    k = _clip01((a - thr) / span)
    P = np.concatenate([c * k[..., None], k[..., None]], axis=2).astype(np.float32)
    B = _f64(M.blur_image(P, p["size"]))
    bw = B[..., 3]
    big = bw > 1e-6
    e = np.where(big[..., None], B[..., :3] / np.where(big, bw, 1.0)[..., None], c)
    v = c * k[..., None] + e * (1 - k)[..., None]
    out = np.empty_like(s)
    if p["output"] == "extended":
        out[..., :3] = v
        out[..., 3] = 1
    else:
        out[..., :3] = v * a[..., None]
        out[..., 3] = a
    return out.astype(np.float32)


def light_wrap_image(fg, bg, p):
    if bg is None:
        return fg
    s, b = _f64(fg), _f64(bg)
    a = s[..., 3]
    ba = _blur_plane(a.astype(np.float32), p["width"])
    G = b.copy()
    if p["threshold"] > 0:
        L = LUM[0] * b[..., 0] + LUM[1] * b[..., 1] + LUM[2] * b[..., 2]
        hi = L > p["threshold"]
        k = np.where(hi, (L - p["threshold"]) / np.where(hi, L, 1.0), 0.0)
        G[..., :3] = b[..., :3] * k[..., None]
    D = _f64(M.blur_image(G.astype(np.float32), p["diffuse"]))
    e = a * (1 - ba) * p["intensity"]
    out = np.empty_like(s)
    if p["output"] == "wrap only":
        out[..., :3] = D[..., :3] * e[..., None]
        out[..., 3] = _clip01(e)
    else:
        out[..., :3] = s[..., :3] + D[..., :3] * e[..., None]
        out[..., 3] = a
    return out.astype(np.float32)


def core_edge_image(img, p):
    A = _plane_pic(img[..., 3])
    er = M.erode_image(A, {"size": -p["size"], "shape": "disc", "channels": "rgba"})
    di = M.erode_image(A, {"size": p["size"], "shape": "disc", "channels": "rgba"})
    c, d = er[..., 0].astype(np.float64), di[..., 0].astype(np.float64)
    m = c if p["output"] == "core" else (1 - d) if p["output"] == "outside" else d - c
    v = _blur_plane(m, p["softness"]) if p["softness"] > 0 else m
    return np.repeat(v[..., None], 4, axis=2).astype(np.float32)


# ── colour ───────────────────────────────────────────────────────────────────

def _pow_cdl(v, pw):
    if pw == 1:
        return np.where(v > 0, np.power(np.where(v > 0, v, 1.0), pw), v)
    return np.where(v > 0, np.power(np.where(v > 0, v, 1.0), pw), 0.0)


def cdl_image(img, p):
    sl = [p["slope_r"], p["slope_g"], p["slope_b"]]
    of = [p["offset_r"], p["offset_g"], p["offset_b"]]
    pw = [p["power_r"], p["power_g"], p["power_b"]]
    sat = p["saturation"]

    def inverse(c):
        L = LUM[0] * c[..., 0] + LUM[1] * c[..., 1] + LUM[2] * c[..., 2]
        out = np.empty_like(c)
        for k in range(3):
            x = L + (c[..., k] - L) / sat if sat != 0 else L
            x = _pow_cdl(x, 1 / (pw[k] or 1e-6))
            out[..., k] = (x - of[k]) / (sl[k] or 1e-6)
        return out

    def forward(c):
        v = np.empty_like(c)
        for k in range(3):
            v[..., k] = _pow_cdl(c[..., k] * sl[k] + of[k], pw[k])
        L = LUM[0] * v[..., 0] + LUM[1] * v[..., 1] + LUM[2] * v[..., 2]
        return L[..., None] + (v - L[..., None]) * sat
    return _straight_map(img, inverse if p["direction"] == "inverse" else forward)


def _hue_curve(P, hue):
    P = np.asarray(P, np.float64)
    u = hue / 60
    f0 = np.floor(u)
    t = u - f0
    i = np.mod(f0.astype(np.int64), 6)
    p0, p1, p2, p3 = P[(i + 5) % 6], P[i], P[(i + 1) % 6], P[(i + 2) % 6]
    return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * (t * t) + (3 * p1 - p0 - 3 * p2 + p3) * (t * t * t))


def hue_curves_image(img, p):
    S = [p["sat_" + h] for h in HUES]
    T = [p["hue_" + h] for h in HUES]
    Lc = [p["lum_" + h] for h in HUES]
    R3 = math.sqrt(3)

    def fn(c):
        r, g, b = c[..., 0], c[..., 1], c[..., 2]
        mx = np.maximum(np.maximum(r, g), b)
        mn = np.minimum(np.minimum(r, g), b)
        dl = mx - mn
        ok = (dl > 0) & (mx > 0)
        sd = np.where(ok, dl, 1.0)
        hh = np.where(mx == r, (g - b) / sd, np.where(mx == g, (b - r) / sd + 2, (r - g) / sd + 4))
        hh = np.where(hh < 0, hh + 6, hh)
        hue = np.where(ok, 60 * hh, 0.0)
        w = _clip01(dl / np.where(ok, mx, 1.0))
        sat = 1 + (_hue_curve(S, hue) - 1) * w
        turn = _hue_curve(T, hue) * w
        lum = 1 + (_hue_curve(Lc, hue) - 1) * w
        grey = (r + g + b) / 3
        vr, vg, vb = r - grey, g - grey, b - grey
        a = (turn * math.pi) / 180
        cs, sn = np.cos(a), np.sin(a)
        xr, xg, xb = (vb - vg) / R3, (vr - vb) / R3, (vg - vr) / R3
        out = np.stack([(grey + (vr * cs + xr * sn) * sat) * lum, (grey + (vg * cs + xg * sn) * sat) * lum,
                        (grey + (vb * cs + xb * sn) * sat) * lum], axis=-1)
        return np.where(ok[..., None], out, c)
    return _straight_map(img, fn)


def clamp_image(img, p):
    s = _f64(img)
    ch = p["channels"]
    on = [0, 1, 2, 3] if ch == "rgba" else [0, 1, 2] if ch == "rgb" else [{"r": 0, "g": 1, "b": 2, "a": 3}.get(ch, 3)]
    out = s.copy()
    for k in on:
        v = s[..., k]
        if p["min_on"] != "off":
            v = np.where(v < p["minimum"], p["minimum"], v)
        if p["max_on"] != "off":
            v = np.where(v > p["maximum"], p["maximum"], v)
        out[..., k] = v
    return out.astype(np.float32)


_CIN_OFF = 10 ** (((95 - 685) * 0.002) / 0.6)


def log_encode(curve, x):
    with np.errstate(all="ignore"):
        if curve == "logc3":
            return np.where(x > 0.010591, 0.24719 * np.log10(np.maximum(5.555556 * x + 0.052272, 1e-300)) + 0.385537, 5.367655 * x + 0.092809)
        if curve == "slog3":
            return np.where(x >= 0.01125, (420 + np.log10(np.maximum((x + 0.01) / 0.19, 1e-300)) * 261.5) / 1023,
                            (x * (171.2102946929 - 95) / 0.01125 + 95) / 1023)
        if curve == "acescct":
            return np.where(x <= 0.0078125, 10.5402377416545 * x + 0.0729055341958355, (np.log2(np.maximum(x, 1e-300)) + 9.72) / 17.52)
        v = x * (1 - _CIN_OFF) + _CIN_OFF
        return np.where(v > 0, (685 + (np.log10(np.maximum(v, 1e-300)) * 0.6) / 0.002) / 1023, 0.0)


def log_decode(curve, t):
    with np.errstate(all="ignore"):
        if curve == "logc3":
            return np.where(t > 5.367655 * 0.010591 + 0.092809, (np.power(10.0, (t - 0.385537) / 0.24719) - 0.052272) / 5.555556,
                            (t - 0.092809) / 5.367655)
        if curve == "slog3":
            return np.where(t >= 171.2102946929 / 1023, np.power(10.0, (t * 1023 - 420) / 261.5) * 0.19 - 0.01,
                            ((t * 1023 - 95) * 0.01125) / (171.2102946929 - 95))
        if curve == "acescct":
            return np.where(t <= 0.155251141552511, (t - 0.0729055341958355) / 10.5402377416545, np.power(2.0, t * 17.52 - 9.72))
        return (np.power(10.0, ((t * 1023 - 685) * 0.002) / 0.6) - _CIN_OFF) / (1 - _CIN_OFF)


def log_lin_image(img, p):
    fn = (lambda v: log_decode(p["curve"], v)) if p["operation"] == "log to lin" else (lambda v: log_encode(p["curve"], v))
    return _straight_map(img, fn)


def _colour_stats(img):
    s = _f64(img)
    a = s[..., 3]
    wsum = float(np.sum(a))
    if not wsum > 0:
        return None
    m = [float(np.sum(s[..., k])) / wsum for k in range(3)]
    ok = a > 0
    sd = []
    for k in range(3):
        d = np.where(ok, s[..., k] / np.where(ok, a, 1.0) - m[k], 0.0)
        sd.append(math.sqrt(float(np.sum(np.where(ok, a * (d * d), 0.0))) / wsum))
    return m, sd


def color_match_image(img, ref, p):
    if ref is None:
        return img
    A, B = _colour_stats(img), _colour_stats(ref)
    if not A or not B:
        return img
    k = [B[1][c] / max(A[1][c], 1e-6) for c in range(3)]

    def fn(c):
        out = np.empty_like(c)
        for ch in range(3):
            v = c[..., ch]
            t = B[0][ch] + (v - A[0][ch]) * k[ch]
            out[..., ch] = v + (t - v) * p["amount"]
        return out
    return _straight_map(img, fn)


# ── filters ──────────────────────────────────────────────────────────────────

_M32 = 0xFFFFFFFF


def _u32(v):
    return np.asarray(v, dtype=np.int64).astype(np.uint64) & np.uint64(_M32)


def _imul(a, k):
    return (a * np.uint64(k & _M32)) & np.uint64(_M32)


def hash01(x, y, c, f, seed):
    """The page's hash01 over arrays of whole numbers."""
    h = _imul(_u32(x), 0x27d4eb2d) ^ _imul(_u32(y), 0x165667b1) ^ _imul(_u32(c + 1), 0x9e3779b1) \
        ^ _imul(_u32(f), 0x85ebca77) ^ _imul(_u32(seed), 0xc2b2ae3d)
    h = h ^ (h >> np.uint64(16))
    h = _imul(h, 0x85ebca6b)
    h = h ^ (h >> np.uint64(13))
    h = _imul(h, 0xc2b2ae35)
    h = h ^ (h >> np.uint64(16))
    return h.astype(np.float64) / 4294967296


def blur_variance(size):
    sigma = max(0.0, float(size)) / 2
    if sigma <= 0:
        return 1.0
    k = [1.0]
    for sz in M.boxes_for_gauss(sigma):
        nk = [0.0] * (len(k) + sz - 1)
        for i in range(len(k)):
            for t in range(sz):
                nk[i + t] += k[i] / sz
        k = nk
    v = 0.0
    for x in k:
        v += x * x
    return v * v


def plate_grain(img):
    s = _f64(img)
    a = s[..., 3]
    u = np.where(a > 0, a, 1.0)
    L = (LUM[0] * s[..., 0] + LUM[1] * s[..., 1] + LUM[2] * s[..., 2]) / u
    B = _blur_plane(L, 2)
    d = L - B
    m = float(np.sum(d)) / d.size
    e = d - m
    return math.sqrt(float(np.sum(e * e)) / d.size)


def _round(x):
    return int(math.floor(x + 0.5))


def grain_image(img, p, frame, scale, plate):
    h, w = img.shape[:2]
    fr = 0 if p["animated"] == "off" else _round(frame)
    seed = _round(p.get("seed") or 0)
    ys, xs = np.mgrid[0:h, 0:w]
    N = np.zeros((h, w, 4), np.float32)
    for c in range(3):
        N[..., c] = (hash01(xs, ys, c, fr, seed) - 0.5) * 3.4641016151377544
    sz = p["size"] * scale
    G = _f64(M.blur_image(N, sz) if sz > 0 else N)
    norm = 1 / math.sqrt(blur_variance(sz))
    amt = p["amount"] * plate_grain(plate) if plate is not None else p["amount"]
    s = _f64(img)
    c, a, ok = _straight(s)
    L = _clip01(LUM[0] * c[..., 0] + LUM[1] * c[..., 1] + LUM[2] * c[..., 2])
    k = amt * ((1 - p["response"]) + p["response"] * L)
    g0 = G[..., 0] * norm
    out = s.copy()
    for ch in range(3):
        gc = g0 + (G[..., ch] * norm - g0) * p["saturation"]
        out[..., ch] = np.where(ok, (c[..., ch] + k * gc) * a, s[..., ch])
    return out.astype(np.float32)


def _box_mean(a, r):
    return M._box_axis(M._box_axis(a, r, 1), r, 0)


def denoise_image(img, p, scale):
    r = _round(p["radius"] * scale)
    if r <= 0 or not p["strength"] > 0:
        return img
    eps = p["strength"] * p["strength"]
    I = _f64(img)
    mI = _box_mean(I.copy(), r)
    mII = _box_mean(I * I, r)
    v = mII - mI * mI
    A = v / (v + eps)
    B = mI - A * mI
    A = _box_mean(A, r)
    B = _box_mean(B, r)
    q = A * I + B
    out = I + (q - I) * p["mix"]
    out[..., 3] = I[..., 3]
    return out.astype(np.float32)


def sharpen_image(img, p, scale):
    s = _f64(img)
    B = _f64(M.blur_image(img, p["size"] * scale))
    out = s + (s - B) * p["amount"]
    out[..., 3] = s[..., 3]
    return out.astype(np.float32)


def median_image(img, p, scale):
    r = min(MEDIAN_MAX, _round(p["radius"] * scale))
    if r <= 0:
        return img
    h, w = img.shape[:2]
    nc = 3 if p["channels"] == "rgb" else 4
    pad = np.pad(img[..., :nc], ((r, r), (r, r), (0, 0)), mode="edge")
    side = 2 * r + 1
    mid = (side * side - 1) // 2
    out = img.copy()
    step = max(1, int(2_000_000 // max(1, side * side * w * nc)))
    for y0 in range(0, h, step):
        y1 = min(h, y0 + step)
        stack = np.stack([pad[y0 + dy:y1 + dy, dx:dx + w] for dy in range(side) for dx in range(side)], axis=0)
        out[y0:y1, :, :nc] = np.partition(stack, mid, axis=0)[mid]
    return out


def edge_detect_image(img, p, scale):
    src = _f64(M.blur_image(img, p["size"] * scale) if p["size"] > 0 else img)
    h, w = img.shape[:2]
    lum = p["source"] != "rgb"
    planes = [LUM[0] * src[..., 0] + LUM[1] * src[..., 1] + LUM[2] * src[..., 2]] if lum else [src[..., c] for c in range(3)]
    out = np.zeros((h, w, 4), np.float64)
    for c, a in enumerate(planes):
        P = np.pad(a, 1, mode="edge")
        p00, p01, p02 = P[0:h, 0:w], P[0:h, 1:w + 1], P[0:h, 2:w + 2]
        p10, p12 = P[1:h + 1, 0:w], P[1:h + 1, 2:w + 2]
        p20, p21, p22 = P[2:h + 2, 0:w], P[2:h + 2, 1:w + 1], P[2:h + 2, 2:w + 2]
        gx = (p02 + 2 * p12 + p22) - (p00 + 2 * p10 + p20)
        gy = (p20 + 2 * p21 + p22) - (p00 + 2 * p01 + p02)
        e = (np.sqrt(gx * gx + gy * gy) / 4) * p["gain"]
        if lum:
            out[..., 0] = e
            out[..., 1] = e
            out[..., 2] = e
        else:
            out[..., c] = e
    out[..., 3] = 1
    return out.astype(np.float32)


def edge_blur_image(img, p, scale):
    s = _f64(img)
    ba = _blur_plane(img[..., 3], p["width"] * scale)
    B = _f64(M.blur_image(img, p["size"] * scale))
    e = (1 - np.abs(2 * ba - 1)) * p["amount"]
    return (s + (B - s) * e[..., None]).astype(np.float32)


# ── time ─────────────────────────────────────────────────────────────────────

def vector_blend(a, b, t):
    h, w = a.shape[:2]
    u, v = M.optical_flow(M.grey_of(a), M.grey_of(b), **RETIME_FLOW)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    A, B = _f64(a), _f64(b)
    sa = M._sample_clamped(A, xs - t * u, ys - t * v)
    sb = M._sample_clamped(B, xs + (1 - t) * u, ys + (1 - t) * v)
    return (sa + (sb - sa) * t).astype(np.float32)


def time_blur_frames(p, f):
    sh = max(0.0, float(p["shutter"]))
    N = max(1, _round(p["samples"]))
    lo = 0 if p.get("offset") == "start" else -sh if p.get("offset") == "end" else -sh / 2
    wt = {}
    for k in range(N):
        t = f + lo + (sh * (k + 0.5)) / N
        f0 = int(math.floor(t))
        fr = t - f0
        if fr < 1e-9:
            wt[f0] = wt.get(f0, 0) + 1 / N
        else:
            wt[f0] = wt.get(f0, 0) + (1 - fr) / N
            wt[f0 + 1] = wt.get(f0 + 1, 0) + fr / N
    return sorted(wt.items())


def weighted_sum(pics, weights):
    acc = np.zeros(pics[0].shape, np.float64)
    for pic, wv in zip(pics, weights):
        acc = acc + pic.astype(np.float64) * wv
    return acc.astype(np.float32)


def hold_frame(n, f):
    at = int(n.get("frame") or 0)
    every = max(0, _round(n.get("every") or 0))
    return at + ((f - at) // every) * every if every > 0 else at


def append_parts(n, f):
    a0 = int(n.get("a_first") or 0)
    a1 = int(n["a_last"]) if n.get("a_last") is not None else 23
    b0 = int(n.get("b_first") or 0)
    d = max(0, _round(n.get("dissolve") or 0))
    la = max(1, a1 - a0 + 1)
    start = la - d
    if f < start:
        return [(0, a0 + f, 1)]
    if f >= la:
        return [(1, b0 + f - start, 1)]
    t = (f - start + 1) / (d + 1)
    return [(0, a0 + f, 1 - t), (1, b0 + f - start, t)]


# ── AI results ───────────────────────────────────────────────────────────────

def ai_result_frame(n, f):
    fr = (n.get("results") or {}).get("frames") if isinstance(n.get("results"), dict) else None
    if not fr:
        return None
    ks = sorted(int(k) for k, v in fr.items() if v and str(k).lstrip("-").isdigit())
    if not ks:
        return None
    if f in ks:
        return f
    best = None
    for k in ks:
        if k <= f:
            best = k
    return ks[0] if best is None else best


def ai_read(n, f):
    rf = ai_result_frame(n, f)
    if rf is None:
        return None
    return {"id": f"{n['id']}#ai{rf}", "type": "read", "file": n["results"]["frames"][str(rf)],
            "colorspace": "linear" if AI_KINDS[n["type"]] in _AI_DATA else "srgb", "fit": "stretch", "offset": 0, "inputs": []}


def upscale_factor(n):
    try:
        return max(1.0, float(n.get("factor") or 2))
    except (TypeError, ValueError):
        return 2.0


def _ai_make(n, f, p, api):
    kind = AI_KINDS[n["type"]]
    ins = n.get("inputs") or []
    if ins and ins[0]:
        s = api.run(ins[0], f)
    else:
        w0, h0 = api.size(n, 0)
        s = M.blank(w0, h0)
    k = upscale_factor(n) if kind == "upscale" else 1
    h0, w0 = s.shape[:2]
    w, h = max(1, _round(w0 * k)), max(1, _round(h0 * k))
    rd = ai_read(n, f)
    got = api.source(rd, f) if rd and api.source else None
    if got is None:
        return M.resample(s, M.fit_matrix(w0, h0, w, h, "stretch"), w, h) if kind == "upscale" else s
    R = _f64(M.resample(got, M.fit_matrix(got.shape[1], got.shape[0], w, h, "stretch"), w, h))
    S = _f64(s)
    if kind in ("matte", "depth"):
        m = 0.2126 * R[..., 0] + 0.7152 * R[..., 1] + 0.0722 * R[..., 2]
        if kind == "depth":
            return _matte(1 - m if p.get("invert") == "on" else m)
        if p.get("output") == "matte":
            return _matte(m)
        return (S * m[..., None]).astype(np.float32)
    if kind == "upscale":
        return R.astype(np.float32)
    out = R * S[..., 3:4]
    if kind == "inpaint" and len(ins) > 1 and ins[1]:
        m = _f64(M.conform(api.run(ins[1], f), w, h))[..., 3:4]
        out = S * (1 - m) + out * m
    return out.astype(np.float32)


# ── the nodes ────────────────────────────────────────────────────────────────

def make(n, f, api):
    """The picture of an extra node at f (or ``(picture, extras)``); None for a type it does not know."""
    t = n.get("type")
    if t not in EXTRA_TYPES:
        return None
    ins = list(n.get("inputs") or [])
    while len(ins) < len(EXTRA_TYPES[t]["inputs"]):
        ins.append(None)
    p = api.P(n, f)
    scale = api.scale

    def src():
        return api.run(ins[0], f)

    def other(k, img):
        return M.conform(api.run(ins[k], f), img.shape[1], img.shape[0]) if ins[k] else None

    if t == "differencekeyer":
        s = src()
        return difference_key_image(s, other(1, s), p)
    if t == "despill":
        return despill_image(src(), p)
    if t == "edgeextend":
        return edge_extend_image(src(), dict(p, size=p["size"] * scale))
    if t == "lightwrap":
        s = src()
        return light_wrap_image(s, other(1, s), dict(p, width=p["width"] * scale, diffuse=p["diffuse"] * scale))
    if t == "coreedge":
        return core_edge_image(src(), dict(p, size=p["size"] * scale, softness=p["softness"] * scale))
    if t in ("framehold", "timeoffset"):
        g = hold_frame(n, f) if t == "framehold" else f - int(n.get("offset") or 0)
        return api.run(ins[0], g), api.ex_of(ins[0], g)
    if t == "framerange":
        first = int(n.get("first") or 0)
        last = int(n["last"]) if n.get("last") is not None else 47
        if n.get("outside") == "black" and (f < first or f > last):
            w, h = api.size(n, 0)
            return M.blank(w, h), {}
        g = min(last, max(first, f))
        return api.run(ins[0], g), api.ex_of(ins[0], g)
    if t == "appendclip":
        parts = append_parts(n, f)
        if len(parts) == 1:
            i, g, _ = parts[0]
            return api.run(ins[i], g), api.ex_of(ins[i], g)
        a = api.run(ins[0], parts[0][1])
        b = M.conform(api.run(ins[1], parts[1][1]), a.shape[1], a.shape[0])
        tt = parts[1][2]
        return M.mix_images(a, b, tt), M.mix_extras(api.ex_of(ins[0], parts[0][1]), api.ex_of(ins[1], parts[1][1]), tt, a.shape[:2])
    if t == "timeblur":
        fw = time_blur_frames(p, f)
        pics = [api.run(ins[0], g) for g, _ in fw]
        h0, w0 = pics[0].shape[:2]
        out = weighted_sum([M.conform(q, w0, h0) for q in pics], [x[1] for x in fw])
        best = 0
        for k in range(1, len(fw)):
            if fw[k][1] > fw[best][1]:
                best = k
        return out, api.ex_of(ins[0], fw[best][0])
    if t == "cdl":
        return cdl_image(src(), p)
    if t == "lut":
        s = src()
        fn = api.ocio({"file": n.get("file")}) if n.get("file") and api.ocio else None
        return M.ocio_image(s, fn, p.get("unpremult") != "off") if fn else s
    if t == "huecurves":
        return hue_curves_image(src(), p)
    if t == "clamp":
        return clamp_image(src(), p)
    if t == "loglin":
        return log_lin_image(src(), p)
    if t == "colormatch":
        s = src()
        return color_match_image(s, api.run(ins[1], f) if ins[1] else None, p)
    if t == "grain":
        s = src()
        return grain_image(s, p, f, scale, api.run(ins[1], f) if ins[1] else None)
    if t == "denoise":
        return denoise_image(src(), p, scale)
    if t == "sharpen":
        return sharpen_image(src(), p, scale)
    if t == "median":
        return median_image(src(), p, scale)
    if t == "edgedetect":
        return edge_detect_image(src(), p, scale)
    if t == "edgeblur":
        return edge_blur_image(src(), p, scale)
    return _ai_make(n, f, p, api)
