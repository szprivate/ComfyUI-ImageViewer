"""The 3D space's menu bar, tool column, multi-view panes and orientation axes, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three: the bar's menus opened with the mouse (one open, the next follows the pointer), the
Outliner holding the tree only, the tool column, the quad layout (four panes, each its own view,
a press making a pane active, a view moving between panes), a flat view's orthographic camera, and the
axes: a click looks along that axis.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_view3d_menubar_browser
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
SHOTS = None

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
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
class MenuBarPaneTests(unittest.TestCase):
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

    def _root(self, pg):
        return "window.__panel._modelView().root"

    def test_the_menu_bar_and_the_tool_column(self):
        pg = self._page()
        try:
            labels = pg.evaluate("() => [...window.__panel._modelView().root.querySelectorAll('.model-mb-menus > button')].map((b) => b.textContent)")
            right = pg.evaluate("() => window.__panel._modelView().root.querySelectorAll('.model-mb-right select, .model-mb-right button').length")
            tools = pg.evaluate("() => [...window.__panel._modelView().root.querySelectorAll('.model-toolcol [data-tool]')].map((b) => b.dataset.tool)")
            outliner_bar = pg.evaluate("() => !!window.__panel.previzPanel && !!window.__panel.previzPanel.querySelector('.previz-actions, .previz-bar')")
            # A real click opens File; moving onto Edit opens Edit in its place.
            bar = "window.__panel._modelView().root.querySelector('.model-mb-menus')"
            file_btn = pg.evaluate_handle(f"() => {bar}.querySelector('[data-menu=file]')").as_element()
            edit_btn = pg.evaluate_handle(f"() => {bar}.querySelector('[data-menu=edit]')").as_element()
            file_btn.click()
            pg.wait_for_timeout(100)
            file_items = pg.locator("button.previz-menu-item").all_inner_texts()
            edit_btn.hover()
            pg.wait_for_timeout(100)
            edit_items = pg.locator("button.previz-menu-item").all_inner_texts()
            open_now = pg.evaluate(f"() => [...{bar}.querySelectorAll('button.open')].map((b) => b.dataset.menu)")
            pg.keyboard.press("Escape")
            pg.mouse.click(800, 600)
            pg.wait_for_timeout(150)
            closed = pg.evaluate(f"() => {bar}.querySelectorAll('button.open').length")
            # The Rotate tool from the column.
            pg.evaluate_handle("() => window.__panel._modelView().root.querySelector('.model-toolcol [data-tool=rotate]')").as_element().click()
            mode = pg.evaluate("() => window.__panel._modelView().gizmoMode")
        finally:
            pg.close()
        self.assertEqual(labels, ["File", "Edit", "Create", "Rig", "Animate", "Constrain", "World", "View", "Windows"])
        self.assertGreaterEqual(right, 3)
        self.assertEqual(tools[:4], ["select", "translate", "rotate", "scale"])
        self.assertFalse(outliner_bar)
        self.assertIn("Save scene…", file_items)
        self.assertIn("Undo", edit_items)
        self.assertNotIn("Save scene…", edit_items)
        self.assertEqual(open_now, ["edit"])
        self.assertEqual(closed, 0)
        self.assertEqual(mode, "rotate")
        self.assertEqual(self.errors, [])

    def test_quad_views_and_the_axes(self):
        pg = self._page()
        try:
            pg.evaluate("() => window.__panel._modelView().setPaneLayout('quad')")
            pg.wait_for_timeout(200)
            boxes = pg.evaluate("() => [...window.__panel._modelView().root.querySelectorAll('.model-pane')].map((p) => { const r = p.getBoundingClientRect(); return [p.dataset.slot, r.x, r.y, r.width, r.height]; })")
            labels = pg.evaluate("() => [...window.__panel._modelView().root.querySelectorAll('.model-pane-label')].map((b) => b.textContent)")
            # A press in the top left pane (top) makes it active: its camera is orthographic.
            tl = min(boxes, key=lambda b: (b[2], b[1]))
            pg.mouse.move(tl[1] + tl[3] / 2, tl[2] + tl[4] / 2)
            pg.mouse.down(); pg.mouse.up()
            top = pg.evaluate("() => { const v = window.__panel._modelView(); return { kind: v.paneActiveKind(), ortho: !!v.activeCameraObject().isOrthographicCamera, w: v.canvas.clientWidth }; }")
            # The pane's menu: Front there - the pane that had Front takes Top.
            pg.evaluate("() => { const v = window.__panel._modelView(); v.setPaneView(v._paneState().active, 'front'); }")
            views = pg.evaluate("() => window.__panel._modelView()._paneState().views")
            # The perspective pane's axes: +Y looks down.
            pv = pg.evaluate("() => window.__panel._modelView()._paneState().views.indexOf('persp')")
            ball = pg.evaluate_handle(f"() => window.__panel._modelView()._paneEls[{pv}].axes.svg.querySelector('[data-axis=y] circle')").as_element()
            pg.wait_for_timeout(100)
            ball.click()
            pg.wait_for_timeout(100)
            down = pg.evaluate("""() => { const v = window.__panel._modelView(); const c = v.activeCameraObject();
              const d = c.position.clone().sub(v.controls.target).normalize(); return { kind: v.paneActiveKind(), d: [d.x, d.y, d.z] }; }""")
            pg.evaluate("() => window.__panel._modelView().togglePaneMaximised()")
            single = pg.evaluate("() => window.__panel._modelView()._paneState().layout")
        finally:
            pg.close()
        self.assertEqual(len(boxes), 4)
        self.assertEqual(len(labels), 4)
        self.assertEqual(top["kind"], "top")
        self.assertTrue(top["ortho"])
        self.assertLess(top["w"], 900)          # the canvas answers the pane's size
        self.assertEqual(sorted(views), sorted(["top", "persp", "front", "right"]))
        self.assertEqual(views.count("front"), 1)
        self.assertEqual(down["kind"], "persp")
        self.assertAlmostEqual(down["d"][1], 1.0, places=3)
        self.assertEqual(single, "single")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
