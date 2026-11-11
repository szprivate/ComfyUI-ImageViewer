"""History thumbnails dropped onto the ComfyUI graph, in a real browser with real drag and drop: the REAL viewer js
against tests/harness/graph.html, a graph laid out as ComfyUI does (canvas, and the Nodes 2.0 pane over it).

Dropping onto a loader node swaps its file in place, with Nodes 2.0 on (the node is a DOM element over the canvas and
its image widget stops the drop from bubbling) and off (the node is drawn on the canvas). A drop on empty canvas makes
a new loader node.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_graph_drop_browser
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

SETUP = """async () => {
  const P = window.__panel;
  for (let i = 0; i < 100 && !(P.dockLayout && P.historyStrip); i++) await new Promise((r) => setTimeout(r, 50));
  Object.assign(P.style, { left: '920px', top: '20px', width: '560px', height: '800px' });
  if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
  const f = { path: 'D:/out/new.png', filename: 'new.png', type: 'output' };
  P.allTabs.folder_a = [f]; P.tabLabels.folder_a = 'Tab A';
  if (!P.tabOrder.includes('folder_a')) P.tabOrder.push('folder_a');
  P.pushHistorySnapshot('folder_a', [f]);
  P._rebuildTabBar(null); P.switchTab('folder_a');
  P._historyPanelSig = null; P.renderHistoryPanel();
  await new Promise((r) => setTimeout(r, 200));
}"""

STATE = """() => ({ values: window.__nodes.map((n) => n.widgets[0].value), added: window.__added,
                    zone: !!window.__zoneGot, doc: !!window.__docGot })"""

THUMB = "comfyui-image-viewer-panel .history-thumb"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class GraphDropTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
        cls.server = subprocess.Popen(["node", os.path.join(ROOT, "tests", "harness", "server.mjs"), ROOT], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/graph.html", timeout=1).read()
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
        pg.goto(f"http://127.0.0.1:{self.port}/graph.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_selector(THUMB, timeout=5000)
        return pg

    def drop(self, pg, target, x=None, y=None):
        kw = {"target_position": {"x": x, "y": y}} if x is not None else {}
        pg.drag_and_drop(THUMB, target, **kw)
        pg.wait_for_timeout(300)
        return pg.evaluate(STATE)

    def test_nodes_2_drop_on_the_image_widget_replaces_in_place(self):
        pg = self.page()
        s = self.drop(pg, "#zone1")
        self.assertEqual(s["values"], ["D:/out/new.png", "old.png", "old.png"])
        self.assertEqual(s["added"], [], "no new node")
        self.assertFalse(s["zone"] or s["doc"], "ComfyUI's own drop handling stays out of it")
        self.assertEqual(self.errors, [])

    def test_nodes_2_drop_on_the_node_title_replaces_in_place(self):
        pg = self.page()
        s = self.drop(pg, ".lg-node[data-node-id='1']", 100, 6)
        self.assertEqual(s["values"][0], "D:/out/new.png")
        self.assertEqual(s["added"], [])

    def test_classic_drop_on_a_canvas_node_replaces_in_place(self):
        pg = self.page()
        s = self.drop(pg, "#graph-canvas", 600, 200)
        self.assertEqual(s["values"], ["old.png", "D:/out/new.png", "old.png"])
        self.assertEqual(s["added"], [])

    def test_classic_drop_on_a_dom_widget_replaces_its_node(self):
        pg = self.page()
        s = self.drop(pg, "#domw", 50, 50)
        self.assertEqual(s["values"], ["old.png", "old.png", "D:/out/new.png"])

    def test_drop_on_empty_canvas_makes_a_new_loader(self):
        pg = self.page()
        s = self.drop(pg, "#graph-canvas", 200, 700)
        self.assertEqual(s["values"], ["old.png", "old.png", "old.png"])
        self.assertEqual(s["added"], ["VHS_LoadImagePath"])

    def _watch_tiles(self, pg):
        # Two more snapshots, so one can go while another is pressed; every tile taken out of the strip is counted.
        pg.evaluate("""async () => { const P = window.__panel;
            for (const n of ['b', 'c']) P.pushHistorySnapshot('folder_a', [{ path: `D:/out/${n}.png`, filename: `${n}.png`, type: 'output' }]);
            P._historyPanelSig = null; P.renderHistoryPanel(); await new Promise((r) => setTimeout(r, 100));
            window.__gone = [];
            new MutationObserver((ms) => ms.forEach((m) => m.removedNodes.forEach((n) => window.__gone.push(n.title || n.className))))
              .observe(P.historyStrip, { childList: true }); }""")

    def test_a_render_while_a_tile_is_pressed_waits_and_keeps_the_tile(self):
        # Chrome starts no drag from a tile taken out of the page between the press and the move (a render then:
        # the missing-file check took a snapshot away, and replaceChildren took every tile out and back).
        pg = self.page()
        self._watch_tiles(pg)
        n0 = pg.evaluate("() => window.__panel.historyStrip.querySelectorAll('.history-thumb').length")
        box = pg.locator(THUMB).last.bounding_box()
        pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        pg.mouse.down()
        pg.evaluate("() => { const P = window.__panel; P.removeHistoryItem(P.historyKey(), 0); P._historyPanelSig = null; P.renderHistoryPanel(); }")
        held = pg.evaluate("() => ({ n: window.__panel.historyStrip.querySelectorAll('.history-thumb').length, gone: window.__gone.length })")
        self.assertEqual(held, {"n": n0, "gone": 0}, "nothing leaves the strip while the tile is pressed")
        pg.mouse.up()
        pg.wait_for_timeout(100)
        after = pg.evaluate("() => ({ n: window.__panel.historyStrip.querySelectorAll('.history-thumb').length, gone: window.__gone.length })")
        self.assertEqual(after["n"], n0 - 1, "let go, the render is made")
        self.assertEqual(self.errors, [])

    def test_a_render_during_a_drag_waits_and_the_drop_still_lands(self):
        pg = self.page()
        self._watch_tiles(pg)
        pg.evaluate("""() => { const P = window.__panel; window.addEventListener('drop', () => { window.__goneAtDrop = window.__gone.length; }, true);
            P.historyStrip.addEventListener('dragstart', () => setTimeout(() => {
            P.removeHistoryItem(P.historyKey(), 0); P._historyPanelSig = null; P.renderHistoryPanel(); window.__rendered = true; }, 0)); }""")
        s = self.drop(pg, "#graph-canvas", 200, 700)
        self.assertTrue(pg.evaluate("() => !!window.__rendered"))
        self.assertEqual(s["added"], ["VHS_LoadImagePath"])
        self.assertEqual(pg.evaluate("() => window.__goneAtDrop"), 0, "no tile left the strip during the drag")
        self.assertEqual(pg.evaluate("() => window.__panel.historyStrip.querySelectorAll('.history-thumb').length"), 2,
                         "the render was made after it")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
