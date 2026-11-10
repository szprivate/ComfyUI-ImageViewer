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
SHUFFLE_CHOICES = ["r", "g", "b", "a", "0", "1"]
COPY_CHOICES = ["B", "A.r", "A.g", "A.b", "A.a", "0", "1"]
KEYER_MODES = ["chroma", "luma"]
ROTO_MODES = ["add", "subtract"]
SHUTTER_OFFSETS = ["centred", "start", "end"]
DEPTH_CHANNELS = ["r", "g", "b", "a", "luminance"]
FLOW_DETAIL = {"full": 0, "half": 1, "quarter": 2}
LUM = (0.2126, 0.7152, 0.0722)
_CH = {"r": 0, "g": 1, "b": 2, "a": 3}

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
    "crop": {"inputs": ["src"], "params": {
        "topleft": {"kind": "vec2", "def": [0, 0], "key": True},
        "bottomright": {"kind": "vec2", "def": None, "key": True},
        "softness": {"kind": "num", "def": 0, "min": 0, "key": True},
    }},
    "shuffle": {"inputs": ["src"], "params": {k: {"kind": "enum", "def": k, "choices": SHUFFLE_CHOICES} for k in "rgba"}},
    "copy": {"inputs": ["B", "A"], "params": {
        "r": {"kind": "enum", "def": "B", "choices": COPY_CHOICES}, "g": {"kind": "enum", "def": "B", "choices": COPY_CHOICES},
        "b": {"kind": "enum", "def": "B", "choices": COPY_CHOICES}, "a": {"kind": "enum", "def": "A.a", "choices": COPY_CHOICES},
    }},
    "premult": {"inputs": ["src"], "params": {}},
    "unpremult": {"inputs": ["src"], "params": {}},
    "retime": {"inputs": ["src"], "params": {
        "speed": {"kind": "num", "def": 1},
        "start": {"kind": "int", "def": 0},
        "offset": {"kind": "num", "def": 0},
        "blend": {"kind": "enum", "def": "nearest", "choices": ["nearest", "mix"]},
    }},
    "keyer": {"inputs": ["src"], "params": {
        "mode": {"kind": "enum", "def": "chroma", "choices": KEYER_MODES},
        "screen": {"kind": "color", "def": [0.1, 0.55, 0.1, 1], "key": True},
        "tolerance": {"kind": "num", "def": 0.3, "min": 0, "key": True},
        "softness": {"kind": "num", "def": 0.3, "min": 0, "key": True},
        "despill": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
    }},
    "roto": {"inputs": ["src"], "params": {"shapes": {"kind": "shapes", "def": []}}},
    "vectors": {"inputs": ["src"], "params": {
        "smoothness": {"kind": "num", "def": 0.04, "min": 0.001, "max": 1},
        "iterations": {"kind": "int", "def": 30, "min": 1, "max": 200},
        "levels": {"kind": "int", "def": 4, "min": 1, "max": 8},
        "detail": {"kind": "enum", "def": "half", "choices": list(FLOW_DETAIL)},
    }},
    "motionblur": {"inputs": ["src", "vectors"], "params": {
        "shutter": {"kind": "num", "def": 0.5, "min": 0, "max": 2, "key": True},
        "samples": {"kind": "int", "def": 10, "min": 1, "max": 64},
        "offset": {"kind": "enum", "def": "centred", "choices": SHUTTER_OFFSETS},
    }},
    "depthblur": {"inputs": ["src", "depth"], "params": {
        "channel": {"kind": "enum", "def": "r", "choices": DEPTH_CHANNELS},
        "focus": {"kind": "num", "def": 0.5, "key": True},
        "dof": {"kind": "num", "def": 0.05, "min": 0, "key": True},
        "falloff": {"kind": "num", "def": 0.3, "min": 0.001, "key": True},
        "size": {"kind": "num", "def": 20, "min": 0, "max": 200, "key": True},
        "layers": {"kind": "int", "def": 6, "min": 2, "max": 16},
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


def _box_rows(a, r):
    """Mean over 2r+1 along axis 1 of a C-ordered [H, W, C] array, the edge repeated."""
    n = a.shape[1]
    p = np.concatenate([np.repeat(a[:, :1], r + 1, axis=1), a, np.repeat(a[:, -1:], r, axis=1)], axis=1)
    c = np.cumsum(p, axis=1, dtype=np.float64)
    out = c[:, 2 * r + 1:2 * r + 1 + n]
    out -= c[:, 0:n]
    out /= (2 * r + 1)
    return out


def _box_axis(a, r, axis):
    """Mean over 2r+1 along ``axis``, the edge repeated (the page's boxAxis: the same running sums). Down the
    columns it works on the transposed picture: numpy sums along the last axes much faster."""
    if r <= 0:
        return a
    if axis == 1:
        return _box_rows(a, r)
    t = np.ascontiguousarray(np.swapaxes(a, 0, 1))
    return np.ascontiguousarray(np.swapaxes(_box_rows(t, r), 0, 1))


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


# ── the heavier nodes (js/imageViewer_compOps.js) ────────────────────────────

def _clamp01(v):
    return np.clip(v, 0.0, 1.0)


def _axis_cover(n, lo, hi, soft):
    i = np.arange(n, dtype=np.float64)
    if soft > 0:
        c = i + 0.5
        return _clamp01((c - lo) / soft) * _clamp01((hi - c) / soft)
    return _clamp01(np.minimum(i + 1, hi) - np.maximum(i, lo))


def crop_image(img, l, t, r, b, soft):
    h, w = img.shape[:2]
    m = _axis_cover(h, t, b, soft)[:, None] * _axis_cover(w, l, r, soft)[None, :]
    return (img.astype(np.float64) * m[..., None]).astype(np.float32)


def shuffle_image(img, pick):
    out = np.empty_like(img)
    for k, c in enumerate(pick):
        out[..., k] = 0 if c == "0" else 1 if c == "1" else img[..., _CH[c]]
    return out


def copy_image(B, A, pick):
    out = np.empty_like(B)
    for k, c in enumerate(pick):
        out[..., k] = 0 if c == "0" else 1 if c == "1" else B[..., k] if c == "B" else A[..., _CH[c[2:]]]
    return out


def premult_image(img):
    d = img.astype(np.float64)
    a = d[..., 3:4]
    return np.concatenate([d[..., :3] * a, a], axis=2).astype(np.float32)


def unpremult_image(img):
    d = img.astype(np.float64)
    a = d[..., 3:4]
    rgb = np.where(a > 0, d[..., :3] / np.where(a > 0, a, 1), d[..., :3])
    return np.concatenate([rgb, a], axis=2).astype(np.float32)


def key_image(img, p):
    d = img.astype(np.float64)
    a = d[..., 3]
    sc = p.get("screen") or [0, 1, 0, 1]
    ssum = sc[0] + sc[1] + sc[2]
    qs = [sc[0] / ssum, sc[1] / ssum, sc[2] / ssum] if ssum > 1e-6 else [1 / 3, 1 / 3, 1 / 3]
    e0, e1, e2 = qs[0] - 1 / 3, qs[1] - 1 / 3, qs[2] - 1 / 3
    spread = math.sqrt(e0 * e0 + e1 * e1 + e2 * e2)
    k = 0
    if sc[1] >= sc[0] and sc[1] >= sc[2]:
        k = 1
    elif sc[2] >= sc[0] and sc[2] >= sc[1]:
        k = 2
    o1, o2 = (k + 1) % 3, (k + 2) % 3
    soft, tol, despill = max(p["softness"], 1e-6), p["tolerance"], p["despill"]
    safe = np.where(a > 0, a, 1)
    c = [np.where(a > 0, d[..., i] / safe, d[..., i]) for i in range(3)]
    if p.get("mode") == "luma":
        key = _clamp01((LUM[0] * c[0] + LUM[1] * c[1] + LUM[2] * c[2] - tol) / soft)
    else:
        total = c[0] + c[1] + c[2]
        st = np.where(total > 1e-6, total, 1)
        q0, q1, q2 = c[0] / st - qs[0], c[1] / st - qs[1], c[2] / st - qs[2]
        dist = np.sqrt(q0 * q0 + q1 * q1 + q2 * q2) / (spread if spread > 1e-6 else 1)
        key = _clamp01((dist - tol) / soft)
        key = np.where((total <= 1e-6) | (spread <= 1e-6), 1.0, key)
        if despill > 0:
            lim = np.maximum(c[o1], c[o2])
            c[k] = np.where(c[k] > lim, c[k] - despill * (c[k] - lim), c[k])
    na = a * key
    return np.stack([c[0] * na, c[1] * na, c[2] * na, na], axis=2).astype(np.float32)


_SUB = 4
_SPLINE_STEPS = 8


def shape_points(shape, frame):
    keys = [k for k in (shape.get("keys") or []) if isinstance(k, dict) and isinstance(k.get("pts"), list)]
    keys.sort(key=lambda k: k["f"])
    if not keys:
        return shape.get("pts") if isinstance(shape.get("pts"), list) else []
    if frame <= keys[0]["f"]:
        return keys[0]["pts"]
    if frame >= keys[-1]["f"]:
        return keys[-1]["pts"]
    i = 0
    while keys[i + 1]["f"] <= frame:
        i += 1
    a, b = keys[i], keys[i + 1]
    if len(a["pts"]) != len(b["pts"]):
        return a["pts"]
    t = (frame - a["f"]) / (b["f"] - a["f"])
    return [[p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] for p, q in zip(a["pts"], b["pts"])]


def shape_outline(pts, smooth, scale=1.0):
    n = len(pts)
    if not smooth or n < 3:
        return [[p[0] * scale, p[1] * scale] for p in pts]
    out = []
    for i in range(n):
        p0, p1, p2, p3 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        for s in range(_SPLINE_STEPS):
            t = s / _SPLINE_STEPS
            t2 = t * t
            t3 = t2 * t
            q = [0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                        + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3) for k in (0, 1)]
            out.append([q[0] * scale, q[1] * scale])
    return out


def polygon_cover(poly, w, h):
    """The page's polygonCover: even-odd, 4 x 4 sub-samples a pixel."""
    cov = np.zeros((h, w), np.float64)
    n = len(poly)
    if n < 3:
        return cov
    P = np.asarray(poly, np.float64)
    Q = np.roll(P, -1, axis=0)
    W4 = w * _SUB
    counts = np.zeros(W4 + 1, np.int64)
    for sy in range(h * _SUB):
        yy = (sy + 0.5) / _SUB
        hit = (P[:, 1] <= yy) != (Q[:, 1] <= yy)
        if hit.sum() < 2:
            continue
        p, q = P[hit], Q[hit]
        xs = np.sort(p[:, 0] + (yy - p[:, 1]) * (q[:, 0] - p[:, 0]) / (q[:, 1] - p[:, 1]))
        counts[:] = 0
        for j in range(0, len(xs) - 1, 2):
            k0 = max(0, math.ceil(xs[j] * _SUB - 0.5))
            k1 = min(W4, math.ceil(xs[j + 1] * _SUB - 0.5))
            if k1 > k0:
                counts[k0] += 1
                counts[k1] -= 1
        inside = np.cumsum(counts[:W4])
        cov[sy // _SUB] += inside.reshape(w, _SUB).sum(axis=1) / (_SUB * _SUB)
    return cov


def roto_matte(shapes, frame, w, h, scale):
    M = np.zeros((h, w), np.float64)
    for sh in shapes if isinstance(shapes, list) else []:
        if not isinstance(sh, dict) or sh.get("off"):
            continue
        pts = shape_points(sh, frame)
        if not pts or len(pts) < 3:
            continue
        m = polygon_cover(shape_outline(pts, sh.get("smooth") is not False, scale), w, h)
        feather = float(sh.get("feather") or 0) * scale
        if feather > 0:
            tmp = np.zeros((h, w, 4), np.float32)
            tmp[..., 0] = m
            m = blur_image(tmp, feather)[..., 0].astype(np.float64)
        if sh.get("mode") == "subtract":
            M = M * (1 - m)
        else:
            M = M + m - M * m
    return M


def roto_image(matte, src):
    if src is not None:
        return (src.astype(np.float64) * matte[..., None]).astype(np.float32)
    return np.repeat(matte[..., None], 4, axis=2).astype(np.float32)


_FLOW_WARPS = 2
_FLOW_MIN_SIDE = 8


def grey_of(img):
    d = img.astype(np.float64)
    lum = LUM[0] * d[..., 0] + LUM[1] * d[..., 1] + LUM[2] * d[..., 2]
    return np.where(lum > 0, np.power(np.maximum(lum, 0), 1 / 2.2), 0.0)


def _sample_clamped(a, x, y):
    """Bilinear at index coordinates, the edge repeated; ``a`` [H, W] or [H, W, C]."""
    h, w = a.shape[:2]
    x0 = np.floor(x)
    y0 = np.floor(y)
    fx, fy = x - x0, y - y0
    x0 = x0.astype(np.int64)
    y0 = y0.astype(np.int64)
    x1, y1 = np.clip(x0 + 1, 0, w - 1), np.clip(y0 + 1, 0, h - 1)
    x0, y0 = np.clip(x0, 0, w - 1), np.clip(y0, 0, h - 1)
    if a.ndim == 3:
        fx, fy = fx[..., None], fy[..., None]
    A, B, C, D = a[y0, x0], a[y0, x1], a[y1, x0], a[y1, x1]
    top = A + (B - A) * fx
    bot = C + (D - C) * fx
    return top + (bot - top) * fy


def _halve(a):
    h2, w2 = a.shape[0] // 2, a.shape[1] // 2
    return (a[0:2 * h2:2, 0:2 * w2:2] + a[0:2 * h2:2, 1:2 * w2:2] + a[1:2 * h2:2, 0:2 * w2:2] + a[1:2 * h2:2, 1:2 * w2:2]) / 4


def _nb(a):
    """(left, right, up, down) neighbours, the edge repeated."""
    return (np.concatenate([a[:, :1], a[:, :-1]], axis=1), np.concatenate([a[:, 1:], a[:, -1:]], axis=1),
            np.concatenate([a[:1], a[:-1]], axis=0), np.concatenate([a[1:], a[-1:]], axis=0))


def optical_flow(g0, g1, smoothness=0.04, iterations=30, levels=4, detail="full"):
    """The page's opticalFlow: Horn-Schunck on a pyramid with warping; returns (u, v) [H, W]."""
    skip = FLOW_DETAIL.get(detail, 0)
    pyr = [(g0, g1)]
    while len(pyr) < levels + skip:
        a, b = pyr[-1]
        if min(a.shape[0] // 2, a.shape[1] // 2) < _FLOW_MIN_SIDE:
            break
        pyr.append((_halve(a), _halve(b)))
    a2 = smoothness * smoothness
    u = v = None
    fine = min(skip, len(pyr) - 1)
    for I0, I1 in reversed(pyr[fine:]):
        H, W = I0.shape
        if u is None:
            u, v = np.zeros((H, W)), np.zeros((H, W))
        else:
            ph, pw = u.shape
            yi = np.minimum(np.arange(H) >> 1, ph - 1)[:, None]
            xi = np.minimum(np.arange(W) >> 1, pw - 1)[None, :]
            u, v = 2 * u[yi, xi], 2 * v[yi, xi]
        xs = np.arange(W, dtype=np.float64)[None, :]
        ys = np.arange(H, dtype=np.float64)[:, None]
        for _ in range(_FLOW_WARPS):
            Iw = _sample_clamped(I1, xs + u, ys + v)
            l0, r0, t0, b0 = _nb(I0)
            l1, r1, t1, b1 = _nb(Iw)
            Ix = ((r0 - l0) / 2 + (r1 - l1) / 2) / 2
            Iy = ((b0 - t0) / 2 + (b1 - t1) / 2) / 2
            It = Iw - I0
            den = a2 + Ix * Ix + Iy * Iy
            du, dv = np.zeros((H, W)), np.zeros((H, W))
            for _ in range(iterations):
                ul, ur, ut, ud = _nb(du)
                vl, vr, vt, vd = _nb(dv)
                ub = (ul + ur + ut + ud) / 4
                vb = (vl + vr + vt + vd) / 4
                t = (Ix * ub + Iy * vb + It) / den
                du, dv = ub - Ix * t, vb - Iy * t
            u = u + du
            v = v + dv
    if fine > 0:
        k = 2 ** fine
        h, w = g0.shape
        sx = (np.arange(w, dtype=np.float64)[None, :] + 0.5) / k - 0.5
        sy = (np.arange(h, dtype=np.float64)[:, None] + 0.5) / k - 0.5
        sx, sy = np.broadcast_to(sx, (h, w)), np.broadcast_to(sy, (h, w))
        return _sample_clamped(u, sx, sy) * k, _sample_clamped(v, sx, sy) * k
    return u, v


def vectors_image(prev, cur, nxt, opts, scale=1.0):
    g = grey_of(cur)
    fu, fv = optical_flow(g, grey_of(nxt), **opts)
    bu, bv = optical_flow(g, grey_of(prev), **opts)
    return np.stack([fu / scale, fv / scale, bu / scale, bv / scale], axis=2).astype(np.float32)


def motion_blur_image(img, vec, shutter, samples, offset, scale=1.0):
    if not shutter > 0 or vec is None:
        return img
    h, w = img.shape[:2]
    d = img.astype(np.float64)
    V = vec.astype(np.float64)
    lo = 0 if offset == "start" else -shutter if offset == "end" else -shutter / 2
    hi = lo + shutter
    N = max(1, int(math.floor(samples + 0.5)))
    xs = np.arange(w, dtype=np.float64)[None, :]
    ys = np.arange(h, dtype=np.float64)[:, None]
    acc = np.zeros((h, w, 4))
    for k in range(N):
        t = lo + ((k + 0.5) * (hi - lo)) / N
        if t >= 0:
            dx, dy = t * V[..., 0] * scale, t * V[..., 1] * scale
        else:
            dx, dy = -t * V[..., 2] * scale, -t * V[..., 3] * scale
        acc = acc + _sample_clamped(d, xs + dx, ys + dy)
    return (acc / N).astype(np.float32)


def depth_blur_image(img, depth, p):
    d = img.astype(np.float64)
    D = depth.astype(np.float64)
    L = max(2, int(math.floor(p["layers"] + 0.5)))
    ch = p["channel"]
    z = LUM[0] * D[..., 0] + LUM[1] * D[..., 1] + LUM[2] * D[..., 2] if ch == "luminance" else D[..., _CH[ch]]
    fall = max(p["falloff"], 1e-6)
    pos = _clamp01((np.abs(z - p["focus"]) - p["dof"] / 2) / fall) * (L - 1)
    num = np.zeros(d.shape)
    den = np.zeros(d.shape[:2])
    for layer in range(L):
        k = 1 - np.abs(pos - layer)
        if not (k > 0).any():
            continue
        k = np.where(k > 0, k, 0.0)
        col = (d * k[..., None]).astype(np.float32)
        wt = k.astype(np.float32)[..., None]   # one channel: the page blurs four alike, each the same numbers
        size = (p["size"] * layer) / (L - 1)
        num = num + blur_image(col, size)
        den = den + blur_image(wt, size)[..., 0]
    ok = (den > 1e-6)[..., None]
    return np.where(ok, num / np.where(ok, den[..., None], 1), d).astype(np.float32)


def mix_images(a, b, t):
    x = a.astype(np.float64)
    return (x + (b.astype(np.float64) - x) * t).astype(np.float32)


def retime_frame(node, f):
    start = node.get("start") or 0
    speed = node.get("speed")
    speed = 1 if speed is None else speed
    return start + (f - start) * speed + (node.get("offset") or 0)


def render_node(comp, nid, frame, source=None, scale=1.0, memo=None):
    """The picture node ``nid`` makes at ``frame``; ``source(node, frame)`` gives a Read's pixels (a picture at
    their own size) or None. The page's ``renderNode``: nodes that look at other times render their input
    at those frames."""
    fmt = comp["format"]
    W = max(1, int(math.floor(fmt["width"] * scale + 0.5)))
    H = max(1, int(math.floor(fmt["height"] * scale + 0.5)))
    memo = {} if memo is None else memo

    def run(i, f, depth):
        if not i or depth > 256:
            return blank(W, H)
        if (i, f) in memo:
            return memo[(i, f)]
        img = make(node_by_id(comp, i), f, depth + 1)
        memo[(i, f)] = img
        return img

    def P(n, f, names):
        return {k: param_at(n, k, f) for k in names}

    def vectors_of(src, f, d1, n):
        return vectors_image(run(src, f - 1, d1), run(src, f, d1), run(src, f + 1, d1),
                             {"smoothness": param_at(n, "smoothness", f), "iterations": int(param_at(n, "iterations", f)),
                              "levels": int(param_at(n, "levels", f)), "detail": param_at(n, "detail", f)}, scale)

    def make(n, f, d1):
        if not n:
            return blank(W, H)
        t = n.get("type")
        ins = n.get("inputs") or []
        if n.get("disable"):
            return run(ins[0], f, d1) if NODE_TYPES[t]["inputs"] else blank(W, H)
        if t == "read":
            src = source(n, f) if source else None
            return resample(src, fit_matrix(src.shape[1], src.shape[0], W, H, n.get("fit") or "fit", scale), W, H) \
                if src is not None else blank(W, H)
        if t == "constant":
            c = param_at(n, "color", f) or [0, 0, 0, 1]
            img = np.empty((H, W, 4), np.float32)
            img[...] = np.array([c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]], np.float32)
            return img
        if t == "merge":
            Bi, Ai = run(ins[0], f, d1), run(ins[1], f, d1)
            Mi = run(ins[2], f, d1) if ins[2] else None
            return merge_images(Bi, Ai, Mi, n.get("operation") or "over", param_at(n, "mix", f))
        if t == "transform":
            return resample(run(ins[0], f, d1), transform_matrix(n, f, fmt, scale), W, H)
        if t == "grade":
            return grade_image(run(ins[0], f, d1), P(n, f, NODE_TYPES["grade"]["params"]))
        if t == "blur":
            return blur_image(run(ins[0], f, d1), param_at(n, "size", f) * scale)
        if t == "crop":
            tl = param_at(n, "topleft", f) or [0, 0]
            br = param_at(n, "bottomright", f) or [fmt["width"], fmt["height"]]
            return crop_image(run(ins[0], f, d1), tl[0] * scale, tl[1] * scale, br[0] * scale, br[1] * scale,
                              param_at(n, "softness", f) * scale)
        if t == "shuffle":
            return shuffle_image(run(ins[0], f, d1), [n.get(k) or k for k in "rgba"])
        if t == "copy":
            pick = [n.get(k) or NODE_TYPES["copy"]["params"][k]["def"] for k in "rgba"]
            return copy_image(run(ins[0], f, d1), run(ins[1], f, d1), pick)
        if t == "premult":
            return premult_image(run(ins[0], f, d1))
        if t == "unpremult":
            return unpremult_image(run(ins[0], f, d1))
        if t == "retime":
            tf = retime_frame(n, f)
            if n.get("blend") != "mix":
                return run(ins[0], int(math.floor(tf + 0.5)), d1)
            f0 = int(math.floor(tf))
            fr = tf - f0
            if fr < 1e-9:
                return run(ins[0], f0, d1)
            return mix_images(run(ins[0], f0, d1), run(ins[0], f0 + 1, d1), fr)
        if t == "keyer":
            return key_image(run(ins[0], f, d1), P(n, f, NODE_TYPES["keyer"]["params"]))
        if t == "roto":
            return roto_image(roto_matte(n.get("shapes"), f, W, H, scale), run(ins[0], f, d1) if ins[0] else None)
        if t == "vectors":
            return vectors_of(ins[0], f, d1, n)
        if t == "motionblur":
            src = run(ins[0], f, d1)
            vec = run(ins[1], f, d1) if ins[1] else vectors_of(ins[0], f, d1, {"type": "vectors"})
            return motion_blur_image(src, vec, param_at(n, "shutter", f), param_at(n, "samples", f), n.get("offset") or "centred", scale)
        if t == "depthblur":
            src = run(ins[0], f, d1)
            if not ins[1]:
                return src
            p = P(n, f, NODE_TYPES["depthblur"]["params"])
            p["size"] = p["size"] * scale
            return depth_blur_image(src, run(ins[1], f, d1), p)
        if t == "output":
            return run(ins[0], f, d1)
        return blank(W, H)
    return run(nid, frame, 0)


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
