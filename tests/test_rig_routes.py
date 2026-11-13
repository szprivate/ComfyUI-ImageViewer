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
        a = ap.parse_args(); print('predicting', a.task, a.seed)
        import os
        if os.environ.get('FAKE_SKIN_FAIL') and 'skin' in a.task:
            raise RuntimeError('CUDA error: no kernel image is available')
        shutil.copyfile(a.input, a.output)
    """,
    "src/__init__.py": "",
    "src/data/__init__.py": "",
    "src/data/extract.py": """
        import os, sys
        given = [x.split('=', 1)[1] for x in sys.argv if x.startswith('--input=')][0]
        print('extract', given)
        if os.environ.get('FAKE_EXTRACT_FAIL'):
            print('RuntimeError: could not load the file')   # UniRig prints its error and exits 0
        else:
            out = os.path.splitext(given)[0]
            os.makedirs(out, exist_ok=True)
            open(os.path.join(out, 'raw_data.npz'), 'wb').close()
    """,
    "src/inference/__init__.py": "",
    "src/inference/merge.py": """
        import argparse, os, shutil
        ap = argparse.ArgumentParser()
        for k in ('require_suffix', 'num_runs', 'id', 'source', 'target', 'output'): ap.add_argument('--' + k)
        a = ap.parse_args(); shutil.copyfile(os.environ['FAKE_RIGGED'], a.output); print('merged')
    """,
}

# A stand-in SkinTokens folder: the files the viewer looks for, and just enough of its src package for
# scripts/rig/skintokens_run.py (which loads the checkpoint through torch.load, reads the mesh, predicts and
# transfers); FAKE_SKIN_LOG gets a line per call, FAKE_RIGGED is what the transfer writes.
FAKE_SKINTOKENS = {
    "experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt": "ckpt",
    "experiments/skin_vae_2_10_32768/last.ckpt": "vae",
    "models/Qwen3-0.6B/config.json": "{}",
    "demo.py": "raise SystemExit('the viewer never runs the demo (it starts a server on every interface)')",
    "src/__init__.py": "",
    "src/_log.py": """
        import json, os
        def log(**kw):
            with open(os.environ['FAKE_SKIN_LOG'], 'a') as fh:
                fh.write(json.dumps(kw) + '\\n')
    """,
    "src/data/__init__.py": "",
    "src/data/dataset.py": """
        from src._log import log
        class _Cfg:
            def __init__(self, kw): self.kw = kw
            def split_by_cls(self): return {'articulation': self}
        class DatasetConfig:
            @staticmethod
            def parse(**kw):
                log(step='dataset', loader=kw['datapath']['loader'], workers=kw['num_workers'],
                    files=kw['datapath']['filepaths']['articulation'])
                return _Cfg(kw)
        class RigDatasetModule:
            def __init__(self, **kw): self.cfg = kw['predict_dataset_config']['articulation']
            def predict_dataloader(self):
                import os
                batch = {'vertices': 'v'}
                if os.environ.get('FAKE_SKIN_HAS_SKELETON'):
                    import torch
                    batch['skeleton_tokens'] = torch.Tensor([[1, 2, 3]]); batch['skeleton_mask'] = torch.Tensor([[1, 1, 0]])
                return {'articulation': [batch]}
    """,
    "src/data/transform.py": """
        class Transform:
            @staticmethod
            def parse(**kw): return Transform()
    """,
    "src/data/vertex_group.py": "def voxel_skin(**kw): return 1",
    "src/tokenizer/__init__.py": "",
    "src/tokenizer/parse.py": "def get_tokenizer(**kw): return object()",
    "src/model/__init__.py": "",
    "src/model/tokenrig.py": """
        import torch
        from src._log import log
        class _Asset:
            joints = [[0, 0, 0]] * 22
        class _Pred:
            asset = _Asset()
        class TokenRig:
            tokenizer_config = {}
            transform_config = {'predict_transform': {}}
            @classmethod
            def load_from_system_checkpoint(cls, checkpoint_path):
                ck = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
                log(step='load', ckpt=checkpoint_path, weights_only=ck['weights_only'])
                return cls()
            def to(self, dev): log(step='device', device=dev); return self
            def eval(self): return self
            def _process_fn(self, b): return b
            def predict_step(self, batch, skeleton_tokens=None, make_asset=False):
                log(step='predict', keep=skeleton_tokens is not None, beams=batch['generate_kwargs']['num_beams'],
                    has_tokens='skeleton_tokens' in batch)
                return {'results': [_Pred()]}
    """,
    "src/rig_package/__init__.py": "",
    "src/rig_package/parser/__init__.py": "",
    "src/rig_package/parser/bpy.py": """
        import os, shutil
        from src._log import log
        class BpyParser: pass
        def transfer_rigging(source_asset, target_path, export_path, **kw):
            log(step='transfer', target=os.path.basename(target_path), group=kw.get('group_per_vertex'))
            shutil.copyfile(os.environ['FAKE_RIGGED'], export_path)
    """,
}

# Just enough of torch and transformers for skintokens_run.py: a GPU of FAKE_VRAM_GB, a torch.load that says
# whether it was asked for weights-only loading.
FAKE_SKIN_TORCH = {
    "torch/__init__.py": """
        import contextlib, os
        class Tensor(list):
            def to(self, dev): return self
            def __getitem__(self, i):
                if isinstance(i, Tensor):           # a mask
                    return Tensor([x for x, m in zip(self, i) if m])
                v = list.__getitem__(self, i)
                return Tensor(v) if isinstance(v, list) else v
            def __eq__(self, o): return Tensor([x == o for x in self])
            def cpu(self): return self
            def numpy(self): return list(self)
        class _Props: total_memory = float(os.environ.get('FAKE_VRAM_GB', '24')) * 2 ** 30
        class cuda:
            @staticmethod
            def is_available(): return True
            @staticmethod
            def get_device_properties(i): return _Props()
        class serialization:
            @staticmethod
            def add_safe_globals(x): pass
        def load(f, map_location=None, weights_only=None, **kw): return {'weights_only': weights_only}
        def manual_seed(s): pass
        no_grad = contextlib.nullcontext
    """,
    "transformers/__init__.py": """
        class AutoModelForCausalLM:
            @staticmethod
            def from_config(*a, **k): return None
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


