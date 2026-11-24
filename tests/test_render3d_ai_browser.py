"""The 3D space's Render panel, in a real browser (Sebastian 2026-11-24).

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js from vendor/three: Render…
opens the Render panel with the render settings (the old dialog, merged in), the panel's Render draws one frame
as beauty / depth / normals / mask, a workflow kept on the panel is sent with those passes (the server and ComfyUI
stood in), its result shows as the AI pass and the Wipe compares it with the beauty; the workflow is kept on the
scene per panel. RENDER_PANEL_SHOTS=<folder> writes screenshots.

Needs Playwright with an installed Edge or Chrome and node; skipped without them.
Run: python -m unittest tests.test_render3d_ai_browser
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

OPEN = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  await P.previzAddCamera ? P.previzAddCamera() : null;
  const sc = P.previzScene();
  sc.render = Object.assign({}, sc.render || {}, { useCameraRes: false, width: 320, height: 180, scale: 100 });
  P.previzRenderDialog();
  const h = P.render3dPanel;
  return {
    docked: P.isPanelDocked('render3d'),
    oldDialog: !!P.container.querySelector(':scope > .rd-shade .rd-go'),
    form: !!h.querySelector('.r3-fold-settings .rd-form'),
    settingsOpen: h.querySelector('.r3-fold-settings').open,
    shotBtn: (h.querySelector('.r3-fold-settings .rd-go') || {}).textContent || '',
    renderBtn: !!h.querySelector('.r3-render'),
    passes: [...h.querySelectorAll('.r3-pass')].map((b) => b.dataset.pass),
  };
}"""

RENDER = """async () => {
  const P = window.__panel;
  const st = P._r3St;
  const ok = await P.previzRenderStill(st);
  const read = (url) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let lit = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i] > 200) lit++; if (d[i] < 10) dark++; }
      res({ w: c.width, h: c.height, lit, dark, centre: [...x.getImageData(c.width >> 1, c.height >> 1, 1, 1).data] });
    };
    img.onerror = () => res(null);
    img.src = url;
  });
  const out = { ok, frame: st.frame, error: st.error };
  for (const k of ['beauty', 'depth', 'normals', 'mask']) out[k] = st.passes && st.passes[k] ? await read(st.passes[k]) : null;
  out.dbg = { pass: st.pass, src: (P.render3dPanel.querySelector(".r3-a").getAttribute("src")||"").slice(0,30), conn: P.render3dPanel.isConnected, n: P.render3dPanel.querySelectorAll(".r3-a").length };
  out.shown = P.render3dPanel.querySelector('.r3-a').getAttribute('src') === st.passes.beauty;
  out.passBtns = [...P.render3dPanel.querySelectorAll('.r3-pass')].filter((b) => !b.disabled).map((b) => b.dataset.pass);
  P.render3dPanel.querySelector('.r3-pass[data-pass="depth"]').click();
  out.depthShown = P.render3dPanel.querySelector('.r3-a').getAttribute('src') === st.passes.depth;
  return out;
}"""

