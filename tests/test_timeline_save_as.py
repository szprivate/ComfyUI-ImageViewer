"""Saving a cut, and Save cut as: the REAL routes in a private aiohttp app.

    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_timeline_save_as  (or discover in tests/)
"""
import asyncio
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, _touch, web  # noqa: E402

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer


@unittest.skipIf(web is None, "needs aiohttp")
class SaveAs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, [])
        cls.tio = importlib.import_module(cls.pkg + ".timeline_io")
        cls.outside = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.outside, ignore_errors=True)

    def setUp(self):
        self.out = self.dirs["output"]
        self.a = _touch(self.out, "a.mp4")
        self.edit = {"clips": [{"file": self.a, "name": "a", "in": 0.0, "length": 2.0, "transition": 0}], "texts": []}

    def post(self, path, body, **kw):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as c:
                r = await c.post(path, json=body, **kw)
                text = await r.text()
                return r.status, text
        return asyncio.run(go())

    def test_a_new_save_returns_the_absolute_path_and_the_file_is_there(self):
        status, text = self.post("/bepic/timeline", {"new": True, "name": "first", "edit": self.edit})
        self.assertEqual(status, 200, text)
        data = json.loads(text)
        self.assertTrue(os.path.isabs(data["path"]))
        self.assertTrue(os.path.isfile(data["path"]))
        self.assertEqual(os.path.normcase(data["path"]), os.path.normcase(os.path.abspath(data["otio"])))
        self.assertIn("edits", data["path"])

    def test_save_as_to_a_new_name_keeps_the_source_and_refuses_to_overwrite_unasked(self):
        status, text = self.post("/bepic/timeline", {"new": True, "name": "src", "edit": self.edit})
        src = json.loads(text)
        before = open(src["path"], encoding="utf-8").read()
        folder = os.path.join(self.out, "there")
        body = {"name": "second", "folder": folder, "edit": self.tio.read_editable(src["path"]), "source": src["target"]}
        status, text = self.post("/bepic/timeline_save_as", body)
        self.assertEqual(status, 200, text)
        data = json.loads(text)
        want = os.path.join(folder, "second.otio")
        self.assertEqual(data["path"], want)
        self.assertEqual(data["target"], {"path": want, "external": 1})
        self.assertTrue(os.path.isfile(want))
        self.assertEqual(open(src["path"], encoding="utf-8").read(), before, "the original is untouched")
        # There now: asked; with overwrite: written.
        status, text = self.post("/bepic/timeline_save_as", body)
        self.assertEqual(status, 409)
        self.assertTrue(json.loads(text)["exists"])
        status, _ = self.post("/bepic/timeline_save_as", {**body, "overwrite": True})
        self.assertEqual(status, 200)

    def test_outside_the_roots_and_traversal_in_the_name(self):
        status, _ = self.post("/bepic/timeline_save_as", {"name": "x", "folder": self.outside, "edit": self.edit})
        self.assertEqual(status, 403)
        self.assertEqual(os.listdir(self.outside), [])
        status, text = self.post("/bepic/timeline_save_as", {"name": "../../evil", "folder": self.out, "edit": self.edit})
        self.assertEqual(status, 200, text)
        path = json.loads(text)["path"]
        self.assertEqual(os.path.dirname(path), os.path.abspath(self.out))
        self.assertTrue(path.endswith(".otio"))
        for raw, want in (("a.otio", "a.otio"), ("..\\..\\b.OTIO", "_.._b.otio"), ("", "cut.otio"), ("...", "cut.otio"), ("CON", "cut_CON.otio"), ("c:d", "c_d.otio")):
            self.assertEqual(self.tio.cut_file_name(raw), want, raw)

    def test_a_cross_site_post_is_refused(self):
        status, _ = self.post("/bepic/timeline_save_as", {"name": "x", "folder": self.out, "edit": self.edit}, headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)

    def test_a_failed_write_says_so_leaves_nothing_and_the_old_file_stands(self):
        real = self.tio.os.replace
        def boom(*a):
            raise OSError(24, "Too many open files")
        self.tio.os.replace = boom
        try:
            status, text = self.post("/bepic/timeline_save_as", {"name": "fail", "folder": self.out, "edit": self.edit})
            self.assertEqual(status, 500)
            self.assertIn("Too many open files", text)
            status, text = self.post("/bepic/timeline", {"new": True, "name": "fail2", "edit": self.edit})
            self.assertEqual(status, 500)
            self.assertIn("not saved", text)
        finally:
            self.tio.os.replace = real
        self.assertFalse(os.path.exists(os.path.join(self.out, "fail.otio")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "fail.otio.tmp")))

    def test_the_file_list_says_a_cut_is_a_cut(self):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as c:
                r = await c.get("/bepic/browse", params={"path": self.out})
                return await r.json()
        with open(os.path.join(self.out, "listed.otio"), "w", encoding="utf-8") as fh:
            fh.write("{}")
        kinds = {f["name"]: f["kind"] for f in asyncio.run(go())["files"]}
        self.assertEqual(kinds["listed.otio"], "cut")


if __name__ == "__main__":
    unittest.main()
