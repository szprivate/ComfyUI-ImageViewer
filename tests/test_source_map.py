"""A marked range of the cut, in the sources: timeline_io.source_map (what /imageviewer/cut answers as
``marked`` and agentY's edit_cut / get_viewer_state hand the agent).

The user marks an in and an out on the Edit tab's timeline (film frames) and asks for the shot
inside it made again; the agent needs the file and ITS frames. Covered: a plain clip, one with
a source in point, retimed 2x and 0.5x, looped and ping-ponged, a clip cut in two (the blade),
a source at another frame rate than the cut, a range over two clips, a clip of V2 over V1, a
switched-off clip, stills and titles. The parity test runs the Edit tab's own arithmetic
(imageViewer_editTimelineData.js: pictureAt, srcLocal) under node and checks, frame by frame,
that the clip on screen and the source moment it shows are what source_map works from; skipped
without node.

Run: python -m unittest tests.test_source_map
"""
import importlib
import json
import os
import shutil
import subprocess
import sys
import types
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _tio():
    name = "imageviewer_srcmap_under_test"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules[name] = pkg
    return importlib.import_module(name + ".timeline_io")


tio = _tio()


def clip(file, length, at_in=0.0, **extra):
    return {"name": os.path.splitext(file)[0], "file": file, "in": at_in, "length": length, "transition": 0.0, **extra}


def cut(clips, tracks=None, fps=24.0, **extra):
    return {"name": "t", "fps": fps, "clips": clips, "tracks": tracks or [], **extra}


def only(m, **want):
    got = [p for p in m["pieces"] if all(p.get(k) == v for k, v in want.items())]
    assert len(got) == 1, (want, m["pieces"])
    return got[0]


