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

    def test_a_matte_mask_keeps_features_off_it_frame_by_frame(self):
        from PIL import Image
        rng = np.random.default_rng(4)
        w, h = 320, 200
        base = MM._blur_gauss(rng.random((h, w)).astype(np.float32), 1.5)
        tmp = tempfile.mkdtemp()
        try:
            # the matte's white square moves 10 px a frame to the right; frames 1 and 3 have none of their own
            for f in (0, 2, 4):
                a = np.zeros((h, w), np.uint8)
                a[40:140, 20 + 10 * f:120 + 10 * f] = 255
                Image.fromarray(a).save(os.path.join(tmp, f"matte.{f:04d}.png"))
            m = MM.clean_mask({"id": "m", "mode": "exclude", "keys": [],
                               "matte": {"pattern": os.path.join(tmp, "matte.####.png"), "frames": [0, 2, 4], "grow": 4}})
            self.assertIsNotNone(m)
            self.assertEqual(MM.matte_frame_at(m["matte"], 3), 2)
            hit = MM.matte_hit(m["matte"], 3, [[38, 50], [140, 100], [10, 10], [139, 100]])
            self.assertEqual(hit.tolist(), [True, True, False, True])      # frame 2's square, grown by 4
            st = MM.masks_state([m], 4, [[150, 90], [30, 90]])
            self.assertEqual(st.tolist(), ["exclude", ""])
            tr = MM.auto_track(lambda f: base, range(5), n=60, masks=[m])
            self.assertGreater(len(tr), 10)
            for t in tr:
                k0 = t["keys"][0]
                self.assertFalse(20 <= k0[1] < 120 and 40 <= k0[2] < 140, "started on the matte")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

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


def _true_points(seed=1):
    """scene()'s 300 points, as it draws them."""
    rng = np.random.default_rng(seed)
    return np.c_[rng.uniform(-8, 8, 300), rng.uniform(-4, 4, 300), rng.uniform(8, 30, 300)]


