"""previz_shot: the shots an agent asks for. Run: python -m unittest tests.test_previz_shot"""
import importlib.util
import os
import unittest

_spec = importlib.util.spec_from_file_location(
    "previz_shot", os.path.join(os.path.dirname(__file__), "..", "previz_shot.py"))
ps = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ps)


def scene(**kw):
    return {"items": [{"id": "m1", "kind": "model"}, {"id": "cam", "kind": "camera"}], **kw}


class ShotTests(unittest.TestCase):
    def test_scene_only_is_done(self):
        job = ps.ShotBook().new_job({"scene": scene(), "name": "my shot!"})
        self.assertEqual(job["state"], "done")
        self.assertEqual(job["key"], "previz:my_shot")
        self.assertIsNone(job["render"])

    def test_render_picks_the_active_camera(self):
        job = ps.ShotBook().new_job({"scene": scene(activeCamera="cam"), "render": {"format": "mov"}})
        self.assertEqual(job["state"], "queued")
        self.assertEqual(job["render"]["camera"], "cam")
        self.assertEqual(job["render"]["format"], "mov")

    def test_unknown_render_keys_are_dropped(self):
        job = ps.ShotBook().new_job({"scene": scene(), "render": {"camera": "cam", "evil": 1, "aa": 4}})
        self.assertEqual(job["render"], {"camera": "cam", "aa": 4, "format": "mp4"})

    def test_bad_requests(self):
        b = ps.ShotBook()
        for data in (None, {}, {"scene": {"items": []}}, {"scene": {"items": [{"id": "a"}, {"id": "a"}]}},
                     {"scene": scene(), "render": {"camera": "nope"}},
                     {"scene": {"items": [{"id": "m", "kind": "model"}]}, "render": {"format": "mp4"}}):
            with self.assertRaises(ValueError):
                b.new_job(data)

    def test_report_and_public(self):
        b = ps.ShotBook()
        job = b.new_job({"scene": scene(), "render": {"camera": "cam"}})
        self.assertTrue(b.report({"id": job["id"], "state": "rendering", "done": 3, "total": 10}))
        self.assertTrue(b.report({"id": job["id"], "state": "done", "path": "C:/x.mp4"}))
        pub = b.public(b.get(job["id"]))
        self.assertEqual((pub["state"], pub["done"], pub["path"]), ("done", 3, "C:/x.mp4"))
        self.assertFalse(b.report({"id": "nope"}))

    def test_book_is_bounded(self):
        b = ps.ShotBook()
        ids = [b.new_job({"scene": scene()})["id"] for _ in range(ps.MAX_JOBS + 5)]
        self.assertIsNone(b.get(ids[0]))
        self.assertIsNotNone(b.get(ids[-1]))


if __name__ == "__main__":
    unittest.main()
