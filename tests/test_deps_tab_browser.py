"""The Dependencies tab, in a real browser: a plate on top, its depth pass below it, the render below that;
the stale render outlined; a click on a node opens it; many sibling passes fold into one node and unfold.

Needs Playwright with a browser and node for the stub server; skipped without them.
Run: python -m unittest tests.test_deps_tab_browser
It serves tests/harness/tabs.html - the REAL viewer js against stubbed ComfyUI scripts - on a free port, and
answers /imageviewer/deps from the page (window.__fetchApi).
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

STUB = """() => {
  const real = window.__fetchApi;
  window.__depsAsked = [];
  const passes = Array.from({length: 6}, (_, i) => ({id: `D:/out/mask_${i}.mp4`, file: `mask_${i}.mp4`,
      kind: 'mask', exists: true, stale: '', viewable: false}));
  const graph = {root: 'D:/out/depth.mp4', truncated: false,
    nodes: [
      {id: 'D:/in/plate.mp4', file: 'plate.mp4', kind: 'source', exists: true, stale: '', viewable: false,
       tags: ['magnific', 'dreamina-seedance-2-5'], models: [{name: 'dreamina-seedance-2-5', role: 'partner', value: 'x'}],
       generator: {service: 'magnific', model: 'dreamina-seedance-2-5', provider: 'BytePlus', source: 'c2pa'}},
      {id: 'D:/out/depth.mp4', file: 'depth.mp4', kind: 'depth', exists: true, stale: '', viewable: false, root: true,
       models: [{name: 'depth_anything_v2_vitl', role: 'model', value: 'depth_anything_v2_vitl.pth'}]},
      {id: 'D:/out/render.png', file: 'render.png', kind: 'render', exists: true,
       stale: 'plate.mp4 changed since this was made', viewable: false,
       models: [{name: 'flux1-dev', role: 'model', value: 'flux1-dev.safetensors'}, {name: 'ae', role: 'aux', value: 'ae.safetensors'},
                {name: 'style', role: 'lora', value: 'style.safetensors'}],
       prompts: [{role: 'positive', text: 'a kitchen at dawn, warm light through the window', node: '6', class: 'CLIPTextEncode'},
                 {role: 'negative', text: 'blurry', node: '7', class: 'CLIPTextEncode'}]},
      ...passes],
    edges: [
      {from: 'D:/in/plate.mp4', to: 'D:/out/depth.mp4', kind: 'depth', label: 'DepthAnythingV2'},
      {from: 'D:/out/depth.mp4', to: 'D:/out/render.png', kind: 'render', label: 'flux_depth.json'},
      ...passes.map((p) => ({from: 'D:/in/plate.mp4', to: p.id, kind: 'mask', label: 'mask'}))]};
  window.__fetchApi = async (path, opts) => {
    if (String(path).startsWith('/imageviewer/deps')) {
      window.__depsAsked.push({path: String(path), method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null});
      return new Response(JSON.stringify(graph), {status: 200, headers: {'Content-Type': 'application/json'}});
    }
    return real(path, opts);
  };
}"""

NODES = """() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-node:not(.dp-prompt)')].map((el) => ({
  label: el.querySelector('.dp-label').textContent, top: parseFloat(el.style.top),
  stale: el.classList.contains('stale'), root: el.classList.contains('root'), fold: el.classList.contains('fold')}))"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class DepsTabBrowserTests(unittest.TestCase):
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
        pg.evaluate(STUB)
        pg.evaluate("() => { window.__panel.setViewerToggleState(true); window.__panel.depsOpen('D:/out/depth.mp4'); }")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-node').length > 0",
                             timeout=10000)
        return pg

    def test_top_to_bottom_with_stale_and_fold(self):
        pg = self.page()
        asked = pg.evaluate("() => window.__depsAsked[0]")
        self.assertEqual((asked["path"], asked["method"], asked["body"]), ("/imageviewer/deps", "POST", {"path": "D:/out/depth.mp4"}))
        self.assertTrue(pg.evaluate("() => window.__panel.activeTab").startswith("deps:"))
        nodes = {n["label"]: n for n in pg.evaluate(NODES)}
        self.assertLess(nodes["plate.mp4"]["top"], nodes["depth.mp4"]["top"])
        self.assertLess(nodes["depth.mp4"]["top"], nodes["render.png"]["top"])
        self.assertTrue(nodes["depth.mp4"]["root"])
        self.assertTrue(nodes["render.png"]["stale"])
        self.assertFalse(nodes["depth.mp4"]["stale"])
        self.assertIn("6 mask passes", nodes)
        self.assertTrue(nodes["6 mask passes"]["fold"])
        self.assertEqual(len(pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-edge:not(.dp-edge-prompt)')]")), 3)
        # A click unfolds the passes.
        pg.evaluate("""() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-node.fold')][0].click()""")
        labels = [n["label"] for n in pg.evaluate(NODES)]
        self.assertEqual(sum(1 for x in labels if x.startswith("mask_")), 6)
        self.assertEqual(self.errors, [])

    def test_right_click_menu_drops_and_opens_workflow(self):
        pg = self.page()
        pg.evaluate("""() => {
          const p = window.__panel;
          window.__dropped = []; window.__loaded = []; window.__wfAsked = [];
          p._browserFramesFor = async (paths) => paths.map((x) => ({path: x, kind: 'video'}));
          p._dropHistoryOntoGraph = async (items, e) => { window.__dropped.push({items, e}); };
          const real = window.__fetchApi;
          window.__fetchApi = async (path, opts) => {
            if (String(path) === '/imageviewer/deps/workflow') {
              const body = JSON.parse(opts.body); window.__wfAsked.push(body);
              const wf = body.path.endsWith('render.png') ? {nodes: [{id: 1}], links: []} : null;
              return new Response(JSON.stringify({found: true, source: 'png', workflow: wf, prompt: {'1': {class_type: 'X', inputs: {}}}}),
                                  {status: 200, headers: {'Content-Type': 'application/json'}});
            }
            return real(path, opts);
          };
        }""")
        app_ok = pg.evaluate("""async () => {
          const mod = await import('/scripts/app.js');
          window.__appMod = mod.app;
          mod.app.loadGraphData = async (...a) => { window.__loaded.push({how: 'ui', name: a[3], clean: a[1], wf: a[0]}); };
          mod.app.loadApiJson = async (...a) => { window.__loaded.push({how: 'api', name: a[1], prompt: a[0]}); };
          return true;
        }""")
        self.assertTrue(app_ok)

        def menu_for(label):
            pg.evaluate("""(label) => {
              const el = [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-node:not(.dp-prompt)')]
                .find((x) => x.querySelector('.dp-label').textContent === label);
              const r = el.getBoundingClientRect();
              el.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2,
                clientX: r.left + 10, clientY: r.top + 10}));
            }""", label)
            return pg.evaluate("""() => [...window.__panel.container.querySelectorAll('#thumb-ctx-menu .thumb-ctx-item')]
              .map((x) => ({text: x.textContent, disabled: x.classList.contains('disabled')}))""")

        # The stub's nodes are not viewable: both rows there, but greyed out, and a click does nothing.
        rows = menu_for("render.png")
        self.assertEqual([r["text"] for r in rows], ["⤵ Drop into canvas", "\U0001F9E9 Open its workflow"])
        self.assertTrue(all(r["disabled"] for r in rows))
        pg.keyboard.press("Escape")
        self.assertEqual(pg.evaluate("() => !!window.__panel.container.querySelector('#thumb-ctx-menu')"), False)

        # Viewable ones: drop goes through the History's graph drop, the workflow opens in a new tab.
        pg.evaluate("""() => {
          const p = window.__panel;
          const orig = p._depsNodeMenu.bind(p);
          p._depsNodeMenu = (ev, n) => orig(ev, {...n, viewable: true, exists: true});
        }""")
        menu_for("render.png")
        self.assertFalse(any(r["disabled"] for r in pg.evaluate("""() => [...window.__panel.container.querySelectorAll('#thumb-ctx-menu .thumb-ctx-item')]
              .map((x) => ({disabled: x.classList.contains('disabled')}))""")))
        pg.evaluate("() => window.__panel.container.querySelectorAll('#thumb-ctx-menu .thumb-ctx-item')[0].click()")
        pg.wait_for_function("() => window.__dropped.length === 1", timeout=5000)
        d = pg.evaluate("() => window.__dropped[0]")
        self.assertIsNone(d["e"])
        self.assertEqual((d["items"][0]["path"], d["items"][0]["kind"]), ("D:/out/render.png", "video"))
        self.assertFalse(pg.evaluate("() => !!window.__panel.container.querySelector('#thumb-ctx-menu')"))

        menu_for("render.png")
        pg.evaluate("() => window.__panel.container.querySelectorAll('#thumb-ctx-menu .thumb-ctx-item')[1].click()")
        pg.wait_for_function("() => window.__loaded.length === 1", timeout=5000)
        self.assertEqual(pg.evaluate("() => window.__wfAsked"), [{"path": "D:/out/render.png"}])
        got = pg.evaluate("() => window.__loaded[0]")
        self.assertEqual((got["how"], got["name"], got["clean"], got["wf"]["nodes"][0]["id"]), ("ui", "render", True, 1))
        # No UI workflow kept: the API graph is loaded instead.
        menu_for("depth.mp4")
        pg.evaluate("() => window.__panel.container.querySelectorAll('#thumb-ctx-menu .thumb-ctx-item')[1].click()")
        pg.wait_for_function("() => window.__loaded.length === 2", timeout=5000)
        got = pg.evaluate("() => window.__loaded[1]")
        self.assertEqual((got["how"], got["name"]), ("api", "depth"))
        self.assertEqual(self.errors, [])

    def test_prompts_are_text_boxes_above_their_file(self):
        pg = self.page()
        boxes = pg.evaluate("""() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-prompt')].map((el) => ({
          role: el.querySelector('.dp-prompt-role').textContent, text: el.querySelector('.dp-prompt-text').textContent,
          top: parseFloat(el.style.top), neg: el.classList.contains('dp-prompt-negative')}))""")
        self.assertEqual(sorted(b["text"] for b in boxes), ["a kitchen at dawn, warm light through the window", "blurry"])
        nodes = {n["label"]: n for n in pg.evaluate(NODES)}
        for b in boxes:
            self.assertLess(b["top"], nodes["render.png"]["top"])
            self.assertGreater(b["top"], nodes["plate.mp4"]["top"])
        self.assertTrue(any(b["neg"] and b["role"] == "negative prompt" for b in boxes))
        self.assertEqual(len(pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-edge-prompt')]")), 2)
        # The Prompts button hides them, and brings them back.
        pg.evaluate("() => window.__panel.viewport.querySelector('.view-tab-deps .dp-prompts-btn').click()")
        self.assertEqual(pg.evaluate("() => window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-prompt').length"), 0)
        pg.evaluate("() => window.__panel.viewport.querySelector('.view-tab-deps .dp-prompts-btn').click()")
        self.assertEqual(pg.evaluate("() => window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-prompt').length"), 2)
        self.assertEqual(self.errors, [])

    def test_nodes_move_and_resize(self):
        pg = self.page()
        sel = ".view-tab-deps .dp-node:not(.dp-prompt):not(.fold)"
        box = """(i) => { const el = [...window.__panel.viewport.querySelectorAll('%s')][i];
          return {label: el.querySelector('.dp-label').textContent, x: parseFloat(el.style.left), y: parseFloat(el.style.top),
                  w: parseFloat(el.style.width), h: parseFloat(el.style.height)}; }""" % sel
        edges = "() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-edge')].map((p) => p.getAttribute('d')).join('|')"
        before, paths0 = pg.evaluate(box, 0), pg.evaluate(edges)
        node = pg.locator(sel).first
        r = node.bounding_box()
        # Move: drag from the middle of the label.
        pg.mouse.move(r["x"] + r["width"] / 2, r["y"] + r["height"] - 12)
        pg.mouse.down()
        pg.mouse.move(r["x"] + r["width"] / 2 + 120, r["y"] + r["height"] - 12 + 80, steps=6)
        pg.mouse.up()
        moved = pg.evaluate(box, 0)
        self.assertEqual(moved["label"], before["label"])
        self.assertGreater(moved["x"], before["x"] + 20)
        self.assertGreater(moved["y"], before["y"] + 20)
        self.assertEqual((moved["w"], moved["h"]), (before["w"], before["h"]))
        self.assertNotEqual(pg.evaluate(edges), paths0, "the edges follow the node")
        # The drag's click did not open the file in the Viewer tab.
        self.assertTrue(pg.evaluate("() => window.__panel.activeTab").startswith("deps:"))
        # Resize: drag the bottom-right corner.
        r = node.bounding_box()
        pg.mouse.move(r["x"] + r["width"] - 3, r["y"] + r["height"] - 3)
        pg.mouse.down()
        pg.mouse.move(r["x"] + r["width"] + 90, r["y"] + r["height"] + 60, steps=6)
        pg.mouse.up()
        grown = pg.evaluate(box, 0)
        self.assertGreater(grown["w"], moved["w"] + 20)
        self.assertGreater(grown["h"], moved["h"] + 20)
        self.assertEqual((grown["x"], grown["y"]), (moved["x"], moved["y"]))
        # It stays through a re-render (the Prompts button), and Tidy puts it back.
        pg.evaluate("() => window.__panel.viewport.querySelector('.view-tab-deps .dp-prompts-btn').click()")
        self.assertEqual(pg.evaluate(box, 0)["w"], grown["w"])
        pg.evaluate("""() => [...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-bar button')]
          .find((b) => b.textContent === 'Tidy').click()""")
        tidy = pg.evaluate(box, 0)
        self.assertEqual((tidy["w"], tidy["h"]), (before["w"], before["h"]))
        self.assertEqual(self.errors, [])

    def test_frames_say_still_or_film_and_the_model(self):
        pg = self.page()
        got = pg.evaluate("""() => Object.fromEntries([...window.__panel.viewport.querySelectorAll('.view-tab-deps .dp-node:not(.dp-prompt):not(.fold)')]
            .map((el) => { const t = el.querySelector('.dp-thumb'); const c = el.querySelector('.dp-caption');
              return [el.querySelector('.dp-label').textContent, {
                media: t.classList.contains('dp-media-video') ? 'video' : t.classList.contains('dp-media-image') ? 'image' : '',
                caption: c ? c.textContent : null, border: getComputedStyle(t).borderTopColor, title: el.title}]; }))""")
        self.assertEqual(got["plate.mp4"]["media"], "video")
        self.assertEqual(got["plate.mp4"]["caption"], "VIDEOmagnific · dreamina-seedance-2-5")
        self.assertIn("made with: magnific dreamina-seedance-2-5 (BytePlus)", got["plate.mp4"]["title"])
        self.assertIn("content credentials (C2PA), not verified", got["plate.mp4"]["title"])
        self.assertEqual(got["depth.mp4"]["caption"], "VIDEOdepth_anything_v2_vitl")
        self.assertEqual(got["render.png"]["media"], "image")
        self.assertEqual(got["render.png"]["caption"], "IMAGEflux1-dev + 1 LoRA")
        self.assertNotEqual(got["render.png"]["border"], got["plate.mp4"]["border"])
        self.assertIn("uses: ae.safetensors", got["render.png"]["title"])
        if os.environ.get("DEPS_SHOT"):
            pg.screenshot(path=os.environ["DEPS_SHOT"])
        self.assertEqual(self.errors, [])

    def test_history_menu_offers_it(self):
        pg = self.page()
        got = pg.evaluate("""() => { const P = window.__panel;
          const f = {path: 'D:/out/p1.png', filename: 'p1.png', type: 'output', kind: 'image', external: true};
          P.pushHistorySnapshot('folder_history', [f]);
          P.showThumbContextMenu({clientX: 10, clientY: 10}, f, 'folder_history', 0);
          const m = P.container.querySelector('#thumb-ctx-menu');
          return [...m.querySelectorAll('.thumb-ctx-item')].map((x) => x.textContent); }""")
        self.assertTrue(any("Show dependencies" in x for x in got), got)


if __name__ == "__main__":
    unittest.main()
