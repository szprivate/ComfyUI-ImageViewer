"""A Read is its file's own size, not the comp's (Sebastian 2026-11-23): the comp's width / height is only the
size of what has none of its own. The server learns a Read's size from its file when the node does not say it.

    python -m unittest discover -s tests -p test_comp_read_size.py
"""
import importlib
import os
import shutil
import sys
import tempfile
import types
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
_pkg = types.ModuleType("_crs")
_pkg.__path__ = [os.path.join(ROOT, "src")]
sys.modules.setdefault("_crs", _pkg)
M = importlib.import_module("_crs.comp_model")
IO = importlib.import_module("_crs.comp_io")


def png(path, size, rgb=(255, 0, 0)):
    from PIL import Image
    a = np.zeros((size[1], size[0], 4), np.uint8)
    a[..., :3] = rgb
    a[..., 3] = 255
    Image.fromarray(a, "RGBA").save(path)


class ReadOwnSize(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.comp_path = os.path.join(self.tmp, "shot.comp.json")
        png(os.path.join(self.tmp, "small.png"), (12, 9))
        os.makedirs(os.path.join(self.tmp, "seq"))
        for k in (1001, 1002):
            png(os.path.join(self.tmp, "seq", f"plate.{k}.png"), (40, 20), (0, 255, 0))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def comp(self, nodes, out):
        return {"comp": 1, "format": {"width": 64, "height": 36, "fps": 24, "frames": 4}, "nodes": nodes, "output": out}

    def test_a_read_without_a_size_is_its_file_size_in_a_render(self):
        c = self.comp([{"id": "R", "type": "read", "inputs": [], "file": "small.png"},
                       {"id": "G", "type": "grade", "inputs": ["R", None], "gain": 2},
                       {"id": "O", "type": "output", "inputs": ["G"]}], "O")
        img = M.render_node(c, "O", 0, IO.Sources(self.comp_path), 1.0)
        self.assertEqual(img.shape[:2], (9, 12))
        self.assertGreater(float(img[0, 0, 0]), 1.5)            # the file 1:1, graded
        # A sequence: its first frame's size.
        c2 = self.comp([{"id": "R", "type": "read", "inputs": [], "file": "seq/plate.####.png"},
                        {"id": "O", "type": "output", "inputs": ["R"]}], "O")
        self.assertEqual(M.render_node(c2, "O", 1, IO.Sources(self.comp_path), 0.5).shape[:2], (10, 20))

    def test_merged_over_a_bigger_picture_it_lies_bottom_left_and_the_comp_size_is_only_a_default(self):
        c = self.comp([{"id": "C", "type": "constant", "inputs": [], "color": [0, 0, 1, 1]},
                       {"id": "R", "type": "read", "inputs": [], "file": "small.png"},
                       {"id": "M", "type": "merge", "inputs": ["C", "R", None]},
                       {"id": "O", "type": "output", "inputs": ["M"]}], "O")
        img = M.render_node(c, "O", 0, IO.Sources(self.comp_path), 1.0)
        self.assertEqual(img.shape[:2], (36, 64))               # the Constant: the comp's size
        self.assertGreater(img[-1, 0, 0], 0.9)                  # the Read at the bottom left
        self.assertLess(img[0, -1, 0], 0.1)
        # A size the node already knows wins (the file changed on disk: laid in by fit).
        c["nodes"][1]["size"] = [24, 18]
        self.assertEqual(M.format_at(c, "R"), {"width": 24, "height": 18})
        self.assertEqual(M.render_node(c, "R", 0, IO.Sources(self.comp_path), 1.0).shape[:2], (18, 24))


if __name__ == "__main__":
    unittest.main()
