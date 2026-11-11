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


if __name__ == "__main__":
    unittest.main()
