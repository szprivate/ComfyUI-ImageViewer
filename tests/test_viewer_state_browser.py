"""What the viewer tells agentY, in a real browser: the REAL viewer js against stubbed ComfyUI scripts.

window.bEpicViewerApi.viewerState() names the open tab, the item on screen, the frame, the range picked on
the timeline and how many marks the item has; .annotations() hands those marks over in words and
normalised coordinates. Both read the panel's JS state only, so they answer the same once the viewer is
popped out into its own window - the case that breaks anything reading the panel's DOM.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_viewer_state_browser
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
  // The harness's ComfyUI stand-in has an empty graph; updateData walks its nodes.
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  const frames = ['s0', 's1', 's2', 's3'].map((n) => ({ path: `D:/out/${n}.png`, filename: `${n}.png`, type: 'output',
                                                        prompt_id: 'run-1', label: n }));
  P.updateData({ unique_id: '10', tab_name: 'stills', tabs: { tab1: frames } }, null);
  P.updateData({ unique_id: '11', tab_name: 'other', tabs: { tab1: [{ path: 'D:/out/o.png', filename: 'o.png' }] } }, null);
  P.switchTab('named:stills');
  P.setFrame(2);
  P.playbackRange = { start: 1, end: 3 };
  P.loopMode = 'pingpong';
  P._agentTags = { 'D:/out/s2.png': 'hero' };
  // The Annotation tool's marks on the picture on screen (filed under it: "img:<path>").
  P._annotStore[P._annotKey()] = [
    { id: 'a1', type: 'text', x: 0.1, y: 0.1, size: 40, color: '#ff0', text: 'logo too small' },
    { id: 'a2', type: 'rect', a: { x: 0.25, y: 0.25 }, b: { x: 0.5, y: 0.5 }, color: '#f00', width: 6 },
  ];
  await new Promise((r) => setTimeout(r, 200));
  return P._annotKey();
}"""

# The harness mounts its own panel (window.__panel) beside the one the extension's setup() makes and
# puts behind window.bEpicViewerApi - which stays closed here, and is asked as such below.
STATE = "() => window.__panel.agentViewerState()"
ANNOT = "(o) => window.__panel.agentViewerAnnotations(o)"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ViewerStateTests(unittest.TestCase):
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
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        self.key = pg.evaluate(SETUP)
        return pg

    def test_tab_item_frame_range_and_mark_count(self):
        pg = self.page()
        self.assertEqual(self.key, "img:D:/out/s2.png")
        s = pg.evaluate(STATE)
        self.assertTrue(s["open"])
        self.assertIn(s["display"], ("floating", "docked"))
        self.assertEqual(s["tab"]["key"], "named:stills")
        self.assertEqual(s["tab"]["label"], "stills")
        self.assertEqual(s["tab"]["mode"], "sequence")
        tabs = {t["key"]: t for t in s["tabs"]}
        self.assertEqual(tabs["named:stills"]["frames"], 4)
        self.assertIn("named:other", tabs)
        item = s["item"]
        self.assertEqual((item["index"], item["of"], item["path"]), (2, 4, "D:/out/s2.png"))
        self.assertEqual((item["prompt_id"], item["label"], item["agent_tag"]), ("run-1", "s2", "hero"))
        tl = s["timeline"]
        self.assertEqual((tl["frames"], tl["current"]), (4, 2))
        self.assertEqual(tl["range"]["start"], 1)
        self.assertEqual(tl["range"]["end"], 3)
        self.assertEqual(tl["loop"], "pingpong")
        self.assertFalse(tl["playing"])
        self.assertEqual(s["annotations"], {"count": 2})
        self.assertIn("zoom", s["view"])
        self.assertEqual(self.errors, [])

    def test_the_marks_on_screen_in_words(self):
        pg = self.page()
        a = pg.evaluate(ANNOT, {})
        self.assertEqual((a["kind"], a["count"], a["source"]), ("image", 2, "D:/out/s2.png"))
        g = a["annotations"][0]
        self.assertEqual(g["notes"], ["logo too small"])
        box = next(m for m in g["marks"] if m["type"] == "box")
        self.assertEqual(box["box"], {"x1": 0.25, "y1": 0.25, "x2": 0.5, "y2": 0.5})
        self.assertNotIn("items", a)
        raw = pg.evaluate(ANNOT, {"raw": True})
        self.assertEqual([i["type"] for i in raw["items"]], ["text", "rect"])
        # Another picture of the tab has marks of its own (none): they follow the picture, not the tab.
        pg.evaluate("() => window.__panel.setFrame(0)")
        self.assertEqual(pg.evaluate(ANNOT, {})["count"], 0)
        self.assertNotIn("annotations", pg.evaluate(STATE))
        self.assertEqual(self.errors, [])

    def test_the_api_answers_and_a_closed_viewer_says_so(self):
        pg = self.page()
        api = pg.evaluate("() => [typeof window.bEpicViewerApi.viewerState, typeof window.bEpicViewerApi.annotations,"
                          " window.bEpicViewerApi.viewerState().display, window.bEpicViewerApi.annotations().count]")
        self.assertEqual(api, ["function", "function", "closed", 0])
        pg.evaluate("() => window.__panel.setViewerToggleState(false)")
        s = pg.evaluate(STATE)
        self.assertEqual((s["open"], s["display"]), (False, "closed"))
        self.assertNotIn("tab", s)

    def test_the_same_answer_with_the_viewer_popped_out(self):
        pg = self.page()
        before = pg.evaluate(STATE)
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        pop.value.wait_for_load_state()
        pg.wait_for_function("() => window.__panel.container.ownerDocument !== document", timeout=10000)
        s = pg.evaluate(STATE)
        self.assertEqual(s["display"], "popout")
        self.assertTrue(s["visible"])
        for k in ("tab", "item", "timeline", "annotations"):
            self.assertEqual(s[k], before[k], k)
        self.assertEqual(pg.evaluate(ANNOT, {})["count"], 2)
        pg.evaluate("() => window.__panel.toggleUndock()")       # docked back
        self.assertNotEqual(pg.evaluate(STATE)["display"], "popout")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
