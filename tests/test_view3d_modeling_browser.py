"""Modeling in the 3D space, part 1, with the real mouse and keys, in a real browser.

Sebastian 2026-11-20: "add extensive modeling capabilities". An editable mesh item (Create mesh, or a
shape / model converted), its edit mode (Tab; 1 / 2 / 3 = vertices / edges / faces), picking and boxing
components, the gizmo moving them, Extrude (Ctrl+E), Inset (I), Delete, each one undo step and saved
with the scene. js/imageViewer_meshData.js, js/imageViewer_view3dMeshEdit.js,
js/imageViewer_previzModeling.js.

Needs Playwright with an installed browser and node; skipped without them.
MODELING_SHOTS=<folder> saves screenshots.
Run: python -m unittest tests.test_view3d_modeling_browser
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
SHOTS = os.environ.get("MODELING_SHOTS")

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  try { localStorage.removeItem('imageviewer.viewer.meshEdit'); localStorage.removeItem('imageviewer.viewer.snap3d'); } catch (_) {}
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const v = P._modelView();
  v.setPaneLayout('single');
  const box = await P.previzAddMesh('box');
  const shape = await P.previzAddPrimitive('sphere');
  shape.position = [-3, 0, 0];
  await P.previzChanged({ reload: true });
  v.resetView();
  const cam = v.activeCameraObject();
  cam.position.set(3, 4, 5); v.controls.target.set(0, 0.5, 0); cam.lookAt(0, 0.5, 0); v.controls.update();
  P.previzSelect(box.id);
  v.setGizmoMode('translate');
  v.requestRender();
  return { box: box.id, shape: shape.id };
}"""

SCREEN = """(p) => {
  const v = window.__panel._modelView();
  const T = v.libs.THREE;
  const r = v.canvas.getBoundingClientRect();
  const q = new T.Vector3(...p).project(v.activeCameraObject());
  return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
}"""