AI = """async () => {
  const P = window.__panel;
  const st = P._r3St;
  const sent = [];
  const before = window.__fetchApi;
  window.__fetchApi = async (path, opts) => {
    if (String(path).startsWith('/imageviewer/render3d_ai')) {
      const body = JSON.parse(opts.body);
      sent.push(body);
      return { ok: true, status: 200, json: async () => ({ run: 'r1', graph: { '1': { class_type: 'LoadImage', inputs: {} } },
        outputs: { '9': 'out', '10': 'lines' }, main: 'out', uses: { src: 'beauty', depth: 'depth' }, seed: 1 }) };
    }
    return before(path, opts);
  };
  P._paintQueue = async () => 'pid1';
  P._cpAiWaitNodes = async (id, want) => ({ '9': [{ filename: 'ai_out.png', subfolder: 'render3d/ai/r1', type: 'output' }],
                                             '10': [{ filename: 'ai_lines.png', subfolder: 'render3d/ai/r1', type: 'output' }] });
  P._r3Keep(st, { name: 'My look', source: 'file', path: 'look.json', sig: 'x',
    graph: { '1': { class_type: 'LoadImage', inputs: { image: 'a.png' } }, '2': { class_type: 'LoadImage', inputs: { image: 'b.png' }, _meta: { title: 'comp:depth' } },
             '9': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } } },
    inputs: [{ name: 'src', node: '1', kind: 'picture' }, { name: 'depth', node: '2', kind: 'picture' }],
    outputs: [{ name: 'out', node: '9', kind: 'picture' }, { name: 'lines', node: '10', kind: 'picture' }],
    params: [{ id: 'wf_prompt', name: 'prompt', node: '5', input: 'text', kind: 'prompt', def: 'clay' }] });
  const h = P.render3dPanel;
  const takes = h.querySelector('.r3-takes').textContent;
  const prompt = h.querySelector('[data-param="wf_prompt"]');
  prompt.value = 'a red car'; prompt.dispatchEvent(new Event('change'));
  const ans = await P.previzRenderAi(st);
  window.__fetchApi = before;
  const s0 = sent[0] || {};
  const out = { ans, takes, sentPasses: Object.keys(s0.passes || {}).sort(), sentValues: s0.values, sentFrame: s0.frame,
                pass: st.pass, aiUrl: st.ai && st.ai.url, more: Object.keys((st.ai && st.ai.more) || {}),
                passBtns: [...h.querySelectorAll('.r3-pass')].map((b) => b.dataset.pass),
                kept: JSON.parse(JSON.stringify(P.previzScene().renderAi || {})) };
  h.querySelector('.r3-wipe-btn').click();
  out.wipe = { on: h.querySelector('.r3-stage').classList.contains('wipe'), a: h.querySelector('.r3-a').getAttribute('src') === st.passes.beauty,
               b: h.querySelector('.r3-b').getAttribute('src') === st.ai.url, clip: h.querySelector('.r3-b').style.clipPath };
  // A second Render panel has a workflow of its own.
  const ok2 = P.dockNewInstance('render3d', 'render3d');
  out.second = ok2;
  const insts = P._dockInstancesOf('render3d').filter((x) => x.inst !== P._r3Inst);
  out.secondHasWorkflow = insts.length ? !!insts[0].inst.st.mine().custom : null;
  out.secondId = insts.length ? insts[0].id : null;
  return out;
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class RenderPanelBrowserTests(unittest.TestCase):
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
        if getattr(cls, "server", None):
            cls.server.kill()
            cls.server.wait()

    def test_the_render_panel_renders_passes_and_runs_a_workflow_on_them(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
            pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
            opened = pg.evaluate(OPEN)
            shots = os.environ.get("RENDER_PANEL_SHOTS")
            r = pg.evaluate(RENDER)
            if shots:
                os.makedirs(shots, exist_ok=True)
                pg.evaluate("() => { const P = window.__panel; P._r3St.pass = 'beauty'; P._r3St.draw(); }")
                pg.wait_for_timeout(300)
                pg.screenshot(path=os.path.join(shots, "render-panel.png"))
            ai = pg.evaluate(AI)
        finally:
            pg.close()
        self.assertTrue(opened["docked"], "Render… opens the Render panel")
        self.assertFalse(opened["oldDialog"], "no dialog over the viewer any more")
        self.assertTrue(opened["form"] and opened["settingsOpen"], "the settings are in the panel, unfolded")
        self.assertEqual(opened["shotBtn"], "Render shot")
        self.assertTrue(opened["renderBtn"])
        self.assertEqual(opened["passes"], ["beauty", "depth", "normals", "mask"])
        self.assertTrue(r["ok"], r["error"])
        for k in ("beauty", "depth", "normals", "mask"):
            self.assertIsNotNone(r[k], k)
            self.assertEqual((r[k]["w"], r[k]["h"]), (320, 180), k)
        self.assertGreater(r["mask"]["lit"], 100, "the box covers part of the frame")
        self.assertGreater(r["mask"]["dark"], 100, "and not all of it")
        self.assertGreater(r["depth"]["dark"], 100, "nothing there is black in the depth")
        self.assertTrue(r["shown"] and r["depthShown"], r.get("dbg"))
        self.assertEqual(r["passBtns"], ["beauty", "depth", "normals", "mask"])
        self.assertTrue(ai["ans"] and ai["ans"]["ok"], ai)
        self.assertIn("beauty", ai["takes"])
        self.assertIn("depth", ai["takes"])
        self.assertEqual(ai["sentPasses"], ["beauty", "depth", "mask", "normals"])
        self.assertEqual(ai["sentValues"], {"wf_prompt": "a red car"})
        self.assertEqual(ai["pass"], "ai")
        self.assertIn("ai_out.png", ai["aiUrl"])
        self.assertEqual(ai["more"], ["lines"])
        self.assertEqual(ai["passBtns"][-2:], ["ai", "ai:lines"])
        kept = ai["kept"]["render3d"]
        self.assertEqual(kept["custom"]["name"], "My look")
        self.assertEqual(kept["values"], {"wf_prompt": "a red car"})
        self.assertEqual(kept["last"]["main"]["filename"], "ai_out.png")
        self.assertTrue(ai["wipe"]["on"] and ai["wipe"]["a"] and ai["wipe"]["b"])
        self.assertIn("inset", ai["wipe"]["clip"])
        self.assertTrue(ai["second"])
        self.assertFalse(ai["secondHasWorkflow"], "a second panel starts without the first one's workflow")
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
