"""Retime and loop: what timeline_render makes of a clip's speed and loop, and how timeline_io keeps them.

A clip is made here with PyAV whose frame k is grey level 8*k (so a rendered frame says which source frame it
shows), rendered through the real timeline_render, and read back. Needs PyAV (ComfyUI's interpreter has it):
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_timeline_retime_loop
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
N = 24          # frames in the source
FPS = 24


def _modules():
    name = "bepic_retime_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [ROOT]
        sys.modules[name] = pkg
    tio = importlib.import_module(name + ".timeline_io")
    tr = importlib.import_module(name + ".timeline_render")
    return tio, tr


def make_counter(path, frames=N, fps=FPS):
    """Frame k is grey 8*k all over (k < 32); a 440 Hz tone under it."""
    with av.open(path, "w") as out:
        vs = out.add_stream("libx264" if "libx264" in av.codecs_available else "mpeg4", rate=fps,
                            options={"crf": "0"} if "libx264" in av.codecs_available else {})
        vs.width, vs.height, vs.pix_fmt = 64, 32, "yuv420p"
        for i in range(frames):
            img = np.full((32, 64, 3), 8 * i, dtype=np.uint8)
            vf = av.VideoFrame.from_ndarray(img, format="rgb24")
            vf.pts = i
            for pkt in vs.encode(vf):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)


def read_levels(path):
    """The source frame each frame of a film shows (its grey / 8, rounded)."""
    out = []
    with av.open(path) as src:
        for frame in src.decode(src.streams.video[0]):
            out.append(int(round(float(frame.to_ndarray(format="rgb24").mean()) / 8.0)))
    return out


def doc_of(tio, clip, length):
    """An OTIO timeline of one clip, saved through timeline_io as the panel saves it."""
    doc = tio.new_doc("t", FPS)
    edit = {"clips": [{"file": clip["file"], "name": "c", "in": clip.get("in", 0), "length": length, "transition": 0,
                       "speed": clip.get("speed", 1), "loop": clip.get("loop", ""), "span": clip.get("span", 0)}],
            "texts": []}
    return tio.rebuild(doc, edit, may_use=lambda p: True)


@unittest.skipIf(av is None, "needs PyAV")
class RetimeLoopRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.src = os.path.join(cls.tmp, "counter.mp4")
        make_counter(cls.src)
        cls.tio, cls.tr = _modules()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, clip, length, name, frames=None):
        doc = doc_of(self.tio, {"file": self.src, **clip}, length)
        out = os.path.join(self.tmp, name + ".mp4")
        got = self.tr.render(doc, out, "mp4", frames=frames)
        return got, read_levels(out)

    def test_plain_clip_renders_each_source_frame_once(self):
        got, levels = self.render({}, N / FPS, "plain")
        self.assertEqual(got["frames"], N)
        self.assertEqual(levels, list(range(N)))

    def test_retimed_to_twice_the_length_repeats_each_frame_about_twice_in_order(self):
        got, levels = self.render({"speed": 0.5}, 2 * N / FPS, "slow")
        self.assertEqual(got["frames"], 2 * N)
        self.assertEqual(levels, sorted(levels), "in order")
        self.assertEqual(set(levels), set(range(N)), "every source frame shown")
        counts = [levels.count(k) for k in range(N)]
        self.assertTrue(all(1 <= c <= 3 for c in counts), counts)
        self.assertEqual(sum(counts), 2 * N)

    def test_retimed_to_half_the_length_plays_every_other_frame(self):
        got, levels = self.render({"speed": 2.0}, N / 2 / FPS, "fast")
        self.assertEqual(got["frames"], N // 2)
        self.assertEqual(levels, list(range(1, N, 2)))

    def test_a_clip_looped_twice_gives_2n_frames_the_source_twice(self):
        got, levels = self.render({"loop": "loop", "span": N / FPS}, 2 * N / FPS, "loop")
        self.assertEqual(got["frames"], 2 * N)
        self.assertEqual(levels, list(range(N)) * 2)

    def test_ping_pong_runs_back(self):
        got, levels = self.render({"loop": "pingpong", "span": N / FPS}, 2 * N / FPS, "pingpong")
        self.assertEqual(levels, list(range(N)) + list(range(N - 1, -1, -1)))

    def test_a_retimed_loop_loops_the_retimed_clip(self):
        got, levels = self.render({"loop": "loop", "span": N / FPS, "speed": 2.0}, N / FPS, "fastloop")
        self.assertEqual(levels, list(range(1, N, 2)) * 2)

    def test_the_in_out_range_only(self):
        got, levels = self.render({}, N / FPS, "range", frames=[5, 9])
        self.assertEqual(got["frames"], 5)
        self.assertEqual(levels, [5, 6, 7, 8, 9])


@unittest.skipIf(av is None, "needs PyAV")
class RetimeLoopFileTests(unittest.TestCase):
    def test_speed_and_loop_round_trip_with_a_linear_time_warp(self):
        tio, _tr = _modules()
        tmp = tempfile.mkdtemp()
        try:
            src = os.path.join(tmp, "c.mp4")
            open(src, "wb").close()
            doc = doc_of(tio, {"file": src, "in": 0.5, "speed": 0.5, "loop": "pingpong", "span": 1.0}, 4.0)
            item = doc["tracks"]["children"][0]["children"][0]
            warp = [fx for fx in item["effects"] if fx["OTIO_SCHEMA"] == "LinearTimeWarp.1"]
            self.assertEqual(warp[0]["time_scalar"], 0.5)
            self.assertEqual(item["metadata"]["bepic"]["loop"], "pingpong")
            # source_range: its start in the source, its duration on the timeline - what a plain reader plays.
            self.assertEqual(item["source_range"]["start_time"]["value"], 12)
            self.assertEqual(item["source_range"]["duration"]["value"], 96)
            clip = tio.editable(json.loads(json.dumps(doc)))["clips"][0]
            self.assertEqual((clip["speed"], clip["loop"], clip["span"], clip["in"], clip["length"]),
                             (0.5, "pingpong", 1.0, 0.5, 4.0))
            # Back to 100 %: the warp goes, and so does the loop.
            edit = {"clips": [{"ref": 0, "in": 0.5, "length": 1.0, "transition": 0, "speed": 1, "loop": "", "span": 0}],
                    "texts": []}
            plain = tio.rebuild(doc, edit, may_use=lambda p: True)
            item = plain["tracks"]["children"][0]["children"][0]
            self.assertFalse([fx for fx in item["effects"] if fx["OTIO_SCHEMA"] == "LinearTimeWarp.1"])
            self.assertNotIn("speed", item["metadata"]["bepic"])
            self.assertNotIn("loop", item["metadata"]["bepic"])
            # Another program's LinearTimeWarp is read as a speed.
            item["effects"].append({"OTIO_SCHEMA": "LinearTimeWarp.1", "name": "", "effect_name": "LinearTimeWarp",
                                    "metadata": {}, "time_scalar": 2.0})
            self.assertEqual(tio.editable(plain)["clips"][0]["speed"], 2.0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_dissolve_into_a_retimed_clip_keeps_its_in_point(self):
        tio, _tr = _modules()
        tmp = tempfile.mkdtemp()
        try:
            a, b = os.path.join(tmp, "a.mp4"), os.path.join(tmp, "b.mp4")
            for p in (a, b):
                open(p, "wb").close()
            doc = tio.new_doc("t", FPS)
            edit = {"clips": [{"file": a, "name": "a", "in": 0, "length": 3, "transition": 0},
                              {"file": b, "name": "b", "in": 1, "length": 3, "transition": 1, "speed": 2}], "texts": []}
            got = tio.editable(tio.rebuild(doc, edit, may_use=lambda p: True))["clips"][1]
            self.assertEqual((got["in"], got["length"], got["transition"], got["speed"]), (1.0, 3.0, 1.0, 2.0))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
