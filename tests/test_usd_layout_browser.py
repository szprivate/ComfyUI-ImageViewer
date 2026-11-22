"""A layout stage opened as a scene: hundreds of models of ONE file (Pixar's Kitchen
Set is 425) must not ask the server for every model's prim tree at each redraw -
that storm took ComfyUI Desktop's page down. A USD model's Contents row is read
only once it is opened, and trees arriving together redraw the Outliner once.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html); the
routes are answered here (the prim tree) or refused (the display copies).
Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_usd_layout_browser
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

N = 400
OPEN = """async (n) => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const items = [{ id: 'g', kind: 'group', name: 'Props_grp', parent: null }];
  for (let i = 0; i < n; i++) items.push({ id: `m${i}`, kind: 'model', name: `Spoon_${i}`, parent: 'g',
    src: { path: '/stages/Kitchen_set.usd', prim: `/Kitchen_set/Props_grp/Spoon_${i}`, name: `Spoon_${i}`, format: 'usd' } });
  P._previzOpenScene({ version: 1, fps: 24, length: 10, items });
  P.previzChanged({ reload: true });
  P.setPanelDocked('previz', true);
  P._previzRenderPanel();
  return P.previzScene().items.length;
}"""

TREE = {"root": "/Kitchen_set/Props_grp/Spoon_0", "truncated": False, "variants": {},
        "prims": [{"rel": "Geom", "name": "Geom", "parent": "", "type": "Xform", "kind": "", "arcs": [],
                   "variants": {}, "visible": True, "active": True},
                  {"rel": "Geom/Mesh", "name": "Mesh", "parent": "Geom", "type": "Mesh", "kind": "", "arcs": [],
                   "variants": {}, "visible": True, "active": True}]}


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class LayoutStageTests(unittest.TestCase):
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

    def test_hundreds_of_models_of_one_stage_ask_for_no_tree_until_one_is_opened(self):
        import json
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors, trees = [], []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        def tree(route):
            trees.append(route.request.url)
            route.fulfill(status=200, content_type="application/json", body=json.dumps(TREE))
        pg.route("**/imageviewer/usd_tree**", tree)
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            # The group, the models - and the scene's hidden default view camera.
            self.assertEqual(pg.evaluate(OPEN, N), N + 2)
            pg.wait_for_timeout(1500)
            # Redraws of the whole Outliner meanwhile: none of them asked for a tree.
            for _ in range(3):
                pg.evaluate("() => window.__panel._previzRenderPanel()")
            pg.wait_for_timeout(300)
            self.assertEqual(trees, [], "no prim tree is asked for before a Contents row is opened")
            heads = pg.evaluate("""() => [...window.__panel.previzPanel.querySelectorAll('.previz-prim')]
                .map((r) => r.querySelector('.previz-name').textContent)""")
            self.assertEqual(len(heads), N, heads[:3])
            self.assertTrue(all(h == "Contents" for h in heads), heads[:3])
            # Opening one asks for that one only, and its prims are drawn.
            pg.evaluate("""() => window.__panel.previzPanel.querySelector('.previz-prim .previz-twisty').click()""")
            pg.wait_for_function("""() => [...window.__panel.previzPanel.querySelectorAll('.previz-prim .previz-name')]
                .some((n) => n.textContent === 'Mesh')""", timeout=5000)
            self.assertEqual(len(trees), 1, trees)
            self.assertIn("prim=%2FKitchen_set%2FProps_grp%2FSpoon_0", trees[0])
            heads = pg.evaluate("""() => [...window.__panel.previzPanel.querySelectorAll('.previz-prim .previz-name')]
                .map((n) => n.textContent).slice(0, 3)""")
            self.assertEqual(heads[0], "Contents (2 prims)", heads)
            # Searching uses the trees known and asks for no others.
            pg.evaluate("""() => { const s = window.__panel.previzPanel.querySelector('.ol-search');
                s.value = 'Mesh'; s.dispatchEvent(new Event('input', { bubbles: true })); }""")
            pg.wait_for_timeout(300)
            self.assertEqual(len(trees), 1, trees)
            self.assertEqual(errors, [])
        finally:
            pg.close()


if __name__ == "__main__":
    unittest.main()
