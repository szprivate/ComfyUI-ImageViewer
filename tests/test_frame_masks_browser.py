"""Framing masks, in a real browser: the button right of Toggle Overlays and its menu put a mask of an
aspect ratio over the picture (bars where the picture is wider or taller than the ratio), its opacity
is the shade's, it follows zoom and pan, it goes with the overlays, and the 3D space draws it inside
the camera gate while looking through a camera.

Needs Playwright with a browser, node for the stub server and ffmpeg for the test still; skipped without them.
Run: python -m unittest tests.test_frame_masks_browser
FRAME_MASK_SHOTS=<folder> saves screenshots.
"""
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FFMPEG = shutil.which("ffmpeg")
SHOTS = os.environ.get("FRAME_MASK_SHOTS") or None

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  try { localStorage.removeItem('imageviewer.viewer.frameMasks'); } catch (_) {}
  P._fmState = null;
  P.setViewerToggleState(true);
  P.updateData({ unique_id: '20', tabs: { tab1: [
    { path: 'D:/out/p1.png', filename: 'p1.png', type: 'output' }] } }, null);
}"""

# The picture's outline (#img-frame) and the mask's box and hole, in page pixels.
STATE = """() => { const P = window.__panel, vp = P.viewport;
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const m = vp.querySelector('#frame-mask'), hole = m && m.querySelector('.frame-mask-hole');
  const shown = !!m && getComputedStyle(m).display !== 'none';
  return { shown, frame: box(P.imgFrame), mask: shown ? box(m) : null, hole: shown && hole ? box(hole) : null,
    shadow: hole ? hole.style.boxShadow : '', label: hole ? hole.textContent : '',
    btn: P.frameMaskBtn.classList.contains('active') }; }"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or FFMPEG is None,
                 "needs playwright, node and ffmpeg")
class FrameMaskBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="imageviewer_masks_")
        # 4:3, so 16:9 leaves bars top and bottom and 9:16 left and right.
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=800x600:rate=1:duration=1",
                        "-frames:v", "1", os.path.join(cls.media, "p1.png")], check=True)
        # The Edit harness's films (D:/out/a.mp4, b.mp4), served for real so its tab shows a picture.
        for name, secs in (("a.mp4", 4), ("b.mp4", 5)):
            subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size=640x360:rate=24:duration={secs}",
                            "-pix_fmt", "yuv420p", os.path.join(cls.media, name)], check=True)
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.media)
        env.pop("HARNESS_MEDIA", None)
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
        cls.server.terminate()
        cls.server.wait(5)
        shutil.rmtree(cls.media, ignore_errors=True)

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1400, "height": 900})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_function("() => window.__panel.imgBase.naturalWidth > 0", timeout=15000)
        pg.wait_for_timeout(150)
        return pg

    def shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, name))

    def _open_menu(self, pg):
        x, y = pg.evaluate("""() => { const r = window.__panel.frameMaskMoreBtn.getBoundingClientRect();
            return [r.x + r.width / 2, r.y + r.height / 2]; }""")
        pg.mouse.click(x, y)
        pg.wait_for_selector("#frame-mask-menu", timeout=3000)

    def assertNear(self, a, b, tol=1.5, msg=None):
        self.assertLess(abs(a - b), tol, msg or f"{a} != {b}")

    def test_the_menu_puts_a_ratio_over_the_picture(self):
        pg = self.page()
        st = pg.evaluate(STATE)
        self.assertFalse(st["shown"])
        self.assertFalse(st["btn"])
        # The button sits right of Toggle Overlays.
        order = pg.evaluate("""() => { const P = window.__panel, kids = [...P.overlaysBtn.parentNode.children];
            return [kids.indexOf(P.overlaysBtn), kids.indexOf(P.frameMaskBtn), kids.indexOf(P.frameMaskMoreBtn)]; }""")
        self.assertLess(order[0], order[1])
        self.assertEqual(order[1] + 1, order[2])

        self._open_menu(pg)
        labels = pg.evaluate("() => [...window.__panel.container.querySelectorAll('#frame-mask-menu .frame-mask-pick')].map(b => b.textContent)")
        for k in ("4:3", "16:9", "1.85:1", "21:9", "2.39:1", "9:16", "1:1", "4:5"):
            self.assertIn(k, labels)

        # 16:9 on a 4:3 picture: as wide as the picture, bars top and bottom.
        pg.click("#frame-mask-menu .frame-mask-pick[data-mask='1.78']")
        st = pg.evaluate(STATE)
        self.assertTrue(st["shown"] and st["btn"], st)
        f, m, h = st["frame"], st["mask"], st["hole"]
        self.assertNear(m["x"], f["x"]); self.assertNear(m["w"], f["w"]); self.assertNear(m["h"], f["h"])
        self.assertNear(h["w"], f["w"])
        self.assertNear(h["h"], f["w"] * 9 / 16)
        self.assertNear(h["y"] - f["y"], (f["h"] - h["h"]) / 2)
        self.assertEqual(st["label"], "16:9")
        self.assertIn("0.75", st["shadow"])      # the default opacity
        self.shot(pg, "1-16x9.png")

        # 9:16: as tall as the picture, bars left and right.
        pg.click("#frame-mask-menu .frame-mask-pick[data-mask='0.56']")
        st = pg.evaluate(STATE)
        h, f = st["hole"], st["frame"]
        self.assertNear(h["h"], f["h"])
        self.assertNear(h["w"], f["h"] * 9 / 16)
        self.assertNear(h["x"] - f["x"], (f["w"] - h["w"]) / 2)

        # Opacity: the slider is the shade's alpha, kept for the next page.
        pg.evaluate("""() => { const s = window.__panel.container.querySelector('#frame-mask-menu .frame-mask-slider');
            s.value = '30'; s.dispatchEvent(new Event('input')); }""")
        st = pg.evaluate(STATE)
        self.assertIn("0.3)", st["shadow"])
        self.assertEqual(pg.evaluate("() => window.__panel.container.querySelector('#frame-mask-menu .frame-mask-value').textContent"), "30%")
        kept = pg.evaluate("() => JSON.parse(localStorage.getItem('imageviewer.viewer.frameMasks'))")
        self.assertEqual(kept["key"], "0.56")
        self.assertAlmostEqual(kept["opacity"], 0.3)
        self.assertTrue(kept["on"])

        # A ratio of one's own.
        pg.fill("#frame-mask-menu .frame-mask-input", "3:2")
        st = pg.evaluate(STATE)
        self.assertEqual(st["label"], "3:2")
        self.assertNear(st["hole"]["h"], st["frame"]["w"] / 1.5)
        pg.fill("#frame-mask-menu .frame-mask-input", "nonsense")
        self.assertEqual(pg.evaluate(STATE)["label"], "3:2")     # stays on the last one that read
        self.shot(pg, "2-menu.png")

        # The button switches it off and on again; Escape closes the menu.
        pg.keyboard.press("Escape")
        self.assertFalse(pg.is_visible("#frame-mask-menu"))
        pg.evaluate("() => window.__panel.frameMaskBtn.click()")
        self.assertFalse(pg.evaluate(STATE)["shown"])
        pg.evaluate("() => window.__panel.frameMaskBtn.click()")
        self.assertTrue(pg.evaluate(STATE)["shown"])
        self.assertEqual(self.errors, [])

    def test_it_follows_zoom_and_pan_and_goes_with_the_overlays(self):
        pg = self.page()
        pg.evaluate("() => window.__panel.frameMaskSet({ on: true, key: '2.39' })")
        st = pg.evaluate(STATE)
        self.assertEqual(st["label"], "2.39:1")
        pg.evaluate("() => { const P = window.__panel; P.zoom = 2; P.panX = 60; P.panY = -40; P.updateTransform(); }")
        pg.wait_for_timeout(50)
        z = pg.evaluate(STATE)
        # The outline is the picture as drawn (transformed): the mask lies on it.
        self.assertNear(z["mask"]["w"], z["frame"]["w"], 2)
        self.assertNear(z["mask"]["x"], z["frame"]["x"], 2)
        self.assertNear(z["mask"]["y"], z["frame"]["y"], 2)
        self.assertNear(z["mask"]["w"], st["mask"]["w"] * 2, 2)
        self.assertNear(z["hole"]["h"], z["frame"]["w"] / 2.39, 2)

        # Toggle Overlays (S) takes it away with the rest, and brings it back.
        pg.evaluate("() => window.__panel.toggleOverlays(false)")
        self.assertFalse(pg.evaluate(STATE)["shown"])
        pg.evaluate("() => window.__panel.toggleOverlays(true)")
        self.assertTrue(pg.evaluate(STATE)["shown"])

        # Shift+G is its key.
        box = pg.evaluate("() => { const r = window.__panel.viewport.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
        pg.mouse.move(*box)
        pg.keyboard.press("Shift+G")
        self.assertFalse(pg.evaluate(STATE)["shown"])
        pg.keyboard.press("Shift+G")
        self.assertTrue(pg.evaluate(STATE)["shown"])
        self.assertEqual(self.errors, [])

    def test_the_3d_space_masks_the_camera_gate(self):
        pg = self.page()
        pg.evaluate("""async () => { const P = window.__panel;
            P.frameMaskSet({ on: true, key: '2.39', opacity: 0.6 });
            await P.spaceOpen('3d');
            await P.previzAddPrimitive('box');
            P._modelView().setPaneLayout('single'); }""")
        pg.wait_for_timeout(300)
        q3 = """() => { const v = window.__panel._modelView(), el = v._fmEl;
            const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
            const gf = v.ui.gateFrame;
            return { shown: !!el && getComputedStyle(el).display !== 'none', mask: el ? box(el) : null,
                     hole: el && el.firstChild ? box(el.firstChild) : null, stage: box(v.stage),
                     gate: getComputedStyle(v.ui.gate).display !== 'none' ? box(gf) : null,
                     flat: !!window.__panel.viewport.querySelector('#frame-mask') &&
                           getComputedStyle(window.__panel.viewport.querySelector('#frame-mask')).display !== 'none' }; }"""
        st = pg.evaluate(q3)
        # No camera looked through: the whole view; the Viewer's own mask is not drawn on a 3D tab.
        self.assertTrue(st["shown"], st)
        self.assertFalse(st["flat"])
        self.assertNear(st["mask"]["w"], st["stage"]["w"])
        self.assertNear(st["hole"]["h"], st["stage"]["w"] / 2.39, 2)
        self.shot(pg, "3-3d-view.png")

        pg.evaluate("""async () => { const P = window.__panel; P.previzAddCamera();
            const cam = P.scene3d ? P.scene3d.activeCamera : null;
            P.previzLookThroughSelected(); }""")
        pg.wait_for_timeout(300)
        st = pg.evaluate(q3)
        self.assertIsNotNone(st["gate"], st)
        self.assertNear(st["mask"]["x"], st["gate"]["x"])
        self.assertNear(st["mask"]["w"], st["gate"]["w"])
        self.assertNear(st["mask"]["h"], st["gate"]["h"])
        self.assertNear(st["hole"]["h"], min(st["gate"]["h"], st["gate"]["w"] / 2.39), 2)
        self.shot(pg, "4-3d-gate.png")

        # Split panes: no single picture to mask.
        pg.evaluate("() => window.__panel._modelView().setPaneLayout('quad')")
        pg.wait_for_timeout(200)
        self.assertFalse(pg.evaluate(q3)["shown"])
        self.assertEqual(self.errors, [])

    def test_a_cuts_tab_in_the_edit_space_is_masked_too(self):
        import sys
        sys.path.insert(0, os.path.dirname(__file__))
        from test_edit_timeline_browser import SETUP as EDIT_SETUP
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('comfyui-image-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        pg.evaluate(EDIT_SETUP, 0)
        pg.wait_for_function("() => __panel._emPending === 0 && __panel._emDrawn > 0", timeout=15000)
        pg.evaluate("() => { __panel.setFrame(24); __panel.frameMaskSet({ on: true, key: '2.39' }); }")
        pg.wait_for_function("""() => { const m = __panel.viewport.querySelector('#frame-mask');
            return !!m && getComputedStyle(m).display !== 'none'; }""", timeout=5000)
        st = pg.evaluate("""() => { const P = __panel, m = P.viewport.querySelector('#frame-mask'), el = P._activeBaseEl();
            const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
            return { mask: r(m), hole: r(m.firstChild), cut: !!P._editTlTab }; }""")
        self.assertTrue(st["cut"])
        self.assertNear(st["hole"]["w"], st["mask"]["w"])
        self.assertNear(st["hole"]["h"], st["mask"]["w"] / 2.39, 2)
        self.shot(pg, "5-edit.png")
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
