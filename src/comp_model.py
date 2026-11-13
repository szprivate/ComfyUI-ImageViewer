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
import re

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
SHUTTER_OFFSETS = ["centred", "start", "end"]
DEPTH_CHANNELS = ["r", "g", "b", "a", "luminance"]
FLOW_DETAIL = {"full": 0, "half": 1, "quarter": 2}
LUM = (0.2126, 0.7152, 0.0722)
DEFOCUS_SHAPES = ["disc", "polygon"]
LUMA_SOURCES = ["luminance", "max", "red", "green", "blue"]
KEY_OUTPUTS = ["premultiplied", "matte", "despilled"]
DESPILL_LIMITS = ["max", "average"]
ERODE_SHAPES = ["box", "disc"]
ERODE_CHANNELS = ["rgba", "alpha"]
LAPLACIAN_MODES = ["laplacian", "highpass"]
CM_CHANNELS = ["r", "g", "b", "a", "luminance"]
CM_OUTPUTS = ["a", "r", "g", "b", "rgb", "rgba"]
CM_OPS = ["union", "plus", "minus", "from", "multiply", "divide", "in", "out", "stencil", "max", "min", "absminus", "xor"]
GLOW_SOURCES = ["luminance", "max"]
REFORMAT_TYPES = ["to format", "scale"]
REFORMAT_RESIZE = ["none", "fit", "fill", "width", "height", "distort"]
GHOST_SHAPES = ["disc", "polygon"]
MATH_OPS = ["add", "multiply", "power", "invert", "clamp", "min", "max", "abs", "threshold", "set"]
_CH = {"r": 0, "g": 1, "b": 2, "a": 3}

# The node types: the page's NODE_TYPES (kind, default, range, animatable). The parity test compares them.
CC_RANGES = ["master", "shadows", "midtones", "highlights"]
CC_SECONDARIES = ["secA", "secB"]
CC_VIEWS = ["result", "shadows", "midtones", "highlights", "secondary A", "secondary B"]
_CC_CH = ["", "_r", "_g", "_b"]


def cc_params():
    """ColorCorrect's parameters (js/imageViewer_compColor.js ``ccParams``; the panel's own fields left out)."""
    P = {}
    for R in CC_RANGES:
        def add(name, spec):
            P[f"{R}_{name}"] = dict(spec, key=True)
        add("hue", {"kind": "num", "def": 0})
        add("saturation", {"kind": "num", "def": 100, "min": 0})
        add("brightness", {"kind": "num", "def": 0})
        add("contrast", {"kind": "num", "def": 100, "min": 0})
        for name, d, mn in (("gain", 1, None), ("gamma", 1, 0.01), ("pedestal", 0, None)):
            for c in _CC_CH:
                add(name + c, {"kind": "num", "def": d, **({"min": mn} if mn is not None else {})})
        add("tint_hue", {"kind": "num", "def": 0})
        add("tint", {"kind": "num", "def": 0, "min": 0, "max": 100})
    P["contrast_centre"] = {"kind": "num", "def": 0.18, "min": 0.001, "key": True}
    P["shadow_end"] = {"kind": "num", "def": 0.5, "min": 0.01, "max": 1, "key": True}
    P["highlight_start"] = {"kind": "num", "def": 0.5, "min": 0, "max": 0.99, "key": True}
    for S in CC_SECONDARIES:
        P[f"{S}_on"] = {"kind": "enum", "def": "off", "choices": ["off", "on"]}
        P[f"{S}_color"] = {"kind": "color", "def": [0.6, 0.12, 0.05, 1] if S == "secA" else [0.05, 0.25, 0.6, 1]}
        P[f"{S}_hue_tol"] = {"kind": "num", "def": 15, "min": 0, "max": 180, "key": True}
        P[f"{S}_hue_soft"] = {"kind": "num", "def": 20, "min": 0, "max": 180, "key": True}
        P[f"{S}_sat_tol"] = {"kind": "num", "def": 0.3, "min": 0, "max": 1, "key": True}
        P[f"{S}_lum_tol"] = {"kind": "num", "def": 0.4, "min": 0, "max": 1, "key": True}
        P[f"{S}_soft"] = {"kind": "num", "def": 0.15, "min": 0, "max": 1, "key": True}
        P[f"{S}_hue"] = {"kind": "num", "def": 0, "key": True}
        P[f"{S}_saturation"] = {"kind": "num", "def": 100, "min": 0, "key": True}
        P[f"{S}_brightness"] = {"kind": "num", "def": 0, "key": True}
    P["mix"] = {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True}
    P["view"] = {"kind": "enum", "def": "result", "choices": CC_VIEWS}
    return P


