"""Comp: the compositing document (``*.comp.json``) and its pixel arithmetic, in numpy.

The same arithmetic as ``js/imageViewer_compModel.js`` (the Comp space's preview): the render, the
``Image Viewer Comp`` node and the routes run this one. ``tests/test_comp_parity.py`` renders the same
comps with both and compares them, and checks that the node table here is the page's.

Pictures are ``float32 [H, W, 4]``: linear light, premultiplied RGBA, top row first. Keys use Motion's
model and interpolation (``imageViewer_mgScene.js`` ``valueAt``), ported in :func:`value_at`.

No ComfyUI, aiohttp or torch in here, so it can be tested on its own.
"""
from __future__ import annotations

import copy
import math

import numpy as np

COMP_VERSION = 1
SUFFIX = ".comp.json"
MERGE_OPS = ["over", "under", "plus", "minus", "multiply", "screen", "max", "min", "difference",
             "in", "out", "atop", "mask", "stencil"]
FITS = ["fit", "fill", "none", "stretch"]
COLORSPACES = ["auto", "srgb", "linear"]

# The node types: the page's NODE_TYPES (kind, default, range, animatable). The parity test compares them.
NODE_TYPES = {
    "read": {"inputs": [], "params": {
        "file": {"kind": "file", "def": ""},
        "offset": {"kind": "int", "def": 0},
        "colorspace": {"kind": "enum", "def": "auto", "choices": COLORSPACES},
        "fit": {"kind": "enum", "def": "fit", "choices": FITS},
    }},
    "constant": {"inputs": [], "params": {
        "color": {"kind": "color", "def": [0, 0, 0, 1], "key": True},
    }},
    "merge": {"inputs": ["B", "A", "mask"], "params": {
        "operation": {"kind": "enum", "def": "over", "choices": MERGE_OPS},
        "mix": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
    }},
    "transform": {"inputs": ["src"], "params": {
        "translate": {"kind": "vec2", "def": [0, 0], "key": True},
        "rotate": {"kind": "num", "def": 0, "key": True},
        "scale": {"kind": "vec2", "def": [1, 1], "key": True},
        "center": {"kind": "vec2", "def": None, "key": True},
    }},
    "grade": {"inputs": ["src"], "params": {
        "blackpoint": {"kind": "num", "def": 0, "key": True},
        "whitepoint": {"kind": "num", "def": 1, "key": True},
        "lift": {"kind": "num", "def": 0, "key": True},
        "gain": {"kind": "num", "def": 1, "key": True},
        "multiply": {"kind": "num", "def": 1, "key": True},
        "offset": {"kind": "num", "def": 0, "key": True},
        "gamma": {"kind": "num", "def": 1, "min": 0.01, "key": True},
        "saturation": {"kind": "num", "def": 1, "min": 0, "key": True},
        "mix": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
    }},
    "blur": {"inputs": ["src"], "params": {
        "size": {"kind": "num", "def": 10, "min": 0, "max": 500, "key": True},
    }},
    "output": {"inputs": ["src"], "params": {}},
}


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_comp_path(path) -> bool:
    return isinstance(path, str) and path.lower().endswith(SUFFIX)


def node_by_id(comp, nid):
    for n in comp.get("nodes") or []:
        if n.get("id") == nid:
            return n
    return None


def new_comp(width=1920, height=1080, fps=24, frames=48):
    """The page's ``newComp``: a black Constant "Background" into Output1."""
    return {"comp": COMP_VERSION, "format": {"width": int(width), "height": int(height), "fps": fps, "frames": int(frames)},
            "nodes": [{"id": "Constant1", "type": "constant", "name": "Background", "x": 0, "y": 0,
                       "color": [0, 0, 0, 1], "inputs": []},
                      {"id": "Output1", "type": "output", "x": 0, "y": 200, "inputs": ["Constant1"]}],
            "output": "Output1"}


