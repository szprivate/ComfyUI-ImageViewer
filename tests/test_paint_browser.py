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
        self.assertTrue(pg.evaluate("() => [...__panel._paintActive().editor.parts.props.querySelectorAll('label.paint-check')].length === 2"))
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
        # Generative fill: saved first, a snapshot, and agentY asked with the paths and the call back.
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
            return [e.opts.clone.size, e.parts.props.querySelector('input[type=range]').value, !!e.optBar.querySelector('select')]; }}""")
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


if __name__ == "__main__":
    unittest.main()
