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


if __name__ == "__main__":
    unittest.main()