class SourceMapTests(unittest.TestCase):

    def test_plain_clip_from_its_start(self):
        e = cut([clip("a.mp4", 2.0)])
        p = only(tio.source_map(e, 12, 35, {"a.mp4": 24}), clip=1)
        self.assertEqual((p["rec_in"], p["rec_out"], p["rec_frames"]), (12, 35, 24))
        self.assertEqual((p["src_in"], p["src_out"], p["src_frames"]), (12, 35, 24))
        self.assertAlmostEqual(p["src_in_s"], 0.5)
        self.assertAlmostEqual(p["src_out_s"], 1.5)
        self.assertAlmostEqual(p["src_seconds"], 1.0)
        self.assertEqual((p["src_first_shown"], p["src_last_shown"]), (12, 35))
        self.assertFalse(p["whole_clip"])
        self.assertTrue(p["src_fps_known"])

    def test_source_in_point_and_the_clip_later_in_the_film(self):
        # The bug's own shape: the second shot of the cut starts 83 frames into a multi-shot file.
        e = cut([clip("a.mp4", 2.0), clip("multi.mp4", 32 / 24, at_in=83 / 24)])
        m = tio.source_map(e, 48, 79, {"multi.mp4": 24, "a.mp4": 24})
        self.assertEqual(len(m["pieces"]), 1)
        p = m["pieces"][0]
        self.assertEqual((p["clip"], p["rec_in"], p["rec_out"]), (2, 48, 79))
        self.assertEqual((p["src_in"], p["src_out"]), (83, 114))
        self.assertTrue(p["whole_clip"])
        # Only part of it marked: the source frames move with it.
        p = only(tio.source_map(e, 52, 75, {"multi.mp4": 24}), clip=2)
        self.assertEqual((p["src_in"], p["src_out"], p["src_frames"]), (87, 110, 24))
        self.assertAlmostEqual(p["src_in_s"], 87 / 24, places=3)

    def test_twice_as_fast_runs_over_two_source_frames_a_frame(self):
        e = cut([clip("a.mp4", 1.0, at_in=1.0, speed=2.0)])
        p = only(tio.source_map(e, 0, 11, {"a.mp4": 24}), clip=1)
        self.assertEqual((p["src_in"], p["src_out"], p["src_frames"]), (24, 47, 24))
        self.assertAlmostEqual(p["src_in_s"], 1.0)
        self.assertAlmostEqual(p["src_out_s"], 2.0)
        self.assertEqual(p["speed"], 2.0)
        self.assertEqual(p["src_first_shown"], 25)     # mid-frame: 1 s + 0.5/24 s * 2

    def test_half_speed_runs_over_one_source_frame_every_two(self):
        e = cut([clip("a.mp4", 2.0, speed=0.5)])
        p = only(tio.source_map(e, 0, 47, {"a.mp4": 24}), clip=1)
        self.assertEqual((p["rec_frames"], p["src_in"], p["src_out"], p["src_frames"]), (48, 0, 23, 24))
        self.assertAlmostEqual(p["src_seconds"], 1.0)

    def test_a_source_at_another_frame_rate(self):
        e = cut([clip("thirty.mp4", 1.0, at_in=2.0)])
        p = only(tio.source_map(e, 0, 23, {"thirty.mp4": 30}), clip=1)
        self.assertEqual((p["fps"], p["src_fps"]), (24.0, 30.0))
        self.assertEqual((p["src_in"], p["src_out"], p["src_frames"]), (60, 89, 30))
        # Unknown rate: the cut's, and said.
        q = only(tio.source_map(e, 0, 23), clip=1)
        self.assertFalse(q["src_fps_known"])
        self.assertEqual((q["src_in"], q["src_out"]), (48, 71))
        self.assertAlmostEqual(q["src_in_s"], 2.0)       # the seconds do not depend on it

    def test_a_25_fps_cut(self):
        e = cut([clip("a.mp4", 2.0, at_in=1.0)], fps=25.0)
        p = only(tio.source_map(e, 25, 49, {"a.mp4": 50}), clip=1)
        self.assertAlmostEqual(p["rec_in_s"], 1.0)
        self.assertEqual((p["src_in"], p["src_out"]), (100, 149))

    def test_a_loop_runs_its_turn_again(self):
        e = cut([clip("a.mp4", 2.0, at_in=1.0, loop="loop", span=0.5)])
        p = only(tio.source_map(e, 0, 47, {"a.mp4": 24}), clip=1)
        self.assertEqual(p["loop"], "loop")
        self.assertEqual(len(p["runs"]), 4)
        self.assertEqual((p["src_in"], p["src_out"], p["src_frames"]), (24, 35, 12))
        for k, r in enumerate(p["runs"]):
            self.assertEqual((r["rec_in"], r["rec_out"]), (12 * k, 12 * k + 11))
            self.assertEqual((r["src_in"], r["src_out"], r["backwards"]), (24, 35, False))
        # A range inside the second turn only.
        p = only(tio.source_map(e, 15, 20, {"a.mp4": 24}), clip=1)
        self.assertEqual((p["src_in"], p["src_out"]), (27, 32))

    def test_a_ping_pong_comes_back(self):
        e = cut([clip("a.mp4", 1.0, loop="pingpong", span=0.5)])
        p = only(tio.source_map(e, 0, 23, {"a.mp4": 24}), clip=1)
        self.assertEqual([r["backwards"] for r in p["runs"]], [False, True])
        self.assertEqual([(r["src_in"], r["src_out"]) for r in p["runs"]], [(0, 11), (0, 11)])
        self.assertEqual(p["src_last_shown"], 0)

    def test_a_clip_cut_in_two_gives_two_pieces_of_one_file(self):
        e = cut([clip("a.mp4", 1.0), clip("a.mp4", 1.0, at_in=1.0)])
        m = tio.source_map(e, 12, 35, {"a.mp4": 24})
        self.assertEqual([(p["clip"], p["rec_in"], p["rec_out"], p["src_in"], p["src_out"]) for p in m["pieces"]],
                         [(1, 12, 23, 12, 23), (2, 24, 35, 24, 35)])

    def test_a_range_over_two_clips(self):
        e = cut([clip("a.mp4", 1.0, at_in=3.0), clip("b.mp4", 1.0, at_in=0.5)])
        m = tio.source_map(e, 18, 29, {"a.mp4": 24, "b.mp4": 24})
        a, b = m["pieces"]
        self.assertEqual((a["file"], a["rec_in"], a["rec_out"], a["src_in"], a["src_out"]), ("a.mp4", 18, 23, 90, 95))
        self.assertEqual((b["file"], b["rec_in"], b["rec_out"], b["src_in"], b["src_out"]), ("b.mp4", 24, 29, 12, 17))
        self.assertEqual((m["start"], m["end"], m["frames"]), (18, 29, 12))

    def test_gaps_and_dissolves_move_the_clips(self):
        # 0.5 s of empty time before the first clip; a 0.5 s dissolve into the second (editable's form:
        # the second clip begins 0.5 s before the first ends).
        e = cut([clip("a.mp4", 1.0, gap=0.5), clip("b.mp4", 1.0, at_in=0.0, transition=0.5)])
        m = tio.source_map(e, 0, 59, {"a.mp4": 24, "b.mp4": 24})
        a = only(m, file="a.mp4")
        b = only(m, file="b.mp4")
        self.assertEqual((a["rec_in"], a["rec_out"], a["src_in"]), (12, 35, 0))
        self.assertEqual((b["rec_in"], b["rec_out"], b["src_in"], b["src_out"]), (24, 47, 0, 23))

    def test_a_clip_of_v2_lies_over_v1(self):
        e = cut([clip("a.mp4", 2.0)],
                tracks=[{"id": "V2", "kind": "video", "clips": [clip("over.mp4", 0.5, at_in=1.0, at=0.5)]},
                        {"id": "A2", "kind": "audio", "clips": [clip("vo.wav", 2.0, at=0.0)]}])
        m = tio.source_map(e, 0, 47, {"a.mp4": 24, "over.mp4": 24})
        self.assertEqual([p["track"] for p in m["pieces"]], ["V1", "V2"])   # no sound track
        v1, v2 = m["pieces"]
        self.assertEqual(v1["covered_by"], ["V2:1"])
        self.assertNotIn("covered_by", v2)
        self.assertEqual((v2["rec_in"], v2["rec_out"], v2["src_in"], v2["src_out"]), (12, 23, 24, 35))

    def test_switched_off_stills_and_titles(self):
        e = cut([clip("a.mp4", 1.0, disabled=True), clip("still.png", 1.0)],
                tracks=[{"id": "V2", "kind": "video", "clips": [
                    {"name": "", "file": "", "in": 0.0, "length": 1.0, "at": 1.0, "title": {"text": "Hello\nthere"}}]},
                        {"id": "V3", "kind": "video", "off": True, "clips": [clip("hidden.mp4", 2.0, at=0.0)]}])
        m = tio.source_map(e, 0, 47)
        self.assertEqual([p["file"] for p in m["pieces"]], ["still.png", ""])
        still, title = m["pieces"]
        self.assertTrue(still["still"])
        self.assertNotIn("src_in", still)
        self.assertTrue(title["title"])
        self.assertEqual(title["name"], 'title "Hello"')
        self.assertNotIn("covered_by", still)            # a title is laid over, it hides nothing

    def test_the_range_is_held_to_the_film(self):
        e = cut([clip("a.mp4", 1.0)])
        m = tio.source_map(e, 30, -5, {"a.mp4": 24})
        self.assertEqual((m["start"], m["end"]), (0, 23))
        self.assertEqual(m["end_s"], 1.0)

    def test_read_from_an_otio_file(self):
        # A cut written the way the panel saves it reads back to the same map (speed in metadata.imageviewer).
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            media = os.path.join(td, "a.mp4").replace("\\", "/")
            open(media, "wb").close()
            edit = cut([clip(media, 1.0, at_in=2.0, speed=2.0, volume=1.0, color="", fx={})])
            path = os.path.join(td, "c.otio")
            tio.save(path, edit, "2026-11-03T00:00:00+00:00", may_use=lambda _p: True, create="c")
            back = tio.read_editable(path)
            p = only(tio.source_map(back, 0, 23, {back["clips"][0]["file"]: 24}), clip=1)
        self.assertEqual((p["speed"], p["src_in"], p["src_out"], p["src_fps_known"]), (2.0, 48, 95, True))

    def test_the_render_reads_the_same_moments(self):
        tr_name = "imageviewer_srcmap_under_test.timeline_render"
        try:
            tr = importlib.import_module(tr_name)
        except ImportError as exc:  # pragma: no cover - numpy / av missing in this interpreter
            self.skipTest(f"timeline_render does not import here ({exc})")
        self.assertIs(tr.source_moment, tio.source_moment)


