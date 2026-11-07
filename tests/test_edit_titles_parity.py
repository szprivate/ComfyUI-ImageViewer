"""A title drawn by the browser (imageViewer_editTitles / paintTitle, the Edit tab's preview) and by the render
(title_render, Pillow) lands in the same place: for each alignment, bold, italic (a real face and a synthetic one),
underline, tracking, several lines and a box, the bounding box of what is drawn agrees within a few pixels, and so does
how much is drawn.

Needs Playwright with an installed Edge or Chrome, node for the stub server, Pillow and numpy; skipped without them.
The fonts are copied out of the machine's font folder into a scratch folder and served from there; the browser gets
the same list the server's /imageviewer/fonts would answer (title_render.font_list of that folder).
Run: python -m unittest tests.test_edit_titles_parity
"""
import importlib
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None
try:
    import numpy as np
    from PIL import Image  # noqa: F401
except ImportError:  # pragma: no cover
    np = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
W, H = 640, 360
# Fonts of Windows' own folder; the test is skipped where they are not.
FONTS = ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf", "georgia.ttf", "comic.ttf"]

CASES = [
    {"text": "Left aligned words", "align": "left", "size": 8},
    {"text": "Centred words", "align": "center", "size": 8},
    {"text": "Right aligned", "align": "right", "size": 8, "valign": "top"},
    {"text": "Justified text that wraps over two lines here", "align": "justify", "size": 7, "w": 0.5, "h": 0.4, "y": 0.5},
    {"text": "Bold Title", "bold": True, "size": 10, "y": 0.5},
    {"text": "Italic Title", "italic": True, "size": 10, "y": 0.5, "valign": "bottom"},
    {"text": "Georgia bold", "font": "Georgia", "bold": True, "size": 9, "y": 0.4},          # no bold face: synthetic
    {"text": "Comic italic", "font": "Comic Sans MS", "italic": True, "size": 9},            # no italic face: synthetic
    {"text": "Underlined and tracked", "underline": True, "track": 120, "size": 6, "sw": 0},
    {"text": "Two lines\nof words", "size": 7, "line": 1.5, "y": 0.3, "caps": "upper"},
    {"text": "On a box", "bgo": 0.8, "bgp": 40, "bgr": 30, "size": 6, "sw": 0, "x": 0.3, "y": 0.2, "w": 0.4},
    {"text": "Shadow and outline", "sho": 0.9, "shx": 10, "shy": 10, "shb": 5, "sw": 12, "size": 7},
]