# Just enough of OpenCV and MediaPipe for scripts/rig/video_pose_run.py: a film of 5 frames, one person.
FAKE_POSETRACK = {
    "cv2/__init__.py": """
        import numpy as np
        CAP_PROP_FPS, CAP_PROP_FRAME_COUNT, CAP_PROP_FRAME_WIDTH, CAP_PROP_FRAME_HEIGHT, COLOR_BGR2RGB = 1, 2, 3, 4, 5
        class VideoCapture:
            def __init__(self, path): self.n = 0; self.path = path
            def isOpened(self): return self.path.endswith('.mp4')
            def get(self, k): return {1: 25.0, 2: 5, 3: 640, 4: 360}[k]
            def read(self):
                self.n += 1
                return (self.n <= 5), np.zeros((360, 640, 3), np.uint8)
            def release(self): pass
        def cvtColor(f, code): return f
        IMREAD_COLOR = 1
        def imread(path, flag=1): return np.zeros((480, 320, 3), np.uint8) if path.endswith('.png') else None
    """,
    "mediapipe/__init__.py": """
        class ImageFormat: SRGB = 1
        class Image:
            def __init__(self, image_format=None, data=None): self.data = data
    """,
    "mediapipe/tasks/__init__.py": "",
    "mediapipe/tasks/python/__init__.py": """
        class BaseOptions:
            def __init__(self, model_asset_path=None): self.model_asset_path = model_asset_path
    """,
    "mediapipe/tasks/python/vision.py": """
        class _P:
            def __init__(self, x, y, z): self.x, self.y, self.z, self.visibility = x, y, z, 0.9
        class _R:
            def __init__(self, t):
                self.pose_world_landmarks = [[_P(0.01 * i, -0.02 * i, 0.0) for i in range(33)]] if t != 2000 // 25 * 1 else []
                self.pose_landmarks = [[_P(0.5, 0.5, 0.0) for i in range(33)]]
        class RunningMode: VIDEO = 2; IMAGE = 1
        class PoseLandmarkerOptions:
            def __init__(self, **kw): self.kw = kw
        class PoseLandmarker:
            @staticmethod
            def create_from_options(o): return PoseLandmarker()
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def detect_for_video(self, image, ms): return _R(ms)
            def detect(self, image): return _R(0)
    """,
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
        cls.env = {k: os.environ.get(k) for k in ("IMAGE_VIEWER_RIG_TOOLS", "FAKE_RIGGED", "FAKE_KIMODO_LOG", "UNIRIG_DEVICE",
                                                  "FAKE_SKIN_LOG")}
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.routes = importlib.import_module(cls.pkg + ".rig_routes")
        cls.abc_io = importlib.import_module(cls.pkg + ".abc_io")
        unirig = os.path.join(cls.tmp, "UniRig")
        fake = os.path.join(cls.tmp, "fakemods")
        _tree(unirig, FAKE_UNIRIG)
        skintokens = os.path.join(cls.tmp, "SkinTokens")
        _tree(skintokens, FAKE_SKINTOKENS)
        skintorch = os.path.join(cls.tmp, "skintorch")
        _tree(skintorch, FAKE_SKIN_TORCH)
        cls.skinlog = os.path.join(cls.tmp, "skintokens.log")
        _tree(fake, FAKE_KIMODO)
        posefake = os.path.join(cls.tmp, "posefake")
        _tree(posefake, FAKE_POSETRACK)
        task = os.path.join(cls.tmp, "pose_landmarker_heavy.task")
        with open(task, "wb") as fh:
            fh.write(b"model")
        cls.film = os.path.join(cls.dirs["input"], "dance.mp4")
        with open(cls.film, "wb") as fh:
            fh.write(b"not really a film")
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
                       "skintokens": {"python": sys.executable, "repo": skintokens, "env": {"PYTHONPATH": skintorch}},
                       "kimodo": {"python": sys.executable, "env": {"PYTHONPATH": fake}, "text_encoder_device": "cpu"},
                       "posetrack": {"python": sys.executable, "env": {"PYTHONPATH": posefake}, "model": task}}, fh)
        os.environ.update(IMAGE_VIEWER_RIG_TOOLS=cfg, FAKE_RIGGED=rigged, FAKE_KIMODO_LOG=cls.log, UNIRIG_DEVICE="cuda",
                          FAKE_SKIN_LOG=cls.skinlog)

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

    def test_usd_export_and_the_rig_coming_back(self):
        """FBX and USD carry the viewer's rig (meta.live); read_motion hands it back, with a USD's animation."""
        live = {"v": 1, "kind": "imageviewer.rig", "items": [{"id": "c1", "kind": "control"}], "model": {"bones": ["a", "b"]}}

        async def go(c):
            out = {}
            for fmt in ("fbx", "usd"):
                meta, parts = self.payload(fmt)
                meta["live"] = live
                form = aiohttp.FormData()
                form.add_field("meta", json.dumps(meta), content_type="application/json")
                for k, v in parts.items():
                    form.add_field(k, v, filename=k, content_type="application/octet-stream")
                r = await c.post("/imageviewer/rig/export", data=form, headers={"X-ImageViewer-Rig": "1"})
                self.assertEqual(r.status, 200, await r.text())
                path = (await r.json())["path"]
                r = await c.post("/imageviewer/rig/read_motion", json={"path": path})
                self.assertEqual(r.status, 200, await r.text())
                out[fmt] = (path, await r.json())
            note = os.path.join(self.dirs["output"], "notes.txt")
            with open(note, "w") as fh:
                fh.write("x")
            r1 = await c.post("/imageviewer/rig/read_motion", json={"path": note})
            r2 = await c.post("/imageviewer/rig/read_motion", json={"path": os.path.join(self.tmp, "rigged.glb")})
            r3 = await c.post("/imageviewer/rig/read_motion", json={"path": os.path.join(self.dirs["output"], "none.fbx")})
            return out, r1.status, r2.status, r3.status
        out, txt, outside, missing = self.run_c(go)
        fbx_path, fbx = out["fbx"]
        usd_path, usd = out["usd"]
        self.assertTrue(usd_path.endswith(".usd"), usd_path)
        self.assertEqual(fbx["live"], live)
        self.assertEqual((fbx["fps"], fbx["unit_cm"], fbx["up"]), (24, 100.0, "y"))
        self.assertEqual(usd["live"], live)
        self.assertEqual([j["name"] for j in usd["joints"]], ["a", "b"])
        self.assertEqual(usd["frames"], [0.0, 1.0, 2.0])
        # Frame 2: bone b turned 90 degrees about Z, as it was written.
        q = usd["anim"][2][1][3:7]
        np.testing.assert_allclose(np.abs(q), [0, 0, np.sin(np.pi / 4), np.cos(np.pi / 4)], atol=1e-6)
        self.assertEqual(txt, 403)          # not a 3D file: nothing is read
        self.assertEqual(outside, 403)      # outside the folders the viewer may serve
        self.assertEqual(missing, 404)

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
        self.assertTrue(tools["skintokens"]["ready"], tools)
        self.assertTrue(tools["kimodo"]["ready"], tools)
        self.assertEqual(tools["kimodo"]["model"], "Kimodo-SOMA-RP-v1.2")
        self.assertEqual((bad_mode, few, missing), (400, 400, 404))
        missing_cfg = self.routes.tool_status({"unirig": {"python": "/no/python"}})
        self.assertFalse(missing_cfg["unirig"]["ready"])
        self.assertFalse(missing_cfg["skintokens"]["ready"])
        no_ckpt = self.routes.tool_status({"skintokens": {"python": sys.executable, "repo": self.tmp}})
        self.assertFalse(no_ckpt["skintokens"]["ready"])
        self.assertIn("checkpoint", no_ckpt["skintokens"]["why"])
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
            ilog = await (await c.get(f"/imageviewer/install_log?id={job['job']}")).json()
            tail = await (await c.get(f"/imageviewer/install_log?id={job['job']}&since=3")).json()
            # The log window's Stop stops the installer as the dialog's does.
            sj = await (await c.post("/imageviewer/rig/install", json={"root": slow})).json()
            await asyncio.sleep(0.5)
            await c.post("/imageviewer/install_log", json={"id": sj["job"], "cancel": True})
            stopped = await self.wait(c, sj)
            slog = await (await c.get(f"/imageviewer/install_log?id={sj['job']}")).json()
            listing = await (await c.get("/imageviewer/install_log")).json()
            return t0, bad.status, job, again, done, t1, stopped, (ilog, tail, slog, listing)
        try:
            t0, bad, job, again, done, t1, stopped, (ilog, tail, slog, listing) = self.run_c(go)
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
        # Every line the installer printed is in the install log the page's window follows.
        self.assertEqual(done["log_id"], job["job"])
        self.assertEqual(ilog["state"], "done")
        self.assertTrue(ilog["lines"][0].startswith("$ "))          # the command itself first
        self.assertIn("$ step 6", ilog["lines"])
        self.assertIn("== written", ilog["lines"])
        self.assertEqual(ilog["lines"][-1], "-- done --")
        self.assertEqual(tail["lines"], ilog["lines"][3:])
        self.assertEqual(ilog["next"], len(ilog["lines"]))
        self.assertTrue(ilog["log_file"].endswith(".log"))
        self.assertNotIn("hf_", json.dumps(ilog))
        self.assertEqual(slog["state"], "cancelled", slog)
        self.assertIn("-- stop asked for --", slog["lines"])
        self.assertIn(job["job"], [l["id"] for l in listing["logs"]])

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

    def skin_log(self):
        with open(self.skinlog, encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def test_autorig_with_skintokens(self):
        async def go(c, **extra):
            body = {"src": {"filename": "statue.glb", "type": "input"}, "name": "statue", "seed": 3, **extra}
            r = await c.post("/imageviewer/rig/autorig", json=body)
            got = await r.json()
            return (r.status, got) if r.status != 200 else (200, await self.wait(c, got))
        if os.path.exists(self.skinlog):
            os.remove(self.skinlog)
        st, job = self.run_c(lambda c: go(c, engine="skintokens"))
        self.assertEqual(job["state"], "done", job)
        self.assertEqual(job["result"]["engine"], "skintokens")
        self.assertIn("statue_rig", job["result"]["name"])
        self.assertTrue(os.path.isfile(job["result"]["path"]))
        log = " ".join(job["log"])
        for step in ("SkinTokens on cuda", "reading the mesh", "predicting the skeleton and skin weights", "22 bones",
                     "putting the rig onto the model"):
            self.assertIn(step, log)
        self.assertNotIn("warning", log)
        calls = {c["step"]: c for c in self.skin_log()}
        self.assertTrue(calls["load"]["weights_only"], calls)            # never torch.load(weights_only=False)
        self.assertEqual(calls["dataset"]["loader"], "bpy")               # no bpy server, no network port
        self.assertEqual(calls["dataset"]["workers"], 0)
        self.assertTrue(calls["dataset"]["files"][0].endswith("model.glb"))
        self.assertFalse(calls["predict"]["keep"])
        self.assertFalse(calls["predict"]["has_tokens"])
        self.assertEqual(calls["transfer"], {"step": "transfer", "target": "model.glb", "group": 4})

        # Keep the model's skeleton: skin weights only. Only SkinTokens can, and only with a skeleton there.
        os.remove(self.skinlog)
        os.environ["FAKE_SKIN_HAS_SKELETON"] = "1"
        try:
            st, job = self.run_c(lambda c: go(c, engine="skintokens", keep_skeleton=True))
        finally:
            os.environ.pop("FAKE_SKIN_HAS_SKELETON", None)
        self.assertEqual(job["state"], "done", job)
        self.assertIn("keeping the model's skeleton", " ".join(job["log"]))
        self.assertTrue({c["step"]: c for c in self.skin_log()}["predict"]["keep"])
        st, job = self.run_c(lambda c: go(c, engine="skintokens", keep_skeleton=True))
        self.assertEqual(job["state"], "error", job)
        self.assertIn("no skeleton to keep", job["error"])
        st, body = self.run_c(lambda c: go(c, engine="unirig", keep_skeleton=True))
        self.assertEqual(st, 400, body)
        st, body = self.run_c(lambda c: go(c, engine="blender"))
        self.assertEqual(st, 400, body)

        # A GPU with less than SkinTokens asks for: it still runs, and says so.
        os.environ["FAKE_VRAM_GB"] = "8"
        try:
            st, job = self.run_c(lambda c: go(c, engine="skintokens"))
        finally:
            os.environ.pop("FAKE_VRAM_GB", None)
        self.assertEqual(job["state"], "done", job)
        self.assertIn("warning: this GPU has 8 GB", " ".join(job["log"]))

    def test_autorig_reads_alembic_and_says_why_it_failed(self):
        # An Alembic is handed to UniRig as an OBJ of its first frame.
        async def export_abc(c):
            st, abc = await self.post_export(c, "abc")
            return abc
        abc = self.run_c(export_abc)
        dst = os.path.join(self.dirs["input"], "stick.abc")
        shutil.copyfile(abc["path"], dst)

        async def go(c, name):
            r = await c.post("/imageviewer/rig/autorig", json={"src": {"filename": name, "type": "input"}, "name": "stick"})
            body = await r.json()
            return (r.status, body) if r.status != 200 else (200, await self.wait(c, body))
        st, job = self.run_c(lambda c: go(c, "stick.abc"))
        self.assertEqual(job["state"], "done", job)
        self.assertIn("model.obj", " ".join(job["log"]))
        # A mesh UniRig cannot read: the job says so, instead of a missing raw_data.npz further on.
        os.environ["FAKE_EXTRACT_FAIL"] = "1"
        try:
            st, job = self.run_c(lambda c: go(c, "statue.glb"))
        finally:
            os.environ.pop("FAKE_EXTRACT_FAIL", None)
        self.assertEqual(job["state"], "error", job)
        self.assertIn("could not read the mesh", job["error"])
        self.assertIn("could not load the file", job["error"])
        self.assertNotIn("predicting the skeleton", " ".join(job["log"]))
        # A step that fails says why, and the whole run is in a log file.
        os.environ["FAKE_SKIN_FAIL"] = "1"
        try:
            st, job = self.run_c(lambda c: go(c, "statue.glb"))
        finally:
            os.environ.pop("FAKE_SKIN_FAIL", None)
        self.assertEqual(job["state"], "error", job)
        self.assertIn("no kernel image is available", job["error"])
        self.assertIn("full log:", job["error"])
        with open(job["log_file"], encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("Traceback", text)
        self.assertIn("predicting the skeleton", text)
        # A format it does not read at all is refused up front.
        with open(os.path.join(self.dirs["input"], "thing.stl"), "wb") as fh:
            fh.write(b"solid x")
        st, body = self.run_c(lambda c: go(c, "thing.stl"))
        self.assertEqual(st, 400, body)

    def test_kimodo_says_plainly_when_llama_access_is_pending(self):
        raw = ("Kimodo stopped: hydra.errors.InstantiationException: Error in call to target "
               "'kimodo.model.llm2vec.llm2vec_wrapper.LLM2VecEncoder': | OSError('You are trying to access a gated repo."
               "\\nMake sure to have access to it at https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct.\\n"
               "Your request to access model meta-llama/Meta-Llama-3-8B-Instruct is awaiting a review from the repo authors.')")
        said = self.routes.kimodo_why(raw)
        self.assertIn("meta-llama/Meta-Llama-3-8B-Instruct", said)
        self.assertIn("waiting for its authors to approve", said)
        self.assertIn("https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct says", said)
        self.assertNotIn("hydra", said)
        self.assertIn("hf auth login", self.routes.kimodo_why("gated repo https://huggingface.co/a/b."))
        self.assertEqual(self.routes.kimodo_why("other failure"), "other failure")

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

    def test_restyle_sends_the_path_and_the_hands_and_feet(self):
        key0 = {"frame": 0, "joints": {"Spine1": [0, 0, 0, 1]}, "root": [0, 1, 0]}
        key15 = {"frame": 15, "joints": {"Spine1": [0, 0, 0, 1]}, "root": [0, 1, 0.5], "effectors": ["Spine1", "Nope"]}
        path = {"frames": [0, 15, 30, 99], "xz": [[0, 0], [0, 0.5], [0, 1], [0, 9]]}

        async def go(c):
            bad = await c.post("/imageviewer/rig/motion", json={"mode": "restyle", "prompt": "", "frames": 31, "path": path})
            nopath = await c.post("/imageviewer/rig/motion", json={"mode": "restyle", "prompt": "Sneaks.", "frames": 31})
            r = await c.post("/imageviewer/rig/motion", json={"mode": "restyle", "prompt": "A person sneaks.", "frames": 31,
                                                                 "keys": [key0, key15], "path": path})
            return bad.status, nopath.status, await self.wait(c, await r.json())
        open(self.log, "w").close()
        try:
            bad, nopath, done = self.run_c(go)
        finally:
            for w in self.routes.WORKERS:
                w.stop()
        self.assertEqual((bad, nopath), (400, 400))
        self.assertEqual(done["state"], "done", done)
        with open(self.log) as fh:
            cons = [json.loads(line) for line in fh][-1]["constraints"]
        kinds = {c["type"]: c for c in cons}
        self.assertEqual(kinds["fullbody"]["frame_indices"], [0])
        self.assertEqual(kinds["end-effector"]["frame_indices"], [15])
        self.assertEqual(kinds["end-effector"]["joint_names"], ["Spine1"])      # names the skeleton lacks left out
        # the path: frames past the motion's end are dropped
        self.assertEqual(kinds["root2d"]["frame_indices"], [0, 15, 30])
        self.assertEqual(kinds["root2d"]["smooth_root_2d"][-1], [0, 1])

    def test_clean_path_checks_its_numbers(self):
        cp = self.routes.clean_path
        self.assertIsNone(cp(None, 10))
        self.assertEqual(cp({"frames": [0, 0, 3], "xz": [[1, 2], [3, 4], [5, 6]]}, 10), {"frames": [0, 3], "xz": [[1, 2], [5, 6]]})
        with self.assertRaises(ValueError):
            cp({"frames": [0], "xz": []}, 10)
        with self.assertRaises(ValueError):
            cp({"frames": ["a"], "xz": [[0, 0]]}, 10)

    def test_video_pose_runs_the_tracker_on_a_film(self):
        async def go(c):
            tools = await (await c.get("/imageviewer/rig/tools")).json()
            missing = await c.post("/imageviewer/rig/video_pose", json={"src": {"filename": "gone.mp4", "type": "input"}})
            notfilm = await c.post("/imageviewer/rig/video_pose", json={"src": {"filename": "statue.glb", "type": "input"}})
            r = await c.post("/imageviewer/rig/video_pose", json={"src": {"filename": "dance.mp4", "type": "input"}, "step": 1})
            return tools, missing.status, notfilm.status, await self.wait(c, await r.json())
        tools, missing, notfilm, done = self.run_c(go)
        self.assertTrue(tools["posetrack"]["ready"], tools)
        self.assertEqual(missing, 404)
        self.assertIn(notfilm, (400, 403))
        self.assertEqual(done["state"], "done", done)
        res = done["result"]
        self.assertEqual((res["fps"], res["width"], res["height"]), (25.0, 640, 360))
        self.assertEqual([f["i"] for f in res["frames"]], [0, 1, 2, 3, 4])
        self.assertEqual(len(res["frames"][0]["world"]), 33)
        self.assertIsNone(res["frames"][2]["world"])          # the frame at 80 ms had nobody in it

    def test_video_pose_reads_one_picture(self):
        with open(os.path.join(self.dirs["input"], "dancer.png"), "wb") as fh:
            fh.write(b"\x89PNG\r\n\x1a\n")

        async def go(c):
            r = await c.post("/imageviewer/rig/video_pose", json={"src": {"filename": "dancer.png", "type": "input"}})
            return await self.wait(c, await r.json())
        done = self.run_c(go)
        self.assertEqual(done["state"], "done", done)
        res = done["result"]
        self.assertTrue(res["picture"])
        self.assertEqual((res["width"], res["height"]), (320, 480))
        self.assertEqual(len(res["frames"]), 1)
        self.assertEqual(len(res["frames"][0]["world"]), 33)

    def test_body_pose_hands_the_page_a_sam3d_body_graph(self):
        import types
        fp = importlib.import_module(self.pkg + ".viewer_api").folder_paths
        with open(os.path.join(self.dirs["output"], "hero.png"), "wb") as fh:
            fh.write(b"\x89PNG\r\n\x1a\nhero")
        saved_nodes, saved_list = sys.modules.get("nodes"), getattr(fp, "get_filename_list", None)
        try:
            import av
        except ImportError:
            av = None
        if av is not None:                                     # a film of 12 frames at 25 fps, 640 x 360
            oc = av.open(os.path.join(self.dirs["input"], "dance.mp4"), "w")
            vs = oc.add_stream("libx264", rate=25)
            vs.width, vs.height, vs.pix_fmt = 640, 360, "yuv420p"
            for i in range(12):
                for pkt in vs.encode(av.VideoFrame.from_ndarray(np.full((360, 640, 3), i * 20, np.uint8), format="rgb24")):
                    oc.mux(pkt)
            for pkt in vs.encode():
                oc.mux(pkt)
            oc.close()

        async def go(c):
            src = {"src": {"filename": "hero.png", "type": "output"}, "fov": 45}
            none = await c.post("/imageviewer/rig/body_pose", json=src)
            sys.modules["nodes"] = types.SimpleNamespace(NODE_CLASS_MAPPINGS={
                "SAM3DBody_Loader": 1, "SAM3DBody_Predict": 1, "ImageViewerBodyPose": 1})
            fp.get_filename_list = lambda folder: []
            weights = await c.post("/imageviewer/rig/body_pose", json=src)
            tools = await (await c.get("/imageviewer/rig/tools")).json()
            fp.get_filename_list = lambda folder: ["sam_3d_body_dinov3_bf16.safetensors"] if folder == "detection" else []
            ok = await c.post("/imageviewer/rig/body_pose", json=src)
            film = await c.post("/imageviewer/rig/body_pose", json={"src": {"filename": "dance.mp4", "type": "input"},
                                                                     "start": 1, "end": 10, "step": 2, "smooth": 0.5})
            sound = await c.post("/imageviewer/rig/body_pose", json={"src": {"filename": "hero.wav", "type": "output"}})
            return (none.status, await none.json(), weights.status, await weights.json(), tools,
                    ok.status, await ok.json(), film.status, await film.json(), sound.status)
        try:
            none_s, none, w_s, w, tools, ok_s, ok, film_s, film, sound_s = self.run_c(go)
        finally:
            if saved_nodes is None:
                sys.modules.pop("nodes", None)
            else:
                sys.modules["nodes"] = saved_nodes
            if saved_list is None:
                del fp.get_filename_list
            else:
                fp.get_filename_list = saved_list
        self.assertEqual(none_s, 409)
        self.assertIn("SAM3DBody_Predict", [m["what"] for m in none["missing"]])
        self.assertEqual(w_s, 409)
        self.assertEqual([m["what"] for m in w["missing"]], ["sam_3d_body_dinov3_bf16.safetensors"])
        self.assertTrue(w["missing"][0]["url"].startswith("https://huggingface.co/Comfy-Org/"))
        self.assertFalse(tools["sam3dbody"]["ready"])
        self.assertEqual(ok_s, 200, ok)
        self.assertEqual(ok["output"], "4")
        self.assertEqual(ok["graph"]["3"]["inputs"]["fov"], 45.0)
        self.assertTrue(ok["image"].startswith("rig_pose/"), ok)
        self.assertTrue(os.path.isfile(os.path.join(self.dirs["input"], *ok["image"].split("/"))))
        self.assertEqual(ok["graph"]["1"]["inputs"]["image"], ok["image"])
        self.assertIn(sound_s, (400, 404))
        if av is None:
            return
        # A film: cut into parts in the input folder, a LoadVideo -> ... -> ImageViewerBodyPose graph each.
        self.assertEqual(film_s, 200, film)
        self.assertTrue(film["film"])
        self.assertEqual(film["frames"], [1, 3, 5, 7, 9])
        self.assertEqual((film["width"], film["height"], film["fps"]), (640, 360, 25.0))
        part = film["parts"][0]
        self.assertEqual((part["first"], part["count"]), (0, 5))
        g = part["graph"]
        self.assertEqual(g["1"]["class_type"], "LoadVideo")
        self.assertTrue(os.path.isfile(os.path.join(self.dirs["input"], *g["1"]["inputs"]["file"].split("/"))))
        self.assertEqual(g["3"]["inputs"]["image"], ["5", 0])
        self.assertEqual(g["6"]["inputs"]["strength"], 0.5)
        self.assertEqual(g[part["output"]]["inputs"]["mhr_pose_data"], ["6", 0])

    def test_lipsync_reads_a_sound_into_mouth_curves(self):
        try:
            import av  # noqa: F401
        except ImportError:
            self.skipTest("needs PyAV")
        import wave
        rate = 16000
        t = np.arange(int(rate * 0.4)) / rate
        voice = 0.3 * np.sin(2 * np.pi * 700 * t) + 0.15 * np.sin(2 * np.pi * 1400 * t)
        sig = np.concatenate([np.zeros(int(rate * 0.3)), voice, np.zeros(int(rate * 0.06)), voice, np.zeros(int(rate * 0.3))])
        path = os.path.join(self.dirs["input"], "line.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
            w.writeframes((sig * 32767).astype("<i2").tobytes())

        async def go(c):
            r = await c.post("/imageviewer/rig/lipsync", json={"src": {"filename": "line.wav", "type": "input"}, "fps": 25, "lead": 0})
            bad = await c.post("/imageviewer/rig/lipsync", json={"src": {"filename": "line.wav", "type": "input"}, "fps": 500})
            return r.status, await r.json(), bad.status
        status, out, bad = self.run_c(go)
        self.assertEqual(status, 200, out)
        self.assertEqual(bad, 400)
        n = out["frames"]
        self.assertEqual(n, len(out["open"]))
        self.assertAlmostEqual(n / 25, len(sig) / rate, delta=0.08)
        self.assertLess(max(out["open"][:5]), 0.1, "silence: closed")
        self.assertGreater(max(out["open"][10:16]), 0.8, "the voice opens the mouth")
        dip = int((0.3 + 0.4 + 0.03) * 25)
        self.assertEqual(max(out["closed"][dip - 1:dip + 2]), 1.0, "the short drop between two sounds shuts the lips")


if __name__ == "__main__":
    unittest.main()
