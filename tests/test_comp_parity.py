"""The Comp preview (js/imageViewer_compModel.js) and the render (src/comp_model.py) make the same pictures.

Runs node on tests/comp_parity.mjs with the same comps and the same source pixels and compares every
float. Also checks that the two node tables agree. Skipped without node on PATH."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("comp_model", os.path.join(ROOT, "src", "comp_model.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

W, H = 29, 17


def src(seed, w=W, h=H, alpha=True):
    rng = np.random.default_rng(seed)
    u8 = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
    if not alpha:
        u8[..., 3] = 255
    return u8


def comp(nodes, out="Output1", frames=10, w=W, h=H):
    return {"comp": 1, "format": {"width": w, "height": h, "fps": 24, "frames": frames}, "nodes": nodes, "output": out}


def read(i, **kw):
    return dict({"id": f"Read{i}", "type": "read", "file": f"r{i}.png", "inputs": []}, **kw)


def out(src_id):
    return {"id": "Output1", "type": "output", "inputs": [src_id]}


def merge(i, b, a, m=None, **kw):
    return dict({"id": f"Merge{i}", "type": "merge", "inputs": [b, a, m]}, **kw)


def channel_cases(sources):
    """Extra channels: made, shuffled, written into by the nodes that make something, moved with the picture,
    merged, mixed over time, removed. The extras are compared too."""
    c = []
    N = node
    c.append(({"comp": comp([read(1), N("addchannels", 1, ["Read1"], channels="mask.a, depth.z", value=0.25),
                             N("shuffle", 1, ["addchannels1"], r="mask.a", g="r", b="1", a="depth.z"), out("shuffle1")])}, sources))
    c.append(({"comp": comp([read(1), N("keyer", 1, ["Read1"], write="mask.a", tolerance=0.2),
                             N("transform", 1, ["keyer1"], translate=[2.5, -1.25], rotate=9),
                             N("blur", 1, ["transform1"], size=3), N("shuffle", 1, ["blur1"], a="mask.a"), out("shuffle1")])}, sources))
    c.append(({"comp": comp([read(1), N("lumakeyer", 1, ["Read1"], write="matte"),
                             N("reformat", 1, ["lumakeyer1"], width=20, height=12, resize="fill"),
                             N("crop", 1, ["reformat1"], topleft=[2, 3], softness=1.5),
                             N("removechannels", 1, ["crop1"], channels="matte.r matte.g"), out("removechannels1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("addchannels", 1, ["Read1"], channels="bx", value=0.5),
                             N("keyer", 1, ["Read2"], write="ax.a"), merge(1, "addchannels1", "keyer1"),
                             N("removechannels", 1, ["Merge1"], operation="keep", channels="ax, bx.g, rgb"), out("removechannels1")])}, sources))
    moved = moving(5, [1, 2, 3])
    c.append(({"comp": comp([read(1), N("lumakeyer", 1, ["Read1"], write="k.a", low=0.3),
                             N("retime", 1, ["lumakeyer1"], speed=0.5, blend="mix"), out("retime1")], w=40, h=32), "frame": 3}, moved))
    c.append(({"comp": comp([N("constant", 1, [], color=[0.2, 0.4, 0.6, 0.8], write="a"), out("constant1")])}, {}))
    c.append(({"comp": comp([N("constant", 1, [], color=[0.2, 0.4, 0.6, 0.8], write="c.g"), out("constant1")])}, {}))
    c.append(({"comp": comp([read(1), N("shuffle", 1, ["Read1"], out="lay", r="-", g="a", b="0", a="g"),
                             N("shuffle", 2, ["shuffle1"], out="rgba", r="lay.a", g="-", b="lay.r", a="lay.g"), out("shuffle2")])}, sources))
    c.append(({"comp": comp([read(1), N("lensflare", 1, ["Read1", None], position=[10, 8], write="flare"), out("lensflare1")])}, sources))
    return c


def mask_cases(sources):
    """Every MASKABLE node's mask input and mix: a channel of the mask picture, inverted, an extra channel,
    a smaller mask (laid bottom left), a keyed mix."""
    c = []
    N = node
    c.append(({"comp": comp([read(1), read(2), N("grade", 1, ["Read1", "Read2"], gain=2.5, mix=0.7), out("grade1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("blur", 1, ["Read1", "Read2"], size=3, mask_channel="g", mask_invert="on"),
                             out("blur1")])}, sources))
    c.append(({"comp": comp([read(1), N("blur", 1, ["Read1", None], size=2, mix=0.35), out("blur1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("lumakeyer", 1, ["Read2"], write="m.a"),
                             N("glow", 1, ["Read1", "lumakeyer1"], mask_channel="m.a", mix=0.8), out("glow1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("reformat", 1, ["Read2"], width=12, height=9, resize="none"),
                             N("erode", 1, ["Read1", "reformat1"], size=1.5), out("erode1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("addchannels", 1, ["Read1"], channels="z.a", value=0.5),
                             N("shuffle", 1, ["addchannels1", "Read2"], r="b", b="r", mask_channel="r"), out("shuffle1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("copy", 1, ["Read1", "Read2", "Read2"], mask_channel="b"), out("copy1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("colorcorrect", 1, ["Read1", "Read2"], master_saturation=150, mix=0.6), out("colorcorrect1")])}, sources))
    c.append(({"comp": comp([read(1), N("unpremult", 1, ["Read1", None], mix=0.5,
                             tracks={"mix": [{"f": 0, "v": 0}, {"f": 9, "v": 1}]}), out("unpremult1")]), "frame": 4}, sources))
    return c


def box_cases(sources):
    """Small things over a plate: the preview works only inside their boxes (bounding boxes); the numbers must
    not change. A sparse picture, a crop moved and blurred, a merge mask, a roto-free mask stage, a reformat."""
    c = []
    N = node
    sparse = np.zeros((H, W, 4), np.uint8)
    sparse[5:9, 7:12] = src(9, 5, 4)
    sp = dict(sources, Read3=sparse)
    c.append(({"comp": comp([read(1), read(2), N("crop", 1, ["Read1"], topleft=[4, 3], bottomright=[10, 8]),
                             N("transform", 1, ["crop1"], translate=[6.5, 4.25], rotate=20, scale=[0.8, 1.3]),
                             N("blur", 1, ["transform1"], size=4), merge(1, "Read2", "blur1"), out("Merge1")])}, sources))
    c.append(({"comp": comp([read(2), read(3), N("blur", 1, ["Read3"], size=7),
                             merge(1, "Read2", "blur1", operation="screen"), out("Merge1")])}, sp))
    c.append(({"comp": comp([read(2), read(3), N("grade", 1, ["Read3", None], gain=2),
                             N("transform", 1, ["grade1"], translate=[-9, 2]), merge(1, "Read2", "transform1", "Read1", mix=0.6),
                             out("Merge1")])}, dict(sp, Read1=src(1))))
    c.append(({"comp": comp([read(3), N("blur", 1, ["Read3"], size=30), out("blur1")])}, sp))
    c.append(({"comp": comp([read(2), read(3), N("reformat", 1, ["Read3"], width=14, height=10, resize="none"),
                             merge(1, "Read2", "reformat1", operation="plus"), N("blur", 2, ["Merge1", "Read3"], size=2), out("blur2")])}, sp))
    return c


def paint_cases(sources):
    """The Paint node: colour, erase, clone (from the picture before it and from another frame), reveal, frame ranges,
    a stroke following a Transform, at a proxy scale and over a picture of another size."""
    N = node
    c = []
    line = [[2, 3], [9.5, 6.25], [20, 4], [26, 14]]
    strokes = [
        {"tool": "color", "pts": line, "size": 5, "hard": 0.4, "opacity": 0.8, "color": [1.2, 0.3, 0.1, 0.7]},
        {"tool": "erase", "pts": [[14, 9], [18, 12]], "size": 6.5, "hard": 0, "opacity": 0.6},
        {"tool": "clone", "pts": [[4, 12], [12, 13]], "size": 4, "hard": 0.8, "offset": [6.5, -3.25]},
        {"tool": "reveal", "pts": [[20, 2], [21, 15]], "size": 7, "hard": 0.5, "spacing": 0.3, "offset": [-2, 1]},
        {"tool": "color", "pts": [[8, 8]], "size": 9, "life": "single", "f": 0, "color": [0, 1, 0, 1]},
        {"tool": "color", "pts": [[3, 14]], "size": 9, "life": "single", "f": 4, "color": [0, 0, 1, 1]},
        {"tool": "color", "pts": [[24, 3]], "size": 5, "life": "from", "f": 1},
        {"tool": "color", "pts": [[24, 9]], "size": 5, "life": "range", "f": 3, "f1": 1},
        {"tool": "color", "pts": [[1, 1], [28, 16]], "size": 3, "off": True},
    ]
    for scale in (1, 0.5):
        c.append(({"comp": comp([read(1), read(2), N("paint", 1, ["Read1", "Read2"], strokes=strokes), out("paint1")]), "scale": scale}, sources))
    c.append(({"comp": comp([read(1), read(2), N("paint", 1, ["Read1", "Read2"], strokes=strokes), out("paint1")]), "frame": 2}, sources))
    c.append(({"comp": comp([N("paint", 1, [None, None], strokes=strokes[:2]), out("paint1")])}, {}))
    moved = moving(5, [1, 2, 3])
    c.append(({"comp": comp([read(1), N("paint", 1, ["Read1", None], strokes=[
        {"tool": "clone", "pts": [[6, 6], [30, 20]], "size": 8, "dt": -1, "offset": [2, 2]},
        {"tool": "reveal", "pts": [[6, 20], [30, 6]], "size": 8}]), out("paint1")], w=40, h=32), "frame": 2}, moved))
    tr = N("transform", 1, ["Read1"], tracks={"translate": [{"f": 0, "v": [0, 0]}, {"f": 4, "v": [8, -4]}]})
    c.append(({"comp": comp([read(1), tr, N("paint", 1, ["transform1", None], strokes=[
        {"tool": "color", "pts": [[5, 10], [12, 9]], "size": 4, "link": "transform1", "f": 1}]), out("paint1")]), "frame": 3}, sources))
    small = {"Read1": src(3, 11, 7), "Read2": sources["Read2"]}
    c.append(({"comp": comp([read(1, fit="none"), N("reformat", 1, ["Read1"], width=11, height=7), read(2),
                             N("paint", 1, ["reformat1", "Read2"], strokes=strokes[:4]), out("paint1")])}, small))
    return c


def warp_cases(sources):
    """CornerPin, STMap, VectorWarp, LensDistortion, GridWarp, and the trackers' stabilise / match-move."""
    c = []
    N = node
    pin = {"to1": [2, 15], "to2": [26, 16.5], "to3": [24, 1], "to4": [4.5, 3]}
    c.append(({"comp": comp([read(1), N("cornerpin", 1, ["Read1"], **pin), out("cornerpin1")])}, sources))
    c.append(({"comp": comp([read(1), N("cornerpin", 1, ["Read1"], invert="on", from1=[1, 16], from3=[27, 0.5], **pin), out("cornerpin1")])}, sources))
    c.append(({"comp": comp([read(1), N("addchannels", 1, ["Read1"], channels="m.a", value=0.5),
                             N("cornerpin", 1, ["addchannels1"], **pin), N("shuffle", 1, ["cornerpin1"], g="m.a"), out("shuffle1")]), "scale": 0.5}, sources))
    # an ST map from a lens undistort, used on the plate: the same picture as the undistort itself
    lens = {"k1": -0.12, "k2": 0.03, "zoom": 1.05}
    c.append(({"comp": comp([read(1), N("lensdistortion", 1, ["Read1"], **lens), out("lensdistortion1")])}, sources))
    c.append(({"comp": comp([read(1), N("lensdistortion", 1, ["Read1"], mode="redistort", center=[12, 9], **lens), out("lensdistortion1")])}, sources))
    c.append(({"comp": comp([read(1), N("lensdistortion", 1, ["Read1"], output="stmap", **lens), out("lensdistortion1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("lensdistortion", 1, ["Read2"], output="stmap", k1=0.2),
                             N("stmap", 1, ["Read1", "lensdistortion1"]), out("stmap1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("reformat", 1, ["Read2"], width=13, height=21, resize="distort"),
                             N("stmap", 1, ["Read1", "reformat1"], u="b", v="r"), out("stmap1")]), "scale": 0.5}, sources))
    c.append(({"comp": comp([read(1), read(2), N("vectorwarp", 1, ["Read1", "Read2"], amount=3.5), out("vectorwarp1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("vectorwarp", 1, ["Read1", "Read2"], u="b", v="a", amount=-2), out("vectorwarp1")]), "scale": 0.5}, sources))
    moved = moving(5, [1, 2, 3])
    c.append(({"comp": comp([read(1), N("vectors", 1, ["Read1"], iterations=8, levels=2),
                             N("vectorwarp", 1, ["Read1", "vectors1"]), out("vectorwarp1")], w=40, h=32), "frame": 2}, moved))
    dst = [v + d for v, d in zip([0, 0, 14.5, 0, 29, 0, 0, 8.5, 14.5, 8.5, 29, 8.5, 0, 17, 14.5, 17, 29, 17],
                                [0, 0, 1, 0, 0, 0, 0, 0, 3, -2, 0, 0, 0, 0, -1, 0, 0, 0])]
    c.append(({"comp": comp([read(1), N("gridwarp", 1, ["Read1"], cols=3, rows=3, dst_points=dst), out("gridwarp1")])}, sources))
    c.append(({"comp": comp([read(1), N("gridwarp", 1, ["Read1"], cols=3, rows=3, dst_points=dst, distortion=0.4), out("gridwarp1")]), "scale": 0.5}, sources))
    pts = {"points": [{"id": "p1", "keys": [[0, 5, 5, 1], [4, 8, 6, 1]]}, {"id": "p2", "keys": [[0, 20, 6, 1], [4, 22, 9, 1]]},
                      {"id": "p3", "keys": [[0, 21, 14, 1], [4, 20, 15.5, 1]]}, {"id": "p4", "keys": [[0, 6, 13, 1], [4, 7, 12, 1]]}]}
    for motion in ("translate", "rotate", "scale", "perspective"):
        for how in ("stabilise", "match-move"):
            c.append(({"comp": comp([read(1), N("tracker", 1, ["Read1"], points=pts, motion=motion, transform=how), out("tracker1")]), "frame": 3}, sources))
    c.append(({"comp": comp([read(1), N("tracker", 1, ["Read1"], points=pts, motion="scale", transform="match-move", reference=4),
                             out("tracker1")]), "frame": 1, "scale": 0.5}, sources))
    plane = {"keys": [[0, 2, 15, 26, 16, 25, 2, 3, 1], [6, 3, 14, 24, 16, 26, 1, 4, 3]]}
    for how in ("stabilise", "match-move"):
        c.append(({"comp": comp([read(1), N("planartracker", 1, ["Read1"], plane=plane, transform=how), out("planartracker1")]), "frame": 2}, sources))
    return c


def cases():
    s1, s2, s3 = src(1), src(2), src(3, 11, 7)
    sources = {"Read1": s1, "Read2": s2}
    c = []
    for op in M.MERGE_OPS:
        c.append(({"comp": comp([read(1), read(2), merge(1, "Read1", "Read2", operation=op, mix=0.7), out("Merge1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), read(3), merge(1, "Read1", "Read2", "Read3"), out("Merge1")])},
              dict(sources, Read3=src(4))))
    for fit in M.FITS:
        c.append(({"comp": comp([read(3, fit=fit), out("Read3")])}, {"Read3": s3}))
    c.append(({"comp": comp([read(1), {"id": "Transform1", "type": "transform", "inputs": ["Read1"], "translate": [3.25, -2],
                                        "rotate": 17, "scale": [1.3, 0.8], "center": [10, 5]}, out("Transform1")])}, sources))
    c.append(({"comp": comp([read(1), {"id": "Transform1", "type": "transform", "inputs": ["Read1"], "translate": [1, 2],
                                        "rotate": -9, "scale": [0.9, 1.1], "skew": [0.3, -0.15], "center": [12, 7]}, out("Transform1")])}, sources))
    c.append(({"comp": comp([read(1), {"id": "Grade1", "type": "grade", "inputs": ["Read1"], "blackpoint": 0.05, "whitepoint": 0.9,
                                        "lift": 0.02, "gain": 1.4, "multiply": 1.1, "offset": -0.01, "gamma": 1.7,
                                        "saturation": 0.4, "mix": 0.8}, out("Grade1")])}, sources))
    for size in (0.5, 3, 7.5):
        c.append(({"comp": comp([read(1), {"id": "Blur1", "type": "blur", "inputs": ["Read1"], "size": size}, out("Blur1")])}, sources))
    c.append(({"comp": comp([{"id": "Constant1", "type": "constant", "color": [0.2, 0.5, 1.5, 0.6], "inputs": []}, out("Constant1")])}, {}))
    # keys: Motion's eases at a frame between two keys
    for ease in ("smooth", "linear", "hold", "easeIn", "backOut", [0.2, 0.1, 0.3, 1]):
        t = {"id": "Transform1", "type": "transform", "inputs": ["Read1"],
             "tracks": {"translate": [{"f": 0, "v": [0, 0], "ease": ease}, {"f": 8, "v": [6, -4]}],
                        "rotate": [{"f": 2, "v": 0, "ease": ease, "to": 3}, {"f": 9, "v": 30}]}}
        c.append(({"comp": comp([read(1), t, out("Transform1")]), "frame": 5}, sources))
    c.append(({"comp": comp([read(1), read(2), merge(1, "Read1", "Read2", disable=True), out("Merge1")])}, sources))
    # a layer's length: the Merge passes B before its in and from its out on
    for fr in (1, 3, 6):
        c.append(({"comp": comp([read(1), read(2), merge(1, "Read1", "Read2", **{"in": 2, "out": 6}), out("Merge1")]), "frame": fr}, sources))
    c.append(({"comp": comp([read(1), {"id": "Blur1", "type": "blur", "inputs": ["Read1"], "size": 6}, out("Blur1")]), "scale": 0.5}, sources))
    for fit in ("none", "fit"):   # at a proxy scale "none" keeps the picture's size in the comp
        c.append(({"comp": comp([read(3, fit=fit), out("Read3")], w=40, h=24), "scale": 0.5}, {"Read3": s3}))
    straight = {"Read1": src(9, alpha=False)}
    c.append(({"comp": comp([read(1, colorspace="linear"), out("Read1")])}, straight))
    c.extend(new_node_cases(sources))
    c.extend(paint_cases(sources))
    return c


def _synthetic_luts():
    """A LUT and a matrix standing in for OCIO transforms (both twins apply them the same way)."""
    n, shaper = 9, "log2:-8:3"
    axis = M.shaper_inverse(shaper, np.linspace(0, 1, n))
    R, G, B = np.meshgrid(axis, axis, axis, indexing="ij")
    lut = np.stack([np.sqrt(R) * 0.8 + 0.1 * G, G * G / (1 + G) + 0.05 * B, 0.3 * R + 0.5 * np.log1p(B)], axis=-1)
    mat = [0.6, 0.3, 0.1, 0.07, 0.9, 0.03, 0.02, 0.1, 0.88, 0.01, -0.02, 0.0]
    return {"lut": {"size": n, "shaper": shaper, "data": lut.astype(np.float32).reshape(-1).tolist()},
            "mat": {"size": 0, "shaper": "matrix", "data": mat}}


OCIO_LUTS = _synthetic_luts()


def ocio_hook(luts):
    def hook(spec):
        lut = luts["mat"] if spec.get("dst") == "matrixspace" else luts["lut"]
        return lambda rgb: M.apply_lut(rgb, (lut["size"], lut["shaper"], np.asarray(lut["data"], np.float32)))
    return hook


def node(t, i, ins, **kw):
    return dict({"id": f"{t}{i}", "type": t, "inputs": ins}, **kw)


def moving(seed, frames, w=40, h=32, dx=1.5, dy=-1.0):
    """A smooth picture moving by (dx, dy) a frame: sources keyed Read1@f."""
    rng = np.random.default_rng(seed)
    base = rng.random((6, 6, 3))
    out = {}
    for f in frames:
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
        u = (xs - dx * f) / w * 5
        v = (ys - dy * f) / h * 5
        rgb = sum(base[i, j] * (np.cos(u * (i + 1) * 0.7 + j)[..., None] * np.sin(v * (j + 1) * 0.6 + i)[..., None])
                  for i in range(3) for j in range(3))
        rgb = (rgb - rgb.min()) / (rgb.max() - rgb.min())
        u8 = np.concatenate([(rgb * 255).astype(np.uint8), np.full((h, w, 1), 255, np.uint8)], axis=2)
        out[f"Read1@{f}"] = u8
    return out


def new_node_cases(sources):
    c = []
    one = lambda n, srcs=sources, **kw: ({"comp": comp([read(1), read(2), n, out(n["id"])], **kw.pop("cw", {})), **kw}, srcs)
    c.append(one(node("crop", 1, ["Read1"], topleft=[3.3, 2.6], bottomright=[20.2, 14.7])))
    c.append(one(node("crop", 1, ["Read1"], topleft=[3.3, 2.6], softness=2.5)))
    c.append(one(node("shuffle", 1, ["Read1"], r="b", g="r", b="a", a="1")))
    c.append(one(node("copy", 1, ["Read1", "Read2"], r="A.r", g="B", b="0", a="A.a")))
    c.append(one(node("premult", 1, ["Read1"])))
    c.append(one(node("unpremult", 1, ["Read1"])))
    green = src(11)
    green[..., 1] = np.maximum(green[..., 1], 200)
    green[:8, :, 1] = 40
    for mode in ("chroma", "luma"):
        c.append(one(node("keyer", 1, ["Read1"], mode=mode, screen=[0.1, 0.8, 0.12, 1], tolerance=0.2, softness=0.35, despill=0.7),
                     {"Read1": green}))
    frames = moving(5, range(0, 8))
    big = {"w": 40, "h": 32}
    for kw in ({"speed": 0.5, "offset": 1}, {"speed": 0.75, "start": 2, "blend": "mix"}, {"speed": -1, "offset": 6}):
        c.append(one(node("retime", 1, ["Read1"], **kw), frames, frame=3, cw=big))
    vec = node("vectors", 1, ["Read1"], iterations=12)
    for detail in ("full", "half", "quarter"):
        c.append(({"comp": comp([read(1), dict(vec, detail=detail), out("vectors1")], **big), "frame": 4}, frames))
    c.append(({"comp": comp([read(1), vec, node("motionblur", 1, ["Read1", "vectors1"], shutter=0.8, samples=7),
                             out("motionblur1")], **big), "frame": 4}, frames))
    c.append(({"comp": comp([read(1), node("motionblur", 1, ["Read1", None], shutter=1.2, samples=5, offset="end"),
                             out("motionblur1")], **big), "frame": 3, "scale": 0.5}, frames))
    for ch in ("r", "luminance"):
        c.append(one(node("depthblur", 1, ["Read1", "Read2"], channel=ch, focus=0.4, dof=0.1, falloff=0.25, size=6, layers=5)))
    c.append(one(node("depthblur", 1, ["Read1", "Read2"], focus=0.4, dof=0.1, falloff=0.25, size=7, layers=4, filter="lens")))
    for kw in ({"size": 7.3}, {"size": 9, "shape": "polygon", "blades": 6, "rotation": 17, "aspect": 1.4},
               {"size": 6, "shape": "polygon", "blades": 5, "bloom": 3, "threshold": 0.3}, {"size": 0.6}):
        c.append(one(node("defocus", 1, ["Read1"], **kw)))
    cc = [
        {"master_hue": 25, "master_saturation": 140, "master_contrast": 120, "master_brightness": 0.02},
        {"shadows_hue": -40, "midtones_saturation": 50, "highlights_contrast": 80, "shadow_end": 0.35, "highlight_start": 0.6,
         "shadows_tint_hue": 210, "shadows_tint": 60, "highlights_tint_hue": 40, "highlights_tint": 30, "master_tint_hue": 300, "master_tint": 10},
        {"master_gain_r": 1.2, "master_gamma_b": 1.4, "midtones_pedestal": 0.03, "highlights_gain": 0.8, "shadows_gamma_g": 0.7,
         "shadows_pedestal_r": -0.02, "mix": 0.7},
        {"secA_on": "on", "secA_color": [0.6, 0.2, 0.1, 1], "secA_hue_tol": 40, "secA_sat_tol": 0.5, "secA_lum_tol": 0.6,
         "secA_hue": 90, "secA_saturation": 30, "secA_brightness": 0.05, "secB_on": "on", "secB_color": [0.1, 0.3, 0.7, 1],
         "secB_hue_tol": 60, "secB_sat_tol": 0.8, "secB_lum_tol": 0.8, "secB_saturation": 200},
        {"view": "midtones"}, {"view": "secondary A", "secA_on": "on", "secA_hue_tol": 60, "secA_sat_tol": 1, "secA_lum_tol": 1},
    ]
    for kw in cc:
        c.append(one(node("colorcorrect", 1, ["Read1"], **kw)))
    for kw in ({}, {"source": "max", "low": 0.3, "low_soft": 0.2, "high": 0.8, "high_soft": 0.1, "clip_black": 0.1, "clip_white": 0.9},
               {"source": "green", "low_soft": 0, "invert": "on", "output": "matte"}):
        c.append(one(node("lumakeyer", 1, ["Read1"], **kw)))
    for kw in ({}, {"screen": [0.7, 0.2, 0.1, 1], "screen_gain": 1.4, "clip_black": 0.1, "clip_white": 0.8, "despill_limit": "average", "despill": 0.6},
               {"screen": [0.1, 0.2, 0.6, 1], "output": "despilled"}, {"output": "matte", "invert": "on"}):
        c.append(one(node("chromakeyer", 1, ["Read1"], **kw)))
    for kw in ({"size": -2}, {"size": 2.5, "shape": "disc"}, {"size": -3.25, "shape": "disc", "channels": "alpha"}, {"size": 4, "shape": "disc"}):
        c.append(one(node("erode", 1, ["Read1"], **kw)))
    c.append(({"comp": comp([read(1), node("erode", 1, ["Read1"], size=3.5, shape="disc"), out("erode1")]), "scale": 0.5}, sources))
    for kw in ({}, {"size": 3, "gain": 2, "offset": 0.5}, {"mode": "highpass", "size": 6, "offset": 0.5}):
        c.append(one(node("laplacian", 1, ["Read1"], **kw)))
    for kw in ({}, {"a_channel": "luminance", "b_channel": "r", "operation": "stencil", "output": "rgb", "mix": 0.6},
               {"operation": "xor"}, {"operation": "absminus", "output": "g"}):
        c.append(one(node("channelmerge", 1, ["Read1", "Read2"], **kw)))
    # divide: on the same picture, where big quotients (float32's last place) do not swamp the comparison
    c.append(one(node("channelmerge", 1, ["Read1", "Read1"], operation="divide", a_channel="g", b_channel="luminance", output="rgba", mix=0.5)))
    for kw in ({"in_space": "a", "out_space": "b"}, {"in_space": "a", "out_space": "matrixspace"},
               {"in_space": "a", "out_space": "b", "unpremult": "off"}):
        cs, srcs = one(node("ocio_colorspace", 1, ["Read1"], **kw))
        c.append((dict(cs, ocio=OCIO_LUTS), srcs))
    cs, srcs = one(node("ocio_display", 1, ["Read1"], display="sRGB", view="v"))
    c.append((dict(cs, ocio=OCIO_LUTS), srcs))
    for kw in ({"mode": "to format", "width": 20, "height": 15}, {"mode": "scale", "scale": 0.6, "resize": "distort", "flop": "on"},
               {"width": 12, "height": 20, "resize": "fill", "turn": "on", "center": "off"},
               {"width": 50, "height": 31, "resize": "none", "center": "off"},
               {"width": 25, "height": 9, "resize": "height", "flip": "on"}, {"width": 18, "height": 10, "resize": "none"}):
        c.append(one(node("reformat", 1, ["Read1"], **kw)))
    c.append(({"comp": comp([read(1), node("reformat", 1, ["Read1"], width=20, height=12, turn="on"), out("reformat1")], w=40, h=24), "scale": 0.5}, sources))
    # Pictures of their own size: a smaller A over B (laid at its bottom left), B smaller than A, a Transform,
    # Crop and Blur on a reformatted picture, a mask of another size, channels carried across.
    N = node
    c.append(({"comp": comp([read(1), read(2), N("reformat", 1, ["Read2"], width=13, height=9, resize="distort"),
                             N("transform", 1, ["reformat1"], rotate=20, scale=[1.2, 0.9]),
                             N("merge", 1, ["Read1", "transform1", None], operation="over"), out("merge1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("reformat", 1, ["Read1"], mode="scale", scale=0.5),
                             N("crop", 1, ["reformat1"], topleft=[1, 2], softness=1), N("blur", 1, ["crop1"], size=2),
                             N("merge", 1, ["blur1", "Read2", "Read1"], operation="plus", mix=0.7), out("merge1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), N("addchannels", 1, ["Read2"], channels="mask.a", value=0.5),
                             N("reformat", 1, ["addchannels1"], width=30, height=40, resize="fit"),
                             N("copy", 1, ["Read1", "reformat1"], a="A.a"), N("shuffle", 1, ["copy1"], g="mask.a"), out("shuffle1")])}, sources))
    c.append(({"comp": comp([read(1), N("reformat", 1, ["Read1"], width=21, height=13),
                             N("constant", 1, [], color=[0.2, 0.4, 0.6, 1]), N("channelmerge", 1, ["reformat1", "constant1"]),
                             out("channelmerge1")]), "scale": 0.5}, sources))
    for kw in ({}, {"steps": 1, "size": 7, "source": "max", "tint": [1, 0.6, 0.3, 1], "intensity": 2},
               {"threshold": 0.4, "softness": 0, "effect_only": "on", "steps": 5, "size": 12}):
        c.append(one(node("glow", 1, ["Read1"], **kw)))
    c.append(({"comp": comp([read(1), node("glow", 1, ["Read1"], size=10, threshold=0.5), out("glow1")]), "scale": 0.5}, sources))
    big = {"w": 64, "h": 40}
    flares = [
        ({"position": [20, 12]}, ["Read1", None]),
        ({"position": [50, 8], "ghost_shape": "disc", "ghost_size": 0.1, "ghost_amount": 0.4, "dirt_amount": 1, "dirt_spots": 60,
          "seed": 7, "streak_count": 5, "streak_width": 1.3, "halo_amount": 0.3, "halo_radius": 0.3, "halo_width": 0.04}, [None, None]),
        ({"position": [10, 30], "ghost_size": 0.12, "ghost_amount": 0.5, "blades": 7, "ghost_rotation": 20, "ghost_softness": 0,
          "dirt_amount": 0.8, "dirt_reach": 0.6, "color": [0.7, 0.9, 1, 1]}, ["Read1", "Read2"]),
    ]
    for kw, ins in flares:
        c.append(one(node("lensflare", 1, ins, **kw), cw=big))
        c.append(one(node("lensflare", 1, ins, **kw), cw=big, scale=0.5))
    for op in ("add", "multiply", "power", "invert", "clamp", "min", "max", "abs", "threshold", "set"):
        c.append(one(node("channelmath", 1, ["Read1"], operation=op, value=0.4, channels="rgba" if op == "clamp" else "rgb", mix=0.8)))
    c.extend(channel_cases(sources))
    c.extend(scene_cases(sources))
    c.extend(mask_cases(sources))
    c.extend(box_cases(sources))
    c.extend(warp_cases(sources))
    c.extend(extra_cases(sources))
    c.extend(graph_cases(sources))
    return c


def _noisy(u8, seed, amp=14):
    rng = np.random.default_rng(seed)
    v = u8.astype(np.int64)
    v[..., :3] += rng.integers(-amp, amp + 1, v[..., :3].shape)
    return np.clip(v, 0, 255).astype(np.uint8)


PROFILE = {"v": 1, "scale": 1, "levels": 4, "bins": 8, "lo": 0.05, "hi": 0.8,
           "sigma": [[[0.02 + 0.002 * k + 0.001 * c for k in range(8)] for c in range(3)],
                     [[0.006 + 0.001 * k for k in range(8)] for c in range(3)],
                     [[0.003] * 8 for c in range(3)], [[0.001] * 8 for c in range(3)]],
           "corr": [[1, 0.6, 0.4], [0.6, 1, 0.5], [0.4, 0.5, 1]]}


def grain_cases():
    """Degrain, Regrain and the Grain node with a profile (js/imageViewer_compGrain.js, comp_extra's grain section)."""
    c = []
    N = node
    big = {"w": 40, "h": 32}
    clean = moving(5, range(0, 9))
    noisy = {k: _noisy(v, 100 + i) for i, (k, v) in enumerate(sorted(clean.items()))}
    one = lambda n, srcs, **kw: ({"comp": comp([read(1), read(2), read(3), read(4), n, out(n["id"])], **big), **kw}, srcs)
    for kw in ({"temporal": 0}, {}, {"temporal": 2, "motion": 2, "strength": 2.5, "coarse": 0}, {"output": "removed", "fine": 0.5}):
        c.append(one(N("degrain", 1, ["Read1"], **kw), noisy, frame=4))
    c.append(one(N("degrain", 1, ["Read1"], profile=PROFILE), noisy, frame=4))
    c.append(one(N("degrain", 1, ["Read1"], profile=PROFILE), noisy, frame=3, scale=0.5))
    c.append(one(N("degrain", 1, ["Read1", "Read2"], mix=0.6), dict(noisy, Read2=src(31, 40, 32)), frame=4))
    pl = dict(noisy)
    pl.update({"Read2": noisy["Read1@4"], "Read3": clean["Read1@4"], "Read4": src(32, 40, 32)})
    comp_pic = moving(7, [4])["Read1@4"]
    for f in range(0, 9):
        pl[f"Read1@{f}"] = comp_pic
    for kw in ({}, {"fill": "synth", "seed": 3}, {"fill": "plate"}, {"detect": "off"}, {"output": "grain"},
               {"output": "new areas", "threshold": 0.05, "softness": 0}, {"output": "difference", "cell": 8},
               {"profile": PROFILE, "animated": "off"}):
        c.append(one(N("regrain", 1, ["Read1", "Read2", "Read3", None], **kw), pl, frame=4))
    c.append(one(N("regrain", 1, ["Read1", "Read2", "Read3", "Read4"]), pl, frame=4))
    c.append(one(N("regrain", 1, ["Read1", "Read2", "Read3", None], cell=20), pl, frame=4, scale=0.5))
    c.append(one(N("regrain", 1, ["Read1", None, None, None], profile=PROFILE), pl, frame=4))
    c.append(one(N("regrain", 1, ["Read1", None, None, None]), pl, frame=4))       # nothing to go by: passes
    for kw in ({"profile": PROFILE, "amount": 1}, {"profile": PROFILE, "amount": 0.5, "seed": 4, "animated": "off"}):
        c.append(one(N("grain", 1, ["Read1", None], **kw), pl, frame=2))
    c.append(one(N("grain", 1, ["Read1", None], profile=PROFILE, amount=1), pl, frame=2, scale=0.5))
    return c


def extra_cases(sources):
    """The finishing nodes (src/comp_extra.py, js/imageViewer_compExtra.js): keying, time, colour, filters, AI."""
    c = []
    N = node
    one = lambda n, srcs=sources, **kw: ({"comp": comp([read(1), read(2), n, out(n["id"])], **kw.pop("cw", {})), **kw}, srcs)
    for kw in ({}, {"threshold": 0.1, "softness": 0, "invert": "on"}, {"output": "matte", "softness": 0.3}):
        c.append(one(N("differencekeyer", 1, ["Read1", "Read2"], **kw)))
    c.append(one(N("differencekeyer", 1, ["Read1", "Read2"], write="k.a")))
    green = src(11)
    green[..., 1] = np.maximum(green[..., 1], 180)
    for kw in ({}, {"screen": "blue", "limit": "average", "amount": 0.6, "replace": "grey"},
               {"replace": "colour", "replace_color": [0.9, 0.4, 0.2, 1]}, {"output": "spill"}):
        c.append(one(N("despill", 1, ["Read1"], **kw), {"Read1": green, "Read2": sources["Read2"]}))
    for kw in ({}, {"size": 3, "threshold": 0.5, "output": "extended"}):
        c.append(one(N("edgeextend", 1, ["Read1"], **kw)))
    c.append(one(N("edgeextend", 1, ["Read1"], size=8), scale=0.5, cw={"w": 40, "h": 24}))
    for kw in ({}, {"width": 4, "diffuse": 6, "intensity": 2, "threshold": 0.3}, {"output": "wrap only"}):
        c.append(one(N("lightwrap", 1, ["Read1", "Read2"], **kw)))
    for kw in ({}, {"output": "core", "size": 2.5}, {"output": "outside", "softness": 0}, {"write": "m.a"}):
        c.append(one(N("coreedge", 1, ["Read1"], **kw)))
    frames = moving(5, range(0, 9))
    big = {"w": 40, "h": 32}
    for kw in ({"frame": 2}, {"frame": 1, "every": 3}):
        c.append(one(N("framehold", 1, ["Read1"], **kw), frames, frame=6, cw=big))
    for f, kw in ((1, {"first": 3, "last": 5}), (7, {"first": 3, "last": 5}), (7, {"first": 3, "last": 5, "outside": "black"})):
        c.append(one(N("framerange", 1, ["Read1"], **kw), frames, frame=f, cw=big))
    c.append(one(N("timeoffset", 1, ["Read1"], offset=-2), frames, frame=4, cw=big))
    for f in (1, 3, 4, 6):
        c.append(({"comp": comp([read(1), N("timeoffset", 1, ["Read1"], offset=3), N("appendclip", 1, ["Read1", "timeoffset1"], a_first=1, a_last=4, b_first=0, dissolve=2),
                                 out("appendclip1")], **big), "frame": f}, frames))
    for kw in ({}, {"shutter": 1.5, "samples": 4, "offset": "start"}, {"shutter": 2, "samples": 3, "offset": "end"}):
        c.append(one(N("timeblur", 1, ["Read1"], **kw), frames, frame=4, cw=big))
    c.append(one(N("retime", 1, ["Read1"], speed=0.5, blend="vectors"), frames, frame=5, cw=big))
    c.append(one(N("retime", 1, ["Read1"], speed=0.25, start=1, blend="vectors"), frames, frame=4, cw=big, scale=0.5))
    for kw in ({"slope_r": 1.2, "slope_g": 0.9, "offset_b": 0.02, "power_r": 1.3, "power_g": 0.8, "saturation": 0.7},
               {"slope_r": 1.2, "offset_g": -0.03, "power_b": 1.6, "saturation": 1.4, "direction": "inverse"}):
        c.append(one(N("cdl", 1, ["Read1"], **kw)))
    for kw in ({}, {"unpremult": "off"}):
        cs, srcs = one(N("lut", 1, ["Read1"], file="look.cube", **kw))
        c.append((dict(cs, ocio=OCIO_LUTS), srcs))
    for kw in ({"sat_red": 1.6, "hue_green": 30, "lum_blue": 0.7, "sat_cyan": 0.2},
               {"hue_red": -40, "hue_yellow": 25, "lum_magenta": 1.4, "sat_blue": 1.8}):
        c.append(one(N("huecurves", 1, ["Read1"], **kw)))
    for kw in ({}, {"minimum": 0.2, "maximum": 0.6, "channels": "rgba"}, {"min_on": "off", "maximum": 0.3, "channels": "g"}):
        c.append(one(N("clamp", 1, ["Read1"], **kw)))
    opaque = {"Read1": src(9, alpha=False), "Read2": sources["Read2"]}
    for curve in ("cineon", "logc3", "slog3", "acescct"):
        for op in ("log to lin", "lin to log"):
            c.append(one(N("loglin", 1, ["Read1"], curve=curve, operation=op), opaque))   # straight values in 0..1, as log footage is
    for kw in ({}, {"amount": 0.5}):
        c.append(one(N("colormatch", 1, ["Read1", "Read2"], **kw)))
    for kw in ({}, {"size": 0, "saturation": 1, "response": 0, "seed": 7}, {"size": 2.5, "animated": "off", "amount": 0.1}):
        c.append(one(N("grain", 1, ["Read1", None], **kw), frame=3))
    c.append(one(N("grain", 1, ["Read1", "Read2"], amount=0.8)))
    c.append(one(N("grain", 1, ["Read1", None], size=3), scale=0.5, frame=2, cw={"w": 40, "h": 24}))
    for kw in ({}, {"radius": 1, "strength": 0.2, "mix": 0.6}):
        c.append(one(N("denoise", 1, ["Read1"], **kw)))
    c.append(one(N("denoise", 1, ["Read1"], radius=4), scale=0.5, cw={"w": 40, "h": 24}))
    for kw in ({}, {"amount": 1.5, "size": 4}):
        c.append(one(N("sharpen", 1, ["Read1"], **kw)))
    for kw in ({}, {"radius": 2, "channels": "rgb"}, {"radius": 4}):
        c.append(one(N("median", 1, ["Read1"], **kw)))
    for kw in ({}, {"size": 0, "gain": 2, "source": "rgb"}):
        c.append(one(N("edgedetect", 1, ["Read1"], **kw)))
    for kw in ({}, {"size": 6, "width": 2, "amount": 0.7}):
        c.append(one(N("edgeblur", 1, ["Read1"], **kw)))
    c.extend(grain_cases())
    # Through a mask (the last input) and a mix, as the other per-pixel nodes.
    c.append(one(N("cdl", 1, ["Read1", "Read2"], slope_r=1.5, saturation=0.4, mix=0.7)))
    c.append(one(N("grain", 1, ["Read1", None, "Read2"], amount=0.4, mask_invert="on"), frame=2))
    c.append(one(N("denoise", 1, ["Read1", "Read2"], mix=0.5, mask_channel="r")))
    c.append(one(N("differencekeyer", 1, ["Read1", "Read2", "Read2"], mix=0.6)))
    # AI nodes: their result is a picture beside the comp (here a source keyed by the node's result Read).
    res = lambda *fs: {"frames": {str(f): f"r_{f}.png" for f in fs}}
    ai = dict(sources)
    ai.update({"ai_matte1#ai2": src(21), "ai_depth1#ai2": src(22), "ai_relight1#ai2": src(23), "ai_inpaint1#ai2": src(24),
               "ai_upscale1#ai2": src(25, 2 * W + 3, 2 * H - 1)})
    for kw in ({}, {"output": "matte"}, {"write": "ai.a"}):
        c.append(one(N("ai_matte", 1, ["Read1"], results=res(2, 7), **kw), ai, frame=4))
    c.append(one(N("ai_matte", 1, ["Read1"]), ai))   # not run: passes the input
    c.append(one(N("ai_depth", 1, ["Read1"], results=res(2), invert="on"), ai, frame=0))
    c.append(one(N("ai_relight", 1, ["Read1"], results=res(2)), ai, frame=2))
    c.append(one(N("ai_inpaint", 1, ["Read1", "Read2"], results=res(2)), ai, frame=5))
    c.append(one(N("ai_upscale", 1, ["Read1"], results=res(2)), ai, frame=2))
    c.append(one(N("ai_upscale", 1, ["Read1"], factor="4"), ai))
    c.append(({"comp": comp([read(1), N("ai_upscale", 1, ["Read1"], results=res(2)), N("blur", 1, ["ai_upscale1"], size=2), out("blur1")]),
               "frame": 2, "scale": 0.5}, ai))
    # VFX nodes: one film over frames first..last (here a source keyed by "<node>#vfx@<frame>"), the input outside.
    vres = lambda **kw: dict({"file": "n_vfx/x.mp4", "offset": 0, "first": 2, "last": 6}, **kw)
    vx = dict(sources)
    vx.update({"vfx_alpha1#vfx@4": src(31), "vfx_hdr1#vfx@4": src(32), "vfx_reframe1#vfx@4": src(33, 40, 22),
               "vfx_upscale1#vfx@4": src(34, 2 * W, 2 * H), "vfx_upscale1#vfx@1": src(34, 2 * W, 2 * H)})
    for kw in ({}, {"output": "matte"}):
        c.append(one(N("vfx_alpha", 1, ["Read1"], results=vres(), **kw), vx, frame=4))
    c.append(one(N("vfx_alpha", 1, ["Read1"]), vx, frame=4))                 # not rendered: passes the input
    c.append(one(N("vfx_hdr", 1, ["Read1"], results=vres()), vx, frame=4))
    c.append(one(N("vfx_reframe", 1, ["Read1"], results=vres(width=40, height=22)), vx, frame=4))
    c.append(one(N("vfx_reframe", 1, ["Read1"], results=vres(width=40, height=22)), vx, frame=8))   # outside: the input, laid into the new size
    c.append(one(N("vfx_upscale", 1, ["Read1"], results=vres(width=2 * W, height=2 * H)), vx, frame=1))
    c.append(({"comp": comp([read(1), N("vfx_upscale", 1, ["Read1"], results=vres(width=2 * W, height=2 * H)), N("blur", 1, ["vfx_upscale1"], size=2), out("blur1")]),
               "frame": 4, "scale": 0.5}, vx))
    return c


def synthetic_deep(seed, w, h, most=3):
    """A deep picture with 0..most samples a pixel, in no particular depth order (as a file may hold them)."""
    rng = np.random.default_rng(seed)
    counts = rng.integers(0, most + 1, w * h)
    tot = int(counts.sum())
    s = np.zeros((tot, 6), np.float32)
    a = rng.random(tot).astype(np.float32) * 0.9
    s[:, :3] = rng.random((tot, 3)).astype(np.float32) * a[:, None]
    s[:, 3] = a
    s[:, 4] = rng.random(tot).astype(np.float32) * 4 + 0.5
    s[:, 5] = s[:, 4]
    return M.DP.sort_samples({"w": w, "h": h, "n": counts.astype(np.uint32), "s": s})


def scene_cases(sources):
    """3D (cards, shapes, projection, point clouds, near clipping), deep, and views."""
    N = node
    c = []
    cam = lambda i, **kw: N("camera3d", i, [], **kw)
    r3 = lambda i, sc, cm, bg=None, **kw: N("render3d", i, [sc, cm, bg], **kw)
    c.append(({"comp": comp([read(1), N("card3d", 1, ["Read1"], rotate=[10, 25, 3], translate=[0.05, -0.03, 0]),
                             cam(1, translate=[0.1, 0.05, 1.6], rotate=[-2, 3, 1]), r3(1, "card3d1", "camera3d1"), out("render3d1")])}, sources))
    c.append(({"comp": comp([read(2), N("geo3d", 1, [None], shape="sphere", divisions=13, translate=[0.31, 0.07, -0.42], uniform=0.71),
                             N("geo3d", 2, [None], shape="cube", rotate=[33, 41, 7], translate=[-0.37, -0.11, 0.13], scale=[0.61, 0.43, 0.52]),
                             N("geo3d", 3, ["Read2"], shape="cylinder", divisions=9, rotate=[71, 12, 5], translate=[0.03, 0.29, -0.2], uniform=0.4),
                             N("scene3d", 1, ["geo3d1", "geo3d2", "geo3d3", None]), cam(1, translate=[0.13, 0.21, 2.7], rotate=[-4.3, 2.9, 1.7], focal=41),
                             r3(1, "scene3d1", "camera3d1", "Read2", samples=1), out("render3d1")])}, sources))
    c.append(({"comp": comp([read(1), cam(1, translate=[0.02, 0.01, 2.1], rotate=[1.3, -2.1, 0.4]),
                             N("project3d", 1, ["Read1", "camera3d1"], faces="front"),
                             N("card3d", 1, ["project3d1"], rotate=[7, -31, 2], translate=[0.0, 0.03, -0.3], uniform=1.3),
                             N("geo3d", 1, ["project3d1"], shape="cylinder", divisions=11, rotate=[3, 17, 2], translate=[0.21, -0.1, 0.25], uniform=0.45),
                             N("scene3d", 1, ["card3d1", "geo3d1", None, None]), cam(2, translate=[0.47, 0.12, 1.9], rotate=[-3.1, 13.7, 0.8]),
                             r3(1, "scene3d1", "camera3d2", samples=3), out("render3d1")])}, sources))
    c.append(({"comp": comp([read(1), N("lumakeyer", 1, ["Read1"], write="depth.z", low=0.1), cam(1, translate=[0, 0, 1.5]),
                             N("pointcloud", 1, ["lumakeyer1", "camera3d1"], step=1, multiply=1.7, size=1.6),
                             cam(2, translate=[0.31, 0.2, 1.4], rotate=[-6.1, 9.3, 0.7]), r3(1, "pointcloud1", "camera3d2"), out("render3d1")])}, sources))
    c.append(({"comp": comp([read(1), N("lumakeyer", 1, ["Read1"], write="depth.z", low=0.1), cam(1, translate=[0, 0, 1.5]),
                             N("pointcloud", 1, ["lumakeyer1", "camera3d1"], step=3, mode="inverse", multiply=0.9, size=2.3),
                             cam(2, translate=[0.11, -0.2, 1.1], rotate=[3.1, -7.3, 0.2]), r3(1, "pointcloud1", "camera3d2", samples=2), out("render3d1")])}, sources))
    c.append(({"comp": comp([read(1), N("card3d", 1, ["Read1"], rotate=[0, 81.3, 0], uniform=3.1),
                             cam(1, translate=[0.13, 0.02, 0.37], rotate=[0.7, 1.1, 0], near=0.05), r3(1, "card3d1", "camera3d1"), out("render3d1")])}, sources))
    c.append(({"comp": comp([read(1), N("card3d", 1, ["Read1"], rotate=[5, 12, 0]), cam(1, translate=[0.1, 0, 1.9]), out("card3d1")])}, sources))
    c.append(({"comp": comp([read(1), N("card3d", 1, ["Read1"], rotate=[5, 12, 0]), cam(1, translate=[0.1, 0.03, 1.7], rotate=[1.1, 2.3, 0.3]),
                             r3(1, "card3d1", "camera3d1"), out("render3d1")], w=40, h=32), "scale": 0.5}, sources))
    # views
    vc = lambda nodes, **kw: dict(comp(nodes, **kw), format=dict(comp(nodes, **kw)["format"], views=["left", "right"]))
    stereo = [read(1), N("card3d", 1, ["Read1"], rotate=[3, 17, 1]), N("geo3d", 1, [None], shape="cube", uniform=0.3, translate=[0.2, 0.1, 0.4], rotate=[20, 30, 0]),
              N("scene3d", 1, ["card3d1", "geo3d1", None, None]),
              cam(1, translate=[0.03, 0.02, 1.8], interaxial=0.21, convergence=1.4), r3(1, "scene3d1", "camera3d1")]
    c.append(({"comp": vc(stereo + [N("anaglyph", 1, ["render3d1"]), out("anaglyph1")])}, sources))
    c.append(({"comp": vc(stereo + [N("anaglyph", 1, ["render3d1"], mode="grey"), out("anaglyph1")])}, sources))
    c.append(({"comp": vc(stereo + [N("sidebyside", 1, ["render3d1"]), out("sidebyside1")])}, sources))
    c.append(({"comp": vc(stereo + [N("sidebyside", 1, ["render3d1"], layout="over under"), out("sidebyside1")])}, sources))
    c.append(({"comp": vc(stereo + [out("render3d1")]), "view": "right"}, sources))
    c.append(({"comp": vc(stereo + [N("oneview", 1, ["render3d1"], view="right"), out("oneview1")])}, sources))
    per_view = {"Read1@0#left": src(11), "Read1@0#right": src(12), "Read2": src(2)}
    c.append(({"comp": vc([read(1, file="plate_%V.png"), read(2), N("joinviews", 1, ["Read1", "Read2", None, None]),
                           dict(N("grade", 1, ["joinviews1"]), split={"right": {"gain": 2.5}}), N("sidebyside", 1, ["grade1"]), out("sidebyside1")])}, per_view))
    c.append(({"comp": vc([read(1, file="plate_%v.png"), N("anaglyph", 1, ["Read1"]), out("anaglyph1")])},
              {"Read1@0#left": src(13), "Read1@0#right": src(14)}))
    # deep
    deep_a = synthetic_deep(21, 20, 10)
    c.append(({"comp": comp([N("deepread", 1, [], file="a.exr"), out("deepread1")]), "deep": {"deepread1": deep_a}}, {}))
    c.append(({"comp": comp([N("deepread", 1, [], file="a.exr"), N("deepcrop", 1, ["deepread1"], znear=1.2, zfar=3.1), out("deepcrop1")]), "deep": {"deepread1": deep_a}}, {}))
    c.append(({"comp": comp([N("deepread", 1, [], file="a.exr"), N("deepcrop", 1, ["deepread1"], znear=1.2, outside="on"), out("deepcrop1")]), "deep": {"deepread1": deep_a}}, {}))
    c.append(({"comp": comp([N("deepread", 1, [], file="a.exr"), out("deepread1")], w=40, h=30), "scale": 0.5, "deep": {"deepread1": synthetic_deep(22, 33, 25)}}, {}))
    c.append(({"comp": comp([read(1), read(2), N("addchannels", 1, ["Read1"], channels="depth.z", value=1.5),
                             N("deepfromimage", 1, ["addchannels1"]), N("deepfromimage", 2, ["Read2"], z=1.1),
                             N("deepread", 1, [], file="a.exr"), N("deepmerge", 1, ["deepfromimage1", "deepfromimage2", "deepread1", None]),
                             N("deepflatten", 1, ["deepmerge1"]), out("deepflatten1")]), "deep": {"deepread1": deep_a}}, sources))
    c.append(({"comp": comp([read(1), N("deepread", 1, [], file="a.exr"), N("deepfromimage", 1, ["Read1"], z=2.2),
                             N("deepholdout", 1, ["deepread1", "deepfromimage1"]), out("deepholdout1")]), "deep": {"deepread1": deep_a}}, sources))
    c.append(({"comp": comp([read(1), N("card3d", 1, ["Read1"], rotate=[5, 20, 0]), N("geo3d", 1, [None], shape="sphere", divisions=10, uniform=0.5, translate=[0.1, 0, -0.3]),
                             N("scene3d", 1, ["card3d1", "geo3d1", None, None]), cam(1, translate=[0, 0, 1.8]),
                             N("render3d", 1, ["scene3d1", "camera3d1", None]), N("deepread", 1, [], file="a.exr"),
                             N("deepmerge", 1, ["render3d1", "deepread1", None, None]), out("deepmerge1")]), "deep": {"deepread1": deep_a}}, sources))
    return c


def graph_cases(sources):
    """Graph organisation: Dots, groups (nested, disabled, with two inputs), backdrops and notes laid out flat, and
    expressions - the frame, maths, other nodes' numbers in the same graph and in the graphs around it, links."""
    N, c = node, []
    gin = lambda i, idx=0: {"id": f"Input{i}", "type": "group_input", "index": idx, "inputs": []}
    gout = lambda src_id: {"id": "GroupOutput1", "type": "group_output", "inputs": [src_id]}
    notes = [{"id": "Backdrop1", "type": "backdrop", "x": -40, "y": -40, "w": 400, "h": 300, "inputs": []},
             {"id": "StickyNote1", "type": "sticky", "text": "a note", "inputs": []}]
    c.append(({"comp": comp([read(1), read(2), N("dot", 1, ["Read1"]), N("dot", 2, ["dot1"]), merge(1, "dot2", "Read2"), *notes, out("Merge1")])}, sources))
    inner = {"id": "G2", "type": "group", "inputs": ["blur1"], "nodes": [
        gin(1), N("transform", 1, ["Input1"], translate=[0, 0], rotate=0,
                  expr={"translate": ["Grade1.gain * 3 - 1", "sin(frame) * 2"], "rotate": "frame * 5 + random(3) * 10"}),
        gout("transform1")]}
    outer = {"id": "G1", "type": "group", "inputs": ["Read1", "Read2"], "nodes": [
        gin(1, 0), gin(2, 1), N("blur", 1, ["Input1"], size=1, expr={"size": "clamp(frame / 2, 0, 3) + (frame % 3 == 1 ? 0.5 : 0)"}),
        inner, merge(1, "G2", "Input2", mix=0.5, expr={"mix": "smoothstep(0, 8, frame) * 0.5 + noise(frame * 0.3) * 0.1"}),
        {"id": "Dot1", "type": "dot", "inputs": ["Merge1"]}, gout("Dot1")]}
    grade = N("grade", 1, ["G1"], gain=1, expr={"gain": "pow(1.2, 2) - floor(2.7) / 4 + round(0.5) * 0.1"})
    grade["id"] = "Grade1"
    for f in (0, 4):
        c.append(({"comp": comp([read(1), read(2), outer, grade, out("Grade1")]), "frame": f}, sources))
    off = dict(outer, disable=True)
    c.append(({"comp": comp([read(1), read(2), off, out("G1")])}, sources))
    # Links (what the Parameters panel writes), vectors by component and a colour from another node.
    c.append(({"comp": comp([N("constant", 1, [], color=[0.2, 0.4, 0.6, 1]),
                             N("constant", 2, [], color=[0, 0, 0, 1], expr={"color": ["constant1.color.b * 0.5 + 0.1", "constant1.color", None, "mod(7, 4) / 3"]}),
                             N("transform", 1, ["constant2"], expr={"translate": ["'constant1'.color.g * 10 + 2", "max(1, 2, 3) - atan2(1, 1)"], "scale": ["1 + 0.1 * (frame > 2)", None]}),
                             out("transform1")]), "frame": 3}, {}))
    return c


class CompParity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not shutil.which("node"):
            raise unittest.SkipTest("node is not on PATH")
        cls.cases = cases()
        payload = []
        for spec_, sources in cls.cases:
            payload.append({"comp": spec_["comp"], "frame": spec_.get("frame", 0), "scale": spec_.get("scale", 1), "ocio": spec_.get("ocio"),
                            "view": spec_.get("view"),
                            "deep": {k: {"w": d["w"], "h": d["h"], "n": d["n"].tolist(), "s": d["s"].reshape(-1).tolist()} for k, d in (spec_.get("deep") or {}).items()},
                            "sources": {k: {"w": int(v.shape[1]), "h": int(v.shape[0]), "u8": v.reshape(-1).tolist(),
                                            "linear": next((n.get("colorspace") == "linear" for n in spec_["comp"]["nodes"] if n["id"] == k.split("@")[0]), False)}
                                        for k, v in sources.items()}})
        tmp = tempfile.mkdtemp()
        cls.tmp = tmp
        a, b = os.path.join(tmp, "cases.json"), os.path.join(tmp, "out.json")
        with open(a, "w") as fh:
            json.dump(payload, fh)
        subprocess.run(["node", os.path.join(HERE, "comp_parity.mjs"), a, b], check=True, cwd=ROOT)
        with open(b) as fh:
            cls.js = json.load(fh)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    def test_the_node_tables_agree(self):
        for t, d in M.NODE_TYPES.items():
            self.assertIn(t, self.js["table"])
            js = self.js["table"][t]
            self.assertEqual(js["inputs"], d["inputs"], t)
            self.assertEqual(sorted(js["params"]), sorted(d["params"]), t)
            for p, pd in d["params"].items():
                j = js["params"][p]
                self.assertEqual((j["kind"], j["def"], j["key"]), (pd["kind"], pd["def"], bool(pd.get("key"))), f"{t}.{p}")
                self.assertEqual((j["min"], j["max"]), (pd.get("min"), pd.get("max")), f"{t}.{p}")
                if pd.get("choices") is not None:
                    self.assertEqual(j["choices"], pd["choices"], f"{t}.{p}")
        self.assertEqual(sorted(self.js["table"]), sorted(M.NODE_TYPES))

    def test_the_python_api_names_nodes_as_the_page_does(self):
        import types
        pkg = types.ModuleType("_cpar")
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules.setdefault("_cpar", pkg)
        import importlib
        A = importlib.import_module("_cpar.comp_api")
        self.assertEqual({t: d["label"] for t, d in self.js["table"].items()}, A.LABELS)

    def test_every_case_renders_the_same(self):
        for i, (spec_, sources) in enumerate(self.cases):
            with self.subTest(i=i, nodes=[n["type"] + ":" + str(n.get("operation", "")) for n in spec_["comp"]["nodes"]]):
                c, _ = M.normalize(spec_["comp"])
                pics = {}
                for k, v in sources.items():
                    node = M.node_by_id(c, k.split("@")[0])
                    pics[k] = M.decode8(v, linear=(node or {}).get("colorspace") == "linear")
                deeps = spec_.get("deep") or {}
                img, ex = M.render_node(c, c["output"], spec_.get("frame", 0),
                                        lambda n, f: pics.get(f"{n['id']}@{f}#{n.get('__view')}", pics.get(f"{n['id']}@{f}", pics.get(n["id"]))), spec_.get("scale", 1),
                                        ocio=ocio_hook(spec_["ocio"]) if spec_.get("ocio") else None, channels=True,
                                        view=spec_.get("view"), deep_source=lambda n, f: deeps.get(n["id"]))
                js = self.js["pictures"][i]
                self.assertEqual((js["w"], js["h"]), (img.shape[1], img.shape[0]))
                ref = np.asarray(js["data"], np.float32).reshape(img.shape)
                diff = float(np.max(np.abs(ref - img))) if img.size else 0.0
                self.assertLess(diff, 2e-5, f"case {i}: max difference {diff}")
                self.assertEqual(list(js["ch"]), list(ex), f"case {i}: the extra channels")
                for k, v in ex.items():
                    # relative to the channel's size: a depth of 160 differs by float32's last places
                    d = float(np.max(np.abs(np.asarray(js["ch"][k], np.float32).reshape(v.shape) - v) / np.maximum(1, np.abs(v)))) if v.size else 0.0
                    if os.environ.get("COMP_PARITY_DEBUG") and d >= 2e-5:
                        a = np.asarray(js["ch"][k], np.float32).reshape(v.shape)
                        yx = np.unravel_index(np.argmax(np.abs(a - v)), v.shape)
                        print(i, k, yx, a[yx], v[yx])
                    self.assertLess(d, 2e-5, f"case {i}: channel {k} differs by {d}")


if __name__ == "__main__":
    unittest.main()
