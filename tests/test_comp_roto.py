"""Comp's Roto node renders the viewer's roto data through roto_raster, as the ImageViewerRoto node does."""
import importlib.util
import os
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "src", name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


M = _load("comp_model")
R = _load("roto_raster")

SQUARE = [{"x": 0.25, "y": 0.25}, {"x": 0.75, "y": 0.25}, {"x": 0.75, "y": 0.75}, {"x": 0.25, "y": 0.75}]
MOVED = [{"x": p["x"] - 0.2, "y": p["y"]} for p in SQUARE]
ROTO = {"version": 1, "global": {"invert": False, "blur": 0, "dilate": 0, "feather": 0},
        "layers": [{"id": "a", "name": "Shape", "visible": True, "mode": "union", "points": SQUARE,
                    "keyframes": {"0": SQUARE, "10": MOVED}}]}


def comp(roto, src=None):
    nodes = [{"id": "Roto1", "type": "roto", "x": 0, "y": 0, "inputs": [src], "roto": roto},
             {"id": "Output1", "type": "output", "x": 0, "y": 0, "inputs": ["Roto1"]}]
    if src:
        nodes.append({"id": src, "type": "constant", "x": 0, "y": 0, "inputs": [], "color": [1, 0, 0, 1]})
    return {"comp": 1, "format": {"width": 40, "height": 20, "fps": 24, "frames": 20}, "nodes": nodes, "output": "Output1"}


class CompRoto(unittest.TestCase):
    def test_the_matte_is_roto_rasters_at_that_frame(self):
        for f in (0, 4, 10, 15):
            img = M.render_node(comp(ROTO), "Roto1", f)
            want = R.rasterize(ROTO, 40, 20, 20)[f]
            np.testing.assert_allclose(img[..., 3], want, atol=1e-6)
            np.testing.assert_allclose(img[..., 0], want, atol=1e-6)

    def test_the_shape_moves_with_its_keys_and_cuts_its_input(self):
        a = M.render_node(comp(ROTO, "Constant1"), "Roto1", 0)
        b = M.render_node(comp(ROTO, "Constant1"), "Roto1", 10)
        self.assertGreater(a[10, 25, 0], 0.99)          # inside the square at 0
        self.assertLess(b[10, 25, 0], 0.01)             # moved off it at 10
        self.assertGreater(b[10, 8, 0], 0.99)
        self.assertEqual(float(a[10, 25, 1]), 0.0)      # the input's colour, cut by the matte

    def test_no_shapes_is_an_empty_matte(self):
        for roto in (None, {"layers": []}):
            self.assertEqual(float(M.render_node(comp(roto), "Roto1", 0).sum()), 0.0)


if __name__ == "__main__":
    unittest.main()
