"""Matchmove (matchmove.py, matchmove_solve.py, matchmove_routes.py): synthetic plates whose camera, lens and
motion are known, solved back.

    python -m unittest discover -s tests -p test_matchmove.py
"""
import asyncio
import importlib
import math
import os
import shutil
import sys
import tempfile
import time
import types
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_pkg = types.ModuleType("imageviewer_mm_under_test")
_pkg.__path__ = [os.path.join(ROOT, "src")]
sys.modules.setdefault("imageviewer_mm_under_test", _pkg)
MM = importlib.import_module("imageviewer_mm_under_test.matchmove")
S = importlib.import_module("imageviewer_mm_under_test.matchmove_solve")
WP = importlib.import_module("imageviewer_mm_under_test.comp_warp")
T = importlib.import_module("imageviewer_mm_under_test.comp_track")

W, H, F = 1920, 1080, 1500.0


def scene(n_frames=40, lens=None, noise=0.25, tripod=False, seed=1, w=W, h=H, f=F):
    """Tracks of 300 random points seen by a camera that moves (or only turns): (tracks, poses)."""
    rng = np.random.default_rng(seed)
    X = np.c_[rng.uniform(-8, 8, 300), rng.uniform(-4, 4, 300), rng.uniform(8, 30, 300)]
    poses = []
    for fr in range(n_frames):
        a = fr / n_frames
        R = S.rodrigues(np.array([0.05 * math.sin(a * 3), 0.3 * a, 0.02]))
        C = np.zeros(3) if tripod else np.array([3 * a, 0.3 * math.sin(a * 6), 1.5 * a])
        poses.append((R, -R @ C))
    tracks = []
    for i, P in enumerate(X):
        keys = []
        for fr, (R, t) in enumerate(poses):
            pc = R @ P + t
            uv = f * pc[:2] / pc[2] + [w / 2, h / 2]
            if pc[2] > 0 and 0 < uv[0] < w and 0 < uv[1] < h:
                keys.append([fr, *uv])
        if len(keys) < 2:
            continue
        a = np.asarray(keys)
        xy = a[:, 1:] + rng.normal(0, noise, (len(a), 2))
        if lens:
            xy = MM.distort_points(xy, lens, w, h)
        tracks.append({"id": f"t{i}", "group": "camera", "keys": [[int(k[0]), x, y, 1] for k, (x, y) in zip(a, xy)]})
    return tracks, poses


def centres(frames):
    return np.array([-np.array(v["R"]).T @ np.array(v["t"]) for _, v in sorted(frames.items(), key=lambda kv: int(kv[0]))])


class Solve(unittest.TestCase):
    def test_a_moving_camera_with_a_known_lens_and_focal_length(self):
        lens = {"k1": -0.06, "k2": 0.01}
        tr, poses = scene(lens=lens)
        r = S.solve(MM.clean_tracks(tr), W, H, lens=lens, focal_px=F)
        self.assertNotIn("error", r, r.get("error"))
        self.assertEqual(r["mode"], "free")
        self.assertEqual(len(r["frames"]), 40)
        self.assertLess(r["rms"], 0.6)
        # the path, up to scale
        got, want = centres(r["frames"]), np.array([-R.T @ t for R, t in poses])
        got, want = got - got.mean(0), want - want.mean(0)
        s = np.linalg.norm(want) / np.linalg.norm(got)
        Rr = S.kabsch(got, want)            # the solve's world is the first camera's: turned and scaled
        self.assertLess(np.abs(got @ Rr.T * s - want).max(), 0.05)

    def test_an_unknown_focal_length_is_found(self):
        tr, _ = scene(n_frames=30, seed=4)
        r = S.solve(MM.clean_tracks(tr), W, H, focal_px=None)
        self.assertNotIn("error", r, r.get("error"))
        self.assertAlmostEqual(r["focal_px"], F, delta=F * 0.01)

    def test_a_camera_that_only_turns_is_solved_as_a_tripod(self):
        tr, _ = scene(n_frames=30, tripod=True, seed=3)
        r = S.solve(MM.clean_tracks(tr), W, H, focal_px=F, mode="auto")
        self.assertEqual(r["mode"], "tripod")
        self.assertLess(r["rms"], 0.6)
        self.assertTrue(any("tripod" in n for n in r["notes"]))

    def test_an_object_moving_in_the_shot(self):
        tr, poses = scene(n_frames=40, noise=0.2)
        rng = np.random.default_rng(5)
        Xo = rng.uniform(-1, 1, (40, 3))
        for i, P in enumerate(Xo):
            keys = []
            for fr, (R, t) in enumerate(poses):
                a = fr / 40
                Ro = S.rodrigues(np.array([0, 2.0 * a, 0.3 * a]))
                pc = R @ (Ro @ P + [-2 + 3 * a, 0, 12]) + t
                keys.append([fr, *(F * pc[:2] / pc[2] + [W / 2, H / 2] + rng.normal(0, 0.2, 2)), 1])
            tr.append({"id": f"o{i}", "group": "car", "keys": keys})
        tr = MM.clean_tracks(tr)
        cam = S.solve(tr, W, H, focal_px=F)
        self.assertLess(cam["rms"], 0.5)          # the car's tracks are not the camera's
        ob = S.solve_object(tr, "car", cam, W, H)
        self.assertNotIn("error", ob, ob.get("error"))
        R0, R1 = np.array(ob["frames"][0]["R"]), np.array(ob["frames"][39]["R"])
        self.assertAlmostEqual(np.linalg.norm(S.rot_log(R1 @ R0.T)), np.linalg.norm([0, 2 * 39 / 40, 0.3 * 39 / 40]), delta=0.02)

    def test_too_few_tracks_say_so(self):
        r = S.solve([], W, H)
        self.assertIn("error", r)


