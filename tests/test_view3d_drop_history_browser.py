"""History items dropped into the 3D space go INTO the scene, in a real browser (Sebastian 2026-11-12).

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js from vendor/three,
real media from a scratch folder (HARNESS_MEDIA_DIR, made with ffmpeg): a History payload dropped on the
3D view makes a picture an image plane shaped to it, a film an image plane whose frame is the scene's
(sought, never played; a render frame waits for the seek), and a splat or a 3D file a model item. A drop
on the Viewer tab still opens the item there.

The drop here is a synthetic DragEvent (Playwright's drags are faked too); the real-mouse drag from the
History strip is checked on ws26.

Needs Playwright with an installed browser, node and ffmpeg; skipped without them.
Run: python -m unittest tests.test_view3d_drop_history_browser
"""
import json
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

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  P._modelView().setPaneLayout('single');
  return true;
}"""

DROP = """(items) => {
  const P = window.__panel;
  const dt = new DataTransfer();
  dt.setData('application/x-imageviewer-history', JSON.stringify({ items }));
  const r = P.viewport.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
               clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  P.viewport.dispatchEvent(new DragEvent('dragover', at));
  P.viewport.dispatchEvent(new DragEvent('drop', at));
  return true;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _item(path, kind):
    return {"path": path, "url": None, "filename": os.path.basename(path), "subfolder": "", "type": None,
            "external": True, "dropped": False, "kind": kind, "format": None, "thumb": None,
            "isSequence": False, "seqDir": None, "seqCount": 0}


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or shutil.which("ffmpeg") is None,
                 "needs playwright, node and ffmpeg")
