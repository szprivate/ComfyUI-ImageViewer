"""The pose library's store and routes (src/rig_poses.py).

    python -m unittest discover -s tests -p test_rig_poses.py
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
import rig_poses  # noqa: E402

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover
    web = None

POSE = {
    "name": "Wave hello", "model": "Hero", "created": 5,
    "controls": {"fk:LeftArm": {"position": [0, 0, 0], "rotation": [0, 0, -60], "role": "upperArm.L"},
                 "ik:arm.L": {"position": [0.1, 0.2, 0.3], "rotation": [1, 2, 3], "ikfk": 7},
                 "bad": "nope"},
    "blendshapes": {"jawOpen": 0.4, "x": 9},
    "thumb": "data:image/png;base64,iVBORw0KGgo=",
}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_a_pose_is_cleaned_kept_listed_renamed_and_deleted(self):
        saved = rig_poses.save_pose(POSE, self.dir)
        self.assertEqual(saved["controls"]["ik:arm.L"]["ikfk"], 1.0)      # held to 0..1
        self.assertNotIn("bad", saved["controls"])
        self.assertNotIn("role", saved["controls"]["fk:LeftArm"].keys() - {"role"})
        self.assertEqual(saved["blendshapes"]["x"], 1.0)
        self.assertTrue(saved["thumb"].startswith("data:image/png"))
        self.assertEqual(os.listdir(self.dir), ["wave hello.json"])
        # A newer pose of another name lists first; the same name in another case replaces.
        rig_poses.save_pose({**POSE, "name": "Crouch", "created": 9}, self.dir)
        rig_poses.save_pose({**POSE, "name": "WAVE HELLO", "created": 1}, self.dir)
        names = [p["name"] for p in rig_poses.list_poses(self.dir)]
        self.assertEqual(names, ["Crouch", "WAVE HELLO"])
        rig_poses.rename_pose("crouch", "Crouch low", self.dir)
        self.assertEqual(sorted(os.listdir(self.dir)), ["crouch low.json", "wave hello.json"])
        self.assertTrue(rig_poses.delete_pose("Crouch low", self.dir))
        self.assertFalse(rig_poses.delete_pose("Crouch low", self.dir))

    def test_names_cannot_leave_the_folder_and_bad_poses_are_refused(self):
        for evil in ["../../etc/passwd", "..\\..\\win.ini", "CON", "a/b", "\x00x"]:
            name = rig_poses.file_name(evil)
            self.assertNotIn("/", name)
            self.assertNotIn("\\", name)
            self.assertFalse(name.startswith("."))
        self.assertEqual(rig_poses.file_name("CON"), "_con.json")
        for bad in [None, {"name": "x"}, {"name": "", "controls": {"a": {"rotation": [0, 0, 0]}}}, {"name": "x", "controls": {"a": {}}}]:
            with self.assertRaises(ValueError):
                rig_poses.save_pose(bad, self.dir)
        p = rig_poses.clean_pose({**POSE, "thumb": "javascript:alert(1)"})
        self.assertNotIn("thumb", p)


@unittest.skipIf(web is None, "aiohttp is not installed")
class RouteTests(unittest.TestCase):
    def test_the_routes_list_save_rename_delete_and_refuse_other_sites(self):
        folder = tempfile.mkdtemp()
        os.environ["IMAGE_VIEWER_POSES"] = folder

        class Access:
            @staticmethod
            def same_origin(request):
                if (request.headers.get("Content-Type") or "").split(";")[0] != "application/json":
                    return False, "Refused: the request must be sent as application/json."
                return True, ""

        async def run():
            app = web.Application()
            rig_poses.register(lambda m, p, h: app.router.add_route(m, p, h), web=web, path_access=Access)
            async with TestClient(TestServer(app)) as c:
                post = lambda body: c.post("/imageviewer/rig/poses", json=body)
                r = await post({"op": "list"})
                self.assertEqual((await r.json())["poses"], [])
                r = await post({"op": "save", "pose": POSE})
                self.assertEqual(r.status, 200)
                r = await post({"op": "list"})
                self.assertEqual([p["name"] for p in (await r.json())["poses"]], ["Wave hello"])
                r = await post({"op": "rename", "name": "Wave hello", "to": "Wave"})
                self.assertEqual((await r.json())["pose"]["name"], "Wave")
                r = await post({"op": "rename", "name": "nothing", "to": "x"})
                self.assertEqual(r.status, 404)
                r = await post({"op": "save", "pose": {"name": "x"}})
                self.assertEqual(r.status, 400)
                r = await c.post("/api/imageviewer/rig/poses", data=json.dumps({"op": "list"}), headers={"Content-Type": "text/plain"})
                self.assertEqual(r.status, 403)
                r = await post({"op": "delete", "name": "Wave"})
                self.assertTrue((await r.json())["ok"])
                self.assertEqual(os.listdir(folder), [])

        try:
            asyncio.run(run())
        finally:
            os.environ.pop("IMAGE_VIEWER_POSES", None)


if __name__ == "__main__":
    unittest.main()
