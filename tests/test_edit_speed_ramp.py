"""Speed ramps: the file, the render, and the JS / Python arithmetic agreeing (rampAdvance / ramp_advance, srcLocal / source_moment).

A ramped clip's speed is keyed ("spd" in fx.keys, clip time); what it shows at u seconds is its in point plus
the integral of that speed. The render test uses the counter clip of tests/test_timeline_retime_loop.py (frame k
is grey 8*k). Needs PyAV for the render:
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_edit_speed_ramp
"""
import json
import math
import os
import shutil
import subprocess
import tempfile
import unittest

from test_timeline_retime_loop import FPS, _modules, av, make_counter, read_levels

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RAMP = [{"t": 0.25, "v": 0.5, "i": "inout"}, {"t": 0.75, "v": 1.9}]


class SpeedRampFileTests(unittest.TestCase):
    def test_the_ramp_is_kept_in_the_file(self):
        tio, _tr = _modules()
        tmp = tempfile.mkdtemp()
        try:
            src = os.path.join(tmp, "c.mp4")
            open(src, "wb").close()
            doc = tio.rebuild(tio.new_doc("t", FPS), {"clips": [{"file": src, "name": "c", "in": 0.5, "length": 2, "transition": 0,
                                                                  "fx": {"keys": {"spd": RAMP}}}], "texts": []}, may_use=lambda p: True)
            clip = tio.editable(json.loads(json.dumps(doc)))["clips"][0]
            self.assertEqual(clip["fx"]["keys"]["spd"], RAMP)
            self.assertEqual(clip["loop"], "")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_source_moment_agrees_with_the_panels_srcLocal(self):
        tio, _tr = _modules()
        clips = [{"file": "x.mp4", "in": 1.0, "length": 2.0, "fx": {"keys": {"spd": [{"t": 0.5, "v": v, "i": i}, {"t": 1.5, "v": 3.0}]}}}
                 for v in (0.25, 1.0) for i in ("linear", "in", "out", "inout", "hold")]
        clips.append({"file": "x.png", "in": 0.0, "length": 2.0, "fx": {"keys": {"spd": RAMP}}})
        clips.append({"file": "x.mp4", "in": 2.0, "length": 2.0, "motion": "reverse", "fx": {"keys": {"spd": RAMP}}})
        us = [0, 0.3, 0.5, 0.9, 1.5, 1.99]
        js = ("import * as D from './js/imageViewer_editTimelineData.js';"
              f"const C = {json.dumps(clips)}, U = {json.dumps(us)};"
              "console.log(JSON.stringify(C.map((c) => U.map((u) => D.srcLocal(c, u)))));")
        out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
        want = json.loads(out.stdout)
        got = [[round(tio.source_moment(c, u), 4) for u in us] for c in clips]
        self.assertEqual(got, want)


@unittest.skipIf(av is None, "needs PyAV")
class SpeedRampRenderTests(unittest.TestCase):
    def test_a_ramp_shows_the_source_frame_of_each_moment(self):
        tio, tr = _modules()
        tmp = tempfile.mkdtemp()
        try:
            src = os.path.join(tmp, "counter.mp4")
            make_counter(src, frames=30)
            clip = {"file": src, "name": "c", "in": 0, "length": 1.0, "transition": 0, "fx": {"keys": {"spd": RAMP}}}
            doc = tio.rebuild(tio.new_doc("t", FPS), {"clips": [clip], "texts": []}, may_use=lambda p: True)
            out = os.path.join(tmp, "ramp.mp4")
            got = tr.render(doc, out, "mp4")
            self.assertEqual(got["frames"], FPS)
            want = [math.floor(round(tio.source_moment(clip, (k + 0.5) / FPS), 4) * FPS + 1e-6) for k in range(FPS)]
            self.assertEqual(read_levels(out), want)
            self.assertEqual(want, sorted(want))
            self.assertLess(want[3] - want[0], 3, "slow at first")
            self.assertGreater(want[-1] - want[-4], 4, "fast at the end")
            self.assertIsNone(tr.clip_sound(clip, 0.5), "silent")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
