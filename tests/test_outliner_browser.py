"""The 3D Outliner in a real browser: its search field, its filter of kinds and its fold arrows.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three: a scene of a group with shapes in it, a camera and a lamp; typing into the search keeps
the matches and what they are in; Enter selects the matches; the filter hides a kind (its children
moving a level up) and is kept per viewer; Shift+click on an arrow folds a whole branch.

Needs Playwright with an installed browser and node; skipped without them.
Set OUTLINER_SHOTS to a folder to also save screenshots there.
Run: python -m unittest tests.test_outliner_browser
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
SHOTS = os.environ.get("OUTLINER_SHOTS")

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  try { P._viewerWindow().localStorage.removeItem('imageviewer.viewer.outlinerFilter'); } catch (_) {}
  P._olFilter = null;
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const scene = P.previzScene();
  const g = P.previzAddGroup(); P.previzRename(g.id, 'Set dressing');
  const shapes = [];
  for (const [t, n] of [['box', 'Crate'], ['sphere', 'Boulder'], ['box', 'Table']]) {
    await P.previzAddPrimitive(t);
    const it = P.previzSelectedItem(); P.previzRename(it.id, n); shapes.push(it.id);
  }
  P.previzMoveItems(shapes, g.id, null);
  const inner = P.previzAddGroup(); P.previzRename(inner.id, 'Props');
  P.previzMoveItems([inner.id], g.id, null);
  P.previzMoveItems([shapes[2]], inner.id, null);
  P.previzAddCamera(); P.previzRename(P.previzSelectedItem().id, 'shotCam');
  if (P.previzAddWorldItem) P.previzAddWorldItem('light');
  P.previzSelect(shapes[0]);
  P.setPanelDocked('previz', true);
  P._previzRenderPanel();
  return scene.items.length;
}"""

