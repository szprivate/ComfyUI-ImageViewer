"""The Edit panel's readings of a file: waveform peaks, filmstrips, beats, cuts, lengths - and the drop routes.

The REAL viewer_api routes in a private aiohttp app, with ComfyUI's folder_paths and server stubbed, against a
clip made here with PyAV: two seconds of red then two of blue (one cut, at 2 s), a 440 Hz tone that is silent
in its second half, and a click track at 120 bpm. Needs PyAV (ComfyUI's interpreter has it):
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_timeline_media_routes
"""
import asyncio
import base64
import importlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest

try:
    import av
    import numpy as np
    from aiohttp import FormData, web
    from aiohttp.test_utils import TestClient, TestServer
    from PIL import Image
except ImportError:  # pragma: no cover
    av = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _load(tmp):
    fp = types.ModuleType("folder_paths")
    fp.base_path = tmp
    dirs = {"output": os.path.join(tmp, "out"), "temp": os.path.join(tmp, "temp"), "input": os.path.join(tmp, "in")}
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)
    fp.get_output_directory = lambda: dirs["output"]
    fp.get_temp_directory = lambda: dirs["temp"]
    fp.get_input_directory = lambda: dirs["input"]
    fp.get_directory_by_type = lambda t: dirs.get(t)
    app = web.Application()
    srv = types.ModuleType("server")
    srv.PromptServer = type("PromptServer", (), {"instance": types.SimpleNamespace(app=app)})
    saved = {k: sys.modules.get(k) for k in ("folder_paths", "server")}
    sys.modules.update(folder_paths=fp, server=srv)
    name = "bepic_media_routes_under_test"
    pkg = types.ModuleType(name)
    pkg.__path__ = [ROOT]
    sys.modules[name] = pkg
    try:
        va = importlib.import_module(name + ".viewer_api")
        tm = importlib.import_module(name + ".timeline_media")
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    return app, va, tm, dirs, name


def make_clip(path, seconds=4.0, fps=24, rate=44100):
    """Red for the first half, blue for the second; a tone in the first half only."""
    with av.open(path, "w") as out:
        vs = out.add_stream("libx264" if "libx264" in av.codecs_available else "mpeg4", rate=fps)
        vs.width, vs.height, vs.pix_fmt = 160, 90, "yuv420p"
        aus = out.add_stream("aac", rate=rate)
        aus.layout = "mono"
        frames = int(seconds * fps)
        for i in range(frames):
            colour = (220, 20, 20) if i < frames // 2 else (20, 20, 220)
            img = np.zeros((90, 160, 3), dtype=np.uint8)
            img[:] = colour
            vf = av.VideoFrame.from_ndarray(img, format="rgb24")
            vf.pts = i
            for pkt in vs.encode(vf):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)
        t = np.arange(int(seconds * rate)) / rate
        tone = (0.8 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        tone[t >= seconds / 2] = 0.0
        step = 1024
        for k in range(0, tone.size, step):
            chunk = tone[k:k + step]
            af = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="flt", layout="mono")
            af.sample_rate = rate
            af.pts = k
            for pkt in aus.encode(af):
                out.mux(pkt)
        for pkt in aus.encode():
            out.mux(pkt)


def make_clicks(path, seconds=12.0, bpm=120.0, rate=22050):
    """A click every beat: what a beat finder must find."""
    n = int(seconds * rate)
    x = np.zeros(n, dtype=np.float32)
    period = 60.0 / bpm
    for k in range(int(seconds / period)):
        a = int((0.25 + k * period) * rate)
        burst = np.random.RandomState(k).uniform(-1, 1, 600).astype(np.float32) * np.linspace(1, 0, 600)
        x[a:a + 600] += burst[: max(0, min(600, n - a))]
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(x, -1, 1) * 32000).astype("<i2").tobytes())


# A film that is already an edit: hard cuts at these frames, and a dissolve over these.
EDIT_FPS = 24
EDIT_CUTS = [24, 50, 120]
EDIT_DISSOLVE = (80, 91)          # its first and last blended frame
EDIT_FRAMES = 144


