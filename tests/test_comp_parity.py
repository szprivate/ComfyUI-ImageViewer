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
    c.extend(mask_cases(sources))
    c.extend(box_cases(sources))
    c.extend(warp_cases(sources))
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

    def test_every_case_renders_the_same(self):
        for i, (spec_, sources) in enumerate(self.cases):
            with self.subTest(i=i, nodes=[n["type"] + ":" + str(n.get("operation", "")) for n in spec_["comp"]["nodes"]]):
                c, _ = M.normalize(spec_["comp"])
                pics = {}
                for k, v in sources.items():
                    node = M.node_by_id(c, k.split("@")[0])
                    pics[k] = M.decode8(v, linear=(node or {}).get("colorspace") == "linear")
                img, ex = M.render_node(c, c["output"], spec_.get("frame", 0),
                                        lambda n, f: pics.get(f"{n['id']}@{f}", pics.get(n["id"])), spec_.get("scale", 1),
                                        ocio=ocio_hook(spec_["ocio"]) if spec_.get("ocio") else None, channels=True)
                js = self.js["pictures"][i]
                self.assertEqual((js["w"], js["h"]), (img.shape[1], img.shape[0]))
                ref = np.asarray(js["data"], np.float32).reshape(img.shape)
                diff = float(np.max(np.abs(ref - img))) if img.size else 0.0
                self.assertLess(diff, 2e-5, f"case {i}: max difference {diff}")
                self.assertEqual(list(js["ch"]), list(ex), f"case {i}: the extra channels")
                for k, v in ex.items():
                    d = float(np.max(np.abs(np.asarray(js["ch"][k], np.float32).reshape(v.shape) - v))) if v.size else 0.0
                    self.assertLess(d, 2e-5, f"case {i}: channel {k} differs by {d}")


if __name__ == "__main__":
    unittest.main()