class Lens(unittest.TestCase):
    def chart(self, w=1280, h=720, lens=None, lines=False):
        f = 1000.0
        Rb = S.rodrigues(np.array([0.35, -0.25, 0.05]))
        tb = np.array([0, 0, 9.0])
        src = np.array([[0, 0], [10, 0], [0, 10], [10, 10]], float)
        P = np.c_[src * 0.5, np.zeros(4)] @ Rb.T + tb
        dst = f * P[:, :2] / P[:, 2:3] + [w / 2, h / 2]
        Hm = T.fit_homography(dst, src)
        ys, xs = np.mgrid[0:h, 0:w] + 0.5
        ux, uy = WP.lens_points(xs, ys, "undistort", lens["k1"], lens["k2"], w / 2, h / 2, math.hypot(w, h) / 2)
        b = T.apply(Hm, np.c_[ux.ravel(), uy.ravel()])
        if lines:
            d = np.minimum(np.abs(b[:, 0] - np.round(b[:, 0])), np.abs(b[:, 1] - np.round(b[:, 1]))).reshape(h, w)
            img = (d < 0.06).astype(np.float32)
        else:
            img = ((np.floor(b[:, 0]) + np.floor(b[:, 1])) % 2).reshape(h, w).astype(np.float32) * 0.8 + 0.1
        return MM._blur_gauss(img, 1.0)

    def test_a_checkerboard_gives_the_comp_lens_numbers_and_the_focal_length(self):
        lens = {"k1": -0.08, "k2": 0.02}
        r = MM.solve_lens_grid([self.chart(lens=lens)], 1280, 720)
        self.assertAlmostEqual(r["k1"], -0.08, delta=0.004)
        self.assertAlmostEqual(r["k2"], 0.02, delta=0.006)
        self.assertLess(r["error"], 0.5)
        self.assertGreater(r["coverage"], 0.9)
        self.assertAlmostEqual(r["focal_px"], 1000, delta=15)

    def test_a_grid_of_lines(self):
        lens = {"k1": -0.08, "k2": 0.02}
        r = MM.solve_lens_grid([self.chart(lens=lens, lines=True)], 1280, 720)
        self.assertAlmostEqual(r["k1"], -0.08, delta=0.01)

    def test_no_chart_says_so(self):
        r = MM.solve_lens_grid([np.zeros((200, 300), np.float32)], 300, 200)
        self.assertEqual(r["points"], 0)
        self.assertTrue(r["notes"])

    def test_lines_straightened(self):
        lens = {"k1": -0.1, "k2": 0.0}
        lines = []
        for y in (100, 300, 600, 900):
            pts = np.c_[np.linspace(50, 1870, 12), np.full(12, float(y))]
            lines.append(MM.distort_points(pts, lens, W, H).tolist())
        r = MM.solve_lens_lines(lines, W, H, use_k2=False)
        self.assertAlmostEqual(r["k1"], -0.1, delta=0.005)

    def test_undistort_and_distort_are_each_others_inverse(self):
        lens = {"k1": -0.1, "k2": 0.03, "center": [950, 530]}
        p = np.array([[10.0, 20.0], [1900, 1000], [960, 540]])
        back = MM.undistort_points(MM.distort_points(p, lens, W, H), lens, W, H)
        self.assertLess(np.abs(back - p).max(), 1e-6)


