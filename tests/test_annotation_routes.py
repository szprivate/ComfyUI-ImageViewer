"""The marks beside a picture or a film, read in words and drawn as a mask, through the REAL routes.

/bepic/video_annotations keeps a picture's marks beside it as it does a film's (``still.png`` ->
``still.annotations.json``); ``?describe=1`` adds them in words (annotation_io.report, the shape the
page answers with); POST /bepic/annotation_mask draws the boxes and strokes as a PNG under
./output/annotation_masks. A file outside what the viewer may show is refused, as for every route.

viewer_api in a private aiohttp app, ComfyUI's folder_paths and server stubbed (as in test_routes_off_loop).
Run: python -m unittest tests.test_annotation_routes
"""
import asyncio
import importlib
import os
import shutil
import sys
import tempfile
import types
import unittest

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from PIL import Image
except ImportError:  # pragma: no cover
    web = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _load(tmp):
    fp = types.ModuleType("folder_paths")
    fp.base_path = tmp
    dirs = {"output": os.path.join(tmp, "out"), "temp": os.path.join(tmp, "temp"), "input": os.path.join(tmp, "in")}
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)
    fp.get_output_directory = lambda: dirs["output"]
    fp.get_temp_directory = lambda: dirs["temp"]
    fp.get_input_directory = lambda: dirs["input"]
    fp.get_directory_by_type = lambda t: dirs.get(t)

    def get_save_image_path(prefix, out_dir, w=0, h=0):
        sub, name = os.path.split(prefix)
        folder = os.path.join(out_dir, sub)
        n = len([f for f in os.listdir(folder)]) + 1 if os.path.isdir(folder) else 1
        return folder, name, n, sub, prefix
    fp.get_save_image_path = get_save_image_path
    app = web.Application()
    srv = types.ModuleType("server")
    srv.PromptServer = type("PromptServer", (), {"instance": types.SimpleNamespace(app=app)})
    saved = {k: sys.modules.get(k) for k in ("folder_paths", "server")}
    sys.modules.update(folder_paths=fp, server=srv)
    name = "bepic_annot_routes_under_test"
    pkg = types.ModuleType(name)
    pkg.__path__ = [ROOT]
    sys.modules[name] = pkg
    try:
        importlib.import_module(name + ".viewer_api")
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    return app, dirs, name


BOX = {"type": "rect", "a": {"x": 0.25, "y": 0.25}, "b": {"x": 0.5, "y": 0.5}, "color": "#f00", "width": 4}
NOTE = {"type": "text", "x": 0.1, "y": 0.1, "size": 30, "color": "#fff", "text": "logo too small"}


@unittest.skipIf(web is None, "needs aiohttp and Pillow")
class AnnotationRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp)
        cls.still = os.path.join(cls.dirs["output"], "still.png")
        Image.new("RGB", (200, 100), (10, 20, 30)).save(cls.still)
        cls.outside = os.path.join(tempfile.mkdtemp(), "secret.png")
        Image.new("RGB", (20, 20)).save(cls.outside)

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(os.path.dirname(cls.outside), ignore_errors=True)

    def _run(self, fn):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    def test_a_pictures_marks_are_kept_beside_it_and_read_back_in_words(self):
        async def fn(c):
            r = await c.post("/bepic/video_annotations", json={"path": self.still, "items": [BOX, NOTE],
                                                               "width": 200, "height": 100, "media": "still.png"})
            self.assertEqual(r.status, 200, await r.text())
            r = await c.get("/bepic/video_annotations", params={"path": self.still, "describe": "1"})
            return r.status, await r.json()
        status, doc = self._run(fn)
        self.assertEqual(status, 200)
        self.assertTrue(os.path.isfile(os.path.join(self.dirs["output"], "still.annotations.json")))
        self.assertEqual((doc["width"], doc["height"]), (200, 100))
        rep = doc["report"]
        self.assertEqual((rep["kind"], rep["count"], rep["source"]), ("image", 2, self.still))
        self.assertEqual(rep["annotations"][0]["notes"], ["logo too small"])
        self.assertEqual({m["type"] for m in rep["annotations"][0]["marks"]}, {"box", "text"})

    def test_a_mask_of_the_stored_marks_lands_in_the_output_folder(self):
        async def fn(c):
            await c.post("/bepic/video_annotations", json={"path": self.still, "items": [BOX, NOTE]})
            r = await c.post("/bepic/annotation_mask", json={"path": self.still})
            return r.status, await r.json()
        status, ans = self._run(fn)
        self.assertEqual(status, 200, ans)
        self.assertEqual((ans["width"], ans["height"], ans["marks"]), (200, 100, 1))
        self.assertTrue(ans["path"].startswith(os.path.join(self.dirs["output"], "annotation_masks")))
        with Image.open(ans["path"]) as m:
            self.assertEqual((m.size, m.getpixel((75, 37)), m.getpixel((5, 5))), ((200, 100), 255, 0))

    def test_marks_sent_with_their_size_need_no_file(self):
        async def fn(c):
            r = await c.post("/bepic/annotation_mask", json={"items": [BOX], "width": 64, "height": 32})
            return r.status, await r.json()
        status, ans = self._run(fn)
        self.assertEqual((status, ans["width"], ans["marks"]), (200, 64, 1))

    def test_a_file_the_viewer_may_not_show_is_refused(self):
        async def fn(c):
            a = await c.get("/bepic/video_annotations", params={"path": self.outside, "describe": "1"})
            b = await c.post("/bepic/annotation_mask", json={"path": self.outside})
            return a.status, b.status
        self.assertEqual(self._run(fn), (403, 403))


if __name__ == "__main__":
    unittest.main()