ROWS = """() => [...window.__panel.previzPanel.querySelectorAll('.previz-list > .previz-item')].map((r) => ({
  name: r.querySelector('.previz-name').textContent,
  depth: Math.round(parseFloat(r.querySelector('.ol-indent').style.width || '0') / 14),
  context: r.classList.contains('context'), selected: r.classList.contains('selected'),
  open: !!r.querySelector('.previz-twisty.open'), kind: r.dataset.kind }))"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class OutlinerTests(unittest.TestCase):
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
        pg.wait_for_timeout(300)
        return pg

    def _shot(self, pg, name, menu=False):
        if not SHOTS:
            return
        os.makedirs(SHOTS, exist_ok=True)
        box = pg.evaluate("""(menu) => { const r = window.__panel.previzPanel.getBoundingClientRect();
            const m = menu && window.__panel._olMenu && window.__panel._olMenu.menu.getBoundingClientRect();
            const x0 = Math.min(r.left, m ? m.left : 1e9), y0 = r.top, x1 = Math.max(r.right, m ? m.right : 0),
                  y1 = Math.max(Math.min(r.bottom, r.top + 420), m ? m.bottom + 8 : 0);
            return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }; }""", menu)
        pg.screenshot(path=os.path.join(SHOTS, name), clip=box)

    def test_search_filter_and_arrows(self):
        pg = self._page()
        try:
            rows0 = pg.evaluate(ROWS)
            self._shot(pg, "1-outliner.png")
            # Typing into the search field (a real keyboard): the matches and what they are in.
            search = pg.evaluate_handle("() => window.__panel.previzPanel.querySelector('.ol-search')").as_element()
            search.click()
            pg.keyboard.type("tab")
            pg.wait_for_timeout(100)
            rows_search = pg.evaluate(ROWS)
            hit = pg.evaluate("() => [...window.__panel.previzPanel.querySelectorAll('.ol-hit')].map((m) => m.textContent)")
            self._shot(pg, "2-search.png")
            # The viewer's own keys stayed away while typing (no tool change on 't', 'a', 'b').
            pg.keyboard.press("Enter")
            pg.wait_for_timeout(100)
            selected = pg.evaluate("() => window.__panel.previzSelectedIds().map((id) => window.__panel.previzScene().items.find((i) => i.id === id).name)")
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(100)
            cleared = pg.evaluate("() => window.__panel.previzPanel.querySelector('.ol-search').value")
            # The filter: hide groups with a real click in its menu.
            pg.evaluate_handle("() => window.__panel.previzPanel.querySelector('.ol-filter-btn')").as_element().click()
            pg.wait_for_timeout(100)
            pg.locator(".ol-kind-toggle[data-kind=camera]").click()
            pg.wait_for_timeout(100)
            self._shot(pg, "3-filter-menu.png", menu=True)
            pg.locator(".ol-kind-toggle[data-kind=group]").click()
            pg.wait_for_timeout(100)
            rows_filtered = pg.evaluate(ROWS)
            lit = pg.evaluate("() => window.__panel.previzPanel.querySelector('.ol-filter-btn').classList.contains('on')")
            kept = pg.evaluate("() => JSON.parse(window.__panel._viewerWindow().localStorage.getItem('imageviewer.viewer.outlinerFilter'))")
            pg.locator(".ol-menu-act.reset").click()
            pg.mouse.click(800, 500)
            pg.wait_for_timeout(100)
            menu_gone = pg.evaluate("() => !window.__panel._olMenu")
            # Shift+click on the top group's arrow folds the whole branch; a plain click opens only it.
            arrow = pg.evaluate_handle("() => window.__panel.previzPanel.querySelector('.previz-list > .previz-item .previz-twisty')").as_element()
            arrow.click(modifiers=["Shift"])
            pg.wait_for_timeout(100)
            rows_folded = pg.evaluate(ROWS)
            pg.evaluate_handle("() => window.__panel.previzPanel.querySelector('.previz-list > .previz-item .previz-twisty')").as_element().click()
            pg.wait_for_timeout(100)
            rows_one = pg.evaluate(ROWS)
            pg.evaluate("() => window.__panel.previzOutlinerFoldAll(true)")
            rows_all = pg.evaluate(ROWS)
        finally:
            pg.close()
        names0 = [r["name"] for r in rows0]
        self.assertEqual(names0[:6], ["Set dressing", "Crate", "Boulder", "Props", "Table", "shotCam"])
        self.assertEqual([r["depth"] for r in rows0[:5]], [0, 1, 1, 1, 2])
        self.assertTrue(rows0[0]["open"])
        self.assertEqual(rows0[1]["kind"], "primitive")
        self.assertTrue(rows0[1]["selected"])
        self.assertEqual([r["name"] for r in rows_search], ["Set dressing", "Props", "Table"])
        self.assertEqual([r["context"] for r in rows_search], [True, True, False])
        self.assertEqual(hit, ["Tab"])
        self.assertEqual(selected, ["Table"])
        self.assertEqual(cleared, "")
        filtered = [r["name"] for r in rows_filtered]
        self.assertNotIn("shotCam", filtered)
        self.assertNotIn("Set dressing", filtered)
        self.assertNotIn("Props", filtered)
        self.assertEqual([(r["name"], r["depth"]) for r in rows_filtered[:3]], [("Crate", 0), ("Boulder", 0), ("Table", 0)])
        self.assertTrue(lit)
        self.assertEqual(sorted(kept["hidden"]), ["camera", "group"])
        self.assertTrue(menu_gone)
        self.assertEqual([r["name"] for r in rows_folded][:2], ["Set dressing", "shotCam"])
        self.assertEqual([r["name"] for r in rows_one][:5], ["Set dressing", "Crate", "Boulder", "Props", "shotCam"])
        self.assertFalse([r for r in rows_one if r["name"] == "Props"][0]["open"])
        self.assertIn("Table", [r["name"] for r in rows_all])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
