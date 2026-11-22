"""Several perspective views, a camera dragged onto a pane, shading per pane and locators, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three (Sebastian 2026-11-17): a quad of four perspective views each with a camera of its own,
a camera dragged from the Outliner onto a pane (that pane looks through it, and navigating there moves
the scene's camera), each pane drawn in its own shading, and Create > Locator (a cross that is picked,
parented to, keyed, sized in the Channel Box and saved with the scene).

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_view3d_multiview_browser
Screenshots: MULTIVIEW_SHOTS=<folder>.
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
SHOTS = os.environ.get("MULTIVIEW_SHOTS") or None
V = "window.__panel._modelView()"

SETUP = """async () => {
  localStorage.removeItem('imageviewer.viewer.view3dPanes');
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  await P.previzAddPrimitive('sphere');
  const s = P.previzScene(); const sp = s.items.find((i) => i.primitive && i.primitive.type === 'sphere');
  sp.position = [2.5, 0, 0]; P.previzChanged();
  const v = P._modelView();
  v.setPaneLayout('single');
  return true;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class MultiViewTests(unittest.TestCase):
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

    def _shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.wait_for_timeout(150)
            pg.evaluate_handle(f"() => {V}.root").as_element().screenshot(path=os.path.join(SHOTS, name))

    def _boxes(self, pg):
        return pg.evaluate(f"""() => Object.fromEntries([...{V}.root.querySelectorAll('.model-pane')].map((p) => {{
            const r = p.getBoundingClientRect(); return [p.dataset.slot, [r.x, r.y, r.width, r.height]]; }}))""")

    def test_every_pane_can_be_a_perspective_view_of_its_own(self):
        pg = self._page()
        try:
            pg.evaluate(f"""() => {{ const v = {V}; v.setPaneLayout('quad');
                ['persp2', 'persp', 'persp3', 'persp4'].forEach((k, i) => v.setPaneView(i, k)); }}""")
            pg.wait_for_timeout(200)
            st = pg.evaluate(f"""() => {{ const v = {V}; const s = v._paneState();
                const cams = s.views.map((k) => v._paneCamera(k));
                return {{ views: s.views, persp: cams.map((c) => !!c.isPerspectiveCamera),
                         distinct: new Set(cams).size, labels: [...v.root.querySelectorAll('.model-pane-label')].map((b) => b.textContent),
                         pos: cams.map((c) => c.position.toArray().map((x) => +x.toFixed(3))),
                         hidden: v.scene3d.items.filter((i) => i.view).map((i) => i.visible === false),
                         items: Object.fromEntries(v.scene3d.items.filter((i) => i.view)
                             .map((i) => [i.view, i.position.map((x) => +x.toFixed(3))])) }}; }}""")
            # Navigating one pane (it is active: a press there) leaves the others where they are.
            boxes = self._boxes(pg)
            x, y, w, h = boxes["0"]
            pg.mouse.move(x + w / 2, y + h / 2)
            pg.mouse.down(); pg.mouse.up()
            pg.evaluate(f"() => {{ const v = {V}; v.lookAlongAxis('y'); v._paneSave(); }}")
            pg.wait_for_timeout(250)
            moved = pg.evaluate(f"""() => {{ const v = {V}; const s = v._paneState();
                return {{ active: v.paneActiveKind(), rotate: v.controls.enableRotate,
                  pos: s.views.map((k) => v._paneCamera(k).position.toArray().map((x) => +x.toFixed(3))),
                  items: Object.fromEntries(v.scene3d.items.filter((i) => i.view)
                      .map((i) => [i.view, i.position.map((x) => +x.toFixed(3))])),
                  kept: JSON.parse(localStorage.getItem('imageviewer.viewer.view3dPanes')).cams }}; }}""")
            self._shot(pg, "four-perspective-views.png")
            # The pane menu is the camera selector: views, the scene's cameras,
            # "New camera…", then the flat views.
            pg.evaluate(f"() => {V}._paneMenu(1, {V}._paneEls[1].label)")
            pg.wait_for_timeout(100)
            items = pg.locator("button.previz-menu-item").all_inner_texts()
            pg.keyboard.press("Escape")
        finally:
            pg.close()
        self.assertEqual(st["views"], ["persp2", "persp", "persp3", "persp4"])
        self.assertEqual(st["persp"], [True] * 4)
        self.assertEqual(st["distinct"], 4)
        # The main view's label names the scene camera it looks through; the extra
        # views keep cameras of their own and their old names.
        self.assertEqual(st["labels"], ["Persp 2 ▾", "Perspective ▾", "Persp 3 ▾", "Persp 4 ▾"])
        # The default camera is hidden: furniture, not content.
        self.assertEqual(st["hidden"], [True])
        self.assertEqual(moved["active"], "persp2")
        self.assertTrue(moved["rotate"])
        # Navigating pane 0 moved its own viewer camera, kept in the viewer's
        # state; the scene's default camera and the other panes stayed put.
        self.assertNotEqual(moved["pos"][0], st["pos"][0])
        self.assertEqual([round(v, 3) for v in moved["kept"]["persp2"]["position"]], moved["pos"][0])
        self.assertEqual(moved["pos"][1:], st["pos"][1:])
        self.assertEqual(moved["items"], st["items"])
        # The pane menu's top block is the camera selector: the scene's one
        # perspective camera (ticked: this pane looks through it), then
        # "New camera…", then the flat views. No view names, no Look-through sub.
        self.assertEqual([t.replace("✓ ", "") for t in items[:2]], ["Perspective", "New camera…"])
        self.assertTrue(items[0].startswith("✓ "))
        self.assertNotIn("Perspective 2", items)
        self.assertIn("Top", items)
        self.assertNotIn("Look through", items)
        self.assertIn("Shading", items)
        self.assertEqual(self.errors, [])

    def test_new_camera_from_the_pane_menu_is_looked_through(self):
        pg = self._page()
        try:
            pg.evaluate(f"() => {V}.setPaneLayout('quad')")
            pg.wait_for_timeout(200)
            pg.evaluate(f"() => {V}._paneMenu(1, {V}._paneEls[1].label)")
            pg.wait_for_timeout(100)
            pg.get_by_text("New camera…", exact=True).click()
            pg.wait_for_timeout(250)
            st = pg.evaluate(f"""() => {{ const v = {V}; const s = v.scene3d;
                const id = v.paneThroughId('persp');
                return {{ id: id, active: s.activeCamera,
                          cams: s.items.filter((i) => i.kind === 'camera').map((i) => [i.name, !!i.view, i.visible]) }}; }}""")
            labels = pg.evaluate(f"""() => [...{V}.root.querySelectorAll('.model-pane-label')].map((b) => b.textContent)""")
        finally:
            pg.close()
        # Made where the view looked, and the view looks through it at once.
        self.assertTrue(st["id"])
        self.assertEqual(st["active"], st["id"])
        self.assertEqual(st["cams"], [["Perspective", True, False], ["Camera", False, True]])
        self.assertEqual(labels[1], "Camera ▾")
        self.assertEqual(self.errors, [])

    def test_a_camera_dragged_onto_a_pane_is_looked_through_there(self):
        pg = self._page()
        try:
            cam = pg.evaluate("""() => { const P = window.__panel; const c = P.previzAddCamera();
                c.position = [0, 1.5, 9]; c.rotation = [0, 0, 0]; P.previzChanged(); P.previzLookThroughSet(null); return c.id; }""")
            pg.evaluate(f"() => {V}.setPaneLayout('quad')")
            pg.wait_for_timeout(300)
            views = pg.evaluate(f"() => {V}._paneState().views")
            boxes = self._boxes(pg)
            # The camera's row in the Outliner, dragged onto the top left pane (a flat view: Top).
            row = pg.locator(f".previz-item[data-item-id='{cam}']")
            row.wait_for(timeout=5000)
            x, y, w, h = boxes["0"]
            stage = pg.locator(".model-stage")
            sb = stage.bounding_box()
            row.drag_to(stage, target_position={"x": x - sb["x"] + w / 2, "y": y - sb["y"] + h / 2})
            pg.wait_for_timeout(300)
            st = pg.evaluate(f"""() => {{ const v = {V}; const s = v._paneState(); const k = s.views[0];
                return {{ kind: k, through: v.paneThroughId(k), label: v._paneEls[0].label.textContent,
                         sceneCam: v.scene3d.activeCamera, same: v._paneCamera(k) === v._entries.get('{cam}').camera,
                         marked: v.root.querySelectorAll('.model-pane.drop-camera').length }}; }}""")
            # Navigating in that pane moves the scene's camera.
            before = pg.evaluate(f"() => window.__panel.previzScene().items.find((i) => i.id === '{cam}').position.slice()")
            pg.evaluate(f"() => {{ const v = {V}; v._paneActivate(0); v.resetView(); }}")
            pg.wait_for_timeout(100)
            after = pg.evaluate(f"() => window.__panel.previzScene().items.find((i) => i.id === '{cam}').position.slice()")
            self._shot(pg, "camera-dropped-on-pane.png")
            # Its own camera again (what re-picking its view in the pane menu does).
            pg.evaluate(f"() => {V}.paneLookThrough(0, null)")
            free = pg.evaluate(f"() => {{ const v = {V}; return [v.paneThroughId(v._paneState().views[0]), v._paneEls[0].label.textContent]; }}")
        finally:
            pg.close()
        self.assertEqual(views[0], "top")
        self.assertEqual(st["kind"], "persp2")
        self.assertEqual(st["through"], cam)
        self.assertTrue(st["same"])
        self.assertTrue(st["label"].startswith("Camera"))
        self.assertIsNone(st["sceneCam"])         # the main view keeps its default camera
        self.assertEqual(st["marked"], 0)
        self.assertNotEqual(before, after)
        self.assertEqual(free, [None, "Persp 2 ▾"])
        self.assertEqual(self.errors, [])

    def test_each_pane_has_its_own_shading(self):
        pg = self._page()
        try:
            pg.evaluate(f"() => {V}.setPaneLayout('quad')")
            pg.wait_for_timeout(200)
            # The active pane takes the toolbar's shading; another pane is set from its menu.
            pg.evaluate(f"""() => {{ const v = {V}; v._paneActivate(1); v.setMaterialMode('clay');
                v.setPaneShading(0, 'wireframe'); v.setPaneShading(2, 'normal'); }}""")
            looks = pg.evaluate(f"""() => {{ const v = {V}; const box = [...v._originals.keys()][0]; const seen = [];
                const r = v.renderer, render = r.render.bind(r);
                r.render = (sc, cam) => {{ seen.push(box.material === v._originals.get(box) ? 'original'
                    : Object.entries(v.materials).find(([, m]) => m === box.material)[0]); return render(sc, cam); }};
                v._tick(); r.render = render;
                return {{ seen, after: box.material === v.materials.clay, shading: v._paneState().shading,
                         sel: v.ui.modeSel.value, tags: [...v.root.querySelectorAll('.model-pane-shade')].map((t) => t.textContent) }}; }}""")
            # Going to another pane brings its shading into the toolbar.
            pg.evaluate(f"() => {V}._paneActivate(0)")
            sel0 = pg.evaluate(f"() => {V}.ui.modeSel.value")
            # Path traced in a pane that is not active: that pane is the one traced.
            traced = pg.evaluate(f"() => {{ const v = {V}; v.setPaneShading(3, 'pathtraced'); return [v._paneTracedSlot(), v.ptActive()]; }}")
            pg.evaluate(f"() => {{ const v = {V}; v.setPaneShading(3, 'original'); }}")
            self._shot(pg, "shading-per-pane.png")
            kept = pg.evaluate("() => JSON.parse(localStorage.getItem('imageviewer.viewer.view3dPanes')).shading")
        finally:
            pg.close()
        self.assertEqual(looks["seen"], ["wireframe", "clay", "normal", "original"])
        self.assertTrue(looks["after"])
        self.assertEqual(looks["shading"], ["wireframe", "clay", "normal", "original"])
        self.assertEqual(looks["sel"], "clay")
        self.assertEqual(looks["tags"], ["Wireframe", "Clay", "Normal", "Original"])
        self.assertEqual(sel0, "wireframe")
        self.assertEqual(traced, [3, True])
        self.assertEqual(kept, ["wireframe", "clay", "normal", "original"])
        self.assertEqual(self.errors, [])

    def test_a_locator_is_created_picked_parented_keyed_and_saved(self):
        pg = self._page()
        try:
            pg.evaluate("() => window.__panel.previzMenuBarOpen('create')")
            pg.wait_for_timeout(100)
            pg.locator("button.previz-menu-item", has_text="Locator").first.click()
            pg.wait_for_timeout(300)
            st = pg.evaluate(f"""() => {{ const P = window.__panel, v = {V}; const s = P.previzScene();
                const loc = s.items.find((i) => i.locator); const e = v._entries.get(loc.id);
                const row = P.previzPanel.querySelector(`.previz-item[data-item-id="${{loc.id}}"]`);
                return {{ id: loc.id, name: loc.name, kind: loc.kind, size: loc.locator.size, sel: P._previzSelection === loc.id,
                         glyph: !!(e && e.locator && e.locator.isLineSegments), row: row && row.dataset.kind,
                         cb: !!P.paramsPanel.querySelector('.cb-row[data-ch=locatorSize]'),
                         layer: e.locator.layers.mask }}; }}""")
            # Size from the Channel Box.
            pg.evaluate("() => window.__panel.previzSetLocatorSize(3)")
            pg.wait_for_timeout(100)
            scaled = pg.evaluate(f"() => {V}._entries.get('{st['id']}').locator.scale.x")
            # A click on the cross selects it.
            pg.evaluate("() => window.__panel.previzSelect(null)")
            # A known vantage for the click: the view's camera is a scene camera
            # now, so it is the camera that gets put there.
            pg.evaluate(f"""async () => {{ const P = window.__panel, v = {V};
                const S = await import('/extensions/viewer/imageViewer_scene3d.js');
                const def = P.previzScene().items.find((i) => i.view === 'persp');
                P.previzApplyTransform(def.id, {{ position: [0, 2, 12],
                    rotation: S.lookRotation([0, 2, 12], [0, 0, 0]) }}, ['position', 'rotation']);
                v.requestRender(); }}""")
            pg.wait_for_timeout(200)
            pt = pg.evaluate(f"""() => {{ const v = {V}; const p = new v.libs.THREE.Vector3(0, 0.9, 0)
                .applyMatrix4(v._entries.get('{st['id']}').locator.matrixWorld).project(v.activeCameraObject());
                const r = v.canvas.getBoundingClientRect(); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; }}""")
            pg.mouse.click(pt[0], pt[1])
            pg.wait_for_timeout(200)
            picked = pg.evaluate("() => window.__panel._previzSelection")
            # The box goes under it; a key on it; saved and read back.
            saved = pg.evaluate(f"""() => {{ const P = window.__panel, s = P.previzScene();
                const box = s.items.find((i) => i.primitive && i.primitive.type === 'box');
                P.previzMoveItems([box.id], '{st['id']}', null);
                P.previzSelect('{st['id']}'); P.previzApplyTransform('{st['id']}', {{ position: [0, 1, 0] }}, ['position']);
                P.previzSetKeyAll && P.previzSetKeyAll();
                const json = JSON.stringify(s); const back = JSON.parse(json);
                const loc = back.items.find((i) => i.id === '{st['id']}');
                return {{ parent: back.items.find((i) => i.id === box.id).parent, size: loc.locator.size, pos: loc.position }}; }}""")
            self._shot(pg, "locator.png")
        finally:
            pg.close()
        self.assertEqual(st["kind"], "group")
        self.assertTrue(st["name"].startswith("Locator"))
        self.assertEqual(st["size"], 1)
        self.assertTrue(st["sel"])
        self.assertTrue(st["glyph"])
        self.assertEqual(st["row"], "locator")
        self.assertTrue(st["cb"])
        self.assertEqual(scaled, 3)
        self.assertEqual(picked, st["id"])
        self.assertEqual(saved["parent"], st["id"])
        self.assertEqual(saved["size"], 3)
        self.assertEqual(saved["pos"], [0, 1, 0])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
