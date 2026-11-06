"""Toggle Overlays, in a real browser: the toolbar button (and the S key) hides everything drawn over the
picture and brings it back as it was, and the picture itself stays.

Needs Playwright with a browser, node for the stub server and ffmpeg for the test still; skipped without them.
Run: python -m unittest tests.test_toggle_overlays_browser
It serves tests/harness/tabs.html - the REAL viewer js against stubbed ComfyUI scripts - on a free port.
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

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  P.updateData({ unique_id: '20', tabs: { tab1: [
    { path: 'D:/out/p1.png', filename: 'p1.png', type: 'output' }] } }, null);
}"""

# Each overlay: the element, and whether it shows (its computed display).
SHOWN = """() => { const P = window.__panel, vp = P.viewport;
  const q = (s) => vp.querySelector(s);
  const on = (el) => !!el && getComputedStyle(el).display !== 'none';
  return { off: vp.classList.contains('overlays-off'), btn: P.overlaysBtn.classList.contains('active'),
    shape: on(q('#shape-overlay')), exposure: on(q('#exposure-control')), path: on(q('.path-bar')),
    toolbar: on(q('.bepic-toolbar')), frame: on(q('#img-frame')),
    picture: on(P.imgBase) && P.imgBase.naturalWidth > 0 }; }"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or FFMPEG is None,
                 "needs playwright, node and ffmpeg")
class ToggleOverlaysBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="bepic_overlays_")
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=400x300:rate=1:duration=1",
                        "-frames:v", "1", os.path.join(cls.media, "p1.png")], check=True)
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
        pg.wait_for_timeout(100)
        return pg

    def test_button_hides_every_overlay_and_brings_them_back(self):
        pg = self.page()
        before = pg.evaluate(SHOWN)
        self.assertFalse(before["off"])
        self.assertTrue(before["btn"])
        self.assertTrue(before["shape"] and before["exposure"] and before["toolbar"] and before["picture"], before)

        pg.evaluate("() => window.__panel.overlaysBtn.click()")
        off = pg.evaluate(SHOWN)
        self.assertTrue(off["off"])
        self.assertFalse(off["btn"])
        for k in ("shape", "exposure", "path", "toolbar", "frame"):
            self.assertFalse(off[k], k)
        self.assertTrue(off["picture"])

        pg.evaluate("() => window.__panel.overlaysBtn.click()")
        self.assertEqual(pg.evaluate(SHOWN), before)
        self.assertEqual(self.errors, [])

    def test_s_key_runs_the_same_toggle(self):
        pg = self.page()
        label = pg.evaluate("""async () => (await import('/extensions/viewer/bEpicViewer_keymap.js'))
            .viewerActionById('bEpic.Viewer.ToggleShape').label""")
        self.assertEqual(label, "Toggle Overlays")
        box = pg.evaluate("() => { const r = window.__panel.viewport.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
        pg.mouse.move(*box)
        pg.keyboard.press("s")
        st = pg.evaluate(SHOWN)
        self.assertTrue(st["off"] and not st["shape"] and not st["exposure"], st)
        pg.keyboard.press("s")
        self.assertFalse(pg.evaluate(SHOWN)["off"])
        pg.evaluate("() => window.__panel.toggleOverlays(false)")
        self.assertTrue(pg.evaluate(SHOWN)["off"])
        self.assertEqual(self.errors, [])

if __name__ == "__main__":
    unittest.main()
