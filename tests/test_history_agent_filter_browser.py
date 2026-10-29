"""agentY's tags in the history filter, in a real browser: the REAL viewer js against stubbed ComfyUI scripts.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_history_agent_filter_browser
The page's window.agentYViewerBridge.tags() is a stub that returns what agentY's `#` menu list would.
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

BS = chr(92) * 2   # a Windows path's backslash, written for JS source
SETUP = """async () => {
  const P = window.__panel;
  window.__tagList = [{ tag: 'hero_face', path: 'D:{BS}out{BS}a.png', source: 'canvas' },
                      { tag: 'set', path: 'D:/out/b.png', source: 'memory' }];
  window.agentYViewerBridge = { tags: async () => window.__tagList.map((t) => ({ ...t })) };
  const key = P.activeTab || 'main';
  P.activeTab = key;
  P.history[key] = ['c', 'b', 'a'].map((n) => [{ path: `D:/out/${n}.png`, filename: `${n}.png`, type: 'output' }]);
  P._historyPanelSig = null;
  P.renderHistoryPanel();
  await P.refreshAgentTags();
  return key;
}"""

SETUP = SETUP.replace("{BS}", BS)
SNAP = """() => {
  const P = window.__panel, sel = P.shadowRoot.querySelector('.history-tag-filter');
  return { groups: [...sel.querySelectorAll('optgroup')].map((g) => ({ label: g.label, options: [...g.children].map((o) => o.textContent) })),
           thumbs: P.shadowRoot.querySelectorAll('.history-strip .history-thumb, #history-strip .history-thumb').length,
           value: sel.value };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class AgentTagFilterTests(unittest.TestCase):
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
        pg.evaluate(SETUP)
        return pg

    def test_the_tags_are_a_group_of_the_filter_and_pick_their_pictures(self):
        pg = self.page()
        snap = pg.evaluate(SNAP)
        self.assertEqual(snap["groups"], [{"label": "agentY tags", "options": ["#hero_face", "#set"]}])
        self.assertEqual(snap["thumbs"], 3)
        pg.evaluate("() => window.__panel.setHistoryTagFilter('agent:hero_face')")
        snap = pg.evaluate(SNAP)
        self.assertEqual((snap["value"], snap["thumbs"]), ("agent:hero_face", 1))
        self.assertEqual(self.errors, [])

    def test_a_new_tag_and_a_rename_reach_the_list(self):
        pg = self.page()
        pg.evaluate("""async () => { window.__tagList.push({ tag: 'extra', path: 'D:/out/c.png' });
                                      await window.__panel.refreshAgentTags(); }""")
        self.assertEqual(pg.evaluate(SNAP)["groups"][0]["options"], ["#extra", "#hero_face", "#set"])
        pg.evaluate("""async () => { window.__panel.setHistoryTagFilter('agent:set');
                                      window.__tagList[1].tag = 'stage'; await window.__panel.refreshAgentTags(); }""")
        snap = pg.evaluate(SNAP)
        self.assertEqual(snap["groups"][0]["options"], ["#extra", "#hero_face", "#stage"])
        # the filter named a tag that is gone: everything shows again
        self.assertEqual((snap["value"], snap["thumbs"]), ("", 3))

    def test_a_tag_made_in_the_viewer_joins_without_the_bridge_list(self):
        pg = self.page()
        pg.evaluate("""async () => { window.__panel._agentTags = { 'D:/out/c.png': 'mine' };
                                      await window.__panel.refreshAgentTags(); window.__panel.setHistoryTagFilter('agent:mine'); }""")
        snap = pg.evaluate(SNAP)
        self.assertEqual((snap["value"], snap["thumbs"]), ("agent:mine", 1))

    def test_no_bridge_no_group(self):
        pg = self.page()
        pg.evaluate("""async () => { window.agentYViewerBridge = undefined; window.__panel._agentTagIndex = null;
                                      window.__panel._agentTagSig = null; window.__panel._syncHistoryTagFilter(); }""")
        self.assertEqual(pg.evaluate(SNAP)["groups"], [])


if __name__ == "__main__":
    unittest.main()
