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


if __name__ == "__main__":
    unittest.main()
