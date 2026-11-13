"""A comp as a Nuke script (``.nk``): Export to Nuke… in the Comp space.

Written clean room from the published, plain-text shape of a Nuke script (a stack of ``Class { knob value ... }``
blocks, ``push`` / ``set`` naming the inputs) and the documented knobs of Nuke's stock nodes; no Foundry code or
files. "Nuke" is a trademark of The Foundry, named here only to say what the file is for.

The graph is written node for node where Nuke has a stock node that does the same arithmetic (Read, Constant,
Merge2, Transform, Reformat, Crop, Grade, Blur, Shuffle, Copy, Premult, Unpremult, TimeWarp, Expression,
ChannelMerge, OCIOColorSpace, OCIODisplay, FilterErode, Write). The others - and any node whose settings Nuke
cannot express - are BAKED: the node's own picture is rendered here, frame by frame, into an EXR sequence beside
the script, and the script reads that (``plan["bake"]``). What is close but not the same arithmetic is listed in
``plan["notes"]`` and in the README written beside the script.

Animated values are written as a key on every frame of the comp (``{{curve x0 v0 v1 ...}}``), so Nuke shows on
each frame what the comp does, whatever the interpolation.

Coordinates: the comp's y runs down from the top, Nuke's up from the bottom; positions, centres, boxes and
rotations are turned over on the way (``_y``). Frames keep their numbers (the root runs from 0 to frames - 1).
"""
from __future__ import annotations

import os
import re
import struct

import numpy as np

from . import comp_model as M

NATIVE = {"read", "constant", "merge", "transform", "reformat", "crop", "grade", "blur", "shuffle", "copy", "premult",
          "unpremult", "retime", "channelmath", "channelmerge", "ocio_colorspace", "ocio_display", "erode", "output",
          "write", "metadata"}
NUKE_VERSION = "13.0 v1"
_CH = {"r": "red", "g": "green", "b": "blue", "a": "alpha"}
_SHUF = {"r": "red", "g": "green", "b": "blue", "a": "alpha", "0": "black", "1": "white"}


# ── values ───────────────────────────────────────────────────────────────────

def _num(v):
    v = float(v)
    if v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return f"{v:.8g}"


def _str(s):
    """A knob's text, quoted for the script (TCL: backslash, quote, brackets and dollar escaped)."""
    s = str(s).replace("\\", "/")
    if s and re.fullmatch(r"[A-Za-z0-9_./:+-]+", s):
        return s
    return '"' + re.sub(r'([\\"\[\]$])', r"\\\1", s) + '"'


def _name(text, used):
    n = re.sub(r"\W", "_", str(text or "node")) or "node"
    if not n[0].isalpha():
        n = "n" + n
    base, k = n, 2
    while n in used:
        n = f"{base}_{k}"
        k += 1
    used.add(n)
    return n


class _Anim:
    """The values of a node's parameters on every frame of the comp, written as constants or per-frame curves."""

    def __init__(self, comp):
        self.frames = list(range(int(comp["format"]["frames"])))
        self.comp = comp

    def animated(self, node, p):
        tr = node.get("tracks") if isinstance(node.get("tracks"), dict) else {}
        ex = node.get("expr") if isinstance(node.get("expr"), dict) else {}
        return bool(isinstance(tr.get(p), list) and tr.get(p)) or bool(ex.get(p))   # an expression: a curve, frame by frame

    def series(self, node, p, fn=lambda v: v):
        return [fn(M.param_at(node, p, f)) for f in self.frames]

    def knob(self, node, p, fn=lambda v: v, comps=1):
        """A knob value: ``fn(value)`` (a number, or a list of ``comps`` numbers) - a curve per component when animated."""
        if not self.animated(node, p) or len(self.frames) < 2:
            return _value(fn(M.param_at(node, p, 0)))
        vals = self.series(node, p, fn)
        if comps == 1:
            return "{{curve x0 " + " ".join(_num(v) for v in vals) + "}}"
        return "{" + " ".join("{curve x0 " + " ".join(_num(v[c]) for v in vals) + "}" for c in range(comps)) + "}"


