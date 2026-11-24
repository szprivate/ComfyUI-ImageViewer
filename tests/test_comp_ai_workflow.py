"""A ComfyUI workflow of the user's own in a Comp AI node (comp_ai_workflow): what it takes and gives, filled in
per frame as ONE prompt, run once without inputs, and what came back laid beside the comp - the AI Workflow node's
picture and layers, and an AI Matte's matte through the node's own finishing.

    python -m unittest discover -s tests -p test_comp_ai_workflow.py
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


def flow():
    """A workflow as the canvas's prompt has it: a plate and a mask in, a sampler whose steps and denoise are the
    comp's, a prompt, a main save and a second save titled depth."""
    return {
        "1": {"class_type": "LoadImage", "_meta": {"title": "comp:plate"}, "inputs": {"image": "x.png", "upload": "image"}},
        "2": {"class_type": "LoadImageMask", "_meta": {"title": "Load Image (as Mask)"}, "inputs": {"image": "m.png", "channel": "alpha"}},
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "_meta": {"title": "Positive"}, "inputs": {"text": "a car", "clip": ["3", 1]}},
        "5": {"class_type": "KSampler", "_meta": {"title": "comp:sampler"},
              "inputs": {"seed": 5, "steps": 20, "denoise": 0.6, "model": ["3", 0], "positive": ["4", 0]}},
        "6": {"class_type": "SaveImage", "_meta": {"title": "comp:out"}, "inputs": {"images": ["5", 0], "filename_prefix": "a"}},
        "7": {"class_type": "PreviewImage", "_meta": {"title": "depth"}, "inputs": {"images": ["5", 0]}},
        "8": {"class_type": "Note", "inputs": {}},
    }


