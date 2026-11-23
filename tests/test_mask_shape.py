"""The shared mask shape: src/mask_shape.py flattens every shape exactly as js/imageViewer_maskShape.js draws it,
and a B-spline roto shape renders as its curve."""
import importlib.util
import json
import os
import random
import shutil
import subprocess
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "src", name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


MS = _load("mask_shape")
R = _load("roto_raster")


def _cases():
    rnd = random.Random(7)
    out = []
    for i in range(40):
        n = rnd.randint(2, 9)
        pts = []
        for _ in range(n):
            x, y = rnd.uniform(0, 200), rnd.uniform(0, 120)
            if rnd.random() < 0.5:
                pts.append([x, y])
            else:
                hx, hy = rnd.uniform(-30, 30), rnd.uniform(-30, 30)
                pts.append([x, y, x - hx, y - hy, x + hx, y + hy])
        out.append({"pts": pts, "kind": "bspline" if i % 2 else "bezier", "closed": i % 3 != 0,
                    "scale": 1 if i % 4 else 640})
    return out


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class Parity(unittest.TestCase):
    def test_python_flattens_as_the_page_draws(self):
        cases = _cases()
        js = json.loads(subprocess.run(["node", os.path.join(ROOT, "tests", "mask_shape_parity.mjs")],
                                       input=json.dumps(cases), capture_output=True, text=True, check=True).stdout)
        for c, want in zip(cases, js):
            got = MS.shape_polygon([MS.from_arr(p) for p in c["pts"]], c["kind"], c["closed"], c["scale"])
            self.assertEqual(len(got), len(want), c)
            for a, b in zip(got, want):
                self.assertAlmostEqual(a[0], b[0], places=9)
                self.assertAlmostEqual(a[1], b[1], places=9)


SQUARE = [{"x": 0.25, "y": 0.25}, {"x": 0.75, "y": 0.25}, {"x": 0.75, "y": 0.75}, {"x": 0.25, "y": 0.75}]


def _roto(shape):
    return {"version": 1, "global": {"invert": False, "blur": 0, "dilate": 0, "feather": 0},
            "layers": [{"id": "a", "name": "Shape", "visible": True, "mode": "union", "shape": shape,
                        "points": SQUARE, "keyframes": {}}]}


class RotoBSpline(unittest.TestCase):
    def test_a_b_spline_shape_is_rounder_and_inside_its_control_points(self):
        sq = R.rasterize(_roto("bezier"), 80, 80, 1)[0]
        bs = R.rasterize(_roto("bspline"), 80, 80, 1)[0]
        self.assertGreater(sq.sum(), bs.sum())                     # rounded corners cover less
        self.assertLess(bs[21, 21], 0.01)                          # a corner of the square is outside it
        self.assertGreater(bs[40, 40], 0.99)                       # the middle is inside
        self.assertTrue(np.all(bs <= sq + 1e-6))                   # never outside its control polygon

    def test_unknown_shape_kinds_render_as_before(self):
        a = R.rasterize(_roto(None), 40, 40, 1)[0]
        b = R.rasterize(_roto("bezier"), 40, 40, 1)[0]
        self.assertTrue(np.array_equal(a, b))


if __name__ == "__main__":
    unittest.main()
