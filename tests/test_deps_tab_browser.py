"""The Dependencies tab, in a real browser: a plate on top, its depth pass below it, the render below that;
the stale render outlined; a click on a node opens it; many sibling passes fold into one node and unfold.

Needs Playwright with a browser and node for the stub server; skipped without them.
Run: python -m unittest tests.test_deps_tab_browser
It serves tests/harness/tabs.html - the REAL viewer js against stubbed ComfyUI scripts - on a free port, and
answers /imageviewer/deps from the page (window.__fetchApi), so no agentY host is needed.
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

STUB = """() => {
  const real = window.__fetchApi;
  window.__depsAsked = [];
  const passes = Array.from({length: 6}, (_, i) => ({id: `D:/out/mask_${i}.mp4`, file: `mask_${i}.mp4`,
      kind: 'mask', exists: true, stale: '', viewable: false}));
  const graph = {root: 'D:/out/depth.mp4', truncated: false,
    nodes: [
      {id: 'D:/in/plate.mp4', file: 'plate.mp4', kind: 'source', exists: true, stale: '', viewable: false},
      {id: 'D:/out/depth.mp4', file: 'depth.mp4', kind: 'depth', exists: true, stale: '', viewable: false, root: true},
      {id: 'D:/out/render.png', file: 'render.png', kind: 'render', exists: true,
       stale: 'plate.mp4 changed since this was made', viewable: false},
      ...passes],
    edges: [
      {from: 'D:/in/plate.mp4', to: 'D:/out/depth.mp4', kind: 'depth', label: 'DepthAnythingV2'},
      {from: 'D:/out/depth.mp4', to: 'D:/out/render.png', kind: 'render', label: 'flux_depth.json'},
      ...passes.map((p) => ({from: 'D:/in/plate.mp4', to: p.id, kind: 'mask', label: 'mask'}))]};
  window.__fetchApi = async (path, opts) => {
    if (String(path).startsWith('/imageviewer/deps')) {
      window.__depsAsked.push(String(path));
      return new Response(JSON.stringify(graph), {status: 200, headers: {'Content-Type': 'application/json'}});
    }
    return real(path, opts);
  };
}"""

NODES = """() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-node')].map((el) => ({
  label: el.querySelector('.dp-label').textContent, top: parseFloat(el.style.top),
  stale: el.classList.contains('stale'), root: el.classList.contains('root'), fold: el.classList.contains('fold')}))"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class DepsTabBrowserTests(unittest.TestCase):
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
        cls.server.terminate()
        cls.server.wait(5)

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(STUB)
        pg.evaluate("() => { window.__panel.setViewerToggleState(true); window.__panel.depsOpen('D:/out/depth.mp4'); }")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-node').length > 0",
                             timeout=10000)
        return pg

    def test_top_to_bottom_with_stale_and_fold(self):
        pg = self.page()
        self.assertIn("path=D%3A%2Fout%2Fdepth.mp4", pg.evaluate("() => window.__depsAsked[0]"))
        self.assertTrue(pg.evaluate("() => window.__panel.activeTab").startswith("deps:"))
        nodes = {n["label"]: n for n in pg.evaluate(NODES)}
        self.assertLess(nodes["plate.mp4"]["top"], nodes["depth.mp4"]["top"])
        self.assertLess(nodes["depth.mp4"]["top"], nodes["render.png"]["top"])
        self.assertTrue(nodes["depth.mp4"]["root"])
        self.assertTrue(nodes["render.png"]["stale"])
        self.assertFalse(nodes["depth.mp4"]["stale"])
        self.assertIn("6 mask passes", nodes)
        self.assertTrue(nodes["6 mask passes"]["fold"])
        self.assertEqual(len(pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-edge')]")), 3)
        # A click unfolds the passes.
        pg.evaluate("""() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-node.fold')][0].click()""")
        labels = [n["label"] for n in pg.evaluate(NODES)]
        self.assertEqual(sum(1 for x in labels if x.startswith("mask_")), 6)
        self.assertEqual(self.errors, [])

    def test_history_menu_offers_it(self):
        pg = self.page()
        got = pg.evaluate("""() => { const P = window.__panel;
          const f = {path: 'D:/out/p1.png', filename: 'p1.png', type: 'output', kind: 'image', external: true};
          P.pushHistorySnapshot('folder_history', [f]);
          P.showThumbContextMenu({clientX: 10, clientY: 10}, f, 'folder_history', 0);
          const m = P.container.querySelector('#thumb-ctx-menu');
          return [...m.querySelectorAll('.thumb-ctx-item')].map((x) => x.textContent); }""")
        self.assertTrue(any("Show dependencies" in x for x in got), got)


if __name__ == "__main__":
    unittest.main()
