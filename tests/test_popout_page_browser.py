"""The undocked viewer's window: it is the viewer's own page (not about:blank), it opens as a window or as a tab as
Settings > Docking > "Undock opens the viewer in" says, and the viewer's relative URLs still resolve against the
ComfyUI page in it.

Needs Playwright with Edge, Chrome or Playwright's Chromium, and node for the stub server; skipped without them.
Run: python -m unittest tests.test_popout_page_browser
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


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]




@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class PopoutPageBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
        cls.server = subprocess.Popen(["node", os.path.join(ROOT, "tests", "harness", "server.mjs"), ROOT], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/edit.html", timeout=1).read()
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

    def undock(self, mode):
        pg = self.browser.new_page(viewport={"width": 1400, "height": 900})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        if mode:
            pg.evaluate("""async (mode) => {
              const { app } = await import('/scripts/app.js');
              app.extensionManager.setting = { get: (id) => id === 'ImageViewer.Undock.OpenAs' ? mode : undefined };
            }""", mode)
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        pg.wait_for_function("() => __panel.popoutWindow && __panel.container.ownerDocument === __panel.popoutWindow.document",
                             timeout=10000)
        win.wait_for_load_state()
        return pg, win

    def test_the_viewer_moves_into_its_own_page_not_about_blank(self):
        pg, win = self.undock(None)
        self.assertTrue(win.url.endswith("/imageViewer_popout.html"), win.url)
        self.assertEqual(win.title(), "ComfyUI Image Viewer")
        self.assertTrue(win.evaluate("() => !!document.querySelector('.panel-container')"))
        # The viewer's relative URLs resolve against the ComfyUI page, as they did in about:blank.
        base_main = pg.evaluate("() => document.baseURI")
        self.assertEqual(win.evaluate("() => document.baseURI"), base_main)
        self.assertEqual(win.evaluate("() => { const a = document.createElement('a'); a.href = 'view?x=1'; return a.href; }"),
                         pg.evaluate("() => new URL('view?x=1', document.baseURI).href"))
        # The reconnect watchdog is armed in the page.
        self.assertTrue(win.evaluate("() => !!window.__imageViewerWatchdog"))
        self.assertEqual(self.errors, [])

    def test_window_mode_is_a_popup_window(self):
        pg, win = self.undock("window")
        self.assertFalse(win.evaluate("() => window.toolbar.visible"), "a sized window opens as a popup")
        self.assertEqual(self.errors, [])

    def test_tab_mode_is_a_tab(self):
        pg, win = self.undock("tab")
        self.assertTrue(win.evaluate("() => window.toolbar.visible"), "no features: a tab, with the browser's bars")
        self.assertTrue(win.url.endswith("/imageViewer_popout.html"), win.url)
        self.assertEqual(self.errors, [])

    def test_docking_back_and_undocking_again(self):
        pg, win = self.undock(None)
        pg.evaluate("() => __panel.toggleUndock()")
        pg.wait_for_function("() => !__panel.popoutWindow && __panel.container.getRootNode() === __panel.shadowRoot", timeout=5000)
        with pg.context.expect_page() as pop:
            pg.evaluate("() => __panel.toggleUndock()")
        win2 = pop.value
        pg.wait_for_function("() => __panel.popoutWindow && __panel.container.ownerDocument === __panel.popoutWindow.document",
                             timeout=10000)
        self.assertTrue(win2.url.endswith("/imageViewer_popout.html"), win2.url)
        self.assertEqual(self.errors, [])

    def test_a_reloaded_comfyui_tab_takes_the_same_window_back(self):
        pg, win = self.undock(None)
        # The orphaned window's watchdog asks the server before it calls out.
        pg.context.route("**/prompt", lambda r: r.fulfill(status=200, body="{}", content_type="application/json"))
        pg.reload()
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.wait_for_function("() => __panel.popoutWindow && !__panel.popoutWindow.closed && "
                             "__panel.container.ownerDocument === __panel.popoutWindow.document", timeout=15000)
        self.assertEqual(len(pg.context.pages), 2, "the same window, no second one")
        self.assertTrue(win.url.endswith("/imageViewer_popout.html"), win.url)
        self.assertTrue(win.evaluate("() => !!document.querySelector('.panel-container')"))
        self.assertEqual(win.evaluate("() => document.baseURI"), pg.evaluate("() => document.baseURI"))


if __name__ == "__main__":
    unittest.main()
