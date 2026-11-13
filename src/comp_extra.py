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
_PRERENDER = _n("enum", "on", choices=["on", "off"])
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
# The VFX nodes (the page's VFX_KINDS): LTX-2.5's workflows over the whole range, one film as their result.
VFX_KINDS = {"vfx_alpha": "alpha", "vfx_hdr": "hdr", "vfx_reframe": "reframe", "vfx_upscale": "upscale"}
_VFX_SIZED = {"reframe", "upscale"}

# The names the page shows (and the Python API uses) for these nodes.
EXTRA_LABELS = {"differencekeyer": "DifferenceKeyer", "despill": "Despill", "edgeextend": "EdgeExtend", "lightwrap": "LightWrap", "coreedge": "CoreEdge",
                "framehold": "FrameHold", "framerange": "FrameRange", "timeoffset": "TimeOffset", "appendclip": "AppendClip", "timeblur": "TimeBlur",
                "cdl": "CDL", "lut": "LUT", "huecurves": "HueCurves", "clamp": "Clamp", "loglin": "Log2Lin",
                "colormatch": "ColorMatch", "grain": "Grain", "degrain": "Degrain", "regrain": "Regrain", "denoise": "Denoise", "sharpen": "Sharpen", "median": "Median",
                "edgedetect": "EdgeDetect", "edgeblur": "EdgeBlur", "ai_matte": "AI Matte", "ai_depth": "AI Depth", "ai_relight": "AI Relight",
                "ai_inpaint": "AI Inpaint", "ai_upscale": "AI Upscale",
                "vfx_alpha": "VFX Alpha Matte", "vfx_hdr": "VFX SDR to HDR", "vfx_reframe": "VFX Reframe", "vfx_upscale": "VFX Upscale"}

# The per-pixel ones that take a mask input (the last) and a mix (the page's EXTRA_MASKABLE).
EXTRA_MASKABLE = ["differencekeyer", "despill", "edgeextend", "lightwrap", "coreedge", "cdl", "lut", "huecurves", "clamp",
                  "loglin", "colormatch", "grain", "degrain", "denoise", "sharpen", "median", "edgedetect", "edgeblur"]
# Slow ones, kept between renders (the page's EXTRA_HEAVY).
EXTRA_HEAVY = ["denoise", "median", "timeblur", "degrain", "regrain"]
_PROFILE = _n("grainprofile", None)
DEGRAIN_OUTPUTS = ["degrained", "removed"]
REGRAIN_FILLS = ["scatter", "synth", "plate"]
REGRAIN_OUTPUTS = ["result", "grain", "new areas", "difference"]
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
        "response": _n("num", 0.5, True, 0, 1), "seed": _n("int", 0), "animated": _n("enum", "on", choices=GRAIN_ANIM),
        "profile": _PROFILE}},
    "degrain": {"inputs": ["src"], "params": {
        "temporal": _n("int", 1, False, 0, 3), "motion": _n("num", 4, False, 0.5, 20), "strength": _n("num", 1.5, True, 0, 10),
        "fine": _n("num", 1, True, 0, 1), "medium": _n("num", 1, True, 0, 1), "coarse": _n("num", 0.5, True, 0, 1),
        "output": _n("enum", "degrained", choices=DEGRAIN_OUTPUTS), "profile": _PROFILE}},
    "regrain": {"inputs": ["comp", "plate", "degrained", "new"], "params": {
        "amount": _n("num", 1, True, 0), "fill": _n("enum", "scatter", choices=REGRAIN_FILLS),
        "detect": _n("enum", "on", choices=["on", "off"]), "threshold": _n("num", 0.02, True, 0),
        "softness": _n("num", 0.02, True, 0), "cell": _n("num", 48, False, 4, 512), "seed": _n("int", 0),
        "animated": _n("enum", "on", choices=GRAIN_ANIM), "output": _n("enum", "result", choices=REGRAIN_OUTPUTS),
        "profile": _PROFILE}},
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
    "vfx_alpha": {"inputs": ["src"], "params": {"output": _n("enum", "premultiplied", choices=["premultiplied", "matte"]),
                                                "prerender": _PRERENDER, "results": _RESULTS}},
    "vfx_hdr": {"inputs": ["src"], "params": {"prerender": _PRERENDER, "results": _RESULTS}},
    "vfx_reframe": {"inputs": ["src"], "params": {"width": _n("int", 1920, mn=256, mx=1920), "height": _n("int", 1088, mn=256, mx=1920),
                                                  "prompt": _n("prompt", ""), "prerender": _PRERENDER, "results": _RESULTS}},
    "vfx_upscale": {"inputs": ["src"], "params": {"mode": _n("enum", "refine", choices=["refine", "restore"]),
                                                  "size": _n("enum", "FullHD", choices=["FullHD", "4K"]),
                                                  "prompt": _n("prompt", ""), "prerender": _PRERENDER, "results": _RESULTS}},
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


