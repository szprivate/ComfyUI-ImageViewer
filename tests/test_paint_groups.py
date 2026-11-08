"""Layer groups in Paint's files and in the agent's ops: the tree kept in order, .ora (nested stacks)
and .psd (Photoshop's layer groups) written and read back, groups baked for Photoshop where they hold
adjustment layers, and group / ungroup / merge_group / move_layer.

Run: python -m unittest tests.test_paint_groups
"""
import os
import sys
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paint_pkg import paint_io as P, paint_ops as O, np  # noqa: E402


def solid(w, h, rgba):
    a = np.zeros((h, w, 4), np.uint8)
    a[...] = rgba
    return a


def doc_with_group(blend="pass_through"):
    """bg, then a group "G" holding "a" and "b" (b on top), then "top"."""
    d = P.PaintDoc(20, 10, "g")
    d.add_pixel_layer(solid(20, 10, (200, 200, 200, 255)), "bg")
    G = d.add_group("G", blend=blend, opacity=0.8)
    a = d.add_pixel_layer(solid(8, 6, (255, 0, 0, 255)), "a", 1, 1, index=1, parent=G["id"])
    b = d.add_pixel_layer(solid(8, 6, (0, 0, 255, 200)), "b", 5, 3, index=2, parent=G["id"], blend="multiply")
    d.add_pixel_layer(solid(4, 4, (0, 255, 0, 255)), "top", 15, 5)
    d.meta = P.clean_meta(d.meta)
    return d, G, a, b


class Tree(unittest.TestCase):
    def test_fix_tree_orders_and_drops_bad_parents(self):
        layers = [{"id": "a", "kind": "pixel", "parent": "g"}, {"id": "g", "kind": "group"},
                  {"id": "b", "kind": "pixel", "parent": "g"}, {"id": "c", "kind": "pixel", "parent": "nope"},
                  {"id": "x", "kind": "group", "parent": "y"}, {"id": "y", "kind": "group", "parent": "x"}]
        out = [L["id"] for L in P.fix_tree([dict(L) for L in layers])]
        # a and b inside g, right under it; c out of its unknown group; a loop broken.
        self.assertEqual(out[:3], ["a", "b", "g"])
        self.assertIn("c", out)
        self.assertEqual(len(out), 6)

    def test_meta_keeps_groups(self):
        d, G, a, b = doc_with_group()
        names = [L["name"] for L in d.layers]
        self.assertEqual(names, ["bg", "a", "b", "G", "top"])
        self.assertEqual(d.layer(G["id"])["blend"], "pass_through")
        self.assertEqual([x["name"] for x in P.subtree(d, d.layer(G["id"]))], ["a", "b", "G"])


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_ora_round_trip_and_stack_xml(self):
        d, G, a, b = doc_with_group("normal")
        want = P.composite(d)
        path = os.path.join(self.tmp, "g.ora")
        P.write_ora(path, d)
        with zipfile.ZipFile(path) as z:
            root = ET.fromstring(z.read("stack.xml"))
            z.extractall(os.path.join(self.tmp, "x"))
        top = root.find("stack")
        kinds = [el.tag for el in top]
        self.assertEqual(kinds, ["layer", "stack", "layer"])
        inner = top.findall("stack")[0]
        self.assertEqual(inner.get("isolation"), "isolate")
        self.assertEqual([el.get("name") for el in inner], ["b", "a"])
        back = P.read_ora(path)
        self.assertEqual([L["name"] for L in back.layers], ["bg", "a", "b", "G", "top"])
        self.assertTrue((P.composite(back) == want).all())
        # Without our json (another program's .ora): the stack is read as groups.
        os.remove(os.path.join(self.tmp, "x", "imageviewer.json"))
        plain = os.path.join(self.tmp, "plain.ora")
        with zipfile.ZipFile(plain, "w") as z:
            for base, _dirs, files in os.walk(os.path.join(self.tmp, "x")):
                for f in files:
                    full = os.path.join(base, f)
                    z.write(full, os.path.relpath(full, os.path.join(self.tmp, "x")))
        other = P.read_ora(plain)
        g = [L for L in other.layers if L["kind"] == "group"]
        self.assertEqual(len(g), 1)
        self.assertEqual(g[0]["blend"], "normal")
        self.assertEqual([L["name"] for L in other.layers], ["bg", "a", "b", "G", "top"])
        self.assertLessEqual(int(np.abs(P.composite(other).astype(int) - want.astype(int)).max()), 1)

    def test_psd_round_trip_keeps_groups(self):
        for blend in ("pass_through", "screen"):
            d, G, a, b = doc_with_group(blend)
            d.layer(G["id"])["collapsed"] = True
            path = os.path.join(self.tmp, f"g_{blend}.psd")
            notes = P.write_psd(path, d)
            self.assertEqual(notes, [])
            back = P.read_psd(path)
            self.assertEqual([L["name"] for L in back.layers], ["bg", "a", "b", "G", "top"])
            g = next(L for L in back.layers if L["kind"] == "group")
            self.assertEqual(g["blend"], blend)
            self.assertTrue(g.get("collapsed"))
            self.assertAlmostEqual(g["opacity"], 0.8, places=2)
            self.assertLessEqual(int(np.abs(P.composite(back).astype(int) - P.composite(d).astype(int)).max()), 2)

    def test_psd_keeps_clipping_masks(self):
        d, G, a, b = doc_with_group("normal")
        d.layer(b["id"])["clip"] = True
        d.meta = P.clean_meta(d.meta)
        path = os.path.join(self.tmp, "clip.psd")
        P.write_psd(path, d)
        back = P.read_psd(path)
        self.assertEqual([bool(L.get("clip")) for L in back.layers], [False, False, True, False, False])
        self.assertLessEqual(int(np.abs(P.composite(back).astype(int) - P.composite(d).astype(int)).max()), 2)
        ora = os.path.join(self.tmp, "clip.ora")
        P.write_ora(ora, d)
        self.assertTrue(P.read_ora(ora).layer(b["id"])["clip"])

    def test_psd_bakes_a_group_holding_an_adjustment(self):
        d, G, a, b = doc_with_group()
        d.add_adjust_layer("invert", {}, index=3)
        d.layers[3]["parent"] = G["id"]
        d.meta = P.clean_meta(d.meta)
        path = os.path.join(self.tmp, "baked.psd")
        notes = P.write_psd(path, d)
        self.assertTrue(any("G" in n and "merged" in n for n in notes), notes)
        back = P.read_psd(path)
        self.assertEqual([L["name"] for L in back.layers], ["G (merged)", "top"])
        self.assertLessEqual(int(np.abs(P.composite(back).astype(int) - P.composite(d).astype(int)).max()), 1)


