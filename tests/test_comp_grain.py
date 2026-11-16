"""Comp's grain: a profile measured at full size by the comp_grain route, and what Degrain, Regrain and the
Grain node do with it on real-sized pictures (the page / numpy parity is in test_comp_parity.py).

    python -m unittest discover -s tests -p test_comp_grain.py
"""
import asyncio
import importlib
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer

W, H, F = 192, 128, 3


def _clean():
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float64)
    v = 0.15 + 0.7 * xs / (W - 1)                      # dark on the left, bright on the right
    return np.stack([v, v * 0.9 + 0.05 * np.sin(ys / 9), v * 0.8], axis=-1)


def _noisy(f):
    rng = np.random.default_rng(10 + f)
    c = _clean()
    k = 0.012 + 0.03 * c[..., :1]                      # grain stronger where it is brighter
    mono = rng.normal(0, 1, (H, W, 1))
    return c + k * (0.7 * mono + 0.3 * rng.normal(0, 1, (H, W, 3)))


def _save(path, rgb):
    from PIL import Image
    u8 = np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(np.concatenate([u8, np.full((H, W, 1), 255, np.uint8)], axis=2), "RGBA").save(path)


@unittest.skipIf(web is None, "needs aiohttp")
class CompGrain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.M = importlib.import_module(cls.pkg + ".comp_model")
        cls.X = cls.M._X
        cls.io = importlib.import_module(cls.pkg + ".comp_io")
        out = cls.dirs["output"]
        os.makedirs(os.path.join(out, "plate"), exist_ok=True)
        for f in range(F):
            _save(os.path.join(out, "plate", f"plate.{f:04d}.png"), _noisy(f))
        _save(os.path.join(out, "clean.png"), _clean())
        cls.comp_path = os.path.join(out, "grain.comp.json")
        with open(cls.comp_path, "w") as fh:
            fh.write("{}")

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def comp(self, *nodes, out="Output1"):
        return {"comp": 1, "format": {"width": W, "height": H, "fps": 24, "frames": F}, "output": out,
                "nodes": [{"id": "Plate", "type": "read", "file": "plate/plate.####.png", "inputs": []},
                          {"id": "Clean", "type": "read", "file": "clean.png", "inputs": []}, *nodes]}

    def render(self, comp, node="Output1", f=1):
        src = self.io.Sources(self.comp_path)
        try:
            return self.M.render_node(comp, node, f, src, 1.0)
        finally:
            src.close()

    def post(self, body):
        async def go():
            app = web.Application(client_max_size=1 << 28)
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as c:
                r = await c.post("/imageviewer/comp_grain", json=body)
                return r.status, await r.json()
        return asyncio.run(go())

    def test_a_regrain_measures_the_plates_own_grain_against_brightness(self):
        comp = self.comp({"id": "R", "type": "regrain", "inputs": ["Clean", "Plate", "Clean", None]},
                         {"id": "Output1", "type": "output", "inputs": ["R"]})
        st, res = self.post({"path": self.comp_path, "comp": comp, "node": "R", "frames": [0, 1, 2]})
        self.assertEqual(st, 200, res)
        p = res["profile"]
        self.assertEqual((res["width"], res["height"], res["frames"], p["frames"]), (W, H, [0, 1, 2], 3))
        q = self.X.profile_at(p, 1.0)
        g = q["total"][1]
        self.assertGreater(g[-1], g[0] * 1.5, g)            # stronger in the bright bins
        # The measured strength is near the grain's real spread (plate less clean, in the comp's linear) among
        # the pixels of each bin.
        clean = self.render(comp, "Clean")
        real = self.render(comp, "Plate")[..., 1] - clean[..., 1]
        guide = self.X.guide_luma(self.X.rgb_planes(clean))
        step = (p["hi"] - p["lo"]) / p["bins"]
        for k in (2, 4, 6):
            inside = (guide >= p["lo"] + k * step) & (guide < p["lo"] + (k + 1) * step)
            inside[:8], inside[-8:], inside[:, :8], inside[:, -8:] = False, False, False, False
            want = float(real[inside].std())
            self.assertLess(abs(q["total"][1][k] - want) / want, 0.2, (k, q["total"][1][k], want))
        self.assertGreater(p["corr"][0][1], 0.5)            # mostly mono grain

    def test_regrain_over_its_own_degrained_plate_gives_the_plate_back(self):
        comp = self.comp({"id": "R", "type": "regrain", "inputs": ["Clean", "Plate", "Clean", None]},
                         {"id": "Output1", "type": "output", "inputs": ["R"]})
        got = self.render(comp)
        want = self.render(comp, "Plate")
        self.assertLess(float(np.abs(got - want).max()), 1e-4)
        # A darker comp gets the grain at the strength of its own brightness: weaker.
        comp2 = self.comp({"id": "G", "type": "grade", "inputs": ["Clean"], "multiply": 0.3},
                          {"id": "R", "type": "regrain", "inputs": ["G", "Plate", "Clean", None], "fill": "synth", "detect": "off"},
                          {"id": "Output1", "type": "output", "inputs": ["R"]})
        dark = self.render(comp2) - self.render(comp2, "G")
        plate = want - self.render(comp, "Clean")
        self.assertLess(float(dark[..., 1].std()), float(plate[..., 1].std()))

    def test_new_areas_get_grain_made_again(self):
        # A grey square laid over the plate: there the comp differs from the degrained plate.
        nodes = [{"id": "K", "type": "constant", "inputs": [], "color": [0.4, 0.4, 0.4, 1]},
                 {"id": "C", "type": "crop", "inputs": ["K"], "topleft": [60, 30], "bottomright": [140, 100]},
                 {"id": "Mg", "type": "merge", "inputs": ["Clean", "C", None]}]
        for fill in ("scatter", "synth"):
            comp = self.comp(*nodes, {"id": "R", "type": "regrain", "inputs": ["Mg", "Plate", "Clean", None], "fill": fill},
                             {"id": "Output1", "type": "output", "inputs": ["R"]})
            new = self.render(dict(comp, nodes=[*comp["nodes"][:-2], dict(comp["nodes"][-2], output="new areas"), comp["nodes"][-1]]))
            self.assertGreater(float(new[60:70, 90:110, 0].mean()), 0.99)
            self.assertLess(float(new[5:15, 5:15, 0].max()), 0.01)
            g = self.render(comp) - self.render(comp, "Mg")
            inside = float(g[45:85, 75:125, 1].std())
            self.assertGreater(inside, 0.005, fill)           # grain in the square, not a clean patch

    def test_degrain_takes_most_of_the_grain_out(self):
        comp = self.comp({"id": "D", "type": "degrain", "inputs": ["Plate"]}, {"id": "Output1", "type": "output", "inputs": ["D"]})
        clean = self.render(comp, "Clean")
        before = float(np.sqrt(np.mean((self.render(comp, "Plate") - clean)[8:-8, 8:-8, :3] ** 2)))
        after = float(np.sqrt(np.mean((self.render(comp) - clean)[8:-8, 8:-8, :3] ** 2)))
        self.assertLess(after, before * 0.6, (before, after))
        st, res = self.post({"path": self.comp_path, "comp": comp, "node": "D", "frames": [1]})
        self.assertEqual(st, 200, res)
        comp["nodes"][2]["profile"] = res["profile"]
        stored = float(np.sqrt(np.mean((self.render(comp) - clean)[8:-8, 8:-8, :3] ** 2)))
        self.assertLess(stored, before * 0.6, (before, stored))
        comp["nodes"][2]["temporal"] = 0
        single = float(np.sqrt(np.mean((self.render(comp) - clean)[8:-8, 8:-8, :3] ** 2)))
        self.assertLess(stored, single)                      # the frames around it help

    def test_grain_with_a_profile_is_as_strong_as_measured(self):
        comp = self.comp({"id": "Gr", "type": "grain", "inputs": ["Clean", "Plate"]}, {"id": "Output1", "type": "output", "inputs": ["Gr"]})
        st, res = self.post({"path": self.comp_path, "comp": self.comp({"id": "R", "type": "regrain", "inputs": ["Clean", "Plate", "Clean", None]}),
                             "node": "R", "frames": [0]})
        self.assertEqual(st, 200, res)
        comp["nodes"][2].update(profile=res["profile"], amount=1)
        made = (self.render(comp) - self.render(comp, "Clean"))[8:-8, 8:-8]
        real = (self.render(comp, "Plate") - self.render(comp, "Clean"))[8:-8, 8:-8]
        ratio = float(made[..., 1].std() / real[..., 1].std())
        self.assertTrue(0.7 < ratio < 1.3, ratio)

    def test_the_route_says_what_is_missing(self):
        comp = self.comp({"id": "R", "type": "regrain", "inputs": ["Clean", None, None, None]})
        st, res = self.post({"path": self.comp_path, "comp": comp, "node": "R", "frames": [0]})
        self.assertEqual(st, 400)
        self.assertIn("plate", res.get("error", ""))
        st, _ = self.post({"path": self.comp_path, "comp": comp, "node": "Plate", "frames": [0]})
        self.assertEqual(st, 400)
        st, _ = self.post({"path": self.comp_path, "comp": comp, "node": "R", "frames": "all"})
        self.assertEqual(st, 400)


if __name__ == "__main__":
    unittest.main()
