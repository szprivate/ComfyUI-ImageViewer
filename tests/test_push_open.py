"""push_open: what a /bepic/push names. Run: python -m unittest tests.test_push_open"""
import importlib.util
import os
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "push_open", os.path.join(os.path.dirname(__file__), "..", "push_open.py"))
po = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(po)

IMG, VID = {".png", ".jpg"}, {".mp4", ".mov"}


class ExpandTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        for n in ("f_1.png", "f_2.png", "f_10.png", "note.txt", "cut.mp4", "cut.otio", "lone.otio"):
            open(os.path.join(self.d, n), "w").close()
        self.allow = lambda p: os.path.abspath(p).startswith(os.path.abspath(self.d))
        self.serve = lambda p: self.allow(p) and os.path.splitext(p)[1].lower() in IMG | VID

    def run_expand(self, *paths):
        return po.expand([os.path.join(self.d, p) if not os.path.isabs(p) else p for p in paths],
                         IMG, VID, may_serve=self.serve, is_allowed=self.allow)

    def names(self, files):
        return [os.path.basename(f) for f in files]

    def test_sequence_patterns_natural_order(self):
        for pat in ("f_%d.png", "f_*.png", "f_#.png"):
            files, refused, _ = self.run_expand(pat)
            self.assertEqual(self.names(files), ["f_1.png", "f_2.png", "f_10.png"], pat)
            self.assertEqual(refused, [])

    def test_folder_lists_media_only(self):
        files, _, _ = self.run_expand(self.d)
        self.assertEqual(self.names(files), ["cut.mp4", "f_1.png", "f_2.png", "f_10.png"])

    def test_otio_stands_for_its_film(self):
        files, refused, cuts = self.run_expand("cut.otio", "lone.otio")
        self.assertEqual(self.names(files), ["cut.mp4"])
        self.assertEqual(refused, [os.path.join(self.d, "lone.otio")])
        self.assertEqual(list(cuts.values()), [os.path.join(self.d, "cut.otio")])

    def test_outside_and_dupes_refused(self):
        other = tempfile.mkdtemp()
        out = os.path.join(other, "x.png")
        open(out, "w").close()
        files, refused, _ = self.run_expand("f_1.png", "f_1.png", out)
        self.assertEqual(self.names(files), ["f_1.png"])
        self.assertEqual(refused, [out])

    def test_cap(self):
        files, _, _ = po.expand([self.d], IMG, VID, may_serve=self.serve, is_allowed=self.allow, cap=2)
        self.assertEqual(len(files), 2)


class SplitPushedTests(unittest.TestCase):
    """A pushed .mgscene.json must open the Motion editor: it was refused because the check was may_serve (media only)."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.scene = os.path.join(self.d, "title.mgscene.json")
        open(self.scene, "w").write("{}")
        self.allow = lambda p: os.path.abspath(p).startswith(os.path.abspath(self.d))
        self.is_scene = lambda r: str(r).lower().endswith(".mgscene.json")

    def split(self, *paths, **kw):
        return po.split_pushed(list(paths), is_allowed=self.allow, is_scene=self.is_scene, **kw)

    def test_scene_in_allowed_folder_opens_motion(self):
        motion, lora, rest = self.split(self.scene)
        self.assertEqual(motion, [os.path.abspath(self.scene)])
        self.assertEqual((lora, rest), ([], []))

    def test_json_is_not_media(self):
        may_serve = lambda p: self.allow(p) and p.lower().endswith((".png", ".mp4"))
        self.assertFalse(may_serve(self.scene))            # the old check: always refused
        self.assertTrue(self.split(self.scene)[0])

    def test_outside_missing_and_media_stay_rest(self):
        other = os.path.join(tempfile.mkdtemp(), "x.mgscene.json")
        open(other, "w").write("{}")
        missing = os.path.join(self.d, "gone.mgscene.json")
        png = os.path.join(self.d, "a.png")
        motion, _, rest = self.split(other, missing, png)
        self.assertEqual(motion, [])
        self.assertEqual(rest, [other, missing, png])

    def test_dataset_manifest_goes_to_lora(self):
        man = os.path.join(self.d, "manifest.json")
        motion, lora, rest = self.split(man, dataset_of=lambda r: r == man)
        self.assertEqual((motion, lora, rest), ([], [os.path.abspath(man)], []))


if __name__ == "__main__":
    unittest.main()