def normalize(raw):
    """``(comp, errors)``: the page's ``normalizeComp`` - defaults filled in, unknown nodes and loops dropped."""
    errors = []
    if not isinstance(raw, dict) or raw.get("comp") != COMP_VERSION:
        raise ValueError('not a comp (it needs "comp": 1)')
    f = raw.get("format") if isinstance(raw.get("format"), dict) else {}

    def _int(v, d, lo, hi):
        return max(lo, min(hi, int(round(v)))) if _is_num(v) else d

    comp = {"comp": COMP_VERSION,
            "format": {"width": _int(f.get("width"), 1920, 4, 16384), "height": _int(f.get("height"), 1080, 4, 16384),
                       "fps": f.get("fps") if _is_num(f.get("fps")) and f.get("fps") > 0 else 24,
                       "frames": _int(f.get("frames"), 48, 1, 100000)},
            "nodes": [], "output": raw.get("output") if isinstance(raw.get("output"), str) else None}
    seen = set()
    for n in raw.get("nodes") if isinstance(raw.get("nodes"), list) else []:
        if not isinstance(n, dict) or n.get("type") not in NODE_TYPES:
            errors.append("a node of unknown type was left out")
            continue
        if not isinstance(n.get("id"), str) or not n["id"] or n["id"] in seen:
            errors.append(f"a {n.get('type')} node without its own id was left out")
            continue
        seen.add(n["id"])
        node = copy.deepcopy(n)
        ins = n.get("inputs") if isinstance(n.get("inputs"), list) else []
        node["inputs"] = [ins[i] if i < len(ins) and isinstance(ins[i], str) else None
                          for i in range(len(NODE_TYPES[n["type"]]["inputs"]))]
        comp["nodes"].append(node)
    for n in comp["nodes"]:
        n["inputs"] = [i if i in seen and i != n["id"] else None for i in n["inputs"]]
    for n in comp["nodes"]:
        for i, src in enumerate(list(n["inputs"])):
            if not src:
                continue
            n["inputs"][i] = None
            if _reaches(comp, src, n["id"]):
                errors.append(f"{n['id']}: an input that made a loop was taken off")
            else:
                n["inputs"][i] = src
    out = node_by_id(comp, comp["output"]) if comp["output"] else None
    if not out or out.get("type") != "output":
        first = next((n for n in comp["nodes"] if n["type"] == "output"), None)
        comp["output"] = first["id"] if first else None
    return comp, errors


def _reaches(comp, start, target):
    seen, stack = set(), [start]
    while stack:
        nid = stack.pop()
        if nid == target:
            return True
        if not nid or nid in seen:
            continue
        seen.add(nid)
        n = node_by_id(comp, nid)
        if n:
            stack.extend(n.get("inputs") or [])
    return False


# ── keys: Motion's interpolation (imageViewer_mgScene.js) ────────────────────

_BEZIERS = {"easeIn": [0.42, 0, 1, 1], "easeOut": [0, 0, 0.58, 1], "easeInOut": [0.42, 0, 0.58, 1],
            "backOut": [0.34, 1.56, 0.64, 1], "expoOut": [0.16, 1, 0.3, 1]}


def _cubic_bezier_y(x1, y1, x2, y2, x):
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0

    def bx(t): return 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
    def by(t): return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
    def dbx(t): return 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2)
    t = x
    for _ in range(8):
        e = bx(t) - x
        if abs(e) < 1e-7:
            return by(t)
        d = dbx(t)
        if abs(d) < 1e-6:
            break
        t -= e / d
    lo, hi, t = 0.0, 1.0, x
    for _ in range(40):
        e = bx(t) - x
        if abs(e) < 1e-7:
            break
        if e > 0:
            hi = t
        else:
            lo = t
        t = (lo + hi) / 2
    return by(t)


def _bezier_progress(ease, t):
    b = ease if isinstance(ease, list) else _BEZIERS.get(ease)
    if not b or len(b) != 4:
        return None
    return _cubic_bezier_y(b[0], b[1], b[2], b[3], t)


def _hermite(p0, p1, m0, m1, t, span):
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * span * m0
            + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * span * m1)


def _auto_slope(ease, a, b, span):
    return (b - a) / span if ease == "linear" and span > 0 else 0


def _comp(v, axis):
    return v[axis] if isinstance(v, list) else v