STATS = """(id) => {
  const P = window.__panel;
  const it = P.previzScene().items.find((i) => i.id === id);
  const v = P._modelView();
  const sel = v.meshEditSelection();
  return { kind: it.kind, verts: it.mesh ? it.mesh.v.length / 3 : 0,
           faces: it.mesh ? (() => { let n = 0; for (let i = 0; i < it.mesh.f.length; i += it.mesh.f[i] + 1) n++; return n; })() : 0,
           editing: v.meshEditing(), mode: sel && sel.mode, sel: sel ? sel.ids : null };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ModelingTests(unittest.TestCase):
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
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        ids = pg.evaluate(SETUP)
        pg.wait_for_timeout(300)
        return pg, ids

    def _shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, name))

    def _hover_view(self, pg):
        r = pg.evaluate("() => { const b = window.__panel._modelView().canvas.getBoundingClientRect();"
                        " return { x: b.left + 40, y: b.bottom - 40 }; }")
        pg.mouse.move(r["x"], r["y"])
        pg.wait_for_timeout(50)

    def _click(self, pg, p, **mods):
        pg.mouse.move(p["x"], p["y"])
        pg.wait_for_timeout(40)
        pg.mouse.down()
        pg.mouse.up()
        pg.wait_for_timeout(80)

    def test_edit_mode_pick_extrude_inset_delete_and_undo(self):
        pg, ids = self._page()
        box = ids["box"]
        try:
            before = pg.evaluate(STATS, box)
            # Tab over the view: into edit mode, vertices; the bar shows.
            self._hover_view(pg)
            pg.keyboard.press("Tab")
            pg.wait_for_timeout(100)
            entered = pg.evaluate(STATS, box)
            bar = pg.evaluate("() => !!window.__panel._modelView().stage.querySelector('.model-mesh-bar')")
            # 3: faces; a click on the top face picks it.
            pg.keyboard.press("3")
            top = pg.evaluate(SCREEN, [0, 1, 0])
            self._click(pg, top)
            picked = pg.evaluate(STATS, box)
            self._shot(pg, "mesh_face_picked.png")
            # Ctrl+E: extruded; the same face stays selected, one undo step.
            self._hover_view(pg)
            pg.keyboard.press("Control+e")
            pg.wait_for_timeout(150)
            extruded = pg.evaluate(STATS, box)
            top_y = pg.evaluate(f"""() => {{ const it = window.__panel.previzScene().items.find((i) => i.id === '{box}');
                let m = -1e9; for (let i = 1; i < it.mesh.v.length; i += 3) m = Math.max(m, it.mesh.v[i]); return m; }}""")
            self._shot(pg, "mesh_extruded.png")
            # I: inset the same face.
            pg.keyboard.press("i")
            pg.wait_for_timeout(150)
            inset = pg.evaluate(STATS, box)
            # Delete: the face goes.
            pg.keyboard.press("Delete")
            pg.wait_for_timeout(150)
            deleted = pg.evaluate(STATS, box)
            # Undo three times: back to the extruded box, the inset one, the plain box.
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(150)
            undo1 = pg.evaluate(STATS, box)
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(150)
            undo3 = pg.evaluate(STATS, box)
            still = pg.evaluate("() => window.__panel._modelView().meshEditing()")
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertEqual((before["kind"], before["verts"], before["faces"]), ("mesh", 8, 6))
        self.assertTrue(bar)
        self.assertEqual((entered["editing"], entered["mode"]), (box, "vertex"))
        self.assertEqual(picked["mode"], "face")
        self.assertEqual(len(picked["sel"]), 1)
        self.assertEqual((extruded["verts"], extruded["faces"]), (12, 10))
        self.assertEqual(extruded["sel"], picked["sel"])
        self.assertAlmostEqual(top_y, 0.75, places=4)          # the mesh's own top is 0.5; 0.25 is the default distance
        self.assertEqual((inset["verts"], inset["faces"]), (16, 14))
        self.assertEqual(deleted["faces"], 13)
        self.assertEqual(deleted["sel"], [])
        self.assertEqual(undo1["faces"], 14)
        self.assertEqual((undo3["verts"], undo3["faces"]), (8, 6))
        self.assertEqual(still, box)

    def test_the_gizmo_moves_vertices_and_a_box_selects(self):
        pg, ids = self._page()
        box = ids["box"]
        try:
            pg.evaluate(f"() => window.__panel._modelView().meshEditBegin('{box}', 'vertex')")
            pg.wait_for_timeout(100)
            corner = pg.evaluate(SCREEN, [0.5, 1, 0.5])
            self._click(pg, corner)
            one = pg.evaluate(STATS, box)
            handle = pg.evaluate("""() => { const v = window.__panel._modelView();
                return { on: v.gizmo.object === v._me.handle, p: v._me.handle.position.toArray() }; }""")
            # The Y handle: drag up.
            yh = pg.evaluate(SCREEN, [0.5, 1.45, 0.5])
            pg.mouse.move(yh["x"], yh["y"])
            pg.wait_for_timeout(60)
            axis = pg.evaluate("() => window.__panel._modelView().gizmo.axis")
            pg.mouse.down()
            pg.mouse.move(yh["x"], yh["y"] - 60, steps=8)
            pg.mouse.up()
            pg.wait_for_timeout(150)
            moved = pg.evaluate(f"""() => {{ const it = window.__panel.previzScene().items.find((i) => i.id === '{box}');
                const v = it.mesh.v; const out = [];
                for (let i = 0; i < v.length; i += 3) out.push([v[i], v[i + 1], v[i + 2]]); return out; }}""")
            undo_len = pg.evaluate("() => window.__panel._undoState().past.length")
            self._shot(pg, "mesh_vertex_moved.png")
            # A box over the whole view: every vertex facing the camera.
            r = pg.evaluate("() => { const b = window.__panel._modelView().canvas.getBoundingClientRect();"
                            " return { x0: b.left + 60, y0: b.top + 60, x1: b.right - 60, y1: b.bottom - 60 }; }")
            pg.mouse.move(r["x0"], r["y0"])
            pg.mouse.down()
            pg.mouse.move(r["x1"], r["y1"], steps=6)
            pg.mouse.up()
            pg.wait_for_timeout(100)
            boxed = pg.evaluate(STATS, box)
            pg.evaluate("() => window.__panel._modelView().setMeshEditOptions({ xray: true })")
            pg.mouse.move(r["x0"], r["y0"])
            pg.mouse.down()
            pg.mouse.move(r["x1"], r["y1"], steps=6)
            pg.mouse.up()
            pg.wait_for_timeout(100)
            boxed_xray = pg.evaluate(STATS, box)
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(len(one["sel"]), 1)
        self.assertTrue(handle["on"])
        self.assertAlmostEqual(handle["p"][1], 1, places=3)
        self.assertEqual(axis, "Y")
        lifted = [p for p in moved if p[1] > 0.55]
        self.assertEqual(len(lifted), 1)
        self.assertAlmostEqual(lifted[0][0], 0.5, places=3)
        self.assertEqual(undo_len, 3)          # add mesh, add sphere, move vertices
        self.assertGreaterEqual(len(boxed["sel"]), 6)
        self.assertLess(len(boxed["sel"]), 8)
        self.assertEqual(len(boxed_xray["sel"]), 8)

    def test_converting_a_shape_and_saving_the_mesh(self):
        pg, ids = self._page()
        try:
            res = pg.evaluate(f"""async () => {{
                const P = window.__panel;
                P.previzSelect('{ids["shape"]}');
                const ok = await P.previzConvertToMesh();
                const it = P.previzScene().items.find((i) => i.id === '{ids["shape"]}');
                const S = await import('/extensions/viewer/imageViewer_scene3d.js');
                const back = S.parseScene(JSON.parse(S.serializeScene(P.previzScene())));
                const b = back.items.find((i) => i.id === it.id);
                const menu = P._previzMeshMenuEntries().filter((e) => e && e.label).map((e) => e.label);
                const usd = (await import('/extensions/viewer/imageViewer_view3dUsd.js')).BUILT_KINDS;
                return {{ ok, kind: it.kind, smooth: it.smooth, verts: it.mesh.v.length / 3, offset: it.offset,
                         back: b && b.kind, backVerts: b && b.mesh.v.length / 3, backOffset: b && b.offset,
                         drawn: !!P._modelView()._entries.get(it.id).editMesh, menu, usd }};
            }}""")
            pg.wait_for_timeout(100)
            self._hover_view(pg)
            pg.keyboard.press("Tab")
            pg.wait_for_timeout(100)
            editing = pg.evaluate("() => window.__panel._modelView().meshEditing()")
            self._shot(pg, "mesh_sphere_edit.png")
            pg.keyboard.press("Tab")
            pg.wait_for_timeout(100)
            after = pg.evaluate("() => window.__panel._modelView().meshEditing()")
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertTrue(res["ok"])
        self.assertEqual(res["kind"], "mesh")
        self.assertTrue(res["smooth"])
        self.assertGreater(res["verts"], 50)
        self.assertEqual(res["back"], "mesh")
        self.assertEqual(res["backVerts"], res["verts"])
        self.assertEqual(res["backOffset"], res["offset"])
        self.assertTrue(res["drawn"])
        self.assertIn("Extrude", res["menu"])
        self.assertIn("mesh", res["usd"])
        self.assertEqual(editing, ids["shape"])
        self.assertIsNone(after)


if __name__ == "__main__":
    unittest.main()
