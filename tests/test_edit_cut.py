"""A cut changed by agentY: timeline_io.apply_ops / change, and POST /bepic/cut.

The ops work on the panel's form of the cut and are saved the way the panel saves, so a voice-over
added on A2 at 8 s reads back from the .otio there - and the open Edit panels are told with
`bepic.edit.changed` (the browser half: test_edit_cut_browser.py).

viewer_api in a private aiohttp app, ComfyUI's folder_paths and server stubbed (as in test_edit_takes).
Run: python -m unittest tests.test_edit_cut
"""
import asyncio
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover
    web = None

sys.path.insert(0, os.path.dirname(__file__))
from test_edit_takes import _load, _tio, _touch  # noqa: E402


class ApplyOps(unittest.TestCase):
    def setUp(self):
        self.tio = _tio()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.s1 = _touch(self.tmp, "shot_01.mp4")
        self.s2 = _touch(self.tmp, "shot_02.mp4")
        self.vo = _touch(self.tmp, "vo.mp3")
        self.bed = _touch(self.tmp, "music.wav")
        self.may = lambda p: os.path.abspath(p).startswith(os.path.abspath(self.tmp))
        edit = {"clips": [{"file": self.s1, "name": "shot_01", "in": 1.0, "length": 4.0, "transition": 0},
                          {"file": self.s2, "name": "shot_02", "in": 0.0, "length": 6.0, "transition": 0}]}
        doc = self.tio.rebuild(self.tio.new_doc("cut", 24), edit, "", self.may)
        # A bed on A1, laid under the whole film, as agentY's edit stage writes one.
        doc["tracks"]["children"].append({"OTIO_SCHEMA": "Track.1", "name": "A1", "kind": "Audio", "metadata": {},
                                          "source_range": None, "effects": [], "markers": [], "children": [
                                              {"OTIO_SCHEMA": "Clip.1", "name": "music", "metadata": {}, "effects": [],
                                               "markers": [], "source_range": self.tio._range(0, 10, 24),
                                               "media_reference": {"OTIO_SCHEMA": "ExternalReference.1",
                                                                   "target_url": self.tio._url(self.bed)}}]})
        self.otio = os.path.join(self.tmp, "cut.otio")
        with open(self.otio, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)

    def test_a_voice_over_goes_on_A2_at_its_time_and_reads_back_from_the_file(self):
        edit, said = self.tio.change(self.otio, [{"op": "add", "file": self.vo, "at": 2.5, "length": 6.0, "volume": 1.2}],
                                     "", self.may)
        a2, = [t for t in edit["tracks"] if t["id"] == "A2"]
        self.assertEqual(a2["kind"], "audio")
        clip, = a2["clips"]
        self.assertEqual((clip["file"], clip["at"], clip["in"], clip["length"], clip["volume"]),
                         (self.vo, 2.5, 0.0, 6.0, 1.2))
        self.assertIn("A2 at 2.5s", said[0])
        again = self.tio.read_editable(self.otio)
        self.assertEqual(again, edit, "what the route answers is what the file holds")
        self.assertEqual([c["file"] for c in again["clips"]], [self.s1, self.s2], "V1 is untouched")
        self.assertEqual([s["file"] for s in again["sound"]], [self.bed], "the bed on A1 is kept")
        # In the OTIO itself: a Gap of 2.5 s, then the clip, on a track named A2 after A1.
        doc = self.tio._load(self.otio)
        names = [t["name"] for t in doc["tracks"]["children"]]
        self.assertEqual(names, ["V1", "A1", "A2"])
        kids = doc["tracks"]["children"][2]["children"]
        self.assertEqual([k["OTIO_SCHEMA"] for k in kids], ["Gap.1", "Clip.1"])
        self.assertEqual(kids[0]["source_range"]["duration"]["value"], 60.0)
        self.assertEqual(kids[1]["metadata"]["agentY"]["volume"], 1.2)

    def test_the_length_defaults_to_the_rest_of_the_file_and_an_unknown_one_is_asked_for(self):
        edit, _ = self.tio.change(self.otio, [{"op": "add", "file": self.vo, "at": 1, "in": 0.5}], "", self.may,
                                  {self.vo: 8.0})
        self.assertEqual(edit["tracks"][0]["clips"][0]["length"], 7.5)
        with self.assertRaisesRegex(ValueError, "give 'length'"):
            self.tio.change(self.otio, [{"op": "add", "file": self.vo, "at": 1}], "", self.may)

    def test_an_empty_track_picks_one_with_room_and_a_named_one_that_is_taken_is_refused(self):
        ops = [{"op": "add", "file": self.vo, "at": 0, "length": 4},
               {"op": "add", "file": self.vo, "at": 5, "length": 2},          # room on A2 after the first
               {"op": "add", "file": self.vo, "at": 1, "length": 2}]          # A2 is taken there: A3
        edit, _ = self.tio.apply_ops(self.tio.read_editable(self.otio), ops)
        self.assertEqual([(t["id"], [c["at"] for c in t["clips"]]) for t in edit["tracks"]],
                         [("A2", [0.0, 5.0]), ("A3", [1.0])])
        with self.assertRaisesRegex(ValueError, "A2 has vo"):
            self.tio.apply_ops(edit, [{"op": "add", "file": self.vo, "track": "A2", "at": 3, "length": 1}])
        got, _ = self.tio.apply_ops(edit, [{"op": "add", "file": self.vo, "track": "A5", "at": 3, "length": 1}])
        self.assertEqual([t["id"] for t in got["tracks"]], ["A2", "A3", "A4", "A5"])
        got, _ = self.tio.apply_ops(edit, [{"op": "add", "file": self.s1, "at": 3, "length": 1}])
        self.assertEqual([t["id"] for t in got["tracks"]], ["V2", "A2", "A3"], "a picture goes on V2, above the cut")

    def test_V1_and_A1_take_no_placed_clip_and_kinds_must_match(self):
        e = self.tio.read_editable(self.otio)
        for track in ("V1", "A1"):
            with self.assertRaisesRegex(ValueError, "takes no clip placed"):
                self.tio.apply_ops(e, [{"op": "add", "file": self.vo, "track": track, "at": 0, "length": 1}])
        with self.assertRaisesRegex(ValueError, "is sound"):
            self.tio.apply_ops(e, [{"op": "add", "file": self.vo, "track": "V2", "at": 0, "length": 1}])
        with self.assertRaisesRegex(ValueError, "not a track name"):
            self.tio.apply_ops(e, [{"op": "add", "file": self.vo, "track": "B2", "at": 0, "length": 1}])

    def test_set_trims_and_moves_remove_takes_out_and_one_bad_op_does_nothing(self):
        e, _ = self.tio.change(self.otio, [{"op": "add", "file": self.vo, "at": 2, "length": 6}], "", self.may)
        e, said = self.tio.change(self.otio, [{"op": "set", "track": "A2", "clip": 1, "at": 3.0, "length": 4.0, "volume": 0.8},
                                              {"op": "set", "track": "V1", "clip": 1, "in": 2.0, "length": 3.0}], "", self.may)
        c = e["tracks"][0]["clips"][0]
        self.assertEqual((c["at"], c["length"], c["volume"]), (3.0, 4.0, 0.8))
        self.assertEqual((e["clips"][0]["in"], e["clips"][0]["length"]), (2.0, 3.0))
        self.assertEqual(self.tio.v1_times(e), [0.0, 3.0], "V1 ripples")
        self.assertEqual(len(said), 2)
        before = self.tio.read_editable(self.otio)
        with self.assertRaisesRegex(ValueError, "change 2"):
            self.tio.change(self.otio, [{"op": "remove", "track": "A2", "clip": 1},
                                        {"op": "remove", "track": "A2", "clip": 9}], "", self.may)
        self.assertEqual(self.tio.read_editable(self.otio), before, "nothing was written")
        e, _ = self.tio.change(self.otio, [{"op": "remove", "track": "V1", "clip": 1},
                                           {"op": "remove", "track": "A1", "clip": 1}], "", self.may)
        self.assertEqual([x["file"] for x in e["clips"]], [self.s2])
        self.assertEqual(e["sound"], [])
        with self.assertRaisesRegex(ValueError, "at least one clip"):
            self.tio.apply_ops(e, [{"op": "remove", "track": "V1", "clip": 1}])
        with self.assertRaisesRegex(ValueError, "'gap' is for V1|begins where"):
            self.tio.apply_ops(e, [{"op": "set", "track": "V1", "clip": 1, "at": 2}])

    def test_bad_ops(self):
        e = self.tio.read_editable(self.otio)
        for ops, msg in (([], "list of 1"), ([1], "not an object"), ([{"op": "zap"}], "add, set or remove"),
                         ([{"op": "set", "track": "V1", "clip": "x"}], "clip's number"),
                         ([{"op": "set", "track": "V1", "clip": 1}], "nothing to set"),
                         ([{"op": "add", "file": self.vo, "at": -1, "length": 1}], "out of range"),
                         ([{"op": "add"}] * 51, "at most")):
            with self.assertRaisesRegex(ValueError, msg):
                self.tio.apply_ops(e, ops)


