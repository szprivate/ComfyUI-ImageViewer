"""VFX on a clip of the History in the REAL viewer, against the REAL routes: right-click a film › Convert Footage ›
Upscale…, pick Restore, Run - the graph queued names the clip's 8n + 1 frames (written into the input folder by
the Edit panel's renderer) and the restore LoRA; ComfyUI's answer (an `executed` of the SaveVideo node) brings
the result into the History in the source's group, the dialog says Done. A missing model is said before
anything is queued, and pictures get no Convert Footage row.

    python -m unittest discover -s tests -p test_clip_vfx_browser.py   (Playwright, aiohttp, PyAV; skipped without)
"""
import asyncio
import os
import shutil
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, web  # noqa: E402
from test_clip_vfx import _counter_film, av  # noqa: E402

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


@unittest.skipIf(sync_playwright is None or web is None or av is None, "needs playwright, aiohttp and PyAV")
class ClipVfxBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.sent = []
        cls.routes_app, cls.dirs, cls.pkg = _load(cls.tmp, cls.sent)
        import importlib
        api = importlib.import_module(cls.pkg + ".viewer_api")
        api.folder_paths.get_full_path = lambda folder, name: f"/m/{folder}/{name}"    # every model is here
        api.folder_paths.get_filename_list = lambda folder: []
        # imageio-ffmpeg starts ffmpeg, and a fork from this process (Playwright's threads) can hang: PyAV here.
        mr = importlib.import_module(cls.pkg + ".media_resolve")
        cls.V = importlib.import_module(cls.pkg + ".clip_vfx")
        mr.probe_video = lambda path: (lambda f: (f["fps"], f["frames"]))(cls.V.probe(path))

        def frame(path, index):
            with av.open(path) as c:
                for i, fr in enumerate(c.decode(video=0)):
                    if i >= index:
                        return fr.to_ndarray(format="rgb24")
            return None
        mr._decode_video_frame = frame
        cls.clip = os.path.join(cls.dirs["output"], "plate.mp4")
        _counter_film(cls.clip, frames=30)
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
        pg.evaluate("""async (clip) => {
            const all = document.querySelectorAll('comfyui-image-viewer-panel'); if (all[1]) all[1].style.display = 'none';
            const f = window.__fetchApi;
            window.__fetchApi = async (p, o) => p.startsWith('/imageviewer/clip_vfx') ? fetch(p, o) : f(p, o);
            window.__queued = [];
            __api.queuePrompt = async (n, d) => { window.__queued.push(d.output); return { prompt_id: 'v' + window.__queued.length }; };
            const { app } = await import('/scripts/app.js'); window.__toasts = [];
            app.extensionManager.toast = { add: (t) => window.__toasts.push(t.summary + ' -- ' + t.detail) };
            const P = window.__panel;
            if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
            P.history.all = [[{ fromTab: P.activeTab || 'main', path: clip, filename: 'plate.mp4', type: 'output', group: 'Seq 010' }],
                             [{ fromTab: P.activeTab || 'main', path: clip.replace('plate.mp4', 'still.png'), filename: 'still.png', type: 'output' }]];
            P._historyPanelSig = null; P.renderHistoryPanel();
        }""", self.clip)
        return pg

    def menu(self, pg, idx):
        pg.evaluate("""(idx) => { const P = window.__panel, fr = P.history.all[idx][0];
            P.showThumbContextMenu({ clientX: 300, clientY: 200, preventDefault() {}, stopPropagation() {} }, fr, 'all', idx); }""", idx)
        return pg.evaluate("() => [...__panel.shadowRoot.querySelectorAll('#thumb-ctx-menu .thumb-ctx-item')].map((e) => e.textContent)")

    def test_upscale_a_clip_from_its_menu_and_the_result_lands_beside_it(self):
        pg = self.page()
        rows = self.menu(pg, 1)
        self.assertFalse(any("Convert Footage" in r for r in rows), rows)          # a picture has none
        rows = self.menu(pg, 0)
        self.assertTrue(any("Convert Footage" in r for r in rows), rows)
        R = "__panel.shadowRoot"
        pg.evaluate(f"() => {R}.querySelector('.clip-vfx-item').click()")
        subs = pg.evaluate(f"() => [...{R}.querySelectorAll('[data-vfx]')].map((e) => e.dataset.vfx)")
        self.assertEqual(subs, ["alpha", "hdr", "reframe", "upscale"])
        pg.evaluate(f"() => {R}.querySelector('[data-vfx=upscale]').click()")
        pg.wait_for_function(f"() => {R}.querySelector('.clip-vfx-dlg[data-action=upscale]')", timeout=10000)
        self.assertIsNone(pg.evaluate(f"() => {R}.querySelector('#thumb-ctx-menu')"))
        pg.evaluate(f"""() => {{ const d = {R}.querySelector('.clip-vfx-dlg'), s = d.querySelectorAll('select');
            s[0].value = 'restore'; s[1].value = '4K'; d.querySelector('textarea').value = 'a city street';
            d.querySelector('.rd-go').click(); }}""")
        pg.wait_for_function("() => window.__queued.length === 1", timeout=20000)
        g = pg.evaluate("() => window.__queued[0]")
        name = g["5001"]["inputs"]["file"]
        self.assertTrue(name.startswith("clip_vfx/plate_"), name)        # 30 frames -> the first 25
        self.assertIn("restore", g["5004:5606"]["inputs"]["lora_name"])
        self.assertEqual(g["9002:9200"]["inputs"]["output_size"], "4K")
        self.assertEqual(g["5508"]["inputs"]["value"], "a city street")
        with av.open(os.path.join(self.dirs["input"], name)) as c:
            self.assertEqual(sum(1 for _ in c.decode(video=0)), 25)
        msg = pg.evaluate(f"() => {R}.querySelector('.clip-vfx-dlg .rd-message').textContent")
        self.assertIn("5 frames at the end left out", msg)
        # ComfyUI runs it and says so.
        out = os.path.join(self.dirs["output"], "ltx_vfx")
        os.makedirs(out, exist_ok=True)
        _counter_film(os.path.join(out, "plate_upscale_restore_00001_.mp4"), frames=25)
        pg.evaluate("""() => __api.dispatch('executed', { prompt_id: 'v1', node: '4852',
            output: { images: [{ filename: 'plate_upscale_restore_00001_.mp4', subfolder: 'ltx_vfx', type: 'output' }], animated: [true] } })""")
        pg.wait_for_function("() => __panel.history.all.length === 3", timeout=20000)
        top = pg.evaluate("() => __panel.history.all[0][0]")
        self.assertTrue(top["path"].replace("\\", "/").endswith("ltx_vfx/plate_upscale_restore_00001_.mp4"), top)
        self.assertEqual(top.get("group"), "Seq 010")
        self.assertEqual(top.get("label"), "plate \u00b7 Upscale (restore, 4K)")
        pg.wait_for_function(f"() => /Done/.test({R}.querySelector('.clip-vfx-dlg .rd-message')?.textContent || 'Done')", timeout=10000)
        self.assertFalse(os.path.exists(os.path.join(self.dirs["input"], name)))   # the part is removed
        self.assertTrue(any("done" in t for t in pg.evaluate("() => window.__toasts")))
        self.assertEqual(self.errors, [])

    def test_a_missing_model_is_said_and_nothing_is_queued(self):
        import importlib
        api = importlib.import_module(self.pkg + ".viewer_api")
        was = api.folder_paths.get_full_path
        api.folder_paths.get_full_path = lambda folder, name: None
        self.addCleanup(setattr, api.folder_paths, "get_full_path", was)
        pg = self.page()
        pg.evaluate("() => __panel.clipVfxDialog(__panel.history.all[0], 'alpha')")
        pg.wait_for_function("() => __panel.shadowRoot.querySelector('.clip-vfx-dlg .rd-go')", timeout=10000)
        pg.evaluate("() => __panel.shadowRoot.querySelector('.clip-vfx-dlg .rd-go').click()")
        pg.wait_for_function("() => /Not here/.test(__panel.shadowRoot.querySelector('.clip-vfx-dlg .rd-message').textContent)", timeout=10000)
        self.assertIn("ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors",
                      pg.evaluate("() => __panel.shadowRoot.querySelector('.clip-vfx-dlg .rd-message').textContent"))
        self.assertEqual(pg.evaluate("() => window.__queued.length"), 0)
        self.assertFalse(os.path.isdir(os.path.join(self.dirs["input"], "clip_vfx")) and
                         os.listdir(os.path.join(self.dirs["input"], "clip_vfx")))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
