"""The Edit timeline's settings (size, frame rate, scaling): the file, the render and the Resolve export.

The file and FCPXML tests need nothing; the render tests make real clips with PyAV (ComfyUI's interpreter):
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_edit_timeline_settings
"""
import importlib
import os
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_resolve_export import _rx, clip, film  # noqa: E402
from test_edit_takes import _tio  # noqa: E402

try:
    import av
    import numpy as np
except ImportError:
    av = None


def _tr():
    _tio()
    return importlib.import_module("imageviewer_takes_tio_under_test.timeline_render")


def _write(path, w, h, fps, frames, color):
    """A film of one colour (an even size, so x264 takes it)."""
    with av.open(path, "w") as out:
        v = out.add_stream("libx264", rate=fps)
        v.width, v.height, v.pix_fmt = w, h, "yuv420p"
        for i in range(frames):
            arr = np.zeros((h, w, 3), dtype=np.uint8)
            arr[:, :] = color
            # Its frame number in the top left corner's green, to see which frame a film frame shows.
            arr[:4, :4, 1] = min(255, i * 10)
            for packet in v.encode(av.VideoFrame.from_ndarray(arr, format="rgb24")):
                out.mux(packet)
        for packet in v.encode():
            out.mux(packet)


class SettingsInTheFile(unittest.TestCase):
    def setUp(self):
        self.tio = _tio()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.file = os.path.join(self.tmp, "a.mp4").replace("\\", "/")
        open(self.file, "wb").close()

    def doc(self, settings=None, fps=24):
        edit = {"clips": [clip(self.file, 2.0)], "texts": []}
        if settings is not None:
            edit["settings"] = settings
        return self.tio.rebuild(self.tio.new_doc("cut", fps), edit, "", lambda p: True)

    def test_clean_settings_keeps_only_what_may_be(self):
        c = self.tio.clean_settings
        self.assertEqual(c({"fps": 25, "width": 1920, "height": 1080, "fit": "fill", "set_by": "hand"}),
                         {"fps": 25.0, "width": 1920, "height": 1080, "fit": "fill", "set_by": "hand"})
        self.assertEqual(c({"fps": -1, "width": 0, "height": 1080, "fit": "zoom", "set_by": "x"}), {})
        self.assertEqual(c({"fps": "abc", "width": "x"}), {})
        self.assertEqual(c(None), {})

    def test_the_settings_are_written_and_read_back(self):
        doc = self.doc({"fps": 25, "width": 1280, "height": 720, "fit": "fill", "set_by": "hand"})
        note = doc["metadata"]["imageviewer"]
        self.assertEqual((note["fps"], note["width"], note["height"], note["fit"], note["set_by"]), (25.0, 1280, 720, "fill", "hand"))
        edit = self.tio.editable(doc)
        self.assertEqual((edit["fps"], edit["width"], edit["height"], edit["fit"], edit["setBy"]), (25.0, 1280, 720, "fill", "hand"))
        # The clip's range is written at the timeline's rate.
        v1 = self.tio._track_of(doc, "video")
        self.assertEqual(v1["children"][0]["source_range"]["duration"]["rate"], 25.0)

    def test_a_new_rate_rewrites_every_range_and_wins_over_the_old_ones(self):
        doc = self.doc({"fps": 24})
        edit = self.tio.editable(doc)
        edit["settings"] = {"fps": 30}
        again = self.tio.rebuild(doc, edit, "", lambda p: True)
        self.assertEqual(self.tio.cut_rate(again), 30.0)
        self.assertEqual(self.tio.editable(again)["fps"], 30.0)
        self.assertAlmostEqual(self.tio.editable(again)["clips"][0]["length"], 2.0, 3)

    def test_an_edit_without_settings_keeps_the_files(self):
        doc = self.doc({"fps": 50, "width": 640, "height": 480})
        edit = self.tio.editable(doc)
        edit.pop("settings", None)
        again = self.tio.rebuild(doc, edit, "", lambda p: True)
        got = self.tio.editable(again)
        self.assertEqual((got["fps"], got["width"], got["height"], got["fit"]), (50.0, 640, 480, "fit"))

    def test_an_older_file_takes_its_size_from_agentys_note_and_its_rate_from_its_ranges(self):
        doc = self.doc(None, fps=25)
        doc["metadata"]["imageviewer"] = {"edited": ""}
        doc["metadata"]["agentY"] = {"width": 1024, "height": 576}
        got = self.tio.editable(doc)
        self.assertEqual((got["fps"], got["width"], got["height"], got["setBy"]), (25.0, 1024, 576, ""))

    def test_a_clips_own_scaling_is_kept_in_its_fx(self):
        self.assertEqual(self.tio.clean_fx({"fit": "none", "zx": 1}), {"fit": "none"})
        self.assertEqual(self.tio.clean_fx({"fit": "squash"}), {})


