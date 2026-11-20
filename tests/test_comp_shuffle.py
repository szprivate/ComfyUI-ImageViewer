"""Comp's Shuffle routes channels of two inputs through a grid: the routing on the server side - an older node
upgraded on reading, the Python API's older settings, and the export of a stock-friendly Shuffle."""
import importlib
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("_cshuf")
_pkg.__path__ = [os.path.join(ROOT, "src")]
sys.modules.setdefault("_cshuf", _pkg)
M = importlib.import_module("_cshuf.comp_model")
N = importlib.import_module("_cshuf.comp_nuke")


def comp(nodes, out="Output1"):
    return {"comp": 1, "format": {"width": 4, "height": 2, "fps": 24, "frames": 1}, "output": out, "nodes": nodes}


class Routing(unittest.TestCase):
    def test_an_older_shuffle_reads_as_its_routing_with_its_mask_past_input_a(self):
        c, _ = M.normalize(comp([{"id": "K", "type": "constant", "inputs": []}, {"id": "Mk", "type": "constant", "inputs": []},
                                 {"id": "S", "type": "shuffle", "out": "lay", "r": "a", "g": "-", "b": "0", "a": "1", "inputs": ["K", "Mk"]},
                                 {"id": "Output1", "type": "output", "inputs": ["S"]}]))
        s = M.node_by_id(c, "S")
        self.assertEqual(s["inputs"], ["K", None, "Mk"])
        self.assertEqual(s["route"], {"lay.r": "B:a", "lay.b": "0", "lay.a": "1"})
        self.assertEqual((s["out1"], s["in2"]), ("lay", "none"))
        self.assertNotIn("r", s)
        again, _ = M.normalize(c)
        self.assertEqual(M.node_by_id(again, "S")["inputs"], ["K", None, "Mk"])

    def test_a_and_b_constants_and_a_layer_routed(self):
        c = comp([{"id": "B", "type": "constant", "color": [0.1, 0.2, 0.3, 0.4], "inputs": []},
                  {"id": "A", "type": "constant", "color": [0.5, 0.6, 0.7, 0.8], "inputs": []},
                  {"id": "S", "type": "shuffle", "inputs": ["B", "A", None], "route": {"r": "A:g", "a": "1", "keep.a": "A:a"}},
                  {"id": "Output1", "type": "output", "inputs": ["S"]}])
        img, ex = M.render_node(c, "S", 0, channels=True)
        self.assertAlmostEqual(float(img[0, 0, 0]), 0.48, places=5)   # A's green, premultiplied
        self.assertAlmostEqual(float(img[0, 0, 1]), 0.08, places=5)   # B's own green passes
        self.assertAlmostEqual(float(img[0, 0, 3]), 1.0, places=5)
        self.assertAlmostEqual(float(ex["keep.a"][0, 0]), 0.8, places=5)


class Export(unittest.TestCase):
    def test_an_rgba_shuffle_of_b_is_written_and_one_reading_a_is_baked(self):
        nodes = [{"id": "K", "type": "constant", "color": [1, 0, 0, 1], "inputs": []},
                 {"id": "S", "type": "shuffle", "inputs": ["K", None, None], "route": {"r": "B:b", "g": "0", "a": "1"}},
                 {"id": "Output1", "type": "output", "inputs": ["S"]}]
        self.assertIsNone(N._bakeable(nodes[1]))
        text, plan = N.build(comp(nodes))
        self.assertIn("red blue", text)
        self.assertIn("green black", text)
        self.assertIn("blue blue", text)          # not written: its own
        self.assertEqual(plan["bake"], [])
        nodes[1]["route"] = {"r": "A:r"}
        nodes[1]["inputs"] = ["K", "K", None]
        self.assertIn("input A", N._bakeable(nodes[1]))
        _, plan = N.build(comp(nodes), bake=False)
        self.assertIn("S", plan["placeholder"])


class Api(unittest.TestCase):
    def test_the_older_settings_still_set_the_routing(self):
        try:
            A = importlib.import_module("_cshuf.comp_api")
        except ImportError as e:   # comp_write's imports
            self.skipTest(str(e))
        c = A.Comp.new()
        k = c.add("constant")
        s = c.add("shuffle", inputs=[k], out="lay", g="a", b="-")
        n = c.node(s)
        self.assertEqual(n["out1"], "lay")
        self.assertEqual(n["route"]["lay.g"], "B:a")
        self.assertNotIn("lay.b", n["route"])
        c.set(s, route={"r": "A:g", "a": "1"})
        self.assertEqual(c.node(s)["route"], {"r": "A:g", "a": "1"})
        with self.assertRaises(A.CompError):
            c.set(s, route={"r": "C:g"})


if __name__ == "__main__":
    unittest.main()
