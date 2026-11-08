"""Paint's Select > Modify and Colour range and the guides on the server: the agent's `select` modes expand /
contract / smooth / border / color_range and its `guides` op; guides kept through crop, canvas size, resize
and the .ora. (The page's twins are compared pixel by pixel in tests/test_paint_parity.py.)

Run: python -m unittest tests.test_paint_select
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_ops as O, np  # noqa: E402


def doc():
    d = P.PaintDoc(40, 30, "p")
    a = np.zeros((30, 40, 4), np.uint8)
    a[...] = (10, 20, 30, 255)
    a[5:15, 5:15] = (250, 0, 0, 255)
    d.add_pixel_layer(a, "bg")
    d.meta = P.clean_meta(d.meta)
    return d


class Select(unittest.TestCase):
    def apply(self, d, *ops):
        return O.apply_ops(d, list(ops), read_image=None)

    def test_modify(self):
        d = doc()
        self.apply(d, {"op": "select", "mode": "rect", "x": 10, "y": 10, "w": 10, "h": 10})
        said = self.apply(d, {"op": "select", "mode": "expand", "by": 3})
        self.assertIn("expand by 3", said[0])
        self.assertEqual(int((d.selection >= 128).sum()), 16 * 16 - 4 * 5)   # a disc of 3 rounds each corner by 5 pixels
        self.apply(d, {"op": "select", "mode": "contract", "by": 3})
        self.assertEqual(int(d.selection[15, 15]), 255)
        self.apply(d, {"op": "select", "mode": "border", "by": 4})
        self.assertEqual(int(d.selection[15, 15]), 0)
        self.assertEqual(int(d.selection[15, 9]), 255)
        self.apply(d, {"op": "select", "mode": "contract", "by": 50})
        self.assertIsNone(d.selection)
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "select", "mode": "smooth", "by": 2})

    def test_color_range(self):
        d = doc()
        said = self.apply(d, {"op": "select", "mode": "color_range", "color": "#fa0000", "fuzziness": 30})
        self.assertIn("10x10 at 5,5", said[0])
        self.apply(d, {"op": "select", "mode": "color_range", "color": [10, 20, 30], "fuzziness": 30, "combine": "add", "sample": "layer"})
        self.assertTrue(bool((d.selection == 255).all()))
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "select", "mode": "color_range"})

    def test_guides_op_crop_resize_and_ora(self):
        d = doc()
        said = self.apply(d, {"op": "guides", "add": [{"axis": "x", "pos": 20}, {"axis": "y", "pos": 10.2}, {"axis": "y", "pos": 99}]})
        self.assertEqual(said[0], "2 guide(s)")
        self.assertEqual(d.meta["guides"], [{"axis": "x", "pos": 20}, {"axis": "y", "pos": 10.0}])
        self.assertEqual(P.outline(d)["guides"], [["x", 20], ["y", 10.0]])
        self.apply(d, {"op": "crop", "x": 5, "y": 0, "w": 30, "h": 30})
        self.assertEqual(d.meta["guides"], [{"axis": "x", "pos": 15}, {"axis": "y", "pos": 10.0}])
        self.apply(d, {"op": "resize", "scale": 2})
        self.assertEqual(d.meta["guides"], [{"axis": "x", "pos": 30}, {"axis": "y", "pos": 20}])
        with tempfile.TemporaryDirectory() as tmp:
            f = os.path.join(tmp, "g.ora")
            P.write_ora(f, d)
            self.assertEqual(P.read_ora(f).meta["guides"], d.meta["guides"])
        self.apply(d, {"op": "guides", "remove": [{"axis": "x", "pos": 30}]})
        self.assertEqual(d.meta["guides"], [{"axis": "y", "pos": 20}])
        self.apply(d, {"op": "guides", "clear": True})
        self.assertNotIn("guides", d.meta)


if __name__ == "__main__":
    unittest.main()
