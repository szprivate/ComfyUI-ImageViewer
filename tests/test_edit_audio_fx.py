"""Sound effects of the Edit panel: the JS table and the render's (audio_fx.py) agreeing, the .otio, the
render of each effect (PyAV / numpy, measured on test tones), and the Resolve export baking them.

    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest discover -s tests -p "test_edit_audio_fx.py"
"""
import importlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import xml.etree.ElementTree as ET

try:
    import av
    import numpy as np
except ImportError:  # pragma: no cover
    av = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FPS = 24
NODE = shutil.which("node")
RATE = 48000


def _mods():
    name = "imageviewer_audio_fx_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules[name] = pkg
    get = lambda m: importlib.import_module(f"{name}.{m}")      # noqa: E731
    return get


def js(expr, data):
    url = "file:///" + os.path.join(ROOT, "js", "imageViewer_audioFxData.js").replace("\\", "/")
    code = (f"import * as A from {json.dumps(url)}; const data = JSON.parse(process.argv[1]);"
            f" process.stdout.write(JSON.stringify({expr}));")
    out = subprocess.run([NODE, "--input-type=module", "-e", code, json.dumps(data)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


CHAINS = [
    {"type": "eq", "p": {"hp": 80, "ls_g": 3, "pk_f": 2500, "pk_g": -4.5, "pk_q": 2, "hs_g": 1.5, "lp": 12000}},
    {"type": "comp", "p": {"thr": -24, "ratio": 3, "att": 5, "rel": 200, "knee": 9, "makeup": 4}},
    {"type": "limit", "p": {"ceil": -3, "rel": 80}},
    {"type": "reverb", "on": False, "p": {"preset": "hall", "mix": 2, "decay": 3}, "keys": {"mix": [{"t": 1, "v": 0.5, "i": "in"}, {"t": 0, "v": 0.1}]}},
    {"type": "delay", "p": {"time": 120, "fb": 0.5}},
    {"type": "gain", "keys": {"gain": [{"t": 0.5, "v": -6}, {"t": 2, "v": 3}]}},
    {"type": "pan", "p": {"pan": -0.4}},
    {"type": "nope"},
]


@unittest.skipIf(NODE is None, "needs node")
class Parity(unittest.TestCase):
    def setUp(self):
        self.fx = _mods()("audio_fx")

    def test_the_chain_its_filters_and_its_keys_are_the_same_both_sides(self):
        self.assertEqual(self.fx.clean_chain(CHAINS), js("A.cleanAfx(data)", CHAINS))
        clean = self.fx.clean_chain(CHAINS)
        self.assertEqual(len(clean), 7)                   # the unknown one is left out
        self.assertEqual(clean[3]["p"]["mix"], 1)         # held to its range
        self.assertEqual([self.fx.ffmpeg_filters(f) for f in clean], js("A.cleanAfx(data).map(A.afxFfmpeg)", CHAINS))
        times = [0, 0.25, 0.5, 0.9, 1.3, 2, 3]
        for i, k in ((3, "mix"), (5, "gain")):
            want = js(f"data.t.map((t) => A.afxParam(A.cleanAfx(data.c)[{i}], '{k}', t))", {"c": CHAINS, "t": times})
            for t, v in zip(times, want):
                self.assertAlmostEqual(self.fx.param_at(clean[i], k, t), v, places=9)
        for p in (-1, -0.4, 0, 0.3, 1):
            for a, b in zip(self.fx.pan_gains(p), js(f"A.panGains({p})", {})):
                self.assertAlmostEqual(a, b, places=12)

    def test_the_reverbs_impulse_response_is_the_same_noise(self):
        want = js("A.reverbIR('plate', 0.3, 15, 48000).map((c) => [c.length, Array.from(c.slice(700, 760))])", {})
        got = self.fx.reverb_ir("plate", 0.3, 15)
        for ch in range(2):
            self.assertEqual(got.shape[1], want[ch][0])
            for a, b in zip(got[ch][700:760], want[ch][1]):
                self.assertAlmostEqual(float(a), b, delta=1e-6)
        self.assertAlmostEqual(float(np.sum(got[0].astype(np.float64) ** 2)), 1.0, places=4) if av else None


class InTheFile(unittest.TestCase):
    def test_clip_track_and_bed_effects_come_back(self):
        get = _mods()
        tio = get("timeline_io")
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        a, s = os.path.join(tmp, "a.mp4"), os.path.join(tmp, "s.wav")
        for p in (a, s):
            open(p, "wb").close()
        edit = {"clips": [{"file": a, "in": 0, "length": 2, "transition": 0, "afx": [CHAINS[0]]}], "texts": [],
                "tracks": [{"id": "A2", "kind": "audio", "name": "A2", "afx": [CHAINS[2], CHAINS[6]],
                            "clips": [{"file": s, "in": 0, "length": 1, "at": 0, "afx": [CHAINS[4]]}]}]}
        doc = json.loads(json.dumps(tio.rebuild(tio.new_doc("t", FPS), edit, may_use=lambda p: True)))
        back = tio.editable(doc)
        fx = get("audio_fx")
        self.assertEqual(back["clips"][0]["afx"], fx.clean_chain([CHAINS[0]]))
        self.assertEqual([f["type"] for f in back["tracks"][0]["afx"]], ["limit", "pan"])
        self.assertEqual(back["tracks"][0]["clips"][0]["afx"][0]["type"], "delay")
        # The bed's (A1) effects ride on the first sound track.
        edit2 = {"clips": [{"ref": 0, "in": 0, "length": 2, "transition": 0}], "texts": [], "afx": {"A1": [CHAINS[5]]}}
        back = tio.editable(json.loads(json.dumps(tio.rebuild(doc, edit2, may_use=lambda p: True))))
        self.assertEqual([f["type"] for f in back["afx"]["A1"]], ["gain"])
        # Taken off: gone.
        edit3 = {"clips": [{"ref": 0, "in": 0, "length": 2, "transition": 0, "afx": []}], "texts": []}
        back = tio.editable(json.loads(json.dumps(tio.rebuild(doc, edit3, may_use=lambda p: True))))
        self.assertNotIn("afx", back["clips"][0])


def tone(freq, seconds=1.0, amp=0.5):
    t = np.arange(int(seconds * RATE)) / RATE
    x = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.stack([x, x])


def rms(x, a=0.2, b=None):
    seg = x[..., int(a * RATE):int(b * RATE) if b else None]
    return float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))