def vfx_span(n):
    """The comp frames a VFX node's result covers, (first, last), or None before it ran."""
    r = n.get("results") if isinstance(n.get("results"), dict) else None
    if not r or not r.get("file"):
        return None
    try:
        return int(r["first"]), int(r["last"])
    except (KeyError, TypeError, ValueError):
        return None


def vfx_read(n, f):
    sp = vfx_span(n)
    if not sp or f < sp[0] or f > sp[1]:
        return None
    r = n["results"]
    return {"id": f"{n['id']}#vfx", "type": "read", "file": r["file"],
            "colorspace": r.get("colorspace") or ("linear" if VFX_KINDS[n["type"]] == "alpha" else "auto"),
            "fit": "stretch", "offset": int(r.get("offset") or 0), "inputs": []}


def vfx_size(n):
    """The result's size for reframe / upscale once run ({width, height}), else None (the size that comes in)."""
    r = n.get("results") if isinstance(n.get("results"), dict) and not n.get("disable") else None
    if not r or not r.get("file") or VFX_KINDS.get(n["type"]) not in _VFX_SIZED:
        return None
    try:
        w, h = _round(float(r.get("width"))), _round(float(r.get("height")))
    except (TypeError, ValueError):
        return None
    return {"width": w, "height": h} if w > 0 and h > 0 else None


def _vfx_make(n, f, p, api):
    kind = VFX_KINDS[n["type"]]
    ins = n.get("inputs") or []
    if ins and ins[0]:
        s = api.run(ins[0], f)
    else:
        w0, h0 = api.size(n, 0)
        s = M.blank(w0, h0)
    h0, w0 = s.shape[:2]
    sz = vfx_size(n)
    w, h = (max(1, _round(sz["width"] * api.scale)), max(1, _round(sz["height"] * api.scale))) if sz else (w0, h0)

    def fit(img):
        hh, ww = img.shape[:2]
        return img if (ww, hh) == (w, h) else M.resample(img, M.fit_matrix(ww, hh, w, h, "stretch"), w, h)
    rd = vfx_read(n, f)
    got = api.source(rd, f) if rd and api.source else None
    if got is None:
        return fit(s)
    R = fit(got)
    if kind in ("reframe", "upscale"):
        return R
    R, S = _f64(R), _f64(fit(s))
    if kind == "alpha":
        m = 0.2126 * R[..., 0] + 0.7152 * R[..., 1] + 0.0722 * R[..., 2]
        if p.get("output") == "matte":
            return _matte(m)
        return (S * m[..., None]).astype(np.float32)
    return (R * S[..., 3:4]).astype(np.float32)


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
        if is_profile(n.get("profile")):
            return profile_grain_image(s, n, p, f, scale)
        return grain_image(s, p, f, scale, api.run(ins[1], f) if ins[1] else None)
    if t == "degrain":
        fs = degrain_frames(n, f)
        at = fs.index(f)
        s = api.run(ins[0], f)
        h0, w0 = s.shape[:2]
        pics = [s if g == f else M.conform(api.run(ins[0], g), w0, h0) for g in fs]
        return degrain_image(pics, at, n, p, scale)
    if t == "regrain":
        s = src()
        return regrain_image(s, other(1, s), other(2, s), other(3, s), n, p, f, scale)
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
    if t in VFX_KINDS:
        return _vfx_make(n, f, p, api)
    return _ai_make(n, f, p, api)


