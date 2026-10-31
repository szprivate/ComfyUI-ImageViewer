"""The marks beside a film: validation, the sidecar file, and how they are grouped.

annotation_io has no ComfyUI imports, so it is loaded straight from its file (the
package __init__ needs ComfyUI).

    python -m unittest discover -s tests
"""

import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "annotation_io", pathlib.Path(__file__).resolve().parents[1] / "annotation_io.py")
aio = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(aio)


def text(f=0, fe=None, **kw):
    d = {"type": "text", "f": f, "x": 0.25, "y": 0.5, "size": 40, "color": "#fff", "text": "face drifts"}
    if fe is not None:
        d["fe"] = fe
    d.update(kw)
    return d


class Sidecar(unittest.TestCase):
    def test_it_sits_beside_the_film_under_its_stem(self):
        self.assertEqual(aio.sidecar_for("/o/shot_01.mp4"), "/o/shot_01.annotations.json")
        self.assertIsNone(aio.sidecar_for(""))

    def test_save_then_read_round_trips_and_the_file_is_plain_json(self):
        with tempfile.TemporaryDirectory() as d:
            side = aio.sidecar_for(os.path.join(d, "a.mp4"))
            aio.save(side, {"media": "a.mp4", "fps": 24, "frames": 100, "items": [
                text(72, 80),
                {"type": "arrow", "f": 3, "a": {"x": 0, "y": 0}, "b": {"x": 1, "y": 1}, "width": 6}]})
            raw = json.loads(pathlib.Path(side).read_text(encoding="utf-8"))
            self.assertEqual(raw["version"], 1)
            doc = aio.read(side)
            self.assertEqual([i["type"] for i in doc["items"]], ["text", "arrow"])
            self.assertEqual((doc["items"][0]["f"], doc["items"][0]["fe"]), (72, 80))
            self.assertEqual(doc["items"][1]["fe"], 3)           # a single frame by default

    def test_saving_no_marks_removes_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            side = os.path.join(d, "a.annotations.json")
            aio.save(side, {"items": [text(1)]})
            self.assertTrue(os.path.exists(side))
            self.assertIsNone(aio.save(side, {"items": []}))
            self.assertFalse(os.path.exists(side))
            self.assertEqual(os.listdir(d), [])                   # no temp file left behind

    def test_a_missing_or_broken_file_reads_as_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(aio.read(os.path.join(d, "none.json")))
            bad = os.path.join(d, "bad.json")
            pathlib.Path(bad).write_text("{nope", encoding="utf-8")
            self.assertIsNone(aio.read(bad))


class Validation(unittest.TestCase):
    def test_coordinates_are_clamped_to_the_picture(self):
        it = aio.clean_item(text(1, x=5, y=-2))
        self.assertEqual((it["x"], it["y"]), (1.0, 0.0))

    def test_the_last_frame_never_precedes_the_first(self):
        it = aio.clean_item(text(10, 2))
        self.assertEqual((it["f"], it["fe"]), (10, 10))

    def test_things_that_are_not_marks_are_dropped(self):
        doc = aio.clean({"items": [text(0, text=""), {"type": "evil"}, "x",
                                   {"type": "pen", "f": 0, "pts": [{"x": 0, "y": 0}]},
                                   text(0)]})
        self.assertEqual(len(doc["items"]), 1)

    def test_a_note_is_capped(self):
        self.assertEqual(len(aio.clean_item(text(0, text="x" * 99999))["text"]), aio.MAX_TEXT)

    def test_not_an_object_is_refused(self):
        with self.assertRaises(ValueError):
            aio.clean([1, 2])


class Reporting(unittest.TestCase):
    def test_marks_are_grouped_by_their_frame_range_in_order(self):
        doc = aio.clean({"items": [text(50), text(10, 14), text(50, text="b"), text(10, 14, text="c")]})
        g = aio.groups(doc)
        self.assertEqual([(x["frame"], x["end"], len(x["items"])) for x in g], [(10, 14, 2), (50, 50, 2)])

    def test_timecode(self):
        self.assertEqual(aio.timecode(0, 24), "00:00:00.00")
        self.assertEqual(aio.timecode(24 * 3 + 12, 24), "00:00:03.12")
        self.assertEqual(aio.timecode(24 * 3600 + 24 * 61, 24), "01:01:01.00")

    def test_the_size_is_kept_when_known(self):
        self.assertEqual((aio.clean({"width": 640, "height": 360})["width"]), 640)
        self.assertNotIn("width", aio.clean({"width": 640}))


