"""Paint in the REAL viewer, against the REAL routes: open a picture in a Paint tab (its panels come up), paint a
stroke with real pointer input, undo / redo, add a layer and an adjustment, save (an .ora by the export rule, read
back here), export a .psd, the agent's change arriving as one undo step, Generate asking agentY, and the tab
leaving the viewer as it was.

    python -m unittest tests.test_paint_browser     (Playwright and aiohttp; skipped without)
"""
import asyncio
import json
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


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or web is None, "needs playwright and aiohttp")
class PaintBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls._flows_was = os.environ.get("IMAGE_VIEWER_PAINT_WORKFLOWS")
        os.environ["IMAGE_VIEWER_PAINT_WORKFLOWS"] = os.path.join(cls.tmp, "paint_workflows")   # never the user's own
        cls.routes_app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        import importlib
        cls.P = importlib.import_module(cls.pkg + ".paint_io")
        from PIL import Image
        cls.png = os.path.join(cls.dirs["output"], "photo.png")
        a = np.zeros((120, 200, 4), np.uint8)
        a[..., 2] = 160
        a[..., 3] = 255
        a[30:90, 50:150, 0] = 220
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
        if cls._flows_was is None:
            os.environ.pop("IMAGE_VIEWER_PAINT_WORKFLOWS", None)
        else:
            os.environ["IMAGE_VIEWER_PAINT_WORKFLOWS"] = cls._flows_was

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/paint.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('comfyui-image-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        return pg

    def open_photo(self, pg):
        pg.evaluate("(p) => __panel.paintOpen(p)", self.png)
        pg.wait_for_function("() => { const r = __panel._paintActive(); return r && r.editor && r.editor.doc; }", timeout=10000)
        pg.wait_for_timeout(150)

    ED = "__panel._paintActive().editor"

    def test_open_paint_undo_save_export(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        st = pg.evaluate(f"() => ({{ tab: __panel.activeTab, mode: __panel.viewport.classList.contains('paint-mode'),"
                         f" layers: __panel.isPanelDocked('paintLayers'), props: __panel.isPanelDocked('paintProps'),"
                         f" w: {ed}.doc.w, h: {ed}.doc.h, n: {ed}.doc.layers.length, frames: __panel.getImgCount() }})")
        self.assertEqual(st["tab"], "paint:" + self.png)
        self.assertTrue(st["mode"] and st["layers"] and st["props"], st)
        self.assertEqual((st["w"], st["h"], st["n"], st["frames"]), (200, 120, 1, 0))
        # The pixels arrived exactly.
        px0 = pg.evaluate(f"() => {{ const e = {ed}; const b = e.pix.get(e.doc.layers[0].id); return [...b.slice(0, 4), ...b.slice((60*200+100)*4, (60*200+100)*4+4)]; }}")
        self.assertEqual(px0, [0, 0, 160, 255, 220, 0, 160, 255])

        # A new layer, then a brush stroke with the real pointer across the canvas.
        pg.evaluate(f"() => {{ const e = {ed}; e.newLayer('Strokes'); e.fg = [255, 255, 0]; e.setTool('brush'); e.opts.brush.size = 12; e.opts.brush.hardness = 100; }}")
        box = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        x0, y0, w, h = box
        pg.mouse.move(x0 + w * 0.2, y0 + h * 0.5)
        pg.mouse.down()
        for i in range(1, 11):
            pg.mouse.move(x0 + w * (0.2 + 0.06 * i), y0 + h * 0.5, steps=2)
        pg.mouse.up()
        painted = f"() => {{ const e = {ed}; const L = e.doc.layers.find((l) => l.name === 'Strokes'); const b = e.pix.get(L.id); let n = 0; for (let i = 3; i < b.length; i += 4) if (b[i]) n++; return n; }}"
        n = pg.evaluate(painted)
        self.assertGreater(n, 300)
        self.assertTrue(pg.evaluate(f"() => {ed}.isDirty()"))
        # Ctrl+Z / Ctrl+Shift+Z with the pointer over the viewer.
        pg.mouse.move(x0 + w * 0.5, y0 + h * 0.3)
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(painted), 0)
        pg.keyboard.press("Control+Shift+z")
        self.assertEqual(pg.evaluate(painted), n)
        # An adjustment layer on top.
        pg.evaluate(f"() => {ed}.addAdjustment('invert')")

        # Save: the next version by the rule, as an .ora; read back here.
        pg.keyboard.press("Control+s")
        pg.wait_for_function("() => __panel._paintActive().path", timeout=10000)
        path = pg.evaluate("() => __panel._paintActive().path")
        self.assertRegex(path.replace("\\", "/"), r"/imageviewer/paint/photo_v\d{3}\.ora$")   # the next version free (tests share the folder)
        self.assertFalse(pg.evaluate(f"() => {ed}.isDirty()"))
        doc = self.P.read_ora(path)
        self.assertEqual([L["name"] for L in doc.layers], ["Background", "Strokes", "Invert"])
        strokes = doc.layers[1]
        self.assertEqual(int((doc.px[strokes["id"]][..., 3] > 0).sum()), n)
        # The page's picture and the file's look the same (one arithmetic, twice).
        flat_js = pg.evaluate(f"""async () => {{ const D = await import('/extensions/viewer/imageViewer_paintData.js'); const e = {ed};
            const c = D.composite(e.doc, e._pixOf, e._maskOf); return [...c.slice((60*200+60)*4, (60*200+60)*4 + 4)]; }}""")
        flat_py = self.P.composite(doc)[60, 60].tolist()
        self.assertEqual(flat_js, flat_py)

        # Saved again after a change: over the same file.
        pg.evaluate(f"() => {ed}.setLayerProps({ed}.doc.layers[2].id, {{ opacity: 0.5 }}, 'Opacity')")
        pg.keyboard.press("Control+s")
        pg.wait_for_function(f"() => !{ed}.isDirty()", timeout=10000)
        self.assertEqual(pg.evaluate("() => __panel._paintActive().path"), path)
        self.assertAlmostEqual(self.P.read_ora(path).layers[2]["opacity"], 0.5)

        # Export a .psd through the export dialog.
        pg.evaluate(f"() => __panel.paintExport(__panel._paintActive())")
        pg.wait_for_function("() => __panel.container.querySelector('.export-dlg .rd-box')", timeout=5000)
        pg.evaluate("() => { const b = __panel.container.querySelector('.export-dlg .rd-box'); const s = [...b.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'psd')); s.value = 'psd'; s.dispatchEvent(new Event('change')); }")
        pg.evaluate("() => __panel.container.querySelector('.export-dlg .rd-go').click()")
        pg.wait_for_function("() => !__panel.container.querySelector('.export-dlg')", timeout=10000)
        psds = sorted(n for n in os.listdir(os.path.dirname(path)) if n.endswith(".psd"))
        self.assertTrue(psds, os.listdir(os.path.dirname(path)))
        psd = os.path.join(os.path.dirname(path), psds[-1])
        back = self.P.read_psd(psd)
        self.assertIn("Invert (merged)", [L["name"] for L in back.layers])
        self.assertEqual(self.errors, [])

    def test_a_pens_pressure_sets_the_brushs_size_and_opacity(self):
        """A real pen through the browser's input pipeline (CDP: pointerType pen, force = pressure)."""
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {{ const e = {ed}; e.newLayer('Pen'); e.fg = [255, 255, 0]; e.setTool('brush');"
                    f" Object.assign(e.opts.brush, {{ size: 20, hardness: 100, opacity: 100 }}); }}")
        cdp = pg.context.new_cdp_session(pg)
        box = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width / {ed}.doc.w]; }}")
        x0, y0, k = box

        def pen_line(y, pressure):
            pts = [(x0 + (30 + i * 7) * k, y0 + y * k) for i in range(21)]
            def ev(kind, x, yy, buttons=1):
                cdp.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": yy, "button": "left", "buttons": buttons,
                                                      "clickCount": 1, "pointerType": "pen", "force": pressure})
            ev("mouseMoved", *pts[0], buttons=0)
            ev("mousePressed", *pts[0])
            for x, yy in pts[1:]:
                ev("mouseMoved", x, yy)
            ev("mouseReleased", *pts[-1], buttons=0)

        # Thickness of the stroke across x = 100 (its middle), and the alpha there.
        across = (f"(y0) => {{ const e = {ed}; const L = e.doc.layers.find((l) => l.name === 'Pen'); const b = e.pix.get(L.id);"
                  f" let n = 0, top = 0; for (let y = y0 - 15; y < y0 + 15; y++) {{ const a = b[(y * L.w + 100) * 4 + 3]; if (a) n++; top = Math.max(top, a); }} return [n, top]; }}")
        pen_line(30, 0.15)
        pen_line(80, 1.0)
        light, full = pg.evaluate(across, 30), pg.evaluate(across, 80)
        self.assertGreaterEqual(full[0], 18)               # size 20 at full pressure
        self.assertLessEqual(light[0], 6)                  # about 3 px at 0.15
        self.assertGreater(light[0], 0)
        self.assertEqual(light[1], 255)                    # opacity does not follow the pen by default
        # Opacity on, size off: as wide as full, but faint.
        pg.evaluate(f"() => Object.assign({ed}.opts.brush, {{ penSize: false, penOpacity: true }})")
        pen_line(55, 0.4)
        faint = pg.evaluate(across, 55)
        self.assertGreaterEqual(faint[0], 18)
        self.assertLess(abs(faint[1] - 102), 4)
        # The mouse paints at full, whatever the switches.
        pg.evaluate(f"() => Object.assign({ed}.opts.brush, {{ penSize: true, penOpacity: true }})")
        pg.mouse.move(x0 + 30 * k, y0 + 105 * k)
        pg.mouse.down()
        pg.mouse.move(x0 + 170 * k, y0 + 105 * k, steps=15)
        pg.mouse.up()
        self.assertEqual(pg.evaluate(across, 105)[1], 255)
        self.assertGreaterEqual(pg.evaluate(across, 105)[0], 18)
        # The switches are in Properties.
        self.assertTrue(pg.evaluate("() => [...__panel._paintActive().editor.parts.tool.querySelectorAll('label.paint-check')].length === 2"))
        self.assertEqual(self.errors, [])

    def test_the_agents_change_is_one_undo_step(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate("() => __panel.paintSave(__panel._paintActive())")
        pg.wait_for_function("() => __panel._paintActive().path", timeout=10000)
        path = pg.evaluate("() => __panel._paintActive().path")
        # What edit_image does: POST /imageviewer/paint/doc; the server's message is handed to the page as ComfyUI would.
        del self.sent[:]
        got = pg.evaluate("""async (path) => { const r = await fetch('/imageviewer/paint/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doc: path, ops: [{ op: 'add_layer', color: '#00ff00', name: 'Green', opacity: 50 }] }) }); return [r.status, await r.json()]; }""", path)
        self.assertEqual(got[0], 200, got)
        ev = [d for e, d in self.sent if e == "imageviewer.paint.changed"]
        self.assertEqual(len(ev), 1)
        pg.evaluate("(d) => __api.dispatch('imageviewer.paint.changed', d)", ev[0])
        pg.wait_for_function(f"() => {ed}.doc.layers.length === 2", timeout=10000)
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers[1].name"), "Green")
        self.assertFalse(pg.evaluate(f"() => {ed}.isDirty()"))      # it is what the file holds
        pg.evaluate(f"() => {ed}.undo()")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers.length"), 1)
        pg.evaluate(f"() => {ed}.redo()")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers.length"), 2)
        state = pg.evaluate("() => __panel.agentViewerState()")
        self.assertEqual(state["tab"]["mode"], "paint")
        self.assertEqual(state["paint"]["layers"], 2)
        self.assertEqual(state["paint"]["path"], path)
        self.assertEqual(self.errors, [])

    def test_the_agent_works_on_the_unsaved_picture_and_saves_it(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        # The user's unsaved work: a new layer and a selection. The picture was never saved.
        pg.evaluate(f"() => {{ const e = {ed}; e.newLayer('Mine'); const m = new Uint8Array(200*120); for (let y = 10; y < 40; y++) for (let x = 20; x < 70; x++) m[y*200+x] = 255; e.setSelection(m); }}")
        self.assertTrue(pg.evaluate(f"() => {ed}.isDirty()"))
        state = pg.evaluate("() => __panel.agentViewerState().paint")
        self.assertTrue(state["dirty"])
        self.assertEqual(state["selection_box"], {"x": 20, "y": 10, "w": 50, "h": 30})
        tok = state["token"]
        self.assertRegex(tok, r"^[0-9a-f]{32}$")
        # edit_image on the live tab: the server asks the page first (imageviewer.paint.sync), as ComfyUI would relay it.
        del self.sent[:]
        pg.evaluate("(tok) => { window.__agent = fetch('/imageviewer/paint/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' },"
                    " body: JSON.stringify({ doc: tok, sync: true, ops: [{ op: 'add_layer', color: '#00ff00', name: 'Agent', opacity: 50 }] }) })"
                    " .then(async (r) => [r.status, await r.json()]); }", tok)
        ask = []
        for _ in range(100):
            ask = [d for e, d in self.sent if e == "imageviewer.paint.sync"]
            if ask:
                break
            pg.wait_for_timeout(50)
        self.assertTrue(ask, "the page was not asked for its picture")
        pg.evaluate("(d) => __api.dispatch('imageviewer.paint.sync', d)", ask[0])
        got = pg.evaluate("() => window.__agent")
        self.assertEqual(got[0], 200, got)
        self.assertEqual([r["name"] for r in got[1]["outline"]["layers"]][:2], ["Agent", "Mine"])
        self.assertTrue(got[1]["written"])
        path = got[1]["path"]
        self.assertTrue(path.endswith(".ora"))
        ev = [d for e, d in self.sent if e == "imageviewer.paint.changed"]
        self.assertTrue(ev and ev[0]["synced"])
        pg.evaluate("(d) => __api.dispatch('imageviewer.paint.changed', d)", ev[0])
        pg.wait_for_function(f"() => {ed}.doc.layers.some((L) => L.name === 'Agent')", timeout=10000)
        self.assertFalse(pg.evaluate(f"() => {ed}.isDirty()"))      # saved, with the user's layer in it
        self.assertEqual(pg.evaluate("() => __panel._paintActive().path"), path)
        self.assertEqual([L["name"] for L in self.P.read_ora(path).layers][-2:], ["Mine", "Agent"])
        pg.evaluate(f"() => {ed}.undo()")                             # the agent's change is one step
        self.assertFalse(pg.evaluate(f"() => {ed}.doc.layers.some((L) => L.name === 'Agent')"))
        self.assertTrue(pg.evaluate(f"() => {ed}.doc.layers.some((L) => L.name === 'Mine')"))
        self.assertEqual(self.errors, [])

    def test_heal_here_and_fill_asks_agenty(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        # A selection over the red block; heal fills it from around it (blue), here.
        pg.evaluate(f"""async () => {{ const D = await import('/extensions/viewer/imageViewer_paintData.js'); const e = {ed};
            e.setSelection(D.rectMask ? D.rectMask(200, 120, 40, 20, 120, 80) : null); }}""")
        has_sel = pg.evaluate(f"() => !!{ed}.sel")
        if not has_sel:
            pg.evaluate(f"() => {{ const e = {ed}; const m = new Uint8Array(200*120); for (let y = 20; y < 100; y++) for (let x = 40; x < 160; x++) m[y*200+x] = 255; e.setSelection(m); }}")
        pg.evaluate(f"() => __panel.paintGenerate(__panel._paintActive(), 'heal', {{}})")
        pg.wait_for_function(f"() => {ed}.undoStack.length && {ed}.undoStack[{ed}.undoStack.length-1].label.startsWith('Fill from')", timeout=10000)
        mid = pg.evaluate(f"() => {{ const e = {ed}; const b = e.pix.get(e.doc.layers[0].id); return [...b.slice((60*200+100)*4, (60*200+100)*4+4)]; }}")
        self.assertLess(mid[0], 60, mid)      # the red is gone
        self.assertGreater(mid[2], 120, mid)  # the blue came in
        # Generative fill with the choice "agentY builds one": saved first, a snapshot, and agentY asked with the
        # paths and the call back.
        pg.evaluate("""async () => { await fetch('/imageviewer/paint/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'fill', choice: 'agent' }) }); __panel._paintWf = null; }""")
        self.addCleanup(lambda: self._choose("fill", "flux_fill"))
        pg.evaluate(f"() => {{ {ed}._prompt = 'a red umbrella'; }}")
        pg.evaluate(f"() => __panel.paintGenerate(__panel._paintActive(), 'fill', {{ prompt: 'a red umbrella' }})")
        pg.wait_for_function("() => window.__asked.length === 1", timeout=10000)
        text = pg.evaluate("() => window.__asked[0].text")
        self.assertIn("a red umbrella", text)
        self.assertIn("edit_image(doc=", text)
        self.assertIn('"mask": "selection"', text)
        snap = [ln for ln in text.splitlines() if ln.startswith("Mask of the selection: ")][0]
        self.assertTrue(os.path.isfile(snap.split(": ", 1)[1].split(" (box")[0]))
        self.assertEqual(self.errors, [])

    def test_leaving_the_tab_gives_the_viewer_back(self):
        pg = self.page()
        self.open_photo(pg)
        pg.evaluate("() => { __panel.allTabs['other'] = [{ filename: 'x.png', type: 'output', subfolder: '' }]; __panel.tabOrder.push('other'); __panel._rebuildTabBar(null); __panel.switchTab('other'); }")
        st = pg.evaluate("() => ({ mode: __panel.viewport.classList.contains('paint-mode'), layers: __panel.isPanelDocked('paintLayers'),"
                         " shown: getComputedStyle(__panel._paintState().host).display })")
        self.assertEqual(st, {"mode": False, "layers": False, "shown": "none"})
        pg.evaluate("() => __panel.switchTab('paint:' + %s)" % json.dumps(self.png))
        self.assertTrue(pg.evaluate("() => __panel.isPanelDocked('paintLayers')"))
        # A picture with changes asks once before its tab closes.
        pg.evaluate(f"() => {self.ED}.newLayer()")
        pg.evaluate("() => __panel.closeTab(__panel.activeTab)")
        self.assertTrue(pg.evaluate("() => !!__panel.allTabs['paint:' + %s]" % json.dumps(self.png)))
        pg.evaluate("() => __panel.closeTab('paint:' + %s)" % json.dumps(self.png))
        self.assertFalse(pg.evaluate("() => !!__panel.allTabs['paint:' + %s]" % json.dumps(self.png)))
        self.assertEqual(self.errors, [])

    # ── Sebastian's list (the second round) ─────────────────────────────────────

    def test_the_bar_opens_a_blank_canvas_and_the_pointer_shows(self):
        pg = self.page()
        pg.evaluate("() => __panel.paintBarOpen()")
        pg.wait_for_function("() => { const r = __panel._paintActive(); return r && r.editor && r.editor.doc; }", timeout=10000)
        ed = self.ED
        st = pg.evaluate(f"() => {{ const e = {ed}; const b = e.pix.get(e.doc.layers[0].id); return {{ w: e.doc.w, h: e.doc.h, px: [...b.slice(0, 4)],"
                         f" empty: !!e.wrap.querySelector('.paint-empty'), key: __panel.activeTab }}; }}")
        self.assertEqual((st["w"], st["h"], st["px"], st["empty"]), (1920, 1080, [255, 255, 255, 255], False))
        self.assertTrue(st["key"].startswith("paint:new-"), st)
        # The bar again: the same tab, not a second one.
        pg.evaluate("() => __panel.paintBarOpen()")
        self.assertEqual(pg.evaluate("() => __panel.tabOrder.filter((k) => k.startsWith('paint:')).length"), 1)
        # An editor with no picture shows the arrow (the brush hides the pointer only over a picture).
        cur = pg.evaluate("""async () => { const m = await import('/extensions/viewer/imageViewer_paintEditor.js');
            const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px'; document.body.append(d);
            const e = m.createPaintEditor(d, {}); const c = e.wrap.style.cursor; const ec = getComputedStyle(e.wrap.querySelector('.paint-empty')).cursor; e.dispose(); d.remove(); return [c, ec]; }""")
        self.assertEqual(cur, ["default", "default"])
        self.assertEqual(self.errors, [])

    def test_a_tab_whose_path_has_backslashes_closes(self):
        pg = self.page()
        key = "paint:C:\\AI\\out\\photo_v001.ora"
        left = pg.evaluate("""(key) => { __panel._paintMakeTab(key, 'photo'); __panel.closeTab(key);
            return [!!__panel.allTabs[key], [...(__panel.tabsContainer || __panel.tabBar).querySelectorAll('.tab[data-tab]')].some((b) => b.dataset.tab === key)]; }""", key)
        self.assertEqual(left, [False, False])
        self.assertEqual(self.errors, [])

    def test_the_open_dialog_closes_when_the_picture_opened(self):
        pg = self.page()
        pg.evaluate("() => { __panel._toolState = undefined; __panel.paintPickOpen(); }")     # a page whose tools never came up
        pg.wait_for_function("() => __panel.container.querySelector('.pick-dlg .pick-path')", timeout=5000)
        pg.evaluate("""(dir) => { const p = __panel.container.querySelector('.pick-dlg .pick-path'); p.value = dir;
            p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }""", os.path.dirname(self.png))
        pg.wait_for_function("(f) => [...__panel.container.querySelectorAll('.pick-dlg .pick-row.file')].some((r) => r.dataset.path === f)", arg=self.png, timeout=5000)
        pg.evaluate("(f) => [...__panel.container.querySelectorAll('.pick-dlg .pick-row.file')].find((r) => r.dataset.path === f).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))", self.png)
        pg.wait_for_function("() => { const r = __panel._paintActive(); return r && r.editor && r.editor.doc; }", timeout=10000)
        pg.wait_for_timeout(300)
        self.assertFalse(pg.evaluate("() => !!__panel.container.querySelector('.pick-dlg')"))
        self.assertEqual(self.errors, [])

    def test_clone_stamp_paints_from_the_source(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {{ const e = {ed}; e.setTool('clone'); Object.assign(e.opts.clone, {{ size: 10, hardness: 100, opacity: 100 }}); }}")
        x0, y0, k = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width / {ed}.doc.w]; }}")
        at = lambda x, y: (x0 + x * k, y0 + y * k)
        # Painting before a source is set does nothing.
        pg.mouse.move(*at(20, 10)); pg.mouse.down(); pg.mouse.move(*at(25, 10)); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.length"), 0)
        # Alt+click in the red block, then paint up in the blue.
        pg.keyboard.down("Alt"); pg.mouse.click(*at(100, 60)); pg.keyboard.up("Alt")
        self.assertEqual(pg.evaluate(f"() => [Math.round({ed}.cloneSrc.x), Math.round({ed}.cloneSrc.y)]"), [100, 60])
        pg.mouse.move(*at(20, 12)); pg.mouse.down()
        pg.mouse.move(*at(40, 12), steps=8); pg.mouse.up()
        px = f"([x, y]) => {{ const e = {ed}; const L = e.doc.layers[0]; const b = e.pix.get(L.id); const i = ((y - L.y) * L.w + x - L.x) * 4; return [...b.slice(i, i + 4)]; }}"
        self.assertEqual(pg.evaluate(px, [30, 12]), [220, 0, 160, 255])     # red, from 80 px further on
        self.assertEqual(pg.evaluate(px, [30, 25]), [0, 0, 160, 255])       # below the stroke: still blue
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Clone stamp")
        # The options bar holds the clone stamp's controls, kept in step with Properties.
        bar = pg.evaluate(f"""() => {{ const e = {ed}; const r = e.optBar.querySelector('input[type=range]'); r.value = 33; r.dispatchEvent(new Event('input'));
            return [e.opts.clone.size, e.parts.tool.querySelector('input[type=range]').value, !!e.optBar.querySelector('select')]; }}""")
        self.assertEqual(bar, [33, "33", True])
        self.assertEqual(self.errors, [])

    def test_transform_moves_rotates_and_shears(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {ed}.setTool('move')")
        x0, y0, k = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width / {ed}.doc.w]; }}")
        at = lambda x, y: (x0 + x * k, y0 + y * k)
        # Inside: a move by whole pixels, applied by Enter (no resampling: the same buffer).
        buf0 = pg.evaluate(f"() => {{ window.__b0 = {ed}.pix.get({ed}.doc.layers[0].id); return true; }}")
        pg.mouse.move(*at(100, 60)); pg.mouse.down(); pg.mouse.move(*at(110, 65), steps=5); pg.mouse.up()
        pg.keyboard.press("Enter")
        st = pg.evaluate(f"() => {{ const e = {ed}, L = e.doc.layers[0]; return [L.x, L.y, L.w, L.h, e.pix.get(L.id) === window.__b0, e.undoStack.at(-1).label, !!e.tf]; }}")
        self.assertEqual(st, [10, 5, 200, 120, True, "Move", False])
        # The numbers: a quarter turn, then Cancel (Esc) leaves it as it was.
        pg.evaluate(f"() => {ed}.tfSet({{ r: 90 }})")
        self.assertEqual(pg.evaluate(f"() => [{ed}.doc.layers[0].w, {ed}.doc.layers[0].h]"), [120, 200])
        pg.mouse.move(*at(5, 5)); pg.keyboard.press("Escape")
        self.assertEqual(pg.evaluate(f"() => [{ed}.doc.layers[0].w, {ed}.doc.layers[0].h, !!{ed}.tf]"), [200, 120, False])
        # Outside the box (left of it): a rotation about its middle (110, 65), Shift in 15° steps.
        pg.mouse.move(*at(5, 65)); pg.mouse.down()
        pg.keyboard.down("Shift"); pg.mouse.move(*at(104, 58), steps=6); pg.keyboard.up("Shift")
        r = pg.evaluate(f"() => {ed}.tf.p.r")
        self.assertEqual(r % 15, 0)
        self.assertAlmostEqual(r, 45, delta=1)
        pg.mouse.up()
        pg.evaluate(f"() => {ed}.tfCommit()")
        L = pg.evaluate(f"() => {{ const L = {ed}.doc.layers[0]; return [L.w, L.h, {ed}.undoStack.at(-1).label]; }}")
        self.assertEqual(L[2], "Transform")
        self.assertAlmostEqual(L[0], 320 / 2 ** 0.5, delta=2)
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(f"() => [{ed}.doc.layers[0].w, {ed}.doc.layers[0].x]"), [200, 10])
        # Ctrl + the top edge's handle: a horizontal shear.
        top = pg.evaluate(f"() => {{ const L = {ed}.doc.layers[0]; return [L.x + L.w / 2, L.y]; }}")
        pg.mouse.move(*at(*top)); pg.keyboard.down("Control"); pg.mouse.down()
        pg.mouse.move(*at(top[0] + 30, top[1]), steps=5); pg.mouse.up(); pg.keyboard.up("Control")
        p = pg.evaluate(f"() => {ed}.tf.p")
        self.assertAlmostEqual(p["kx"], -30 / 120, delta=0.03)
        self.assertEqual((p["sx"], p["sy"], p["r"]), (1, 1, 0))
        # The top left handle: a scale, the bottom right corner (210, 125) staying put.
        pg.keyboard.press("Escape")
        pg.mouse.move(*at(10, 5)); pg.mouse.down(); pg.mouse.move(*at(60, 35), steps=5); pg.mouse.up()
        pg.keyboard.press("Enter")
        L = pg.evaluate(f"() => {{ const L = {ed}.doc.layers[0]; return [L.x, L.y, L.w, L.h]; }}")
        for got, want in zip(L, [60, 35, 150, 90]):
            self.assertAlmostEqual(got, want, delta=2)
        self.assertEqual(self.errors, [])

    def test_transform_selection_lifts_the_selected_pixels_and_puts_them_down(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, k = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width / {ed}.doc.w]; }}")
        at = lambda x, y: (x0 + x * k, y0 + y * k)
        px = f"""([x, y]) => {{ const e = {ed}, L = e.doc.layers[0], b = e.pix.get(L.id), i = ((y - L.y) * L.w + x - L.x) * 4;
            return x < L.x || y < L.y || x >= L.x + L.w || y >= L.y + L.h ? [0, 0, 0, 0] : [b[i], b[i + 1], b[i + 2], b[i + 3]]; }}"""
        sel = f"([x, y]) => {ed}.sel ? {ed}.sel[y * {ed}.doc.w + x] : -1"
        # A square of the red block selected.
        pg.evaluate(f"""() => {{ const e = {ed}, W = e.doc.w, m = new Uint8Array(W * e.doc.h);
            for (let y = 40; y < 60; y++) for (let x = 60; x < 80; x++) m[y * W + x] = 255; e.setSelection(m); }}""")
        # Under the Transform tool's right-click.
        flyout = pg.evaluate(f"""() => {{ const e = {ed}; const b = e.box.querySelector('.paint-tools [data-group=transform]');
            b.dispatchEvent(new MouseEvent('contextmenu', {{ bubbles: true, cancelable: true }}));
            const f = e.box.querySelector('.paint-flyout[data-group=transform]'); const n = [...f.querySelectorAll('[data-tool]')].map((x) => x.dataset.tool);
            f.querySelector('[data-tool=tfsel]').click(); return n; }}""")
        self.assertEqual(flyout, ["move", "tfsel"])
        # Picked: the pixels float at once, a layer of their own over the one they came from, cut out there.
        st = pg.evaluate(f"() => {{ const e = {ed}; return [e.tool, !!(e.tf && e.tf.float), e.doc.layers.length, e.tf.L.w, e.tf.L.h, e.sel]; }}")
        self.assertEqual(st, ["tfsel", True, 2, 20, 20, None])
        self.assertEqual(pg.evaluate(px, [70, 50])[3], 0)
        # Dragged inside the box 50 px left, put down by Enter: one layer again, one undo step.
        pg.mouse.move(*at(70, 50)); pg.mouse.down(); pg.mouse.move(*at(20, 50), steps=6); pg.mouse.up()
        pg.keyboard.press("Enter")
        st = pg.evaluate(f"() => {{ const e = {ed}; return [!!e.tf, e.doc.layers.length, e.undoStack.at(-1).label]; }}")
        self.assertEqual(st, [False, 1, "Move selection"])
        self.assertEqual(pg.evaluate(px, [15, 50])[:3], [220, 0, 160])
        self.assertEqual(pg.evaluate(px, [70, 50])[3], 0)
        self.assertEqual(pg.evaluate(px, [55, 50])[:3], [220, 0, 160])
        # The selection went with them.
        self.assertEqual([pg.evaluate(sel, [15, 50]), pg.evaluate(sel, [70, 50])], [255, 0])
        # Undo: as it was before the pixels were taken up.
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(px, [70, 50])[:3], [220, 0, 160])
        self.assertEqual(pg.evaluate(px, [15, 50])[:3], [0, 0, 160])
        self.assertEqual(pg.evaluate(sel, [70, 50]), 255)
        # A quarter turn by the numbers, then Esc: everything put back, nothing on the undo stack.
        n = pg.evaluate(f"() => {ed}.undoStack.length")
        pg.evaluate(f"() => {{ {ed}.setTool('move'); {ed}.setTool('tfsel'); {ed}.tfSet({{ r: 90 }}); }}")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers.length"), 2)
        pg.mouse.move(*at(5, 5)); pg.keyboard.press("Escape")
        st = pg.evaluate(f"() => {{ const e = {ed}; return [!!e.tf, e.doc.layers.length, e.undoStack.length, !!e.sel]; }}")
        self.assertEqual(st, [False, 1, n, True])
        self.assertEqual(pg.evaluate(px, [70, 50])[:3], [220, 0, 160])
        # Shift+V switches between the two; with nothing selected it says so and floats nothing.
        pg.evaluate(f"() => {{ {ed}.setTool('move'); {ed}.deselect(); }}")
        pg.mouse.move(*at(100, 60)); pg.keyboard.press("Shift+V")
        self.assertEqual(pg.evaluate(f"() => [{ed}.tool, !!{ed}.tf]"), ["tfsel", False])
        pg.mouse.move(*at(100, 60)); pg.mouse.down(); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => [!!{ed}.tf, {ed}.doc.layers.length]"), [False, 1])
        self.assertEqual(self.errors, [])

    def test_generate_has_no_fill_around_button(self):
        pg = self.page()
        self.open_photo(pg)
        kinds = pg.evaluate(f"() => [...{self.ED}.parts.generate.querySelectorAll('[data-gen]')].map((b) => b.dataset.gen)")
        self.assertNotIn("heal", kinds)
        self.assertIn("fill", kinds)

    def test_history_panel_rename_fill_and_backspace(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {{ const e = {ed}; e.newLayer('A'); e.newLayer('B'); }}")
        pg.evaluate("() => __panel.setPanelDocked('paintHistory', true)")
        rows = pg.evaluate(f"() => [...{ed}.parts.history.querySelectorAll('.paint-row')].map((r) => [r.textContent, r.className.includes('active')])")
        self.assertEqual([r[0] for r in rows][1:], ["New layer", "New layer"])
        self.assertTrue(rows[2][1])
        # A click on the first row: back to the picture as it was opened; on the last: forwards again.
        pg.evaluate(f"() => {ed}.parts.history.querySelectorAll('.paint-row')[0].click()")
        self.assertEqual(pg.evaluate(f"() => [{ed}.doc.layers.length, {ed}.redoStack.length]"), [1, 2])
        self.assertTrue(pg.evaluate(f"() => {ed}.parts.history.querySelectorAll('.paint-row')[2].classList.contains('future')"))
        pg.evaluate(f"() => {ed}.parts.history.querySelectorAll('.paint-row')[2].click()")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers.length"), 3)

        # A double-click on a layer's name renames it.
        def name_box(name):
            return pg.evaluate(f"""(n) => {{ const r = [...{ed}.layerList.querySelectorAll('.paint-row')].find((x) => x.querySelector('.nm').textContent === n);
                const b = r.querySelector('.nm').getBoundingClientRect(); return [b.left + 10, b.top + b.height / 2]; }}""", name)
        pg.mouse.dblclick(*name_box("A"))
        pg.wait_for_timeout(50)
        self.assertTrue(pg.evaluate(f"() => !!{ed}.layerList.querySelector('.nm input')"))
        pg.keyboard.press("Control+a"); pg.keyboard.type("Sky"); pg.keyboard.press("Enter")
        self.assertIn("Sky", pg.evaluate(f"() => {ed}.doc.layers.map((l) => l.name)"))
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers.length"), 3)

        # Backspace with the Layers panel last pressed: the layer goes.
        pg.mouse.click(*name_box("B"))
        pg.keyboard.press("Backspace")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers.map((l) => l.name)"), ["Background", "Sky"])

        # Shift+F5 over the picture: Fill in Properties; a custom colour at half.
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        pg.mouse.click(x0 + w / 2, y0 + h / 2)   # the brush's dab on Sky; the canvas has the press now
        pg.evaluate(f"() => {{ const e = {ed}; e.setActive(e.doc.layers[0].id); e.setTool('marquee'); }}")
        pg.evaluate(f"() => {{ const e = {ed}; const m = new Uint8Array(200*120); for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) m[y*200+x] = 255; e.setSelection(m); }}")
        pg.keyboard.press("Shift+F5")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.props.querySelector('.paint-fill')"))
        pg.evaluate(f"""() => {{ const f = {ed}.parts.props.querySelector('.paint-fill'); const s = f.querySelector('select'); s.value = 'custom'; s.dispatchEvent(new Event('change'));
            const c = f.querySelector('input[type=color]'); c.value = '#00ff00'; c.dispatchEvent(new Event('input'));
            const n = f.querySelector('input[type=number]'); n.value = 50; n.dispatchEvent(new Event('change'));
            [...f.querySelectorAll('button')].find((b) => b.textContent === 'Fill').click(); }}""")
        px = pg.evaluate(f"() => {{ const e = {ed}; const b = e.pix.get(e.doc.layers[0].id); return [[...b.slice(0, 4)], [...b.slice((20*200+20)*4, (20*200+20)*4+4)]]; }}")
        self.assertEqual(px[0], [0, 128, 80, 255])
        self.assertEqual(px[1], [0, 0, 160, 255])
        self.assertFalse(pg.evaluate(f"() => !!{ed}.parts.props.querySelector('.paint-fill')"))
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Fill")
        self.assertEqual(self.errors, [])

    def test_layers_pick_several_group_drag_move_and_save(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {{ const e = {ed}; e.newLayer('A'); e.newLayer('B'); e.newLayer('C'); }}")
        names = lambda: pg.evaluate(f"() => {ed}.doc.layers.map((l) => l.name + (l.parent ? '<' + {ed}.doc.layers.find((g) => g.id === l.parent).name : ''))")

        def row(name):
            # The list is short in the test's window: the row is scrolled to first.
            return pg.evaluate(f"""(n) => {{ const r = [...{ed}.layerList.querySelectorAll('.paint-row')].find((x) => x.querySelector('.nm').textContent === n);
                r.scrollIntoView({{ block: 'nearest' }}); const b = r.getBoundingClientRect(); return [b.left + b.width * 0.6, b.top + b.height / 2, b.height]; }}""", name)
        # Click C, Shift+click A: A, B and C picked; Ctrl+click B: out again.
        pg.mouse.click(*row("C")[:2])
        pg.keyboard.down("Shift"); pg.mouse.click(*row("A")[:2]); pg.keyboard.up("Shift")
        picked = lambda: sorted(pg.evaluate(f"() => {ed}.pickedLayers().map((l) => l.name)"))
        self.assertEqual(picked(), ["A", "B", "C"])
        self.assertEqual(pg.evaluate(f"() => {ed}.layerList.querySelectorAll('.paint-row.picked').length"), 3)
        pg.keyboard.down("Control"); pg.mouse.click(*row("B")[:2]); pg.keyboard.up("Control")
        self.assertEqual(picked(), ["A", "C"])
        # Opacity from the panel: both. Ctrl+G: A and C into a group where C was.
        pg.evaluate(f"() => {{ const e = {ed}; e.opNum.value = 40; e.opNum.dispatchEvent(new Event('change')); }}")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers.filter((l) => l.opacity === 0.4).map((l) => l.name)"), ["A", "C"])
        pg.mouse.move(*row("C")[:2])
        pg.keyboard.press("Control+g")
        self.assertEqual(names(), ["Background", "B", "A<Group 1", "C<Group 1", "Group 1"])
        self.assertEqual(pg.evaluate(f"() => {ed}.active().blend"), "pass_through")
        # Indented under it; folding hides its rows (and is no undo step).
        undo_n = pg.evaluate(f"() => {ed}.undoStack.length")
        pg.evaluate(f"() => {ed}.layerList.querySelector('.paint-row .caret:not(.none)').click()")
        self.assertEqual(pg.evaluate(f"() => [...{ed}.layerList.querySelectorAll('.paint-row .nm')].map((n) => n.textContent)"), ["Group 1", "B", "Background"])
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.length"), undo_n)
        pg.evaluate(f"() => {ed}.layerList.querySelector('.paint-row .caret:not(.none)').click()")
        # Drag B onto the group's row (its middle): into the group, at its top.
        pg.evaluate(f"""() => {{ const e = {ed}; const rows = [...e.layerList.querySelectorAll('.paint-row')];
            const src = rows.find((r) => r.querySelector('.nm').textContent === 'B'), dst = rows.find((r) => r.querySelector('.nm').textContent === 'Group 1');
            const dt = new DataTransfer(); const b = dst.getBoundingClientRect();
            src.dispatchEvent(new DragEvent('dragstart', {{ dataTransfer: dt, bubbles: true }}));
            dst.dispatchEvent(new DragEvent('dragover', {{ dataTransfer: dt, bubbles: true, cancelable: true, clientY: b.top + b.height / 2 }}));
            dst.dispatchEvent(new DragEvent('drop', {{ dataTransfer: dt, bubbles: true, cancelable: true, clientY: b.top + b.height / 2 }})); }}""")
        self.assertEqual(names(), ["Background", "A<Group 1", "C<Group 1", "B<Group 1", "Group 1"])
        # The Move tool with the group active moves every layer in it, as one undo step.
        pg.evaluate(f"""() => {{ const e = {ed}; e.setActive(e.doc.layers.find((l) => l.name === 'Group 1').id); e.setTool('move');
            for (const l of e.doc.layers) if (l.kind === 'pixel' && l.name !== 'Background') {{ const b = e.pix.get(l.id); b.fill(0); for (let i = 0; i < 40; i++) b.set([255, 0, 0, 255], ((20 + i) * 200 + 20) * 4); }} }}""")
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        k = w / 200
        pg.mouse.move(x0 + 100 * k, y0 + 60 * k); pg.mouse.down()
        pg.mouse.move(x0 + 110 * k, y0 + 65 * k, steps=4); pg.mouse.up()
        pos = pg.evaluate(f"() => {ed}.doc.layers.filter((l) => l.kind === 'pixel').map((l) => [l.name, l.x, l.y])")
        self.assertEqual(pos, [["Background", 0, 0], ["A", 10, 5], ["C", 10, 5], ["B", 10, 5]])
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Move layers")
        # The page's picture with the group equals the server's, saved as an .ora with the group in it.
        pg.evaluate(f"() => {{ const e = {ed}; e.setLayerProps(e.active().id, {{ blend: 'multiply', opacity: 0.7 }}, 'Group'); }}")
        pg.evaluate("() => __panel.paintSave(__panel._paintActive())")
        pg.wait_for_function(f"() => !{ed}.isDirty()", timeout=10000)
        path = pg.evaluate("() => __panel._paintActive().path")
        doc = self.P.read_ora(path)
        self.assertEqual([L["name"] for L in doc.layers], ["Background", "A", "C", "B", "Group 1"])
        self.assertEqual(doc.layers[-1]["blend"], "multiply")
        js = pg.evaluate(f"""async () => {{ const D = await import('/extensions/viewer/imageViewer_paintData.js'); const e = {ed};
            return [...D.composite(e.doc, e._pixOf, e._maskOf)]; }}""")
        py = self.P.composite(doc)
        self.assertLessEqual(int(np.abs(np.array(js, np.int32).reshape(py.shape) - py.astype(np.int32)).max()), 1)
        # Ctrl+E on the group: one layer that looks the same; undo; Ctrl+Shift+G ungroups.
        before = pg.evaluate(f"() => [...{ed}.comp]")
        pg.mouse.move(x0 + 50, y0 + 50)
        pg.keyboard.press("Control+e")
        self.assertEqual(names(), ["Background", "Group 1"])
        self.assertEqual(pg.evaluate(f"() => [...{ed}.comp]"), before)
        pg.keyboard.press("Control+z")
        pg.keyboard.press("Control+Shift+g")
        self.assertEqual(names(), ["Background", "A", "C", "B"])
        self.assertEqual(sorted(pg.evaluate(f"() => {ed}.pickedLayers().map((l) => l.name)")), ["A", "B", "C"])
        # Delete with several picked: all of them go, in one step.
        pg.evaluate(f"() => {ed}.deleteLayer()")
        self.assertEqual(names(), ["Background"])
        self.assertEqual(self.errors, [])

    def test_clipping_mask_and_a_filters_live_preview(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        # A small "base" and a red layer over all of it; Alt+click on the red one clips it to the base.
        pg.evaluate(f"""() => {{ const e = {ed};
            const b = new Uint8ClampedArray(40 * 30 * 4); for (let i = 0; i < 40 * 30; i++) b.set([0, 255, 0, 255], i * 4);
            e.addPixelLayer(b, 40, 30, 'base', 10, 10);
            const r = new Uint8ClampedArray(200 * 120 * 4); for (let i = 0; i < 200 * 120; i++) r.set([255, 0, 0, 255], i * 4);
            e.addPixelLayer(r, 200, 120, 'red', 0, 0); }}""")
        comp = lambda x, y: pg.evaluate(f"() => [...{ed}.comp.slice(({y} * 200 + {x}) * 4, ({y} * 200 + {x}) * 4 + 4)]")
        self.assertEqual(comp(150, 100), [255, 0, 0, 255])
        r = pg.evaluate(f"""() => {{ const row = [...{ed}.layerList.querySelectorAll('.paint-row')].find((x) => x.querySelector('.nm').textContent === 'red');
            row.scrollIntoView({{ block: 'nearest' }}); const b = row.getBoundingClientRect(); return [b.left + b.width * 0.6, b.top + b.height / 2]; }}""")
        pg.keyboard.down("Alt"); pg.mouse.click(*r); pg.keyboard.up("Alt")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.doc.layers.find((l) => l.name === 'red').clip"))
        self.assertEqual(comp(20, 20), [255, 0, 0, 255])          # on the base
        self.assertEqual(comp(150, 100)[:3], [0, 0, 160])         # off it: the photo
        self.assertTrue(pg.evaluate(f"() => !!{ed}.layerList.querySelector('.paint-row .clipmark') && !!{ed}.layerList.querySelector('.nm.base')"))
        # Ctrl+Alt+G releases it.
        pg.mouse.move(r[0], r[1])
        pg.keyboard.press("Control+Alt+g")
        self.assertEqual(comp(150, 100), [255, 0, 0, 255])
        # A filter's preview shows on the picture without an undo step; Cancel puts it back; OK is one step.
        pg.evaluate(f"() => {ed}.deleteLayer({ed}.doc.layers.find((l) => l.name === 'red').id)")
        pg.evaluate(f"() => {{ const e = {ed}; e.setActive(e.doc.layers[0].id); }}")
        n0 = pg.evaluate(f"() => {ed}.undoStack.length")
        before = comp(50, 30)
        pg.evaluate(f"() => {ed}._filterMenu().find((m) => m && m.label && m.label.startsWith('Pixelate')).run()")
        pg.wait_for_function(f"() => !!{ed}.box.querySelector('.paint-dlg')", timeout=3000)
        pg.evaluate(f"() => {{ const i = {ed}.box.querySelector('.paint-dlg input[type=number]'); i.value = 40; i.dispatchEvent(new Event('input')); }}")
        pg.wait_for_timeout(400)
        self.assertNotEqual(comp(50, 30), before)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.length"), n0)
        pg.evaluate(f"() => [...{ed}.box.querySelectorAll('.paint-dlg button')].find((b) => b.textContent === 'Cancel').click()")
        pg.wait_for_timeout(100)
        self.assertEqual(comp(50, 30), before)
        pg.evaluate(f"() => {ed}._filterMenu().find((m) => m && m.label && m.label.startsWith('Pixelate')).run()")
        pg.wait_for_function(f"() => !!{ed}.box.querySelector('.paint-dlg')", timeout=3000)
        pg.evaluate(f"() => [...{ed}.box.querySelectorAll('.paint-dlg button')].find((b) => b.textContent === 'OK').click()")
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Pixelate (mosaic)")
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.length"), n0 + 1)
        pg.keyboard.press("Control+z")
        self.assertEqual(comp(50, 30), before)
        self.assertEqual(self.errors, [])

    def test_spot_healing_healing_brush_patch_and_clone_overlay(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda x, y: (x0 + x * w / 200, y0 + y * h / 120)
        # A striped layer with three red specks.
        pg.evaluate(f"""() => {{ const e = {ed}, px = new Uint8ClampedArray(200 * 120 * 4);
            for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) px.set(((x >> 3) & 1) ? [200, 200, 200, 255] : [70, 70, 70, 255], (y * 200 + x) * 4);
            for (const [cx, cy] of [[40, 40], [100, 60], [160, 80]]) for (let y = cy - 3; y < cy + 3; y++) for (let x = cx - 3; x < cx + 3; x++) px.set([255, 0, 0, 255], (y * 200 + x) * 4);
            e.addPixelLayer(px, 200, 120, 'stripes'); }}""")
        red = lambda cx, cy: pg.evaluate(f"""() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id); let n = 0;
            for (let y = {cy} - 3; y < {cy} + 3; y++) for (let x = {cx} - 3; x < {cx} + 3; x++) {{ const o = ((y - L.y) * L.w + x - L.x) * 4; if (b[o] - b[o + 1] > 60) n++; }} return n; }}""")
        self.assertEqual(red(40, 40), 36)
        # J: the spot healing brush; a dab over the speck takes it away.
        pg.mouse.move(*at(5, 5))
        pg.keyboard.press("j")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "spot")
        pg.evaluate(f"() => {{ {ed}.opts.spot.size = 14; }}")
        pg.mouse.move(*at(39, 40)); pg.mouse.down(); pg.mouse.move(*at(41, 40), steps=3); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Spot healing brush")
        self.assertEqual(red(40, 40), 0)
        # Shift+J: the healing brush, from a source (Alt+click); its stroke heals the second speck.
        pg.keyboard.press("Shift+j")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "heal")
        pg.evaluate(f"() => {{ {ed}.opts.heal.size = 14; }}")
        pg.keyboard.down("Alt"); pg.mouse.click(*at(116, 60)); pg.keyboard.up("Alt")
        pg.mouse.move(*at(100, 60)); pg.mouse.down(); pg.mouse.move(*at(101, 60), steps=2); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Healing brush")
        self.assertEqual(red(100, 60), 0)
        # Shift+J: the patch; the selection round the third speck dragged 16 px right.
        pg.keyboard.press("Shift+j")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "patch")
        pg.evaluate(f"() => {{ const e = {ed}, m = new Uint8Array(200 * 120); for (let y = 74; y < 86; y++) for (let x = 154; x < 166; x++) m[y * 200 + x] = 255; e.setSelection(m); }}")
        pg.mouse.move(*at(160, 80)); pg.mouse.down(); pg.mouse.move(*at(176, 80), steps=4); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Patch")
        self.assertEqual(red(160, 80), 0)
        # One step each: undo brings the speck back.
        pg.keyboard.press("Control+z")
        self.assertEqual(red(160, 80), 36)
        # The clone stamp's overlay draws (no error) and a turned source is where the cross goes.
        pg.evaluate(f"() => {{ const e = {ed}; e.setTool('clone'); e.setCloneSource(50, 50); }}")
        pg.mouse.move(*at(120, 30))
        self.assertTrue(pg.evaluate(f"() => {ed}.opts.clone.overlay"))
        pg.evaluate(f"() => {{ {ed}.opts.clone.angle = 90; }}")
        pg.mouse.move(*at(30, 30)); pg.mouse.down(); pg.mouse.move(*at(31, 30), steps=2); pg.mouse.up()
        src = pg.evaluate(f"() => {ed}._cloneFrom(40, 30)")
        self.assertAlmostEqual(src["x"], 50, delta=1.5)
        self.assertAlmostEqual(src["y"], 60, delta=1.5)

    def test_distort_perspective_and_warp(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda x, y: (x0 + x * w / 200, y0 + y * h / 120)
        L = lambda: pg.evaluate(f"() => {{ const L = {ed}.doc.layers[0]; return [L.x, L.y, L.w, L.h]; }}")
        alpha = lambda x, y: pg.evaluate(f"() => {{ const e = {ed}, L = e.doc.layers[0]; if ({x} < L.x || {y} < L.y || {x} >= L.x + L.w || {y} >= L.y + L.h) return 0;"
                                         f" return e.pix.get(L.id)[(({y} - L.y) * L.w + {x} - L.x) * 4 + 3]; }}")
        def drag(a, b):
            pg.mouse.move(*at(*a)); pg.mouse.down(); pg.mouse.move(*at(*b), steps=6); pg.mouse.up()
        # Distort: the top right corner pulled in; Enter applies it as one step.
        pg.evaluate(f"() => {ed}.wpBegin('distort')")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "move")
        drag((200, 0), (160, 30))
        pg.mouse.move(*at(100, 60))
        pg.keyboard.press("Enter")
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Distort")
        self.assertFalse(pg.evaluate(f"() => !!{ed}.wp"))
        self.assertEqual(alpha(195, 5), 0)
        self.assertEqual(alpha(100, 60), 255)
        self.assertEqual(alpha(5, 115), 255)
        pg.keyboard.press("Control+z")
        self.assertEqual(L(), [0, 0, 200, 120])
        # Perspective: the top left corner dragged right takes the top right one left.
        pg.evaluate(f"() => {ed}.wpBegin('perspective')")
        drag((0, 0), (40, 0))
        q = pg.evaluate(f"() => {ed}.wp.pts")
        self.assertAlmostEqual(q[0][0], 40, delta=1.5)
        self.assertAlmostEqual(q[1][0], 160, delta=1.5)
        pg.keyboard.press("Enter")
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Perspective")
        self.assertEqual(alpha(5, 2), 0)
        self.assertEqual(alpha(195, 2), 0)
        self.assertEqual(alpha(100, 2), 255)
        pg.keyboard.press("Control+z")
        # Warp from Properties' button: the middle points pulled down bend the picture; Esc puts it back.
        pg.click(".wp-warp")
        self.assertEqual(pg.evaluate(f"() => [{ed}.wp.mode, {ed}.wp.pts.length]"), ["warp", 16])
        before = pg.evaluate(f"() => [...{ed}.comp]")
        drag((200 / 3, 40), (200 / 3, 70))
        self.assertNotEqual(pg.evaluate(f"() => [...{ed}.comp]"), before)
        pg.keyboard.press("Escape")
        self.assertFalse(pg.evaluate(f"() => !!{ed}.wp"))
        self.assertEqual(L(), [0, 0, 200, 120])
        pg.click(".wp-warp")
        drag((200 / 3, 0), (200 / 3, 30))
        pg.mouse.dblclick(*at(100, 60))
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Warp")
        self.assertEqual(alpha(66, 5), 0)
        self.assertEqual(alpha(66, 60), 255)

    def test_pen_paths_select_fill_stroke_and_save(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        k = w / 200
        at = lambda x, y: (x0 + x * k, y0 + y * k)
        pg.mouse.move(*at(5, 5))
        pg.keyboard.press("p")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "pen")
        # Click, click, drag (a smooth anchor), click, then the first anchor: a closed path of four.
        pg.mouse.click(*at(20, 20))
        pg.mouse.click(*at(180, 20))
        pg.mouse.move(*at(180, 100)); pg.mouse.down(); pg.mouse.move(*at(160, 110), steps=5); pg.mouse.up()
        pg.mouse.click(*at(20, 100))
        pg.mouse.click(*at(20, 20))
        P = pg.evaluate(f"() => {ed}.curPath()")
        self.assertTrue(P["closed"])
        self.assertEqual(len(P["pts"]), 4)
        self.assertTrue(P["pts"][2]["smooth"])
        self.assertAlmostEqual(P["pts"][2]["ox"], 160, delta=1)
        self.assertAlmostEqual(P["pts"][2]["ix"], 200, delta=1)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.slice(-2).map((x) => x.label)"), ["Add anchor", "Close path"])
        # Ctrl+Enter: the inside as the selection.
        pg.keyboard.press("Control+Enter")
        self.assertEqual(pg.evaluate(f"() => [{ed}.sel[60 * 200 + 100], {ed}.sel[5 * 200 + 5], {ed}.sel[60 * 200 + 190]]"), [255, 0, 0])
        # Ctrl+drag the first anchor; a click on a straight segment adds an anchor, a click on that anchor takes it away.
        pg.keyboard.down("Control"); pg.mouse.move(*at(20, 20)); pg.mouse.down(); pg.mouse.move(*at(10, 10), steps=4); pg.mouse.up(); pg.keyboard.up("Control")
        b0 = P["pts"][0]
        a0 = pg.evaluate(f"() => {ed}.curPath().pts[0]")
        self.assertAlmostEqual(a0["x"] - b0["x"], -10, delta=0.6)
        self.assertAlmostEqual(a0["y"] - b0["y"], -10 * k / (h / 120), delta=0.6)
        pg.mouse.click(*at(95, 15))
        self.assertEqual(pg.evaluate(f"() => {ed}.curPath().pts.length"), 5)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Add anchor")
        pg.mouse.click(*at(95, 15))
        self.assertEqual(pg.evaluate(f"() => {ed}.curPath().pts.length"), 4)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Delete anchor")
        # Fill (Properties' button) paints the inside with the colour; Stroke paints along it on a new layer.
        pg.evaluate(f"() => {{ {ed}.deselect(); {ed}.fg = [0, 255, 0]; }}")
        pg.click(".pen-fill")
        px = lambda x, y, i=0: pg.evaluate(f"() => {{ const e = {ed}, L = e.doc.layers[{i}], b = e.pix.get(L.id), o = (({y} - L.y) * L.w + {x} - L.x) * 4; return [...b.slice(o, o + 4)]; }}")
        self.assertEqual(px(100, 60), [0, 255, 0, 255])
        self.assertEqual(px(5, 110), [0, 0, 160, 255])
        pg.evaluate(f"() => {{ {ed}.newLayer(); {ed}.fg = [255, 0, 0]; {ed}.opts.pen.width = 4; }}")
        pg.click(".pen-stroke")
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Stroke path")
        mx, my = pg.evaluate(f"() => {{ const q = {ed}.curPath().pts; return [Math.floor((q[3].x + q[0].x) / 2), Math.floor((q[3].y + q[0].y) / 2)]; }}")
        self.assertEqual(px(mx, my, 1), [255, 0, 0, 255])
        self.assertEqual(px(100, 60, 1)[3], 0)
        # Mask from the path; undo takes it away again.
        pg.click(".pen-mask")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.active().mask"))
        pg.keyboard.press("Control+z")
        self.assertFalse(pg.evaluate(f"() => !!{ed}.active().mask"))
        # Saved in the .ora and read back; the server's agent op makes the same selection.
        pg.evaluate("() => __panel.paintSave(__panel._paintActive())")
        pg.wait_for_function(f"() => !{ed}.isDirty()", timeout=10000)
        path = pg.evaluate("() => __panel._paintActive().path")
        doc = self.P.read_ora(path)
        self.assertEqual([q["name"] for q in doc.meta["paths"]], ["Path 1"])
        self.assertEqual(len(doc.meta["paths"][0]["pts"]), 4)
        from paint_pkg import paint_ops as O
        O.apply_ops(doc, [{"op": "path", "path": "Path 1", "do": "select"}], read_image=None)
        js = pg.evaluate(f"""async () => {{ const D = await import('/extensions/viewer/imageViewer_paintData.js');
            return [...D.pathMask({ed}.doc.w, {ed}.doc.h, {ed}.curPath())]; }}""")
        self.assertTrue((np.array(js, np.uint8).reshape(doc.selection.shape) == doc.selection).all())
        # Esc lets go of the path; Delete with it picked deletes it.
        pg.mouse.move(*at(5, 5))
        pg.keyboard.press("Escape")
        self.assertIsNone(pg.evaluate(f"() => {ed}.curPath()"))
        pg.evaluate(f"() => {ed}.selectPath({ed}.doc.paths[0].id)")
        pg.keyboard.press("Delete")
        self.assertFalse(pg.evaluate(f"() => !!{ed}.doc.paths"))

    def test_quick_mask_and_mask_handling(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        k = w / 200
        # Q with nothing selected: all selected (no red). Black brush strokes take away; Q again: the selection.
        pg.mouse.move(x0 + 5, y0 + 5)
        pg.keyboard.press("q")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.quick && {ed}.tint.style.display === 'block'"))
        pg.evaluate(f"() => {{ const e = {ed}; e.setTool('brush'); e.fg = [0, 0, 0]; e.opts.brush.size = 20; e.opts.brush.hardness = 100; }}")
        n0 = pg.evaluate(f"() => {ed}.undoStack.length")
        pg.mouse.move(x0 + 50 * k, y0 + 60 * k); pg.mouse.down()
        pg.mouse.move(x0 + 150 * k, y0 + 60 * k, steps=10); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Quick Mask Brush")
        self.assertEqual(pg.evaluate(f"() => {ed}.quick.m[60 * 200 + 100]"), 0)
        self.assertEqual(pg.evaluate(f"() => {ed}.tint.getContext('2d').getImageData(100, 60, 1, 1).data[3]"), 128)
        # The photo's pixels did not change.
        self.assertEqual(pg.evaluate(f"() => [...{ed}.pix.get({ed}.doc.layers[0].id).slice((60*200+100)*4, (60*200+100)*4+4)]"), [220, 0, 160, 255])
        pg.keyboard.press("q")
        self.assertFalse(pg.evaluate(f"() => !!{ed}.quick || {ed}.tint.style.display === 'block'"))
        self.assertEqual(pg.evaluate(f"() => [{ed}.sel[60 * 200 + 100], {ed}.sel[10 * 200 + 10]]"), [0, 255])
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.length"), n0 + 2)
        # A mask from the selection on a new layer; Alt+click its thumbnail shows it alone, Esc goes back.
        pg.evaluate(f"""() => {{ const e = {ed}; const r = new Uint8ClampedArray(200 * 120 * 4); for (let i = 0; i < 200 * 120; i++) r.set([255, 255, 0, 255], i * 4);
            e.addPixelLayer(r, 200, 120, 'yellow'); e.addMask('selection'); e.deselect(); }}""")
        comp = lambda x, y: pg.evaluate(f"() => [...{ed}.comp.slice(({y} * 200 + {x}) * 4, ({y} * 200 + {x}) * 4 + 4)]")
        self.assertEqual(comp(10, 10), [255, 255, 0, 255])
        self.assertEqual(comp(100, 60), [220, 0, 160, 255])
        mt = pg.evaluate(f"""() => {{ const r = [...{ed}.layerList.querySelectorAll('.paint-row')].find((x) => x.querySelector('.nm').textContent === 'yellow');
            r.scrollIntoView({{ block: 'nearest' }}); const c = r.querySelectorAll('canvas')[1].getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; }}""")
        pg.keyboard.down("Alt"); pg.mouse.click(*mt); pg.keyboard.up("Alt")
        self.assertEqual(pg.evaluate(f"() => [{ed}.tint.style.display, [...{ed}.tint.getContext('2d').getImageData(100, 60, 1, 1).data]]"), ["block", [0, 0, 0, 255]])
        pg.mouse.move(x0 + 5, y0 + 5)
        pg.keyboard.press("Escape")
        self.assertEqual(pg.evaluate(f"() => {ed}.tint.style.display"), "none")
        # Ctrl+click the mask's thumbnail: the selection; the bucket and Del paint the mask while it is picked.
        mt = pg.evaluate(f"""() => {{ const r = [...{ed}.layerList.querySelectorAll('.paint-row')].find((x) => x.querySelector('.nm').textContent === 'yellow');
            r.scrollIntoView({{ block: 'nearest' }}); const c = r.querySelectorAll('canvas')[1].getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; }}""")
        pg.keyboard.down("Control"); pg.mouse.click(*mt); pg.keyboard.up("Control")
        self.assertEqual(pg.evaluate(f"() => [{ed}.sel[60 * 200 + 100], {ed}.sel[10 * 200 + 10]]"), [0, 255])
        pg.mouse.click(*mt)                                    # the mask picked
        self.assertTrue(pg.evaluate(f"() => {ed}.editMask"))
        pg.mouse.move(x0 + 5, y0 + 5)
        pg.evaluate(f"() => {{ {ed}._layersFocus = false; }}")  # as after a press on the canvas
        pg.keyboard.press("Delete")                            # the selected part hidden
        self.assertEqual(comp(10, 10)[:3], [0, 0, 160])
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Clear (mask)")
        # Density 50 %: what the mask hides shows at half.
        pg.keyboard.press("Control+z")
        pg.evaluate(f"""() => {{ const s = [...{ed}.parts.props.querySelectorAll('.paint-sect')].find((x) => x.querySelector('h4').textContent === 'Mask');
            const r = s.querySelector('input[type=range]'); r.value = 50; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }}""")
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Mask density")
        c = comp(100, 60)
        self.assertTrue(230 <= c[0] <= 240 and 120 <= c[1] <= 135, c)
        self.assertEqual(self.errors, [])


    def test_brush_tips_abr_import_angle_and_tip_from_selection(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda x, y: (x0 + x * w / 200, y0 + y * h / 120)
        # A version 1 .abr built byte by byte: one sampled tip, a bar 40 x 4.
        r = pg.evaluate(f"""async () => {{ const b = [], u8 = (v) => b.push(v & 255), u16 = (v) => {{ u8(v >> 8); u8(v); }}, u32 = (v) => {{ u16(v >>> 16); u16(v & 0xffff); }};
            const body = []; const B = (f) => {{ const keep = b.length; f(); body.push(...b.splice(keep)); }};
            B(() => {{ u32(0); u16(25); u8(1); for (let i = 0; i < 8; i++) u8(0); u32(0); u32(0); u32(4); u32(40); u16(8); u8(0); for (let i = 0; i < 160; i++) u8(255); }});
            u16(1); u16(1); u16(2); u32(body.length); b.push(...body);
            const e = {ed}; e.setTool('brush'); const res = await e.importAbr(new Uint8Array(b), 'bars.abr');
            return [res.tips.length, e.opts.brush.tip, e.tips.get(e.opts.brush.tip).w, e.tips.get(e.opts.brush.tip).h, e.opts.brush.spacing]; }}""")
        self.assertEqual(r[0], 1)
        self.assertEqual(r[2:], [40, 4, 25])
        tip = r[1]
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.tool.querySelector('.paint-tip[data-tip=\"{tip}\"].on')"))
        # One dab on an empty layer: the bar lies across, then turned 90° it stands.
        pg.evaluate(f"""() => {{ const e = {ed}; e.addPixelLayer(new Uint8ClampedArray(200 * 120 * 4), 200, 120, 'tips');
            e.fg = [0, 0, 0]; e.opts.brush.size = 40; e.opts.brush.hardness = 100; e.opts.brush.opacity = 100; }}""")
        alpha = lambda x, y: pg.evaluate(f"() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id); return b[(({y} - L.y) * L.w + {x} - L.x) * 4 + 3]; }}")
        pg.mouse.click(*at(100, 60))
        self.assertGreater(alpha(115, 60), 200)
        self.assertEqual(alpha(100, 50), 0)
        pg.keyboard.press("Control+z")
        self.assertEqual(alpha(115, 60), 0)
        pg.evaluate(f"() => {{ {ed}.opts.brush.angle = 90; }}")
        pg.mouse.click(*at(100, 60))
        self.assertGreater(alpha(100, 50), 200)
        self.assertEqual(alpha(115, 60), 0)
        # Define a tip from the selection: a black square in it, kept as a tip of its size, chosen.
        n = pg.evaluate(f"""async () => {{ const e = {ed}, px = new Uint8ClampedArray(200 * 120 * 4).fill(255);
            for (let y = 20; y < 32; y++) for (let x = 20; x < 32; x++) px.set([0, 0, 0, 255], (y * 200 + x) * 4);
            e.addPixelLayer(px, 200, 120, 'square'); const m = new Uint8Array(200 * 120);
            for (let y = 16; y < 36; y++) for (let x = 16; x < 36; x++) m[y * 200 + x] = 255; e.setSelection(m);
            const t = await e.tipFromSelection(); return [t.w, t.h, e.opts.brush.tip === t.id, [...e.tips.values()].filter((x) => !x.builtin).length]; }}""")
        self.assertEqual(n[2:], [True, 2])
        self.assertTrue(12 <= n[0] <= 20 and 12 <= n[1] <= 20, n)
        # Round again, and the tip forgotten.
        pg.evaluate(f"() => {{ const e = {ed}; e.parts.tool.querySelector('.tip-del').click(); }}")
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate(f"() => [[...{ed}.tips.values()].filter((x) => !x.builtin).length, {ed}.opts.brush.tip || null]"), [1, None])
        self.assertEqual(self.errors, [])

    def test_gradient_shapes_dodge_burn_sponge_and_smudge(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda x, y: (x0 + x * w / 200, y0 + y * h / 120)
        px = lambda x, y: pg.evaluate(f"() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id), o = (({y} - L.y) * L.w + {x} - L.x) * 4; return [...b.slice(o, o + 4)]; }}")
        label = lambda: pg.evaluate(f"() => {ed}.undoStack.at(-1).label")
        pg.evaluate(f"() => {{ const e = {ed}; e.addPixelLayer(new Uint8ClampedArray(200 * 120 * 4), 200, 120, 'g'); e.fg = [255, 0, 0]; e.bg = [0, 0, 255]; }}")
        # G, Shift+G: the gradient; dragged across, red on the left, blue on the right, one step.
        pg.mouse.move(*at(5, 5))
        pg.keyboard.press("g"); pg.keyboard.press("Shift+g")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "gradient")
        pg.mouse.move(*at(20, 60)); pg.mouse.down(); pg.mouse.move(*at(180, 62), steps=5); pg.mouse.up()
        self.assertEqual(label(), "Gradient")
        self.assertEqual(px(5, 60), [255, 0, 0, 255])
        self.assertEqual(px(195, 60), [0, 0, 255, 255])
        mid = px(100, 60)
        self.assertTrue(110 < mid[0] < 145 and 110 < mid[2] < 145, mid)
        # Radial, Colour to transparent.
        pg.keyboard.press("Control+z")
        pg.evaluate(f"() => {{ Object.assign({ed}.opts.gradient, {{ type: 'radial', preset: 'fg-clear' }}); }}")
        pg.mouse.move(*at(100, 60)); pg.mouse.down(); pg.mouse.move(*at(140, 60), steps=4); pg.mouse.up()
        self.assertGreater(px(100, 60)[3], 230)
        self.assertEqual(px(100, 110)[3], 0)
        self.assertEqual(px(100, 80)[:3], [255, 0, 0])
        # U: shapes. A rectangle on a new layer, filled with the colour; Shift+U: the next shape.
        pg.mouse.move(*at(5, 5))
        pg.keyboard.press("u")
        self.assertEqual(pg.evaluate(f"() => [{ed}.tool, {ed}.opts.shape.kind]"), ["shape", "rect"])
        pg.mouse.move(*at(20, 20)); pg.mouse.down(); pg.mouse.move(*at(60, 50), steps=4); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {ed}.active().name"), "Rectangle 1")
        self.assertEqual(px(40, 35), [255, 0, 0, 255])
        self.assertEqual(px(70, 35)[3], 0)
        pg.keyboard.press("Shift+u"); pg.keyboard.press("Shift+u")
        self.assertEqual(pg.evaluate(f"() => {ed}.opts.shape.kind"), "ellipse")
        # Ellipse with Shift: a circle; as a path instead of pixels.
        pg.evaluate(f"() => {{ {ed}.opts.shape.mode = 'path'; }}")
        pg.mouse.move(*at(100, 20)); pg.mouse.down(); pg.keyboard.down("Shift"); pg.mouse.move(*at(140, 30), steps=4); pg.mouse.up(); pg.keyboard.up("Shift")
        p = pg.evaluate(f"() => {{ const P = {ed}.doc.paths.at(-1); const xs = P.pts.map((q) => q.x), ys = P.pts.map((q) => q.y); return [P.name, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; }}")
        self.assertEqual(p[0], "Ellipse 1")
        self.assertAlmostEqual(p[1], p[2], delta=0.01)
        self.assertAlmostEqual(p[1], 40, delta=1)
        # O: dodge lightens a grey layer; Shift+O: burn darkens; again: the sponge takes colour out.
        pg.evaluate(f"""() => {{ const e = {ed}, b = new Uint8ClampedArray(200 * 120 * 4);
            for (let i = 0; i < 200 * 120; i++) b.set(i % 200 < 100 ? [128, 128, 128, 255] : [200, 60, 60, 255], i * 4);
            e.addPixelLayer(b, 200, 120, 'tones'); for (const t of ['dodge', 'burn', 'sponge']) Object.assign(e.opts[t], {{ size: 20, hardness: 100 }}); }}""")
        pg.mouse.move(*at(5, 5))
        pg.keyboard.press("o")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "dodge")
        pg.mouse.move(*at(20, 30)); pg.mouse.down(); pg.mouse.move(*at(40, 30), steps=4); pg.mouse.up()
        self.assertEqual(label(), "Dodge")
        self.assertGreater(px(30, 30)[0], 150)
        self.assertEqual(px(30, 30)[3], 255)
        self.assertEqual(px(30, 60), [128, 128, 128, 255])
        pg.keyboard.press("Shift+o")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "burn")
        pg.mouse.move(*at(20, 60)); pg.mouse.down(); pg.mouse.move(*at(40, 60), steps=4); pg.mouse.up()
        self.assertEqual(label(), "Burn")
        self.assertLess(px(30, 60)[0], 110)
        pg.keyboard.press("Shift+o")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "sponge")
        pg.mouse.move(*at(140, 60)); pg.mouse.down(); pg.mouse.move(*at(160, 60), steps=4); pg.mouse.up()
        self.assertEqual(label(), "Sponge")
        c = px(150, 60)
        self.assertLess(c[0] - c[1], 140 - 30, c)
        # R: smudge drags the grey into the red, one step; undo puts it back.
        pg.keyboard.press("r")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "smudge")
        pg.evaluate(f"() => {{ Object.assign({ed}.opts.smudge, {{ size: 16, hardness: 100, opacity: 90 }}); }}")
        before = px(110, 100)
        pg.mouse.move(*at(92, 100)); pg.mouse.down(); pg.mouse.move(*at(120, 100), steps=14); pg.mouse.up()
        self.assertEqual(label(), "Smudge")
        after = px(110, 100)
        self.assertLess(after[0], before[0] - 20, (before, after))
        self.assertGreater(after[1], before[1] + 20, (before, after))
        pg.keyboard.press("Control+z")
        self.assertEqual(px(110, 100), before)
        # A gradient into a mask: the mask's grey runs from black to white.
        pg.evaluate(f"() => {{ const e = {ed}; e.addMask('all'); e.editMask = true; e.setTool('gradient'); Object.assign(e.opts.gradient, {{ type: 'linear', preset: 'bw' }}); }}")
        pg.mouse.move(*at(0, 10)); pg.mouse.down(); pg.mouse.move(*at(200, 10), steps=4); pg.mouse.up()
        self.assertEqual(label(), "Gradient (mask)")
        m = pg.evaluate(f"() => {{ const e = {ed}, m = e.masks.get(e.active().id); return [m[60 * 200 + 2], m[60 * 200 + 197]]; }}")
        self.assertLess(m[0], 10)
        self.assertGreater(m[1], 245)
        self.assertEqual(self.errors, [])

    def test_layer_style_lock_transparency_and_the_clipboard(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda x, y: (x0 + x * w / 200, y0 + y * h / 120)
        comp = lambda x, y: pg.evaluate(f"() => [...{ed}.comp.slice(({y} * 200 + {x}) * 4, ({y} * 200 + {x}) * 4 + 4)]")
        label = lambda: pg.evaluate(f"() => {ed}.undoStack.at(-1).label")
        pg.evaluate(f"""() => {{ const e = {ed}, b = new Uint8ClampedArray(40 * 30 * 4);
            for (let i = 0; i < 40 * 30; i++) b.set([255, 255, 0, 255], i * 4);
            e.addPixelLayer(b, 40, 30, 'box', 80, 45); }}""")
        under = comp(78, 60)
        # Layer > Stroke: the section in Properties, an edge round the box at once; one undo step.
        pg.evaluate(f"() => {ed}.openStyle('stroke')")
        self.assertEqual(label(), "Layer style")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.effects.querySelector('.paint-style .style-on[data-kind=stroke]:checked')"))
        self.assertEqual(comp(78, 60), [0, 0, 0, 255])
        self.assertEqual(comp(100, 60), [255, 255, 0, 255])
        self.assertTrue(pg.evaluate(f"() => [...{ed}.layerList.querySelectorAll('.paint-row .tag.fx')].length === 1"))
        # A drop shadow switched on by its box; the size slider drags live and keeps one step.
        pg.evaluate(f"() => {{ const c = {ed}.parts.effects.querySelector('.paint-style .style-on[data-kind=shadow]'); c.checked = true; c.dispatchEvent(new Event('change')); }}")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.active().style.shadow"))
        n = pg.evaluate(f"() => {ed}.undoStack.length")
        pg.evaluate(f"""() => {{ const s = [...{ed}.parts.effects.querySelectorAll('.paint-style .paint-field')].find((f) => f.textContent.startsWith('Size'));
            const r = s.querySelector('input[type=range]'); r.value = 5; r.dispatchEvent(new Event('input')); r.value = 6; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }}""")
        self.assertEqual(pg.evaluate(f"() => [{ed}.active().style.stroke.size, {ed}.undoStack.length]"), [6, n + 1])
        self.assertEqual(comp(76, 60), [0, 0, 0, 255])
        # Painting on the styled layer: the edge follows the stroke as it goes.
        pg.evaluate(f"() => {{ const e = {ed}; e.setTool('brush'); e.fg = [0, 0, 255]; Object.assign(e.opts.brush, {{ size: 6, hardness: 100 }}); }}")
        pg.mouse.move(*at(130, 60)); pg.mouse.down(); pg.mouse.move(*at(135, 60), steps=3)
        pg.wait_for_timeout(100)
        self.assertEqual(comp(140, 60)[:3], [0, 0, 0])
        pg.mouse.up()
        # Undo (the stroke, the layer growing for it, the size) takes the size back; Clear the style takes it all.
        for _ in range(3):
            pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(f"() => {ed}.active().style.stroke.size"), 3)
        pg.evaluate(f"() => {ed}.clearStyle({ed}.active())")
        self.assertEqual(comp(78, 60), under)
        # Locked transparency: the brush paints only on the box, the eraser paints the second colour.
        pg.evaluate(f"() => {{ const e = {ed}; e.toggleLockAlpha(); e.bg = [0, 255, 0]; }}")
        self.assertEqual(label(), "Lock transparency")
        self.assertTrue(pg.evaluate(f"() => {ed}.lockAlphaBtn.classList.contains('on')"))
        px = lambda x, y: pg.evaluate(f"() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id), o = (({y} - L.y) * L.w + {x} - L.x) * 4; return {x} >= L.x && {y} >= L.y && {x} < L.x + L.w && {y} < L.y + L.h ? [...b.slice(o, o + 4)] : null; }}")
        pg.mouse.move(*at(70, 50)); pg.mouse.down(); pg.mouse.move(*at(90, 50), steps=6); pg.mouse.up()
        self.assertEqual(px(85, 50), [0, 0, 255, 255])
        self.assertIn(px(75, 50), (None, [0, 0, 0, 0]))
        self.assertEqual(comp(75, 50), comp(75, 52))                     # nothing painted outside the box
        pg.keyboard.press("e")
        pg.mouse.move(*at(100, 70)); pg.mouse.down(); pg.mouse.move(*at(105, 70), steps=3); pg.mouse.up()
        self.assertEqual(px(102, 70), [0, 255, 0, 255])
        # The clipboard: Ctrl+C the selected part, Ctrl+V a new layer of it; Ctrl+Shift+V in place.
        pg.evaluate(f"() => {{ const e = {ed}, m = new Uint8Array(200 * 120); for (let y = 50; y < 60; y++) for (let x = 90; x < 110; x++) m[y * 200 + x] = 255; e.setSelection(m); }}")
        pg.mouse.move(*at(5, 5))
        pg.keyboard.press("Control+c")
        self.assertEqual(pg.evaluate(f"() => [{ed}._clip.w, {ed}._clip.h, {ed}._clip.x, {ed}._clip.y]"), [20, 10, 90, 50])
        nl = pg.evaluate(f"() => {ed}.doc.layers.length")
        pg.keyboard.press("Control+Shift+v")
        pg.wait_for_function(f"() => {ed}.doc.layers.length === {nl + 1}")
        self.assertEqual(pg.evaluate(f"() => {{ const L = {ed}.active(); return [L.name, L.x, L.y, L.w, L.h]; }}"), ["Pasted 1", 90, 50, 20, 10])
        self.assertEqual(label(), "Add layer")
        pg.keyboard.press("Control+v")
        pg.wait_for_function(f"() => {ed}.doc.layers.length === {nl + 2}")
        self.assertEqual(pg.evaluate(f"() => {ed}.active().name"), "Pasted 2")
        # Cut: copied, and cleared from the layer it came from.
        pg.evaluate(f"() => {{ const e = {ed}; e.setActive(e.doc.layers.find((L) => L.name === 'box').id); e.toggleLockAlpha(); }}")
        pg.keyboard.press("Control+x")
        self.assertEqual(px(95, 55)[3], 0)
        self.assertEqual(self.errors, [])

    def test_select_modify_colour_range_guides_rulers_and_snapping(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {ed}.zoomTo(2)")
        g = lambda: pg.evaluate(f"() => {ed}.doc.guides || []")
        scr = lambda x, y: pg.evaluate(f"() => {{ const r = {ed}.wrap.getBoundingClientRect(), v = {ed}.view; return [r.left + v.x + {x} * v.zoom, r.top + v.y + {y} * v.zoom]; }}")
        wrap = pg.evaluate(f"() => {{ const r = {ed}.wrap.getBoundingClientRect(); return [r.left, r.top]; }}")
        # Ctrl+R: the rulers; a drag down from the top one makes a horizontal guide, snapping onto the middle.
        pg.mouse.move(*scr(100, 60))
        pg.keyboard.press("Control+r")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.rulers"))
        x, _ = scr(60, 0)
        pg.mouse.move(x, wrap[1] + 5); pg.mouse.down()
        pg.mouse.move(*scr(60, 30), steps=4)
        pg.mouse.move(*scr(60, 61), steps=2); pg.mouse.up()
        self.assertEqual(g(), [{"axis": "y", "pos": 60}])
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "New guide")
        pg.mouse.move(wrap[0] + 5, scr(0, 60)[1]); pg.mouse.down()
        pg.mouse.move(*scr(40.2, 50), steps=4); pg.mouse.up()
        self.assertEqual(g(), [{"axis": "y", "pos": 60}, {"axis": "x", "pos": 40}])
        # A rectangle selection snaps its corners to the guides.
        pg.evaluate(f"() => {ed}.setTool('marquee')")
        pg.mouse.move(*scr(41.5, 20)); pg.mouse.down()
        pg.mouse.move(*scr(70, 58.7), steps=4); pg.mouse.up()
        sel = pg.evaluate(f"""async () => {{ const D = await import('/extensions/viewer/imageViewer_paintData.js'); return D.maskBBox({ed}.sel, 200, 120); }}""")
        self.assertEqual([sel["x"], sel["y"] + sel["h"]], [40, 60])
        # Select > Expand / Contract / Border: one step each, undone in one.
        n = pg.evaluate(f"() => [...{ed}.sel].filter((v) => v).length")
        pg.evaluate(f"() => {ed}.modifySelection('expand', 3)")
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Expand selection")
        self.assertGreater(pg.evaluate(f"() => [...{ed}.sel].filter((v) => v).length"), n)
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(f"() => [...{ed}.sel].filter((v) => v).length"), n)
        pg.evaluate(f"() => {ed}.modifySelection('border', 4)")
        self.assertEqual(pg.evaluate(f"() => [{ed}.sel[40 * 200 + 55], {ed}.sel[40 * 200 + 40]]"), [0, 255])
        # Colour range: previewed while the dialog is up, Cancel gives the old selection back, OK one step.
        before = pg.evaluate(f"() => [...{ed}.sel]")
        pg.evaluate(f"() => {{ const e = {ed}, i = (10 * 200 + 10) * 4; e.fg = [e.comp[i], e.comp[i + 1], e.comp[i + 2]]; e.colorRangeDialog(); }}")
        pg.wait_for_function(f"() => {ed}.sel && {ed}.sel[10 * 200 + 10] === 255")
        pg.click(".paint-dlg button:has-text('Cancel')")
        self.assertEqual(pg.evaluate(f"() => [...{ed}.sel]"), before)
        k = pg.evaluate(f"() => {ed}.undoStack.length")
        pg.evaluate(f"() => {ed}.colorRangeDialog()")
        pg.click(".paint-dlg button:has-text('OK')")
        self.assertEqual(pg.evaluate(f"() => [{ed}.undoStack.length, {ed}.undoStack.at(-1).label, {ed}.sel[10 * 200 + 10]]"), [k + 1, "Colour range", 255])
        # The Move tool drags a guide; off the canvas it is gone. Snapping off: no pull.
        pg.evaluate(f"() => {ed}.setTool('move')")
        pg.mouse.move(*scr(40, 90)); pg.mouse.down()
        pg.mouse.move(*scr(80, 90), steps=4); pg.mouse.up()
        self.assertEqual(g(), [{"axis": "y", "pos": 60}, {"axis": "x", "pos": 80}])
        pg.mouse.move(*scr(80, 90)); pg.mouse.down()
        pg.mouse.move(*scr(-20, 90), steps=4); pg.mouse.up()
        self.assertEqual(g(), [{"axis": "y", "pos": 60}])
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Delete guide")
        # Moving a layer snaps its edge onto the guide.
        pg.evaluate(f"""() => {{ const e = {ed}, b = new Uint8ClampedArray(20 * 10 * 4).fill(255); e.addPixelLayer(b, 20, 10, 'box', 10, 10); }}""")
        pg.mouse.move(*scr(15, 15)); pg.mouse.down()
        pg.mouse.move(*scr(15, 62.5), steps=5); pg.mouse.up()
        pg.keyboard.press("Enter")
        self.assertEqual(pg.evaluate(f"() => [{ed}.active().x, {ed}.active().y]"), [10, 60])
        pg.keyboard.press("Control+Shift+Semicolon")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.snapOff"))
        # Saved in the .ora and read back.
        pg.evaluate("() => __panel.paintSave(__panel._paintActive())")
        pg.wait_for_function(f"() => !{ed}.isDirty()", timeout=10000)
        doc = self.P.read_ora(pg.evaluate("() => __panel._paintActive().path"))
        self.assertEqual(doc.meta["guides"], [{"axis": "y", "pos": 60}])
        self.assertEqual(self.errors, [])

    def test_liquify_and_smart_filters(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {ed}.zoomTo(2)")
        scr = lambda x, y: pg.evaluate(f"() => {{ const r = {ed}.wrap.getBoundingClientRect(), v = {ed}.view; return [r.left + v.x + {x} * v.zoom, r.top + v.y + {y} * v.zoom]; }}")
        comp = lambda x, y: pg.evaluate(f"() => [...{ed}.comp.slice(({y} * 200 + {x}) * 4, ({y} * 200 + {x}) * 4 + 4)]")
        own = lambda x, y: pg.evaluate(f"() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id), o = (({y} - L.y) * L.w + {x} - L.x) * 4; return [...b.slice(o, o + 4)]; }}")
        n = pg.evaluate(f"() => {ed}.undoStack.length")
        # A smart Gaussian blur from the Filter menu: Properties shows it; the layer keeps its own pixels.
        before = own(100, 60)
        pg.evaluate(f"() => {ed}.addSmartFilter('blur')")
        self.assertEqual(pg.evaluate(f"() => [{ed}.undoStack.length, {ed}.undoStack.at(-1).label]"), [n + 1, "Smart filter"])
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.effects.querySelector('.paint-smart .smart-on:checked')"))
        self.assertTrue(pg.evaluate(f"() => [...{ed}.layerList.querySelectorAll('.paint-row .tag.sf')].length === 1"))
        self.assertEqual(own(100, 60), before)
        # The radius slider drags live and keeps one step.
        pg.evaluate(f"""() => {{ const s = [...{ed}.parts.effects.querySelectorAll('.paint-smart .paint-field')].find((f) => f.textContent.startsWith('Radius'));
            const r = s.querySelector('input[type=range]'); r.value = 8; r.dispatchEvent(new Event('input')); r.value = 9; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }}""")
        self.assertEqual(pg.evaluate(f"() => [{ed}.active().filters[0].params.radius, {ed}.undoStack.length]"), [9, n + 2])
        # An adjustment after it; switched off; moved first; taken away.
        pg.evaluate(f"() => {ed}.addSmartFilter('invert')")
        pg.evaluate(f"() => {ed}.requestRedraw(null)"); pg.wait_for_timeout(50)
        inv = comp(100, 60)
        pg.evaluate(f"() => {{ const c = {ed}.parts.effects.querySelectorAll('.paint-smart .smart-on')[1]; c.checked = false; c.dispatchEvent(new Event('change')); }}")
        pg.wait_for_timeout(50)
        self.assertNotEqual(comp(100, 60), inv)
        pg.evaluate(f"() => {ed}.setSmartFilter({ed}.active(), 1, {{ move: -1 }})")
        self.assertEqual(pg.evaluate(f"() => {ed}.active().filters.map((f) => f.type)"), ["invert", "blur"])
        pg.evaluate(f"() => {ed}.setSmartFilter({ed}.active(), 0, null)")
        self.assertEqual(pg.evaluate(f"() => {ed}.active().filters.map((f) => f.type)"), ["blur"])
        # Saved in the .ora and read back.
        pg.evaluate("() => __panel.paintSave(__panel._paintActive())")
        pg.wait_for_function(f"() => !{ed}.isDirty()", timeout=10000)
        doc = self.P.read_ora(pg.evaluate("() => __panel._paintActive().path"))
        self.assertEqual([f["type"] for f in doc.layers[0]["filters"]], ["blur"])
        pg.evaluate(f"() => {ed}.clearSmartFilters({ed}.active())")
        # Liquify (Shift+Ctrl+X): a drag pushes the pixels; Esc throws it away, Enter keeps it as one step.
        pg.evaluate(f"""() => {{ const e = {ed}, b = new Uint8ClampedArray(200 * 120 * 4);
            for (let y = 0; y < 120; y++) for (let x = 98; x < 103; x++) b.set([255, 0, 0, 255], (y * 200 + x) * 4);
            e.addPixelLayer(b, 200, 120, 'bar', 0, 0); Object.assign(e.opts.liquify, {{ mode: 'push', size: 40, strength: 100 }}); }}""")
        start = own(110, 60)
        src = own(100, 60)
        pg.mouse.move(*scr(100, 60))
        pg.keyboard.press("Control+Shift+x")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "liquify")
        pg.mouse.down(); pg.mouse.move(*scr(110, 60), steps=10); pg.mouse.up()
        self.assertTrue(pg.evaluate(f"() => !!{ed}.lq"))
        moved = own(110, 60)
        self.assertNotEqual(moved, start)
        self.assertLess(sum(abs(a - b) for a, b in zip(moved, src)), sum(abs(a - b) for a, b in zip(start, src)))
        k = pg.evaluate(f"() => {ed}.undoStack.length")
        pg.keyboard.press("Escape")
        self.assertEqual(own(110, 60), start)
        self.assertEqual(pg.evaluate(f"() => [!!{ed}.lq, {ed}.undoStack.length]"), [False, k])
        pg.mouse.move(*scr(100, 60)); pg.mouse.down(); pg.mouse.move(*scr(110, 60), steps=10); pg.mouse.up()
        pg.mouse.move(*scr(60, 30)); pg.mouse.down(); pg.mouse.move(*scr(60, 40), steps=5); pg.mouse.up()
        pg.keyboard.press("Enter")
        self.assertEqual(pg.evaluate(f"() => [!!{ed}.lq, {ed}.undoStack.length, {ed}.undoStack.at(-1).label]"), [False, k + 1, "Liquify"])
        self.assertEqual(own(110, 60), moved)
        pg.keyboard.press("Control+z")
        self.assertEqual(own(110, 60), start)
        self.assertEqual(self.errors, [])

    def test_big_picture_previews_while_dragging_and_draws_in_full_when_let_go(self):
        pg = self.page()
        pg.evaluate("() => __panel.paintNewBlank({ w: 4000, h: 3000, fill: 'white' })")
        pg.wait_for_function("() => { const r = __panel._paintActive(); return r && r.editor && r.editor.doc && r.editor.doc.w === 4000; }", timeout=15000)
        ed = self.ED
        pg.evaluate(f"() => {ed}.fit()")
        self.assertGreater(pg.evaluate(f"() => {ed}._previewK()"), 1)
        scr = lambda x, y: pg.evaluate(f"() => {{ const r = {ed}.wrap.getBoundingClientRect(), v = {ed}.view; return [r.left + v.x + {x} * v.zoom, r.top + v.y + {y} * v.zoom]; }}")
        comp = lambda x, y: pg.evaluate(f"() => [...{ed}.comp.slice(({y} * 4000 + {x}) * 4, ({y} * 4000 + {x}) * 4 + 4)]")
        # The preview canvas's pixel at picture (x, y).
        prev = lambda x, y: pg.evaluate(f"""() => {{ const e = {ed}, c = e._pvCanvas, k = c.width / e.doc.w;
            return [...c.getContext('2d').getImageData(Math.floor({x} * k), Math.floor({y} * k), 1, 1).data]; }}""")
        shown = lambda: pg.evaluate(f"() => !!{ed}._pvShown && {ed}._pvCanvas.style.display === 'block'")
        # A red square on a layer of its own.
        pg.evaluate(f"""() => {{ const e = {ed}, b = new Uint8ClampedArray(1000 * 1000 * 4);
            for (let i = 0; i < 1000 * 1000; i++) b.set([255, 0, 0, 255], i * 4);
            e.addPixelLayer(b, 1000, 1000, 'sq', 1000, 1000); }}""")
        pg.wait_for_timeout(100)
        n = pg.evaluate(f"() => {ed}.undoStack.length")
        # The move tool: while dragged the preview follows the pointer, the canvas is not laid again.
        pg.evaluate(f"() => {ed}.setTool('move')")
        pg.mouse.move(*scr(1500, 1500)); pg.mouse.down()
        pg.mouse.move(*scr(1800, 1500), steps=4); pg.mouse.move(*scr(2000, 1500), steps=2)
        pg.wait_for_timeout(120)
        self.assertTrue(shown())
        self.assertEqual(prev(2400, 1500)[:3], [255, 0, 0])
        self.assertEqual(prev(1200, 1500)[:3], [255, 255, 255])
        self.assertEqual(comp(1200, 1500)[:3], [255, 0, 0])        # the full canvas is not drawn while dragging
        pg.mouse.up()
        pg.wait_for_function(f"() => !{ed}._pvShown", timeout=5000)
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate(f"() => [{ed}.active().x, {ed}.undoStack.length, {ed}.undoStack.at(-1).label]"), [1500, n + 1, "Move"])
        self.assertEqual(comp(2400, 1500)[:3], [255, 0, 0])
        self.assertEqual(comp(1200, 1500)[:3], [255, 255, 255])
        # The free transform: the preview turns, the layer is resampled once, when let go.
        pg.keyboard.press("Control+t")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.tf"))
        pg.mouse.move(*scr(2700, 900)); pg.mouse.down()
        pg.mouse.move(*scr(3200, 1500), steps=5)
        pg.wait_for_timeout(120)
        self.assertTrue(shown())
        self.assertEqual(pg.evaluate(f"() => [{ed}.active().w, {ed}.tf.smooth]"), [1000, False])   # not resampled yet
        pg.mouse.up()
        pg.wait_for_function(f"() => !{ed}._pvShown", timeout=5000)
        self.assertGreater(pg.evaluate(f"() => {ed}.active().w"), 1100)
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Transform")
        # The gradient: seen while dragged (nothing was drawn until let go), applied in full when let go.
        pg.evaluate(f"""() => {{ const e = {ed}; e.addPixelLayer(new Uint8ClampedArray(4000 * 3000 * 4), 4000, 3000, 'g');
            e.fg = [0, 255, 0]; e.bg = [0, 0, 255]; e.setTool('gradient'); }}""")
        pg.wait_for_timeout(100)
        pg.mouse.move(*scr(500, 2500)); pg.mouse.down(); pg.mouse.move(*scr(3500, 2500), steps=5)
        pg.wait_for_timeout(120)
        self.assertTrue(shown())
        self.assertEqual(prev(100, 2500)[:3], [0, 255, 0])
        self.assertEqual(prev(3900, 2500)[:3], [0, 0, 255])
        self.assertEqual(comp(100, 2500)[:3], [255, 255, 255])
        pg.mouse.up()
        pg.wait_for_function(f"() => !{ed}._pvShown", timeout=8000)
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Gradient")
        self.assertEqual(comp(100, 2500)[:3], [0, 255, 0])
        self.assertEqual(comp(3900, 2500)[:3], [0, 0, 255])
        # A slider (the layer's opacity): the preview while it moves, the full picture once it rests.
        pg.evaluate(f"() => {{ const e = {ed}; e.liveBegin(); e.active().opacity = 0.5; e.requestRedraw(); }}")
        pg.wait_for_timeout(80)
        self.assertTrue(shown())
        g = prev(100, 2500)
        self.assertTrue(120 < g[0] < 135 and g[1] == 255, g)
        pg.wait_for_function(f"() => !{ed}._pvShown", timeout=5000)
        self.assertTrue(120 < comp(100, 2500)[0] < 135)
        pg.evaluate(f"() => {ed}.liveEnd('Opacity')")
        # A stroke keeps what is under its layer; the next stroke on it takes it again without laying it.
        pg.evaluate(f"() => {{ const e = {ed}; e.setTool('brush'); Object.assign(e.opts.brush, {{ size: 40, hardness: 100 }}); }}")
        for y in (500, 700):
            pg.mouse.move(*scr(500, y)); pg.mouse.down(); pg.mouse.move(*scr(900, y), steps=3); pg.mouse.up()
            pg.wait_for_timeout(60)
            if y == 500:
                first = pg.evaluate(f"() => {{ window.__below = {ed}._belowKept.below; return !!window.__below; }}")
        self.assertTrue(first)
        self.assertTrue(pg.evaluate(f"() => {ed}._belowKept.below === window.__below"))
        self.assertEqual(self.errors, [])

    def test_filter_dialog_adjustment_and_smart_filter_sliders_preview_while_dragged(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        comp = lambda: pg.evaluate(f"() => {{ const e = {ed}, o = (60 * e.doc.w + 100) * 4; return [...e.comp.slice(o, o + 3)]; }}")

        def drag(handle, steps=5):
            # Pressed on the slider's middle and moved right; what the picture shows is read before it is let go.
            el = handle.as_element()
            el.scroll_into_view_if_needed()
            b = el.bounding_box()
            x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
            pg.mouse.move(x, y); pg.mouse.down()
            seen = []
            for k in range(1, steps + 1):
                pg.mouse.move(x + k * b["width"] / 12, y)
                pg.wait_for_timeout(60)
                seen.append(comp())
            return seen

        # The Filter menu's dialogs have a slider by each number now; its preview follows the drag.
        start = comp()
        brighter = "(px, w, h, v) => { const o = new Uint8ClampedArray(px); for (let i = 0; i < o.length; i += 4) { o[i] += v.b; o[i + 1] += v.b; o[i + 2] += v.b; } return o; }"
        pg.evaluate(f"() => {ed}.filterDialog('Brighter', [['b', 'Brighter', 0, -100, 100]], {brighter})")
        rng = pg.evaluate_handle(f"() => {ed}.box.querySelector('.paint-dlg .paint-dlg-range')")
        self.assertTrue(pg.evaluate("(r) => !!r", rng))
        seen = drag(rng)
        self.assertNotEqual(seen[1], start, "the preview changes while the slider is still held")
        self.assertNotEqual(seen[-1], seen[1], "and goes on following it")
        self.assertEqual(pg.evaluate(f"() => {ed}.box.querySelector('.paint-dlg input[type=number]').value"),
                         pg.evaluate(f"() => {ed}.box.querySelector('.paint-dlg .paint-dlg-range').value"))
        pg.mouse.up()
        pg.click(".paint-dlg .go .paint-btn:text-is('Cancel')")
        pg.wait_for_timeout(50)
        self.assertEqual(comp(), start, "Cancel puts it back")
        # An adjustment layer's slider in Properties: live too.
        pg.evaluate(f"() => {ed}.addAdjustment('brightness_contrast')")
        pg.wait_for_timeout(100)
        sl = pg.evaluate_handle(f"() => [...{ed}.parts.props.querySelectorAll('.paint-sect')].find((x) => /Brightness/i.test(x.querySelector('h4')?.textContent || '')).querySelector('input[type=range]')")
        seen = drag(sl)
        self.assertNotEqual(seen[1], start)
        self.assertNotEqual(seen[-1], seen[1])
        pg.mouse.up()
        pg.keyboard.press("Control+z"); pg.keyboard.press("Control+z")
        pg.wait_for_timeout(50)
        # A smart filter's slider: live too.
        pg.evaluate(f"() => {{ const e = {ed}; e.setActive(e.doc.layers[0].id); e.addSmartFilter('brightness_contrast'); }}")
        pg.wait_for_timeout(100)
        start = comp()
        sl = pg.evaluate_handle(f"() => {ed}.parts.effects.querySelector('.paint-smart input[type=range]')")
        seen = drag(sl)
        self.assertNotEqual(seen[1], start)
        self.assertNotEqual(seen[-1], seen[1])
        pg.mouse.up()
        self.assertEqual(self.errors, [])

    def test_path_tools_flyout_path_and_direct_selection_add_delete_convert(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        # Picture pixels to the screen, as the editor itself turns them back (read each time: the options bar's height follows the tool).
        at = lambda x, y: tuple(pg.evaluate(f"() => {{ const e = {ed}, r = e.wrap.getBoundingClientRect(); return [r.left + e.view.x + {x} * e.view.zoom, r.top + e.view.y + {y} * e.view.zoom]; }}"))
        sq = "[[40, 30], [160, 30], [160, 90], [40, 90]].map(([x, y]) => ({ x, y, ix: x, iy: y, ox: x, oy: y, smooth: false }))"
        pg.evaluate(f"() => {{ const e = {ed}; e.change('Path', () => {{ e.doc.paths = [{{ id: 'p1', name: 'Path 1', closed: true, pts: {sq} }}]; }}); e.selectPath(null); }}")
        pts = lambda: pg.evaluate(f"() => {ed}.curPath().pts.map((a) => [Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10])")
        last = lambda: pg.evaluate(f"() => {ed}.undoStack.at(-1).label")
        # One place in the toolbar; a right-click opens the six tools as icons, a click picks one and shows it there.
        slot = ".paint-tools [data-group=pen]"
        self.assertEqual(pg.locator(".paint-tools [data-group]").count(), 5)   # transform, select, paint, pen, shape
        pg.click(slot, button="right")
        self.assertEqual(pg.evaluate(f"() => [...{ed}.box.querySelectorAll('.paint-flyout .paint-btn')].map((b) => b.dataset.tool)"),
                         ["pen", "penadd", "pendel", "penconv", "pathsel", "pathdirect"])
        self.assertTrue(pg.evaluate(f"() => [...{ed}.box.querySelectorAll('.paint-flyout svg')].length === 6"))
        pg.click(".paint-flyout [data-tool=pathsel]")
        self.assertEqual(pg.evaluate(f"() => [{ed}.tool, !!{ed}.box.querySelector('.paint-flyout'), {ed}.box.querySelector('{slot}').dataset.tool]"),
                         ["pathsel", False, "pathsel"])
        self.assertTrue(pg.evaluate(f"() => {ed}.box.querySelector('{slot}').classList.contains('on')"))
        # A click elsewhere puts the flyout away without picking anything.
        pg.click(slot, button="right")
        pg.mouse.click(*at(5, 115))
        self.assertEqual(pg.evaluate(f"() => [{ed}.tool, !!{ed}.box.querySelector('.paint-flyout')]"), ["pathsel", False])
        # Path selection: a drag on the curve moves the whole path, Alt+drag a copy, the arrows nudge it.
        pg.mouse.move(*at(100, 30)); pg.mouse.down(); pg.mouse.move(*at(110, 40), steps=5); pg.mouse.up()
        self.assertEqual(pts(), [[50, 40], [170, 40], [170, 100], [50, 100]])
        self.assertEqual(last(), "Move path")
        pg.keyboard.down("Alt"); pg.mouse.move(*at(110, 40)); pg.mouse.down(); pg.mouse.move(*at(100, 30), steps=5); pg.mouse.up(); pg.keyboard.up("Alt")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.paths.map((q) => q.name)"), ["Path 1", "Path 1 copy"])
        self.assertEqual(pts(), [[40, 30], [160, 30], [160, 90], [40, 90]])
        self.assertEqual(last(), "Duplicate path")
        pg.keyboard.press("ArrowRight"); pg.keyboard.press("Shift+ArrowDown")
        self.assertEqual(pts()[0], [41, 40])
        self.assertEqual(last(), "Nudge path")
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.paths.map((q) => q.name)"), ["Path 1"])
        # Direct selection (Shift+A): a box picks two anchors, a drag moves both, Shift+click one more, Del takes them away.
        pg.keyboard.press("Shift+a")
        self.assertEqual(pg.evaluate(f"() => {ed}.tool"), "pathdirect")
        pg.mouse.move(*at(150, 30)); pg.mouse.down(); pg.mouse.move(*at(185, 110), steps=6); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => [{ed}.curPath().id, [...{ed}._pathPicked()].sort()]"), ["p1", [1, 2]])
        pg.mouse.move(*at(170, 40)); pg.mouse.down(); pg.mouse.move(*at(160, 40), steps=4); pg.mouse.up()
        self.assertEqual(pts(), [[50, 40], [160, 40], [160, 100], [50, 100]])
        self.assertEqual(last(), "Move anchors")
        pg.keyboard.press("ArrowUp")
        self.assertEqual(pts(), [[50, 40], [160, 39], [160, 99], [50, 100]])
        self.assertEqual(last(), "Nudge anchors")
        pg.keyboard.down("Shift"); pg.mouse.click(*at(50, 100)); pg.keyboard.up("Shift")
        self.assertEqual(sorted(pg.evaluate(f"() => [...{ed}._pathPicked()]")), [1, 2, 3])
        pg.keyboard.press("Delete")
        self.assertEqual(pts(), [[50, 40]])
        self.assertEqual(last(), "Delete anchors")
        pg.keyboard.press("Control+z")
        self.assertEqual(len(pts()), 4)
        # A plain click on an anchor picks it alone; a click on nothing lets the path go.
        pg.mouse.click(*at(50, 40))
        self.assertEqual(pg.evaluate(f"() => [...{ed}._pathPicked()]"), [0])
        pg.mouse.click(*at(5, 5))
        self.assertIsNone(pg.evaluate(f"() => {ed}.pathId"))
        # Add anchor: a click on the curve; Delete anchor: a click on it; Convert point: a drag from a corner makes it smooth.
        pg.click(slot, button="right"); pg.click(".paint-flyout [data-tool=penadd]")
        pg.mouse.click(*at(105, 100))
        self.assertEqual(len(pts()), 5)
        self.assertEqual(last(), "Add anchor")
        pg.click(slot, button="right"); pg.click(".paint-flyout [data-tool=pendel]")
        pg.mouse.click(*at(105, 100))
        self.assertEqual(len(pts()), 4)
        self.assertEqual(last(), "Delete anchor")
        pg.click(slot, button="right"); pg.click(".paint-flyout [data-tool=penconv]")
        pg.mouse.move(*at(50, 40)); pg.mouse.down(); pg.mouse.move(*at(60, 30), steps=4); pg.mouse.up()
        a = pg.evaluate(f"() => {ed}.curPath().pts[0]")
        self.assertTrue(a["smooth"])
        self.assertAlmostEqual(a["ix"], 40, delta=1)
        self.assertEqual(last(), "Smooth anchor")
        pg.mouse.click(*at(50, 40))
        self.assertFalse(pg.evaluate(f"() => {ed}.curPath().pts[0].smooth"))
        self.assertEqual(last(), "Corner anchor")
        # Shift+P goes round the pen's four; the toolbar's place follows.
        pg.keyboard.press("p")
        seen = []
        for _ in range(4):
            pg.keyboard.press("Shift+p")
            seen.append(pg.evaluate(f"() => [{ed}.tool, {ed}.box.querySelector('{slot}').dataset.tool]"))
        self.assertEqual(seen, [["penadd", "penadd"], ["pendel", "pendel"], ["penconv", "penconv"], ["pen", "pen"]])
        self.assertEqual(self.errors, [])

    def _choose(self, action, choice):
        mod = sys.modules[self.pkg + ".paint_generate"]
        mod.set_choice(action, choice)

    def test_generate_runs_its_workflow_and_the_result_is_a_new_layer(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        out_dir = os.path.join(self.dirs["output"], "paint", "generate")
        os.makedirs(out_dir, exist_ok=True)
        # The built-in FLUX Fill needs models this server does not have: a notice names them, nothing is queued.
        pg.evaluate("""() => { window.__queued = []; window.__notes = [];
            __api.queuePrompt = async (n, d) => { window.__queued.push(d.output); return { prompt_id: 'p' + window.__queued.length }; }; }""")
        pg.evaluate(f"() => {{ const e = {ed}; const m = new Uint8Array(200*120); for (let y = 20; y < 100; y++) for (let x = 40; x < 160; x++) m[y*200+x] = 255; e.setSelection(m); }}")
        pg.evaluate("""async () => { const { app } = await import('/scripts/app.js'); window.__toasts = [];
            app.extensionManager.toast.add = (t) => window.__toasts.push(t.summary + ' -- ' + t.detail); }""")
        pg.evaluate("() => __panel.paintGenerate(__panel._paintActive(), 'fill', { prompt: 'a green box' })")
        pg.wait_for_function("() => window.__toasts.some((t) => /needs what is not here/.test(t))", timeout=10000)
        self.assertTrue(pg.evaluate("() => window.__toasts.some((t) => /flux1-fill-dev/.test(t))"))
        self.assertEqual(pg.evaluate("() => window.__queued.length"), 0)
        # A workflow of one's own (API format, as Settings takes it): Load Image -> Save Image.
        graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}, "_meta": {"title": "paint:image"}},
                 "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["9", 0]}, "_meta": {"title": "paint:prompt"}},
                 "3": {"class_type": "KSampler", "inputs": {"seed": 1, "positive": ["2", 0]}},
                 "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "x"}, "_meta": {"title": "paint:output"}}}
        got = pg.evaluate("""async (g) => { const r = await fetch('/imageviewer/paint/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'fill', graph: g, name: 'mine', source: 'file' }) }); __panel._paintWf = null; return r.json(); }""", graph)
        self.addCleanup(lambda: self._choose("fill", "flux_fill"))
        self.assertEqual(got["actions"]["fill"]["choice"], "custom")
        self.assertEqual(got["slots"]["image"], "1")
        pg.evaluate("() => { window.__gen = __panel.paintGenerate(__panel._paintActive(), 'fill', { prompt: 'a green box', variations: 2 }); }")
        pg.wait_for_function("() => window.__queued.length === 2", timeout=10000)
        queued = pg.evaluate("() => window.__queued")
        self.assertEqual(queued[0]["2"]["inputs"]["text"], "a green box")
        self.assertNotEqual(queued[0]["3"]["inputs"]["seed"], queued[1]["3"]["inputs"]["seed"])
        inp = queued[0]["1"]["inputs"]["image"]
        self.assertTrue(inp.startswith("paint/gen_"), inp)
        from PIL import Image
        crop = Image.open(os.path.join(self.dirs["input"], inp))
        # ComfyUI would run it: a green picture of the crop's size, announced as ComfyUI does.
        for i, pid in enumerate(("p1", "p2")):
            g = np.zeros((crop.height, crop.width, 4), np.uint8)
            g[..., 1] = 200 + i * 20
            g[..., 3] = 255
            Image.fromarray(g, "RGBA").save(os.path.join(out_dir, f"fill_{i}.png"))
            pg.evaluate("""([pid, f]) => __api.dispatch('executed', { prompt_id: pid, node: '4',
                output: { images: [{ filename: f, subfolder: 'paint/generate', type: 'output' }] } })""", [pid, f"fill_{i}.png"])
        pg.wait_for_function(f"() => {ed}.doc.layers.length === 3", timeout=10000)
        names = pg.evaluate(f"() => {ed}.doc.layers.map((L) => L.name)")
        self.assertIn("a green box", names)
        self.assertIn("a green box 2", names)
        self.assertTrue(pg.evaluate(f"() => {ed}.undoStack[{ed}.undoStack.length-1].label.startsWith('Generative fill')"))
        # One undo takes both layers away.
        pg.evaluate(f"() => {ed}.undo()")
        self.assertEqual(pg.evaluate(f"() => {ed}.doc.layers.length"), 1)
        pg.evaluate(f"() => {ed}.redo()")
        # The new layer is masked to the selection: inside green, outside the photo.
        top = pg.evaluate(f"""() => {{ const e = {ed}; return e.doc.layers.filter((L) => L.name === 'a green box 2').map((L) => [L.x, L.y, !!L.mask])[0]; }}""")
        self.assertTrue(top[2], top)
        self.assertEqual(self.errors, [])

    def test_generate_says_at_once_that_it_runs_and_shows_how_far_it_is(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        out_dir = os.path.join(self.dirs["output"], "paint", "generate")
        os.makedirs(out_dir, exist_ok=True)
        pg.evaluate("""() => { window.__queued = []; window.__posted = [];
            __api.queuePrompt = async (n, d) => { window.__queued.push(d.output); return { prompt_id: 'q' + window.__queued.length }; };
            const f = window.__fetchApi; window.__fetchApi = async (p, o) => { if (p === '/queue' || p === '/interrupt') window.__posted.push([p, o && o.body]); return f(p, o); }; }""")
        pg.evaluate(f"() => {{ const e = {ed}; const m = new Uint8Array(200*120); for (let y = 20; y < 100; y++) for (let x = 40; x < 160; x++) m[y*200+x] = 255; e.setSelection(m); }}")
        graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}, "_meta": {"title": "paint:image"}},
                 "2": {"class_type": "CLIPTextEncode", "inputs": {"text": ""}, "_meta": {"title": "paint:prompt"}},
                 "3": {"class_type": "KSampler", "inputs": {"seed": 1, "positive": ["2", 0]}},
                 "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "x"}, "_meta": {"title": "paint:output"}}}
        pg.evaluate("""async (g) => { await fetch('/imageviewer/paint/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'fill', graph: g, name: 'mine', source: 'file' }) }); __panel._paintWf = null; await __panel._paintWorkflows(true); }""", graph)
        self.addCleanup(lambda: self._choose("fill", "flux_fill"))
        # The Generate panel's own button: busy at once, and the bar up.
        pg.evaluate(f"() => {{ const e = {ed}; e._prompt = 'a green box'; e.parts.generate.querySelector('[data-gen=fill]').click(); }}")
        btn = f"{ed}.parts.generate.querySelector('[data-gen=fill]')"
        bar = f"{ed}._genEl"
        self.assertTrue(pg.evaluate(f"() => {btn}.classList.contains('busy')"))
        self.assertTrue(pg.evaluate(f"() => {bar}.bar.classList.contains('on')"))
        pg.wait_for_function(f"() => /queue/.test({bar}.text.textContent)", timeout=10000)
        self.assertIn("mine", pg.evaluate(f"() => {bar}.what.textContent"))
        # ComfyUI starts it: the node's name and the sampler's steps, the bar filling.
        pg.evaluate("""() => { __api.dispatch('execution_start', { prompt_id: 'q1' }); __api.dispatch('executing', { prompt_id: 'q1', node: '3' });
            __api.dispatch('progress', { prompt_id: 'q1', node: '3', value: 5, max: 20 }); }""")
        self.assertEqual(pg.evaluate(f"() => {bar}.text.textContent"), "KSampler 5 / 20")
        self.assertEqual(pg.evaluate(f"() => {bar}.fill.style.width"), "25%")
        # Stop: interrupted (it had started), the bar says so, the button is free again.
        pg.evaluate(f"() => {bar}.stop.click()")
        pg.wait_for_function(f"() => {bar}.bar.dataset.state === 'failed'", timeout=10000)
        self.assertEqual(pg.evaluate(f"() => {bar}.text.textContent"), "Stopped")
        self.assertEqual([p for p, _ in pg.evaluate("() => window.__posted")], ["/queue", "/interrupt"])
        self.assertFalse(pg.evaluate(f"() => {btn}.classList.contains('busy')"))
        # A second run that comes back: "Done", a new layer.
        pg.evaluate(f"() => {ed}.parts.generate.querySelector('[data-gen=fill]').click()")
        pg.wait_for_function("() => window.__queued.length === 2", timeout=10000)
        from PIL import Image
        crop = Image.open(os.path.join(self.dirs["input"], pg.evaluate("() => window.__queued[1]['1'].inputs.image")))
        g = np.zeros((crop.height, crop.width, 4), np.uint8)
        g[..., 1] = 200
        g[..., 3] = 255
        Image.fromarray(g, "RGBA").save(os.path.join(out_dir, "status_0.png"))
        pg.evaluate("""() => __api.dispatch('executed', { prompt_id: 'q2', node: '4',
            output: { images: [{ filename: 'status_0.png', subfolder: 'paint/generate', type: 'output' }] } })""")
        pg.wait_for_function(f"() => {bar}.bar.dataset.state === 'done'", timeout=10000)
        self.assertEqual(pg.evaluate(f"() => {bar}.text.textContent"), "Done: a new layer")
        self.assertEqual(self.errors, [])

    def test_settings_page_replaces_a_generate_workflow(self):
        pg = self.page()
        # The settings entry's editor (what ComfyUI's dialog renders); "Load API file…" takes an API-format file.
        pg.evaluate("""async () => { const S = await import('/extensions/viewer/imageViewer_settings.js');
            document.querySelectorAll('comfyui-image-viewer-panel').forEach((p) => { p.style.display = 'none'; });
            const el = S.renderPaintWorkflowEditor(); el.id = 'pwf'; document.body.prepend(el); }""")
        pg.wait_for_function("() => document.querySelectorAll('#pwf .imageviewer-pwf-row').length === 7", timeout=10000)
        pg.wait_for_function("() => /Not on this machine/.test(document.querySelector('#pwf').textContent)", timeout=5000)
        graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
                 "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "x"}}}
        path = os.path.join(self.tmp, "my_upscale.json")
        with open(path, "w") as fh:
            json.dump(graph, fh)
        rows = pg.locator("#pwf .imageviewer-pwf-row")
        upscale = rows.filter(has_text="Upscale")
        with pg.expect_file_chooser() as fc:
            upscale.get_by_text("Load API file…").click()
        fc.value.set_files(path)
        pg.wait_for_function("() => /My workflow: my_upscale/.test(document.querySelector('#pwf').textContent)", timeout=10000)
        self.addCleanup(lambda: self._choose("upscale", "upscale_model"))
        self.assertEqual(pg.evaluate("() => [...document.querySelectorAll('#pwf select')].map((s) => s.value)").count("custom"), 1)
        self.assertIn("picture in: node 1", pg.locator("#pwf").inner_text())
        # Remove mine: back to the default.
        rows.filter(has_text="Upscale").get_by_text("Remove mine").click()
        pg.wait_for_function("() => !/My workflow: my_upscale/.test(document.querySelector('#pwf').textContent)", timeout=10000)
        self.assertEqual(self.errors, [])


    def test_properties_tool_options_effects_and_generate_are_panels_of_their_own(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        ids = ["paintLayers", "paintProps", "paintTool", "paintEffects", "paintGenerate", "paintHistory"]
        # All up with the Paint tab; Properties, Tool options, Effects and Generate share one place, Properties in front.
        self.assertEqual(pg.evaluate("(ids) => ids.map((i) => __panel.isPanelDocked(i))", ids), [True] * 6)
        self.assertEqual(pg.evaluate("(ids) => ids.map((i) => __panel.isPanelFront(i))", ids), [True, True, False, False, False, True])
        # Each holds its part: the layer in Properties, the tool in Tool options, Generate's buttons in Generate.
        self.assertTrue(pg.evaluate(f"() => {ed}.parts.props.textContent.includes('200')"))
        self.assertFalse(pg.evaluate(f"() => !!{ed}.parts.props.querySelector('[data-gen]')"))
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.generate.querySelector('[data-gen=fill]')"))
        self.assertTrue(pg.evaluate(f"() => {ed}.parts.tool.querySelector('h4').textContent.length > 0"))
        self.assertTrue(pg.evaluate(f"() => __panel._dockPanelEl('paintTool').contains({ed}.parts.tool)"))
        # The prompt being typed survives a redraw of the other panels.
        pg.evaluate(f"() => {{ const t = {ed}.parts.generate.querySelector('textarea'); t.value = 'a cat'; t.dispatchEvent(new Event('input')); {ed}.refreshProps(); }}")
        self.assertEqual(pg.evaluate(f"() => {ed}.parts.generate.querySelector('textarea').value"), "a cat")
        # Layer > Layer style brings Effects to the front with the style in it.
        pg.evaluate(f"() => {ed}.openStyle('stroke')")
        self.assertTrue(pg.evaluate("() => __panel.isPanelFront('paintEffects') && !__panel.isPanelFront('paintProps')"))
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.effects.querySelector('.paint-style .style-on[data-kind=stroke]:checked')"))
        # Shift+F5 brings Properties back with Fill.
        pg.evaluate(f"() => {ed}.openFill()")
        self.assertTrue(pg.evaluate("() => __panel.isPanelFront('paintProps')"))
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.props.querySelector('.paint-fill')"))
        pg.evaluate(f"() => {ed}.closeFill()")
        # Which one is in front survives leaving the tab and coming back.
        pg.evaluate("() => __panel.paintShowPanel('generate')")
        pg.evaluate("() => __panel.paintTabLeave()")
        self.assertFalse(pg.evaluate("() => __panel.isPanelDocked('paintGenerate')"))
        pg.evaluate("() => __panel.paintTabEnter(__panel.activeTab)")
        pg.wait_for_timeout(50)
        self.assertTrue(pg.evaluate("() => __panel.isPanelFront('paintGenerate')"))
        # A layout saved before these panels existed gets them as tabs behind Properties, not as three more panels.
        got = pg.evaluate("""() => { const p = __panel;
            p.applyDockData({ right: { width: 300, panels: [{ id: 'paintLayers', size: 2 }, { id: 'paintProps', size: 2 }, { id: 'paintHistory', size: 1 }] } });
            return p.dockLayout.right.panels.filter((e) => e.id.startsWith('paint')).map((e) => [e.id, !!e.tab, !!e.behind]); }""")
        self.assertEqual(got, [["paintLayers", False, False], ["paintProps", True, False], ["paintTool", True, True],
                               ["paintEffects", True, True], ["paintGenerate", True, True], ["paintHistory", False, False]])
        self.assertEqual(self.errors, [])

    def test_solo_and_dragging_layers_onto_duplicate_and_delete(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {{ const e = {ed}; e.newLayer('A'); e.newLayer('B'); e.setLayerProps(e.doc.layers[2].id, {{ visible: false }}, 'Hide'); }}")
        vis = lambda: pg.evaluate(f"() => {ed}.doc.layers.map((l) => l.name + ':' + (l.visible ? 1 : 0))")
        self.assertEqual(vis(), ["Background:1", "A:1", "B:0"])

        def rowsel(name):
            return f"[...{ed}.layerList.querySelectorAll('.paint-row')].find((x) => x.querySelector('.nm').textContent === '{name}')"
        # Alt+click A's eye: only A seen; the eye is lit. Again: as it was (B still hidden).
        pg.evaluate(f"() => {{ const r = {rowsel('A')}; r.querySelector('.eye').dispatchEvent(new MouseEvent('click', {{ bubbles: true, altKey: true }})); }}")
        self.assertEqual(vis(), ["Background:0", "A:1", "B:0"])
        self.assertTrue(pg.evaluate(f"() => {rowsel('A')}.querySelector('.eye').classList.contains('solo')"))
        pg.evaluate(f"() => {{ const r = {rowsel('A')}; r.querySelector('.eye').dispatchEvent(new MouseEvent('click', {{ bubbles: true, altKey: true }})); }}")
        self.assertEqual(vis(), ["Background:1", "A:1", "B:0"])
        # From the menu: Solo, then End solo.
        pg.evaluate(f"() => {{ const e = {ed}; e.setActive(e.doc.layers[0].id); e._layerMenu().find((x) => x.label && x.label.startsWith('Solo')).run(); }}")
        self.assertEqual(vis(), ["Background:1", "A:0", "B:0"])
        pg.evaluate(f"() => {{ const e = {ed}; e._layerMenu().find((x) => x.label && x.label.startsWith('End solo')).run(); }}")
        self.assertEqual(vis(), ["Background:1", "A:1", "B:0"])
        # A row dragged onto Duplicate: copied whole (a selection makes no difference); onto Delete: gone.
        pg.evaluate(f"() => {{ const e = {ed}; const m = new Uint8Array(200*120); m[0] = 255; e.setSelection(m); }}")
        def drag(name, title):
            # HTML5 drag and drop as the browser fires it: dragstart on the row, dragover + drop on the button.
            pg.evaluate(f"""([n, t]) => {{ const e = {ed}; const dt = new DataTransfer();
                const r = [...e.layerList.querySelectorAll('.paint-row')].find((x) => x.querySelector('.nm').textContent === n);
                const b = [...e.parts.layers.querySelectorAll('.paint-lfoot .paint-btn')].find((x) => x.title.startsWith(t));
                r.dispatchEvent(new DragEvent('dragstart', {{ bubbles: true, dataTransfer: dt }}));
                const ov = new DragEvent('dragover', {{ bubbles: true, cancelable: true, dataTransfer: dt }});
                b.dispatchEvent(ov);
                if (!ov.defaultPrevented) throw new Error('the button does not take the drop');
                b.dispatchEvent(new DragEvent('drop', {{ bubbles: true, cancelable: true, dataTransfer: dt }}));
                r.dispatchEvent(new DragEvent('dragend', {{ bubbles: true, dataTransfer: dt }})); }}""", [name, title])
        drag("A", "Duplicate")
        pg.wait_for_function(f"() => {ed}.doc.layers.some((l) => l.name === 'A copy')", timeout=5000)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Duplicate layer")
        drag("B", "Delete")
        pg.wait_for_function(f"() => !{ed}.doc.layers.some((l) => l.name === 'B')", timeout=5000)
        self.assertEqual([n.split(":")[0] for n in vis()], ["Background", "A", "A copy"])
        self.assertEqual(self.errors, [])

    def test_save_as_dialog_writes_a_psd_asks_before_overwriting_and_lands_in_the_history(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        folder = os.path.join(self.dirs["output"], "saveas_here")
        pg.evaluate("() => __panel.paintSaveAs(__panel._paintActive())")
        dlg = f"{ed}.box.querySelector('.paint-saveas')"
        pg.wait_for_function(f"() => !!{dlg}", timeout=5000)

        def fill_and_go(fmt):
            pg.evaluate(f"""([folder, fmt]) => {{ const d = {dlg};
                d.querySelector('.paint-saveas-name').value = 'mine';
                d.querySelector('.paint-saveas-format').value = fmt;
                d.querySelector('.paint-saveas-folder').value = folder;
                d.querySelector('.paint-saveas-go').click(); }}""", [folder, fmt])
        fill_and_go("psd")
        target = os.path.join(folder, "mine.psd")
        pg.wait_for_function(f"() => !{dlg}", timeout=10000)
        self.assertTrue(os.path.isfile(target))
        self.assertEqual(pg.evaluate("() => __panel._paintActive().path"), target)
        self.assertFalse(pg.evaluate(f"() => {ed}.isDirty()"))
        # It is in the History: a picture of how it looks, with the file itself as `paint`.
        pg.wait_for_function("(t) => (__panel.history.all || []).some((s) => (s[0] || {}).paint === t)", arg=target, timeout=10000)
        shown = pg.evaluate("(t) => (__panel.history.all || []).find((s) => (s[0] || {}).paint === t)[0]", target)
        self.assertTrue(shown["path"].lower().endswith(".png"), shown)
        self.assertTrue(os.path.isfile(shown["path"]))
        # The same name again: asked first; Overwrite writes it.
        pg.evaluate("() => __panel.paintSaveAs(__panel._paintActive())")
        pg.wait_for_function(f"() => !!{dlg}", timeout=5000)
        before = os.path.getmtime(target)
        fill_and_go("psd")
        pg.wait_for_function(f"() => /there already/.test({dlg}.querySelector('.paint-saveas-note').textContent)", timeout=10000)
        self.assertEqual(os.path.getmtime(target), before)
        pg.evaluate(f"() => {dlg}.querySelector('.paint-saveas-over').click()")
        pg.wait_for_function(f"() => !{dlg}", timeout=10000)
        self.assertEqual(self.errors, [])


    def test_smart_layer_keeps_its_resolution_refuses_the_brush_rasterizes_saves_and_edits_its_contents(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        # A detailed 800 x 480 picture placed as a smart layer: fitted into the 200 x 120 canvas.
        pg.evaluate(f"""() => {{ const b = new Uint8ClampedArray(800 * 480 * 4); let s = 7;
            for (let i = 0; i < b.length; i++) {{ s = (s * 1103515245 + 12345) >>> 0; b[i] = (i & 3) === 3 ? 255 : s >>> 24; }}
            return {ed}.addSmartLayer(b, 800, 480, 'big'); }}""")
        st = pg.evaluate(f"() => {{ const e = {ed}, L = e.active(); return [L.name, e.isSmart(L), L.x, L.y, L.w, L.h, e.undoStack.at(-1).label]; }}")
        self.assertEqual(st, ["big", True, 0, 0, 200, 120, "Place smart layer"])
        self.assertEqual(pg.evaluate(f"() => {ed}.layerList.querySelectorAll('.paint-row .tag.so').length"), 1)
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.props.querySelector('[data-smart=rasterize]')"))
        pg.evaluate(f"() => {{ window.__s0 = Array.from({ed}.pix.get({ed}.active().id)); }}")
        # Down to a tenth and up again: drawn from the source each time, so nothing of it is lost.
        pg.evaluate(f"() => {{ {ed}.tfSet({{ sx: 0.1, sy: 0.1 }}); {ed}.tfCommit(); }}")
        self.assertEqual(pg.evaluate(f"() => [{ed}.active().w, {ed}.isSmart({ed}.active())]"), [20, True])
        pg.evaluate(f"() => {{ {ed}.tfSet({{ sx: 10, sy: 10 }}); {ed}.tfCommit(); }}")
        diff = pg.evaluate(f"""() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id), a = window.__s0; let m = 0;
            if (L.w !== 200 || L.h !== 120) return [L.w, L.h];
            for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }}""")
        self.assertLessEqual(diff, 2)
        # The brush is refused (the layer stays smart, its pixels as they were).
        pg.evaluate(f"() => {{ window.__s1 = Array.from({ed}.pix.get({ed}.active().id)); {ed}.setTool('brush'); }}")
        pg.evaluate(f"() => {ed}.zoomTo(2)")
        at = lambda x, y: pg.evaluate(f"() => {{ const r = {ed}.wrap.getBoundingClientRect(), v = {ed}.view; return [r.left + v.x + {x} * v.zoom, r.top + v.y + {y} * v.zoom]; }}")
        pg.mouse.move(*at(50, 50)); pg.mouse.down(); pg.mouse.move(*at(90, 60), steps=5); pg.mouse.up()
        self.assertTrue(pg.evaluate(f"() => {{ const e = {ed}, b = e.pix.get(e.active().id); return e.isSmart(e.active()) && window.__s1.every((v, i) => v === b[i]); }}"))
        # Rasterize, and undo it.
        pg.evaluate(f"() => {ed}.rasterize()")
        self.assertEqual(pg.evaluate(f"() => [{ed}.isSmart({ed}.active()), {ed}.undoStack.at(-1).label]"), [False, "Rasterize"])
        pg.keyboard.press("Control+z")
        self.assertTrue(pg.evaluate(f"() => {ed}.isSmart({ed}.active())"))
        # Saved: the .ora holds the whole source.
        pg.evaluate("() => __panel.paintSave(__panel._paintActive())")
        pg.wait_for_function(f"() => !{ed}.isDirty()", timeout=10000)
        path = pg.evaluate("() => __panel._paintActive().path")
        doc = self.P.read_ora(path)
        L = doc.layers[-1]
        self.assertEqual((L["smart"]["sw"], L["smart"]["sh"]), (800, 480))
        self.assertEqual(doc.sources[L["smart"]["src"]].shape, (480, 800, 4))
        # Edit contents: a tab of its own; filled red and saved, the smart layer is drawn from it.
        parent = pg.evaluate("() => __panel.activeTab")
        lid = pg.evaluate(f"() => {ed}.active().id")
        self.assertTrue(pg.evaluate(f"(id) => __panel.paintEditSmart(__panel._paintActive(), id)", lid))
        pg.wait_for_function("() => { const r = __panel._paintActive(); return r && r.smartFor && r.editor && r.editor.doc; }", timeout=10000)
        self.assertEqual(pg.evaluate(f"() => [{ed}.doc.w, {ed}.doc.h]"), [800, 480])
        pg.evaluate(f"() => {{ const e = {ed}, L = e.active(), b = new Uint8ClampedArray(L.w * L.h * 4); for (let i = 0; i < b.length; i += 4) b.set([255, 0, 0, 255], i); e.change('Fill', () => {{ e.pix.set(L.id, b); }}); }}")
        pg.evaluate("() => __panel.paintSave(__panel._paintActive())")
        pg.wait_for_function(f"() => !{ed}.isDirty()", timeout=10000)
        pg.evaluate("(k) => __panel.switchTab(k)", parent)
        pg.wait_for_timeout(150)
        got = pg.evaluate(f"(id) => {{ const e = {ed}, L = e.doc.layers.find((x) => x.id === id), b = e.pix.get(L.id); return [e.isSmart(L), [...b.slice(0, 4)], [L.w, L.h], e.undoStack.at(-1).label]; }}", lid)
        self.assertTrue(got[0])
        self.assertEqual(got[1], [255, 0, 0, 255])
        self.assertEqual(got[2], [200, 120])
        # An .ora with a smart layer, written by the agent's side, opens as one: its source comes along.
        import importlib
        O = importlib.import_module(self.pkg + ".paint_ops")
        d = self.P.PaintDoc(100, 60)
        d.add_pixel_layer(np.full((60, 100, 4), 255, np.uint8), "bg")
        big = np.zeros((300, 500, 4), np.uint8); big[..., 2] = 200; big[..., 3] = 255
        O.apply_ops(d, [{"op": "add_layer", "file": "x", "name": "agent", "fit": "contain"}], read_image=lambda f: big)
        ora = os.path.join(self.dirs["output"], "smart_in.ora")
        self.P.write_ora(ora, d)
        pg.evaluate("(p) => __panel.paintOpen(p)", ora)
        pg.wait_for_function("(p) => { const r = __panel._paintActive(); return r && r.path === p && r.editor && r.editor.doc; }", arg=ora, timeout=10000)
        pg.wait_for_timeout(150)
        st = pg.evaluate(f"() => {{ const e = {ed}, L = e.doc.layers.find((x) => x.name === 'agent'); return [e.isSmart(L), e.srcs.get(L.smart.src).w]; }}")
        self.assertEqual(st, [True, 500])

    def test_adjustment_panels_histogram_levels_per_channel_curves_presets_and_into_the_pixels(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate("() => __panel.paintShowPanel('props')")
        pg.evaluate(f"() => {ed}.addAdjustment('levels')")
        pg.wait_for_function(f"() => !!{ed}.parts.props.querySelector('.paint-adj[data-adjust=levels] canvas.paint-hist')", timeout=5000)
        pg.wait_for_timeout(100)
        # The histogram is of what is under it: the photo (blue 160 everywhere, a red block).
        h = pg.evaluate(f"() => {{ const e = {ed}; const L = e.active(); const h = e._adjHistUnder(L); return [h.n, h.b[160], h.r[220], h.r[0]]; }}")
        self.assertEqual(h[0], 200 * 120)
        self.assertEqual(h[1], 200 * 120)
        self.assertEqual(h[2], 60 * 100)
        self.assertEqual(h[3], 200 * 120 - 60 * 100)

        def box(sel):
            return pg.evaluate(f"""(q) => {{ const el = {ed}.parts.props.querySelector(q); el.scrollIntoView({{ block: 'center' }});
                const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}""", sel)
        # Drag the input black handle to about a quarter: in_black follows, one undo step "Levels".
        hk = box(".paint-adj[data-adjust=levels] .paint-ltrack:not(.grad) .h.k")
        track = box(".paint-adj[data-adjust=levels] .paint-ltrack:not(.grad)")
        n0 = pg.evaluate(f"() => {ed}.undoStack.length")
        pg.mouse.move(hk[0] + hk[2] / 2, hk[1] + 4)
        pg.mouse.down()
        pg.mouse.move(track[0] + track[2] * 0.25, hk[1] + 4, steps=5)
        pg.mouse.up()
        ib = pg.evaluate(f"() => {ed}.active().adjust.params.in_black")
        self.assertTrue(55 <= ib <= 72, ib)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.length"), n0 + 1)
        # The red channel: a number of its own; the master stays.
        pg.evaluate(f"""() => {{ const b = {ed}.parts.props.querySelector('.paint-adj[data-adjust=levels]');
            const ch = b.querySelector('.paint-hbar select'); ch.value = 'r'; ch.dispatchEvent(new Event('change'));
            const n = b.querySelector('input[title="Input white"]'); n.value = '200'; n.dispatchEvent(new Event('change')); }}""")
        p = pg.evaluate(f"() => {ed}.active().adjust.params")
        self.assertEqual(p["r"]["in_white"], 200)
        self.assertEqual(p["in_black"], ib)
        self.assertIsNone(p["g"])
        # The picture follows: red 220 -> through the master then red's own levels.
        pg.wait_for_timeout(100)
        comp = pg.evaluate(f"() => {{ const e = {ed}; const c = D_composite(); return c; }}".replace("D_composite()", "Array.from(e.comp.slice((60*200+100)*4, (60*200+100)*4+3))"))
        self.assertEqual(comp[0], 255)
        # Curves: a preset, then a point dragged off the graph goes.
        pg.evaluate(f"() => {ed}.addAdjustment('curves')")
        pg.wait_for_function(f"() => !!{ed}.parts.props.querySelector('.paint-adj[data-adjust=curves]')", timeout=5000)
        pg.evaluate(f"""() => {{ const b = {ed}.parts.props.querySelector('.paint-adj[data-adjust=curves]');
            const pre = b.querySelectorAll('.paint-hbar select')[1]; pre.value = 'strong'; pre.dispatchEvent(new Event('change')); }}""")
        self.assertEqual(pg.evaluate(f"() => {ed}.active().adjust.params.rgb.length"), 4)
        cv = box(".paint-adj[data-adjust=curves] canvas.paint-curve")
        x, y = cv[0] + cv[2] * 64 / 255, cv[1] + cv[3] * (1 - 40 / 255)
        pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x - 200, y, steps=4); pg.mouse.up()
        self.assertEqual(pg.evaluate(f"() => {ed}.active().adjust.params.rgb.length"), 3)
        # Filter > Curves (into the pixels): the same editor in a dialog; OK bakes it as one step.
        pg.evaluate(f"() => {{ const e = {ed}; e.setActive(e.doc.layers[0].id); e.adjustPixelsDialog('curves'); }}")
        pg.wait_for_function(f"() => !!{ed}.box.querySelector('.paint-adjdlg .paint-adj[data-adjust=curves]')", timeout=5000)
        pg.evaluate(f"""() => {{ const b = {ed}.box.querySelector('.paint-adjdlg');
            const pre = b.querySelectorAll('.paint-hbar select')[1]; pre.value = 'negative'; pre.dispatchEvent(new Event('change')); }}""")
        pg.wait_for_timeout(100)
        before = pg.evaluate(f"() => {ed}.undoStack.length")
        pg.evaluate(f"() => [...{ed}.box.querySelector('.paint-adjdlg').querySelectorAll('button')].find((b) => b.textContent === 'OK').click()")
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.length"), before + 1)
        self.assertEqual(pg.evaluate(f"() => {ed}.undoStack.at(-1).label"), "Curves")
        blue = pg.evaluate(f"() => {{ const e = {ed}; return e.pix.get(e.doc.layers[0].id)[2]; }}")
        self.assertEqual(blue, 255 - 160)
        # A filter's dialog has Reset and Before.
        pg.evaluate(f"() => {ed}._filterMenu().find((x) => x.label && x.label.startsWith('Gaussian')).run()")
        names = pg.evaluate(f"() => [...{ed}.box.querySelectorAll('.paint-dlg button')].map((b) => b.textContent)")
        self.assertIn("Reset", names)
        self.assertIn("Before", names)
        self.assertEqual(self.errors, [])


    # ── after 1.22.0: popped out, histograms, tool groups, the area eyedropper, brush tips ──────────────────

    def _ink(self, win, x, y):
        from io import BytesIO
        from PIL import Image
        return np.array(Image.open(BytesIO(win.screenshot(clip={"x": x - 1, "y": y - 1, "width": 2, "height": 2}))).convert("RGB"))[0, 0].tolist()

    def test_popped_out_a_stroke_shows_while_it_is_dragged(self):
        """The viewer in its own window, the main window behind it (its frames stop): the brush is drawn as it moves."""
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function(f"() => {ed}.root.ownerDocument !== document", timeout=10000)
        win.wait_for_timeout(500)
        self.assertTrue(pg.evaluate(f"() => {ed}.d === {ed}.root.ownerDocument && {ed}.d !== document"))
        pg.evaluate("() => { window.requestAnimationFrame = () => 0; }")      # the window behind: no frames there
        pg.evaluate(f"() => {{ const e = {ed}; e.zoomTo(2); e.setTool('brush'); e.opts.brush.size = 20; e.opts.brush.hardness = 100; e.opts.brush.opacity = 100; e.fg = [255, 255, 0]; }}")
        at = lambda x, y: pg.evaluate(f"() => {{ const r = {ed}.wrap.getBoundingClientRect(), v = {ed}.view; return [r.left + v.x + {x} * v.zoom, r.top + v.y + {y} * v.zoom]; }}")
        win.mouse.move(*at(20, 60))
        win.mouse.down()
        win.mouse.move(*at(150, 60), steps=8)
        win.wait_for_timeout(250)
        px = self._ink(win, *at(100, 60))
        self.assertTrue(px[0] > 200 and px[1] > 200 and px[2] < 80, f"yellow while still pressed, got {px}")
        win.mouse.up()
        self.assertEqual(self.errors, [])

    def test_filter_histogram_is_there_before_anything_is_touched(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {ed}.adjustPixelsDialog('levels')")
        pg.wait_for_function(f"() => !!{ed}.box.querySelector('.paint-adjdlg canvas.paint-hist')", timeout=5000)
        pg.wait_for_timeout(150)
        ink = pg.evaluate(f"""() => {{ const cv = {ed}.box.querySelector('.paint-adjdlg canvas.paint-hist');
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return [cv.width, n]; }}""")
        self.assertGreater(ink[0], 100)
        self.assertGreater(ink[1], 50, "the histogram is drawn without moving a slider")
        self.assertEqual(self.errors, [])

    def test_selections_brushes_and_shapes_share_a_toolbar_place_each(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        groups = pg.evaluate(f"() => [...{ed}.box.querySelectorAll('.paint-tools [data-group]')].map((b) => b.dataset.group)")
        for g in ("transform", "select", "paint", "pen", "shape"):
            self.assertEqual(groups.count(g), 1, groups)
        for t in ("marquee", "ellipse", "lasso", "brush", "spot", "heal", "patch"):
            self.assertEqual(pg.evaluate(f"() => {ed}.box.querySelectorAll('.paint-tools > [data-tool=\"{t}\"]:not([data-group])').length"), 0, t)
        sizes = {g: pg.evaluate(f"""() => {{ const e = {ed}; const b = e.box.querySelector('.paint-tools [data-group={g}]');
            b.dispatchEvent(new MouseEvent('contextmenu', {{ bubbles: true, cancelable: true }}));
            const f = e.box.querySelector('.paint-flyout[data-group={g}]'); const n = f ? [...f.querySelectorAll('[data-tool]')].map((x) => x.dataset.tool) : null;
            if (f) f.remove(); return n; }}""") for g in ("select", "paint", "shape")}
        self.assertEqual(sizes["select"], ["marquee", "ellipse", "lasso"])
        self.assertEqual(sizes["paint"], ["brush", "spot", "heal", "patch"])
        self.assertEqual(sizes["shape"], ["shape:rect", "shape:rounded", "shape:ellipse", "shape:polygon", "shape:line"])
        # A shape from the flyout is the shape tool with that shape picked; the slot shows it.
        r = pg.evaluate(f"""() => {{ const e = {ed}; const b = e.box.querySelector('.paint-tools [data-group=shape]');
            b.dispatchEvent(new MouseEvent('contextmenu', {{ bubbles: true, cancelable: true }}));
            e.box.querySelector('.paint-flyout [data-tool="shape:ellipse"]').click();
            return [e.tool, e.opts.shape.kind, b.dataset.tool]; }}""")
        self.assertEqual(r, ["shape", "ellipse", "shape:ellipse"])
        r = pg.evaluate(f"() => {{ const e = {ed}; e.setTool('spot'); return e.box.querySelector('.paint-tools [data-group=paint]').dataset.tool; }}")
        self.assertEqual(r, "spot")
        self.assertEqual(self.errors, [])

    def test_eyedropper_dragged_takes_the_average_of_a_box(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda x, y: (x0 + x * w / 200, y0 + y * h / 120)
        pg.evaluate(f"() => {ed}.setTool('picker')")
        # A click: the pixel.
        pg.mouse.click(*at(10, 10))
        self.assertEqual(pg.evaluate(f"() => {ed}.fg"), [0, 0, 160])
        # A box half over the red block (x 50..150): red is about half of 220.
        pg.mouse.move(*at(0, 40))
        pg.mouse.down()
        pg.mouse.move(*at(50, 60), steps=4)
        pg.mouse.move(*at(100, 80), steps=4)
        self.assertTrue(pg.evaluate(f"() => !!({ed}._drag && {ed}._drag.box)"), "a box while dragging")
        pg.mouse.up()
        fg = pg.evaluate(f"() => {ed}.fg")
        self.assertEqual(fg[1], 0)
        self.assertEqual(fg[2], 160)
        self.assertTrue(100 <= fg[0] <= 120, fg)
        self.assertEqual(self.errors, [])

    def test_brush_tips_dialog_built_in_tips_and_importing_an_abr(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate(f"() => {{ {ed}.setTool('brush'); __panel.paintShowPanel('tool'); }}")
        pg.wait_for_function(f"() => !!{ed}.parts.tool.querySelector('.tip-import')", timeout=5000)
        self.assertGreaterEqual(pg.evaluate(f"() => {ed}.parts.tool.querySelectorAll('.paint-tip[data-tip^=\"builtin:\"]').length"), 14)
        pg.evaluate(f"() => {ed}.parts.tool.querySelector('.tip-import').click()")
        dlg = pg.locator(".paint-tipsdlg")
        dlg.wait_for(timeout=5000)
        self.assertEqual(dlg.locator(".paint-tipgrid").first.locator(".paint-tipcell").count(), 14)
        # An .abr chosen through the dialog's own file input.
        abr = bytearray()
        u8 = lambda v: abr.append(v & 255)
        u16 = lambda v: (u8(v >> 8), u8(v))
        u32 = lambda v: (u16(v >> 16), u16(v & 0xFFFF))
        body = bytearray()
        keep, abr = abr, body
        u32(0); u16(25); u8(1)
        for _ in range(8):
            u8(0)
        u32(0); u32(0); u32(4); u32(40); u16(8); u8(0)
        for _ in range(160):
            u8(255)
        abr = keep
        u16(1); u16(1); u16(2); u32(len(body))
        abr += body
        path = os.path.join(self.tmp, "bars.abr")
        with open(path, "wb") as f:
            f.write(bytes(abr))
        dlg.locator("input[type=file]").set_input_files(path)
        pg.wait_for_function("() => /1 tip/.test(document.querySelector('.paint-tipmsg') ? document.querySelector('.paint-tipmsg').textContent : '') || "
                             f"/1 tip/.test(({ed}.box.querySelector('.paint-tipmsg') || {{}}).textContent || '')", timeout=5000)
        self.assertEqual(dlg.locator(".paint-tipgrid").nth(1).locator(".paint-tipcell").count(), 1)
        # A built-in tip chosen in the dialog paints.
        dlg.locator(".paint-tipcell[data-tip='builtin:square']").click()
        self.assertEqual(pg.evaluate(f"() => {ed}.opts.brush.tip"), "builtin:square")
        dlg.locator("button", has_text="Close").click()
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        pg.evaluate(f"""() => {{ const e = {ed}; e.addPixelLayer(new Uint8ClampedArray(200 * 120 * 4), 200, 120, 'tips');
            e.fg = [0, 0, 0]; e.opts.brush.size = 40; e.opts.brush.opacity = 100; }}""")
        pg.mouse.click(x0 + 100 * w / 200, y0 + 60 * h / 120)
        a = pg.evaluate(f"() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id); const A = (x, y) => b[((y - L.y) * L.w + x - L.x) * 4 + 3]; return [A(100, 60), A(114, 46)]; }}")
        self.assertGreater(a[0], 200)
        self.assertGreater(a[1], 200, "a square tip reaches its corner")
        # Built-in tips cannot be deleted.
        self.assertFalse(pg.evaluate(f"() => !!{ed}.parts.tool.querySelector('.tip-del')"))
        self.assertEqual(self.errors, [])


    def test_brush_tip_direction_points_the_tip_along_the_stroke(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda x, y: (x0 + x * w / 200, y0 + y * h / 120)
        # A thin horizontal bar as the tip (40 x 4), spaced far apart so each dab can be seen on its own.
        pg.evaluate(f"""async () => {{ const e = {ed}; e.setTool('brush');
            const a = new Uint8Array(40 * 4).fill(255); const t = await e._tipKeep({{ name: 'bar', w: 40, h: 4, a }});
            Object.assign(e.opts.brush, {{ tip: t.id, size: 30, opacity: 100, hardness: 100, spacing: 300, direction: true, angle: 0 }});
            e.addPixelLayer(new Uint8ClampedArray(200 * 120 * 4), 200, 120, 'flow'); e.fg = [0, 0, 0]; e.refreshProps(); }}""")
        self.assertTrue(pg.evaluate(f"() => !!{ed}.parts.tool.querySelector('.tip-direction input:checked')"))
        alpha = lambda x, y: pg.evaluate(f"() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id); if ({x} < L.x || {y} < L.y || {x} >= L.x + L.w || {y} >= L.y + L.h) return 0; return b[(({y} - L.y) * L.w + {x} - L.x) * 4 + 3]; }}")
        # Down the picture: the bar stands upright at the start of the stroke.
        pg.mouse.move(*at(100, 20))
        pg.mouse.down()
        for yy in range(22, 101, 2):
            pg.mouse.move(*at(100, yy))
        pg.mouse.up()
        self.assertGreater(alpha(100, 30), 200)
        self.assertEqual(alpha(112, 20), 0, "not lying across")
        # Without Direction the same stroke lies across.
        pg.keyboard.press("Control+z")
        pg.evaluate(f"() => {{ {ed}.opts.brush.direction = false; }}")
        pg.mouse.move(*at(100, 20))
        pg.mouse.down()
        for yy in range(22, 101, 2):
            pg.mouse.move(*at(100, yy))
        pg.mouse.up()
        self.assertGreater(alpha(112, 20), 200)
        self.assertEqual(self.errors, [])


    def test_brush_flow_builds_up_within_a_stroke_up_to_the_opacity(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        x0, y0, w, h = pg.evaluate(f"() => {{ const r = {ed}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        at = lambda x, y: (x0 + x * w / 200, y0 + y * h / 120)
        pg.evaluate(f"""() => {{ const e = {ed}; e.setTool('brush'); __panel.paintShowPanel('tool');
            Object.assign(e.opts.brush, {{ tip: null, size: 20, hardness: 100, opacity: 80, flow: 30, spacing: 15 }});
            e.addPixelLayer(new Uint8ClampedArray(200 * 120 * 4), 200, 120, 'flow'); e.fg = [0, 0, 0]; e.refreshProps(); }}""")
        self.assertTrue(pg.evaluate(f"() => [...{ed}.parts.tool.querySelectorAll('.paint-field > label')].some((l) => l.textContent === 'Flow %')"))
        alpha = lambda x, y: pg.evaluate(f"() => {{ const e = {ed}, L = e.active(), b = e.pix.get(L.id); if ({x} < L.x || {y} < L.y || {x} >= L.x + L.w || {y} >= L.y + L.h) return 0; return b[(({y} - L.y) * L.w + {x} - L.x) * 4 + 3]; }}")
        pg.mouse.click(*at(40, 60))
        one = alpha(40, 60)
        self.assertTrue(56 <= one <= 66, one)                       # one click: 30 % flow of the 80 % opacity
        # Back and forth over one place in one stroke: it builds up, held at the opacity (80 %).
        pg.mouse.move(*at(100, 60))
        pg.mouse.down()
        for i in range(6):
            pg.mouse.move(*at(140, 60), steps=8)
            pg.mouse.move(*at(100, 60), steps=8)
        pg.mouse.up()
        many = alpha(120, 60)
        self.assertTrue(195 <= many <= 205, many)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