def _interpolate(a, b, frame):
    span = b["f"] - a["f"]
    if a.get("ease") == "hold" or span <= 0:
        return copy.deepcopy(a["v"])
    t = (frame - a["f"]) / span
    va, vb = a["v"], b["v"]
    has_tan = "to" in a or "ti" in b
    bez = None if has_tan else _bezier_progress(a.get("ease"), t)

    def each(axis):
        p0, p1 = _comp(va, axis), _comp(vb, axis)
        if has_tan or a.get("ease") in ("smooth", None):
            m0 = _comp(a["to"], axis) if "to" in a else _auto_slope(a.get("ease"), p0, p1, span)
            m1 = _comp(b["ti"], axis) if "ti" in b else _auto_slope(a.get("ease"), p0, p1, span)
            return _hermite(p0, p1, m0, m1, t, span)
        if bez is not None:
            return p0 + (p1 - p0) * bez
        return p0 + (p1 - p0) * t
    return [each(i) for i in range(len(va))] if isinstance(va, list) else each(0)


def value_at(keys, own, frame):
    if not keys:
        return copy.deepcopy(own)
    if frame <= keys[0]["f"]:
        return copy.deepcopy(keys[0]["v"])
    if frame >= keys[-1]["f"]:
        return copy.deepcopy(keys[-1]["v"])
    i = 0
    while i < len(keys) - 1 and keys[i + 1]["f"] <= frame:
        i += 1
    return _interpolate(keys[i], keys[i + 1], frame)


def param_at(node, p, frame):
    d = NODE_TYPES.get(node.get("type"), {}).get("params", {}).get(p)
    own = node[p] if p in node else (d["def"] if d else None)
    if not d or not d.get("key"):
        return copy.deepcopy(own)
    tracks = node.get("tracks") if isinstance(node.get("tracks"), dict) else {}
    keys = tracks.get(p) if isinstance(tracks.get(p), list) else []
    v = value_at(keys, own, frame)
    if d["kind"] == "num" and _is_num(v):
        if "min" in d and v < d["min"]:
            v = d["min"]
        if "max" in d and v > d["max"]:
            v = d["max"]
    return v


# ── pixels ───────────────────────────────────────────────────────────────────

def blank(w, h):
    return np.zeros((h, w, 4), np.float32)


def srgb_to_linear(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def decode8(u8, linear=False):
    """uint8 straight RGBA [H, W, 4] (sRGB, or linear) -> a picture (the page's decode8)."""
    lut = (np.arange(256) / 255.0) if linear else srgb_to_linear(np.arange(256) / 255.0)
    lut = lut.astype(np.float32)
    a = (u8[..., 3].astype(np.float32) / np.float32(255))
    out = np.empty(u8.shape[:2] + (4,), np.float32)
    for k in range(3):
        out[..., k] = lut[u8[..., k]] * a
    out[..., 3] = a
    return out


def from_float(rgb, alpha=None, linear=True):
    """Float straight RGB [H, W, 3] (+ alpha [H, W]) -> a picture; sRGB decoded unless ``linear``."""
    rgb = np.asarray(rgb, np.float32)
    if not linear:
        rgb = srgb_to_linear(np.clip(rgb, 0, None)).astype(np.float32)
    a = np.ones(rgb.shape[:2], np.float32) if alpha is None else np.asarray(alpha, np.float32)
    return np.concatenate([rgb * a[..., None], a[..., None]], axis=2).astype(np.float32)


def to_straight(img, srgb=True):
    """A picture -> (rgb straight [H, W, 3], alpha [H, W]): what ComfyUI's IMAGE and MASK are."""
    a = img[..., 3]
    rgb = np.where(a[..., None] > 1e-8, img[..., :3] / np.maximum(a[..., None], 1e-8), img[..., :3])
    if srgb:
        rgb = linear_to_srgb(np.clip(rgb, 0, None))
    return rgb.astype(np.float32), a.astype(np.float32)


def _mul(m, n):
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]


def _inv(m):
    det = m[0] * m[3] - m[1] * m[2] or 1e-12
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
            (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]


def _t(x, y): return [1, 0, 0, 1, x, y]
def _s(x, y): return [x, 0, 0, y, 0, 0]


def _r(deg):
    a = deg * math.pi / 180
    c, s = math.cos(a), math.sin(a)
    return [c, s, -s, c, 0, 0]


