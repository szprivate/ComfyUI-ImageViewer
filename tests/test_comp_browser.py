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
        st = pg.evaluate("""() => ({ graph: __panel.isPanelDocked('compGraph'), props: __panel.isPanelDocked("params"),
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

    def test_popped_out_the_picture_is_drawn(self):
        """The viewer in its own window, the main window behind it (its frames stop): the picture still draws there,
        for a comp opened before the pop-out and for one opened after it."""
        pg = self.page()
        self.new_comp(pg)
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function(f"() => {self.ED}.canvas.ownerDocument !== document", timeout=10000)
        win.wait_for_timeout(400)
        pg.evaluate("() => { window.requestAnimationFrame = () => 0; }")      # the window behind: no frames there
        for color in ([0, 1, 0, 1], [1, 0, 1, 1]):
            pg.evaluate(f"""(c) => {{ const e = {self.ED}; e.comp().nodes.find((n) => n.type === 'constant').color = c; e.refresh(); }}""", color)
            win.wait_for_timeout(500)
            px = self.pixel(pg, 0.5, 0.5)
            self.assertEqual([px[0] > 200, px[1] > 200, px[2] > 200], [c > 0.5 for c in color[:3]], (color, px))
            box = pg.evaluate(f"""() => {{ const c = {self.ED}.canvas, r = c.getBoundingClientRect(), s = c.parentElement.getBoundingClientRect();
                return [r.width, r.height, s.width, s.height]; }}""")
            self.assertTrue(abs(box[0] - (box[2] - 24)) < 2 or abs(box[1] - (box[3] - 24)) < 2, f"fitted to the stage: {box}")
        # A second comp, opened while popped out.
        self.new_comp(pg)
        pg.evaluate(f"""() => {{ const e = {self.ED}; e.comp().nodes.find((n) => n.type === 'constant').color = [1, 1, 0, 1]; e.refresh(); }}""")
        win.wait_for_timeout(600)
        px = self.pixel(pg, 0.5, 0.5)
        self.assertTrue(px[0] > 200 and px[1] > 200 and px[2] < 60, px)
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            win.screenshot(path=os.path.join(SHOTS, "comp-popped-out.png"))
        self.assertEqual(self.errors, [])

    def test_the_node_menus_scroll_and_find_a_node_by_typing(self):
        """The Add button's menu and the graph's right-click menu: one list that scrolls with the wheel (the graph
        does not zoom under it), a field on top that finds a node by name, category or id, Enter adds it."""
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate("() => __panel.setPanelDocked('compGraph', true)")
        graph = pg.evaluate_handle("() => __panel.compGraphPanel.querySelector('.cp-graph')")
        add = graph.evaluate_handle("(g) => g.querySelector('.cp-add')")
        add.click()
        menu = graph.evaluate_handle("(g) => g.querySelector('.cp-tabmenu')")
        info = menu.evaluate("""(m) => { const l = m.querySelector('.cp-tmlist'), r = m.getBoundingClientRect(), g = m.parentElement.getBoundingClientRect();
            return { scroll: l.scrollHeight > l.clientHeight, inside: r.bottom <= g.bottom + 1, focused: m.getRootNode().activeElement === m.querySelector('input'),
                     heads: m.querySelectorAll('.cp-tmhead').length }; }""")
        self.assertTrue(info["scroll"] and info["inside"] and info["focused"], info)
        self.assertGreater(info["heads"], 3)                        # by category
        zoom = pg.evaluate(f"() => {self.ED}.state.graph.s")
        box = menu.evaluate("(m) => { const r = m.querySelector('.cp-tmlist').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        pg.mouse.move(*box)
        pg.mouse.wheel(0, 300)
        pg.wait_for_timeout(300)
        self.assertGreater(menu.evaluate("(m) => m.querySelector('.cp-tmlist').scrollTop"), 0, "the list scrolled")
        self.assertEqual(pg.evaluate(f"() => {self.ED}.state.graph.s"), zoom, "the graph did not zoom")
        # Typing finds it: by name, by category, by id; Enter adds it.
        pg.keyboard.type("defo")
        self.assertEqual(menu.evaluate("(m) => [...m.querySelectorAll('.cp-tmrow')].map((d) => d.dataset.type)"), ["defocus"])
        pg.keyboard.press("Enter")
        self.assertFalse(graph.evaluate("(g) => !!g.querySelector('.cp-tabmenu')"))
        self.assertTrue(pg.evaluate(f"() => {self.ED}.comp().nodes.some((n) => n.type === 'defocus')"))
        # The right-click menu on an empty spot: the same menu, its node placed where it was opened.
        r = graph.evaluate("(g) => { const r = g.getBoundingClientRect(); return [r.left + r.width * 0.8, r.top + r.height * 0.7]; }")
        pg.mouse.click(*r, button="right")
        menu = graph.evaluate_handle("(g) => g.querySelector('.cp-tabmenu')")
        self.assertIn("Frame all (F)", menu.evaluate("(m) => m.textContent"))
        pg.keyboard.type("key")
        types = menu.evaluate("(m) => [...m.querySelectorAll('.cp-tmrow')].map((d) => d.dataset.type)")
        self.assertEqual(set(types), {"keyer", "lumakeyer", "chromakeyer"}, types)
        pg.keyboard.press("ArrowDown")
        pg.keyboard.press("Enter")
        self.assertTrue(pg.evaluate(f"() => {self.ED}.comp().nodes.some((n) => n.type === '{types[1]}')"))
        # On a node: its actions come first and are found by typing too.
        nodebox = graph.evaluate("(g) => { const r = g.querySelector('.cp-node').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        pg.mouse.click(*nodebox, button="right")
        menu = graph.evaluate_handle("(g) => g.querySelector('.cp-tabmenu')")
        self.assertEqual(menu.evaluate("(m) => m.querySelector('.cp-tmrow').textContent"), "View this node (1)")
        pg.keyboard.type("renam")
        self.assertEqual(menu.evaluate("(m) => [...m.querySelectorAll('.cp-tmrow')].map((d) => d.textContent)"), ["Rename…"])
        pg.keyboard.press("Escape")
        self.assertFalse(graph.evaluate("(g) => !!g.querySelector('.cp-tabmenu')"))
        if SHOTS:
            add.click()
            pg.keyboard.type("blur")
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-node-menu.png"))
        self.assertEqual(self.errors, [])

    def test_several_selected_nodes_of_one_type_change_together(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        ids = pg.evaluate(f"""() => {{ const e = {ED}; e.select(['Constant1']);
            const a = e.addNode('blur', {{ size: 2 }}); const b = e.addNode('blur', {{ size: 8 }}); const g = e.addNode('grade');
            e.select([g.id, b.id, a.id]); return [a.id, b.id, g.id]; }}""")
        a, b, g = ids
        P = "__panel.compPropsPanel"
        head = pg.evaluate(f"() => {P}.querySelector('h4').textContent")
        self.assertIn("2 Blur nodes", head)
        size = pg.locator(f'input[data-fk="{a}:size"]')
        self.assertEqual(size.input_value(), "")                       # they differ: a dash
        self.assertEqual(size.get_attribute("placeholder"), "—")
        size.fill("5"); size.dispatch_event("change")
        got = pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'blur').map((n) => n.size)")
        self.assertEqual(got, [5, 5])
        pg.evaluate(f"() => {ED}.undo()")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'blur').map((n) => n.size)"), [2, 8], "one undo step")
        # Up steps each by its own value; the label drag moves each from where it was.
        pg.locator(f'input[data-fk="{a}:size"]').focus()
        pg.keyboard.press("Shift+ArrowUp")
        stepped = pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'blur').map((n) => n.size)")
        self.assertGreater(stepped[0], 2)
        self.assertAlmostEqual(stepped[1] - stepped[0], 6)            # each by the same step from its own value
        # The stopwatch keys every one; the Grade (another type) is left alone.
        pg.locator(f'input[data-fk="{a}:size"]').locator("xpath=..").locator(".mg-sw").click()
        tracks = pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'blur').map((n) => !!(n.tracks && n.tracks.size))")
        self.assertEqual(tracks, [True, True])
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.evaluate(f"() => {{ const e = {ED}; const bl = e.comp().nodes.filter((n) => n.type === 'blur'); bl[1].size = 30; e.refresh(); }}")
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-multi-edit.png"))
            # The node graph filling the viewer, and Parameters folded to its title bar.
            pg.evaluate("() => __panel.dockToggleMaximized('compGraph', true)")
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "panel-maximised.png"))
            pg.evaluate("() => { __panel.dockToggleMaximized('compGraph', false); __panel.setPanelDocked('compLayers', true); __panel.dockToggleCollapsed('params', true); }")
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "panel-folded.png"))
            pg.evaluate("() => __panel.dockToggleCollapsed('params', false)")
        self.assertEqual(self.errors, [])

    def test_export_to_nuke_from_the_bar(self):
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate(f"""() => {{ const e = {self.ED}; const c = e.comp(); const out = c.nodes.find((n) => n.type === 'output');
            const g = e.addNode('glow'); g.inputs = [c.nodes.find((n) => n.type === 'constant').id]; out.inputs = [g.id]; e.refresh(); }}""")
        pg.evaluate("() => __panel.compSetFormat({ duration: 2 })")
        pg.locator(".mg-bar button", has_text="Nuke…").click()
        pg.wait_for_selector(".export-dlg .rd-box")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.wait_for_timeout(400)
            pg.screenshot(path=os.path.join(SHOTS, "comp-nuke-dialog.png"))
        pg.locator(".export-dlg .rd-box button", has_text="Export").last.click()
        pg.wait_for_function("() => !__panel.container.querySelector('.export-dlg')", timeout=60000)
        nk = [os.path.join(r, f) for r, _, fs in os.walk(self.dirs["output"]) for f in fs if f.endswith(".nk")]
        self.assertEqual(len(nk), 1, nk)
        with open(nk[0], encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("Write {", text)
        self.assertIn("glow (baked)", text)
        bake = os.path.splitext(nk[0])[0] + "_bake"
        baked = [f for r, _, fs in os.walk(bake) for f in fs if f.endswith(".exr")]
        self.assertEqual(len(baked), 2)
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

    def test_colorcorrect_is_laid_out_as_color_finesse_and_its_wheels_push_a_range(self):
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate(f"() => {self.ED}.addNode('colorcorrect')")
        P = "__panel.compPropsPanel"
        click = lambda label: pg.evaluate(f"() => Array.from({P}.querySelectorAll('button')).find((b) => b.textContent === {label!r}).click()")
        labels = lambda: pg.evaluate(f"() => Array.from({P}.querySelectorAll('.mg-prop label')).map((l) => l.textContent)")
        self.assertIn("Saturation", labels())
        click("Shadows")
        self.assertIn("Contrast", labels())
        click("RGB")
        self.assertIn("Gamma B", labels())
        click("Hue offsets")
        self.assertEqual(pg.evaluate(f"() => {P}.querySelectorAll('.cp-ccwheel canvas').length"), 4)
        b = pg.evaluate(f"() => {{ const r = {P}.querySelectorAll('.cp-ccwheel canvas')[3].getBoundingClientRect(); return [r.left, r.top, r.width]; }}")
        pg.evaluate(f"() => {P}.querySelectorAll('.cp-ccwheel canvas')[3].scrollIntoView({{block: 'center'}})")
        b = pg.evaluate(f"() => {{ const r = {P}.querySelectorAll('.cp-ccwheel canvas')[3].getBoundingClientRect(); return [r.left, r.top, r.width]; }}")
        cx, cy = b[0] + b[2] / 2, b[1] + b[2] / 2
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx - 10, cy - 10, steps=3); pg.mouse.move(cx - 30, cy, steps=3); pg.mouse.up()
        n = pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.type === 'colorcorrect')")
        self.assertAlmostEqual(n["shadows_tint_hue"], 180, delta=3)
        self.assertGreater(n["shadows_tint"], 50)
        pg.evaluate(f"() => {self.ED}.undo()")
        n = pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.type === 'colorcorrect')")
        self.assertEqual(n["shadows_tint"], 0, "one drag, one undo step")
        click("Luma ranges")
        self.assertEqual(pg.evaluate(f"() => {P}.querySelectorAll('.cp-ccluma polyline').length"), 3)
        click("Secondaries")
        self.assertIn("Hue tolerance", labels())
        if SHOTS:
            click("Hue offsets")
            pg.wait_for_timeout(200)
            pg.locator(".cp-cctabs").first.evaluate("(e) => e.scrollIntoView()")
            pg.screenshot(path=os.path.join(SHOTS, "comp-colorcorrect.png"))
        self.assertEqual(self.errors, [])

    def test_a_lens_flare_with_dirt_and_a_glow_are_drawn(self):
        pg = self.page()
        self.new_comp(pg)
        before = self.pixel(pg, 0.5, 0.5)
        pg.evaluate(f"""() => {{ const e = {self.ED}; e.select(['Constant1']);
            e.addNode('lensflare', {{ position: [1240, 380], dirt_amount: 1.2, dirt_reach: 0.5, ghost_amount: 0.3, ghost_size: 0.06 }});
            e.addNode('glow', {{ threshold: 0.6, size: 40 }}); }}""")
        pg.wait_for_timeout(1500)
        types = pg.evaluate(f"() => {self.ED}.comp().nodes.map((n) => n.type)")
        self.assertIn("lensflare", types)
        self.assertIn("glow", types)
        at_light = self.pixel(pg, 1240 / 1920, 380 / 1080)
        self.assertGreater(sum(at_light[:3]), sum(before[:3]) + 100, (at_light, before))
        P = "__panel.compPropsPanel"
        pg.evaluate(f"() => {self.ED}.select([{self.ED}.comp().nodes.find((n) => n.type === 'lensflare').id])")
        labels = pg.evaluate(f"() => Array.from({P}.querySelectorAll('.mg-prop label')).map((l) => l.textContent)")
        self.assertIn("ghost_shape", labels)
        if SHOTS:
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-lensflare.png"))
        self.assertEqual(self.errors, [])

    def test_handles_on_the_picture_and_numbers_dragged_by_their_label(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"() => {{ const e = {ED}; e.select(['Constant1']); e.addNode('lensflare', {{ position: [960, 540] }}); }}")
        pg.wait_for_timeout(400)
        h = pg.locator(".cp-over circle.cp-handle[data-param=position]")
        self.assertEqual(h.count(), 1)
        b = h.bounding_box()
        cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        k = pg.evaluate(f"() => {ED}.state.zoom.s")
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 40, cy - 20, steps=4); pg.mouse.up()
        pos = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'lensflare').position")
        self.assertAlmostEqual(pos[0], 960 + 40 / k, delta=1.5)
        self.assertAlmostEqual(pos[1], 540 - 20 / k, delta=1.5)
        pg.evaluate(f"() => {ED}.undo()")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'lensflare').position"), [960, 540], "one drag, one undo step")
        # A Transform has a move handle and a centre; a Crop two corners.
        pg.evaluate(f"() => {ED}.addNode('transform')")
        self.assertEqual(pg.locator(".cp-over circle.cp-handle").count(), 2)
        pg.evaluate(f"() => {ED}.addNode('crop')")
        self.assertEqual(pg.locator(".cp-over circle.cp-handle").count(), 2)
        # A number's label dragged to the right raises it; Up in its field steps it and keeps the focus.
        pg.evaluate(f"() => {ED}.select([{ED}.comp().nodes.find((n) => n.type === 'lensflare').id])")
        P = "__panel.compPropsPanel"
        lab = pg.locator(f".mg-prop label.cp-scrub", has_text="intensity").first
        lb = lab.bounding_box()
        lx, ly = lb["x"] + 10, lb["y"] + lb["height"] / 2
        pg.mouse.move(lx, ly); pg.mouse.down(); pg.mouse.move(lx + 50, ly, steps=5); pg.mouse.up()
        v = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'lensflare').intensity")
        self.assertAlmostEqual(v, 1 + 50 * 0.05, delta=0.06)
        pg.evaluate(f"() => {ED}.undo()")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'lensflare').intensity"), 1)
        inp = pg.locator('input[data-fk$=":intensity"]')
        inp.focus()
        pg.keyboard.press("ArrowUp"); pg.keyboard.press("ArrowUp"); pg.keyboard.press("Shift+ArrowUp")
        v = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'lensflare').intensity")
        self.assertAlmostEqual(v, 1 + 0.05 * 12, places=5)
        self.assertTrue(pg.evaluate("() => (document.activeElement.shadowRoot ? document.activeElement.shadowRoot.activeElement : document.activeElement)?.dataset?.fk?.endsWith(':intensity')"))
        # The Add button opens the node list: typed, Enter adds under the selected node.
        pg.locator("button.cp-add").click()
        pg.keyboard.type("refor")
        pg.keyboard.press("Enter")
        self.assertIn("reformat", pg.evaluate(f"() => {ED}.comp().nodes.map((n) => n.type)"))
        pg.evaluate(f"() => {ED}.select([{ED}.comp().nodes.find((n) => n.type === 'lensflare').id])")
        # One panel: the Parameters panel shows the comp node, titled by it; ComfyUI's widgets step aside.
        st = pg.evaluate("""() => ({ mode: __panel.paramsPanel.classList.contains('comp-mode'), title: __panel.paramsTitle.innerText,
            inside: __panel.paramsPanel.contains(__panel.compPropsPanel), widgets: getComputedStyle(__panel.paramsPanel.querySelector('.params-content')).display,
            docked: !!(__panel._dockPanelEl && __panel._dockPanelEl('compProps')) })""")
        self.assertEqual(st, {"mode": True, "title": "LensFlare1", "inside": True, "widgets": "none", "docked": False})
        if SHOTS:
            pg.wait_for_timeout(400)
            pg.screenshot(path=os.path.join(SHOTS, "comp-handles.png"))
        self.assertEqual(self.errors, [])

    def test_ocio_reads_nodes_and_the_viewers_display(self):
        import importlib.util
        if importlib.util.find_spec("PyOpenColorIO") is None:
            self.skipTest("needs PyOpenColorIO")
        pg = self.page()
        self.new_comp(pg)
        pg.wait_for_function(f"() => {self.ED}.state.ocio && {self.ED}.state.ocio.available", timeout=10000)
        pg.evaluate(f"() => {{ {self.ED}.select(['Constant1']); {self.ED}.addNode('ocio_colorspace'); }}")
        P = "__panel.compPropsPanel"
        opts = pg.evaluate(f"() => Array.from({P}.querySelectorAll('select')[0].options).map((o) => o.value)")
        self.assertIn("ACEScct", opts)
        # A display and view of the config in the bar: the picture is drawn through its LUT.
        bar = pg.evaluate(f"() => Array.from(__panel.container.querySelectorAll('select.mg-btn')).map((s) => s.options.length)")
        self.assertTrue(any(n > 2 for n in bar), bar)
        pg.evaluate(f"() => {{ const s = Array.from(__panel.container.querySelectorAll('select.mg-btn')).find((s) => s.options[0].text === 'sRGB (plain)'); s.value = s.options[1].value; s.dispatchEvent(new Event('change')); }}")
        pg.wait_for_timeout(800)
        self.assertTrue(pg.evaluate(f"() => !!{self.ED}.state.display"))
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "comp-ocio.png"))
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
