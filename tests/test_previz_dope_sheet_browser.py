"""The 3D space's Dope Sheet, Curve Editor tools and Playblast, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three: two keyed boxes on the Dope Sheet, keys moved by a real mouse drag, scaled by the
selection bar's end, staggered across the objects, deleted / copied / pasted with the keys; the Curve
Editor's buffer, simplify, infinity and retime; a playblast whose frames are caught on their way to
the server, each with the heads-up display burnt in.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_previz_dope_sheet_browser
"""
import base64
import json
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
SHOTS = os.environ.get("DOPE_SHOTS")   # a folder: screenshots for a person to look at

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const S = await import('/extensions/viewer/imageViewer_scene3d.js');
  for (const [n, x] of [['A', 0], ['B', 2]]) {
    await P.previzAddPrimitive('box');
    const it = P.previzSelectedItem();
    it.name = n;
    for (const [f, y] of [[0, 0], [20, 3], [40, 0]]) S.setKeyframe(it, 'position', f, [x, y, 0]);
    P.previzChanged();
  }
  P.previzSelectAll();
  P.setPanelDocked('dopeSheet', true);
  P.dockTabFront && P.dockTabFront('dopeSheet');
  P.previzRefreshDopeSheet();
  P.setFrame(0);
  window.__S = S;
  return true;
}"""

STATE = """() => {
  const P = window.__panel, h = P.dopeSheetPanel;
  const items = P.previzScene().items;
  return { rows: [...h.querySelectorAll('.ds-row:not(.ds-head) .ds-name')].map((n) => n.textContent.replace(/^[\\u25b8\\u25be]/, '')),
           keys: h.querySelectorAll('.ds-key').length,
           on: h.querySelectorAll('.ds-key.on').length,
           frames: Object.fromEntries(items.map((it) => [it.name, (it.tracks.position || []).map((k) => k.f)])),
           sel: P.previzDopeSelection().length,
           visible: h.getBoundingClientRect().height > 0 };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class DopeSheetTests(unittest.TestCase):
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

    def _shot(self, pg, name, el=None):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            (el or pg).screenshot(path=os.path.join(SHOTS, name))

    # tabs.html holds two panels: everything is found through window.__panel, never by id.
    def _el(self, pg, js):
        return pg.evaluate_handle(f"() => {{ const P = window.__panel; return {js}; }}").as_element()

    def _key(self, pg, row, frame):
        return self._el(pg, f'P.dopeSheetPanel.querySelector(\'.ds-key[data-row="{row}"][data-f="{frame}"]\')')

    def test_dope_sheet_moves_scales_and_staggers_keys_across_objects(self):
        pg = self._page()
        try:
            st = pg.evaluate(STATE)
            self.assertTrue(st["visible"])
            self.assertEqual(st["rows"], ["Summary", "A", "translate", "B", "translate"])
            self.assertEqual(st["keys"], 15, "3 frames on each of the 5 rows")
            self._shot(pg, "dope-sheet.png", self._el(pg, "P.dopeSheetPanel"))

            # A click on the Summary's diamond at 20 selects frame 20 on both objects;
            # a real drag moves them together.
            k = self._key(pg, 0, 20)
            box = k.bounding_box()
            per = pg.evaluate("() => window.__panel._dsGeom().perFrame")
            pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            pg.mouse.down()
            pg.mouse.move(box["x"] + box["width"] / 2 + per * 5, box["y"] + box["height"] / 2, steps=6)
            pg.mouse.up()
            st = pg.evaluate(STATE)
            self.assertEqual(st["frames"], {"A": [0, 25, 40], "B": [0, 25, 40]})
            self.assertEqual(st["sel"], 2)
            self.assertTrue(pg.evaluate("() => window.__panel.previzCanUndo()"))

            # Undo puts both back in one step.
            pg.evaluate("() => window.__panel.previzUndo()")
            self.assertEqual(pg.evaluate(STATE)["frames"], {"A": [0, 20, 40], "B": [0, 20, 40]})

            # Box select everything, then scale by dragging the bar's right end to 60.
            pg.evaluate("() => window.__panel.previzDopeSelectAll()")
            hi = self._el(pg, "P.dopeSheetPanel.querySelector('.ds-handle.hi')")
            hb = hi.bounding_box()
            x60 = pg.evaluate("() => window.__panel._dsGeom().x(60)")
            pg.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
            pg.mouse.down()
            pg.mouse.move(x60, hb["y"] + hb["height"] / 2, steps=8)
            pg.mouse.up()
            self.assertEqual(pg.evaluate(STATE)["frames"], {"A": [0, 30, 60], "B": [0, 30, 60]})

            # Offset: B starts 4 frames after A.
            pg.evaluate("() => window.__panel.previzDopeStagger(4)")
            self.assertEqual(pg.evaluate(STATE)["frames"], {"A": [0, 30, 60], "B": [4, 34, 64]})
            self._shot(pg, "dope-sheet-offset.png", self._el(pg, "P.dopeSheetPanel"))

            # The keys answer while the sheet has the focus: Esc, a box, Delete, Ctrl+C / Ctrl+V.
            pg.evaluate("() => window.__panel._dsUi.body.focus()")
            pg.keyboard.press("Escape")
            self.assertEqual(pg.evaluate(STATE)["sel"], 0)
            a64 = self._key(pg, 3, 64).bounding_box()
            pg.mouse.move(a64["x"] + 20, a64["y"] - 3)
            pg.mouse.down()
            pg.mouse.move(a64["x"] - 6, a64["y"] + a64["height"] + 3, steps=4)
            pg.mouse.up()
            self.assertEqual(pg.evaluate(STATE)["sel"], 1, "the box took B's key at 64 only")
            pg.keyboard.press("Delete")
            self.assertEqual(pg.evaluate(STATE)["frames"]["B"], [4, 34])
            pg.evaluate("() => { const P = window.__panel; P._dsSetSelection([{id: P.previzScene().items[0].id, prop: 'position', f: 30}]); }")
            pg.keyboard.press("Control+c")
            pg.evaluate("() => window.__panel.setFrame(50)")
            pg.evaluate("() => window.__panel._dsUi.body.focus()")
            pg.keyboard.press("Control+v")
            st = pg.evaluate(STATE)
            self.assertIn(50, st["frames"]["A"], "pasted at the playhead")
            self.assertIn(50, st["frames"]["B"], "a copy of one object pastes onto every selected one")
            pg.keyboard.press("Period")
            self.assertEqual(sorted(pg.evaluate(STATE)["frames"]["A"]), [0, 30, 51, 60])
        finally:
            pg.close()
        self.assertEqual(self.errors, [])

    def test_curve_editor_tools(self):
        pg = self._page()
        try:
            out = pg.evaluate("""() => {
              const P = window.__panel, S = window.__S;
              P.setPanelDocked('curves', true); P.dockTabFront && P.dockTabFront('curves');
              const a = P.previzScene().items[0];
              P.previzSelect(a.id);
              P.previzRefreshCurves();
              const h = P.curvesPanel;
              const tools = [...h.querySelectorAll('.curves-tools .curves-tool')].map((b) => b.textContent);
              // Bake A into a key a frame, then simplify.
              for (let f = 0; f <= 40; f++) S.setKeyframe(a, 'position', f, S.valueAt(a, 'position', f), 'linear');
              P.previzChanged();
              const dense = a.tracks.position.length;
              P.previzCurveBufferSnap();
              const r = P.previzCurveSimplify(0.01);
              const buffered = h.querySelectorAll('path.curves-buffer').length;
              P.previzCurveInfinity('post', 'cycle');
              const inf = S.infinityOf(a, 'position');
              const dashed = h.querySelectorAll('path.curves-infinity.post').length;
              const yAt50 = S.valueAt(a, 'position', 50)[1], yAt10 = S.valueAt(a, 'position', 10)[1];
              P.previzCurveBufferSwap();
              const swapped = a.tracks.position.length;
              P.previzCurveBufferSwap();
              const retimed = P.previzCurveRetime(0, 40, 80, true);
              const last = a.tracks.position[a.tracks.position.length - 1].f;
              return { tools, dense, r, buffered, inf, dashed, yAt50, yAt10, swapped, retimed, last };
            }""")
            self._shot(pg, "curve-tools.png", self._el(pg, "P.curvesPanel"))
        finally:
            pg.close()
        self.assertEqual(out["tools"][:2], ["Buffer", "Swap"])
        self.assertIn("Retime…", out["tools"])
        self.assertEqual(out["dense"], 41)
        self.assertLess(out["r"]["after"], 12)
        self.assertGreaterEqual(out["buffered"], 1, "the buffer is drawn grey behind")
        self.assertEqual(out["inf"], {"pre": "constant", "post": "cycle"})
        self.assertGreaterEqual(out["dashed"], 1, "the cycle is drawn past the last key")
        self.assertGreater(out["yAt10"], 0.5)
        self.assertAlmostEqual(out["yAt50"], out["yAt10"], places=3)
        self.assertEqual(out["swapped"], 41, "swap brings the dense curve back")
        self.assertGreater(out["retimed"], 0)
        self.assertEqual(out["last"], 80)
        self.assertEqual(self.errors, [])

    def test_playblast_burns_the_hud_into_every_frame_and_lands_in_history(self):
        pg = self._page()
        frames, encoded = [], []

        def frame(route):
            body = json.loads(route.request.post_data)
            frames.append(body)
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"path": f"/out/{body['index']}.png", "dir": "/out"}))

        def encode(route):
            encoded.append(json.loads(route.request.post_data))
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"path": "/out/shot_playblast_v001.mp4",
                                           "relative": "previz/shot_playblast/v001/shot_playblast_v001.mp4"}))

        pg.route("**/imageviewer/previz_frame", frame)
        pg.route("**/imageviewer/previz_encode", encode)
        try:
            pg.evaluate("() => { const P = window.__panel; P.previzPlayblastDialog(); }")
            self.assertTrue(pg.evaluate("() => !!window.__panel._pbDlg.querySelector('.pb-box')"))
            self._shot(pg, "playblast-dialog.png", self._el(pg, "P._pbDlg.querySelector('.pb-box')"))
            pg.evaluate("() => { const P = window.__panel; P._landed = []; P.exportLanded = (p) => P._landed.push(...p);"
                        " document.querySelector('comfyui-image-viewer-panel'); }")
            pg.evaluate("() => window.__panel._pbDlg.remove()")
            res = pg.evaluate("""async () => {
              const P = window.__panel;
              const r = await P.previzPlayblast({ start: 0, end: 3, scale: 25, note: 'blocking pass' });
              return { ok: r.ok, frames: r.frames, where: r.where, landed: P._landed };
            }""")
            # The top band of the first frame is darker than the same pixels without the HUD.
            dark = pg.evaluate("""async (url) => {
              const img = new Image(); img.src = url; await img.decode();
              const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
              const g = c.getContext('2d'); g.drawImage(img, 0, 0);
              const band = g.getImageData(0, 4, img.width, 10).data;
              let bright = 0; for (let i = 0; i < band.length; i += 4) bright = Math.max(bright, band[i]);
              return { w: img.width, h: img.height, bright };
            }""", frames[0]["dataurl"])
            if SHOTS:
                with open(os.path.join(SHOTS, "playblast-frame.png"), "wb") as fh:
                    fh.write(base64.b64decode(frames[0]["dataurl"].split(",", 1)[1]))
        finally:
            pg.close()
        self.assertTrue(res["ok"])
        self.assertEqual(res["frames"], 4)
        self.assertEqual([f["index"] for f in frames], [0, 1, 2, 3])
        self.assertTrue(all(f["name"].endswith("_playblast") for f in frames))
        self.assertEqual(len(encoded), 1)
        self.assertEqual(res["landed"], ["/out/shot_playblast_v001.mp4"])
        self.assertGreater(dark["bright"], 150, "the HUD's white text is in the top band")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
