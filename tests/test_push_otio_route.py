"""POST /imageviewer/push with an .otio that has no film beside it opens the cut (the REAL route in a private aiohttp app),
and a cut dropped from the desktop is kept by /imageviewer/timeline_upload.

    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest discover -s tests -p test_push_otio_route.py
"""
import asyncio
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, _touch, web  # noqa: E402

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer


@unittest.skipIf(web is None, "needs aiohttp")
class PushOtio(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.outside = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.outside, ignore_errors=True)

    def setUp(self):
        del self.sent[:]

    def _run(self, fn):
        # timeline_media imports folder_paths when a route first needs it (after _load put the real modules back).
        fp = types.ModuleType("folder_paths")
        fp.get_input_directory = lambda: self.dirs["input"]
        fp.get_output_directory = lambda: self.dirs["output"]
        fp.get_temp_directory = lambda: self.dirs["temp"]
        fp.get_directory_by_type = lambda t: self.dirs.get(t)
        fp.base_path = self.tmp
        was = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = fp
        try:
            return asyncio.run(self._serve(fn))
        finally:
            if was is None:
                sys.modules.pop("folder_paths", None)
            else:
                sys.modules["folder_paths"] = was

    async def _serve(self, fn):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return await go()

    def push(self, paths, **kw):
        async def go(c):
            r = await c.post("/imageviewer/push", json={"paths": paths, **kw})
            return r.status, await r.json()
        return self._run(go)

    def test_a_lone_otio_opens_as_a_cut(self):
        otio = _touch(self.dirs["output"], "lone.otio")
        status, got = self.push([otio], panel="edit")
        self.assertEqual(status, 200, got)
        self.assertEqual([os.path.normcase(p) for p in got["cuts"]], [os.path.normcase(os.path.abspath(otio))])
        self.assertEqual(got["refused"], [])
        self.assertEqual([e for e, _ in self.sent], ["imageviewer.edit.open"])
        self.assertEqual(os.path.normcase(self.sent[0][1]["path"]), os.path.normcase(os.path.abspath(otio)))

    def test_an_otio_with_a_film_beside_it_still_shows_the_film(self):
        out = self.dirs["output"]
        _touch(out, "with_film.mp4")
        otio = _touch(out, "with_film.otio")
        status, got = self.push([otio])
        self.assertEqual(status, 200, got)
        self.assertEqual(got["cuts"], [])
        self.assertEqual(got["shown"], 1)

    def test_the_access_fence_holds_and_a_missing_cut_is_refused(self):
        outside = _touch(self.outside, "away.otio")
        status, got = self.push([outside, os.path.join(self.dirs["output"], "nope.otio")])
        self.assertEqual(status, 200, got)
        self.assertEqual(got["cuts"], [])
        self.assertEqual(len(got["refused"]), 2)
        self.assertEqual([e for e, _ in self.sent], [])

    def test_a_dropped_cut_is_kept_beside_the_others_and_never_written_over(self):
        async def up(c, body):
            from aiohttp import FormData
            form = FormData()
            form.add_field("file", body, filename="my cut.otio", content_type="application/octet-stream")
            r = await c.post("/imageviewer/timeline_upload", data=form)
            return r.status, await r.text()
        s1, t1 = self._run(lambda c: up(c, b'{"a": 1}'))
        s2, t2 = self._run(lambda c: up(c, b'{"a": 2}'))
        s3, t3 = self._run(lambda c: up(c, b'{"a": 1}'))
        self.assertEqual((s1, s2, s3), (200, 200, 200), (t1, t2, t3))
        p1, p2, p3 = (json.loads(t)["path"] for t in (t1, t2, t3))
        self.assertTrue(p1.endswith(".otio") and os.path.isfile(p1))
        self.assertNotEqual(p1, p2, "other bytes: another file")
        self.assertEqual(p1, p3, "the same bytes: the same file")
        self.assertEqual(open(p1, "rb").read(), b'{"a": 1}')
        self.assertEqual(open(p2, "rb").read(), b'{"a": 2}')

    def test_other_files_are_still_refused_by_the_upload(self):
        async def go(c):
            from aiohttp import FormData
            form = FormData()
            form.add_field("file", b"x", filename="notes.txt")
            return (await c.post("/imageviewer/timeline_upload", data=form)).status
        self.assertEqual(self._run(go), 415)


if __name__ == "__main__":
    unittest.main()
