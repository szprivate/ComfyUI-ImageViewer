"""Comp's 3D nodes drawn by the 3D space's renderer (js/imageViewer_comp3dEngine.js), in a real browser with the
real three.js (tests/harness/tabs.html, vendor/three served as the server does).

A Card with a picture in front of a Camera, through Render3D: the 3D space's renderer and Comp's own (built-in)
make the same picture and the same depth.z; a Light lights a Card; a SceneFile's box (a scene of the 3D space)
shows in the picture and a Camera follows the scene's camera.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_comp_3d_engine_browser
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

RUN = """async () => {
  const C = await import('/extensions/viewer/imageViewer_compModel.js');
  const { Comp3DEngine } = await import('/extensions/viewer/imageViewer_comp3dEngine.js');
  const eng = new Comp3DEngine(document.body);
  const ok = await eng.ensure();
  if (!ok) return { skip: eng.why };
  const N = (type, id, inputs, params = {}) => Object.assign(C.makeNode({ nodes: [] }, type, params), { id, inputs });
  const comp = (nodes, out) => ({ comp: 1, format: { width: 64, height: 48, fps: 24, frames: 4 }, nodes, output: out });
  const nodes = (renderer, extra = []) => [N('constant', 'Constant1', [], { color: [1, 0.5, 0.25, 1] }),
      N('card3d', 'card3d1', ['Constant1'], { rotate: [0, 20, 0] }), N('camera3d', 'camera3d1', [], { translate: [0, 0, 2] }),
      ...extra, N('render3d', 'render3d1', [extra.length ? 'scene3d1' : 'card3d1', 'camera3d1', null], { samples: 2, renderer })];
  const out = {};
  const stats = (img) => {
    let a = 0, r = 0, n = 0;
    for (let i = 0; i < img.w * img.h; i++) { const al = img.data[i * 4 + 3]; a += al; if (al > 0.99) { r += img.data[i * 4]; n++; } }
    return { alpha: a, red: n ? r / n : 0 };
  };
  const cpu = C.renderNode(comp(nodes('built-in'), 'render3d1'), 'render3d1', 0, {});
  const gpu = C.renderNode(comp(nodes('3D space'), 'render3d1'), 'render3d1', 0, { engine3d: eng });
  let diff = 0, dz = 0, both = 0;
  for (let i = 0; i < cpu.data.length; i++) diff = Math.max(diff, Math.abs(cpu.data[i] - gpu.data[i]));
  const zc = cpu.ch['depth.z'], zg = gpu.ch && gpu.ch['depth.z'];
  if (zg) for (let i = 0; i < zc.length; i++) if (zc[i] > 0 && zg[i] > 0) { both++; dz = Math.max(dz, Math.abs(zc[i] - zg[i])); }
  out.card = { cpu: stats(cpu), gpu: stats(gpu), diff, dz, both, hasZ: !!zg, w: gpu.w, h: gpu.h };
  // Lit by a light from the front: the picture is still there and the light's colour shows.
  const lit = C.renderNode(comp(nodes('3D space', [N('light3d', 'light1', [], { light: 'directional', rotate: [0, 0, 0], color: [0, 1, 0, 1], intensity: 1 }),
      N('scene3d', 'scene3d1', ['card3d1', 'light1', null, null])]), 'render3d1'), 'render3d1', 0, { engine3d: eng });
  let g = 0, rr = 0;
  for (let i = 0; i < lit.w * lit.h; i++) { g += lit.data[i * 4 + 1]; rr += lit.data[i * 4]; }
  out.lit = { green: g, red: rr };
  // A SceneFile: a box of the 3D space, and a Camera following the scene's camera.
  const scene = { items: [
      { id: 'b1', kind: 'primitive', shape: 'box', name: 'Box', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { id: 'c1', kind: 'camera', name: 'shotCam', position: [0, 0.5, 4], rotation: [0, 0, 0], scale: [1, 1, 1], fov: 30 } ],
      render: { start: 1, end: 10 } };
  const sf = N('scenefile3d', 'sf1', [], { file: 'tab:x' });
  const cam = N('camera3d', 'camera3d1', ['sf1'], { from_scene: 'shotCam' });
  const rn = N('render3d', 'render3d1', ['sf1', 'camera3d1', null], { samples: 1 });
  const sc = comp([sf, cam, rn], 'render3d1');
  await eng.prepareScene('sf1', scene, 'k1');
  const got = { scene, key: 'k1' };
  const img = C.renderNode(sc, 'render3d1', 0, { engine3d: eng, sceneSource: () => got });
  out.scene = stats(img);
  out.needs = C.sourceNeeds(sc, 'render3d1', 0).map((x) => ({ id: x.node.id, scene: !!x.scene, engine: !!x.engine }));
  eng.dispose();
  return out;
}"""

# A Comp tab with SceneFile "tab:<3D tab>" -> Render3D: the 3D tab's box is in the comp's picture, and a sphere
# added in the 3D tab afterwards shows in the comp too (followed live).
PANEL = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const key3d = P.activeTab;
  await P.previzAddPrimitive('box');
  const label = P._cpSceneTabs()[0].label;
  const C = await import('/extensions/viewer/imageViewer_compModel.js');
  P._cpShowDoc('/tmp/x.comp.json', C.newComp({ width: 160, height: 90 }));
  let rec;
  for (let i = 0; i < 100; i++) { rec = Object.values(P._cpState().tabs).find(r => r.editor); if (rec) break; await sleep(50); }
  if (!rec) return { error: 'no comp tab' };
  const keyComp = P.activeTab;
  const ed = rec.editor;
  const sf = ed.addNode('scenefile3d', { file: 'tab:' + label });
  const cam = ed.addNode('camera3d', { translate: [0, 0.5, 6] });
  const rn = ed.addNode('render3d', {});
  rn.inputs[0] = sf.id; rn.inputs[1] = cam.id; ed.comp().output = rn.id; ed.refresh(); ed.view(rn.id);
  const lit = () => { const c = ed.canvas; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i - 3] + d[i - 2] + d[i - 1] > 30) n++; return n; };
  for (let i = 0; i < 60 && !(rec.engine && rec.engine.ready && lit() > 0); i++) await sleep(100);
  await sleep(300);
  const before = lit(), sig1 = rec.engine.sig;
  P.switchTab(key3d);
  await sleep(200);
  const sph = await P.previzAddPrimitive('sphere');
  const it = P.previzSelectedItem(); it.position = [2, 0, 0]; await P.previzChanged({ reload: true });
  P.switchTab(keyComp);
  for (let i = 0; i < 60 && rec.engine.sig === sig1; i++) await sleep(100);
  await sleep(500);
  return { before, after: lit(), sig1, sig2: rec.engine.sig, ready: rec.engine.ready, got: [...rec.sceneGot.values()].map(g => g.key) };
}"""


ROOM = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  P.setViewerToggleState(true);
  const C = await import('/extensions/viewer/imageViewer_compModel.js');
  P._cpShowDoc('/tmp/room.comp.json', C.newComp({ width: 160, height: 90 }));
  let rec;
  for (let i = 0; i < 100; i++) { rec = Object.values(P._cpState().tabs).find(r => r.editor); if (rec) break; await sleep(50); }
  if (!rec) return { error: 'no comp tab' };
  const ed = rec.editor;
  const k = ed.addNode('constant', { color: [1, 0.5, 0.2, 1] });
  ed.comp().output && (C.nodeById(ed.comp(), ed.comp().output).inputs[0] = k.id);
  ed.select([k.id]);
  const rn = ed.addNode('render3d', {});
  const card = ed.comp().nodes.find(n => n.type === 'card3d'), cam = ed.comp().nodes.find(n => n.type === 'camera3d');
  const starter = { card: card && card.inputs[0] === k.id, wired: rn.inputs[0] === (card && card.id) && rn.inputs[1] === (cam && cam.id) };
  ed.view(rn.id);
  const ok = await ed.engineReady();
  if (!ok) return { ready: false, starter };
  const btn = (rec.el && rec.el.querySelector('.cp-3d')) || P.shadowRoot.querySelector('.cp-3d');
  if (!btn) return { error: 'no 3D button', starter };
  btn.click();
  for (let i = 0; i < 60 && !(rec.engine.roomInfo() && rec.engine.roomInfo().objects >= 2); i++) await sleep(100);
  ed.select([card.id]);
  await sleep(200);
  const free = rec.engine.view.activeCameraObject() === rec.engine.view.camera;
  const keyR = rec.engine.roomKey('r') && rec.engine._room.gizmo.mode; rec.engine.roomKey('w');
  const info1 = rec.engine.roomInfo();
  const room = rec.engine._room, hist0 = ed.state.hist.past.length;
  room.gizmo.dispatchEvent({ type: 'dragging-changed', value: true });
  room.proxy.position.set(0.5, 0.25, -1);
  room.proxy.rotation.set(0, Math.PI / 4, 0, 'XYZ');
  room.gizmo.dispatchEvent({ type: 'objectChange' });
  room.gizmo.dispatchEvent({ type: 'dragging-changed', value: false });
  await sleep(300);
  const moved = { translate: card.translate, rotate: card.rotate };
  const canvasW = rec.engine.view.canvas.clientWidth;
  await ed.setRoom(false);
  const info2 = rec.engine.roomInfo();
  return { ready: true, starter, info1, free, keyR, moved, canvasW, closed: info2 === null, hidden: rec.engine.box.style.visibility,
    hist: ed.state.hist.past.length - hist0, warn: P.shadowRoot.querySelectorAll('.cp-wbadge').length };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class Comp3DEngineTests(unittest.TestCase):
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

    def test_render3d_through_the_3d_space_matches_comps_own_renderer(self):
        pg = self.browser.new_page(viewport={"width": 1200, "height": 800})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate(RUN)
        finally:
            pg.close()
        if "skip" in st:
            self.skipTest(st["skip"])
        card = st["card"]
        self.assertEqual((card["w"], card["h"]), (64, 48))
        self.assertGreater(card["cpu"]["alpha"], 100)
        self.assertAlmostEqual(card["gpu"]["alpha"], card["cpu"]["alpha"], delta=card["cpu"]["alpha"] * 0.03)
        self.assertAlmostEqual(card["gpu"]["red"], 1, delta=0.01, msg="unlit: the picture as it is, linear")
        self.assertLess(card["diff"], 0.6, "only the edges differ (sampling)")
        self.assertTrue(card["hasZ"])
        self.assertGreater(card["both"], 100)
        self.assertLess(card["dz"], 0.02, "the same planar depth")
        self.assertGreater(st["lit"]["green"], 10, "the green light lights the card")
        self.assertGreater(st["scene"]["alpha"], 50, "the SceneFile's box is in the picture")
        self.assertEqual([n for n in st["needs"] if n["scene"]], [{"id": "sf1", "scene": True, "engine": False}])
        self.assertEqual(errors, [])

    def test_a_scenefile_follows_a_3d_tab_live(self):
        pg = self.browser.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate(PANEL)
        finally:
            pg.close()
        self.assertNotIn("error", st)
        if not st["ready"]:
            self.skipTest("no float render targets")
        self.assertGreater(st["before"], 100, "the 3D tab's box is in the comp's picture")
        self.assertNotEqual(st["sig1"], st["sig2"], "the 3D tab's change reached the comp's renderer")
        self.assertGreater(st["after"], st["before"], "the sphere added in the 3D tab shows in the comp")
        self.assertEqual(errors, [])

    def test_the_3d_room_shows_the_scene_and_its_gizmo_moves_the_card(self):
        pg = self.browser.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate(ROOM)
        finally:
            pg.close()
        self.assertNotIn("error", st, st)
        self.assertEqual(st["starter"], {"card": True, "wired": True}, "a Render3D after a picture comes with a Card and a Camera")
        if not st["ready"]:
            self.skipTest("no float render targets")
        self.assertTrue(st["info1"]["shown"])
        self.assertTrue(st["info1"]["camera"], "the render camera is drawn")
        self.assertGreaterEqual(st["info1"]["objects"], 2)
        self.assertEqual(st["info1"]["gizmo"], "Card1", "selecting the Card in the graph puts the gizmo on it")
        self.assertTrue(st["free"], "the room is looked at through its free camera, not a scene camera")
        self.assertEqual(st["keyR"], "scale")
        self.assertGreater(st["canvasW"], 300, "the room fills the picture's place")
        self.assertEqual(st["moved"]["translate"], [0.5, 0.25, -1])
        self.assertAlmostEqual(st["moved"]["rotate"][1], 45, places=1)
        if st["hist"] is not None:
            self.assertEqual(st["hist"], 1, "one undo step for the drag")
        self.assertTrue(st["closed"])
        self.assertEqual(st["hidden"], "hidden")
        self.assertEqual(st["warn"], 0)
        self.assertEqual(errors, [])

    def test_the_renderer_starts_in_another_window(self):
        # Popped out, the engine's canvas belongs to the other window: its WebGL 2 context is not an instance of
        # this window's WebGL2RenderingContext (the room then refused to open, "no float pictures").
        pg = self.browser.new_page()
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate("""async () => {
              const { Comp3DEngine } = await import('/extensions/viewer/imageViewer_comp3dEngine.js');
              const here = new Comp3DEngine(document.body); const base = await here.ensure();
              const f = document.createElement('iframe'); document.body.append(f);
              await new Promise((r) => setTimeout(r, 100));
              const e = new Comp3DEngine(f.contentDocument.body); const ok = await e.ensure();
              return { base, ok, why: e.why };
            }""")
        finally:
            pg.close()
        if not st["base"]:
            self.skipTest("no float render targets")
        self.assertTrue(st["ok"], st["why"])


if __name__ == "__main__":
    unittest.main()