class Measurements(unittest.TestCase):
    """Real distances and shapes kept by the solve (matchmove_solve.clean_constraints / _constrain), the focal
    check that warns of a squashed solve, a pixel aspect, a phone's 35 mm equivalent."""

    def test_distances_put_the_solve_in_metres_with_its_proportions(self):
        tracks, _ = scene(n_frames=30)
        X = _true_points()
        ids = [t["id"] for t in tracks]
        P = lambda i: X[int(i[1:])]  # noqa: E731
        a, b, c, d = ids[0], ids[5], ids[10], ids[20]
        cons = [{"id": "c1", "kind": "distance", "ids": [a, b], "value": float(np.linalg.norm(P(a) - P(b)))},
                {"id": "c2", "kind": "distance", "ids": [c, d], "value": float(np.linalg.norm(P(c) - P(d)))}]
        # held 20 % short and refined from there, as a phone's metadata may be
        r = S.solve(tracks, W, H, focal_px=F * 0.8, refine_focal=True, constraints=cons)
        self.assertEqual(r["units"], "m")
        self.assertAlmostEqual(r["focal_px"], F, delta=F * 0.02)
        self.assertTrue(all(q["ok"] for q in r["constraints"]), r["constraints"])
        pts = {q["id"]: np.asarray(q["X"]) for q in r["points"]}
        # a distance nobody measured comes out right too: 1 unit = 1 m
        for e, f in ((ids[30], ids[40]), (ids[50], ids[60])):
            if e in pts and f in pts:
                self.assertAlmostEqual(np.linalg.norm(pts[e] - pts[f]) / np.linalg.norm(P(e) - P(f)), 1.0, delta=0.02)
        self.assertTrue(any("moved the focal length" in n for n in r["notes"]), r["notes"])

    def test_a_focal_length_held_wrong_is_said_to_squash_the_depth(self):
        tracks, _ = scene(n_frames=30)
        r = S.solve(tracks, W, H, focal_px=F * 0.8, refine_focal=False)
        self.assertEqual(r["focal_check"]["better"], "long", r["focal_check"])
        self.assertTrue(any("squashed" in n for n in r["notes"]), r["notes"])
        ok = S.solve(tracks, W, H, focal_px=F, refine_focal=False)
        self.assertIsNone(ok["focal_check"]["better"], ok["focal_check"])
        self.assertFalse(ok["focal_check"]["weak"], ok["focal_check"])

    def test_shapes_pull_points_into_a_plane_a_line_and_a_right_angle(self):
        rng = np.random.default_rng(3)
        P = {f"p{i}": np.array([rng.uniform(-2, 2), rng.normal(0, 0.1), rng.uniform(-2, 2)]) for i in range(8)}
        P.update({f"l{i}": np.array([i * 1.0, 0.1 * rng.normal(), 0.1 * rng.normal()]) for i in range(5)})
        P.update({"a": np.array([2.0, 0.3, 0.0]), "b": np.zeros(3), "e": np.array([0.4, 0.1, 2.0])})
        cons = S.clean_constraints([{"id": "pl", "kind": "plane", "ids": [f"p{i}" for i in range(8)]},
                                    {"id": "ln", "kind": "line", "ids": [f"l{i}" for i in range(5)]},
                                    {"id": "ra", "kind": "right", "ids": ["a", "b", "e"]},
                                    {"kind": "distance", "ids": ["a"], "value": 1},         # dropped: one track
                                    {"kind": "right", "ids": ["a", "b"]}])                 # dropped: two
        self.assertEqual([c["kind"] for c in cons], ["plane", "line", "right"])
        before = {r["id"]: r["ok"] for r in S.constraint_report(cons, P)}
        self.assertEqual(before, {"pl": False, "ln": False, "ra": False})
        T = S.constraint_targets(cons, P)
        after = {r["id"]: r for r in S.constraint_report(cons, {**P, **T})}
        self.assertTrue(all(r["ok"] for r in after.values()), after)
        self.assertAlmostEqual(after["ra"]["solved"], 90.0, places=3)

    def test_measured_tracks_that_were_not_solved_are_said(self):
        rep = S.constraint_report(S.clean_constraints([{"id": "d", "kind": "distance", "ids": ["x", "y"], "value": 2}]), {"x": np.zeros(3)})
        self.assertFalse(rep[0]["ok"])
        self.assertIn("not solved", rep[0]["text"])

    def test_a_squeezed_plate_solves_with_its_pixel_aspect(self):
        pa = 2.0
        tracks, _ = scene(n_frames=30, f=F)
        # the same camera seen through a 2x squeeze: every x half as far from the centre
        sq = []
        for t in tracks:
            keys = [[k[0], W / 2 + (k[1] - W / 2) / pa, k[2], k[3]] for k in t["keys"]]
            sq.append({**t, "keys": keys})
        r = S.solve(sq, W, H, focal_px=F, refine_focal=True, pixel_aspect=pa)
        self.assertLess(r["rms"], 0.6)
        self.assertAlmostEqual(r["focal_px"], F, delta=F * 0.02)
        self.assertEqual(r["pixel_aspect"], pa)
        self.assertAlmostEqual(r["center"][0], W / 2, delta=1)
        bad = S.solve(sq, W, H, focal_px=F, refine_focal=True)
        self.assertGreater(abs(bad["focal_px"] - F) / F + bad["rms"], 0.1)

    def test_a_phone_says_its_field_of_view_by_its_35mm_equivalent(self):
        tmp = tempfile.mkdtemp()
        try:
            p = os.path.join(tmp, "phone.mov")
            open(p, "wb").close()
            with open(os.path.join(tmp, "phone.camera.json"), "w") as fh:
                fh.write('{"make": "Apple", "model": "iPhone 14", "focal_mm": 5.7, "focal35": 26}')
            facts = MM.camera_facts(p, None, 1920, 1080)
            # the 16:9 picture on a full-frame diagonal, not the "iphone" sensor of the list
            want = 2 * math.degrees(math.atan(math.hypot(36, 24) * 16 / math.hypot(16, 9) / 2 / 26))
            self.assertAlmostEqual(facts["fov_h"], want, delta=0.05)
            self.assertIn("35 mm", facts["sources"]["sensor_mm"])
            self.assertTrue(any("stabilised" in n for n in facts["notes"]), facts["notes"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class LensChart(unittest.TestCase):
    """The checkerboard the viewer shows full screen (js/imageViewer_lensChart.js), filmed through a lens: the lens
    step reads it."""

    def layout(self, w, h, cols):
        import json
        import subprocess
        node = shutil.which("node")
        if not node:
            self.skipTest("needs node")
        url = "file://" + os.path.join(ROOT, "js", "imageViewer_lensChart.js").replace("\\", "/")
        out = subprocess.run([node, "--input-type=module", "-e",
                              f"import {{ chartLayout }} from {json.dumps(url)}; console.log(JSON.stringify(chartLayout({w}, {h}, {cols})))"],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_the_chart_on_a_screen_filmed_with_a_lens_is_read(self):
        sw, sh = 1920, 1080                                   # the monitor the chart is shown on
        L = self.layout(sw, sh, 12)
        self.assertGreaterEqual(L["x0"], L["cell"])
        self.assertGreaterEqual(L["y0"], L["cell"])
        w, h, f = 1280, 720, 1000.0
        lens = {"k1": -0.06, "k2": 0.015}
        # the screen 0.6 m wide, 0.75 m away, turned a little
        Rb = S.rodrigues(np.array([0.12, -0.18, 0.02]))
        tb = np.array([0, 0, 0.62])
        size = 0.6 / sw
        src = np.array([[0, 0], [sw, 0], [0, sh], [sw, sh]], float)
        P = np.c_[(src - [sw / 2, sh / 2]) * size, np.zeros(4)] @ Rb.T + tb
        dst = f * P[:, :2] / P[:, 2:3] + [w / 2, h / 2]
        Hm = T.fit_homography(dst, src)
        ys, xs = np.mgrid[0:h, 0:w] + 0.5
        ux, uy = WP.lens_points(xs, ys, "undistort", lens["k1"], lens["k2"], w / 2, h / 2, math.hypot(w, h) / 2)
        b = T.apply(Hm, np.c_[ux.ravel(), uy.ravel()])
        i = np.floor((b[:, 0] - L["x0"]) / L["cell"])
        j = np.floor((b[:, 1] - L["y0"]) / L["cell"])
        on_board = (i >= 0) & (i < L["cols"]) & (j >= 0) & (j < L["rows"])
        on_screen = (b[:, 0] >= 0) & (b[:, 0] < sw) & (b[:, 1] >= 0) & (b[:, 1] < sh)
        img = np.where(on_screen, 0.9, 0.05)                  # white screen, dark room
        img = np.where(on_board & ((i + j) % 2 == 0), 0.08, img)
        g = MM._blur_gauss(img.reshape(h, w).astype(np.float32), 1.0)
        r = MM.solve_lens_grid([g], w, h)
        self.assertGreater(r["points"], (L["cols"] - 1) * (L["rows"] - 1) * 0.6)
        self.assertAlmostEqual(r["k1"], lens["k1"], delta=0.006)
        self.assertLess(r["error"], 0.5)


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

    def test_an_ai_matte_over_the_shot_is_one_job_and_becomes_a_mask(self):
        from PIL import Image
        async def go(c):
            r = await c.post("/imageviewer/mm_matte_workflows", json={"engine": "background"})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertTrue(any(w["id"] == "rmbg2" for w in d["workflows"]))
            r = await c.post("/imageviewer/mm_matte", json={"engine": "objects", "frames": [0], "path": self.seq})
            self.assertEqual(r.status, 400)                                 # SAM 3 needs words
            r = await c.post("/imageviewer/mm_matte", json={"path": self.seq, "engine": "background",
                                                            "workflow": "rmbg2", "frames": [0, 2, 4, 99]})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertEqual(d["frames"], [0, 2, 4])
            self.assertEqual((d["width"], d["height"]), (320, 200))
            g = d["graph"]
            loaders = [k for k, v in g.items() if v["class_type"] == "LoadImage"]
            self.assertEqual(len(loaders), 3)                               # one picture a frame, one prompt
            self.assertEqual(len([k for k, v in g.items() if v["class_type"] == "SaveImage"]), 3)
            # ComfyUI's answers: a white box on black, moving
            images = {}
            sub = os.path.join("matchmove", "matte", d["run"])
            os.makedirs(os.path.join(self.dirs["output"], sub), exist_ok=True)
            for f in d["frames"]:
                a = np.zeros((100, 160, 3), np.uint8)
                a[20:70, 10 + 5 * f:60 + 5 * f] = 255
                name = f"matte.{f:04d}_00001_.png"
                Image.fromarray(a).save(os.path.join(self.dirs["output"], sub, name))
                images[str(f)] = {"filename": name, "subfolder": sub, "type": "output"}
            r = await c.post("/imageviewer/mm_matte_place", json={"run": d["run"], "images": images})
            got = await r.json()
            self.assertEqual(r.status, 200, got)
            self.assertEqual(got["frames"], [0, 2, 4])
            self.assertTrue(got["pattern"].startswith(self.dirs["input"]))
            first = Image.open(MM.matte_path(got["pattern"], 2))
            self.assertEqual(first.size, (320, 200))                        # at the plate's size
            matte = {"pattern": got["pattern"], "frames": got["frames"], "width": 320, "height": 200, "grow": 0}
            r = await c.post("/imageviewer/mm_matte_sample", json={"matte": matte, "points": {
                "0": [["a", 60, 80], ["b", 300, 180]], "2": [["a", 60, 80], ["b", 300, 180]], "1": [["a", 1, 1]]}})
            votes = (await r.json())["votes"]
            self.assertEqual(votes, {"a": [2, 2], "b": [0, 2]})
            # a matte outside what may be read is not taken as a mask
            r = await c.post("/imageviewer/mm_matte_sample", json={"matte": {"pattern": "/etc/x.####.png", "frames": [0]}})
            self.assertEqual(r.status, 403)
            r = await c.post("/imageviewer/mm_track", json={"path": self.seq, "from": 0, "to": 3, "n": 40,
                                                            "masks": [{"id": "k", "mode": "exclude", "matte": matte}]})
            jd = await self.wait(c, (await r.json())["job"])
            self.assertEqual(jd["state"], "done", jd)
            for t in jd["tracks"]:
                k0 = t["keys"][0]
                self.assertFalse(20 <= k0[1] < 120 and 40 <= k0[2] < 140, "started on the matte")
        self.run_c(go)

    def test_the_models_can_run_on_a_smaller_plate_and_answer_at_its_size(self):
        from PIL import Image
        async def go(c):
            r = await c.post("/imageviewer/mm_matte", json={"path": self.seq, "engine": "background",
                                                            "workflow": "rmbg2", "frames": [0], "scale": 0.05})
            self.assertEqual(r.status, 400)                                 # below the smallest share
            r = await c.post("/imageviewer/mm_matte", json={"path": self.seq, "engine": "background",
                                                            "workflow": "rmbg2", "frames": [0, 2], "scale": 0.5})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertEqual((d["width"], d["height"], d["scale"]), (320, 200, 0.5))
            self.assertEqual((d["work_width"], d["work_height"]), (160, 100))
            g = d["graph"]
            for k, v in g.items():
                if v["class_type"] == "LoadImage":                          # the models get the half-size frame
                    self.assertEqual(Image.open(os.path.join(self.dirs["input"], v["inputs"]["image"])).size, (160, 100))
            images = {}
            sub = os.path.join("matchmove", "matte", d["run"])
            os.makedirs(os.path.join(self.dirs["output"], sub), exist_ok=True)
            for f in d["frames"]:
                a = np.zeros((100, 160, 3), np.uint8)
                a[20:70, 10:60] = 255
                name = f"matte.{f:04d}_00001_.png"
                Image.fromarray(a).save(os.path.join(self.dirs["output"], sub, name))
                images[str(f)] = {"filename": name, "subfolder": sub, "type": "output"}
            r = await c.post("/imageviewer/mm_matte_place", json={"run": d["run"], "images": images})
            got = await r.json()
            self.assertEqual(r.status, 200, got)
            m = np.asarray(Image.open(MM.matte_path(got["pattern"], 0)).convert("L"))
            self.assertEqual(m.shape, (200, 320))                           # back at the plate's size
            self.assertGreater(m[90, 70], 200)
            self.assertLess(m[180, 300], 50)
        self.run_c(go)

    def test_a_video_background_remover_takes_the_stretch_as_one_film(self):
        import av
        from PIL import Image
        async def go(c):
            r = await c.post("/imageviewer/mm_matte_workflows", json={"engine": "background"})
            ids = [w["id"] for w in (await r.json())["workflows"]]
            self.assertIn("bria_video", ids)                                # in place of the picture node
            self.assertNotIn("bria_rmbg", ids)
            r = await c.post("/imageviewer/mm_matte", json={"path": self.seq, "engine": "background",
                                                            "workflow": "bria_video", "frames": [0, 2, 4]})
            self.assertEqual(r.status, 400)                                 # a film is every frame
            r = await c.post("/imageviewer/mm_matte", json={"path": self.seq, "engine": "background",
                                                            "workflow": "bria_video", "frames": [0, 1, 2, 3, 4], "scale": 0.5})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertTrue(d["video"])
            self.assertEqual(d["frames"], [0, 1, 2, 3, 4])
            self.assertEqual((d["width"], d["height"], d["work_width"], d["work_height"]), (320, 200, 160, 100))
            g = d["graph"]
            self.assertEqual(sorted(v["class_type"] for v in g.values()),
                             ["BriaTransparentVideoBackground", "LoadVideo", "MaskToImage", "SaveImage"])
            film = os.path.join(self.dirs["input"], g["1"]["inputs"]["file"])
            with av.open(film) as ic:
                n = sum(1 for _ in ic.decode(video=0))
                self.assertEqual((ic.streams.video[0].width, ic.streams.video[0].height), (160, 100))
            self.assertEqual(n, 5)
            self.assertEqual(list(d["outputs"].values()), ["4"])
            # the node's answer: five numbered mattes, a box moving right
            sub = os.path.join("matchmove", "matte", d["run"])
            os.makedirs(os.path.join(self.dirs["output"], sub), exist_ok=True)
            for i in range(5):
                a = np.zeros((100, 160, 3), np.uint8)
                a[20:70, 10 + 10 * i:60 + 10 * i] = 255
                Image.fromarray(a).save(os.path.join(self.dirs["output"], sub, f"matte_{i + 1:05d}_.png"))
            r = await c.post("/imageviewer/mm_matte_place", json={"run": d["run"], "images": {
                "0": {"filename": "matte_00001_.png", "subfolder": sub, "type": "output"}}})
            got = await r.json()
            self.assertEqual(r.status, 200, got)
            self.assertEqual(got["frames"], [0, 1, 2, 3, 4])
            m4 = np.asarray(Image.open(MM.matte_path(got["pattern"], 4)).convert("L"))
            self.assertEqual(m4.shape, (200, 320))
            self.assertGreater(m4[90, 150], 200)                            # frame 4's box, not frame 0's
            self.assertLess(m4[90, 30], 50)
        self.run_c(go)

    def test_depth_puts_the_floor_into_the_solves_world_and_says_the_metres(self):
        """A depth job (Depth Anything 3 Metric) of a floor 1.5 below a camera sliding sideways: each frame's depth,
        scaled onto the solved tracks, lands on the floor in the solve's world, and a unit is 0.4 m."""
        CW = importlib.import_module(self.pkg + ".comp_write")        # 32-bit float, as ComfyUI saves them
        k, f, c, floor = 2.5, 300.0, (160.0, 100.0), 1.5          # 2.5 solve units a metre

        def z_at(u, v):
            dy = (v - c[1]) / f
            return np.where(dy > 0.02, floor / np.maximum(dy, 1e-6), 20.0).clip(0, 20.0)

        rng = np.random.default_rng(3)
        Xs = np.r_[np.c_[rng.uniform(-3, 3, 40), np.full(40, floor), rng.uniform(3, 12, 40)],
                   np.c_[rng.uniform(-6, 6, 15), rng.uniform(-3, 1, 15), np.full(15, 20.0)]]

        async def go(c_):
            r = await c_.post("/imageviewer/mm_matte_workflows", json={"engine": "depth"})
            d = await r.json()
            ids = [w["id"] for w in d["workflows"]]
            self.assertIn("comp_da3_metric", ids)
            self.assertFalse([i for i in ids if "moge" in i or "lotus" in i])      # scaled per frame: not in space
            r = await c_.post("/imageviewer/mm_matte", json={"path": self.seq, "engine": "depth",
                                                             "workflow": "comp_da3_metric", "frames": [0, 2, 4]})
            self.assertEqual(r.status, 409)                                     # its model is not here: asked for
            G = sys.modules[self.pkg + ".paint_generate"]
            real, G.missing = G.missing, lambda g, fp, nc: []
            try:
                r = await c_.post("/imageviewer/mm_matte", json={"path": self.seq, "engine": "depth",
                                                                 "workflow": "comp_da3_metric", "frames": [0, 2, 4]})
            finally:
                G.missing = real
            prep = await r.json()
            self.assertEqual(r.status, 200, prep)
            sub = os.path.join("matchmove", "depth", prep["run"])
            os.makedirs(os.path.join(self.dirs["output"], sub), exist_ok=True)
            images, cams, tracks = {}, {}, {}
            gy, gx = np.mgrid[0:100, 0:160]
            for fr in prep["frames"]:
                C = np.array([0.3 * fr, 0.0, 0.0])
                cams[str(fr)] = {"R": np.eye(3).tolist(), "t": (-C).tolist()}
                depth = z_at((gx + 0.5) * 2, (gy + 0.5) * 2) / k              # the model's metres, at half size
                depth = depth.astype(np.float32)
                name = f"depth.{fr:04d}_00001_.exr"
                with open(os.path.join(self.dirs["output"], sub, name), "wb") as fh:
                    fh.write(CW.exr_bytes({"R": depth, "G": depth, "B": depth}, depth="float", compression="none"))
                images[str(fr)] = {"filename": name, "subfolder": sub, "type": "output"}
                pc = Xs - C
                uv = f * pc[:, :2] / pc[:, 2:] + c
                tracks[str(fr)] = [[u, v, *X] for (u, v), X in zip(uv.tolist(), Xs.tolist()) if 0 <= u < 320 and 0 <= v < 200]
            r = await c_.post("/imageviewer/mm_depth_place", json={"run": prep["run"], "images": images, "cams": cams,
                                                                  "tracks": tracks, "focal": f, "center": list(c)})
            got = await r.json()
            self.assertEqual(r.status, 200, got)
            self.assertTrue(got["metric"])
            self.assertAlmostEqual(got["metres_per_unit"], 1 / k, delta=0.01)
            self.assertEqual([q["frame"] for q in got["frames"]], [0, 2, 4])
            P = np.asarray(got["points"])
            on = np.abs(P[:, 1] - floor) < 0.03
            self.assertGreater(on.mean(), 0.3, on.mean())                       # the lower part of the picture
            self.assertLess(np.abs(P[~on][:, 2] - 20).min(), 0.6)              # the rest is the far wall
            r = await c_.post("/imageviewer/mm_depth_place", json={"run": prep["run"], "images": images, "cams": cams,
                                                                  "tracks": {}, "focal": f})
            self.assertEqual(r.status, 400)                                     # no tracks: no scale
            r = await c_.post("/imageviewer/mm_matte_place", json={"run": prep["run"], "images": images})
            self.assertEqual(r.status, 400)                                     # depth is not a matte
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