def _shot_picture(k, i):
    """Shot k at its i-th frame: a pattern of its own, with a bar drifting across (motion, not a cut)."""
    h, w = 90, 160
    y, x = np.mgrid[0:h, 0:w]
    base = [(200, 40, 40), (40, 180, 60), (40, 60, 200), (220, 200, 40), (160, 40, 180)][k]
    img = np.zeros((h, w, 3), dtype=np.float32)
    shade = 0.6 + 0.4 * ((x + y * (k + 1)) % 64) / 64.0
    for ch in range(3):
        img[..., ch] = base[ch] * shade
    bar = (i * 2) % w
    img[:, bar:bar + 6] = 255
    return img


def make_edited_film(path):
    """EDIT_FRAMES frames: shots 0..4 with hard cuts at EDIT_CUTS and shot 2 dissolving into 3 over EDIT_DISSOLVE."""
    a, b = EDIT_DISSOLVE
    with av.open(path, "w") as out:
        vs = out.add_stream("libx264" if "libx264" in av.codecs_available else "mpeg4", rate=EDIT_FPS)
        vs.width, vs.height, vs.pix_fmt = 160, 90, "yuv420p"
        try:
            vs.options = {"crf": "12"}
        except Exception:
            pass
        for f in range(EDIT_FRAMES):
            if f < 24:
                img = _shot_picture(0, f)
            elif f < 50:
                img = _shot_picture(1, f)
            elif f < a:
                img = _shot_picture(2, f)
            elif f <= b:
                m = (f - a + 1) / (b - a + 2)
                img = (1 - m) * _shot_picture(2, f) + m * _shot_picture(3, f)
            elif f < 120:
                img = _shot_picture(3, f)
            else:
                img = _shot_picture(4, f)
            vf = av.VideoFrame.from_ndarray(np.clip(img, 0, 255).astype(np.uint8), format="rgb24")
            vf.pts = f
            for pkt in vs.encode(vf):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)


