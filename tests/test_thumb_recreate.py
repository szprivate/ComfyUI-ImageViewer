"""History > Recreate thumbnail: media_resolve.forget_thumbs drops every cached tile of one file and nothing else,
and thumb_for makes a new one. Run: python -m unittest tests.test_thumb_recreate"""
import importlib.util
import os
import sys
import tempfile
import types
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TMP = tempfile.mkdtemp()

_fp = types.ModuleType("folder_paths")
_fp.get_temp_directory = lambda: TMP
_saved = sys.modules.get("folder_paths")
sys.modules["folder_paths"] = _fp
try:
    _spec = importlib.util.spec_from_file_location("imageviewer_media_resolve_rt", os.path.join(ROOT, "src", "media_resolve.py"))
    mr = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(mr)
finally:
    if _saved is not None:
        sys.modules["folder_paths"] = _saved

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None


@unittest.skipIf(Image is None, "Pillow not installed")
class ForgetThumbsTests(unittest.TestCase):
    def setUp(self):
        mr.folder_paths = _fp    # this module's stub, whatever another test put in sys.modules
        self.src_dir = tempfile.mkdtemp()
        self.png = os.path.join(self.src_dir, "shot_010.png")
        Image.new("RGB", (800, 600), (10, 200, 10)).save(self.png)
        self.other = os.path.join(self.src_dir, "other.png")
        Image.new("RGB", (800, 600), (10, 10, 200)).save(self.other)

    def test_every_size_and_colourspace_and_the_poster_go_and_others_stay(self):
        a = mr.thumb_for(self.png)
        b = mr.thumb_for(self.png, 128)
        c = mr.thumb_for(self.png, 256, "ACEScg")
        keep = mr.thumb_for(self.other)
        poster = mr._cache_path(self.png, "poster")
        open(poster, "wb").write(b"x")
        stranger = os.path.join(TMP, "ImageViewer_proxy_shot_010_x.png")
        open(stranger, "wb").write(b"x")
        for p in (a, b, keep):
            self.assertTrue(p and os.path.isfile(p))
        removed = mr.forget_thumbs(self.png)
        self.assertGreaterEqual(removed, 3)
        for p in (a, b, poster) + ((c,) if c else ()):
            self.assertFalse(os.path.exists(p), p)
        self.assertTrue(os.path.isfile(keep))
        self.assertTrue(os.path.isfile(stranger))
        again = mr.thumb_for(self.png)
        self.assertEqual(again, a)
        self.assertTrue(os.path.isfile(again))

    def test_nothing_cached_is_nothing_removed(self):
        self.assertEqual(mr.forget_thumbs(os.path.join(self.src_dir, "never.png")), 0)


if __name__ == "__main__":
    unittest.main()
