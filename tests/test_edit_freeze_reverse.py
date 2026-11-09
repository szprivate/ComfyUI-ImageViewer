"""Freeze frame and reverse: the file, the render, and the JS / Python arithmetic agreeing.

A reversed clip runs its source backwards from its in point (the moment at the clip's head); a frozen
one holds its in point. Both are silent. The render tests use the counter clip of
tests/test_timeline_retime_loop.py (frame k is grey 8*k). Needs PyAV for the render:
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_edit_freeze_reverse
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from test_timeline_retime_loop import FPS, N, _modules, av, make_counter, read_levels

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def doc_of(tio, clips):
    doc = tio.new_doc("t", FPS)
    return tio.rebuild(doc, {"clips": clips, "texts": []}, may_use=lambda p: True)


class FreezeReverseFileTests(unittest.TestCase):
    def setUp(self):
        self.tio, _tr = _modules()
        self.tmp = tempfile.mkdtemp()
        self.src = os.path.join(self.tmp, "c.mp4")
        open(self.src, "wb").close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def item(self, doc, k=0):
        return doc["tracks"]["children"][0]["children"][k]

    def test_reverse_is_a_negative_linear_time_warp_and_comes_back(self):
        doc = doc_of(self.tio, [{"file": self.src, "name": "c", "in": 2.0, "length": 1.0, "transition": 0,
                                 "speed": 2, "motion": "reverse"}])
        item = self.item(doc)
        warp = [fx for fx in item["effects"] if fx["OTIO_SCHEMA"] == "LinearTimeWarp.1"]
        self.assertEqual(warp[0]["time_scalar"], -2.0)
        self.assertEqual(item["metadata"]["imageviewer"]["motion"], "reverse")
        self.assertEqual(item["source_range"]["start_time"]["value"], 48)     # the moment at its head
        clip = self.tio.editable(json.loads(json.dumps(doc)))["clips"][0]
        self.assertEqual((clip["motion"], clip["speed"], clip["in"], clip["length"]), ("reverse", 2.0, 2.0, 1.0))

    def test_freeze_is_a_freeze_frame_and_drops_speed_and_loop(self):
        doc = doc_of(self.tio, [{"file": self.src, "name": "c", "in": 1.0, "length": 2.0, "transition": 0,
                                 "speed": 3, "loop": "loop", "span": 0.5, "motion": "freeze"}])
        item = self.item(doc)
        self.assertEqual([fx["OTIO_SCHEMA"] for fx in item["effects"]], ["FreezeFrame.1"])
        note = item["metadata"]["imageviewer"]
        self.assertEqual(note.get("motion"), "freeze")
        self.assertNotIn("speed", note)
        self.assertNotIn("loop", note)
        clip = self.tio.editable(doc)["clips"][0]
        self.assertEqual((clip["motion"], clip["speed"], clip["loop"]), ("freeze", 1.0, ""))

    def test_taken_off_again_the_effects_go(self):
        doc = doc_of(self.tio, [{"file": self.src, "name": "c", "in": 1.0, "length": 2.0, "transition": 0,
                                 "motion": "reverse"}])
        plain = self.tio.rebuild(doc, {"clips": [{"ref": 0, "in": 0.0, "length": 2.0, "transition": 0,
                                                  "speed": 1, "loop": "", "span": 0, "motion": ""}], "texts": []},
                                 may_use=lambda p: True)
        item = self.item(plain)
        self.assertFalse(item["effects"])
        self.assertNotIn("motion", item["metadata"]["imageviewer"])
        self.assertEqual(self.tio.editable(plain)["clips"][0]["motion"], "")

    def test_another_programs_effects_are_read(self):
        doc = doc_of(self.tio, [{"file": self.src, "name": "c", "in": 1.0, "length": 2.0, "transition": 0}])
        item = self.item(doc)
        item["effects"] = [{"OTIO_SCHEMA": "LinearTimeWarp.1", "name": "", "effect_name": "LinearTimeWarp",
                            "metadata": {}, "time_scalar": -1.0}]
        self.assertEqual(self.tio.editable(doc)["clips"][0]["motion"], "reverse")
        item["effects"] = [{"OTIO_SCHEMA": "FreezeFrame.1", "name": "", "effect_name": "FreezeFrame",
                            "metadata": {}, "time_scalar": 0.0}]
        self.assertEqual(self.tio.editable(doc)["clips"][0]["motion"], "freeze")

    def test_a_dissolve_into_a_reversed_clip_keeps_its_head(self):
        b = os.path.join(self.tmp, "b.mp4")
        open(b, "wb").close()
        doc = doc_of(self.tio, [{"file": self.src, "name": "a", "in": 0, "length": 3, "transition": 0},
                                {"file": b, "name": "b", "in": 5, "length": 3, "transition": 1, "motion": "reverse"}])
        item = self.item(doc, 2)                          # a, the dissolve, b
        self.assertEqual(item["source_range"]["start_time"]["value"], round((5 - 0.5) * FPS))
        got = self.tio.editable(doc)["clips"][1]
        self.assertEqual((got["in"], got["length"], got["transition"], got["motion"]), (5.0, 3.0, 1.0, "reverse"))

    def test_source_moment_agrees_with_the_panels_srcLocal(self):
        clips = [{"file": "x.mp4", "in": 3.0, "length": 2.0, "motion": "reverse"},
                 {"file": "x.mp4", "in": 3.0, "length": 2.0, "motion": "reverse", "speed": 0.5},
                 {"file": "x.mp4", "in": 1.5, "length": 2.0, "motion": "freeze"},
                 {"file": "x.png", "in": 0.0, "length": 2.0, "motion": "reverse"},
                 {"file": "x.mp4", "in": 0.5, "length": 9.0, "motion": "reverse"}]
        us = [0, 0.3, 1.0, 1.99, 4.0]
        js = ("import * as D from './js/imageViewer_editTimelineData.js';"
              f"const C = {json.dumps(clips)}, U = {json.dumps(us)};"
              "console.log(JSON.stringify(C.map((c) => U.map((u) => D.srcLocal(c, u)))));")
        out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
        want = json.loads(out.stdout)
        got = [[round(self.tio.source_moment(c, u), 4) for u in us] for c in clips]
        self.assertEqual(got, want)


@unittest.skipIf(av is None, "needs PyAV")
class FreezeReverseRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.src = os.path.join(cls.tmp, "counter.mp4")
        make_counter(cls.src)
        cls.tio, cls.tr = _modules()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, clip, length, name):
        doc = doc_of(self.tio, [{"file": self.src, "name": "c", "transition": 0, "length": length, **clip}])
        out = os.path.join(self.tmp, name + ".mp4")
        got = self.tr.render(doc, out, "mp4")
        return got, read_levels(out)

    def test_reversed_plays_the_frames_last_first(self):
        got, levels = self.render({"in": N / FPS, "motion": "reverse"}, N / FPS, "rev")
        self.assertEqual(got["frames"], N)
        self.assertEqual(levels, list(range(N - 1, -1, -1)))

    def test_reversed_at_twice_the_speed(self):
        _got, levels = self.render({"in": N / FPS, "motion": "reverse", "speed": 2}, N / 2 / FPS, "rev2")
        self.assertEqual(levels, list(range(N - 1, 0, -2)))   # moments 23/24, 21/24 ...: the frame on screen there

    def test_freeze_holds_one_frame(self):
        got, levels = self.render({"in": 7.5 / FPS, "motion": "freeze"}, 10 / FPS, "freeze")
        self.assertEqual(got["frames"], 10)
        self.assertEqual(levels, [7] * 10)

    def test_frozen_and_reversed_clips_are_silent(self):
        for motion in ("freeze", "reverse"):
            self.assertIsNone(self.tr.clip_sound({"file": self.src, "in": 0.5, "motion": motion}, 0.5))


if __name__ == "__main__":
    unittest.main()
