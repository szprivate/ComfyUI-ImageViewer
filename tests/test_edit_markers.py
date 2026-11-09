"""Markers (the Edit panel's M): how timeline_io keeps timeline and clip markers in the .otio.

    python -m unittest tests.test_edit_markers
"""
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FPS = 24


def _tio():
    name = "imageviewer_markers_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules[name] = pkg
    return importlib.import_module(name + ".timeline_io")


class MarkersInTheFile(unittest.TestCase):
    def setUp(self):
        self.tio = _tio()
        self.tmp = tempfile.mkdtemp()
        self.a = os.path.join(self.tmp, "a.mp4")
        open(self.a, "wb").close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self, **extra):
        return {"clips": [{"file": self.a, "name": "a", "in": 1, "length": 4, "transition": 0, "speed": 2,
                           "markers": [{"src": 3, "len": 0.5, "name": "flash", "note": "too bright", "color": "red"}]}],
                "texts": [], "markers": [{"t": 2.5, "len": 0, "name": "music in", "note": "", "color": "green"},
                                         {"t": 0.5, "len": 1, "name": "", "note": "", "color": "nope"}], **extra}

    def test_timeline_and_clip_markers_go_into_the_file_and_come_back(self):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), self.edit(), may_use=lambda p: True)
        v1 = doc["tracks"]["children"][0]
        self.assertEqual([m["name"] for m in v1["markers"]], ["music in", ""])
        self.assertEqual(v1["markers"][0]["marked_range"]["start_time"]["value"], 60)
        self.assertEqual(v1["markers"][0]["color"], "GREEN")
        self.assertEqual(v1["markers"][1]["color"], "BLUE", "a colour that is not one is blue")
        self.assertEqual(doc["tracks"].get("markers") or [], [], "not on the stack: those are agentY's texts")
        clip = v1["children"][0]
        m = clip["markers"][0]
        self.assertEqual((m["name"], m["comment"], m["color"]), ("flash", "too bright", "RED"))
        self.assertEqual(m["marked_range"]["start_time"]["value"], 72, "in the clip's source time")
        self.assertEqual(m["marked_range"]["duration"]["value"], 24, "0.5 s of the clip at 2x is a second of source")
        back = self.tio.editable(json.loads(json.dumps(doc)))
        self.assertEqual([(x["t"], x["len"], x["name"], x["color"]) for x in back["markers"]],
                         [(0.5, 1.0, "", "blue"), (2.5, 0.0, "music in", "green")])
        cm = back["clips"][0]["markers"]
        self.assertEqual([(x["src"], x["len"], x["name"], x["note"], x["color"]) for x in cm], [(3.0, 0.5, "flash", "too bright", "red")])
        self.assertEqual(back["texts"], [], "markers are not read as texts / titles")
        self.assertEqual(back["tracks"], [])

    def test_what_another_program_wrote_into_a_marker_survives_and_a_marker_taken_away_goes(self):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), self.edit(), may_use=lambda p: True)
        v1 = doc["tracks"]["children"][0]
        v1["markers"][0]["metadata"]["resolve"] = {"keep": 1}
        back = self.tio.editable(json.loads(json.dumps(doc)))
        kept = [m for m in back["markers"] if m["name"] == "music in"]
        kept[0]["name"] = "music"
        clip = {**back["clips"][0], "markers": []}
        again = self.tio.rebuild(doc, {"clips": [clip], "texts": [], "markers": kept}, may_use=lambda p: True)
        v1 = again["tracks"]["children"][0]
        self.assertEqual([m["name"] for m in v1["markers"]], ["music"])
        self.assertEqual(v1["markers"][0]["metadata"]["resolve"], {"keep": 1})
        self.assertEqual(v1["children"][0]["markers"], [])
        # An edit that says nothing of markers (an older page, agentY) leaves them alone.
        same = self.tio.rebuild(again, {"clips": [{"ref": 0, "in": 1, "length": 4, "transition": 0}], "texts": []}, may_use=lambda p: True)
        self.assertEqual([m["name"] for m in same["tracks"]["children"][0]["markers"]], ["music"])

    def test_markers_written_by_another_program_are_read(self):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), {"clips": [{"file": self.a, "name": "a", "in": 0, "length": 4, "transition": 0}], "texts": []},
                               may_use=lambda p: True)
        v1 = doc["tracks"]["children"][0]
        v1["markers"] = [{"OTIO_SCHEMA": "Marker.2", "name": "from resolve", "color": "FUCHSIA", "comment": "hi",
                          "marked_range": {"OTIO_SCHEMA": "TimeRange.1", "start_time": {"OTIO_SCHEMA": "RationalTime.1", "rate": 24, "value": 12},
                                           "duration": {"OTIO_SCHEMA": "RationalTime.1", "rate": 24, "value": 0}}, "metadata": {}}]
        back = self.tio.editable(json.loads(json.dumps(doc)))
        self.assertEqual(back["markers"], [{"t": 0.5, "len": 0.0, "name": "from resolve", "note": "hi", "color": "magenta", "ref": 0}])


if __name__ == "__main__":
    unittest.main()
