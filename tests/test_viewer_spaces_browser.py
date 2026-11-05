"""Renders go into the one Viewer tab as groups, and the bar opens each space, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html):

- a send naming a tab (the agent's, or a Send to Viewer node's) is a group of the Viewer tab, not a tab;
- a new render is put on screen only while the newest one is (live, or the top snapshot picked); looking
  at an older one, or at another tab, it waits in the History;
- "Open 3D…" / "Open Edit…" bring up the tab of that kind that is open, else make an empty one.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_viewer_spaces_browser
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
  const { app } = await import('/scripts/app.js');   // the stand-in's graph is empty
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  window.__send = (name, tab, extra = {}) => P.updateData({ unique_id: '50', tab_name: tab,
      tabs: { tab: [{ path: `D:/out/${name}.png`, filename: `${name}.png`, type: 'output', ...extra }] } }, null);
  window.__shown = () => { const f = (P.allTabs[P.activeTab] || [])[P.isViewingHistory ? 0 : 0] || {};
      const s = P.agentViewerState(); return { tab: P.activeTab, item: s.item ? s.item.path : null, group: s.item ? s.item.group : null,
      tabs: Object.keys(P.allTabs), history: P.history.all.length }; };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ViewerSpacesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA="1")
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
        # The harness serves no three.js: a 3D tab's viewport cannot load here, which is not what is tested.
        pg.on("pageerror", lambda e: None if "three.module.js" in str(e) else self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("() => localStorage.clear()")
        pg.evaluate(SETUP)
        return pg

    def shown(self, pg):
        return pg.evaluate("() => window.__shown()")

    def test_sends_are_groups_of_the_viewer_tab_and_the_newest_is_followed(self):
        pg = self.page()
        pg.evaluate("() => { __send('a', 'agentY', { group: 'Characters' }); __send('b', 'side by side'); }")
        st = self.shown(pg)
        self.assertEqual(st["tabs"], ["folder_history"], "no tab per send")
        self.assertEqual((st["tab"], st["item"], st["group"]), ("folder_history", "D:/out/b.png", "side by side"))
        groups = pg.evaluate("() => window.__panel.history.all.map((s) => s[0].group)")
        self.assertEqual(groups, ["side by side", "Characters"], "a group the frames carry is kept")
        # The newest snapshot picked in the strip still counts as the newest: the next render follows.
        pg.evaluate("() => window.__panel.openHistorySnapshot('all', 0)")
        pg.evaluate("() => __send('c', 'agentY')")
        self.assertEqual(self.shown(pg)["item"], "D:/out/c.png")
        self.assertEqual(self.errors, [])

    def test_an_older_snapshot_or_another_tab_stays_on_screen(self):
        pg = self.page()
        pg.evaluate("() => { __send('a', 'agentY'); __send('b', 'agentY'); }")
        pg.evaluate("() => window.__panel.openHistorySnapshot('all', 1)")
        self.assertEqual(self.shown(pg)["item"], "D:/out/a.png")
        pg.evaluate("() => __send('c', 'agentY')")
        st = self.shown(pg)
        self.assertEqual(st["item"], "D:/out/a.png", "looking at an older one: it stays")
        self.assertEqual(st["history"], 3, "the new render is in the History")
        # On another tab (an empty 3D scene), a render does not take the user off it.
        pg.evaluate("() => window.__panel.spaceOpen('3d')")
        pg.evaluate("() => __send('d', 'agentY')")
        st = self.shown(pg)
        self.assertEqual(st["tab"], "previz:new-1")
        self.assertEqual(st["history"], 4)
        self.assertEqual(self.errors, [])

    def test_open_3d_and_open_edit_reuse_the_open_tab_else_make_one(self):
        pg = self.page()
        pg.evaluate("() => window.__panel.spaceOpen('3d')")
        pg.evaluate("() => window.__panel.spaceOpen('3d')")
        tabs = pg.evaluate("() => window.__panel.tabOrder")
        self.assertEqual([t for t in tabs if t.startswith("previz:")], ["previz:new-1"], "the open 3D tab is reused")
        self.assertTrue(pg.evaluate("() => window.__panel.isPrevizTab('previz:new-1')"), "an empty scene")
        pg.evaluate("() => window.__panel.spaceOpen('edit')")
        pg.wait_for_timeout(200)
        st = pg.evaluate("() => ({ active: window.__panel.activeTab, cuts: window.__panel.tabOrder.filter((k) => k.startsWith('edit:')) })")
        self.assertEqual(len(st["cuts"]), 1)
        self.assertEqual(st["active"], st["cuts"][0])
        pg.evaluate("() => window.__panel.switchTab('previz:new-1')")
        pg.evaluate("() => window.__panel.spaceOpen('edit')")
        pg.wait_for_timeout(200)
        st2 = pg.evaluate("() => ({ active: window.__panel.activeTab, cuts: window.__panel.tabOrder.filter((k) => k.startsWith('edit:')) })")
        self.assertEqual(st2, st, "the open cut comes back, no second one")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
