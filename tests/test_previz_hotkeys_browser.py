"""The 3D space's convenience keys and tools, in a real browser.

The REAL viewer js against stubbed ComfyUI (tests/harness/tabs.html), three.js from vendor/three, driven
with Playwright's real mouse and keyboard:
  - F over the view frames the selection (nothing selected: the view is reset); F over the Outliner opens
    the tree down to the selection;
  - the Channel Box sets a typed value on every selected channel;
  - the Display menu and Shift+1.. switch kinds off (not drawn, not clickable) and the joints of a skinned
    model are drawn;
  - the Select tool (Q) and the marquee, with Maya's modifiers;
  - S / Shift+S set keys, K held + drag scrubs the timeline.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_previz_hotkeys_browser
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import rig_fixture  # noqa: E402

# Two boxes apart on X, a group holding the second, a camera; the free view looking at all of it.
SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  P.setPanelDocked('previz', true);
  P.setPanelDocked('channels', true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  const a = P.previzSelectedItem(); a.name = 'A'; a.position = [-3, 0.5, 0];
  await P.previzAddPrimitive('box');
  const b = P.previzSelectedItem(); b.name = 'B'; b.position = [3, 0.5, 0];
  P.previzAddGroup();
  const g = P.previzSelectedItem(); g.name = 'G';
  P.previzReparent(b.id, g.id);
  await P.previzChanged({ reload: true });
  const view = P._modelView();
  await view.whenLoaded(20000);
  P.previzSelect(null);
  view.resetView();
  await new Promise((r) => setTimeout(r, 200));
  window.__ids = { a: a.id, b: b.id, g: g.id };
  return window.__ids;
}"""

# Screen centre of an item, in page pixels.
WHERE = """(id) => {
  const view = window.__panel._modelView();
  const e = view._entries.get(id);
  const THREE = view.libs.THREE;
  const c = new THREE.Box3().setFromObject(e.root).getCenter(new THREE.Vector3()).project(view.activeCameraObject());
  const r = view.canvas.getBoundingClientRect();
  return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
}"""

CANVAS = """() => { const r = window.__panel._modelView().canvas.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height }; }"""

