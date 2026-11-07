"""The Edit panel's lighter sources: the edit proxy of a heavy film and the scrub sound.

- /imageviewer/edit_proxy: "none" for a small film with key frames close together; a film bigger than 720p,
  or with its key frames seconds apart, gets a 540p copy with a key frame every half second, made in the
  background ("making", then "ready"), served by /imageviewer/view_file with edit=1 - the same frames and length.
- /imageviewer/timeline_pcm: a file's sound as mono 16-bit samples at 22050 Hz (204 for a still).

The REAL viewer_api routes (tests/test_timeline_media_routes.py's private app). Needs PyAV, numpy, aiohttp, Pillow:
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_edit_proxy
"""
import asyncio
import os
import shutil
import sys
import time
import unittest

from tests.test_timeline_media_routes import _load, av, make_clicks, make_clip

if av is not None:
    import numpy as np
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from PIL import Image


def make_film(path, w, h, seconds, fps=24, gop=None):
    """A moving gradient, `gop` frames between key frames (x264's default when None)."""
    with av.open(path, "w") as out:
        vs = out.add_stream("libx264", rate=fps, options={"preset": "ultrafast", **({"g": str(gop)} if gop else {})})
        vs.width, vs.height, vs.pix_fmt = w, h, "yuv420p"
        y, x = np.mgrid[0:h, 0:w]
        for i in range(int(seconds * fps)):
            img = np.zeros((h, w, 3), dtype=np.uint8)
            img[..., 0] = (x + i * 8) % 256
            img[..., 1] = (y + i * 4) % 256
            vf = av.VideoFrame.from_ndarray(img, format="rgb24")
            vf.pts = i
            for pkt in vs.encode(vf):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)


def key_gaps(path):
    with av.open(path) as c:
        vs = c.streams.video[0]
        keys = [float(p.pts * vs.time_base) for p in c.demux(vs) if p.pts is not None and p.is_keyframe]
    return [b - a for a, b in zip(keys, keys[1:])]


