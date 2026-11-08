"""Paint's gradient and shapes on the server: the agent's `gradient` and `shape` ops.
(The page's twins are compared pixel by pixel in tests/test_paint_parity.py.)

Run: python -m unittest tests.test_paint_draw
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_ops as O, np  # noqa: E402


def doc():
    d = P.PaintDoc(40, 30, "p")
    a = np.zeros((30, 40, 4), np.uint8)
    a[...] = (10, 20, 30, 255)
    d.add_pixel_layer(a, "bg")
    d.meta = P.clean_meta(d.meta)
    return d


class Draw(unittest.TestCase):
    def apply(self, d, *ops):
        return O.apply_ops(d, list(ops), read_image=None)

    def test_gradient_onto_a_layer_and_in_the_selection(self):
        d = doc()
        said = self.apply(d, {"op": "gradient", "from": [0, 0], "to": [40, 0], "colors": ["#000000", "#ffffff"]})
        self.assertIn("linear gradient", said[0])
        px = d.px[d.layers[0]["id"]]
        self.assertLessEqual(int(px[10, 1, 0]), 10)
        self.assertEqual(int(px[10, 38, 0]), 245)            # 255 * 38.5 / 40
        self.assertEqual(int(px[10, 20, 0]), 131)            # 255 * 20.5 / 40
        # Inside a selection only, at half opacity; a radial one.
        d = doc()
        self.apply(d, {"op": "select", "mode": "rect", "x": 0, "y": 0, "w": 20, "h": 30},
                   {"op": "gradient", "type": "radial", "from": [10, 15], "to": [20, 15], "colors": ["#ff0000", "#ff0000"], "opacity": 50})
        px = d.px[d.layers[0]["id"]]
        self.assertEqual(px[15, 10].tolist(), [133, 10, 15, 255])
        self.assertEqual(px[15, 30].tolist(), [10, 20, 30, 255])
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "gradient", "type": "spiral", "from": [0, 0], "to": [1, 1]})
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "gradient", "from": [0, 0]})

    def test_shapes_on_new_layers_or_as_paths(self):
        d = doc()
        said = self.apply(d, {"op": "shape", "kind": "ellipse", "box": [5, 5, 30, 20], "fill": "#00ff00", "stroke": "#0000ff", "width": 2})
        self.assertIn("Ellipse", said[0])
        L = next(L for L in d.layers if L["name"] == "Ellipse")
        px = d.px[L["id"]]
        self.assertEqual(px[15, 20].tolist(), [0, 255, 0, 255])
        self.assertEqual(px[15, 5].tolist()[2], 255)         # the edge, on the outline
        self.assertEqual(int(px[1, 1, 3]), 0)
        self.apply(d, {"op": "shape", "kind": "line", "from": [0, 29], "to": [39, 29], "stroke": "#ffffff", "width": 3, "name": "rule"})
        L = next(L for L in d.layers if L["name"] == "rule")
        self.assertEqual(d.px[L["id"]][29, 20].tolist(), [255, 255, 255, 255])
        self.apply(d, {"op": "shape", "kind": "polygon", "sides": 5, "box": [0, 0, 20, 20], "as_path": True, "name": "star"})
        self.assertEqual(P.outline(d)["paths"], [{"name": "star", "points": 5, "closed": True}])
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "shape", "kind": "rect", "box": [0, 0, 5, 5], "fill": None})
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "shape", "kind": "rect"})


if __name__ == "__main__":
    unittest.main()
