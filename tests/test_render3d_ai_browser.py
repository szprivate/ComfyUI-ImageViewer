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
    oldDialog: !!P.container.querySelector(':scope > .rd-shade:not(.r3-setwin) .rd-go'),
    form: !!P.container.querySelector(':scope > .r3-setwin .rd-form'),
    settingsOpen: !!P.container.querySelector(':scope > .r3-setwin'),
    inPanel: !!h.querySelector('.r3-fold-settings'),
    shotBtn: (P.container.querySelector('.r3-setwin .rd-go') || {}).textContent || '',
    renderBtn: !!h.querySelector('.r3-render'),
    passes: [...h.querySelectorAll('.r3-pass-select option')].map((b) => b.value),
    bar: [...h.querySelectorAll('.r3-bar > button')].map((b) => b.textContent),
    stackPanel: !!P.renderStackPanel,
    noPromptInRender: !h.querySelector('.r3-prompt-in'),
    noLowerSelector: !h.querySelector('.r3-wf-pick'),
  };
}"""

RENDER = """async () => {
  const P = window.__panel;
  const st = P._r3St;
  const vw = P._modelView();
  const hist = [];
  const fa0 = window.__fetchApi;
  window.__fetchApi = async (path, opts) => {
    if (String(path).startsWith('/imageviewer/save_annotation')) { hist.push('save'); return { ok: true, status: 200, json: async () => ({ path: '/o/render_beauty_v001.png' }) }; }
    if (String(path).startsWith('/imageviewer/push')) { hist.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ shown: true }) }; }
    return fa0(path, opts);
  };
  let hiddenDuring = null;
  const rf0 = vw.renderFrame.bind(vw);
  vw.renderFrame = (f, w, hh) => { if (hiddenDuring === null) hiddenDuring = vw.canvas.style.visibility; return rf0(f, w, hh); };
  const ok = await P.previzRenderStill(st);
  vw.renderFrame = rf0;
  await new Promise((r) => setTimeout(r, 600));
  window.__fetchApi = fa0;
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
  const out = { ok, frame: st.frame, error: st.error, hist, hiddenDuring, visibleAfter: vw.canvas.style.visibility };
  for (const k of ['beauty', 'depth', 'normals', 'mask']) out[k] = st.passes && st.passes[k] ? await read(st.passes[k]) : null;
  out.dbg = { pass: st.pass, src: (P.render3dPanel.querySelector(".r3-a").getAttribute("src")||"").slice(0,30), conn: P.render3dPanel.isConnected, n: P.render3dPanel.querySelectorAll(".r3-a").length };
  out.shown = P.render3dPanel.querySelector('.r3-a').getAttribute('src') === st.passes.beauty;
  out.passBtns = [...P.render3dPanel.querySelectorAll('.r3-pass-select option')].filter((b) => !b.disabled).map((b) => b.value);
  const sel = P.render3dPanel.querySelector('.r3-pass-select');
  sel.value = 'depth'; sel.dispatchEvent(new Event('change'));
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
  P._r3StackPrimary().build();
  const caret0 = P.renderStackPanel.querySelector('.r3-stack-row .r3-caret');
  if (caret0) caret0.click();
  const S = P.renderStackPanel;
  const takes = (S.querySelector('.r3-takes') || { textContent: '' }).textContent;
  const inFold = !!S.querySelector('[data-param="wf_prompt"]');
  const prompt = S.querySelector('.r3-prompt-in');
  const placeholder = prompt.placeholder;
  prompt.value = 'a red car'; prompt.dispatchEvent(new Event('input')); prompt.dispatchEvent(new Event('change'));
  const ans = await P.previzRenderAi(st);
  window.__fetchApi = before;
  const s0 = sent[0] || {};
  const out = { ans, takes, inFold, placeholder, sentPasses: Object.keys(s0.passes || {}).sort(), sentValues: s0.values, sentFrame: s0.frame,
                pass: st.pass, aiUrl: st.ai && st.ai.url, more: Object.keys((st.ai && st.ai.more) || {}),
                passBtns: [...h.querySelectorAll('.r3-pass-select option')].map((b) => b.value),
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


REGION = """async () => {
  const P = window.__panel;
  const st = P._r3St;
  const h = P.render3dPanel;
  const view = P._modelView();
  const read = (url) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0); res({ w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data }); };
    img.onerror = () => res(null); img.src = url;
  });
  await P.previzRenderStill(st);
  const before = await read(st.passes.mask);
  // The box moves right; only the left half is rendered again.
  const box = P.previzScene().items.find((it) => it.kind === 'box' || it.shape === 'box' || it.primitive === 'box') || P.previzScene().items[0];
  box.position = [(box.position || [0, 0, 0])[0] + 0.6, ...(box.position || [0, 0, 0]).slice(1)];
  await P.previzChanged();
  h.querySelector('.r3-region-btn').click();
  st.region.box = [0, 0, 0.5, 1];
  st.draw();
  const label = h.querySelector('.r3-render').textContent;
  const sizes = [];
  const rf = view.renderFrame.bind(view);
  view.renderFrame = (f, w, hh) => { sizes.push([w, hh]); return rf(f, w, hh); };
  const ok = await P.previzRenderStill(st);
  view.renderFrame = rf;
  const after = await read(st.passes.mask);
  let leftChanged = 0, rightChanged = 0;
  for (let y = 0; y < after.h; y++) for (let x = 0; x < after.w; x++) {
    const i = (y * after.w + x) * 4;
    if (Math.abs(after.d[i] - before.d[i]) > 20) { if (x < after.w / 2) leftChanged++; else rightChanged++; }
  }
  // The full frame now, to compare: the right half would have changed too.
  st.region.on = false;
  await P.previzRenderStill(st);
  const full = await read(st.passes.mask);
  let fullRight = 0;
  for (let y = 0; y < full.h; y++) for (let x = full.w / 2; x < full.w; x++) { const i = (y * full.w + x) * 4; if (Math.abs(full.d[i] - before.d[i]) > 20) fullRight++; }
  // A region through the workflow: the crop goes, the answer comes back pasted over the frame.
  st.region = { on: true, box: [0.25, 0.25, 0.75, 0.75] };
  st.ai = null;            // no AI picture of this frame yet: the answer goes over the beauty
  const sent = [];
  const fa = window.__fetchApi;
  window.__fetchApi = async (path, opts) => {
    if (String(path).startsWith('/imageviewer/render3d_ai')) {
      sent.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ run: 'r2', graph: {}, outputs: { '9': 'out' }, main: 'out', uses: {}, seed: 1 }) };
    }
    return fa(path, opts);
  };
  P._cpAiWaitNodes = async () => ({ '9': [{ filename: 'red.png', subfolder: 'render3d/ai/r2', type: 'output' }] });
  const ans = await P.previzRenderPanelRender(st);
  window.__fetchApi = fa;
  const crop = sent[0] ? await read(sent[0].passes.beauty) : null;
  const res = await read(st.ai.url);
  const px = (im, x, y) => [...im.d.slice((y * im.w + x) * 4, (y * im.w + x) * 4 + 3)];
  return { ok, label, sizes, leftChanged, rightChanged, fullRight, ans, sentN: sent.length, prompt: sent[0] && sent[0].values,
           crop: crop && [crop.w, crop.h], res: res && [res.w, res.h], mid: res && px(res, 160, 90), corner: res && px(res, 5, 5),
           last: JSON.parse(JSON.stringify(st.mine().last || {})) };
}"""

IPR = """async () => {
  const P = window.__panel;
  const st = P._r3St;
  st.region.on = false;
  const h = P.render3dPanel;
  h.querySelector('.r3-ipr-btn').click();
  const on = h.querySelector('.r3-ipr-btn').classList.contains('on');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  while (!(st.passes && st.passes.preview) && Date.now() - t0 < 6000) await wait(100);
  const first = st.passes && st.passes.preview ? st.passes.beauty : null;
  const box = P.previzScene().items[0];
  box.position = [0, 0.3, 0];
  await P.previzChanged();
  const t1 = Date.now();
  while (st.passes && st.passes.beauty === first && Date.now() - t1 < 6000) await wait(100);
  const redrawn = !!(st.passes && st.passes.preview && st.passes.beauty !== first);
  const info = h.querySelector('.r3-info').textContent;
  h.querySelector('.r3-ipr-btn').click();
  return { on, first: !!first, redrawn, info, off: !st.ipr && !st.iprTimer };
}"""

AGENT = """async () => {
  const P = window.__panel;
  const set = await P.previzSceneAgent('render_panel_set', { prompt: 'a blue car in a red canyon', region: [0.1, 0.2, 0.6, 0.9], ai: false });
  const info = await P.previzSceneAgent('render_panel_info', {});
  P._r3StackPrimary().build();
  const fc = P.renderStackPanel.querySelector('.r3-stack-row .r3-caret');
  if (fc) fc.click();
  const field = (P.renderStackPanel.querySelector('.r3-prompt-in') || { value: '' }).value;
  const state = P.agentViewerState ? P.agentViewerState() : null;
  const r = await P.previzSceneAgent('render_panel_render', { ai: false });
  await P.previzSceneAgent('render_panel_set', { region: null });
  return { set, info: { prompt: info.prompt, region: info.region, ai: info.ai, panels: info.panels, prepared: (info.prepared || []).length },
           field, state: state && state.render_panel, render: { ok: r.ok, rendered: r.rendered } };
}"""

REFS = """async () => {
  const P = window.__panel;
  const st = P._r3St;
  const h = P.render3dPanel;
  const sent = [];
  const before = window.__fetchApi;
  window.__fetchApi = async (path, opts) => {
    if (String(path).startsWith('/imageviewer/render3d_ai')) {
      sent.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ run: 'r2', graph: {}, outputs: { '9': 'out' }, main: 'out', uses: {}, seed: 1 }) };
    }
    return before(path, opts);
  };
  P._paintQueue = async () => 'pid2';
  P._cpAiWaitNodes = async () => ({ '9': [{ filename: 'ai_ref.png', subfolder: 'render3d/ai/r2', type: 'output' }] });
  st.region = { on: false, box: null };
  P._r3Keep(st, { name: 'Two refs', source: 'file', path: 'refs.json', sig: 'y',
    graph: { '1': { class_type: 'LoadImage', inputs: { image: 'a.png' } }, '2': { class_type: 'LoadImage', inputs: { image: 'r.png' }, _meta: { title: 'comp:ref1' } },
             '3': { class_type: 'LoadImage', inputs: { image: 'r2.png' }, _meta: { title: 'comp:ref2' } },
             '9': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } } },
    inputs: [{ name: 'src', node: '1', kind: 'picture' }, { name: 'ref1', node: '2', kind: 'picture' }, { name: 'ref2', node: '3', kind: 'picture' }],
    outputs: [{ name: 'out', node: '9', kind: 'picture' }], params: [] });
  P._r3StackPrimary().build();
  const rc = P.renderStackPanel.querySelector('.r3-stack-row .r3-caret');
  if (rc) rc.click();
  const S = P.renderStackPanel;
  const emptyHint = S.querySelector('.r3-ref-hint').textContent;
  const takes = (S.querySelector('.r3-takes') || { textContent: '' }).textContent;
  P.previzRenderPanelRefs(st, { add: [{ filename: 'ref_a.png', type: 'output', subfolder: '' }, { filename: 'ref_b.png', type: 'output', subfolder: '' },
                                      { filename: 'ref_c.png', type: 'output', subfolder: '' }, { filename: 'ref_a.png', type: 'output', subfolder: '' }] });
  P._r3StackPrimary().build();
  st.draw();
  const thumbs = S.querySelectorAll('.r3-refs .r3-ref').length;
  const unused = S.querySelectorAll('.r3-refs .r3-ref.unused').length;
  const ans = await P.previzRenderAi(st);
  window.__fetchApi = before;
  const refs = (sent[0] && sent[0].refs) || [];
  S.querySelector('.r3-refs .r3-ref .r3-ref-x').click();
  P._r3StackPrimary().build();
  const afterRemove = (P.previzScene().renderAi.render3d.refs || []).map((r) => r.filename);
  const info = await P.previzSceneAgent('render_panel_info', {});
  const cleared = await P.previzSceneAgent('render_panel_set', { refs: [] });
  return { emptyHint, takes, thumbs, unused, ok: ans && ans.ok, sent: refs.length, png: refs.every((r) => r.startsWith('data:image/png;base64,')),
           afterRemove, infoRefs: info.refs, slots: info.ref_slots, cleared: cleared.refs, left: S.querySelectorAll('.r3-refs .r3-ref').length };
}"""

MENU = """async () => {
  const P = window.__panel;
  const st = P._r3St;
  const before = window.__fetchApi;
  const wf = (id, label) => ({ id, label, missing: [] });
  const edit = ['nano_banana_pro_edit', 'gpt_image_25_edit', 'flux2_klein_9b_edit'].map((id) => wf(id, id));
  for (let i = 0; i < 70; i++) edit.push(wf('other_' + i, 'Other edit ' + i));
  window.__fetchApi = async (path, opts) => {
    if (String(path).startsWith('/imageviewer/comp_ai_workflows')) return { ok: true, status: 200, json: async () => ({ workflows: [wf('comp_r3_zimage_depth', 'Z'), wf('comp_r3_qwen2511', 'Q'), wf('comp_r3_gpt25', 'G')] }) };
    if (String(path).startsWith('/imageviewer/paint/workflows')) return { ok: true, status: 200, json: async () => ({ actions: {
      edit: { workflows: edit }, upscale: { workflows: [wf('seedvr2_7b', 'SeedVR2'), wf('topaz_x', 'Topaz')] } } }) };
    return before(path, opts);
  };
  const btn = P.render3dPanel.querySelector('.r3-render');
  await P._r3PickMenu(st, btn);
  window.__fetchApi = before;
  const menu = P._previzAddMenu;
  const top = [...menu.querySelectorAll(':scope > .previz-menu-item, :scope > .previz-menu-subwrap > .previz-menu-item')].map((b) => b.textContent);
  const heads = [...menu.querySelectorAll(':scope > .previz-menu-head')].map((b) => b.textContent);
  const moreBtn = [...menu.querySelectorAll('.previz-menu-subwrap > .previz-menu-item')].find((b) => b.textContent.startsWith('More workflows'));
  moreBtn.click();
  const sub = moreBtn.parentElement.querySelector('.previz-submenu');
  const host = P._previzMenuHost().getBoundingClientRect(), r = sub.getBoundingClientRect();
  const html = JSON.stringify([...menu.children].map((c) => c.tagName + '.' + c.className + ':' + (c.firstChild && c.firstChild.textContent || '')));
  const out = { html, seps: menu.querySelectorAll(':scope > .previz-menu-sep').length, top, heads, more: moreBtn.textContent, subItems: sub.querySelectorAll('.previz-menu-item').length,
                scroll: sub.classList.contains('scroll'), scrolls: sub.scrollHeight > sub.clientHeight + 10,
                inside: r.top >= host.top - 1 && r.bottom <= host.bottom + 1 };
  P._previzCloseAddMenu();
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
            red = os.path.join(ROOT, "tests", "harness", "_r3_red.png")
            from PIL import Image
            Image.new("RGB", (64, 64), (255, 0, 0)).save(red)
            pg.route("**/view?*", lambda route: route.fulfill(path=red, content_type="image/png"))
            region = pg.evaluate(REGION)
            if shots:
                pg.evaluate("() => { const P = window.__panel; P._r3St.region = { on: true, box: [0.25, 0.25, 0.75, 0.75] }; P._r3St.pass = 'ai'; P._r3St.draw(); }")
                pg.wait_for_timeout(300)
                pg.screenshot(path=os.path.join(shots, "render-panel-region.png"))
            ipr = pg.evaluate(IPR)
            agent = pg.evaluate(AGENT)
            refs = pg.evaluate(REFS)
            menu = pg.evaluate(MENU)
            if shots:
                pg.evaluate("() => { const P = window.__panel; P._r3St.region.on = false; P._r3St.pass = 'beauty'; P._r3St.draw(); }")
                pg.wait_for_timeout(300)
                h = pg.evaluate("() => { const r = window.__panel.render3dPanel.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }")
                pg.screenshot(path=os.path.join(shots, "render-panel-bar.png"),
                              clip={"x": h[0], "y": h[1], "width": max(10, h[2]), "height": max(10, h[3])})
        finally:
            if os.path.exists(os.path.join(ROOT, "tests", "harness", "_r3_red.png")):
                os.remove(os.path.join(ROOT, "tests", "harness", "_r3_red.png"))
            pg.close()
        self.assertTrue(opened["docked"], "Render… opens the Render panel")
        self.assertFalse(opened["oldDialog"], "no dialog over the viewer any more")
        self.assertTrue(opened["form"] and opened["settingsOpen"], "the settings are in a floating window")
        self.assertFalse(opened["inPanel"], "no settings fold in the panel itself")
        self.assertEqual(opened["shotBtn"], "Save settings")
        self.assertTrue(opened["renderBtn"])
        self.assertEqual(opened["bar"][:5], ["Render", "AI", "IPR", "Region", "Settings"])
        self.assertTrue(opened["stackPanel"], "the AI Render Stack is a panel of its own")
        self.assertTrue(opened["noPromptInRender"], "the prompt left the Render panel for the stack")
        self.assertTrue(opened["noLowerSelector"], "the lower workflow selector is gone")
        self.assertEqual(opened["passes"], ["beauty", "depth", "normals", "mask"])
        self.assertTrue(r["ok"], r["error"])
        self.assertEqual(r["hiddenDuring"], "hidden", "the viewport canvas is taken off screen while a render owns it")
        self.assertEqual(r["visibleAfter"], "", "and is back afterwards")
        self.assertEqual(r["hist"][0], "save", "the render is saved...")
        self.assertEqual(r["hist"][1]["group"], "3D renders", "...and goes into the History")
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
        self.assertFalse(ai["inFold"], "the prompt is not a second field in the workflow's settings")
        self.assertIn("clay", ai["placeholder"], "the workflow's own prompt is named while the field is empty")
        self.assertEqual(ai["pass"], "ai")
        self.assertIn("ai_out.png", ai["aiUrl"])
        self.assertEqual(ai["more"], ["lines"])
        self.assertEqual(ai["passBtns"][-2:], ["ai", "ai:lines"])
        kept = ai["kept"]["render3d"]
        self.assertEqual(kept["custom"]["name"], "My look")
        self.assertEqual(kept["prompt"], "a red car")
        self.assertEqual(kept["last"]["main"]["filename"], "ai_out.png")
        self.assertTrue(ai["wipe"]["on"] and ai["wipe"]["a"] and ai["wipe"]["b"])
        self.assertIn("inset", ai["wipe"]["clip"])
        self.assertTrue(ai["second"])
        self.assertFalse(ai["secondHasWorkflow"], "a second panel starts without the first one's workflow")
        # Region render: only the box is rendered (at the box's size) and pasted into the frame.
        self.assertTrue(region["ok"])
        self.assertEqual(region["label"], "Render region")
        self.assertIn([160, 180], region["sizes"], region["sizes"])
        self.assertGreater(region["leftChanged"], 50, "the moved box shows in the region")
        self.assertEqual(region["rightChanged"], 0, "outside the region the old render stays")
        self.assertGreater(region["fullRight"], 50, "a whole render would have changed the right half too")
        self.assertTrue(region["ans"] and region["ans"]["ok"], region["ans"])
        self.assertEqual(region["crop"], [160, 90], "the workflow gets the region's crop")
        self.assertEqual(region["res"], [320, 180], "its answer is pasted back into the whole frame")
        self.assertEqual(region["mid"], [255, 0, 0])
        self.assertNotEqual(region["corner"], [255, 0, 0], "outside the region the picture is what it was")
        self.assertEqual(region["last"]["region"], [0.25, 0.25, 0.75, 0.75])
        self.assertEqual(region["prompt"], {"wf_prompt": "a red car"})
        # IPR: a preview whenever the scene changes.
        self.assertTrue(ipr["on"] and ipr["first"] and ipr["redrawn"], ipr)
        self.assertIn("preview", ipr["info"])
        self.assertTrue(ipr["off"])
        # The agent reads and writes the prompt, the region, AI, and renders.
        self.assertEqual(agent["info"]["prompt"], "a blue car in a red canyon")
        self.assertEqual(agent["field"], "a blue car in a red canyon")
        self.assertEqual(agent["info"]["region"], [0.1, 0.2, 0.6, 0.9])
        self.assertFalse(agent["info"]["ai"])
        self.assertIn("render3d", agent["info"]["panels"])
        self.assertTrue(agent["render"]["ok"])
        if agent["state"] is not None:
            self.assertEqual(agent["state"]["prompt"], "a blue car in a red canyon")
        # Reference pictures: kept on the panel, sent as data URLs for the ref loaders the workflow has.
        self.assertIn("up to 2 reference pictures", refs["emptyHint"])
        self.assertIn("ref1", refs["takes"])
        self.assertEqual(refs["thumbs"], 3, "a picture added twice is kept once")
        self.assertEqual(refs["unused"], 1, "the third is more than the workflow takes")
        self.assertTrue(refs["ok"])
        self.assertEqual(refs["sent"], 2, "only as many as the workflow takes are sent")
        self.assertTrue(refs["png"])
        self.assertEqual(refs["afterRemove"], ["ref_b.png", "ref_c.png"])
        self.assertEqual(refs["infoRefs"], ["ref_b.png", "ref_c.png"])
        self.assertEqual(refs["slots"], 2)
        self.assertEqual(refs["cleared"], [])
        self.assertEqual(refs["left"], 0)
        # The workflow menu: the main models, the rest in one submenu that scrolls inside the viewer.
        self.assertEqual(menu["heads"], ["Realistic render", "Edit the picture", "Upscale"])
        self.assertIn("nano_banana_pro_edit", menu["top"], menu["html"])
        self.assertNotIn("", menu["top"], "a separator is a line, not an empty row")
        self.assertEqual(menu["seps"], 2)
        self.assertIn("SeedVR2", menu["top"])
        self.assertNotIn("Topaz", menu["top"])
        self.assertFalse(any(t.startswith("Other edit") for t in menu["top"]), "the long list is not in the menu itself")
        self.assertEqual(menu["more"], "More workflows (71)")
        self.assertEqual(menu["subItems"], 71)
        self.assertTrue(menu["scroll"] and menu["scrolls"], menu)
        self.assertTrue(menu["inside"], menu)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
