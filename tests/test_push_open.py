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


if __name__ == "__main__":
    unittest.main()
