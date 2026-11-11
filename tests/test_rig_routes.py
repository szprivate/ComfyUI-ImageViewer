"""The rig routes (src/rig_routes.py) through the REAL viewer_api in a private aiohttp app: FBX and Alembic
exports by the export rule, which tools are set up, and the auto-rig and motion jobs - run through the real
runner scripts (scripts/rig/), against a stand-in UniRig folder and stand-in torch / kimodo modules, so what
is tested is the viewer's side: the commands, the protocol, the constraints it builds and what comes back.

    python -m unittest discover -s tests -p test_rig_routes.py
"""
import asyncio
import importlib
import json
import os
import shutil
import sys
import tempfile
import textwrap
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402
import rig_fixture  # noqa: E402

if web is not None:
    import aiohttp
    from aiohttp.test_utils import TestClient, TestServer

FAKE_UNIRIG = {
    "run.py": """
        import argparse, shutil
        ap = argparse.ArgumentParser(); ap.add_argument('--task'); ap.add_argument('--seed'); ap.add_argument('--input')
        ap.add_argument('--output'); ap.add_argument('--npz_dir'); ap.add_argument('--data_name')
        a = ap.parse_args(); print('predicting', a.task, a.seed); shutil.copyfile(a.input, a.output)
    """,
    "src/__init__.py": "",
    "src/data/__init__.py": "",
    "src/data/extract.py": "import sys; print('extract', [x for x in sys.argv if x.startswith('--input')])",
    "src/inference/__init__.py": "",
    "src/inference/merge.py": """
        import argparse, os, shutil
        ap = argparse.ArgumentParser()
        for k in ('require_suffix', 'num_runs', 'id', 'source', 'target', 'output'): ap.add_argument('--' + k)
        a = ap.parse_args(); shutil.copyfile(os.environ['FAKE_RIGGED'], a.output); print('merged')
    """,
}

# Just enough of torch and kimodo for scripts/rig/kimodo_run.py to run its protocol.
FAKE_KIMODO = {
    "torch/__init__.py": """
        import numpy as np
        class cuda:
            @staticmethod
            def is_available(): return False
        def full(shape, value, device=None): return np.full(shape, value)
    """,
    "kimodo/__init__.py": """
        import json, os
        import numpy as np
        class _Skel: nbjoints = 77
        class _Model:
            fps = 30.0
            skeleton = _Skel()
            def __call__(self, texts, frames, constraint_lst=(), num_denoising_steps=0, num_samples=1, **kw):
                with open(os.environ['FAKE_KIMODO_LOG'], 'a') as fh:
                    fh.write(json.dumps({'texts': texts, 'frames': frames, 'constraints': list(constraint_lst),
                                         'steps': num_denoising_steps, 'heading': 'first_heading_angle' in kw}) + '\\n')
                T = sum(frames)
                rot = np.tile(np.eye(3), (num_samples, T, 77, 1, 1))
                joints = np.zeros((num_samples, T, 77, 3)); joints[..., 0, 2] = np.linspace(0, 1, T)
                return {'global_rot_mats': rot, 'posed_joints': joints, 'foot_contacts': np.ones((num_samples, T, 4))}
        def load_model(name, device=None, default_family=None):
            print('loading', name); return _Model()
    """,
    "kimodo/skeleton/__init__.py": """
        import numpy as np
        class _T:
            def __init__(self, a): self.a = a
            def cpu(self): return self
            def numpy(self): return self.a
        class SOMASkeleton77:
            def __init__(self):
                self.bone_order_names = ['Hips', 'Spine1'] + ['J%d' % i for i in range(75)]
                self.bone_parents = {n: (None if i == 0 else 'Hips') for i, n in enumerate(self.bone_order_names)}
                self.neutral_joints = _T(np.zeros((77, 3)))
    """,
    "kimodo/constraints.py": "def load_constraints_lst(lst, skeleton, device=None): return lst",
    "kimodo/tools.py": "def seed_everything(s): pass",
}


def _tree(root, files):
    for rel, text in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(textwrap.dedent(text))


