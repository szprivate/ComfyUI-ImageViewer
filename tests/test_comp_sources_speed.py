"""The quicker ways the Comp preview reads its footage give the pictures the plain ways gave: an 8-bit picture
through a table (the numbers of the float reader + from_float), the shrink by strided sums, and a film read at
random (seeking to keyframes) frame for frame what reading it forwards gives.

    python -m unittest discover -s tests -p test_comp_sources_speed.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402


@unittest.skipIf(web is None, "needs aiohttp")
class CompSourcesSpeed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        _, cls.dirs, cls.pkg = _load(cls.tmp, [])
        cls.io = sys.modules[cls.pkg + ".comp_io"]
        cls.M = sys.modules[cls.pkg + ".comp_model"]

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_an_8_bit_picture_reads_as_the_float_reader_reads_it(self):
        from PIL import Image
        rng = np.random.default_rng(3)
        for mode, ch in (("RGBA", 4), ("RGB", 3)):
            a = rng.integers(0, 256, (37, 53, ch), dtype=np.uint8)
            f = os.path.join(self.tmp, f"t_{mode}.png")
            Image.fromarray(a, mode).save(f)
            u8 = self.io._read_u8(f)
            self.assertEqual(u8.shape, (37, 53, 4))
            for linear in (False, True):
                rgb, alpha = self.io._read_float(f)
                ref = self.M.from_float(rgb, alpha, linear=linear)
                got = self.io.from_u8(u8, linear=linear)
                self.assertLess(float(np.max(np.abs(ref - got))), 1e-6, (mode, linear))
        # not 8 bits: the float reader's
        f16 = os.path.join(self.tmp, "deep.png")
        Image.fromarray(rng.integers(0, 65535, (8, 9), dtype=np.uint16).astype(np.int32), "I").save(f16)
        self.assertIsNone(self.io._read_u8(f16))

    def test_the_shrink_is_a_box_average(self):
        img = np.random.default_rng(1).random((23, 31, 4), np.float32)
        for k in (2, 3, 5):
            ref = img[: 23 // k * k, : 31 // k * k].reshape(23 // k, k, 31 // k, k, 4).mean(axis=(1, 3), dtype=np.float64)
            self.assertLess(float(np.max(np.abs(self.io.shrink(img, k) - ref))), 1e-6, k)
        self.assertIs(self.io.shrink(img, 1), img)

    @unittest.skipIf(importlib.util.find_spec("av") is None, "needs PyAV")
    def test_a_film_read_at_random_gives_the_frames_read_forwards(self):
        import av
        fp = os.path.join(self.tmp, "film.mp4")
        out = av.open(fp, "w")
        s = out.add_stream("libx264", rate=24)
        s.width, s.height, s.pix_fmt = 64, 48, "yuv420p"
        s.options = {"g": "12"}
        for i in range(120):
            img = np.zeros((48, 64, 3), np.uint8)
            img[..., 0] = (i * 2) % 256
            img[:, : (i % 64)] = 255
            fr = av.VideoFrame.from_ndarray(img, format="rgb24")
            fr.pts = i
            for p in s.encode(fr):
                out.mux(p)
        for p in s.encode(None):
            out.mux(p)
        out.close()
        forwards = self.io._Video(fp)
        ref = [forwards.frame(i).copy() for i in range(120)]
        forwards.close()
        v = self.io._Video(fp)
        for n in [100, 5, 60, 59, 119, 0, 30, 31, 90, 12, 118, 3, 3, 64]:
            self.assertTrue(np.array_equal(v.frame(n), ref[n]), n)
        self.assertTrue(np.array_equal(v.frame(500), ref[-1]), "past the end: the last frame")
        v.close()


if __name__ == "__main__":
    unittest.main()