@unittest.skipIf(web is None, "needs aiohttp")
class CutRoute(unittest.TestCase):
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
        self.s1 = _touch(out, "shot_01.mp4")
        self.vo = _touch(out, "vo.mp3")
        doc = self.tio.rebuild(self.tio.new_doc("cut", 24),
                               {"clips": [{"file": self.s1, "name": "shot_01", "in": 0, "length": 10, "transition": 0}]},
                               "", lambda p: True)
        self.otio = os.path.join(out, "cut.otio").replace("\\", "/")
        with open(self.otio, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        del self.sent[:]

    def post(self, body, path="/bepic/cut", headers=None):
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                r = await client.post(path, json=body, headers=headers or {})
                return r.status, await r.json()
        return asyncio.run(go())

    def test_no_ops_reads_the_cut_and_writes_nothing(self):
        mtime = os.path.getmtime(self.otio)
        status, ans = self.post({"otio": self.otio})
        self.assertEqual(status, 200, ans)
        self.assertTrue(ans["ok"])
        self.assertFalse(ans["saved"])
        self.assertEqual(ans["edit"]["clips"][0]["file"], self.s1)
        self.assertEqual(ans["length"], 10.0)
        self.assertEqual(self.sent, [])
        self.assertEqual(os.path.getmtime(self.otio), mtime)

    def test_a_vo_added_at_a_time_is_saved_and_the_pages_are_told(self):
        status, ans = self.post({"otio": self.otio, "ops": [{"op": "add", "file": self.vo, "at": 4, "length": 5}]},
                                "/api/bepic/cut?client_id=tab1")
        self.assertEqual(status, 200, ans)
        self.assertTrue(ans["ok"] and ans["saved"] and ans["pushed"])
        clip = ans["edit"]["tracks"][0]["clips"][0]
        self.assertEqual((ans["edit"]["tracks"][0]["id"], clip["at"], clip["length"]), ("A2", 4.0, 5.0))
        self.assertEqual(self.tio.read_editable(self.otio), ans["edit"])
        (event, payload), = self.sent
        self.assertEqual(event, "bepic.edit.changed")
        self.assertEqual((payload["otio"], payload["client_id"], payload["file"]),
                         (os.path.abspath(self.otio), "tab1", "cut.otio"))
        self.assertEqual(payload["edit"], ans["edit"])
        self.assertFalse(os.path.exists(self.otio + ".tmp"))

    def test_refusals(self):
        stray = _touch(self.outside, "stray.mp3")
        other = os.path.join(self.outside, "cut.otio")
        shutil.copy(self.otio, other)
        cases = [({"otio": other}, 403), ({"otio": self.otio, "ops": [{"op": "add", "file": stray, "at": 0}]}, 403),
                 ({"otio": ""}, 400), ({"otio": self.otio.replace(".otio", ".mp4")}, 400),
                 ({"otio": self.otio, "ops": "x"}, 400),
                 ({"otio": self.otio, "ops": [{"op": "add", "file": self.vo.replace("vo.mp3", "gone.mp3"), "at": 0}]}, 400),
                 ({"otio": os.path.join(self.dirs["output"], "nope.otio")}, 404),
                 ({"otio": self.otio, "ops": [{"op": "add", "file": self.vo, "track": "V1", "at": 0, "length": 1}]}, 422)]
        for body, want in cases:
            status, ans = self.post(body)
            self.assertEqual(status, want, (body, ans))
            self.assertFalse(ans["ok"])
        self.assertEqual(self.sent, [])
        status, _ = self.post({"otio": self.otio}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
