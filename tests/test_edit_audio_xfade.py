"""Audio crossfades and fades, and the tracks' Lock / Auto Track Selector: the .otio, the render, and the
Edit tab's JS agreeing with the render's arithmetic.

The JS side is asked through node; the render tests need PyAV (ComfyUI's interpreter):
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_edit_audio_xfade
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

try:
    import av
    import numpy as np
except ImportError:  # pragma: no cover
    av = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FPS = 24
NODE = shutil.which("node")


def _modules():
    name = "bepic_audio_xfade_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [ROOT]
        sys.modules[name] = pkg
    tio = importlib.import_module(name + ".timeline_io")
    try:
        tr = importlib.import_module(name + ".timeline_render")
    except ImportError:  # pragma: no cover
        tr = None
    return tio, tr


def js(expr, data):
    url = "file:///" + os.path.join(ROOT, "js", "bEpicViewer_editTimelineData.js").replace("\\", "/")
    code = (f"import * as D from {json.dumps(url)}; const data = JSON.parse(process.argv[1]);"
            f" process.stdout.write(JSON.stringify({expr}));")
    out = subprocess.run([NODE, "--input-type=module", "-e", code, json.dumps(data)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


ENVS = [
    {"len": 2.0, "fi": 0.5, "fo": 0.3, "xin": None, "xout": None},
    {"len": 2.0, "fi": 0.0, "fo": 0.0, "xin": {"b": 0.25, "a": 0.25, "curve": "+3"}, "xout": {"b": 0.0, "a": 1.0, "curve": "0"}},
    {"len": 1.5, "fi": 0.0, "fo": 0.4, "xin": {"b": 0.8, "a": 0.0, "curve": "-3"}, "xout": None},
]
TIMES = [round(-1.0 + k * 0.037, 4) for k in range(120)]


class GainCurveParity(unittest.TestCase):
    """envGain (the Edit tab) = timeline_io.env_gain = timeline_render.env_curve (the render), everywhere."""

    @unittest.skipIf(NODE is None, "needs node")
    def test_js_and_python_give_the_same_gain(self):
        tio, tr = _modules()
        got = js("data.envs.map((e) => data.times.map((u) => D.envGain(e, u)))", {"envs": ENVS, "times": TIMES})
        for env, row in zip(ENVS, got):
            py = [tio.env_gain(env, u) for u in TIMES]
            for a, b in zip(row, py):
                self.assertAlmostEqual(a, b, places=6)
            if av is not None:
                vec = tr.env_curve(env, np.array(TIMES))
                for a, b in zip(row, vec):
                    self.assertAlmostEqual(a, float(b), places=5)
        curves = js("['0','+3','-3'].map((c) => [0, 0.25, 0.5, 0.9].map((p) => D.curveGain(c, p)))", {})
        for c, row in zip(["0", "+3", "-3"], curves):
            for p, v in zip([0, 0.25, 0.5, 0.9], row):
                self.assertAlmostEqual(tio.curve_gain(c, p), v, places=9)

    @unittest.skipIf(NODE is None, "needs node")
    def test_which_clips_crossfade_is_decided_alike(self):
        tio, _ = _modules()
        edit = {"clips": [{"file": "a.mp4", "in": 1, "length": 2, "transition": 0},
                          {"file": "b.mp4", "in": 1, "length": 2, "transition": 0, "xfade": {"len": 1, "curve": "0", "align": "end"}},
                          {"file": "c.mp4", "in": 1, "length": 2, "transition": 0.5, "xfade": {"len": 1}}],
                "tracks": [{"id": "A2", "kind": "audio", "clips": [
                    {"file": "s.wav", "in": 0, "length": 1, "at": 2, "fadeIn": 0.2},
                    {"file": "t.wav", "in": 3, "length": 1, "at": 3, "xfade": {"len": 0.4}}]}]}
        envs = tio.audio_envs(edit)
        sels = [["V1", {"kind": "clip", "i": i}] for i in range(3)] + [["A2", {"kind": "tclip", "track": "A2", "i": i}] for i in range(2)]
        want = js("data.sels.map(([_, s]) => D.audioEnv(data.cut, s))", {"cut": {**edit, "texts": [], "sound": []}, "sels": sels})
        for (tid, s), w in zip(sels, want):
            self.assertEqual(envs[(tid, s["i"])], w, (tid, s))


class InTheFile(unittest.TestCase):
    def setUp(self):
        self.tio, _ = _modules()
        self.tmp = tempfile.mkdtemp()
        self.a, self.b, self.s = (os.path.join(self.tmp, n) for n in ("a.mp4", "b.mp4", "s.wav"))
        for p in (self.a, self.b, self.s):
            open(p, "wb").close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fades_crossfades_lock_and_auto_select_come_back(self):
        edit = {"clips": [{"file": self.a, "name": "a", "in": 0, "length": 2, "transition": 0, "fadeIn": 0.5},
                          {"file": self.b, "name": "b", "in": 1, "length": 2, "transition": 0,
                           "xfade": {"len": 0.5, "curve": "-3", "align": "start"}}],
                "texts": [{"text": "t", "start": 0, "length": 1}],
                "tracks": [{"id": "A2", "kind": "audio", "name": "A2", "off": False, "lock": True, "auto": False,
                            "clips": [{"file": self.s, "name": "s", "at": 0, "in": 0, "length": 1, "fadeOut": 0.25},
                                      {"file": self.s, "name": "s", "at": 1, "in": 2, "length": 1, "xfade": {"len": 0.2}}]}],
                "lock": {"V1": True, "A1": False, "T": True}, "auto": {"V1": False, "A1": True, "T": False}}
        doc = json.loads(json.dumps(self.tio.rebuild(self.tio.new_doc("t", FPS), edit, may_use=lambda p: True)))
        back = self.tio.editable(doc)
        self.assertEqual(back["clips"][0]["fadeIn"], 0.5)
        self.assertEqual(back["clips"][1]["xfade"], {"len": 0.5, "curve": "-3", "align": "start"})
        a2 = back["tracks"][0]
        self.assertEqual((a2["lock"], a2["auto"]), (True, False))
        self.assertEqual(a2["clips"][0]["fadeOut"], 0.25)
        self.assertEqual(a2["clips"][1]["xfade"], {"len": 0.2, "curve": "+3", "align": "centre"})
        self.assertEqual(back["lock"], {"V1": True, "A1": False, "T": True})
        self.assertEqual(back["auto"], {"V1": False, "A1": True, "T": False})
        # Taken off again: gone from the file.
        again = {"clips": [{"ref": 0, "in": 0, "length": 2, "transition": 0, "fadeIn": 0},
                           {"ref": 1, "in": 1, "length": 2, "transition": 0, "xfade": None}], "texts": [],
                 "lock": {"V1": False, "T": False}, "auto": {"V1": True, "T": True}}
        back = self.tio.editable(json.loads(json.dumps(self.tio.rebuild(doc, again, may_use=lambda p: True))))
        self.assertNotIn("fadeIn", back["clips"][0])
        self.assertNotIn("xfade", back["clips"][1])
        self.assertEqual(back["lock"]["V1"], False)
        self.assertEqual(back["auto"]["T"], True)

    def test_agentYs_changes_leave_a_locked_track_alone(self):
        edit = {"clips": [{"file": self.a, "in": 0, "length": 2, "transition": 0}], "texts": [],
                "lock": {"V1": True},
                "tracks": [{"id": "A2", "kind": "audio", "name": "A2", "lock": True,
                            "clips": [{"file": self.s, "in": 0, "length": 1, "at": 0}]}]}
        with self.assertRaisesRegex(ValueError, "locked"):
            self.tio.apply_ops(edit, [{"op": "set", "track": "A2", "clip": 1, "at": 3}])
        with self.assertRaisesRegex(ValueError, "locked"):
            self.tio.apply_ops(edit, [{"op": "remove", "track": "V1", "clip": 1}])
        with self.assertRaisesRegex(ValueError, "locked"):
            self.tio.apply_ops(edit, [{"op": "add", "file": self.s, "track": "A2", "at": 5, "length": 1}])
        # Left to choose, it takes a track that is not locked.
        new, _said = self.tio.apply_ops(edit, [{"op": "add", "file": self.s, "at": 5, "length": 1}])
        self.assertEqual([t["id"] for t in new["tracks"] if t["clips"] and t["clips"][-1]["at"] == 5], ["A3"])

    def test_the_beds_fades(self):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), {"clips": [{"file": self.a, "in": 0, "length": 2, "transition": 0}],
                                                            "texts": []}, may_use=lambda p: True)
        url = "file:///" + self.s.replace("\\", "/")
        doc["tracks"]["children"].append({"OTIO_SCHEMA": "Track.1", "kind": "Audio", "name": "A1", "children": [
            {"OTIO_SCHEMA": "Clip.1", "name": "bed", "metadata": {}, "source_range": None,
             "media_reference": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": url}}]})
        bed = self.tio.editable(doc)["sound"][0]
        self.assertEqual((bed["fadeIn"], bed["fadeOut"]), (0.0, 1.0))          # agentY's 1 s fade out, where nothing is said
        edit = {"clips": [{"ref": 0, "in": 0, "length": 2, "transition": 0}], "texts": [],
                "sound": [{**bed, "fadeIn": 0.5, "fadeOut": 0}]}
        bed = self.tio.editable(self.tio.rebuild(doc, edit, may_use=lambda p: True))["sound"][0]
        self.assertEqual((bed["fadeIn"], bed["fadeOut"]), (0.5, 0.0))


def tone_film(path, seconds, freq, fps=FPS, rate=48000):
    """A grey film with a tone of `freq` Hz all through it."""
    with av.open(path, "w") as out:
        vs = out.add_stream("libx264" if "libx264" in av.codecs_available else "mpeg4", rate=fps)
        vs.width, vs.height, vs.pix_fmt = 64, 32, "yuv420p"
        aus = out.add_stream("aac", rate=rate)
        aus.layout = "mono"
        for i in range(int(seconds * fps)):
            vf = av.VideoFrame.from_ndarray(np.full((32, 64, 3), 120, dtype=np.uint8), format="rgb24")
            vf.pts = i
            for pkt in vs.encode(vf):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)
        t = np.arange(int(seconds * rate)) / rate
        tone = (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        for k in range(0, tone.size, 1024):
            af = av.AudioFrame.from_ndarray(tone[k:k + 1024].reshape(1, -1), format="flt", layout="mono")
            af.sample_rate = rate
            af.pts = k
            for pkt in aus.encode(af):
                out.mux(pkt)
        for pkt in aus.encode():
            out.mux(pkt)


def sound_of(path):
    chunks = []
    with av.open(path) as src:
        res = av.AudioResampler(format="flt", layout="mono", rate=48000)
        for frame in src.decode(src.streams.audio[0]):
            for piece in res.resample(frame):
                chunks.append(piece.to_ndarray().reshape(-1))
    return np.concatenate(chunks)


def tone_level(x, freq, t0, t1, rate=48000):
    """How strong a tone of `freq` is between t0 and t1 seconds (amplitude, by correlation)."""
    seg = x[int(t0 * rate):int(t1 * rate)]
    t = np.arange(seg.size) / rate
    return float(2 * np.hypot(np.mean(seg * np.sin(2 * np.pi * freq * t)), np.mean(seg * np.cos(2 * np.pi * freq * t))))


@unittest.skipIf(av is None, "needs PyAV")
class Rendered(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tio, cls.tr = _modules()
        cls.tmp = tempfile.mkdtemp()
        cls.lo, cls.hi = os.path.join(cls.tmp, "lo.mp4"), os.path.join(cls.tmp, "hi.mp4")
        tone_film(cls.lo, 4.0, 440)
        tone_film(cls.hi, 4.0, 660)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, edit, name):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), {"texts": [], **edit}, may_use=lambda p: True)
        out = os.path.join(self.tmp, name + ".mp4")
        self.tr.render(doc, out, "mp4")
        return sound_of(out)

    def test_a_crossfade_at_a_v1_cut_takes_the_sound_from_beyond_it(self):
        # Two shots of 1.5 s, cut at 1.5 s; a crossfade of 1 s centred on it, +3 dB.
        clips = [{"file": self.lo, "name": "lo", "in": 1, "length": 1.5, "transition": 0},
                 {"file": self.hi, "name": "hi", "in": 1, "length": 1.5, "transition": 0,
                  "xfade": {"len": 1.0, "curve": "+3", "align": "centre"}}]
        x = self.render({"clips": clips}, "v1x")
        plain = self.render({"clips": [clips[0], {**clips[1], "xfade": None}]}, "v1plain")
        self.assertAlmostEqual(len(x) / 48000, 3.0, delta=0.05)          # nothing moved
        # Before the crossfade only the shot going out, after it only the one coming in.
        self.assertGreater(tone_level(x, 440, 0.2, 0.9), 0.4)
        self.assertLess(tone_level(x, 660, 0.2, 0.9), 0.03)
        self.assertGreater(tone_level(x, 660, 2.1, 2.8), 0.4)
        self.assertLess(tone_level(x, 440, 2.1, 2.8), 0.03)
        # Just before the cut the shot coming in is already heard (its handle), just after it the one going out.
        self.assertGreater(tone_level(x, 660, 1.2, 1.45), 0.1)
        self.assertGreater(tone_level(x, 440, 1.55, 1.8), 0.1)
        self.assertLess(tone_level(plain, 660, 1.2, 1.45), 0.03)
        self.assertLess(tone_level(plain, 440, 1.55, 1.8), 0.03)
        # At the cut both are at sin(45 degrees): the equal power curve's middle.
        mid_lo, mid_hi = tone_level(x, 440, 1.46, 1.54), tone_level(x, 660, 1.46, 1.54)
        self.assertAlmostEqual(mid_lo / 0.5, 0.707, delta=0.12)
        self.assertAlmostEqual(mid_hi / 0.5, 0.707, delta=0.12)

    def test_a_crossfade_on_a_sound_track_and_fades(self):
        clips = [{"file": self.lo, "name": "v", "in": 0, "length": 4, "transition": 0, "volume": 0}]
        a2 = {"id": "A2", "kind": "audio", "name": "A2", "off": False, "clips": [
            {"file": self.lo, "name": "lo", "at": 0, "in": 0.5, "length": 2, "fadeIn": 1.0},
            {"file": self.hi, "name": "hi", "at": 2, "in": 0.5, "length": 2, "fadeOut": 1.0,
             "xfade": {"len": 0.6, "curve": "0", "align": "start"}}]}
        x = self.render({"clips": clips, "tracks": [a2]}, "a2x")
        # The fade in: a straight line from 0 to the tone's level over the first second.
        self.assertLess(tone_level(x, 440, 0.0, 0.1), 0.06)
        self.assertAlmostEqual(tone_level(x, 440, 0.45, 0.55), 0.25, delta=0.05)
        self.assertGreater(tone_level(x, 440, 1.2, 1.9), 0.45)
        # "start on edit": the clip going out plays on past its end, falling; the one coming in rises from the cut.
        self.assertAlmostEqual(tone_level(x, 440, 2.27, 2.33), 0.25, delta=0.06)
        self.assertAlmostEqual(tone_level(x, 660, 2.27, 2.33), 0.25, delta=0.06)
        self.assertLess(tone_level(x, 440, 2.7, 2.9), 0.03)
        # The fade out of the last clip.
        self.assertAlmostEqual(tone_level(x, 660, 3.45, 3.55), 0.25, delta=0.06)


if __name__ == "__main__":
    unittest.main()
