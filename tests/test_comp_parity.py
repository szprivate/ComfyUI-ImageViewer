"""The Comp preview (js/imageViewer_compModel.js) and the render (src/comp_model.py) make the same pictures.

Runs node on tests/comp_parity.mjs with the same comps and the same source pixels and compares every
float. Also checks that the two node tables agree. Skipped without node on PATH."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("comp_model", os.path.join(ROOT, "src", "comp_model.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

W, H = 29, 17


def src(seed, w=W, h=H, alpha=True):
    rng = np.random.default_rng(seed)
    u8 = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
    if not alpha:
        u8[..., 3] = 255
    return u8


def comp(nodes, out="Output1", frames=10, w=W, h=H):
    return {"comp": 1, "format": {"width": w, "height": h, "fps": 24, "frames": frames}, "nodes": nodes, "output": out}


def read(i, **kw):
    return dict({"id": f"Read{i}", "type": "read", "file": f"r{i}.png", "inputs": []}, **kw)


def out(src_id):
    return {"id": "Output1", "type": "output", "inputs": [src_id]}


def merge(i, b, a, m=None, **kw):
    return dict({"id": f"Merge{i}", "type": "merge", "inputs": [b, a, m]}, **kw)


def cases():
    s1, s2, s3 = src(1), src(2), src(3, 11, 7)
    sources = {"Read1": s1, "Read2": s2}
    c = []
    for op in M.MERGE_OPS:
        c.append(({"comp": comp([read(1), read(2), merge(1, "Read1", "Read2", operation=op, mix=0.7), out("Merge1")])}, sources))
    c.append(({"comp": comp([read(1), read(2), read(3), merge(1, "Read1", "Read2", "Read3"), out("Merge1")])},
              dict(sources, Read3=src(4))))
    for fit in M.FITS:
        c.append(({"comp": comp([read(3, fit=fit), out("Read3")])}, {"Read3": s3}))
    c.append(({"comp": comp([read(1), {"id": "Transform1", "type": "transform", "inputs": ["Read1"], "translate": [3.25, -2],
                                        "rotate": 17, "scale": [1.3, 0.8], "center": [10, 5]}, out("Transform1")])}, sources))
    c.append(({"comp": comp([read(1), {"id": "Grade1", "type": "grade", "inputs": ["Read1"], "blackpoint": 0.05, "whitepoint": 0.9,
                                        "lift": 0.02, "gain": 1.4, "multiply": 1.1, "offset": -0.01, "gamma": 1.7,
                                        "saturation": 0.4, "mix": 0.8}, out("Grade1")])}, sources))
    for size in (0.5, 3, 7.5):
        c.append(({"comp": comp([read(1), {"id": "Blur1", "type": "blur", "inputs": ["Read1"], "size": size}, out("Blur1")])}, sources))
    c.append(({"comp": comp([{"id": "Constant1", "type": "constant", "color": [0.2, 0.5, 1.5, 0.6], "inputs": []}, out("Constant1")])}, {}))
    # keys: Motion's eases at a frame between two keys
    for ease in ("smooth", "linear", "hold", "easeIn", "backOut", [0.2, 0.1, 0.3, 1]):
        t = {"id": "Transform1", "type": "transform", "inputs": ["Read1"],
             "tracks": {"translate": [{"f": 0, "v": [0, 0], "ease": ease}, {"f": 8, "v": [6, -4]}],
                        "rotate": [{"f": 2, "v": 0, "ease": ease, "to": 3}, {"f": 9, "v": 30}]}}
        c.append(({"comp": comp([read(1), t, out("Transform1")]), "frame": 5}, sources))
    c.append(({"comp": comp([read(1), read(2), merge(1, "Read1", "Read2", disable=True), out("Merge1")])}, sources))
    c.append(({"comp": comp([read(1), {"id": "Blur1", "type": "blur", "inputs": ["Read1"], "size": 6}, out("Blur1")]), "scale": 0.5}, sources))
    for fit in ("none", "fit"):   # at a proxy scale "none" keeps the picture's size in the comp
        c.append(({"comp": comp([read(3, fit=fit), out("Read3")], w=40, h=24), "scale": 0.5}, {"Read3": s3}))
    straight = {"Read1": src(9, alpha=False)}
    c.append(({"comp": comp([read(1, colorspace="linear"), out("Read1")])}, straight))
    return c


class CompParity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not shutil.which("node"):
            raise unittest.SkipTest("node is not on PATH")
        cls.cases = cases()
        payload = []
        for spec_, sources in cls.cases:
            payload.append({"comp": spec_["comp"], "frame": spec_.get("frame", 0), "scale": spec_.get("scale", 1),
                            "sources": {k: {"w": int(v.shape[1]), "h": int(v.shape[0]), "u8": v.reshape(-1).tolist(),
                                            "linear": next((n.get("colorspace") == "linear" for n in spec_["comp"]["nodes"] if n["id"] == k), False)}
                                        for k, v in sources.items()}})
        tmp = tempfile.mkdtemp()
        cls.tmp = tmp
        a, b = os.path.join(tmp, "cases.json"), os.path.join(tmp, "out.json")
        with open(a, "w") as fh:
            json.dump(payload, fh)
        subprocess.run(["node", os.path.join(HERE, "comp_parity.mjs"), a, b], check=True, cwd=ROOT)
        with open(b) as fh:
            cls.js = json.load(fh)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    def test_the_node_tables_agree(self):
        for t, d in M.NODE_TYPES.items():
            self.assertIn(t, self.js["table"])
            js = self.js["table"][t]
            self.assertEqual(js["inputs"], d["inputs"], t)
            self.assertEqual(sorted(js["params"]), sorted(d["params"]), t)
            for p, pd in d["params"].items():
                j = js["params"][p]
                self.assertEqual((j["kind"], j["def"], j["key"]), (pd["kind"], pd["def"], bool(pd.get("key"))), f"{t}.{p}")
                self.assertEqual((j["min"], j["max"]), (pd.get("min"), pd.get("max")), f"{t}.{p}")
                if pd.get("choices") is not None:
                    self.assertEqual(j["choices"], pd["choices"], f"{t}.{p}")
        self.assertEqual(sorted(self.js["table"]), sorted(M.NODE_TYPES))

    def test_every_case_renders_the_same(self):
        for i, (spec_, sources) in enumerate(self.cases):
            with self.subTest(i=i, nodes=[n["type"] + ":" + str(n.get("operation", "")) for n in spec_["comp"]["nodes"]]):
                c, _ = M.normalize(spec_["comp"])
                pics = {}
                for k, v in sources.items():
                    node = M.node_by_id(c, k)
                    pics[k] = M.decode8(v, linear=(node or {}).get("colorspace") == "linear")
                img = M.render_node(c, c["output"], spec_.get("frame", 0), lambda n, f: pics.get(n["id"]), spec_.get("scale", 1))
                js = self.js["pictures"][i]
                self.assertEqual((js["w"], js["h"]), (img.shape[1], img.shape[0]))
                ref = np.asarray(js["data"], np.float32).reshape(img.shape)
                diff = float(np.max(np.abs(ref - img))) if img.size else 0.0
                self.assertLess(diff, 2e-5, f"case {i}: max difference {diff}")


if __name__ == "__main__":
    unittest.main()