def box(f=0, fe=None, **kw):
    d = {"type": "rect", "f": f, "a": {"x": 0.5, "y": 0.5}, "b": {"x": 0.25, "y": 0.25}, "color": "#f00", "width": 4}
    if fe is not None:
        d["fe"] = fe
    d.update(kw)
    return d


class InWords(unittest.TestCase):
    """report() answers in the shape the page does (bEpicViewer_viewerState.annotationReport)."""

    def test_a_film_is_told_per_frame_range_with_timecodes_and_notes(self):
        doc = aio.clean({"fps": 24, "frames": 96, "width": 640, "height": 360,
                         "items": [text(72, 80), box(72, 80), text(10, text="too dark")]})
        r = aio.report(doc, kind="video", source="D:/o/cut.mp4")
        self.assertEqual((r["kind"], r["count"], r["width"], r["fps"], r["frames"]), ("video", 3, 640, 24, 96))
        self.assertEqual([(g["frame"], g["end"]) for g in r["annotations"]], [(10, 10), (72, 80)])
        g = r["annotations"][1]
        self.assertEqual((g["timecode"], g["end_timecode"]), ("00:00:03.00", "00:00:03.08"))
        self.assertEqual(g["notes"], ["face drifts"])
        self.assertEqual(g["marks"][1]["type"], "box")
        self.assertEqual(g["marks"][1]["box"], {"x1": 0.25, "y1": 0.25, "x2": 0.5, "y2": 0.5})
        self.assertIn("box from 25%,25% to 50%,50%", g["marks"][1]["description"])
        self.assertIn('text at 25%,50% (160,180 px', g["marks"][0]["description"])

    def test_one_frame_only_the_marks_on_it(self):
        doc = aio.clean({"fps": 24, "frames": 96, "items": [text(72, 80), text(10)]})
        r = aio.report(doc, kind="video", frame=75)
        self.assertEqual((r["count"], r["frame"]), (1, 75))

    def test_a_picture_has_one_set_without_frames(self):
        r = aio.report(aio.clean({"items": [text(0), box()]}), kind="image")
        self.assertEqual(r["kind"], "image")
        self.assertEqual(len(r["annotations"]), 1)
        self.assertNotIn("frame", r["annotations"][0])


class Mask(unittest.TestCase):
    def test_a_box_is_filled_and_a_text_or_arrow_is_not_a_region(self):
        items = [box(), text(0), {"type": "arrow", "a": {"x": 0.9, "y": 0.9}, "b": {"x": 0.95, "y": 0.95}}]
        img, used = aio.mask_image(items, 200, 100)
        self.assertEqual((img.size, img.mode, used), ((200, 100), "L", 1))
        self.assertEqual(img.getpixel((75, 37)), 255)        # inside the box (50..100 x 25..50)
        self.assertEqual(img.getpixel((10, 10)), 0)
        self.assertEqual(img.getpixel((185, 92)), 0)         # the arrow left nothing

    def test_a_circled_area_is_filled_an_open_stroke_only_drawn(self):
        import math
        ring = [{"x": 0.5 + 0.3 * math.cos(t / 20 * 2 * math.pi), "y": 0.5 + 0.3 * math.sin(t / 20 * 2 * math.pi)}
                for t in range(21)]
        img, _ = aio.mask_image([{"type": "pen", "pts": ring, "width": 2}], 100, 100)
        self.assertEqual(img.getpixel((50, 50)), 255)
        line = [{"x": 0.1, "y": 0.5}, {"x": 0.5, "y": 0.5}, {"x": 0.9, "y": 0.5}]
        img, _ = aio.mask_image([{"type": "pen", "pts": line, "width": 4}], 100, 100)
        self.assertEqual(img.getpixel((50, 50)), 255)
        self.assertEqual(img.getpixel((50, 30)), 0)

    def test_on_one_frame_only_its_marks(self):
        img, used = aio.mask_image([box(10, 12)], 100, 100, frame=40)
        self.assertEqual((used, img.getpixel((37, 37))), (0, 0))

    def test_no_size_no_mask(self):
        with self.assertRaises(ValueError):
            aio.mask_image([box()], 0, 0)


if __name__ == "__main__":
    unittest.main()
