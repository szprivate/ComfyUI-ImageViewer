"""video_poster: a still for a film in the strips. Run: python -m unittest tests.test_video_poster"""
import importlib.util
import os
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "video_poster", os.path.join(os.path.dirname(__file__), "..", "video_poster.py"))
vp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vp)

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None


@unittest.skipIf(Image is None, "Pillow not installed")
class PosterTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.mp4 = os.path.join(self.d, "title.mp4")
        open(self.mp4, "wb").write(b"\0\0\0\x18ftypmp42 not a decodable film")
        self.dst = os.path.join(self.d, "cache", "thumb.png")

    def poster(self, size=(1920, 1080), name="title.png"):
        p = os.path.join(self.d, name)
        Image.new("RGB", size, (200, 30, 30)).save(p)
        return p

    def test_poster_beside_the_film_needs_no_decoder(self):
        self.poster()
        out = vp.make(self.mp4, self.dst, decode=lambda v, i: self.fail("decoder must not be asked"))
        self.assertEqual(out, self.dst)
        with Image.open(self.dst) as im:
            self.assertLessEqual(max(im.size), vp.MAX_SIDE)
            self.assertEqual(im.getpixel((2, 2))[:3], (200, 30, 30))

    def test_other_name_is_not_its_poster(self):
        self.poster(name="other.png")
        self.assertIsNone(vp.sibling_poster(self.mp4))

    def test_decoded_frame_when_no_poster(self):
        import numpy as np
        out = vp.make(self.mp4, self.dst, decode=lambda v, i: np.full((90, 160, 3), 77, dtype="uint8"))
        self.assertEqual(out, self.dst)
        with Image.open(self.dst) as im:
            self.assertEqual(im.size, (160, 90))

    def test_nothing_makes_none(self):
        # no poster, a decoder that finds nothing and (on a CI box) no usable ffmpeg for a non-film
        self.assertIsNone(vp.make(self.mp4, self.dst, decode=lambda v, i: None))


if __name__ == "__main__":
    unittest.main()