def _value(v):
    if isinstance(v, (list, tuple)):
        return "{" + " ".join(_num(x) for x in v) + "}"
    if isinstance(v, (int, float)):
        return _num(v)
    return _str(v)


# ── the graph ────────────────────────────────────────────────────────────────

class _Out:
    """The Nuke nodes written so far, in order: [{cls, name, knobs: [(k, text)], inputs: [name | None], pos}]."""

    def __init__(self):
        self.nodes = []
        self.used = set()

    def add(self, cls, base, knobs, inputs, pos, label=None):
        name = _name(base, self.used)
        ks = list(knobs)
        if label:
            ks.append(("label", _str(label)))
        self.nodes.append({"cls": cls, "name": name, "knobs": ks, "inputs": list(inputs), "pos": pos})
        return name


def _reachable(comp):
    seen = set()

    def walk(i):
        if not i or i in seen:
            return
        seen.add(i)
        n = M.node_by_id(comp, i)
        for s in (n or {}).get("inputs") or []:
            walk(s)
    walk(comp.get("output"))
    return seen


def _bakeable(n):
    """Why node ``n`` cannot be written as Nuke nodes (it is baked then), or None."""
    t = n.get("type")
    if t not in NATIVE:
        return f"{t}: no stock Nuke node does the same"
    if t in M.MASKABLE:
        ins = n.get("inputs") or []
        k = M.mask_index(t)
        if len(ins) > k and ins[k]:
            return f"{t}: its mask is not written into the Nuke script (the node is baked)"
        if t not in M.OWN_MIX and ((n.get("tracks") or {}).get("mix") or (n.get("mix") is not None and n.get("mix") != 1)):
            return f"{t}: its mix is not written into the Nuke script (the node is baked)"
    if t == "shuffle" and ((n.get("out") or "rgba") != "rgba" or any((n.get(k) or k) not in _SHUF for k in "rgba")):
        return "shuffle: extra channels are not written into the Nuke script (its rgba is baked)"
    if t == "constant" and (n.get("write") or "rgba") != "rgba":
        return "constant: writing into a channel is not written into the Nuke script (its rgba is baked)"
    if t == "channelmerge":
        if "luminance" in (n.get("a_channel"), n.get("b_channel")) or n.get("output") in ("rgb", "rgba"):
            return "channelmerge: Nuke's ChannelMerge takes one channel of each and writes one (no luminance)"
    return None


NOT_PICTURES = {"camera3d", "card3d", "geo3d", "scene3d", "project3d", "pointcloud",
                "deepread", "deepfromimage", "deepmerge", "deepholdout", "deepcrop"}


