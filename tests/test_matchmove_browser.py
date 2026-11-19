"""Matchmove in the REAL viewer, against the REAL routes: a plate rendered here from a camera that is known
(dots in space seen by a camera moving sideways) goes through the guide - plate, auto-track, a track deleted in the
Plate panel by its key, the solve, building into the scene - and the 3D tab ends up with a keyed camera looked
through, the plate behind it and the solved points as locators. The Matchmove menu in the 3D menu bar and the lower
bar's Matchmove group are there, and the guide and plate go with the 3D tab and come back with it.

    python -m unittest tests.test_matchmove_browser     (Playwright, aiohttp and PyAV; skipped without)
"""
import asyncio
import json
import math
import os
import shutil
import socket
import sys
import tempfile
import threading
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402

try:
    from playwright.sync_api import sync_playwright
except Exception:  # noqa: BLE001
    sync_playwright = None
try:
    import av  # noqa: F401  (the undistorted plate is an H.264 film)
except Exception:  # noqa: BLE001
    av = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS = os.path.join(ROOT, "tests", "harness")
TYPES = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml"}
SHOTS = os.environ.get("MATCHMOVE_SHOTS")   # a folder: screenshots of the panels are written there

W, H, F, N = 640, 360, 520.0, 24


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def render_plate(folder):
    """N frames of 700 dots in space seen by a camera that slides right and turns a little: plate.####.png."""
    from PIL import Image
    rng = np.random.default_rng(7)
    X = np.c_[rng.uniform(-9, 9, 700), rng.uniform(-4, 4, 700), rng.uniform(7, 22, 700)]
    size = rng.uniform(1.6, 3.2, 700)
    shade = rng.uniform(0.45, 1.0, 700)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32) + 0.5
    for f in range(N):
        a = f / N
        ang = 0.12 * a
        R = np.array([[math.cos(ang), 0, -math.sin(ang)], [0, 1, 0], [math.sin(ang), 0, math.cos(ang)]])
        C = np.array([2.2 * a, 0.25 * math.sin(a * 4), 0.6 * a])
        pc = (X - C) @ R.T
        img = np.full((H, W), 0.08, np.float32)
        for (x, y, z), s, v in zip(pc, size, shade):
            if z <= 0.5:
                continue
            u, w = F * x / z + W / 2, F * y / z + H / 2
            if not (-6 < u < W + 6 and -6 < w < H + 6):
                continue
            x0, x1, y0, y1 = int(max(0, u - 8)), int(min(W, u + 9)), int(max(0, w - 8)), int(min(H, w + 9))
            if x1 <= x0 or y1 <= y0:
                continue
            d2 = (xx[y0:y1, x0:x1] - u) ** 2 + (yy[y0:y1, x0:x1] - w) ** 2
            img[y0:y1, x0:x1] = np.maximum(img[y0:y1, x0:x1], v * np.exp(-d2 / (2 * s * s)))
        Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).convert("RGB").save(
            os.path.join(folder, f"plate.{1001 + f:04d}.png"))
    return os.path.join(folder, "plate.1001.png").replace("\\", "/")


