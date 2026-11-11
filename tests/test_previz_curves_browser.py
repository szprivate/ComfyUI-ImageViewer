"""The 3D space's Curve Editor shows an animated object's keys, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three as the server does: a box keyed at two frames draws a dot per key and channel in the
Curve Editor. It once drew nothing: the panel wrote `ui.subText`, which the shared curve panel
(imageViewer_curveUI.js) has never had - it is `ui.sub` - so every refresh threw before a curve.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_previz_curves_browser
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

KEY_A_BOX = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  const it = P.previzSelectedItem();
  P.setFrame(0); P.previzKeyAll('position');
  P.setFrame(20); it.position = [3, 1, 0]; P.previzKeyAll('position');
  P.setPanelDocked('curves', true);
  P.previzRefreshCurves();
  const h = P.curvesPanel, sub = h.querySelector('.curves-sub');
  return { name: it.name, keys: it.tracks.position.map((k) => k.f),
           dots: h.querySelectorAll('.kf-dot').length,
           curves: h.querySelectorAll('svg path').length,
           sub: sub ? sub.textContent : null,
           lit: [...h.querySelectorAll('.curves-ch.on')].map((r) => r.textContent) };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class PrevizCurvesTests(unittest.TestCase):
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

    def test_an_animated_box_shows_its_keys_in_the_curve_editor(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if "failed to wake up" in m.text else None)
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate(KEY_A_BOX)
        finally:
            pg.close()
        self.assertEqual(st["keys"], [0, 20])
        self.assertEqual(st["lit"], ["translate.x", "translate.y", "translate.z"], "the animated channels are on")
        self.assertEqual(st["dots"], 6, "a dot per key on each of the three channels")
        self.assertGreaterEqual(st["curves"], 3)
        self.assertEqual(st["sub"], "Box · 3 channels")
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
