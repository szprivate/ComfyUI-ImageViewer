"""Chisel's depth from the 3D space, in a real browser: the REAL viewer js against stubbed ComfyUI scripts
(tests/harness/tabs.html), three.js served from vendor/three as the server does. A box in front of the camera
shows up in Model3DView.renderDepth at its distance along the view axis; the sky and the grid do not.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_chisel_depth_browser
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

BOX_DEPTH = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  const view = P._modelView();
  const { THREE } = view.libs;
  const it = P.previzSelectedItem();
  const entry = view._entries.get(it.id);
  const obj = entry.object || entry.body || view._bodyOf(entry);
  obj.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(obj);
  const cam = view.activeCameraObject();
  cam.lookAt(box.getCenter(new THREE.Vector3()));
  cam.updateMatrixWorld(true);
  // The planar distance to the box's centre, and how far its corners reach either side of it.
  const inv = cam.matrixWorld.clone().invert();
  const zs = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z])
    zs.push(-new THREE.Vector3(x, y, z).applyMatrix4(inv).z);
  if (!view.beginRender({ grid: false, helpers: false })) return { error: 'busy' };
  let d;
  try { d = view.renderDepth(160, 90); } finally { view.endRender(); }
  if (!d) return { error: 'no depth' };
  let hit = 0;
  for (const v of d.data) if (v > 0) hit++;
  return { w: d.w, h: d.h, centre: d.data[45 * 160 + 80], corner: d.data[0], bottom: d.data[89 * 160 + 2],
           near: Math.min(...zs), far: Math.max(...zs), hit, canvasW: view.canvas.width };
}"""

# An Atlas world stand-in: a textured quad (an OBJ with uvs, its picture half red, half blue) loaded as a model,
# then its views and its point cloud (imageViewer_atlas3d.js).
ATLAS_SHOW = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  const obj = 'v -1 -1 -5\\nv 1 -1 -5\\nv 1 1 -5\\nv -1 1 -5\\nvt 0 0\\nvt 1 0\\nvt 1 1\\nvt 0 1\\nf 1/1 2/2 3/3\\nf 1/1 3/3 4/4\\n';
  const url = URL.createObjectURL(new Blob([obj], { type: 'text/plain' }));
  const world = S.makeModelItem({ url, name: 'world.obj' }, 'Atlas: court');
  const scene = P.previzScene();
  scene.items.push(world);
  await P.previzChanged();
  const view = P._modelView();
  for (let i = 0; i < 100; i++) {
    const e = view._entries.get(world.id);
    if (e && e.object) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const entry = view._entries.get(world.id);
  if (!entry || !entry.object) return { error: 'no model ' + (entry && entry.error) };
  const { THREE } = view.libs;
  // Its picture: left half red, right half blue.
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
  const g = cv.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 32, 64); g.fillStyle = '#0000ff'; g.fillRect(32, 0, 32, 64);
  const tex = new THREE.CanvasTexture(cv);
  entry.object.traverse((o) => { if (o.isMesh) { const m = view._originals.get(o) || o.material; (Array.isArray(m) ? m[0] : m).map = tex; } });
  view.atlasSetViews(world.id, [
    { id: 0, right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], pos: [0, 0, 0], image: 'D:/o/court/view_000.png', aspect: 16 / 9, fov: 50 },
    { id: 1, right: [0, 0, 1], up: [0, 1, 0], fwd: [1, 0, 0], pos: [-2, 0, -5], image: 'D:/o/court/view_001.png', aspect: 1, fov: 40 },
  ]);
  view.applyFrame(view.sceneFrame);
  const views = view.atlasViewsInfo(world.id);
  // The point cloud.
  world.atlasPoints = true;
  view.applyFrame(view.sceneFrame);
  const pts = [];
  entry.object.traverse((o) => { if (o.isPoints) pts.push(o); });
  const meshesShown = (() => { let n = 0; entry.object.traverse((o) => { if (o.isMesh && o.visible) n++; }); return n; })();
  const colours = pts.length ? Array.from(pts[0].geometry.attributes.color.array) : [];
  const xs = pts.length ? Array.from(pts[0].geometry.attributes.position.array).filter((_, i) => i % 3 === 0) : [];
  // The depth pass still sees the mesh, and no view.
  const cam = view.activeCameraObject();
  cam.position.set(0, 0, 0); cam.lookAt(0, 0, -5); cam.updateMatrixWorld(true);
  if (!view.beginRender({ grid: false, helpers: true })) return { error: 'busy' };
  let d, viewsInRender;
  try {
    d = view.renderDepth(64, 36);
    viewsInRender = view._atlasViewsShown.get(world.id).group.visible;
  } finally { view.endRender(); }
  const viewsAfter = view._atlasViewsShown.get(world.id).group.visible;
  world.atlasPoints = false;
  world.atlasViews = false;
  view.applyFrame(view.sceneFrame);
  let ptsLeft = 0; entry.object.traverse((o) => { if (o.isPoints) ptsLeft++; });
  return { views, points: pts.length, meshesShown, colours, xs, centre: d && d.data[18 * 64 + 32],
           viewsInRender, viewsAfter, viewsOff: view.atlasViewsInfo(world.id), ptsLeft,
           parsed: S.parseScene(S.serializeScene({ ...scene, items: [{ ...world, atlasPoints: true, atlasViews: false }] })).items[0] };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ChiselDepthTests(unittest.TestCase):
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

    def test_a_box_in_front_of_the_camera_is_in_the_depth_map(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if "failed to wake up" in m.text else None)
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate(BOX_DEPTH)
        finally:
            pg.close()
        self.assertNotIn("error", st)
        self.assertEqual((st["w"], st["h"]), (160, 90))
        self.assertGreater(st["centre"], st["near"] - 1e-3, "the box's face, not in front of it")
        self.assertLess(st["centre"], st["far"])
        self.assertEqual(st["corner"], 0, "the sky is nothing")
        self.assertGreater(st["hit"], 50)
        self.assertLess(st["hit"], 160 * 90, "the grid and the floor of nothing do not count")
        self.assertEqual(errors, [])

    def test_an_atlas_world_shows_its_views_and_as_a_point_cloud(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            st = pg.evaluate(ATLAS_SHOW)
        finally:
            pg.close()
        self.assertNotIn("error", st)
        self.assertEqual(st["views"]["count"], 2)
        self.assertEqual(st["views"]["ids"], [0, 1])
        self.assertTrue(st["views"]["shown"])
        self.assertGreater(st["points"], 0)
        self.assertEqual(st["meshesShown"], 0, "the mesh is drawn as its points")
        # Each vertex coloured from the picture: the left ones red, the right ones blue.
        cols = [st["colours"][i:i + 3] for i in range(0, len(st["colours"]), 3)]
        for x, c in zip(st["xs"], cols):
            if x < 0:
                self.assertGreater(c[0], 0.9, (x, c)); self.assertLess(c[2], 0.1)
            else:
                self.assertGreater(c[2], 0.9, (x, c)); self.assertLess(c[0], 0.1)
        self.assertAlmostEqual(st["centre"], 5, delta=0.05, msg="the depth pass measures the mesh, not the points")
        self.assertFalse(st["viewsInRender"], "views are never in a picture")
        self.assertTrue(st["viewsAfter"])
        self.assertEqual(st["viewsOff"]["count"], 0)
        self.assertEqual(st["ptsLeft"], 0)
        self.assertTrue(st["parsed"].get("atlasPoints"))
        self.assertIs(st["parsed"].get("atlasViews"), False)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
