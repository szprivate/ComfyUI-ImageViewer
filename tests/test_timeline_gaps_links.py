"""Gaps on V1 and a film's sound split off its picture: how timeline_io keeps them in the .otio and timeline_render plays them.

The file side needs nothing; the render side makes its clips with PyAV (ComfyUI's interpreter has it):
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_timeline_gaps_links
"""
import importlib
import json
import os
import shutil
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


def _modules():
    name = "imageviewer_gaps_under_test"
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


def rt(frames):
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": FPS, "value": frames}


def rng(start, length):
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(start), "duration": rt(length)}


class GapsAndLinksInTheFile(unittest.TestCase):
    def setUp(self):
        self.tio, _ = _modules()
        self.tmp = tempfile.mkdtemp()
        self.a, self.b = os.path.join(self.tmp, "a.mp4"), os.path.join(self.tmp, "b.mp4")
        for p in (self.a, self.b):
            open(p, "wb").close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self):
        return {"clips": [{"file": self.a, "name": "a", "in": 0, "length": 2, "transition": 0,
                           "link": "L1", "unlinked": True, "mute": True},
                          {"file": self.b, "name": "b", "in": 1, "length": 3, "transition": 0.5, "gap": 1.5}],
                "texts": [],
                "tracks": [{"id": "A2", "kind": "audio", "name": "A2", "off": False,
                            "clips": [{"file": self.a, "name": "a", "at": 0.5, "in": 0, "length": 2.5,
                                       "link": "L1", "unlinked": True}]}]}

    def test_the_bed_deleted_in_the_panel_goes_from_the_file_and_the_other_clips_stay(self):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), self.edit(), may_use=lambda p: True)
        bed = self.tio._track_of(doc, "audio")
        clip = lambda f: {"OTIO_SCHEMA": "Clip.2", "name": os.path.basename(f), "source_range": rng(0, 24), "metadata": {}, "effects": [], "markers": [],
                          "media_reference": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": f, "metadata": {}}}
        bed["children"] = [clip(self.a), clip(self.b)]
        names = lambda d: [s["name"] for s in self.tio.editable(json.loads(json.dumps(d)))["sound"]]
        self.assertEqual(names(doc), ["a.mp4", "b.mp4"])
        # Nothing said about it (an older caller, agentY): as it was.
        self.assertEqual(names(self.tio.rebuild(doc, self.edit(), may_use=lambda p: True)), ["a.mp4", "b.mp4"])
        kept = self.tio.editable(json.loads(json.dumps(doc)))["sound"][1:]
        self.assertEqual(names(self.tio.rebuild(doc, {**self.edit(), "sound": kept}, may_use=lambda p: True)), ["b.mp4"])
        self.assertEqual(names(self.tio.rebuild(doc, {**self.edit(), "sound": []}, may_use=lambda p: True)), [])

    def test_a_gap_is_an_otio_gap_and_comes_back(self):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), self.edit(), may_use=lambda p: True)
        v1 = doc["tracks"]["children"][0]["children"]
        self.assertEqual([c["OTIO_SCHEMA"] for c in v1], ["Clip.1", "Gap.1", "Clip.1"])   # no dissolve into a gap
        self.assertEqual(v1[1]["source_range"]["duration"]["value"], 36)
        back = self.tio.editable(json.loads(json.dumps(doc)))
        self.assertEqual([(c["in"], c["length"], c["transition"], c.get("gap", 0)) for c in back["clips"]],
                         [(0.0, 2.0, 0.0, 0), (1.0, 3.0, 0.0, 1.5)])
        self.assertEqual(self.tio.edit_length(back), 6.5)
        # The strip over the scrub bar reads it as a gap too.
        flat = self.tio.flatten(doc)
        self.assertEqual([v["kind"] for v in flat["video"]], ["clip", "gap", "clip"])
        self.assertEqual(flat["duration"], 6.5)

    def test_a_link_group_and_mute_are_in_metadata_imageviewer(self):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), self.edit(), may_use=lambda p: True)
        v = doc["tracks"]["children"][0]["children"][0]
        self.assertEqual(v["metadata"]["imageviewer"], {**v["metadata"]["imageviewer"], "link": "L1", "unlinked": True, "mute": True})
        sound = [t for t in doc["tracks"]["children"] if t["name"] == "A2"][0]["children"]
        self.assertEqual([c["OTIO_SCHEMA"] for c in sound], ["Gap.1", "Clip.1"])
        self.assertEqual(sound[1]["metadata"]["imageviewer"]["link"], "L1")
        self.assertEqual(sound[1]["media_reference"]["target_url"], v["media_reference"]["target_url"])   # one file
        back = self.tio.editable(doc)
        self.assertEqual({k: back["clips"][0].get(k) for k in ("link", "unlinked", "mute")},
                         {"link": "L1", "unlinked": True, "mute": True})
        a2 = back["tracks"][0]["clips"][0]
        self.assertEqual((a2["link"], a2["unlinked"], a2["at"], a2["length"]), ("L1", True, 0.5, 2.5))
        # Linked again: "unlinked" goes; muted no more: "mute" goes.
        edit = {"clips": [{"ref": 0, "in": 0, "length": 2, "transition": 0, "link": "L1", "unlinked": False, "mute": False},
                          {"ref": 2, "in": 1, "length": 3, "transition": 0, "gap": 0}], "texts": []}
        note = self.tio.rebuild(doc, edit, may_use=lambda p: True)["tracks"]["children"][0]["children"][0]["metadata"]["imageviewer"]
        self.assertEqual(note.get("link"), "L1")
        self.assertNotIn("unlinked", note)
        self.assertNotIn("mute", note)
        # A link name that is not one is left out.
        bad = self.tio.clip_link({"metadata": {"imageviewer": {"link": "<script>", "mute": "yes"}}})
        self.assertEqual(bad, {})

    def test_a_fade_to_or_from_black_of_another_program_is_read_as_a_cut(self):
        url = "file:///" + self.a.replace("\\", "/")
        clip = lambda s, n: {"OTIO_SCHEMA": "Clip.1", "name": "c", "source_range": rng(s, n),
                             "media_reference": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": url}}
        mix = {"OTIO_SCHEMA": "Transition.1", "in_offset": rt(6), "out_offset": rt(6)}
        gap = {"OTIO_SCHEMA": "Gap.1", "source_range": rng(0, 24)}
        doc = {"OTIO_SCHEMA": "Timeline.1", "name": "t", "tracks": {"OTIO_SCHEMA": "Stack.1", "children": [
            {"OTIO_SCHEMA": "Track.1", "kind": "Video", "children": [clip(0, 48), mix, gap, mix, clip(12, 24)]}]}}
        got = self.tio.editable(doc)["clips"]
        self.assertEqual([(c["in"], c["length"], c["transition"], c.get("gap", 0)) for c in got],
                         [(0.0, 2.0, 0.0, 0), (0.5, 1.0, 0.0, 1.0)])


AGENTY = os.path.join(ROOT, "..", "agentY", "src", "utils", "edit_timeline.py")


@unittest.skipUnless(os.path.isfile(AGENTY), "needs agentY beside the viewer")
class AgentYReadsIt(unittest.TestCase):
    """agentY's edit stage takes a cut back from the .otio (edit_timeline.from_otio): gaps closed, the split-off sound said."""

    def test_from_otio_closes_the_gap_and_says_what_it_did(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("agenty_edit_timeline_under_test", AGENTY)
        et = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(et)
        tio, _ = _modules()
        tmp = tempfile.mkdtemp()
        try:
            a, b = os.path.join(tmp, "a.mp4"), os.path.join(tmp, "b.mp4")
            for p in (a, b):
                open(p, "wb").close()
            edit = GapsAndLinksInTheFile.edit(type("E", (), {"a": a, "b": b})())
            doc = json.loads(json.dumps(tio.rebuild(tio.new_doc("t", FPS), edit, may_use=lambda p: True)))
            tl = et.from_otio(doc)
            self.assertEqual([(c["in"], c["out"], c["transition"]) for c in tl["clips"]], [(0.0, 2.0, 0.0), (1.0, 4.0, 0.0)])
            self.assertNotEqual(tl["clips"][0].get("volume"), 0.0)        # its sound clip is there: heard with the picture
            said = et.otio_dropped(doc)
            self.assertTrue(any("gap of 1.5s" in d for d in said), said)
            self.assertTrue(any("split off" in d and "+0.5s" in d for d in said), said)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def make_tone_clip(path, seconds, colour, fps=FPS, rate=48000):
    """A film of one colour with a 440 Hz tone all through it."""
    with av.open(path, "w") as out:
        vs = out.add_stream("libx264" if "libx264" in av.codecs_available else "mpeg4", rate=fps)
        vs.width, vs.height, vs.pix_fmt = 64, 32, "yuv420p"
        aus = out.add_stream("aac", rate=rate)
        aus.layout = "mono"
        for i in range(int(seconds * fps)):
            img = np.zeros((32, 64, 3), dtype=np.uint8)
            img[:] = colour
            vf = av.VideoFrame.from_ndarray(img, format="rgb24")
            vf.pts = i
            for pkt in vs.encode(vf):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)
        t = np.arange(int(seconds * rate)) / rate
        tone = (0.6 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        for k in range(0, tone.size, 1024):
            af = av.AudioFrame.from_ndarray(tone[k:k + 1024].reshape(1, -1), format="flt", layout="mono")
            af.sample_rate = rate
            af.pts = k
            for pkt in aus.encode(af):
                out.mux(pkt)
        for pkt in aus.encode():
            out.mux(pkt)


def frame_means(path):
    """Each frame of a film as its mean (r, g, b)."""
    out = []
    with av.open(path) as src:
        for frame in src.decode(src.streams.video[0]):
            out.append(frame.to_ndarray(format="rgb24").reshape(-1, 3).mean(axis=0))
    return out


def loudness(path, step=0.1):
    """The film's sound as RMS per `step` seconds."""
    chunks = []
    with av.open(path) as src:
        res = av.AudioResampler(format="flt", layout="mono", rate=48000)
        for frame in src.decode(src.streams.audio[0]):
            for piece in res.resample(frame):
                chunks.append(piece.to_ndarray().reshape(-1))
    x = np.concatenate(chunks)
    n = int(step * 48000)
    return [float(np.sqrt(np.mean(x[k:k + n] ** 2))) for k in range(0, len(x) - n + 1, n)]


@unittest.skipIf(av is None, "needs PyAV")
class GapsAndLinksRendered(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tio, cls.tr = _modules()
        cls.tmp = tempfile.mkdtemp()
        cls.red = os.path.join(cls.tmp, "red.mp4")
        make_tone_clip(cls.red, 3.0, (220, 20, 20))
        cls.blue = os.path.join(cls.tmp, "blue.png")
        from PIL import Image
        Image.new("RGB", (64, 32), (20, 20, 220)).save(cls.blue)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, edit, name):
        doc = self.tio.rebuild(self.tio.new_doc("t", FPS), {"texts": [], **edit}, may_use=lambda p: True)
        out = os.path.join(self.tmp, name + ".mp4")
        got = self.tr.render(doc, out, "mp4")
        return got, out

    def test_a_merged_clip_is_heard_once_and_a_split_one_once(self):
        # As loud as the film's own sound, in all three states: never that and the sound clip together.
        plain = {"clips": [{"file": self.red, "name": "a", "in": 0, "length": 2, "transition": 0}]}
        split = {"clips": [{**plain["clips"][0], "link": "L1", "unlinked": True, "mute": True}],
                 "tracks": [{"id": "A2", "kind": "audio", "name": "A2", "off": False,
                             "clips": [{"file": self.red, "name": "a", "at": 0, "in": 0, "length": 2, "link": "L1", "unlinked": True}]}]}
        merged = {"clips": plain["clips"], "tracks": [{**split["tracks"][0], "clips": []}]}
        relinked = {"clips": [{**plain["clips"][0], "link": "L1", "mute": True}],
                    "tracks": [{**split["tracks"][0], "clips": [{**split["tracks"][0]["clips"][0], "unlinked": False}]}]}
        level = lambda edit, name: sum(loudness(self.render(edit, name)[1])[2:15]) / 13
        once = level(plain, "once")
        self.assertGreater(once, 0.05)
        for edit, name in ((split, "split"), (merged, "merged"), (relinked, "relinked")):
            self.assertAlmostEqual(level(edit, name) / once, 1.0, delta=0.1, msg=name)

    def test_a_gap_on_v1_renders_black_or_the_track_over_it(self):
        clips = [{"file": self.red, "name": "a", "in": 0, "length": 1, "transition": 0},
                 {"file": self.red, "name": "b", "in": 1, "length": 1, "transition": 0, "gap": 1}]
        got, out = self.render({"clips": clips}, "gap")
        self.assertEqual(got["frames"], 72)
        means = frame_means(out)
        self.assertGreater(means[12][0], 150)                     # red
        self.assertLess(max(means[30]), 12)                       # the gap: black
        self.assertLess(max(means[44]), 12)
        self.assertGreater(means[60][0], 150)
        over = {"clips": clips, "tracks": [{"id": "V2", "kind": "video", "name": "V2", "off": False,
                                            "clips": [{"file": self.blue, "name": "p", "at": 1, "in": 0, "length": 1}]}]}
        _got, out = self.render(over, "gap_over")
        means = frame_means(out)
        self.assertGreater(means[36][2], 150)                     # what the higher track shows
        self.assertLess(means[36][0], 60)
        # The sound of the gap is silence.
        loud = loudness(out)
        self.assertGreater(loud[3], 0.1)
        self.assertLess(loud[14], 0.01)
        self.assertGreater(loud[25], 0.1)

    def test_a_detached_sound_plays_at_its_own_place_and_the_film_is_muted(self):
        edit = {"clips": [{"file": self.red, "name": "a", "in": 0, "length": 2, "transition": 0,
                           "link": "L1", "unlinked": True, "mute": True}],
                "tracks": [{"id": "A2", "kind": "audio", "name": "A2", "off": False,
                            "clips": [{"file": self.red, "name": "a", "at": 0.8, "in": 0, "length": 1.2,
                                       "link": "L1", "unlinked": True}]}]}
        got, out = self.render(edit, "lcut")
        self.assertTrue(got["sound"])
        loud = loudness(out)
        self.assertTrue(all(v < 0.01 for v in loud[:7]), loud[:8])    # 0 .. 0.7 s: the film's own sound is muted
        self.assertTrue(all(v > 0.1 for v in loud[9:19]), loud[8:20])  # 0.8 .. 2 s: the sound clip
        # Not muted, and no sound clip: the film's own sound from the start.
        plain = {"clips": [{"file": self.red, "name": "a", "in": 0, "length": 2, "transition": 0}]}
        _got, out = self.render(plain, "plain")
        self.assertGreater(loudness(out)[1], 0.1)


if __name__ == "__main__":
    unittest.main()
