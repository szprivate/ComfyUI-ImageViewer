"""The History's VFX actions on a clip (clip_vfx.py) through the REAL routes: each action's graph filled from
its options, the clip cut to 8n + 1 frames (and a long alpha clip into runs of 121), the missing-model check
before anything is written, a clip in the input folder read as it is, the result handed back (runs joined,
an HDR pass's EXR frames found, the parts removed), and the refusals.

    python -m unittest discover -s tests -p test_clip_vfx.py

The film writing and joining (timeline_render, PyAV) is replaced by stand-ins here; it is the Edit panel's
renderer, tested on its own.
"""
import asyncio
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest


def _put(path, data):
    with open(path, "wb") as f:
        f.write(data)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


@unittest.skipIf(web is None, "needs aiohttp")
class ClipVfx(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.V = importlib.import_module(cls.pkg + ".clip_vfx")
        api = importlib.import_module(cls.pkg + ".viewer_api")
        cls.fp = api.folder_paths
        cls.have = {"*"}
        cls.fp.get_full_path = lambda folder, name: (f"/m/{folder}/{name}" if "*" in cls.have or name in cls.have else None)
        cls.fp.get_filename_list = lambda folder: []
        cls.clip = os.path.join(cls.dirs["output"], "shot 01.mp4")
        _put(cls.clip, b"film")
        cls.facts = {"frames": 100, "fps": 24.0, "width": 854, "height": 480, "seconds": 100 / 24}
        cls.written, cls.joined = [], []
        cls.V.probe = lambda path: dict(cls.facts)

        def write(path, first, n, fps, out, may_use=None):
            cls.written.append((os.path.basename(path), first, n, fps))
            _put(out, b"part")
        cls.V.write_part = write

        def join(paths, fps, out, may_use=None):
            cls.joined.append([os.path.basename(p) for p in paths])
            _put(out, b"joined")
        cls.V.join = join

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.have.clear()
        self.have.add("*")
        self.written.clear()
        self.joined.clear()
        self.facts.update(frames=100)

    def run_c(self, fn):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    @staticmethod
    async def j(c, route, body):
        r = await c.post(route, json=body)
        return r.status, await r.json()

    def prepare(self, action, options=None, source=None):
        return self.run_c(lambda c: self.j(c, "/imageviewer/clip_vfx/prepare",
                                           {"source": source or {"path": self.clip}, "action": action, "options": options or {}}))

    def out_ref(self, name, sub="ltx_vfx"):
        os.makedirs(os.path.join(self.dirs["output"], sub), exist_ok=True)
        _put(os.path.join(self.dirs["output"], sub, name), b"result")
        return {"filename": name, "subfolder": sub, "type": "output"}

    # ── the frames ──

    def test_runs_are_8n_plus_1_and_alpha_is_cut_into_runs_of_121(self):
        V = self.V
        self.assertEqual(V.plan(97), [(0, 97)])
        self.assertEqual(V.plan(100), [(0, 97)])
        self.assertEqual(V.plan(300, 121), [(0, 121), (121, 121), (242, 57)])
        self.assertEqual(V.plan(250, 121), [(0, 121), (121, 121)])          # 8 left over: no run
        with self.assertRaises(V.VfxError):
            V.plan(8)

    # ── each action's graph ──

    def test_each_action_fills_its_workflow(self):
        V = self.V
        g, save = V.graph_for("reframe", {"width": 1080, "height": 1900, "prompt": "a beach"}, "clip_vfx/a.mp4", "ltx_vfx/a_reframe")
        self.assertEqual(g[save]["class_type"], "SaveVideo")
        self.assertEqual(g[save]["inputs"]["filename_prefix"], "ltx_vfx/a_reframe")
        self.assertEqual(g["5368"]["inputs"]["file"], "clip_vfx/a.mp4")
        self.assertEqual(g["5404"]["inputs"]["value"], "a beach")
        self.assertEqual((g["9009"]["inputs"]["value"], g["9010"]["inputs"]["value"]), (1088, 1920))   # 64s
        g, _ = V.graph_for("upscale", {"mode": "restore", "size": "4K"}, "x.mp4", "p")
        self.assertIn("restore", g["5004:5606"]["inputs"]["lora_name"])
        self.assertEqual(g["9002:9200"]["inputs"]["output_size"], "4K")
        g, _ = V.graph_for("upscale", {"mode": "nonsense", "size": "8K"}, "x.mp4", "p")
        self.assertIn("refine", g["5004:5606"]["inputs"]["lora_name"])
        self.assertEqual(g["9002:9200"]["inputs"]["output_size"], "FullHD")
        g, _ = V.graph_for("hdr", {}, "x.mp4", "p", "ltx_vfx/hdr_exr/x_1")
        self.assertEqual(g["9117"]["inputs"]["output_dir"], "ltx_vfx/hdr_exr/x_1")
        g, _ = V.graph_for("alpha", {"prompt": "ignored"}, "x.mp4", "p")
        self.assertEqual(g["5508"]["inputs"]["value"], "")
        # Never an API key, and the text encoders on the CPU, as tested.
        for a, o in (("alpha", {}), ("hdr", {}), ("reframe", {}), ("upscale", {}), ("upscale", {"mode": "restore"})):
            g, _ = V.graph_for(a, o, "x.mp4", "p", "d")
            for v in g.values():
                key = v["inputs"].get("api_key")
                self.assertTrue(not key or isinstance(key, list), a)          # empty, or a link
                if v["class_type"] == "PrimitiveString" and "api key" in v["_meta"]["title"].lower():
                    self.assertEqual(v["inputs"]["value"], "", a)
                if v["class_type"] == "CLIPLoader":
                    self.assertEqual(v["inputs"]["device"], "cpu", a)

    # ── the routes ──

    def test_prepare_cuts_the_clip_to_8n_plus_1_and_says_what_was_left_out(self):
        st, d = self.prepare("upscale", {"mode": "refine"})
        self.assertEqual(st, 200, d)
        self.assertEqual((d["runs"], d["used"], d["left_out"]), (1, 97, 3))
        self.assertIn("3 frames at the end left out", d["note"])
        self.assertEqual(self.written, [("shot 01.mp4", 0, 97, 24.0)])
        g = d["graphs"][0]
        name = g["5001"]["inputs"]["file"]
        self.assertTrue(name.startswith("clip_vfx/shot_01_") and name.endswith("_01.mp4"), name)
        self.assertTrue(os.path.isfile(os.path.join(self.dirs["input"], name)))
        self.assertEqual(g[d["output"]]["inputs"]["filename_prefix"], "ltx_vfx/shot_01_upscale_refine")

    def test_a_long_alpha_clip_runs_in_parts_and_they_are_joined(self):
        self.facts.update(frames=300)
        st, d = self.prepare("alpha")
        self.assertEqual(st, 200, d)
        self.assertEqual(d["runs"], 3)
        self.assertEqual([w[1:3] for w in self.written], [(0, 121), (121, 121), (242, 57)])
        parts = [os.path.join(self.dirs["input"], g["5001"]["inputs"]["file"]) for g in d["graphs"]]
        refs = [self.out_ref(f"shot_01_alpha_0000{i}_.mp4") for i in (1, 2, 3)]
        st, r = self.run_c(lambda c: self.j(c, "/imageviewer/clip_vfx/finish", {"job": d["job"], "results": refs}))
        self.assertEqual(st, 200, r)
        self.assertEqual(self.joined, [[x["filename"] for x in refs]])
        self.assertTrue(r["path"].endswith(os.path.join("ltx_vfx", "shot_01_alpha_v001.mp4")), r["path"])
        self.assertTrue(all(not os.path.exists(p) for p in parts))          # the parts are removed
        st, r = self.run_c(lambda c: self.j(c, "/imageviewer/clip_vfx/finish", {"job": d["job"], "results": refs[:2]}))
        self.assertEqual(st, 400)

    def test_every_load_image_reads_a_picture_that_is_there(self):
        # ComfyUI checks the file a LoadImage names even with "use image" off (seen on ws26 2026-11-11:
        # "Invalid image file: 2875b7cd-....png" for alpha and reframe).
        for action in ("alpha", "reframe"):
            st, d = self.prepare(action)
            self.assertEqual(st, 200, d)
            loads = [v for g in d["graphs"] for v in g.values() if v["class_type"] == "LoadImage"]
            self.assertTrue(loads, action)
            for v in loads:
                path = os.path.join(self.dirs["input"], *v["inputs"]["image"].split("/"))
                self.assertTrue(os.path.isfile(path), path)
                with open(path, "rb") as fh:
                    self.assertEqual(fh.read(8), b"\x89PNG\r\n\x1a\n")
        try:
            from PIL import Image
        except ImportError:
            return
        with Image.open(path) as im:
            self.assertEqual(im.size, (64, 64))
            im.load()

    def test_a_clip_in_the_input_folder_of_8n_plus_1_frames_is_read_as_it_is(self):
        self.facts.update(frames=97)
        src = os.path.join(self.dirs["input"], "plate.mov")
        _put(src, b"film")
        st, d = self.prepare("hdr", source={"filename": "plate.mov", "type": "input", "subfolder": ""})
        self.assertEqual(st, 200, d)
        self.assertEqual(self.written, [])
        self.assertEqual(d["graphs"][0]["9102"]["inputs"]["file"], "plate.mov")
        exr_dir = d["graphs"][0]["9117"]["inputs"]["output_dir"]
        folder = os.path.join(self.dirs["output"], exr_dir)
        os.makedirs(folder)
        for i in (1, 0):
            _put(os.path.join(folder, f"frame_{i:05d}.exr"), b"x")
        ref = self.out_ref("plate_hdr_00001_.mp4")
        st, r = self.run_c(lambda c: self.j(c, "/imageviewer/clip_vfx/finish", {"job": d["job"], "results": [ref]}))
        self.assertEqual(st, 200, r)
        self.assertEqual([os.path.basename(p) for p in r["exr"]], ["frame_00000.exr", "frame_00001.exr"])
        self.assertTrue(os.path.isfile(src))                                # the source is never removed

    def test_missing_models_are_said_before_anything_is_written(self):
        self.have.clear()
        st, d = self.prepare("reframe")
        self.assertEqual(st, 409, d)
        whats = {m["what"] for m in d["missing"]}
        self.assertIn("ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors", whats)
        self.assertIn("ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", whats)
        self.assertEqual(self.written, [])

    def test_refusals(self):
        outside = tempfile.mkdtemp()
        try:
            p = os.path.join(outside, "x.mp4")
            _put(p, b"film")
            st, _ = self.prepare("alpha", source={"path": p})
            self.assertEqual(st, 403)
        finally:
            shutil.rmtree(outside, ignore_errors=True)
        st, _ = self.prepare("alpha", source={"filename": "../../etc/passwd", "type": "output"})
        self.assertEqual(st, 404)
        st, d = self.prepare("explode")
        self.assertEqual(st, 400, d)
        self.facts.update(frames=5)
        st, d = self.prepare("alpha")
        self.assertEqual(st, 400, d)
        st, _ = self.run_c(lambda c: self.j(c, "/imageviewer/clip_vfx/finish", {"job": "nope", "results": [self.out_ref("a.mp4")]}))
        self.assertEqual(st, 404)

        async def foreign(c):
            r = await c.post("/imageviewer/clip_vfx/prepare", json={"source": {"path": self.clip}, "action": "alpha"},
                             headers={"Origin": "http://evil.example"})
            return r.status
        self.assertEqual(self.run_c(foreign), 403)

    def test_the_offer(self):
        async def go(c):
            r = await c.get("/imageviewer/clip_vfx")
            return await r.json()
        d = self.run_c(go)
        self.assertEqual(set(d["actions"]), {"alpha", "hdr", "reframe", "upscale"})
        self.assertEqual(d["actions"]["upscale"]["modes"], ["refine", "restore"])
        self.assertTrue(all(p["width"] % 64 == 0 and p["height"] % 64 == 0 for p in d["reframe"]))

    def test_the_workflows_are_agenty_cores_templates(self):
        """The same files as agentY-core's ltx2_5_vfx_* templates (when a checkout lies beside this one)."""
        core = os.path.join(ROOT, "..", "agenty-core", "comfyui_workflow_templates_custom", "templates")
        if not os.path.isdir(core):
            core = os.path.join(ROOT, "..", "agentY-core", "comfyui_workflow_templates_custom", "templates")
        names = [n for n in os.listdir(self.V.WF_DIR) if n.endswith(".json")]
        self.assertEqual(len(names), 5)
        theirs = [n for n in names if os.path.isfile(os.path.join(core, n))]
        if not theirs:
            self.skipTest("no agentY-core checkout with the templates beside this one")
        for n in theirs:
            with open(os.path.join(core, n), encoding="utf-8") as a, open(os.path.join(self.V.WF_DIR, n), encoding="utf-8") as b:
                self.assertEqual(json.load(a), json.load(b), n)


try:
    import av  # noqa: F401
    import numpy as np
except ImportError:  # pragma: no cover
    av = None


def _counter_film(path, frames=100, fps=24, sound=True):
    """A film whose frame i is red (i % 10) * 25, with a tone."""
    with av.open(path, "w") as o:
        s = o.add_stream("libx264", rate=fps)
        s.width, s.height, s.pix_fmt = 320, 180, "yuv420p"
        a = o.add_stream("aac", rate=44100) if sound else None
        for i in range(frames):
            f = np.zeros((180, 320, 3), np.uint8)
            f[..., 0] = (i % 10) * 25
            for pk in s.encode(av.VideoFrame.from_ndarray(f, format="rgb24")):
                o.mux(pk)
        if a is not None:
            t = 0
            for _k in range(int(frames / fps * 44100 / 1024) + 1):
                x = (0.2 * np.sin(np.arange(1024) / 10)).astype(np.float32)[None].repeat(2, 0)
                fr = av.AudioFrame.from_ndarray(x, format="fltp", layout="stereo")
                fr.sample_rate, fr.pts = 44100, t
                t += 1024
                for pk in a.encode(fr):
                    o.mux(pk)
            for pk in a.encode():
                o.mux(pk)
        for pk in s.encode():
            o.mux(pk)


@unittest.skipIf(av is None, "needs PyAV")
class ClipVfxFilms(unittest.TestCase):
    """The parts and the join for real, through the Edit panel's renderer."""

    def test_parts_start_on_their_frame_keep_the_sound_and_join_again(self):
        import types                     # a fresh copy: the class above puts stand-ins into its own
        pkg = types.ModuleType("imageviewer_clipvfx_films")
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules["imageviewer_clipvfx_films"] = pkg
        V = importlib.import_module("imageviewer_clipvfx_films.clip_vfx")
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        src = os.path.join(tmp, "c.mp4")
        _counter_film(src)
        self.assertEqual(V.probe(src)["frames"], 100)
        ok = lambda p: True  # noqa: E731
        p1, p2, j = (os.path.join(tmp, n) for n in ("p1.mp4", "p2.mp4", "j.mp4"))
        V.write_part(src, 10, 57, 24.0, p1, ok)
        V.write_part(src, 67, 25, 24.0, p2, ok)
        V.join([p1, p2], 24.0, j, ok)

        def reds(path):
            with av.open(path) as c:
                self.assertEqual(len(c.streams.audio), 1, path)
                return [round(fr.to_ndarray(format="rgb24")[90, 160, 0] / 25) for fr in c.decode(video=0)]
        self.assertEqual(reds(p1), [(i % 10) for i in range(10, 67)])
        self.assertEqual(reds(p2), [(i % 10) for i in range(67, 92)])
        self.assertEqual(reds(j), [(i % 10) for i in list(range(10, 67)) + list(range(67, 92))])


if __name__ == "__main__":
    unittest.main()
