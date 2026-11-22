"""Modeling in the 3D space, parts 1 to 3, with the real mouse and keys, in a real browser.

Sebastian 2026-11-20: "add extensive modeling capabilities". An editable mesh item (Create mesh, or a
shape / model converted), its edit mode (Tab; 1 / 2 / 3 = vertices / edges / faces), picking and boxing
components, the gizmo moving them, Extrude (Ctrl+E), Inset (I), Delete, each one undo step and saved
with the scene; part 2: a ring by Ctrl+double-click, bevel (Ctrl+B), loop cut (Ctrl+R), bridge, fill,
weld, soft selection (B) carrying a move along; part 3: subdivision drawn and applied, mirror, booleans
between two meshes, UV projections with a checker, and the agent's mesh actions. js/imageViewer_meshData.js, js/imageViewer_meshOps.js, js/imageViewer_view3dMeshEdit.js,
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
            pg.keyboard.press("Enter")      # the operation follows the mouse until kept
            pg.wait_for_timeout(150)
            extruded = pg.evaluate(STATS, box)
            top_y = pg.evaluate(f"""() => {{ const it = window.__panel.previzScene().items.find((i) => i.id === '{box}');
                let m = -1e9; for (let i = 1; i < it.mesh.v.length; i += 3) m = Math.max(m, it.mesh.v[i]); return m; }}""")
            self._shot(pg, "mesh_extruded.png")
            # I: inset the same face.
            pg.keyboard.press("i")
            pg.keyboard.press("Enter")      # the operation follows the mouse until kept
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
            pg.evaluate("() => window.__panel._modelView().setGizmoSpace('world')")   # this drag is along the world axes
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

    def test_local_gizmo_follows_the_selection_normal(self):
        """In Modeling, Local turns the gizmo to the selected face / edge / vertex's normal."""
        pg, ids = self._page()
        box = ids["box"]
        # The gizmo's own up axis (+Y) in world space, and whether its handle is identity.
        UP = """() => { const v = window.__panel._modelView(); const T = v.libs.THREE;
            v._me.handle.updateMatrixWorld(true);
            const up = new T.Vector3(0, 1, 0).applyQuaternion(v._me.handle.getWorldQuaternion(new T.Quaternion()));
            const q = v._me.handle.quaternion.toArray();
            return { space: v.gizmoSpace, up: [up.x, up.y, up.z],
                     ident: q.every((c, i) => Math.abs(c - (i === 3 ? 1 : 0)) < 1e-6) }; }"""
        # Pick the one face whose normal points along `want`, without clicking.
        SEL_FACE = """async (want) => { const M = await import('/extensions/viewer/imageViewer_meshData.js');
            const v = window.__panel._modelView(); const w = v._me.work;
            const fi = w.f.findIndex((f) => { const n = M.faceNormal(w, f);
                return Math.abs(n[0] - want[0]) < 0.5 && Math.abs(n[1] - want[1]) < 0.5 && Math.abs(n[2] - want[2]) < 0.5; });
            v.meshEditSetSelection([fi], 'replace', 'face'); return fi; }"""
        try:
            pg.evaluate(f"() => window.__panel._modelView().meshEditBegin('{box}', 'face')")
            pg.evaluate("() => window.__panel._modelView().setGizmoSpace('world')")
            pg.wait_for_timeout(60)
            # World: a side face selected, the handle stays identity (unchanged behaviour).
            pg.evaluate(SEL_FACE, [1, 0, 0])
            pg.wait_for_timeout(60)
            world_side = pg.evaluate(UP)
            # Toggle to Local WITHOUT re-selecting: the handle turns to the +X face's normal.
            pg.evaluate("() => window.__panel._modelView().setGizmoSpace('local')")
            pg.wait_for_timeout(60)
            local_side = pg.evaluate(UP)
            self._shot(pg, "mesh_gizmo_normal_side.png")
            # The top face in Local: its normal is +Y, so the handle is identity again.
            pg.evaluate(SEL_FACE, [0, 1, 0])
            pg.wait_for_timeout(60)
            local_top = pg.evaluate(UP)
            self._shot(pg, "mesh_gizmo_normal_top.png")
            # Vertex mode, a top corner: the normal leans up and out (equal parts on all axes).
            pg.evaluate("""() => { const v = window.__panel._modelView(); const w = v._me.work;
                const vi = w.v.map((p, i) => [p, i]).filter(([[, y]]) => y > 0.4)[0][1];
                v.meshEditSetSelection([vi], 'replace', 'vertex'); }""")
            pg.wait_for_timeout(60)
            local_vert = pg.evaluate(UP)
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(world_side["space"], "world")
        self.assertTrue(world_side["ident"], world_side)
        self.assertEqual(local_side["space"], "local")
        self.assertAlmostEqual(local_side["up"][0], 1.0, places=3)   # +X face normal
        self.assertAlmostEqual(local_side["up"][1], 0.0, places=3)
        self.assertAlmostEqual(local_top["up"][1], 1.0, places=3)    # +Y face normal
        self.assertTrue(local_top["ident"], local_top)
        self.assertAlmostEqual(local_vert["up"][1], 1 / 3 ** 0.5, places=3)   # a cube corner

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


    def test_ring_bevel_loop_cut_bridge_fill_and_soft_selection(self):
        pg, ids = self._page()
        box = ids["box"]
        closed = """(id) => import('/extensions/viewer/imageViewer_meshOps.js').then(async (O) => {
            const M = await import('/extensions/viewer/imageViewer_meshData.js');
            const it = window.__panel.previzScene().items.find((i) => i.id === id);
            return O.boundaryLoops(M.unpack(it.mesh)).length; })"""
        try:
            self._hover_view(pg)
            pg.keyboard.press("Tab")
            pg.keyboard.press("2")
            pg.wait_for_timeout(100)
            # Ctrl+double-click on the near vertical edge: its ring, the four vertical edges.
            e = pg.evaluate(SCREEN, [0.5, 0.5, 0.5])
            pg.mouse.move(e["x"], e["y"])
            pg.wait_for_timeout(40)
            pg.keyboard.down("Control")
            pg.mouse.dblclick(e["x"], e["y"])
            pg.keyboard.up("Control")
            pg.wait_for_timeout(100)
            ring = pg.evaluate(STATS, box)
            # Ctrl+B: bevelled.
            self._hover_view(pg)
            pg.keyboard.press("Control+b")
            pg.keyboard.press("Enter")      # the operation follows the mouse until kept
            pg.wait_for_timeout(200)
            bevelled = pg.evaluate(STATS, box)
            bevel_closed = pg.evaluate(closed, box)
            self._shot(pg, "mesh_bevelled.png")
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(150)
            # One edge, Ctrl+R: a loop round the box.
            self._click(pg, e)
            one = pg.evaluate(STATS, box)
            self._hover_view(pg)
            pg.keyboard.press("Control+r")
            pg.keyboard.press("Enter")      # the operation follows the mouse until kept
            pg.wait_for_timeout(200)
            cut = pg.evaluate(STATS, box)
            self._shot(pg, "mesh_loop_cut.png")
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(150)
            # Top and bottom out, every vertex selected, Bridge: closed again with a wall across.
            res = pg.evaluate(f"""async () => {{
                const P = window.__panel, v = P._modelView();
                const M = await import('/extensions/viewer/imageViewer_meshData.js');
                const it = () => P.previzScene().items.find((i) => i.id === '{box}');
                const w = M.unpack(it().mesh);
                const caps = w.f.map((f, i) => [f, i]).filter(([f]) => f.every((k) => Math.abs(w.v[k][1]) > 0.4)
                    && new Set(f.map((k) => w.v[k][1])).size === 1).map(([, i]) => i);
                v.meshEditSetSelection(caps, 'replace', 'face');
                await P.previzMeshOp('delete');
                const tube = M.meshStats(M.unpack(it().mesh)).faces;
                v.meshEditSetSelection(M.allOf(M.unpack(it().mesh), 'vertex'), 'replace', 'vertex');
                await P.previzMeshOp('bridge');
                const bridged = M.meshStats(M.unpack(it().mesh)).faces;
                P.previzUndo(); await new Promise((r) => setTimeout(r, 150));
                v.meshEditSetSelection([], 'replace', 'vertex');
                await P.previzMeshOp('fill');
                const filled = M.meshStats(M.unpack(it().mesh)).faces;
                return {{ caps: caps.length, tube, bridged, filled }};
            }}""")
            fill_closed = pg.evaluate(closed, box)
            pg.evaluate("() => { const P = window.__panel; P.previzUndo(); P.previzUndo(); }")
            pg.wait_for_timeout(200)
            # B: soft selection on; one corner moved up carries its neighbours, less the further away.
            self._hover_view(pg)
            pg.keyboard.press("b")
            pg.keyboard.press("1")
            pg.evaluate("() => window.__panel._modelView().setMeshEditOptions({ softRadius: 1.2 })")
            pg.evaluate("() => window.__panel._modelView().setGizmoSpace('world')")   # this drag is along the world axes
            pg.wait_for_timeout(100)
            corner = pg.evaluate(SCREEN, [0.5, 1, 0.5])
            self._click(pg, corner)
            soft_on = pg.evaluate("() => window.__panel._modelView().meshEditOptions().soft")
            self._shot(pg, "mesh_soft_selection.png")
            yh = pg.evaluate(SCREEN, [0.5, 1.45, 0.5])
            pg.mouse.move(yh["x"], yh["y"])
            pg.wait_for_timeout(60)
            pg.mouse.down()
            pg.mouse.move(yh["x"], yh["y"] - 60, steps=8)
            pg.mouse.up()
            pg.wait_for_timeout(150)
            ys = pg.evaluate(f"""() => {{ const it = window.__panel.previzScene().items.find((i) => i.id === '{box}');
                const v = it.mesh.v; const out = []; for (let i = 1; i < v.length; i += 3) out.push(v[i]); return out; }}""")
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertEqual((ring["mode"], len(ring["sel"])), ("edge", 4))
        self.assertEqual((bevelled["verts"], bevelled["faces"]), (24, 18))
        self.assertEqual(bevel_closed, 0)
        self.assertEqual(len(one["sel"]), 1)
        self.assertEqual((cut["verts"], cut["faces"]), (12, 10))
        self.assertEqual((cut["mode"], len(cut["sel"])), ("edge", 4))
        self.assertEqual((res["caps"], res["tube"], res["bridged"]), (2, 4, 8))
        self.assertEqual(res["filled"], 6)
        self.assertEqual(fill_closed, 0)
        self.assertTrue(soft_on)
        top = sorted(y for y in ys if y > 0)
        bottom = [y for y in ys if y < 0]
        self.assertGreater(top[-1], 0.6)                  # the corner itself
        self.assertTrue(any(0.5 + 1e-3 < y < top[-1] - 1e-3 for y in top))   # a neighbour, part of the way
        self.assertTrue(all(abs(y + 0.5) < 0.5 for y in bottom))


    def test_subdivision_mirror_boolean_uvs(self):
        pg, ids = self._page()
        box = ids["box"]
        try:
            res = pg.evaluate(f"""async () => {{
                const P = window.__panel, v = P._modelView();
                const it = () => P.previzScene().items.find((i) => i.id === '{box}');
                const tris = () => v._entries.get('{box}').editMesh.geometry.attributes.position.count / 3;
                const out = {{}};
                P.previzMeshSetSubdiv(2);
                await new Promise((r) => setTimeout(r, 150));
                out.drawnSubdiv = tris(); out.keptVerts = it().mesh.v.length / 3;
                // Editing shows the cage again; leaving shows the subdivided one.
                v.meshEditBegin('{box}');
                out.drawnEditing = tris();
                v.meshEditEnd();
                out.drawnAfter = tris();
                out.cbSubdiv = !!P.container.querySelector('.cb-mesh-subdiv');
                await P.previzMeshApplySubdiv();
                out.applied = [it().mesh.v.length / 3, it().subdiv || 0];
                P.previzUndo(); P.previzUndo();
                await new Promise((r) => setTimeout(r, 150));
                // UVs: a box projection with the checker.
                P.previzMeshSetUv({{ type: 'box', checker: true }});
                await new Promise((r) => setTimeout(r, 150));
                const e = v._entries.get('{box}');
                out.uv = !!e.editMesh.geometry.attributes.uv && !!e.editMesh.material.map;
                // A second box, moved half over: subtract it from the first.
                const cutter = await P.previzAddMesh('box');
                cutter.position = [0.5, 0.5, 0.5];
                await P.previzChanged({{ reload: true }});
                out.boolean = await P.previzMeshBoolean('subtract', ['{box}', cutter.id]);
                out.cutterHidden = P.previzScene().items.find((i) => i.id === cutter.id).visible === false;
                const M = await import('/extensions/viewer/imageViewer_meshData.js');
                const X = await import('/extensions/viewer/imageViewer_meshModel.js');
                const d = X.describeMesh(M.unpack(it().mesh));
                out.cut = [d.closed, d.faces];
                // Mirror in edit mode across X after deleting the -X half.
                P.previzUndo();
                await new Promise((r) => setTimeout(r, 150));
                return out;
            }}""")
            pg.wait_for_timeout(150)
            self._shot(pg, "mesh_uv_checker.png")
            agent = pg.evaluate(f"""async () => {{
                const P = window.__panel;
                const run = (action, a) => P.previzSceneAgent(action, a);
                const out = {{}};
                const m = await run('mesh_add', {{ shape: 'box', name: 'Agent box', position: [3, 0, 0] }});
                out.add = [m.name, m.vertices, m.faces];
                const ex = await run('mesh_edit', {{ item: 'Agent box', op: 'extrude', select: {{ side: '+y' }}, amount: 0.5 }});
                out.extrude = [ex.selected, ex.mesh.faces, ex.mesh.box.max[1]];
                const bv = await run('mesh_edit', {{ item: 'Agent box', op: 'bevel', select: {{ along: 'y', within: 5 }}, amount: 0.05 }});
                out.bevel = [bv.mesh.closed, bv.mesh.faces > 10];
                const mv = await run('mesh_edit', {{ item: 'Agent box', op: 'move', mode: 'face', select: {{ side: '+y' }}, offset: [0, 0.25, 0] }});
                out.move = mv.mesh.box.max[1];
                const set = await run('mesh_set', {{ item: 'Agent box', subdiv: 1, uv: 'cylinder' }});
                out.set = [set.subdiv, set.uv && set.uv.type];
                const info = await run('mesh_info', {{ item: 'Agent box', select: {{ side: '-y' }} }});
                out.info = [info.closed, info.selected.ids.length];
                let err = null;
                try {{ await run('mesh_edit', {{ item: 'Agent box', op: 'twist' }}); }} catch (e) {{ err = String(e.message || e); }}
                out.err = err;
                return out;
            }}""")
            pg.wait_for_timeout(200)
            self._shot(pg, "mesh_agent.png")
            # Symmetrize: a box loop-cut across X at its middle, its +X half mirrored over the plane.
            mirror = pg.evaluate("""async () => {
                const P = window.__panel;
                await P.previzSceneAgent('mesh_add', { shape: 'box', name: 'Mirror box' });
                await P.previzSceneAgent('mesh_edit', { item: 'Mirror box', op: 'loopcut', mode: 'edge',
                                                        select: { along: 'x', within: 5 }, amount: 0.5 });
                const r = await P.previzSceneAgent('mesh_edit', { item: 'Mirror box', op: 'symmetrize', axis: 'x' });
                return [r.mesh.closed, r.mesh.vertices, r.mesh.faces];
            }""")
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(res["drawnSubdiv"], 6 * 16 * 2)        # 96 quads, two triangles each
        self.assertEqual(res["keptVerts"], 8)
        self.assertEqual(res["drawnEditing"], 12)
        self.assertEqual(res["drawnAfter"], 192)
        self.assertTrue(res["cbSubdiv"])
        self.assertEqual(res["applied"], [98, 0])
        self.assertTrue(res["uv"])
        self.assertTrue(res["boolean"])
        self.assertTrue(res["cutterHidden"])
        self.assertTrue(res["cut"][0])
        self.assertEqual(res["cut"][1], 9)                     # a cube with a corner cube taken out
        self.assertEqual(agent["add"], ["Agent box", 8, 6])
        self.assertEqual(agent["extrude"][:2], [1, 10])
        self.assertAlmostEqual(agent["extrude"][2], 1.0, places=4)
        self.assertEqual(agent["bevel"], [True, True])
        self.assertAlmostEqual(agent["move"], 1.25, places=4)
        self.assertEqual(agent["set"], [1, "cylinder"])
        self.assertEqual(agent["info"], [True, 5])             # the bottom and the bevels' four corner triangles in its plane
        self.assertIn("op is one of", agent["err"])
        self.assertEqual(mirror, [True, 12, 10])

    def _drag(self, pg, a, b, steps=12):
        pg.mouse.move(a["x"], a["y"])
        pg.wait_for_timeout(40)
        pg.mouse.down()
        for k in range(1, steps + 1):
            pg.mouse.move(a["x"] + (b["x"] - a["x"]) * k / steps, a["y"] + (b["y"] - a["y"]) * k / steps)
            pg.wait_for_timeout(15)

    def test_tools_are_dragged_live_and_adjusted_after(self):
        """Sebastian 2026-11-20: tools in the left column, sizes dragged on screen, live, before they are kept."""
        pg, ids = self._page()
        box = ids["box"]
        top_y = f"""() => {{ const it = window.__panel.previzScene().items.find((i) => i.id === '{box}');
            let m = -1e9; for (let i = 1; i < it.mesh.v.length; i += 3) m = Math.max(m, it.mesh.v[i]); return m; }}"""
        drawn = "() => { const v = window.__panel._modelView(); return v._me.work.v.length; }"
        try:
            self._hover_view(pg)
            pg.keyboard.press("Tab")
            pg.keyboard.press("3")
            top = pg.evaluate(SCREEN, [0, 1, 0])
            self._click(pg, top)
            tools = pg.evaluate("""() => [...window.__panel._modelView().ui.tools.querySelectorAll('.model-mesh-tool')]
                .map((b) => b.dataset.tool)""")
            # The Extrude tool: no gizmo, an arrow on the face instead.
            pg.click(".model-mesh-tool[data-tool=mesh-extrude]")
            pg.wait_for_timeout(100)
            picked = pg.evaluate("""() => { const v = window.__panel._modelView();
                return { tool: v.meshTool(), gizmo: !!(v.gizmo && v.gizmo.object), arrow: !!v.stage.querySelector('.model-mesh-handle .mh-grip') }; }""")
            # A drag upwards from the face: previewed live, nothing written yet.
            up = pg.evaluate(SCREEN, [0, 1.6, 0])
            self._drag(pg, top, up)
            live = pg.evaluate("() => window.__panel._modelView().meshToolLive()")
            mid = {"drawn": pg.evaluate(drawn), "top": pg.evaluate(top_y),
                   "hud": pg.evaluate("() => window.__panel._modelView().stage.querySelector('.model-mesh-hud').textContent")}
            self._shot(pg, "mesh_tool_extrude_drag.png")
            pg.mouse.up()
            pg.wait_for_timeout(250)
            kept = pg.evaluate(STATS, box)
            kept_top = pg.evaluate(top_y)
            adjust = pg.evaluate("() => window.__panel._modelView().meshAdjustState()")
            self._shot(pg, "mesh_tool_adjust.png")
            # The adjust box: another distance replaces the result, no new undo step.
            pg.fill(".model-mesh-adjust .mma-input[data-key=amount]", "1")
            pg.press(".model-mesh-adjust .mma-input[data-key=amount]", "Tab")
            pg.wait_for_timeout(300)
            adjusted_top = pg.evaluate(top_y)
            adjusted = pg.evaluate(STATS, box)
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(200)
            undone = pg.evaluate(STATS, box)
            box_gone = pg.evaluate("() => !window.__panel._modelView().stage.querySelector('.model-mesh-adjust')")
            # Ctrl+E: modal, follows the mouse; Esc drops it, a click keeps it.
            self._click(pg, top)
            pg.mouse.move(top["x"] + 5, top["y"] + 5)
            pg.keyboard.press("Control+e")
            pg.mouse.move(up["x"], up["y"], steps=6)
            pg.wait_for_timeout(50)
            modal = pg.evaluate("() => window.__panel._modelView().meshToolLive()")
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(150)
            dropped = pg.evaluate(STATS, box)
            pg.keyboard.press("Control+e")
            pg.mouse.move(up["x"], up["y"] - 20, steps=6)
            pg.mouse.down()
            pg.mouse.up()
            pg.wait_for_timeout(250)
            clicked = pg.evaluate(STATS, box)
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(200)
            # Inset: dragged away from the face's middle, the border grows.
            self._click(pg, top)
            pg.click(".model-mesh-tool[data-tool=mesh-inset]")
            side = pg.evaluate(SCREEN, [0.3, 1, 0.3])
            self._drag(pg, top, {"x": top["x"] + 40, "y": top["y"]})
            inset_live = pg.evaluate("() => window.__panel._modelView().meshToolLive()")
            pg.mouse.up()
            pg.wait_for_timeout(250)
            inset = pg.evaluate(STATS, box)
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(200)
            # Loop cut: pointing at an edge shows the cut, a click makes it.
            pg.click(".model-mesh-tool[data-tool=mesh-loopcut]")
            e = pg.evaluate(SCREEN, [0.5, 0.2, 0.5])
            pg.mouse.move(e["x"] + 2, e["y"])
            pg.wait_for_timeout(80)
            preview = pg.evaluate("() => window.__panel._modelView().stage.querySelectorAll('.model-mesh-handle .mh-cut').length")
            self._shot(pg, "mesh_tool_loopcut_hover.png")
            pg.mouse.down()
            pg.mouse.up()
            pg.wait_for_timeout(250)
            cut = pg.evaluate(STATS, box)
            cut_adjust = pg.evaluate("() => window.__panel._modelView().meshAdjustState()")
            # W puts the tool down: the gizmo is back.
            pg.click(".model-toolcol [data-tool=translate]")
            back = pg.evaluate("() => window.__panel._modelView().meshTool()")
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(tools, ["mesh-extrude", "mesh-inset", "mesh-bevel", "mesh-loopcut", "mesh-soft"])
        self.assertEqual(picked, {"tool": "extrude", "gizmo": False, "arrow": True})
        self.assertEqual(live["name"], "extrude")
        self.assertGreater(live["params"]["amount"], 0.2)
        self.assertEqual(mid["drawn"], 12)                 # the preview has the new vertices ...
        self.assertAlmostEqual(mid["top"], 0.5, places=4)  # ... the scene does not, yet
        self.assertIn("Extrude", mid["hud"])
        self.assertEqual((kept["verts"], kept["faces"]), (12, 10))
        self.assertAlmostEqual(kept_top, 0.5 + live["params"]["amount"], delta=0.05)
        self.assertEqual(adjust["name"], "extrude")
        self.assertAlmostEqual(adjusted_top, 1.5, places=3)
        self.assertEqual((adjusted["verts"], adjusted["faces"]), (12, 10))
        self.assertEqual((undone["verts"], undone["faces"]), (8, 6))     # one step for the drag and its adjusting
        self.assertTrue(box_gone)
        self.assertEqual(modal["name"], "extrude")
        self.assertEqual(dropped["verts"], 8)
        self.assertEqual(clicked["verts"], 12)
        self.assertGreater(inset_live["params"]["amount"], 0.01)
        self.assertEqual((inset["verts"], inset["faces"]), (12, 10))
        self.assertGreaterEqual(preview, 4)
        self.assertEqual(cut["verts"], 12)
        self.assertEqual(cut_adjust["name"], "loopcut")
        self.assertIsNone(back)


if __name__ == "__main__":
    unittest.main()
