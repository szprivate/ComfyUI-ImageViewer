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
    c.append(({"comp": comp([read(1), {"id": "Blur1", "type": "blur", "inputs": ["Read1"], "size": 6}, out("Blur1")]), "scale": 0.5}, sources))
    for fit in ("none", "fit"):   # at a proxy scale "none" keeps the picture's size in the comp
        c.append(({"comp": comp([read(3, fit=fit), out("Read3")], w=40, h=24), "scale": 0.5}, {"Read3": s3}))
    straight = {"Read1": src(9, alpha=False)}
    c.append(({"comp": comp([read(1, colorspace="linear"), out("Read1")])}, straight))
    c.extend(new_node_cases(sources))
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
    shapes = [{"pts": [[2, 2], [24, 3.5], [20, 15], [5, 12]], "smooth": True, "feather": 1.5},
              {"pts": [[8, 5], [16, 5], [12, 11]], "smooth": False, "mode": "subtract"},
              {"pts": [[1, 1], [6, 1], [6, 6]], "smooth": False,
               "keys": [{"f": 0, "pts": [[1, 1], [6, 1], [6, 6]]}, {"f": 10, "pts": [[11, 6], [26, 1], [16, 16]]}]}]
    c.append(one(node("roto", 1, [None], shapes=shapes), frame=4))
    c.append(one(node("roto", 1, ["Read1"], shapes=shapes), frame=7, scale=0.5))
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
               {"width": 12, "height": 20, "resize": "fill", "turn": "on", "center": "off", "black_outside": "off"},
               {"width": 25, "height": 9, "resize": "height", "flip": "on"}, {"width": 18, "height": 10, "resize": "none"}):
        c.append(one(node("reformat", 1, ["Read1"], **kw)))
    c.append(({"comp": comp([read(1), node("reformat", 1, ["Read1"], width=20, height=12, turn="on"), out("reformat1")], w=40, h=24), "scale": 0.5}, sources))
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
                img = M.render_node(c, c["output"], spec_.get("frame", 0),
                                    lambda n, f: pics.get(f"{n['id']}@{f}", pics.get(n["id"])), spec_.get("scale", 1),
                                    ocio=ocio_hook(spec_["ocio"]) if spec_.get("ocio") else None)
                js = self.js["pictures"][i]
                self.assertEqual((js["w"], js["h"]), (img.shape[1], img.shape[0]))
                ref = np.asarray(js["data"], np.float32).reshape(img.shape)
                diff = float(np.max(np.abs(ref - img))) if img.size else 0.0
                self.assertLess(diff, 2e-5, f"case {i}: max difference {diff}")


if __name__ == "__main__":
    unittest.main()