@unittest.skipIf(av is None, "needs PyAV")
class EachEffectRendered(unittest.TestCase):
    """Each effect run through the render's own path (ffmpeg filters in PyAV, numpy) on a test tone."""

    def setUp(self):
        self.fx = _mods()("audio_fx")

    def run_fx(self, x, *chain):
        return self.fx.apply_chain(x, list(chain))

    def test_eq_a_peak_lifts_its_band_and_the_pass_filters_cut(self):
        x = tone(1000, amp=0.25)
        y = self.run_fx(x, {"type": "eq", "p": {"pk_f": 1000, "pk_g": 6, "pk_q": 1}})
        self.assertAlmostEqual(rms(y) / rms(x), 10 ** (6 / 20), delta=0.05)
        low = tone(100)
        self.assertLess(rms(self.run_fx(low, {"type": "eq", "p": {"hp": 1000}})) / rms(low), 0.03)
        high = tone(8000)
        self.assertLess(rms(self.run_fx(high, {"type": "eq", "p": {"lp": 500}})) / rms(high), 0.03)
        # A shelf of +6 dB, well inside it: about twice.
        self.assertAlmostEqual(rms(self.run_fx(low, {"type": "eq", "p": {"ls_f": 500, "ls_g": 6}})) / rms(low), 2.0, delta=0.15)

    def test_the_limiter_holds_the_ceiling_and_the_compressor_brings_it_down(self):
        x = tone(440, amp=0.9)
        y = self.run_fx(x, {"type": "limit", "p": {"ceil": -12, "rel": 50}})
        self.assertLessEqual(float(np.abs(y[:, int(0.1 * RATE):]).max()), 10 ** (-12 / 20) * 1.02)
        c = self.run_fx(x, {"type": "comp", "p": {"thr": -20, "ratio": 4, "att": 5, "rel": 50, "knee": 0}})
        self.assertLess(rms(c) / rms(x), 0.5)
        # Make-up gives some of it back.
        m = self.run_fx(x, {"type": "comp", "p": {"thr": -20, "ratio": 4, "att": 5, "rel": 50, "knee": 0, "makeup": 6}})
        self.assertAlmostEqual(rms(m) / rms(c), 2.0, delta=0.1)

    def test_reverb_and_delay_and_their_keyed_mix(self):
        x = np.zeros((2, RATE), dtype=np.float32)
        x[:, 0] = 1.0
        d = self.run_fx(x, {"type": "delay", "p": {"time": 250, "fb": 0.5, "mix": 0.5}})
        k = int(0.25 * RATE)
        self.assertAlmostEqual(float(d[0, 0]), 0.5, places=5)          # dry, at half
        self.assertAlmostEqual(float(d[0, k]), 0.5, places=5)          # the echo
        self.assertAlmostEqual(float(d[0, 2 * k]), 0.25, places=5)     # fed back
        r = self.run_fx(x, {"type": "reverb", "p": {"preset": "room", "mix": 1, "decay": 0.8, "pre": 20}})
        self.assertLess(float(np.abs(r[:, :int(0.019 * RATE)]).max()), 1e-6)   # the pre-delay
        self.assertGreater(rms(r, 0.03, 0.2), 1e-4)                    # the tail
        self.assertGreater(rms(r, 0.03, 0.2), rms(r, 0.6, 0.8) * 5)    # falling
        # The mix keyed from 0 to 1: dry at the start, wet at the end.
        t = tone(440, 1.0)
        keyed = self.run_fx(t, {"type": "delay", "p": {"time": 50, "fb": 0}, "keys": {"mix": [{"t": 0, "v": 0}, {"t": 1, "v": 1}]}})
        self.assertAlmostEqual(rms(keyed, 0.0, 0.05) / rms(t, 0.0, 0.05), 1.0, delta=0.15)

    def test_gain_and_pan(self):
        x = tone(440)
        self.assertAlmostEqual(rms(self.run_fx(x, {"type": "gain", "p": {"gain": -6}})) / rms(x), 10 ** (-6 / 20), places=3)
        y = self.run_fx(x, {"type": "pan", "p": {"pan": 1}})
        self.assertLess(rms(y[0:1]), 1e-6)
        self.assertAlmostEqual(rms(y[1:2]) / rms(x[1:2]), 2.0, places=3)        # both sides into the right, as WebAudio does
        z = self.run_fx(x, {"type": "pan", "p": {"pan": 0}})
        self.assertAlmostEqual(rms(z[0:1]) / rms(x[0:1]), 1.0, places=5)
        # A bypassed effect does nothing.
        self.assertTrue(np.allclose(self.run_fx(x, {"type": "gain", "on": False, "p": {"gain": -20}}), x))


