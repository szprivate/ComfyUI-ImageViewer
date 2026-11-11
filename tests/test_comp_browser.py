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

    def test_the_graph_has_a_grid_nodes_snap_and_align_to_it(self):
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate("() => { try { localStorage.removeItem('imageviewer.comp.grid'); } catch (_) {} }")
        pg.evaluate("() => __panel.setPanelDocked('compGraph', true)")
        graph = pg.evaluate_handle("() => __panel.compGraphPanel.querySelector('.cp-graph')")
        st = graph.evaluate("(g) => ({ grid: g.dataset.grid, img: g.style.backgroundImage.length > 0, on: g.querySelector('.cp-grid-btn').classList.contains('on'), snap: g.querySelector('.cp-snap-btn').classList.contains('on') })")
        self.assertEqual((st["img"], st["on"], st["snap"]), (True, True, True), st)
        # A node dragged lands on the grid.
        box = graph.evaluate("(g) => { const r = g.querySelector('.cp-node').getBoundingClientRect(); return [r.left + 20, r.top + 10]; }")
        pg.mouse.move(*box); pg.mouse.down(); pg.mouse.move(box[0] + 37, box[1] + 23, steps=5); pg.mouse.up()
        xy = pg.evaluate(f"() => {{ const e = {self.ED}; const n = e.comp().nodes[0]; return [n.x, n.y]; }}")
        self.assertEqual([xy[0] % 15, xy[1] % 15], [0, 0], xy)
        self.assertNotEqual(xy, [0, 0])
        # Shift while dragging: placed freely.
        box = graph.evaluate("(g) => { const r = g.querySelector('.cp-node').getBoundingClientRect(); return [r.left + 20, r.top + 10]; }")
        scale = pg.evaluate(f"() => {self.ED}.state.graph.s")
        pg.mouse.move(*box); pg.mouse.down(); pg.keyboard.down("Shift"); pg.mouse.move(box[0] + 7 * scale, box[1] + 4 * scale, steps=4); pg.mouse.up(); pg.keyboard.up("Shift")
        xy2 = pg.evaluate(f"() => {{ const n = {self.ED}.comp().nodes[0]; return [n.x, n.y]; }}")
        self.assertTrue(xy2[0] % 15 or xy2[1] % 15, xy2)
        # Align: two nodes in a column, one undo step.
        pg.evaluate(f"""() => {{ const e = {self.ED}; const c = e.comp(); c.nodes[0].x = 47; c.nodes[1].x = 200; e.select(c.nodes.slice(0, 2).map((n) => n.id)); }}""")
        graph.evaluate("(g) => g.querySelector('.cp-align-btn').click()")
        items = graph.evaluate("(g) => [...g.querySelectorAll('.cp-pop > div')].map((d) => [d.textContent, d.classList.contains('off')])")
        self.assertIn(["Align in a column", False], items)
        self.assertIn(["Spread out across", True], items)            # needs three
        graph.evaluate("(g) => [...g.querySelectorAll('.cp-pop > div')].find((d) => d.textContent === 'Align in a column').click()")
        xs = pg.evaluate(f"() => {self.ED}.comp().nodes.slice(0, 2).map((n) => n.x)")
        self.assertEqual(xs[0], xs[1]); self.assertEqual(xs[0] % 15, 0)
        pg.evaluate(f"() => {self.ED}.undo ? {self.ED}.undo() : null")
        # The switches: G hides the grid, S stops snapping; kept for the next comp.
        corner = graph.evaluate("(g) => { const r = g.getBoundingClientRect(); return [r.right - 30, r.top + 40]; }")
        pg.mouse.click(*corner)
        pg.keyboard.press("g"); pg.keyboard.press("s")
        st = graph.evaluate("(g) => ({ grid: g.dataset.grid, snap: g.querySelector('.cp-snap-btn').classList.contains('on') })")
        self.assertEqual(st, {"grid": "off", "snap": False})
        self.assertEqual(pg.evaluate("() => JSON.parse(localStorage.getItem('imageviewer.comp.grid'))"), {"show": False, "snap": False})
        pg.keyboard.press("g"); pg.keyboard.press("s")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-grid.png"))
        self.assertEqual(self.errors, [])

    def test_new_open_and_save_buttons_as_paints_with_save_as(self):
        pg = self.page()
        path = self.new_comp(pg)
        bar = pg.evaluate("() => [...__panel.container.querySelectorAll('.mg-bar .cp-ibtn')].map((b) => [b.className.split(' ').find((c) => c.startsWith('cp-') && c !== 'cp-ibtn'), !!b.querySelector('svg.paint-icon')])")
        self.assertEqual(bar, [["cp-new", True], ["cp-open", True], ["cp-save", True]])
        # Save opens Paint's kind of menu.
        pg.evaluate("() => __panel.container.querySelector('.mg-bar .cp-save').click()")
        rows = pg.evaluate("() => [...__panel.container.querySelectorAll('.cp-pop > div')].map((d) => d.firstChild.textContent)")
        self.assertEqual(rows, ["Save", "Save as…", "Render…", "Export to Nuke…", "Open…", "New comp"])
        # Open: the file picker for comps; New: a new comp tab.
        pg.evaluate("() => { window.__picked = 0; __panel.compPickFile = () => { window.__picked++; }; }")
        pg.evaluate("() => __panel.container.querySelector('.cp-pop').remove()")
        pg.evaluate("() => __panel.container.querySelector('.mg-bar .cp-open').click()")
        self.assertEqual(pg.evaluate("() => window.__picked"), 1)
        pg.evaluate("() => __panel.container.querySelector('.mg-bar .cp-new').click()")
        pg.wait_for_function(f"(p) => __panel.activeTab.startsWith('comp:') && __panel.activeTab !== 'comp:' + p", arg=path, timeout=10000)
        newer = pg.evaluate("() => __panel.activeTab")
        # Save as from Ctrl+Shift+S: a dialog, the comp goes on in the new file's tab, the old tab closes.
        pg.evaluate(f"() => {{ const e = {self.ED}; e.comp().format.frames = 17; }}")
        pg.evaluate(f"() => {self.ED}.state.dirty = true")
        root = pg.evaluate_handle("() => __panel.container.querySelector('.comp-tab:not([style*=none]) .cp-root')")
        root.evaluate("(r) => r.focus()")
        pg.keyboard.press("Control+Shift+S")
        pg.wait_for_function("() => !!__panel.container.querySelector('.cp-saveas')", timeout=5000)
        folder = os.path.join(self.dirs["output"], "saved_as")
        pg.evaluate("""(f) => { const b = __panel.container.querySelector('.cp-saveas'); b.querySelector('.cp-saveas-name').value = 'other shot';
            b.querySelector('.cp-saveas-folder').value = f; b.querySelector('.cp-saveas-go').click(); }""", folder)
        target = os.path.join(folder, "other shot.comp.json")
        pg.wait_for_function("(t) => __panel.activeTab === 'comp:' + t", arg=target, timeout=10000)
        self.assertTrue(os.path.isfile(target))
        import json
        with open(target) as fh:
            self.assertEqual(json.load(fh)["format"]["frames"], 17)
        self.assertNotIn(newer, pg.evaluate("() => __panel.tabOrder"))
        self.assertFalse(pg.evaluate(f"() => {self.ED}.isDirty()"))
        # Again into the same name: asked first.
        pg.evaluate("() => { __panel.compSaveAs(); }")
        pg.wait_for_function("() => !!__panel.container.querySelector('.cp-saveas')", timeout=5000)
        pg.evaluate("""(f) => { const b = __panel.container.querySelector('.cp-saveas'); b.querySelector('.cp-saveas-name').value = 'other shot';
            b.querySelector('.cp-saveas-folder').value = f; b.querySelector('.cp-saveas-go').click(); }""", folder)
        pg.wait_for_function("() => { const o = __panel.container.querySelector('.cp-saveas-over'); return o && o.style.display !== 'none'; }", timeout=5000)
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-save-as.png"))
        pg.keyboard.press("Escape")
        self.assertEqual(self.errors, [])

    def test_a_value_shows_while_it_is_typed_and_the_timeline_scrub_redraws(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"() => {{ const e = {ED}; e.comp().nodes.find((n) => n.id === 'Constant1').color = [1, 1, 1, 1]; e.refresh(); e.select(['Constant1']); }}")
        pg.wait_for_timeout(300)
        alpha = pg.locator(".comp-params .mg-prop input[type=number]").first
        alpha.click()
        alpha.fill("")
        pg.keyboard.type("0.25")                    # not committed: no Enter, the field keeps the focus
        pg.wait_for_timeout(300)
        px = self.pixel(pg, 0.5, 0.5)
        self.assertLess(abs(px[0] - 137), 6, f"the picture shows the typed alpha at once (0.25 linear in sRGB): {px}")
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(200)
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.id === 'Constant1').color[3]"), 0.25)
        pg.evaluate(f"() => {ED}.undo()")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.id === 'Constant1').color[3]"), 1, "one undo step back to before")
        # The colour keyed over time; the viewer's timeline dragged: the picture follows while it moves.
        pg.evaluate(f"""() => {{ const e = {ED}; const n = e.comp().nodes.find((x) => x.id === 'Constant1');
            n.tracks = {{ color: [{{ f: 0, v: [0, 0, 0, 1] }}, {{ f: 40, v: [1, 1, 1, 1] }}] }}; e.refresh(); }}""")
        seen = pg.evaluate(f"""async () => {{ const e = {ED}; const out = [];
            for (let f = 0; f <= 40; f += 10) {{ __panel.setFrame(f); await new Promise((r) => setTimeout(r, 160));
                const c = e.canvas; out.push(c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[0]); }}
            return out; }}""")
        self.assertEqual(seen, sorted(seen), seen)
        self.assertLess(seen[0], 20); self.assertGreater(seen[-1], 235)
        self.assertGreaterEqual(len(set(seen)), 4, seen)
        self.assertEqual(self.errors, [])

    def test_a_node_dropped_on_a_wire_goes_into_the_flow(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate("() => __panel.setPanelDocked('compGraph', true)")
        # A free Blur beside the Background -> Output wire.
        pg.evaluate(f"""() => {{ const e = {ED}; e.select([]); const b = e.addNode('blur'); const n = e.comp().nodes.find((x) => x.type === 'blur');
            n.x = 400; n.y = 60; n.inputs = [null]; e.select([]); e.refresh(); }}""")
        pg.wait_for_timeout(200)
        graph = pg.evaluate_handle("() => __panel.compGraphPanel.querySelector('.cp-graph')")
        start = graph.evaluate("(g) => { const r = g.querySelector('.cp-node[data-id=Blur1]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        wire = graph.evaluate("""(g) => { const p = g.querySelector('.cp-wires path'); const L = p.getTotalLength(), m = p.getPointAtLength(L / 2);
            const ctm = p.getScreenCTM(); return [m.x * ctm.a + ctm.e, m.y * ctm.d + ctm.f]; }""")
        pg.mouse.move(*start); pg.mouse.down()
        pg.mouse.move(*wire, steps=8)
        self.assertEqual(graph.evaluate("(g) => g.querySelectorAll('.cp-wires path.cp-wire-hot').length"), 1, "the wire lights up")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-drop-on-wire.png"))
        pg.mouse.up()
        ins = pg.evaluate(f"() => {{ const c = {ED}.comp(); const by = (id) => c.nodes.find((n) => n.id === id); return [by('Blur1').inputs, by(c.output).inputs]; }}")
        self.assertEqual(ins, [["Constant1"], ["Blur1"]])
        pg.evaluate(f"() => {ED}.undo()")
        self.assertEqual(pg.evaluate(f"() => {{ const c = {ED}.comp(); return c.nodes.find((n) => n.id === c.output).inputs; }}"), ["Constant1"])
        self.assertEqual(self.errors, [])

    def test_the_curve_editor_shows_the_selected_nodes_keys_and_edits_them(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"""() => {{ const e = {ED}; const n = e.comp().nodes.find((x) => x.id === 'Constant1');
            n.tracks = {{ color: [{{ f: 0, v: [0, 0, 0, 1] }}, {{ f: 40, v: [1, 0.5, 0, 1] }}] }}; e.select(['Constant1']); }}""")
        pg.evaluate("() => __panel.setPanelDocked('compCurves', true)")
        pg.wait_for_timeout(300)
        st = pg.evaluate("""() => { const h = __panel.compCurvesPanel; return { front: __panel.isPanelFront ? __panel.isPanelFront('compCurves') : true,
            curves: [...h.querySelectorAll('.curves-ch')].map((b) => b.textContent), dots: h.querySelectorAll('.kf-dot').length,
            paths: h.querySelectorAll('svg path[data-curve]').length }; }""")
        self.assertTrue(st["front"], st)
        self.assertEqual(st["curves"], ["Background.color.r", "Background.color.g", "Background.color.b", "Background.color.a"], st)
        self.assertEqual(st["dots"], 8)
        self.assertEqual(st["paths"], 4)
        # Only the red curve, then its last key dragged down: the key changes, one undo step.
        pg.evaluate("() => [...__panel.compCurvesPanel.querySelectorAll('.curves-ch')][0].click()")
        dot = pg.evaluate("""() => { const d = __panel.compCurvesPanel.querySelector('.kf-dot[data-f="40"]'); const r = d.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }""")
        wrap = pg.evaluate("() => { const r = __panel.compCurvesPanel.querySelector('.kf-dot').parentElement.getBoundingClientRect(); return [r.top, r.height]; }")
        pg.mouse.move(*dot); pg.mouse.down()
        pg.mouse.move(dot[0], dot[1] + wrap[1] * 0.3, steps=6)
        pg.mouse.up()
        red = pg.evaluate(f"() => {ED}.comp().nodes.find((x) => x.id === 'Constant1').tracks.color[1].v")
        self.assertLess(red[0], 0.9, red)
        self.assertEqual(red[1:], [0.5, 0, 1], "the other axes are left as they were")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-curve-editor.png"))
        pg.evaluate(f"() => {ED}.undo()")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((x) => x.id === 'Constant1').tracks.color[1].v"), [1, 0.5, 0, 1])
        # A tangent: click the key, drag its handle; the curve's ease changes, the keys stay.
        pg.evaluate("""() => { const d = __panel.compCurvesPanel.querySelector('.kf-dot[data-f="0"]'); d.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 })); d.ownerDocument.defaultView.dispatchEvent(new PointerEvent('pointerup')); }""")
        h = pg.evaluate("() => { const t = __panel.compCurvesPanel.querySelector('.kf-tan'); if (!t) return null; const r = t.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        self.assertIsNotNone(h)
        pg.mouse.move(*h); pg.mouse.down(); pg.mouse.move(h[0], h[1] - 40, steps=4); pg.mouse.up()
        k0 = pg.evaluate(f"() => {ED}.comp().nodes.find((x) => x.id === 'Constant1').tracks.color[0]")
        self.assertIn("to", k0)
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
        self.assertEqual(pg.locator(".mg-bar button", has_text="Nuke…").count(), 0)   # in Save's menu only
        self.assertEqual(pg.locator(".mg-bar button", has_text="Render…").count(), 0)
        pg.locator(".mg-bar .cp-save").click()
        pg.locator("text=Export to Nuke…").last.click()
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

    def test_render_dialog_offers_the_send_nodes_formats_and_options(self):
        """Render…: the format menu and the per-format rows are the Send to Viewer node's (file_writer); a JPEG
        sequence is numbered from the first frame number at the padding and written at the quality asked."""
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate("() => __panel.compSetFormat({ duration: 2 })")
        pg.evaluate("""() => { window.__landed = []; __panel.exportLanded = async (p) => { window.__landed.push(p); };
            __panel.previzNodeForRender = async () => 'image'; }""")
        pg.evaluate("() => __panel.compRenderDialog()")
        pg.wait_for_selector(".export-dlg .rd-box")
        pg.wait_for_timeout(200)
        fmts = pg.evaluate("() => Array.from(__panel.container.querySelector('.export-dlg .rd-box select').options).map((o) => o.value)")
        for f in ("png", "exr", "tiff", "jpg", "mp4", "mov", "webm"):
            self.assertIn(f, fmts)
        shown = lambda: pg.evaluate("""() => Array.from(__panel.container.querySelectorAll('.export-dlg .rd-row'))
            .filter((r) => r.style.display !== 'none' && r.querySelector('.rd-label'))
            .map((r) => [r.querySelector('.rd-label').textContent, Array.from(r.querySelectorAll(':scope > .rd-inline'))
                .filter((w) => w.style.display !== 'none').map((w) => w.firstChild.textContent)])""")
        pick = lambda f: pg.evaluate("""(f) => { const s = __panel.container.querySelector('.export-dlg .rd-box select');
            s.value = f; s.dispatchEvent(new Event('change')); }""", f)
        pick("mov")
        rows = dict(shown())
        self.assertEqual(rows["Save as"], ["Quality", "Codec"])
        self.assertNotIn("Numbered", rows)
        pick("exr")
        rows = dict(shown())
        self.assertEqual(rows["Save as"], ["Bit depth", "Compression"])
        self.assertIn("Numbered", rows)
        self.assertNotIn("Colour", rows)
        pick("jpg")
        rows = dict(shown())
        self.assertEqual(rows["Save as"], ["Quality"])
        pg.wait_for_function("() => /\\.jpg$/.test(__panel.container.querySelector('.export-dlg .export-where').textContent)")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-render-dialog.png"))
        pg.evaluate("""() => { const nums = __panel.container.querySelectorAll('.export-dlg input[type=number]');
            const [q, , first, pad] = nums; q.value = 55; first.value = 1001; pad.value = 4; }""")
        pg.locator(".export-dlg .rd-box button", has_text="Render").last.click()
        pg.wait_for_function("() => !__panel.container.querySelector('.export-dlg')", timeout=60000)
        landed = pg.evaluate("() => window.__landed")
        self.assertEqual(len(landed), 1)
        names = [os.path.basename(p) for p in landed[0]]
        self.assertTrue(names[0].endswith(".1001.jpg") and names[1].endswith(".1002.jpg"), names)
        self.assertEqual(self.errors, [])

    def test_a_roto_shape_drawn_with_the_viewers_roto_tool_and_the_new_nodes_rendered_by_the_server(self):
        pg = self.page()
        path = self.new_comp(pg)
        # A Roto (no input: a white matte) straight into the Output. Selecting it brings the viewer's Roto tool up.
        pg.evaluate(f"""() => {{ const e = {self.ED}; const c = e.comp(); e.select([]);
            const r = e.addNode('roto'); c.nodes.find((n) => n.type === 'output').inputs = [r.id]; e.select([r.id]); }}""")
        on = pg.evaluate("() => ({ tool: __panel._toolState.active, comp: !!(__panel._toolState.node && __panel._toolState.node._compRoto),"
                         " inStage: __panel._toolDraw.parentNode === __panel.compEditor().stage,"
                         " panel: !!__panel.compPropsPanel.querySelector('.cp-roto-slot .imageviewer-tool-panel .imageviewer-layer-list') })")
        self.assertEqual(on, {"tool": "roto", "comp": True, "inStage": True, "panel": True})
        pg.evaluate("() => __panel.compPropsPanel.querySelectorAll('button').forEach((b) => { if (b.textContent === '+ Shape') b.click(); })")
        box = pg.evaluate(f"() => {{ const r = {self.ED}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda fx, fy: (box[0] + box[2] * fx, box[1] + box[3] * fy)
        for fx, fy in ((0.2, 0.2), (0.6, 0.2), (0.6, 0.7), (0.2, 0.7), (0.2, 0.2)):   # the last click closes it
            pg.mouse.click(*at(fx, fy))
        roto = lambda: pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.type === 'roto').roto")
        r = roto()
        self.assertEqual(len(r["layers"]), 1)
        pts = r["layers"][0]["points"]
        self.assertEqual(len(pts), 4)
        self.assertAlmostEqual(pts[0]["x"], 0.2, delta=0.01)       # shares of the comp's frame, as the viewer's tool keeps them
        self.assertAlmostEqual(pts[2]["y"], 0.7, delta=0.01)
        pg.wait_for_timeout(600)
        self.assertGreater(self.pixel(pg, 0.4, 0.45)[0], 200, "inside the shape: white")
        self.assertLess(self.pixel(pg, 0.85, 0.45)[0], 30, "outside: black")
        # Drag a corner: the shape follows; the comp's undo takes it back and the tool shows that.
        pg.mouse.move(*at(0.6, 0.7)); pg.mouse.down(); pg.mouse.move(*at(0.8, 0.85), steps=4); pg.mouse.up()
        moved = roto()["layers"][0]["points"][2]
        self.assertAlmostEqual(moved["x"], 0.8, delta=0.02)
        self.assertAlmostEqual(moved["y"], 0.85, delta=0.02)
        pg.wait_for_timeout(700)    # a new undo step after a pause
        pg.evaluate(f"() => {self.ED}.undo()")
        self.assertAlmostEqual(roto()["layers"][0]["points"][2]["x"], 0.6, delta=0.02)
        self.assertAlmostEqual(pg.evaluate("() => __panel._roto.layers[0].points[2].x"), 0.6, delta=0.02)
        pg.evaluate(f"() => {self.ED}.redo()")
        # Animate it with the tool's keys: a key at 0, the corner moved at 10 sets a second key.
        pg.evaluate(f"() => {{ __panel.setFrame(0); __panel._roto.selLayer = 0; __panel._rotoSetKey(); }}")
        pg.evaluate("() => __panel.setFrame(10)")
        self.assertEqual(pg.evaluate(f"() => {self.ED}.state.frame"), 10)
        pg.mouse.move(*at(0.8, 0.85)); pg.mouse.down(); pg.mouse.move(*at(0.7, 0.6), steps=4); pg.mouse.up()
        keys = sorted(int(k) for k in roto()["layers"][0]["keyframes"])
        self.assertEqual(keys, [0, 10])
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "comp-roto.png"))
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
        # Another node selected: the tool goes off and its overlay back into the viewport.
        pg.evaluate(f"() => {{ const e = {self.ED}; e.select([e.comp().nodes.find((n) => n.type === 'constant').id]); }}")
        off = pg.evaluate("() => ({ tool: __panel._toolState.active, home: __panel._toolDraw.parentNode === __panel.viewport })")
        self.assertEqual(off, {"tool": "none", "home": True})
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
        # A Transform has a jack: the middle moves, Ctrl+drag the centre alone, the ring scales, the bar turns.
        pg.evaluate(f"() => {ED}.addNode('transform')")
        parts = pg.evaluate("() => Array.from(__panel.compEditor().stage.querySelectorAll('.cp-over [data-jack]')).map((e) => e.dataset.jack)")
        self.assertEqual(sorted(set(parts)), ["e", "move", "n", "ring", "rot", "s", "skew", "w"])
        tr = lambda: pg.evaluate(f"() => {{ const n = {ED}.comp().nodes.find((x) => x.type === 'transform'); return [n.translate || [0, 0], n.rotate || 0, n.scale || [1, 1], n.center || null]; }}")
        mid = lambda sel: (lambda b: (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2))(pg.locator(sel).bounding_box())
        cx, cy = mid(".cp-over .cp-jctr")
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 30, cy + 10, steps=4); pg.mouse.up()
        t, r, sc, c = tr()
        self.assertAlmostEqual(t[0], 30 / k, delta=1); self.assertAlmostEqual(t[1], 10 / k, delta=1)
        bx, by = mid(".cp-over .cp-jbar.rot")
        cx, cy = mid(".cp-over .cp-jctr")
        pg.mouse.move(bx, by); pg.mouse.down(); pg.mouse.move(cx, cy + (bx - cx), steps=6); pg.mouse.up()
        self.assertAlmostEqual(tr()[1], 90, delta=2)
        ex, ey = mid(".cp-over .cp-jsq[data-jack=n]")
        pg.mouse.move(ex, ey); pg.mouse.down(); pg.mouse.move(cx + 2 * (ex - cx), cy + 2 * (ey - cy), steps=6); pg.mouse.up()   # twice as far out (it turned with the jack)
        self.assertAlmostEqual(tr()[2][1], 2, delta=0.08)   # scale up and down: n is its own axis
        pg.keyboard.down("Control"); pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 20, cy, steps=4); pg.mouse.up(); pg.keyboard.up("Control")
        t2, r2, sc2, c2 = tr()
        self.assertIsNotNone(c2, "Ctrl+drag moves the centre")
        if SHOTS:
            pg.wait_for_timeout(400)
            pg.screenshot(path=os.path.join(SHOTS, "comp-transform-jack.png"))
        # A Crop has a box: its edges, corners and inside.
        pg.evaluate(f"() => {ED}.addNode('crop', {{ topleft: [200, 100], bottomright: [1400, 900] }})")
        self.assertEqual(pg.locator(".cp-over rect.cp-jsq[data-crop]").count(), 4)
        lx, ly = mid(".cp-over .cp-cedge[data-crop=l]")
        pg.mouse.move(lx, ly); pg.mouse.down(); pg.mouse.move(lx + 40, ly, steps=4); pg.mouse.up()
        crop = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'crop').topleft")
        self.assertAlmostEqual(crop[0], 200 + 40 / k, delta=1.5)
        self.assertEqual(crop[1], 100)
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
        # A mid grey (linear 0.18) shown plainly, then through a display / view that is not the plain sRGB curve.
        pg.evaluate(f"() => {{ const e = {self.ED}; e.comp().nodes = e.comp().nodes.filter((n) => n.type !== 'ocio_colorspace'); const c = e.comp().nodes.find((n) => n.id === 'Constant1'); c.color = [0.18, 0.18, 0.18, 1]; e.comp().nodes.find((n) => n.type === 'output').inputs = ['Constant1']; e.refresh(); }}")
        pg.wait_for_timeout(500)
        plain = self.pixel(pg, 0.5, 0.5)
        views = pg.evaluate("() => Array.from(Array.from(__panel.container.querySelectorAll('select.mg-btn')).find((s) => s.options[0].text === 'sRGB (plain)').options).map((o) => o.value)")
        pick = next(v for v in views if v and "ACES" in v and "sRGB" in v.split("\u0001")[0])
        # The bake is slow the first time (an ACES config reads its LUT files): redraws asked for meanwhile wait
        # for the same answer - once they drew the plain picture and the menu seemed to do nothing.
        pg.evaluate("() => { const was = __panel._cpOcioLut.bind(__panel); __panel._cpOcioLut = async (spec) => { await new Promise((r) => setTimeout(r, 700)); return was(spec); }; }")
        pg.evaluate("(v) => { const s = Array.from(__panel.container.querySelectorAll('select.mg-btn')).find((s) => s.options[0].text === 'sRGB (plain)'); s.value = v; s.dispatchEvent(new Event('change')); }", pick)
        for _ in range(4):
            pg.wait_for_timeout(120)
            pg.evaluate(f"() => {self.ED}.refresh()")
        pg.wait_for_function(f"(p) => {{ const c = {self.ED}.canvas; const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; return Math.abs(d[0] - p[0]) > 6; }}", arg=plain, timeout=8000)
        self.assertTrue(pg.evaluate(f"() => !!{self.ED}.state.display"))
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "comp-ocio.png"))
        self.assertEqual(self.errors, [])

    def test_the_viewers_exposure_bar_works_over_the_comp_picture(self):
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate(f"() => {{ const e = {self.ED}; const c = e.comp().nodes.find((n) => n.id === 'Constant1'); c.color = [0.1, 0.2, 0.05, 1]; e.comp().nodes.find((n) => n.type === 'output').inputs = ['Constant1']; e.refresh(); }}")
        pg.wait_for_timeout(400)
        before = self.pixel(pg, 0.5, 0.5)
        # The viewer's own bar (the same element) sits in the comp's bar, after the display menu; the input
        # colourspace hidden; on one row with the bar's buttons.
        st = pg.evaluate(f"""() => {{ const c = __panel.exposureControl, bar = c.parentNode, r = c.getBoundingClientRect(),
                p = bar.querySelector('select.mg-btn').getBoundingClientRect();
            return {{ inBar: bar.classList.contains('mg-bar') && bar.parentNode === {self.ED}.stage.parentNode, after: !!(c.previousElementSibling && c.previousElementSibling.tagName === 'SELECT'),
                shown: getComputedStyle(c).display !== 'none', pos: getComputedStyle(c).position, row: Math.abs((r.top + r.bottom) / 2 - (p.top + p.bottom) / 2),
                cs: getComputedStyle(__panel.colorInSel || c).display, chans: Array.from(__panel.rgbChannelSel.options).map((o) => o.text) }}; }}""")
        self.assertTrue(st["inBar"] and st["after"] and st["shown"], st)
        self.assertEqual(st["pos"], "static")
        self.assertLess(st["row"], 3, st)
        self.assertEqual(st["chans"], ["RGB", "Red", "Green", "Blue", "Alpha"])
        if pg.evaluate("() => !!__panel.colorInSel"):
            self.assertEqual(st["cs"], "none")
        # A redraw of the bar (the comp marked changed) keeps it there.
        pg.evaluate(f"() => {{ const e = {self.ED}; e.comp().nodes.find((n) => n.id === 'Constant1').name = 'Plate'; e.refresh(); }}")
        self.assertTrue(pg.evaluate("() => __panel.exposureControl.parentNode.classList.contains('mg-bar')"))
        # Its slider: +2 stops is the colour times four (0.1 -> 0.4: sRGB 170); the label as the viewer writes it.
        pg.evaluate("() => { const r = __panel.exposureSlider; r.value = '2'; r.dispatchEvent(new Event('input')); }")
        pg.wait_for_function(f"() => {{ const c = {self.ED}.canvas; return c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data[0] > 160; }}", timeout=5000)
        self.assertEqual(pg.evaluate("() => __panel.exposureValue.textContent"), "2.0 EV")
        self.assertLess(abs(self.pixel(pg, 0.5, 0.5)[0] - 170), 3)
        # Its channel menu: green as grey.
        pg.evaluate("() => { const s = __panel.rgbChannelSel; s.value = 'green'; s.dispatchEvent(new Event('change')); }")
        pg.wait_for_timeout(300)
        px = self.pixel(pg, 0.5, 0.5)
        self.assertEqual(px[0], px[1]); self.assertEqual(px[1], px[2])
        self.assertGreater(px[0], 220, px)                        # 0.2 x 4 = 0.8
        if SHOTS:
            pg.evaluate("() => { const s = __panel.rgbChannelSel; s.value = 'all'; s.dispatchEvent(new Event('change')); }")
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-exposure-channels.png"))
        # A click on the bar (not the slider) sets it back to 0, as in the viewer; the picture does not pan.
        z = pg.evaluate(f"() => JSON.stringify({self.ED}.state.zoom)")
        box = pg.evaluate("() => { const r = __panel.exposureValue.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        pg.mouse.click(box[0], box[1])
        pg.wait_for_timeout(300)
        self.assertEqual(pg.evaluate("() => __panel.exposure"), 0)
        self.assertEqual(pg.evaluate(f"() => JSON.stringify({self.ED}.state.zoom)"), z)
        # E held and a drag sideways on the picture: the exposure, as in the viewer.
        s = pg.evaluate(f"() => {{ const r = {self.ED}.stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }}")
        pg.mouse.move(s[0], s[1])
        pg.keyboard.down("e")
        pg.mouse.down(); pg.mouse.move(s[0] + 50, s[1], steps=5); pg.mouse.up()
        pg.keyboard.up("e")
        self.assertAlmostEqual(pg.evaluate("() => __panel.exposure"), 1.0, places=1)
        self.assertEqual(pg.evaluate(f"() => JSON.stringify({self.ED}.state.zoom)"), z)
        # The R G B A keys on the picture pick the viewer's channel; again: all of them.
        pg.evaluate(f"() => {self.ED}.stage.closest('.cp-root').focus()")
        pg.keyboard.press("a")
        self.assertEqual(pg.evaluate("() => __panel.channelView"), "alpha")
        pg.keyboard.press("a")
        self.assertEqual(pg.evaluate("() => __panel.channelView"), "all")
        # Leaving Comp puts the bar back in the viewer; the comp itself never changed.
        pg.evaluate("() => __panel.resetExposure()")
        pg.wait_for_timeout(300)
        self.assertEqual(self.pixel(pg, 0.5, 0.5), before)
        self.assertEqual(pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.id === 'Constant1').color"), [0.1, 0.2, 0.05, 1])
        pg.evaluate("() => __panel.compTabLeave()")
        self.assertTrue(pg.evaluate("() => __panel.exposureControl.parentNode === __panel.viewport"))
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
