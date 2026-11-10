"""agentY's further cut changes (timeline_ops.py through timeline_io.apply_ops / change): insert and
overwrite on V1, markers, speed / reverse / freeze, dissolves and their looks, the Mixer's faders.

Each is saved the way the panel saves and must read back from the .otio as it was answered.
Run: python -m unittest tests.test_edit_cut_ops
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from test_edit_takes import _tio, _touch  # noqa: E402


class CutOps(unittest.TestCase):
    def setUp(self):
        self.tio = _tio()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.s1 = _touch(self.tmp, "shot_01.mp4")
        self.s2 = _touch(self.tmp, "shot_02.mp4")
        self.s3 = _touch(self.tmp, "shot_03.mp4")
        self.vo = _touch(self.tmp, "vo.mp3")
        self.may = lambda p: os.path.abspath(p).startswith(os.path.abspath(self.tmp))
        edit = {"clips": [{"file": self.s1, "name": "shot_01", "in": 1.0, "length": 4.0, "transition": 0},
                          {"file": self.s2, "name": "shot_02", "in": 0.0, "length": 6.0, "transition": 0}]}
        doc = self.tio.rebuild(self.tio.new_doc("cut", 24), edit, "", self.may)
        self.otio = os.path.join(self.tmp, "cut.otio")
        with open(self.otio, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)

    def change(self, *ops, durations=None):
        edit, said = self.tio.change(self.otio, list(ops), "", self.may, durations)
        self.assertEqual(self.tio.read_editable(self.otio), edit, "what is answered is what the file holds")
        return edit, said

    def v1(self, edit):
        return [(c["name"], c["in"], c["length"]) for c in edit["clips"]]

    # ── insert / overwrite ──────────────────────────────────────────────────

    def test_insert_inside_a_shot_cuts_it_in_two_and_moves_the_rest_on(self):
        self.change({"op": "add", "file": self.vo, "at": 7.0, "length": 2.0})       # A2, after the playhead
        edit, said = self.change({"op": "insert", "file": self.s3, "at": 2.0, "in": 3.0, "length": 1.5})
        self.assertEqual(self.v1(edit), [("shot_01", 1.0, 2.0), ("shot_03", 3.0, 1.5), ("shot_01", 3.0, 2.0),
                                         ("shot_02", 0.0, 6.0)])
        self.assertEqual(self.tio.v1_times(edit), [0.0, 2.0, 3.5, 5.5])
        a2, = [t for t in edit["tracks"] if t["id"] == "A2"]
        self.assertEqual(a2["clips"][0]["at"], 8.5, "a placed clip after the playhead moves on with the cut")
        self.assertIn("inserted shot_03", said[0])

    def test_insert_at_a_cut_and_past_the_end(self):
        edit, _ = self.change({"op": "insert", "file": self.s3, "at": 4.0, "length": 1.0},
                              {"op": "insert", "file": self.s3, "at": 13.0, "length": 1.0, "name": "tail"})
        self.assertEqual([c["name"] for c in edit["clips"]], ["shot_01", "shot_03", "shot_02", "tail"])
        self.assertEqual(edit["clips"][3].get("gap"), 2.0, "past the end: empty time before it")

    def test_insert_refuses_sound_and_other_tracks(self):
        with self.assertRaisesRegex(ValueError, "is sound"):
            self.change({"op": "insert", "file": self.vo, "at": 1, "length": 1})
        with self.assertRaisesRegex(ValueError, "with 'add'"):
            self.change({"op": "insert", "file": self.s3, "at": 1, "length": 1, "track": "V2"})

    def test_overwrite_lays_a_clip_over_what_is_there_and_nothing_moves(self):
        edit, _ = self.change({"op": "overwrite", "file": self.s3, "at": 3.0, "in": 0.5, "length": 2.0})
        self.assertEqual(self.v1(edit), [("shot_01", 1.0, 3.0), ("shot_03", 0.5, 2.0), ("shot_02", 1.0, 5.0)])
        self.assertEqual(self.tio.v1_times(edit), [0.0, 3.0, 5.0])

    def test_overwrite_inside_one_shot_keeps_its_head_and_tail(self):
        edit, _ = self.change({"op": "overwrite", "file": self.s3, "at": 6.0, "length": 1.0})
        self.assertEqual(self.v1(edit), [("shot_01", 1.0, 4.0), ("shot_02", 0.0, 2.0), ("shot_03", 0.0, 1.0),
                                         ("shot_02", 3.0, 3.0)])

    # ── markers ────────────────────────────────────────────────────────────

    def test_markers_are_added_changed_and_removed_in_time_order(self):
        edit, _ = self.change({"op": "add_marker", "at": 5.0, "name": "hand glitch", "note": "fix the fingers",
                               "color": "red"},
                              {"op": "add_marker", "at": 1.0, "length": 0.5})
        self.assertEqual([(m["t"], m["name"], m["color"]) for m in edit["markers"]],
                         [(1.0, "", "blue"), (5.0, "hand glitch", "red")])
        self.assertEqual(edit["markers"][1]["note"], "fix the fingers")
        edit, _ = self.change({"op": "set_marker", "marker": 1, "at": 7.0, "color": "green"})
        self.assertEqual([m["t"] for m in edit["markers"]], [5.0, 7.0])
        edit, said = self.change({"op": "remove_marker", "marker": 1})
        self.assertEqual([m["t"] for m in edit["markers"]], [7.0])
        with self.assertRaisesRegex(ValueError, "no marker 4"):
            self.change({"op": "remove_marker", "marker": 4})
        with self.assertRaisesRegex(ValueError, "'color'"):
            self.change({"op": "add_marker", "at": 1, "color": "beige"})

    # ── speed, motion, dissolves ───────────────────────────────────────────

    def test_speed_keeps_the_source_and_the_length_follows(self):
        edit, said = self.change({"op": "set", "track": "V1", "clip": 2, "speed": 2.0})
        self.assertEqual((edit["clips"][1]["speed"], edit["clips"][1]["length"]), (2.0, 3.0))
        self.assertIn("speed 2.0", said[0])

    def test_reverse_and_freeze_and_back(self):
        edit, _ = self.change({"op": "set", "track": "V1", "clip": 1, "motion": "reverse"})
        c = edit["clips"][0]
        self.assertEqual((c["motion"], c["in"]), ("reverse", 5.0), "the same stretch, its last moment first")
        edit, _ = self.change({"op": "set", "track": "V1", "clip": 1, "motion": "none"})
        self.assertEqual((edit["clips"][0]["motion"], edit["clips"][0]["in"]), ("", 1.0))
        edit, _ = self.change({"op": "set", "track": "V1", "clip": 2, "motion": "freeze", "hold_at": 2.5})
        self.assertEqual((edit["clips"][1]["motion"], edit["clips"][1]["in"]), ("freeze", 2.5))

    def test_a_dissolve_and_its_look(self):
        edit, said = self.change({"op": "set", "track": "V1", "clip": 2, "transition": 1.0,
                                  "transition_look": {"type": "dip", "color": "#FFFFFF"}})
        self.assertEqual(edit["clips"][1]["transition"], 1.0)
        self.assertEqual(edit["clips"][1]["tfx"], {"type": "dip", "color": "#ffffff"})
        edit, _ = self.change({"op": "set", "track": "V1", "clip": 2, "transition_look": "dissolve"})
        self.assertNotIn("tfx", edit["clips"][1])
        with self.assertRaisesRegex(ValueError, "between two clips of V1"):
            self.change({"op": "set", "track": "V1", "clip": 1, "transition": 1.0})
        with self.assertRaisesRegex(ValueError, "longer than the shots"):
            self.change({"op": "set", "track": "V1", "clip": 2, "transition": 5.0})

    # ── the Mixer ──────────────────────────────────────────────────────────

    def test_the_masters_fader_and_mute_and_a_tracks_pan(self):
        self.change({"op": "add", "file": self.vo, "at": 1.0, "length": 2.0})
        edit, said = self.change({"op": "mix", "track": "master", "gain_db": -6},
                                 {"op": "mix", "track": "A2", "pan": -0.5, "gain_db": 3})
        gain, = [fx for fx in edit["afx"]["master"] if fx["type"] == "gain"]
        self.assertEqual(gain["p"]["gain"], -6)
        a2, = [t for t in edit["tracks"] if t["id"] == "A2"]
        self.assertEqual({fx["type"]: fx["p"].get(fx["type"]) for fx in a2["afx"]}, {"pan": -0.5, "gain": 3})
        edit, _ = self.change({"op": "mix", "track": "master", "gain_db": 0, "mute": True})
        self.assertFalse([fx for fx in edit["afx"]["master"] if fx["type"] == "gain"], "0 dB takes the fader off")
        self.assertTrue(edit["off"]["master"])
        with self.assertRaisesRegex(ValueError, "sound track"):
            self.change({"op": "mix", "track": "V1", "gain_db": -3})


if __name__ == "__main__":
    unittest.main()