@unittest.skipIf(av is None, "needs PyAV, numpy, aiohttp and Pillow (ComfyUI's interpreter)")
class EditProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tempfile
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.va, cls.tm, cls.dirs, cls.pkg = _load(cls.tmp)
        cls.mr = sys.modules[cls.pkg + ".media_resolve"]
        out = cls.dirs["output"]
        cls.small = os.path.join(out, "small.mp4")           # 160x90, a key frame every 12 frames
        make_film(cls.small, 160, 90, 3, gop=12)
        cls.sparse = os.path.join(out, "sparse.mp4")         # small, but one key frame in 4 s
        make_film(cls.sparse, 160, 90, 4, gop=250)
        cls.hd = os.path.join(out, "hd.mp4")                 # 1920x1080
        make_film(cls.hd, 1920, 1080, 1.5, gop=12)
        cls.sound = os.path.join(out, "red_blue.mp4")        # a 440 Hz tone in its first 2 s of 4
        make_clip(cls.sound)
        cls.wav = os.path.join(out, "clicks.wav")
        make_clicks(cls.wav, seconds=2)
        cls.still = os.path.join(out, "still.png")
        Image.new("RGB", (64, 36), (0, 200, 0)).save(cls.still)

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

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

    async def _state_until_made(self, c, path):
        seen = []
        for _ in range(600):
            r = await c.get("/imageviewer/edit_proxy", params={"path": path})
            self.assertEqual(r.status, 200, await r.text())
            seen.append((await r.json())["state"])
            if seen[-1] != "making":
                return seen
            await asyncio.sleep(0.1)
        return seen

    # ── the edit proxy ──

    def test_a_small_film_with_close_key_frames_plays_as_it_is(self):
        async def go(c):
            st = await self._state_until_made(c, self.small)
            full = await c.get("/imageviewer/view_file", params={"path": self.small})
            edit = await c.get("/imageviewer/view_file", params={"path": self.small, "edit": "1"})
            return st, await full.read(), await edit.read()
        st, full, edit = self.run_async(go)
        self.assertEqual(st, ["none"])
        self.assertEqual(full, edit, "no proxy: edit=1 serves the film itself")

    def test_an_hd_film_gets_a_540p_copy_with_the_same_frames(self):
        async def go(c):
            before = await c.get("/imageviewer/view_file", params={"path": self.hd, "edit": "1"})
            t0 = time.perf_counter()
            st = await self._state_until_made(c, self.hd)
            made = time.perf_counter() - t0
            edit = await c.get("/imageviewer/view_file", params={"path": self.hd, "edit": "1"})
            return await before.read(), st, made, await edit.read()
        before, st, made, edit = self.run_async(go)
        print(f"\nedit proxy of 1.5 s of 1080p: {made * 1000:.0f} ms", file=sys.stderr)
        with open(self.hd, "rb") as fh:
            self.assertEqual(before, fh.read(), "until the copy is made, edit=1 serves the film")
        self.assertEqual(st[0], "making")
        self.assertEqual(st[-1], "ready")
        proxy = self.mr.edit_proxy_ready(self.hd)
        self.assertTrue(proxy)
        with open(proxy, "rb") as fh:
            self.assertEqual(edit, fh.read())
        with av.open(proxy) as c, av.open(self.hd) as o:
            p, s = c.streams.video[0], o.streams.video[0]
            self.assertEqual((p.width, p.height), (960, 540))
            self.assertEqual(sum(1 for _ in c.decode(p)), sum(1 for _ in o.decode(s)))
        self.assertLessEqual(max(key_gaps(proxy) or [0]), 0.51)
        self.assertFalse(self.mr.edit_proxy_needed(proxy), "the copy itself needs none")

    def test_a_film_with_key_frames_far_apart_gets_a_copy_at_its_own_size(self):
        self.assertGreater(max(key_gaps(self.sparse) or [4.0]), 2.0)
        st = self.run_async(lambda c: self._state_until_made(c, self.sparse))
        self.assertEqual(st[-1], "ready")
        proxy = self.mr.edit_proxy_ready(self.sparse)
        with av.open(proxy) as c:
            self.assertEqual((c.streams.video[0].width, c.streams.video[0].height), (160, 90))
        self.assertLessEqual(max(key_gaps(proxy)), 0.51)

    def test_a_sound_or_a_still_has_no_proxy(self):
        async def go(c):
            out = []
            for p in (self.still, self.wav):
                r = await c.get("/imageviewer/edit_proxy", params={"path": p})
                out.append((r.status, (await r.json())["state"]))
            return out
        self.assertEqual(self.run_async(go), [(200, "none"), (200, "none")])

    def test_outside_the_allowed_folders_is_refused(self):
        import tempfile
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "secret.mp4")
        shutil.copy(self.small, p)
        async def go(c):
            return (await c.get("/imageviewer/edit_proxy", params={"path": p})).status, \
                   (await c.get("/imageviewer/timeline_pcm", params={"path": p})).status
        self.assertEqual(self.run_async(go), (403, 403))

    # ── the scrub sound ──

    def test_pcm_is_the_sound_in_mono_at_22050(self):
        async def go(c):
            r = await c.get("/imageviewer/timeline_pcm", params={"path": self.sound})
            body = await r.read()
            again = await c.get("/imageviewer/timeline_pcm", params={"path": self.sound}, headers={"If-None-Match": r.headers["ETag"]})
            return r.status, r.headers.get("X-Pcm-Rate"), body, again.status
        status, rate, body, again = self.run_async(go)
        self.assertEqual(status, 200)
        self.assertEqual(rate, "22050")
        x = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32767
        self.assertAlmostEqual(x.size / 22050, 4.0, delta=0.1)
        first, second = x[: 22050 * 2 - 2000], x[22050 * 2 + 2000:]
        self.assertGreater(np.abs(first).max(), 0.6)          # the tone, at 0.8
        self.assertLess(np.abs(second).max(), 0.05)           # silence
        self.assertEqual(again, 304)

    def test_a_still_has_no_pcm(self):
        r = self.run_async(lambda c: c.get("/imageviewer/timeline_pcm", params={"path": self.still}))
        self.assertIn(r.status, (204, 422))


if __name__ == "__main__":
    unittest.main()
