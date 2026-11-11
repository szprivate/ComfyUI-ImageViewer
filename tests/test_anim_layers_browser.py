"""Animation layers in the 3D space, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js from vendor/three:
the Anim Layers panel adds a layer, a move of the box keys THAT layer (the base keeps its keys), the
weight / mute / solo change what the 3D view draws, the base row takes the keys back, and undo
restores. ANIM_LAYERS_SHOTS=<folder> writes a screenshot of the panel.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_anim_layers_browser
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


DRIVE = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  const it = P.previzSelectedItem();
  P.setFrame(0); P.previzKeyAll('position');
  P.setFrame(20); it.position = [4, 0, 0]; P.previzKeyAll('position');
  P.setPanelDocked('animLayers', true);
  P.setPanelDocked('curves', true);
  const h = P.animLayersPanel;
  const out = { bar: !!h.querySelector('.al-bar'), rowsBefore: h.querySelectorAll('.al-row').length };
  h.querySelector('.al-add').click();
  const sc = P.previzScene();
  out.layers = sc.animLayers.length; out.activeIsNew = sc.activeLayer === sc.animLayers[0].id;
  out.activeRow = h.querySelector('.al-row.active .al-name').textContent;
  // A move at frame 10: the gizmo's way in (previzApplyTransform).
  P.setFrame(10);
  P.previzApplyTransform(it.id, { position: [2, 3, 0] }, ['position']);
  const root = () => P._modelView()._entries.get(it.id).root.position;
  out.base = it.tracks.position.map((k) => [k.f, k.v[1]]);
  out.layerKeys = it.layerTracks[sc.activeLayer].position.map((k) => [k.f, k.v]);
  out.y = root().y; out.x = root().x;
  P.setPanelDocked('channels', true); P._previzRenderChannels();
  out.cbY = Number(P._cbUI && P._cbUI.rows.get('position.1')?.input?.value);
  // The weight to a half, through the row's slider.
  const slider = h.querySelector('.al-row.active .al-weight');
  slider.value = '0.5'; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change'));
  out.yHalf = root().y;
  h.querySelector('.al-row.active .al-mute').click();
  out.yMuted = root().y;
  h.querySelector('.al-row.active .al-mute').click();
  out.yBack = root().y;
  // The curve editor shows the layer's own curve.
  P.previzRefreshCurves();
  out.curveDots = P.curvesPanel.querySelectorAll('.kf-dot').length;
  // An override layer on top, soloed.
  h.querySelector('.al-addover').click();
  P.setFrame(10);
  P.previzApplyTransform(it.id, { position: [2, 0, 5] }, ['position']);
  out.zOver = root().z;
  out.names = [...h.querySelectorAll('.al-row .al-name')].map((n) => n.textContent);
  // The base row: keys go back to the item's own tracks.
  h.querySelector('.al-base').click();
  out.activeAfterBase = P.previzScene().activeLayer || null;
  P.setFrame(20); P.previzKeyAll('position');
  out.baseKeys = it.tracks.position.length;
  out.panelHtml = h.querySelectorAll('.al-row').length;
  return out;
}"""

UNDO = """async () => {
  const P = window.__panel;
  const n = () => (P.previzScene().animLayers || []).length;
  const before = n();
  P.previzUndo(); P.previzUndo(); P.previzUndo();
  const after = n();
  return { before, after };
}"""

AI_LAYER = """async () => {
  const P = window.__panel;
  // previzRigApplyMotion's layer path, without a rig: the wrapper keys go where they should.
  const sc = P.previzScene();
  const it = sc.items.find((i) => i.kind === 'primitive');
  const id = P.previzLayerBakeTarget(it.id, null, { name: 'AI motion' });
  const keys = P.previzWithLayer(id, () => { const S = window.__S; return 0; });
  P.previzWithLayer(id, () => { P.setFrame(5); P.previzKeyAll('position'); });
  return { id, active: sc.activeLayer, has: !!(it.layerTracks && it.layerTracks[id]), name: sc.animLayers.find((l) => l.id === id).name };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class AnimLayersBrowserTests(unittest.TestCase):
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

    def test_layers_from_the_panel_change_what_the_view_draws(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate(DRIVE)
            shots = os.environ.get("ANIM_LAYERS_SHOTS")
            if shots:
                os.makedirs(shots, exist_ok=True)
                pg.evaluate("() => { const P = window.__panel; P.setFrame(10); P.previzLayerSetActive(P.previzScene().animLayers[0].id); P.setPanelDocked('params', false); P.setPanelDocked('previz', false); }")
                pg.wait_for_timeout(300)
                pg.screenshot(path=os.path.join(shots, "anim-layers.png"))
                box = pg.evaluate("() => { const r = window.__panel.animLayersPanel.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }")
                pg.screenshot(path=os.path.join(shots, "anim-layers-panel.png"),
                              clip={"x": box[0], "y": box[1], "width": box[2], "height": box[3]})
            undo = pg.evaluate(UNDO)
            ai = pg.evaluate(AI_LAYER)
        finally:
            pg.close()
        self.assertTrue(st["bar"])
        self.assertEqual(st["rowsBefore"], 1, "only the base row")
        self.assertEqual(st["layers"], 1)
        self.assertTrue(st["activeIsNew"])
        self.assertEqual(st["activeRow"], "AnimLayer1")
        y0 = st["base"][0][1]                      # a new box stands on the floor
        self.assertEqual(st["base"], [[0, y0], [20, y0]], "the base keeps its keys")
        self.assertEqual(len(st["layerKeys"]), 1)
        self.assertEqual(st["layerKeys"][0][0], 10)
        for got, want in zip(st["layerKeys"][0][1], [2, 3 - y0, 0]):   # the base stands at x = 0
            self.assertAlmostEqual(got, want, places=5)   # the offset that puts the box at (2, 3)
        self.assertAlmostEqual(st["x"], 2, places=5)
        self.assertAlmostEqual(st["y"], 3, places=5)
        self.assertAlmostEqual(st["cbY"], 3, places=3, msg="the Channel Box shows the whole stack")
        self.assertAlmostEqual(st["yHalf"], y0 + (3 - y0) / 2, places=5)
        self.assertAlmostEqual(st["yMuted"], y0, places=5)
        self.assertAlmostEqual(st["yBack"], y0 + (3 - y0) / 2, places=5)
        self.assertEqual(st["curveDots"], 3, "the layer's one key on three channels")
        self.assertAlmostEqual(st["zOver"], 5, places=5)
        self.assertEqual(st["names"], ["Override", "AnimLayer1", "BaseAnimation"])
        self.assertIsNone(st["activeAfterBase"])
        self.assertEqual(st["baseKeys"], 2, "keyed on the base again (frame 20 replaced)")
        self.assertLess(undo["after"], undo["before"])
        self.assertTrue(ai["has"])
        self.assertTrue(ai["name"].startswith("AI motion"))
        self.assertNotEqual(ai["active"], ai["id"], "the wrapper puts the active layer back")
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
