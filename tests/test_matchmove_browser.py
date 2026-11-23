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
FLOOR_Y = 4.6


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def plate_scene():
    """The plate's dots and, per frame, its camera (R, C): pc = R (X - C)."""
    rng = np.random.default_rng(7)
    X = np.c_[rng.uniform(-9, 9, 700), rng.uniform(-4, 4, 700), rng.uniform(7, 22, 700)]
    fl = np.random.default_rng(11)
    X = np.r_[X, np.c_[fl.uniform(-10, 10, 260), np.full(260, FLOOR_Y), fl.uniform(14, 32, 260)]]
    cams = []
    for f in range(N):
        a = f / N
        ang = 0.12 * a
        R = np.array([[math.cos(ang), 0, -math.sin(ang)], [0, 1, 0], [math.sin(ang), 0, math.cos(ang)]])
        cams.append((R, np.array([2.2 * a, 0.25 * math.sin(a * 4), 0.6 * a])))
    return X, cams


def render_depth(folder, pkg, metres_per_unit=0.5):
    """What a metric depth model would say of the plate: z-depth in metres - the floor, each dot as a disc of its
    own depth, far away above the floor: depth.<frame>.exr (32-bit float, as ComfyUI saves them)."""
    import importlib
    CW = importlib.import_module(pkg + ".comp_write")
    X, cams = plate_scene()
    os.makedirs(folder, exist_ok=True)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64) + 0.5
    dy = (yy - H / 2) / F
    for f, (R, C) in enumerate(cams):
        z = np.where(dy > 1e-3, (FLOOR_Y - C[1]) / np.maximum(dy, 1e-9), 80.0).clip(0, 80.0)
        pc = (X - C) @ R.T
        for x, y, zz in pc:
            if zz <= 0.5:
                continue
            u, v = F * x / zz + W / 2, F * y / zz + H / 2
            x0, x1, y0, y1 = int(max(0, u - 4)), int(min(W, u + 5)), int(max(0, v - 4)), int(min(H, v + 5))
            if x1 <= x0 or y1 <= y0:
                continue
            z[y0:y1, x0:x1] = np.minimum(z[y0:y1, x0:x1], zz)
        d = (z * metres_per_unit).astype(np.float32)
        with open(os.path.join(folder, f"depth.{f}.exr"), "wb") as fh:
            fh.write(CW.exr_bytes({"R": d, "G": d, "B": d}, depth="float", compression="none"))


def render_plate(folder):
    """N frames of 700 dots in space and 260 on a floor below them, seen by a camera that slides right and turns a little: plate.####.png."""
    from PIL import Image
    rng = np.random.default_rng(7)
    X = np.c_[rng.uniform(-9, 9, 700), rng.uniform(-4, 4, 700), rng.uniform(7, 22, 700)]
    size = rng.uniform(1.6, 3.2, 700)
    shade = rng.uniform(0.45, 1.0, 700)
    # a floor: 260 dots on the plane y = FLOOR_Y (the picture's y is down, so it is below the camera)
    fl = np.random.default_rng(11)
    X = np.r_[X, np.c_[fl.uniform(-10, 10, 260), np.full(260, FLOOR_Y), fl.uniform(14, 32, 260)]]
    size = np.r_[size, fl.uniform(1.6, 3.2, 260)]
    shade = np.r_[shade, fl.uniform(0.45, 1.0, 260)]
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


