"""Paint's pen paths on the server: kept in the document (.ora), moved by crop / canvas size / resize,
and the agent's `path` op (select, fill, stroke, mask, remove).

Run: python -m unittest tests.test_paint_paths
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_ops as O, paint_math as M, np  # noqa: E402


def doc():
    d = P.PaintDoc(40, 30, "p")
    a = np.zeros((30, 40, 4), np.uint8)
    a[...] = (10, 20, 30, 255)
    d.add_pixel_layer(a, "bg")
    d.meta = P.clean_meta(d.meta)
    return d


SQUARE = [[5, 5], [30, 5], [30, 25], [5, 25]]


class Paths(unittest.TestCase):
    def apply(self, d, *ops):
        return O.apply_ops(d, list(ops), read_image=None)

    def test_select_fill_stroke_mask_remove(self):
        d = doc()
        said = self.apply(d, {"op": "path", "points": SQUARE, "name": "box", "do": "select"})
        self.assertIn("box", said[0])
        self.assertEqual(int(d.selection[15, 15]), 255)
        self.assertEqual(int(d.selection[2, 2]), 0)
        self.assertEqual(P.outline(d)["paths"], [{"name": "box", "points": 4, "closed": True}])
        self.apply(d, {"op": "path", "path": "box", "do": "fill", "color": "#ff0000"})
        px = d.px[d.layers[0]["id"]]
        self.assertEqual(px[15, 15].tolist(), [255, 0, 0, 255])
        self.assertEqual(px[2, 2].tolist(), [10, 20, 30, 255])
        self.apply(d, {"op": "add_layer", "name": "line"},
                   {"op": "path", "path": "box", "do": "stroke", "color": "blue", "width": 2, "layer": "line"})
        line = d.px[d.layer(d.meta["active"])["id"]]
        L = d.layer(d.meta["active"])
        self.assertEqual(int(line[15 - L["y"], 5 - L["x"], 3]), 255)
        self.assertEqual(int(line[15 - L["y"], 15 - L["x"], 3]), 0)
        self.apply(d, {"op": "path", "path": "box", "do": "mask", "layer": "bg"})
        self.assertEqual(int(d.masks[d.layers[0]["id"]][15, 15]), 255)
        # A curve: points with handles; the same name replaces the path.
        self.apply(d, {"op": "path", "name": "box", "points": [[5, 15, 5, 25, 5, 5], [35, 15, 35, 5, 35, 25]], "closed": True})
        self.assertEqual(len(d.meta["paths"]), 1)
        self.assertTrue(d.meta["paths"][0]["pts"][0]["smooth"])
        self.apply(d, {"op": "path", "path": "box", "do": "remove"})
        self.assertNotIn("paths", d.meta)
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "path", "path": "nope", "do": "select"})

    def test_kept_in_the_ora_and_moved_with_the_canvas(self):
        d = doc()
        self.apply(d, {"op": "path", "points": SQUARE, "name": "box"})
        path = os.path.join(tempfile.mkdtemp(), "p.ora")
        P.write_ora(path, d)
        back = P.read_ora(path)
        self.assertEqual(back.meta["paths"][0]["pts"], d.meta["paths"][0]["pts"])
        self.assertTrue(any("path" in n for n in P.write_psd(os.path.join(os.path.dirname(path), "p.psd"), d)))
        self.apply(d, {"op": "crop", "x": 5, "y": 5, "w": 20, "h": 20})
        self.assertEqual((d.meta["paths"][0]["pts"][0]["x"], d.meta["paths"][0]["pts"][0]["y"]), (0, 0))
        self.apply(d, {"op": "resize", "scale": 2})
        self.assertEqual(d.meta["paths"][0]["pts"][1]["x"], 50)

    def test_stroke_of_an_open_path_has_no_closing_side(self):
        p = M.clean_path({"pts": [{"x": 5, "y": 5}, {"x": 30, "y": 5}, {"x": 30, "y": 25}]})
        m = M.stroke_mask(40, 30, M.flatten_path(p), p["closed"], 2)
        self.assertEqual(int(m[5, 15]), 255)
        self.assertEqual(int(m[15, 17]), 0)


if __name__ == "__main__":
    unittest.main()
