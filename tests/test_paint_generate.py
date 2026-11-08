"""Paint's Generate with ready-made workflows (paint_generate.py) through the REAL routes: the built-in
table, the slots found in a workflow, the missing-model check, the crop and the PNG a workflow loads,
placing the result back as a layer, and the user's own workflow kept in place of a built-in one.

    python -m unittest discover -s tests -p test_paint_generate.py
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

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer


@unittest.skipIf(web is None, "needs aiohttp")
class PaintGenerate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.flows = os.path.join(cls.tmp, "flows")
        os.environ["IMAGE_VIEWER_PAINT_WORKFLOWS"] = cls.flows
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.G = importlib.import_module(cls.pkg + ".paint_generate")
        cls.P = importlib.import_module(cls.pkg + ".paint_io")
        api = importlib.import_module(cls.pkg + ".viewer_api")
        cls.fp = api.folder_paths
        cls.have = set()
        cls.fp.get_full_path = lambda folder, name: (f"/models/{folder}/{name}" if name in cls.have or "*" in cls.have else None)
        cls.listed = {}
        cls.fp.get_filename_list = lambda folder: list(cls.listed.get(folder, []))
        from PIL import Image
        cls.png = os.path.join(cls.dirs["output"], "pic.png")
        a = np.zeros((100, 200, 4), np.uint8)
        a[..., 2] = 200
        a[..., 3] = 255
        Image.fromarray(a, "RGBA").save(cls.png)

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("IMAGE_VIEWER_PAINT_WORKFLOWS", None)
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        shutil.rmtree(self.flows, ignore_errors=True)
        self.have.clear()
        self.have.add("*")
        self.listed.clear()

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

    async def open_with_selection(self, c, rect=(60, 30, 40, 20)):
        st, d = await self.j(c, "/imageviewer/paint/open", {"path": self.png})
        self.assertEqual(st, 200, d)
        tok = d["token"]
        x, y, w, h = rect
        st, d = await self.j(c, "/imageviewer/paint/doc", {"doc": tok, "write": False,
                                                           "ops": [{"op": "select", "mode": "rect", "x": x, "y": y, "w": w, "h": h}]})
        self.assertEqual(st, 200, d)
        return tok

    def fake_result(self, w, h, rgb=(255, 0, 0)):
        from PIL import Image
        folder = os.path.join(self.dirs["output"], "paint", "generate")
        os.makedirs(folder, exist_ok=True)
        a = np.zeros((h, w, 4), np.uint8)
        a[..., :3] = rgb
        a[..., 3] = 255
        Image.fromarray(a, "RGBA").save(os.path.join(folder, "fill_00001_.png"))
        return {"filename": "fill_00001_.png", "subfolder": "paint/generate", "type": "output"}

    def test_every_built_in_workflow_has_its_slots(self):
        for e in self.G.builtins():
            _e, g = self.G._builtin(e["id"])
            s = self.G.detect_slots(g)
            self.assertTrue(s["image"] and s["output"], e["id"])
            if set(e["actions"]) & {"fill", "edit"}:
                self.assertTrue(s["prompt"], e["id"])
            for a in e["actions"]:
                self.assertIn(a, self.G.ACTIONS)
        # Every action has a default, the first in the table.
        self.assertEqual(self.G.choices()["fill"], "flux_fill")
        self.assertEqual(self.G.choices()["remove"], "flux_fill")
        self.assertEqual(self.G.choices()["upscale"], "upscale_model")

    def test_slots_found_without_titles(self):
        g = {"3": {"class_type": "KSampler", "inputs": {"seed": 5, "steps": 4}},
             "4": {"class_type": "CLIPTextEncode", "_meta": {"title": "Negative"}, "inputs": {"text": "blurry"}},
             "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat"}},
             "7": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
             "8": {"class_type": "LoadImageMask", "inputs": {"image": "m.png", "channel": "alpha"}},
             "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "x"}}}
        s = self.G.detect_slots(g)
        self.assertEqual((s["image"], s["mask"], s["prompt"], s["output"], s["seeds"]),
                         ("7", "8", ["5", "text"], "9", [["3", "seed"]]))

    def test_listing_names_missing_models(self):
        self.have.clear()
        self.have.add("ae.safetensors")
        L = self.G.listing(self.fp, None)
        flux = next(w for w in L["actions"]["fill"]["workflows"] if w["id"] == "flux_fill")
        self.assertIn("flux1-fill-dev.safetensors", [m["what"] for m in flux["missing"]])
        self.assertNotIn("ae.safetensors", [m["what"] for m in flux["missing"]])
        self.assertTrue(any(w["api"] for w in L["actions"]["fill"]["workflows"]))

    def test_fill_cuts_out_the_selection_with_context_and_places_the_result(self):
        async def go(c):
            tok = await self.open_with_selection(c)
            st, d = await self.j(c, "/imageviewer/paint/generate", {"token": tok, "action": "fill"})
            self.assertEqual(st, 400)                   # no prompt
            st, d = await self.j(c, "/imageviewer/paint/generate", {"token": tok, "action": "fill", "prompt": "a red ball", "variations": 2})
            self.assertEqual(st, 200, d)
            # The selection 40x20 at 60,30 with 32 px of context (a quarter of 40 is less), held to the canvas.
            self.assertEqual(d["box"], [28, 0, 104, 82])
            self.assertEqual(len(d["graphs"]), 2)
            g = d["graphs"][0]
            self.assertEqual(g["5"]["inputs"]["text"], "a red ball")
            self.assertNotEqual(g["10"]["inputs"]["seed"], d["graphs"][1]["10"]["inputs"]["seed"])
            name = g["1"]["inputs"]["image"]
            from PIL import Image
            im = np.asarray(Image.open(os.path.join(self.dirs["input"], name)).convert("RGBA"))
            tw, th = d["size"]
            self.assertEqual(im.shape[:2], (th, tw))
            self.assertEqual((tw % 16, th % 16), (0, 0))
            self.assertAlmostEqual(tw * th / 1e6, 1.0, delta=0.1)
            # Alpha = 255 - selection: LoadImage's mask is the place to change.
            self.assertEqual(im[th // 2, tw // 2, 3], 0)
            self.assertEqual(im[2, 2, 3], 255)
            # The result comes back at the box, masked to the selection, as a layer.
            img = self.fake_result(tw, th)
            st, p = await self.j(c, "/imageviewer/paint/generate_place", {"job": d["job"], "image": img})
            self.assertEqual(st, 200, p)
            self.assertEqual(p["token"], tok)
            op = p["ops"][0]
            self.assertEqual((op["op"], op["x"], op["y"], op["mask"]), ("add_layer", 28, 0, "selection"))
            st, r = await self.j(c, "/imageviewer/paint/doc", {"doc": tok, "ops": p["ops"], "write": False})
            self.assertEqual(st, 200, r)
            L = r["outline"]["layers"][0]
            self.assertEqual((L["w"], L["h"], L["x"], L["y"]), (104, 82, 28, 0))
        self.run_c(go)

    def test_models_in_subfolders_of_other_model_paths_are_found(self):
        # an extra model path (L:) with the files in folders of their own: ComfyUI lists them as
        # "flux\\flux1-fill-dev.safetensors", and the workflow is pointed at that name
        self.have.clear()
        self.listed.update({"unet": ["FLUX\\Flux1-Fill-Dev.safetensors"],
                            "clip": ["flux/clip_l.safetensors", "t5/t5xxl_fp16.safetensors", "old/deep/clip_l.safetensors"],
                            "vae": ["flux/ae.safetensors"]})
        L = self.G.listing(self.fp, None)
        flux = next(w for w in L["actions"]["fill"]["workflows"] if w["id"] == "flux_fill")
        self.assertEqual(flux["missing"], [])
        async def go(c):
            tok = await self.open_with_selection(c)
            st, d = await self.j(c, "/imageviewer/paint/generate", {"token": tok, "action": "fill", "prompt": "a cat"})
            self.assertEqual(st, 200, d)
            g = d["graphs"][0]
            names = {k: v for n in g.values() for k, v in (n.get("inputs") or {}).items() if k.endswith("_name") or k.startswith("clip_name")}
            self.assertEqual(names["unet_name"], "FLUX\\Flux1-Fill-Dev.safetensors")
            self.assertEqual(names["clip_name1"], "flux/clip_l.safetensors")
            self.assertEqual(names["clip_name2"], "t5/t5xxl_fp16.safetensors")
            self.assertEqual(names["vae_name"], "flux/ae.safetensors")
        self.run_c(go)

    def test_a_missing_model_is_named_before_anything_is_queued(self):
        self.have.clear()
        async def go(c):
            tok = await self.open_with_selection(c)
            st, d = await self.j(c, "/imageviewer/paint/generate", {"token": tok, "action": "fill", "prompt": "x"})
            self.assertEqual(st, 409)
            self.assertIn("flux1-fill-dev.safetensors", [m["what"] for m in d["missing"]])
        self.run_c(go)

    def test_remove_needs_a_selection_and_upscale_grows_the_canvas(self):
        async def go(c):
            st, o = await self.j(c, "/imageviewer/paint/open", {"path": self.png})
            tok = o["token"]
            st, d = await self.j(c, "/imageviewer/paint/generate", {"token": tok, "action": "remove"})
            self.assertEqual(st, 400)
            st, d = await self.j(c, "/imageviewer/paint/generate", {"token": tok, "action": "upscale", "k": 2})
            self.assertEqual(st, 200, d)
            self.assertEqual(d["size"], [200, 100])
            img = self.fake_result(800, 400)
            st, p = await self.j(c, "/imageviewer/paint/generate_place", {"job": d["job"], "image": img})
            st, r = await self.j(c, "/imageviewer/paint/doc", {"doc": tok, "ops": p["ops"], "write": False})
            self.assertEqual(st, 200, r)
            self.assertEqual((r["outline"]["w"], r["outline"]["h"]), (400, 200))
        self.run_c(go)

    def test_the_users_own_workflow_takes_the_place_of_the_built_in_one(self):
        mine = {"1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
                "2": {"class_type": "MyInpaint", "inputs": {"image": ["1", 0], "mask": ["1", 1], "prompt": "", "seed": 1}},
                "3": {"class_type": "PreviewImage", "inputs": {"images": ["2", 0]}}}
        async def go(c):
            st, d = await self.j(c, "/imageviewer/paint/workflows", {"action": "fill", "graph": {"nodes": [], "links": []}})
            self.assertEqual(st, 400)
            self.assertIn("API", d["error"])
            st, d = await self.j(c, "/imageviewer/paint/workflows", {"action": "fill", "graph": {"output": mine, "workflow": {}},
                                                                     "name": "Mine", "source": "canvas"})
            self.assertEqual(st, 200, d)
            self.assertEqual(d["actions"]["fill"]["choice"], "custom")
            self.assertEqual(d["actions"]["fill"]["custom"]["name"], "Mine")
            self.assertEqual(d["slots"]["prompt"], ["2", "prompt"])
            self.assertTrue(os.path.isfile(os.path.join(self.flows, "fill.json")))
            tok = await self.open_with_selection(c)
            st, g = await self.j(c, "/imageviewer/paint/generate", {"token": tok, "action": "fill", "prompt": "a boat"})
            self.assertEqual(st, 200, g)
            self.assertEqual(g["graphs"][0]["2"]["inputs"]["prompt"], "a boat")
            self.assertEqual(g["output"], "3")
            # Back to a built-in one, then the user's taken away.
            st, d = await self.j(c, "/imageviewer/paint/workflows", {"action": "fill", "choice": "gpt_image_2_inpaint"})
            self.assertEqual(d["actions"]["fill"]["choice"], "gpt_image_2_inpaint")
            st, d = await self.j(c, "/imageviewer/paint/workflows", {"action": "fill", "graph": None})
            self.assertIsNone(d["actions"]["fill"]["custom"])
            st, d = await self.j(c, "/imageviewer/paint/workflows", {"action": "fill", "choice": "custom"})
            self.assertEqual(st, 400)
            r = await c.get("/imageviewer/paint/workflows")
            self.assertEqual((await r.json())["actions"]["fill"]["choice"], "gpt_image_2_inpaint")
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
