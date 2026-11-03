"""Paint draws the page and the server draws the files with ONE arithmetic (paint_math.py and
js/bEpicViewer_paintData.js): the same documents - every blend mode, every adjustment, masks,
opacity, layers off the canvas - composited by both must come out the same, pixel for pixel
(1 level of 255 is allowed where float rounding in pow / sqrt differs).

Run: python -m unittest tests.test_paint_parity   (needs node and numpy; skipped without)
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_math as M, np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
b64 = lambda a: base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def rnd_doc(seed, blends, adjust=None, size=(37, 29)):
    rng = np.random.default_rng(seed)
    W, H = size
    d = P.PaintDoc(W, H, f"case{seed}")
    bg = rng.integers(0, 256, (H, W, 4), dtype=np.uint8)
    bg[..., 3] = rng.choice([0, 128, 255, 255, 255], (H, W)).astype(np.uint8)
    d.add_pixel_layer(bg, "bg")
    for i, mode in enumerate(blends):
        w, h = int(rng.integers(8, W + 10)), int(rng.integers(8, H + 10))
        px = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
        L = d.add_pixel_layer(px, f"l{i}", int(rng.integers(-8, W - 4)), int(rng.integers(-8, H - 4)), blend=mode,
                              opacity=float(rng.choice([1.0, 0.73, 0.5])))
        if i % 2 == 0:
            mw, mh = int(rng.integers(5, W)), int(rng.integers(5, H))
            L["mask"] = {"enabled": True, "x": int(rng.integers(-3, 10)), "y": int(rng.integers(-3, 10)), "w": mw, "h": mh,
                         "fill": int(rng.choice([0, 255]))}
            d.masks[L["id"]] = rng.integers(0, 256, (mh, mw), dtype=np.uint8)
    for kind, params in (adjust or []):
        L = d.add_adjust_layer(kind, params, opacity=0.8)
        L["mask"] = {"enabled": True, "x": 2, "y": 3, "w": W - 5, "h": H - 6, "fill": 255}
        d.masks[L["id"]] = rng.integers(0, 256, (H - 6, W - 5), dtype=np.uint8)
    return d


ADJ = [("levels", {"in_black": 20, "in_white": 230, "gamma": 1.4, "out_black": 10, "out_white": 240}),
       ("curves", {"rgb": [[0, 10], [80, 120], [200, 180], [255, 250]], "g": [[0, 0], [128, 100], [255, 255]]}),
       ("brightness_contrast", {"brightness": 25, "contrast": 40}),
       ("brightness_contrast", {"brightness": -30, "contrast": -50}),
       ("exposure", {"exposure": 0.7, "offset": 0.01, "gamma": 1.2}),
       ("hue_saturation", {"hue": 77, "saturation": 35, "lightness": -20}),
       ("hue_saturation", {"hue": -140, "saturation": -60, "lightness": 30}),
       ("grade", {"lift": [0.05, 0, -0.03], "gamma": [1.1, 0.9, 1], "gain": [1.2, 1, 0.8]}),
       ("invert", {}), ("threshold", {"level": 100})]


@unittest.skipIf(shutil.which("node") is None, "needs node")
class PaintParity(unittest.TestCase):
    def run_node(self, cases):
        job = {"cases": {}}
        for name, d in cases.items():
            job["cases"][name] = {"doc": d.meta, "px": {k: b64(v) for k, v in d.px.items()},
                                  "masks": {k: b64(v) for k, v in d.masks.items()},
                                  "filters": getattr(d, "filters", None)}
        with tempfile.TemporaryDirectory() as tmp:
            a, b = os.path.join(tmp, "in.json"), os.path.join(tmp, "out.json")
            with open(a, "w") as f:
                json.dump(job, f)
            subprocess.run(["node", os.path.join(HERE, "paint_parity.mjs"), a, b], check=True)
            with open(b) as f:
                return json.load(f)

    def same(self, py, js_b64, shape, what, tol=1):
        js = np.frombuffer(base64.b64decode(js_b64), np.uint8).reshape(shape)
        diff = np.abs(py.astype(int) - js.astype(int))
        if py.ndim == 3:
            seen = (py[..., 3] > 0) | (js[..., 3] > 0)
            diff = np.where(seen[..., None], diff, 0)
        self.assertLessEqual(int(diff.max()), tol, f"{what}: max difference {diff.max()} at {np.unravel_index(diff.argmax(), diff.shape)}")
        return diff

    def test_every_blend_mode_with_masks_and_opacity(self):
        cases = {}
        for k, mode in enumerate(M.BLEND_MODES):
            cases[mode] = rnd_doc(10 + k, [mode, mode, "normal"])
        got = self.run_node(cases)
        for name, d in cases.items():
            self.same(P.composite(d), got[name]["composite"], (d.h, d.w, 4), name)

    def test_every_adjustment(self):
        cases = {f"{k}_{i}": rnd_doc(50 + i, ["multiply"], [(k, p)]) for i, (k, p) in enumerate(ADJ)}
        got = self.run_node(cases)
        for name, d in cases.items():
            self.same(P.composite(d), got[name]["composite"], (d.h, d.w, 4), name)

    def test_a_stack_of_everything(self):
        d = rnd_doc(99, list(M.BLEND_MODES), ADJ[:6], size=(61, 47))
        d.layers[3]["visible"] = False
        got = self.run_node({"all": d})
        self.same(P.composite(d), got["all"]["composite"], (d.h, d.w, 4), "all")

    def test_filters_and_selection_shapes(self):
        d = rnd_doc(7, [])
        L = d.layers[0]
        poly = [[2.3, 1.1], [30.5, 6.2], [20.2, 27.7], [4.9, 18.4], [15, 12]]
        d.filters = {"blur": 3.5, "radius": 2.0, "amount": 1.3, "polygon": poly}
        got = self.run_node({"f": d})["f"]
        px = d.px[L["id"]]
        self.same(M.blur_pixels(px, 3.5), got["blur"], px.shape, "blur", tol=1)
        self.same(M.sharpen_pixels(px, 2.0, 1.3), got["sharpen"], px.shape, "sharpen", tol=1)
        h, w = px.shape[:2]
        self.same(M.feather_mask(M.ellipse_mask(w, h, 3, 4, w * 0.6, h * 0.5), 3.5), got["feather"], (h, w), "feather")
        self.same(M.polygon_mask(w, h, poly), got["polygon"], (h, w), "polygon", tol=0)
        self.same(M.ellipse_mask(w, h, 2.5, 3.2, w * 0.7, h * 0.6), got["ellipse"], (h, w), "ellipse", tol=0)


if __name__ == "__main__":
    unittest.main()
