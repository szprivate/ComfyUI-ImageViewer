"""Takes: the same shot made again, kept beside the first - in the timeline file, and through POST /imageviewer/take.

timeline_io keeps `takes` per clip (editable -> rebuild -> editable), points the clip's media at the active take (the
.otio stays valid for any other program), and add_take does on disk what the Edit panel's addTake does in the page.
The route is fenced like the other timeline routes (path_access) and tells the pages with `imageviewer.edit.take`.

viewer_api in a private aiohttp app, ComfyUI's folder_paths and server stubbed (as in test_annotation_routes).
Run: python -m unittest tests.test_edit_takes
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

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover
    web = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _tio():
    name = "imageviewer_takes_tio_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [ROOT]
        sys.modules[name] = pkg
    return importlib.import_module(name + ".timeline_io")


def _touch(folder, name):
    path = os.path.join(folder, name)
    with open(path, "wb") as fh:
        fh.write(b"\0" * 16)
    return path.replace("\\", "/")


class TimelineTakes(unittest.TestCase):
    def setUp(self):
        self.tio = _tio()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.a1 = _touch(self.tmp, "shot_03_v001.mp4")
        self.a2 = _touch(self.tmp, "shot_03_v002.mp4")
        self.a3 = _touch(self.tmp, "shot_03_v003.mp4")
        self.b = _touch(self.tmp, "other.mp4")
        self.may = lambda p: os.path.abspath(p).startswith(os.path.abspath(self.tmp))
        edit = {"clips": [
            {"file": self.a1, "name": "shot_03", "in": 1.0, "length": 3.0, "transition": 0, "color": "#ff0000", "volume": 0.5,
             "fx": {"zx": 2.0}, "speed": 1.5},
            {"file": self.b, "name": "other", "in": 0.0, "length": 2.0, "transition": 0}]}
        self.doc = self.tio.rebuild(self.tio.new_doc("t", 24), edit, "", self.may)

    def media(self, doc, i=0):
        video = self.tio._track_of(doc, "video")
        return self.tio._file(video["children"][i]["media_reference"])

    def test_takes_make_the_round_trip_and_the_active_one_is_the_media(self):
        edit = self.tio.editable(self.doc)
        self.assertNotIn("takes", edit["clips"][0])
        edit["clips"][0]["takes"] = [
            {"file": self.a1, "version": 1, "created": "", "note": "original", "active": False},
            {"file": self.a2, "version": 2, "created": "2026-10-31T10:00:00", "note": "warmer", "active": True}]
        edit["clips"][0]["file"] = self.a2
        new = self.tio.rebuild(self.doc, edit, "", self.may)
        self.assertEqual(self.media(new), self.a2)
        self.assertEqual(self.media(self.doc), self.a1, "the document given is left alone")
        json.loads(json.dumps(new))
        self.assertTrue(new["OTIO_SCHEMA"].startswith("Timeline"))
        clip = self.tio._track_of(new, "video")["children"][0]
        self.assertTrue(clip["media_reference"]["OTIO_SCHEMA"].startswith("ExternalReference"))
        again = self.tio.editable(new)
        self.assertEqual(again["clips"][0]["file"], self.a2)
        self.assertEqual([(t["version"], t["active"]) for t in again["clips"][0]["takes"]], [(1, False), (2, True)])
        self.assertEqual(again["clips"][0]["takes"][1]["note"], "warmer")
        self.assertEqual(again["clips"][0]["color"], "#ff0000")
        self.assertNotIn("takes", again["clips"][1])
        # And back to v1: the media follows.
        back = again["clips"][0]
        back["takes"] = [dict(t, active=t["version"] == 1) for t in back["takes"]]
        self.assertEqual(self.media(self.tio.rebuild(new, again, "", self.may)), self.a1)

    def test_a_new_media_file_has_to_pass_may_use_and_exist(self):
        edit = self.tio.editable(self.doc)
        edit["clips"][0]["takes"] = [{"file": self.a2, "version": 2, "created": "", "note": "", "active": True}]
        with self.assertRaises(ValueError):
            self.tio.rebuild(self.doc, edit, "")                                   # no may_use: no new material
        with self.assertRaises(ValueError):
            self.tio.rebuild(self.doc, edit, "", lambda p: False)
        edit["clips"][0]["takes"][0]["file"] = os.path.join(self.tmp, "missing.mp4")
        with self.assertRaises(ValueError):
            self.tio.rebuild(self.doc, edit, "", self.may)
        # The media a clip already points at needs no check.
        edit["clips"][0]["takes"] = [{"file": self.a1, "version": 1, "created": "", "note": "", "active": True}]
        self.tio.rebuild(self.doc, edit, "")

    def test_takes_are_validated_and_capped(self):
        messy = [{"file": "a", "version": 1, "active": True}, {"file": "b", "version": 2, "active": True},
                 {"file": "c", "version": True}, {"file": "", "version": 3}, {"file": "d", "version": "4"}, "str", None,
                 {"file": "e", "version": 5, "note": "n" * 500, "created": 7}]
        got = self.tio.clean_takes(messy)
        self.assertEqual([t["file"] for t in got], ["a", "b", "e"])
        self.assertEqual([t["active"] for t in got], [True, False, False])
        self.assertEqual(len(got[2]["note"]), 200)
        self.assertEqual(got[2]["created"], "")
        self.assertEqual(len(self.tio.clean_takes([{"file": f"f{i}", "version": i} for i in range(90)])), 50)
        self.assertEqual(self.tio.clean_takes("nope"), [])
        self.assertEqual([t["active"] for t in self.tio.clean_takes([{"file": "x", "version": 1}, {"file": "y", "version": 2}])],
                         [False, True])

    def test_add_take_on_disk_does_what_the_panel_does(self):
        new, n = self.tio.add_take(self.doc, self.a1, self.a2, 2, "warmer", "2026-10-31T10:00:00")
        self.assertEqual(n, 1)
        self.assertEqual(self.media(new), self.a2)
        self.assertEqual(self.media(new, 1), self.b)
        edit = self.tio.editable(new)
        c = edit["clips"][0]
        self.assertEqual((c["in"], c["length"], c["speed"], c["color"], c["fx"], c["name"]), (1.0, 3.0, 1.5, "#ff0000", {"zx": 2.0}, "shot_03"))
        self.assertEqual([(t["version"], t["note"], t["active"]) for t in c["takes"]],
                         [(1, "original", False), (2, "warmer", True)])
        # Again from the new file: v3 next to v2 and v1; the same file twice stays one take.
        newer, n = self.tio.add_take(new, self.a2, self.a3, 3)
        self.assertEqual(n, 1)
        self.assertEqual([t["version"] for t in self.tio.editable(newer)["clips"][0]["takes"]], [1, 2, 3])
        same, _ = self.tio.add_take(newer, self.a3, self.a3, 3)
        self.assertEqual(len(self.tio.editable(same)["clips"][0]["takes"]), 3)
        # Nothing uses that file: nothing changes.
        none, n = self.tio.add_take(self.doc, self.a3, self.a2, 2)
        self.assertEqual(n, 0)
        self.assertEqual(none, self.doc)
        # Windows spellings of one path are one path.
        spelled, n = self.tio.add_take(self.doc, self.a1.replace("/", "\\").upper(), self.a2, 2)
        self.assertEqual(n, 1 if os.name == "nt" else 0)

    def test_add_take_clamps_to_a_shorter_source_or_retimes(self):
        # a1 is used from 1.0 for 3.0 s at 1.5x: 4.5 s of source (1.0 .. 5.5).
        new, n = self.tio.add_take(self.doc, self.a1, self.a2, 2, duration=3.0)
        c = self.tio.editable(new)["clips"][0]
        self.assertEqual(c["in"], 1.0)
        self.assertAlmostEqual(c["length"], (3.0 - 1.0) / 1.5, places=2)
        self.assertEqual(c["takes"][1]["len"], 3.0, "it remembers the length it had")
        slow, n = self.tio.add_take(self.doc, self.a1, self.a2, 2, retime=True, duration=3.0)
        c = self.tio.editable(slow)["clips"][0]
        self.assertAlmostEqual(c["length"], 3.0, places=2)
        self.assertAlmostEqual(c["speed"], (3.0 - 1.0) / 3.0, places=2)
        roomy, _ = self.tio.add_take(self.doc, self.a1, self.a2, 2, duration=60.0)
        self.assertEqual(self.tio.editable(roomy)["clips"][0]["length"], 3.0)
        unknown, _ = self.tio.add_take(self.doc, self.a1, self.a2, 2)
        self.assertEqual(self.tio.editable(unknown)["clips"][0]["length"], 3.0)


def _load(tmp, sent):
    fp = types.ModuleType("folder_paths")
    fp.base_path = tmp
    dirs = {"output": os.path.join(tmp, "out"), "temp": os.path.join(tmp, "temp"), "input": os.path.join(tmp, "in")}
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)
    fp.get_output_directory = lambda: dirs["output"]
    fp.get_temp_directory = lambda: dirs["temp"]
    fp.get_input_directory = lambda: dirs["input"]
    fp.get_directory_by_type = lambda t: dirs.get(t)
    app = web.Application()
    srv = types.ModuleType("server")
    srv.PromptServer = type("PromptServer", (), {"instance": types.SimpleNamespace(
        app=app, send_sync=lambda event, data: sent.append((event, data)))})
    saved = {k: sys.modules.get(k) for k in ("folder_paths", "server")}
    sys.modules.update(folder_paths=fp, server=srv)
    name = "imageviewer_takes_routes_under_test"
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


@unittest.skipIf(web is None, "needs aiohttp")
class TakeRoute(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.tio = importlib.import_module(cls.pkg + ".timeline_io")
        cls.outside = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.outside, ignore_errors=True)

    def setUp(self):
        out = self.dirs["output"]
        self.a1 = _touch(out, "shot_03_v001.mp4")
        self.a2 = _touch(out, "shot_03_v002.mp4")
        self.b = _touch(out, "other.mp4")
        edit = {"clips": [{"file": self.a1, "name": "shot_03", "in": 1.0, "length": 3.0, "transition": 0},
                          {"file": self.b, "name": "other", "in": 0.0, "length": 2.0, "transition": 0}]}
        doc = self.tio.rebuild(self.tio.new_doc("cut", 24), edit, "", lambda p: True)
        self.otio = os.path.join(out, "cut.otio").replace("\\", "/")
        with open(self.otio, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        del self.sent[:]

    def _run(self, fn):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    def post(self, body, path="/imageviewer/take"):
        async def fn(c):
            r = await c.post(path, json=body)
            return r.status, await r.json()
        return self._run(fn)

    def body(self, **over):
        b = {"otio": self.otio, "takes": [{"from_file": self.a1, "file": self.a2, "version": 2, "note": "warmer"}], "retime": False}
        b.update(over)
        return b

    def test_a_take_is_written_into_the_timeline_and_the_pages_are_told(self):
        status, ans = self.post(self.body())
        self.assertEqual(status, 200, ans)
        self.assertTrue(ans["ok"] and ans["saved"] and ans["pushed"])
        self.assertEqual(ans["applied"], 1)
        self.assertIsInstance(ans["notes"], list)
        edit = self.tio.read_editable(self.otio)
        self.assertEqual(edit["clips"][0]["file"], self.a2)
        self.assertEqual([(t["version"], t["active"]) for t in edit["clips"][0]["takes"]], [(1, False), (2, True)])
        self.assertFalse(os.path.exists(self.otio + ".tmp"))
        (event, payload), = self.sent
        self.assertEqual(event, "imageviewer.edit.take")
        self.assertEqual(payload["otio"], os.path.abspath(self.otio))
        self.assertTrue(payload["saved"])
        self.assertFalse(payload["retime"])
        take, = payload["takes"]
        self.assertEqual((take["from_file"], take["file"], take["version"], take["note"]), (self.a1, self.a2, 2, "warmer"))
        self.assertRegex(take["created"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")
        status, ans = self.post(self.body(), "/api/imageviewer/take")
        self.assertEqual(status, 200)

    def test_the_version_comes_from_the_name_when_the_request_gives_none(self):
        self.post(self.body(takes=[{"from_file": self.a1, "file": self.a2}]))
        self.assertEqual(self.sent[0][1]["takes"][0]["version"], 2)

    def test_no_clip_uses_the_file_or_no_timeline_there_the_pages_are_still_told_and_nothing_is_saved(self):
        status, ans = self.post(self.body(takes=[{"from_file": self.a2, "file": self.a1, "version": 3}]))
        self.assertEqual((status, ans["saved"], ans["applied"], ans["pushed"]), (200, False, 0, True))
        self.assertTrue(ans["notes"])
        status, ans = self.post(self.body(otio=os.path.join(self.dirs["output"], "nope.otio")))
        self.assertEqual((status, ans["ok"], ans["saved"], ans["pushed"]), (200, True, False, True))
        status, ans = self.post(self.body(otio=""))
        self.assertEqual((status, ans["saved"], ans["pushed"]), (200, False, True))
        self.assertEqual(self.tio.read_editable(self.otio)["clips"][0]["file"], self.a1)

    def test_paths_outside_the_allowed_folders_are_refused(self):
        stray = _touch(self.outside, "stray.mp4")
        other = os.path.join(self.outside, "cut.otio")
        shutil.copy(self.otio, other)
        status, ans = self.post(self.body(otio=other))
        self.assertEqual((status, ans["ok"]), (403, False))
        self.assertFalse(self.sent)
        status, ans = self.post(self.body(takes=[{"from_file": self.a1, "file": stray}]))
        self.assertEqual((status, ans["ok"]), (403, False))
        self.assertFalse(self.sent)
        self.assertEqual(self.tio.read_editable(self.otio)["clips"][0]["file"], self.a1)

    def test_bad_bodies_are_400(self):
        for body in ({}, {"takes": []}, {"takes": "x"}, {"takes": [5]}, {"takes": [{"file": self.a2}]},
                     {"takes": [{"from_file": self.a1, "file": os.path.join(self.dirs["output"], "missing.mp4")}]},
                     self.body(otio=os.path.join(self.dirs["output"], "cut.json")), self.body(otio=5),
                     {"takes": [{"from_file": self.a1, "file": self.a2}] * 51}):
            status, ans = self.post(body)
            self.assertEqual((status, ans["ok"]), (400, False), body)
        async def fn(c):
            r = await c.post("/imageviewer/take", data="not json", headers={"Content-Type": "application/json"})
            return r.status
        self.assertEqual(self._run(fn), 400)
        self.assertFalse(self.sent)

    def _raw(self, path, body, headers):
        async def fn(c):
            r = await c.post(path, data=json.dumps(body), headers=headers)
            return r.status
        return self._run(fn)

    def test_only_comfyuis_own_page_or_no_browser_page_may_write_a_timeline(self):
        # the security audit: a web page of another site must not write into the user's .otio files
        js = {"Content-Type": "application/json"}
        for path, body in (("/imageviewer/take", self.body()),
                           ("/imageviewer/timeline", {"otio": self.otio, "edit": {"clips": []}})):
            for headers in ({"Content-Type": "text/plain"},                       # a no-preflight cross-site POST
                            {"Content-Type": "application/x-www-form-urlencoded"},
                            {**js, "Origin": "https://evil.example"},
                            {**js, "Origin": "null"},
                            {**js, "Host": "evil.example"},                       # DNS rebinding
                            {**js, "Host": "evil.example", "Origin": "http://evil.example"}):
                self.assertEqual(self._raw(path, body, headers), 403, (path, headers))
        self.assertFalse(self.sent)
        self.assertEqual(self.tio.read_editable(self.otio)["clips"][0]["file"], self.a1)

        async def own(c):          # the page itself: an Origin naming the host it was sent to
            host = f"{c.server.host}:{c.server.port}"
            r = await c.post("/imageviewer/take", data=json.dumps(self.body()),
                             headers={**js, "Origin": f"http://{host}"})
            return r.status
        self.assertEqual(self._run(own), 200)

    def test_client_id_is_read_from_the_query_string(self):
        async def fn(c):
            r = await c.post("/imageviewer/take?client_id=tab-7", json=self.body())
            return r.status
        self.assertEqual(self._run(fn), 200)
        self.assertEqual(self.sent[0][1]["client_id"], "tab-7")

    def test_text_from_the_request_is_data_and_capped(self):
        status, ans = self.post(self.body(takes=[{"from_file": self.a1, "file": self.a2, "version": 2,
                                                   "note": "<img src=x onerror=1>" + "n" * 900}]))
        self.assertEqual(status, 200)
        note = self.tio.read_editable(self.otio)["clips"][0]["takes"][1]["note"]
        self.assertEqual(len(note), 200)
        self.assertTrue(note.startswith("<img"))


if __name__ == "__main__":
    unittest.main()
