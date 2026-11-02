"""Titles: clips of the video tracks whose picture is words.

- the .otio: a title is a GeneratorReference clip with its look in metadata.bepic.title, read back the same; the
  texts of an older cut (markers) come in as titles, keep what agentY wrote into them, and old cuts read unchanged;
- the render (PyAV: ComfyUI's interpreter) draws them over what is under them, keyed size included, never as a
  cover, never over sound; a missing font falls back and the render says so;
- the fonts route lists families and hands out a face by its id only.

Run: D:/ai/comfyui/.venv/Scripts/python.exe -m unittest discover -s tests -p "test_edit_titles.py"
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
    import av
    import numpy as np
except ImportError:  # pragma: no cover
    av = None
try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover
    web = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FPS = 24


def _modules():
    name = "bepic_titles_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [ROOT]
        sys.modules[name] = pkg
    tio = importlib.import_module(name + ".timeline_io")
    tr = importlib.import_module(name + ".title_render")
    return tio, tr


def marker(tio, text, start, length, **look):
    return {"OTIO_SCHEMA": "Marker.2", "name": text, "color": "PURPLE", "marked_range": tio._range(start, length, FPS),
            "metadata": {"agentY": {"kind": "text", "text": text, "preset": "title_rise", "params": {"k": 1}},
                         **({"bepic": look} if look else {})}}


class TitleFile(unittest.TestCase):
    def setUp(self):
        self.tio, self.tr = _modules()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.a = os.path.join(self.tmp, "a.mp4").replace("\\", "/")
        open(self.a, "wb").close()

    def doc(self, marks=()):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), {"clips": [{"file": self.a, "in": 0, "length": 4}]},
                               may_use=lambda p: True)
        doc["tracks"]["markers"] = list(marks)
        return doc

    def test_an_old_cuts_texts_come_in_as_titles_on_tracks_of_their_own(self):
        doc = self.doc([marker(self.tio, "First", 0, 3, size=10, x=0.3, color="#ff0000"),
                        marker(self.tio, "Second", 1, 1), marker(self.tio, "Third", 3, 1)])
        doc["tracks"]["metadata"] = {"bepic": {"texts_off": True}}
        e = self.tio.editable(doc)
        self.assertEqual(e["texts"], [])
        self.assertFalse(e["off"]["T"])
        tracks = [t for t in e["tracks"] if any(c.get("title") for c in t["clips"])]
        self.assertEqual([t["id"] for t in tracks], ["V2", "V3"], "two texts overlap: two tracks")
        self.assertTrue(all(t["off"] for t in tracks), "the texts' switch is the tracks' switch")
        first = tracks[0]["clips"][0]
        self.assertEqual((first["title"]["text"], first["title"]["size"], first["title"]["x"], first["title"]["color"]),
                         ("First", 10.0, 0.3, "#ff0000"))
        self.assertEqual((first["at"], first["length"], first["in"], first["file"], first["mark"]), (0.0, 3.0, 0.0, "", 0))
        self.assertEqual(tracks[0]["clips"][1]["title"]["text"], "Third")
        # The same rule as the panel's (textsToTitles) - the JS gives the same tracks for the same texts.

    def test_a_title_is_saved_as_a_generator_clip_and_reads_back_the_same(self):
        doc = self.doc([marker(self.tio, "Hi", 1, 2)])
        e = self.tio.editable(doc)
        title = e["tracks"][0]["clips"][0]
        title["title"] = dict(title["title"], bold=True, align="right", font="Georgia", text="Hi\nthere")
        title["fx"] = {"op": 0.5, "keys": {"tsize": [{"t": 0, "v": 6}, {"t": 1, "v": 12}]}}
        new = self.tio.rebuild(doc, e, may_use=lambda p: True)
        self.assertEqual(new["tracks"]["markers"], [], "the marker became the title")
        item = [c for c in new["tracks"]["children"][1]["children"] if c["OTIO_SCHEMA"] == "Clip.1"][0]
        self.assertEqual(item["media_reference"]["OTIO_SCHEMA"], "GeneratorReference.1")
        self.assertEqual(item["media_reference"]["generator_kind"], "bepic.title")
        self.assertEqual(item["metadata"]["bepic"]["title"]["align"], "right")
        self.assertEqual(item["metadata"]["agentY"]["preset"], "title_rise", "what agentY wrote into the marker stays")
        self.assertEqual(item["metadata"]["agentY"]["text"], "Hi\nthere")
        back = self.tio.editable(new)
        t = back["tracks"][0]["clips"][0]
        self.assertEqual(t["ref"], [1, 1])
        self.assertEqual(t["title"], self.tr.clean_title(title["title"]))
        self.assertEqual((t["at"], t["length"], t["in"], t["file"]), (1.0, 2.0, 0.0, ""))
        self.assertEqual(t["fx"]["keys"]["tsize"], [{"t": 0.0, "v": 6.0}, {"t": 1.0, "v": 12.0}])
        # Saved again by its ref, changed: the look follows.
        t["title"]["italic"] = True
        again = self.tio.editable(self.tio.rebuild(new, back, may_use=lambda p: True))
        self.assertTrue(again["tracks"][0]["clips"][0]["title"]["italic"])
        # A title made in the panel (no ref, no mark).
        back["tracks"][0]["clips"].append({"name": "", "at": 3.5, "in": 0, "length": 0.5, "title": {"text": "New"}})
        made = self.tio.editable(self.tio.rebuild(new, back, may_use=lambda p: True))
        self.assertEqual([c["title"]["text"] for c in made["tracks"][0]["clips"]], ["Hi\nthere", "New"])

    def test_clean_title_holds_the_look_to_the_table(self):
        t = self.tr.clean_title({"size": 99, "align": "x", "color": "#ABCDEF", "bold": 1, "font": ""})
        self.assertEqual((t["size"], t["align"], t["color"], t["bold"], t["font"]), (40.0, "center", "#abcdef", False, "Arial"))
        self.assertEqual(set(t), set(self.tr.TITLE_NUM) | set(self.tr.TITLE_COLORS) | set(self.tr.TITLE_FLAGS)
                         | set(self.tr.TITLE_CHOICES) | {"text", "font"})

    def test_fonts_resolve_by_family_and_style_with_a_fallback(self):
        fams = [{"family": "Arial", "faces": {"regular": {"id": "a"}, "bold": {"id": "b"}}},
                {"family": "Mono", "faces": {"regular": {"id": "m"}}}]
        self.assertEqual(self.tr.resolve_face(fams, "arial", True, False)["face"]["id"], "b")
        got = self.tr.resolve_face(fams, "Mono", True, True)
        self.assertEqual((got["face"]["id"], got["bold"], got["italic"]), ("m", True, True))
        gone = self.tr.resolve_face(fams, "Nope", False, False)
        self.assertEqual((gone["family"], gone["missing"]), ("Arial", True))
        self.assertIn("not on this machine", self.tr.missing_note({"font": "Nope"}, gone))

    def test_a_collection_face_is_handed_out_as_a_font_of_its_own(self):
        faces = [f for fam in self.tr.fonts() for f in fam["faces"].values() if f["path"].lower().endswith(".ttc")]
        if not faces:
            self.skipTest("no font collection on this machine")
        from PIL import ImageFont
        face = faces[-1]
        data = self.tr.face_bytes(face)
        path = os.path.join(self.tmp, "one.ttf")
        with open(path, "wb") as fh:
            fh.write(data)
        want = ImageFont.truetype(face["path"], 20, index=face["index"]).getname()
        self.assertEqual(ImageFont.truetype(path, 20).getname(), want)


@unittest.skipIf(av is None, "needs PyAV and numpy (ComfyUI's interpreter)")
class TitleRender(unittest.TestCase):
    def setUp(self):
        self.tio, self.tr = _modules()
        self.render = importlib.import_module("bepic_titles_under_test.timeline_render")
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.grey = os.path.join(self.tmp, "grey.mp4").replace("\\", "/")
        with av.open(self.grey, "w") as out:
            vs = out.add_stream("mpeg4", rate=FPS)
            vs.width, vs.height, vs.pix_fmt = 320, 180, "yuv420p"
            for i in range(FPS * 2):
                vf = av.VideoFrame.from_ndarray(np.full((180, 320, 3), 100, dtype=np.uint8), format="rgb24")
                vf.pts = i
                for pkt in vs.encode(vf):
                    out.mux(pkt)
            for pkt in vs.encode():
                out.mux(pkt)

    def film(self, titles, name="out.mp4"):
        edit = {"clips": [{"file": self.grey, "in": 0, "length": 2}], "sound": [],
                "tracks": [{"id": "V2", "kind": "video", "name": "V2", "off": False, "clips": titles}]}
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)
        out = os.path.join(self.tmp, name)
        got = self.render.render(doc, out, "mp4", lambda p: True)
        frames = []
        with av.open(out) as src:
            for f in src.decode(src.streams.video[0]):
                frames.append(f.to_ndarray(format="rgb24"))
        return got, frames

    def test_a_title_is_drawn_over_the_shot_where_it_is_and_nowhere_else(self):
        look = {"text": "HELLO", "size": 20, "color": "#ff0000", "sw": 0, "y": 0.5}
        got, frames = self.film([{"at": 0.5, "in": 0, "length": 0.5, "name": "t", "title": look}])
        self.assertEqual(got["texts"], 1)
        self.assertEqual(got["notes"], [])
        before, during, after = frames[6], frames[18], frames[30]
        red = lambda f: int(((f[:, :, 0] > 180) & (f[:, :, 1] < 80)).sum())
        self.assertEqual(red(before), 0)
        self.assertGreater(red(during), 200, "the words are on the shot")
        self.assertEqual(red(after), 0)
        # The shot is still there around the words: not a cover.
        self.assertTrue(abs(int(during[5, 5, 0]) - 100) < 12)
        # As the title renderer draws it, laid on the frame.
        rgba, _ = self.tr.render(look, 320, 180)
        want = rgba[:, :, 3] > 200
        self.assertGreater((during[want][:, 0] > 150).mean(), 0.9)

    def test_keyed_size_grows_and_the_clip_opacity_applies(self):
        look = {"text": "W", "size": 5, "color": "#ffffff", "sw": 0, "y": 0.5}
        keys = {"tsize": [{"t": 0, "v": 5}, {"t": 1.9, "v": 30}]}
        got, frames = self.film([{"at": 0, "in": 0, "length": 2, "name": "t", "title": look, "fx": {"keys": keys}}])
        white = lambda f: int((f.min(axis=2) > 200).sum())
        self.assertLess(white(frames[2]) * 4, white(frames[44]), "bigger later")
        _, faded = self.film([{"at": 0, "in": 0, "length": 2, "name": "t", "title": dict(look, size=30), "fx": {"op": 0.5}}],
                             "faded.mp4")
        self.assertEqual(white(faded[10]), 0, "at half opacity nothing is white")

    def test_a_missing_font_falls_back_and_the_render_says_so(self):
        got, _ = self.film([{"at": 0, "in": 0, "length": 1, "name": "t", "title": {"text": "x", "font": "No Such Font Here"}}])
        self.assertEqual(len(got["notes"]), 1)
        self.assertIn("No Such Font Here", got["notes"][0])


@unittest.skipIf(web is None, "needs aiohttp")
class FontRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.dirname(__file__))
        from test_edit_takes import _load
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, [])

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                r = await client.get(path)
                return r.status, r.headers.get("Content-Type", ""), await r.read()
        return asyncio.run(go())

    def test_the_families_are_listed_without_paths_and_a_face_is_served_by_id_only(self):
        status, _, body = self.get("/bepic/fonts")
        self.assertEqual(status, 200)
        got = json.loads(body)
        self.assertIn("fonts", got)
        if not got["fonts"]:
            self.skipTest("no fonts on this machine")
        self.assertNotIn(":\\\\", body.decode("utf-8"))
        self.assertNotIn("\"path\"", body.decode("utf-8"))
        fam = next((f for f in got["fonts"] if f["family"] == "Arial"), got["fonts"][0])
        face = next(iter(fam["faces"].values()))
        self.assertTrue(face["url"].startswith("/bepic/font_file?id="))
        self.assertGreater(face["asc"], 0)
        status, kind, data = self.get(face["url"])
        self.assertEqual(status, 200)
        self.assertTrue(kind.startswith("font/"))
        self.assertGreater(len(data), 1000)
        self.assertEqual(self.get("/bepic/font_file?id=../../etc/passwd")[0], 404)
        self.assertEqual(self.get("/api/bepic/fonts")[0], 200)


if __name__ == "__main__":
    unittest.main()
