"""Paint's smart filters on the server: `set_layer` `filters`, the outline, the composite, the .ora keeping
them and the .psd baking them. (The page's twin is compared pixel by pixel in tests/test_paint_parity.py.)

Run: python -m unittest tests.test_paint_smart
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_ops as O, np  # noqa: E402


def doc():
    d = P.PaintDoc(30, 20, "p")
    a = np.zeros((20, 30, 4), np.uint8)
    a[...] = (200, 100, 50, 255)
    d.add_pixel_layer(a, "bg")
    b = np.zeros((6, 6, 4), np.uint8)
    b[...] = (255, 255, 255, 255)
    d.add_pixel_layer(b, "box", 10, 7)
    d.meta = P.clean_meta(d.meta)
    return d


class Smart(unittest.TestCase):
    def apply(self, d, *ops):
        return O.apply_ops(d, list(ops), read_image=None)

    def test_set_layer_filters_and_the_composite(self):
        d = doc()
        plain = P.composite(d)
        said = self.apply(d, {"op": "set_layer", "layer": "box", "filters": [{"type": "invert"}, {"type": "blur", "params": {"radius": 3}}]})
        self.assertIn("smart filters invert, blur", said[0])
        L = d.layers[1]
        self.assertEqual([f["type"] for f in L["filters"]], ["invert", "blur"])
        self.assertEqual(d.px[L["id"]].tolist(), np.full((6, 6, 4), 255, np.uint8).tolist())   # its own pixels kept
        c = P.composite(d)
        self.assertLess(int(c[10, 13, 0]), 30)                       # inverted
        self.assertFalse(np.array_equal(c[5, 13], plain[5, 13]))     # blurred past its box
        self.assertEqual(P.outline(d)["layers"][0]["filters"], ["invert", "blur"])
        self.apply(d, {"op": "set_layer", "layer": "box", "filters": [{"type": "invert", "on": False}]})
        self.assertTrue(np.array_equal(P.composite(d), plain))
        self.apply(d, {"op": "set_layer", "layer": "box", "filters": None})
        self.assertNotIn("filters", d.layers[1])
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "set_layer", "layer": "box", "filters": [{"type": "liquify"}]})

    def test_ora_keeps_them_psd_bakes_them(self):
        d = doc()
        self.apply(d, {"op": "set_layer", "layer": "box", "filters": [{"type": "hue_saturation", "params": {"hue": 90}}, {"type": "blur", "params": {"radius": 2}}]})
        want = P.composite(d)
        with tempfile.TemporaryDirectory() as tmp:
            f = os.path.join(tmp, "s.ora")
            P.write_ora(f, d)
            back = P.read_ora(f)
            self.assertEqual(back.layers[1]["filters"], d.layers[1]["filters"])
            self.assertTrue(np.array_equal(P.composite(back), want))
            layers, notes = P.baked_for_psd(d)
            self.assertTrue(any("smart filters" in n for n in notes))
            L, px, _ = layers[1]
            self.assertNotIn("filters", L)
            self.assertEqual((L["w"], L["h"]), (30, 20))


if __name__ == "__main__":
    unittest.main()
