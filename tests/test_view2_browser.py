"""The second view (imageViewer_view2.js): another open tab shown in a panel beside the picture.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js from vendor/three:
a 3D scene shown in the panel by a second 3D view of its own (the same items, its own camera, a scene
camera to look through while the main view does not), following the frame; a picture tab shown as its
picture; the panel put beside the picture like any panel; nothing of the main view changed by it.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_view2_browser
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
SHOTS = os.environ.get("VIEW2_SHOTS") or None

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  P.previzAddCamera();
  P._modelView().setPaneLayout('single');
  return P.activeTab;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class SecondViewTests(unittest.TestCase):
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
        # A context of its own: localStorage (the layout, the second view's choice) does not carry over.
        ctx = self.browser.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=2 if SHOTS else 1)
        pg = ctx.new_page()
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        self.tab = pg.evaluate(SETUP)
        pg.wait_for_timeout(200)
        return pg

    def _shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, name))

    def test_a_3d_scene_in_the_second_view_with_a_camera_of_its_own(self):
        pg = self._page()
        try:
            pg.evaluate("() => { const P = window.__panel; P.setPanelDocked('view2', true);"
                        " P.dockPanelBeside('view2', { kind: 'view' }, 'left'); }")
            pg.wait_for_function("() => { const v = window.__panel._v2 && window.__panel._v2.view;"
                                 " return !!(v && v.visible && v._entries && v._entries.size >= 2); }", timeout=20000)
            pg.wait_for_timeout(300)
            info = pg.evaluate("""() => { const P = window.__panel, s = P._v2, v = s.view, m = P._modelView();
                const box = P.view2Panel.getBoundingClientRect(), pic = P.dockViewEl.getBoundingClientRect();
                const c = v.root.querySelector('canvas').getBoundingClientRect();
                return { tab: P.view2Tab(), kind: s.ui.root.dataset.kind, ids: [...v._entries.keys()].sort(),
                         main: [...m._entries.keys()].sort(), left: box.right <= pic.left + 1,
                         canvas: [c.width, c.height], inPanel: P.view2Panel.contains(v.root),
                         sameObject: v.scene3d === m.scene3d, differentCanvas: v.renderer.domElement !== m.renderer.domElement }; }""")
            self._shot(pg, "view2_3d.png")
            # Look through the scene's camera in the second view only.
            cam = pg.evaluate("""() => { const P = window.__panel; const c = P.previzScene().items.find((i) => i.kind === 'camera' && !i.view);
                P.view2SetCamera(c.id); const v = P._v2.view, m = P._modelView();
                const def = P.previzScene().items.find((i) => i.view === 'persp');
                return { id: c.id, through: v.activeCameraObject() === v._entries.get(c.id).camera,
                         mainDef: m.activeCameraObject() === m._entries.get(def.id).camera, sel: P._v2.ui.camSel.value,
                         activeCamera: P.previzScene().activeCamera || null }; }""")
            # The frame follows the viewer's.
            pg.evaluate("() => window.__panel.setFrame(5)")
            pg.wait_for_timeout(300)
            frame = pg.evaluate("() => window.__panel._v2.view.sceneFrame")
            # A new item shows up in the second view as well.
            pg.evaluate("() => window.__panel.previzAddPrimitive('sphere')")
            pg.wait_for_function("() => window.__panel._v2.view._entries.size >= 3", timeout=20000)
            # Put away: its view stops drawing.
            pg.evaluate("() => window.__panel.setPanelDocked('view2', false)")
            pg.wait_for_timeout(200)
            away = pg.evaluate("() => ({ visible: window.__panel._v2.view.visible, raf: window.__panel._v2.raf })")
        finally:
            pg.close()
        self.assertEqual(info["tab"], self.tab)
        self.assertEqual(info["kind"], "3d")
        self.assertEqual(info["ids"], info["main"])
        self.assertTrue(info["left"])
        self.assertTrue(info["inPanel"])
        self.assertTrue(info["sameObject"])
        self.assertTrue(info["differentCanvas"])
        self.assertGreater(info["canvas"][0], 100)
        self.assertGreater(info["canvas"][1], 100)
        self.assertTrue(cam["through"])
        # The main view draws through the scene's hidden default camera, not a free one.
        self.assertTrue(cam["mainDef"])
        self.assertEqual(cam["sel"], cam["id"])
        self.assertIsNone(cam["activeCamera"])
        self.assertEqual(frame, 5)
        self.assertFalse(away["visible"])
        self.assertEqual(away["raf"], 0)
        self.assertEqual(self.errors, [])

    def test_a_picture_tab_in_the_second_view(self):
        pg = self._page()
        try:
            pg.evaluate("""() => { const P = window.__panel;
                P.allTabs.pic = [{ path: 'D:/a.png', name: 'a.png', external: true }]; P.tabLabels.pic = 'pic';
                P.tabOrder = [...(P.tabOrder || []), 'pic'];
                P.setPanelDocked('view2', true); P.view2Show('pic'); }""")
            pg.wait_for_timeout(300)
            info = pg.evaluate("""() => { const P = window.__panel, ui = P._v2.ui;
                return { kind: ui.root.dataset.kind, src: ui.img.getAttribute('src') || '', shown: ui.pic.style.display,
                         options: [...ui.tabSel.options].map((o) => o.value), cam: ui.camSel.style.display,
                         stored: JSON.parse(localStorage.getItem('imageviewer.viewer.view2')).tab,
                         view3d: !!(P._v2.view && P._v2.view.visible) }; }""")
        finally:
            pg.close()
        self.assertEqual(info["kind"], "picture")
        self.assertIn("a.png", info["src"])
        self.assertEqual(info["shown"], "")
        self.assertIn("pic", info["options"])
        self.assertIn(self.tab, info["options"])
        self.assertEqual(info["cam"], "none")
        self.assertEqual(info["stored"], "pic")
        self.assertFalse(info["view3d"])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
