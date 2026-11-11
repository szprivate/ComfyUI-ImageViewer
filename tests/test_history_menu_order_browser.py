"""The History thumbnail menu's order, in a real browser: the REAL viewer js against stubbed ComfyUI scripts.

Sebastian's order (2026-11-11), a line between the sections:
  Copy image path, Remove from history, Recreate thumbnail, Move to group
  Show dependencies, Load workflow
  Convert Footage (films), Edit in Paint / Comp (pictures, films) / Motion, Open in 3D (models, splats)
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
                   [{ fromTab: key, path: 'D:/out/a.png', filename: 'a.png', type: 'output' }],
                   [{ fromTab: key, path: 'D:/out/world.spz', filename: 'world.spz', type: 'output', kind: 'model', format: 'spz' }]];
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
            "Copy image path", "Remove from history", "Recreate thumbnail", "Move to group", "--",
            "Show dependencies", "Load workflow", "--",
            "Convert Footage", "Edit in Comp", "--",
            "Tag as asset…", "(colours)",
        ])
        self.assertEqual(self.errors, [])

    def test_a_picture_has_no_vfx(self):
        pg = self.page()
        rows = self.menu(pg, 1)
        self.assertEqual(rows, ["Copy image path", "Remove from history", "Recreate thumbnail", "Move to group", "--",
                                "Show dependencies", "Load workflow", "--",
                                "Edit in Paint", "Edit in Comp", "--", "Tag as asset…", "(colours)"])

    def test_a_splat_opens_in_3d(self):
        pg = self.page()
        rows = self.menu(pg, 2)
        self.assertIn("Open in 3D", rows)
        self.assertNotIn("Edit in Comp", rows)
        self.assertNotIn("Edit in Paint", rows)
        pg.evaluate("""() => { const P = window.__panel; window.__opened = [];
          P.previzOpenAsset = (fr) => { window.__opened.push(fr.path); }; }""")
        pg.locator("comfyui-image-viewer-panel .thumb-ctx-item", has_text="Open in 3D").click()
        self.assertEqual(pg.evaluate("() => window.__opened"), ["D:/out/world.spz"])

    def test_edit_in_comp_hands_over_the_file(self):
        pg = self.page()
        pg.evaluate("""() => { const P = window.__panel; window.__comp = [];
          P.compEditMedia = (it) => { window.__comp.push([it.path, it.kind]); }; }""")
        self.menu(pg, 0)
        pg.locator("comfyui-image-viewer-panel .thumb-ctx-item", has_text="Edit in Comp").click()
        self.assertEqual(pg.evaluate("() => window.__comp"), [["D:/out/clip.mp4", "video"]])

    def test_recreate_thumbnail_asks_the_server_and_gives_the_tile_a_new_url(self):
        pg = self.page()
        pg.evaluate("""() => {
          const P = window.__panel; window.__posts = [];
          P.history.all[0][0].thumb = 'ImageViewer_poster_clip_x.png';
          P._historyPanelSig = null; P.renderHistoryPanel();
          const real = window.fetch;
          window.fetch = (url, opt) => {
            if (String(url).includes('/imageviewer/thumb_recreate')) {
              window.__posts.push(JSON.parse(opt.body));
              return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            return real(url, opt);
          };
        }""")
        self.menu(pg, 0)
        pg.locator("comfyui-image-viewer-panel .thumb-ctx-item", has_text="Recreate thumbnail").click()
        pg.wait_for_function("() => window.__posts.length > 0")
        posts = pg.evaluate("() => window.__posts")   # the harness's api stub posts {path: route, body}
        self.assertEqual([p.get("body", p) for p in posts], [{"path": "D:/out/clip.mp4"}])
        pg.wait_for_function("() => window.__panel.history.all[0][0].thumbV > 0")
        fr = pg.evaluate("() => window.__panel.history.all[0][0]")
        self.assertIsNone(fr.get("thumb"))
        url = pg.evaluate("() => window.__panel.thumbUrl(window.__panel.history.all[0][0])")
        self.assertIn("/imageviewer/thumb?path=", url)
        self.assertIn("tv=", url)

    def test_edit_in_comp_makes_a_comp_at_the_files_size_with_a_read(self):
        pg = self.page()
        got = pg.evaluate("""async () => {
          const P = window.__panel; const seen = []; let shown = null;
          const reply = (j) => ({ ok: true, status: 200, json: async () => j });
          window.__fetchApi = async (path, opts) => {
            seen.push(String(path).split('?')[0]);
            if (path.startsWith('/imageviewer/comp_source')) return reply({ kind: 'video', first: 0, last: 71, fps: 25, width: 1280, height: 720 });
            if (path === '/imageviewer/comp_new') {
              const b = JSON.parse(opts.body);
              return reply({ path: 'D:/out/comps/' + b.name + '_v001.comp.json', version: 1, comp: { comp: 1, format: { width: b.width, height: b.height, fps: b.fps, frames: b.frames },
                nodes: [{ id: 'Constant1', type: 'constant', name: 'Background', x: 0, y: 0, color: [0, 0, 0, 1], inputs: [] },
                        { id: 'Output1', type: 'output', x: 0, y: 200, inputs: ['Constant1'] }], output: 'Output1' } });
            }
            if (path === '/imageviewer/comp') return reply({ ok: true });
            return { ok: false, status: 404, json: async () => ({}) };
          };
          P._cpShowDoc = (p, c) => { shown = { p, c }; };
          const out = await P.compEditMedia({ path: 'D:/out/clip.mp4', kind: 'video' });
          const read = shown.c.nodes.find((n) => n.type === 'read');
          const merge = shown.c.nodes.find((n) => n.type === 'merge');
          const outN = shown.c.nodes.find((n) => n.id === 'Output1');
          return { out, seen, fmt: shown.c.format, file: read && read.file, merged: !!merge && merge.inputs[1] === read.id && outN.inputs[0] === merge.id };
        }""")
        self.assertEqual(got["out"], "D:/out/comps/clip_v001.comp.json")
        self.assertEqual(got["seen"], ["/imageviewer/comp_source", "/imageviewer/comp_new", "/imageviewer/comp"])
        self.assertEqual(got["fmt"], {"width": 1280, "height": 720, "fps": 25, "frames": 72})
        self.assertEqual(got["file"], "D:/out/clip.mp4")
        self.assertTrue(got["merged"])

    def test_open_in_3d_puts_the_splat_into_a_new_3d_scene(self):
        pg = self.page()
        got = pg.evaluate("""async () => {
          const P = window.__panel;
          const fr = P.history.all[2][0];
          const ok = await P.previzOpenAsset(fr);
          const scene = P.previzScene();
          return { ok, tab: P.activeTab, label: P.tabLabels[P.activeTab], is3d: P.isPrevizTab(),
                   items: scene.items.map((i) => i.name) };
        }""")
        self.assertTrue(got["ok"])
        self.assertTrue(got["is3d"])
        self.assertIn("world", got["label"])
        self.assertEqual(got["items"], ["world.spz"])

    def test_the_history_button_stands_right_of_the_file_browser(self):
        pg = self.page()
        info = pg.evaluate("""() => {
          const sr = window.__panel.shadowRoot;
          const b = sr.getElementById('browser-toggle-btn'), h = sr.getElementById('history-toggle-btn');
          const rb = b.getBoundingClientRect(), rh = h.getBoundingClientRect();
          return { shown: getComputedStyle(h).display !== 'none' && rh.width > 0, next: b.nextElementSibling === h,
                   right: rh.left >= rb.right - 1, sameRow: Math.abs(rh.top - rb.top) < 4,
                   icon: !!h.querySelector('svg.lucide-history'), active: h.classList.contains('active') };
        }""")
        self.assertEqual(info, {"shown": True, "next": True, "right": True, "sameRow": True, "icon": True, "active": True})
        pg.locator("comfyui-image-viewer-panel #history-toggle-btn").first.click()
        self.assertFalse(pg.evaluate("() => window.__panel.isPanelDocked('history')"))

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
        self.assertEqual(rows, ["Copy image path", "Remove 2 from history", "Recreate 2 thumbnails", "Move 2 to group",
                                "--", "(colours)"])

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
