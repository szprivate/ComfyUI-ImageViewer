"""Video transitions beyond the cross dissolve (dip to a colour, wipes): the file, the render's frames, the parity with the page.

    python -m unittest tests.test_edit_transitions
"""
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FPS = 24


def _mod(which):
    name = "imageviewer_transitions_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules[name] = pkg
    return importlib.import_module(name + "." + which)


class TransitionsInTheFile(unittest.TestCase):
    def setUp(self):
        self.tio = _mod("timeline_io")
        self.tmp = tempfile.mkdtemp()
        self.a, self.b = os.path.join(self.tmp, "a.mp4"), os.path.join(self.tmp, "b.mp4")
        for p in (self.a, self.b):
            open(p, "wb").close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_dip_and_a_wipe_go_into_the_file_and_come_back(self):
        edit = {"clips": [{"file": self.a, "name": "a", "in": 0, "length": 4, "transition": 0},
                          {"file": self.b, "name": "b", "in": 0, "length": 4, "transition": 1, "tfx": {"type": "dip", "color": "#FF0000"}},
                          {"file": self.a, "name": "c", "in": 0, "length": 4, "transition": 0.5, "tfx": {"type": "wipe", "dir": "up"}}],
                "texts": []}
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)
        kids = doc["tracks"]["children"][0]["children"]
        trans = [k for k in kids if k["OTIO_SCHEMA"].startswith("Transition")]
        self.assertEqual([t["transition_type"] for t in trans], ["SMPTE_Dissolve", "SMPTE_Dissolve"], "other programs read dissolves")
        self.assertEqual([t["name"] for t in trans], ["Dip to Color", "Wipe"])
        self.assertEqual(trans[0]["metadata"]["imageviewer"]["transition"], {"type": "dip", "color": "#ff0000"})
        back = self.tio.editable(json.loads(json.dumps(doc)))
        self.assertNotIn("tfx", back["clips"][0])
        self.assertEqual(back["clips"][1]["tfx"], {"type": "dip", "color": "#ff0000"})
        self.assertEqual(back["clips"][2]["tfx"], {"type": "wipe", "dir": "up"})
        # A cross dissolve again: nothing of the look is left in the file.
        edit["clips"][1]["tfx"] = None
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)
        back = self.tio.editable(json.loads(json.dumps(doc)))
        self.assertNotIn("tfx", back["clips"][1])

    def test_clean_tfx_holds_it_to_what_it_may_be(self):
        c = self.tio.clean_tfx
        self.assertIsNone(c(None))
        self.assertIsNone(c({"type": "dissolve"}))
        self.assertEqual(c({"type": "dip", "color": "red"}), {"type": "dip", "color": "#000000"})
        self.assertEqual(c({"type": "wipe", "dir": "sideways"}), {"type": "wipe", "dir": "right"})


