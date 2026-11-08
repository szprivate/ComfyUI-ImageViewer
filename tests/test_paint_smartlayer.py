"""Smart layers on the server: the agent's ops (add_layer from a file, transform, distort, resize, fill,
rasterize), the .ora keeping the source, the .psd getting pixels, and the routes moving a source.

    python -m unittest discover -s tests -p test_paint_smartlayer.py
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_ops as O, paint_smartlayer as SL  # noqa: E402


def detailed(w, h, seed=3):
    rng = np.random.default_rng(seed)
    a = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
    a[..., 3] = 255
    return a


def doc_with_smart(big, W=300, H=200):
    d = P.PaintDoc(W, H)
    d.add_pixel_layer(np.full((H, W, 4), 255, np.uint8), "bg")
    said = O.apply_ops(d, [{"op": "add_layer", "file": "x", "name": "photo", "fit": "contain"}],
                       read_image=lambda f: big)
    return d, d.layers[-1], said


class SmartOps(unittest.TestCase):
    def test_a_picture_from_a_file_is_a_smart_layer_with_its_whole_source(self):
        big = detailed(1200, 800)
        d, L, said = doc_with_smart(big)
        self.assertIn("smart layer", said[0])
        self.assertEqual((L["smart"]["sw"], L["smart"]["sh"]), (1200, 800))
        self.assertEqual(d.sources[L["smart"]["src"]].shape, (800, 1200, 4))
        self.assertEqual(d.px[L["id"]].shape, (200, 300, 4))
        self.assertEqual(P.outline(d)["layers"][0]["smart"]["source"], [1200, 800])

    def test_smart_false_makes_a_plain_layer(self):
        d = P.PaintDoc(100, 80)
        O.apply_ops(d, [{"op": "add_layer", "file": "x", "smart": False, "fit": "contain"}],
                    read_image=lambda f: detailed(400, 320))
        self.assertNotIn("smart", d.layers[-1])
        self.assertEqual(d.sources, {})

    def test_scaling_down_and_up_again_keeps_the_detail(self):
        big = detailed(1200, 800)
        d, L, _ = doc_with_smart(big)
        before = d.px[L["id"]].copy()
        said = O.apply_ops(d, [{"op": "transform", "scale": 0.1}, {"op": "transform", "scale": 10}], read_image=None)
        self.assertTrue(all("smart" in s for s in said), said)
        self.assertEqual({k: L[k] for k in "xywh"}, {"x": 0, "y": 0, "w": 300, "h": 200})
        diff = np.abs(d.px[L["id"]].astype(int) - before.astype(int)).max()
        self.assertLessEqual(diff, 2, "drawn again from the source, not from the shrunk pixels")
        # A plain layer does lose it.
        d2 = P.PaintDoc(300, 200)
        d2.add_pixel_layer(before.copy(), "plain")
        O.apply_ops(d2, [{"op": "transform", "scale": 0.1}, {"op": "transform", "scale": 10}], read_image=None)
        P2 = d2.px[d2.layers[-1]["id"]]
        h, w = min(P2.shape[0], 200), min(P2.shape[1], 300)
        self.assertGreater(np.abs(P2[:h, :w].astype(int) - before[:h, :w].astype(int)).mean(), 5)

    def test_distort_and_resize_stay_smart(self):
        d, L, _ = doc_with_smart(detailed(600, 400))
        O.apply_ops(d, [{"op": "distort", "corners": [[10, 10], [280, 30], [260, 190], [20, 170]]}], read_image=None)
        self.assertIn("smart", L)
        self.assertEqual(len(L["smart"]["m"]), 9)
        self.assertNotEqual(L["smart"]["m"][6], 0)            # a perspective
        O.apply_ops(d, [{"op": "resize", "scale": 2}], read_image=None)
        self.assertEqual((d.w, d.h), (600, 400))
        self.assertIn("smart", L)
        self.assertEqual((L["x"], L["y"]), (20, 20))
        self.assertEqual(d.px[L["id"]].shape[:2], (L["h"], L["w"]))

    def test_painting_into_it_makes_a_plain_layer_and_says_so(self):
        d, L, _ = doc_with_smart(detailed(600, 400))
        said = O.apply_ops(d, [{"op": "select", "mode": "rect", "x": 0, "y": 0, "w": 50, "h": 50},
                               {"op": "fill", "layer": "photo", "color": "red"}], read_image=None)
        self.assertNotIn("smart", L)
        self.assertIn("rasterized", said[-1])
        self.assertEqual(tuple(d.px[L["id"]][5, 5][:3]), (255, 0, 0))

    def test_rasterize(self):
        d, L, _ = doc_with_smart(detailed(600, 400))
        px = d.px[L["id"]].copy()
        said = O.apply_ops(d, [{"op": "rasterize", "layer": "photo"}], read_image=None)
        self.assertIn("rasterized", said[0])
        self.assertNotIn("smart", L)
        self.assertTrue(np.array_equal(d.px[L["id"]], px))
        self.assertIn("nothing to do", O.apply_ops(d, [{"op": "rasterize", "layer": "photo"}], read_image=None)[0])


class SmartFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ora_keeps_the_source_and_psd_gets_pixels(self):
        big = detailed(900, 600)
        d, L, _ = doc_with_smart(big)
        O.apply_ops(d, [{"op": "transform", "scale": 0.25}], read_image=None)
        path = os.path.join(self.tmp, "a.ora")
        P.write_ora(path, d)
        back = P.read_ora(path)
        BL = back.layers[-1]
        self.assertEqual(BL["smart"]["sw"], 900)
        self.assertTrue(np.array_equal(back.sources[BL["smart"]["src"]], big))
        self.assertTrue(np.array_equal(back.px[BL["id"]], d.px[L["id"]]))
        # Scaled up again after the round trip: still from the source.
        O.apply_ops(back, [{"op": "transform", "layer": BL["name"], "scale": 4}], read_image=None)
        self.assertEqual((BL["w"], BL["h"]), (300, 200))
        # .psd: the pixels as drawn, a note that the source stays behind.
        psd = os.path.join(self.tmp, "a.psd")
        notes = P.write_psd(psd, back) or []
        allnotes = " ".join(list(notes) + list(getattr(back, "notes", []))).lower()
        self.assertIn("smart", allnotes)
        self.assertNotIn("smart", P.read_psd(psd).layers[-1])

    def test_a_missing_source_in_an_ora_is_a_plain_layer_with_a_note(self):
        import zipfile
        d, L, _ = doc_with_smart(detailed(400, 300))
        path = os.path.join(self.tmp, "b.ora")
        P.write_ora(path, d)
        cut = os.path.join(self.tmp, "c.ora")
        with zipfile.ZipFile(path) as zi, zipfile.ZipFile(cut, "w") as zo:
            for it in zi.infolist():
                if not it.filename.startswith("smart/"):
                    zo.writestr(it, zi.read(it.filename))
        back = P.read_ora(cut)
        self.assertNotIn("smart", back.layers[-1])
        self.assertTrue(any("smart" in n for n in back.notes), back.notes)


try:
    from test_edit_takes import _load, web  # noqa: E402
except Exception:  # pragma: no cover
    web = None
if web is not None:
    from aiohttp.test_utils import TestClient, TestServer


@unittest.skipIf(web is None, "needs aiohttp")
class SmartRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import importlib
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.P = importlib.import_module(cls.pkg + ".paint_io")

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_c(self, fn):
        async def go():
            from aiohttp import web as W
            app = W.Application(client_max_size=1 << 28)
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    def test_a_source_is_staged_once_kept_after_and_served_back(self):
        src = detailed(120, 80, 9)

        async def go(c):
            r = await c.post("/imageviewer/paint/open", json={"new": {"w": 40, "h": 30, "name": "sm"}})
            d = await r.json()
            tok, meta = d["token"], d["doc"]
            bg = meta["layers"][0]
            m = SL.mul3(SL.move3(2, 3), SL.scale3(0.25))
            Ls = {"id": "lsm", "name": "photo", "kind": "pixel", "x": 2, "y": 3, "w": 30, "h": 20,
                  "smart": {"src": "s1", "sw": 120, "sh": 80, "m": SL.mul3(SL.move3(-2, -3), m)}}
            drawn = np.zeros((20, 30, 4), np.uint8)
            await c.post("/imageviewer/paint/stage", params={"token": tok, "part": "layer:lsm"}, data=drawn.tobytes())
            r = await c.post("/imageviewer/paint/stage", params={"token": tok, "part": "src:s1"}, data=src.tobytes())
            self.assertEqual(r.status, 200, await r.text())
            meta2 = {**meta, "layers": [bg, Ls]}
            r = await c.post("/imageviewer/paint/save", json={"token": tok, "meta": meta2, "keep": [bg["id"]]})
            s = await r.json()
            self.assertEqual(r.status, 200, s)
            back = self.P.read_ora(s["path"])
            self.assertTrue(np.array_equal(back.sources["s1"], src))
            self.assertEqual(back.layers[-1]["smart"]["src"], "s1")
            # Saved again keeping the layer: the source is not sent again and stays.
            r = await c.post("/imageviewer/paint/save", json={"token": tok, "meta": meta2, "keep": [bg["id"], "lsm"]})
            self.assertEqual(r.status, 200, await r.text())
            self.assertTrue(np.array_equal(self.P.read_ora(s["path"]).sources["s1"], src))
            r = await c.get("/imageviewer/paint/px", params={"token": tok, "src": "s1"})
            self.assertEqual(r.status, 200)
            self.assertEqual(await r.read(), src.tobytes())
            # A smart layer whose source never came is a plain one.
            Lx = {**Ls, "id": "lx", "smart": {**Ls["smart"], "src": "nope"}}
            await c.post("/imageviewer/paint/stage", params={"token": tok, "part": "layer:lx"}, data=drawn.tobytes())
            r = await c.post("/imageviewer/paint/save", json={"token": tok, "meta": {**meta2, "layers": [bg, Ls, Lx]},
                                                              "keep": [bg["id"], "lsm"]})
            self.assertEqual(r.status, 200, await r.text())
            back = self.P.read_ora(s["path"])
            self.assertEqual([("smart" in L) for L in back.layers], [False, True, False])
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
