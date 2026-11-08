"""Paint's layer styles and locked transparency on the server: the agent's set_layer (style, lock_alpha),
the outline, the .ora keeping them, the .psd baking the style and carrying the lock.
(The page's twin is compared pixel by pixel in tests/test_paint_parity.py test_layer_styles.)

Run: python -m unittest tests.test_paint_style
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_ops as O, paint_style as S, np  # noqa: E402


def doc():
    d = P.PaintDoc(40, 30, "p")
    d.add_pixel_layer(np.full((30, 40, 4), 255, np.uint8), "bg")
    sq = np.zeros((10, 10, 4), np.uint8)
    sq[...] = (200, 0, 0, 255)
    d.add_pixel_layer(sq, "sq", 15, 10)
    d.meta = P.clean_meta(d.meta)
    return d


class Styles(unittest.TestCase):
    def apply(self, d, *ops):
        return O.apply_ops(d, list(ops), read_image=None)

    def test_dilate_is_a_disc(self):
        m = np.zeros((11, 11), np.uint8)
        m[5, 5] = 255
        out = S.dilate(m, 3)
        self.assertEqual(int(out.sum() // 255), 29)          # the pixels within 3 of the middle (x^2 + y^2 <= 9)
        self.assertEqual(int(out[5, 8]), 255)
        self.assertEqual(int(out[7, 7]), 255)                # 2.83 away: in
        self.assertEqual(int(out[8, 6]), 0)                  # 3.16 away: out

    def test_set_layer_style_and_the_composite(self):
        d = doc()
        said = self.apply(d, {"op": "set_layer", "layer": "sq", "style": {"stroke": {"size": 2, "color": "#0000ff"},
                                                                       "shadow": {"distance": 5, "angle": 90, "size": 0}}})
        self.assertIn("style shadow, stroke", said[0])
        c = P.composite(d)
        self.assertEqual(c[15, 20].tolist(), [200, 0, 0, 255])          # the layer itself
        self.assertEqual(c[15, 13].tolist(), [0, 0, 255, 255])          # its edge, 2 px out
        self.assertEqual(c[22, 20].tolist()[:3], [64, 64, 64])          # the shadow 5 px down, 75 % black
        row = P.outline(d)["layers"][0]
        self.assertEqual(sorted(row["style"]), ["shadow", "stroke"])
        # One effect off, then the style off.
        self.apply(d, {"op": "set_layer", "layer": "sq", "style": {"shadow": None}})
        self.assertEqual(list(d.layer(d.layers[1]["id"])["style"]), ["stroke"])
        self.apply(d, {"op": "set_layer", "layer": "sq", "style": None})
        self.assertNotIn("style", d.layers[1])
        self.assertEqual(P.composite(d)[15, 13].tolist(), [255, 255, 255, 255])
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "set_layer", "layer": "sq", "style": {"bevel": {}}})

    def test_files_keep_the_style_and_the_lock(self):
        d = doc()
        self.apply(d, {"op": "set_layer", "layer": "sq", "style": {"glow": {"size": 6}}, "lock_alpha": True})
        with tempfile.TemporaryDirectory() as tmp:
            ora = os.path.join(tmp, "a.ora")
            P.write_ora(ora, d)
            back = P.read_ora(ora)
            L = next(L for L in back.layers if L["name"] == "sq")
            self.assertEqual(L["style"], d.layers[1]["style"])
            self.assertTrue(L["lockAlpha"])
            psd = os.path.join(tmp, "a.psd")
            notes = P.write_psd(psd, d)
            self.assertTrue(any("layer style of 'sq' was baked" in n for n in notes))
            back = P.read_psd(psd)
            L = next(L for L in back.layers if L["name"] == "sq")
            self.assertTrue(L.get("lockAlpha"))
            self.assertNotIn("style", L)
            self.assertLess(int(np.abs(P.composite(back).astype(int) - P.composite(d).astype(int)).max()), 2)


if __name__ == "__main__":
    unittest.main()
