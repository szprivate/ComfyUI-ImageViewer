"""The 3D Render panel's AI workflow on the server (render3d_ai): which pass each loader takes, the passes written
into ComfyUI's input folder, the parameters, the seed and the save prefixes filled in; a film loader refused.

    python -m unittest discover -s tests -p test_render3d_ai.py
"""
import asyncio
import base64
import importlib
import io
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


def png(value, alpha=255):
    from PIL import Image
    a = np.full((12, 16, 4), value, np.uint8)
    a[..., 3] = alpha
    buf = io.BytesIO()
    Image.fromarray(a, "RGBA").save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def flow():
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": "x.png", "upload": "image"}},
        "2": {"class_type": "LoadImage", "_meta": {"title": "comp:depth"}, "inputs": {"image": "d.png"}},
        "3": {"class_type": "LoadImageMask", "inputs": {"image": "m.png", "channel": "alpha"}},
        "4": {"class_type": "LoadImage", "_meta": {"title": "comp:normals"}, "inputs": {"image": "n.png"}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "clay", "clip": ["9", 0]}},
        "6": {"class_type": "KSampler", "_meta": {"title": "comp:sampler"}, "inputs": {"seed": 1, "steps": 20, "model": ["9", 0]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": "x"}},
        "8": {"class_type": "SaveImage", "_meta": {"title": "comp:lines"}, "inputs": {"images": ["1", 0], "filename_prefix": "y"}},
    }


@unittest.skipIf(web is None, "needs aiohttp")
class PassNames(unittest.TestCase):
    def test_a_loader_takes_the_pass_its_name_says(self):
        tmp = tempfile.mkdtemp()
        _app, _dirs, pkg = _load(tmp, [])
        try:
            R = importlib.import_module(pkg + ".render3d_ai")
            self.assertEqual(R.pass_for("src", "picture"), "beauty")
            self.assertEqual(R.pass_for("Z", "picture"), "depth")
            self.assertEqual(R.pass_for("depth2", "picture"), "depth")
            self.assertEqual(R.pass_for("normal_map", "picture"), "normals")
            self.assertEqual(R.pass_for("matte", "picture"), "mask")
            self.assertEqual(R.pass_for("mask", "mask"), "mask")
            self.assertEqual(R.pass_for("image2", "picture"), "beauty")
            self.assertEqual(R.pass_for("whatever", "mask"), "mask")
        finally:
            for k in [k for k in sys.modules if k == pkg or k.startswith(pkg + ".")]:
                sys.modules.pop(k, None)
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipIf(web is None, "needs aiohttp")
class RenderAiRoute(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, [])
        cls.W = importlib.import_module(cls.pkg + ".comp_ai_workflow")

    @classmethod
    def tearDownClass(cls):
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

    def test_the_passes_go_into_the_workflow(self):
        from PIL import Image
        custom = self.W.make_custom(flow(), "Look")
        steps = next(p["id"] for p in custom["params"] if p["input"] == "steps")
        passes = {"beauty": png(200), "depth": png(120), "normals": png(128), "mask": png(255)}

        async def go(c):
            r = await c.post("/imageviewer/render3d_ai", json={"custom": custom, "passes": passes, "frame": 7,
                                                                "values": {steps: 6, "wf_prompt": "a red car"}})
            got = await r.json()
            self.assertEqual(r.status, 200, got)
            g = got["graph"]
            self.assertEqual(got["uses"], {"src": "beauty", "depth": "depth", "mask": "mask", "normals": "normals"})
            for k, p in (("1", "beauty"), ("2", "depth"), ("3", "mask"), ("4", "normals")):
                self.assertTrue(g[k]["inputs"]["image"].endswith(f"/{p}.0007.png"), g[k]["inputs"]["image"])
                self.assertTrue(os.path.isfile(os.path.join(self.dirs["input"], g[k]["inputs"]["image"])))
            self.assertEqual(g["3"]["inputs"]["channel"], "red")
            dep = np.asarray(Image.open(os.path.join(self.dirs["input"], g["2"]["inputs"]["image"])))
            self.assertEqual(int(dep[0, 0, 0]), 120)
            self.assertEqual(g["6"]["inputs"]["steps"], 6)
            self.assertEqual(g["5"]["inputs"]["text"], "a red car")
            self.assertEqual(got["main"], "out")
            self.assertEqual(sorted(got["outputs"].values()), ["lines", "out"])
            self.assertTrue(g["7"]["inputs"]["filename_prefix"].startswith(f"render3d/ai/{got['run']}/out.0007"))
            # A pass the workflow needs and the page did not send.
            r = await c.post("/imageviewer/render3d_ai", json={"custom": custom, "passes": {"beauty": png(1)}})
            self.assertEqual(r.status, 400)
            self.assertIn("pass", (await r.json())["error"])
            # A film loader is for sequences, not one frame.
            film = self.W.make_custom({"1": {"class_type": "LoadVideo", "inputs": {"file": "a.mp4"}},
                                       "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "z"}}}, "Film")
            r = await c.post("/imageviewer/render3d_ai", json={"custom": film, "passes": passes})
            self.assertEqual(r.status, 400)
            self.assertIn("film", (await r.json())["error"])
            r = await c.post("/imageviewer/render3d_ai", json={"custom": None, "passes": passes})
            self.assertEqual(r.status, 400)
        self.run_c(go)


@unittest.skipIf(web is None, "needs aiohttp")
class RealisticRender(unittest.TestCase):
    """The prepared "Realistic render" list: Z-Image Turbo with a depth ControlNet, Qwen Image Edit 2511, GPT Image 2.5."""

    def test_the_three_are_listed_and_take_the_right_passes(self):
        tmp = tempfile.mkdtemp()
        _app, dirs, pkg = _load(tmp, [])
        try:
            A = importlib.import_module(pkg + ".comp_ai")
            G = importlib.import_module(pkg + ".paint_generate")
            W = importlib.import_module(pkg + ".comp_ai_workflow")
            R = importlib.import_module(pkg + ".render3d_ai")
            got = A.workflows_for("render3d")
            self.assertEqual(got["action"], "render")
            ids = [w["id"] for w in got["workflows"]]
            self.assertEqual(ids, ["comp_r3_zimage_depth", "comp_r3_qwen2511", "comp_r3_gpt25"])
            self.assertTrue(next(w for w in got["workflows"] if w["id"] == "comp_r3_gpt25")["api"])
            want = {"comp_r3_zimage_depth": {"depth": "depth"},
                    "comp_r3_qwen2511": {"beauty": "beauty", "depth": "depth"},
                    "comp_r3_gpt25": {"beauty": "beauty", "depth": "depth"}}
            passes = {"beauty": png(200), "depth": png(120), "normals": png(128), "mask": png(255)}
            for wid, uses in want.items():
                e, g = G._builtin(wid)
                self.assertIsNotNone(g, wid)
                custom = W.make_custom(g, e["label"])
                prompt = [p for p in custom["params"] if p["id"] == "wf_prompt"]
                self.assertTrue(prompt, (wid, [p["id"] for p in custom["params"]]))
                k = prompt[0]["node"]
                self.assertNotIn("neg", (g[k].get("_meta") or {}).get("title", "").lower(), wid)
                res = R.prepare(custom, passes, dirs["input"], values={"wf_prompt": "a car in a canyon"})
                self.assertEqual(res["uses"], uses, wid)
                self.assertEqual(res["graph"][k]["inputs"][prompt[0]["input"]], "a car in a canyon", wid)
                self.assertEqual(res["main"], "out", wid)
            e, g = G._builtin("comp_r3_zimage_depth")
            custom = W.make_custom(g, e["label"])
            self.assertIn("wf_layout_strength", [p["id"] for p in custom["params"]])
        finally:
            for k in [k for k in sys.modules if k == pkg or k.startswith(pkg + ".")]:
                sys.modules.pop(k, None)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_reference_pictures_fill_the_ref_loaders_and_empty_slots_go(self):
        tmp = tempfile.mkdtemp()
        _app, dirs, pkg = _load(tmp, [])
        try:
            G = importlib.import_module(pkg + ".paint_generate")
            W = importlib.import_module(pkg + ".comp_ai_workflow")
            R = importlib.import_module(pkg + ".render3d_ai")
            self.assertEqual([R.ref_index(n) for n in ("ref", "ref1", "Ref 2", "reference_3", "style4", "ref5", "src", "image3")],
                             [1, 1, 2, 3, 4, 0, 0, 0])
            self.assertEqual(R.pass_for("ref2", "picture"), "ref2")
            self.assertEqual(R.pass_for("ref2", "mask"), "mask")
            passes = {"beauty": png(200), "depth": png(120), "normals": png(128), "mask": png(255)}
            # GPT 2.5: image_3 / image_4 are the references; with one picture image_4 and its loader go.
            e, g = G._builtin("comp_r3_gpt25")
            custom = W.make_custom(g, e["label"])
            res = R.prepare(custom, passes, dirs["input"], refs=[png(30)])
            self.assertEqual(res["uses"], {"beauty": "beauty", "depth": "depth", "ref1": "ref1"})
            self.assertEqual(res["refs"], 1)
            node = next(n for n in res["graph"].values() if n["class_type"] == "OpenAIGPTImageNodeV2")
            self.assertIn("model.images.image_3", node["inputs"])
            self.assertNotIn("model.images.image_4", node["inputs"])
            self.assertEqual(sum(1 for n in res["graph"].values() if n["class_type"] == "LoadImage"), 3)
            ref_file = next(n["inputs"]["image"] for n in res["graph"].values() if (n.get("_meta") or {}).get("title") == "comp:ref1")
            self.assertTrue(os.path.isfile(os.path.join(dirs["input"], *ref_file.split("/"))))
            # Qwen 2511: image3 on both encoders, or no image3 without a picture.
            e, g = G._builtin("comp_r3_qwen2511")
            custom = W.make_custom(g, e["label"])
            enc = lambda r: [n for n in r["graph"].values() if n["class_type"] == "TextEncodeQwenImageEditPlus"]
            with_ref = R.prepare(custom, passes, dirs["input"], refs=[png(30), png(60)])
            self.assertTrue(all("image3" in n["inputs"] for n in enc(with_ref)))
            self.assertEqual(with_ref["refs"], 1)          # it has one slot
            without = R.prepare(custom, passes, dirs["input"])
            self.assertTrue(all("image3" not in n["inputs"] for n in enc(without)))
            with self.assertRaises(R.RenderAiError):
                R.prepare(custom, passes, dirs["input"], refs=["data:text/plain;base64,aGk="])
        finally:
            for k in [k for k in sys.modules if k == pkg or k.startswith(pkg + ".")]:
                sys.modules.pop(k, None)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
