"""The translate gizmo in the 3D space's split views, with the real mouse, in a real browser.

Sebastian 2026-11-12: in a split layout an axis of the translate gizmo was hard to hit, as if the
area the mouse has to find shrank with the view. Two causes: three's TransformControls sizes its
handles (and their invisible pick shapes) as a share of the view's height, so a pane half the
stage's height had them half as big; and after drawing every pane the handles were left as the
LAST pane drew them, so the hover in any other pane tested the ray against another camera's
handles. The panes now scale the gizmo by stage height / pane height and make its handles again
for the pane under the mouse (`_paneGizmoFit` in js/imageViewer_view3dPanes.js).

The test hovers with the real mouse along +X from the gizmo's centre, one view filling the stage
and then the Front and Top panes of the quad layout, and measures how far out the X
handle still answers: about the same in pixels everywhere.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_view3d_pane_gizmo_browser
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
  const box = await P.previzAddPrimitive('box');
  // The box centred on its pivot, as boxes came in before they stood on the grid (scene3d
  // groundOffset): the reach along +X below was measured with the gizmo at the view's centre.
  delete box.offset; box.position = [0, 0.5, 0];
  await P.previzChanged({ reload: true });
  P._modelView().resetView();
  const v = P._modelView();
  v.setPaneLayout('single');
  v.setGizmoMode ? v.setGizmoMode('translate') : (v.gizmoMode = 'translate');
  return true;
}"""

# Where the gizmo's centre is on screen in the pane showing `kind` (client pixels), or null.
CENTRE = """(kind) => {
  const v = window.__panel._modelView();
  const s = v._paneState();
  const slot = s.layout === 'single' ? 0 : s.views.indexOf(kind);
  const rect = s.layout === 'single' ? v.stage.getBoundingClientRect()
    : (() => { const st = v.stage.getBoundingClientRect(); const p = v._paneRects().find((q) => q.slot === slot);
               return { left: st.left + p.x, top: st.top + p.y, width: p.w, height: p.h }; })();
  const cam = s.layout === 'single' ? v.activeCameraObject() : v._paneCamera(kind);
  if (!v.gizmo || !v.gizmo.object) return null;
  const w = v.gizmo.object.getWorldPosition(new v.libs.THREE.Vector3()).project(cam);
  return { x: rect.left + (w.x + 1) / 2 * rect.width, y: rect.top + (1 - w.y) / 2 * rect.height, h: rect.height };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class PaneGizmoTests(unittest.TestCase):
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

    def _reach(self, pg, kind):
        """How many pixels right of the gizmo's centre the mouse still finds the X handle in `kind`'s view."""
        c = pg.evaluate(CENTRE, kind)
        self.assertIsNotNone(c)
        # Into the pane first, so it becomes the active one; then along +X.
        pg.mouse.move(c["x"] - 40, c["y"] + 40)
        pg.wait_for_timeout(60)
        reach = 0
        for d in range(4, 400, 4):
            pg.mouse.move(c["x"] + d, c["y"])
            pg.wait_for_timeout(15)
            axis = pg.evaluate("() => window.__panel._modelView().gizmo.axis")
            if axis == "X":
                reach = d
            elif reach and d > reach + 40:
                break
        return reach

    def test_the_x_handle_is_as_easy_to_hit_in_every_pane(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            pg.evaluate(SETUP)
            pg.wait_for_timeout(300)
            # One view filling the stage (the perspective view, looking at the box from the front-right).
            single = self._reach(pg, "persp")
            # The quad layout: Top, Persp, Front, Right. Front and Top both show +X going right.
            pg.evaluate("() => { const v = window.__panel._modelView(); v.setPaneLayout('quad'); }")
            pg.wait_for_timeout(300)
            views = pg.evaluate("() => window.__panel._modelView()._paneState().views")
            front = self._reach(pg, "front")
            top = self._reach(pg, "top")
            # Back to one view: the gizmo's own size again.
            pg.evaluate("() => window.__panel._modelView().setPaneLayout('single')")
            pg.wait_for_timeout(300)
            size = pg.evaluate("() => window.__panel._modelView().gizmo.size")
        finally:
            pg.close()
        print(f"\nX handle reach: single {single}px, quad front {front}px, quad top {top}px ({views})")
        self.assertGreater(single, 20)
        self.assertGreater(front, single * 0.75)
        self.assertGreater(top, single * 0.75)
        self.assertAlmostEqual(size, 1.0, places=6)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
