"""Export to Nuke: the .nk the Comp space writes (src/comp_nuke.py) - its stack, the turned-over coordinates, the
keys as curves, what is baked, and the EXR writer read back."""
import importlib
import os
import re
import sys
import tempfile
import types
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("_cnk")
_pkg.__path__ = [os.path.join(ROOT, "src")]
sys.modules.setdefault("_cnk", _pkg)
N = importlib.import_module("_cnk.comp_nuke")

try:
    import OpenEXR
except ImportError:
    OpenEXR = None


def comp(nodes, frames=3, out="Output1"):
    return {"comp": 1, "format": {"width": 100, "height": 50, "fps": 25, "frames": frames}, "output": out, "nodes": nodes}


def blocks(text):
    """[(class, {knob: value}, pushes before it)] in order."""
    got, pushes = [], []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("push "):
            pushes.append(ln[5:])
        m = re.match(r"^(\w+) \{$", ln)
        if m and m.group(1) != "Root":
            knobs = {}
            i += 1
            while lines[i] != "}":
                k, _, v = lines[i].strip().partition(" ")
                knobs[k] = v
                i += 1
            got.append((m.group(1), knobs, pushes))
            pushes = []
        i += 1
    return got


class NukeScript(unittest.TestCase):
    def test_a_merge_pushes_its_inputs_so_that_b_is_input_0(self):
        c = comp([{"id": "BG", "type": "constant", "color": [0, 0, 1, 1], "inputs": []},
                  {"id": "FG", "type": "constant", "color": [1, 0, 0, 0.5], "inputs": []},
                  {"id": "Merge1", "type": "merge", "inputs": ["BG", "FG", None]},
                  {"id": "Output1", "type": "output", "inputs": ["Merge1"]}])
        text, plan = N.build(c, nk_path="/x/a.nk")
        b = {cls_name: (k, p) for cls_name, k, p in [(k["name"], k, p) for _, k, p in blocks(text)]}
        knobs, pushes = b["Merge1"]
        # Nuke pops input 0 first, so input 0 (B, the comp's first input) must be pushed last.
        self.assertEqual(pushes[-1], "$N_BG")
        self.assertIn("$N_FG", pushes)
        self.assertEqual(plan["bake"], [])
        self.assertIn('format "100 50 0 0 100 50 1 comp_100x50"', text)
        self.assertIn("last_frame 2", text)

    def test_a_layers_length_is_the_merges_disable_expression(self):
        c = comp([{"id": "BG", "type": "constant", "inputs": []},
                  {"id": "FG", "type": "constant", "inputs": []},
                  {"id": "Merge1", "type": "merge", "inputs": ["BG", "FG", None], "in": 1, "out": 2},
                  {"id": "Output1", "type": "output", "inputs": ["Merge1"]}])
        text, _ = N.build(c)
        m = {k["name"]: k for _, k, _p in blocks(text)}["Merge1"]
        self.assertEqual(m["disable"], '{{"frame<1 || frame>=2"}}')

    def test_a_transform_is_turned_over_to_y_up(self):
        c = comp([{"id": "C", "type": "constant", "inputs": []},
                  {"id": "T", "type": "transform", "inputs": ["C"], "translate": [10, 5], "rotate": 30, "center": [20, 10]},
                  {"id": "Output1", "type": "output", "inputs": ["T"]}])
        text, _ = N.build(c)
        t = [k for cls, k, _ in blocks(text) if cls == "Transform"][0]
        self.assertEqual(t["translate"], "{10 -5}")
        self.assertEqual(t["center"], "{20 40}")
        self.assertEqual(t["rotate"], "-30")

    def test_a_reformat_is_one_reformat_and_what_follows_works_in_its_size(self):
        c = comp([{"id": "C", "type": "constant", "inputs": []},
                  {"id": "R", "type": "reformat", "inputs": ["C"], "width": 40, "height": 30, "center": "off"},
                  {"id": "T", "type": "transform", "inputs": ["R"], "rotate": 10},
                  {"id": "K", "type": "crop", "inputs": ["T"], "topleft": [5, 5]},
                  {"id": "Output1", "type": "output", "inputs": ["K"]}])
        text, _ = N.build(c)
        rs = [k for cls, k, _ in blocks(text) if cls == "Reformat"]
        self.assertEqual(len(rs), 1)                       # no second Reformat back into the comp's format
        self.assertEqual((rs[0]["box_width"], rs[0]["box_height"], rs[0]["center"]), ("40", "30", "false"))
        t = [k for cls, k, _ in blocks(text) if cls == "Transform"][0]
        self.assertEqual(t["center"], "{20 15}")           # the middle of the 40 x 30 picture, not of the comp
        k = [k for cls, k, _ in blocks(text) if cls == "Crop"][0]
        self.assertEqual(k["box"], "{5 0 40 25}")

    def test_keys_are_written_as_a_curve_with_a_key_on_every_frame(self):
        c = comp([{"id": "C", "type": "constant", "inputs": []},
                  {"id": "B", "type": "blur", "inputs": ["C"], "size": 0,
                   "tracks": {"size": [{"f": 0, "v": 0}, {"f": 2, "v": 4}]}},
                  {"id": "Output1", "type": "output", "inputs": ["B"]}])
        text, _ = N.build(c)
        blur = [k for cls, k, _ in blocks(text) if cls == "Blur"][0]
        self.assertTrue(blur["size"].startswith("{{curve x0 0"), blur["size"])
        self.assertEqual(len(blur["size"].split()) - 2, 3)   # "{{curve x0" + three values

    def test_what_nuke_has_no_node_for_is_baked_and_read_back(self):
        c = comp([{"id": "C", "type": "constant", "inputs": []},
                  {"id": "Glow1", "type": "glow", "inputs": ["C"]},
                  {"id": "Off", "type": "defocus", "inputs": ["Glow1"], "disable": True},
                  {"id": "Output1", "type": "output", "inputs": ["Off"]}])
        text, plan = N.build(c, bake_dir="/b")
        self.assertEqual([b["id"] for b in plan["bake"]], ["Glow1"])
        off = [k for cls, k, _ in blocks(text) if k["name"] == "Off"][0]
        self.assertEqual(off.get("disable"), "true")          # switched off: a NoOp that passes its input on
        read = [k for cls, k, _ in blocks(text) if cls == "Read" and k["name"] == "Glow1"][0]
        self.assertIn("Glow1.####.exr", read["file"])
        _, plan2 = N.build(c, bake=False)
        self.assertEqual(plan2["bake"], [])
        self.assertIn("Glow1", plan2["placeholder"])
        self.assertIn("Baked", N.readme(plan, "a.nk"))

    def test_a_masked_node_or_a_mix_is_baked(self):
        c = comp([{"id": "C", "type": "constant", "inputs": []},
                  {"id": "M", "type": "constant", "inputs": []},
                  {"id": "Blur1", "type": "blur", "inputs": ["C", "M"], "size": 2},
                  {"id": "Blur2", "type": "blur", "inputs": ["Blur1", None], "size": 2, "mix": 0.5},
                  {"id": "Blur3", "type": "blur", "inputs": ["Blur2", None], "size": 2},
                  {"id": "Output1", "type": "output", "inputs": ["Blur3"]}])
        _, plan = N.build(c, bake_dir="/b")
        self.assertEqual(sorted(b["id"] for b in plan["bake"]), ["Blur1", "Blur2"])
        self.assertIn("Blur3", plan["native"])

    def test_a_group_is_written_flat_and_an_expression_as_a_curve(self):
        c = comp([{"id": "C", "type": "constant", "inputs": []},
                  {"id": "D", "type": "dot", "inputs": ["C"]},
                  {"id": "G1", "type": "group", "inputs": ["D"], "nodes": [
                      {"id": "Input1", "type": "group_input", "index": 0, "inputs": []},
                      {"id": "Blur1", "type": "blur", "inputs": ["Input1"], "size": 1, "expr": {"size": "frame * 2"}},
                      {"id": "GroupOutput1", "type": "group_output", "inputs": ["Blur1"]}]},
                  {"id": "Note", "type": "sticky", "text": "hello", "inputs": []},
                  {"id": "Output1", "type": "output", "inputs": ["G1"]}])
        text, plan = N.build(c)
        self.assertEqual(plan["native"], ["C", "G1/Blur1", "Output1"])
        blur = [k for cls, k, _ in blocks(text) if cls == "Blur"][0]
        self.assertEqual(blur["name"], "G1_Blur1")             # a Nuke name holds no "/"
        self.assertEqual(blur["size"], "{{curve x0 0 2 4}}")   # the expression's values, frame by frame
        write = [p for cls, k, p in blocks(text) if cls == "Write"][0]
        self.assertEqual(write[-1], "$N_G1_Blur1")             # through the Dot and the group's ports

    def test_no_comp_node_type_breaks_the_writer(self):
        nodes = [{"id": f"N{i}", "type": t, "inputs": []} for i, t in enumerate(N.M.NODE_TYPES) if t != "output"]
        nodes.append({"id": "Output1", "type": "output", "inputs": [nodes[0]["id"]]})
        text, plan = N.build(comp(nodes))
        lines = text.splitlines()
        self.assertEqual(sum(ln.endswith(" {") for ln in lines), sum(ln == "}" for ln in lines))
        # Dots, groups, their ports, backdrops and notes are laid out flat first: they write no node of their own.
        graph_only = {"dot", "group", "group_input", "group_output", "backdrop", "sticky"}
        self.assertEqual(len(plan["native"]) + len(plan["bake"]) + len(plan["placeholder"]) + len(plan["skipped"]), len([n for n in nodes if n["type"] not in graph_only]))
        self.assertTrue(text.startswith("#! nuke -nx"))

    @unittest.skipIf(OpenEXR is None, "needs the OpenEXR module to read the file back")
    def test_the_plain_exr_writer_reads_back(self):
        rng = np.random.default_rng(3)
        px = rng.random((7, 11, 4)).astype(np.float32)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.exr")
            with open(p, "wb") as fh:
                fh.write(N.exr_bytes(px))
            with OpenEXR.File(p) as f:
                ch = f.channels()
                got = np.stack([ch[c].pixels for c in "RGBA"], axis=-1) if "R" in ch else ch["RGBA"].pixels
        np.testing.assert_allclose(got.astype(np.float32), px.astype(np.float16).astype(np.float32))


if __name__ == "__main__":
    unittest.main()