class Ops(unittest.TestCase):
    def apply(self, d, *ops):
        return O.apply_ops(d, list(ops), read_image=None)

    def test_outline_lists_groups(self):
        d, G, a, b = doc_with_group()
        rows = P.outline(d)["layers"]
        self.assertEqual([r["name"] for r in rows], ["top", "G", "b", "a", "bg"])
        self.assertEqual(rows[1]["kind"], "group")
        self.assertEqual(rows[1]["layers_inside"], 2)
        self.assertEqual(rows[2]["in_group"], "G")

    def test_group_and_ungroup(self):
        d = P.PaintDoc(10, 10)
        for n in ("one", "two", "three"):
            d.add_pixel_layer(solid(10, 10, (10, 20, 30, 255)), n)
        before = P.composite(d)
        said = self.apply(d, {"op": "group", "layers": ["one", "three"], "name": "Pair"})
        self.assertIn("2 layers", said[0])
        self.assertEqual([L["name"] for L in d.layers], ["two", "one", "three", "Pair"])
        self.assertTrue((P.composite(d) == before).all())
        self.apply(d, {"op": "ungroup", "layer": "Pair"})
        self.assertEqual([L["name"] for L in d.layers], ["two", "one", "three"])
        self.assertFalse(any(L.get("parent") for L in d.layers))

    def test_add_into_move_and_remove(self):
        d, G, a, b = doc_with_group()
        self.apply(d, {"op": "add_layer", "name": "new", "into": "G"})
        self.assertEqual([L["name"] for L in d.layers], ["bg", "a", "b", "new", "G", "top"])
        self.assertEqual(d.layer(d.meta["active"])["parent"], G["id"])
        self.apply(d, {"op": "move_layer", "layer": "new", "to": "bottom"})
        self.assertEqual([L["name"] for L in d.layers], ["bg", "new", "a", "b", "G", "top"])
        self.apply(d, {"op": "move_layer", "layer": "G", "to": "top"})
        self.assertEqual([L["name"] for L in d.layers], ["bg", "top", "new", "a", "b", "G"])
        self.apply(d, {"op": "move_layer", "layer": "new", "into": "none"})
        self.assertEqual([L["name"] for L in d.layers], ["bg", "top", "a", "b", "G", "new"])
        self.apply(d, {"op": "duplicate_layer", "layer": "G"})
        self.assertEqual(sum(1 for L in d.layers if L["kind"] == "group"), 2)
        self.assertEqual(len(d.layers), 9)
        self.apply(d, {"op": "remove_layer", "layer": "G copy"})
        self.assertEqual([L["name"] for L in d.layers], ["bg", "top", "a", "b", "G", "new"])

    def test_merge_group_looks_the_same(self):
        for blend in ("normal", "pass_through"):
            d, G, a, b = doc_with_group(blend)
            before = P.composite(d)
            self.apply(d, {"op": "merge_group", "layer": "G"})
            self.assertEqual([L["name"] for L in d.layers], ["bg", "G", "top"])
            self.assertEqual(d.layers[1]["kind"], "pixel")
            if blend == "normal":
                self.assertLessEqual(int(np.abs(P.composite(d).astype(int) - before.astype(int)).max()), 1)

    def test_mask_settings_op_and_psd_bakes_them(self):
        d, G, a, b = doc_with_group()
        self.apply(d, {"op": "mask", "layer": "a", "from": "all"})
        d.masks[a["id"]][:, :10] = 0
        said = self.apply(d, {"op": "mask", "layer": "a", "from": "settings", "density": 40, "feather": 3})
        self.assertIn("density 40%", said[0])
        self.assertEqual(P.outline(d)["layers"][3]["mask_density"], 40)
        path = os.path.join(tempfile.mkdtemp(), "m.psd")
        P.write_psd(path, d)
        back = P.read_psd(path)
        self.assertLessEqual(int(np.abs(P.composite(back).astype(int) - P.composite(d).astype(int)).max()), 2)

    def test_merge_down_stays_in_its_group(self):
        d, G, a, b = doc_with_group()
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "merge_down", "layer": "a"})
        self.apply(d, {"op": "merge_down", "layer": "b"})
        self.assertEqual([L["name"] for L in d.layers], ["bg", "a", "G", "top"])
        with self.assertRaises(O.OpError):
            self.apply(d, {"op": "merge_down", "layer": "G"})


if __name__ == "__main__":
    unittest.main()