class TransitionFrames(unittest.TestCase):
    def setUp(self):
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("numpy")
        self.tr = _mod("timeline_render")

    def frames(self):
        import numpy as np
        out = np.full((4, 8, 3), 200, dtype=np.uint8)
        inn = np.full((4, 8, 3), 40, dtype=np.uint8)
        return out, inn

    def test_cross_dissolve_dip_and_wipe(self):
        out, inn = self.frames()
        f = self.tr.transition_frame
        self.assertEqual(int(f(None, out, inn, 0.25)[0, 0, 0]), 160)
        dip = {"type": "dip", "color": "#ffffff"}
        self.assertEqual(int(f(dip, out, inn, 0.25)[0, 0, 0]), 228, "halfway to white")
        self.assertEqual(int(f(dip, out, inn, 0.5)[0, 0, 0]), 255, "white in the middle")
        self.assertEqual(int(f(dip, out, inn, 0.75)[0, 0, 0]), 148, "halfway from white to the shot coming in")
        w = f({"type": "wipe", "dir": "right"}, out, inn, 0.25)
        self.assertEqual(list(w[0, :, 0]), [40, 40, 200, 200, 200, 200, 200, 200])
        w = f({"type": "wipe", "dir": "up"}, out, inn, 0.5)
        self.assertEqual(list(w[:, 0, 0]), [200, 200, 40, 40])

    def test_the_page_draws_the_same_shares(self):
        # transitionLook (the page) against transition_frame: the same picture from the same two frames.
        script = ("import * as D from './js/imageViewer_editTimelineData.js';"
                  "const out = [];"
                  "for (const tfx of [null, {type:'dip', color:'#ffffff'}, {type:'dip', color:'#102030'}])"
                  " for (const m of [0.1, 0.3, 0.5, 0.7, 0.9]) out.push(D.transitionLook(tfx, m));"
                  "console.log(JSON.stringify(out));")
        try:
            got = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
        except FileNotFoundError:
            self.skipTest("node")
        looks = json.loads(got.stdout)
        out, inn = self.frames()
        k = 0
        for tfx in (None, {"type": "dip", "color": "#ffffff"}, {"type": "dip", "color": "#102030"}):
            for m in (0.1, 0.3, 0.5, 0.7, 0.9):
                look = looks[k]
                k += 1
                ground = int(look.get("color", "#000000")[1:3], 16)
                # The page: the shot coming in at `inn` over the one going out at `out` over the ground.
                under = 200 * look["out"] + ground * (1 - look["out"])
                page = 40 * look["inn"] + under * (1 - look["inn"])
                self.assertAlmostEqual(int(self.tr.transition_frame(tfx, out, inn, m)[0, 0, 0]), page, delta=1, msg=f"{tfx} at {m}")


if __name__ == "__main__":
    unittest.main()


try:
    import av
    import numpy as np
except ImportError:                     # the render needs PyAV (ComfyUI's interpreter has it)
    av = None


@unittest.skipIf(av is None, "needs PyAV")
class TransitionsRendered(unittest.TestCase):
    """A real render through timeline_render.render: a dip to white and a wipe between a red and a blue picture."""

    @classmethod
    def setUpClass(cls):
        from PIL import Image
        cls.tio, cls.tr = _mod("timeline_io"), _mod("timeline_render")
        cls.tmp = tempfile.mkdtemp()
        cls.red, cls.blue = os.path.join(cls.tmp, "red.png"), os.path.join(cls.tmp, "blue.png")
        Image.new("RGB", (64, 32), (220, 20, 20)).save(cls.red)
        Image.new("RGB", (64, 32), (20, 20, 220)).save(cls.blue)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, tfx, name):
        edit = {"texts": [], "clips": [{"file": self.red, "name": "a", "in": 0, "length": 2, "transition": 0},
                                       {"file": self.blue, "name": "b", "in": 0, "length": 2, "transition": 1, "tfx": tfx}]}
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)
        out = os.path.join(self.tmp, name + ".mp4")
        self.tr.render(doc, out, "mp4")
        with av.open(out) as src:
            return [f.to_ndarray(format="rgb24") for f in src.decode(src.streams.video[0])]

    def test_a_dip_to_white_is_white_in_its_middle(self):
        frames = self.render({"type": "dip", "color": "#ffffff"}, "dip")
        self.assertEqual(len(frames), 72, "3 s: the dissolve's second overlaps")
        mid = frames[24 + 12].reshape(-1, 3).mean(axis=0)
        self.assertTrue(all(v > 230 for v in mid), mid)
        self.assertGreater(frames[10].reshape(-1, 3).mean(axis=0)[0], 180, "red before it")
        self.assertGreater(frames[60].reshape(-1, 3).mean(axis=0)[2], 180, "blue after it")

    def test_a_wipe_uncovers_the_next_shot_from_the_left(self):
        f = self.render({"type": "wipe", "dir": "right"}, "wipe")[24 + 12]
        left, right = f[:, :20].reshape(-1, 3).mean(axis=0), f[:, 44:].reshape(-1, 3).mean(axis=0)
        self.assertGreater(left[2], 150, "blue on the left half")
        self.assertGreater(right[0], 150, "red still on the right")
