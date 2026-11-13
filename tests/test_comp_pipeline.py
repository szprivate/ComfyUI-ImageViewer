"""Comp's pipeline: the Python API (src/comp_api.py), the command-line render (scripts/comp_render.py), and the
routes through the REAL viewer_api - Write nodes planned and rendered, a node's metadata, autosave and recovery,
the agent's ops, relinking, localising, and the farm request (a dry run; the relay to agentY is not reached).

    python -m unittest discover -s tests -p test_comp_pipeline.py
"""
import asyncio
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from test_edit_takes import _load, web  # noqa: E402

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer

_pkg = types.ModuleType("_cpl")
_pkg.__path__ = [os.path.join(ROOT, "src")]
sys.modules.setdefault("_cpl", _pkg)
A = importlib.import_module("_cpl.comp_api")
CW = importlib.import_module("_cpl.comp_write")
CP = importlib.import_module("_cpl.comp_pipeline")


def png(path, rgb=(255, 0, 0), size=(16, 24)):
    from PIL import Image
    a = np.zeros((size[0], size[1], 4), np.uint8)
    a[..., :3] = rgb
    a[..., 3] = 255
    Image.fromarray(a, "RGBA").save(path)


class PythonApi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        png(os.path.join(self.tmp, "plate.png"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_build_save_and_render(self):
        c = A.Comp.new(24, 16, fps=25, frames=3)
        r = c.add("read", file="plate.png")
        g = c.add("grade", inputs=[r], gain=2)
        self.assertEqual((r, g), ("Read1", "Grade1"))
        c.key(g, "gain", 0, 1.0)
        c.key(g, "gain", 2, 3.0, ease="linear")
        w = c.add("write", inputs=[g], name="main", file="out/{name}.####.exr", channels="all")
        c.connect(c.output, w)
        with self.assertRaises(A.CompError):
            c.connect(r, w)                     # a loop
        with self.assertRaises(A.CompError):
            c.set(g, gain="lots")
        with self.assertRaises(A.CompError):
            c.add("nosuch")
        path = c.save(os.path.join(self.tmp, "sh010.comp.json"))
        again = A.Comp.open(path)
        s = again.summary()
        self.assertEqual(s["writes"], ["Write1"])
        self.assertEqual([n for n in s["nodes"] if n["id"] == "Grade1"][0]["keys"], {"gain": [0, 2]})
        got = again.render()
        self.assertEqual([os.path.basename(f) for f in got[0]["files"]], ["main.1001.exr", "main.1002.exr", "main.1003.exr"])
        files = again.render_output(os.path.join(self.tmp, "o", "o.####.png"), frames=[1])
        self.assertEqual([os.path.basename(f) for f in files], ["o.1002.png"])

    def test_ops_are_all_or_nothing_and_name_what_they_made(self):
        c = A.Comp.new(24, 16)
        got = c.apply([{"op": "add", "type": "read", "file": "plate.png"},
                       {"op": "add", "type": "blur", "inputs": ["$0"], "params": {"size": 4}},
                       {"op": "connect", "node": "Output1", "from": "$1"},
                       {"op": "key", "node": "$1", "param": "size", "frame": 10, "value": 8}])
        self.assertEqual(got["ids"], ["Read1", "Blur1"])
        self.assertEqual(c.node("Output1")["inputs"], ["Blur1"])
        before = json.dumps(c.data, sort_keys=True)
        with self.assertRaises(A.CompError):
            c.apply([{"op": "add", "type": "grade"}, {"op": "set", "node": "Grade1", "gain": -1e9, "nosuch": 1}])
        self.assertEqual(json.dumps(c.data, sort_keys=True), before)
        with self.assertRaises(A.CompError):
            c.apply([{"op": "explode"}])


class CommandLine(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        png(os.path.join(self.tmp, "plate.png"))
        c = A.Comp.new(24, 16, frames=5)
        r = c.add("read", file="plate.png")
        w = c.add("write", inputs=[r], name="main", handles=1)
        c.connect(c.output, w)
        self.path = c.save(os.path.join(self.tmp, "cli.comp.json"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "comp_render.py"), self.path, "--quiet", *args],
                              capture_output=True, text=True, timeout=300)

    def test_list_and_a_farm_chunk(self):
        p = self.run_cli("--list")
        self.assertEqual(p.returncode, 0, p.stderr)
        [w] = json.loads(p.stdout)
        self.assertEqual((w["first"], w["last"]), (-1, 5))
        p = self.run_cli("--frames", "2-3", "--frame-offset", "1")     # comp frames 1..2
        self.assertEqual(p.returncode, 0, p.stderr)
        out = sorted(os.listdir(os.path.join(self.tmp, "cli_main")))
        self.assertEqual(out, ["main.1002.exr", "main.1003.exr"])
        p = self.run_cli("--writes", "nope")
        self.assertEqual(p.returncode, 1)
        self.assertIn("no node", p.stderr)


@unittest.skipIf(web is None, "needs aiohttp")
class Routes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        os.environ["IMAGE_VIEWER_COMP_AUTOSAVE"] = os.path.join(cls.tmp, "autosave")
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.outside = tempfile.mkdtemp()
        png(os.path.join(cls.dirs["output"], "plate.png"), (0, 255, 0))

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("IMAGE_VIEWER_COMP_AUTOSAVE", None)
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

    @staticmethod
    async def wait(c, route, jid):
        for _ in range(400):
            await asyncio.sleep(0.05)
            r = await c.get(route, params={"job": jid})
            s = await r.json()
            if s["state"] != "running":
                return s
        raise AssertionError("the job did not end")

    def comp(self, **write):
        return {"comp": 1, "format": {"width": 24, "height": 16, "fps": 24, "frames": 3}, "output": "Output1",
                "nodes": [{"id": "Read1", "type": "read", "file": "plate.png", "inputs": []},
                          {"id": "Metadata1", "type": "metadata", "set": "shot = sh020", "inputs": ["Read1"]},
                          dict({"id": "Write1", "type": "write", "name": "comp", "inputs": ["Metadata1"]}, **write),
                          {"id": "Output1", "type": "output", "inputs": ["Write1"]}]}

    def test_writes_planned_and_rendered(self):
        path = os.path.join(self.dirs["output"], "w.comp.json")

        async def go(c):
            st, d = await self.j(c, "/imageviewer/comp", {"path": path, "comp": self.comp(handles=1)})
            self.assertEqual(st, 200, d)
            st, d = await self.j(c, "/imageviewer/comp_write_plan", {"path": path})
            self.assertEqual(st, 200, d)
            self.assertEqual((d["writes"][0]["first"], d["writes"][0]["last"], d["refused"]), (-1, 3, None))
            st, d = await self.j(c, "/imageviewer/comp_write", {"path": path, "first": 0, "last": 0, "handles": 0})
            self.assertEqual(st, 200, d)
            s = await self.wait(c, "/imageviewer/comp_write", d["job"])
            self.assertEqual(s["state"], "done", s)
            [w] = s["result"]["writes"]
            self.assertEqual([os.path.basename(f) for f in w["files"]], ["comp.1001.exr"])
            self.assertEqual(CW.exr_header(w["files"][0])["shot"], "sh020")
            # a Write outside the allowed folders is refused before anything is written
            bad = self.comp(file=os.path.join(self.outside, "x.####.exr"))
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": bad})
            st, d = await self.j(c, "/imageviewer/comp_write", {"path": path})
            self.assertEqual(st, 403, d)
            self.assertEqual(os.listdir(self.outside), [])
            st, d = await self.j(c, "/imageviewer/comp_metadata", {"path": path, "comp": self.comp(), "node": "Write1", "frame": 1})
            self.assertEqual(st, 200, d)
            self.assertEqual(d["metadata"]["shot"], "sh020")
            self.assertTrue(d["metadata"]["input/filename"].endswith("plate.png"))
        self.run_c(go)

    def test_autosave_and_recovery(self):
        path = os.path.join(self.dirs["output"], "a.comp.json")

        async def go(c):
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": self.comp()})
            changed = self.comp()
            changed["format"]["frames"] = 9
            st, d = await self.j(c, "/imageviewer/comp_autosave", {"path": path, "comp": changed})
            self.assertEqual(st, 200, d)
            r = await c.get("/imageviewer/comp", params={"path": path})
            got = await r.json()
            self.assertIn("autosave", got)
            r = await c.get("/imageviewer/comp_autosave", params={"path": path})
            self.assertEqual((await r.json())["comp"]["format"]["frames"], 9)
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": changed})      # a save forgets it
            r = await c.get("/imageviewer/comp", params={"path": path})
            self.assertNotIn("autosave", await r.json())
            r = await c.get("/imageviewer/comp_autosave", params={"path": path})
            self.assertEqual(r.status, 404)
            st, _ = await self.j(c, "/imageviewer/comp_autosave", {"path": os.path.join(self.outside, "z.comp.json"), "comp": changed})
            self.assertEqual(st, 403)
        self.run_c(go)

    def test_the_agents_ops(self):
        path = os.path.join(self.dirs["output"], "agent", "made.comp.json")

        async def go(c):
            st, d = await self.j(c, "/imageviewer/comp_ops", {"path": path, "ops": []})
            self.assertEqual(st, 404, d)
            st, d = await self.j(c, "/imageviewer/comp_ops", {"path": path, "create": {"width": 32, "height": 20, "frames": 4}, "ops": [
                {"op": "add", "type": "read", "file": "../plate.png"},
                {"op": "add", "type": "write", "inputs": ["$0"], "name": "main"},
                {"op": "connect", "node": "Output1", "from": "$1"}]})
            self.assertEqual(st, 200, d)
            self.assertEqual(d["ids"], ["Read1", "Write1"])
            self.assertEqual(d["comp"]["format"]["width"], 32)
            self.assertIn(("imageviewer.comp.open", {"path": path, "quiet": True}), self.sent)
            st, d = await self.j(c, "/imageviewer/comp_ops", {"path": path, "ops": [{"op": "set", "node": "Read1", "nosuch": 1}]})
            self.assertEqual(st, 422, d)
            r = await c.get("/imageviewer/comp_summary", params={"path": path})
            s = await r.json()
            self.assertEqual(s["writes"], ["Write1"])
        self.run_c(go)

    def test_relink_and_localise(self):
        path = os.path.join(self.dirs["output"], "r.comp.json")
        moved = os.path.join(self.dirs["output"], "moved", "deep")
        os.makedirs(moved, exist_ok=True)
        for n in (1, 2):
            png(os.path.join(moved, f"bg.{n:04d}.png"))
        comp = self.comp()
        comp["nodes"].insert(0, {"id": "Read2", "type": "read", "file": "old/place/bg.####.png", "inputs": []})

        async def go(c):
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": comp})
            st, d = await self.j(c, "/imageviewer/comp_relink", {"path": path})
            self.assertEqual([m["id"] for m in d["missing"]], ["Read2"])
            st, d = await self.j(c, "/imageviewer/comp_relink", {"path": path, "folder": self.dirs["output"]})
            self.assertEqual(st, 200, d)
            self.assertEqual(d["found"], {"Read2": "moved/deep/bg.####.png"})
            st, d = await self.j(c, "/imageviewer/comp_relink", {"path": path, "folder": self.outside})
            self.assertEqual(st, 403)
            comp["nodes"][0]["file"] = "moved/deep/bg.####.png"
            st, d = await self.j(c, "/imageviewer/comp_localise", {"path": path, "comp": comp})
            self.assertEqual(st, 200, d)
            s = await self.wait(c, "/imageviewer/comp_localise", d["job"])
            self.assertEqual(s["state"], "done", s)
            res = s["result"]
            self.assertEqual((res["files"], res["copied"]), (3, 3))
            local = res["local"]["Read2"]
            self.assertTrue(local.startswith(os.path.join(self.dirs["input"], "comp_footage")), local)
            self.assertTrue(os.path.isfile(local.replace("####", "0002")))
            st, d = await self.j(c, "/imageviewer/comp_localise", {"path": path, "comp": comp})
            s = await self.wait(c, "/imageviewer/comp_localise", d["job"])
            self.assertEqual(s["result"]["copied"], 0)             # up to date: nothing copied again
            # the preview reads the local copy
            r = await c.get("/imageviewer/comp_source", params={"file": "moved/deep/bg.####.png", "comp": path, "local": local})
            got = await r.json()
            self.assertEqual(got["path"], local)
        self.run_c(go)

    def test_the_farm_request_dry_run(self):
        path = os.path.join(self.dirs["output"], "f.comp.json")

        async def go(c):
            await self.j(c, "/imageviewer/comp", {"path": path, "comp": self.comp(handles=2)})
            st, d = await self.j(c, "/imageviewer/comp_farm", {"path": path, "dry_run": True, "chunk": 2})
            self.assertEqual(st, 200, d)
            r = d["request"]
            self.assertEqual((r["frames"], r["frame_offset"], r["chunk"], r["writes"]), ("0-6", 2, 2, ["Write1"]))
            self.assertTrue(r["script"].endswith(os.path.join("scripts", "comp_render.py")))
            self.assertTrue(any("own disk" in w for w in d["warnings"]), d["warnings"])
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
