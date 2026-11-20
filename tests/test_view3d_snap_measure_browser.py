"""Snapping, the measure tool and the timeline's cache marks of the 3D space, with the real mouse, in a real browser.

Sebastian 2026-11-20: a point / grid / geometry snapping tool in the 3D view's tool column that also
snaps to locators, a measure tool beside it, and the green cache marks on the timeline for image planes
(and for a film in the Viewer), as the Comp space has them. js/imageViewer_view3dSnap.js,
js/imageViewer_view3dMeasure.js, planeCacheTest in js/imageViewer_view3dVideoPlane.js and
renderCacheMarks in js/imageViewer_mixinPlayback.js.

Needs Playwright with an installed browser, node and ffmpeg (the film); skipped without them.
SNAP_SHOTS=<folder> saves screenshots.
Run: python -m unittest tests.test_view3d_snap_measure_browser
"""
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHOTS = os.environ.get("SNAP_SHOTS")

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  try { localStorage.removeItem('imageviewer.viewer.snap3d'); } catch (_) {}
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const v = P._modelView();
  v.setPaneLayout('single');
  const loc = P.previzAddLocator();
  loc.position = [3, 1, 2];
  const box = await P.previzAddPrimitive('box');
  const other = await P.previzAddPrimitive('box');
  other.position = [-3, 0, 0];
  await P.previzChanged({ reload: true });
  v.resetView();
  const cam = v.activeCameraObject();
  cam.position.set(4, 7, 11); v.controls.target.set(0, 0.5, 0); cam.lookAt(0, 0.5, 0); v.controls.update();
  P.previzSelect(box.id);
  v.setGizmoMode('translate');
  v.requestRender();
  return { loc: loc.id, box: box.id, other: other.id };
}"""

# A world point on screen (client pixels).
SCREEN = """(p) => {
  const v = window.__panel._modelView();
  const T = v.libs.THREE;
  const r = v.canvas.getBoundingClientRect();
  const q = new T.Vector3(...p).project(v.activeCameraObject());
  return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
}"""

ROOT_OF = """(id) => {
  const v = window.__panel._modelView();
  const e = v._entries.get(id); e.root.updateWorldMatrix(true, false);
  return new v.libs.THREE.Vector3().setFromMatrixPosition(e.root.matrixWorld).toArray();
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or shutil.which("ffmpeg") is None,
                 "needs playwright, node and ffmpeg")
class SnapMeasureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="iv_snap3d_")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        "testsrc=size=320x180:rate=24:duration=2", "-c:v", "libvpx", "-b:v", "300k",
                        os.path.join(cls.media, "plate.webm")], check=True)
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.media)
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
        shutil.rmtree(getattr(cls, "media", ""), ignore_errors=True)

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

    def _drag_centre(self, pg, start, to, steps=12):
        """Press the gizmo's centre (the free move) at `start` and let go at `to` (client pixels)."""
        pg.mouse.move(start["x"] + 30, start["y"] + 30)
        pg.wait_for_timeout(40)
        pg.mouse.move(start["x"], start["y"])
        pg.wait_for_timeout(60)
        axis = pg.evaluate("() => window.__panel._modelView().gizmo.axis")
        pg.mouse.down()
        pg.mouse.move(to["x"], to["y"], steps=steps)
        pg.wait_for_timeout(60)
        mark = pg.evaluate("""() => { const m = window.__panel._modelView()._snapMark;
            return m && m.style.display !== 'none' ? m.dataset.kind : null; }""")
        pg.mouse.up()
        pg.wait_for_timeout(100)
        return axis, mark

    def test_snapping_to_a_locator_a_point_and_the_grid(self):
        pg, ids = self._page()
        try:
            # The tool column has the magnet and the ruler.
            tools = pg.evaluate("""() => [...window.__panel._modelView().ui.tools.querySelectorAll('[data-tool]')]
                .map((b) => b.dataset.tool)""")
            # Off: a drag lands where the pointer leaves it, not on the locator.
            start = pg.evaluate(SCREEN, pg.evaluate(ROOT_OF, ids["box"]))
            loc = pg.evaluate(SCREEN, [3, 1, 2])
            self._drag_centre(pg, start, {"x": loc["x"] + 5, "y": loc["y"] + 4})
            off = pg.evaluate(ROOT_OF, ids["box"])
            pg.evaluate("() => window.__panel.previzUndo()")
            pg.wait_for_timeout(200)
            # On (the N key over the view): onto the locator's centre.
            pg.mouse.move(800, 500)
            pg.keyboard.press("n")
            on = pg.evaluate("() => window.__panel._modelView().snapOn()")
            start = pg.evaluate(SCREEN, pg.evaluate(ROOT_OF, ids["box"]))
            axis, mark = self._drag_centre(pg, start, {"x": loc["x"] + 5, "y": loc["y"] + 4})
            self._shot(pg, "snap_locator.png")
            at_loc = pg.evaluate(ROOT_OF, ids["box"])
            saved = pg.evaluate(f"() => window.__panel.previzScene().items.find((i) => i.id === '{ids['box']}').position")
            # Onto a corner of the other box: (-2.5, 1, 0.5) is its top corner.
            pg.evaluate("() => window.__panel._modelView().setSnapOptions({ locators: false, pivots: false })")
            corner = pg.evaluate(SCREEN, [-2.5, 1, 0.5])
            start = pg.evaluate(SCREEN, at_loc)
            _, mark2 = self._drag_centre(pg, start, {"x": corner["x"] + 4, "y": corner["y"] - 3})
            at_corner = pg.evaluate(ROOT_OF, ids["box"])
            # The grid alone: along X by hand, whole steps.
            pg.evaluate("() => window.__panel._modelView().setSnapOptions({ points: false, edges: false, surface: false })")
            step = pg.evaluate("() => window.__panel._modelView().gridEffective().spacing")
            start = pg.evaluate(SCREEN, at_corner)
            xend = pg.evaluate(SCREEN, [at_corner[0] + 1.37, at_corner[1], at_corner[2]])
            # The X handle: a little right of the centre along +X.
            xh = pg.evaluate(SCREEN, [at_corner[0] + 0.6, at_corner[1], at_corner[2]])
            pg.mouse.move(xh["x"], xh["y"])
            pg.wait_for_timeout(60)
            xaxis = pg.evaluate("() => window.__panel._modelView().gizmo.axis")
            pg.mouse.down()
            pg.mouse.move(xh["x"] + (xend["x"] - start["x"]), xh["y"] + (xend["y"] - start["y"]), steps=10)
            pg.mouse.up()
            pg.wait_for_timeout(100)
            on_grid = pg.evaluate(ROOT_OF, ids["box"])
        finally:
            pg.close()
        self.assertIn("snap", tools)
        self.assertIn("measure", tools)
        self.assertGreater(max(abs(off[0] - 3), abs(off[1] - 1), abs(off[2] - 2)), 0.05)
        self.assertTrue(on)
        self.assertEqual(axis, "XYZ")
        self.assertEqual(mark, "locator")
        for a, b in zip(at_loc, [3, 1, 2]):
            self.assertAlmostEqual(a, b, places=4)
        self.assertIsNotNone(saved)
        self.assertIn(mark2, ("point", "edge"))
        if mark2 == "point":
            for a, b in zip(at_corner, [-2.5, 1, 0.5]):
                self.assertAlmostEqual(a, b, places=4)
        self.assertEqual(xaxis, "X")
        self.assertAlmostEqual(on_grid[0] / step, round(on_grid[0] / step), places=4)
        self.assertNotAlmostEqual(on_grid[0], at_corner[0], places=3)
        self.assertAlmostEqual(on_grid[1], at_corner[1], places=4)
        self.assertAlmostEqual(on_grid[2], at_corner[2], places=4)
        self.assertEqual(self.errors, [])

    def test_measuring_a_distance_and_an_angle(self):
        pg, ids = self._page()
        try:
            pg.evaluate("() => window.__panel._modelView().ui.measureBtn.click()")
            on = pg.evaluate("() => window.__panel._modelView().measureActive()")
            gizmo = pg.evaluate("() => !!window.__panel._modelView().gizmo.object")
            # The locator's centre, the other box's top corner, then a point on the ground.
            for p in ([3, 1, 2], [-2.5, 1, 0.5]):
                s = pg.evaluate(SCREEN, p)
                pg.mouse.move(s["x"] + 3, s["y"] + 2)
                pg.mouse.click(s["x"] + 3, s["y"] + 2)
                pg.wait_for_timeout(60)
            g = pg.evaluate(SCREEN, [-2, 0, 4])
            pg.mouse.click(g["x"], g["y"])
            pg.wait_for_timeout(60)
            pg.keyboard.press("Enter")
            pg.wait_for_timeout(100)
            self._shot(pg, "measure.png")
            chains = pg.evaluate("() => window.__panel._modelView().measurements()")
            info = pg.evaluate("() => window.__panel._modelView()._msInfo.innerText")
            labels = pg.evaluate("""() => [...window.__panel._modelView()._msBox.querySelectorAll('.model-measure-label')]
                .filter((e) => e.style.display !== 'none').map((e) => e.textContent)""")
            # A measurement is not in a render.
            hidden = pg.evaluate("""() => { const v = window.__panel._modelView();
                v.beginRender(64, 36, {}); const vis = v._msGroup.visible; v.endRender(); return vis; }""")
            # Esc clears, Esc again puts the tool away; W brings the gizmo back.
            pg.mouse.move(800, 500)
            pg.keyboard.press("Escape")
            cleared = pg.evaluate("() => window.__panel._modelView().measurements().length")
            pg.keyboard.press("Escape")
            off = pg.evaluate("() => window.__panel._modelView().measureActive()")
            pg.keyboard.press("w")
            back = pg.evaluate("() => !!window.__panel._modelView().gizmo.object")
        finally:
            pg.close()
        self.assertTrue(on)
        self.assertFalse(gizmo)
        self.assertEqual(len(chains), 1)
        pts = chains[0]
        self.assertEqual(len(pts), 3)
        for a, b in zip(pts[0], [3, 1, 2]):
            self.assertAlmostEqual(a, b, places=4)
        for a, b in zip(pts[1], [-2.5, 1, 0.5]):
            self.assertAlmostEqual(a, b, places=4)
        self.assertAlmostEqual(pts[2][1], 0, places=4)
        self.assertIn("Total", info)
        self.assertIn("Angle at point 2", info)
        self.assertTrue(any(l.endswith("°") for l in labels))
        self.assertIn("5.701 m", " ".join(labels))         # |(3,1,2) - (-2.5,1,0.5)| = 5.701
        self.assertFalse(hidden)
        self.assertEqual(cleared, 0)
        self.assertFalse(off)
        self.assertTrue(back)
        self.assertEqual(self.errors, [])

    def test_the_timeline_marks_what_a_film_plane_and_a_viewer_film_hold(self):
        pg, ids = self._page()
        try:
            item = {"path": "D:/out/plate.webm", "url": None, "filename": "plate.webm", "subfolder": "", "type": None,
                    "external": True, "dropped": False, "kind": "video", "format": None, "thumb": None,
                    "isSequence": False, "seqDir": None, "seqCount": 0}
            pg.evaluate("""(items) => {
              const P = window.__panel;
              const dt = new DataTransfer();
              dt.setData('application/x-imageviewer-history', JSON.stringify({ items }));
              const r = P.viewport.getBoundingClientRect();
              const at = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
                           clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
              P.viewport.dispatchEvent(new DragEvent('dragover', at));
              P.viewport.dispatchEvent(new DragEvent('drop', at));
            }""", [item])
            pg.wait_for_function("""() => { const P = window.__panel; const it = P.previzScene().items.find((i) => i.kind === 'imageplane');
                const e = it && P._modelView()._entries.get(it.id); return !!(e && e.video && e.video.buffered.length); }""", timeout=15000)
            pg.wait_for_function("() => window.__panel.container.querySelector('#timeline-cache').children.length > 0", timeout=10000)
            plane = pg.evaluate("""() => { const v = window.__panel._modelView(); const has = v.planeCacheTest();
                const box = window.__panel.container.querySelector('#timeline-cache');
                return { f0: has(0), runs: box.children.length, w: box.firstElementChild.style.width }; }""")
            self._shot(pg, "cache_3d.png")
            # The Viewer: the film itself, marked as the browser buffers it.
            pg.evaluate("""(it) => window.__panel.showInViewerTab([[{ ...it, fps: 24, frames: 48 }]], { show: true })""", item)
            pg.wait_for_function("""() => { const P = window.__panel; return P._videoMode && P.videoBase.buffered.length
                && P.container.querySelector('#timeline-cache').children.length > 0; }""", timeout=15000)
            viewer = pg.evaluate("() => window.__panel.container.querySelector('#timeline-cache').children.length")
        finally:
            pg.close()
        self.assertTrue(plane["f0"])
        self.assertGreaterEqual(plane["runs"], 1)
        self.assertGreaterEqual(viewer, 1)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
