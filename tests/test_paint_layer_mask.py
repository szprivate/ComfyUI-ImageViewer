"""edit_image's mask made from a layer (paint_ops, {"op": "mask", "from": "layer"}): what Paint's
layerToMask does when a pixel layer is dropped on another layer's row.

Run: python -m unittest tests.test_paint_layer_mask
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_ops as O, np  # noqa: E402


def solid(w, h, rgba):
    a = np.zeros((h, w, 4), np.uint8)
    a[...] = rgba
    return a


class LayerToMask(unittest.TestCase):
    def doc(self):
        d = P.PaintDoc(10, 6, "m")
        d.add_pixel_layer(solid(10, 6, (200, 50, 50, 255)), "photo")
        # A white square, half see-through on its right half, at 2,1 - and a grey one beside it.
        px = solid(4, 4, (255, 255, 255, 255))
        px[:, 2:, 3] = 128
        d.add_pixel_layer(px, "shape", 2, 1)
        d.meta = P.clean_meta(d.meta)
        return d

    def test_brightness_times_alpha_at_the_layers_place_and_the_layer_goes(self):
        d = self.doc()
        said = O.apply_ops(d, [{"op": "mask", "layer": "photo", "from": "layer", "source": "shape"}], read_image=None)
        self.assertIn("mask from layer 'shape'", said[0])
        self.assertEqual([L["name"] for L in d.layers], ["photo"])
        photo = d.layers[0]
        self.assertEqual(photo["mask"]["w"], 10)
        m = d.masks[photo["id"]]
        self.assertEqual(m[0, 0], 0, "outside the layer: black")
        self.assertEqual(m[1, 2], 255, "opaque white: shown")
        self.assertIn(int(m[1, 4]), (127, 128), "half see-through: half")

    def test_keep_leaves_the_layer_and_a_mask_there_is_replaced(self):
        d = self.doc()
        O.apply_ops(d, [{"op": "mask", "layer": "photo", "from": "all"}], read_image=None)
        said = O.apply_ops(d, [{"op": "mask", "layer": "photo", "from": "layer", "source": "shape", "keep": True}],
                           read_image=None)
        self.assertIn("replaced its mask", said[0])
        self.assertEqual([L["name"] for L in d.layers], ["photo", "shape"])
        self.assertEqual(d.masks[d.layers[0]["id"]][0, 0], 0)

    def test_refusals(self):
        d = self.doc()
        with self.assertRaisesRegex(O.OpError, "'source'"):
            O.apply_ops(d, [{"op": "mask", "layer": "photo", "from": "layer"}], read_image=None)
        with self.assertRaisesRegex(O.OpError, "its own mask"):
            O.apply_ops(d, [{"op": "mask", "layer": "photo", "from": "layer", "source": "photo"}], read_image=None)


if __name__ == "__main__":
    unittest.main()
