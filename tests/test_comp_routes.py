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

    def test_save_as_writes_a_new_file_and_asks_before_writing_over_one(self):
        async def go(c):
            comp = self.M.new_comp()
            folder = os.path.join(self.dirs["output"], "save_as_here")
            st, d = await self.j(c, "/imageviewer/comp_save_as", {"folder": folder, "name": "../shot a.comp.json", "comp": comp})
            self.assertEqual(st, 200, d)
            self.assertEqual(d["path"], os.path.join(folder, "shot a.comp.json"))
            self.assertTrue(os.path.isfile(d["path"]))
            st, d2 = await self.j(c, "/imageviewer/comp_save_as", {"folder": folder, "name": "shot a", "comp": comp})
            self.assertEqual((st, d2.get("exists"), d2.get("path")), (409, True, d["path"]))
            comp["format"]["frames"] = 7
            st, _ = await self.j(c, "/imageviewer/comp_save_as", {"folder": folder, "name": "shot a", "comp": comp, "overwrite": True})
            self.assertEqual(st, 200)
            r = await c.get("/imageviewer/comp", params={"path": d["path"]})
            self.assertEqual((await r.json())["comp"]["format"]["frames"], 7)
            st, _ = await self.j(c, "/imageviewer/comp_save_as", {"folder": self.outside, "name": "x", "comp": comp})
            self.assertEqual(st, 403)
            self.assertFalse(os.path.exists(os.path.join(self.outside, "x.comp.json")))
            st, _ = await self.j(c, "/imageviewer/comp_save_as", {"folder": folder, "name": "  ", "comp": comp})
            self.assertEqual(st, 400)
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

    def test_recreate_thumbnail_forgets_the_tiles_and_thumb_makes_them_again(self):
        # History > Recreate thumbnail (viewer_api /imageviewer/thumb_recreate), here beside the other routes on a picture.
        async def go(c):
            r = await c.get("/imageviewer/thumb", params={"path": self.png, "max": 32})
            self.assertEqual(r.status, 200)
            tmp = self.dirs["temp"]
            made = [f for f in os.listdir(tmp) if f.startswith("ImageViewer_thumb32_plate_")]
            self.assertEqual(len(made), 1)
            st, body = await self.j(c, "/imageviewer/thumb_recreate", {"path": self.png})
            self.assertEqual((st, body["ok"], body["removed"] >= 1), (200, True, True), body)
            self.assertFalse(os.path.exists(os.path.join(tmp, made[0])))
            r = await c.get("/imageviewer/thumb", params={"path": self.png, "max": 32})
            self.assertEqual(r.status, 200)
            self.assertTrue(os.path.exists(os.path.join(tmp, made[0])))
            # The same fences as /imageviewer/thumb: outside the folders, nothing; not JSON from elsewhere, nothing.
            st, _ = await self.j(c, "/imageviewer/thumb_recreate", {"path": os.path.join(self.outside, "x.png")})
            self.assertIn(st, (403, 404))
            r = await c.post("/imageviewer/thumb_recreate", json={"path": self.png}, headers={"Origin": "http://evil.example"})
            self.assertEqual(r.status, 403)
        self.run_c(go)

    def test_pixels_of_a_read(self):
        async def go(c):
            comp_path = os.path.join(self.dirs["output"], "p.comp.json")
            r = await c.get("/imageviewer/comp_source", params={"file": "plate.png", "comp": comp_path})
            info = await r.json()
            self.assertEqual((r.status, info["kind"], info.get("width"), info.get("height")), (200, "still", 60, 40), info)
            r = await c.get("/imageviewer/comp_pixels", params={"file": "plate.png", "comp": comp_path, "max": 30})
            self.assertEqual(r.status, 200)
            w, h = int(r.headers["X-Comp-W"]), int(r.headers["X-Comp-H"])
            self.assertEqual((w, h, r.headers["X-Comp-OW"], r.headers["X-Comp-OH"]), (30, 20, "60", "40"))
            body = await r.read()
            # packed across machines only: the test client is this machine
            self.assertEqual(r.headers["X-ImageViewer-Enc"], "none")
            px = np.frombuffer(body, "<f2").reshape(h, w, 4).astype(np.float32)
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

    def test_render_saves_as_the_send_node_saves(self):
        """The node's formats and options (file_writer): the menu from comp_formats, frames numbered from the
        first frame number at the padding, a JPEG's quality, an EXR's linear premultiplied values, a TIFF."""
        from PIL import Image

        async def go(c):
            r = await c.get("/imageviewer/comp_formats")
            f = await r.json()
            FW = importlib.import_module(self.pkg + ".file_writer")
            self.assertEqual(f["quality_default"], FW.QUALITY_DEFAULT)
            self.assertEqual(f["bit_depths"], FW.BIT_DEPTHS)
            for e in ("png", "exr", "jpg", "tiff"):
                self.assertIn(e, f["stills"])
            self.assertEqual(f["videos"], ["mp4", "mov", "webm"])
            self.assertEqual(f["first_frame_default"], 1001)
            path = os.path.join(self.dirs["output"], "saves.comp.json")
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": self.comp_with_plate(2)})
            s = await self.render(c, path, format="jpg", first_number=1001, padding=4, options={"quality": 40})
            self.assertEqual(s["state"], "done", s)
            names = [os.path.basename(p) for p in s["result"]["paths"]]
            self.assertTrue(names[0].endswith(".1001.jpg") and names[1].endswith(".1002.jpg"), names)
            self.assertIn(".####.jpg", s["result"]["relative"])
            low = os.path.getsize(s["result"]["paths"][0])
            s = await self.render(c, path, format="jpg", first_number=7, padding=6, options={"quality": 100})
            self.assertTrue(s["result"]["paths"][0].endswith(".000007.jpg"), s["result"]["paths"])
            self.assertGreater(os.path.getsize(s["result"]["paths"][0]), low)
            s = await self.render(c, path, format="exr", first=0, last=0)
            self.assertEqual(s["state"], "done", s)
            self.assertTrue(s["result"]["path"].endswith(".exr"))
            with open(s["result"]["path"], "rb") as fh:
                self.assertEqual(fh.read(4), b"\x76\x2f\x31\x01")      # OpenEXR's magic number
            s = await self.render(c, path, format="tif", first=0, last=0)     # the old name still works
            self.assertEqual(s["state"], "done", s)
            self.assertTrue(s["result"]["path"].endswith(".tiff"), s["result"]["path"])
            px = np.asarray(Image.open(s["result"]["path"]).convert("RGBA"))
            self.assertEqual(tuple(px[5, 5]), (255, 0, 0, 255))
            st, d = await self.j(c, "/imageviewer/comp_render", {"path": path, "format": "xyz"})
            self.assertEqual(st, 400, d)
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

    def test_export_to_nuke_writes_a_script_and_bakes_what_nuke_lacks(self):
        async def go(c):
            path = os.path.join(self.dirs["output"], "tonuke.comp.json")
            comp = self.comp_with_plate(2)
            comp["nodes"].insert(3, {"id": "Glow1", "type": "glow", "inputs": ["Merge1"]})
            comp["nodes"][-1]["inputs"] = ["Glow1"]
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": comp})
            st, d = await self.j(c, "/imageviewer/comp_export_nuke", {"path": path})
            self.assertEqual(st, 200, d)
            for _ in range(200):
                r = await c.get("/imageviewer/comp_export_nuke", params={"job": d["job"]})
                s = await r.json()
                if s["state"] != "running":
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(s["state"], "done", s)
            res = s["result"]
            self.assertTrue(res["path"].endswith("tonuke_v001.nk"), res["path"])
            text = open(res["path"], encoding="utf-8").read()
            self.assertIn("Merge2 {", text)
            self.assertIn("Write {", text)
            self.assertEqual(res["baked"], ["Glow1"])
            frames = sorted(os.listdir(os.path.join(res["bake_dir"], "Glow1")))
            self.assertEqual(frames, ["Glow1.0000.exr", "Glow1.0001.exr"])
            self.assertTrue(os.path.isfile(res["readme"]))
            st, _ = await self.j(c, "/imageviewer/comp_export_nuke", {"path": os.path.join(self.outside, "x.comp.json")})
            self.assertEqual(st, 403)
        self.run_c(go)

    def test_track_points_and_a_surface_through_a_moving_picture(self):
        from PIL import Image
        ys, xs = np.mgrid[0:80, 0:120].astype(np.float64)
        rng = np.random.default_rng(3)
        g = np.zeros_like(xs)
        for a, b, c in (rng.random((40, 3)) - [0.5, 0.5, 0]) * [1.2, 1.2, 6]:
            g += np.sin(xs * a + ys * b + c)
        u8 = np.clip(128 + g * 18, 0, 255).astype(np.uint8)
        Image.fromarray(np.dstack([u8, u8, u8, np.full_like(u8, 255)]), "RGBA").save(os.path.join(self.dirs["output"], "tex.png"))
        comp = {"comp": 1, "format": {"width": 120, "height": 80, "fps": 24, "frames": 5}, "output": "Output1",
                "nodes": [{"id": "Read1", "type": "read", "file": "tex.png", "inputs": []},
                          {"id": "Transform1", "type": "transform", "inputs": ["Read1"],
                           "tracks": {"translate": [{"f": 0, "v": [0, 0], "ease": "linear"}, {"f": 4, "v": [6, -3]}]}},
                          {"id": "Tracker1", "type": "tracker", "inputs": ["Transform1"]},
                          {"id": "PlanarTracker1", "type": "planartracker", "inputs": ["Transform1"]},
                          {"id": "Output1", "type": "output", "inputs": ["Tracker1"]}]}

        async def wait(c, jid):
            for _ in range(200):
                r = await c.get("/imageviewer/comp_track", params={"job": jid})
                s = await r.json()
                if s["state"] != "running":
                    return s
                await asyncio.sleep(0.05)
            self.fail("the track did not end")

        async def go(c):
            path = os.path.join(self.dirs["output"], "track.comp.json")
            st, _ = await self.j(c, "/imageviewer/comp", {"path": path, "comp": comp})
            self.assertEqual(st, 200)
            st, d = await self.j(c, "/imageviewer/comp_track", {"path": path, "node": "Tracker1", "from": 0, "to": 4,
                                                                "points": [{"id": "p1", "x": 60, "y": 40, "pattern": [15, 15], "search": [41, 41]}]})
            self.assertEqual(st, 200, d)
            s = await wait(c, d["job"])
            self.assertEqual(s["state"], "done", s)
            keys = s["keys"]["p1"]
            self.assertEqual([k[0] for k in keys], [0, 1, 2, 3, 4])
            for f, x, y, score in keys:
                self.assertAlmostEqual(x, 60 + 1.5 * f, delta=0.15)
                self.assertAlmostEqual(y, 40 - 0.75 * f, delta=0.15)
            # backwards from the last frame, with the comp sent along (not saved)
            st, d = await self.j(c, "/imageviewer/comp_track", {"path": path, "comp": comp, "node": "Tracker1", "from": 4, "to": 1,
                                                                "points": [{"id": "p1", "x": 66, "y": 37}]})
            s = await wait(c, d["job"])
            self.assertEqual([k[0] for k in s["keys"]["p1"]], [4, 3, 2, 1])
            quad = [[35, 60], [85, 60], [85, 20], [35, 20]]
            st, d = await self.j(c, "/imageviewer/comp_track", {"path": path, "node": "PlanarTracker1", "from": 0, "to": 4, "quad": quad})
            self.assertEqual(st, 200, d)
            s = await wait(c, d["job"])
            self.assertEqual(s["state"], "done", s)
            last = s["plane"][-1]
            self.assertEqual(last[0], 4)
            for k in range(4):
                self.assertAlmostEqual(last[1 + 2 * k], quad[k][0] + 6, delta=0.3)
                self.assertAlmostEqual(last[2 + 2 * k], quad[k][1] - 3, delta=0.3)
            st, d = await self.j(c, "/imageviewer/comp_track", {"path": path, "node": "Output1", "points": [{"x": 1, "y": 1}]})
            self.assertEqual(st, 422)
            st, d = await self.j(c, "/imageviewer/comp_track", {"path": path, "node": "Tracker1", "points": []})
            self.assertEqual(st, 400)
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


    def test_a_reformat_before_the_output_renders_at_its_size(self):
        from PIL import Image

        async def go(c):
            comp = self.comp_with_plate(2)
            comp["nodes"].insert(3, {"id": "Reformat1", "type": "reformat", "inputs": ["Merge1"], "width": 30, "height": 22})
            comp["nodes"][-1]["inputs"] = ["Reformat1"]
            path = os.path.join(self.dirs["output"], "small.comp.json")
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": comp})
            s = await self.render(c, path, format="png", first=0, last=0)
            self.assertEqual(s["state"], "done", s)
            self.assertEqual(Image.open(s["result"]["path"]).size, (30, 22))
            s = await self.render(c, path, format="mp4", quality="low")
            self.assertEqual(s["state"], "done", s)
            with av.open(s["result"]["path"]) as f:
                v = f.streams.video[0]
                self.assertEqual((v.codec_context.width, v.codec_context.height), (30, 22))
        self.run_c(go)

    def test_a_deep_exr_is_read_for_the_preview_and_the_render(self):
        """A deep file written by comp_deep: GET comp_deep hands its samples to the page, sorted front first; a
        DeepRead -> DeepHoldout -> render flattens it as the page does."""
        D = importlib.import_module(self.pkg + ".comp_deep")
        from PIL import Image
        w, h = 6, 4
        n = np.array([2, 1, 0, 3] * 6, np.uint32)
        s = np.zeros((int(n.sum()), 6), np.float32)
        s[:, 0] = 0.5
        s[:, 3] = 0.5
        s[:, 4] = np.arange(len(s), 0, -1) % 5 + 1     # not in depth order: the reader sorts
        s[:, 5] = s[:, 4]
        path = os.path.join(self.dirs["output"], "deep.exr")
        D.write_deep(path, {"w": w, "h": h, "n": n, "s": s})

        async def go(c):
            r = await c.get("/imageviewer/comp_deep", params={"file": path, "frame": "0"})
            self.assertEqual(r.status, 200)
            self.assertEqual((r.headers["X-Comp-W"], r.headers["X-Comp-H"], r.headers["X-Deep-Samples"]), ("6", "4", str(len(s))))
            raw = gzip.decompress(await r.read())
            counts = np.frombuffer(raw[: w * h * 4], "<u4")
            samples = np.frombuffer(raw[w * h * 4:], "<f4").reshape(-1, 6)
            self.assertEqual(counts.tolist(), n.tolist())
            self.assertTrue(samples[0, 4] <= samples[1, 4])
            r = await c.get("/imageviewer/comp_deep", params={"file": os.path.join(self.outside, "x.exr")})
            self.assertEqual(r.status, 403)
            comp = {"comp": 1, "format": {"width": 6, "height": 4, "fps": 24, "frames": 1}, "output": "Output1",
                    "nodes": [{"id": "DeepRead1", "type": "deepread", "file": "deep.exr", "inputs": []},
                              {"id": "DeepFlatten1", "type": "deepflatten", "inputs": ["DeepRead1"]},
                              {"id": "Output1", "type": "output", "inputs": ["DeepFlatten1"]}]}
            cp = os.path.join(self.dirs["output"], "deep.comp.json")
            await self.j(c, "/imageviewer/comp", {"path": cp, "comp": comp})
            st = await self.render(c, cp, format="png", first=0, last=0)
            self.assertEqual(st["state"], "done", st)
            px = np.asarray(Image.open(st["result"]["path"]).convert("RGBA"))
            self.assertEqual(px[0, 0, 3], 191)     # two samples of alpha 0.5: 0.75
            self.assertEqual(px[0, 2, 3], 0)       # none
        self.run_c(go)

    def test_a_camera_file_is_read_as_keys(self):
        cam = os.path.join(self.dirs["output"], "shot.chan")
        with open(cam, "w") as fh:
            fh.write("# frame tx ty tz rx ry rz vfov\n2 0 1 5 0 10 0 40\n1 0 1 6 0 0 0 40\nnot a line\n")

        async def go(c):
            r = await c.get("/imageviewer/comp_camera", params={"file": cam})
            self.assertEqual(r.status, 200, await r.text())
            keys = (await r.json())["keys"]
            self.assertEqual([k["f"] for k in keys], [1, 2])
            self.assertEqual(keys[1]["r"], [0, 10, 0])
            self.assertEqual(keys[0]["vfov"], 40)
            r = await c.get("/imageviewer/comp_camera", params={"file": self.png})
            self.assertEqual(r.status, 400)
        self.run_c(go)

    def test_the_open_dialog_is_for_the_page_on_this_machine_and_only_names_a_file(self):
        nd = importlib.import_module(self.pkg + ".native_dialog")
        real = nd.pick_file
        self.addCleanup(lambda: setattr(nd, "pick_file", real))
        asked = []

        async def go(c):
            nd.pick_file = lambda start="", title="", filters=(): (asked.append(start), self.png)[1]
            st, got = await self.j(c, "/imageviewer/comp_open_dialog", {"start": self.png})
            self.assertEqual(st, 200, got)
            self.assertEqual(os.path.normcase(got["path"]), os.path.normcase(os.path.abspath(self.png)))
            self.assertEqual((got["name"], got["allowed"]), ("plate.png", True))
            self.assertEqual(os.path.normcase(asked[-1]), os.path.normcase(os.path.dirname(self.png)), "starts in the file's folder")
            # a folder the viewer may not read is no place to start in, and a file there is named as not allowed
            far = os.path.join(self.outside, "far.png")
            open(far, "wb").close()
            nd.pick_file = lambda start="", title="", filters=(): (asked.append(start), far)[1]
            st, got = await self.j(c, "/imageviewer/comp_open_dialog", {"start": self.outside})
            self.assertEqual((st, got["allowed"], asked[-1]), (200, False, ""))
            nd.pick_file = lambda *a, **k: ""
            self.assertEqual(await self.j(c, "/imageviewer/comp_open_dialog", {}), (200, {"cancelled": True}))

            def none(*a, **k):
                raise nd.Unavailable("no desktop")
            nd.pick_file = none
            self.assertEqual((await self.j(c, "/imageviewer/comp_open_dialog", {}))[0], 501)

            def busy(*a, **k):
                raise nd.Busy("up already")
            nd.pick_file = busy
            self.assertEqual((await self.j(c, "/imageviewer/comp_open_dialog", {}))[0], 409)
            # another site's page, and a form post, are refused before any dialog
            nd.pick_file = lambda *a, **k: self.fail("no dialog for a refused request")
            r = await c.post("/imageviewer/comp_open_dialog", json={}, headers={"Origin": "http://evil.example"})
            self.assertEqual(r.status, 403)
            r = await c.post("/imageviewer/comp_open_dialog", data={"start": ""})
            self.assertEqual(r.status, 403)
            self.assertEqual((await c.get("/imageviewer/comp_open_dialog")).status, 405)
        self.run_c(go)

    def test_only_one_system_dialog_at_a_time_and_none_without_a_desktop(self):
        nd = importlib.import_module(self.pkg + ".native_dialog")
        self.assertTrue(nd._lock.acquire(blocking=False))
        try:
            with self.assertRaises(nd.Busy):
                nd.pick_file()
        finally:
            nd._lock.release()
        if sys.platform not in ("win32", "darwin") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            with self.assertRaises(nd.Unavailable):
                nd.pick_file()
        self.assertEqual(nd._filter_text([("Footage", "*.exr;*.png"), ("All files", "*.*")]), "Footage\0*.exr;*.png\0All files\0*.*\0\0")

    def test_a_comp_with_views_renders_one_output_per_view(self):
        from PIL import Image
        for name, col in (("eye_left.png", (255, 0, 0)), ("eye_right.png", (0, 255, 0))):
            Image.new("RGBA", (12, 8), col + (255,)).save(os.path.join(self.dirs["output"], name))

        async def go(c):
            comp = {"comp": 1, "format": {"width": 12, "height": 8, "fps": 24, "frames": 1, "views": ["left", "right"]},
                    "output": "Output1",
                    "nodes": [{"id": "Read1", "type": "read", "file": "eye_%V.png", "inputs": []},
                              {"id": "Output1", "type": "output", "inputs": ["Read1"]}]}
            cp = os.path.join(self.dirs["output"], "stereo.comp.json")
            await self.j(c, "/imageviewer/comp", {"path": cp, "comp": comp})
            st = await self.render(c, cp, format="png", first=0, last=0)
            self.assertEqual(st["state"], "done", st)
            got = {v["view"]: v["path"] for v in st["result"]["views"]}
            self.assertEqual(sorted(got), ["left", "right"])
            self.assertIn("stereo_left", os.path.basename(got["left"]))
            self.assertEqual(tuple(np.asarray(Image.open(got["left"]).convert("RGB"))[2, 2]), (255, 0, 0))
            self.assertEqual(tuple(np.asarray(Image.open(got["right"]).convert("RGB"))[2, 2]), (0, 255, 0))
            one = await self.render(c, cp, format="png", first=0, last=0, views=["right"])
            self.assertEqual([v["view"] for v in one["result"]["views"]], ["right"])
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