# ── grain as a measured thing (the page's imageViewer_compGrain.js) ──────────
# Clean room: the a-trous B3-spline wavelet (Starck and Murtagh), soft thresholding (Donoho), the median
# absolute deviation, Tukey's biweight and Cholesky, from their published descriptions.

GRAIN_LEVELS = 4
GRAIN_BINS = 8
_MIN_COUNT = 8
_SAMPLES = 65536
_MIN_SHARE = 0.005
_EDGE = 4


def atrous_smooth(a, j):
    """One a-trous smoothing at level j: [1 4 6 4 1] / 16 with holes of 2^j, across then down, edges held."""
    h, w = a.shape
    s = 1 << j
    xs = np.arange(w)
    x0, x1 = np.maximum(xs - 2 * s, 0), np.maximum(xs - s, 0)
    x3, x4 = np.minimum(xs + s, w - 1), np.minimum(xs + 2 * s, w - 1)
    t = (a[:, x0] + 4 * a[:, x1] + 6 * a + 4 * a[:, x3] + a[:, x4]) / 16
    ys = np.arange(h)
    y0, y1 = np.maximum(ys - 2 * s, 0), np.maximum(ys - s, 0)
    y3, y4 = np.minimum(ys + s, h - 1), np.minimum(ys + 2 * s, h - 1)
    return (t[y0] + 4 * t[y1] + 6 * t + 4 * t[y3] + t[y4]) / 16


def atrous(a, levels):
    d = []
    c = a
    for j in range(levels):
        n = atrous_smooth(c, j)
        d.append(c - n)
        c = n
    return d, c


_KR = 128
_KERNELS = []


def _atrous_kernels():
    if _KERNELS:
        return _KERNELS
    c = [0.0] * (2 * _KR + 1)
    c[_KR] = 1.0
    ks = [c]
    for k in range(GRAIN_LEVELS):
        s = 1 << k
        n = [0.0] * (2 * _KR + 1)
        taps = ((-2 * s, 1), (-s, 4), (0, 6), (s, 4), (2 * s, 1))
        for i in range(len(c)):
            if not c[i]:
                continue
            for o, wt in taps:
                q = i + o
                if 0 <= q < len(n):
                    n[q] += c[i] * wt / 16
        c = n
        ks.append(c)
    _KERNELS.extend(ks)
    return _KERNELS


def _dot(a, b):
    v = 0.0
    for i in range(len(a)):
        v += a[i] * b[i]
    return v


def white_band_cov(j, k):
    K = _atrous_kernels()
    x, y, z, t = _dot(K[j], K[k]), _dot(K[j], K[k + 1]), _dot(K[j + 1], K[k]), _dot(K[j + 1], K[k + 1])
    return x * x - y * y - z * z + t * t


def white_band_spread(j):
    return math.sqrt(white_band_cov(j, j))


def rgb_planes(img):
    s = _f64(img)
    return [s[..., 0], s[..., 1], s[..., 2]]


def guide_luma(planes):
    L = LUM[0] * planes[0] + LUM[1] * planes[1] + LUM[2] * planes[2]
    return atrous_smooth(atrous_smooth(L, 0), 1)