def render_cinematic(folder, seq_folder):
    """The plate as an iPhone Cinematic film: the frames as H.264 and a depth track (disparity 4 / z, the floor
    and the dots as render_depth has them, a quarter of the size) of sample type 'dish', as the phone writes it."""
    import shutil as _sh
    import subprocess
    from test_iphone_io import make_cinematic
    X, cams = plate_scene()
    dw, dh = W // 2, H // 2
    yy, xx = np.mgrid[0:dh, 0:dw].astype(np.float64) + 0.5
    dy = (yy * 2 - H / 2) / F
    disp = []
    for R, C in cams:
        z = np.where(dy > 1e-3, (FLOOR_Y - C[1]) / np.maximum(dy, 1e-9), 200.0).clip(0, 200.0)
        pc = (X - C) @ R.T
        for x, y, zz in pc:
            if zz <= 0.5:
                continue
            u, v = (F * x / zz + W / 2) / 2, (F * y / zz + H / 2) / 2
            x0, x1, y0, y1 = int(max(0, u - 2)), int(min(dw, u + 3)), int(max(0, v - 2)), int(min(dh, v + 3))
            if x1 > x0 and y1 > y0:
                z[y0:y1, x0:x1] = np.minimum(z[y0:y1, x0:x1], zz)
        disp.append(np.clip(4.0 / z, 0, 1))
    os.makedirs(folder, exist_ok=True)
    pic = os.path.join(folder, "picture.mp4")
    subprocess.run([_sh.which("ffmpeg"), "-v", "error", "-y", "-framerate", "24", "-start_number", "1001", "-i",
                    os.path.join(seq_folder, "plate.%04d.png"), "-c:v", "libx264", "-crf", "6", "-pix_fmt", "yuv420p",
                    pic], check=True)
    return make_cinematic(folder, W, H, dw, dh, frames=N, rotate=False, depth=np.asarray(disp, np.float32),
                          pic=pic, fps=24).replace("\\", "/")


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

            # The Matchmove menu opens from the 3D menu bar and lists the steps (the 3D view's tab in front: the plate opened over it).
            pg.evaluate("() => window.__panel.dockViewFront()")
            pg.wait_for_timeout(100)
            pg.evaluate_handle("() => window.__panel._modelView().root.querySelector('[data-menu=matchmove]')").as_element().click()
            pg.wait_for_timeout(150)
            items = pg.locator("button.previz-menu-item").all_inner_texts()
            pg.keyboard.press("Escape")
            self.assertTrue(any("Open Matchmove" in t for t in items), items)

            # Auto-track.
            n = pg.evaluate("async () => { const P = window.__panel; await P.matchmoveAutoTrack(); return P._mmCur().mm.tracks.length; }")
            self.assertGreater(n, 40)
            self._shot(pg, "mm_tracked")

            # A hard shot: new points on a frame in the middle, followed both ways; tracks carried on past their ends.
            hard = pg.evaluate("""async (N) => { const P = window.__panel; const st = P._mmCur();
                const ids = new Set(st.mm.tracks.map((t) => t.id));
                // the first five tracks cut to frames 4..6, then carried on
                const cut = st.mm.tracks.slice(0, 5).map((t) => t.id);
                P._mmEdit("cut", (m) => { for (const t of m.tracks) if (cut.includes(t.id)) t.keys = t.keys.filter((k) => k[0] >= 4 && k[0] <= 6); });
                const ext = await P.matchmoveExtendTracks(cut);
                const spans = st.mm.tracks.filter((t) => cut.includes(t.id)).map((t) => [t.keys[0][0], t.keys[t.keys.length - 1][0]]);
                P.setFrame(Math.floor(N / 2));
                const more = await P.matchmoveTrackFrom([Math.floor(N / 2)], { direction: "both" });
                const fresh = st.mm.tracks.filter((t) => !ids.has(t.id));
                st.mm.step = "track";
                P._mmRender();
                const labels = [...P.mmGuidePanel.querySelectorAll('button')].map((b) => b.textContent);
                return { ext, spans, more, fresh: fresh.length, first: Math.min(...fresh.map((t) => t.keys[0][0])),
                         last: Math.max(...fresh.map((t) => t.keys[t.keys.length - 1][0])), labels }; }""", N)
            self.assertGreater(hard["ext"]["keys"], 5, hard)
            self.assertTrue(any(a < 4 or b > 6 for a, b in hard["spans"]), hard["spans"])
            self.assertEqual(hard["fresh"], hard["more"]["added"])
            if hard["fresh"]:
                self.assertLess(hard["first"], N // 2)                     # followed backwards too
                self.assertGreater(hard["last"], N // 2)
            self.assertIn("New points on this frame", hard["labels"])
            self.assertTrue(any(t.startswith("Carry") for t in hard["labels"]), hard["labels"])
            pg.evaluate("() => window.__panel.dockToggleMaximized('mmGuide')")
            pg.wait_for_timeout(200)
            self._shot(pg, "mm_hard_shot")
            pg.evaluate("() => window.__panel.dockToggleMaximized('mmGuide')")
            n = pg.evaluate("() => window.__panel._mmCur().mm.tracks.length")

            # A track picked and deleted with its key, from the Plate panel (its tab brought to the front).
            pg.evaluate("""() => { const P = window.__panel; P.matchmovePlateMain(true); const st = P._mmCur();
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
                         locs, file: (sc.matchmove || {}).file || null, fps: sc.fps,
                         filmback: cam && cam.filmback, focal: cam ? P._cbValue(cam, 'focal', null) : null,
                         sensor: P._mmCur().mm.camera.sensor, fpx: P._mmCur().mm.solve.focal_px }; }""")
            self.assertTrue(built["cam"] and built["active"] and built["plate"] and built["under"], built)
            # The camera's film back is the plate's sensor, so its focal length (Channel Box) is the solve's in mm.
            self.assertEqual(built["filmback"], built["sensor"])
            self.assertAlmostEqual(built["focal"], built["fpx"] * built["sensor"][0] / W, delta=0.01)
            self.assertEqual(built["keys"], N)
            self.assertGreater(built["locs"], 20)
            self.assertTrue(built["file"] and built["file"].endswith(".mm.json"), built)
            self.assertTrue(os.path.isfile(built["file"]))
            with open(built["file"], encoding="utf-8") as fh:
                saved = json.load(fh)
            self.assertTrue(saved.get("solve"))
            self._shot(pg, "mm_built")

            # One playhead: the timeline's slider took the shot's new length (its old thumb stayed as a second one).
            self.assertEqual(pg.evaluate("() => Number(window.__panel.timeline.max)"), N - 1)
            # The plate is the plate itself, read frame by frame, and follows the timeline.
            src = pg.evaluate("() => window.__panel.previzScene().items.find((i) => i.name === 'Plate').src")
            self.assertEqual(src.get("kind"), "plate", src)
            self.assertTrue(src["path"].endswith("plate.####.png"), src)
            shown = """() => { const P = window.__panel; const pl = P.previzScene().items.find((i) => i.name === 'Plate');
                const e = P._model3d._entries.get(pl.id); return e && e.plateTex ? e.plateShown : null; }"""
            for f in (15, 3):
                pg.evaluate(f"() => window.__panel.setFrame({f})")
                pg.wait_for_function(f"() => ({shown})() === {f}", timeout=20000)

            # Its Path in the Channel Box swaps it: another sequence, one frame of it typed.
            from PIL import Image, ImageOps
            other_dir = os.path.join(os.path.dirname(self.plate), "other")
            os.makedirs(other_dir, exist_ok=True)
            for k in range(N):
                im = Image.open(self.plate.replace("####", f"{1001 + k:04d}")).convert("RGB")
                ImageOps.invert(im).save(os.path.join(other_dir, f"other.{1001 + k:04d}.png"))
            pg.evaluate("""() => { const P = window.__panel; const pl = P.previzScene().items.find((i) => i.name === 'Plate');
                P.previzSelect(pl.id); }""")
            pg.wait_for_timeout(200)
            self.assertTrue(pg.evaluate("() => window.__panel.channelsPanel.querySelector('.cb-path').value").endswith("plate.####.png"))
            pg.evaluate("""(p) => { const i = window.__panel.channelsPanel.querySelector('.cb-path');
                i.value = p; i.dispatchEvent(new Event('change')); }""", os.path.join(other_dir, "other.1009.png").replace("\\", "/"))
            pg.wait_for_function("""() => { const P = window.__panel; const pl = P.previzScene().items.find((i) => i.name === 'Plate');
                const e = P._model3d._entries.get(pl.id);
                return pl.src.path.endsWith('other.####.png') && e && e.plateTex && e.plateShown === 3; }""", timeout=20000)
            self.assertTrue(pg.evaluate("() => window.__panel.channelsPanel.querySelector('.cb-path').value").endswith("other.####.png"))
            # A path that is not there is said, and the plate stays.
            r = pg.evaluate("async () => window.__panel.previzSetPlanePath(null, '/nowhere/missing.####.exr')")
            self.assertFalse(r["ok"], r)
            self.assertIn("other", pg.evaluate("() => window.__panel.previzScene().items.find((i) => i.name === 'Plate').src.path"))

            # The layout button toggles one view and the split used last; its caret is View > Layout.
            lay = pg.evaluate("""async () => { const V = window.__panel._model3d; const b = V.ui.layoutBtn; const out = [V._paneState().layout];
                const wait = () => new Promise((r) => setTimeout(r, 120));
                b.click(); await wait(); out.push(V._paneState().layout);
                b.click(); await wait(); out.push(V._paneState().layout);
                V.setPaneLayout('2v'); V.setPaneLayout('single'); b.click(); await wait(); out.push(V._paneState().layout);
                V.ui.layoutMoreBtn.click(); await wait();
                out.push([...window.__panel._previzMenuHost().querySelectorAll('.previz-menu-item')].map((x) => x.textContent));
                V.setPaneLayout('single'); return out; }""")
            self.assertEqual(lay[:4], ["single", "quad", "single", "2v"])
            self.assertIn("✓ Two stacked", lay[4])
            self.assertIn("Four views", lay[4])
            pg.keyboard.press("Escape")

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

    def _heights(self, pg, raw=False):
        """The solved points' heights in the world: the floor's at 0 and the rest above it?"""
        return pg.evaluate("""async (raw) => {
            const D = await import('/extensions/viewer/imageViewer_matchmoveData.js');
            const st = window.__panel._mmCur(), o = st.mm.orient;
            const ids = new Set(st.groundInfo.ids || []);
            const ys = st.mm.solve.points.map((q) => ({ y: D.orientApply(o, D.pointToScene(q.X))[1], on: ids.has(q.id) }));
            const on = ys.filter((q) => q.on).map((q) => q.y).sort((a, b) => a - b);
            const mid = on[on.length >> 1];
            if (raw) return mid;
            const span = Math.max(...ys.map((q) => Math.abs(q.y)));
            const off = ys.filter((q) => !q.on).map((q) => q.y).sort((a, b) => a - b);
            return { on_floor: Math.abs(mid) < span * 0.02, above: off[off.length >> 1] > 0 };
        }""", raw)

    def _fake_mattes(self, name, white):
        """ComfyUI's answers made here: output/fakematte/<name>.<frame>.png, white where white(f, y, x)."""
        from PIL import Image
        d = os.path.join(self.dirs["output"], "fakematte")
        os.makedirs(d, exist_ok=True)
        yy, xx = np.mgrid[0:H, 0:W]
        for f in range(N):
            Image.fromarray((white(f, yy, xx) * 255).astype(np.uint8)).save(os.path.join(d, f"{name}.{f}.png"))

    def _fake_comfy(self, pg, name, ext="png", sub="fakematte"):
        """The page's road to ComfyUI stood in for: no model check, SAM 3's canvas graph a small prompt, the queue a
        promise and every frame's picture one of _fake_mattes'."""
        pg.evaluate("""([name, ext, sub]) => {
            const P = window.__panel;
            P._mmModelsReady = async () => true;
            P._paintPrompt = async (item) => item.format !== 'ui' ? null : {
                '1': { class_type: 'LoadImage', inputs: { image: 'x.png' }, _meta: { title: 'paint:image' } },
                '2': { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: 'paint:prompt' } },
                '3': { class_type: 'SAM3_Detect', inputs: { image: ['1', 0], cond: ['2', 0] } },
                '4': { class_type: 'MaskToImage', inputs: { mask: ['3', 0] } },
                '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'x' }, _meta: { title: 'paint:output' } } };
            P._paintQueue = async (graph) => { window.__queued = graph; return 'p1'; };
            P._cpAiWaitAll = async (pid, outputs) => Object.fromEntries(Object.keys(outputs).map((f) =>
                [f, { filename: `${name}.${f}.${ext}`, subfolder: sub, type: 'output' }]));
        }""", [name, ext, sub])

    @unittest.skipIf(shutil.which("ffmpeg") is None, "needs ffmpeg")
    def test_an_iphone_cinematic_film_brings_its_camera_and_its_depth_finds_the_ground(self):
        film = render_cinematic(os.path.join(self.dirs["input"], "phone"), self.dirs["output"])
        pg = self._page()
        try:
            pg.evaluate("() => { const P = window.__panel; P.matchmovePickPlate = () => {}; P.matchmoveOpen(); }")
            pg.wait_for_timeout(300)
            got = pg.evaluate("""async (p) => { const P = window.__panel; await P.matchmoveSetPlate(p);
                const st = P._mmCur(); P._mmRender();
                return { plate: st.mm.plate, cam: st.mm.camera, refine: st.mm.settings.refine, phone: st.facts.phone,
                         text: P.mmGuidePanel.textContent }; }""", film)
            self.assertEqual((got["plate"]["width"], got["plate"]["height"], got["plate"]["frames"]), (W, H, N))
            self.assertEqual(got["cam"]["model"], "Apple iPhone 14")
            self.assertAlmostEqual(got["cam"]["focalMm"], 5.7)
            self.assertEqual(got["refine"], "on")                         # a phone's focal is a start
            self.assertTrue(got["phone"]["depth"])
            self.assertIn("Cinematic depth", got["text"])
            self.assertIn("From the phone's film", got["text"])
            # Show the depth: the frame's depth picture is drawn in the guide.
            pg.evaluate("() => { const st = window.__panel._mmCur(); st.phoneDepthShown = true; window.__panel._mmRender(); }")
            pg.wait_for_function("() => { const i = window.__panel.mmGuidePanel.querySelector('img.mm-phone-depth'); return i && i.naturalWidth > 0; }",
                                 timeout=20000)
            if SHOTS:          # the guide's Plate step alone, drawn at its full height
                h = pg.evaluate_handle("""() => { const s = window.__panel.mmGuidePanel.querySelector('.mm-scroll');
                    s.style.cssText += ';position:fixed;left:20px;top:20px;width:340px;height:auto;max-height:none;z-index:99999;background:#202020;';
                    return s; }""").as_element()
                pg.wait_for_timeout(200)
                h.screenshot(path=os.path.join(SHOTS, "mm_phone_plate.png"))
                pg.evaluate("() => window.__panel._mmRender()")
            # Track and solve the film; the 35 mm key's focal is refined to the plate's real one.
            n = pg.evaluate("async () => { const P = window.__panel; await P.matchmoveAutoTrack(); return P._mmCur().mm.tracks.length; }")
            self.assertGreater(n, 40)
            sv = pg.evaluate("""async () => { const P = window.__panel; await P.matchmoveSolve();
                const s = P._mmCur().mm.solve; return { rms: s.rms, f: s.focal_px }; }""")
            self.assertLess(sv["rms"], 1.5, sv)
            # The solve pulled into the film's own depth track, and the tracks checked against it.
            dp = pg.evaluate("""async () => { const P = window.__panel;
                const s = await P.previzSceneAgent('matchmove_solve', { depth: 'phone' });
                P._mmCur().mm.step = 'solve'; P._mmRender();
                const text = P.mmGuidePanel.textContent, src = P.mmGuidePanel.querySelector('select.mm-depth-source').value;
                const e = await P.matchmoveDepthEdges();
                return { depth: s.matchmove.solve.depth, rms: s.matchmove.solve.rms_px, text, src, edges: e }; }""")
            self.assertFalse(dp["depth"].get("error"), dp["depth"])
            self.assertEqual((dp["depth"]["source"], dp["depth"]["reading"], dp["src"]), ("phone", "disparity", "phone"))
            self.assertGreater(dp["depth"]["order"], 0.5, dp["depth"])
            self.assertLess(dp["rms"], 1.5, dp)
            self.assertIn("Depth (phone", dp["text"])
            self.assertEqual(dp["edges"]["source"], "phone")
            self.assertGreater(dp["edges"]["sampled_tracks"], 20, dp["edges"])
            # The ground from the film's own depth: level, the camera above it.
            g = pg.evaluate("""async () => { const P = window.__panel; await P.matchmoveBuild();
                P._mmCur().mm.step = 'scene'; P._mmRender();
                const button = [...P.mmGuidePanel.querySelectorAll('button')].some((b) => b.textContent === "Find with the phone's depth");
                const r = await P.matchmoveGroundPhone(); return { r, button, gi: P._mmCur().groundInfo,
                text: P.mmGuidePanel.textContent }; }""")
            gi = g["gi"]
            self.assertFalse(gi.get("error"), gi)
            self.assertEqual(gi["model"], "phone")
            self.assertEqual(gi["reading"], "disparity")
            self.assertLess(gi["tilt"], 5, gi)
            self.assertGreater(gi["height"], 0, gi)
            self.assertTrue(g["button"])
            self.assertIn("phone's depth", g["text"])
            self._shot(pg, "mm_phone_ground")
            # The agent's road: the summary names the phone and its depth, the ground from it, its depth saved.
            ag = pg.evaluate("""async () => { const P = window.__panel;
                const info = await P.previzSceneAgent('matchmove_info', {});
                const ground = await P.previzSceneAgent('matchmove_ground', { how: 'phone' });
                const saved = await P.previzSceneAgent('matchmove_phone_export', {});
                return { phone: info.matchmove.phone, ground: ground.ground, depth: saved.depth }; }""")
            self.assertTrue(ag["phone"]["film"])
            self.assertTrue(ag["phone"]["depth"]["width"] > 0, ag)
            self.assertLess(ag["ground"]["tilt"], 5, ag)
            self.assertGreater(ag["ground"]["camera_height"], 0, ag)
            self.assertGreater(ag["depth"]["frames"], 0, ag)
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_the_agent_tracks_solves_and_builds_through_its_actions(self):
        """The agent's road: previzRigAgentRun (what /imageviewer/rig/agent sends the page) with matchmove_* actions,
        from a page with no 3D tab up - one is brought up, the panels open, and each answer carries the summary."""
        pg = self._page()
        try:
            pg.evaluate("""() => {
                const real = window.fetch.bind(window);
                window.__answers = {};
                window.fetch = (url, init) => {
                    if (String(url).includes('/rig/agent_done')) {
                        const b = JSON.parse(init.body);
                        if (b.state !== 'running') window.__answers[b.id] = b;
                        return Promise.resolve(new Response('{}'));
                    }
                    return real(url, init);
                };
                let n = 0;
                window.__agent = async (action, args) => {
                    const id = `a${++n}`;
                    await window.__panel.previzRigAgentRun({ id, action, args });
                    return window.__answers[id];
                };
            }""")
            # the two lists of actions agree, and the scene agent knows every matchmove one
            names = pg.evaluate("""async () => {
                const m = await import('/extensions/viewer/imageViewer_previzAgentMatchmove.js');
                const s = await import('/extensions/viewer/imageViewer_previzAgentScene.js');
                return { mm: m.MATCHMOVE_AGENT_ACTIONS, missing: m.MATCHMOVE_AGENT_ACTIONS.filter((a) => !s.SCENE_AGENT_ACTIONS.has(a)) }; }""")
            self.assertEqual(names["missing"], [])
            routes = sys.modules[self.pkg + ".rig_routes"].AGENT_ACTIONS
            self.assertEqual([a for a in names["mm"] if a not in routes], [])

            ask = lambda action, args=None: pg.evaluate("([a, b]) => window.__agent(a, b)", [action, args or {}])  # noqa: E731
            r = ask("matchmove_info")
            self.assertEqual(r["state"], "done", r)
            self.assertIsNone(r["result"]["matchmove"]["plate"])
            r = ask("matchmove_track")
            self.assertEqual(r["state"], "error")
            self.assertIn("no plate", r["error"])

            r = ask("matchmove_open", {"plate": self.plate})
            self.assertEqual(r["state"], "done", r)
            mm = r["result"]["matchmove"]
            self.assertEqual((mm["plate"]["width"], mm["plate"]["frames"]), (W, N))
            self.assertTrue(pg.evaluate("() => window.__panel.isPrevizTab() && window.__panel.isPanelDocked('mmGuide')"))

            r = ask("matchmove_lens", {"how": "set", "k1": 0, "k2": 0})
            self.assertEqual(r["result"]["matchmove"]["lens"]["source"], "typed", r)
            # a mask over the left edge keeps tracks from starting there
            r = ask("matchmove_mask", {"name": "left", "keys": [{"frame": 0, "points": [[0, 0], [90, 0], [90, H], [0, H]]}]})
            self.assertEqual(r["state"], "done", r)
            self.assertEqual(r["result"]["matchmove"]["masks"][0]["name"], "left")
            r = ask("matchmove_mask", {"keys": [{"frame": 0, "points": [[0, 0], [1, 1]]}]})
            self.assertEqual(r["state"], "error")

            r = ask("matchmove_track", {"features": 200})
            self.assertEqual(r["state"], "done", r)
            tracks = r["result"]["matchmove"]["tracks"]
            self.assertGreater(tracks["total"], 40, tracks)
            starts = pg.evaluate("() => window.__panel._mmCur().mm.tracks.map((t) => t.keys[0]).filter((k) => k[0] === 0 && k[1] < 85).length")
            self.assertEqual(starts, 0)

            r = ask("matchmove_track_delete", {"shorter_than": 4})
            self.assertEqual(r["state"], "done", r)
            r = ask("matchmove_solve", {"mode": "auto"})
            self.assertEqual(r["state"], "done", r)
            sv = r["result"]["matchmove"]["solve"]
            self.assertLess(sv["rms_px"], 1.0, sv)
            self.assertEqual(sv["frames"], N)
            self.assertAlmostEqual(sv["focal_px"], F, delta=F * 0.05)
            self.assertTrue(sv["worst_tracks"])
            worst = sv["worst_tracks"][0][0]
            r = ask("matchmove_track_delete", {"worst_share": 0.05})
            self.assertGreater(r["result"]["deleted"], 0)
            self.assertNotIn(worst, pg.evaluate("() => window.__panel._mmCur().mm.tracks.map((t) => t.id)"))
            r = ask("matchmove_solve")
            self.assertEqual(r["state"], "done", r)

            r = ask("matchmove_build")
            self.assertEqual(r["state"], "done", r)
            built = r["result"]["matchmove"]["built"]
            self.assertTrue(built and built["camera"], built)
            pts = [q[0] for q in r["result"]["matchmove"]["solve"]["worst_tracks"][-3:]]
            # The ground, found by itself: the floor dots, level, at height 0, with the cloud above it.
            r = ask("matchmove_ground", {"how": "auto"})
            self.assertEqual(r["state"], "done", r)
            g = r["result"]["ground"]
            self.assertGreater(g["points"], 20, g)
            self.assertLess(g["tilt"], 3, g)
            self.assertEqual(self._heights(pg), {"on_floor": True, "above": True})
            r = ask("matchmove_ground", {"how": "auto", "flip": True})
            self.assertFalse(self._heights(pg)["above"])                # upside down now
            r = ask("matchmove_ground", {"how": "auto", "lift": 0.5})
            self.assertEqual(r["state"], "done", r)
            self.assertAlmostEqual(self._heights(pg, raw=True), 0.5, delta=0.05)    # the floor half a unit up
            # The ground by AI: SAM 3's matte (the lower part of the picture here) votes the floor tracks in.
            self._fake_mattes("ground", lambda f, y, x: y > 255)
            self._fake_comfy(pg, "ground")
            r = ask("matchmove_ground", {"how": "ai", "prompt": "floor"})
            self.assertEqual(r["state"], "done", r)
            self.assertGreater(r["result"]["ground"]["points"], 15, r)
            self.assertLess(r["result"]["ground"]["tilt"], 3, r)
            self.assertEqual(self._heights(pg), {"on_floor": True, "above": True})
            self.assertEqual(pg.evaluate("() => window.__panel._mmCur().groundInfo.how"), "ai")
            # The ground from depth (Depth Anything 3 Metric, stood in): level, and in metres - the camera was 4.6
            # plate units above the floor, and a plate unit is half a metre here.
            render_depth(os.path.join(self.dirs["output"], "fakedepth"), self.pkg)
            self._fake_comfy(pg, "depth", "exr", "fakedepth")
            G = sys.modules[self.pkg + ".paint_generate"]
            real, G.missing = G.missing, lambda g, fp, nc: []                  # its model "is here"
            try:
                r = ask("matchmove_ground", {"how": "depth", "scale": 0.5})
            finally:
                G.missing = real
            self.assertEqual(r["state"], "done", r)
            g = r["result"]["ground"]
            self.assertTrue(g["in_metres"], g)
            self.assertLess(g["tilt"], 3, g)
            self.assertAlmostEqual(g["camera_height"], 4.6 * 0.5, delta=0.15)
            self.assertGreater(g["points"], 1000, g)
            # The solve pulled into AI depth: the depth run first (a dozen frames, kept), then the solve with it.
            real, G.missing = G.missing, lambda g, fp, nc: []
            try:
                r = ask("matchmove_solve", {"depth": "ai", "depth_scale": 0.5})
            finally:
                G.missing = real
            self.assertEqual(r["state"], "done", r)
            mmr = r["result"]["matchmove"]
            self.assertEqual(mmr["settings"]["depth"], "ai")
            self.assertEqual(len(mmr["ai_depth"]["frames"]), 12, mmr.get("ai_depth"))
            dep = mmr["solve"]["depth"]
            self.assertFalse(dep.get("error"), dep)
            self.assertEqual((dep["source"], dep["reading"]), ("ai", "depth"))
            self.assertGreater(dep["order"], 0.8, dep)
            self.assertLess(mmr["solve"]["rms_px"], 1.0)
            self.assertIn("Depth (AI", pg.evaluate("() => window.__panel.mmGuidePanel.textContent"))
            r = ask("matchmove_track_delete", {"depth_edges": True})
            self.assertEqual(r["state"], "done", r)
            de = r["result"]["depth_edges"]
            self.assertEqual((de["source"], de["frames"]), ("ai", 12))
            self.assertLess(r["result"]["deleted"], 120, r["result"])      # a few dots on the edge of a nearer one
            r = ask("matchmove_solve", {"depth": "off"})
            self.assertEqual(r["state"], "done", r)
            self.assertNotIn("depth", r["result"]["matchmove"]["solve"])
            # A mask over the whole shot from a background remover: a box on the left, frame by frame.
            self._fake_mattes("left", lambda f, y, x: x < 120)
            self._fake_comfy(pg, "left")
            r = ask("matchmove_ai_mask", {"engine": "background", "step": 2, "scale": 0.5})
            self.assertEqual(r["state"], "done", r)
            m = r["result"]["mask"]
            self.assertEqual(m["frames"], 13)                           # 0, 2 .. 22 and the last frame
            mk = pg.evaluate("(id) => window.__panel._mmCur().mm.masks.find((q) => q.id === id)", m["id"])
            self.assertEqual((mk["matte"]["engine"], mk["matte"]["width"]), ("background", W))
            self.assertTrue(os.path.isfile(mk["matte"]["pattern"].replace("####", "0004")))
            r = ask("matchmove_ai_mask", {"engine": "objects"})
            self.assertEqual(r["state"], "error")                       # SAM 3 needs words
            r = ask("matchmove_orient", {"how": "origin", "points": pts[:1]})
            self.assertEqual(r["state"], "done", r)
            r = ask("matchmove_orient", {"how": "scale", "points": pts[:2]})
            self.assertEqual(r["state"], "error")             # no distance
            r = ask("matchmove_geometry", {"kind": "locator", "points": pts[:1]})
            self.assertEqual(r["state"], "done", r)
            self.assertTrue(r["result"]["item"])
            r = ask("matchmove_lens_export", {"to": "comp"})
            self.assertEqual(r["state"], "done", r)
            self.assertTrue(os.path.isfile(r["result"]["path"]), r)
            r = ask("matchmove_save")
            self.assertTrue(os.path.isfile(r["result"]["path"]), r)
            # tracking again keeps off the AI mask
            r = ask("matchmove_track", {"features": 200, "from": 0, "to": 6})
            self.assertEqual(r["state"], "done", r)
            starts = pg.evaluate("() => window.__panel._mmCur().mm.tracks.filter((t) => t.keys[0][0] === 0 && t.keys[0][1] < 110).length")
            self.assertEqual(starts, 0)
            self.assertEqual(self.errors, [])
        finally:
            pg.close()


    def test_the_agent_sees_a_plate_loaded_by_hand(self):
        """Sebastian 2026-11-20: "the agent can't see the loaded plate in Matchmove". A plate set in the guide by hand
        (and put in the main view) is in the viewer's state the agent gets with each message - path, frames, the
        frame shown - and matchmove_frame answers the tracks on a frame for the agent to look at."""
        pg = self._page()
        try:
            pg.evaluate("""() => {
                const real = window.fetch.bind(window); window.__answers = {};
                window.fetch = (url, init) => { if (String(url).includes('/rig/agent_done')) { const b = JSON.parse(init.body);
                    if (b.state !== 'running') window.__answers[b.id] = b; return Promise.resolve(new Response('{}')); } return real(url, init); };
                let n = 0; window.__agent = async (action, args) => { const id = `a${++n}`;
                    await window.__panel.previzRigAgentRun({ id, action, args }); return window.__answers[id]; }; }""")
            self.assertNotIn("matchmove", pg.evaluate("() => window.__panel.agentViewerState()"))
            pg.evaluate("async () => { const P = window.__panel; P.matchmovePickPlate = () => {}; P.matchmoveOpen(); }")
            pg.wait_for_timeout(300)
            pg.evaluate("async (p) => { await window.__panel.matchmoveSetPlate(p); }", self.plate)
            pg.evaluate("() => { window.__panel.matchmovePlateMain(true); window.__panel.setFrame(5); }")
            pg.wait_for_timeout(300)
            vs = pg.evaluate("() => window.__panel.agentViewerState()")
            mm = vs.get("matchmove")
            self.assertIsNotNone(mm, vs)
            self.assertTrue(mm["plate"]["path"].endswith("plate.####.png"), mm)
            self.assertEqual((mm["plate"]["frames"], mm["plate"]["width"], mm["plate"]["frame_range"]), (N, W, [0, N - 1]))
            self.assertEqual(mm["current_frame"], 5)
            self.assertTrue(mm.get("plate_in_main_view"))
            self.assertEqual(mm["tracks"], {"total": 0})
            # on another tab the plate is still named, with the 3D tab it is on
            key3d = pg.evaluate("() => window.__panel.activeTab")
            pg.evaluate("""() => { const P = window.__panel; P.updateData({ unique_id: '21', tabs: { tab1: [
                { path: 'D:/out/p1.png', filename: 'p1.png', type: 'output' }] } }, null);
                const other = Object.keys(P.allTabs).find((k) => k !== P.activeTab); if (other) P.switchTab(other); }""")
            pg.wait_for_timeout(300)
            away = pg.evaluate("() => window.__panel.agentViewerState()").get("matchmove")
            self.assertEqual((away["tab"], away["on_this_tab"]), (key3d, False), away)
            # the agent's info reads the same plate (its 3D tab brought up), with the frame shown
            r = pg.evaluate("() => window.__agent('matchmove_info', {})")
            self.assertEqual(r["state"], "done", r)
            self.assertEqual(r["result"]["matchmove"]["plate"]["frames"], N)
            self.assertIn("current_frame", r["result"]["matchmove"])
            r = pg.evaluate("() => window.__agent('matchmove_track', {features: 80})")
            self.assertEqual(r["state"], "done", r)
            r = pg.evaluate("() => window.__agent('matchmove_frame', {frames: [0, 12, 99]})")
            self.assertEqual(r["state"], "done", r)
            fr = r["result"]["frames"]
            self.assertEqual([f["frame"] for f in fr], [0, 12, N - 1])
            self.assertGreater(len(fr[0]["tracks"]), 20)
            t = fr[0]["tracks"][0]
            self.assertTrue(0 <= t["x"] <= W and 0 <= t["y"] <= H, t)
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_a_mask_drawn_on_the_plate_has_tangents_and_a_b_spline_mode(self):
        """The mask tool draws as every mask tool does: a press dragged while placing pulls out the point's
        tangents (shown at once), a double-click closes it, and the Bezier / B-spline switch turns it."""
        pg = self._page()
        try:
            pg.evaluate("() => { try { localStorage.removeItem('imageviewer.viewer.maskShape'); } catch (e) {} }")
            pg.evaluate("async () => { const P = window.__panel; P.matchmovePickPlate = () => {}; P.matchmoveOpen(); }")
            pg.wait_for_timeout(300)
            pg.evaluate("async (p) => { await window.__panel.matchmoveSetPlate(p); }", self.plate)
            pg.evaluate("() => window.__panel.matchmovePlateMain(true)")
            pg.wait_for_function("() => { const st = window.__panel._mmCur(); return st && st.frameNear && st.frameNear.naturalWidth > 0; }",
                                 timeout=20000)
            pg.wait_for_timeout(300)
            pg.evaluate("() => window.__panel.matchmoveTool('mask')")
            box = pg.evaluate("() => { const r = window.__panel._mmUI.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
            at = lambda fx, fy: (box[0] + box[2] * fx, box[1] + box[3] * fy)
            pg.mouse.move(*at(0.3, 0.3)); pg.mouse.down(); pg.mouse.move(*at(0.4, 0.25), steps=5)
            d = pg.evaluate("() => window.__panel._mmCur().drawing")
            self.assertEqual(len(d), 1)
            self.assertEqual(len(d[0]), 6, "the point being placed has its tangents")
            self._shot(pg, "mm_mask_tangents_while_drawing")
            pg.mouse.up()
            pg.mouse.click(*at(0.7, 0.3))
            pg.mouse.click(*at(0.7, 0.7))
            pg.mouse.dblclick(*at(0.3, 0.7))
            mk = pg.evaluate("() => window.__panel._mmCur().mm.masks")
            self.assertEqual(len(mk), 1, mk)
            pts = mk[0]["keys"][0]["pts"]
            self.assertEqual(len(pts), 4)
            self.assertEqual(len(pts[0]), 6)
            self.assertNotIn("shape", mk[0])
            # B-spline: the picked mask is turned (control points, no tangents) and new masks start as one.
            pg.evaluate("() => window.__panel._mmUI.tools.__shape.querySelector('.mask-shape-btn[data-shape=\"bspline\"]').click()")
            mk = pg.evaluate("() => window.__panel._mmCur().mm.masks")
            self.assertEqual(mk[0].get("shape"), "bspline")
            self.assertTrue(all(len(p) == 2 for p in mk[0]["keys"][0]["pts"]))
            self.assertEqual(pg.evaluate("() => localStorage.getItem('imageviewer.viewer.maskShape')"), "bspline")
            pressed = pg.evaluate("() => [...window.__panel._mmUI.tools.__shape.querySelectorAll('.mask-shape-btn')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.shape)")
            self.assertEqual(pressed, ["bspline"])
            pg.wait_for_timeout(400)                              # the buttons' colour fades over
            self._shot(pg, "mm_mask_bspline")
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_the_plate_is_a_tab_of_the_main_view(self):
        """Sebastian 2026-11-20: the plate's Main view / 3D view button did nothing - it is gone, and the Plate opens
        as a tab of the main view, beside the 3D view; the tabs switch between them, it goes with the 3D tab."""
        pg = self._page()
        try:
            pg.evaluate("async () => { const P = window.__panel; P.matchmovePickPlate = () => {}; P.matchmoveOpen(); }")
            pg.wait_for_timeout(300)
            pg.evaluate("async (p) => { await window.__panel.matchmoveSetPlate(p); }", self.plate)
            pg.wait_for_function("() => { const st = window.__panel._mmCur(); return st && st.frameNear && st.frameNear.naturalWidth > 0; }",
                                 timeout=20000)
            q = """() => { const P = window.__panel, ui = P._mmUI;
                const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
                const tabs = [...P.dockViewEl.parentNode.querySelectorAll('.pt-tab')].map((t) => t.textContent.trim());
                return { inView: P.isPanelViewTab('mmPlate'), front: P.isPanelFront('mmPlate'), viewBehind: P.isViewBehind(),
                         main: P._mmPlateMainShown(), plate: box(P.mmPlatePanel), canvas: ui ? ui.canvas.clientWidth : 0,
                         swap: !!(ui && ui.root.querySelector('.mm-plate-swap')), bar: ui ? ui.bar.textContent : '',
                         menu: P._previzMatchmoveMenuEntries().map((e) => e.label || '').filter(Boolean),
                         state: P.agentViewerState().matchmove }; }"""
            st = pg.evaluate(q)
            self.assertTrue(st["inView"] and st["front"] and st["viewBehind"] and st["main"], st)
            self.assertFalse(st["swap"])
            self.assertNotIn("Main view", st["bar"])
            self.assertFalse(any("main view" in m for m in st["menu"]), st["menu"])
            self.assertGreater(st["plate"]["w"], 600)
            self.assertGreater(st["canvas"], 600)
            self.assertTrue(st["state"].get("plate_in_main_view"), st["state"])
            self._shot(pg, "mm_plate_tab")
            # The 3D view's tab brings it to the front; the plate stays open behind it.
            pg.evaluate("() => window.__panel.matchmovePlateMain(false)")
            pg.wait_for_timeout(300)
            st = pg.evaluate(q)
            self.assertTrue(st["inView"] and not st["front"] and not st["viewBehind"] and not st["main"], st)
            self.assertNotIn("plate_in_main_view", st["state"])
            pg.evaluate("() => window.__panel.matchmovePlateMain(true)")
            pg.wait_for_timeout(300)
            self.assertTrue(pg.evaluate(q)["main"])
            # Another tab puts the plate away and shows the main view; the 3D tab brings the plate back.
            key3d = pg.evaluate("() => window.__panel.activeTab")
            pg.evaluate("""() => { const P = window.__panel; P.updateData({ unique_id: '20', tabs: { tab1: [
                { path: 'D:/out/p1.png', filename: 'p1.png', type: 'output' }] } }, null);
                const other = Object.keys(P.allTabs).find((k) => k !== P.activeTab); if (other) P.switchTab(other); }""")
            pg.wait_for_timeout(300)
            away = pg.evaluate("() => ({ docked: window.__panel.isPanelDocked('mmPlate'), behind: window.__panel.isViewBehind() })")
            self.assertEqual(away, {"docked": False, "behind": False})
            pg.evaluate("(k) => window.__panel.switchTab(k)", key3d)
            pg.wait_for_timeout(400)
            st = pg.evaluate(q)        # the tab's 3D view comes up in front, the plate a tab behind it
            self.assertTrue(st["inView"] and not st["viewBehind"], st)
            self.assertTrue(pg.evaluate("() => window.__panel.isPanelDocked('mmPlate')"))
            # Dragged elsewhere by the user, it stays there the next time Matchmove opens.
            pg.evaluate("() => { const P = window.__panel; P.dockPanelTo('mmPlate', 'bottom'); P.matchmoveOpen(); }")
            pg.wait_for_timeout(300)
            st = pg.evaluate(q)
            self.assertFalse(st["inView"]); self.assertFalse(st["viewBehind"])
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_the_error_graph_draws_and_follows_the_playhead(self):
        """Sebastian 2026-11-20: the error per frame stayed empty, and its orange line should follow the playhead.
        Drawn when its fold opens (it was drawn once, before it had a size), redrawn as the frame moves; the masks
        step's Mask with AI sits beside Draw Mask and shows its options, with Generate Mask, only while it is on."""
        pg = self._page()
        try:
            pg.evaluate("() => { const P = window.__panel; P.matchmovePickPlate = () => {}; P.matchmoveOpen(); }")
            pg.wait_for_timeout(300)
            pg.evaluate("async (p) => { await window.__panel.matchmoveSetPlate(p); }", self.plate)
            # the masks step
            m = pg.evaluate("""async () => { const P = window.__panel, st = P._mmCur(); st.mm.step = 'masks'; P._mmRender(true);
                const btns = () => [...P.mmGuidePanel.querySelectorAll('.mm-scroll button')].map((b) => b.textContent);
                const before = btns();
                P.mmGuidePanel.querySelector('.mm-mask-ai').click();
                const row = P.mmGuidePanel.querySelector('.mm-mask-ai').parentNode;
                const order = [...row.querySelectorAll('button')].map((b) => b.textContent);
                const open = { btns: btns(), on: P.mmGuidePanel.querySelector('.mm-mask-ai').classList.contains('on'),
                               box: !!P.mmGuidePanel.querySelector('.mm-ai-mask'),
                               last: [...P.mmGuidePanel.querySelectorAll('.mm-ai-mask button')].map((b) => b.textContent).pop() };
                P.mmGuidePanel.querySelector('.mm-mask-ai').click();
                return { before, order, open, closed: !!P.mmGuidePanel.querySelector('.mm-ai-mask') }; }""")
            self.assertEqual(m["order"], ["Draw Mask", "Mask with AI"])
            self.assertNotIn("Generate Mask", m["before"])
            self.assertTrue(m["open"]["on"] and m["open"]["box"], m)
            self.assertEqual(m["open"]["last"], "Generate Mask")
            self.assertFalse(m["closed"])
            pg.evaluate("async () => { const P = window.__panel; await P.matchmoveAutoTrack(); }")
            labels = pg.evaluate("""() => { const P = window.__panel; P._mmCur().mm.step = 'track'; P._mmRender(true);
                return [...P.mmGuidePanel.querySelectorAll('.mm-scroll label')].map((l) => l.textContent); }""")
            self.assertNotIn("Hard shots", labels)
            pg.evaluate("async () => { await window.__panel.matchmoveSolve(); }")
            # the fold starts closed: the graph has no size, and is drawn when it opens
            g = pg.evaluate("""async () => { const P = window.__panel, st = P._mmCur(); st.mm.step = 'solve'; P._mmRender(true);
                const d = P.mmGuidePanel.querySelector('details[data-fold=solve-graph]');
                d.open = false; await new Promise((r) => setTimeout(r, 100));
                d.open = true; await new Promise((r) => setTimeout(r, 200));
                const c = d.querySelector('canvas.mm-graph');
                const ink = () => { const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
                    for (let i = 3; i < x.length; i += 4) if (x[i]) n++; return n; };
                const orange = () => { const x = c.getContext('2d').getImageData(0, c.height - 2, c.width, 1).data;
                    for (let i = 0; i < x.length; i += 4) if (x[i] === 255 && x[i + 1] === 102 && x[i + 2] === 0) return i / 4; return -1; };
                P.setFrame(2); await new Promise((r) => setTimeout(r, 200));
                const a = orange();
                P.setFrame(20); await new Promise((r) => setTimeout(r, 200));
                return { w: c.width, ink: ink(), a, b: orange(), frame: P.currentFrame }; }""")
            self.assertGreater(g["w"], 100, g)
            self.assertGreater(g["ink"], 500, g)
            self.assertEqual(g["frame"], 20)
            self.assertGreater(g["a"], 0, g)
            self.assertGreater(g["b"], g["a"] + 100, g)
            self._shot(pg, "mm_error_graph")
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_measurements_lasso_select_and_the_lens_chart(self):
        """Tracks picked with a lasso in the Plate panel (Ctrl takes away), two real distances measured from the
        guide: the solve comes back in metres with a third distance right; the built locators lassoed in the 3D view;
        the lens chart full screen and closed with Esc."""
        pg = self._page()
        try:
            pg.evaluate("async () => { const P = window.__panel; P.matchmovePickPlate = () => {}; P.matchmoveOpen(); }")
            pg.wait_for_timeout(300)
            pg.evaluate("async (p) => { await window.__panel.matchmoveSetPlate(p); }", self.plate)
            pg.wait_for_function("() => { const st = window.__panel._mmCur(); return st && st.frameNear && st.frameNear.naturalWidth > 0; }",
                                 timeout=20000)
            pg.evaluate("async () => { await window.__panel.matchmoveAutoTrack(); window.__panel.setFrame(0); }")
            pg.wait_for_timeout(300)
            # The camera list: a phone sets its 35 mm equivalent.
            pg.evaluate("""() => { const P = window.__panel; P._mmCur().mm.step = 'plate'; P._mmRender(); }""")
            cam = pg.evaluate("""() => { const P = window.__panel; const sel = P.mmGuidePanel.querySelector('.mm-camera-preset');
                sel.value = 'iphone14-wide'; sel.dispatchEvent(new Event('change')); return P._mmCur().mm.camera; }""")
            self.assertEqual((cam["preset"], cam["focalMm"]), ("iphone14-wide", 26), cam)
            # ... and back to nothing known: this plate is no phone's.
            pg.evaluate("""() => { const P = window.__panel; P._mmEdit('reset', (m) => { m.camera.focalMm = null; m.camera.focalKnown = false;
                m.camera.preset = ''; m.camera.sensor = [36, 24]; }); }""")

            # Lasso in the Plate panel: switched on from its bar, drawn round the left third.
            pg.evaluate("() => window.__panel._mmUI.shape.click()")
            self.assertEqual(pg.evaluate("() => window.__panel._mmCur().selectShape"), "lasso")
            box = pg.evaluate("() => { const r = window.__panel._mmUI.stage.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
            corners = pg.evaluate("""() => { const P = window.__panel, st = P._mmCur(), p = st.mm.plate;
                return [P._mmToScreen(st, 0, 0), P._mmToScreen(st, p.width / 3, 0), P._mmToScreen(st, p.width / 3, p.height), P._mmToScreen(st, 0, p.height)]; }""")
            def lasso(points, mods=()):
                for m in mods:
                    pg.keyboard.down(m)
                pg.mouse.move(box[0] + points[0][0], box[1] + points[0][1])
                pg.mouse.down()
                for (x, y) in points[1:] + points[:1]:
                    pg.mouse.move(box[0] + x, box[1] + y, steps=8)
                pg.mouse.up()
                for m in mods:
                    pg.keyboard.up(m)
            lasso(corners)
            picked = pg.evaluate("""() => { const P = window.__panel, st = P._mmCur(), p = st.mm.plate;
                const xs = [...st.sel].map((id) => { const t = st.mm.tracks.find((q) => q.id === id); return t.keys.find((k) => k[0] === 0)[1]; });
                return { n: xs.length, max: Math.max(...xs), here: st.mm.tracks.filter((t) => t.keys.some((k) => k[0] === 0 && k[1] < p.width / 3 - 4)).length }; }""")
            self.assertGreater(picked["n"], 5, picked)
            self.assertLess(picked["max"], W / 3 + 8, picked)
            self.assertGreaterEqual(picked["n"], picked["here"] - 1, picked)
            # Ctrl takes the top half away.
            top = [corners[0], corners[1], [corners[1][0], (corners[1][1] + corners[2][1]) / 2], [corners[0][0], (corners[0][1] + corners[3][1]) / 2]]
            lasso(top, ("Control",))
            left = pg.evaluate("""() => { const st = window.__panel._mmCur();
                return [...st.sel].map((id) => st.mm.tracks.find((q) => q.id === id).keys.find((k) => k[0] === 0)[2]); }""")
            self.assertTrue(left and min(left) > H / 2 - 4, left)
            self._shot(pg, "mm_lasso")

            # Two real distances, measured through the guide's buttons: the tracks' dots are known here.
            X, cams = plate_scene()
            u = F * X[:, 0] / X[:, 2] + W / 2
            v = F * X[:, 1] / X[:, 2] + H / 2
            keys0 = pg.evaluate("""() => window.__panel._mmCur().mm.tracks.map((t) => { const k = t.keys.find((q) => q[0] === 0); return k ? [t.id, k[1], k[2], t.keys.length] : null; }).filter(Boolean)""")
            truth = {}
            for tid, x, y, n in keys0:
                d = np.hypot(u - x, v - y)
                i = int(np.argmin(d))
                if d[i] < 0.8 and n >= N - 2 and np.sum(d < 6) == 1:
                    truth[tid] = X[i]
            ids = sorted(truth, key=lambda k: truth[k][0])
            self.assertGreater(len(ids), 10)
            pairs = [(ids[0], ids[-1]), (min(ids, key=lambda k: truth[k][2]), max(ids, key=lambda k: truth[k][2]))]
            pg.evaluate("() => { const P = window.__panel; P._mmCur().mm.step = 'solve'; P._mmRender(); }")
            # Measurements is a fold of the Solve step: open it (kept open over the redraws)
            pg.evaluate("() => { const d = window.__panel.mmGuidePanel.querySelector('details[data-fold=solve-measure]'); d.open = true; }")
            pg.wait_for_timeout(50)
            for a, b in pairs:
                metres = float(np.linalg.norm(truth[a] - truth[b]))
                pg.evaluate("""([a, b, m]) => { const P = window.__panel, st = P._mmCur(); st.sel = new Set([a, b]); st.measureMetres = m; P._mmRender(); }""",
                            [a, b, metres])
                pg.locator("button[data-measure=distance]").click()
            self.assertEqual(pg.evaluate("() => window.__panel._mmCur().mm.constraints.length"), 2)
            sv = pg.evaluate("""async () => { const P = window.__panel; await P.matchmoveSolve(); const s = P._mmCur().mm.solve;
                return { units: s.units, rows: s.constraints, rms: s.rms, pts: s.points.map((q) => [q.id, q.X]) }; }""")
            self.assertEqual(sv["units"], "m", sv["rows"])
            self.assertTrue(all(r["ok"] for r in sv["rows"]), sv["rows"])
            pts = {k: np.asarray(x) for k, x in sv["pts"]}
            rest = [k for k in ids if k in pts and k not in {p for pr in pairs for p in pr}]
            # distances nobody measured: 1 unit = 1 m (the median over many, the dots are a few pixels on a small plate)
            ratios = [np.linalg.norm(pts[a] - pts[b]) / np.linalg.norm(truth[a] - truth[b])
                      for i, a in enumerate(rest) for b in rest[i + 1:] if np.linalg.norm(truth[a] - truth[b]) > 3]
            self.assertGreater(len(ratios), 10)
            self.assertAlmostEqual(float(np.median(ratios)), 1.0, delta=0.06)
            pg.wait_for_timeout(200)
            rows = pg.evaluate("() => [...window.__panel.mmGuidePanel.querySelectorAll('.mm-constraint')].map((r) => r.textContent)")
            self.assertEqual(len(rows), 2)
            self.assertTrue(all("% off" in r for r in rows), rows)
            # this small plate does not pin its focal length down (it is found some 10 % off): the guide says so
            self.assertIn("warn", pg.evaluate("() => window.__panel.mmGuidePanel.querySelector('.mm-proportions').className"))
            self._shot(pg, "mm_measurements")

            # Built: the locators lassoed in the 3D view (Edit > Tool > Lasso select).
            pg.evaluate("async () => { await window.__panel.matchmoveBuild(); }")
            pg.wait_for_timeout(500)
            pg.evaluate("""() => { const P = window.__panel; P._modelView().setSelectShape('lasso'); P.previzSelectMany([], 'replace'); }""")
            pg.wait_for_timeout(300)
            c = pg.evaluate("() => { const r = window.__panel._model3d.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
            pg.evaluate("() => window.__panel.previzSetGizmoMode('select')")
            ring = [(c[0] + c[2] * fx, c[1] + c[3] * fy) for fx, fy in ((0.12, 0.12), (0.9, 0.12), (0.9, 0.9), (0.12, 0.9))]
            pg.mouse.move(*ring[0])
            pg.mouse.down()
            for p in ring[1:] + ring[:1]:
                pg.mouse.move(*p, steps=6)
            pg.mouse.up()
            pg.wait_for_timeout(200)
            chosen = pg.evaluate("() => { const P = window.__panel; const sc = P.previzScene(); return P.previzSelectedIds().filter((id) => (sc.items.find((i) => i.id === id) || {}).mmTrack).length; }")
            self.assertGreater(chosen, 5)
            self.assertFalse(pg.evaluate("() => !!window.__panel._model3d.root.querySelector('.model-lasso')"))

            # The lens chart: full screen, more squares with +, Esc closes.
            pg.evaluate("() => window.__panel.matchmoveLensChart()")
            pg.wait_for_timeout(200)
            cols = pg.evaluate("() => document.querySelector('.iv-lens-chart').dataset.cols")
            self.assertEqual(cols, "12")
            self._shot(pg, "mm_lens_chart")
            pg.keyboard.press("+")
            self.assertEqual(pg.evaluate("() => document.querySelector('.iv-lens-chart').dataset.cols"), "14")
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(100)
            self.assertFalse(pg.evaluate("() => !!document.querySelector('.iv-lens-chart')"))
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_tracks_pinned_to_geometry_put_the_solve_into_its_space(self):
        """Survey points: a track pinned by a click on a box's corner in the 3D view (it snaps), one by typed numbers
        in the guide, the rest through the agent (a point, a locator's origin): the solve lands in the geometry's
        space - the scene's units, turned and moved - and Build puts the camera where the geometry says."""
        pg = self._page()
        try:
            pg.evaluate("async () => { const P = window.__panel; P.matchmovePickPlate = () => {}; P.matchmoveOpen(); }")
            pg.wait_for_timeout(300)
            pg.evaluate("async (p) => { await window.__panel.matchmoveSetPlate(p); }", self.plate)
            pg.wait_for_function("() => { const st = window.__panel._mmCur(); return st && st.frameNear && st.frameNear.naturalWidth > 0; }",
                                 timeout=20000)
            pg.evaluate("async () => { await window.__panel.matchmoveAutoTrack(); window.__panel.setFrame(0); }")
            pg.wait_for_timeout(300)
            # The true spot of each long track, from the plate's known cameras.
            _, cams = plate_scene()
            keys = pg.evaluate("() => window.__panel._mmCur().mm.tracks.filter((t) => t.on && t.keys.length >= 20).map((t) => [t.id, t.keys])")
            truth = {}
            for tid, ks in keys:
                A = []
                for k in ks:
                    R, C = cams[int(k[0])]
                    P = np.c_[R, -R @ C]
                    x, y = (k[1] - W / 2) / F, (k[2] - H / 2) / F
                    A += [x * P[2] - P[0], y * P[2] - P[1]]
                Xh = np.linalg.svd(np.array(A))[2][-1]
                truth[tid] = Xh[:3] / Xh[3]
            self.assertGreater(len(truth), 12)
            # The geometry's world: the plate's turned, scaled, moved and in scene axes (y up).
            K, D0 = 0.37, np.array([2.0, -1.5, 4.0])
            ang = 0.7
            Q = np.array([[math.cos(ang), 0, math.sin(ang)], [0, 1, 0], [-math.sin(ang), 0, math.cos(ang)]])
            FLIP = np.diag([1.0, -1.0, -1.0])
            geo = lambda X: FLIP @ (K * Q @ np.asarray(X)) + D0  # noqa: E731
            ids = list(truth)
            P_ = np.array([truth[i] for i in ids])
            pick = []
            for ax in range(3):
                pick += [ids[int(np.argmin(P_[:, ax]))], ids[int(np.argmax(P_[:, ax]))]]
            pick = list(dict.fromkeys(pick))[:5]
            self.assertGreaterEqual(len(pick), 4)

            # 1. A click on the geometry: a box's top corner, snapped, pins the picked track there.
            pg.evaluate("""async () => {
                const P = window.__panel, v = P._modelView();
                const box = await P.previzAddPrimitive('box');
                await P.previzChanged({ reload: true });
                v.setPaneLayout('single');
                const cam = v.activeCameraObject();
                cam.position.set(3, 4, 5); v.controls.target.set(0, 0.5, 0); cam.lookAt(0, 0.5, 0); v.controls.update();
                v.requestRender();
                window.__box = box.id;
            }""")
            pg.wait_for_timeout(300)
            first = keys[0][0] if keys[0][0] not in pick else [k for k, _ in keys if k not in pick][0]
            pg.evaluate("(id) => { const P = window.__panel, st = P._mmCur(); st.sel = new Set([id]); st.mm.step = 'solve'; P._mmRender();"
                        " window.__picked = P.matchmovePinPick(); }", first)
            self.assertTrue(pg.evaluate("() => window.__panel._modelView().pickPointActive()"))
            self.assertIn("Click the spot", pg.evaluate("() => window.__panel.mmGuidePanel.textContent"))
            corner = pg.evaluate("""(p) => { const v = window.__panel._modelView(), T = v.libs.THREE, r = v.canvas.getBoundingClientRect();
                const q = new T.Vector3(...p).project(v.activeCameraObject());
                return { x: r.left + (q.x + 1) / 2 * r.width + 3, y: r.top + (1 - q.y) / 2 * r.height + 2 }; }""", [0.5, 1, 0.5])
            pg.mouse.move(corner["x"] - 20, corner["y"] - 20)
            pg.mouse.move(corner["x"], corner["y"], steps=4)
            pg.mouse.down(); pg.mouse.up()
            pin = pg.evaluate("async () => await window.__picked")
            self.assertIsNotNone(pin)
            self.assertEqual(pin["id"], first)
            self.assertEqual((pin["from"]["kind"], pin["from"]["item"]), ("point", pg.evaluate("() => window.__box")), pin)
            for a, b in zip(pin["X"], [0.5, 1, 0.5]):
                self.assertAlmostEqual(a, b, places=3)
            self.assertFalse(pg.evaluate("() => window.__panel._modelView().pickPointActive()"))
            # Esc stops waiting and pins nothing
            pg.evaluate("() => { window.__picked = window.__panel.matchmovePinPick(); }")
            pg.keyboard.press("Escape")
            self.assertIsNone(pg.evaluate("async () => await window.__picked"))
            # that pin was a test of the click: off it goes (the × in the guide's list)
            pg.evaluate("() => { const d = window.__panel.mmGuidePanel.querySelector('details[data-fold=solve-geometry]'); d.open = true; }")
            pg.evaluate("(id) => [...window.__panel.mmGuidePanel.querySelectorAll('.mm-pin')].find((li) => li.dataset.id === id).querySelector('button').click()", first)
            self.assertEqual(pg.evaluate("() => window.__panel._mmCur().mm.survey.length"), 0)

            # 2. Typed numbers in the guide.
            X0 = geo(truth[pick[0]]).tolist()
            pg.evaluate("""([id, X]) => { const P = window.__panel, st = P._mmCur(); st.sel = new Set([id]); P._mmRender();
                const d = P.mmGuidePanel.querySelector('details[data-fold=solve-geometry]'); d.open = true;
                const row = [...d.querySelectorAll('.mm-row')].find((r) => r.textContent.includes('At X Y Z'));
                const ins = row.querySelectorAll('input[type=number]');
                X.forEach((v, k) => { ins[k].value = String(v); ins[k].dispatchEvent(new Event('change')); });
                [...row.querySelectorAll('button')].find((b) => b.textContent === 'Pin').click(); }""", [pick[0], X0])
            got = pg.evaluate("() => window.__panel._mmCur().mm.survey")
            self.assertEqual([(p["id"], p["from"]["kind"]) for p in got], [(pick[0], "typed")])

            # 3. The agent: a point, and a locator's origin.
            pg.evaluate("""() => {
                const real = window.fetch.bind(window);
                window.__answers = {};
                window.fetch = (url, init) => {
                    if (String(url).includes('/rig/agent_done')) {
                        const b = JSON.parse(init.body);
                        if (b.state !== 'running') window.__answers[b.id] = b;
                        return Promise.resolve(new Response('{}'));
                    }
                    return real(url, init);
                };
                let n = 0;
                window.__agent = async (action, args) => { const id = `g${++n}`; await window.__panel.previzRigAgentRun({ id, action, args }); return window.__answers[id]; };
            }""")
            ask = lambda action, args=None: pg.evaluate("([a, b]) => window.__agent(a, b)", [action, args or {}])  # noqa: E731
            r = ask("matchmove_pin", {"add": [{"track": t, "point": geo(truth[t]).tolist()} for t in pick[1:-1]]})
            self.assertEqual(r["state"], "done", r)
            loc = pg.evaluate("""async (X) => { const P = window.__panel; const l = P.previzAddLocator(); l.position = X; l.name = 'Survey nail';
                await P.previzChanged({ reload: true }); return l.id; }""", geo(truth[pick[-1]]).tolist())
            r = ask("matchmove_pin", {"add": {"track": pick[-1], "item": "Survey nail"}, "mode": "hold"})
            self.assertEqual(r["state"], "done", r)
            pins = r["result"]["matchmove"]["pins"]
            self.assertEqual(len(pins), len(pick))
            self.assertEqual(pins[-1]["on_geometry"]["item"], loc)
            r = ask("matchmove_pin", {"add": {"track": "nope", "point": [0, 0, 0]}})
            self.assertEqual(r["state"], "error")

            # 4. The solve lands in the geometry's space.
            r = ask("matchmove_solve", {"mode": "auto", "geometry": "hold"})
            self.assertEqual(r["state"], "done", r)
            sv = r["result"]["matchmove"]["solve"]
            self.assertTrue(sv["surveyed"], sv)
            self.assertEqual(sv["units"], "scene")
            self.assertLess(sv["rms_px"], 1.0)
            self.assertAlmostEqual(sv["focal_px"], F, delta=F * 0.05)
            self.assertTrue(all(p["used"] for p in r["result"]["matchmove"]["pins"]), r["result"]["matchmove"]["pins"])
            self.assertIn("placed", pg.evaluate("() => window.__panel.mmGuidePanel.querySelector('details[data-fold=solve-geometry] summary').textContent"))
            # 5. Build: the camera stands where the geometry puts it, the Matchmove group not turned.
            r = ask("matchmove_build")
            self.assertEqual(r["state"], "done", r)
            pg.evaluate("() => window.__panel.setFrame(0)")
            pg.wait_for_timeout(200)
            at = pg.evaluate("""() => { const P = window.__panel, v = P._modelView(), st = P._mmCur();
                const e = v._entries.get(st.mm.scene.camera); e.root.updateWorldMatrix(true, false);
                return new v.libs.THREE.Vector3().setFromMatrixPosition(e.root.matrixWorld).toArray(); }""")
            want = geo(cams[0][1])
            self.assertLess(float(np.linalg.norm(np.array(at) - want)), 0.05, (at, want.tolist()))
            pg.evaluate("() => { const P = window.__panel; P._mmCur().mm.step = 'scene'; P._mmRender(); }")
            self.assertIn("Placed on the geometry", pg.evaluate("() => window.__panel.mmGuidePanel.textContent"))
            pg.evaluate("() => { const P = window.__panel; P._mmCur().mm.step = 'solve'; P._mmRender(); }")
            self._shot(pg, "mm_geometry")
            self.assertEqual(self.errors, [])
        finally:
            pg.close()


if __name__ == "__main__":
    unittest.main()