def build(comp, *, info_of=None, nk_path="", bake_dir="", bake=True, comp_path=""):
    """``(text, plan)``: the script, and ``{bake: [{id, name, dir, pattern}], notes: [...], native: [...]}``.

    ``info_of(node) -> (absolute path, source_info)`` says what a Read's file is (frames, kind); ``bake_dir`` is where
    baked nodes' frames will lie (``<bake_dir>/<name>/<name>.####.exr``)."""
    comp, _ = M.normalize(comp)
    comp = M.G.flatten(comp)   # groups and Dots laid out flat, backdrops and notes left out
    fmt = comp["format"]
    W, H, F = int(fmt["width"]), int(fmt["height"]), int(fmt["frames"])
    A = _Anim(comp)
    out = _Out()
    plan = {"bake": [], "notes": [], "native": [], "placeholder": [], "skipped": []}
    head = {}            # comp node id -> the Nuke node that is its picture
    reach = _reachable(comp)
    notes = set()

    def note(s):
        if s not in notes:
            notes.add(s)
            plan["notes"].append(s)

    y_ = lambda y: H - y   # noqa: E731 - comp y (down) to Nuke y (up)

    def write(nid):
        if not nid:
            return None
        if nid in head:
            return head[nid]
        n = M.node_by_id(comp, nid)
        if not n:
            return None
        head[nid] = None                   # a loop guard; normalize drops loops anyway
        t = n["type"]
        ins = n.get("inputs") or []
        pos = (int(n.get("x") or 0), int(n.get("y") or 0))
        label = n.get("name") or n["id"]
        why = _bakeable(n)
        if why and not n.get("disable"):
            if bake and nid in reach:
                name = _name(label, out.used)
                out.used.discard(name)
                d = os.path.join(bake_dir, name)
                pattern = os.path.join(d, f"{name}.####.exr")
                plan["bake"].append({"id": nid, "name": name, "dir": d, "pattern": pattern, "type": t})
                head[nid] = out.add("Read", name, [
                    ("inputs", "0"), ("file", _str(pattern)), ("first", "0"), ("last", str(F - 1)),
                    ("origfirst", "0"), ("origlast", str(F - 1)), ("origset", "true"), ("colorspace", "linear"),
                    ("raw", "true")], [], pos, label=f"{t} (baked)")
                return head[nid]
            src = write(ins[0]) if ins else None
            plan["placeholder"].append(nid)
            head[nid] = out.add("NoOp", label, [("inputs", "1" if ins else "0")], [src] if ins else [], pos,
                                label=f"{t}: not in Nuke ({'off' if n.get('disable') else 'not baked'})")
            return head[nid]
        if n.get("disable") and t not in NATIVE:
            src = write(ins[0]) if ins else None
            head[nid] = out.add("NoOp", label, [("inputs", "1" if ins else "0"), ("disable", "true")], [src] if ins else [],
                                pos, label=f"{t} (off)")
            return head[nid]
        plan["native"].append(nid)
        head[nid] = _native(n, t, ins, pos, label, write, out, A, W, H, F, y_, note, info_of, nk_path, comp_path)
        return head[nid]

    for n in comp["nodes"]:
        # A camera, a piece of 3D or a deep picture is not a picture of its own: it is written (baked as the
        # picture the comp makes of it) only when a node in the script reads it, not for the nodes that use it.
        if n["type"] in NOT_PICTURES and n["id"] != comp.get("output"):
            continue
        write(n["id"])
    plan["skipped"] = [n["id"] for n in comp["nodes"] if n["id"] not in head]

    lines = ["#! nuke -nx", f"version {NUKE_VERSION}", "Root {", " inputs 0",
             f" name {_str(nk_path.replace(os.sep, '/')) if nk_path else 'comp.nk'}",
             " frame 0", " first_frame 0", f" last_frame {max(0, F - 1)}", " lock_range true",
             f" fps {_num(fmt['fps'])}", f' format "{W} {H} 0 0 {W} {H} 1 comp_{W}x{H}"', "}"]
    for k, nd in enumerate(out.nodes):
        for i in reversed(nd["inputs"]):
            lines.append(f"push ${_var(i)}" if i else "push 0")
        lines.append(nd["cls"] + " {")
        for key, val in nd["knobs"]:
            lines.append(f" {key} {val}")
        lines.append(f" name {nd['name']}")
        lines.append(f" xpos {nd['pos'][0]}")
        lines.append(f" ypos {nd['pos'][1]}")
        lines.append("}")
        lines.append(f"set {_var(nd['name'])} [stack 0]")
    return "\n".join(lines) + "\n", plan


def _var(name):
    return "N_" + name