class Tracking(unittest.TestCase):
    def test_features_follow_a_moving_picture_and_keep_out_of_masks(self):
        rng = np.random.default_rng(2)
        w, h = 640, 360
        base = MM._blur_gauss(rng.random((h * 2, w * 2)).astype(np.float32), 2.0)

        def frame(f):
            xs = np.arange(w)[None, :] + 0.5 + 3.3 * f + 200 + 0 * np.arange(h)[:, None]
            ys = np.arange(h)[:, None] + 0.5 + 1.7 * f + 100 + 0 * np.arange(w)[None, :]
            return T.sample(base, xs, ys).astype(np.float32)
        masks = [{"id": "m", "mode": "exclude", "keys": [{"f": 0, "pts": [[0, 0], [200, 0], [200, 200], [0, 200]]}]},
                 {"id": "o", "mode": "object", "object": "car",
                  "keys": [{"f": 0, "pts": [[400, 200], [600, 200], [600, 340], [400, 340]]}]}]
        tr = MM.auto_track(frame, range(10), n=80, masks=masks)
        self.assertGreater(len(tr), 40)
        errs = []
        for t in tr:
            k0 = t["keys"][0]
            self.assertFalse(k0[1] < 200 and k0[2] < 200, "started under an exclude mask")
            for k in t["keys"][1:]:
                df = k[0] - k0[0]
                errs.append(math.hypot(k[1] - (k0[1] - 3.3 * df), k[2] - (k0[2] - 1.7 * df)))
        self.assertLess(np.median(errs), 0.1)
        self.assertTrue(any(t["group"] == "car" for t in tr))

    def test_mask_keys_are_straight_in_between(self):
        m = MM.clean_mask({"keys": [{"f": 0, "pts": [[0, 0], [10, 0], [0, 10]]},
                                    {"f": 10, "pts": [[10, 0], [20, 0], [10, 10]]}]})
        self.assertEqual(MM.mask_at(m, 5)[0].tolist(), [5, 0])
        self.assertEqual(MM.mask_at(m, -3)[0].tolist(), [0, 0])
        self.assertEqual(MM.mask_at(m, 30)[0].tolist(), [10, 0])
        self.assertEqual(MM.inside([[0, 0], [10, 0], [10, 10], [0, 10]], [[5, 5], [15, 5]]).tolist(), [True, False])