@unittest.skipIf(web is None, "needs aiohttp")
class CompAiWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.W = importlib.import_module(cls.pkg + ".comp_ai_workflow")
        cls.M = importlib.import_module(cls.pkg + ".comp_model")
        from PIL import Image
        a = np.zeros((40, 60, 4), np.uint8)
        a[..., 0] = 200
        a[..., 3] = 255
        Image.fromarray(a, "RGBA").save(os.path.join(cls.dirs["output"], "plate.png"))
        m = np.zeros((40, 60, 4), np.uint8)
        m[:, :30, 3] = 255
        Image.fromarray(m, "RGBA").save(os.path.join(cls.dirs["output"], "half.png"))

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

    def save(self, name, px):
        from PIL import Image
        d = os.path.join(self.dirs["output"], "gen")
        os.makedirs(d, exist_ok=True)
        Image.fromarray(px).save(os.path.join(d, name))
        return {"filename": name, "subfolder": "gen", "type": "output"}

    def test_what_a_workflow_takes_and_gives(self):
        info = self.W.inspect(flow())
        self.assertEqual([(x["name"], x["node"], x["kind"]) for x in info["inputs"]], [("plate", "1", "picture"), ("mask", "2", "mask")])
        self.assertEqual([(x["name"], x["node"]) for x in info["outputs"]], [("out", "6"), ("depth", "7")])
        ps = {p["id"]: p for p in info["params"]}
        self.assertEqual(set(ps), {"wf_prompt", "wf_sampler_seed", "wf_sampler_steps", "wf_sampler_denoise"})
        self.assertEqual((ps["wf_sampler_steps"]["kind"], ps["wf_sampler_steps"]["def"]), ("int", 20))
        self.assertEqual(ps["wf_sampler_denoise"]["kind"], "num")
        self.assertEqual((ps["wf_prompt"]["node"], ps["wf_prompt"]["input"], ps["wf_prompt"]["kind"]), ("4", "text", "prompt"))
        self.assertEqual(info["seeds"], [])       # the sampler's seed is the comp's (titled comp:)
        c = self.W.make_custom(flow(), "Mine", "canvas")
        self.assertNotIn("8", c["graph"])         # notes are not run
        self.assertEqual((c["name"], c["source"]), ("Mine", "canvas"))
        with self.assertRaises(self.W.WorkflowError):
            self.W.make_custom({"nodes": [], "links": []})          # the canvas's own format: the page turns it into a prompt
        with self.assertRaises(self.W.WorkflowError):
            self.W.make_custom({"1": {"class_type": "LoadImage", "inputs": {"image": "x"}}})   # saves nothing

    def test_the_viewers_send_node_counts_as_the_workflows_save(self):
        """Sebastian 2026-11-24: From canvas did nothing on a canvas that ends in Send to Image Viewer - it saved
        nothing the comp knew. It stands for a SaveImage now, so running the job pushes nothing into the viewer."""
        g = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
             "2": {"class_type": "ImageInvert", "inputs": {"image": ["1", 0]}},
             "3": {"class_type": "ImageViewerSend", "_meta": {"title": "comp:out"}, "inputs": {"input": ["2", 0], "file_format": "png"}},
             "4": {"class_type": "bEpicSendToViewer", "inputs": {"input": ["1", 0]}},
             "5": {"class_type": "ImageViewerSend", "inputs": {"input": "not a link"}}}
        c = self.W.make_custom(g, "canvas", "canvas")
        self.assertEqual(c["graph"]["3"], {"class_type": "SaveImage", "_meta": {"title": "comp:out"},
                                           "inputs": {"images": ["2", 0], "filename_prefix": "comp/ai"}})
        self.assertEqual(c["graph"]["4"]["class_type"], "SaveImage")
        self.assertNotIn("5", c["graph"])
        self.assertEqual([(x["name"], x["node"]) for x in c["outputs"]], [("out", "3"), ("out2", "4")])

    def comp(self, custom, kind="ai_workflow", **node):
        n = {"id": "AI1", "type": kind, "inputs": ["Read1", "Mask1"], "custom": custom, **node}
        return {"comp": 1, "format": {"width": 60, "height": 40, "fps": 24, "frames": 4}, "output": "Output1",
                "nodes": [{"id": "Read1", "type": "read", "file": "plate.png", "inputs": []},
                          {"id": "Mask1", "type": "read", "file": "half.png", "inputs": []},
                          n, {"id": "Output1", "type": "output", "inputs": ["AI1"]}]}

    def _fake_models(self, lists):
        fp = sys.modules[self.pkg + ".viewer_api"].folder_paths
        fp.folder_names_and_paths = {k: ([], set()) for k in lists}
        fp.get_filename_list = lambda f: list(lists.get(f, []))
        fp.get_full_path = lambda f, n: (n if n in lists.get(f, []) else None)

        def undo():
            for k in ("folder_names_and_paths", "get_filename_list", "get_full_path"):
                if hasattr(fp, k):
                    delattr(fp, k)
        self.addCleanup(undo)

    def test_an_ai_workflow_node_runs_its_frames_as_one_prompt_and_gets_a_picture_and_a_layer(self):
        from PIL import Image
        self._fake_models({"checkpoints": ["sd.safetensors"]})
        custom = self.W.make_custom(flow(), "Mine")
        comp_path = os.path.join(self.dirs["output"], "wf.comp.json")
        comp = self.comp(custom, wf_sampler_steps=8, tracks={"wf_sampler_denoise": [{"f": 0, "v": 0.2}, {"f": 2, "v": 0.6}]})
        self.assertEqual(self.M.inputs_of(comp["nodes"][2]), ["plate", "mask"])
        self.assertAlmostEqual(self.M.param_at(comp["nodes"][2], "wf_sampler_denoise", 1), 0.4, 3)

        async def go(c):
            r = await c.post("/imageviewer/comp_ai_inspect", json={"graph": {"output": flow()}, "name": "x"})
            got = await r.json()
            self.assertEqual(r.status, 200, got)
            self.assertEqual(got["custom"]["outputs"][1]["name"], "depth")
            r = await c.post("/imageviewer/comp_ai_custom", json={"path": comp_path, "comp": comp, "node": "AI1", "frames": [0, 1, 2]})
            prep = await r.json()
            self.assertEqual(r.status, 200, prep)
            self.assertEqual(prep["mode"], "frames")
            g = prep["graph"]
            kinds = [v["class_type"] for v in g.values()]
            self.assertEqual(kinds.count("CheckpointLoaderSimple"), 1)     # the model loads once
            self.assertEqual(kinds.count("LoadImage"), 3)
            self.assertEqual(kinds.count("KSampler"), 3)
            samplers = sorted((v["inputs"]["denoise"], v["inputs"]["steps"], v["inputs"]["seed"]) for v in g.values() if v["class_type"] == "KSampler")
            self.assertEqual([round(s[0], 3) for s in samplers], [0.2, 0.4, 0.6])     # the keys, frame by frame
            self.assertEqual({s[1] for s in samplers}, {8})
            masks = [v for v in g.values() if v["class_type"] == "LoadImageMask"]
            self.assertEqual({m["inputs"]["channel"] for m in masks}, {"red"})
            sent = np.asarray(Image.open(os.path.join(self.dirs["input"], masks[0]["inputs"]["image"])))
            self.assertEqual(sent.ndim, 2)
            self.assertEqual((int(sent[5, 5]), int(sent[5, 50])), (255, 0))    # the mask's alpha, white = in it
            self.assertEqual(len(prep["outputs"]), 6)
            images = {}
            for nid, (f, name) in prep["outputs"].items():
                px = np.zeros((20, 30, 3), np.uint8)
                px[...] = 40 * (f + 1) if name == "out" else 250
                images[nid] = [self.save(f"{name}{f}.png", px)]
            r = await c.post("/imageviewer/comp_ai_custom_place", json={"run": prep["run"], "images": images})
            placed = await r.json()
            self.assertEqual(r.status, 200, placed)
            bad = {next(iter(images)): [{"filename": "../../x.png", "type": "output"}]}
            r = await c.post("/imageviewer/comp_ai_custom_place", json={"run": prep["run"], "images": bad})
            self.assertEqual(r.status, 404)
            r = await c.post("/imageviewer/comp_ai_custom", json={"path": "/etc/x.comp.json", "comp": comp, "node": "AI1", "frames": [0]})
            self.assertEqual(r.status, 403)
            return placed
        placed = self.run_c(go)
        self.assertEqual(sorted(placed["frames"]), ["0", "1", "2"])
        self.assertTrue(placed["frames"]["1"].startswith("wf_ai/AI1/"), placed["frames"])
        self.assertEqual(sorted(placed["layers"]["depth"]), ["0", "1", "2"])
        self.assertEqual((placed["width"], placed["height"]), (30, 20))
        n = comp["nodes"][2]
        n["results"] = {"frames": placed["frames"], "layers": placed["layers"], "width": 30, "height": 20}
        self.assertEqual(self.M.format_at(comp, "AI1"), {"width": 30, "height": 20})     # its result's size
        io = importlib.import_module(self.pkg + ".comp_io")
        src = io.Sources(comp_path)
        try:
            img, ex = self.M.render_node(comp, "AI1", 1, src, 1.0, channels=True)
        finally:
            src.close()
        self.assertEqual(img.shape[:2], (20, 30))
        self.assertIn("depth.r", ex)
        self.assertGreater(float(ex["depth.r"].mean()), 0.9)
        self.assertLess(float(img[..., 0].mean()), 0.2)        # frame 1's grey 80 (sRGB) as linear

    def test_a_workflow_without_inputs_runs_once_and_its_picture_is_held(self):
        g = {"1": {"class_type": "EmptyLatentImage", "inputs": {"width": 64, "height": 64}},
             "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "x"}}}
        comp_path = os.path.join(self.dirs["output"], "once.comp.json")
        comp = self.comp(self.W.make_custom(g))
        comp["nodes"][2]["inputs"] = []

        async def go(c):
            r = await c.post("/imageviewer/comp_ai_custom", json={"path": comp_path, "comp": comp, "node": "AI1", "frames": [0, 1, 2, 3]})
            prep = await r.json()
            self.assertEqual(r.status, 200, prep)
            self.assertEqual(prep["mode"], "once")
            self.assertEqual(len(prep["graph"]), 2)
            r = await c.post("/imageviewer/comp_ai_custom_place", json={"run": prep["run"], "images": {"2": [self.save("once.png", np.full((8, 8, 3), 9, np.uint8))]}})
            return await r.json()
        placed = self.run_c(go)
        self.assertEqual(list(placed["frames"]), ["0"])       # held over the frames (the nearest frame that ran)

    def test_a_film_a_workflow_saved_is_laid_on_the_frames(self):
        try:
            import av
        except ImportError:
            self.skipTest("needs PyAV")
        g = {"1": {"class_type": "EmptyLatentImage", "inputs": {"width": 64, "height": 64}},
             "2": {"class_type": "SaveVideo", "inputs": {"video": ["1", 0], "filename_prefix": "v"}}}
        comp_path = os.path.join(self.dirs["output"], "film.comp.json")
        comp = self.comp(self.W.make_custom(g))
        comp["nodes"][2]["inputs"] = []
        film = os.path.join(self.dirs["output"], "gen", "v.mp4")
        os.makedirs(os.path.dirname(film), exist_ok=True)
        with av.open(film, "w") as oc:
            st = oc.add_stream("mpeg4", rate=24)
            st.width, st.height, st.pix_fmt = 32, 16, "yuv420p"
            for i in range(4):
                fr = av.VideoFrame.from_ndarray(np.full((16, 32, 3), 60 * i, np.uint8), format="rgb24")
                for p in st.encode(fr):
                    oc.mux(p)
            for p in st.encode(None):
                oc.mux(p)

        async def go(c):
            r = await c.post("/imageviewer/comp_ai_custom", json={"path": comp_path, "comp": comp, "node": "AI1", "frames": [0, 1, 2, 3]})
            prep = await r.json()
            self.assertEqual(r.status, 200, prep)
            r = await c.post("/imageviewer/comp_ai_custom_place", json={"run": prep["run"], "images": {"2": [{"filename": "v.mp4", "subfolder": "gen", "type": "output"}]}})
            placed = await r.json()
            self.assertEqual(r.status, 200, placed)
            return placed
        placed = self.run_c(go)
        self.assertEqual(sorted(placed["frames"]), ["0", "1", "2", "3"])
        from PIL import Image
        last = np.asarray(Image.open(os.path.join(self.dirs["output"], *placed["frames"]["3"].split("/"))))
        self.assertGreater(int(last[..., 0].mean()), 140)

    def test_an_ai_matte_runs_its_own_workflow_with_its_own_finishing(self):
        g = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
             "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "x"}}}
        comp_path = os.path.join(self.dirs["output"], "matte.comp.json")
        comp = self.comp(self.W.make_custom(g), "ai_matte", workflow="custom")
        comp["nodes"][2]["inputs"] = ["Read1"]

        async def go(c):
            r = await c.post("/imageviewer/comp_ai_custom", json={"path": comp_path, "comp": comp, "node": "AI1", "frames": [1]})
            prep = await r.json()
            self.assertEqual(r.status, 200, prep)
            ans = np.zeros((40, 60, 3), np.uint8)
            ans[:, :30] = 255
            nid = next(iter(prep["outputs"]))
            r = await c.post("/imageviewer/comp_ai_custom_place", json={"run": prep["run"], "images": {nid: [self.save("mt.png", ans)]}})
            return await r.json()
        placed = self.run_c(go)
        self.assertEqual(placed["layers"], {})
        from PIL import Image
        m = np.asarray(Image.open(os.path.join(self.dirs["output"], *placed["frames"]["1"].split("/"))))
        self.assertEqual(m.ndim, 2)                            # a matte, as the node's own list makes it
        self.assertEqual((int(m[5, 5]), int(m[5, 50])), (255, 0))
        comp["nodes"][2]["workflow"] = None
        with self.assertRaises(self.W.WorkflowError):          # not picked: the node's own list runs
            self.W.prepare(comp, comp_path, "AI1", [0], None, self.dirs["input"])


if __name__ == "__main__":
    unittest.main()