def _median(v):
    v = np.sort(np.asarray(v, np.float64))
    n = v.size
    if not n:
        return 0.0
    return float(v[(n - 1) // 2]) if n % 2 else float((v[n // 2 - 1] + v[n // 2]) / 2)


def _sample_index(w, h, levels):
    step = max(1, int(math.floor(math.sqrt((w * h) / _SAMPLES))))
    m = max(1, min(w // 4, h // 4, 1 << levels))
    ys = np.arange(m, h - m, step)
    xs = np.arange(m, w - m, step)
    return (ys[:, None] * w + xs[None, :]).reshape(-1)


def _flat_samples(idx, guide):
    if not idx.size:
        return idx
    h, w = guide.shape
    g = guide.reshape(-1)
    gm = np.abs(g[idx + 1] - g[idx - 1]) + np.abs(g[idx + w] - g[idx - w])
    lim = _EDGE * _median(gm)
    out = idx[gm <= lim]
    return out if out.size >= idx.size / 4 else idx


def _fill_bins(row, whole):
    out = list(row)
    for k in range(len(out)):
        if out[k] is not None:
            continue
        best = None
        r = 1
        while r < len(row) and best is None:
            if k - r >= 0 and row[k - r] is not None:
                best = row[k - r]
            elif k + r < len(row) and row[k + r] is not None:
                best = row[k + r]
            r += 1
        out[k] = whole if best is None else best
    return out


def analyse_grain(noise, guide, scale=1.0, rng=None):
    """The page's analyseGrain: noise = three planes, guide = the brightness plane (h x w)."""
    levels, NB = GRAIN_LEVELS, GRAIN_BINS
    h, w = guide.shape
    idx = _flat_samples(_sample_index(w, h, levels), guide)
    gflat = guide.reshape(-1)
    if rng:
        lo, hi = float(rng[0]), float(rng[1])
    else:
        g = np.sort(gflat[idx])
        n = g.size
        lo = float(g[int(math.floor(0.01 * (n - 1)))]) if n else 0.0
        hi = float(g[int(math.floor(0.99 * (n - 1)))]) if n else 1.0
    if not (hi - lo > 1e-6):
        hi = lo + 1e-6
    b = np.floor((gflat[idx] - lo) / (hi - lo) * NB)
    b = np.clip(b, 0, NB - 1).astype(np.int64)
    sigma = [[None] * 3 for _ in range(levels)]
    bands0 = []
    for c in range(3):
        d, _ = atrous(noise[c], levels)
        bands0.append(d[0].reshape(-1))
        for j in range(levels):
            v = np.abs(d[j].reshape(-1)[idx])
            least = max(_MIN_COUNT, int(math.ceil(_MIN_SHARE * idx.size)))
            row = []
            for k in range(NB):
                g = v[b == k]
                row.append(1.4826 * _median(g) if g.size >= least else None)
            sigma[j][c] = _fill_bins(row, 1.4826 * _median(v))
    S = [[0.0] * 3 for _ in range(3)]
    sb = [x[idx] for x in bands0]
    # Summed pixel by pixel in the page's order (a then b inside each pixel), so the rounding is the same.
    for a in range(3):
        for bb in range(3):
            S[a][bb] = float(_seq_sum(sb[a] * sb[bb]))
    corr = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    for a in range(3):
        for bb in range(3):
            if a == bb:
                continue
            q = math.sqrt(S[a][a] * S[bb][bb])
            corr[a][bb] = max(-1.0, min(1.0, S[a][bb] / q)) if q > 0 else 0.0
    return {"v": 1, "scale": scale, "levels": levels, "bins": NB, "lo": lo, "hi": hi, "sigma": sigma, "corr": corr}


def _seq_sum(v):
    """A sum taken one after the other, as the page adds (numpy's own sum pairs them)."""
    return float(np.cumsum(v)[-1]) if v.size else 0.0


def is_profile(p):
    try:
        return bool(p and p.get("v") == 1 and isinstance(p.get("sigma"), list) and p["sigma"]
                    and isinstance(p.get("corr"), list) and math.isfinite(float(p["lo"])) and math.isfinite(float(p["hi"])))
    except (TypeError, ValueError, AttributeError):
        return False


def merge_profiles(lst):
    ps = [p for p in lst if is_profile(p)]
    if not ps:
        return None
    import copy
    p0 = ps[0]
    out = copy.deepcopy(p0)
    for j in range(len(p0["sigma"])):
        for c in range(3):
            for k in range(p0["bins"]):
                out["sigma"][j][c][k] = _median([p["sigma"][j][c][k] for p in ps])
    for a in range(3):
        for b in range(3):
            s = 0.0
            for p in ps:
                s += p["corr"][a][b]
            out["corr"][a][b] = s / len(ps)
    out["frames"] = len(ps)
    return out


def profile_at(p, scale):
    shift = int(math.floor(math.log2(float(p["scale"]) / scale) + 0.5))
    L = len(p["sigma"])
    levels = max(1, L - max(0, shift))
    bands = []
    for j in range(levels):
        m = min(L - 1, max(0, j + shift))
        bands.append([list(map(float, row)) for row in p["sigma"][m]])
    bins = int(p["bins"])
    rho = [[white_band_cov(j, k) / (white_band_spread(j) * white_band_spread(k)) for k in range(levels)] for j in range(levels)]
    total = []
    for c in range(3):
        row = []
        for b in range(bins):
            v = 0.0
            for j in range(levels):
                for k in range(levels):
                    v += rho[j][k] * bands[j][c][b] * bands[k][c][b]
            row.append(math.sqrt(max(0.0, v)))
        total.append(row)
    return {"levels": levels, "bands": bands, "total": total, "lo": float(p["lo"]), "hi": float(p["hi"]), "bins": bins,
            "corr": [list(map(float, r)) for r in p["corr"]]}


def bin_places(guide, q):
    NB = q["bins"]
    u = (guide - q["lo"]) / (q["hi"] - q["lo"]) * NB - 0.5
    u = np.clip(u, 0, NB - 1)
    k = np.floor(u)
    k = np.minimum(k, max(0, NB - 2))
    t = u - k if NB > 1 else np.zeros_like(u)
    return k.astype(np.int64), t


def _lookup(row, pl):
    k, t = pl
    r = np.asarray(row, np.float64)
    if r.size > 1:
        return r[k] * (1 - t) + r[k + 1] * t
    return np.full(k.shape, r[0])


def cholesky3(m):
    L = [[0.0] * 3 for _ in range(3)]
    for i in range(3):
        for j in range(i + 1):
            s = m[i][j]
            for k in range(j):
                s -= L[i][k] * L[j][k]
            L[i][j] = math.sqrt(max(s, 1e-6)) if i == j else s / L[j][j]
    return L


def synth_field(q, w, h, frame, seed):
    ys, xs = np.mgrid[0:h, 0:w]
    k = 3.4641016151377544
    a = (hash01(xs, ys, 0, frame, seed) - 0.5) * k
    b = (hash01(xs, ys, 1, frame, seed) - 0.5) * k
    c = (hash01(xs, ys, 2, frame, seed) - 0.5) * k
    Lc = cholesky3(q["corr"])
    X = [Lc[0][0] * a, Lc[1][0] * a + Lc[1][1] * b, Lc[2][0] * a + Lc[2][1] * b + Lc[2][2] * c]
    out = []
    for ch in range(3):
        share = []
        for j in range(q["levels"]):
            s = 0.0
            for kk in range(q["bins"]):
                s += q["bands"][j][ch][kk] / q["total"][ch][kk] if q["total"][ch][kk] > 0 else 0
            share.append(s / q["bins"])
        g0 = [share[j] / white_band_spread(j) for j in range(q["levels"])]
        vr = 0.0
        for j in range(q["levels"]):
            for kk in range(q["levels"]):
                vr += g0[j] * g0[kk] * white_band_cov(j, kk)
        sd = math.sqrt(vr) if vr > 0 else 1.0
        d, _ = atrous(X[ch], q["levels"])
        o = np.zeros((h, w))
        for j in range(q["levels"]):
            o = o + (g0[j] / sd) * d[j]
        out.append(o)
    return out


def _profile_for(n, noise, guide, scale):
    p = n.get("profile") if n else None
    return profile_at(p if is_profile(p) else analyse_grain(noise, guide, scale), scale)


def profile_grain_image(img, n, p, frame, scale):
    h, w = img.shape[:2]
    q = profile_at(n["profile"], scale)
    fr = 0 if p["animated"] == "off" else _round(frame)
    seed = _round(p.get("seed") or 0)
    F = synth_field(q, w, h, fr, seed)
    s = _f64(img)
    pl = bin_places(guide_luma(rgb_planes(img)), q)
    out = s.copy()
    a = s[..., 3]
    for c in range(3):
        out[..., c] = s[..., c] + p["amount"] * a * F[c] * _lookup(q["total"][c], pl)
    return out.astype(np.float32)


def _box3(a):
    h, w = a.shape
    xs = np.arange(w)
    t = (a[:, np.maximum(xs - 1, 0)] + a + a[:, np.minimum(xs + 1, w - 1)]) / 3
    ys = np.arange(h)
    return (t[np.maximum(ys - 1, 0)] + t + t[np.minimum(ys + 1, h - 1)]) / 3


def degrain_frames(n, f):
    R = max(0, min(3, _round(n.get("temporal") if n.get("temporal") is not None else 1)))
    return list(range(f - R, f + R + 1))


def degrain_image(pics, at, n, p, scale):
    S = pics[at]
    s = _f64(S)
    planes = rgb_planes(S)
    guide = guide_luma(planes)
    q = _profile_for(n, planes, guide, scale)
    pl = bin_places(guide, q)
    lum_tot = [(q["total"][0][k] + q["total"][1][k] + q["total"][2][k]) / 3 for k in range(q["bins"])]
    T, rho = planes, None
    if len(pics) > 1:
        acc = [x.copy() for x in planes]
        W = np.ones(guide.shape)
        W2 = np.ones(guide.shape)
        mot = max(1e-6, p["motion"])
        sg = _lookup(lum_tot, pl)
        for k in range(len(pics)):
            if k == at:
                continue
            Q = rgb_planes(pics[k])
            D = (np.abs(Q[0] - planes[0]) + np.abs(Q[1] - planes[1]) + np.abs(Q[2] - planes[2])) / 3
            Db = _box3(D)
            with np.errstate(divide="ignore", invalid="ignore"):
                u = np.where(sg > 0, Db / (mot * sg), 2.0)
            wt = np.where(u < 1, (1 - u * u) * (1 - u * u), 0.0)
            for c in range(3):
                acc[c] = acc[c] + wt * Q[c]
            W = W + wt
            W2 = W2 + wt * wt
        T = [a / W for a in acc]
        rho = np.sqrt(W2) / W
    amt = [p["fine"], p["medium"], p["coarse"]]
    k0 = max(0.0, p["strength"])
    res = []
    for c in range(3):
        d, rest = atrous(T[c], q["levels"])
        o = rest.copy()
        for j in range(q["levels"]):
            a = amt[min(j, 2)]
            v = d[j]
            if not a:
                o = o + v
                continue
            thr = k0 * _lookup(q["bands"][j][c], pl) * (rho if rho is not None else 1)
            m = np.abs(v) - thr
            soft = np.where(m > 0, np.where(v < 0, -m, m), 0.0)
            o = o + (v + a * (soft - v))
        res.append(o)
    out = np.empty_like(s)
    out[..., 3] = s[..., 3]
    for c in range(3):
        out[..., c] = s[..., c] - res[c] if p["output"] == "removed" else res[c]
    return out.astype(np.float32)


def _scatter_field(G, w, h, cs, frame, seed):
    ys, xs = np.mgrid[0:h, 0:w]
    cx, cy = np.floor(xs / cs).astype(np.int64), np.floor(ys / cs).astype(np.int64)
    best = np.full((h, w), np.inf)
    bx, by = np.zeros((h, w), np.int64), np.zeros((h, w), np.int64)
    for db in (-1, 0, 1):
        for da in (-1, 0, 1):
            a, b = cx + da, cy + db
            px = (a + hash01(a, b, 10, frame, seed)) * cs
            py = (b + hash01(a, b, 11, frame, seed)) * cs
            dd = (px - xs) * (px - xs) + (py - ys) * (py - ys)
            nb = dd < best
            best = np.where(nb, dd, best)
            bx = np.where(nb, a, bx)
            by = np.where(nb, b, by)
    G, ok = G
    jy = jx = None
    done = np.zeros((h, w), bool)
    for t in range(4):
        ox = np.floor(hash01(bx, by, 12 + 2 * t, frame, seed) * w).astype(np.int64)
        oy = np.floor(hash01(bx, by, 13 + 2 * t, frame, seed) * h).astype(np.int64)
        ty, tx = (ys + oy) % h, (xs + ox) % w
        if jy is None:
            jy, jx = ty, tx
        else:
            jy, jx = np.where(done, jy, ty), np.where(done, jx, tx)
        done = done | ok[jy, jx]
    return [g[jy, jx] for g in G]


def _scatter_source(Nrm, guide):
    h, w = guide.shape
    xs, ys = np.arange(w), np.arange(h)
    l, r = np.maximum(xs - 1, 0), np.minimum(xs + 1, w - 1)
    u, d = np.maximum(ys - 1, 0), np.minimum(ys + 1, h - 1)
    gm = np.abs(guide[:, r] - guide[:, l]) + np.abs(guide[d] - guide[u])
    idx = _sample_index(w, h, GRAIN_LEVELS)
    lim = 2 * _EDGE * _median(gm.reshape(-1)[idx])
    return [np.clip(x, -4, 4) for x in Nrm], gm <= lim


def regrain_image(comp, plate, degr, new_mask, n, p, frame, scale):
    h, w = comp.shape[:2]
    fr = 0 if p["animated"] == "off" else _round(frame)
    seed = _round(p.get("seed") or 0)
    s = _f64(comp)
    Cg = guide_luma(rgb_planes(comp))
    have = plate is not None and degr is not None
    G = Dg = None
    if have:
        P, D = rgb_planes(plate), rgb_planes(degr)
        G = [P[c] - D[c] for c in range(3)]
        Dg = guide_luma(D)
        q = _profile_for(n, G, Dg, scale)
    elif is_profile(n.get("profile")):
        q = profile_at(n["profile"], scale)
    else:
        return comp
    plC = bin_places(Cg, q)
    if not have:
        m = np.ones((h, w))
    else:
        m = np.zeros((h, w))
        if new_mask is not None:
            m = _clip01(_f64(new_mask)[..., 3])
        if p["detect"] == "on":
            d = np.abs(Cg - Dg)
            thr, soft = p["threshold"], p["softness"]
            v = _clip01((d - thr) / soft) if soft > 0 else np.where(d > thr, 1.0, 0.0)
            m = np.where(v > m, v, m)
    Nrm = None
    if have:
        plD = bin_places(Dg, q)
        Nrm = []
        for c in range(3):
            sg = _lookup(q["total"][c], plD)
            with np.errstate(divide="ignore", invalid="ignore"):
                Nrm.append(np.where(sg > 1e-9, G[c] / sg, 0.0))
    F = None
    if not have or p["fill"] == "synth":
        F = synth_field(q, w, h, fr, seed)
    elif p["fill"] == "scatter":
        F = _scatter_field(_scatter_source(Nrm, Dg), w, h, max(4.0, p["cell"] * scale), fr, seed)
    mm = m if F is not None else np.zeros((h, w))
    out = np.empty_like(s)
    a = s[..., 3]
    mode = p["output"]
    for c in range(3):
        u = (Nrm[c] * (1 - mm) if Nrm is not None else 0) + (F[c] * mm if F is not None else 0)
        g = p["amount"] * u * _lookup(q["total"][c], plC)
        r = s[..., c] + a * g
        if mode == "grain":
            out[..., c] = g
        elif mode == "new areas":
            out[..., c] = m
        elif mode == "difference":
            out[..., c] = r - _f64(plate)[..., c] if have else g
        else:
            out[..., c] = r
    out[..., 3] = a if mode == "result" else 1.0
    return out.astype(np.float32)


def analyse_inputs(node_type, pics):
    """The noise and guide Analyse measures for a node from its inputs' pictures: (noise planes, guide) or None."""
    a = pics[0] if pics else None
    b = pics[1] if len(pics) > 1 else None
    if node_type == "regrain":
        if a is None or b is None:
            return None
        P, D = rgb_planes(a), rgb_planes(b)
        return [P[c] - D[c] for c in range(3)], guide_luma(D)
    if a is None:
        return None
    P = rgb_planes(a)
    return P, guide_luma(P)
