"""The scene's interpolation in Python (usd_io.value_at, what a USD export bakes) against the
viewer's (imageViewer_scene3d.js valueAt), on random tracks with every infinity mode.

Needs node; skipped without it. Run: python -m unittest tests.test_scene_infinity_parity
"""
import importlib.util
import json
import os
import pathlib
import random
import shutil
import subprocess
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_spec = importlib.util.spec_from_file_location("usd_io_parity", os.path.join(ROOT, "src", "usd_io.py"))
usd_io = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(usd_io)

MODES = ["constant", "linear", "cycle", "offset", "oscillate"]
EASES = ["smooth", "linear", "hold"]

JS = """
import * as S from '%s';
import { readFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(0, 'utf8'));
const out = items.map((it) => it.frames.map((f) => S.valueAt(it, it.prop, f)));
console.log(JSON.stringify(out));
"""


def _cases(seed=7, n=60):
    rnd = random.Random(seed)
    items = []
    for i in range(n):
        prop = rnd.choice(["position", "rotation", "fov"])
        keys, f = [], rnd.randint(-5, 10)
        for _ in range(rnd.randint(2, 5)):
            v = rnd.uniform(-200, 200) if prop == "fov" else [rnd.uniform(-200, 200) for _ in range(3)]
            key = {"f": f, "v": v, "ease": rnd.choice(EASES)}
            if rnd.random() < 0.4:
                t = rnd.uniform(-5, 5)
                key["to"] = t if prop == "fov" else [t, -t, t / 2]
                key["ti"] = key["to"]
            keys.append(key)
            f += rnd.randint(1, 12)
        item = {"id": f"i{i}", "kind": "camera" if prop == "fov" else "primitive", "prop": prop,
                "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "fov": 35,
                "tracks": {prop: keys},
                "infinity": {prop: {"pre": rnd.choice(MODES), "post": rnd.choice(MODES)}},
                "frames": [x * 0.5 for x in range(-80, 160)]}
        items.append(item)
    return items


@unittest.skipIf(shutil.which("node") is None, "needs node")
class InfinityParityTests(unittest.TestCase):
    def test_python_bakes_what_the_viewer_draws(self):
        items = _cases()
        url = pathlib.Path(ROOT, "js", "imageViewer_scene3d.js").as_uri()
        js = subprocess.run(["node", "--input-type=module", "-e", JS % url], input=json.dumps(items),
                            capture_output=True, text=True, check=True, cwd=ROOT)
        want = json.loads(js.stdout)
        for item, values in zip(items, want):
            for frame, w in zip(item["frames"], values):
                got = usd_io.value_at(item, item["prop"], frame)
                a = got if isinstance(got, list) else [got]
                b = w if isinstance(w, list) else [w]
                for x, y in zip(a, b):
                    self.assertAlmostEqual(x, y, places=6,
                                           msg=f"{item['id']} {item['infinity']} at {frame}")

    def test_infinity_makes_a_bake_cover_the_shot(self):
        item = {"tracks": {"position": [{"f": 0, "v": [0, 0, 0]}, {"f": 10, "v": [1, 0, 0]}]}}
        self.assertFalse(usd_io.has_infinity(item))
        item["infinity"] = {"position": {"pre": "constant", "post": "cycle"}}
        self.assertTrue(usd_io.has_infinity(item))


if __name__ == "__main__":
    unittest.main()