PAINT = """async ([look, w, h]) => {
  const F = await import('/extensions/viewer/imageViewer_editFonts.js');
  await F.fontList(true);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  let f = F.paintTitle(c, look, { x: 0, y: 0, w, h });
  if (!f.ready) { await document.fonts.ready; for (let i = 0; i < 50 && !F.paintTitle(c, look, { x: 0, y: 0, w, h }).ready; i++) await new Promise(r => setTimeout(r, 50)); }
  f = F.paintTitle(c, look, { x: 0, y: 0, w, h });
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + 3];
  return { raw: Array.from(a), family: f.family, ready: f.ready, failed: !!f.failed };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _bbox(alpha, at=96):
    ys, xs = np.nonzero(alpha >= at)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


@unittest.skipIf(sync_playwright is None or np is None or shutil.which("node") is None, "needs playwright, numpy, node")
class TitleParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        windir = os.environ.get("WINDIR") or r"C:\Windows"
        src = os.path.join(windir, "Fonts")
        if not all(os.path.isfile(os.path.join(src, f)) for f in FONTS):
            raise unittest.SkipTest("the Windows fonts this compares with are not here")
        cls.tmp = tempfile.mkdtemp()
        cls.fonts = os.path.join(cls.tmp, "fonts")
        os.makedirs(cls.fonts)
        for f in FONTS:
            shutil.copy(os.path.join(src, f), cls.fonts)
        pkg = types.ModuleType("imageviewer_parity")
        pkg.__path__ = [os.path.join(ROOT, "src")]
        sys.modules["imageviewer_parity"] = pkg
        cls.tr = importlib.import_module("imageviewer_parity.title_render")
        cls.families = cls.tr.scan([cls.fonts])
        listing = {"fonts": [{"family": f["family"], "faces": {k: {"id": v["id"], "asc": v["asc"], "desc": v["desc"],
                                                                    "url": "/media/" + os.path.basename(v["path"])}
                                                                for k, v in f["faces"].items()}} for f in cls.families],
                   "fallback": []}
        cls.listing = listing
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA_DIR=cls.fonts)
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
        cls.pg = cls.browser.new_page(viewport={"width": 1200, "height": 800})
        cls.pg.goto(f"http://127.0.0.1:{cls.port}/edit.html")
        cls.pg.wait_for_function("window.__ready===true", timeout=20000)
        cls.pg.evaluate("(l) => { window.__fonts = l; }", listing)

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "browser", None):
            cls.browser.close()
        if getattr(cls, "pw", None):
            cls.pw.stop()
        if getattr(cls, "server", None):
            cls.server.terminate()
            cls.server.wait(5)
        shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    def browser_alpha(self, look):
        got = self.pg.evaluate(PAINT, [look, W, H])
        self.assertTrue(got["ready"] and not got["failed"], f"the face loaded: {got}")
        return np.array(got["raw"], dtype=np.uint8).reshape(H, W), got["family"]

    def test_the_browser_and_the_render_draw_a_title_in_the_same_place(self):
        for look in CASES:
            with self.subTest(text=look["text"]):
                rgba, note = self.tr.render(look, W, H, self.families)
                self.assertEqual(note, "")
                py = rgba[:, :, 3]
                js, family = self.browser_alpha(look)
                self.assertEqual(family, look.get("font", "Arial"))
                a, b = _bbox(py), _bbox(js)
                self.assertIsNotNone(a)
                self.assertIsNotNone(b, "the browser drew something")
                for k, (p, q) in enumerate(zip(a, b)):
                    self.assertLessEqual(abs(p - q), 3, f"bbox {a} (render) vs {b} (browser), side {k}")
                # As much ink: the sum of the coverage agrees (the browser's antialiasing is a shade heavier at small
                # sizes - up to ~15 % at a 20 px font - so this is not a pixel count at a threshold).
                ia, ib = float(py.sum()), float(js.sum())
                self.assertLess(abs(ia - ib) / max(ia, ib), 0.2, f"{ia} vs {ib} of ink")
                ca, cb = float((py >= 96).sum()), float((js >= 96).sum())
                if os.environ.get("TITLE_PARITY_DUMP"):
                    from PIL import Image as _I
                    _I.fromarray(np.vstack([py, js])).save(os.path.join(os.environ["TITLE_PARITY_DUMP"], look["text"][:12] + ".png"))
                # And mostly in the same pixels.
                both = float(((py >= 96) & (js >= 96)).sum())
                self.assertGreater(both / max(ca, cb), 0.75, "the same pixels are drawn")

    def test_a_missing_font_falls_back_alike_and_says_so(self):
        look = {"text": "Fallback", "font": "No Such Font", "size": 9}
        rgba, note = self.tr.render(look, W, H, self.families)
        self.assertIn("No Such Font", note)
        self.assertIn("Arial", note)
        js, family = self.browser_alpha(look)
        self.assertEqual(family, "Arial")
        a, b = _bbox(rgba[:, :, 3]), _bbox(js)
        for p, q in zip(a, b):
            self.assertLessEqual(abs(p - q), 3)
        said = self.pg.evaluate("async (l) => (await import('/extensions/viewer/imageViewer_editFonts.js')).fontNote(l)", look)
        self.assertIn("not on this machine", said)


if __name__ == "__main__":
    unittest.main()