@unittest.skipIf(sync_playwright is None or web is None or av is None, "needs playwright, aiohttp and PyAV")
class MatchmoveBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls._env = {k: os.environ.get(k) for k in ("IMAGE_VIEWER_SETTINGS",)}
        os.environ["IMAGE_VIEWER_SETTINGS"] = os.path.join(cls.tmp, "settings.json")
        cls.routes_app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        cls.plate = render_plate(cls.dirs["output"])
        cls.port = _free_port()
        cls.loop = asyncio.new_event_loop()
        started = threading.Event()

        async def static(request):
            p = request.path
            if p.startswith("/extensions/viewer/"):
                f = os.path.join(ROOT, "js", p[len("/extensions/viewer/"):])
            else:
                f = os.path.join(HARNESS, p.lstrip("/"))
            f = os.path.abspath(f)
            if not f.startswith(ROOT) or not os.path.isfile(f):
                return web.Response(status=404, text="nf")
            with open(f, "rb") as fh:
                return web.Response(body=fh.read(), content_type=TYPES.get(os.path.splitext(f)[1], "application/octet-stream"),
                                    headers={"Cache-Control": "no-store"})

        async def serve():
            app = web.Application(client_max_size=1 << 28)
            for r in cls.routes_app.router.routes():
                if "/imageviewer/" in r.resource.canonical:
                    app.router.add_route(r.method, r.resource.canonical, r.handler)
            app.router.add_route("GET", "/{tail:.*}", static)
            cls.runner = web.AppRunner(app)
            await cls.runner.setup()
            await web.TCPSite(cls.runner, "127.0.0.1", cls.port).start()
            started.set()

        def run():
            asyncio.set_event_loop(cls.loop)
            cls.loop.run_until_complete(serve())
            cls.loop.run_forever()

        cls.thread = threading.Thread(target=run, daemon=True)
        cls.thread.start()
        started.wait(10)
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                cls.browser = (cls.pw.chromium.launch(channel=channel, headless=True) if channel
                               else cls.pw.chromium.launch(headless=True))
                break
            except Exception:  # noqa: BLE001
                continue
        if cls.browser is None:
            cls.tearDownClass()
            raise unittest.SkipTest("no browser for playwright")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "browser", None):
            cls.browser.close()
        if getattr(cls, "pw", None):
            cls.pw.stop()
        if getattr(cls, "runner", None):
            asyncio.run_coroutine_threadsafe(cls.runner.cleanup(), cls.loop).result(10)
            cls.loop.call_soon_threadsafe(cls.loop.stop)
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        for k, v in cls._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _page(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 900}, device_scale_factor=2 if SHOTS else 1)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/matchmove.html")
        pg.wait_for_function("() => window.__ready || document.title.startsWith('ERR') || document.title.startsWith('IMPORT')",
                             timeout=30000)
        self.assertEqual(pg.title(), "ready")
        pg.evaluate("""async () => { const P = window.__panel;
            const { app } = await import('/scripts/app.js');
            app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
            P.setViewerToggleState(true); }""")
        return pg

    def _shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, name + ".png"))

    def test_a_plate_tracked_solved_and_built_into_the_3d_space(self):
        pg = self._page()
        try:
            # Open, through the lower bar's Matchmove group: a 3D tab with the guide and the plate.
            groups = pg.evaluate("() => [...window.__panel.container.querySelectorAll('.bar-group')].map((b) => b.id)")
            self.assertIn("bar-group-matchmove", groups)
            pg.evaluate("""async () => { const P = window.__panel;
                P.matchmovePickPlate = () => {};          // the file picker is not what is tested here
                P.matchmoveOpen(); }""")
            pg.wait_for_timeout(300)
            state = pg.evaluate("""() => { const P = window.__panel;
                return { tab: P.isPrevizTab(), guide: P.isPanelDocked('mmGuide'), plate: P.isPanelDocked('mmPlate'),
                         chips: P.mmGuidePanel.querySelectorAll('.mm-chip').length,
                         menus: [...P._modelView().root.querySelectorAll('.model-mb-menus > button')].map((b) => b.textContent) }; }""")
            self.assertTrue(state["tab"] and state["guide"] and state["plate"], state)
            self.assertEqual(state["chips"], 7)
            self.assertIn("Matchmove", state["menus"])

            # The plate: one frame names the sequence; its size and length are read.
            plate = pg.evaluate("async (p) => { const P = window.__panel; await P.matchmoveSetPlate(p); return P._mmCur().mm.plate; }",
                                self.plate)
            self.assertEqual((plate["width"], plate["height"], plate["frames"]), (W, H, N))
            self.assertTrue(plate["path"].endswith("plate.####.png"), plate["path"])
            # The Plate panel draws the frame.
            pg.wait_for_function("() => { const st = window.__panel._mmCur(); return st && st.frameNear && st.frameNear.naturalWidth > 0; }",
                                 timeout=20000)

            # The Matchmove menu opens from the 3D menu bar and lists the steps.
            pg.evaluate_handle("() => window.__panel._modelView().root.querySelector('[data-menu=matchmove]')").as_element().click()
            pg.wait_for_timeout(150)
            items = pg.locator("button.previz-menu-item").all_inner_texts()
            pg.keyboard.press("Escape")
            self.assertTrue(any("Open Matchmove" in t for t in items), items)

            # Auto-track.
            n = pg.evaluate("async () => { const P = window.__panel; await P.matchmoveAutoTrack(); return P._mmCur().mm.tracks.length; }")
            self.assertGreater(n, 40)
            self._shot(pg, "mm_tracked")

            # A track picked and deleted with its key, from the Plate panel.
            pg.evaluate("""() => { const P = window.__panel; const st = P._mmCur();
                st.sel = new Set([st.mm.tracks[0].id]); P._mmUI.stage.focus(); P._mmFocused = true; }""")
            pg.keyboard.press("Delete")
            after = pg.evaluate("() => window.__panel._mmCur().mm.tracks.length")
            self.assertEqual(after, n - 1)
            # ... and back with Ctrl+Z.
            pg.keyboard.press("Control+z")
            self.assertEqual(pg.evaluate("() => window.__panel._mmCur().mm.tracks.length"), n)

            # Solve: the focal length is not given, so it is found.
            sv = pg.evaluate("""async () => { const P = window.__panel; await P.matchmoveSolve();
                const s = P._mmCur().mm.solve; return { rms: s.rms, f: s.focal_px, frames: Object.keys(s.frames).length, mode: s.mode }; }""")
            self.assertLess(sv["rms"], 1.0, sv)
            self.assertEqual(sv["frames"], N)
            self.assertAlmostEqual(sv["f"], F, delta=F * 0.05)

            # Put the floor on the points and build it into the scene.
            built = pg.evaluate("""async () => { const P = window.__panel;
                await P.matchmoveBuild();
                const sc = P.previzScene();
                const cam = sc.items.find((i) => i.kind === 'camera' && /Matchmove camera/.test(i.name));
                const plate = sc.items.find((i) => i.name === 'Plate');
                const locs = sc.items.filter((i) => i.mmTrack).length;
                return { cam: !!cam, keys: cam ? ((cam.tracks || {}).position || []).length : 0,
                         active: sc.activeCamera === (cam && cam.id), plate: !!plate, under: plate && plate.parent === (cam && cam.id),
                         locs, file: (sc.matchmove || {}).file || null, fps: sc.fps }; }""")
            self.assertTrue(built["cam"] and built["active"] and built["plate"] and built["under"], built)
            self.assertEqual(built["keys"], N)
            self.assertGreater(built["locs"], 20)
            self.assertTrue(built["file"] and built["file"].endswith(".mm.json"), built)
            self.assertTrue(os.path.isfile(built["file"]))
            with open(built["file"], encoding="utf-8") as fh:
                saved = json.load(fh)
            self.assertTrue(saved.get("solve"))
            self._shot(pg, "mm_built")

            # The panels go with the 3D tab and come back with it.
            # (the harness's Viewer tab holds no picture, so nothing leaves 3D mode by itself: the panel is told, as a
            # picture coming up tells it)
            pg.evaluate("""async () => { const P = window.__panel; P._mmKey = P.activeTab; await P.switchTab('folder_history');
                P._exitModelMode(); }""")
            pg.wait_for_timeout(200)
            gone = pg.evaluate("() => [window.__panel.isPanelDocked('mmGuide'), window.__panel.isPanelDocked('mmPlate')]")
            self.assertEqual(gone, [False, False])
            pg.evaluate("async () => { const P = window.__panel; await P.switchTab(P._mmKey); }")
            pg.wait_for_timeout(300)
            back = pg.evaluate("() => [window.__panel.isPanelDocked('mmGuide'), window.__panel.isPanelDocked('mmPlate')]")
            self.assertEqual(back, [True, True])
            self.assertEqual(self.errors, [])
        finally:
            pg.close()


if __name__ == "__main__":
    unittest.main()
