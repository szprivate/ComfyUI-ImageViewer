"""New Atlas world, in a real browser: the 3D space's bar and Previz panel open the dialog, a History
selection comes in as pictures, Create posts to /imageviewer/atlas_create and follows the job.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html); the viewer server's routes are
answered by a stand-in for window.__fetchApi. Needs Playwright and node; skipped without them.
Run: python -m unittest tests.test_atlas_create_browser
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
SHOTS = os.environ.get("ATLAS_CREATE_SHOTS", "")

STUB = """() => {
  const real = window.__fetchApi;
  window.__atlasCalls = [];
  let polls = 0;
  window.__fetchApi = async (p, opts) => {
    if (p.startsWith('/imageviewer/atlas_create')) {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      window.__atlasCalls.push([p, body]);
      const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (body) return ok({ ok: true, id: 'j1', state: 'running' });
      polls += 1;
      return ok(polls < 2 ? { id: 'j1', state: 'running', phase: 'Atlas is placing the pictures in 3D', elapsed: 3 }
                          : { id: 'j1', state: 'done', name: body ? '' : 'room', glb: 'D:/o/room/world.glb', tab: 'previz:atlas_room' });
    }
    return real(p, opts);
  };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class AtlasCreateTests(unittest.TestCase):
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
        pg.on("pageerror", lambda e: None if "/imageviewer/lib/three/" in str(e) else self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("() => localStorage.clear()")
        return pg

    def test_the_dialog_from_the_3d_space_sends_prompt_and_pictures(self):
        pg = self.page()
        pg.evaluate(STUB)
        pg.evaluate("""async () => {
          const P = window.__panel;
          const { app } = await import('/scripts/app.js');   // the stand-in's graph is empty
          app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
          P.setViewerToggleState(true);
          P.updateData({ unique_id: '50', tab_name: 'agentY', tabs: { tab: [
            { path: 'D:/out/room.png', filename: 'room.png', type: 'output' }] } }, null);
          P.startHistorySelection('all', 0);
          P.spaceOpen('3d');
        }""")
        # The Previz panel's button is there on any 3D tab, the 3D menu has the entry too.
        has_btn = pg.evaluate("""() => [...window.__panel.shadowRoot.querySelectorAll('.previz-btn')]
                                  .some((b) => b.textContent === 'New world')""")
        self.assertTrue(has_btn)
        pg.evaluate("""() => [...window.__panel.shadowRoot.querySelectorAll('.previz-btn')]
                          .find((b) => b.textContent === 'New world').click()""")
        root = "window.__panel.shadowRoot"
        pg.wait_for_function(f"() => !!{root}.querySelector('.atlas-create')")
        st = pg.evaluate(f"""() => {{
          const d = {root}.querySelector('.atlas-create');
          return {{ chips: d.querySelectorAll('.atlas-pic').length, name: d.querySelector('.atlas-name').value,
                    aspectOff: d.querySelector('.atlas-aspect').disabled,
                    visible: d.getBoundingClientRect().width > 300 }};
        }}""")
        self.assertEqual((st["chips"], st["name"], st["aspectOff"], st["visible"]), (1, "room", True, True))
        prompt = pg.evaluate_handle(f"() => {root}.querySelector('.atlas-prompt')")
        prompt.as_element().fill("a cosy living room at dusk")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "new-atlas-world.png"))
        pg.evaluate(f"() => {root}.querySelector('.atlas-create .rd-go').click()")
        pg.wait_for_function(f"() => !{root}.querySelector('.atlas-create')", timeout=15000)
        calls = pg.evaluate("() => window.__atlasCalls")
        post = next(c for c in calls if c[1])
        self.assertEqual(post[0], "/imageviewer/atlas_create")
        self.assertEqual(post[1]["images"], [{"path": "D:/out/room.png"}])
        self.assertEqual(post[1]["prompt"], "a cosy living room at dusk")
        self.assertEqual(post[1]["name"], "cosy_living_room_dusk")
        self.assertTrue(any(c[0].startswith("/imageviewer/atlas_create?id=j1") for c in calls))
        self.assertEqual(self.errors, [])

    def test_the_3d_menu_opens_it_on_any_tab_with_a_prompt_only(self):
        pg = self.page()
        pg.evaluate(STUB)
        pg.evaluate("() => { window.__panel.setViewerToggleState(true); window.__panel.atlasCreateDialog(); }")
        root = "window.__panel.shadowRoot"
        st = pg.evaluate(f"""() => {{
          const d = {root}.querySelector('.atlas-create');
          return {{ go: d.querySelector('.rd-go').disabled, aspectOff: d.querySelector('.atlas-aspect').disabled }};
        }}""")
        self.assertEqual(st, {"go": True, "aspectOff": False}, "nothing to make yet; the aspect ratio is offered")
        pg.evaluate(f"() => {{ const t = {root}.querySelector('.atlas-prompt'); t.value = 'a beach'; t.dispatchEvent(new Event('input')); }}")
        self.assertFalse(pg.evaluate(f"() => {root}.querySelector('.atlas-create .rd-go').disabled"))
        pg.keyboard.press("Escape")
        self.assertFalse(pg.evaluate(f"() => !!{root}.querySelector('.atlas-create')"))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