NODE_TYPES = {
    "read": {"inputs": [], "params": {
        "file": {"kind": "file", "def": ""},
        "offset": {"kind": "int", "def": 0},
        "colorspace": {"kind": "ocio_cs", "def": "auto", "choices": COLORSPACES},
        "fit": {"kind": "enum", "def": "fit", "choices": FITS},
    }},
    "constant": {"inputs": [], "params": {
        "color": {"kind": "color", "def": [0, 0, 0, 1], "key": True},
        "write": {"kind": "target", "def": "rgba"},
    }},
    "merge": {"inputs": ["B", "A", "mask"], "params": {
        "operation": {"kind": "enum", "def": "over", "choices": MERGE_OPS},
        "mix": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
    }},
    "transform": {"inputs": ["src"], "params": {
        "translate": {"kind": "vec2", "def": [0, 0], "key": True},
        "rotate": {"kind": "num", "def": 0, "key": True},
        "scale": {"kind": "vec2", "def": [1, 1], "key": True},
        "skew": {"kind": "vec2", "def": [0, 0], "key": True},
        "center": {"kind": "vec2", "def": None, "key": True},
    }},
    "colorcorrect": {"inputs": ["src"], "params": cc_params()},
    "ocio_colorspace": {"inputs": ["src"], "params": {
        "in_space": {"kind": "ocio_cs", "def": ""},
        "out_space": {"kind": "ocio_cs", "def": ""},
        "unpremult": {"kind": "enum", "def": "on", "choices": ["on", "off"]},
    }},
    "ocio_display": {"inputs": ["src"], "params": {
        "in_space": {"kind": "ocio_cs", "def": ""},
        "display": {"kind": "ocio_display", "def": ""},
        "view": {"kind": "ocio_view", "def": ""},
        "unpremult": {"kind": "enum", "def": "on", "choices": ["on", "off"]},
    }},
    "lumakeyer": {"inputs": ["src"], "params": {
        "source": {"kind": "enum", "def": "luminance", "choices": LUMA_SOURCES},
        "low": {"kind": "num", "def": 0.2, "key": True},
        "low_soft": {"kind": "num", "def": 0.1, "min": 0, "key": True},
        "high": {"kind": "num", "def": 10, "key": True},
        "high_soft": {"kind": "num", "def": 0, "min": 0, "key": True},
        "clip_black": {"kind": "num", "def": 0, "min": 0, "max": 1, "key": True},
        "clip_white": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
        "invert": {"kind": "enum", "def": "off", "choices": ["off", "on"]},
        "output": {"kind": "enum", "def": "premultiplied", "choices": ["premultiplied", "matte"]},
        "write": {"kind": "target", "def": "rgba"},
    }},
    "chromakeyer": {"inputs": ["src"], "params": {
        "screen": {"kind": "color", "def": [0.1, 0.55, 0.1, 1]},
        "screen_gain": {"kind": "num", "def": 1, "min": 0, "key": True},
        "clip_black": {"kind": "num", "def": 0, "min": 0, "max": 1, "key": True},
        "clip_white": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
        "despill": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
        "despill_limit": {"kind": "enum", "def": "max", "choices": DESPILL_LIMITS},
        "invert": {"kind": "enum", "def": "off", "choices": ["off", "on"]},
        "output": {"kind": "enum", "def": "premultiplied", "choices": KEY_OUTPUTS},
        "write": {"kind": "target", "def": "rgba"},
    }},
    "erode": {"inputs": ["src"], "params": {
        "size": {"kind": "num", "def": -1, "min": -100, "max": 100, "key": True},
        "shape": {"kind": "enum", "def": "box", "choices": ERODE_SHAPES},
        "channels": {"kind": "enum", "def": "rgba", "choices": ERODE_CHANNELS},
    }},
    "laplacian": {"inputs": ["src"], "params": {
        "mode": {"kind": "enum", "def": "laplacian", "choices": LAPLACIAN_MODES},
        "size": {"kind": "num", "def": 0, "min": 0, "max": 200, "key": True},
        "gain": {"kind": "num", "def": 1, "key": True},
        "offset": {"kind": "num", "def": 0, "key": True},
    }},
    "channelmerge": {"inputs": ["B", "A"], "params": {
        "a_channel": {"kind": "enum", "def": "a", "choices": CM_CHANNELS},
        "b_channel": {"kind": "enum", "def": "a", "choices": CM_CHANNELS},
        "operation": {"kind": "enum", "def": "union", "choices": CM_OPS},
        "output": {"kind": "enum", "def": "a", "choices": CM_OUTPUTS},
        "mix": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
    }},
    "channelmath": {"inputs": ["src"], "params": {
        "operation": {"kind": "enum", "def": "multiply", "choices": MATH_OPS},
        "value": {"kind": "num", "def": 1, "key": True},
        "channels": {"kind": "enum", "def": "rgb", "choices": CM_OUTPUTS},
        "mix": {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True},
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
    "reformat": {"inputs": ["src"], "params": {
        "mode": {"kind": "enum", "def": "to format", "choices": REFORMAT_TYPES},
        "width": {"kind": "int", "def": None, "min": 1},
        "height": {"kind": "int", "def": None, "min": 1},
        "scale": {"kind": "num", "def": 1, "min": 0.01, "key": True},
        "resize": {"kind": "enum", "def": "fit", "choices": REFORMAT_RESIZE},
        "center": {"kind": "enum", "def": "on", "choices": ["on", "off"]},
        "flip": {"kind": "enum", "def": "off", "choices": ["off", "on"]},
        "flop": {"kind": "enum", "def": "off", "choices": ["off", "on"]},
        "turn": {"kind": "enum", "def": "off", "choices": ["off", "on"]},
    }},
    "crop": {"inputs": ["src"], "params": {
        "topleft": {"kind": "vec2", "def": [0, 0], "key": True},
        "bottomright": {"kind": "vec2", "def": None, "key": True},
        "softness": {"kind": "num", "def": 0, "min": 0, "key": True},
    }},
    "shuffle": {"inputs": ["src"], "params": dict({"out": {"kind": "layer", "def": "rgba"}}, **{k: {"kind": "chan", "def": k} for k in "rgba"})},
    "addchannels": {"inputs": ["src"], "params": {
        "channels": {"kind": "chanlist", "def": "mask.a"},
        "value": {"kind": "num", "def": 0},
    }},
    "removechannels": {"inputs": ["src"], "params": {
        "operation": {"kind": "enum", "def": "remove", "choices": ["remove", "keep"]},
        "channels": {"kind": "chanlist", "def": ""},
    }},
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
        "write": {"kind": "target", "def": "rgba"},
    }},
    "roto": {"inputs": ["src"], "params": {
        "roto": {"kind": "roto", "def": None},
        "write": {"kind": "target", "def": "rgba"},
        "premult": {"kind": "enum", "def": "on", "choices": ["on", "off"]},
    }},
    "vectors": {"inputs": ["src"], "params": {
        "smoothness": {"kind": "num", "def": 0.04, "min": 0.001, "max": 1},
        "iterations": {"kind": "int", "def": 30, "min": 1, "max": 200},
        "levels": {"kind": "int", "def": 4, "min": 1, "max": 8},
        "detail": {"kind": "enum", "def": "half", "choices": list(FLOW_DETAIL)},
        "write": {"kind": "target", "def": "rgba"},
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
        "filter": {"kind": "enum", "def": "gaussian", "choices": ["gaussian", "lens"]},
    }},
    "defocus": {"inputs": ["src"], "params": {
        "size": {"kind": "num", "def": 20, "min": 0, "max": 400, "key": True},
        "shape": {"kind": "enum", "def": "disc", "choices": DEFOCUS_SHAPES},
        "blades": {"kind": "int", "def": 6, "min": 3, "max": 16},
        "rotation": {"kind": "num", "def": 0, "key": True},
        "aspect": {"kind": "num", "def": 1, "min": 0.1, "max": 10, "key": True},
        "threshold": {"kind": "num", "def": 1, "min": 0, "key": True},
        "bloom": {"kind": "num", "def": 0, "min": 0, "key": True},
    }},
    "glow": {"inputs": ["src"], "params": {
        "threshold": {"kind": "num", "def": 0.8, "key": True},
        "softness": {"kind": "num", "def": 0.2, "min": 0, "key": True},
        "size": {"kind": "num", "def": 30, "min": 0, "max": 500, "key": True},
        "steps": {"kind": "int", "def": 4, "min": 1, "max": 8},
        "intensity": {"kind": "num", "def": 1, "min": 0, "key": True},
        "tint": {"kind": "color", "def": [1, 1, 1, 1]},
        "source": {"kind": "enum", "def": "luminance", "choices": GLOW_SOURCES},
        "effect_only": {"kind": "enum", "def": "off", "choices": ["off", "on"]},
    }},
    "lensflare": {"inputs": ["src", "dirt"], "params": {
        "position": {"kind": "vec2", "def": None, "key": True},
        "color": {"kind": "color", "def": [1, 0.85, 0.7, 1]},
        "intensity": {"kind": "num", "def": 1, "min": 0, "key": True},
        "size": {"kind": "num", "def": 1, "min": 0.01, "key": True},
        "glow_amount": {"kind": "num", "def": 1, "min": 0, "key": True},
        "glow_size": {"kind": "num", "def": 0.05, "min": 0, "key": True},
        "streak_count": {"kind": "int", "def": 6, "min": 0, "max": 32},
        "streak_amount": {"kind": "num", "def": 0.3, "min": 0, "key": True},
        "streak_length": {"kind": "num", "def": 0.4, "min": 0, "key": True},
        "streak_width": {"kind": "num", "def": 2, "min": 0.1, "key": True},
        "streak_angle": {"kind": "num", "def": 15, "key": True},
        "halo_amount": {"kind": "num", "def": 0.1, "min": 0, "key": True},
        "halo_radius": {"kind": "num", "def": 0.25, "min": 0, "key": True},
        "halo_width": {"kind": "num", "def": 0.015, "min": 0.001, "key": True},
        "ghost_count": {"kind": "int", "def": 6, "min": 0, "max": 16},
        "ghost_amount": {"kind": "num", "def": 0.15, "min": 0, "key": True},
        "ghost_size": {"kind": "num", "def": 0.04, "min": 0, "key": True},
        "ghost_spread": {"kind": "num", "def": 1, "key": True},
        "ghost_shape": {"kind": "enum", "def": "polygon", "choices": GHOST_SHAPES},
        "blades": {"kind": "int", "def": 6, "min": 3, "max": 16},
        "ghost_rotation": {"kind": "num", "def": 0, "key": True},
        "ghost_softness": {"kind": "num", "def": 0.3, "min": 0, "max": 1, "key": True},
        "dirt_amount": {"kind": "num", "def": 0, "min": 0, "key": True},
        "dirt_spots": {"kind": "int", "def": 120, "min": 0, "max": 1000},
        "dirt_reach": {"kind": "num", "def": 0.3, "min": 0.01, "key": True},
        "seed": {"kind": "int", "def": 1},
        "write": {"kind": "target", "def": "rgba"},
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
        # A layer's length: whole frames, out after in (a Merge's only).
        for k in ("in", "out"):
            if node["type"] != "merge" or not _is_num(node.get(k)):
                node.pop(k, None)
            else:
                node[k] = int(round(node[k]))
        if "in" in node and "out" in node and node["out"] <= node["in"]:
            errors.append(f"{node['id']}: its out was not after its in and was taken off")
            node.pop("out")
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


def merge_live(n, f):
    """Is a Merge's A laid over at frame ``f``: ``in`` is its first frame, ``out`` the first it is no longer."""
    if _is_num(n.get("in")) and f < n["in"]:
        return False
    if _is_num(n.get("out")) and f >= n["out"]:
        return False
    return True


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
def _k(kx, ky): return [1, ky, kx, kx * ky + 1, 0, 0]   # skew: x by kx * y, then y by ky * x


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
    k = param_at(node, "skew", frame) or [0, 0]
    c = param_at(node, "center", frame) or [fmt["width"] / 2, fmt["height"] / 2]
    cx, cy = c[0] * scale, c[1] * scale
    return _mul(_t(t[0] * scale + cx, t[1] * scale + cy), _mul(_r(r), _mul(_s(sc[0], sc[1]), _mul(_k(k[0], k[1]), _t(-cx, -cy)))))


def reformat_size(node, frame, in_fmt):
    """The size a Reformat makes, in pixels of the comp, from the size that comes in (the page's ``reformatSize``)."""
    if (param_at(node, "mode", frame) or "to format") == "scale":
        k = param_at(node, "scale", frame) or 1
        return max(1, _round_js(in_fmt["width"] * k)), max(1, _round_js(in_fmt["height"] * k))
    return (max(1, _round_js(param_at(node, "width", frame) or in_fmt["width"])),
            max(1, _round_js(param_at(node, "height", frame) or in_fmt["height"])))


def reformat_layout(node, frame, in_fmt, scale=1.0):
    """A Reformat: the picture that comes in (``in_fmt`` big) laid into a NEW picture of reformat_size; the matrix
    (input pixels -> output pixels) and the output's size in pixels (the page's ``reformatLayout``)."""
    FW, FH = in_fmt["width"], in_fmt["height"]
    bw, bh = reformat_size(node, frame, in_fmt)
    turn = param_at(node, "turn", frame) == "on"
    iw, ih = (FH, FW) if turn else (FW, FH)
    sx = sy = 1
    how = param_at(node, "resize", frame) or "fit"
    if how == "fit":
        sx = sy = min(bw / iw, bh / ih)
    elif how == "fill":
        sx = sy = max(bw / iw, bh / ih)
    elif how == "width":
        sx = sy = bw / iw
    elif how == "height":
        sx = sy = bh / ih
    elif how == "distort":
        sx, sy = bw / iw, bh / ih
    lw, lh = iw * sx, ih * sy
    if param_at(node, "flop", frame) == "on":
        sx = -sx
    if param_at(node, "flip", frame) == "on":
        sy = -sy
    centre = param_at(node, "center", frame) != "off"
    cx, cy = (bw / 2, bh / 2) if centre else (lw / 2, bh - lh / 2)
    m = _mul(_s(sx, sy), _t(-FW / 2, -FH / 2))
    if turn:
        m = _mul(_s(sx, sy), _mul([0, -1, 1, 0, 0, 0], _t(-FW / 2, -FH / 2)))
    m = _mul(_t(cx, cy), m)
    m = _mul(_s(scale, scale), _mul(m, _s(1 / scale, 1 / scale)))
    return m, max(1, _round_js(bw * scale)), max(1, _round_js(bh * scale))


def format_at(comp, nid, depth=0):
    """The size of the picture node ``nid`` makes, in pixels of the comp (the page's ``formatAt``)."""
    F = {"width": comp["format"]["width"], "height": comp["format"]["height"]}
    n = node_by_id(comp, nid) if nid and depth < 256 else None
    if not n or n.get("type") not in NODE_TYPES:
        return F
    ins = n.get("inputs") or []

    def up():
        return format_at(comp, ins[0], depth + 1) if NODE_TYPES[n["type"]]["inputs"] and ins and ins[0] else F
    if n.get("disable") or n["type"] != "reformat":
        return F if n["type"] in ("read", "constant") else up()
    w, h = reformat_size(n, 0, up())
    return {"width": w, "height": h}


def conform(img, w, h):
    """``img`` laid into an h x w picture, bottom left on bottom left (the page's ``conform``); a 2-D plane too."""
    if img is None or (img.shape[0] == h and img.shape[1] == w):
        return img
    out = np.zeros((h, w) + img.shape[2:], img.dtype)
    dy = h - img.shape[0]
    cw = min(w, img.shape[1])
    y0, y1 = max(0, dy), min(h, img.shape[0] + dy)
    if y1 > y0 and cw > 0:
        out[y0:y1, :cw] = img[y0 - dy:y1 - dy, :cw]
    return out


def _conform_extras(ex, w, h):
    return {k: conform(v, w, h) for k, v in (ex or {}).items()}


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


def roto_matte(data, frame, w, h):
    """A Roto node's matte at ``frame`` in a w x h picture: the viewer's roto data (coordinates a share of the
    frame, sizes in comp pixels) through roto_raster, the code the ImageViewerRoto node renders with."""
    if not isinstance(data, dict) or not data.get("layers"):
        return np.zeros((h, w), np.float64)
    return _roto_raster().rasterize(data, w, h, frames=[int(frame)])[0].astype(np.float64)


def _roto_raster():
    try:
        from . import roto_raster
        return roto_raster
    except ImportError:  # loaded on its own, by its path (the tests): roto_raster.py beside it
        import importlib.util
        import os
        import sys
        mod = sys.modules.get("roto_raster")
        if mod is None:
            spec = importlib.util.spec_from_file_location("roto_raster", os.path.join(os.path.dirname(os.path.abspath(__file__)), "roto_raster.py"))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            sys.modules["roto_raster"] = mod
        return mod


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
        if p.get("filter") == "lens":
            lp = {"size": size, "shape": "disc", "blades": 6, "rotation": 0, "aspect": 1, "bloom": 0, "threshold": 1}
            num = num + defocus_image(col, lp)
            den = den + defocus_image(wt, lp)[..., 0]
        else:
            num = num + blur_image(col, size)
            den = den + blur_image(wt, size)[..., 0]
    ok = (den > 1e-6)[..., None]
    return np.where(ok, num / np.where(ok, den[..., None], 1), d).astype(np.float32)


def aperture_rows(size, shape, blades, rotation, aspect):
    """The page's ``apertureRows``: [(dy, l, r)], the aperture's span on each row of pixels."""
    r = size / 2
    rows = []
    if not r > 0:
        return rows
    R = int(math.ceil(r))
    verts = None
    if shape == "polygon":
        n = max(3, int(math.floor(blades + 0.5)))
        rot = (rotation * math.pi) / 180
        verts = []
        for k in range(n):
            a = rot + (2 * math.pi * k) / n - math.pi / 2
            verts.append((r * aspect * math.cos(a), r * math.sin(a)))
    for dy in range(-R, R + 1):
        if verts is None:
            if abs(dy) > r:
                continue
            hw = aspect * math.sqrt(r * r - dy * dy)
            rows.append((dy, -hw, hw))
            continue
        lo, hi = math.inf, -math.inf
        for k in range(len(verts)):
            p, q = verts[k], verts[(k + 1) % len(verts)]
            if (p[1] <= dy) != (q[1] <= dy):
                x = p[0] + ((dy - p[1]) * (q[0] - p[0])) / (q[1] - p[1])
                lo = min(lo, x)
                hi = max(hi, x)
        if hi > lo:
            rows.append((dy, lo, hi))
    return rows


def _row_span(l, r):
    a, b = int(math.floor(l + 0.5)), int(math.floor(r + 0.5))
    if a == b:
        return a, b, r - l, 0.0
    return a, b, a + 0.5 - l, r - (b - 0.5)


def defocus_image(img, p):
    """The page's ``defocusImage``: the mean through the aperture, highlights bloomed first."""
    rows = [(dy,) + _row_span(l, r) for dy, l, r in aperture_rows(p["size"], p["shape"], p["blades"], p["rotation"], p["aspect"])]
    if len(rows) <= 1 and (not rows or rows[0][1] == rows[0][2]):
        return img
    h, w, C = img.shape
    s = img.astype(np.float64)
    reach = 1
    for _, a, b, _, _ in rows:
        reach = max(reach, abs(a) + 1, abs(b) + 1)
    total = 0.0
    for _, a, b, wa, wb in rows:
        if a == b:
            total += wa
            continue
        if b - 1 >= a + 1:
            total += b - 1 - (a + 1) + 1
        total += wa
        total += wb
    Q = np.concatenate([np.repeat(s[:, :1], reach, axis=1), s, np.repeat(s[:, -1:], reach, axis=1)], axis=1)
    bloom, thr = p.get("bloom") or 0, p["threshold"]
    if bloom > 0 and C >= 3:
        L = LUM[0] * Q[..., 0] + LUM[1] * Q[..., 1] + LUM[2] * Q[..., 2]
        m = np.where(L > thr, 1 + bloom * (L - thr), 1.0)
        Q = Q.copy()
        for c in range(3):
            Q[..., c] = Q[..., c] * m
    P = np.concatenate([np.zeros((h, 1, C)), np.cumsum(Q, axis=1)], axis=1)
    # Rows repeated at the top and bottom too, so each kernel row is a slice (a view), not a copy.
    ry = max(abs(k[0]) for k in rows)
    yy = np.clip(np.arange(-ry, h + ry), 0, h - 1)
    Q, P = Q[yy], P[yy]
    acc = np.zeros((h, w, C))
    for dy, a, b, wa, wb in rows:
        Qr, Pr = Q[ry + dy:ry + dy + h], P[ry + dy:ry + dy + h]
        o = reach
        if a == b:
            acc += wa * Qr[:, o + a:o + a + w]
            continue
        if b - 1 >= a + 1:
            acc += Pr[:, o + b:o + b + w] - Pr[:, o + a + 1:o + a + 1 + w]
        acc += wa * Qr[:, o + a:o + a + w]
        acc += wb * Qr[:, o + b:o + b + w]
    return (acc / total).astype(np.float32)


def _smooth(e0, e1, x):
    if not e1 > e0:
        return np.where(x < e0, 0.0, 1.0)
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _cc_luma(r, g, b):
    l = LUM[0] * r + LUM[1] * g + LUM[2] * b
    return np.where(l > 0, np.power(np.where(l > 0, l, 1.0), 1 / 2.2), 0.0)


def _hue_sat(r, g, b):
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    c = mx - mn
    sc = np.where(c > 0, c, 1.0)
    h = np.where(mx == r, 60 * ((g - b) / sc), np.where(mx == g, 60 * ((b - r) / sc + 2), 60 * ((r - g) / sc + 4)))
    h = np.where(h < 0, h + 360, h)
    h = np.where(c > 0, h, 0.0)
    return h, np.where(mx > 0, c / np.where(mx > 0, mx, 1.0), 0.0)


def _hue_turn(deg):
    th = (deg * math.pi) / 180
    co, si = np.cos(th), np.sin(th)
    return co + (1 - co) / 3, (1 - co) / 3 - si / math.sqrt(3), (1 - co) / 3 + si / math.sqrt(3)


def _tint_of(deg, amount):
    a = (deg * math.pi) / 180
    v = [math.cos(a), math.cos(a - (2 * math.pi) / 3), math.cos(a + (2 * math.pi) / 3)]
    l = LUM[0] * v[0] + LUM[1] * v[1] + LUM[2] * v[2]
    return [(amount / 100) * (x - l) for x in v]


def range_weights(Y, se, hs):
    ws = 1 - _smooth(0, se, Y)
    wh = _smooth(hs, 1, Y)
    wm = np.maximum(1 - ws - wh, 0)
    total = ws + wm + wh
    return ws / total, wm / total, wh / total


def color_correct_image(img, p):
    """The page's ``colorCorrectImage``: Color Finesse's primaries per luma range, two secondaries, a mix."""
    d = img.astype(np.float64)
    A = d[..., 3]
    ok = A > 0
    sa_ = np.where(ok, A, 1.0)
    r0, g0, b0 = d[..., 0] / sa_, d[..., 1] / sa_, d[..., 2] / sa_
    v = lambda R, n: p[f"{R}_{n}"]
    hue = [v(R, "hue") for R in CC_RANGES]
    sat = [v(R, "saturation") / 100 for R in CC_RANGES]
    bri = [v(R, "brightness") for R in CC_RANGES]
    con = [v(R, "contrast") / 100 for R in CC_RANGES]
    gain = [[v(R, "gain") * v(R, "gain" + _CC_CH[k]) for R in CC_RANGES] for k in (1, 2, 3)]
    gam = [[v(R, "gamma") * v(R, "gamma" + _CC_CH[k]) for R in CC_RANGES] for k in (1, 2, 3)]
    ped = [[v(R, "pedestal") + v(R, "pedestal" + _CC_CH[k]) for R in CC_RANGES] for k in (1, 2, 3)]
    tint = [_tint_of(v(R, "tint_hue"), v(R, "tint")) for R in CC_RANGES]
    cc, mix, view = p["contrast_centre"], p["mix"], p.get("view") or "result"
    ws, wm, wh = range_weights(_cc_luma(r0, g0, b0), p["shadow_end"], p["highlight_start"])
    r, g, b = r0, g0, b0
    t0, t1, t2 = _hue_turn(hue[0] + (ws * hue[1] + wm * hue[2] + wh * hue[3]))
    r, g, b = t0 * r + t1 * g + t2 * b, t2 * r + t0 * g + t1 * b, t1 * r + t2 * g + t0 * b
    s_ = sat[0] * (ws * sat[1] + wm * sat[2] + wh * sat[3])
    l = LUM[0] * r + LUM[1] * g + LUM[2] * b
    r, g, b = l + (r - l) * s_, l + (g - l) * s_, l + (b - l) * s_
    br = bri[0] + (ws * bri[1] + wm * bri[2] + wh * bri[3])
    r, g, b = r + br, g + br, b + br
    ct = con[0] * (ws * con[1] + wm * con[2] + wh * con[3])

    def pivot(x):
        return np.where(x > 0, cc * np.power(np.where(x > 0, x, cc) / cc, ct), x)
    c = [pivot(r), pivot(g), pivot(b)]
    for k in range(3):
        mul = 1 + (tint[0][k] + (wm * tint[2][k] + wh * tint[3][k]))
        c[k] = c[k] * mul + ws * tint[1][k] * 0.1
    for k in range(3):
        G, Ga, Pe = gain[k], gam[k], ped[k]
        gk = G[0] * (ws * G[1] + wm * G[2] + wh * G[3])
        ak = Ga[0] * (ws * Ga[1] + wm * Ga[2] + wh * Ga[3])
        pk = Pe[0] + (ws * Pe[1] + wm * Pe[2] + wh * Pe[3])
        x = c[k] * gk + pk
        c[k] = np.where(x > 0, np.power(np.where(x > 0, x, 1.0), 1 / ak), x)
    q = {"secA": np.zeros_like(r0), "secB": np.zeros_like(r0)}
    for X in CC_SECONDARIES:
        if p.get(f"{X}_on") != "on":
            continue
        key = p.get(f"{X}_color") or [0, 0, 0, 1]
        kh, ks = (float(t) for t in _hue_sat(np.float64(key[0]), np.float64(key[1]), np.float64(key[2])))
        kY = float(_cc_luma(np.float64(key[0]), np.float64(key[1]), np.float64(key[2])))
        ht, hsft, st, lt, soft = (p[f"{X}_{n}"] for n in ("hue_tol", "hue_soft", "sat_tol", "lum_tol", "soft"))
        ph, ps = _hue_sat(c[0], c[1], c[2])
        dh = np.abs(ph - kh)
        dh = np.where(dh > 180, 360 - dh, dh)
        m = (1 - _smooth(ht, ht + hsft, dh)) * (1 - _smooth(st, st + soft, np.abs(ps - ks))) \
            * (1 - _smooth(lt, lt + soft, np.abs(_cc_luma(c[0], c[1], c[2]) - kY)))
        q[X] = m
        u0, u1, u2 = (float(t) for t in _hue_turn(np.float64(p[f"{X}_hue"])))
        xr, xg, xb = u0 * c[0] + u1 * c[1] + u2 * c[2], u2 * c[0] + u0 * c[1] + u1 * c[2], u1 * c[0] + u2 * c[1] + u0 * c[2]
        ll = LUM[0] * xr + LUM[1] * xg + LUM[2] * xb
        xs, xb_ = p[f"{X}_saturation"] / 100, p[f"{X}_brightness"]
        xr, xg, xb = ll + (xr - ll) * xs + xb_, ll + (xg - ll) * xs + xb_, ll + (xb - ll) * xs + xb_
        on = m > 0
        c = [np.where(on, c[0] + (xr - c[0]) * m, c[0]), np.where(on, c[1] + (xg - c[1]) * m, c[1]), np.where(on, c[2] + (xb - c[2]) * m, c[2])]
    if view != "result":
        m = {"shadows": ws, "midtones": wm, "highlights": wh, "secondary A": q["secA"]}.get(view, q["secB"])
        out = np.stack([m, m, m, np.ones_like(m)], axis=-1)
    else:
        out = np.stack([(r0 + (c[0] - r0) * mix) * A, (g0 + (c[1] - g0) * mix) * A, (b0 + (c[2] - b0) * mix) * A, A], axis=-1)
    return np.where(ok[..., None], out, d).astype(np.float32)


def _clip_matte(m, black, white):
    if not white > black:
        return np.where(m < black, 0.0, 1.0)
    return np.clip((m - black) / (white - black), 0, 1)


def _ramp_up(x, lo, soft):
    if soft > 0:
        return np.clip((x - lo) / soft, 0, 1)
    return np.where(x >= lo, 1.0, 0.0)


def _key_out(d, m, output, c=None):
    if output == "matte":
        return np.stack([m, m, m, np.ones_like(m)], axis=-1).astype(np.float32)
    a = d[..., 3]
    if c is not None:
        k = a if output == "despilled" else a * m
        return np.stack([c[0] * k, c[1] * k, c[2] * k, k], axis=-1).astype(np.float32)
    return np.stack([d[..., 0] * m, d[..., 1] * m, d[..., 2] * m, a * m], axis=-1).astype(np.float32)


def _straight(d):
    u = np.where(d[..., 3] > 0, d[..., 3], 1.0)
    return d[..., 0] / u, d[..., 1] / u, d[..., 2] / u


def luma_key_image(img, p):
    d = img.astype(np.float64)
    r, g, b = _straight(d)
    src = p["source"]
    Y = (np.maximum(np.maximum(r, g), b) if src == "max" else r if src == "red" else g if src == "green" else b if src == "blue"
         else LUM[0] * r + LUM[1] * g + LUM[2] * b)
    m = _ramp_up(Y, p["low"], p["low_soft"]) * (1 - _ramp_up(Y, p["high"], p["high_soft"]))
    m = _clip_matte(m, p["clip_black"], p["clip_white"])
    if p.get("invert") == "on":
        m = 1 - m
    return _key_out(d, m, p["output"])


def chroma_key_image(img, p):
    d = img.astype(np.float64)
    sc = p.get("screen") or [0, 1, 0, 1]
    k = 1 if sc[1] >= sc[0] and sc[1] >= sc[2] else 2 if sc[2] >= sc[0] else 0
    k1, k2 = (k + 1) % 3, (k + 2) % 3
    S = sc[k] - max(sc[k1], sc[k2])
    c = list(_straight(d))
    lim = (c[k1] + c[k2]) / 2 if p["despill_limit"] == "average" else np.maximum(c[k1], c[k2])
    diff = c[k] - np.maximum(c[k1], c[k2])
    t = np.clip((diff / S) * p["screen_gain"], 0, 1) if S > 0 else np.zeros_like(diff)
    m = _clip_matte(1 - t, p["clip_black"], p["clip_white"])
    sp = c[k] - lim
    c[k] = np.where(sp > 0, c[k] - sp * p["despill"], c[k])
    return _key_out(d, 1 - m if p.get("invert") == "on" else m, p["output"], c)


def _morph_rows(img, radii, shape, grow, chans):
    """Erode / dilate at each whole radius in ``radii`` (the extremes along the rows shared between them):
    the edge repeated, as the page's ``morph``."""
    h, w = img.shape[:2]
    pick = np.maximum if grow else np.minimum
    R = max(radii)
    s = img[..., chans]
    sp = np.concatenate([np.repeat(s[:, :1], R, axis=1), s, np.repeat(s[:, -1:], R, axis=1)], axis=1)
    H = [s]
    for k in range(1, R + 1):
        H.append(pick(H[k - 1], pick(sp[:, R - k:R - k + w], sp[:, R + k:R + k + w])))
    outs = []
    for r in radii:
        if r <= 0:
            outs.append(img)
            continue
        v = None
        for dy in range(-r, r + 1):
            hw = int(math.floor(math.sqrt(r * r - dy * dy) + 1e-9)) if shape == "disc" else r
            Hp = H[hw]
            if dy == 0:
                row = Hp
            elif dy < 0:
                row = np.concatenate([np.repeat(Hp[:1], -dy, axis=0), Hp[:h + dy]], axis=0) if -dy < h else np.repeat(Hp[:1], h, axis=0)
            else:
                row = np.concatenate([Hp[dy:], np.repeat(Hp[-1:], dy, axis=0)], axis=0) if dy < h else np.repeat(Hp[-1:], h, axis=0)
            v = row if v is None else pick(v, row, out=v if v is not row and v is not Hp else None)
        out = img.copy()
        out[..., chans] = v
        outs.append(out)
    return outs


def erode_image(img, p):
    size = p["size"]
    r = abs(size)
    lo = int(math.floor(r))
    fr = r - lo
    if r <= 0:
        return img
    chans = [3] if p["channels"] == "alpha" else [0, 1, 2, 3]
    grow = size > 0
    if fr <= 1e-9:
        return _morph_rows(img, [lo], p["shape"], grow, chans)[0]
    A, B = _morph_rows(img, [lo, lo + 1], p["shape"], grow, chans)
    a = A.astype(np.float64)
    return (a + (B.astype(np.float64) - a) * fr).astype(np.float32)


def laplacian_image(img, p):
    s = img.astype(np.float64)
    B = (blur_image(img, p["size"]) if p["size"] > 0 else img).astype(np.float64)
    h, w = img.shape[:2]
    if p["mode"] == "highpass":
        v = s[..., :3] - B[..., :3]
    else:
        xl, xr = np.clip(np.arange(w) - 1, 0, w - 1), np.clip(np.arange(w) + 1, 0, w - 1)
        yu, yd = np.clip(np.arange(h) - 1, 0, h - 1), np.clip(np.arange(h) + 1, 0, h - 1)
        b = B[..., :3]
        v = 4 * b - (b[:, xl] + b[:, xr] + b[yu] + b[yd])
    out = np.empty(s.shape)
    out[..., :3] = v * p["gain"] + p["offset"]
    out[..., 3] = s[..., 3]
    return out.astype(np.float32)


def _ch_of(d, ch):
    if ch == "luminance":
        return LUM[0] * d[..., 0] + LUM[1] * d[..., 1] + LUM[2] * d[..., 2]
    return d[..., _CH[ch]]


def _out_chans(out):
    return [0, 1, 2, 3] if out == "rgba" else [0, 1, 2] if out == "rgb" else [_CH[out]]


def _cm_op(op, A, B):
    if op == "union":
        return A + B - A * B
    if op == "plus":
        return A + B
    if op == "minus":
        return A - B
    if op == "from":
        return B - A
    if op in ("multiply", "in"):
        return A * B
    if op == "divide":
        return np.where(B != 0, A / np.where(B != 0, B, 1.0), 0.0)
    if op == "out":
        return A * (1 - B)
    if op == "stencil":
        return B * (1 - A)
    if op == "max":
        return np.maximum(A, B)
    if op == "min":
        return np.minimum(A, B)
    if op == "absminus":
        return np.abs(A - B)
    if op == "xor":
        return A + B - 2 * A * B
    return A


def channel_merge_image(b, a, p):
    bd = b.astype(np.float64)
    A = _ch_of(a.astype(np.float64), p["a_channel"]) if a is not None else np.zeros(bd.shape[:2])
    v = _cm_op(p["operation"], A, _ch_of(bd, p["b_channel"]))
    out = bd.copy()
    for c in _out_chans(p["output"]):
        out[..., c] = bd[..., c] + (v - bd[..., c]) * p["mix"]
    return out.astype(np.float32)


def channel_math_image(img, p):
    d = img.astype(np.float64)
    out = d.copy()
    v, op = p["value"], p["operation"]
    for c in _out_chans(p["channels"]):
        x = d[..., c]
        if op == "add":
            y = x + v
        elif op == "multiply":
            y = x * v
        elif op == "power":
            y = np.where(x > 0, np.power(np.where(x > 0, x, 1.0), v), x)
        elif op == "invert":
            y = v - x
        elif op == "clamp":
            y = np.where(x < 0, 0.0, np.where(x > v, v, x))
        elif op == "min":
            y = np.minimum(x, v)
        elif op == "max":
            y = np.maximum(x, v)
        elif op == "abs":
            y = np.abs(x)
        elif op == "threshold":
            y = np.where(x >= v, 1.0, 0.0)
        else:
            y = np.full_like(x, v)
        out[..., c] = x + (y - x) * p["mix"]
    return out.astype(np.float32)


def parse_shaper(s):
    parts = str(s or "lin:0:1").split(":")
    kind = "log2" if parts[0] == "log2" else "lin"
    try:
        lo, hi = float(parts[1]), float(parts[2])
    except (IndexError, ValueError):
        lo, hi = 0.0, 1.0
    return kind, lo, hi


def shaper_forward(shaper, x):
    kind, lo, hi = parse_shaper(shaper)
    x = np.asarray(x, dtype=np.float64)
    if kind == "log2":
        u = np.where(x > 0, (np.log2(np.where(x > 0, x, 1.0)) - lo) / (hi - lo), 0.0)
    else:
        u = (x - lo) / (hi - lo)
    return np.clip(u, 0, 1)


def shaper_inverse(shaper, u):
    kind, lo, hi = parse_shaper(shaper)
    u = np.asarray(u, dtype=np.float64)
    return np.power(2.0, lo + u * (hi - lo)) if kind == "log2" else lo + u * (hi - lo)


def apply_lut(rgb, lut):
    """The page's ``lutColor`` over [..., 3] straight colours: trilinear on the shaper's grid.
    ``lut`` = (size, shaper, float32 [size^3 * 3], blue fastest)."""
    N, shaper, L = lut
    if shaper == "matrix":   # a plain 3 x 3 and offset: exact
        m = [float(x) for x in np.asarray(L, dtype=np.float32)]
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        return np.stack([m[0] * r + m[1] * g + m[2] * b + m[9], m[3] * r + m[4] * g + m[5] * b + m[10],
                         m[6] * r + m[7] * g + m[8] * b + m[11]], axis=-1)
    L = np.asarray(L, dtype=np.float64).reshape(N, N, N, 3)
    idx = []
    for c in range(3):
        u = shaper_forward(shaper, rgb[..., c]) * (N - 1)
        i = np.clip(np.floor(u), 0, N - 2).astype(np.int64)
        idx.append((i, u - i))
    (ri, rf), (gi, gf), (bi, bf) = idx
    out = np.empty(rgb.shape[:-1] + (3,))
    for c in range(3):
        def v(i, j, k):
            return L[i, j, k, c]
        b00 = v(ri, gi, bi) + (v(ri, gi, bi + 1) - v(ri, gi, bi)) * bf
        b01 = v(ri, gi + 1, bi) + (v(ri, gi + 1, bi + 1) - v(ri, gi + 1, bi)) * bf
        b10 = v(ri + 1, gi, bi) + (v(ri + 1, gi, bi + 1) - v(ri + 1, gi, bi)) * bf
        b11 = v(ri + 1, gi + 1, bi) + (v(ri + 1, gi + 1, bi + 1) - v(ri + 1, gi + 1, bi)) * bf
        g0 = b00 + (b01 - b00) * gf
        g1 = b10 + (b11 - b10) * gf
        out[..., c] = g0 + (g1 - g0) * rf
    return out


def ocio_image(img, fn, unpremult=True):
    """The page's ``ocioImage``: ``fn`` over the straight colours (``unpremult``) or the numbers as they are."""
    d = img.astype(np.float64)
    a = d[..., 3]
    out = d.copy()
    if unpremult:
        ok = a > 0
        u = np.where(ok, a, 1.0)[..., None]
        c = np.asarray(fn(d[..., :3] / u), dtype=np.float64)
        out[..., :3] = np.where(ok[..., None], c * u, d[..., :3])
    else:
        out[..., :3] = np.asarray(fn(d[..., :3]), dtype=np.float64)
    return out.astype(np.float32)


def ocio_spec(t, p):
    if t == "ocio_display":
        return {"src": p.get("in_space") or "", "display": p.get("display") or "*", "view": p.get("view") or "*"}
    return {"src": p.get("in_space") or "", "dst": p.get("out_space") or ""}


# ── light: Glow and LensFlare (js/imageViewer_compLight.js) ─────────────────────

_M32 = 0xFFFFFFFF


def _round_js(x):
    return int(math.floor(float(x) + 0.5))


def mulberry32(seed):
    """A seeded generator of numbers in [0, 1): the page's ``mulberry32``, number for number."""
    state = [int(seed) & _M32]

    def imul(x, y):
        return (x * y) & _M32

    def nxt():
        a = (state[0] + 0x6D2B79F5) & _M32
        state[0] = a
        t = imul(a ^ (a >> 15), 1 | a)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & _M32) ^ t
        return ((t ^ (t >> 14)) & _M32) / 4294967296
    return nxt


def glow_image(img, p):
    s = img.astype(np.float64)
    tint = p.get("tint") or [1, 1, 1, 1]
    if p.get("source") == "max":
        L = np.maximum(np.maximum(s[..., 0], s[..., 1]), s[..., 2])
    else:
        L = LUM[0] * s[..., 0] + LUM[1] * s[..., 1] + LUM[2] * s[..., 2]
    soft, th = float(p["softness"]), float(p["threshold"])
    k = np.clip((L - th) / soft, 0, 1) if soft > 0 else np.where(L > th, 1.0, 0.0)
    hi = np.zeros(img.shape[:2] + (3,), np.float32)   # the page's alpha is 0 here: only rgb is blurred
    for c in range(3):
        hi[..., c] = s[..., c] * k * tint[c]
    steps = max(1, _round_js(p["steps"]))
    acc = np.zeros(hi.shape, np.float64)
    size = float(p["size"])
    for _ in range(steps):
        acc += blur_image(hi, size)
        size = size / 2
    g = float(p["intensity"]) / steps
    rgb = acc * g
    out = np.empty(img.shape, np.float32)
    if p.get("effect_only") == "on":
        out[..., :3] = rgb
        out[..., 3] = np.clip(LUM[0] * rgb[..., 0] + LUM[1] * rgb[..., 1] + LUM[2] * rgb[..., 2], 0, 1)
    else:
        out[..., :3] = s[..., :3] + rgb
        out[..., 3] = img[..., 3]
    return out


def flare_ghosts(p):
    rnd = mulberry32(_round_js(p["seed"]) * 7919 + 17)
    tint = p.get("color") or [1, 1, 1, 1]
    out = []
    for _ in range(_round_js(p["ghost_count"])):
        t = (rnd() * 1.6 - 0.3) * p["ghost_spread"]
        r = 0.3 + rnd() * 1.4
        c = [tint[0] * (0.5 + 0.5 * rnd()), tint[1] * (0.5 + 0.5 * rnd()), tint[2] * (0.5 + 0.5 * rnd())]
        k = 0.3 + 0.7 * rnd()
        out.append({"t": t, "r": r, "c": c, "k": k})
    return out


def dirt_spots(p):
    rnd = mulberry32(_round_js(p["seed"]) * 104729 + 3)
    out = []
    for _ in range(_round_js(p["dirt_spots"])):
        x = rnd()
        y = rnd()
        r = 0.002 + rnd() * 0.018
        k = 0.2 + 0.8 * rnd()
        out.append({"x": x, "y": y, "r": r, "k": k})
    return out


def _poly_edge(n, rot, a):
    seg = (2 * math.pi) / n
    x = np.fmod(a - rot + math.pi / 2, seg)
    x = np.where(x < 0, x + seg, x)
    return math.cos(math.pi / n) / np.cos(x - math.pi / n)


def flare_image(src, dirt, p, W, H, scale):
    D = math.hypot(W, H) * p["size"]
    pos = p.get("position") or [W / scale / 2, H / scale / 2]
    lx, ly, cx, cy = pos[0] * scale, pos[1] * scale, W / 2, H / 2
    tint = p.get("color") or [1, 1, 1, 1]
    I = p["intensity"]
    X = np.arange(W, dtype=np.float64)[None, :] + 0.5
    Y = np.arange(H, dtype=np.float64)[:, None] + 0.5
    dx = np.broadcast_to(X - lx, (H, W))
    dy = np.broadcast_to(Y - ly, (H, W))
    r2 = dx * dx + dy * dy
    r = np.sqrt(r2)
    core = np.zeros((H, W), np.float64)
    if p["glow_amount"] > 0:
        Rg = p["glow_size"] * D
        Rg2 = Rg * Rg
        g = Rg2 / (Rg2 + r2)
        core = core + p["glow_amount"] * g * g
    if p["streak_amount"] > 0:
        nS = _round_js(p["streak_count"])
        Ls = p["streak_length"] * D
        Ws = max(1e-3, p["streak_width"] * scale)
        for i in range(nS):
            a = ((p["streak_angle"] + (360 * i) / max(1, nS)) * math.pi) / 180
            ux, uy = math.cos(a), math.sin(a)
            along = dx * ux + dy * uy
            perp = (-dx * uy + dy * ux) / Ws
            fo = 1 - along / Ls if Ls != 0 else np.zeros_like(along)
            add = p["streak_amount"] * np.exp(-(perp * perp)) * fo * fo
            core = core + np.where((along > 0) & (along < Ls), add, 0.0)
    c = [core * tint[0], core * tint[1], core * tint[2]]
    if p["halo_amount"] > 0:
        Rh = p["halo_radius"] * D
        Wh = max(1e-3, p["halo_width"] * D)
        for k in range(3):
            e = (r - Rh * (1 + (k - 1) * 0.03)) / Wh
            c[k] = c[k] + p["halo_amount"] * tint[k] * np.exp(-(e * e))
    if p["ghost_amount"] > 0:
        poly = p.get("ghost_shape") == "polygon"
        nB = max(3, _round_js(p["blades"]))
        rot = (p["ghost_rotation"] * math.pi) / 180
        soft = min(1.0, max(0.0, float(p["ghost_softness"])))
        for g in flare_ghosts(p):
            gx = lx + g["t"] * 2 * (cx - lx)
            gy = ly + g["t"] * 2 * (cy - ly)
            R = max(1e-3, g["r"] * p["ghost_size"] * D)
            x0, x1 = max(0, int(math.floor(gx - 1.5 * R)) - 1), min(W, int(math.ceil(gx + 1.5 * R)) + 1)
            y0, y1 = max(0, int(math.floor(gy - 1.5 * R)) - 1), min(H, int(math.ceil(gy + 1.5 * R)) + 1)
            if x0 >= x1 or y0 >= y1:
                continue
            qx = np.broadcast_to(X[:, x0:x1] - gx, (y1 - y0, x1 - x0))
            qy = np.broadcast_to(Y[y0:y1, :] - gy, (y1 - y0, x1 - x0))
            rho = np.sqrt(qx * qx + qy * qy) / R
            inside = rho < 1.5
            if poly:
                rho = np.where(inside, rho / _poly_edge(nB, rot, np.arctan2(qy, qx)), rho)
            cover = (1 - _smooth(1 - soft, 1, rho)) * (0.7 + 0.3 * np.where(rho < 1, rho, 1.0))
            w = np.where(inside & (cover > 0), p["ghost_amount"] * g["k"] * cover, 0.0)
            for k in range(3):
                c[k][y0:y1, x0:x1] = c[k][y0:y1, x0:x1] + w * g["c"][k]
    if p["dirt_amount"] > 0:
        if dirt is not None:
            d = dirt.astype(np.float64)
            dm = LUM[0] * d[..., 0] + LUM[1] * d[..., 1] + LUM[2] * d[..., 2]
        else:
            dm = np.zeros((H, W), np.float64)
            diag = math.hypot(W, H)
            for sp in dirt_spots(p):
                sx, sy, rr = sp["x"] * W, sp["y"] * H, sp["r"] * diag
                x0, x1 = max(0, int(math.floor(sx - rr))), min(W - 1, int(math.ceil(sx + rr)))
                y0, y1 = max(0, int(math.floor(sy - rr))), min(H - 1, int(math.ceil(sy + rr)))
                if x0 > x1 or y0 > y1:
                    continue
                e = np.hypot(X[:, x0:x1 + 1] - sx, Y[y0:y1 + 1, :] - sy) / rr
                dm[y0:y1 + 1, x0:x1 + 1] += sp["k"] * (1 - _smooth(0.3, 1, e))
        Rd = p["dirt_reach"] * D
        Rd2 = Rd * Rd
        lit = p["dirt_amount"] * dm * (Rd2 / (Rd2 + r2))
        for k in range(3):
            c[k] = c[k] + lit * tint[k]
    out = np.empty((H, W, 4), np.float32)
    f = [c[0] * I, c[1] * I, c[2] * I]
    if src is not None:
        s = src.astype(np.float64)
        for k in range(3):
            out[..., k] = s[..., k] + f[k]
        out[..., 3] = src[..., 3]
    else:
        for k in range(3):
            out[..., k] = f[k]
        out[..., 3] = np.clip(LUM[0] * f[0] + LUM[1] * f[1] + LUM[2] * f[2], 0, 1)
    return out


def mix_images(a, b, t):
    x = a.astype(np.float64)
    return (x + (b.astype(np.float64) - x) * t).astype(np.float32)


def retime_frame(node, f):
    start = node.get("start") or 0
    speed = node.get("speed")
    speed = 1 if speed is None else speed
    return start + (f - start) * speed + (node.get("offset") or 0)


# ── channels (js/imageViewer_compChannels.js) ──────────────────────────────
# Beside its rgba a picture carries named extra channels ("mask.a", "depth.z": "<layer>.<channel>"), each an
# [H, W] float32; render_node keeps them per node and frame. The page's rules, name for name.

RGBA = ["r", "g", "b", "a"]
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def is_channel(s):
    if s in _CH:
        return True
    if not isinstance(s, str) or "." not in s:
        return False
    i = s.index(".")
    return i > 0 and bool(_NAME.match(s[:i])) and bool(_NAME.match(s[i + 1:])) and s[:i] != "rgba"


def is_layer(s):
    return s == "rgba" or (isinstance(s, str) and bool(_NAME.match(s)) and s not in _CH and s != "rgb")


def layer_of(name):
    return "rgba" if name in _CH else name[:name.index(".")]


def layer_channels(layer):
    return list(RGBA) if layer == "rgba" else [f"{layer}.{c}" for c in RGBA]


def is_target(t):
    return is_channel(t) or is_layer(t)


def parse_channels(text):
    out = []
    for t in re.split(r"[\s,;]+", str(text or "")):
        if t and (is_channel(t) or is_layer(t) or t == "rgb") and t not in out:
            out.append(t)
    return out


def expand_channels(tokens, have, create=False):
    out = []

    def put(c):
        if c not in out:
            out.append(c)
    for t in tokens:
        if t == "rgba":
            for c in RGBA:
                put(c)
        elif t == "rgb":
            for c in "rgb":
                put(c)
        elif is_channel(t):
            put(t)
        elif is_layer(t):
            mine = [n for n in have if layer_of(n) == t]
            for c in (mine if mine or not create else layer_channels(t)):
                put(c)
    return out


def channel_of(img, ex, name):
    if name in _CH:
        return img[..., _CH[name]].copy()
    return (ex or {}).get(name)


class _State:
    def __init__(self, img, ex):
        self.img, self.own, self.ex = img, False, dict(ex or {})

    def put(self, name, v):
        h, w = self.img.shape[:2]
        if name in _CH:
            if not self.own:
                self.img = self.img.copy()
                self.own = True
            self.img[..., _CH[name]] = v
        else:
            a = np.empty((h, w), np.float32)
            a[...] = v
            self.ex[name] = a


def add_channels(img, ex, tokens, value):
    s = _State(img, ex)
    for c in expand_channels(tokens, list(s.ex), True):
        if c not in _CH and c not in s.ex:
            s.put(c, value)
    return s.img, s.ex


def remove_channels(img, ex, tokens, keep):
    s = _State(img, ex)
    named = expand_channels(tokens, list(s.ex), False)
    gone = [c for c in RGBA + list(s.ex) if c not in named] if keep else named
    for c in gone:
        if c in _CH:
            s.put(c, 0)
        else:
            s.ex.pop(c, None)
    return s.img, s.ex


def shuffle_channels(img, ex, out, picks):
    s = _State(img, ex)
    read = []
    for p in picks:
        if p == "-":
            read.append(None)
        elif p in ("0", "1"):
            read.append(float(p))
        else:
            v = channel_of(img, ex, p)
            read.append(0.0 if v is None else v)
    for k, c in enumerate(layer_channels(out if is_layer(out) else "rgba")):
        if read[k] is not None:
            s.put(c, read[k])
    return s.img, s.ex


def write_target(base, bex, P, target):
    if not is_target(target) or target == "rgba":
        return P, dict(bex or {})
    s = _State(base, bex)
    if is_layer(target):
        for k, c in enumerate(layer_channels(target)):
            s.put(c, P[..., k])
    else:
        letter = target if target in _CH else target[target.index(".") + 1:]
        s.put(target, P[..., _CH[letter] if letter in _CH else 3])
    return s.img, s.ex


def map_extras(ex, fn):
    names = list(ex or {})
    out = {}
    for g in range(0, len(names), 4):
        grp = names[g:g + 4]
        h, w = ex[grp[0]].shape
        pic = np.zeros((h, w, 4), np.float32)
        for k, nm in enumerate(grp):
            pic[..., k] = ex[nm]
        r = fn(pic)
        for k, nm in enumerate(grp):
            out[nm] = np.ascontiguousarray(r[..., k], np.float32)
    return out


def union_extras(bex, aex):
    out = dict(bex or {})
    for k, v in (aex or {}).items():
        if k not in out:
            out[k] = v
    return out


def mix_extras(ax, bx, t, shape):
    out = {}
    zero = np.zeros(shape, np.float32)
    names = list(ax or {}) + [k for k in (bx or {}) if k not in (ax or {})]
    for k in names:
        x = (ax or {}).get(k, zero).astype(np.float64)
        y = (bx or {}).get(k, zero).astype(np.float64)
        out[k] = (x + (y - x) * t).astype(np.float32)
    return out


def roto_write(m, src, sex, target, premult):
    h, w = m.shape
    P = np.repeat(m[..., None], 4, axis=2).astype(np.float32)
    ex = dict(sex or {})
    if not is_target(target) or target == "rgba":
        if src is None:
            return P, ex
        if premult:
            return (src.astype(np.float64) * m[..., None]).astype(np.float32), ex
        out = src.copy()
        out[..., 3] = m
        return out, ex
    base = src if src is not None else blank(w, h)
    if src is not None and premult:
        base = src.copy()
        base[..., :3] = (src[..., :3].astype(np.float64) * m[..., None]).astype(np.float32)
    return write_target(base, ex, P, target)


WRITES = {t for t, d in NODE_TYPES.items() if "write" in d["params"]}
_TWO_IN = {"merge", "copy", "channelmerge"}

# Nodes with a mask input (the last) and a mix on top of what they do (the page's MASKABLE / maskMix).
MASKABLE = ["grade", "colorcorrect", "ocio_colorspace", "ocio_display", "glow", "lensflare", "blur",
            "shuffle", "copy", "erode", "laplacian", "channelmerge", "channelmath", "premult", "unpremult", "lumakeyer",
            "chromakeyer", "keyer", "motionblur", "depthblur", "defocus"]
OWN_MIX = {t for t in MASKABLE if "mix" in NODE_TYPES[t]["params"]}
for _mt in MASKABLE:
    _md = NODE_TYPES[_mt]
    _md["inputs"] = list(_md["inputs"]) + ["mask"]
    if "mix" not in _md["params"]:
        _md["params"]["mix"] = {"kind": "num", "def": 1, "min": 0, "max": 1, "key": True}
    _md["params"]["mask_channel"] = {"kind": "chan", "def": "a"}
    _md["params"]["mask_invert"] = {"kind": "enum", "def": "off", "choices": ["off", "on"]}
MASKABLE = set(MASKABLE)


def mask_index(t):
    return len(NODE_TYPES[t]["inputs"]) - 1 if t in MASKABLE else -1


def mask_mix(src, sex, img, ex, m, mix, invert):
    """src + (img - src) x mix x m for the picture and every extra channel (the page's ``maskMix``)."""
    h, w = img.shape[:2]
    if m is None:
        t = np.full((h, w), float(mix), np.float64)
    else:
        mm = m.astype(np.float64)
        t = mix * ((1 - mm) if invert else mm)
    S = src.astype(np.float64)
    out = (S + (img.astype(np.float64) - S) * t[..., None]).astype(np.float32)
    oex = {}
    names = list(dict.fromkeys(list((sex or {}).keys()) + list((ex or {}).keys())))
    for k in names:
        a = (sex or {}).get(k)
        b = (ex or {}).get(k)
        a = a.astype(np.float64) if a is not None else np.zeros((h, w), np.float64)
        b = b.astype(np.float64) if b is not None else np.zeros((h, w), np.float64)
        oex[k] = (a + (b - a) * t).astype(np.float32)
    return out, oex


def render_node(comp, nid, frame, source=None, scale=1.0, memo=None, ocio=None, channels=False):
    """The picture node ``nid`` makes at ``frame``; ``source(node, frame)`` gives a Read's pixels (a picture at
    their own size) or None. The page's ``renderNode``: nodes that look at other times render their input
    at those frames."""
    fmt = comp["format"]
    W = max(1, int(math.floor(fmt["width"] * scale + 0.5)))
    H = max(1, int(math.floor(fmt["height"] * scale + 0.5)))
    memo = {} if memo is None else memo

    def ex_of(i, f):
        return memo.get(("x", i, f)) or {} if i else {}

    def run(i, f, depth):
        if not i or depth > 256:
            return blank(W, H)
        if (i, f) in memo:
            return memo[(i, f)]
        n = node_by_id(comp, i)
        img = make(n, f, depth + 1)
        if isinstance(img, tuple):
            img, ex = img
        elif not n or n.get("type") not in NODE_TYPES or not NODE_TYPES[n["type"]]["inputs"] or not (n.get("inputs") or [None])[0]:
            ex = {}
        else:
            ex = ex_of(n["inputs"][0], f)
            if not n.get("disable") and n["type"] in _TWO_IN and len(n["inputs"]) > 1 and n["inputs"][1]:
                ex = union_extras(ex, _conform_extras(ex_of(n["inputs"][1], f), img.shape[1], img.shape[0]))
        if n and not n.get("disable") and n.get("type") in WRITES and n["type"] != "roto":
            w = n.get("write") or "rgba"
            if w != "rgba":
                i0 = (n.get("inputs") or [None])[0]
                base = run(i0, f, depth + 1) if i0 else blank(W, H)
                img, ex = write_target(base, ex_of(i0, f), conform(img, base.shape[1], base.shape[0]), w)
        if n and not n.get("disable") and n.get("type") in MASKABLE:
            img, ex = mask_stage(n, f, depth, img, ex)
        memo[(i, f)] = img
        memo[("x", i, f)] = ex
        return img

    def mask_stage(n, f, depth, img, ex):
        mix = 1 if n["type"] in OWN_MIX else param_at(n, "mix", f)
        ins = n.get("inputs") or []
        k = mask_index(n["type"])
        mi = ins[k] if len(ins) > k else None
        if not mi and mix == 1:
            return img, ex
        h, w = img.shape[:2]
        i0 = ins[0] if ins else None
        s0 = run(i0, f, depth + 1) if i0 else blank(w, h)
        src = conform(s0, w, h)
        sex = _conform_extras(ex_of(i0, f), w, h) if i0 else {}
        m = None
        if mi:
            mp = run(mi, f, depth + 1)
            plane = channel_of(mp, ex_of(mi, f), n.get("mask_channel") or "a")
            m = conform(plane, w, h) if plane is not None else np.zeros((h, w), np.float32)
        return mask_mix(src, sex, img, ex, m, mix, (n.get("mask_invert") or "off") == "on")

    def spatial(i0, f, d1, fn):
        src = run(i0, f, d1)
        return fn(src), map_extras(ex_of(i0, f), fn)

    def P(n, f, names):
        return {k: param_at(n, k, f) for k in names}

    def vectors_of(src, f, d1, n):
        return vectors_image(run(src, f - 1, d1), run(src, f, d1), run(src, f + 1, d1),
                             {"smoothness": param_at(n, "smoothness", f), "iterations": int(param_at(n, "iterations", f)),
                              "levels": int(param_at(n, "levels", f)), "detail": param_at(n, "detail", f)}, scale)

    def in_fmt(n, k=0):
        ins = n.get("inputs") or []
        return format_at(comp, ins[k] if len(ins) > k else None)

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
            if not merge_live(n, f):
                return run(ins[0], f, d1)
            Bi = run(ins[0], f, d1)
            Ai = conform(run(ins[1], f, d1), Bi.shape[1], Bi.shape[0])
            Mi = conform(run(ins[2], f, d1), Bi.shape[1], Bi.shape[0]) if ins[2] else None
            return merge_images(Bi, Ai, Mi, n.get("operation") or "over", param_at(n, "mix", f))
        if t == "transform":
            m = transform_matrix(n, f, in_fmt(n), scale)
            return spatial(ins[0], f, d1, lambda p: resample(p, m, p.shape[1], p.shape[0]))
        if t in ("lumakeyer", "chromakeyer", "erode", "laplacian", "channelmath"):
            p = P(n, f, NODE_TYPES[t]["params"])
            src = run(ins[0], f, d1)
            if t == "lumakeyer":
                return luma_key_image(src, p)
            if t == "chromakeyer":
                return chroma_key_image(src, p)
            if t == "erode":
                p["size"] = p["size"] * scale
                return erode_image(src, p)
            if t == "laplacian":
                p["size"] = p["size"] * scale
                return laplacian_image(src, p)
            return channel_math_image(src, p)
        if t == "channelmerge":
            Bi = run(ins[0], f, d1)
            return channel_merge_image(Bi, conform(run(ins[1], f, d1), Bi.shape[1], Bi.shape[0]) if ins[1] else None,
                                       P(n, f, NODE_TYPES["channelmerge"]["params"]))
        if t in ("ocio_colorspace", "ocio_display"):
            p = P(n, f, NODE_TYPES[t]["params"])
            src = run(ins[0], f, d1)
            fn = ocio(ocio_spec(t, p)) if ocio else None
            return ocio_image(src, fn, p.get("unpremult") != "off") if fn else src
        if t == "glow":
            p = P(n, f, NODE_TYPES["glow"]["params"])
            p["size"] = p["size"] * scale
            return glow_image(run(ins[0], f, d1), p)
        if t == "lensflare":
            p = P(n, f, NODE_TYPES["lensflare"]["params"])
            src = run(ins[0], f, d1) if ins and ins[0] else None
            w, h = (src.shape[1], src.shape[0]) if src is not None else (W, H)
            dirt = conform(run(ins[1], f, d1), w, h) if len(ins) > 1 and ins[1] else None
            return flare_image(src, dirt, p, w, h, scale)
        if t == "colorcorrect":
            return color_correct_image(run(ins[0], f, d1), P(n, f, NODE_TYPES["colorcorrect"]["params"]))
        if t == "grade":
            return grade_image(run(ins[0], f, d1), P(n, f, NODE_TYPES["grade"]["params"]))
        if t == "blur":
            sz = param_at(n, "size", f) * scale
            return spatial(ins[0], f, d1, lambda p: blur_image(p, sz))
        if t == "reformat":
            m, rw, rh = reformat_layout(n, f, in_fmt(n), scale)
            return spatial(ins[0], f, d1, lambda p: resample(p, m, rw, rh))
        if t == "crop":
            tl = param_at(n, "topleft", f) or [0, 0]
            F = in_fmt(n)
            br = param_at(n, "bottomright", f) or [F["width"], F["height"]]
            soft = param_at(n, "softness", f) * scale
            return spatial(ins[0], f, d1, lambda p: crop_image(p, tl[0] * scale, tl[1] * scale, br[0] * scale, br[1] * scale, soft))
        if t == "shuffle":
            src = run(ins[0], f, d1)
            return shuffle_channels(src, ex_of(ins[0], f), n.get("out") or "rgba", [n.get(k) or k for k in "rgba"])
        if t == "addchannels":
            src = run(ins[0], f, d1)
            text = n.get("channels") if n.get("channels") is not None else NODE_TYPES["addchannels"]["params"]["channels"]["def"]
            return add_channels(src, ex_of(ins[0], f), parse_channels(text), param_at(n, "value", f) or 0)
        if t == "removechannels":
            src = run(ins[0], f, d1)
            return remove_channels(src, ex_of(ins[0], f), parse_channels(n.get("channels")), n.get("operation") == "keep")
        if t == "copy":
            pick = [n.get(k) or NODE_TYPES["copy"]["params"][k]["def"] for k in "rgba"]
            Bi = run(ins[0], f, d1)
            return copy_image(Bi, conform(run(ins[1], f, d1), Bi.shape[1], Bi.shape[0]), pick)
        if t == "premult":
            return premult_image(run(ins[0], f, d1))
        if t == "unpremult":
            return unpremult_image(run(ins[0], f, d1))
        if t == "retime":
            tf = retime_frame(n, f)
            s0 = ins[0]

            def at(g):
                return run(s0, g, d1), ex_of(s0, g)
            if n.get("blend") != "mix":
                return at(int(math.floor(tf + 0.5)))
            f0 = int(math.floor(tf))
            fr = tf - f0
            if fr < 1e-9:
                return at(f0)
            a, b = run(s0, f0, d1), run(s0, f0 + 1, d1)
            return mix_images(a, b, fr), mix_extras(ex_of(s0, f0), ex_of(s0, f0 + 1), fr, a.shape[:2])
        if t == "keyer":
            return key_image(run(ins[0], f, d1), P(n, f, NODE_TYPES["keyer"]["params"]))
        if t == "roto":
            src = run(ins[0], f, d1) if ins[0] else None
            m = roto_matte(n.get("roto"), f, W, H)
            if src is not None:
                m = conform(m, src.shape[1], src.shape[0])
            return roto_write(m, src, ex_of(ins[0], f), n.get("write") or "rgba", n.get("premult") != "off")
        if t == "vectors":
            return vectors_of(ins[0], f, d1, n)
        if t == "motionblur":
            src = run(ins[0], f, d1)
            vec = run(ins[1], f, d1) if ins[1] else vectors_of(ins[0], f, d1, {"type": "vectors"})
            return motion_blur_image(src, conform(vec, src.shape[1], src.shape[0]), param_at(n, "shutter", f), param_at(n, "samples", f), n.get("offset") or "centred", scale)
        if t == "defocus":
            p = P(n, f, NODE_TYPES["defocus"]["params"])
            p["size"] = p["size"] * scale
            return defocus_image(run(ins[0], f, d1), p)
        if t == "depthblur":
            src = run(ins[0], f, d1)
            if not ins[1]:
                return src
            p = P(n, f, NODE_TYPES["depthblur"]["params"])
            p["size"] = p["size"] * scale
            return depth_blur_image(src, conform(run(ins[1], f, d1), src.shape[1], src.shape[0]), p)
        if t == "output":
            return run(ins[0], f, d1)
        return blank(W, H)
    img = run(nid, frame, 0)
    return (img, ex_of(nid, frame)) if channels else img


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