def tone_film(path, seconds, freq, amp=0.5):
    with av.open(path, "w") as out:
        vs = out.add_stream("libx264" if "libx264" in av.codecs_available else "mpeg4", rate=FPS)
        vs.width, vs.height, vs.pix_fmt = 64, 32, "yuv420p"
        aus = out.add_stream("aac", rate=RATE)
        aus.layout = "mono"
        for i in range(int(seconds * FPS)):
            vf = av.VideoFrame.from_ndarray(np.full((32, 64, 3), 90, dtype=np.uint8), format="rgb24")
            vf.pts = i
            for pkt in vs.encode(vf):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)
        x = tone(freq, seconds, amp)[0]
        for k in range(0, x.size, 1024):
            af = av.AudioFrame.from_ndarray(x[k:k + 1024].reshape(1, -1), format="flt", layout="mono")
            af.sample_rate = RATE
            af.pts = k
            for pkt in aus.encode(af):
                out.mux(pkt)
        for pkt in aus.encode():
            out.mux(pkt)


def sound_of(path):
    chunks = []
    with av.open(path) as src:
        res = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        for frame in src.decode(src.streams.audio[0]):
            for piece in res.resample(frame):
                chunks.append(piece.to_ndarray().reshape(-1))
    return np.concatenate(chunks)


