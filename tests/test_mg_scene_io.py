"""mg_scene_io: the Motion panel's scene file guard. Run: python -m unittest tests.test_mg_scene_io"""
import importlib.util
import json
import os
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "mg_scene_io", os.path.join(os.path.dirname(__file__), "..", "mg_scene_io.py"))
io = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(io)

SCENE = {"mgscene": 1, "comp": {"width": 1280, "height": 720, "fps": 30, "duration": 30}, "layers": []}


class SceneIoTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def test_only_scene_names(self):
        self.assertTrue(io.is_scene_path("a/b.mgscene.json"))
        self.assertTrue(io.is_scene_path("A.MGSCENE.JSON"))
        self.assertFalse(io.is_scene_path("a/b.json"))
        with self.assertRaises(ValueError):
            io.check_path("/etc/passwd")

    def test_write_then_read_round_trips(self):
        p = os.path.join(self.d, "sub", "x.mgscene.json")
        io.write(p, SCENE)
        self.assertEqual(io.read(p), SCENE)
        self.assertEqual([n for n in os.listdir(os.path.dirname(p)) if n.endswith(".tmp")], [])

    def test_refuses_things_that_are_not_scenes(self):
        p = os.path.join(self.d, "x.mgscene.json")
        for bad in (None, [], {"layers": []}, {"mgscene": 2, "comp": {}, "layers": []}, {"mgscene": 1, "comp": {}}):
            with self.assertRaises(ValueError):
                io.write(p, bad)
        self.assertFalse(os.path.exists(p))

    def test_read_rejects_non_objects(self):
        p = os.path.join(self.d, "x.mgscene.json")
        with open(p, "w") as fh:
            json.dump([1, 2], fh)
        with self.assertRaises(ValueError):
            io.read(p)


if __name__ == "__main__":
    unittest.main()