class SettingsInResolve(unittest.TestCase):
    def setUp(self):
        self.rx, self.tio = _rx(), _tio()

    def make(self, edit):
        with tempfile.TemporaryDirectory() as tmp:
            probes = {}
            for c in edit["clips"]:
                path = os.path.join(tmp, os.path.basename(c["file"])).replace("\\", "/")
                open(path, "wb").close()
                c["file"] = path
                probes[path] = film(width=1000, height=1000)
            doc = self.tio.rebuild(self.tio.new_doc("cut", 24), edit, "", lambda p: True)
            model = self.rx.build_model(doc, probes)
            uris = {self.tio.norm_path(p): self.rx.file_uri("D:/pkg/media/" + os.path.basename(p)) for p in model["files"]}
            return model, ET.fromstring(self.rx.fcpxml(model, probes, uris))

    def test_the_sequence_has_the_timelines_size_and_fill_and_none_are_a_conform(self):
        edit = {"clips": [clip("a.mp4", 2), clip("b.mp4", 2, fx={"fit": "none", "zx": 2, "zy": 2}), clip("c.mp4", 2, fx={"fit": "fit"})],
                "texts": [], "settings": {"fps": 25, "width": 1280, "height": 720, "fit": "fill"}}
        model, root = self.make(edit)
        self.assertEqual((model["width"], model["height"]), (1280, 720))
        fmt = root.find("resources/format[@id='r1']")
        self.assertEqual((fmt.get("width"), fmt.get("height")), ("1280", "720"))
        a, b, c = root.findall(".//spine/asset-clip")
        self.assertEqual(a.find("adjust-conform").get("type"), "fill")
        self.assertEqual([e.tag for e in b], ["adjust-conform", "adjust-transform"], "after the crop, before the transform")
        self.assertEqual(b.find("adjust-conform").get("type"), "none")
        self.assertIsNone(c.find("adjust-conform"), "fit is Resolve's own default")


@unittest.skipIf(av is None, "needs PyAV")
class SettingsInTheRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.square = os.path.join(cls.tmp, "square.mp4").replace("\\", "/")      # 32 x 32 red, 10 fps, 1 s
        cls.wide = os.path.join(cls.tmp, "wide.mp4").replace("\\", "/")          # 64 x 36 blue, 25 fps
        _write(cls.square, 32, 32, 10, 10, (200, 0, 0))
        _write(cls.wide, 64, 36, 25, 25, (0, 0, 200))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.tio, self.tr = _tio(), _tr()

    def render(self, clips, settings):
        doc = self.tio.rebuild(self.tio.new_doc("cut", 24), {"clips": clips, "texts": [], "settings": settings}, "", lambda p: True)
        out = os.path.join(self.tmp, "out.mp4")
        got = self.tr.render(doc, out)
        frames = []
        with av.open(out) as src:
            for frame in src.decode(video=0):
                frames.append(frame.to_ndarray(format="rgb24"))
        return got, frames

    def test_fit_mode_arithmetic(self):
        fit = self.tr.fit
        self.assertEqual(fit(32, 32, 64, 36, "fit"), (36, 36, 14, 0))
        self.assertEqual(fit(32, 32, 64, 36, "fill"), (64, 64, 0, -14))
        self.assertEqual(fit(32, 32, 64, 36, "stretch"), (64, 36, 0, 0))
        self.assertEqual(fit(32, 32, 64, 36, "none"), (32, 32, 16, 2))

    def test_the_film_has_the_timelines_size_and_rate_and_another_rate_keeps_its_speed(self):
        got, frames = self.render([clip(self.square, 1.0)], {"fps": 25, "width": 64, "height": 36})
        self.assertEqual((got["width"], got["height"]), (64, 36))
        self.assertEqual(got["frames"], 25, "1 s at 25 fps")
        self.assertAlmostEqual(float(got["fps"]), 25.0)
        # Fitted: red in the middle, black at the sides.
        mid, side = frames[3][18, 32], frames[3][18, 2]
        self.assertGreater(int(mid[0]), 150)
        self.assertLess(int(side.max()), 30)
        # A 10 fps source at 25 fps: frame f shows source frame floor((f + .5) / 25 * 10) - its green says which.
        greens = [int(frames[f][1, 15, 1]) for f in (0, 12, 24)]          # the picture's top left corner (it starts at x 14)
        self.assertLess(greens[0], greens[1])
        self.assertLess(greens[1], greens[2])

    def test_fill_covers_the_frame_and_none_keeps_its_pixels(self):
        _got, frames = self.render([clip(self.square, 0.5)], {"fps": 25, "width": 64, "height": 36, "fit": "fill"})
        self.assertGreater(int(frames[2][18, 2][0]), 150, "filled: red to the edges")
        _got, frames = self.render([clip(self.square, 0.5, fx={"fit": "none"})], {"fps": 25, "width": 64, "height": 36, "fit": "fill"})
        self.assertLess(int(frames[2][18, 8].max()), 30, "its own 32 pixels, black beside them")
        self.assertGreater(int(frames[2][18, 32][0]), 150)

    def test_stretch_and_a_crop_of_a_filled_picture_stay_inside_the_frame(self):
        _got, frames = self.render([clip(self.square, 0.5, fx={"fit": "stretch"})], {"fps": 25, "width": 64, "height": 36})
        self.assertGreater(int(frames[2][18, 2][0]), 150)
        # Filled (64 x 64, cut to 36 rows) and cropped 25 % off its left: the box is clamped to the frame.
        _got, frames = self.render([clip(self.square, 0.5, fx={"cl": 0.25})], {"fps": 25, "width": 64, "height": 36, "fit": "fill"})
        self.assertLess(int(frames[2][18, 4].max()), 30)
        self.assertGreater(int(frames[2][18, 40][0]), 150)


if __name__ == "__main__":
    unittest.main()