def _native(n, t, ins, pos, label, write, out, A, W, H, F, y_, note, info_of, nk_path, comp_path=""):
    """Write node ``n`` as stock Nuke nodes; returns the last one's name (the node's picture)."""
    P = lambda p: M.param_at(n, p, 0)  # noqa: E731
    dis = [("disable", "true")] if n.get("disable") else []
    src = lambda k=0: write(ins[k]) if len(ins) > k and ins[k] else None  # noqa: E731
    x, y = pos
    if t == "read":
        path, info = info_of(n) if info_of else (n.get("file") or "", {"kind": "missing"})
        kind = info.get("kind")
        cs = n.get("colorspace") or "auto"
        if cs == "auto":
            cs = "linear" if os.path.splitext(path)[1].lower() in (".exr", ".hdr") else "sRGB"
        elif cs == "srgb":
            cs = "sRGB"
        knobs = [("inputs", "0"), ("file", _str(path))]
        if kind == "sequence":
            f0, f1 = int(info.get("first") or 0), int(info.get("last") or 0)
            knobs += [("first", str(f0)), ("last", str(f1)), ("origfirst", str(f0)), ("origlast", str(f1)), ("origset", "true"),
                      ("frame_mode", '"start at"'), ("frame", str(int(n.get("offset") or 0)))]
        elif kind == "video":
            nf = int(info.get("last") or 0) - int(info.get("first") or 0) + 1
            knobs += [("first", "1"), ("last", str(max(1, nf))), ("origfirst", "1"), ("origlast", str(max(1, nf))),
                      ("origset", "true"), ("frame_mode", '"start at"'), ("frame", str(int(n.get("offset") or 0)))]
        elif kind == "missing":
            note(f"{label}: its file was not found when the script was written")
        knobs += [("colorspace", _str(cs)), ("premultiplied", "true"), ("before", "hold"), ("after", "hold")]
        r = out.add("Read", label, knobs, [], pos)
        how = {"fit": "fit", "fill": "fill", "none": "none", "stretch": "distort"}[n.get("fit") or "fit"]
        note("Read: Nuke reads PNG / JPEG / films as sRGB and EXR / HDR as linear unless the comp names a colourspace "
             "(written as is: 'sRGB' and 'linear' are the nuke-default config's names); every Read is taken as straight "
             "and premultiplied, as the comp does")
        note("Read and Reformat: Nuke's resize filter is cubic, the comp's bilinear")
        return out.add("Reformat", f"{label}_fit", [("inputs", "1"), ("format", f'"{W} {H} 0 0 {W} {H} 1 comp_{W}x{H}"'),
                                                    ("resize", how), ("center", "true"), ("black_outside", "true")] + dis,
                       [r], (x, y + 40))
    if t == "constant":
        def pm(c):
            c = c or [0, 0, 0, 1]
            return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
        return out.add("Constant", label, [("inputs", "0"), ("channels", "rgba"), ("color", A.knob(n, "color", pm, 4)),
                                           ("format", f'"{W} {H} 0 0 {W} {H} 1 comp_{W}x{H}"'),
                                           ("first", "0"), ("last", str(max(0, F - 1)))] + dis, [], pos)
    if t == "merge":
        b, a = src(0), src(1)
        m = src(2)
        note("Merge: screen, difference, min and max work on alpha as on colour in the comp; Nuke's Merge2 may treat alpha its own way for some of them")
        # A layer's length: the Merge is off before its in and from its out on (comp frames are Nuke's here).
        live = []
        if M._is_num(n.get("in")):
            live.append(f"frame<{int(n['in'])}")
        if M._is_num(n.get("out")):
            live.append(f"frame>={int(n['out'])}")
        if live and not dis:
            dis = [("disable", '{{"' + " || ".join(live) + '"}}')]
        knobs = [("inputs", "2+1" if m else "2"), ("operation", n.get("operation") or "over"),
                 ("mix", A.knob(n, "mix"))] + dis
        return out.add("Merge2", label, knobs, [b, a] + ([m] if m else []), pos)
    # The size that comes in: a node's numbers are in its pixels (y up from ITS bottom, as Nuke's are).
    fi = M.format_at(A.comp, ins[0]) if ins and ins[0] else {"width": W, "height": H}
    IW, IH = fi["width"], fi["height"]
    if t == "transform":
        mid = [IW / 2, IH / 2]
        tr = A.knob(n, "translate", lambda v: [(v or [0, 0])[0], -(v or [0, 0])[1]], 2)
        ce = A.knob(n, "center", lambda v: [(v or mid)[0], IH - (v or mid)[1]], 2)
        note("Transform: Nuke filters with cubic, the comp with bilinear")
        return out.add("Transform", label, [("inputs", "1"), ("translate", tr), ("rotate", A.knob(n, "rotate", lambda v: -(v or 0))),
                                            ("scale", A.knob(n, "scale", lambda v: list(v or [1, 1]), 2)),
                                            ("skewX", A.knob(n, "skew", lambda v: -(v or [0, 0])[0])),
                                            ("skewY", A.knob(n, "skew", lambda v: -(v or [0, 0])[1])),
                                            ("skew_order", "XY"), ("center", ce),
                                            ("black_outside", "true")] + dis, [src()], pos)
    if t == "reformat":
        if A.animated(n, "scale"):
            note(f"{label}: an animated Reformat scale is written at its value on the first frame")
        ks = [("inputs", "1")]
        if P("mode") == "scale":
            ks += [("type", "scale"), ("scale", _num(P("scale") or 1))]
        else:
            ks += [("type", '"to box"'), ("box_width", _num(P("width") or IW)), ("box_height", _num(P("height") or IH)),
                   ("box_fixed", "true")]
        ks += [("resize", P("resize") or "fit"), ("center", "true" if P("center") != "off" else "false"),
               ("flip", "true" if P("flip") == "on" else "false"), ("flop", "true" if P("flop") == "on" else "false"),
               ("turn", "true" if P("turn") == "on" else "false"), ("black_outside", "true")]
        return out.add("Reformat", label, ks + dis, [src()], pos)
    if t == "crop":
        if any(A.animated(n, p) for p in ("topleft", "bottomright")):
            box = "{" + " ".join("{curve x0 " + " ".join(_num(v) for v in vals) + "}" for vals in zip(*[
                _crop_box(M.param_at(n, "topleft", f), M.param_at(n, "bottomright", f), IW, IH) for f in A.frames])) + "}"
        else:
            box = _value(_crop_box(P("topleft"), P("bottomright"), IW, IH))
        if P("softness"):
            note("Crop: Nuke's softness is not the comp's ramp")
        return out.add("Crop", label, [("inputs", "1"), ("box", box), ("softness", A.knob(n, "softness")), ("reformat", "false"),
                                       ("crop", "true")] + dis, [src()], pos)
    if t == "grade":
        sat = A.animated(n, "saturation") or P("saturation") != 1
        mixed = A.animated(n, "mix") or P("mix") != 1
        ks = [("inputs", "1"), ("blackpoint", A.knob(n, "blackpoint")), ("whitepoint", A.knob(n, "whitepoint")),
              ("black", A.knob(n, "lift")), ("white", A.knob(n, "gain")), ("multiply", A.knob(n, "multiply")),
              ("add", A.knob(n, "offset")), ("gamma", A.knob(n, "gamma")), ("black_clamp", "false"),
              ("unpremult", "rgba.alpha")]
        if not sat:
            return out.add("Grade", label, ks + [("mix", A.knob(n, "mix"))] + dis, [src()], pos)
        s = src()
        g = out.add("Grade", label, ks + dis, [s], pos)
        st = out.add("Saturation", f"{label}_saturation", [("inputs", "1"), ("saturation", A.knob(n, "saturation")),
                                                           ("unpremult", "rgba.alpha")] + dis, [g], (x, y + 40))
        if not mixed:
            return st
        return out.add("Dissolve", f"{label}_mix", [("inputs", "2"), ("which", A.knob(n, "mix"))] + dis, [s, st], (x, y + 80))
    if t == "blur":
        note("Blur: Nuke's Blur size is close to the comp's (two sigma) but not the same filter")
        return out.add("Blur", label, [("inputs", "1"), ("channels", "rgba"), ("size", A.knob(n, "size"))] + dis, [src()], pos)
    if t == "shuffle":
        return out.add("Shuffle", label, [("inputs", "1")] + [(_CH[k], _SHUF.get(n.get(k) or k, _CH[k])) for k in "rgba"] + dis,
                       [src()], pos)
    if t == "copy":
        pick = {k: n.get(k) or M.NODE_TYPES["copy"]["params"][k]["def"] for k in "rgba"}
        pairs = [(v[2], k) for k, v in pick.items() if v.startswith("A.")]
        cur = src(0)
        if pairs:
            ks = [("inputs", "2")]
            for j, (fr, to) in enumerate(pairs):
                ks += [(f"from{j}", f"rgba.{_CH[fr]}"), (f"to{j}", f"rgba.{_CH[to]}")]
            cur = out.add("Copy", label, ks + dis, [cur, src(1)], pos)
        consts = {k: v for k, v in pick.items() if v in ("0", "1")}
        if consts or not pairs:
            cur = out.add("Shuffle", f"{label}_const" if pairs else label,
                          [("inputs", "1")] + [(_CH[k], ("black" if consts[k] == "0" else "white") if k in consts else _CH[k]) for k in "rgba"] + dis,
                          [cur], (x, y + 40) if pairs else pos)
        return cur
    if t in ("premult", "unpremult"):
        return out.add("Premult" if t == "premult" else "Unpremult", label, [("inputs", "1")] + dis, [src()], pos)
    if t == "retime":
        vals = [M.retime_frame(n, f) for f in A.frames]
        nearest = n.get("blend") != "mix"
        if nearest:
            vals = [float(np.floor(v + 0.5)) for v in vals]
        lookup = "{{curve x0 " + " ".join(_num(v) for v in vals) + "}}" if len(vals) > 1 else _num(vals[0] if vals else 0)
        if not nearest:
            note("Retime (mix): Nuke's TimeWarp blends frames with its own filter")
        return out.add("TimeWarp", label, [("inputs", "1"), ("lookup", lookup), ("filter", "none" if nearest else "box")] + dis,
                       [src()], pos)
    if t == "channelmath":
        op, chans = n.get("operation") or "multiply", n.get("channels") or "rgb"
        use = {"a": "a", "r": "r", "g": "g", "b": "b", "rgb": "rgb", "rgba": "rgba"}[chans]
        ks = [("inputs", "1")]
        for j, c in enumerate("rgba"):
            ks.append((f"expr{j}", _str(_math_expr(op, c) if c in use else c)))
        ks += [("addUserKnob", "{20 User}"), ("addUserKnob", "{7 v l value}"), ("v", A.knob(n, "value")),
               ("addUserKnob", "{7 m l mix}"), ("m", A.knob(n, "mix"))]
        return out.add("Expression", label, ks + dis, [src()], pos)
    if t == "channelmerge":
        ch = lambda c: "rgba." + _CH[c]  # noqa: E731
        return out.add("ChannelMerge", label, [("inputs", "2"), ("A", ch(n.get("a_channel") or "a")), ("operation", n.get("operation") or "union"),
                                               ("B", ch(n.get("b_channel") or "a")), ("output", ch(n.get("output") or "a")),
                                               ("mix", A.knob(n, "mix"))] + dis, [src(0), src(1)], pos)
    if t in ("ocio_colorspace", "ocio_display"):
        un = (n.get("unpremult") or "on") != "off"
        cur = src()
        if un:
            cur = out.add("Unpremult", f"{label}_unpremult", [("inputs", "1")] + dis, [cur], (x, y - 40))
        ins_cs = P("in_space") or "scene_linear"
        if t == "ocio_colorspace":
            cur = out.add("OCIOColorSpace", label, [("inputs", "1"), ("in_colorspace", _str(ins_cs)),
                                                    ("out_colorspace", _str(P("out_space") or "scene_linear"))] + dis, [cur], pos)
        else:
            ks = [("inputs", "1"), ("colorspace", _str(ins_cs))]
            if P("display") and P("display") != "*":
                ks.append(("display", _str(P("display"))))
            if P("view") and P("view") != "*":
                ks.append(("view", _str(P("view"))))
            cur = out.add("OCIODisplay", label, ks + dis, [cur], pos)
        note("OCIO nodes: Nuke uses its own OCIO config - set it to the one the viewer used for the same colours; "
             "an empty space is written as the scene_linear role")
        if un:
            cur = out.add("Premult", f"{label}_premult", [("inputs", "1")] + dis, [cur], (x, y + 40))
        return cur
    if t == "erode":
        if A.animated(n, "size"):
            note(f"{label}: an animated Erode size is written per frame")
        note("Erode/Dilate: written as Nuke's FilterErode (box filter): close to the comp's min / max, not the same")
        return out.add("FilterErode", label, [("inputs", "1"), ("channels", "alpha" if n.get("channels") == "alpha" else "rgba"),
                                              ("size", A.knob(n, "size", lambda v: -(v or 0))), ("filter", "box")] + dis,
                       [src()], pos)
    if t == "metadata":
        note("Metadata: written as a NoOp (its keys are the comp's own; the EXRs its Writes make carry them)")
        return out.add("NoOp", label, [("inputs", "1")] + dis, [src()], pos, label="metadata")
    if t == "write":
        from . import comp_write as CW
        pattern, ft = CW.resolve_pattern(n, comp_path or nk_path)
        if ft != "exr" and not CW.comp_io.is_sequence(pattern) and ft not in CW.FILM_TYPES:
            stem, ext = os.path.splitext(pattern)
            pattern = f"{stem}.{'#' * int(n.get('padding') or 4)}{ext}"
        frames = CW.write_frames(n, {"format": {"frames": F}})
        knobs = [("inputs", "1"), ("file", _str(pattern.replace(os.sep, "/"))), ("file_type", {"jpg": "jpeg", "tiff": "tiff"}.get(ft, ft)),
                 ("first", str(frames[0])), ("last", str(frames[-1])), ("use_limit", "true")]
        if ft == "exr":
            knobs += [("channels", "all" if n.get("channels") == "all" else "rgb" if n.get("channels") == "rgb" else "rgba"),
                      ("datatype", '"32 bit float"' if n.get("depth") == "float" else '"16 bit half"'),
                      ("colorspace", "linear")]
        if (n.get("first_number") or 1001) != 0:
            note("Write: Nuke numbers frames as the comp does (from 0); the viewer's Write numbers them from its 'frame 0 is'")
        return out.add("Write", label, knobs + dis, [src()], pos)
    if t == "output":
        base = os.path.splitext(os.path.basename(nk_path or "comp.nk"))[0]
        folder = os.path.join(os.path.dirname(nk_path or "."), f"{base}_render")
        return out.add("Write", label, [("inputs", "1"), ("file", _str(os.path.join(folder, f"{base}.####.exr"))),
                                        ("file_type", "exr"), ("colorspace", "linear"),
                                        ("first", "0"), ("last", str(max(0, F - 1))), ("use_limit", "true")], [src()], pos)
    raise ValueError(t)