def resample(src, m, w, h):
    """``src`` drawn through ``m`` (source -> output pixels) into w x h, bilinear, transparent outside."""
    sh, sw = src.shape[:2]
    if list(m) == [1, 0, 0, 1, 0, 0] and (sw, sh) == (w, h):
        return src.astype(np.float32, copy=True)
    iv = _inv(m)
    px = np.arange(w, dtype=np.float64) + 0.5
    py = np.arange(h, dtype=np.float64)[:, None] + 0.5
    u = iv[0] * px + iv[2] * py + iv[4] - 0.5
    v = iv[1] * px + iv[3] * py + iv[5] - 0.5
    x0 = np.floor(u).astype(np.int64)
    y0 = np.floor(v).astype(np.int64)
    fx = (u - x0)[..., None]
    fy = (v - y0)[..., None]
    out = np.zeros((h, w, 4), np.float64)
    srcd = src.astype(np.float64)
    for dy in (0, 1):
        for dx in (0, 1):
            xx, yy = x0 + dx, y0 + dy
            ok = (xx >= 0) & (yy >= 0) & (xx < sw) & (yy < sh)
            wgt = (fx if dx else 1 - fx) * (fy if dy else 1 - fy)
            vals = srcd[np.clip(yy, 0, sh - 1), np.clip(xx, 0, sw - 1)]
            out += np.where(ok[..., None], vals * wgt, 0)
    return out.astype(np.float32)


def fit_matrix(sw, sh, w, h, fit, k=1.0):
    kx = ky = float(k)
    if fit == "fit":
        kx = ky = min(w / sw, h / sh)
    elif fit == "fill":
        kx = ky = max(w / sw, h / sh)
    elif fit == "stretch":
        kx, ky = w / sw, h / sh
    return _mul(_t(w / 2, h / 2), _mul(_s(kx, ky), _t(-sw / 2, -sh / 2)))


def transform_matrix(node, frame, fmt, scale=1.0):
    t = param_at(node, "translate", frame) or [0, 0]
    r = param_at(node, "rotate", frame) or 0
    sc = param_at(node, "scale", frame) or [1, 1]
    c = param_at(node, "center", frame) or [fmt["width"] / 2, fmt["height"] / 2]
    cx, cy = c[0] * scale, c[1] * scale
    return _mul(_t(t[0] * scale + cx, t[1] * scale + cy), _mul(_r(r), _mul(_s(sc[0], sc[1]), _t(-cx, -cy))))


def boxes_for_gauss(sigma, n=3):
    """Paint's (paint_math.boxes_for_gauss), with the page's rounding (half up)."""
    if sigma <= 0:
        return [1] * n
    w_ideal = math.sqrt((12 * sigma * sigma / n) + 1)
    wl = int(math.floor(w_ideal))
    if wl % 2 == 0:
        wl -= 1
    wu = wl + 2
    m_ideal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4)
    m = int(math.floor(m_ideal + 0.5))
    return [wl if i < m else wu for i in range(n)]


def _box_axis(a, r, axis):
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


def blur_image(img, size):
    sigma = max(0.0, float(size)) / 2
    if sigma <= 0:
        return img
    out = img.astype(np.float64)
    for s in boxes_for_gauss(sigma):
        r = (s - 1) // 2
        out = _box_axis(out, r, 1)
        out = _box_axis(out, r, 0)
    return out.astype(np.float32)


def grade_image(img, p):
    a = img[..., 3:4].astype(np.float64)
    A = p["multiply"] * (p["gain"] - p["lift"]) / ((p["whitepoint"] - p["blackpoint"]) or 1e-6)
    B = p["offset"] + p["lift"] - A * p["blackpoint"]
    g = 1 / (p["gamma"] or 1e-6)
    c = np.where(a > 0, img[..., :3] / np.where(a > 0, a, 1), 0.0)
    r = A * c + B
    if g != 1:
        r = np.where(r > 0, np.power(np.maximum(r, 0), g), r)
    if p["saturation"] != 1:
        lum = (0.2126 * r[..., 0] + 0.7152 * r[..., 1] + 0.0722 * r[..., 2])[..., None]
        r = lum + (r - lum) * p["saturation"]
    res = (c + (r - c) * p["mix"]) * a
    out = np.where(a > 0, res, img[..., :3])
    return np.concatenate([out, a], axis=2).astype(np.float32)