CASES = [
    cut([clip("a.mp4", 2.0), clip("multi.mp4", 32 / 24, at_in=83 / 24)]),
    cut([clip("a.mp4", 1.0, at_in=1.0, speed=2.0), clip("b.mp4", 2.0, speed=0.5)]),
    cut([clip("a.mp4", 2.0, at_in=1.0, loop="loop", span=0.5), clip("b.mp4", 1.0, loop="pingpong", span=0.4, speed=1.5)]),
    cut([clip("a.mp4", 1.0), clip("a.mp4", 1.0, at_in=1.0), clip("c.mp4", 1.0, gap=0.25)]),
    cut([clip("a.mp4", 1.5), clip("b.mp4", 1.0, transition=0.5)]),
    cut([clip("a.mp4", 2.0)], tracks=[{"id": "V2", "kind": "video",
                                       "clips": [clip("over.mp4", 0.5, at_in=1.0, at=0.5, speed=1.25)]}]),
    cut([clip("a.mp4", 1.2, at_in=0.3)], fps=25.0),
]
RATES = {"a.mp4": 24, "b.mp4": 30, "multi.mp4": 24, "c.mp4": 25, "over.mp4": 60}


@unittest.skipIf(shutil.which("node") is None, "needs node")
class EditTabParityTests(unittest.TestCase):
    """Frame by frame, the Edit tab (pictureAt, srcLocal) and source_map agree on the clip on
    screen and the source frame it shows."""

    def test_frame_by_frame(self):
        jobs = []
        for e in CASES:
            total = int(round(tio.edit_length(e) * e["fps"]))
            jobs.append({"cut": e, "start": 0, "end": total - 1})
        res = subprocess.run(["node", os.path.join(ROOT, "tests", "harness", "source_map_js.mjs")], input=json.dumps(jobs),
                             capture_output=True, text=True, timeout=60, cwd=ROOT)
        self.assertEqual(res.returncode, 0, res.stderr)
        for e, job, frames in zip(CASES, jobs, json.loads(res.stdout)):
            fps = e["fps"]
            m = tio.source_map(e, job["start"], job["end"], RATES)
            layers = {f"{t}:{n - 1}": (c, at) for _r, t, n, c, at in tio._picture_layers(e)}
            for fr in frames:
                f = fr["f"]
                on = [p for p in m["pieces"] if p["rec_in"] <= f <= p["rec_out"]]
                if not fr["key"]:
                    self.assertEqual(on, [], f)
                    continue
                key = fr["key"]
                self.assertIn(key, [f"{p['track']}:{p['clip'] - 1}" for p in on], (e["clips"], f))
                c, at = layers[key]
                py = tio.source_moment(c, (f + 0.5) / fps - at)
                self.assertAlmostEqual(py, fr["local"], places=3, msg=(key, f))
                p = next(p for p in on if f"{p['track']}:{p['clip'] - 1}" == key)
                # The frame the tab shows lies inside the piece's source stretch.
                shown = int((fr["local"] + 1e-6) * p["src_fps"])
                self.assertTrue(p["src_in"] <= shown <= p["src_out"], (key, f, shown, p))
                if f == p["rec_in"]:
                    self.assertEqual(shown, p["src_first_shown"], (key, f))
                if f == p["rec_out"]:
                    self.assertEqual(shown, p["src_last_shown"], (key, f))


if __name__ == "__main__":
    unittest.main()
