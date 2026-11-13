"""Comp in the REAL viewer, against the REAL routes: a new comp opens in a Comp tab with the Node Graph up (the
default way in) and the picture over the viewport; a Read laid over the background shows in the picture through the
float16 pixels route; the viewer's bar is the comp's time; Layers is the same graph; the render lands in the History
and on the ComfyUI canvas; leaving the tab gives the viewport back.

    python -m unittest tests.test_comp_browser     (Playwright and aiohttp; skipped without)
"""
import asyncio
import importlib
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

    def test_layers_have_a_length_and_keys_on_a_timeline(self):
        pg = self.page()
        path = self.new_comp(pg)
        comp = {"comp": 1, "format": {"width": 64, "height": 36, "fps": 24, "frames": 40}, "output": "Output1", "nodes": [
            {"id": "BG", "type": "constant", "color": [0, 0, 1, 1], "inputs": [], "x": 0, "y": 0},
            {"id": "Solid", "type": "constant", "color": [1, 0, 0, 1], "inputs": [], "x": 200, "y": 0},
            {"id": "T", "type": "transform", "inputs": ["Solid"], "x": 200, "y": 60,
             "tracks": {"rotate": [{"f": 4, "v": 0}, {"f": 12, "v": 90}], "translate": [{"f": 12, "v": [0, 0]}]}},
            {"id": "Merge1", "type": "merge", "inputs": ["BG", "T", None], "x": 0, "y": 120, "in": 5, "out": 20},
            {"id": "Output1", "type": "output", "inputs": ["Merge1"], "x": 0, "y": 200}]}
        pg.evaluate(f"([c, p]) => {self.ED}.load(c, p)", [comp, path])
        pg.evaluate("() => __panel.setPanelDocked('compLayers', true)")
        pg.wait_for_timeout(250)
        P = "__panel.compLayersPanel"
        self.assertEqual(pg.evaluate(f"() => {P}.querySelectorAll('.cp-lrow').length"), 2)
        bar = pg.locator(".cp-layers .kl-bar").first
        b0 = bar.bounding_box()
        k = b0["width"] / 15                                  # frames 5..19: 15 frames
        # the picture follows the length: frame 2 is the background alone, frame 8 the solid over it
        pg.evaluate("() => __panel.setFrame(2)"); pg.wait_for_timeout(300)
        self.assertGreater(self.pixel(pg, 0.5, 0.5)[2], 200)
        pg.evaluate("() => __panel.setFrame(8)"); pg.wait_for_timeout(300)
        self.assertGreater(self.pixel(pg, 0.5, 0.5)[0], 200)
        # slide the bar by 6 frames: in / out and every key of the layer move
        cx, cy = b0["x"] + 2.5 * k, b0["y"] + b0["height"] / 2      # frame 7.5: no key there
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 3 * k, cy); pg.mouse.move(cx + 6 * k, cy, steps=4); pg.mouse.up()
        got = pg.evaluate(f"""() => {{ const c = {self.ED}.comp(); const m = c.nodes.find((n) => n.id === 'Merge1'), t = c.nodes.find((n) => n.id === 'T');
            return [m.in, m.out, t.tracks.rotate.map((k) => k.f), t.tracks.translate.map((k) => k.f)]; }}""")
        self.assertEqual(got, [11, 26, [10, 18], [18]])
        # one undo step for the drag
        pg.evaluate(f"() => {self.ED}.undo()")
        self.assertEqual(pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.id === 'Merge1').in"), 5)
        # trim the out end by -5 frames
        b0 = bar.bounding_box()
        ex, ey = b0["x"] + b0["width"] - 2, b0["y"] + b0["height"] / 2
        pg.mouse.move(ex, ey); pg.mouse.down(); pg.mouse.move(ex - 5 * k, ey, steps=4); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {{ const m = {self.ED}.comp().nodes.find((n) => n.id === 'Merge1'); return [m.in, m.out]; }}"), [5, 15])
        # unfold the layer: a row per animated param; drag the rotate key at 12 to 16
        pg.locator(".cp-layers .cp-lrow .cp-ltw").first.click()
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate(f"() => {P}.querySelectorAll('.cp-lsub').length"), 2)
        dias = pg.locator(".cp-layers .cp-lsub .kl-dia")
        self.assertEqual(dias.count(), 3)
        d = [dias.nth(i) for i in range(3) if pg.evaluate("(e) => e._keys[0].prop + ':' + e._keys[0].f", dias.nth(i).element_handle()) == "rotate:12"][0]
        db = d.bounding_box()
        dx, dy = db["x"] + db["width"] / 2, db["y"] + db["height"] / 2
        pg.mouse.move(dx, dy); pg.mouse.down(); pg.mouse.move(dx + 2 * k, dy); pg.mouse.move(dx + 4 * k, dy, steps=3); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.id === 'T').tracks.rotate.map((k) => k.f)"), [4, 16])
        # a box over both sub rows around frame 4..16 picks three keys; Del takes them away (rotate keeps its value)
        r0 = pg.locator(".cp-layers .cp-lsub .cp-ltrack").first.bounding_box()
        r1 = pg.locator(".cp-layers .cp-lsub .cp-ltrack").nth(1).bounding_box()
        x4 = r0["x"] + 3 * k
        pg.mouse.move(x4, r0["y"] + 2); pg.mouse.down(); pg.mouse.move(x4 + 8 * k, r1["y"] + r1["height"] - 2, steps=5)
        pg.mouse.move(r0["x"] + 17 * k, r1["y"] + r1["height"] - 2, steps=3); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {self.ED}.state.lkeys.length"), 3)
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.locator(".cp-layers").screenshot(path=os.path.join(SHOTS, "comp-layer-timeline.png"))
        pg.keyboard.press("Delete")
        t = pg.evaluate(f"() => {self.ED}.comp().nodes.find((n) => n.id === 'T')")
        self.assertNotIn("tracks", t)
        self.assertEqual(t["rotate"], 90)
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
        self.assertEqual(set(types), {"keyer", "lumakeyer", "chromakeyer", "differencekeyer", "despill", "edgeextend", "lightwrap", "coreedge"}, types)
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
        self.assertEqual(rows, ["Save", "Save as…", "Render…", "Render Write nodes…", "Send to the farm…", "Export to Nuke…",
                                "Relink footage…", "Localise footage…", "Open…", "New comp"])
        off = pg.evaluate("() => [...__panel.container.querySelectorAll('.cp-pop > div.off')].map((d) => d.firstChild.textContent)")
        self.assertEqual(off, ["Render Write nodes…", "Send to the farm…"])   # no Write node yet
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

    def test_frames_are_kept_rendered_ahead_and_marked_on_the_timeline(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"""() => {{ const e = {ED}; const n = e.comp().nodes.find((x) => x.id === 'Constant1');
            n.tracks = {{ color: [{{ f: 0, v: [0, 0, 0, 1] }}, {{ f: 40, v: [1, 1, 1, 1] }}] }}; e.refresh(); }}""")
        pg.wait_for_timeout(300)
        made = pg.evaluate(f"() => {ED}.renderAhead()")
        self.assertGreater(made, 5, made)
        kept = pg.evaluate(f"() => [...{ED}.cachedFrames()].sort((a, b) => a - b)")
        self.assertIn(0, kept)
        self.assertIn(1, kept)
        pg.wait_for_timeout(100)
        self.assertGreater(pg.evaluate("() => __panel.container.querySelectorAll('#timeline-cache i').length"), 0,
                           "the kept frames are marked on the viewer's timeline")
        # A frame kept comes back as it was drawn; a change of a node forgets what it reached.
        pg.evaluate("() => __panel.setFrame(10)")
        pg.wait_for_timeout(250)
        px10 = self.pixel(pg, 0.5, 0.5)
        pg.evaluate(f"() => {{ const e = {ED}; e.comp().nodes.find((x) => x.id === 'Constant1').tracks.color[1].v = [1, 0, 0, 1]; e.refresh(); }}")
        pg.wait_for_timeout(250)
        self.assertNotEqual(self.pixel(pg, 0.5, 0.5), px10, "the picture follows the change")
        kept2 = pg.evaluate(f"() => [...{ED}.cachedFrames()]")
        self.assertNotIn(20, kept2, "frames made before the change are no longer counted")
        self.assertEqual(self.errors, [])

    def test_while_a_value_moves_the_picture_is_smaller_and_then_its_own_size(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"""() => {{ const e = {ED}; e.setFormat({{ width: 1280, height: 720 }}); e.setProxyBudget(0);
            const c = e.comp(); c.nodes.push({{ id: 'Grade1', type: 'grade', x: 0, y: 60, inputs: ['Constant1', null], gain: 1 }});
            c.nodes.find((n) => n.id === 'Output1').inputs = ['Grade1']; c.nodes.find((n) => n.id === 'Constant1').color = [0.2, 0.4, 0.6, 1]; e.refresh(); }}""")
        pg.wait_for_timeout(600)
        full = pg.evaluate(f"() => {ED}.lastRender()")
        self.assertEqual(full["phases"]["proxy"], 1, full)
        # values changed one after the other, as a drag does: drawn smaller, the same footage
        seen = pg.evaluate(f"""async () => {{ const e = {ED}, out = [];
            for (let k = 1; k <= 6; k++) {{ e.comp().nodes.find((n) => n.id === 'Grade1').gain = 1 + k * 0.1; e.refresh();
                await new Promise((r) => setTimeout(r, 60)); out.push(e.lastRender()); }}
            return out; }}""")
        self.assertTrue(any(r["phases"]["proxy"] > 1 for r in seen), seen)
        small = [r for r in seen if r["phases"]["proxy"] > 1][-1]
        self.assertLess(small["width"], full["width"])
        # once it stops, the picture at its own size, with the last value
        pg.wait_for_timeout(700)
        last = pg.evaluate(f"() => {ED}.lastRender()")
        self.assertEqual((last["phases"]["proxy"], last["width"], last["height"]), (1, full["width"], full["height"]), last)
        px = self.pixel(pg, 0.5, 0.5)
        self.assertAlmostEqual(px[0], round(255 * ((0.2 * 1.6) ** (1 / 2.4) * 1.055 - 0.055)), delta=3)
        self.assertEqual(self.errors, [])

    def test_the_gpu_preview_makes_the_cpus_numbers(self):
        pg = self.page()
        res = pg.evaluate("""async () => {
            const C = await import('/extensions/viewer/imageViewer_compModel.js');
            const G = await import('/extensions/viewer/imageViewer_compGpu.js');
            const gpu = G.createCompGpu(document);
            if (!gpu) return { none: true };
            let seed = 7;
            const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
            const pic = (w, h, sparse) => { const d = new Float32Array(w * h * 4);
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (sparse && (x < 20 || x > 40 || y < 10 || y > 30)) continue;
                    const a = rnd(), i = (y * w + x) * 4; d[i] = rnd() * a; d[i + 1] = rnd() * a; d[i + 2] = rnd() * a * 1.5; d[i + 3] = a; }
                return { w, h, data: d }; };
            const W = 97, H = 61, P1 = pic(W, H, false), P2 = pic(W, H, true);
            const N = (id, type, inputs, kw = {}) => ({ id, type, inputs, x: 0, y: 0, ...kw });
            const mk = (nodes, out) => C.normalizeComp({ comp: 1, format: { width: W, height: H, fps: 24, frames: 10 }, nodes, output: out }).comp;
            const R = [N('R1', 'read', [], { file: 'a.png' }), N('R2', 'read', [], { file: 'b.png' })];
            const cases = [
                mk([...R, N('G', 'grade', ['R1', null], { gain: 1.7, gamma: 0.8, saturation: 1.3, lift: 0.05 }), N('O', 'output', ['G'])], 'O'),
                mk([...R, N('T', 'transform', ['R2'], { translate: [7.5, -3.25], rotate: 17, scale: [1.2, 0.85] }), N('M', 'merge', ['R1', 'T', null]), N('O', 'output', ['M'])], 'O'),
                mk([...R, N('B', 'blur', ['R2', null], { size: 9 }), N('M', 'merge', ['R1', 'B', 'R1'], { operation: 'screen', mix: 0.7 }), N('O', 'output', ['M'])], 'O'),
                mk([...R, N('C', 'crop', ['R1'], { topleft: [10, 8], bottomright: [70, 50], softness: 3 }), N('F', 'reformat', ['C'], { width: 60, height: 40, resize: 'fill' }),
                    N('M', 'merge', ['R2', 'F', null], { operation: 'difference' }), N('O', 'output', ['M'])], 'O'),
                mk([...R, N('U', 'unpremult', ['R1', null]), N('G', 'grade', ['U', 'R2'], { gain: 2, mask_invert: 'on' }), N('P', 'premult', ['G', null], { mix: 0.5 }),
                    N('B', 'blur', ['P', 'R2'], { size: 4, mask_channel: 'r' }), N('O', 'output', ['B'])], 'O'),
                mk([...R, N('K', 'constant', [], { color: [0.2, 0.5, 0.9, 0.6] }), N('L', 'lumakeyer', ['R1', null]), N('M', 'merge', ['K', 'L', null]), N('O', 'output', ['M'])], 'O'),
            ];
            const out = [];
            for (const comp of cases) {
                const src = (n) => (n.id === 'R1' ? P1 : P2);
                const cpu = C.renderNode(comp, comp.output, 0, { scale: 1, source: src });
                const g = gpu.render(comp, comp.output, 0, { scale: 1, source: src });
                if (!g) { out.push({ skipped: true }); continue; }
                let d = 0;
                for (let i = 0; i < cpu.data.length; i++) d = Math.max(d, Math.abs(cpu.data[i] - g.data[i]));
                out.push({ d, w: g.w, h: g.h, cw: cpu.w, ch: cpu.h });
            }
            // A region: only its pixels are worked, and they are right.
            const comp = cases[2];
            const src = (n) => (n.id === 'R1' ? P1 : P2);
            const cpu = C.renderNode(comp, comp.output, 0, { scale: 1, source: src });
            const g = gpu.render(comp, comp.output, 0, { scale: 1, source: src }, [30, 20, 60, 40]);
            let d = 0, outside = 0;
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) {
                const i = (y * W + x) * 4 + k;
                if (x >= 30 && x < 60 && y >= 20 && y < 40) d = Math.max(d, Math.abs(cpu.data[i] - g.data[i])); else if (g.data[i]) outside++;
            }
            return { out, roi: { d, outside, box: g.roi } };
        }""")
        if res.get("none"):
            self.skipTest("no WebGL2 with float targets here")
        for i, r in enumerate(res["out"]):
            if r.get("skipped"):
                continue
            self.assertEqual((r["w"], r["h"]), (r["cw"], r["ch"]), f"case {i}")
            self.assertLess(r["d"], 1e-4, f"case {i}: {r}")
        self.assertLess(res["roi"]["d"], 1e-4, res["roi"])
        self.assertEqual(res["roi"]["outside"], 0, "nothing worked outside the region")
        self.assertEqual(self.errors, [])

    def test_the_editor_draws_on_the_gpu_and_only_the_part_on_screen_when_zoomed_in(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"""() => {{ const e = {ED}; const c = e.comp();
            c.nodes.push({{ id: 'Grade1', type: 'grade', x: 0, y: 60, inputs: ['Constant1', null], gain: 2 }});
            c.nodes.find((n) => n.id === 'Output1').inputs = ['Grade1'];
            c.nodes.find((n) => n.id === 'Constant1').color = [0.25, 0.5, 0.75, 1]; e.refresh(); }}""")
        pg.wait_for_timeout(400)
        info = pg.evaluate(f"() => {ED}.renderInfo()")
        if info["gpuOff"]:
            self.skipTest("GPU off here: " + info["gpuOff"])
        self.assertIn(info["how"], ("gpu", "kept"), info)
        px = self.pixel(pg, 0.5, 0.5)
        pg.evaluate(f"() => {ED}.setGpu(false)")
        pg.wait_for_timeout(400)
        self.assertEqual(pg.evaluate(f"() => {ED}.renderInfo().how"), "kept", "the CPU finds the GPU's picture in the shared cache")
        self.assertEqual(self.pixel(pg, 0.5, 0.5), px)
        pg.evaluate(f"() => {{ {ED}.setGpu(true); const z = {ED}.state.zoom; z.fit = false; z.s = 6; z.x = -1500; z.y = -900; {ED}.relayout && {ED}.relayout(); }}")
        pg.evaluate(f"() => {{ const c = {ED}.comp(); c.nodes.find((n) => n.id === 'Grade1').gain = 3; {ED}.refresh(); }}")
        pg.wait_for_timeout(500)
        info = pg.evaluate(f"() => {ED}.renderInfo()")
        self.assertEqual(info["how"], "gpu, region", info)
        self.assertTrue(info["region"], info)
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

    def test_a_history_item_without_a_path_dropped_on_the_graph_is_a_read(self):
        # A node's output in the History often names its file only as filename / subfolder / type.
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate("() => __panel.setPanelDocked('compGraph', true)")
        pg.wait_for_timeout(200)
        pg.evaluate("""() => { const g = __panel.compGraphPanel.querySelector('.cp-graph'), r = g.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.setData('application/x-imageviewer-history', JSON.stringify({ items: [{ path: null, filename: 'plate.png', subfolder: '', type: 'output', kind: 'image' }] }));
            g.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, composed: true,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); }""")
        pg.wait_for_function(f"() => {ED}.comp().nodes.some((n) => n.type === 'read')", timeout=5000)
        files = pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'read').map((n) => n.file)")
        self.assertEqual([os.path.normcase(os.path.abspath(f)) for f in files], [os.path.normcase(os.path.abspath(self.png))])
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

    def test_several_selected_nodes_each_have_a_panel_of_their_own(self):
        """Nuke's Properties bin: a panel per selected node, the one picked last on top; a change is that node's."""
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        a, b, g = pg.evaluate(f"""() => {{ const e = {ED}; e.select(['Constant1']);
            const a = e.addNode('blur', {{ size: 2 }}); const b = e.addNode('blur', {{ size: 8 }}); const g = e.addNode('grade');
            e.select([g.id, b.id, a.id]); return [a.id, b.id, g.id]; }}""")
        P = "__panel.compPropsPanel"
        panes = pg.evaluate(f"() => [...{P}.querySelectorAll('.cp-pane')].map((x) => x.dataset.pane)")
        self.assertEqual(panes, [a, b, g])
        self.assertEqual(pg.locator(f'input[data-fk="{a}:size"]').input_value(), "2")
        self.assertEqual(pg.locator(f'input[data-fk="{b}:size"]').input_value(), "8")
        size = pg.locator(f'input[data-fk="{b}:size"]')
        size.fill("5"); size.dispatch_event("change")
        got = pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'blur').map((n) => n.size)")
        self.assertEqual(got, [2, 5], "only the node of that panel changes")
        # The name and the graph colour are set in the panel's header; there are no rows for them.
        head = f'.cp-pane[data-pane="{a}"] .cp-panehead'
        self.assertEqual(pg.locator(f'.cp-pane[data-pane="{a}"] .mg-prop label', has_text="name").count(), 0)
        self.assertEqual(pg.locator(f'.cp-pane[data-pane="{a}"] .mg-prop label', has_text="colour").count(), 0)
        nm = pg.locator(f"{head} input.cp-panename")
        self.assertEqual(nm.get_attribute("placeholder"), a)
        nm.click()
        self.assertEqual(pg.locator(f'.cp-pane[data-pane="{a}"] .mg-prop').count() > 0, True, "a click on the name does not fold")
        nm.fill("Soften"); nm.press("Enter")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.id === '{a}').name"), "Soften")
        self.assertEqual(pg.locator(f"{head} input.cp-panename").input_value(), "Soften")
        self.assertEqual(pg.locator(f"{head} .cp-panetilereset").count(), 0)
        tile = pg.locator(f"{head} input.cp-panetile")
        tile.fill("#7d6fd1"); tile.dispatch_event("change")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.id === '{a}').tile"), "#7d6fd1")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-panel-header.png"))
        pg.locator(f"{head} .cp-panetilereset").click()
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.id === '{a}').tile"), None)
        nm = pg.locator(f"{head} input.cp-panename")
        nm.fill(""); nm.press("Enter")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.id === '{a}').name"), None)
        # Folding a panel, and closing one (the node leaves the selection).
        pg.locator(f'.cp-pane[data-pane="{g}"] .cp-panehead .cp-panefold').click()
        self.assertEqual(pg.locator(f'.cp-pane[data-pane="{g}"] .mg-prop').count(), 0)
        pg.locator(f'.cp-pane[data-pane="{b}"] .cp-panehead button').click()
        panes = pg.evaluate(f"() => [...{P}.querySelectorAll('.cp-pane')].map((x) => x.dataset.pane)")
        self.assertEqual(panes, [a, g])
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-panels-per-node.png"))
        self.assertEqual(self.errors, [])

    def test_extra_channels_shuffle_roto_write_and_the_layer_shown(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        ids = pg.evaluate(f"""() => {{ const e = {ED}; e.select(['Constant1']);
            const c = e.comp().nodes.find((n) => n.id === 'Constant1'); c.color = [1, 0, 0, 1];
            const add = e.addNode('addchannels', {{ channels: 'mask.a', value: 0.5 }});
            const sh = e.addNode('shuffle'); e.select([sh.id]); return [add.id, sh.id]; }}""")
        add, sh = ids
        opts = pg.evaluate(f"() => [...__panel.compPropsPanel.querySelectorAll('.cp-pane.first select')].map((s) => [...s.options].map((o) => o.value))")
        self.assertTrue(any("mask.a" in o for o in opts), opts)
        # Shuffle mask.a into green: the picture turns yellow-ish (red + half green).
        pg.evaluate(f"() => {{ const e = {ED}; const n = e.node('{sh}'); n.g = 'mask.a'; e.view('{sh}'); e.refresh(); }}")
        pg.wait_for_timeout(500)
        px = self.pixel(pg, 0.5, 0.5)
        self.assertGreater(px[0], 200); self.assertGreater(px[1], 120); self.assertLess(px[2], 30)
        # The layer menu offers the extra layer; it shows as grey.
        pg.evaluate(f"() => {{ const e = {ED}; const n = e.node('{sh}'); n.g = 'g'; e.refresh(); }}")
        pg.wait_for_timeout(400)
        sel = pg.locator(".cp-layer")
        self.assertIn("mask", sel.evaluate("(s) => [...s.options].map((o) => o.value)"))
        sel.select_option("mask")
        pg.wait_for_timeout(400)
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.evaluate(f"() => {ED}.select(['{sh}'])")
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-shuffle-layer-mask.png"))
        px = self.pixel(pg, 0.5, 0.5)
        self.assertTrue(abs(px[0] - px[1]) < 3 and abs(px[1] - px[2]) < 3 and 150 < px[0] < 220, px)
        sel.select_option("rgba")
        # Roto has the channel menu and the premult switch.
        rid = pg.evaluate(f"() => {{ const e = {ED}; const r = e.addNode('roto'); e.select([r.id]); return r.id; }}")
        fks = pg.evaluate(f"() => [...__panel.compPropsPanel.querySelectorAll('.cp-pane.first .mg-prop label')].map((l) => l.textContent)")
        self.assertIn("channel", fks); self.assertIn("premult", fks)
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "comp-roto-channel-premult.png"))
        self.assertEqual(pg.evaluate(f"() => {ED}.node('{rid}').write || 'rgba'"), "rgba")
        self.assertEqual(self.errors, [])

    def test_a_drag_lays_out_the_selection_and_y_stroke_cuts_wires(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        ids = pg.evaluate(f"""() => {{ const e = {ED}; e.select(['Constant1']);
            const a = e.addNode('blur'); const b = e.addNode('grade');
            const n = (id) => e.node(id); n(a.id).x = 300; n(a.id).y = 40; n(b.id).x = 20; n(b.id).y = 260; n('Constant1').x = 150; n('Constant1').y = 150;
            e.refresh(); e.select([b.id]); return [a.id, b.id]; }}""")
        a, b = ids
        g = pg.locator(".cp-graph").first
        g.click(position={"x": 5, "y": 5})
        pg.evaluate(f"() => {ED}.select(['{b}'])")
        # Pick b, then Constant1 and a with ctrl: the order the row is laid out in.
        for nid in ("Constant1", a):
            pg.locator(f'.cp-node[data-id="{nid}"]').click(modifiers=["Control"])
        box = g.bounding_box()
        pg.keyboard.down("a")
        pg.mouse.move(box["x"] + 60, box["y"] + box["height"] - 20)
        pg.mouse.down(); pg.mouse.move(box["x"] + 260, box["y"] + box["height"] - 25, steps=6); pg.mouse.up()
        pg.keyboard.up("a")
        pg.wait_for_timeout(400)
        pos = pg.evaluate(f"() => ['{b}', 'Constant1', '{a}'].map((id) => [{ED}.node(id).x, {ED}.node(id).y])")
        self.assertEqual(len({p[1] for p in pos}), 1, pos)
        self.assertTrue(pos[0][0] < pos[1][0] < pos[2][0], pos)
        pg.evaluate(f"() => {ED}.undo()")
        self.assertEqual(pg.evaluate(f"() => {ED}.node('{b}').x"), 20, "one undo step")
        # Y + a stroke across the Constant -> blur wire cuts it.
        pg.evaluate(f"() => {{ const e = {ED}; e.node('{a}').inputs[0] = 'Constant1'; e.refresh(); }}")
        wire = pg.locator(f'path[data-wire="Constant1>{a}:0"]').bounding_box()
        mx, my = wire["x"] + wire["width"] / 2, wire["y"] + wire["height"] / 2
        pg.keyboard.down("y")
        pg.mouse.move(mx - 40, my - 6); pg.mouse.down(); pg.mouse.move(mx + 40, my + 6, steps=8); pg.mouse.up()
        pg.keyboard.up("y")
        self.assertIsNone(pg.evaluate(f"() => {ED}.node('{a}').inputs[0]"))
        self.assertEqual(self.errors, [])

    def test_a_and_y_are_on_only_while_held(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        g = pg.locator(".cp-graph").first
        g.click(position={"x": 5, "y": 5})
        held = lambda: pg.evaluate(f"() => {ED}.state.held")
        pg.keyboard.down("a")
        self.assertEqual(held(), "a")
        pg.keyboard.up("a")
        self.assertIsNone(held(), "off at the keyup")
        # The focus left the comp while the key was down: its keyup still lets go.
        pg.keyboard.down("y")
        self.assertEqual(held(), "y")
        pg.evaluate("() => { const b = document.createElement('button'); b.id = 'elsewhere'; document.body.append(b); b.focus(); }")
        pg.keyboard.up("y")
        self.assertIsNone(held(), "keyup outside the comp")
        # Leaving the window (no keyup ever comes) lets go.
        g.click(position={"x": 5, "y": 5})
        pg.keyboard.down("a")
        pg.evaluate("() => window.dispatchEvent(new Event('blur'))")
        self.assertIsNone(held(), "window blur")
        pg.keyboard.up("a")
        # A keyup someone else stops in the capture phase of the document still reaches the window's listener.
        g.click(position={"x": 5, "y": 5})
        pg.evaluate("() => document.addEventListener('keyup', window.__stopUp = (e) => e.stopPropagation(), true)")
        pg.keyboard.down("y")
        pg.keyboard.up("y")
        pg.evaluate("() => document.removeEventListener('keyup', window.__stopUp, true)")
        self.assertIsNone(held(), "keyup stopped below the window")
        # Matched by the physical key too: a layout switch while held gives another letter at the keyup.
        g.click(position={"x": 5, "y": 5})
        pg.keyboard.down("y")
        pg.evaluate("() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', code: 'KeyY' }))")
        self.assertIsNone(held(), "same code, other letter")
        pg.keyboard.up("y")
        # Another key's keyup leaves it on.
        g.click(position={"x": 5, "y": 5})
        pg.keyboard.down("a")
        pg.keyboard.press("Shift")
        self.assertEqual(held(), "a")
        pg.keyboard.up("a")
        self.assertIsNone(held())
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

    def test_write_nodes_render_their_own_files_and_the_farm_request_is_checked(self):
        """A Write node after the Constant: Render Write nodes… plans its files, renders a multi-layer EXR sequence
        with handles, and lands it in the History; Send to the farm… shows the Deadline frames before anything goes."""
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate("() => __panel.compSetFormat({ duration: 3 })")
        out = os.path.join(self.dirs["output"], "writes_test")
        pg.evaluate(f"""(dir) => {{ const e = {self.ED}; const c = e.comp(); const k = c.nodes.find((n) => n.type === 'constant');
            const w = e.addNode('write'); w.inputs = [k.id]; w.name = 'main'; w.file = dir + '/main.####.exr'; w.channels = 'all';
            w.first = 0; w.last = 1; w.handles = 1; e.refresh(); }}""", out)
        pg.evaluate("() => { window.__landed = []; __panel.exportLanded = async (p) => { window.__landed.push(p); }; }")
        pg.locator(".mg-bar .cp-save").click()
        pg.locator(".cp-pop > div", has_text="Render Write nodes…").click()
        pg.wait_for_selector(".cp-dlg.cp-writes")
        pg.wait_for_function("() => /main: 4 files/.test(__panel.container.querySelector('.cp-writes .cp-plan').textContent)", timeout=10000)
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-writes-dialog.png"))
        pg.locator(".cp-writes button", has_text="Render").last.click()
        pg.wait_for_function("() => !__panel.container.querySelector('.cp-writes')", timeout=60000)
        self.assertEqual(sorted(os.listdir(out)), ["main.1000.exr", "main.1001.exr", "main.1002.exr", "main.1003.exr"])   # frames -1..2
        self.assertEqual(len(pg.evaluate("() => window.__landed")), 1)
        pg.locator(".mg-bar .cp-save").click()
        pg.locator(".cp-pop > div", has_text="Send to the farm…").click()
        pg.wait_for_selector(".cp-dlg.cp-farm")
        pg.wait_for_function("() => /Deadline frames 0-3 \\(comp frame \\+ 1\\)/.test(__panel.container.querySelector('.cp-farm').textContent)",
                             timeout=10000)
        pg.locator(".cp-farm button", has_text="Cancel").click()
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

    def test_tracker_corner_pin_lens_and_grid_warp_on_the_picture(self):
        from PIL import Image
        ys, xs = np.mgrid[0:80, 0:120].astype(np.float64)
        rng = np.random.default_rng(3)
        g = np.zeros_like(xs)
        for a, b, c in (rng.random((40, 3)) - [0.5, 0.5, 0]) * [1.2, 1.2, 6]:
            g += np.sin(xs * a + ys * b + c)
        u8 = np.clip(128 + g * 18, 0, 255).astype(np.uint8)
        Image.fromarray(np.dstack([u8, u8, u8, np.full_like(u8, 255)]), "RGBA").save(os.path.join(self.dirs["output"], "trk_tex.png"))
        path = os.path.join(self.dirs["output"], "trk.comp.json")
        comp = {"comp": 1, "format": {"width": 120, "height": 80, "fps": 24, "frames": 5}, "output": "Output1",
                "nodes": [{"id": "Read1", "type": "read", "file": "trk_tex.png", "inputs": [], "x": 0, "y": 0},
                          {"id": "Transform1", "type": "transform", "inputs": ["Read1"], "x": 0, "y": 60,
                           "tracks": {"translate": [{"f": 0, "v": [0, 0], "ease": "linear"}, {"f": 4, "v": [6, -3]}]}},
                          {"id": "Tracker1", "type": "tracker", "inputs": ["Transform1"], "x": 0, "y": 120},
                          {"id": "Output1", "type": "output", "inputs": ["Tracker1"], "x": 0, "y": 180}]}
        pg = self.page()
        ok = pg.evaluate("""async ([path, comp]) => { const r = await fetch('/imageviewer/comp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, comp }) }); if (!r.ok) return false; return !!(await __panel.compOpenFile(path)); }""", [path, comp])
        self.assertTrue(ok)
        ED = self.ED
        pg.wait_for_function(f"() => {{ const e = {ED}; return e && e.comp() && e.comp().nodes.length === 4; }}", timeout=10000)
        pg.evaluate(f"() => {{ {ED}.select(['Tracker1']); {ED}.setFrame(0); }}")
        pg.wait_for_timeout(300)
        # + Point, then a click on the picture puts a point there.
        pg.locator(".cp-pane button", has_text="+ Point").click()
        b = pg.evaluate(f"() => {ED}.canvasBox()")
        sb = pg.evaluate(f"() => {{ const r = {ED}.stage.getBoundingClientRect(); return [r.x, r.y]; }}")
        k = b["w"] / b["cw"]
        pg.mouse.click(sb[0] + b["x"] + 60 * k, sb[1] + b["y"] + 40 * k)
        pts = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.id === 'Tracker1').points.points")
        self.assertEqual(len(pts), 1)
        self.assertAlmostEqual(pts[0]["keys"][0][1], 60, delta=1.5)
        self.assertAlmostEqual(pts[0]["keys"][0][2], 40, delta=1.5)
        # Track to the end through the server; the keys come in, one undo step.
        pg.locator(".cp-pane button", has_text="▶▶").click()
        pg.wait_for_function(f"() => {{ const n = {ED}.comp().nodes.find((n) => n.id === 'Tracker1'); return n.points.points[0].keys.length === 5 && !{ED}.state.trkRun; }}", timeout=20000)
        keys = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.id === 'Tracker1').points.points[0].keys")
        x0, y0 = keys[0][1], keys[0][2]
        self.assertAlmostEqual(keys[4][1] - x0, 6, delta=0.4)
        self.assertAlmostEqual(keys[4][2] - y0, -3, delta=0.4)
        # Make: Stabilise is a Transform beside the tracker.
        pg.locator(".cp-pane button", has_text="Stabilise").click()
        made = pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'transform').length")
        self.assertEqual(made, 2)
        # A CornerPin: its corner squares drag.
        pg.evaluate(f"() => {{ {ED}.select(['Read1']); {ED}.addNode('cornerpin'); }}")
        pg.wait_for_timeout(300)
        h = pg.locator(".cp-over rect.cp-wpin[data-param=to3]")
        self.assertEqual(h.count(), 1)
        hb = h.bounding_box()
        z = pg.evaluate(f"() => {ED}.state.zoom.s")
        cx, cy = hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx - 20, cy + 10, steps=4); pg.mouse.up()
        to3 = pg.evaluate(f"() => {{ const n = {ED}.comp().nodes.find((n) => n.type === 'cornerpin'); return n.to3; }}")
        self.assertIsNotNone(to3)
        self.assertAlmostEqual(to3[0], 120 - 20 / z, delta=1.5)
        self.assertAlmostEqual(to3[1], 0 + 10 / z, delta=1.5)
        # A GridWarp: a destination point drags.
        pg.evaluate(f"() => {{ {ED}.select(['Read1']); {ED}.addNode('gridwarp'); }}")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.locator(".cp-over circle.cp-wpt").count(), 25)
        hb = pg.locator(".cp-over circle.cp-wpt").nth(12).bounding_box()
        cx, cy = hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 15, cy, steps=4); pg.mouse.up()
        moved = pg.evaluate(f"""() => {{ const n = {ED}.comp().nodes.find((n) => n.type === 'gridwarp');
            const d = n.dst_points || (n.tracks && n.tracks.dst_points && n.tracks.dst_points[0].v); return d ? d.points || d : null; }}""")
        self.assertIsNotNone(moved, "the drag wrote the destination points")
        # LensDistortion: Draw lines, two clicks and a double-click make a line; Solve says what it found.
        pg.evaluate(f"() => {{ {ED}.select(['Read1']); {ED}.addNode('lensdistortion'); }}")
        pg.wait_for_timeout(300)
        pg.locator(".cp-pane button", has_text="Draw lines").click()
        b = pg.evaluate(f"() => {ED}.canvasBox()")
        k = b["w"] / b["cw"]
        for i, (px, py) in enumerate([(10, 20), (60, 14), (110, 20)]):
            if i == 2:
                pg.mouse.dblclick(sb[0] + b["x"] + px * k, sb[1] + b["y"] + py * k)
            else:
                pg.mouse.click(sb[0] + b["x"] + px * k, sb[1] + b["y"] + py * k)
        lines = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'lensdistortion').lines")
        self.assertTrue(lines and len(lines) == 1 and len(lines[0]) >= 3, lines)
        if SHOTS:
            pg.wait_for_timeout(400)
            pg.screenshot(path=os.path.join(SHOTS, "comp-lens-lines.png"))
        self.assertEqual(self.errors, [])

    def test_a_reformat_makes_the_picture_its_new_size_and_the_jack_after_it_sits_in_its_middle(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"() => {{ const e = {ED}; e.select(['Constant1']); e.addNode('reformat', {{ width: 640, height: 640, resize: 'fill' }}); }}")
        pg.wait_for_function(f"() => {ED}.lastRender().width > 0 && {ED}.lastRender().width === {ED}.lastRender().height", timeout=5000)
        r = pg.evaluate(f"() => {ED}.lastRender()")
        self.assertEqual(r["width"], round(640 * r["scale"]))      # a square picture, not 1920 x 1080 with black around it
        info = pg.evaluate(f"() => {ED}.stage.innerText")
        self.assertIn("640×640", info)
        box = pg.evaluate(f"() => {{ const b = {ED}.canvas.getBoundingClientRect(); return [b.width, b.height]; }}")
        self.assertAlmostEqual(box[0], box[1], delta=1.5)
        # A Transform after it: its jack in the middle of the square picture (its own pixels), turning about it.
        pg.evaluate(f"() => {ED}.addNode('transform')")
        pg.wait_for_timeout(300)
        jc = pg.locator(".cp-over .cp-jctr").bounding_box()
        cb = pg.evaluate(f"() => {{ const b = {ED}.canvas.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }}")
        self.assertAlmostEqual(jc["x"] + jc["width"] / 2, cb[0] + cb[2] / 2, delta=2)
        self.assertAlmostEqual(jc["y"] + jc["height"] / 2, cb[1] + cb[3] / 2, delta=2)
        if SHOTS:
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-reformat-own-size.png"))
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

    def test_3d_nodes_views_a_camera_from_a_3d_shot_and_a_deep_file(self):
        pg = self.page()
        path = self.new_comp(pg)
        ED = self.ED
        # A deep file beside the comp: one red sample in the left half, at depth 2.
        from importlib import import_module
        D = import_module(self.pkg + ".comp_deep")
        W, H = 320, 180
        n = np.zeros(W * H, np.uint32)
        n.reshape(H, W)[:, :160] = 1
        s = np.tile(np.array([[1, 0, 0, 1, 2, 2]], np.float32), (int(n.sum()), 1))
        deep = os.path.join(self.dirs["output"], "deep_plate.exr")
        D.write_deep(deep, {"w": W, "h": H, "n": n, "s": s})
        nodes = [
            {"id": "Constant1", "type": "constant", "inputs": [], "color": [0, 1, 0, 1], "x": 0, "y": 0},
            {"id": "card3d1", "type": "card3d", "inputs": ["Constant1"], "x": 0, "y": 60},
            {"id": "camera3d1", "type": "camera3d", "inputs": [], "translate": [0, 0, 2], "interaxial": 0.6, "convergence": 100, "x": 120, "y": 60},
            {"id": "render3d1", "type": "render3d", "inputs": ["card3d1", "camera3d1", None], "x": 0, "y": 120},
            {"id": "deepread1", "type": "deepread", "inputs": [], "file": deep, "x": 240, "y": 0},
            {"id": "deepflatten1", "type": "deepflatten", "inputs": ["deepread1"], "x": 240, "y": 60},
            {"id": "Output1", "type": "output", "inputs": ["render3d1"], "x": 0, "y": 180}]
        pg.evaluate(f"""([nodes, path]) => {ED}.load({{ comp: 1, format: {{ width: 320, height: 180, fps: 24, frames: 3 }}, nodes, output: 'Output1' }}, path)""",
                    [nodes, path])
        pg.wait_for_timeout(800)
        mid, corner = self.pixel(pg, 0.5, 0.5), self.pixel(pg, 0.03, 0.05)
        self.assertGreater(mid[1], 200); self.assertLess(mid[0], 40)
        self.assertLess(corner[1], 40)
        # Stereo from the bar's view menu: the right eye sees the card further left than the left eye does.
        pg.locator(".cp-views").select_option("\u0001")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().format.views"), ["left", "right"])
        edge = lambda: self.pixel(pg, 0.5 + (35 / 18) * 0.25 * 0.5 * 0.92, 0.5)[1]
        pg.locator(".cp-views").select_option("left")
        pg.wait_for_timeout(600)
        left = edge()
        pg.locator(".cp-views").select_option("right")
        pg.wait_for_timeout(600)
        right = edge()
        self.assertGreater(left, 200, (left, right)); self.assertLess(right, 60, (left, right))
        # A camera of a shot open in a 3D tab: its keys go onto the Camera node.
        pg.evaluate("""() => { __panel._scenes = __panel._scenes || {};
            __panel._scenes['previz:t'] = { name: 'shot', items: [{ id: 'c1', kind: 'camera', name: 'Cam', position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1], fov: 30,
                tracks: { position: [{ f: 0, v: [1, 2, 3] }, { f: 2, v: [1, 2, 5] }] } }] }; }""")
        pg.evaluate(f"() => {ED}.select(['camera3d1'])")
        pg.wait_for_timeout(300)
        pg.locator(".cp-pane.first .cp-camimport button", has_text="3D shot").click()
        pg.wait_for_function(f"() => {{ const n = {ED}.node('camera3d1'); return n.tracks && n.tracks.translate; }}", timeout=5000)
        cam = pg.evaluate(f"() => {ED}.node('camera3d1')")
        self.assertEqual([round(v, 6) for v in cam["translate"]], [1, 2, 3])
        self.assertEqual(len(cam["tracks"]["translate"]), 3)
        self.assertIn("focal", cam["tracks"])
        # The deep file, flattened, through the comp_deep route.
        pg.evaluate(f"() => {ED}.view('deepflatten1')")
        pg.wait_for_timeout(1000)
        l, r = self.pixel(pg, 0.25, 0.5), self.pixel(pg, 0.75, 0.5)
        self.assertGreater(l[0], 200, l); self.assertLess(r[0], 40, r)
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "comp-3d-deep.png"))

    def test_groups_backdrops_dots_expressions_and_the_tool_library(self):
        """Ctrl+G groups the selection and the picture stays; a double-click goes inside, Ctrl+Backspace comes out; a
        number worked out by an expression follows the frame; B puts a backdrop round the selection, which carries its
        nodes; . makes a Dot; a group saved as a tool comes back from the Tab menu."""
        tools = tempfile.mkdtemp()
        os.environ["IMAGE_VIEWER_COMP_TOOLS"] = tools
        self.addCleanup(os.environ.pop, "IMAGE_VIEWER_COMP_TOOLS", None)
        pg = self.page()
        self.new_comp(pg)
        ED, g = self.ED, "__panel.compGraphPanel.querySelector('.cp-graph')"
        pg.evaluate(f"() => {{ const e = {ED}; e.comp().nodes.find((n) => n.type === 'constant').color = [1, 0, 0, 1]; e.select(['Constant1']); e.addNode('grade'); e.refresh(); }}")
        pg.wait_for_timeout(500)
        before = self.pixel(pg, 0.5, 0.5)
        key = lambda k: (pg.evaluate(f"() => {g}.focus()"), pg.keyboard.press(k))
        # Group the Grade: the Output reads the group, the picture is the same.
        pg.evaluate(f"() => {ED}.select(['Grade1'])")
        key("Control+g")
        st = pg.evaluate(f"() => {{ const c = {ED}.comp(); const grp = c.nodes.find((n) => n.type === 'group'); return {{ id: grp && grp.id, out: c.nodes.find((n) => n.id === c.output).inputs[0], inside: grp ? grp.nodes.map((n) => n.type).sort() : [] }}; }}")
        self.assertEqual(st["out"], st["id"])
        self.assertEqual(st["inside"], ["grade", "group_input", "group_output"])
        pg.wait_for_timeout(400)
        self.assertEqual(self.pixel(pg, 0.5, 0.5), before)
        grp = st["id"]
        # Inside it and out again.
        pg.evaluate(f"() => {g}.querySelector('.cp-node[data-id=\"{grp}\"]').dispatchEvent(new MouseEvent('dblclick', {{ bubbles: true }}))")
        inside = pg.evaluate(f"() => ({{ cls: {g}.classList.contains('in-group'), ids: Array.from({g}.querySelectorAll('.cp-node')).map((n) => n.dataset.id).sort(), crumbs: {g}.querySelector('.cp-crumbs').textContent }})")
        self.assertTrue(inside["cls"])
        self.assertEqual(inside["ids"], ["Grade1", "GroupOutput1", "Input1"])
        self.assertIn("Comp", inside["crumbs"])
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.locator(".cp-graph").first.screenshot(path=os.path.join(SHOTS, "comp-inside-group.png"))
        # The Grade inside: its gain worked out from the frame, typed into its expression line.
        pg.evaluate(f"() => {ED}.select(['Grade1'])")
        pg.wait_for_timeout(200)
        pg.evaluate("() => __panel.compPropsPanel.querySelector('[data-expr=\"Grade1:gain\"]').click()")
        inp = pg.locator('.cp-exprline input[data-fk="Grade1:gain:x0"]').first
        inp.fill("frame >= 5 ? 0 : 1")
        inp.press("Enter")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'group').nodes.find((n) => n.id === 'Grade1').expr"), {"gain": "frame >= 5 ? 0 : 1"})
        pg.evaluate("() => __panel.setFrame(6)")
        pg.wait_for_timeout(500)
        self.assertLess(self.pixel(pg, 0.5, 0.5)[0], 20, "the gain is 0 from frame 5")
        pg.evaluate("() => __panel.setFrame(1)")
        pg.wait_for_timeout(500)
        self.assertGreater(self.pixel(pg, 0.5, 0.5)[0], 200)
        self.assertTrue(pg.evaluate(f"() => !!{g}.querySelector('.cp-node[data-id=Grade1] .cp-xbadge')"), "the node says it has one")
        key("Control+Backspace")
        self.assertFalse(pg.evaluate(f"() => {g}.classList.contains('in-group')"))
        # A Dot and a backdrop round the Constant; the backdrop carries it.
        pg.evaluate(f"() => {ED}.select(['Constant1'])")
        key("b")
        bd = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'backdrop')")
        self.assertTrue(bd)
        key("f")   # the whole graph in view: the backdrop's label is above the Constant
        pg.wait_for_timeout(100)
        c0 = pg.evaluate(f"() => {{ const n = {ED}.comp().nodes.find((x) => x.id === 'Constant1'); return [n.x, n.y]; }}")
        head = pg.evaluate(f"() => {{ const r = {g}.querySelector('.cp-bdhead').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; }}")
        pg.mouse.move(*head); pg.mouse.down(); pg.mouse.move(head[0] + 60, head[1] + 30, steps=6); pg.mouse.up()
        c1 = pg.evaluate(f"() => {{ const n = {ED}.comp().nodes.find((x) => x.id === 'Constant1'); return [n.x, n.y]; }}")
        self.assertGreater(c1[0], c0[0] + 20)
        pg.evaluate(f"() => {ED}.select(['Constant1'])")
        key(".")
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'dot').map((n) => n.inputs)"), [["Constant1"]])
        # The group saved as a tool, and put in again from the Tab menu.
        pg.evaluate(f"() => {ED}.select(['{grp}'])")
        pg.wait_for_timeout(200)
        pg.evaluate("() => Array.from(__panel.compPropsPanel.querySelectorAll('button')).find((b) => b.textContent === 'Save as tool…').click()")
        ask = pg.locator(".cp-ask input").first
        ask.fill("Red off")
        ask.press("Enter")
        pg.wait_for_function("() => true")
        pg.wait_for_timeout(500)
        self.assertEqual(os.listdir(tools), ["red off.comp.json"])
        key("Tab")
        pg.wait_for_selector('.cp-tmrow[data-tool="Red off"]', timeout=5000)
        pg.locator('.cp-tmrow[data-tool="Red off"]').first.click()
        pg.wait_for_function(f"() => {ED}.comp().nodes.filter((n) => n.type === 'group').length === 2", timeout=5000)
        if SHOTS:
            pg.evaluate(f"() => {{ const e = {ED}; e.select([]); const n = e.addNode('sticky', {{ text: 'Grade off from frame 5' }}); e.comp().nodes.find((x) => x.id === 'Grade1' || x.type === 'group').tile = '#7d6fd1'; e.refresh(); }}")
            key("f")
            pg.wait_for_timeout(200)
            pg.locator(".cp-graph").first.screenshot(path=os.path.join(SHOTS, "comp-graph-organised.png"))
        self.assertEqual(self.errors, [])

    def test_nodes_are_duplicated_copied_and_pasted_and_alt_dragged(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate("() => __panel.setPanelDocked('compGraph', true)")
        pg.evaluate(f"""() => {{ const e = {ED}; e.select([]); const c = e.comp();
            e.addNode('blur', {{ x: 400, y: 60 }}); e.select([]); e.addNode('grade', {{ x: 400, y: 140 }});
            const by = (id) => c.nodes.find((n) => n.id === id);
            by('Blur1').inputs = ['Constant1']; by('Grade1').inputs = ['Blur1']; e.select(['Blur1', 'Grade1']); e.refresh(); }}""")
        pg.wait_for_timeout(200)
        graph = pg.evaluate_handle("() => __panel.compGraphPanel.querySelector('.cp-graph')")
        nodes = lambda: pg.evaluate(f"() => {ED}.comp().nodes.map((n) => [n.id, n.inputs, n.x, n.y])")   # noqa: E731
        by = lambda i: next(n for n in nodes() if n[0] == i)   # noqa: E731
        mid = lambda i: graph.evaluate("(g, id) => { const r = g.querySelector(`.cp-node[data-id=${id}]`).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }", i)   # noqa: E731
        graph.evaluate("(g) => g.focus()")
        # Ctrl+D: copies beside the originals, wired among themselves, selected; one undo step.
        pg.keyboard.press("Control+d")
        self.assertEqual(by("Grade2")[1], ["Blur2"])
        self.assertEqual(by("Blur2")[1], [None])
        self.assertEqual(by("Grade1")[1], ["Blur1"])
        self.assertEqual(sorted(pg.evaluate(f"() => {ED}.selection()")), ["Blur2", "Grade2"])
        pg.evaluate(f"() => {ED}.undo()")
        self.assertEqual(len(nodes()), 4)
        # Ctrl+C, then Ctrl+V under the pointer; Ctrl+Shift+V keeps the wire from outside.
        pg.evaluate(f"() => {ED}.select(['Blur1'])")
        graph.evaluate("(g) => g.focus()")
        pg.keyboard.press("Control+c")
        box = graph.bounding_box()
        spot = [box["x"] + box["width"] * 0.75, box["y"] + box["height"] * 0.7]
        pg.mouse.move(*spot)
        pg.keyboard.press("Control+v")
        self.assertEqual(by("Blur2")[1], [None])
        m = mid("Blur2")
        self.assertLess(abs(m[0] - spot[0]) + abs(m[1] - spot[1]), 30, "pasted under the pointer")
        pg.keyboard.press("Control+Shift+V")
        self.assertEqual(by("Blur3")[1], ["Constant1"])
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-copy-paste.png"))
        # Alt + drag: a copy is dragged away, the original stays where it was.
        before = by("Grade1")
        a = mid("Grade1")
        pg.keyboard.down("Alt")
        pg.mouse.move(*a); pg.mouse.down()
        pg.mouse.move(a[0] + 160, a[1] + 40, steps=6)
        pg.mouse.up()
        pg.keyboard.up("Alt")
        self.assertEqual(by("Grade1"), before)
        g2 = by("Grade2")
        self.assertEqual(g2[1], [None])
        self.assertGreater(g2[2], before[2] + 80)
        self.assertEqual(pg.evaluate(f"() => {ED}.selection()"), ["Grade2"])
        pg.evaluate(f"() => {ED}.undo()")
        self.assertFalse(any(n[0] == "Grade2" for n in nodes()))
        # Alt + drag on the empty graph still pans.
        self.assertEqual(self.errors, [])

    def test_a_read_comes_in_without_a_dialog_and_open_asks_the_system(self):
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate("() => __panel.setPanelDocked('compGraph', true)")
        pg.evaluate(f"() => {{ const e = {ED}; e.select([]); e.addNodeAt('read'); }}")
        pg.wait_for_timeout(200)
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.filter((n) => n.type === 'read').map((n) => n.file)"), [""])
        self.assertEqual(pg.evaluate("() => __panel.shadowRoot.querySelectorAll('.file-picker, .fp-shade, .export-shade').length"), 0)
        # Open: the server shows the system's dialog (stubbed here) and the Read takes the file it names.
        nd = importlib.import_module(self.pkg + ".native_dialog")
        asked = []
        real = nd.pick_file
        nd.pick_file = lambda start="", title="", filters=(): (asked.append((start, title)), self.png)[1]
        self.addCleanup(lambda: setattr(nd, "pick_file", real))
        pg.evaluate("() => __panel.compPropsPanel.querySelector('.cp-open').click()")
        pg.wait_for_function(f"() => {ED}.comp().nodes.some((n) => n.type === 'read' && n.file)", timeout=5000)
        f = pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'read').file")
        self.assertEqual(os.path.normcase(os.path.abspath(f)), os.path.normcase(os.path.abspath(self.png)))
        self.assertEqual(len(asked), 1)
        # Cancelled: nothing changes. No dialog to be had (501): the viewer's own file browser opens.
        nd.pick_file = lambda *a, **k: ""
        pg.evaluate("() => __panel.compPropsPanel.querySelector('.cp-open').click()")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.evaluate(f"() => {ED}.comp().nodes.find((n) => n.type === 'read').file"), f)

        def none(*a, **k):
            raise nd.Unavailable("no desktop")
        nd.pick_file = none
        before = pg.evaluate("() => __panel.shadowRoot.querySelectorAll('*').length")
        pg.evaluate("() => __panel.compPropsPanel.querySelector('.cp-open').click()")
        pg.wait_for_function("(n) => __panel.shadowRoot.querySelectorAll('*').length > n + 5", arg=before, timeout=5000)
        self.assertEqual(self.errors, [])

    def test_the_layers_show_a_read_before_it_is_wired_and_the_bottom_layers_footage(self):
        pg = self.page()
        path = self.new_comp(pg)
        ED = self.ED
        comp = {"comp": 1, "format": {"width": 64, "height": 36, "fps": 24, "frames": 40}, "output": "Output1", "nodes": [
            {"id": "Read1", "type": "read", "file": self.png, "inputs": [], "x": 0, "y": 0},
            {"id": "Grade1", "type": "grade", "inputs": ["Read1"], "x": 0, "y": 70},
            {"id": "Output1", "type": "output", "inputs": [None], "x": 0, "y": 200}]}
        pg.evaluate(f"([c, p]) => {ED}.load(c, p)", [comp, path])
        pg.evaluate("() => __panel.setPanelDocked('compLayers', true)")
        pg.wait_for_timeout(250)
        P = "__panel.compLayersPanel"
        rows = lambda: pg.evaluate(f"() => [...{P}.querySelectorAll('.cp-lrow')].map((r) => [r.querySelector('.cp-lname').textContent, r.classList.contains('cp-lloose')])")   # noqa: E731
        self.assertEqual(rows(), [["plate.png", False]], "the Read is a layer although nothing reaches the Output")
        self.assertEqual(pg.evaluate(f"() => {P}.querySelectorAll('.cp-note.cp-loose').length"), 1)
        pg.evaluate(f"() => {P}.querySelector('.cp-note.cp-loose button').click()")
        self.assertEqual(pg.evaluate(f"() => {{ const c = {ED}.comp(); return c.nodes.find((n) => n.id === c.output).inputs; }}"), ["Grade1"])
        self.assertEqual(pg.evaluate(f"() => {P}.querySelectorAll('.cp-note.cp-loose').length"), 0)
        self.assertEqual(rows(), [["plate.png", False]], "the bottom layer is named after its footage")
        # A second Read dropped onto the graph is listed as not in the picture yet; "+ layer" puts it on top.
        pg.evaluate("() => __panel.setPanelDocked('compGraph', true)")
        pg.wait_for_timeout(200)
        pg.evaluate("""() => { const g = __panel.compGraphPanel.querySelector('.cp-graph'), r = g.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.setData('application/x-imageviewer-history', JSON.stringify({ items: [{ path: null, filename: 'plate.png', subfolder: '', type: 'output', kind: 'image' }] }));
            g.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, composed: true,
                clientX: r.left + r.width * 0.8, clientY: r.top + r.height / 2 })); }""")
        pg.wait_for_function(f"() => {ED}.comp().nodes.filter((n) => n.type === 'read').length === 2", timeout=5000)
        pg.evaluate("() => __panel.setPanelDocked('compLayers', true)")
        pg.wait_for_timeout(200)
        self.assertEqual(rows(), [["plate.png", False], ["plate.png", True]])
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-layers-loose-read.png"))
        pg.evaluate(f"() => {P}.querySelector('.cp-lloose button').click()")
        self.assertEqual(rows(), [["plate.png", False], ["plate.png", False]])
        ins = pg.evaluate(f"() => {{ const c = {ED}.comp(); const m = c.nodes.find((n) => n.type === 'merge'); return m.inputs.slice(0, 2); }}")
        self.assertEqual(ins, ["Grade1", "Read2"])
        self.assertEqual(self.errors, [])

    def test_the_first_footage_dropped_into_an_empty_graph_is_wired_into_the_output(self):
        pg = self.page()
        path = self.new_comp(pg)
        ED = self.ED
        comp = {"comp": 1, "format": {"width": 64, "height": 36, "fps": 24, "frames": 4}, "output": "Output1",
                "nodes": [{"id": "Output1", "type": "output", "inputs": [None], "x": 0, "y": 200}]}
        pg.evaluate(f"([c, p]) => {ED}.load(c, p)", [comp, path])
        pg.evaluate("() => __panel.setPanelDocked('compGraph', true)")
        pg.wait_for_timeout(200)
        pg.evaluate("""() => { const g = __panel.compGraphPanel.querySelector('.cp-graph'), r = g.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.setData('application/x-imageviewer-history', JSON.stringify({ items: [{ path: null, filename: 'plate.png', subfolder: '', type: 'output', kind: 'image' }] }));
            g.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, composed: true,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 3 })); }""")
        pg.wait_for_function(f"() => {ED}.comp().nodes.some((n) => n.type === 'read')", timeout=5000)
        self.assertEqual(pg.evaluate(f"() => {{ const c = {ED}.comp(); return c.nodes.find((n) => n.id === c.output).inputs; }}"), ["Read1"])
        self.assertEqual(self.errors, [])

    def test_a_vfx_node_renders_once_through_its_workflow_and_reads_the_result_back(self):
        """The History's Convert Footage workflows as Comp nodes: Render prerenders what comes in, queues the
        workflow (ComfyUI stood in for here) and the film that comes back is the node's result."""
        V = importlib.import_module(self.pkg + ".clip_vfx")
        CV = importlib.import_module(self.pkg + ".comp_vfx")
        io = importlib.import_module(self.pkg + ".comp_io")
        fp = importlib.import_module(self.pkg + ".viewer_api").folder_paths
        fp.get_full_path = lambda folder, name: f"/m/{folder}/{name}"
        fp.get_filename_list = lambda folder: []
        # What the workflow "made": a grey film, put where ComfyUI would.
        grey = {"comp": 1, "format": {"width": 64, "height": 36, "fps": 24, "frames": 17},
                "nodes": [{"id": "C", "type": "constant", "color": [0.5, 0.5, 0.5, 1], "inputs": []}], "output": "C"}
        out_dir = os.path.join(self.dirs["output"], "ltx_vfx")
        os.makedirs(out_dir, exist_ok=True)
        CV.render_input(grey, "C", 17, io.Sources(None), os.path.join(out_dir, "made_00001.mp4"))
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate("() => __panel.compSetFormat({ duration: 17 })")
        nid = pg.evaluate(f"""() => {{ const e = {ED}; const c = e.comp(); const bg = c.nodes.find((n) => n.type === 'constant');
            bg.color = [1, 0, 0, 1]; e.select([bg.id]); const v = e.addNode('vfx_alpha'); e.select([v.id]); e.save(); return v.id; }}""")
        pane = f'.cp-pane[data-pane="{nid}"]'
        self.assertIn("Not rendered yet", pg.locator(f"{pane} .cp-vfx").inner_text())
        self.assertEqual(pg.locator(f"{pane} .mg-prop label", has_text="prerender").count(), 1)
        pg.evaluate("""() => { window.__queued = [];
            __panel._paintQueue = async (g) => { window.__queued.push(g); return 'p' + window.__queued.length; };
            __panel._paintWait = async () => ({ filename: 'made_00001.mp4', subfolder: 'ltx_vfx', type: 'output' }); }""")
        pg.locator(f"{pane} button", has_text="Render").first.click()
        pg.wait_for_function(f"() => {{ const n = {ED}.comp().nodes.find((x) => x.id === '{nid}'); return n.results && n.results.file; }}", timeout=60000)
        res = pg.evaluate(f"() => {ED}.comp().nodes.find((x) => x.id === '{nid}').results")
        self.assertEqual((res["first"], res["last"], res["kind"]), (0, 16, "alpha"))
        self.assertTrue(res["key"])
        queued = pg.evaluate("() => window.__queued")
        self.assertEqual(len(queued), 1)
        self.assertTrue(any(v["class_type"] == "LoadVideo" and v["inputs"]["file"].startswith("clip_vfx/") for v in queued[0].values()))
        pg.wait_for_timeout(1500)
        self.assertIn("Rendered: frames 0", pg.locator(f"{pane} .cp-vfx").inner_text())
        # The matte (grey 0.5 as sRGB, read as data) times the red that comes in: a darker red, not the plain one.
        px = self.pixel(pg, 0.5, 0.5)
        self.assertLess(px[0], 245, px)
        self.assertGreater(px[0], 120, px)
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "comp-vfx-node.png"))
        # A change upstream makes it out of date.
        pg.evaluate(f"() => {{ const e = {ED}; e.comp().nodes.find((n) => n.type === 'constant').color = [0, 1, 0, 1]; e.refresh(); e.select(['{nid}']); }}")
        pg.wait_for_timeout(300)
        self.assertIn("Out of date", pg.locator(f"{pane} .cp-vfx").inner_text())
        self.assertEqual(self.errors, [])

    def test_degrain_analyses_its_grain_on_the_server_and_shows_the_profile(self):
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate(f"""() => {{ const e = {self.ED}; e.select(['Constant1']);
            e.addNode('grain', {{ amount: 0.06, size: 0, saturation: 0.5 }}); e.addNode('degrain', {{}}); }}""")
        pg.wait_for_timeout(800)
        P = "__panel.compPropsPanel"
        did = pg.evaluate(f"() => {{ const e = {self.ED}, n = e.comp().nodes.find((x) => x.type === 'degrain'); e.select([n.id]); return n.id; }}")
        pg.wait_for_timeout(300)
        text = pg.evaluate(f"() => ({P}.querySelector('.cp-grain') || {{}}).textContent || ''")
        self.assertIn("No profile", text)
        labels = pg.evaluate(f"() => Array.from({P}.querySelectorAll('.mg-prop label')).map((l) => l.textContent)")
        for want in ("temporal", "strength", "fine", "medium", "coarse"):
            self.assertIn(want, labels)
        pg.evaluate(f"() => Array.from({P}.querySelectorAll('.cp-btnrow button')).find((b) => b.textContent === 'Analyse').click()")
        pg.wait_for_function(f"() => {{ const n = {self.ED}.comp().nodes.find((x) => x.id === '{did}'); return n && n.profile; }}", timeout=20000)
        prof = pg.evaluate(f"() => {self.ED}.comp().nodes.find((x) => x.id === '{did}').profile")
        self.assertEqual((prof["v"], prof["bins"], len(prof["sigma"])), (1, 8, 4))
        self.assertGreater(prof["sigma"][0][1][4], 0.005)     # the Grain's noise was measured at full size
        pg.wait_for_function(f"() => !!{P}.querySelector('.cp-grain-curve')", timeout=5000)
        self.assertIn("Profile from", pg.evaluate(f"() => {P}.querySelector('.cp-grain').textContent"))
        # The Grain node takes a profile too, and with it amount 1 is as measured.
        gid = pg.evaluate(f"() => {{ const e = {self.ED}, n = e.comp().nodes.find((x) => x.type === 'grain'); e.select([n.id]); return n.id; }}")
        pg.wait_for_timeout(300)
        pg.evaluate(f"() => Array.from({P}.querySelectorAll('.cp-btnrow button')).find((b) => b.textContent === 'Analyse').click()")
        pg.wait_for_function(f"() => {{ const n = {self.ED}.comp().nodes.find((x) => x.id === '{gid}'); return n && n.profile; }}", timeout=20000)
        self.assertEqual(pg.evaluate(f"() => {self.ED}.comp().nodes.find((x) => x.id === '{gid}').amount"), 1)
        pg.evaluate(f"() => {self.ED}.select(['{did}'])")
        pg.wait_for_timeout(600)
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "comp-degrain-profile.png"))
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

    def test_an_ai_node_runs_a_frame_range_as_one_job_and_picks_its_model(self):
        """All frames as ONE queued prompt (the loader once, an output per frame), the answers back as a PNG
        sequence on the node in one undo step; the node's workflow and model pickers; Stop."""
        flows = os.path.join(self.tmp, "flows_ai")
        os.environ["IMAGE_VIEWER_PAINT_WORKFLOWS"] = flows
        self.addCleanup(os.environ.pop, "IMAGE_VIEWER_PAINT_WORKFLOWS", None)
        G = importlib.import_module(self.pkg + ".paint_generate")
        fp = sys.modules[self.pkg + ".viewer_api"].folder_paths
        lists = {"checkpoints": ["base.safetensors", "sub/other.safetensors"]}
        fp.folder_names_and_paths = {k: ([], set()) for k in lists}
        fp.get_filename_list = lambda f: list(lists.get(f, []))
        fp.get_full_path = lambda f, n: (n if n in lists.get(f, []) else None)

        def undo():
            for k in ("folder_names_and_paths", "get_filename_list", "get_full_path"):
                if hasattr(fp, k):
                    delattr(fp, k)
        self.addCleanup(undo)
        G.set_custom("background", {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "base.safetensors"}},
            "2": {"class_type": "LoadImage", "_meta": {"title": "paint:image"}, "inputs": {"image": "x.png"}},
            "3": {"class_type": "SomeMatte", "inputs": {"image": ["2", 0], "model": ["1", 0], "seed": 5}},
            "4": {"class_type": "SaveImage", "_meta": {"title": "paint:output"}, "inputs": {"images": ["3", 0], "filename_prefix": "x"}},
        }, "test matte")
        G.set_choice("background", "custom")
        pg = self.page()
        pg.evaluate("""() => { const f = window.__fetchApi;
            window.__fetchApi = (p, o) => (p.startsWith('/imageviewer/paint/') ? fetch(p, o) : f(p, o)); }""")
        path = self.new_comp(pg)
        ai = pg.evaluate(f"""(file) => {{ const e = {self.ED}; const c = e.comp(); const out = c.nodes.find((n) => n.type === 'output');
            const r = e.addNode('read', {{ file }}); const a = e.addNode('ai_matte'); a.inputs = [r.id]; out.inputs = [a.id];
            e.refresh(); e.select([a.id]); return a.id; }}""", self.png)
        pg.evaluate(f"() => {self.ED}.save()")
        pg.evaluate("""() => { window.__queued = []; __api.queuePrompt = async (n, p) => { window.__queued.push(p.output);
            return { prompt_id: 'P' + window.__queued.length }; }; }""")
        # The pickers: Paint's choice plus the workflows, and the loader's files from the model folder.
        pg.wait_for_function("() => __panel.shadowRoot.querySelector('.cp-ai-model')", timeout=10000)
        opts = pg.evaluate("() => Array.from(__panel.shadowRoot.querySelector('.cp-ai-model').options).map((o) => o.value)")
        self.assertEqual(opts, ["", "base.safetensors", "sub/other.safetensors"])
        self.assertTrue(pg.evaluate("() => !!__panel.shadowRoot.querySelector('.cp-ai-wf')"))
        pg.evaluate("""() => { const s = __panel.shadowRoot.querySelector('.cp-ai-model'); s.value = 'sub/other.safetensors';
            s.dispatchEvent(new Event('change')); }""")
        self.assertEqual(pg.evaluate(f"(id) => {self.ED}.node(id).models", ai), {"1.ckpt_name": "sub/other.safetensors"})
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-ai-node-models.png"))
        # All frames: one prompt.
        pg.evaluate(f"(id) => {{ window.__run = __panel._cpAiRun(__panel._cpActive(), id, [0, 1, 2, 3]); }}", ai)
        pg.wait_for_function("() => window.__queued.length === 1", timeout=20000)
        g = pg.evaluate("() => window.__queued[0]")
        kinds = [v["class_type"] for v in g.values()]
        self.assertEqual(kinds.count("CheckpointLoaderSimple"), 1)
        self.assertEqual(kinds.count("SaveImage"), 4)
        self.assertEqual(next(v for v in g.values() if v["class_type"] == "CheckpointLoaderSimple")["inputs"]["ckpt_name"],
                         "sub/other.safetensors")
        self.assertIn("Running", pg.evaluate("() => __panel.shadowRoot.querySelector('.cp-ai-prog').textContent"))
        from PIL import Image
        os.makedirs(os.path.join(self.dirs["output"], "gen"), exist_ok=True)
        outs = {}
        for k, v in g.items():
            if v["class_type"] == "SaveImage":
                f = int(v["inputs"]["filename_prefix"].rsplit(".", 1)[1])
                a = np.zeros((90, 160, 3), np.uint8)
                a[:, : 20 * (f + 1)] = 255
                Image.fromarray(a, "RGB").save(os.path.join(self.dirs["output"], "gen", f"m{f}.png"))
                outs[k] = f"m{f}.png"
        pg.evaluate("""(outs) => { for (const [node, name] of Object.entries(outs))
                __api.dispatch('executed', { prompt_id: 'P1', node, output: { images: [{ filename: name, subfolder: 'gen', type: 'output' }] } });
            __api.dispatch('execution_success', { prompt_id: 'P1' }); }""", outs)
        pg.evaluate("() => window.__run")
        res = pg.evaluate(f"(id) => {self.ED}.node(id).results", ai)
        self.assertEqual(sorted(res["frames"]), ["0", "1", "2", "3"])
        files = [os.path.join(os.path.dirname(path), *rel.split("/")) for rel in res["frames"].values()]
        self.assertTrue(all(os.path.isfile(f) for f in files))
        self.assertEqual(len({os.path.dirname(f) for f in files}), 1)          # one folder: a sequence
        self.assertTrue(res["frames"]["2"].endswith("_matte.0002.png"), res["frames"])
        # One undo step for the whole run.
        pg.evaluate(f"() => {self.ED}.undo()")
        self.assertIsNone(pg.evaluate(f"(id) => {self.ED}.node(id).results || null", ai))
        pg.evaluate(f"() => {self.ED}.redo()")
        # Stop: out of the queue, nothing placed, the node free again.
        pg.evaluate(f"(id) => {{ window.__run = __panel._cpAiRun(__panel._cpActive(), id, [0, 1]); }}", ai)
        pg.wait_for_function("() => window.__queued.length === 2", timeout=20000)
        pg.evaluate(f"(id) => __panel._cpAiStop(id)", ai)
        pg.evaluate("() => window.__run")
        self.assertFalse(pg.evaluate("() => __panel._cpAiRuns.size"))
        self.assertTrue(pg.evaluate("() => !!__panel.shadowRoot.querySelector('.cp-btnrow')"))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
