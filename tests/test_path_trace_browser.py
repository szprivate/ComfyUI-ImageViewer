"""The 3D space's second renderer, path traced (imageViewer_view3dPathTrace.js), in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js and
three-gpu-pathtracer served from vendor/three: the Shading menu's "Path traced" traces the viewport
(samples counted in the corner), a render frame through the tracer is a picture, and the render dialog
offers the renderer with its samples and bounces. Headless Chrome traces on the CPU (SwiftShader), so
only a few samples are asked for.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_path_trace_browser
"""
import os
import shutil
import socket
import subprocess
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# A folder to write screenshots into (PATH_TRACE_SHOTS).
SHOTS = os.environ.get("PATH_TRACE_SHOTS") or None

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('plane');
  await P.previzAddPrimitive('box');
  const v = P._modelView();
  v.setPaneLayout('single');
  return true;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class PathTraceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
        cls.server = subprocess.Popen(["node", os.path.join(ROOT, "tests", "harness", "server.mjs"), ROOT], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/tabs.html", timeout=1).read()
                break
            except Exception:
                time.sleep(0.1)
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                cls.browser = (cls.pw.chromium.launch(channel=channel, headless=True) if channel
                               else cls.pw.chromium.launch(headless=True))
                break
            except Exception:
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
        if getattr(cls, "server", None):
            cls.server.kill()
            cls.server.wait()

    def _page(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2 if SHOTS else 1)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_timeout(200)
        return pg

    def test_the_viewport_traces_and_counts_its_samples(self):
        pg = self._page()
        try:
            pg.evaluate("() => window.__panel._modelView().setMaterialMode('pathtraced')")
            pg.wait_for_function("() => window.__panel._modelView().ptSamples() >= 2", timeout=240000)
            state = pg.evaluate("""() => { const v = window.__panel._modelView();
                return { mode: v.materialMode, select: v.root.querySelector('.model-mode').value,
                         badge: v._ptBadgeEl && v._ptBadgeEl.textContent, shown: v._ptBadgeEl && v._ptBadgeEl.style.display,
                         failed: !!v._ptFailed, plane: v._ptContentNow.length }; }""")
            if SHOTS:
                pg.evaluate_handle("() => window.__panel._modelView().root").as_element().screenshot(
                    path=os.path.join(SHOTS, "path-traced-viewport.png"))
            # Moving the camera starts the picture again from the first samples.
            before = pg.evaluate("() => window.__panel._modelView().ptSamples()")
            pg.evaluate("""() => { const v = window.__panel._modelView(); v.camera.position.x += 2; v.controls.update(); v.requestRender(); }""")
            pg.wait_for_timeout(400)
            after = pg.evaluate("() => window.__panel._modelView().ptSamples()")
            # Back to Original: no badge, raster again.
            pg.evaluate("() => window.__panel._modelView().setMaterialMode('original')")
            badge_off = pg.evaluate("() => window.__panel._modelView()._ptBadgeEl.style.display")
        finally:
            pg.close()
        self.assertFalse(state["failed"])
        self.assertEqual(state["mode"], "pathtraced")
        self.assertEqual(state["select"], "pathtraced")
        self.assertTrue(state["badge"].startswith("Path traced"), state["badge"])
        self.assertEqual(state["shown"], "")
        self.assertEqual(state["plane"], 2)      # the plane and the box; the grid and gizmo are not traced
        self.assertLess(after, before)
        self.assertEqual(badge_off, "none")
        self.assertEqual(self.errors, [])

    def test_raster_while_moving_is_an_option(self):
        pg = self._page()
        try:
            default = pg.evaluate("() => window.__panel._modelView().ptRasterWhileMoving()")
            pg.evaluate("() => { const v = window.__panel._modelView(); v.ptSetRasterWhileMoving(true); v.setMaterialMode('pathtraced'); }")
            pg.wait_for_function("() => window.__panel._modelView().ptSamples() >= 1", timeout=240000)
            # Move the box a little every frame for a while: raster meanwhile, no rebuild.
            moving = pg.evaluate("""async () => { const P = window.__panel; const v = P._modelView();
                const box = P.previzScene().items.find((i) => i.name === 'Box');
                const ent = v._entries.get(box.id); const builds = []; let badge = '';
                const orig = v._pt.setScene.bind(v._pt); v._pt.setScene = (...a) => { builds.push(1); return orig(...a); };
                for (let i = 0; i < 8; i++) {
                    ent.root.position.x += 0.05; v.requestRender();
                    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                    badge = v._ptBadgeEl.textContent;
                }
                return { builds: builds.length, badge }; }""")
            pg.wait_for_function("() => window.__panel._modelView()._ptBadgeEl.textContent.startsWith('Path traced · ') && "
                                 "!window.__panel._modelView()._ptBadgeEl.textContent.includes('moving') && "
                                 "window.__panel._modelView().ptSamples() >= 1", timeout=240000)
            pg.evaluate("() => window.__panel.previzMenuBarOpen('view')")
            pg.wait_for_timeout(100)
            menu = [t for t in pg.locator("button.previz-menu-item").all_inner_texts() if "raster while moving" in t]
            kept = pg.evaluate("() => localStorage.getItem('imageviewer.viewer.ptRasterWhileMoving')")
        finally:
            pg.close()
        self.assertFalse(default)
        self.assertEqual(moving["builds"], 0)
        self.assertEqual(moving["badge"], "Path traced · raster while moving")
        self.assertEqual(menu, ["✓ Path traced: raster while moving"])
        self.assertEqual(kept, "1")
        self.assertEqual(self.errors, [])

    def test_a_split_layout_traces_the_active_pane(self):
        pg = self._page()
        try:
            pg.evaluate("() => { const v = window.__panel._modelView(); v.setPaneLayout('quad'); v.setMaterialMode('pathtraced'); }")
            pg.wait_for_function("() => window.__panel._modelView().ptSamples() >= 1", timeout=240000)
            state = pg.evaluate("""() => { const v = window.__panel._modelView(); const box = v._paneActiveBox();
                const pr = v.renderer.getPixelRatio(); const size = new v.libs.THREE.Vector2(); v._pt._pathTracer.getSize(size);
                return { badge: v._ptBadgeEl.textContent, w: size.x, h: size.y, pw: Math.floor(box.w * pr), ph: Math.floor(box.h * pr),
                         cam: v._pt.camera === v.activeCameraObject(), failed: !!v._ptFailed }; }""")
            if SHOTS:
                pg.evaluate_handle("() => window.__panel._modelView().root").as_element().screenshot(
                    path=os.path.join(SHOTS, "path-traced-quad.png"))
            # Back to one view: the tracer takes the whole canvas again.
            pg.evaluate("() => window.__panel._modelView().setPaneLayout('single')")
            pg.wait_for_function("() => { const v = window.__panel._modelView(); const s = new v.libs.THREE.Vector2(); v._pt._pathTracer.getSize(s);"
                                 " return s.x === v.renderer.getDrawingBufferSize(new v.libs.THREE.Vector2()).x; }", timeout=60000)
            single = pg.evaluate("() => window.__panel._modelView()._ptBadgeEl.textContent")
        finally:
            pg.close()
        self.assertFalse(state["failed"])
        self.assertTrue(state["badge"].startswith("Path traced (active view) · "), state["badge"])
        self.assertEqual((state["w"], state["h"]), (state["pw"], state["ph"]))
        self.assertTrue(state["cam"])
        self.assertNotIn("active view", single)
        self.assertEqual(self.errors, [])

    def test_default_lights_off_leaves_only_the_scenes_own_lights(self):
        pg = self._page()
        read = """() => { const v = window.__panel._modelView(); v._tick(); const m = v._pt._pathTracer.material;
            return { env: m.environmentIntensity, lights: m.lights.count }; }"""
        try:
            pg.evaluate("() => window.__panel._modelView().setMaterialMode('pathtraced')")
            pg.wait_for_function("() => !!window.__panel._modelView()._pt && window.__panel._modelView()._ptSig", timeout=240000)
            on = pg.evaluate(read)
            pg.evaluate("() => window.__panel.previzSetDefaultLights('off')")
            off = pg.evaluate(read)
            # A light of the scene's own shines; switched off (its root hidden) it does not.
            pg.evaluate("() => { const P = window.__panel; P.previzAddLight('point'); }")
            lit = pg.evaluate(read)
            pg.evaluate("""() => { const P = window.__panel; const it = P.previzScene().items.find((i) => i.kind === 'light');
                it.visible = false; P.previzChanged(); P._modelView().requestRender(); }""")
            dark = pg.evaluate(read)
        finally:
            pg.close()
        self.assertGreater(on["env"], 0)
        self.assertEqual(on["lights"], 1)       # the studio key (its four fills are not traced)
        self.assertEqual(off, {"env": 0, "lights": 0})
        self.assertEqual(lit, {"env": 0, "lights": 1})
        self.assertEqual(dark, {"env": 0, "lights": 0})
        self.assertEqual(self.errors, [])

    def test_a_render_frame_is_traced(self):
        pg = self._page()
        try:
            out = pg.evaluate("""async () => { const v = window.__panel._modelView();
                v.beginRender({ shading: 'original', background: 'viewer', aa: 1 });
                let n = 0;
                const url = await v.renderFramePathTraced(null, 96, 64, { samples: 2, bounces: 3, onSample: (k) => { n = k; } });
                v.endRender();
                const img = new Image(); img.src = url; await img.decode();
                return { head: url && url.slice(0, 22), w: img.width, h: img.height, n, mode: v.materialMode }; }""")
        finally:
            pg.close()
        self.assertEqual(out["head"], "data:image/png;base64,")
        self.assertEqual((out["w"], out["h"]), (96, 64))
        self.assertGreaterEqual(out["n"], 2)
        self.assertEqual(out["mode"], "original")
        self.assertEqual(self.errors, [])

    def test_the_render_dialog_offers_the_renderer(self):
        pg = self._page()
        try:
            pg.evaluate("() => window.__panel.previzRenderDialog()")
            pg.wait_for_function("() => !!window.__panel._renderDlg")
            box = "window.__panel._renderDlg.box"
            sel = f"[...{box}.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'pathtraced'))"
            rows = f"""() => {{ const b = {box}; const vis = (n) => n && n.closest('.rd-row') ? n.closest('.rd-row').style.display !== 'none' : null;
                const nums = [...b.querySelectorAll('input[type=number]')];
                const samples = nums.find((n) => n.max === '16384');
                const shading = [...b.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'wireframe'));
                return {{ samples: vis(samples), shading: vis(shading), summary: b.querySelector('.rd-summary').textContent }}; }}"""
            raster = pg.evaluate(rows)
            pg.evaluate(f"() => {{ const s = {sel}; s.value = 'pathtraced'; s.dispatchEvent(new Event('change')); }}")
            traced = pg.evaluate(rows)
            if SHOTS:
                pg.evaluate_handle(f"() => {box}").as_element().screenshot(path=os.path.join(SHOTS, "render-dialog.png"))
        finally:
            pg.close()
        self.assertEqual(raster["samples"], False)
        self.assertEqual(raster["shading"], True)
        self.assertEqual(traced["samples"], True)
        self.assertEqual(traced["shading"], False)
        self.assertIn("path traced, 256 samples", traced["summary"])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
