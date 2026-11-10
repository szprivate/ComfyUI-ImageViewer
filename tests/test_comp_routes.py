"""Comp's routes (comp_routes.py) through the REAL viewer_api in a private aiohttp app: a new comp by the export
rule, read and save, a Read's pixels as the preview gets them (shrunk, float16), the fences, and a render to a
PNG sequence and to a film by the export rule.

    python -m unittest discover -s tests -p test_comp_routes.py
"""
import asyncio
import gzip
import importlib
import os
import shutil
import sys
import tempfile
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer

try:
    import av  # noqa: F401
except ImportError:
    av = None


@unittest.skipIf(web is None, "needs aiohttp")
class CompRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.M = importlib.import_module(cls.pkg + ".comp_model")
        cls.outside = tempfile.mkdtemp()
        from PIL import Image
        cls.png = os.path.join(cls.dirs["output"], "plate.png")
        a = np.zeros((40, 60, 4), np.uint8)
        a[..., 0] = 255
        a[..., 3] = 255
        a[:, 30:, 3] = 0
        Image.fromarray(a, "RGBA").save(cls.png)

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.outside, ignore_errors=True)

    def run_c(self, fn):
        async def go():
            app = web.Application(client_max_size=1 << 28)
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    @staticmethod
    async def j(c, route, body):
        r = await c.post(route, json=body)
        return r.status, await r.json()

    def comp_with_plate(self, frames=3):
        return {"comp": 1, "format": {"width": 60, "height": 40, "fps": 24, "frames": frames}, "output": "Output1",
                "nodes": [{"id": "Constant1", "type": "constant", "color": [0, 0, 1, 1], "inputs": []},
                          {"id": "Read1", "type": "read", "file": "plate.png", "inputs": []},
                          {"id": "Merge1", "type": "merge", "inputs": ["Constant1", "Read1", None]},
                          {"id": "Output1", "type": "output", "inputs": ["Merge1"]}]}

    def test_new_read_and_save(self):
        async def go(c):
            st, d = await self.j(c, "/imageviewer/comp_new", {"name": "my comp", "width": 640, "height": 360})
            self.assertEqual(st, 200, d)
            self.assertTrue(d["path"].endswith("my_comp_v001.comp.json"), d["path"])
            self.assertIn(os.path.join("imageviewer", "comps"), d["path"])
            self.assertEqual(d["comp"]["format"]["width"], 640)
            st, d2 = await self.j(c, "/imageviewer/comp_new", {"name": "my comp"})
            self.assertTrue(d2["path"].endswith("my_comp_v002.comp.json"), d2["path"])
            r = await c.get("/imageviewer/comp", params={"path": d["path"]})
            got = await r.json()
            self.assertEqual(r.status, 200, got)
            self.assertEqual(got["comp"]["output"], "Output1")
            got["comp"]["format"]["frames"] = 99
            st, s = await self.j(c, "/imageviewer/comp", {"path": d["path"], "comp": got["comp"]})
            self.assertEqual(st, 200, s)
            r = await c.get("/imageviewer/comp", params={"path": d["path"]})
            self.assertEqual((await r.json())["comp"]["format"]["frames"], 99)
        self.run_c(go)

    def test_fences(self):
        async def go(c):
            bad = os.path.join(self.outside, "x.comp.json")
            st, _ = await self.j(c, "/imageviewer/comp", {"path": bad, "comp": self.M.new_comp()})
            self.assertEqual(st, 403)
            self.assertFalse(os.path.exists(bad))
            st, _ = await self.j(c, "/imageviewer/comp", {"path": os.path.join(self.dirs["output"], "x.json"),
                                                          "comp": self.M.new_comp()})
            self.assertEqual(st, 400)
            # a Read may name only media in the allowed folders
            secret = os.path.join(self.dirs["output"], "notes.txt")
            with open(secret, "w") as fh:
                fh.write("private")
            r = await c.get("/imageviewer/comp_pixels", params={"file": secret})
            self.assertEqual(r.status, 403)
            r = await c.get("/imageviewer/comp_pixels", params={"file": os.path.join(self.outside, "a.png")})
            self.assertEqual(r.status, 403)
            r = await c.post("/imageviewer/comp_new", data="{}", headers={"Content-Type": "text/plain"})
            self.assertEqual(r.status, 403)
        self.run_c(go)

    def test_pixels_of_a_read(self):
        async def go(c):
            comp_path = os.path.join(self.dirs["output"], "p.comp.json")
            r = await c.get("/imageviewer/comp_source", params={"file": "plate.png", "comp": comp_path})
            info = await r.json()
            self.assertEqual((r.status, info["kind"]), (200, "still"), info)
            r = await c.get("/imageviewer/comp_pixels", params={"file": "plate.png", "comp": comp_path, "max": 30})
            self.assertEqual(r.status, 200)
            w, h = int(r.headers["X-Comp-W"]), int(r.headers["X-Comp-H"])
            self.assertEqual((w, h, r.headers["X-Comp-OW"], r.headers["X-Comp-OH"]), (30, 20, "60", "40"))
            px = np.frombuffer(gzip.decompress(await r.read()), "<f2").reshape(h, w, 4).astype(np.float32)
            self.assertAlmostEqual(float(px[5, 5, 0]), 1.0, places=2)    # red, premultiplied
            self.assertAlmostEqual(float(px[5, 25, 3]), 0.0, places=3)   # the transparent half
        self.run_c(go)

    @unittest.skipIf(importlib.util.find_spec("PyOpenColorIO") is None, "needs PyOpenColorIO")
    def test_ocio_config_luts_reads_nodes_and_a_display_render(self):
        from PIL import Image

        async def go(c):
            r = await c.get("/imageviewer/comp_ocio")
            info = await r.json()
            self.assertTrue(info["available"], info)
            names = [x["name"] for x in info["colorspaces"]]
            self.assertIn(info["working"], names)
            self.assertTrue(info["displays"] and info["displays"][0]["views"])
            # A linear-to-linear transform comes as a matrix, anything else as a 3D LUT behind a shaper.
            lin = next(n for n in names if "linear" in n.lower() and "rec.709" in n.lower())
            r = await c.get("/imageviewer/comp_lut", params={"src": "", "dst": lin})
            self.assertEqual((r.status, r.headers["X-Lut-Shaper"]), (200, "matrix"))
            self.assertEqual(len(np.frombuffer(gzip.decompress(await r.read()), "<f4")), 12)
            r = await c.get("/imageviewer/comp_lut", params={"src": "", "display": "*", "view": "*"})
            self.assertEqual(r.status, 200)
            n = int(r.headers["X-Lut-Size"])
            self.assertEqual(len(np.frombuffer(gzip.decompress(await r.read()), "<f4")), n * n * n * 3)
            r = await c.get("/imageviewer/comp_lut", params={"src": "no such space", "dst": ""})
            self.assertEqual(r.status, 404)
            # A Read in a config colourspace is converted into the working space; an OCIOColorSpace node takes
            # it back, so the render's plain sRGB shows the plate's red again.
            srgb = next(n for n in names if n.lower().startswith("srgb encoded rec.709"))
            comp = self.comp_with_plate(1)
            comp["nodes"][1]["colorspace"] = srgb
            comp["nodes"].insert(3, {"id": "OCIO1", "type": "ocio_colorspace", "inputs": ["Merge1"], "in_space": "", "out_space": lin})
            comp["nodes"][-1]["inputs"] = ["OCIO1"]
            comp["nodes"][0]["color"] = [0, 0, 0, 1]
            path = os.path.join(self.dirs["output"], "ocio.comp.json")
            st, _ = await self.j(c, "/imageviewer/comp", {"path": path, "comp": comp})
            self.assertEqual(st, 200)
            s = await self.render(c, path, format="png")
            self.assertEqual(s["state"], "done", s)
            px = np.asarray(Image.open(s["result"]["path"]).convert("RGBA")).astype(int)
            self.assertLess(np.abs(px[5, 5] - [255, 0, 0, 255]).max(), 3, px[5, 5])
            # The same comp encoded through the config's default display and view instead of plain sRGB.
            d = info["displays"][0]
            s = await self.render(c, path, format="png", display=d["name"], view=d["default"])
            self.assertEqual(s["state"], "done", s)
            s2 = await self.render(c, path, format="png", display="no such display", view="x")
            self.assertEqual(s2["state"], "error")
        self.run_c(go)

    def render(self, c, path, **spec):
        async def go():
            st, d = await self.j(c, "/imageviewer/comp_render", dict({"path": path}, **spec))
            self.assertEqual(st, 200, d)
            for _ in range(200):
                r = await c.get("/imageviewer/comp_render", params={"job": d["job"]})
                s = await r.json()
                if s["state"] != "running":
                    return s
                await asyncio.sleep(0.05)
            self.fail("the render did not end")
        return go()

    def test_render_a_png_sequence_and_a_still(self):
        from PIL import Image

        async def go(c):
            path = os.path.join(self.dirs["output"], "seq.comp.json")
            st, _ = await self.j(c, "/imageviewer/comp", {"path": path, "comp": self.comp_with_plate(3)})
            self.assertEqual(st, 200)
            s = await self.render(c, path, format="png")
            self.assertEqual(s["state"], "done", s)
            res = s["result"]
            self.assertTrue(res["isSequence"])
            self.assertEqual(len(res["paths"]), 3)
            self.assertTrue(all(os.path.isfile(p) for p in res["paths"]))
            px = np.asarray(Image.open(res["paths"][0]).convert("RGBA"))
            self.assertEqual(tuple(px[5, 5]), (255, 0, 0, 255))       # the plate over
            self.assertEqual(tuple(px[5, 50]), (0, 0, 255, 255))      # the blue under it
            one = await self.render(c, path, format="png", first=1, last=1)
            self.assertEqual(one["state"], "done", one)
            self.assertTrue(one["result"]["path"].endswith("seq_v002.png"), one["result"]["path"])
        self.run_c(go)

    def test_a_pushed_comp_opens_in_a_comp_tab(self):
        async def go(c):
            path = os.path.join(self.dirs["output"], "pushed.comp.json")
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": self.M.new_comp()})
            del self.sent[:]
            st, d = await self.j(c, "/imageviewer/push", {"paths": [path]})
            self.assertEqual(st, 200, d)
            self.assertEqual(d["comp"], [os.path.abspath(path)])
            self.assertIn(("imageviewer.comp.open", {"path": os.path.abspath(path)}), self.sent)
        self.run_c(go)

    @unittest.skipIf(av is None, "needs PyAV")
    def test_render_a_film(self):
        async def go(c):
            path = os.path.join(self.dirs["output"], "film.comp.json")
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": self.comp_with_plate(5)})
            s = await self.render(c, path, format="mp4", quality="low")
            self.assertEqual(s["state"], "done", s)
            res = s["result"]
            self.assertEqual(res["kind"], "video")
            self.assertTrue(res["path"].endswith("film_v001.mp4"))
            with av.open(res["path"]) as f:
                self.assertEqual(sum(1 for _ in f.decode(video=0)), 5)
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