class DropHistoryInto3DTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="iv_drop3d_")
        run = lambda *a: subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *a], check=True)
        run("-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=2", "-c:v", "libvpx", "-b:v", "300k",
            os.path.join(cls.media, "plate.webm"))
        run("-f", "lavfi", "-i", "testsrc=size=200x400:rate=1:duration=1", "-frames:v", "1",
            os.path.join(cls.media, "tall.png"))
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

    def _page(self, setup=True):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        if setup:
            pg.evaluate(SETUP)
            pg.wait_for_timeout(200)
        return pg

    def _items(self, pg):
        return pg.evaluate("""() => window.__panel.previzScene().items.map((it) => ({
            kind: it.kind, name: it.name, src: it.src }))""")

    def test_a_picture_becomes_an_image_plane_shaped_to_it(self):
        pg = self._page()
        try:
            pg.evaluate(DROP, [_item("D:/out/tall.png", "image")])
            pg.wait_for_function("""() => { const P = window.__panel; const it = P.previzScene().items.find((i) => i.kind === 'imageplane');
                const e = it && P._modelView()._entries.get(it.id); return !!(e && e.plane && e.plane.material.map); }""", timeout=10000)
            items = self._items(pg)
            scale = pg.evaluate("""() => { const P = window.__panel; const it = P.previzScene().items.find((i) => i.kind === 'imageplane');
                const m = P._modelView()._entries.get(it.id).plane; return [m.scale.x, m.scale.y]; }""")
            tab = pg.evaluate("() => window.__panel.isPrevizTab()")
            undo = pg.evaluate("() => { window.__panel.previzUndo(); return window.__panel.previzScene().items.length; }")
        finally:
            pg.close()
        self.assertTrue(tab)
        self.assertEqual([i["kind"] for i in items], ["imageplane"])
        self.assertEqual(items[0]["src"]["path"], "D:/out/tall.png")
        self.assertAlmostEqual(scale[0], 0.5, places=3)
        self.assertAlmostEqual(scale[1], 1.0, places=3)
        self.assertEqual(undo, 0)
        self.assertEqual(self.errors, [])

    def test_a_film_becomes_an_image_plane_that_follows_the_scene_frame(self):
        pg = self._page()
        try:
            pg.evaluate(DROP, [_item("D:/out/plate.webm", "video")])
            pg.wait_for_function("""() => { const P = window.__panel; const it = P.previzScene().items.find((i) => i.kind === 'imageplane');
                const e = it && P._modelView()._entries.get(it.id); return !!(e && e.video && e.plane.material.map); }""", timeout=15000)
            info = pg.evaluate("""async () => { const P = window.__panel; const v = P._modelView();
                const it = P.previzScene().items.find((i) => i.kind === 'imageplane'); const e = v._entries.get(it.id);
                const fps = v.scene3d.fps || 24;
                v.applyFrame(12); await v.prepareVideoPlanes(12);
                const at12 = e.video.currentTime;
                v.applyFrame(500); await v.prepareVideoPlanes(500);
                const held = e.video.currentTime;
                return { kind: it.src.kind, fps, at12, held, dur: e.video.duration, paused: e.video.paused,
                         texture: !!e.plane.material.map.isVideoTexture, aspect: e.plane.scale.x }; }""")
        finally:
            pg.close()
        self.assertEqual(info["kind"], "video")
        self.assertTrue(info["texture"])
        self.assertTrue(info["paused"])
        self.assertAlmostEqual(info["at12"], 12.5 / info["fps"], places=3)
        # Past its end the last frame is held.
        self.assertLess(info["held"], info["dur"])
        self.assertGreater(info["held"], info["dur"] - 1.0 / info["fps"])
        self.assertAlmostEqual(info["aspect"], 320 / 180, places=3)
        self.assertEqual(self.errors, [])

    def test_splats_and_3d_files_are_imported_and_several_come_in_one_step(self):
        pg = self._page()
        try:
            pg.evaluate(DROP, [_item("D:/out/world.spz", "model"), _item("D:/out/chair.glb", "model"),
                               _item("D:/out/tall.png", "image")])
            pg.wait_for_function("() => window.__panel.previzScene().items.length === 3", timeout=10000)
            items = self._items(pg)
            undo = pg.evaluate("() => { window.__panel.previzUndo(); return window.__panel.previzScene().items.length; }")
        finally:
            pg.close()
        kinds = sorted(i["kind"] for i in items)
        self.assertEqual(kinds, ["imageplane", "model", "model"])
        paths = sorted(i["src"]["path"] for i in items if i["kind"] == "model")
        self.assertEqual(paths, ["D:/out/chair.glb", "D:/out/world.spz"])
        self.assertEqual(undo, 0)

    def test_drops_one_after_the_other_stand_side_by_side_and_take_the_scenes_size(self):
        pg = self._page()
        try:
            pg.evaluate(DROP, [_item("D:/out/tall.png", "image")])
            pg.wait_for_function("() => window.__panel.previzScene().items.length === 1", timeout=10000)
            pg.evaluate(DROP, [_item("D:/out/tall.png", "image")])
            pg.wait_for_function("() => window.__panel.previzScene().items.length === 2", timeout=10000)
            first = pg.evaluate("() => window.__panel.previzScene().items.map((i) => i.position)")
            # A scene in centimetres: Frame all has put the grid at 100.
            pg.evaluate("() => { window.__panel.previzScene().items.length = 0; window.__panel._modelView()._gridAutoScale = 100; return true; }")
            pg.evaluate(DROP, [_item("D:/out/tall.png", "image")])
            pg.wait_for_function("() => window.__panel.previzScene().items.length === 1", timeout=10000)
            big = pg.evaluate("() => { const i = window.__panel.previzScene().items[0]; return { s: i.scale, p: i.position }; }")
        finally:
            pg.close()
        self.assertAlmostEqual(first[1][0] - first[0][0], 2.0, places=5)
        self.assertAlmostEqual(first[1][1], first[0][1], places=5)
        self.assertEqual(big["s"], [100, 100, 100])
        # At the world origin, standing on the grid: the pivot is its foot (scene3d groundOffset).
        self.assertEqual(first[0], [0, 0, 0])
        self.assertAlmostEqual(big["p"][1], 0, places=3)

    def test_new_things_come_in_at_the_world_origin_standing_on_the_grid(self):
        # Sebastian 2026-11-12: a plane came in a few units above the grid. New things landed at the
        # orbit centre, which after Frame all on a model is the model's middle. Now: the origin.
        pg = self._page()
        try:
            got = pg.evaluate("""async () => {
              const P = window.__panel, view = P._modelView(), { THREE } = view.libs;
              view.controls.target.set(2, 3, -1); view.controls.update();
              const box = await P.previzAddPrimitive('box');
              const flat = await P.previzAddPrimitive('plane');
              const plane = P.previzAddImagePlane({ path: 'D:/out/tall.png', name: 'tall.png', external: true });
              const plane2 = P.previzAddImagePlane({ path: 'D:/out/tall.png', name: 'tall.png', external: true });
              const light = P.previzAddWorldItem('light', 'point');
              await new Promise((r) => setTimeout(r, 1500));
              const out = {};
              for (const [k, it] of Object.entries({ box, flat, plane, plane2, light })) {
                if (!it) continue;
                const e = view._entries.get(it.id);
                const b = e && new THREE.Box3().setFromObject(e.root);
                const pivot = e && e.root.getWorldPosition(new THREE.Vector3()).toArray();
                out[k] = { position: it.position, pivot, min: b && b.min.toArray(), max: b && b.max.toArray() };
              }
              return out;
            }""")
        finally:
            pg.close()
        for k in ("box", "flat", "plane"):
            self.assertEqual(got[k]["position"], [0, 0, 0], k)
            for a, b in zip(got[k]["pivot"], [0, 0, 0]):
                self.assertAlmostEqual(a, b, places=4, msg=k)
            self.assertAlmostEqual(got[k]["min"][1], 0, places=3, msg=k)   # on the grid, not under, not above
        self.assertAlmostEqual(got["box"]["max"][1], 1, places=3)
        self.assertAlmostEqual(got["plane"]["max"][1], 1, places=3)
        self.assertEqual(got["plane2"]["position"], [2, 0, 0])            # beside the first, not inside it
        if "light" in got:
            self.assertEqual(got["light"]["position"][0], 0)
            self.assertEqual(got["light"]["position"][2], 0)

    def test_a_drop_on_the_viewer_tab_still_opens_it_there(self):
        pg = self._page(setup=False)
        try:
            pg.evaluate("() => { window.__panel.setViewerToggleState(true); return true; }")
            pg.wait_for_timeout(200)
            calls = pg.evaluate("""(items) => { const P = window.__panel; const seen = [];
                const was = P._openDragItemsInViewer; P._openDragItemsInViewer = (x) => { seen.push(x.length); };
                const add = P.previzAddDropped; let added = 0; P.previzAddDropped = () => { added++; };
                const dt = new DataTransfer(); dt.setData('application/x-imageviewer-history', JSON.stringify({ items }));
                P.viewport.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
                P._openDragItemsInViewer = was; P.previzAddDropped = add;
                return { opened: seen, added, previz: P.isPrevizTab() }; }""", [_item("D:/out/tall.png", "image")])
        finally:
            pg.close()
        self.assertFalse(calls["previz"])
        self.assertEqual(calls["opened"], [1])
        self.assertEqual(calls["added"], 0)


if __name__ == "__main__":
    unittest.main()
