"""A camera's look-at target and the world origin on the grid, in a real browser (Sebastian 2026-11-12).

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js from vendor/three:
  - the grid marks the world origin (on by default, "Show origin" in the grid options);
  - a camera's Look At is off by default; switched on in the Channel Box the camera faces its target,
    the target's channels appear, and its gizmo is dragged with the real mouse;
  - a camera without a target keeps its direction and roll when the view is panned through it.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_camera_aim_browser
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
# A folder to write screenshots into (VIEW3D_SHOTS).
SHOTS = os.environ.get("VIEW3D_SHOTS") or None

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
class CameraAimOriginTests(unittest.TestCase):
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
            pg.screenshot(path=os.path.join(SHOTS, name))

    def test_the_grid_marks_the_world_origin(self):
        pg = self._page()
        try:
            V = "window.__panel._modelView()"
            pg.evaluate("() => localStorage.removeItem('imageviewer.viewer.grid3d')")
            first = pg.evaluate(f"""() => {{ const v = {V}; const o = v.gridOrigin;
                return {{ there: !!o, inScene: !!o && o.parent === v.scene, visible: !!o && o.visible,
                          names: o ? o.children.map((c) => c.name) : [] }}; }}""")
            pg.evaluate(f"() => {{ const v = {V}; v.camera.position.set(9, 6, 9); v.camera.lookAt(0, 0, 0); v.controls.target.set(0, 0, 0); v.controls.update(); v.requestRender(); }}")
            pg.wait_for_timeout(200)
            self._shot(pg, "origin-on.png")
            # The options box has the switch; off hides it, and it is kept.
            pg.evaluate_handle(f"() => {V}.root.querySelector('.model-grid-more')").as_element().click()
            pg.wait_for_timeout(100)
            box = pg.evaluate_handle(f"() => {V}.root.querySelector('.model-grid-menu input[data-grid=origin]')").as_element()
            was_checked = box.is_checked()
            box.click()
            pg.wait_for_timeout(100)
            off = pg.evaluate(f"() => ({{ visible: {V}.gridOrigin.visible, kept: JSON.parse(localStorage.getItem('imageviewer.viewer.grid3d')).origin }})")
            box.click()
            pg.keyboard.press("Escape")
            # Hiding the grid hides the origin with it; a render without the grid leaves it out.
            pg.evaluate(f"() => {V}.setGrid(false)")
            with_grid_off = pg.evaluate(f"() => {V}.gridOrigin.visible")
            pg.evaluate(f"() => {V}.setGrid(true)")
            back = pg.evaluate(f"() => {V}.gridOrigin.visible")
            # A new layout (other size) rebuilds it, still one of it.
            pg.evaluate(f"() => {V}.setGridOptions({{ size: 40 }})")
            count = pg.evaluate(f"() => {V}.scene.children.filter((c) => c.name === 'gridorigin').length")
            pg.evaluate(f"() => {V}.resetGridOptions()")
        finally:
            pg.close()
        self.assertTrue(first["there"] and first["inScene"] and first["visible"])
        self.assertEqual(first["names"], ["gridorigin-axes", "gridorigin-dot"])
        self.assertTrue(was_checked)
        self.assertEqual(off, {"visible": False, "kept": False})
        self.assertFalse(with_grid_off)
        self.assertTrue(back)
        self.assertEqual(count, 1)
        self.assertEqual(self.errors, [])

    def _add_camera(self, pg):
        """A camera at (6, 3, 6) looking down -Z, selected; the free view backed off to see it all."""
        return pg.evaluate("""async () => {
          const P = window.__panel; const v = P._modelView();
          v.camera.position.set(14, 9, 14); v.camera.lookAt(0, 0, 0); v.controls.target.set(0, 0, 0); v.controls.update();
          const cam = P.previzAddCamera();
          cam.position = [6, 3, 6]; cam.rotation = [0, 0, 0];
          await P.previzChanged({ reload: true });
          await new Promise((r) => setTimeout(r, 300));
          P.previzSelect(cam.id);
          await new Promise((r) => setTimeout(r, 200));
          return cam.id;
        }""")

    FACING = """(id) => { const v = window.__panel._modelView(); const e = v._entries.get(id); const T = v.libs.THREE;
        const pos = e.root.getWorldPosition(new T.Vector3());
        const fwd = new T.Vector3(0, 0, -1).applyQuaternion(e.root.quaternion);
        const t = e.aimTarget;
        return { fwd: fwd.toArray(), dot: t ? fwd.dot(t.clone().sub(pos).normalize()) : null,
                 roll: v._aimRollOf(e.root.quaternion) * 180 / Math.PI }; }"""

    def test_look_at_is_off_by_default_and_switched_on_in_the_channel_box(self):
        pg = self._page()
        try:
            cid = self._add_camera(pg)
            cb = "window.__panel.channelsPanel"
            default = pg.evaluate(f"() => ({{ sel: {cb}.querySelector('.cb-row[data-ch=aim] select').value, "
                                  f"rows: !!{cb}.querySelector('.cb-row[data-ch=\"aim:x\"]'), "
                                  f"aim: window.__panel.previzSelectedItem().aim || null, "
                                  f"gizmo: !!(window.__panel._modelView()._aimGizmo && window.__panel._modelView()._aimGizmo.object) }})")
            facing_off = pg.evaluate(self.FACING, cid)
            sel = pg.evaluate_handle(f"() => {cb}.querySelector('.cb-row[data-ch=aim] select')").as_element()
            sel.scroll_into_view_if_needed()
            sel.select_option("on")
            pg.wait_for_timeout(250)
            on = pg.evaluate(f"""() => ({{ aim: window.__panel.previzSelectedItem().aim,
                labels: [...{cb}.querySelectorAll('.cb-row')].map((r) => r.dataset.ch).filter((c) => c && c.startsWith('aim')),
                gizmo: !!(window.__panel._modelView()._aimGizmo && window.__panel._modelView()._aimGizmo.object),
                viz: !!window.__panel._modelView()._entries.get(window.__panel.previzSelectedItem().id).aimViz.visible }})""")
            facing_on = pg.evaluate(self.FACING, cid)
            # Typed into the Channel Box: the camera turns to the new target.
            tx = pg.evaluate_handle(f"() => {cb}.querySelector('.cb-row[data-ch=\"aim:x\"] input')").as_element()
            tx.scroll_into_view_if_needed()
            tx.fill("0")
            tx.press("Enter")
            pg.evaluate(f"() => {{ const i = {cb}.querySelector('.cb-row[data-ch=\"aim:z\"] input'); i.value = '0'; i.dispatchEvent(new Event('change')); }}")
            pg.evaluate(f"() => {{ const i = {cb}.querySelector('.cb-row[data-ch=\"aim:y\"] input'); i.value = '0.5'; i.dispatchEvent(new Event('change')); }}")
            pg.wait_for_timeout(200)
            typed = pg.evaluate("() => window.__panel.previzSelectedItem().aim.target")
            facing_typed = pg.evaluate(self.FACING, cid)
            # Roll turns it about the line to its target, still facing it.
            roll_in = pg.evaluate_handle(f"() => {cb}.querySelector('.cb-row[data-ch=\"aim:roll\"] input')").as_element()
            roll_in.scroll_into_view_if_needed()
            roll_in.fill("30")
            roll_in.press("Enter")
            pg.wait_for_timeout(200)
            rolled = pg.evaluate(self.FACING, cid)
            roll_in.fill("0")
            roll_in.press("Enter")
            pg.wait_for_timeout(150)
            self._shot(pg, "camera-look-at.png")

            # The target's gizmo, dragged with the mouse by its centre (moves in the view's plane).
            at = pg.evaluate("""() => { const v = window.__panel._modelView(); const T = v.libs.THREE;
                const p = v._aimHandle.position.clone().project(v.activeCameraObject());
                const r = v.canvas.getBoundingClientRect();
                return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; }""")
            pg.mouse.move(at["x"], at["y"])
            pg.wait_for_timeout(50)
            pg.mouse.move(at["x"] + 1, at["y"] + 1)
            pg.wait_for_timeout(50)
            hot = pg.evaluate("() => window.__panel._modelView()._aimGizmo.axis")
            pg.mouse.down()
            for k in range(1, 11):
                pg.mouse.move(at["x"] + 1 + 8 * k, at["y"] + 1)
                pg.wait_for_timeout(16)
            pg.mouse.up()
            pg.wait_for_timeout(200)
            dragged = pg.evaluate("() => ({ target: window.__panel.previzSelectedItem().aim.target, selected: window.__panel.previzSelectedItem() && window.__panel.previzSelectedItem().kind })")
            facing_dragged = pg.evaluate(self.FACING, cid)
            undo_ok = pg.evaluate("async () => { window.__panel.previzUndo(); await new Promise((r) => setTimeout(r, 150)); return window.__panel.previzSelectedItem().aim.target; }")

            # Off: the camera keeps the way it faced, written into its rotation.
            before_off = pg.evaluate(self.FACING, cid)
            sel = pg.evaluate_handle(f"() => {cb}.querySelector('.cb-row[data-ch=aim] select')").as_element()
            sel.select_option("off")
            pg.wait_for_timeout(250)
            after_off = pg.evaluate(self.FACING, cid)
            off = pg.evaluate(f"() => ({{ aim: window.__panel.previzSelectedItem().aim, rows: !!{cb}.querySelector('.cb-row[data-ch=\"aim:x\"]'), "
                              "gizmo: !!window.__panel._modelView()._aimGizmo.object })")
            # Saved and read back: the switch and the target stay.
            kept = pg.evaluate("""async () => { const S = await import('/extensions/viewer/imageViewer_scene3d.js');
                const s = S.parseScene(JSON.parse(JSON.stringify(window.__panel.previzScene())));
                return s.items.find((i) => i.kind === 'camera').aim; }""")
        finally:
            pg.close()
        self.assertEqual(default["sel"], "off")
        self.assertFalse(default["rows"])
        self.assertIsNone(default["aim"])
        self.assertFalse(default["gizmo"])
        self.assertAlmostEqual(facing_off["fwd"][2], -1, places=5)     # no target: it looks where it was turned
        self.assertTrue(on["aim"]["on"])
        self.assertEqual(on["labels"], ["aim", "aim:x", "aim:y", "aim:z", "aim:roll"])
        self.assertTrue(on["gizmo"] and on["viz"])
        self.assertAlmostEqual(facing_on["dot"], 1, places=5)
        # Switched on, the target lands where it already looked: nothing jumps.
        self.assertAlmostEqual(facing_on["fwd"][2], -1, places=5)
        self.assertEqual(typed, [0, 0.5, 0])
        self.assertAlmostEqual(facing_typed["dot"], 1, places=5)
        self.assertAlmostEqual(rolled["roll"], 30, places=3)
        self.assertAlmostEqual(rolled["dot"], 1, places=5)
        self.assertIsNotNone(hot)
        self.assertNotEqual(dragged["target"], [0, 0.5, 0])
        self.assertEqual(dragged["selected"], "camera")
        self.assertAlmostEqual(facing_dragged["dot"], 1, places=4)
        self.assertEqual(undo_ok, [0, 0.5, 0])
        for a, b in zip(before_off["fwd"], after_off["fwd"]):
            self.assertAlmostEqual(a, b, places=4)
        self.assertFalse(off["aim"]["on"])
        self.assertFalse(off["rows"])
        self.assertFalse(off["gizmo"])
        self.assertEqual(kept, {"on": False, "target": [0, 0.5, 0]})
        self.assertEqual(self.errors, [])

    def test_a_camera_keeps_its_roll_when_the_view_is_panned_through_it(self):
        pg = self._page()
        try:
            cid = self._add_camera(pg)
            # Turned a little and rolled, then looked through.
            pg.evaluate("""async (id) => { const P = window.__panel; const it = P.previzSelectedItem();
                it.rotation = [-10, 20, 30]; await P.previzChanged({ reload: true });
                P.previzLookThrough(id); await new Promise((r) => setTimeout(r, 300)); }""", cid)
            before = pg.evaluate(self.FACING, cid)
            # A middle-button drag pans through the camera (the orbit controls).
            box = pg.evaluate("() => { const r = window.__panel._modelView().canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }")
            pg.mouse.move(box["x"], box["y"])
            pg.mouse.down(button="middle")
            for k in range(1, 8):
                pg.mouse.move(box["x"] + 10 * k, box["y"] + 4 * k)
                pg.wait_for_timeout(16)
            pg.mouse.up(button="middle")
            # And the wheel dollies.
            pg.mouse.wheel(0, 200)
            pg.wait_for_timeout(300)
            after = pg.evaluate(self.FACING, cid)
            item = pg.evaluate("() => window.__panel.previzSelectedItem()")
        finally:
            pg.close()
        for a, b in zip(before["fwd"], after["fwd"]):
            self.assertAlmostEqual(a, b, places=4)
        self.assertAlmostEqual(before["roll"], after["roll"], places=3)
        self.assertNotEqual(item["position"], [6, 3, 6])          # it did move
        self.assertAlmostEqual(item["rotation"][2], 30, places=3)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
