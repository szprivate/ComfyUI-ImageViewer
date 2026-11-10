"""Comp in the REAL viewer, against the REAL routes: a new comp opens in a Comp tab with the Node Graph up (the
default way in) and the picture over the viewport; a Read laid over the background shows in the picture through the
float16 pixels route; the viewer's bar is the comp's time; Layers is the same graph; the render lands in the History
and on the ComfyUI canvas; leaving the tab gives the viewport back.

    python -m unittest tests.test_comp_browser     (Playwright and aiohttp; skipped without)
"""
import asyncio
import os
import shutil
import socket
import sys
import tempfile
import threading
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402

try:
    from playwright.sync_api import sync_playwright
except Exception:  # noqa: BLE001
    sync_playwright = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS = os.path.join(ROOT, "tests", "harness")
TYPES = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml"}
SHOTS = os.environ.get("COMP_SHOTS")   # a folder: screenshots of the space are written there


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or web is None, "needs playwright and aiohttp")
class CompBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.routes_app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        from PIL import Image
        cls.png = os.path.join(cls.dirs["output"], "plate.png")
        a = np.zeros((90, 160, 4), np.uint8)
        a[..., 0] = 255
        a[..., 3] = 255
        a[:, 80:, 3] = 0          # the right half is transparent
        Image.fromarray(a, "RGBA").save(cls.png)
        cls.port = _free_port()
        cls.loop = asyncio.new_event_loop()
        started = threading.Event()

        async def static(request):
            p = request.path
            if p.startswith("/extensions/viewer/"):
                f = os.path.join(ROOT, "js", p[len("/extensions/viewer/"):])
            else:
                f = os.path.join(HARNESS, p.lstrip("/"))
            f = os.path.abspath(f)
            if not (f.startswith(ROOT)) or not os.path.isfile(f):
                return web.Response(status=404, text="nf")
            with open(f, "rb") as fh:
                return web.Response(body=fh.read(), content_type=TYPES.get(os.path.splitext(f)[1], "application/octet-stream"),
                                    headers={"Cache-Control": "no-store"})

        async def serve():
            app = web.Application(client_max_size=1 << 28)
            for r in cls.routes_app.router.routes():
                if "/imageviewer/" in r.resource.canonical:
                    app.router.add_route(r.method, r.resource.canonical, r.handler)
            app.router.add_route("GET", "/{tail:.*}", static)
            cls.runner = web.AppRunner(app)
            await cls.runner.setup()
            await web.TCPSite(cls.runner, "127.0.0.1", cls.port).start()
            started.set()

        def run():
            asyncio.set_event_loop(cls.loop)
            cls.loop.run_until_complete(serve())
            cls.loop.run_forever()

        cls.thread = threading.Thread(target=run, daemon=True)
        cls.thread.start()
        started.wait(10)
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                cls.browser = (cls.pw.chromium.launch(channel=channel, headless=True) if channel
                               else cls.pw.chromium.launch(headless=True))
                break
            except Exception:  # noqa: BLE001
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
        asyncio.run_coroutine_threadsafe(cls.runner.cleanup(), cls.loop).result(10)
        cls.loop.call_soon_threadsafe(cls.loop.stop)
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/comp.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('comfyui-image-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        return pg

    ED = "__panel.compEditor()"

    def new_comp(self, pg):
        path = pg.evaluate("() => __panel.compNew('shot')")
        self.assertTrue(path and path.endswith(".comp.json"), path)
        pg.wait_for_function(f"() => {{ const e = {self.ED}; return e && e.comp(); }}", timeout=10000)
        return path

    def pixel(self, pg, fx, fy):
        """The picture's pixel at a share of its width / height (r, g, b, a)."""
        return pg.evaluate(f"""([fx, fy]) => {{ const c = {self.ED}.canvas; const x = Math.floor(c.width * fx), y = Math.floor(c.height * fy);
            return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data); }}""", [fx, fy])

    def test_comp_space_graph_picture_time_layers_and_render(self):
        pg = self.page()
        path = self.new_comp(pg)
        st = pg.evaluate("""() => ({ graph: __panel.isPanelDocked('compGraph'), props: __panel.isPanelDocked('compProps'),
            layers: __panel.isPanelDocked('compLayers'), mode: __panel.viewport.classList.contains('comp-mode'),
            nodes: __panel.compGraphPanel.querySelectorAll('.cp-node').length, tab: __panel.activeTab,
            frames: __panel.getImgCount() })""")
        self.assertEqual((st["graph"], st["props"], st["layers"], st["mode"]), (True, True, False, True), st)
        self.assertEqual(st["nodes"], 2)                 # Background into Output1
        self.assertEqual(st["tab"], "comp:" + path)
        self.assertEqual(st["frames"], 48)
        # A Read of the plate laid over the background: a layer, through the real pixels route.
        pg.evaluate(f"""(file) => {{ const e = {self.ED}; e.comp().nodes.find((n) => n.type === 'constant').color = [0, 0, 1, 1];
            const C = e.state; return e.addNode('read', {{ file }}); }}""", self.png)
        pg.evaluate(f"""() => {{ const e = {self.ED}; const c = e.comp(); const read = c.nodes.find((n) => n.type === 'read');
            const out = c.nodes.find((n) => n.type === 'output'); const bg = c.nodes.find((n) => n.type === 'constant');
            const m = e.addNode('merge'); m.inputs = [bg.id, read.id, null]; out.inputs = [m.id]; e.refresh(); }}""")
        pg.wait_for_function(f"() => {self.ED}.lastRender().ms >= 0 && document.querySelector('*')", timeout=5000)
        pg.wait_for_timeout(800)
        left, right = self.pixel(pg, 0.25, 0.5), self.pixel(pg, 0.75, 0.5)
        self.assertGreater(left[0], 200, left)           # the red plate over
        self.assertLess(left[2], 40, left)
        self.assertGreater(right[2], 200, right)         # the blue background where the plate is clear
        # Layers: the same graph as a stack, one layer over the background.
        pg.evaluate("() => __panel.setPanelDocked('compLayers', true)")
        pg.wait_for_timeout(200)
        rows = pg.evaluate("() => __panel.compLayersPanel.querySelectorAll('.cp-lrow').length")
        self.assertEqual(rows, 2, "a layer and the background")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-space.png"))
        # The viewer's bar is the comp's time; the last-frame box edits the comp's length.
        pg.evaluate("() => __panel.setFrame(12)")
        self.assertEqual(pg.evaluate(f"() => {self.ED}.state.frame"), 12)
        pg.evaluate("() => __panel.compSetFormat({ duration: 30 })")
        self.assertEqual(pg.evaluate(f"() => [{self.ED}.comp().format.frames, __panel.getImgCount()]"), [30, 30])
        # Save and render: by the export rule, into the History and onto the canvas.
        pg.evaluate("""() => { window.__landed = []; window.__nodes = [];
            __panel.exportLanded = async (p) => { window.__landed.push(p); };
            __panel.previzNodeForRender = async (p) => { window.__nodes.push(p); return 'image'; }; }""")
        pg.evaluate(f"() => {self.ED}.save()")
        self.assertFalse(pg.evaluate(f"() => {self.ED}.isDirty()"))
        got = pg.evaluate("""async (path) => { const r = await __panel.compRender(path, { format: 'png', first: 3, last: 4 });
            if (r.ok) await __panel.compLand(r.result); return r; }""", path)
        self.assertTrue(got["ok"], got)
        files = got["result"]["paths"]
        self.assertEqual(len(files), 2)
        self.assertTrue(all(os.path.isfile(f) for f in files))
        self.assertEqual(pg.evaluate("() => window.__landed"), [files])
        nodes = pg.evaluate("() => window.__nodes")
        self.assertEqual(len(nodes), 1)
        self.assertTrue(nodes[0]["isSequence"])
        from PIL import Image
        px = np.asarray(Image.open(files[0]).convert("RGBA"))
        self.assertEqual(tuple(px[20, 20])[:3], (255, 0, 0))
        # Leaving the tab gives the viewport back and puts the comp's panels away.
        pg.evaluate("() => __panel.closeTab(__panel.activeTab)")
        st = pg.evaluate("""() => ({ graph: __panel.isPanelDocked('compGraph'), mode: __panel.viewport.classList.contains('comp-mode') })""")
        self.assertEqual(st, {"graph": False, "mode": False})
        self.assertEqual(self.errors, [])

    def test_a_roto_shape_drawn_on_the_picture_and_the_new_nodes_rendered_by_the_server(self):
        pg = self.page()
        path = self.new_comp(pg)
        # A Roto (no input: a white matte) straight into the Output.
        pg.evaluate(f"""() => {{ const e = {self.ED}; const c = e.comp(); e.select([]);
            const r = e.addNode('roto'); c.nodes.find((n) => n.type === 'output').inputs = [r.id]; e.select([r.id]); }}""")
        pg.evaluate("() => __panel.compPropsPanel.querySelectorAll('button').forEach((b) => { if (b.textContent === 'Draw a shape') b.click(); })")
        self.assertTrue(pg.evaluate(f"() => !!{self.ED}.state.draw"))
        box = pg.evaluate(f"() => {{ const r = {self.ED}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda fx, fy: (box[0] + box[2] * fx, box[1] + box[3] * fy)
        for fx, fy in ((0.2, 0.2), (0.6, 0.2), (0.6, 0.7), (0.2, 0.7), (0.2, 0.2)):   # the last click closes it
            pg.mouse.click(*at(fx, fy))
        shapes = pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.type === 'roto').shapes")
        self.assertEqual(len(shapes), 1)
        self.assertEqual(len(shapes[0]["pts"]), 4)
        self.assertFalse(pg.evaluate(f"() => !!{self.ED}.state.draw"))
        pg.wait_for_timeout(600)
        self.assertGreater(self.pixel(pg, 0.4, 0.45)[0], 200, "inside the shape: white")
        self.assertLess(self.pixel(pg, 0.85, 0.45)[0], 30, "outside: black")
        # Drag a corner: the shape follows, as one undo step.
        pg.mouse.move(*at(0.6, 0.7)); pg.mouse.down(); pg.mouse.move(*at(0.8, 0.85), steps=4); pg.mouse.up()
        moved = pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.type === 'roto').shapes[0].pts[2]")
        fw, fh = pg.evaluate(f"() => [{self.ED}.comp().format.width, {self.ED}.comp().format.height]")
        self.assertAlmostEqual(moved[0] / fw, 0.8, delta=0.02)
        self.assertAlmostEqual(moved[1] / fh, 0.85, delta=0.02)
        # Animate it: a key at 0, the corner moved at 10 sets a second key.
        pg.evaluate(f"""() => {{ const e = {self.ED}; e.setFrame(0, {{ fromHost: true }}); }}""")
        pg.evaluate("() => __panel.compPropsPanel.querySelector('.cp-shrow .mg-sw').click()")
        pg.evaluate(f"""() => {{ const e = {self.ED}; e.setFrame(10, {{ fromHost: true }}); }}""")
        pg.mouse.move(*at(0.8, 0.85)); pg.mouse.down(); pg.mouse.move(*at(0.7, 0.6), steps=4); pg.mouse.up()
        keys = pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.type === 'roto').shapes[0].keys.map((k) => k.f)")
        self.assertEqual(keys, [0, 10])
        # The new nodes through the server's render: the roto cuts a constant, depth blur and a crop after it.
        pg.evaluate(f"""() => {{ const e = {self.ED}; const c = e.comp(); const roto = c.nodes.find((n) => n.type === 'roto');
            const bg = c.nodes.find((n) => n.type === 'constant'); bg.color = [1, 0, 0, 1]; roto.inputs = [bg.id];
            e.select([roto.id]); const crop = e.addNode('crop', {{ topleft: [0, 0], bottomright: [c.format.width / 2, c.format.height] }});
            e.select([crop.id]); e.addNode('depthblur', {{ size: 8 }}); e.refresh(); }}""")
        pg.evaluate(f"() => {self.ED}.save()")
        got = pg.evaluate("async (path) => __panel.compRender(path, { format: 'png', first: 0, last: 0 })", path)
        self.assertTrue(got["ok"], got)
        from PIL import Image
        res = got["result"]
        px = np.asarray(Image.open((res.get("paths") or [res["path"]])[0]).convert("RGBA")).astype(int)
        h, w = px.shape[:2]
        self.assertEqual(tuple(px[int(h * 0.3), int(w * 0.3)]), (255, 0, 0, 255), "inside the shape and the crop")
        self.assertEqual(px[int(h * 0.3), int(w * 0.75), 3], 0, "cropped away")
        self.assertEqual(px[int(h * 0.05), int(w * 0.05), 3], 0, "outside the shape")
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "comp-roto.png"))
        self.assertEqual(self.errors, [])

    def test_the_eye_on_a_node_shows_it_in_the_picture_and_the_viewed_node_is_tagged(self):
        pg = self.page()
        self.new_comp(pg)
        g = "__panel.compGraphPanel"
        tag = lambda: pg.evaluate(f"() => Array.from({g}.querySelectorAll('.cp-vtag')).map((t) => [t.closest('.cp-node').dataset.id, t.textContent])")
        self.assertEqual(tag(), [["Output1", "OUTPUT"]])
        pg.evaluate(f"() => {g}.querySelector('.cp-node[data-id=Constant1] .cp-eye').dispatchEvent(new PointerEvent('pointerdown', {{ bubbles: true, button: 0 }}))")
        self.assertEqual(tag(), [["Constant1", "VIEWER"]])
        self.assertEqual(pg.evaluate(f"() => {self.ED}.state.view"), "Constant1")
        if SHOTS:
            pg.mouse.move(10, 10)
            pg.wait_for_timeout(300)
            pg.locator(".cp-graph").first.screenshot(path=os.path.join(SHOTS, "comp-viewer-tag.png")) if pg.locator(".cp-graph").count() else None
        pg.evaluate(f"() => {g}.querySelector('.cp-node[data-id=Constant1] .cp-eye').dispatchEvent(new PointerEvent('pointerdown', {{ bubbles: true, button: 0 }}))")
        self.assertEqual(tag(), [["Output1", "OUTPUT"]], "clicked again: back to the Output")
        self.assertEqual(self.errors, [])

    def test_the_graph_in_comfyuis_bottom_panel(self):
        pg = self.page()
        self.new_comp(pg)
        # ComfyUI's bottom panel, as a plain element of the page (outside the viewer's shadow root).
        # The extension registers the tab (window.__ext is what the page handed registerExtension) ...
        self.assertIn("imageviewer-comp", pg.evaluate("() => (window.__ext.bottomPanelTabs || []).map((t) => t.id)"))
        # ... over ITS viewer; this page's viewer is __panel, so the same tab is made over that one.
        pg.evaluate("""async () => { const m = await import('/extensions/viewer/imageViewer_compComfyTab.js');
            const tab = m.compBottomTabs(() => __panel, () => {})[0];
            const el = document.createElement('div'); el.id = 'bottom-panel';
            Object.assign(el.style, { position: 'fixed', left: '0', right: '0', bottom: '0', height: '260px', background: '#111', zIndex: 5 });
            document.body.append(el); window.__tab = tab; tab.render(el); }""")
        pg.wait_for_timeout(300)
        st = pg.evaluate("""() => ({ here: !!document.querySelector('#bottom-panel .cp-graph'),
            nodes: document.querySelectorAll('#bottom-panel .cp-node').length,
            dock: __panel.compGraphPanel.querySelector('.comp-slot').textContent,
            name: document.querySelector('#bottom-panel .ivc-name').textContent })""")
        self.assertTrue(st["here"], st)
        self.assertEqual(st["nodes"], 2)
        self.assertIn("bottom panel", st["dock"])
        self.assertIn("shot_v", st["name"])
        # It is the same editor: a node added in the viewer shows down there, and the bar steps the viewer's time.
        pg.evaluate(f"() => {self.ED}.addNode('blur')")
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate("() => document.querySelectorAll('#bottom-panel .cp-node').length"), 3)
        pg.evaluate("() => Array.from(document.querySelectorAll('#bottom-panel .ivc-bar button')).find((b) => b.textContent === '▶|').click()")
        self.assertEqual(pg.evaluate(f"() => {self.ED}.state.frame"), 1)
        pg.wait_for_timeout(300)
        self.assertEqual(pg.evaluate("() => document.querySelector('#bottom-panel .ivc-frame').textContent"), "1 / 47")
        if SHOTS:
            pg.evaluate(f"() => {{ __panel.style.height = '640px'; {self.ED}.frameAll(); }}")
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-bottom-panel.png"))
        # The viewer on another tab: the strip says so; back on the comp, the graph is there again.
        key = pg.evaluate("() => __panel.activeTab")
        pg.evaluate("() => { __panel.allTabs['folder_x'] = []; __panel.tabOrder.push('folder_x'); __panel.switchTab('folder_x'); }")
        self.assertIn("not on a comp", pg.evaluate("() => document.querySelector('#bottom-panel').textContent"))
        pg.evaluate("(k) => __panel.switchTab(k)", key)
        self.assertTrue(pg.evaluate("() => !!document.querySelector('#bottom-panel .cp-graph')"))
        # The tab goes: the graph is the Node Graph panel's again.
        pg.evaluate("() => window.__tab.destroy()")
        self.assertTrue(pg.evaluate("() => !!__panel.compGraphPanel.querySelector('.comp-slot .cp-graph')"))
        self.assertEqual(self.errors, [])

    def test_the_comp_button_offers_new_and_open(self):
        pg = self.page()
        pg.evaluate("() => __panel.spaceOpen('comp')")
        pg.wait_for_function("() => __panel.activeTab === 'comp:'", timeout=5000)
        labels = pg.evaluate("() => Array.from(__panel.viewport.querySelectorAll('.comp-view .mg-open-btn')).map((b) => b.textContent)")
        self.assertEqual(labels, ["New comp", "Open…"])
        pg.evaluate("() => __panel.viewport.querySelector('.comp-view .mg-open-btn').click()")
        pg.wait_for_function(f"() => {{ const e = {self.ED}; return e && e.comp(); }}", timeout=10000)
        self.assertNotIn("comp:", pg.evaluate("() => __panel.tabOrder"))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
