"""Clips switched off (D) and keyframed clips: the file, the render, and the Edit tab's JS agreeing with it.

The JS side is asked through node (the data module is plain JS). The render tests need PyAV: ComfyUI's interpreter.
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest discover -s tests -p "test_edit_disabled_keys.py"
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
NODE = shutil.which("node")


def _modules():
    name = "imageviewer_disabled_keys_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules[name] = pkg
    tio = importlib.import_module(name + ".timeline_io")
    try:
        tr = importlib.import_module(name + ".timeline_render")
    except ImportError:  # pragma: no cover
        tr = None
    return tio, tr


def js(expr, data):
    """Evaluate `expr` (a JS expression over D and `data`) under node, as JSON."""
    url = "file:///" + os.path.join(ROOT, "js", "imageViewer_editTimelineData.js").replace("\\", "/")
    code = (f"import * as D from {json.dumps(url)}; const data = JSON.parse(process.argv[1]);"
            f" process.stdout.write(JSON.stringify({expr}));")
    out = subprocess.run([NODE, "--input-type=module", "-e", code, json.dumps(data)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def shot(path, length, **more):
    return {"file": path, "name": os.path.basename(path), "in": 0, "length": length, "transition": 0, **more}


class DisabledClips(unittest.TestCase):
    def setUp(self):
        self.tio, self.tr = _modules()
        self.tmp = tempfile.mkdtemp()
        self.files = {}
        for n in ("a", "b", "c", "o", "s"):
            p = os.path.join(self.tmp, n + ".mp4").replace("\\", "/")
            open(p, "wb").close()
            self.files[n] = p

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self):
        f = self.files
        return {"clips": [shot(f["a"], 2), shot(f["b"], 2, transition=0.5, disabled=True), shot(f["c"], 2, transition=0.25)],
                "texts": [], "sound": [],
                "tracks": [{"id": "V2", "kind": "video", "name": "V2", "off": False,
                            "clips": [{**shot(f["o"], 1), "at": 0.5, "disabled": True}]},
                           {"id": "A2", "kind": "audio", "name": "A2", "off": False,
                            "clips": [{**shot(f["s"], 1), "at": 0, "disabled": True}]}]}

    def doc(self, edit):
        return self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)

    def test_the_switch_is_otio_enabled_and_metadata_and_comes_back(self):
        doc = self.doc(self.edit())
        items = [c for c in doc["tracks"]["children"][0]["children"] if str(c.get("OTIO_SCHEMA", "")).startswith("Clip")]
        self.assertEqual([c.get("enabled", True) for c in items], [True, False, True])
        self.assertTrue(items[1]["metadata"]["imageviewer"]["disabled"])
        back = self.tio.editable(doc)
        self.assertEqual([bool(c.get("disabled")) for c in back["clips"]], [False, True, False])
        self.assertTrue(back["tracks"][0]["clips"][0]["disabled"])
        # Switched on again: both forms go.
        edit = {**back, "clips": [dict(c, disabled=False) for c in back["clips"]]}
        again = self.tio.rebuild(doc, edit, may_use=lambda p: True)
        items = [c for c in again["tracks"]["children"][0]["children"] if str(c.get("OTIO_SCHEMA", "")).startswith("Clip")]
        self.assertEqual([c.get("enabled", True) for c in items], [True, True, True])
        self.assertNotIn("disabled", items[1]["metadata"].get("imageviewer", {}))

    @unittest.skipIf(NODE is None, "needs node")
    def test_the_render_and_the_edit_tab_show_the_same_clip_on_every_frame(self):
        """A disabled V1 shot is a gap in both, its dissolves cuts; disabled clips of the tracks are not there."""
        if self.tr is None:
            self.skipTest("timeline_render needs its imports")
        cut = self.tr.read_cut(self.doc(self.edit()))
        self.assertEqual([c["file"] if not c.get("blank") else "" for c in cut["clips"]], [self.files["a"], "", self.files["c"]])
        self.assertEqual(cut["overlays"], [])
        self.assertEqual(cut["sounds"], [])
        counts = self.tr.frame_counts(cut["clips"], FPS)
        total = self.tr.film_frames(counts)
        shown = [""] * total
        at = 0
        for clip, (n, d_in, _d_out) in zip(cut["clips"], counts):
            at -= d_in
            for k in range(n):
                shown[at + k] = "" if clip.get("blank") else clip["file"]
            at += n
        tab = js("Array.from({ length: data.n }, (_, f) => { const p = D.pictureAt(data.cut, (f + 0.5) / 24); return p && p.clip ? p.clip.file : ''; })",
                 {"cut": {**self.edit(), "fps": FPS, "off": {}}, "n": total})
        self.assertEqual(tab, shown)
        self.assertEqual(js("D.soundItems(data.cut).map(s => s.file)", {"cut": {**self.edit(), "fps": FPS, "off": {}}}), [])


# ── keyframes ────────────────────────────────────────────────────────────────

KEYS = {"op": [{"t": 0, "v": 0}, {"t": 0.5, "v": 0.8, "i": "in"}, {"t": 1.25, "v": 0.3, "i": "hold"}, {"t": 1.75, "v": 1, "i": "inout"}, {"t": 2.5, "v": 0.2}],
        "x": [{"t": 0.2, "v": -0.5, "i": "out"}, {"t": 2, "v": 0.5}],
        "vol": [{"t": 0, "v": 1}, {"t": 2, "v": 0}]}


class KeyframesAgree(unittest.TestCase):
    """The same keys evaluated by the JS (the Edit tab) and the Python (the render), frame by frame."""
    def setUp(self):
        self.tio, self.tr = _modules()
        if self.tr is None:
            self.skipTest("timeline_render needs its imports")

    def test_clean_keys_is_the_same_on_both_sides(self):
        messy = {"op": [{"t": 2, "v": 3}, {"t": 1, "v": 0.5, "i": "nope"}, {"t": 2, "v": 0.2, "i": "hold"}, {"t": -1, "v": 0}],
                 "zz": [{"t": 0, "v": 1}], "vol": [{"t": 0.12345678, "v": 0.5}]}
        self.assertEqual(self.tio.clean_keys(messy), js("D.cleanKeys(data)", messy) if NODE else self.tio.clean_keys(messy))
        self.assertEqual(self.tio.clean_fx({"op": 0.5, "keys": messy})["keys"]["op"], [{"t": 1.0, "v": 0.5}, {"t": 2.0, "v": 0.2, "i": "hold"}])

    @unittest.skipIf(NODE is None, "needs node")
    def test_every_frame_has_the_same_value_in_the_render_and_the_edit_tab(self):
        keys = self.tio.clean_keys(KEYS)
        frames = [(f + 0.5) / FPS for f in range(-2, 80)]
        for p in keys:
            mine = [self.tr.key_value(keys[p], max(0.0, u)) for u in frames]
            theirs = js("data.us.map(u => D.keyValue(data.keys, Math.max(0, u)))", {"keys": keys[p], "us": frames})
            for f, (a, b) in enumerate(zip(mine, theirs)):
                self.assertAlmostEqual(a, b, places=9, msg=f"{p} at frame {f - 2}")
        # The whole look: effective(fx, u) here, clipFx(clip, u) there.
        fx = {"zx": 1.5, "op": 0.9, "keys": keys}
        for u in frames[2::7]:
            here = self.tr.effective(fx, u)
            there = js("D.clipFx({ fx: data.fx }, data.u)", {"fx": fx, "u": u})
            for k in self.tio.FX:
                self.assertAlmostEqual(here[k], there[k], places=9, msg=f"{k} at {u}")

    def test_the_keys_are_kept_in_the_file_and_come_back(self):
        tmp = tempfile.mkdtemp()
        try:
            a = os.path.join(tmp, "a.mp4").replace("\\", "/")
            open(a, "wb").close()
            edit = {"clips": [{**shot(a, 3), "fx": {"op": 0.5, "keys": KEYS}}], "texts": [], "sound": [], "tracks": []}
            doc = self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)
            back = self.tio.editable(json.loads(json.dumps(doc)))["clips"][0]["fx"]
            self.assertEqual(back["keys"], self.tio.clean_keys(KEYS))
            self.assertEqual(back["op"], 0.5)
            plain = self.tio.rebuild(self.tio.new_doc("t", FPS), {**edit, "clips": [{**shot(a, 3), "fx": {"op": 0.5}}]}, may_use=lambda p: True)
            self.assertNotIn("keys", self.tio.editable(plain)["clips"][0]["fx"], "an old cut without keys stays without")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


try:
    import av
    import numpy as np
except ImportError:  # pragma: no cover
    av = None


@unittest.skipIf(av is None, "needs PyAV")
class KeyframesRendered(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tio, cls.tr = _modules()
        sys.path.insert(0, os.path.dirname(__file__))
        from test_timeline_gaps_links import make_tone_clip, frame_means, loudness
        cls.means, cls.loud = staticmethod(frame_means), staticmethod(loudness)
        cls.tmp = tempfile.mkdtemp()
        cls.white = os.path.join(cls.tmp, "white.mp4")
        make_tone_clip(cls.white, 3.0, (250, 250, 250))
        cls.red = os.path.join(cls.tmp, "red.png")
        from PIL import Image
        img = Image.new("RGB", (64, 32), (0, 0, 0))
        img.paste((230, 20, 20), (28, 0, 36, 32))            # a red bar in the middle of a black picture
        img.save(cls.red)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, edit, name):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), {"texts": [], **edit}, may_use=lambda p: True)
        out = os.path.join(self.tmp, name + ".mp4")
        self.tr.render(doc, out, "mp4")
        return out

    def test_an_opacity_ramp_fades_in_frame_by_frame(self):
        edit = {"clips": [{"file": self.white, "name": "w", "in": 0, "length": 2, "transition": 0,
                           "fx": {"keys": {"op": [{"t": 0, "v": 0}, {"t": 1, "v": 1}]}}}]}
        means = [m.mean() for m in self.means(self.render(edit, "fade"))]
        for f in (0, 6, 12, 18, 30):
            want = 250 * self.tr.key_value(self.tio.clean_keys(edit["clips"][0]["fx"]["keys"])["op"], (f + 0.5) / FPS)
            self.assertAlmostEqual(means[f], want, delta=10, msg=f"frame {f}")

    def test_a_position_move_carries_the_picture_across(self):
        edit = {"clips": [{"file": self.red, "name": "r", "in": 0, "length": 2, "transition": 0,
                           "fx": {"keys": {"x": [{"t": 0, "v": -0.25}, {"t": 1.5, "v": 0.25}]}}}]}
        out = self.render(edit, "move")
        with av.open(out) as src:
            pics = [fr.to_ndarray(format="rgb24") for fr in src.decode(src.streams.video[0])]
        where = []
        for f in (0, 18, 35, 40):
            red = pics[f][:, :, 0].astype(int) - pics[f][:, :, 2].astype(int)
            cols = np.where(red.mean(axis=0) > 60)[0]
            where.append(float(cols.mean()) / pics[f].shape[1])
        x = lambda f: self.tr.key_value(self.tio.clean_keys(edit["clips"][0]["fx"]["keys"])["x"], (f + 0.5) / FPS)
        for (f, got) in zip((0, 18, 35, 40), where):
            self.assertAlmostEqual(got, 0.5 + x(f), delta=0.06, msg=f"frame {f}")

    def test_a_volume_ramp_goes_quiet(self):
        edit = {"clips": [{"file": self.white, "name": "w", "in": 0, "length": 2, "transition": 0,
                           "fx": {"keys": {"vol": [{"t": 0, "v": 1}, {"t": 2, "v": 0}]}}}]}
        level = self.loud(self.render(edit, "vol"))
        self.assertGreater(level[2], 0.2)
        self.assertAlmostEqual(level[10] / level[2], (1 - 1.05 / 2) / (1 - 0.25 / 2), delta=0.12)
        self.assertLess(level[18], level[2] * 0.15)


if __name__ == "__main__":
    unittest.main()
