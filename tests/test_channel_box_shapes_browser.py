"""The Channel Box's SHAPES rows are sliders, in a real browser with a real mouse.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html). Every number under
SHAPES - a light's, a world item's, a camera's Resolution, an image plane's Opacity - changes when its
name is dragged left / right, as the transform channels' names do, and the whole drag is one undo
step. Before, only the channels had the drag: the other rows showed the drag cursor and did nothing.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_channel_box_shapes_browser
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

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  P._modelView().setPaneLayout('single');
  return true;
}"""

ROW = """(label) => {
  for (const l of window.__panel.container.querySelectorAll('.cb-body .cb-label')) {
    if (l.textContent !== label) continue;
    l.scrollIntoView({ block: 'center' });
    const b = l.getBoundingClientRect();
    const i = l.parentNode.querySelector('input, select');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, value: i ? i.value : null };
  }
  return null;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ShapeSliderTests(unittest.TestCase):
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

    def _page(self, add):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_function("() => window.__panel._modelView().camera", timeout=10000)
        pg.wait_for_timeout(200)
        pg.evaluate(add)
        pg.wait_for_timeout(500)
        pg.evaluate("""() => { const P = window.__panel;
            if (!P.isPanelDocked('params')) P.setPanelDocked('params', true); P._previzRenderChannels(); }""")
        pg.wait_for_timeout(200)
        return pg

    def _drag(self, pg, label, dx):
        """Press on the row's name, move in steps, let go - the mouse, not a script."""
        r = pg.evaluate(ROW, label)
        self.assertIsNotNone(r, f"no row {label!r}")
        pg.mouse.move(r["x"], r["y"])
        pg.mouse.down()
        for k in range(1, 11):
            pg.mouse.move(r["x"] + dx * k / 10, r["y"])
        pg.mouse.up()
        pg.wait_for_timeout(300)
        return float(r["value"]), float(pg.evaluate(ROW, label)["value"])

    def _undo_labels(self, pg):
        return pg.evaluate("() => window.__panel._undoState().past.map((p) => p.label)")

    def test_a_lights_numbers_follow_a_drag_of_their_names(self):
        pg = self._page("() => window.__panel.previzAddLight('spot')")
        try:
            before, after = self._drag(pg, "Intensity", 40)
            self.assertGreater(after, before)
            pg.wait_for_timeout(300)
            three = pg.evaluate("""() => [...window.__panel._modelView()._entries.values()]
                .find((e) => e.item.kind === 'light').light.intensity""")
            self.assertAlmostEqual(three, after)
            before, after = self._drag(pg, "Cone angle", -40)
            self.assertLess(after, before)
            # One undo step a drag.
            self.assertEqual(self._undo_labels(pg)[-2:], ["set light.intensity", "set light.angle"])
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(200)
            self.assertEqual(pg.evaluate("() => window.__panel.previzSelectedItem().light.angle"), before)
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_a_worlds_numbers_follow_a_drag(self):
        pg = self._page("() => window.__panel.previzAddWorldItem('environment')")
        try:
            before, after = self._drag(pg, "Sun azimuth", 40)
            self.assertAlmostEqual(after, before + 40)      # step 5, a fifth of it a pixel
            before, after = self._drag(pg, "Sun elevation", 400)
            self.assertEqual(after, 90)                     # held to its range
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_a_cameras_resolution_and_an_image_planes_opacity(self):
        pg = self._page("() => window.__panel.previzAddCamera()")
        try:
            before, after = self._drag(pg, "Resolution W", 40)
            self.assertEqual(after, before + 40)
            self.assertEqual(pg.evaluate("() => window.__panel.previzSelectedItem().resolution[0]"), after)
        finally:
            pg.close()
        pg = self._page("() => window.__panel.previzAddImagePlane({ filename: 'x.png', type: 'input', subfolder: '', name: 'x' })")
        try:
            before, after = self._drag(pg, "Opacity", -40)
            self.assertAlmostEqual(after, before - 0.4)
            self.assertEqual(self._undo_labels(pg)[-1], "image plane")
        finally:
            pg.close()


if __name__ == "__main__":
    unittest.main()
