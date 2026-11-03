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
                if "/bepic/" in r.resource.canonical:
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
        pg.evaluate("()=>{const all=document.querySelectorAll('bepic-viewer-panel'); if(all[1]) all[1].style.display='none'}")
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
        self.assertRegex(path.replace("\\", "/"), r"/bepic/paint/photo_v\d{3}\.ora$")   # the next version free (tests share the folder)
        self.assertFalse(pg.evaluate(f"() => {ed}.isDirty()"))
        doc = self.P.read_ora(path)
        self.assertEqual([L["name"] for L in doc.layers], ["Background", "Strokes", "Invert"])
        strokes = doc.layers[1]
        self.assertEqual(int((doc.px[strokes["id"]][..., 3] > 0).sum()), n)
        # The page's picture and the file's look the same (one arithmetic, twice).
        flat_js = pg.evaluate(f"""async () => {{ const D = await import('/extensions/viewer/bEpicViewer_paintData.js'); const e = {ed};
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

    def test_the_agents_change_is_one_undo_step(self):
        pg = self.page()
        self.open_photo(pg)
        ed = self.ED
        pg.evaluate("() => __panel.paintSave(__panel._paintActive())")
        pg.wait_for_function("() => __panel._paintActive().path", timeout=10000)
        path = pg.evaluate("() => __panel._paintActive().path")
        # What edit_image does: POST /bepic/paint/doc; the server's message is handed to the page as ComfyUI would.
        del self.sent[:]
        got = pg.evaluate("""async (path) => { const r = await fetch('/bepic/paint/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doc: path, ops: [{ op: 'add_layer', color: '#00ff00', name: 'Green', opacity: 50 }] }) }); return [r.status, await r.json()]; }""", path)
        self.assertEqual(got[0], 200, got)
        ev = [d for e, d in self.sent if e == "bepic.paint.changed"]
        self.assertEqual(len(ev), 1)
        pg.evaluate("(d) => __api.dispatch('bepic.paint.changed', d)", ev[0])
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
        pg.evaluate(f"""async () => {{ const D = await import('/extensions/viewer/bEpicViewer_paintData.js'); const e = {ed};
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


if __name__ == "__main__":
    unittest.main()