class Facts(unittest.TestCase):
    def test_exif_gives_the_focal_length_and_the_sensor(self):
        from PIL import Image
        tmp = tempfile.mkdtemp()
        try:
            p = os.path.join(tmp, "plate.jpg")
            im = Image.new("RGB", (600, 400))
            ex = Image.Exif()
            ex[0x010F] = "Maker"
            ex[0x0110] = "ALEXA Mini LF"
            ifd = ex.get_ifd(0x8769)
            ifd[0x920A] = 35.0
            im.save(p, exif=ex)
            facts = MM.camera_facts(p, None, 600, 400)
            self.assertEqual(facts["focal_mm"], 35.0)
            self.assertEqual(facts["sensor_mm"], [36.70, 25.54])
            self.assertAlmostEqual(facts["fov_h"], 2 * math.degrees(math.atan(36.7 / 70)), places=2)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_35mm_equivalent_gives_a_sensor(self):
        f = MM.camera_facts("/nonexistent/plate.mov", None, 1920, 1080)
        self.assertTrue(f["notes"])

    def test_a_camera_file_beside_the_plate(self):
        tmp = tempfile.mkdtemp()
        try:
            p = os.path.join(tmp, "shot.mov")
            open(p, "wb").close()
            with open(os.path.join(tmp, "shot.camera.json"), "w") as fh:
                fh.write('{"focal_mm": 50, "sensor_mm": [24.89, 18.66]}')
            facts = MM.camera_facts(p, None, 1920, 1080)
            self.assertEqual(facts["focal_mm"], 50)
            self.assertIn("camera file", facts["sources"]["focal_mm"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


try:
    from test_edit_takes import _load, web  # noqa: E402
except Exception:  # noqa: BLE001
    web = None
if web is not None:
    from aiohttp.test_utils import TestClient, TestServer


@unittest.skipIf(web is None, "needs aiohttp")
class Routes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        from PIL import Image
        rng = np.random.default_rng(1)
        base = (MM._blur_gauss(rng.random((300, 500)).astype(np.float32), 1.5) * 255).astype(np.uint8)
        cls.seq = os.path.join(cls.dirs["output"], "plate.####.png")
        for f in range(6):
            Image.fromarray(np.roll(base, 2 * f, axis=1)[:200, :320]).convert("RGB").save(
                os.path.join(cls.dirs["output"], f"plate.{1001 + f:04d}.png"))

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_c(self, fn):
        async def go():
            app = web.Application(client_max_size=1 << 28)
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    async def wait(self, c, jid):
        for _ in range(200):
            r = await c.get("/imageviewer/mm_job", params={"job": jid})
            d = await r.json()
            if d["state"] != "running":
                return d
            await asyncio.sleep(0.05)
        self.fail("the job did not end")

    def test_plate_frame_track_and_comp(self):
        async def go(c):
            r = await c.get("/imageviewer/mm_plate", params={"path": self.seq})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertEqual((d["frames"], d["width"], d["height"]), (6, 320, 200))
            r = await c.get("/imageviewer/mm_frame", params={"path": self.seq, "frame": 2, "size": 160, "k1": -0.05})
            self.assertEqual(r.headers["Content-Type"], "image/jpeg")
            r = await c.post("/imageviewer/mm_track", json={"path": self.seq, "from": 0, "to": 5, "n": 40})
            jid = (await r.json())["job"]
            d = await self.wait(c, jid)
            self.assertEqual(d["state"], "done", d)
            self.assertGreater(len(d["tracks"]), 10)
            k = d["tracks"][0]["keys"]
            self.assertAlmostEqual(k[1][1] - k[0][1], 2.0, delta=0.15)     # the picture moves 2 px a frame
            r = await c.post("/imageviewer/mm_to_comp", json={"path": self.seq, "lens": {"k1": -0.04, "k2": 0.01}})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertTrue(d["path"].endswith(".comp.json"))
            r = await c.get("/imageviewer/mm_from_comp", params={"path": d["path"]})
            back = await r.json()
            self.assertEqual((back["k1"], back["k2"]), (-0.04, 0.01))
        self.run_c(go)

    def test_one_frame_of_a_sequence_is_the_sequence(self):
        async def go(c):
            one = os.path.join(self.dirs["output"], "plate.1003.png")
            d = await (await c.get("/imageviewer/mm_plate", params={"path": one})).json()
            self.assertEqual(d["frames"], 6)
            self.assertTrue(d["path"].endswith("plate.####.png"))
        self.run_c(go)

    def test_a_matchmove_is_saved_by_the_rule_then_over_itself(self):
        async def go(c):
            data = {"v": 1, "tracks": [{"id": "t1", "keys": [[0, 1, 2, 1]]}]}
            r = await c.post("/imageviewer/mm_save", json={"data": data, "name": "shot010"})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertTrue(d["path"].endswith(".mm.json"))
            self.assertIn("matchmove", d["path"])
            data["step"] = "track"
            r = await c.post("/imageviewer/mm_save", json={"data": data, "path": d["path"]})
            self.assertEqual((await r.json())["path"], d["path"])
            back = await (await c.get("/imageviewer/mm_load", params={"path": d["path"]})).json()
            self.assertEqual(back["data"], data)
            r = await c.post("/imageviewer/mm_save", json={"data": data, "path": os.path.join(self.dirs["output"], "x.json")})
            self.assertEqual(r.status, 403)
            r = await c.get("/imageviewer/mm_load", params={"path": "/etc/passwd"})
            self.assertEqual(r.status, 403)
        self.run_c(go)

    def test_a_plate_outside_the_allowed_folders_is_refused(self):
        async def go(c):
            r = await c.get("/imageviewer/mm_plate", params={"path": "/etc/hostname"})
            self.assertIn(r.status, (403, 404))
        self.run_c(go)

    def test_a_solve_job(self):
        tr, _ = scene(n_frames=20)

        async def go(c):
            r = await c.post("/imageviewer/mm_solve", json={"width": W, "height": H, "tracks": tr, "focal_px": F})
            jid = (await r.json())["job"]
            for _ in range(600):
                d = await (await c.get("/imageviewer/mm_job", params={"job": jid})).json()
                if d["state"] != "running":
                    break
                await asyncio.sleep(0.1)
            self.assertEqual(d["state"], "done", d.get("error"))
            self.assertLess(d["result"]["rms"], 0.6)
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
