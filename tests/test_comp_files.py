"""Comp's colour files and AI nodes on the server: a .cube read the way the comp applies it, a CDL written and
read back, the comp_lut / comp_cdl routes, and an AI node's frame through a (custom) Generate workflow -
prepared, its answer placed beside the comp and read back by the node.

    python -m unittest discover -s tests -p test_comp_files.py
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


def cube_text(n, fn, title="t"):
    lines = [f'TITLE "{title}"', f"LUT_3D_SIZE {n}"]
    for b in range(n):
        for g in range(n):
            for r in range(n):     # red fastest, as the format has it
                v = fn(r / (n - 1), g / (n - 1), b / (n - 1))
                lines.append(" ".join(f"{x:.6f}" for x in v))
    return "\n".join(lines) + "\n"


@unittest.skipIf(web is None, "needs aiohttp")
class CompFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.flows = os.path.join(cls.tmp, "flows")
        os.environ["IMAGE_VIEWER_PAINT_WORKFLOWS"] = cls.flows
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.F = importlib.import_module(cls.pkg + ".comp_files")
        cls.M = importlib.import_module(cls.pkg + ".comp_model")
        cls.AI = importlib.import_module(cls.pkg + ".comp_ai")
        cls.G = importlib.import_module(cls.pkg + ".paint_generate")
        from PIL import Image
        a = np.zeros((40, 60, 4), np.uint8)
        a[..., 0] = 200
        a[..., 3] = 255
        Image.fromarray(a, "RGBA").save(os.path.join(cls.dirs["output"], "plate.png"))

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("IMAGE_VIEWER_PAINT_WORKFLOWS", None)
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_c(self, fn):
        async def go():
            app = web.Application(client_max_size=1 << 28)
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    # ── LUTs ──

    def test_a_cube_is_read_red_slowest_and_applied_as_the_comp_does(self):
        swap = lambda r, g, b: (b, g * 0.5, r)   # noqa: E731 - red and blue swapped, green halved
        size, shaper, data = self.F.parse_cube(cube_text(5, swap))
        self.assertEqual((size, shaper), (5, "lin:0:1"))
        rgb = np.array([[[0.25, 0.5, 1.0], [1.0, 0.0, 0.5]]], np.float32)
        got = self.M.apply_lut(rgb, (size, shaper, data))
        np.testing.assert_allclose(got, [[[1.0, 0.25, 0.25], [0.5, 0.0, 1.0]]], atol=1e-5)

    def test_a_1d_cube_and_its_domain(self):
        text = "LUT_1D_SIZE 3\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n0.5 0.5 0.5\n1 1 1\n"
        size, shaper, data = self.F.parse_cube(text)
        self.assertEqual((size, shaper), (self.F.GRID, "lin:0:2"))
        got = self.M.apply_lut(np.array([[[1.0, 2.0, 0.0]]], np.float32), (size, shaper, data))
        np.testing.assert_allclose(got, [[[0.5, 1.0, 0.0]]], atol=1e-5)

    def test_bad_cubes_say_why(self):
        for text in ("LUT_3D_SIZE 2\n0 0 0\n", "nothing here\n", "LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 1 1 1\n" + "0 0 0\n" * 8):
            with self.assertRaises(self.F.LutError):
                self.F.parse_cube(text)

    # ── CDLs ──

    def test_cdl_written_and_read_back_in_each_form(self):
        v = {"slope": [1.1, 0.9, 1.0], "offset": [0.01, -0.02, 0], "power": [1, 1.2, 0.8], "saturation": 0.7}
        for ext in self.F.CDL_EXTS:
            p = os.path.join(self.tmp, "grade" + ext)
            self.F.write_cdl(p, v, cid="shot_010")
            got = self.F.read_cdl(p)
            for k in ("slope", "offset", "power"):
                np.testing.assert_allclose(got[k], v[k], atol=1e-6)
            self.assertAlmostEqual(got["saturation"], 0.7)
            self.assertEqual(got["id"], "shot_010")
        with self.assertRaises(self.F.LutError):
            self.F.parse_cdl('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><ColorCorrection/>')
        with self.assertRaises(self.F.LutError):
            self.F.write_cdl(os.path.join(self.tmp, "grade.txt"), v)

    def test_the_lut_and_cdl_routes(self):
        comp = os.path.join(self.dirs["output"], "c.comp.json")
        with open(comp, "w") as fh:
            fh.write("{}")
        with open(os.path.join(self.dirs["output"], "look.cube"), "w") as fh:
            fh.write(cube_text(2, lambda r, g, b: (r, g, b)))

        async def go(c):
            r = await c.get("/imageviewer/comp_lut", params={"file": "look.cube", "comp": comp})
            self.assertEqual(r.status, 200)
            self.assertEqual(r.headers["X-Lut-Size"], "2")
            r = await c.get("/imageviewer/comp_lut", params={"file": "/etc/passwd.cube", "comp": comp})
            self.assertEqual(r.status, 403)
            body = {"comp": comp, "file": "c_CDL1.cc", "values": {"slope": [2, 2, 2], "saturation": 0.5}, "id": "CDL1"}
            r = await c.post("/imageviewer/comp_cdl", json=body)
            self.assertEqual(r.status, 200, await r.text())
            r = await c.post("/imageviewer/comp_cdl", json=body)
            self.assertEqual(r.status, 409)
            r = await c.get("/imageviewer/comp_cdl", params={"file": "c_CDL1.cc", "comp": comp})
            got = await r.json()
            self.assertEqual(got["slope"], [2, 2, 2])
            self.assertEqual(got["saturation"], 0.5)
            r = await c.post("/imageviewer/comp_cdl", json=dict(body, file="/etc/x.cc", overwrite=True))
            self.assertEqual(r.status, 403)
        self.run_c(go)

    # ── AI nodes ──

    def test_an_ai_matte_runs_through_a_workflow_and_its_answer_lies_beside_the_comp(self):
        graph = {"1": {"class_type": "LoadImage", "_meta": {"title": "paint:image"}, "inputs": {"image": "x.png"}},
                 "2": {"class_type": "SaveImage", "_meta": {"title": "paint:output"}, "inputs": {"images": ["1", 0], "filename_prefix": "x"}}}
        self.G.set_custom("background", graph, "test matte")
        self.G.set_choice("background", "custom")
        comp_path = os.path.join(self.dirs["output"], "shot.comp.json")
        comp = {"comp": 1, "format": {"width": 60, "height": 40, "fps": 24, "frames": 4}, "output": "Output1",
                "nodes": [{"id": "Read1", "type": "read", "file": "plate.png", "inputs": []},
                          {"id": "AI1", "type": "ai_matte", "inputs": ["Read1"]},
                          {"id": "Output1", "type": "output", "inputs": ["AI1"]}]}
        from PIL import Image

        async def go(c):
            r = await c.post("/imageviewer/comp_ai", json={"path": comp_path, "comp": comp, "node": "AI1", "frame": 2})
            prep = await r.json()
            self.assertEqual(r.status, 200, prep)
            self.assertEqual(prep["kind"], "matte")
            name = prep["graphs"][0]["1"]["inputs"]["image"]
            sent = np.asarray(Image.open(os.path.join(self.dirs["input"], name)))
            self.assertEqual(sent.shape[0], 40)    # at the workflow's size (a multiple of 8 wide)
            self.assertGreater(int(sent[..., 0].mean()), 150)     # the plate's red, as sRGB 8-bit
            # The workflow's answer: a matte as a picture, white on the left half.
            ans = np.zeros((40, 60, 3), np.uint8)
            ans[:, :30] = 255
            os.makedirs(os.path.join(self.dirs["output"], "gen"), exist_ok=True)
            Image.fromarray(ans, "RGB").save(os.path.join(self.dirs["output"], "gen", "m.png"))
            r = await c.post("/imageviewer/comp_ai_place", json={"job": prep["job"], "image": {"filename": "m.png", "subfolder": "gen", "type": "output"}})
            placed = await r.json()
            self.assertEqual(r.status, 200, placed)
            self.assertTrue(placed["file"].startswith("shot_ai/AI1/AI1_matte.0002_"), placed["file"])
            self.assertTrue(os.path.isfile(os.path.join(self.dirs["output"], *placed["file"].split("/"))))
            r = await c.post("/imageviewer/comp_ai_place", json={"job": prep["job"], "image": {"filename": "../../x.png", "type": "output"}})
            self.assertEqual(r.status, 404)
            r = await c.post("/imageviewer/comp_ai", json={"path": "/etc/x.comp.json", "comp": comp, "node": "AI1", "frame": 0})
            self.assertEqual(r.status, 403)
            return placed
        placed = self.run_c(go)
        # The node shows it: the plate where the matte is white, nothing where it is black.
        comp["nodes"][1]["results"] = {"frames": {"2": placed["file"]}, "keys": {}}
        io = importlib.import_module(self.pkg + ".comp_io")
        src = io.Sources(comp_path)
        try:
            img = self.M.render_node(comp, "Output1", 3, src, 1.0)
        finally:
            src.close()
        self.assertGreater(float(img[20, 10, 3]), 0.99)
        self.assertLess(float(img[20, 50, 3]), 0.01)
        self.assertGreater(float(img[20, 10, 0]), 0.3)

    def test_ai_actions(self):
        self.assertEqual(self.AI.action_of("inpaint", ""), ("remove", ""))
        self.assertEqual(self.AI.action_of("inpaint", "a tree")[0], "fill")
        self.assertEqual(self.AI.action_of("depth", "")[0], "edit")
        with self.assertRaises(self.AI.AiError):
            self.AI.action_of("relight", "")

    # ── a frame range as one job; picking the models ──

    MODELS = {"checkpoints": ["base.safetensors", "sub/other.safetensors"], "upscale_models": ["x2.pth", "x4.pth"]}

    def _fake_models(self):
        """The routes' folder_paths with a few model files listed (taken off again by the test's cleanup)."""
        fp = sys.modules[self.pkg + ".viewer_api"].folder_paths
        lists = self.MODELS
        fp.folder_names_and_paths = {k: ([], set()) for k in lists}
        fp.get_filename_list = lambda f: list(lists.get(f, []))
        fp.get_full_path = lambda f, n: (n if n in lists.get(f, []) else None)

        def undo():
            for k in ("folder_names_and_paths", "get_filename_list", "get_full_path"):
                if hasattr(fp, k):
                    delattr(fp, k)
        self.addCleanup(undo)
        return fp

    LOADER_FLOW = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "base.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "x", "clip": ["1", 1]}},
        "3": {"class_type": "LoadImage", "_meta": {"title": "paint:image"}, "inputs": {"image": "x.png"}},
        "4": {"class_type": "VAEEncode", "inputs": {"pixels": ["3", 0], "vae": ["1", 2]}},
        "5": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["2", 0], "negative": ["2", 0],
                                                   "latent_image": ["4", 0], "seed": 1, "steps": 4}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "_meta": {"title": "paint:output"}, "inputs": {"images": ["6", 0], "filename_prefix": "x"}},
    }

    def test_merged_graphs_share_what_is_the_same_and_keep_an_output_per_frame(self):
        import copy
        gs = []
        for i in range(3):
            g = copy.deepcopy(self.LOADER_FLOW)
            g["3"]["inputs"]["image"] = f"f{i}.png"
            gs.append(g)
        merged, outs = self.AI.merge_graphs(gs, ["7", "7", "7"])
        kinds = [v["class_type"] for v in merged.values()]
        self.assertEqual(kinds.count("CheckpointLoaderSimple"), 1)
        self.assertEqual(kinds.count("CLIPTextEncode"), 1)
        self.assertEqual(kinds.count("LoadImage"), 3)
        self.assertEqual(kinds.count("KSampler"), 3)
        self.assertEqual(kinds.count("SaveImage"), 3)
        self.assertEqual(len(set(outs)), 3)
        for o in outs:      # each output reads its own frame's chain
            dec = merged[merged[o]["inputs"]["images"][0]]
            self.assertEqual(dec["class_type"], "VAEDecode")
        loads = {merged[k]["inputs"]["image"] for k in merged if merged[k]["class_type"] == "LoadImage"}
        self.assertEqual(loads, {"f0.png", "f1.png", "f2.png"})

    def test_a_frame_range_is_one_job_and_comes_back_as_a_png_sequence(self):
        self._fake_models()
        self.G.set_custom("background", self.LOADER_FLOW, "test matte with a model")
        self.G.set_choice("background", "custom")
        comp_path = os.path.join(self.dirs["output"], "seq.comp.json")
        comp = {"comp": 1, "format": {"width": 60, "height": 40, "fps": 24, "frames": 6}, "output": "Output1",
                "nodes": [{"id": "Read1", "type": "read", "file": "plate.png", "inputs": []},
                          {"id": "AI1", "type": "ai_matte", "inputs": ["Read1"], "models": {"1.ckpt_name": "sub/other.safetensors"}},
                          {"id": "Output1", "type": "output", "inputs": ["AI1"]}]}
        from PIL import Image

        async def go(c):
            r = await c.post("/imageviewer/comp_ai_batch", json={"path": comp_path, "comp": comp, "node": "AI1", "frames": [1, 2, 3, 4]})
            prep = await r.json()
            self.assertEqual(r.status, 200, prep)
            g = prep["graph"]
            kinds = [v["class_type"] for v in g.values()]
            self.assertEqual(kinds.count("CheckpointLoaderSimple"), 1)    # the model loads once
            self.assertEqual(kinds.count("SaveImage"), 4)
            loader = next(v for v in g.values() if v["class_type"] == "CheckpointLoaderSimple")
            self.assertEqual(loader["inputs"]["ckpt_name"], "sub/other.safetensors")   # the node's own pick
            seeds = {v["inputs"]["seed"] for v in g.values() if v["class_type"] == "KSampler"}
            self.assertEqual(len(seeds), 1)                                # one seed for the run
            self.assertEqual(sorted(prep["outputs"]), ["1", "2", "3", "4"])
            prefixes = sorted(g[o]["inputs"]["filename_prefix"] for o in prep["outputs"].values())
            self.assertTrue(prefixes[0].endswith("AI1.0001"), prefixes)
            # The answers: a matte per frame, wider white each frame.
            os.makedirs(os.path.join(self.dirs["output"], "gen"), exist_ok=True)
            images = {}
            for f in prep["frames"]:
                ans = np.zeros((40, 60, 3), np.uint8)
                ans[:, : 10 * f] = 255
                Image.fromarray(ans, "RGB").save(os.path.join(self.dirs["output"], "gen", f"b{f}.png"))
                images[str(f)] = {"filename": f"b{f}.png", "subfolder": "gen", "type": "output"}
            images["5"] = {"filename": "../../../x.png", "type": "output"}
            r = await c.post("/imageviewer/comp_ai_batch_place", json={"run": prep["run"], "images": images})
            placed = await r.json()
            self.assertEqual(r.status, 200, placed)
            self.assertEqual(sorted(placed["frames"]), ["1", "2", "3", "4"])
            self.assertEqual(placed["missing"], [5])
            self.assertEqual(placed["frames"]["3"], f"seq_ai/AI1/{prep['run']}/AI1_matte.0003.png")
            for rel in placed["frames"].values():
                self.assertTrue(os.path.isfile(os.path.join(self.dirs["output"], *rel.split("/"))))
            r = await c.post("/imageviewer/comp_ai_batch_place", json={"run": "nope", "images": images})
            self.assertEqual(r.status, 400)
            # A file outside the model folders is refused.
            bad = dict(comp, nodes=[comp["nodes"][0], dict(comp["nodes"][1], models={"1.ckpt_name": "../evil.safetensors"}), comp["nodes"][2]])
            r = await c.post("/imageviewer/comp_ai_batch", json={"path": comp_path, "comp": bad, "node": "AI1", "frames": [1]})
            self.assertEqual(r.status, 400)
            return placed
        placed = self.run_c(go)
        comp["nodes"][1]["results"] = {"frames": placed["frames"], "keys": {}}
        io = importlib.import_module(self.pkg + ".comp_io")
        src = io.Sources(comp_path)
        try:
            one = self.M.render_node(comp, "Output1", 1, src, 1.0)
            four = self.M.render_node(comp, "Output1", 4, src, 1.0)
        finally:
            src.close()
        self.assertGreater(float(one[20, 5, 3]), 0.99)     # frame 1: white to x = 10
        self.assertLess(float(one[20, 20, 3]), 0.01)
        self.assertGreater(float(four[20, 35, 3]), 0.99)   # frame 4: white to x = 40

    def test_the_models_a_workflow_can_take_are_listed_from_the_model_folders(self):
        fp = self._fake_models()
        got = self.G.model_inputs(self.LOADER_FLOW, fp)
        self.assertEqual([m["key"] for m in got], ["1.ckpt_name"])
        self.assertEqual(got[0]["folder"], "checkpoints")
        self.assertEqual(got[0]["options"], ["base.safetensors", "sub/other.safetensors"])
        # A node pack's own loader: found by the folder that lists its file.
        g = {"1": {"class_type": "SomePackUpscaler", "inputs": {"model": "x2.pth", "tile": 512}}}
        got = self.G.model_inputs(g, fp)
        self.assertEqual([(m["key"], m["folder"]) for m in got], [("1.model", "upscale_models")])
        self.G.apply_models(g, {"1.model": "x4.pth"}, fp)
        self.assertEqual(g["1"]["inputs"]["model"], "x4.pth")
        with self.assertRaises(self.G.GenerateError):
            self.G.apply_models(g, {"1.model": "C:/elsewhere/x8.pth"}, fp)

        async def go(c):
            self.G.set_custom("upscale", self.LOADER_FLOW, "with a model")
            r = await c.post("/imageviewer/comp_ai_models", json={"action": "upscale", "workflow": "custom"})
            res = await r.json()
            self.assertEqual(r.status, 200, res)
            self.assertEqual(res["inputs"][0]["options"], ["base.safetensors", "sub/other.safetensors"])
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
