"""The 3D Curve Editor selects several keys and edits them together, in a real browser.

Sebastian 2026-11-12: marquee select and Shift+click on the keys, and moving a key or turning a
tangent applies to every selected key. Driven with the real mouse (Playwright's), on the REAL viewer
js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from vendor/three.

Needs Playwright with a Chromium and node; skipped without them.
Run: python -m unittest tests.test_previz_curves_multiselect_browser
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
SHOTS = os.environ.get("IMAGEVIEWER_TEST_SHOTS")   # a folder for screenshots, when set

# A box keyed at frames 0, 10 and 20 on translate; the Curve Editor docked and drawn.
SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  const it = P.previzSelectedItem();
  for (const f of [0, 10, 20]) { P.setFrame(f); P.previzKeyAll('position'); }
  // The values straight onto the keys: three curves apart from each other.
  const vals = { 0: [0, 0, 0], 10: [1, 2, -1], 20: [3, 1, 0] };
  for (const k of it.tracks.position) k.v = vals[k.f].slice();
  P.setFrame(5);
  P.setPanelDocked('curves', true);
  P.previzRefreshCurves();
  await new Promise((r) => setTimeout(r, 300));
  P.previzRefreshCurves();
  return it.id;
}"""

STATE = """() => {
  const P = window.__panel, h = P.curvesPanel;
  const it = P.previzSelectedItem();
  const dots = [...h.querySelectorAll('.kf-dot')].map((d) => {
    const r = d.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, axis: +d.dataset.axis, f: +d.dataset.f,
             chosen: d.classList.contains('chosen') };
  });
  const g = h.querySelector('.kf-graph').getBoundingClientRect();
  return { dots, graph: { l: g.left, t: g.top, r: g.right, b: g.bottom },
           keys: JSON.parse(JSON.stringify(it.tracks.position || [])),
           tans: h.querySelectorAll('.kf-tan').length,
           sel: (P._previzCurveSel || []).length };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class CurveMultiSelectTests(unittest.TestCase):
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
        return pg

    def _shot(self, pg, name):
        if not SHOTS:
            return
        os.makedirs(SHOTS, exist_ok=True)
        r = pg.evaluate("() => { const r = window.__panel.curvesPanel.getBoundingClientRect();"
                        " return { x: r.left, y: r.top, width: r.width, height: r.height }; }")
        pg.screenshot(path=os.path.join(SHOTS, name), clip=r)

    @staticmethod
    def _dot(st, axis, f):
        return next(d for d in st["dots"] if d["axis"] == axis and d["f"] == f)

    def test_shift_click_adds_and_a_drag_moves_every_selected_key(self):
        pg = self._page()
        try:
            st = pg.evaluate(STATE)
            self.assertEqual(len(st["dots"]), 9, "three keys on three channels")
            a, b = self._dot(st, 0, 10), self._dot(st, 1, 10)
            pg.mouse.click(a["x"], a["y"])
            pg.keyboard.down("Shift")
            pg.mouse.click(b["x"], b["y"])
            pg.keyboard.up("Shift")
            st = pg.evaluate(STATE)
            self.assertEqual(sorted((d["axis"], d["f"]) for d in st["dots"] if d["chosen"]), [(0, 10), (1, 10)])
            self.assertEqual(st["tans"], 4, "both selected keys show their two handles")
            self._shot(pg, "1-shift-click.png")

            # Shift+click again takes one away.
            pg.keyboard.down("Shift")
            pg.mouse.click(b["x"], b["y"])
            pg.keyboard.up("Shift")
            self.assertEqual(pg.evaluate(STATE)["sel"], 1)
            pg.keyboard.down("Shift")
            pg.mouse.click(b["x"], b["y"])
            pg.keyboard.up("Shift")

            # Drag one of them up and to the right: both move by the same value, the key retimes.
            st = pg.evaluate(STATE)
            a = self._dot(st, 0, 10)
            pg.mouse.move(a["x"], a["y"])
            pg.mouse.down()
            for i in range(1, 9):
                pg.mouse.move(a["x"] + i * 5, a["y"] - i * 3)
            pg.mouse.up()
            st = pg.evaluate(STATE)
            frames = [k["f"] for k in st["keys"]]
            self.assertEqual(len(frames), 3)
            self.assertEqual(frames[0], 0)
            self.assertEqual(frames[2], 20)
            self.assertGreater(frames[1], 10, "the key moved later")
            mid = st["keys"][1]["v"]
            dx, dy = mid[0] - 1, mid[1] - 2
            self.assertGreater(dx, 0)
            self.assertAlmostEqual(dx, dy, places=6, msg="x and y went up by the same amount")
            self.assertEqual(mid[2], -1, "z was not selected and kept its value")
            self.assertEqual(st["sel"], 2, "the selection followed the keys")
            self.assertEqual(self.errors, [])
        finally:
            pg.close()

    def test_a_marquee_selects_keys_and_a_tangent_turns_them_all(self):
        pg = self._page()
        try:
            st = pg.evaluate(STATE)
            g = st["graph"]
            first = [d for d in st["dots"] if d["f"] == 0]
            # A box around the frame-0 keys only, started on the empty graph left of them.
            x0, x1 = g["l"] + 2, first[0]["x"] + 12
            y0, y1 = g["t"] + 2, g["b"] - 2
            pg.mouse.move(x0, y0)
            pg.mouse.down()
            for i in range(1, 6):
                pg.mouse.move(x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5)
            self.assertEqual(pg.evaluate("() => !!window.__panel.curvesPanel.querySelector('.curves-marquee')"), True)
            self._shot(pg, "2-marquee.png")
            pg.mouse.up()
            st = pg.evaluate(STATE)
            self.assertEqual(sorted((d["axis"], d["f"]) for d in st["dots"] if d["chosen"]), [(0, 0), (1, 0), (2, 0)])
            self.assertFalse(pg.evaluate("() => !!window.__panel.curvesPanel.querySelector('.curves-marquee')"))

            # Ctrl+Shift+box adds the frame-20 keys too.
            last = [d for d in st["dots"] if d["f"] == 20]
            x0, x1 = last[0]["x"] - 12, g["r"] - 2
            pg.keyboard.down("Control"); pg.keyboard.down("Shift")
            pg.mouse.move(x0, y0); pg.mouse.down()
            for i in range(1, 6):
                pg.mouse.move(x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5)
            pg.mouse.up()
            pg.keyboard.up("Shift"); pg.keyboard.up("Control")
            st = pg.evaluate(STATE)
            self.assertEqual(st["sel"], 6)
            self.assertEqual(st["tans"], 6, "first keys have an out handle, last keys an in handle")
            self._shot(pg, "3-two-boxes.png")

            # Turn the out handle of the frame-0 x key: every frame-0 key's out tangent changes.
            h = pg.evaluate("""() => { const P = window.__panel, h = P.curvesPanel;
                const t = [...h.querySelectorAll('.kf-tan')].map((n) => n.getBoundingClientRect());
                t.sort((a, b) => a.left - b.left);
                return { x: t[0].left + t[0].width / 2, y: t[0].top + t[0].height / 2 }; }""")
            pg.mouse.move(h["x"], h["y"])
            pg.mouse.down()
            for i in range(1, 6):
                pg.mouse.move(h["x"] + i, h["y"] - i * 8)
            pg.mouse.up()
            st = pg.evaluate(STATE)
            out0 = st["keys"][0].get("to")
            self.assertIsNotNone(out0, "the first key has hand-set handles now")
            self.assertTrue(all(abs(v) > 1e-6 for v in out0[:3]) or sum(1 for v in out0 if abs(v) > 1e-6) >= 2,
                            f"several axes turned: {out0}")
            self.assertIsNotNone(st["keys"][2].get("ti"), "the last keys' handles turned with them")
            self._shot(pg, "4-tangents-together.png")

            # Del removes every selected key (frames 0 and 20).
            pg.keyboard.press("Delete")
            st = pg.evaluate(STATE)
            self.assertEqual([k["f"] for k in st["keys"]], [10])
            self.assertEqual(self.errors, [])
        finally:
            pg.close()


if __name__ == "__main__":
    unittest.main()