@unittest.skipIf(web is None, "needs aiohttp")
class RigRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.env = {k: os.environ.get(k) for k in ("IMAGE_VIEWER_RIG_TOOLS", "FAKE_RIGGED", "FAKE_KIMODO_LOG", "UNIRIG_DEVICE")}
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.routes = importlib.import_module(cls.pkg + ".rig_routes")
        cls.abc_io = importlib.import_module(cls.pkg + ".abc_io")
        unirig = os.path.join(cls.tmp, "UniRig")
        fake = os.path.join(cls.tmp, "fakemods")
        _tree(unirig, FAKE_UNIRIG)
        _tree(fake, FAKE_KIMODO)
        cls.model = os.path.join(cls.dirs["input"], "statue.glb")
        with open(cls.model, "wb") as fh:
            fh.write(rig_fixture.build(skinned=False))
        rigged = os.path.join(cls.tmp, "rigged.glb")
        with open(rigged, "wb") as fh:
            fh.write(rig_fixture.build())
        cls.log = os.path.join(cls.tmp, "kimodo.log")
        cfg = os.path.join(cls.tmp, "rig_tools.json")
        with open(cfg, "w", encoding="utf-8") as fh:
            json.dump({"unirig": {"python": sys.executable, "repo": unirig},
                       "kimodo": {"python": sys.executable, "env": {"PYTHONPATH": fake}, "text_encoder_device": "cpu"}}, fh)
        os.environ.update(IMAGE_VIEWER_RIG_TOOLS=cfg, FAKE_RIGGED=rigged, FAKE_KIMODO_LOG=cls.log, UNIRIG_DEVICE="cuda")

    @classmethod
    def tearDownClass(cls):
        for k, v in cls.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
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

    @staticmethod
    def payload(fmt):
        """A two-bone stick with one quad skinned to it, keyed over three frames (the second bone bends 90°)."""
        meta = {"format": fmt, "name": "stick", "fps": 24, "frames": [0, 1, 2],
                "root": {"t": [0, 0, 0], "q": [0, 0, 0, 1], "s": [1, 1, 1]},
                "rootMatrix": list(np.eye(4).ravel(order="F")),
                "bones": [{"name": "a", "parent": -1, "rest": {"t": [0, 0, 0], "q": [0, 0, 0, 1], "s": [1, 1, 1]},
                           "bind": list(np.eye(4).ravel(order="F"))},
                          {"name": "b", "parent": 0, "rest": {"t": [0, 1, 0], "q": [0, 0, 0, 1], "s": [1, 1, 1]},
                           "bind": list(np.array([[1, 0, 0, 0], [0, 1, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]], float).ravel(order="F"))}],
                "meshes": [{"name": "quad", "positions": "f32:p", "indices": "u32:i", "joints": "u32:j", "weights": "f32:w"}],
                "anim": "f32:anim"}
        pos = np.array([[0, 1, 0], [0, 2, 0], [0.1, 2, 0], [0.1, 1, 0]], np.float32)
        anim = []
        for f in range(3):
            s = np.sin(np.radians(45 * f) / 2)
            c = np.cos(np.radians(45 * f) / 2)
            anim += [0, 0, 0, 0, 0, 0, 1, 1, 1, 1] + [0, 1, 0, 0, 0, s, c, 1, 1, 1]
        parts = {"p": pos.tobytes(), "i": np.array([0, 1, 2, 0, 2, 3], np.uint32).tobytes(),
                 "j": np.array([[1, 0, 0, 0]] * 4, np.uint32).tobytes(), "w": np.array([[1, 0, 0, 0]] * 4, np.float32).tobytes(),
                 "anim": np.array(anim, np.float32).tobytes()}
        return meta, parts

    async def post_export(self, c, fmt):
        meta, parts = self.payload(fmt)
        form = aiohttp.FormData()
        form.add_field("meta", json.dumps(meta), content_type="application/json")
        for k, v in parts.items():
            form.add_field(k, v, filename=k, content_type="application/octet-stream")
        r = await c.post("/imageviewer/rig/export", data=form, headers={"X-ImageViewer-Rig": "1"})
        return r.status, await r.json()

    def test_export_fbx_and_abc_by_the_rule(self):
        async def go(c):
            st, fbx = await self.post_export(c, "fbx")
            self.assertEqual(st, 200, fbx)
            st, abc = await self.post_export(c, "abc")
            self.assertEqual(st, 200, abc)
            return fbx, abc
        fbx, abc = self.run_c(go)
        self.assertTrue(fbx["relative"].startswith("imageviewer/characters/") or "/characters/" in fbx["relative"], fbx)
        with open(fbx["path"], "rb") as fh:
            self.assertTrue(fh.read(23).startswith(b"Kaydara FBX Binary  \x00"))
        self.assertTrue(abc["path"].endswith(".abc"))
        self.assertEqual(self.abc_io.info(abc["path"])["samples"], 3)
        # Frame 2: the second bone turned 90° about Z, so the quad lies along -X from (0, 1).
        v, _ = self.abc_io.to_mesh(abc["path"], sample=2)
        np.testing.assert_allclose(v[1], [-1, 1, 0], atol=1e-5)

    def test_tools_and_bad_requests(self):
        async def go(c):
            form = aiohttp.FormData()
            form.add_field("meta", "{}", content_type="application/json")
            r0 = await c.post("/imageviewer/rig/export", data=form)           # no header: a form from anywhere
            self.assertEqual(r0.status, 403)
            r = await c.get("/imageviewer/rig/tools")
            tools = await r.json()
            r2 = await c.post("/imageviewer/rig/motion", json={"mode": "dance", "prompt": "x", "frames": 30})
            r3 = await c.post("/imageviewer/rig/motion", json={"mode": "text", "prompt": "x", "frames": 3})
            r4 = await c.post("/imageviewer/rig/autorig", json={"src": {"filename": "nothere.glb", "type": "input"}})
            return tools, r2.status, r3.status, r4.status
        tools, bad_mode, few, missing = self.run_c(go)
        self.assertTrue(tools["unirig"]["ready"], tools)
        self.assertTrue(tools["kimodo"]["ready"], tools)
        self.assertEqual(tools["kimodo"]["model"], "Kimodo-SOMA-RP-v1.2")
        self.assertEqual((bad_mode, few, missing), (400, 400, 404))
        missing_cfg = self.routes.tool_status({"unirig": {"python": "/no/python"}})
        self.assertFalse(missing_cfg["unirig"]["ready"])
        self.assertFalse(missing_cfg["kimodo"]["ready"])

    def test_agent_requests_go_to_the_page_and_back(self):
        async def go(c):
            r = await c.post("/imageviewer/rig/agent", json={"action": "motion", "model": "Hero", "prompt": "walks"})
            ask = await r.json()
            bad = await c.post("/imageviewer/rig/agent", json={"action": "explode"})
            await c.post("/imageviewer/rig/agent_done", json={"id": ask["id"], "state": "done", "result": {"keys": 12}})
            r2 = await c.get(f"/imageviewer/rig/agent?id={ask['id']}")
            return ask, bad.status, await r2.json()
        del self.sent[:]
        ask, bad, state = self.run_c(go)
        self.assertEqual(ask["state"], "sent")
        self.assertEqual(bad, 400)
        self.assertEqual(state["state"], "done")
        self.assertEqual(state["result"], {"keys": 12})
        ev = [d for e, d in self.sent if e == "imageviewer.rig.agent"]
        self.assertEqual(ev, [{"id": ask["id"], "action": "motion", "args": {"model": "Hero", "prompt": "walks"}}])

    async def wait(self, c, job):
        for _ in range(200):
            r = await c.get(f"/imageviewer/rig/job?job={job['job']}")
            job = await r.json()
            if job["state"] != "running":
                return job
            await asyncio.sleep(0.05)
        return job

    def test_install_runs_the_installer_and_keeps_the_token(self):
        fake = os.path.join(self.tmp, "fake_install.py")
        with open(fake, "w") as fh:
            fh.write(textwrap.dedent("""
                import json, sys, time
                args = sys.argv[1:]
                if "--slow" in open(__file__).read() and "slow" in args[1]:
                    import subprocess
                    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
                    print("$ pip install torch", flush=True); time.sleep(60)
                for i in range(7):
                    print(f"$ step {i}", flush=True)
                print("== written", flush=True)
                json.dump(args, open(args[1] + ".args.json", "w"))
            """) + "# --slow\n")
        token_file = os.path.join(self.tmp, "hf", "token")
        old = (self.routes.INSTALLER, os.environ.get("HF_TOKEN_PATH"), os.environ.get("HF_TOKEN"))
        self.routes.INSTALLER = fake
        os.environ["HF_TOKEN_PATH"] = token_file
        os.environ.pop("HF_TOKEN", None)
        root = os.path.join(self.tmp, "rigtools")
        slow = os.path.join(self.tmp, "slow")

        async def go(c):
            t0 = await (await c.get("/imageviewer/rig/tools")).json()
            bad = await c.post("/imageviewer/rig/install", json={"root": root, "hf_token": "not-a-token"})
            r = await c.post("/imageviewer/rig/install", json={"root": root, "only": "kimodo",
                                                               "hf_token": "hf_" + "a" * 30})
            job = await r.json()
            again = await (await c.post("/imageviewer/rig/install", json={"root": "/elsewhere"})).json()
            done = await self.wait(c, job)
            t1 = await (await c.get("/imageviewer/rig/tools")).json()
            # A cancel stops the installer and what it started.
            sj = await (await c.post("/imageviewer/rig/install", json={"root": slow})).json()
            await asyncio.sleep(0.5)
            await c.post("/imageviewer/rig/job", json={"job": sj["job"], "cancel": True})
            stopped = await self.wait(c, sj)
            return t0, bad.status, job, again, done, t1, stopped
        try:
            t0, bad, job, again, done, t1, stopped = self.run_c(go)
        finally:
            self.routes.INSTALLER = old[0]
            for k, v in (("HF_TOKEN_PATH", old[1]), ("HF_TOKEN", old[2])):
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertFalse(t0["install"]["hf_token"])
        self.assertIsNone(t0["install"]["running"])
        self.assertTrue(t0["install"]["root"])
        self.assertEqual(bad, 400)
        self.assertEqual(again["job"], job["job"])                 # one install at a time: the running one
        self.assertEqual(done["state"], "done", done)
        self.assertEqual(done["share"], 1.0)
        self.assertNotIn("hf_", json.dumps(done))                   # the token is never answered
        with open(token_file) as fh:
            self.assertEqual(fh.read(), "hf_" + "a" * 30)
        with open(root + ".args.json") as fh:
            self.assertEqual(json.load(fh), ["--root", root, "--only", "kimodo"])
        self.assertTrue(t1["install"]["hf_token"])
        self.assertEqual(stopped["state"], "cancelled", stopped)

    def test_autorig_runs_unirig_steps(self):
        async def go(c):
            r = await c.post("/imageviewer/rig/autorig", json={"src": {"filename": "statue.glb", "type": "input"},
                                                              "name": "statue", "seed": 7})
            return await self.wait(c, await r.json())
        job = self.run_c(go)
        self.assertEqual(job["state"], "done", job)
        self.assertTrue(job["result"]["path"].endswith(".glb"))
        self.assertIn("statue_rig", job["result"]["name"])
        self.assertTrue(os.path.isfile(job["result"]["path"]))
        log = " ".join(job["log"])
        for step in ("reading the mesh", "predicting the skeleton", "predicting the skin weights", "merging onto the model"):
            self.assertIn(step, log)

    def test_motion_keeps_one_worker_and_sends_constraints(self):
        key = {"frame": 0, "joints": {"Spine1": [0, 0, 0.3826834, 0.9238795]}, "root": [0, 1, 0]}

        async def go(c):
            out = []
            for body in ({"mode": "text", "prompt": "A person walks. Then waves.", "frames": 31, "keys": [key], "heading": 0.5},
                         {"mode": "inbetween", "frames": 61, "keys": [key, dict(key, frame=60)]}):
                r = await c.post("/imageviewer/rig/motion", json=body)
                self.assertEqual(r.status, 200)
                out.append(await self.wait(c, await r.json()))
            return out
        try:
            first, second = self.run_c(go)
        finally:
            for w in self.routes.WORKERS:
                w.stop()
        self.assertEqual(first["state"], "done", first)
        self.assertEqual(second["state"], "done", second)
        res = first["result"]
        self.assertEqual(len(res["joints"]), 77)
        self.assertEqual(len(res["samples"][0]["rot"]), 31)
        self.assertEqual(res["samples"][0]["rot"][0][0], [0, 0, 0, 1])
        self.assertAlmostEqual(res["samples"][0]["root"][-1][2], 1.0)
        with open(self.log) as fh:
            calls = [json.loads(line) for line in fh]
        self.assertEqual(calls[0]["texts"], ["A person walks.", "Then waves."])
        self.assertEqual(calls[0]["frames"], [15, 16])
        self.assertTrue(calls[0]["heading"])
        c = calls[1]["constraints"][0]
        self.assertEqual(c["type"], "fullbody")
        self.assertEqual(c["frame_indices"], [0, 60])
        # Spine1's 45° about Z, as local axis-angle under the hips; the joints after it hang off the hips, unturned.
        np.testing.assert_allclose(c["local_joints_rot"][0][1], [0, 0, np.pi / 4], atol=1e-5)
        np.testing.assert_allclose(c["local_joints_rot"][0][2], [0, 0, 0], atol=1e-9)
        # The model was loaded once for both.
        self.assertEqual(sum(1 for line in first["log"] + second["log"] if line.startswith("loading ")), 1)


if __name__ == "__main__":
    unittest.main()
