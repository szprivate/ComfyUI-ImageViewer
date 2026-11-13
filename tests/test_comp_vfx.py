"""Comp's VFX nodes (comp_vfx.py) through the REAL routes: a node's input prerendered to a film (PyAV) and handed
to the History's Convert Footage workflows (clip_vfx), or with prerender off the Read's own film; the result moved
beside the comp (an HDR pass as its EXR sequence) and answered as the node's results; the node then shows it over
the frames it covers and passes its input elsewhere; the refusals.

    python -m unittest discover -s tests -p test_comp_vfx.py

ComfyUI is not here: the workflow's outputs are files this test puts where ComfyUI would. Needs aiohttp and PyAV.
"""
import asyncio
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402

try:
    import av  # noqa: F401
except ImportError:  # pragma: no cover
    av = None

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer


def _put(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def comp_of(nodes, out, frames=20, w=64, h=36):
    return {"comp": 1, "format": {"width": w, "height": h, "fps": 24, "frames": frames}, "nodes": nodes, "output": out}


@unittest.skipIf(web is None or av is None, "needs aiohttp and PyAV")
class CompVfx(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, [])
        cls.CV = importlib.import_module(cls.pkg + ".comp_vfx")
        cls.V = importlib.import_module(cls.pkg + ".clip_vfx")
        cls.M = importlib.import_module(cls.pkg + ".comp_model")
        cls.io = importlib.import_module(cls.pkg + ".comp_io")
        cls.written = []
        fp = importlib.import_module(cls.pkg + ".viewer_api").folder_paths
        fp.get_full_path = lambda folder, name: f"/m/{folder}/{name}"      # every model is here
        fp.get_filename_list = lambda folder: []

        def write(path, first, n, fps, out, may_use=None):       # the Edit panel's renderer, tested on its own
            cls.written.append((os.path.basename(path), first, n))
            shutil.copyfile(path, out)
        cls.V.write_part = write
        cls.shot = os.path.join(cls.dirs["output"], "shots", "sh010")
        os.makedirs(cls.shot, exist_ok=True)
        cls.comp_path = os.path.join(cls.shot, "sh010.comp.json")

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_c(self, fn):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    def post(self, route, body):
        async def go(c):
            r = await c.post(route, json=body)
            return r.status, await r.json()
        return self.run_c(go)

    def save(self, comp):
        with open(self.comp_path, "w", encoding="utf-8") as f:
            json.dump(comp, f)

    def output_like_comfy(self, src, name, sub="ltx_vfx"):
        dst = os.path.join(self.dirs["output"], sub, name)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        return {"filename": name, "subfolder": sub, "type": "output"}

    def render(self, comp, f):
        src = self.io.Sources(self.comp_path)
        try:
            return self.M.render_node(comp, comp["output"], f, src, 1.0)
        finally:
            src.close()

    # ── prerender on: what comes in, rendered to a film ──

    def test_prerender_sends_what_comes_in_and_the_hdr_result_is_its_exr_sequence_beside_the_comp(self):
        red = {"id": "Constant1", "type": "constant", "color": [0.8, 0.1, 0.05, 1], "inputs": []}
        node = {"id": "vfx_hdr1", "type": "vfx_hdr", "inputs": ["Constant1"]}
        comp = comp_of([red, node, {"id": "Output1", "type": "output", "inputs": ["vfx_hdr1"]}], "Output1", frames=20)
        self.save(comp)
        st, prep = self.post("/imageviewer/comp_vfx", {"path": self.comp_path, "comp": comp, "node": "vfx_hdr1"})
        self.assertEqual(st, 200, prep)
        self.assertEqual((prep["kind"], prep["first"], prep["last"], prep["prerender"]), ("hdr", 0, 16, True))
        self.assertEqual(prep["used"], 17)                 # 20 frames: the 17 that are 8n + 1
        g = prep["graphs"][0]
        load = next(v for v in g.values() if v["class_type"] == "LoadVideo")["inputs"]["file"]
        made = os.path.join(self.dirs["input"], *load.split("/"))
        self.assertTrue(os.path.isfile(made))               # the prerender, read by the workflow as it is
        self.assertEqual(self.V.probe(made)["frames"], 17)
        # ComfyUI's outputs: the film and the EXR frames (stand-ins).
        out = self.output_like_comfy(made, "sh010_hdr_00001.mp4")
        exr_dir = os.path.join(self.dirs["output"], *self.V._JOBS[prep["job"]]["exr_dir"].split("/"))
        for i in range(17):
            _put(os.path.join(exr_dir, f"frame_{i:05d}.exr"), b"exr")
        st, res = self.post("/imageviewer/comp_vfx_finish", {"job": prep["job"], "results": [out]})
        self.assertEqual(st, 200, res)
        self.assertTrue(res["file"].startswith("sh010_vfx/vfx_hdr1/vfx_hdr1_hdr_"), res)
        self.assertTrue(res["file"].endswith("/frame_#####.exr"))
        self.assertEqual((res["first"], res["last"], res["offset"], res["frames"]), (0, 16, 0, 17))
        folder = os.path.join(self.shot, *res["file"].split("/")[:-1])
        self.assertEqual(len(os.listdir(folder)), 17)
        self.assertFalse(os.path.exists(made))              # the prerender is removed
        self.assertFalse(os.path.isdir(exr_dir))

    def test_the_alpha_result_is_shown_over_the_frames_it_covers_and_the_input_elsewhere(self):
        grey = {"id": "Constant1", "type": "constant", "color": [0.5, 0.5, 0.5, 1], "inputs": []}
        node = {"id": "vfx_alpha1", "type": "vfx_alpha", "inputs": ["Constant1"]}
        comp = comp_of([grey, node, {"id": "Output1", "type": "output", "inputs": ["vfx_alpha1"]}], "Output1", frames=12)
        self.save(comp)
        st, prep = self.post("/imageviewer/comp_vfx", {"path": self.comp_path, "comp": comp, "node": "vfx_alpha1"})
        self.assertEqual(st, 200, prep)
        self.assertEqual((prep["first"], prep["last"]), (0, 8))
        load = next(v for v in prep["graphs"][0].values() if v["class_type"] == "LoadVideo")["inputs"]["file"]
        out = self.output_like_comfy(os.path.join(self.dirs["input"], *load.split("/")), "sh010_alpha_00001.mp4")
        st, res = self.post("/imageviewer/comp_vfx_finish", {"job": prep["job"], "results": [out]})
        self.assertEqual(st, 200, res)
        self.assertTrue(res["file"].endswith(".mp4"))
        self.assertEqual((res["width"], res["height"], res["colorspace"]), (64, 36, "linear"))
        node["results"] = res
        inside, outside = self.render(comp, 3), self.render(comp, 10)
        self.assertEqual(inside.shape, (36, 64, 4))
        # The matte film is the grey picture's sRGB value read as data: the picture times it, alpha too.
        self.assertAlmostEqual(float(inside[18, 32, 3]), 0.735, delta=0.03)
        self.assertTrue(np.allclose(outside[18, 32], [0.5, 0.5, 0.5, 1], atol=1e-4))   # past frame 8: the input
        node["output"] = "matte"
        self.assertAlmostEqual(float(self.render(comp, 3)[18, 32, 0]), 0.735, delta=0.03)

    # ── prerender off: the Read's film as it is ──

    def test_prerender_off_takes_the_reads_film_and_its_offset(self):
        film = os.path.join(self.shot, "plate.mp4")
        c0 = comp_of([{"id": "Constant1", "type": "constant", "color": [0.2, 0.4, 0.6, 1], "inputs": []},
                      {"id": "Output1", "type": "output", "inputs": ["Constant1"]}], "Output1", frames=30)
        self.CV.render_input(c0, "Constant1", 30, self.io.Sources(self.comp_path), film)
        rd = {"id": "Read1", "type": "read", "file": "plate.mp4", "offset": 5, "inputs": []}
        dot = {"id": "Dot1", "type": "dot", "inputs": ["Read1"]}
        node = {"id": "vfx_upscale1", "type": "vfx_upscale", "inputs": ["Dot1"], "prerender": "off", "size": "4K"}
        comp = comp_of([rd, dot, node, {"id": "Output1", "type": "output", "inputs": ["vfx_upscale1"]}], "Output1", frames=40)
        self.save(comp)
        self.written.clear()
        st, prep = self.post("/imageviewer/comp_vfx", {"path": self.comp_path, "comp": comp, "node": "vfx_upscale1"})
        self.assertEqual(st, 200, prep)
        self.assertEqual(self.written, [("plate.mp4", 0, 25)])     # 30 frames: 25 of them, from the plate itself
        self.assertEqual((prep["first"], prep["last"], prep["prerender"]), (5, 29, False))
        g = prep["graphs"][0]
        self.assertEqual(next(v for v in g.values() if v["class_type"] == "LTXVGetTilingSizes")["inputs"]["output_size"], "4K")
        st, res = self.post("/imageviewer/comp_vfx_finish", {"job": prep["job"], "results": [self.output_like_comfy(film, "up_00001.mp4")]})
        self.assertEqual(st, 200, res)
        self.assertEqual((res["offset"], res["first"], res["last"]), (5, 5, 29))
        node["results"] = res
        self.assertEqual(self.M.format_at(comp, "vfx_upscale1"), {"width": 64, "height": 36})   # the result's size

    def test_prerender_off_refuses_anything_but_a_read_of_a_film(self):
        node = {"id": "vfx_reframe1", "type": "vfx_reframe", "inputs": ["Constant1"], "prerender": "off"}
        comp = comp_of([{"id": "Constant1", "type": "constant", "inputs": []}, node,
                        {"id": "Output1", "type": "output", "inputs": ["vfx_reframe1"]}], "Output1")
        self.save(comp)
        st, res = self.post("/imageviewer/comp_vfx", {"path": self.comp_path, "comp": comp, "node": "vfx_reframe1"})
        self.assertEqual(st, 400)
        self.assertIn("prerender is off", res["error"])

    def test_refusals(self):
        comp = comp_of([{"id": "vfx_hdr1", "type": "vfx_hdr", "inputs": [None]}], "vfx_hdr1")
        self.save(comp)
        st, res = self.post("/imageviewer/comp_vfx", {"path": self.comp_path, "comp": comp, "node": "vfx_hdr1"})
        self.assertEqual(st, 400)
        self.assertIn("wire a picture", res["error"])
        st, res = self.post("/imageviewer/comp_vfx", {"path": self.comp_path, "comp": comp, "node": "nope"})
        self.assertEqual(st, 400)
        st, res = self.post("/imageviewer/comp_vfx", {"path": os.path.join(self.tmp, "x.txt"), "comp": comp, "node": "vfx_hdr1"})
        self.assertEqual(st, 403)
        st, res = self.post("/imageviewer/comp_vfx_finish", {"job": "unknown", "results": [{"filename": "a.mp4", "type": "output"}]})
        self.assertEqual(st, 404)

    def test_a_missing_model_is_said_before_anything_is_written(self):
        fp = sys.modules.get("folder_paths")
        api = importlib.import_module(self.pkg + ".viewer_api")
        f = api.folder_paths
        old = getattr(f, "get_full_path", None), getattr(f, "get_filename_list", None)
        f.get_full_path = lambda folder, name: None
        f.get_filename_list = lambda folder: []
        try:
            red = {"id": "Constant1", "type": "constant", "inputs": []}
            node = {"id": "vfx_hdr1", "type": "vfx_hdr", "inputs": ["Constant1"]}
            comp = comp_of([red, node], "vfx_hdr1")
            self.save(comp)
            before = set(os.listdir(os.path.join(self.dirs["input"], "clip_vfx"))) if os.path.isdir(os.path.join(self.dirs["input"], "clip_vfx")) else set()
            st, res = self.post("/imageviewer/comp_vfx", {"path": self.comp_path, "comp": comp, "node": "vfx_hdr1"})
            self.assertEqual(st, 409, res)
            self.assertTrue(res["missing"])
            after = set(os.listdir(os.path.join(self.dirs["input"], "clip_vfx"))) if os.path.isdir(os.path.join(self.dirs["input"], "clip_vfx")) else set()
            self.assertEqual(before, after)
        finally:
            f.get_full_path, f.get_filename_list = old
        del fp


if __name__ == "__main__":
    unittest.main()