@unittest.skipIf(av is None, "needs PyAV")
class TheCutRendered(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        get = _mods()
        cls.tio, cls.tr, cls.rx = get("timeline_io"), get("timeline_render"), get("resolve_export")
        cls.tmp = tempfile.mkdtemp()
        cls.a = os.path.join(cls.tmp, "a.mp4").replace("\\", "/")
        cls.s = os.path.join(cls.tmp, "s.mp4").replace("\\", "/")
        tone_film(cls.a, 3.0, 440, 0.25)
        tone_film(cls.s, 3.0, 660, 0.4)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def doc(self, edit):
        return self.tio.rebuild(self.tio.new_doc("t", FPS), {"texts": [], **edit}, may_use=lambda p: True)

    def render(self, edit, name):
        out = os.path.join(self.tmp, name + ".mp4")
        self.tr.render(self.doc(edit), out, "mp4")
        return sound_of(out)

    def test_a_tone_through_a_clips_eq_and_limiter(self):
        clip = {"file": self.a, "name": "a", "in": 0, "length": 2, "transition": 0}
        dry = self.render({"clips": [clip]}, "dry")
        wet = self.render({"clips": [{**clip, "afx": [{"type": "eq", "p": {"pk_f": 440, "pk_g": 12, "pk_q": 1}},
                                                       {"type": "limit", "p": {"ceil": -9, "rel": 50}}]}]}, "wet")
        lvl = lambda x: float(np.abs(x[int(0.3 * RATE):int(1.7 * RATE)]).max())   # noqa: E731
        self.assertAlmostEqual(lvl(dry), 0.25, delta=0.03)
        # The mono tone is in both channels at 0.25 / sqrt 2, read back as mono times sqrt 2. +12 dB would be four
        # times: the limiter holds each channel at -9 dB (0.355).
        self.assertLessEqual(lvl(wet), 10 ** (-9 / 20) * math.sqrt(2) * 1.05)
        self.assertGreater(lvl(wet), lvl(dry) * 1.5)

    def test_a_tracks_effects_work_on_its_clips_after_theirs(self):
        v1 = [{"file": self.a, "name": "a", "in": 0, "length": 2, "transition": 0, "volume": 0}]
        a2 = {"id": "A2", "kind": "audio", "name": "A2", "afx": [{"type": "gain", "p": {"gain": -6}}],
              "clips": [{"file": self.s, "name": "s", "at": 0, "in": 0, "length": 2, "afx": [{"type": "gain", "p": {"gain": -6}}]}]}
        x = self.render({"clips": v1, "tracks": [a2]}, "track")
        rmsx = float(np.sqrt(np.mean(x[int(0.3 * RATE):int(1.7 * RATE)] ** 2)))
        self.assertAlmostEqual(rmsx / (0.4 / math.sqrt(2)), 10 ** (-12 / 20), delta=0.03)

    def test_the_resolve_export_bakes_the_effects_and_keeps_the_dry_originals_muted(self):
        folder = tempfile.mkdtemp(dir=self.tmp)
        otio = os.path.join(folder, "cut.otio")
        edit = {"clips": [{"file": self.a, "name": "a", "in": 0, "length": 2, "transition": 0}], "texts": [],
                "tracks": [{"id": "A2", "kind": "audio", "name": "A2", "afx": [{"type": "gain", "p": {"gain": -6}}],
                            "clips": [{"file": self.s, "name": "s", "at": 0.5, "in": 0, "length": 1}]}]}
        self.tio.save(otio, edit, "", lambda p: True, "cut")
        doc = self.tio._load(otio)
        plan = self.rx.make_plan(doc, otio)
        self.assertTrue(plan["afx"])
        self.assertEqual(plan["bake"], ["A2"])
        off = self.rx.make_plan(doc, otio, bake=False)
        self.assertEqual(off["bake"], [])
        job = self.rx.Job(doc, plan)
        job.run()
        self.assertEqual(job.status, "done", job.error)
        media = os.path.join(plan["path"], "media")
        self.assertIn("A2_fx.wav", os.listdir(media))
        baked = sound_of(os.path.join(media, "A2_fx.wav"))
        rmsb = float(np.sqrt(np.mean(baked[int(0.7 * RATE):int(1.3 * RATE)] ** 2)))
        self.assertAlmostEqual(rmsb / (0.4 / math.sqrt(2)), 0.5, delta=0.04)            # the -6 dB baked in
        self.assertLess(float(np.abs(baked[:int(0.4 * RATE)]).max()), 0.01)             # only A2: silent before its clip
        root = ET.parse(os.path.join(plan["path"], plan["name"] + ".fcpxml")).getroot()
        clips = {e.get("name"): e for e in root.iter("asset-clip")}
        self.assertIn("A2 (fx)", clips)
        self.assertNotIn("enabled", clips["A2 (fx)"].attrib)
        dry = [e for e in root.iter("asset-clip") if e.get("audioRole") == "A2 (dry)"]
        self.assertEqual(len(dry), 1)
        self.assertEqual(dry[0].get("enabled"), "0")
        self.assertTrue(dry[0].get("name").endswith("(dry)"))
        self.assertNotEqual(dry[0].get("lane"), clips["A2 (fx)"].get("lane"))
        self.assertIn("Baked: A2", open(os.path.join(plan["path"], "README.txt"), encoding="utf-8").read())
        # No effect is named in the timeline.
        text = open(os.path.join(plan["path"], plan["name"] + ".fcpxml"), encoding="utf-8").read()
        self.assertNotIn("Fairlight", text)


if __name__ == "__main__":
    unittest.main()