def merge_images(Bimg, Aimg, Mimg, op, mix):
    B = Bimg.astype(np.float64)
    A = Aimg.astype(np.float64)
    a, b = A[..., 3:4], B[..., 3:4]
    r = {
        "over": lambda: A + B * (1 - a), "under": lambda: A * (1 - b) + B, "plus": lambda: A + B,
        "minus": lambda: A - B, "multiply": lambda: A * B, "screen": lambda: A + B - A * B,
        "max": lambda: np.maximum(A, B), "min": lambda: np.minimum(A, B), "difference": lambda: np.abs(A - B),
        "in": lambda: A * b, "out": lambda: A * (1 - b), "atop": lambda: A * b + B * (1 - a),
        "mask": lambda: B * a, "stencil": lambda: B * (1 - a),
    }.get(op, lambda: A + B * (1 - a))()
    t = mix * Mimg[..., 3:4].astype(np.float64) if Mimg is not None else mix
    return (B + (r - B) * t).astype(np.float32)


def render_node(comp, nid, frame, source=None, scale=1.0, memo=None):
    """The picture node ``nid`` makes at ``frame``; ``source(node, frame)`` gives a Read's / Input's pixels
    (a picture at their own size) or None. The page's ``renderNode``."""
    fmt = comp["format"]
    W = max(1, int(math.floor(fmt["width"] * scale + 0.5)))
    H = max(1, int(math.floor(fmt["height"] * scale + 0.5)))
    memo = {} if memo is None else memo

    def run(i, depth):
        if not i or depth > 256:
            return blank(W, H)
        if i in memo:
            return memo[i]
        n = node_by_id(comp, i)
        t = n.get("type") if n else None
        if not n:
            img = blank(W, H)
        elif n.get("disable"):
            img = run(n["inputs"][0], depth + 1) if NODE_TYPES[t]["inputs"] else blank(W, H)
        elif t == "read":
            src = source(n, frame) if source else None
            img = resample(src, fit_matrix(src.shape[1], src.shape[0], W, H, n.get("fit") or "fit", scale), W, H) \
                if src is not None else blank(W, H)
        elif t == "constant":
            c = param_at(n, "color", frame) or [0, 0, 0, 1]
            img = np.empty((H, W, 4), np.float32)
            img[...] = np.array([c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]], np.float32)
        elif t == "merge":
            Bi, Ai = run(n["inputs"][0], depth + 1), run(n["inputs"][1], depth + 1)
            Mi = run(n["inputs"][2], depth + 1) if n["inputs"][2] else None
            img = merge_images(Bi, Ai, Mi, n.get("operation") or "over", param_at(n, "mix", frame))
        elif t == "transform":
            img = resample(run(n["inputs"][0], depth + 1), transform_matrix(n, frame, fmt, scale), W, H)
        elif t == "grade":
            p = {k: param_at(n, k, frame) for k in NODE_TYPES["grade"]["params"]}
            img = grade_image(run(n["inputs"][0], depth + 1), p)
        elif t == "blur":
            img = blur_image(run(n["inputs"][0], depth + 1), param_at(n, "size", frame) * scale)
        elif t == "output":
            img = run(n["inputs"][0], depth + 1)
        else:
            img = blank(W, H)
        memo[i] = img
        return img
    return run(nid, 0)


def sources_of(comp, nid):
    """The Reads node ``nid`` depends on."""
    out, seen = [], set()

    def walk(i):
        if not i or i in seen:
            return
        seen.add(i)
        n = node_by_id(comp, i)
        if not n:
            return
        if n["type"] == "read":
            out.append(n)
        for k, s in enumerate(n.get("inputs") or []):
            if not n.get("disable") or k == 0:
                walk(s)
    walk(nid)
    return out


def source_frame(node, info, f):
    """Which file frame a Read shows at comp frame ``f`` (the page's ``sourceFrame``)."""
    if not info or info.get("kind") == "still":
        return None
    first = info.get("first") if _is_num(info.get("first")) else 0
    last = info.get("last") if _is_num(info.get("last")) else first
    n = first + f - int(node.get("offset") or 0)
    return max(first, min(last, n))
