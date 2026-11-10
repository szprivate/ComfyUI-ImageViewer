"""The Mixer's master strip (its fader / pan = the cut's master chain, its M = the master switch):
kept in the .otio, and the render (Export film) obeys it.

    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest discover -s tests -p "test_edit_mixer_master.py"
"""
import json
import math
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from test_edit_audio_fx import FPS, RATE, _mods, av, sound_of, tone_film  # noqa: E402

if av is not None:
    import numpy as np


class InTheFile(unittest.TestCase):
    def test_the_master_chain_and_switch_come_back_and_go_when_taken_off(self):
        get = _mods()
        tio = get("timeline_io")
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        a = os.path.join(tmp, "a.mp4")
        open(a, "wb").close()
        clip = {"file": a, "in": 0, "length": 2, "transition": 0}
        edit = {"clips": [clip], "texts": [], "off": {"master": True},
                "afx": {"A1": [], "master": [{"type": "gain", "p": {"gain": -6}}, {"type": "pan", "p": {"pan": 0.5}}]}}
        doc = json.loads(json.dumps(tio.rebuild(tio.new_doc("t", FPS), edit, may_use=lambda p: True)))
        back = tio.editable(doc)
        self.assertEqual([f["type"] for f in back["afx"]["master"]], ["gain", "pan"])
        self.assertEqual(back["afx"]["master"][0]["p"]["gain"], -6)
        self.assertTrue(back["off"]["master"])
        # An edit without the keys (an older page) leaves them alone.
        keep = tio.editable(json.loads(json.dumps(tio.rebuild(doc, {"clips": [{"ref": 0, "in": 0, "length": 2, "transition": 0}], "texts": []},
                                                              may_use=lambda p: True))))
        self.assertTrue(keep["off"]["master"])
        self.assertEqual(len(keep["afx"]["master"]), 2)
        # Taken off: gone from the file.
        off = {"clips": [{"ref": 0, "in": 0, "length": 2, "transition": 0}], "texts": [], "off": {"master": False}, "afx": {"master": []}}
        doc2 = json.loads(json.dumps(tio.rebuild(doc, off, may_use=lambda p: True)))
        back = tio.editable(doc2)
        self.assertEqual(back["afx"]["master"], [])
        self.assertFalse(back["off"]["master"])
        note = ((doc2.get("tracks") or {}).get("metadata") or {}).get("imageviewer") or {}
        self.assertNotIn("master_afx", note)
        self.assertNotIn("master_off", note)


@unittest.skipIf(av is None, "needs PyAV")
class TheCutRendered(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        get = _mods()
        cls.tio, cls.tr = get("timeline_io"), get("timeline_render")
        cls.tmp = tempfile.mkdtemp()
        cls.a = os.path.join(cls.tmp, "a.mp4").replace("\\", "/")
        cls.s = os.path.join(cls.tmp, "s.mp4").replace("\\", "/")
        tone_film(cls.a, 3.0, 440, 0.25)
        tone_film(cls.s, 3.0, 660, 0.4)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, edit, name):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), {"texts": [], **edit}, may_use=lambda p: True)
        out = os.path.join(self.tmp, name + ".mp4")
        self.tr.render(doc, out, "mp4")
        try:
            return sound_of(out)
        except Exception:  # noqa: BLE001 - a film with no sound stream
            return None

    def base(self):
        return {"clips": [{"file": self.a, "name": "a", "in": 0, "length": 2, "transition": 0}],
                "tracks": [{"id": "A2", "kind": "audio", "name": "A2",
                            "clips": [{"file": self.s, "name": "s", "at": 0, "in": 0, "length": 2}]}]}

    @staticmethod
    def rms(x):
        seg = x[int(0.3 * RATE):int(1.7 * RATE)].astype(np.float64)
        return float(np.sqrt(np.mean(seg ** 2)))

    def test_the_master_fader_turns_the_whole_mix_down(self):
        dry = self.render(self.base(), "m_dry")
        low = self.render({**self.base(), "afx": {"master": [{"type": "gain", "p": {"gain": -12}}]}}, "m_low")
        self.assertAlmostEqual(self.rms(low) / self.rms(dry), 10 ** (-12 / 20), delta=0.02)

    def test_the_master_switched_off_is_a_silent_film(self):
        x = self.render({**self.base(), "off": {"master": True}}, "m_off")
        self.assertTrue(x is None or float(np.abs(x).max()) < 1e-3)


if __name__ == "__main__":
    unittest.main()
