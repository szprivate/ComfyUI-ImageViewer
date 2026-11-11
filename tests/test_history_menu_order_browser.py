"""The History thumbnail menu's order, in a real browser: the REAL viewer js against stubbed ComfyUI scripts.

Sebastian's order (2026-11-11), a line between the sections:
  Copy image path, Remove from history, Move to group
  VFX (films), Show dependencies, Load workflow (Edit in Motion / Paint after them)
  Tag as asset, the colour tags, agentY: approve - this last one ONLY while a run waits
"Load workflow" does what the Dependencies tab's "Open its workflow" does.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest discover -s tests -p test_history_menu_order_browser.py
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
  window.__halted = false;
  window.__calls = [];
  window.agentYViewerBridge = {
    version: 1, state: () => ({ halted: window.__halted }),
    tag: async () => ({ ok: true }), approve: async (o) => { window.__calls.push(['approve', o]); return { ok: true }; },
    tags: async () => [],
  };
  if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
  const key = P.activeTab || 'main';
  P.activeTab = key;
  P.history.all = [[{ fromTab: key, path: 'D:/out/clip.mp4', filename: 'clip.mp4', type: 'output' }],
                   [{ fromTab: key, path: 'D:/out/a.png', filename: 'a.png', type: 'output' }]];
  P._historyPanelSig = null;
  P.renderHistoryPanel();
  return key;
}"""

# The menu as shown: rows, the colour row as "(colours)", a visible separator as "--".
MENU = """() => {
  const m = window.__panel.shadowRoot.querySelector('#thumb-ctx-menu');
  if (!m) return null;
  return [...m.children].filter((e) => getComputedStyle(e).display !== 'none').map((e) =>
    e.classList.contains('thumb-ctx-sep') ? '--'
    : e.classList.contains('thumb-ctx-tags') ? '(colours)'
    : e.textContent.replace(/^\\S+\\s/, '').replace(/ [▸▾]$/, ''));
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class HistoryMenuOrderTests(unittest.TestCase):
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

    def menu(self, pg, n):
        pg.evaluate("() => window.__panel.shadowRoot.querySelector('#thumb-ctx-menu')?.remove()")
        pg.locator("comfyui-image-viewer-panel .history-thumb").nth(n).click(button="right")
        pg.wait_for_function("() => !!window.__panel.shadowRoot.querySelector('#thumb-ctx-menu')")
        return pg.evaluate(MENU)

    def test_a_film_in_sebastians_order_no_approve_while_nothing_waits(self):
        pg = self.page()
        self.assertEqual(self.menu(pg, 0), [
            "Copy image path", "Remove from history", "Move to group", "--",
            "VFX", "Show dependencies", "Load workflow", "--",
            "Tag as asset…", "(colours)",
        ])
        self.assertEqual(self.errors, [])

    def test_a_picture_has_no_vfx(self):
        pg = self.page()
        rows = self.menu(pg, 1)
        self.assertEqual(rows[:7], ["Copy image path", "Remove from history", "Move to group", "--",
                                    "Show dependencies", "Load workflow", "Edit in Paint"])
        self.assertEqual(rows[7:], ["--", "Tag as asset…", "(colours)"])

    def test_approve_is_last_and_only_while_a_run_waits(self):
        pg = self.page()
        pg.evaluate("() => { window.__halted = true; }")
        rows = self.menu(pg, 1)
        self.assertEqual(rows[-3:], ["Tag as asset…", "(colours)", "agentY: approve"])
        pg.locator("comfyui-image-viewer-panel .thumb-ctx-item", has_text="agentY: approve").click()
        pg.wait_for_function("() => window.__calls.length > 0")
        self.assertEqual(pg.evaluate("() => window.__calls[0][0]"), "approve")
        pg.evaluate("() => { window.__halted = false; }")
        self.assertNotIn("agentY: approve", self.menu(pg, 1))

    def test_several_selected_show_no_empty_section(self):
        pg = self.page()
        pg.locator("comfyui-image-viewer-panel .history-thumb").nth(0).click(modifiers=["Control"])
        pg.locator("comfyui-image-viewer-panel .history-thumb").nth(1).click(modifiers=["Control"])
        rows = self.menu(pg, 1)
        self.assertEqual(rows, ["Copy image path", "Remove 2 from history", "Move 2 to group", "--", "(colours)"])

    def test_load_workflow_asks_for_the_files_workflow_and_loads_it(self):
        pg = self.page()
        pg.evaluate("""() => {
          window.__wf = [];
          const P = window.__panel;
          P._depsOpenWorkflow = (ref) => { window.__wf.push(ref); };
        }""")
        self.menu(pg, 1)
        pg.locator("comfyui-image-viewer-panel .thumb-ctx-item", has_text="Load workflow").click()
        self.assertEqual(pg.evaluate("() => window.__wf"), ["D:/out/a.png"])
        self.assertFalse(pg.evaluate("() => !!window.__panel.shadowRoot.querySelector('#thumb-ctx-menu')"))


if __name__ == "__main__":
    unittest.main()
