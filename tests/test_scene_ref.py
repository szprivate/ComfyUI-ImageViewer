"""previz.scene_versions / resolve_reference: which file a referenced scene reads.

Run: python -m unittest tests.test_scene_ref
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import types
import unittest

sys.modules.setdefault("folder_paths", types.SimpleNamespace(get_output_directory=lambda: tempfile.gettempdir()))
_spec = importlib.util.spec_from_file_location(
    "previz_for_ref", os.path.join(os.path.dirname(__file__), "..", "src", "previz.py"))
pv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pv)


def _write(path, n=1):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"items": [{"id": "m", "kind": "model", "src": {"path": "x.glb"}, "n": n}]}, fh)
    return path


class SceneRefTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_plain_versions_beside_each_other(self):
        d = os.path.join(self.root, "imageviewer", "scenes")
        v1 = _write(os.path.join(d, "hero_v001.json"))
        _write(os.path.join(d, "hero_v002.json"))
        v10 = _write(os.path.join(d, "hero_v010.json"))
        _write(os.path.join(d, "hero_extra_v005.json"))     # another scene
        self.assertEqual([v for v, _ in pv.scene_versions(v1)], [1, 2, 10])
        latest = pv.resolve_reference(v1, "latest")
        self.assertEqual(latest["path"], os.path.abspath(v10))
        self.assertEqual(latest["version"], 10)
        pinned = pv.resolve_reference(v1, "pinned")
        self.assertEqual(pinned["path"], os.path.abspath(v1))
        self.assertEqual(pinned["version"], 1)

    def test_shot_layout_has_a_folder_per_version(self):
        base = os.path.join(self.root, "SQ01", "SH010", "scenes")
        v1 = _write(os.path.join(base, "v001", "sh010_v001_hero.json"))
        _write(os.path.join(base, "v002", "sh010_v002_set.json"))     # another scene's version 2
        v3 = _write(os.path.join(base, "v003", "sh010_v003_hero.json"))
        self.assertEqual(pv.resolve_reference(v1)["path"], os.path.abspath(v3))
        self.assertEqual(pv.resolve_reference(v1)["version"], 3)

    def test_an_unversioned_file_is_itself_and_its_mtime_moves(self):
        f = _write(os.path.join(self.root, "char.json"))
        a = pv.resolve_reference(f)
        self.assertEqual(a["path"], os.path.abspath(f))
        self.assertIsNone(a["version"])
        time.sleep(0.02)
        os.utime(f, (time.time() + 5, time.time() + 5))
        self.assertNotEqual(pv.resolve_reference(f)["mtime"], a["mtime"])
        self.assertIsNone(pv.resolve_reference(os.path.join(self.root, "gone.json")))


if __name__ == "__main__":
    unittest.main()
