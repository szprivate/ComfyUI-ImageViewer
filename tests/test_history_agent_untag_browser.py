"""Taking an agentY tag off a picture, in a real browser: the REAL viewer js against stubbed ComfyUI scripts.

The right-click menu lists "Remove tag #name" once per tag the picture wears, the badge
in the strip has a x, and both go through window.agentYViewerBridge.untag. A tag that
comes from an `agentY add tag` node on the canvas is only cleared after the dialog's
button (bridge.clearCanvasTag). Afterwards the badge and the filter's "agentY tags"
group follow at once (the "agenty-tags-changed" window event). The filter offers
"Manage tags..." when the bridge can open the page. Names and file names are text,
never markup.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest discover -s tests -p test_history_agent_untag_browser.py
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

XSS = '<img src=x onerror="window.__xss=1">'
SETUP = """async (XSS) => {
  const P = window.__panel;
  window.__calls = [];
  window.__tagList = [{ tag: 'hero_face', path: 'D:/out/a.png', source: 'canvas', nodes: [{ id: '12', title: 'hero tag' }] },
                      { tag: 'set', path: 'D:/out/b.png', source: 'memory' },
                      { tag: 'Set', path: 'D:/out/b.png', source: 'memory' },
                      { tag: XSS, path: 'D:/out/c.png', source: 'memory' }];
  const changed = (detail) => window.dispatchEvent(new CustomEvent('agenty-tags-changed', { detail }));
  window.agentYViewerBridge = {
    version: 1, state: () => ({ halted: false }),
    tag: async () => ({ ok: true }), approve: async () => ({ ok: true }),
    tags: async () => window.__tagList.map((t) => ({ ...t })),
    untag: async ({ tag, path }) => {
      window.__calls.push(['untag', tag, path]);
      const t = window.__tagList.find((x) => x.tag === tag && x.path === path);
      if (t && t.source === 'canvas') return { ok: false, removed: false, canvas: t.nodes,
        message: `This tag comes from canvas node #12 'hero tag' - remove it there, or clear that node's tag field.` };
      // one tag, whatever its spelling ("set" and "Set" are one entry in the store)
      window.__tagList = window.__tagList.filter((x) => !(x.tag.toLowerCase() === tag.toLowerCase() && x.path === path));
      changed({ untagged: [{ tag, path }] });
      return { ok: true, removed: true, canvas: [], message: `Removed #${tag} from this picture.` };
    },
    clearCanvasTag: ({ tag, path }) => {
      window.__calls.push(['clear', tag, path]);
      window.__tagList = window.__tagList.filter((x) => !(x.tag === tag && x.path === path));
      changed({ untagged: [{ tag, path }] });
      return { ok: true, message: 'Cleared the tag field of canvas node #12.' };
    },
    manageTags: (o) => { window.__calls.push(['manage', o.anchor && o.anchor.getRootNode() === P.shadowRoot]); return true; },
  };
  if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
  const key = P.activeTab || 'main';
  P.activeTab = key;
  P.history[key] = ['c', 'b', 'a'].map((n) => [{ path: `D:/out/${n}.png`, filename: n === 'c' ? `${XSS}.png` : `${n}.png`,
                                                  type: 'output', label: n === 'c' ? XSS : '' }]);
  P._historyPanelSig = null;
  P.renderHistoryPanel();
  await P.refreshAgentTags();
  return key;
}"""

SNAP = """() => {
  const P = window.__panel, R = P.shadowRoot, sel = R.querySelector('.history-tag-filter');
  const thumbs = [...R.querySelectorAll('.history-thumb')];
  return {
    badges: thumbs.map((t) => [...t.querySelectorAll('.history-agent-tag > span:first-child')].map((s) => s.textContent)),
    groups: [...sel.querySelectorAll('optgroup')].map((g) => [...g.children].map((o) => o.textContent)),
    injected: R.querySelectorAll('.history-strip img[src="x"], .history-agent-tags img, .thumb-ctx-menu img').length,
    xss: window.__xss || 0,
  };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class AgentUntagTests(unittest.TestCase):
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
        pg.evaluate(SETUP, XSS)
        return pg

    def thumb(self, pg, n):
        # strip order is newest first: c, b, a
        return pg.locator("bepic-viewer-panel .history-thumb").nth(n)

    def menu_rows(self, pg):
        return pg.evaluate("() => [...window.__panel.shadowRoot.querySelectorAll('.thumb-ctx-menu .thumb-ctx-item')].map((e) => e.textContent)")

    def test_badges_show_every_tag_once_and_as_text(self):
        pg = self.page()
        snap = pg.evaluate(SNAP)
        self.assertEqual(snap["badges"], [["#" + XSS], ["#set"], ["#hero_face"]])
        # "set" and "Set" are one tag
        self.assertEqual(snap["groups"], [["#" + XSS, "#hero_face", "#set", "Manage tags…"]])
        self.assertEqual((snap["injected"], snap["xss"]), (0, 0))

    def test_remove_a_remembered_tag_from_the_menu(self):
        pg = self.page()
        self.thumb(pg, 1).click(button="right")
        rows = self.menu_rows(pg)
        self.assertIn("✕ Remove tag #set", rows)
        self.assertIn("🏷 Manage tags…", rows)
        pg.locator("bepic-viewer-panel .thumb-ctx-item", has_text="Remove tag #set").click()
        pg.wait_for_function("() => window.__panel.shadowRoot.querySelectorAll('.history-thumb')[1].querySelectorAll('.history-agent-tag').length === 0")
        self.assertEqual(pg.evaluate("window.__calls"), [["untag", "set", "D:/out/b.png"]])
        snap = pg.evaluate(SNAP)
        self.assertEqual(snap["badges"][1], [])
        self.assertEqual(snap["groups"], [["#" + XSS, "#hero_face", "Manage tags…"]])
        self.assertEqual(self.errors, [])

    def test_the_badge_x_removes_it_too(self):
        pg = self.page()
        self.thumb(pg, 0).hover()
        self.thumb(pg, 0).locator(".history-agent-tag-x").click()
        pg.wait_for_function("() => window.__panel.shadowRoot.querySelectorAll('.history-thumb')[0].querySelectorAll('.history-agent-tag').length === 0")
        self.assertEqual(pg.evaluate("window.__calls")[0][:2], ["untag", XSS])
        self.assertEqual(pg.evaluate(SNAP)["xss"], 0)
        # the click did not open the picture
        self.assertFalse(pg.evaluate("window.__panel.isViewingHistory"))

    def test_a_canvas_tag_is_cleared_only_after_the_dialog(self):
        pg = self.page()
        self.thumb(pg, 2).click(button="right")
        pg.locator("bepic-viewer-panel .thumb-ctx-item", has_text="Remove tag #hero_face").click()
        dlg = pg.locator("bepic-viewer-panel .agenty-untag-dialog")
        dlg.wait_for(timeout=5000)
        self.assertIn("canvas node #12 'hero tag'", dlg.inner_text())
        self.assertEqual(pg.evaluate("window.__calls"), [["untag", "hero_face", "D:/out/a.png"]])
        self.assertEqual(pg.evaluate(SNAP)["badges"][2], ["#hero_face"])     # still there
        # "Keep it" changes nothing
        dlg.locator("button", has_text="Keep it").click()
        self.assertEqual(pg.locator("bepic-viewer-panel .agenty-untag-dialog").count(), 0)
        self.assertEqual(len(pg.evaluate("window.__calls")), 1)
        # again, and this time clear the node's field
        self.thumb(pg, 2).click(button="right")
        pg.locator("bepic-viewer-panel .thumb-ctx-item", has_text="Remove tag #hero_face").click()
        pg.locator("bepic-viewer-panel .agenty-untag-dialog button", has_text="Clear node #12").click()
        pg.wait_for_function("() => window.__panel.shadowRoot.querySelectorAll('.history-thumb')[2].querySelectorAll('.history-agent-tag').length === 0")
        self.assertEqual(pg.evaluate("window.__calls")[-1], ["clear", "hero_face", "D:/out/a.png"])
        self.assertEqual(self.errors, [])

    def test_manage_tags_from_the_filter_opens_in_the_viewer_root(self):
        pg = self.page()
        pg.evaluate("""() => { const sel = window.__panel.shadowRoot.querySelector('.history-tag-filter');
                              sel.value = '__manage_tags__'; sel.dispatchEvent(new Event('change')); }""")
        self.assertEqual(pg.evaluate("window.__calls"), [["manage", True]])
        # the filter itself did not change
        self.assertEqual(pg.evaluate("window.__panel.shadowRoot.querySelector('.history-tag-filter').value"), "")
        self.assertEqual(pg.evaluate("window.__panel.historyTagFilter || ''"), "")

    def test_show_path_opens_the_history_item(self):
        pg = self.page()
        self.assertTrue(pg.evaluate("() => window.__panel.agentShowPath('D:\\\\out\\\\b.png')"))
        self.assertEqual(pg.evaluate("[window.__panel.isViewingHistory, window.__panel.currentHistoryIndex]"), [True, 1])
        self.assertFalse(pg.evaluate("() => window.__panel.agentShowPath('D:/out/nope.png')"))

    def test_an_older_bridge_has_no_remove_rows(self):
        pg = self.page()
        pg.evaluate("""async () => { const b = window.agentYViewerBridge; delete b.untag; delete b.manageTags;
                                      window.__panel._historyPanelSig = null; window.__panel.renderHistoryPanel(); }""")
        self.thumb(pg, 1).click(button="right")
        rows = self.menu_rows(pg)
        self.assertFalse([r for r in rows if "Remove tag" in r or "Manage tags" in r], rows)
        self.assertEqual(pg.locator("bepic-viewer-panel .history-agent-tag-x").count(), 0)


if __name__ == "__main__":
    unittest.main()
