"""The viewer's history and its agent tabs survive a reload and a ComfyUI restart, in a real browser.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/restore.html). The page starts the
way ComfyUI does: agentY's bridge is already there, so the viewer's agentY tag watch runs the moment
the panel is attached, while the viewer's own start still waits for its userdata reads.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_viewer_restore_browser
"""
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
KEY = "bEpicViewer:state:v1:/restore.html"   # the state is kept per page path

AGENT = "named:agentY"
FRAMES = [{"filename": "shot_a.png", "subfolder": "", "type": "output", "path": "D:/out/agent/shot_a.png",
           "group": "Look dev", "label": "hero"}]
OLDER = [{"filename": "shot_0.png", "subfolder": "", "type": "output", "path": "D:/out/agent/shot_0.png",
          "group": "Look dev", "label": "first"}]
SAVED = {
    "version": 1,
    "allTabs": {AGENT: FRAMES},
    "history": {AGENT: [FRAMES, OLDER]},
    "tabViewState": {}, "tabLabels": {AGENT: "agentY"}, "tabColors": {},
    "historyTags": {}, "historyTagFilter": "",
    "tabOrder": [AGENT], "activeTab": AGENT,
    "savedAt": 1,
}

STATE = """() => {
  const P = window.__panel;
  let kept = null;
  try { kept = JSON.parse(localStorage.getItem('%s') || 'null'); } catch (_) {}
  return { tabs: Object.keys(P.allTabs), history: Object.fromEntries(Object.entries(P.history).map(([k, v]) => [k, v.length])),
           label: P.tabLabels['%s'] || '', active: P.activeTab,
           tabButtons: P.shadowRoot.querySelectorAll('.tab').length,
           keptTabs: kept ? Object.keys(kept.allTabs || {}) : null,
           keptHistory: kept ? Object.fromEntries(Object.entries(kept.history || {}).map(([k, v]) => [k, v.length])) : null };
}""" % (KEY, AGENT)


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ViewerRestoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
        cls.server = subprocess.Popen(["node", os.path.join(ROOT, "tests", "harness", "server.mjs"), ROOT], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/restore.html", timeout=1).read()
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

    def open_viewer(self, pg, delay=600):
        pg.goto(f"http://127.0.0.1:{self.port}/restore.html?delay={delay}")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.wait_for_timeout(400)   # past the 150 ms of a queued save
        return pg.evaluate(STATE)

    def new_page(self):
        pg = self.browser.new_page(viewport={"width": 1400, "height": 900})   # a context of its own
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        # The saved state, as the session before the restart left it (same origin, another page).
        pg.goto(f"http://127.0.0.1:{self.port}/seed")   # nothing there: a 404 page of the same origin
        pg.evaluate("([k, v]) => localStorage.setItem(k, v)", [KEY, json.dumps(SAVED)])
        return pg

    def assert_restored(self, st):
        self.assertEqual(st["tabs"], [AGENT])
        self.assertEqual(st["history"], {AGENT: 2})
        self.assertEqual(st["label"], "agentY")
        self.assertEqual(st["active"], AGENT)
        self.assertEqual(st["keptTabs"], [AGENT], "the saved state was overwritten")
        self.assertEqual(st["keptHistory"], {AGENT: 2})

    def test_agent_tab_and_history_come_back_after_a_slow_start(self):
        pg = self.new_page()
        self.assert_restored(self.open_viewer(pg))
        self.assertEqual(self.errors, [])

    def test_a_restart_after_new_work_keeps_both(self):
        pg = self.new_page()
        self.assert_restored(self.open_viewer(pg))
        # new work lands in the agent tab, then ComfyUI restarts (the page loads again)
        pg.evaluate("""() => { const P = window.__panel, k = '%s';
            const f = [{ filename: 'shot_b.png', subfolder: '', type: 'output', path: 'D:/out/agent/shot_b.png' }];
            P.history[k].unshift(f); P.allTabs[k] = f; P.persistViewerState(); }""" % AGENT)
        st = self.open_viewer(pg, delay=900)
        self.assertEqual(st["tabs"], [AGENT])
        self.assertEqual(st["history"], {AGENT: 3})
        self.assertEqual(st["keptHistory"], {AGENT: 3})

    def test_a_fast_start_restores_too(self):
        pg = self.new_page()
        self.assert_restored(self.open_viewer(pg, delay=0))


if __name__ == "__main__":
    unittest.main()