def _crop_box(tl, br, W, H):
    tl = tl or [0, 0]
    br = br or [W, H]
    return [tl[0], H - br[1], br[0], H - tl[1]]


def _math_expr(op, c):
    y = {"add": f"{c}+v", "multiply": f"{c}*v", "power": f"{c}>0?pow({c},v):{c}", "invert": f"v-{c}",
         "clamp": f"{c}<0?0:({c}>v?v:{c})", "min": f"min({c},v)", "max": f"max({c},v)", "abs": f"abs({c})",
         "threshold": f"{c}>=v?1:0", "set": "v"}.get(op, c)
    return f"{c}+(({y})-{c})*m"


# ── baked frames ─────────────────────────────────────────────────────────────

def write_exr(img, path):
    """A picture as a premultiplied half-float RGBA EXR (OpenImageIO when there, else a plain uncompressed one)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    px = np.ascontiguousarray(img, dtype=np.float32)
    tmp = path + ".part.exr"
    try:
        import OpenImageIO as oiio
        spec = oiio.ImageSpec(px.shape[1], px.shape[0], 4, oiio.HALF)
        spec.channelnames = ("R", "G", "B", "A")
        spec.alpha_channel = 3
        spec.attribute("compression", "zip")
        o = oiio.ImageOutput.create(tmp)
        if not o or not o.open(tmp, spec):
            raise OSError("OpenImageIO could not write the EXR")
        o.write_image(px)
        o.close()
    except ImportError:
        with open(tmp, "wb") as fh:
            fh.write(exr_bytes(px))
    os.replace(tmp, path)
    return path


def exr_bytes(px):
    """An uncompressed scanline OpenEXR file (half float, channels A B G R) of a [H, W, 4] RGBA picture - written
    from the published OpenEXR file layout."""
    h, w = px.shape[:2]

    def attr(name, typ, data):
        return name.encode() + b"\0" + typ.encode() + b"\0" + struct.pack("<i", len(data)) + data

    chans = b"".join(c.encode() + b"\0" + struct.pack("<iB3xii", 1, 0, 1, 1) for c in "ABGR") + b"\0"
    box = struct.pack("<iiii", 0, 0, w - 1, h - 1)
    header = (struct.pack("<ii", 20000630, 2)
              + attr("channels", "chlist", chans) + attr("compression", "compression", b"\0")
              + attr("dataWindow", "box2i", box) + attr("displayWindow", "box2i", box)
              + attr("lineOrder", "lineOrder", b"\0") + attr("pixelAspectRatio", "float", struct.pack("<f", 1.0))
              + attr("screenWindowCenter", "v2f", struct.pack("<ff", 0, 0)) + attr("screenWindowWidth", "float", struct.pack("<f", 1.0))
              + b"\0")
    half = px.astype("<f2")
    rows = np.concatenate([half[:, :, 3], half[:, :, 2], half[:, :, 1], half[:, :, 0]], axis=1)   # A B G R per row
    line = w * 4 * 2
    start = len(header) + 8 * h
    offsets = struct.pack(f"<{h}Q", *[start + y * (8 + line) for y in range(h)])
    blocks = b"".join(struct.pack("<ii", y, line) + rows[y].tobytes() for y in range(h))
    return header + offsets + blocks


def readme(plan, nk_name):
    lines = [f"{nk_name}: the comp as a Nuke script, written by the ComfyUI Image Viewer's Comp space.", "",
             "Open it in Nuke (File > Open). Frames keep the comp's numbers, from 0. The Write node renders EXRs beside the script.", ""]
    if plan["bake"]:
        lines += ["Baked (rendered here into EXR sequences, read by the script - no stock Nuke node does the same):"]
        lines += [f"  {b['name']} ({b['type']}): {b['pattern']}" for b in plan["bake"]]
        lines.append("")
    if plan["placeholder"]:
        lines += ["Written as NoOp placeholders (switched off, or not baked): " + ", ".join(plan["placeholder"]), ""]
    if plan["notes"]:
        lines += ["Close, but not the same arithmetic:"] + [f"  - {s}" for s in plan["notes"]] + [""]
    lines += ["Written from the published shape of a Nuke script and the stock nodes' documented knobs (no Foundry code).",
              "Nuke is a trademark of The Foundry; the name says only what the file is for."]
    return "\n".join(lines) + "\n"