@unittest.skipIf(av is None, "needs PyAV, numpy, aiohttp and Pillow (ComfyUI's interpreter)")
class TimelineMediaRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.va, cls.tm, cls.dirs, cls.pkg = _load(cls.tmp)
        cls.clip = os.path.join(cls.dirs["output"], "red_blue.mp4")
        make_clip(cls.clip)
        cls.clicks = os.path.join(cls.dirs["output"], "clicks.wav")
        make_clicks(cls.clicks)
        cls.still = os.path.join(cls.dirs["output"], "still.png")
        Image.new("RGB", (320, 180), (0, 200, 0)).save(cls.still)
        cls.outside_dir = tempfile.mkdtemp()
        cls.outside = os.path.join(cls.outside_dir, "secret.mp4")
        shutil.copy(cls.clip, cls.outside)

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.outside_dir, ignore_errors=True)

    def _client(self):
        app = web.Application()
        for r in self.app.router.routes():
            app.router.add_route(r.method, r.resource.canonical, r.handler)
        return TestClient(TestServer(app))

    def run_async(self, fn):
        async def go():
            async with self._client() as c:
                return await fn(c)
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(go())
        finally:
            loop.close()

    def caches(self, kind):
        return [f for f in os.listdir(self.dirs["temp"]) if f.startswith(f"bEpic_{kind}_")]

    # ── peaks ──

    def test_peaks_follow_the_sound_and_are_cached(self):
        async def go(c):
            t0 = time.perf_counter()
            r = await c.get("/bepic/timeline_peaks", params={"path": self.clip})
            cold = time.perf_counter() - t0
            self.assertEqual(r.status, 200, await r.text())
            data = await r.json()
            tag = r.headers["ETag"]
            t0 = time.perf_counter()
            again = await c.get("/bepic/timeline_peaks", params={"path": self.clip})
            warm = time.perf_counter() - t0
            same = await again.json()
            not_changed = await c.get("/bepic/timeline_peaks", params={"path": self.clip}, headers={"If-None-Match": tag})
            return data, same, not_changed.status, cold, warm
        data, same, status304, cold, warm = self.run_async(go)
        print(f"\npeaks of a 4 s clip: cold {cold * 1000:.0f} ms, cached {warm * 1000:.0f} ms", file=sys.stderr)
        self.assertTrue(data["audio"])
        self.assertAlmostEqual(data["duration"], 4.0, delta=0.15)
        self.assertEqual([lv["bps"] for lv in data["levels"]], [25, 100, 400])
        lv = data["levels"][1]
        raw = np.frombuffer(base64.b64decode(lv["data"]), dtype=np.int8).reshape(-1, 2)
        self.assertEqual(raw.shape[0], lv["n"])
        first, second = raw[: lv["n"] // 2 - 10], raw[lv["n"] // 2 + 10:]
        self.assertGreater(first[:, 1].mean(), 80)          # the tone: near 0.8 * 127
        self.assertLess(first[:, 0].mean(), -80)
        self.assertLess(np.abs(second).max(), 10)           # silence
        self.assertEqual(data, same)
        self.assertEqual(status304, 304)
        self.assertEqual(len([f for f in self.caches("peaks") if "red_blue" in f]), 1)

    def test_a_still_has_no_sound(self):
        async def go(c):
            r = await c.get("/bepic/timeline_peaks", params={"path": self.still})
            return r.status, await r.json()
        status, data = self.run_async(go)
        self.assertEqual((status, data["audio"], data["levels"]), (200, False, []))

    def test_a_changed_file_is_read_again(self):
        path = os.path.join(self.dirs["output"], "changes.wav")
        make_clicks(path, seconds=3.0)

        async def go(c):
            a = await (await c.get("/bepic/timeline_peaks", params={"path": path})).json()
            make_clicks(path, seconds=6.0)
            os.utime(path, (time.time() + 5, time.time() + 5))
            b = await (await c.get("/bepic/timeline_peaks", params={"path": path})).json()
            return a, b
        a, b = self.run_async(go)
        self.assertAlmostEqual(a["duration"], 3.0, delta=0.05)
        self.assertAlmostEqual(b["duration"], 6.0, delta=0.05)

    # ── strips ──

    def test_strip_holds_frames_at_even_moments(self):
        async def go(c):
            t0 = time.perf_counter()
            r = await c.get("/bepic/timeline_strip", params={"path": self.clip, "n": "8", "h": "48"})
            cold = time.perf_counter() - t0
            body = await r.read()
            t0 = time.perf_counter()
            again = await c.get("/bepic/timeline_strip", params={"path": self.clip, "n": "8", "h": "48"})
            await again.read()
            warm = time.perf_counter() - t0
            return r.status, dict(r.headers), body, cold, warm
        status, headers, body, cold, warm = self.run_async(go)
        print(f"\nstrip of 8 frames: cold {cold * 1000:.0f} ms, cached {warm * 1000:.0f} ms", file=sys.stderr)
        self.assertEqual(status, 200)
        n, tw, th = int(headers["X-Strip-N"]), int(headers["X-Strip-Tw"]), int(headers["X-Strip-Th"])
        self.assertEqual((n, th), (8, 48))
        self.assertEqual(tw, round(48 * 160 / 90))
        self.assertAlmostEqual(float(headers["X-Strip-Duration"]), 4.0, delta=0.1)
        img = Image.open(io.BytesIO(body)).convert("RGB")
        self.assertEqual(img.size, (n * tw, th))
        colours = [img.getpixel((i * tw + tw // 2, th // 2)) for i in range(n)]
        for c in colours[:4]:
            self.assertGreater(c[0], 150, colours)          # red half
            self.assertLess(c[2], 90, colours)
        for c in colours[4:]:
            self.assertGreater(c[2], 150, colours)          # blue half
            self.assertLess(c[0], 90, colours)
        # A request is rounded up to a kept size, so 5 and 8 are one cache entry.
        self.assertEqual(self.tm.strip_size(5, 40), (8, 48))

    def test_a_still_is_one_tile(self):
        async def go(c):
            r = await c.get("/bepic/timeline_strip", params={"path": self.still, "n": "64"})
            return r.status, dict(r.headers), await r.read()
        status, headers, body = self.run_async(go)
        self.assertEqual((status, headers["X-Strip-N"]), (200, "1"))
        img = Image.open(io.BytesIO(body)).convert("RGB")
        self.assertEqual(img.size, (int(headers["X-Strip-Tw"]), 48))
        self.assertGreater(img.getpixel((5, 5))[1], 150)

    # ── reach ──

    def test_outside_the_allowed_folders_is_refused(self):
        async def go(c):
            out = []
            for route in ("timeline_peaks", "timeline_strip", "timeline_beats", "timeline_shots", "timeline_cuts"):
                for params in ({"path": self.outside},
                               {"filename": "../../" + os.path.basename(self.outside_dir) + "/secret.mp4", "type": "output"},
                               {"path": os.path.join(self.dirs["output"], "..", "..", os.path.basename(self.outside_dir),
                                                     "secret.mp4")}):
                    r = await c.get("/bepic/" + route, params=params)
                    out.append((route, r.status))
            text = os.path.join(self.dirs["output"], "notes.txt")
            with open(text, "w") as fh:
                fh.write("not media")
            r = await c.get("/bepic/timeline_peaks", params={"path": text})
            out.append(("text", r.status))
            r = await c.post("/bepic/timeline_probe", json={"paths": [self.outside, self.clip]})
            probe = await r.json()
            return out, probe
        out, probe = self.run_async(go)
        for route, status in out:
            self.assertIn(status, (400, 403), route)
        self.assertEqual(probe["info"][self.outside], {"error": "not allowed"})
        self.assertTrue(probe["info"][self.clip]["audio"])
        self.assertAlmostEqual(probe["info"][self.clip]["duration"], 4.0, delta=0.15)
        self.assertEqual(self.caches("peaks") + self.caches("strip8h48"), [c for c in self.caches("peaks") + self.caches("strip8h48")
                                                                        if "secret" not in c])

    # ── beats and cuts ──

    def test_beats_of_a_click_track(self):
        async def go(c):
            r = await c.get("/bepic/timeline_beats", params={"path": self.clicks})
            return r.status, await r.json()
        status, data = self.run_async(go)
        self.assertEqual(status, 200)
        self.assertAlmostEqual(data["bpm"], 120.0, delta=2.0)
        gaps = np.diff(data["beats"])
        self.assertAlmostEqual(float(np.median(gaps)), 0.5, delta=0.02)
        # On the clicks, which begin at 0.25 s.
        self.assertLess(min(abs(((b - 0.25) + 0.25) % 0.5 - 0.25) for b in data["beats"][:4]), 0.05)

    def test_beats_match_agentY_scipy_version(self):
        try:
            from scipy.signal import stft
        except ImportError:
            self.skipTest("no scipy to compare with")
        x = np.random.RandomState(3).uniform(-1, 1, 22050 * 3).astype(np.float32)
        _f, _t, spec = stft(x, fs=22050, nperseg=2048, noverlap=1536, boundary=None, padded=False)
        mag = np.log1p(np.abs(spec) * 10.0)
        flux = np.maximum(0.0, mag[:, 1:] - mag[:, :-1]).sum(axis=0)
        flux = flux / flux.max()
        mine = self.tm.onset_strength(x)
        self.assertEqual(mine.shape, flux.shape)
        self.assertLess(float(np.abs(mine - flux).max()), 1e-3)

    def test_shots_find_the_cut(self):
        async def go(c):
            r = await c.get("/bepic/timeline_shots", params={"path": self.clip})
            return r.status, await r.json()
        status, data = self.run_async(go)
        self.assertEqual(status, 200)
        self.assertEqual(len(data["cuts"]), 1, data)
        self.assertAlmostEqual(data["cuts"][0], 2.0, delta=0.1)
        self.assertEqual(len(data["shots"]), 2)

    def test_scene_cut_detection_finds_hard_cuts_and_the_dissolve(self):
        film = os.path.join(self.dirs["output"], "edited.mp4")
        make_edited_film(film)

        async def go(c):
            t0 = time.perf_counter()
            r = await c.get("/bepic/timeline_cuts", params={"path": film})
            cold = time.perf_counter() - t0
            data = await r.json()
            t0 = time.perf_counter()
            await (await c.get("/bepic/timeline_cuts", params={"path": film})).json()
            return r.status, data, cold, time.perf_counter() - t0
        status, data, cold, warm = self.run_async(go)
        print(f"\ncut detection of {EDIT_FRAMES} frames: cold {cold * 1000:.0f} ms, cached {warm * 1000:.0f} ms",
              file=sys.stderr)
        self.assertEqual(status, 200)
        fps = data["fps"]
        # What the panel keeps at its default sensitivity (bEpicViewer_editAuto.js: score >= 0.1, ratio >= 2.5).
        kept = [c for c in data["cuts"] if c["score"] >= 0.1 and c["ratio"] >= 2.5]
        hard = [c for c in kept if c["kind"] == "cut"]
        self.assertEqual(len(hard), len(EDIT_CUTS), data["cuts"])
        for c, frame in zip(hard, EDIT_CUTS):
            self.assertLessEqual(abs(c["t"] * fps - frame), 1.0, (c, frame))
        fades = [c for c in kept if c["kind"] == "dissolve"]
        self.assertEqual(len(fades), 1, data["cuts"])
        a, b = EDIT_DISSOLVE
        self.assertLessEqual(abs(fades[0]["t"] * fps - (a + b) / 2), 1.0, fades)
        self.assertLessEqual(abs(fades[0]["start"] * fps - a), 2.0, fades)
        self.assertLessEqual(abs(fades[0]["end"] * fps - b), 2.0, fades)
        self.assertEqual(len([f for f in self.caches("scan") if "edited" in f]), 1)

    def test_motion_alone_is_not_a_cut(self):
        film = os.path.join(self.dirs["output"], "one_shot.mp4")
        with av.open(film, "w") as out:
            vs = out.add_stream("libx264" if "libx264" in av.codecs_available else "mpeg4", rate=EDIT_FPS)
            vs.width, vs.height, vs.pix_fmt = 160, 90, "yuv420p"
            for f in range(72):
                vf = av.VideoFrame.from_ndarray(np.clip(_shot_picture(1, f * 3), 0, 255).astype(np.uint8), format="rgb24")
                vf.pts = f
                for pkt in vs.encode(vf):
                    out.mux(pkt)
            for pkt in vs.encode():
                out.mux(pkt)

        async def go(c):
            return await (await c.get("/bepic/timeline_cuts", params={"path": film})).json()
        data = self.run_async(go)
        self.assertEqual([c for c in data["cuts"] if c["score"] >= 0.1 and c["ratio"] >= 2.5], [], data)

    def test_a_sound_has_no_cuts_to_find(self):
        async def go(c):
            r = await c.get("/bepic/timeline_shots", params={"path": self.clicks})
            return r.status
        self.assertEqual(self.run_async(go), 422)

    # ── bringing material in ──

    def test_upload_keeps_a_dropped_file_in_input_edits(self):
        with open(self.clip, "rb") as fh:
            payload = fh.read()

        async def go(c):
            out = []
            for name in ("my clip.mp4", "my clip.mp4", "..\\..\\evil.mp4", "run.exe"):
                form = FormData()
                form.add_field("file", payload, filename=name, content_type="application/octet-stream")
                r = await c.post("/bepic/timeline_upload", data=form)
                out.append((r.status, await r.json() if r.status == 200 else await r.text()))
            return out
        (s1, a), (s2, b), (s3, c), (s4, _d) = self.run_async(go)
        self.assertEqual((s1, s2, s3, s4), (200, 200, 200, 415))
        edits = os.path.join(self.dirs["input"], "edits")
        self.assertEqual(os.path.dirname(a["path"]), edits)
        self.assertEqual(a["path"], b["path"])            # the same file twice is one copy
        self.assertTrue(b["reused"])
        self.assertEqual(os.path.dirname(c["path"]), edits)   # no way out of the folder
        self.assertTrue(os.path.basename(c["path"]).endswith("evil.mp4"), c["path"])
        with open(a["path"], "rb") as fh:
            self.assertEqual(fh.read(), payload)

    def test_locate_names_comfy_outputs_by_path(self):
        async def go(c):
            r = await c.post("/bepic/timeline_locate", json={"items": [
                {"filename": "red_blue.mp4", "type": "output", "subfolder": ""},
                {"filename": "../../etc/passwd", "type": "output"},
                {"filename": "missing.mp4", "type": "output"}]})
            return await r.json()
        got = self.run_async(go)
        self.assertEqual(got["paths"], [self.clip, None, None])


if __name__ == "__main__":
    unittest.main()
