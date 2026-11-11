"""A History tile whose poster was in ComfyUI's temp folder - which ComfyUI empties when it starts - is made from
the media itself instead of staying empty after a restart. The REAL viewer js against tests/harness/graph.html.

Needs Playwright with a browser and node; skipped without them.
Run: python -m unittest tests.test_history_thumb_fallback_browser
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
  // A film whose poster ComfyUI wiped from temp, and a picture with no poster at all.
  const film = { path: 'D:/out/clip.mp4', filename: 'clip.mp4', type: 'output', kind: 'video', thumb: 'C:/comfy/temp/poster_gone.png' };
  const pic = { path: 'D:/out/still.png', filename: 'still.png', type: 'output' };
  P.allTabs.folder_a = [pic]; P.tabLabels.folder_a = 'Tab A';
  if (!P.tabOrder.includes('folder_a')) P.tabOrder.push('folder_a');
  P.pushHistorySnapshot('folder_a', [pic]);
  P.pushHistorySnapshot('folder_a', [film]);
  P._rebuildTabBar(null); P.switchTab('folder_a');
  P._historyPanelSig = null; P.renderHistoryPanel();
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class HistoryThumbFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA="1")
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

    def test_a_poster_gone_from_temp_falls_back_to_the_media(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        asked = []
        pg.on("request", lambda r: asked.append(r.url) if "poster_gone" in r.url or "/imageviewer/thumb" in r.url else None)
        # The poster's file is gone: whatever route it is asked through answers 404.
        pg.route("**/*poster_gone*", lambda route: route.fulfill(status=404, body="gone"))
        pg.goto(f"http://127.0.0.1:{self.port}/graph.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_function("""() => { const t = window.__panel.historyStrip.querySelectorAll('.history-thumb img');
            return t.length === 2 && [...t].every((i) => i.complete && i.naturalWidth > 0); }""", timeout=10000)
        tiles = pg.evaluate("""() => [...window.__panel.historyStrip.querySelectorAll('.history-thumb')].map((t) => ({
            src: t.querySelector('img').src, failed: !!t._imageViewerFailed }))""")
        film = next(t for t in tiles if "clip.mp4" in t["src"])
        self.assertIn("/imageviewer/thumb?path=", film["src"], "the film's tile is made from the film")
        self.assertFalse(film["failed"])
        self.assertTrue(any("poster_gone" in u for u in asked), "the poster was asked for first")
        self.assertEqual(pg.evaluate("() => window.__panel.history.all.length"), 2, "nothing was pruned")


if __name__ == "__main__":
    unittest.main()
