"""Full screen of the canvas, in a real browser: the transport button and Shift+F put the viewport alone
on the screen, the picture is fitted to it, the exit button over the canvas, Shift+F again and the
button bring it back.

Needs Playwright with an installed Edge or Chrome, node for the stub server and ffmpeg for the test
picture; skipped without them.
Run: python -m unittest tests.test_fullscreen_browser
It serves tests/harness/tabs.html - the REAL viewer js against stubbed ComfyUI scripts - on a free port.
"""
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FFMPEG = shutil.which("ffmpeg")

SETUP = """async () => {
  const P = window.__panel;
  P.setViewerToggleState(true);
  const f = { path: 'D:/out/p1.png', filename: 'p1.png', type: 'output', kind: 'image', external: true };
  P.pushHistorySnapshot('folder_fs', [f]);
  P.allTabs['folder_fs'] = [JSON.parse(JSON.stringify(f))];
  P.tabLabels['folder_fs'] = 'fs';
  if (!P.tabOrder.includes('folder_fs')) P.tabOrder.push('folder_fs');
  P._rebuildTabBar(null);
  P.switchTab('folder_fs');
}"""

STATE = """() => { const P = window.__panel, v = P.viewport, r = v.getBoundingClientRect(), b = P.fullscreenBtn;
  const ex = v.querySelector('.fs-exit-btn');
  return { on: P.isFullscreen(), w: r.width, h: r.height, zoom: P.zoom, title: b && b.title,
           active: !!b && b.classList.contains('active'), exit: ex ? getComputedStyle(ex).display : null,
           img: P.imgBase.getBoundingClientRect().height }; }"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None or FFMPEG is None,
                 "needs playwright, node and ffmpeg")
class FullscreenBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.mkdtemp(prefix="imageviewer_fs_")
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=400x300:rate=1:duration=1",
                        "-frames:v", "1", os.path.join(cls.media, "p1.png")], check=True)
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.media)
        env.pop("HARNESS_MEDIA", None)
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
        shutil.rmtree(cls.media, ignore_errors=True)

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_function("() => window.__panel.imgBase.naturalWidth > 0", timeout=10000)
        return pg

    @staticmethod
    def centre(pg, expr):
        return pg.evaluate(f"() => {{ const r = ({expr}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }}")

    def test_button_in_and_exit_button_out(self):
        pg = self.page()
        before = pg.evaluate(STATE)
        self.assertFalse(before["on"])
        self.assertEqual(before["exit"], "none")
        self.assertIn("Shift+F", before["title"])

        # A real click, so the browser takes it as the user's gesture (the harness page holds two panels,
        # so the button is found through window.__panel, not by its id).
        pg.mouse.click(*self.centre(pg, "window.__panel.fullscreenBtn"))
        pg.wait_for_function("() => window.__panel.isFullscreen()", timeout=5000)
        pg.wait_for_timeout(200)
        on = pg.evaluate(STATE)
        self.assertTrue(on["active"])
        self.assertEqual(on["exit"], "block")
        # The canvas alone fills the screen: wider and taller than it was inside the panel.
        self.assertGreater(on["w"], before["w"])
        self.assertGreater(on["h"], before["h"])
        # The picture is shown bigger, still fitted (zoom 1 is a fit).
        self.assertGreater(on["img"], before["img"])
        self.assertAlmostEqual(on["zoom"], 1.0, delta=0.01)
        # The transport is not in the full screen element.
        self.assertFalse(pg.evaluate("() => window.__panel.viewport.contains(window.__panel.fullscreenBtn)"))

        pg.mouse.move(700, 400)
        pg.mouse.click(*self.centre(pg, "window.__panel.viewport.querySelector('.fs-exit-btn')"))
        pg.wait_for_function("() => !window.__panel.isFullscreen()", timeout=5000)
        pg.wait_for_timeout(200)
        off = pg.evaluate(STATE)
        self.assertFalse(off["active"])
        self.assertEqual(off["exit"], "none")
        self.assertAlmostEqual(off["w"], before["w"], delta=2)
        self.assertAlmostEqual(off["img"], before["img"], delta=2)
        self.assertEqual(self.errors, [])

    def test_shift_f_toggles(self):
        pg = self.page()
        pg.mouse.move(*self.centre(pg, "window.__panel.viewport"))
        pg.keyboard.press("Shift+F")
        pg.wait_for_function("() => window.__panel.isFullscreen()", timeout=5000)
        pg.keyboard.press("Shift+F")
        pg.wait_for_function("() => !window.__panel.isFullscreen()", timeout=5000)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
