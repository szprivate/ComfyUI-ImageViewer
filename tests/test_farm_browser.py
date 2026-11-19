"""The Farm tab, in a real browser: machines as cards with their state and cost, the spend bar against the cap, the
queue with each render as a chip, live offers to rent, the render dialog sending this canvas's workflow, Setup.

Needs Playwright with a browser and node for the stub server; skipped without them.
Run: python -m unittest tests.test_farm_browser   (FARM_SHOTS=<folder> saves screenshots)
It serves tests/harness/tabs.html - the REAL viewer js against stubbed ComfyUI scripts - and answers
/imageviewer/farm from the page (window.__fetchApi) with a small farm that changes as actions arrive.
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
SHOTS = os.environ.get("FARM_SHOTS", "")


def _preview(seed, noise):
    """A half-denoised looking picture (canyon walls, a blue car-shaped blob) as a JPEG data URL."""
    import base64
    import io
    import numpy as np
    from PIL import Image, ImageFilter
    rng = np.random.default_rng(seed)
    w, hgt = 320, 180
    y, x = np.mgrid[0:hgt, 0:w].astype(np.float32)
    wall = np.clip(np.abs(x - w / 2) / (w / 2), 0, 1) ** 0.6
    img = np.zeros((hgt, w, 3), np.float32)
    img[..., 0] = 120 + 110 * wall + 20 * np.sin(y / 9)
    img[..., 1] = 60 + 70 * wall
    img[..., 2] = 40 + 40 * wall + 80 * (1 - y / hgt) * (1 - wall)
    car = ((x - w * 0.52) / 70) ** 2 + ((y - hgt * 0.68) / 22) ** 2 < 1
    img[car] = [40, 80, 170]
    img += rng.normal(0, noise, img.shape)
    pic = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    buf = io.BytesIO()
    pic.save(buf, "JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

STUB = """(pv) => {
  const real = window.__fetchApi;
  const now = Date.now() / 1000;
  const tasks = (n, done, running, failed) => Array.from({length: n}, (_, i) => ({i, seed: 1000 + i,
    state: i < done ? 'done' : i < done + running ? 'running' : i < done + running + failed ? 'failed' : 'queued',
    machine: i < done + running ? (i % 2 ? 'm2' : 'm1') : null, tries: 1, error: i >= done + running && i < done + running + failed ? 'CUDA out of memory' : '',
    outputs: i < done ? [`D:/out/farm/j1/${String(i).padStart(3, '0')}_GLC_canyon_00001_.png`] : []}));
  const S = window.__farm = {
    ok: true,
    machines: [
      {id: 'm1', name: 'vast-1', provider: 'vast', gpu: 'RTX 5090', gpu_seen: 'NVIDIA GeForce RTX 5090', state: 'ready',
       task: {job: 'j1', i: 6}, state_note: 'GLC canyon turntable #7', usd_per_hour: 0.47, uptime_s: 2860, cost_usd: 0.37,
       done: 4, failed: 0, region: 'Germany, DE', url: 'http://1.2.3.4:40123', created: now - 3000,
       live: {started: true, node: '3', class_type: 'KSampler', value: 12, max: 30, nodes_done: 5, nodes_total: 11, preview: pv[0]},
       parity: {ok: true, missing_nodes: [], missing_models: []}},
      {id: 'm2', name: 'vast-2', provider: 'vast', gpu: 'RTX 5090', gpu_seen: 'NVIDIA GeForce RTX 5090', state: 'ready',
       task: {job: 'j1', i: 7}, state_note: 'GLC canyon turntable #8', usd_per_hour: 0.51, uptime_s: 2790, cost_usd: 0.40,
       done: 3, failed: 1, region: 'Sweden, SE', url: 'http://5.6.7.8:40007', created: now - 2900, parity: null,
       live: {started: true, node: '3', class_type: 'KSampler', value: 26, max: 30, nodes_done: 5, nodes_total: 11, preview: pv[1]}},
      {id: 'm3', name: 'runpod-1', provider: 'runpod', gpu: 'RTX PRO 6000', state: 'starting', usd_per_hour: 0.83,
       uptime_s: 95, cost_usd: 0.02, done: 0, failed: 0, region: 'EU data centres', url: '', created: now - 100,
       parity: {ok: false, missing_nodes: ['SZ_GetPath'], missing_models: ['diffusion_models/z_image_turbo_bf16.safetensors']}},
      {id: 'm4', name: 'office-4090', provider: 'url', gpu: '', gpu_seen: 'NVIDIA GeForce RTX 4090', state: 'stopped',
       usd_per_hour: 0, uptime_s: 0, cost_usd: 0, done: 12, failed: 0, region: '', url: 'http://192.168.1.20:8188',
       created: now - 9000, error: '', parity: null},
    ],
    jobs: [
      {id: 'j1', name: 'GLC canyon turntable', created: now - 1500, batch: 16, seed_mode: 'increment', state: 'running',
       tasks: tasks(16, 7, 2, 1), counts: {done: 7, running: 2, failed: 1, queued: 6}},
      {id: 'j0', name: 'Z-Image look tests', created: now - 7200, batch: 8, seed_mode: 'random', state: 'done',
       tasks: tasks(8, 8, 0, 0), counts: {done: 8}},
    ],
    settings: {daily_cap_usd: 20, idle_stop_minutes: 10, eu_only: true, max_usd_per_hour: 1.5,
               image: 'ghcr.io/example/comfy-farm:ws26', disk_gb: 80, gpu: 'RTX 5090', retries: 1,
               keep_models: true, volume_gb: 150},
    volumes: [
      {id: 'vast:3000', provider: 'vast', provider_id: '3000', name: 'V.3000', size_gb: 150, where: '36683', region: 'Germany, DE',
       usd_per_month: 22.5, models: ['diffusion_models/moss_image_sft_int8_convrot.safetensors', 'text_encoders/qwen3.5_9b_w4a8_gptq.safetensors',
       'vae/flux2-vae_small.safetensors'], models_gb: 19.4, models_at: now - 60, machines: ['vast-1'], created: now - 4000},
      {id: 'runpod:nv1', provider: 'runpod', provider_id: 'nv1', name: 'agentY farm models', size_gb: 200, where: 'EU-RO-1',
       region: 'EU-RO-1', usd_per_month: 14, models: [], models_gb: 0, models_at: 0, machines: [], created: now - 1000}],
    spend: {today: 3.12, cap: 20, per_hour: 1.81, days: {'2026-11-11': 1.2, '2026-11-12': 4.8, '2026-11-13': 0.9, '2026-11-14': 6.4, '2026-11-15': 3.12}},
    keys: {vast: true, runpod: true}, providers: ['vast', 'runpod', 'url'],
  };
  window.__farmPosts = [];
  window.__fetchApi = async (path, opts) => {
    if (String(path).startsWith('/imageviewer/farm')) {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      const ok = (o) => new Response(JSON.stringify(o), {status: 200, headers: {'Content-Type': 'application/json'}});
      if (!body) return ok(S);
      window.__farmPosts.push(body);
      if (body.action === 'offers') return ok({ok: true, state: S, offers: [
        {provider: 'vast', offer_id: '11', gpu: 'RTX 5090', vram_gb: 32, usd_per_hour: 0.44, region: 'Czechia, CZ', reliability: 0.995, down_mbps: 2100},
        {provider: 'vast', offer_id: '12', gpu: 'RTX 5090', vram_gb: 32, usd_per_hour: 0.47, region: 'Germany, DE', reliability: 0.99, down_mbps: 900},
        {provider: 'vast', offer_id: '13', gpu: 'RTX 5090', vram_gb: 32, usd_per_hour: 0.54, region: 'Netherlands, NL', reliability: 0.98, down_mbps: 4500},
        {provider: 'vast', offer_id: '14', gpu: 'RTX 5090', vram_gb: 32, usd_per_hour: 1.92, region: 'Sweden, SE', reliability: 0.999, down_mbps: 8000, too_dear: true}]});
      if (body.action === 'volume_offers') return ok({ok: true, state: S, offers: [
        {provider: 'vast', offer_id: '900', machine_id: '36683', region: 'Germany, DE', free_gb: 800, usd_per_gb_month: 0.12},
        {provider: 'vast', offer_id: '901', machine_id: '41002', region: 'Czechia, CZ', free_gb: 400, usd_per_gb_month: 0.15}]});
      if (body.action === 'delete_volume') S.volumes = S.volumes.filter((v) => v.id !== body.id);
      if (body.action === 'stop') { const m = S.machines.find((x) => x.id === body.id); m.state = 'stopped'; m.task = null; m.uptime_s = 0; }
      if (body.action === 'submit') {
        const j = {id: 'j2', name: body.name, created: Date.now() / 1000, batch: body.batch, seed_mode: body.seed_mode, state: 'queued',
                   tasks: Array.from({length: body.batch}, (_, i) => ({i, seed: 5 + i, state: 'queued', machine: null, outputs: []})), counts: {queued: body.batch}};
        S.jobs.unshift(j);
        return ok({ok: true, job: j, state: S});
      }
      return ok({ok: true, state: S});
    }
    return real(path, opts);
  };
  window.__app = null;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class FarmBrowserTests(unittest.TestCase):
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
        pg = self.browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2 if SHOTS else 1)
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate(STUB, [_preview(1, 70), _preview(2, 22)])
        pg.evaluate("""async () => {
            const { app } = await import('/scripts/app.js');
            app.graphToPrompt = async () => ({ output: {
                '3': {class_type: 'KSampler', inputs: {seed: 5, steps: 8}}, '9': {class_type: 'SaveImage', inputs: {}} } });
            window.__panel.setViewerToggleState(true);
            if (window.__panel.setPanelDocked) window.__panel.setPanelDocked('params', false);
            window.__panel.farmOpen();
        }""")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.view-tab-farm .fm-card[data-id]').length === 4",
                             timeout=10000)
        return pg

    def shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, name))

    def test_machines_spend_and_bar_group(self):
        pg = self.page()
        self.assertEqual(pg.evaluate("() => window.__panel.activeTab"), "farm:")
        cards = pg.evaluate("""() => [...window.__panel.viewport.querySelectorAll('.fm-card[data-id]')].map((c) => ({
            id: c.dataset.id, cls: c.className, name: c.querySelector('.fm-card-name').textContent,
            acts: [...c.querySelectorAll('.fm-acts .fm-btn')].map((b) => b.textContent)}))""")
        self.assertEqual([c["name"] for c in cards], ["vast-1", "vast-2", "runpod-1", "office-4090"])
        self.assertIn("st-busy", cards[0]["cls"])
        self.assertIn("st-starting", cards[2]["cls"])
        self.assertEqual(cards[0]["acts"], ["Stop", "Open ComfyUI", "Check workflow", "Terminate"])
        self.assertEqual(cards[3]["acts"], ["Open ComfyUI", "Check workflow", "Remove"])
        spend = pg.evaluate("() => window.__panel.viewport.querySelector('.fm-spend-text').textContent")
        self.assertEqual(spend, "Today $3.12 of $20.00 · $1.81/h running")
        live = pg.evaluate("""() => { const c = window.__panel.viewport.querySelector('.fm-card[data-id="m1"] .fm-live');
            return {text: c.querySelector('.fm-live-text').textContent, img: !!c.querySelector('img.fm-live-img'),
                    w: c.querySelector('.fm-live-fill').style.width}; }""")
        self.assertEqual(live, {"text": "KSampler · step 12 of 30 · node 6 of 11", "img": True, "w": "49%"})
        tab = pg.evaluate("() => { const t = window.__panel.container.querySelector('.tab[data-tab=\"farm:\"]'); return t && t.dataset.space; }")
        self.assertEqual(tab, "farm")
        self.assertTrue(pg.evaluate("() => !!window.__panel.container.querySelector('#bar-group-farm')"))
        self.shot(pg, "farm-machines.png")
        # Stop sends the action and the card follows the state that comes back.
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-card[data-id=\"m2\"] .fm-btn')].find((b) => b.textContent === 'Stop').click()")
        pg.wait_for_function("() => window.__panel.viewport.querySelector('.fm-card[data-id=\"m2\"]').classList.contains('st-stopped')")
        self.assertEqual(pg.evaluate("() => window.__farmPosts.at(-1)"), {"action": "stop", "id": "m2"})
        self.assertEqual(self.errors, [])

    def test_queue_and_render_dialog(self):
        pg = self.page()
        pg.evaluate("() => window.__panel.viewport.querySelector('.fm-tab[data-view=\"queue\"]').click()")
        chips = pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-job[data-id=\"j1\"] .fm-chip')].map((c) => c.className.split(' ')[1])")
        self.assertEqual(chips.count("st-done"), 7)
        self.assertEqual(chips.count("st-running"), 2)
        self.assertEqual(chips.count("st-failed"), 1)
        caps = pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-job[data-id=\"j1\"] .fm-livecap')].map((c) => c.textContent)")
        self.assertEqual(caps, ["#7 · vast-1", "#8 · vast-2"])
        self.shot(pg, "farm-queue.png")
        pg.evaluate("() => window.__panel.viewport.querySelector('.fm-render').click()")
        pg.wait_for_selector("comfyui-image-viewer-panel .fm-render-dlg", state="attached")
        rows = pg.evaluate("() => window.__panel.viewport.querySelectorAll('.fm-render-dlg .fm-mrow').length")
        self.assertEqual(rows, 4)
        pg.evaluate("""() => { const d = window.__panel.viewport.querySelector('.fm-render-dlg');
            d.querySelector('input[type=number]').value = '12'; d.querySelector('input[type=number]').dispatchEvent(new Event('input'));
            d.querySelector('.fm-field input').value = 'GLC canyon v2'; }""")
        self.shot(pg, "farm-render-dialog.png")
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-render-dlg .fm-btn')].find((b) => b.textContent === 'Render').click()")
        pg.wait_for_function("() => window.__panel.viewport.querySelector('.fm-job[data-id=\"j2\"]')")
        sub = pg.evaluate("() => window.__farmPosts.find((p) => p.action === 'submit')")
        self.assertEqual((sub["batch"], sub["name"], sub["seed_mode"], sub["machines"]), (12, "GLC canyon v2", "increment", []))
        self.assertEqual(sub["workflow"]["3"]["class_type"], "KSampler")
        self.assertNotIn("dest", sub)
        self.assertEqual(self.errors, [])

    def test_offers_and_setup(self):
        pg = self.page()
        pg.evaluate("() => window.__panel.viewport.querySelector('.fm-add').click()")
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-add-dlg .fm-btn')].find((b) => b.textContent === 'Find offers').click()")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.fm-add-dlg .fm-offer:not(.fm-offer-head)').length === 4")
        dear = pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-add-dlg .fm-offer:not(.fm-offer-head) button')].map((b) => b.disabled)")
        self.assertEqual(dear, [False, False, False, True])
        self.shot(pg, "farm-add-machines.png")
        pg.evaluate("() => window.__panel.viewport.querySelector('.fm-add-dlg .fm-offer:not(.fm-offer-head) button').click()")
        txt = pg.evaluate("() => window.__panel.viewport.querySelector('.fm-confirm .fm-sec-text').textContent")
        self.assertIn("10 idle minutes", txt)
        self.assertIn("$20.00", txt)
        self.shot(pg, "farm-rent-confirm.png")
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-confirm .fm-btn')].find((b) => b.textContent === 'Rent').click()")
        pg.wait_for_function("() => window.__farmPosts.some((p) => p.action === 'rent')")
        rent = pg.evaluate("() => window.__farmPosts.find((p) => p.action === 'rent')")
        self.assertEqual((rent["provider"], rent["offer_id"], rent["usd_per_hour"]), ("vast", "11", 0.44))
        pg.evaluate("() => window.__panel.farmOpen('setup')")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.fm-setup .fm-field').length === 10")
        self.shot(pg, "farm-setup.png")
        pg.evaluate("""() => { const i = window.__panel.viewport.querySelector('.fm-setup input[data-key=daily_cap_usd]'); i.value = '35';
            [...window.__panel.viewport.querySelectorAll('.fm-setup .fm-btn')].find((b) => b.textContent === 'Save').click(); }""")
        pg.wait_for_function("() => window.__farmPosts.some((p) => p.action === 'settings')")
        st = pg.evaluate("() => window.__farmPosts.find((p) => p.action === 'settings').settings")
        self.assertEqual((st["daily_cap_usd"], st["eu_only"]), ("35", True))
        self.assertEqual(self.errors, [])

    def test_an_edit_survives_the_refresh_until_saved(self):
        pg = self.page()
        pg.evaluate("() => window.__panel.farmOpen('setup')")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.fm-setup .fm-field').length === 10")
        pg.evaluate("""() => { const i = window.__panel.viewport.querySelector('.fm-setup input[data-key=image]');
            i.focus(); i.value = 'ghcr.io/me/farm:2'; i.dispatchEvent(new Event('input', {bubbles: true})); i.blur(); }""")
        pg.wait_for_timeout(4500)                          # two refreshes of the farm while nothing has focus
        kept = pg.evaluate("() => window.__panel.viewport.querySelector('.fm-setup input[data-key=image]').value")
        self.assertEqual(kept, "ghcr.io/me/farm:2")
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-setup .fm-btn')].find((b) => b.textContent === 'Save').click()")
        pg.wait_for_function("() => window.__farmPosts.some((p) => p.action === 'settings')")
        st = pg.evaluate("() => window.__farmPosts.find((p) => p.action === 'settings').settings")
        self.assertEqual(st["image"], "ghcr.io/me/farm:2")
        self.assertEqual(self.errors, [])

    def test_storage_lists_volumes_their_models_and_makes_and_deletes_them(self):
        pg = self.page()
        pg.evaluate("() => window.__panel.farmOpen('storage')")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.fm-storage .fm-volume').length === 2")
        tab = pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-tab')].map((b) => b.textContent)")
        self.assertIn("Storage (2)", tab)
        first = pg.evaluate("() => window.__panel.viewport.querySelector('.fm-storage .fm-volume').textContent")
        self.assertIn("150 GB", first)
        self.assertIn("$22.50/month", first)
        self.assertIn("3 models · 19.4 GB", first)
        self.assertIn("Used by vast-1", first)
        dels = pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-volume .fm-danger')].map((b) => b.disabled)")
        self.assertEqual(dels, [True, False])                      # the one a machine uses cannot be deleted
        grows = pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-volume')].map((c) => [...c.querySelectorAll('button')].some((b) => b.textContent === 'Grow…'))")
        self.assertEqual(grows, [False, True])                     # only RunPod volumes grow
        pg.evaluate("() => window.__panel.viewport.querySelector('.fm-volume details').open = true")
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-storage .fm-btn')].find((b) => b.textContent === 'Find storage').click()")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.fm-voloffer').length === 2")
        price = pg.evaluate("() => window.__panel.viewport.querySelector('.fm-voloffer .fm-price').textContent")
        self.assertEqual(price, "$18.00/month")                    # 150 GB at $0.12
        self.shot(pg, "farm-storage.png")
        pg.evaluate("() => window.__panel.viewport.querySelector('.fm-voloffer .fm-btn').click()")
        txt = pg.evaluate("() => window.__panel.viewport.querySelector('.fm-confirm .fm-sec-text').textContent")
        self.assertIn("lives on that one machine", txt)
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-confirm .fm-btn')].find((b) => b.textContent === 'Make').click()")
        pg.wait_for_function("() => window.__farmPosts.some((p) => p.action === 'create_volume')")
        mk = pg.evaluate("() => window.__farmPosts.find((p) => p.action === 'create_volume')")
        self.assertEqual((mk["provider"], mk["offer_id"], mk["size_gb"]), ("vast", "900", 150))
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-volume')][1].querySelector('.fm-danger').click()")
        pg.evaluate("() => [...window.__panel.viewport.querySelectorAll('.fm-confirm .fm-btn')].find((b) => b.textContent === 'Delete').click()")
        pg.wait_for_function("() => window.__panel.viewport.querySelectorAll('.fm-storage .fm-volume').length === 1")
        self.assertEqual(pg.evaluate("() => window.__farmPosts.at(-1)"), {"action": "delete_volume", "id": "runpod:nv1"})
        self.assertEqual(self.errors, [])

    def test_a_host_that_is_down_says_so(self):
        pg = self.page()
        pg.evaluate("""() => { window.__fetchApi = async () => new Response(JSON.stringify({ok: false, offline: true,
            error: 'the agentY host is not running (start it, then press the button again)'}), {status: 200}); }""")
        pg.wait_for_function("() => window.__panel.viewport.querySelector('.fm-root').classList.contains('offline')", timeout=6000)
        self.assertIn("not answering", pg.evaluate("() => window.__panel.viewport.querySelector('.fm-note').textContent"))


if __name__ == "__main__":
    unittest.main()