SEL = """() => { const P = window.__panel; return { ids: P.previzSelectedIds().slice().sort(), primary: P._previzSelection }; }"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class PrevizHotkeysTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        with open(os.path.join(cls.tmp, "hero.glb"), "wb") as fh:
            fh.write(rig_fixture.build(prefix="mixamorig:"))
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.tmp)
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
        shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    def _page(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        pg.evaluate("() => { try { localStorage.removeItem('imageviewer.viewer.display3d'); } catch (_) {} }")
        self.ids = pg.evaluate(SETUP)
        return pg

    def _hover_canvas(self, pg, fx=0.5, fy=0.5):
        c = pg.evaluate(CANVAS)
        pg.mouse.move(c["x"] + c["w"] * fx, c["y"] + c["h"] * fy)
        return c

    def test_f_frames_the_selection_and_resets_without_one(self):
        pg = self._page()
        try:
            self._hover_canvas(pg)
            pg.evaluate("(id) => window.__panel.previzSelect(id)", self.ids["a"])
            dir0 = pg.evaluate("""() => { const v = window.__panel._modelView(); const c = v.activeCameraObject();
                return c.position.clone().sub(v.controls.target).normalize().toArray(); }""")
            pg.keyboard.press("f")
            st = pg.evaluate("""() => { const v = window.__panel._modelView(); const c = v.activeCameraObject();
                return { target: v.controls.target.toArray(), dir: c.position.clone().sub(v.controls.target).normalize().toArray(),
                         dist: c.position.distanceTo(v.controls.target) }; }""")
            pg.evaluate("() => window.__panel.previzSelect(null)")
            pg.keyboard.press("f")
            reset = pg.evaluate("() => window.__panel._modelView().controls.target.toArray()")
        finally:
            pg.close()
        self.assertAlmostEqual(st["target"][0], -3, places=3)
        self.assertAlmostEqual(st["target"][1], 0.5, places=3)
        for a, b in zip(st["dir"], dir0):
            self.assertAlmostEqual(a, b, places=3, msg="F keeps the direction the camera looks from")
        self.assertLess(st["dist"], 6, "close in on a unit box")
        self.assertAlmostEqual(reset[0], 0, places=3, msg="nothing selected: the whole scene is framed")
        self.assertEqual(self.errors, [])

    def test_f_over_the_outliner_opens_the_tree_to_the_selection(self):
        pg = self._page()
        try:
            st0 = pg.evaluate("""(ids) => { const P = window.__panel;
                P._previzCollapsed.add(ids.g); P.previzSelect(ids.b);
                return !!P.previzPanel.querySelector(`[data-item-id="${ids.b}"]`); }""", self.ids)
            box = pg.evaluate("""() => { const r = window.__panel.previzPanel.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }""")
            pg.mouse.move(box["x"], box["y"])
            pg.keyboard.press("f")
            st = pg.evaluate("""(ids) => { const P = window.__panel;
                const row = P.previzPanel.querySelector(`[data-item-id="${ids.b}"]`);
                return { row: !!row, selected: row && row.classList.contains('selected'),
                         target: P._modelView().controls.target.toArray() }; }""", self.ids)
        finally:
            pg.close()
        self.assertFalse(st0, "B starts folded away inside G")
        self.assertTrue(st["row"])
        self.assertTrue(st["selected"])
        self.assertAlmostEqual(st["target"][0], 0, places=3, msg="the view did not move")
        self.assertEqual(self.errors, [])

    def test_a_typed_value_goes_to_every_selected_channel(self):
        pg = self._page()
        try:
            st = pg.evaluate("""async (ids) => { const P = window.__panel;
                P.previzSelectMany([ids.a, ids.b], 'replace');
                P._cbSelect('position.0', {}); P._cbSelect('position.2', { ctrlKey: true }); P._cbSelect('scale.1', { ctrlKey: true });
                const inp = P._cbUI.rows.get('position.0').input;
                inp.value = '2.5'; inp.dispatchEvent(new Event('change'));
                const S = await import('/extensions/viewer/imageViewer_scene3d.js');
                const sc = P.previzScene(), A = S.itemById(sc, ids.a), B = S.itemById(sc, ids.b);
                const one = { a: [A.position, A.scale], b: [B.position, B.scale] };
                const inp2 = P._cbUI.rows.get('position.2').input;
                inp2.value = '+=1'; inp2.dispatchEvent(new Event('change'));
                const two = { a: A.position.slice(), b: B.position.slice() };
                P.previzUndo();
                const back = S.itemById(P.previzScene(), ids.a).position.slice();
                return { one: JSON.parse(JSON.stringify(one)), two, back }; }""", self.ids)
        finally:
            pg.close()
        self.assertEqual(st["one"]["a"], [[2.5, 0.5, 2.5], [1, 2.5, 1]])
        self.assertEqual(st["one"]["b"], [[2.5, 0.5, 2.5], [1, 2.5, 1]])
        self.assertEqual(st["two"]["a"], [3.5, 0.5, 3.5], "a relative form works from each channel's own value")
        self.assertEqual(st["back"], [2.5, 0.5, 2.5], "one undo step for the lot")
        self.assertEqual(self.errors, [])

    def test_display_menu_and_shift_digits_hide_kinds(self):
        pg = self._page()
        try:
            at = pg.evaluate(WHERE, self.ids["a"])
            self._hover_canvas(pg)
            pg.keyboard.press("Shift+Digit1")          # polygons off
            pg.wait_for_timeout(100)
            st = pg.evaluate("""(at) => { const v = window.__panel._modelView();
                const r = v.canvas.getBoundingClientRect();
                const ev = { clientX: at.x, clientY: at.y };
                return { off: !v.isDisplayed('polygons'), pick: v._pick(ev), mask: v.activeCameraObject().layers.mask,
                         stored: localStorage.getItem('imageviewer.viewer.display3d') }; }""", at)
            pg.evaluate("() => window.__panel._modelView().ui.displayBtn.click()")
            menu = pg.evaluate("""() => { const v = window.__panel._modelView(); const m = v._dispMenu;
                return m ? [...m.querySelectorAll('input')].map((i) => [i.dataset.kind, i.checked]) : null; }""")
            pg.evaluate("""() => { const m = window.__panel._modelView()._dispMenu;
                const box = m.querySelector('input[data-kind="polygons"]'); box.click(); }""")
            back = pg.evaluate("""(at) => { const v = window.__panel._modelView();
                return { on: v.isDisplayed('polygons'), pick: v._pick({ clientX: at.x, clientY: at.y }) }; }""", at)
        finally:
            pg.close()
        self.assertTrue(st["off"])
        self.assertIsNone(st["pick"], "a hidden kind cannot be clicked")
        self.assertEqual(st["mask"] & 2, 0, "the polygons' layer is not drawn")
        self.assertIn("polygons", st["stored"])
        self.assertIn(["polygons", False], menu)
        self.assertIn(["grid", True], menu)
        self.assertTrue(back["on"])
        self.assertEqual(back["pick"], self.ids["a"])
        self.assertEqual(self.errors, [])

    def test_joints_are_drawn_for_a_skinned_model(self):
        pg = self._page()
        try:
            st = pg.evaluate("""async () => { const P = window.__panel;
                const S = await import('/extensions/viewer/imageViewer_scene3d.js');
                const item = S.makeModelItem({ url: '/media/hero.glb', filename: 'hero.glb' }, 'Hero');
                P.previzScene().items.push(item);
                await P.previzChanged({ reload: true });
                const v = P._modelView(); await v.whenLoaded(20000);
                v.requestRender(); await new Promise((r) => setTimeout(r, 300));
                const j = v._joints && v._joints.get(item.id);
                const on = { has: !!j, visible: j && j.group.visible, dots: j && j.dots.geometry.attributes.position.count };
                v.setDisplayed('joints', false); v.requestRender(); await new Promise((r) => setTimeout(r, 200));
                const mask = v.activeCameraObject().layers.mask;
                return { on, bones: v._entries.get(item.id).bones.size, jointsLayerOff: (mask & 8) === 0,
                         hidden: !j.group.visible }; }""")
        finally:
            pg.close()
        self.assertTrue(st["on"]["has"])
        self.assertTrue(st["on"]["visible"])
        self.assertEqual(st["on"]["dots"], st["bones"])
        self.assertTrue(st["jointsLayerOff"])
        self.assertTrue(st["hidden"])
        self.assertEqual(self.errors, [])

    def test_select_tool_and_marquee_with_maya_modifiers(self):
        pg = self._page()
        try:
            a = pg.evaluate(WHERE, self.ids["a"])
            b = pg.evaluate(WHERE, self.ids["b"])
            c = self._hover_canvas(pg)
            pg.keyboard.press("q")
            mode = pg.evaluate("() => window.__panel._modelView().gizmoMode")
            # A box around both, from empty space above them.
            x0, x1 = min(a["x"], b["x"]) - 40, max(a["x"], b["x"]) + 40
            y0, y1 = min(a["y"], b["y"]) - 40, max(a["y"], b["y"]) + 40
            pg.mouse.move(x0, y0)
            pg.mouse.down()
            pg.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, steps=4)
            pg.mouse.move(x1, y1, steps=4)
            pg.mouse.up()
            both = pg.evaluate(SEL)
            gizmo = pg.evaluate("() => { const v = window.__panel._modelView(); return !!(v.gizmo && v.gizmo.object); }")
            # Ctrl+click takes A out; Shift+click toggles it back in; a click on nothing clears.
            pg.keyboard.down("Control"); pg.mouse.click(a["x"], a["y"]); pg.keyboard.up("Control")
            no_a = pg.evaluate(SEL)
            pg.keyboard.down("Shift"); pg.mouse.click(a["x"], a["y"]); pg.keyboard.up("Shift")
            with_a = pg.evaluate(SEL)
            pg.mouse.click(c["x"] + 10, c["y"] + c["h"] - 10)
            none = pg.evaluate(SEL)
            # With the Move tool a box still starts on empty space.
            pg.keyboard.press("w")
            pg.mouse.move(a["x"] - 30, a["y"] - 30)
            pg.mouse.down()
            pg.mouse.move(a["x"] + 30, a["y"] + 30, steps=5)
            pg.mouse.up()
            moved = pg.evaluate(SEL)
            gizmo_w = pg.evaluate("() => { const v = window.__panel._modelView(); return !!(v.gizmo && v.gizmo.object); }")
        finally:
            pg.close()
        self.assertEqual(mode, "select")
        self.assertEqual(both["ids"], sorted([self.ids["a"], self.ids["b"]]))
        self.assertFalse(gizmo, "the Select tool shows no gizmo")
        self.assertEqual(no_a["ids"], [self.ids["b"]])
        self.assertEqual(with_a["ids"], sorted([self.ids["a"], self.ids["b"]]))
        self.assertEqual(none["ids"], [])
        self.assertEqual(moved["ids"], [self.ids["a"]])
        self.assertTrue(gizmo_w)
        self.assertEqual(self.errors, [])

    def test_s_keys_and_k_scrubs(self):
        pg = self._page()
        try:
            c = self._hover_canvas(pg)
            st = pg.evaluate("""(ids) => { const P = window.__panel; P.previzSelect(ids.a); P.setFrame(5);
                return P.getTimelineBounds(); }""", self.ids)
            pg.keyboard.press("s")
            all_keys = pg.evaluate("""(id) => { const it = window.__panel.previzScene().items.find((x) => x.id === id);
                return Object.keys(it.tracks || {}).filter((k) => (it.tracks[k] || []).some((key) => key.f === 5)).sort(); }""",
                                   self.ids["a"])
            pg.evaluate("""(ids) => { const P = window.__panel; P.previzSelect(ids.b); P.setFrame(7);
                P._cbSelect('rotation.1', {}); }""", self.ids)
            self._hover_canvas(pg)
            pg.keyboard.press("Shift+S")
            some = pg.evaluate("""(id) => { const it = window.__panel.previzScene().items.find((x) => x.id === id);
                return Object.keys(it.tracks || {}).filter((k) => (it.tracks[k] || []).length).sort(); }""", self.ids["b"])
            pg.evaluate("() => window.__panel.setFrame(10)")
            x, y = c["x"] + c["w"] * 0.3, c["y"] + c["h"] * 0.8
            pg.mouse.move(x, y)
            pg.keyboard.down("k")
            pg.mouse.down()
            pg.mouse.move(x + c["w"] * 0.25, y, steps=6)
            pg.mouse.up()
            pg.keyboard.up("k")
            after = pg.evaluate("() => ({ frame: window.__panel.currentFrame, sel: window.__panel.previzSelectedIds() })")
        finally:
            pg.close()
        self.assertIn("position", all_keys)
        self.assertIn("rotation", all_keys)
        self.assertIn("scale", all_keys)
        self.assertEqual(some, ["rotation"], "Shift+S keys the Channel Box's selected channels only")
        span = st["max"] - st["min"] + 1
        self.assertAlmostEqual(after["frame"], min(st["max"], 10 + round(span * 0.25)), delta=1)
        self.assertEqual(after["sel"], [self.ids["b"]], "a scrub selects nothing")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
