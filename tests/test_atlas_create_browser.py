"""New Atlas world and Chisel this view, in a real browser: the 3D space's bar and Previz panel open the dialog, a History
selection comes in as pictures, Create posts to /imageviewer/atlas_create and follows the job.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html); the viewer server's routes are
answered by a stand-in for window.__fetchApi. Needs Playwright and node; skipped without them.
Run: python -m unittest tests.test_atlas_create_browser
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
SHOTS = os.environ.get("ATLAS_CREATE_SHOTS", "")

STUB = """() => {
  const real = window.__fetchApi;
  window.__atlasCalls = [];
  let polls = 0;
  window.__fetchApi = async (p, opts) => {
    if (p.startsWith('/imageviewer/atlas_create')) {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      window.__atlasCalls.push([p, body]);
      const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (body) return ok({ ok: true, id: 'j1', state: 'running' });
      polls += 1;
      return ok(polls < 2 ? { id: 'j1', state: 'running', phase: 'Atlas is placing the pictures in 3D', elapsed: 3 }
                          : { id: 'j1', state: 'done', name: body ? '' : 'room', glb: 'D:/o/room/world.glb', tab: 'previz:atlas_room' });
    }
    return real(p, opts);
  };
}"""


UPLOAD_STUB = """() => {
  const real = window.__fetchApi;
  window.__uploads = [];
  window.__fetchApi = async (p, opts) => {
    if (p === '/imageviewer/timeline_upload') {
      const f = opts.body.get('file');
      window.__uploads.push(f.name);
      if (/^chisel_mask_/.test(f.name)) {
        const bm = await createImageBitmap(f);
        const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
        const g = c.getContext('2d'); g.drawImage(bm, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let white = 0, black = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i] > 200) white++; else if (d[i] < 50) black++; }
        window.__maskStats = { w: c.width, h: c.height, white, black };
      }
      return new Response(JSON.stringify({ path: 'D:/in/edits/' + f.name, name: f.name }), { status: 200 });
    }
    return real(p, opts);
  };
}"""

# Files dropped as Windows Explorer drops them: a DataTransfer of Files, dragenter / dragover / drop on `target`.
DROP_FILES = """() => {
  const target = %s;
  const dt = new DataTransfer();
  for (const n of %s) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], n, { type: n.endsWith('.png') ? 'image/png' : 'text/plain' }));
  const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt };
  target.dispatchEvent(new DragEvent('dragenter', opts));
  target.dispatchEvent(new DragEvent('dragover', opts));
  const drop = new DragEvent('drop', opts);
  target.dispatchEvent(drop);
  return drop.defaultPrevented;
}"""

CHISEL_STUB = """() => {
  const real = window.__fetchApi;
  window.__atlasCalls = [];
  let polls = 0;
  window.__fetchApi = async (p, opts) => {
    if (p.startsWith('/imageviewer/atlas_chisel')) {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      window.__atlasCalls.push([p, body]);
      const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (body) return ok({ ok: true, id: 'c1', state: 'running' });
      polls += 1;
      return ok(polls < 2 ? { id: 'c1', state: 'running', phase: 'Atlas is changing the masked part', elapsed: 4 }
                          : { id: 'c1', state: 'done', path: 'D:/o/court/chisel/chisel_001.png' });
    }
    return real(p, opts);
  };
}"""

# An Atlas world "open" in a 3D tab: the harness has no three.js, so the view is a stand-in with the parts
# captureCamera and the snapshot use (the camera's matrices, the world's body, a 1280 x 720 picture).
FAKE_WORLD = """() => {
  const P = window.__panel;
  P.setViewerToggleState(true);
  const m = (e) => ({ elements: e });
  const cam = { fov: 50, aspect: 1.6, matrixWorld: m([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,1.6,4,1]), updateMatrixWorld() {} };
  const body = { matrixWorld: m([2,0,0,0, 0,2,0,0, 0,0,2,0, 0,0,0,1]), updateWorldMatrix() {} };
  const picture = () => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 430); sky.addColorStop(0, '#6d9fd6'); sky.addColorStop(1, '#d9e6ef');
    g.fillStyle = sky; g.fillRect(0, 0, 1280, 430);
    const lawn = g.createLinearGradient(0, 430, 0, 720); lawn.addColorStop(0, '#6f8f45'); lawn.addColorStop(1, '#3f5a26');
    g.fillStyle = lawn; g.fillRect(0, 430, 1280, 290);
    g.fillStyle = '#8b8378'; g.fillRect(140, 250, 330, 190); g.fillRect(860, 220, 300, 220);
    g.fillStyle = '#5a4a3a'; g.fillRect(560, 500, 170, 26); g.fillRect(575, 526, 12, 34); g.fillRect(703, 526, 12, 34);
    g.fillStyle = '#2f4a22'; for (const x of [90, 520, 790, 1210]) { g.beginPath(); g.arc(x, 400, 70, 0, 7); g.fill(); }
    return c.toDataURL('image/png');
  };
  // The same scene as depth (what renderDepth gives): the lawn running off to the horizon, two buildings, the
  // bench, nothing in the sky. The world is drawn at twice its size (body scale 2).
  const depth = (W, H) => {
    const d = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const Y = y * 720 / H, X = x * 1280 / W;
      let z = Y > 432 ? 1.6 * 900 / (Y - 430) : 0;
      if ((X > 140 && X < 470 && Y > 250 && Y < 440) || (X > 860 && X < 1160 && Y > 220 && Y < 440)) z = 30;
      if (X > 560 && X < 730 && Y > 500 && Y < 560) z = 7;
      d[y * W + x] = Math.min(z, 80);
    }
    return { w: W, h: H, data: d };
  };
  window.__depthCalls = 0;
  const view = { scene3d: { activeCamera: null }, _entries: new Map([['w', { item: null }]]), _walk: false,
                 activeCameraObject: () => cam, _bodyOf: () => body,
                 beginRender: () => true, renderFrame: () => picture(),
                 renderDepth: (w, h) => { window.__depthCalls++; return depth(w, h); }, endRender() {} };
  P.isPrevizTab = () => true;
  P.previzAtlasItem = () => ({ id: 'w', kind: 'model', src: { path: 'D:/o/court/world.glb' } });
  P._modelView = () => view;
  window.__shown = [];
  P.previzAtlasShow = async (state, world, label) => { window.__shown.push([state.path, world, label]); return 'shown'; };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class AtlasCreateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA="1")
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
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        # The harness serves no three.js: a 3D tab's viewport cannot load here, which is not what is tested.
        pg.on("pageerror", lambda e: None if "/imageviewer/lib/three/" in str(e) else self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("() => localStorage.clear()")
        return pg

    def test_the_dialog_from_the_3d_space_sends_prompt_and_pictures(self):
        pg = self.page()
        pg.evaluate(STUB)
        pg.evaluate("""async () => {
          const P = window.__panel;
          const { app } = await import('/scripts/app.js');   // the stand-in's graph is empty
          app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
          P.setViewerToggleState(true);
          P.updateData({ unique_id: '50', tab_name: 'agentY', tabs: { tab: [
            { path: 'D:/out/room.png', filename: 'room.png', type: 'output' }] } }, null);
          P.startHistorySelection('all', 0);
          P.spaceOpen('3d');
        }""")
        # The Previz panel's Atlas menu is there on any 3D tab; its first entry is New Atlas world.
        has_btn = pg.evaluate("""() => !!window.__panel.shadowRoot.querySelector('.previz-btn.previz-atlas-menu')""")
        self.assertTrue(has_btn)
        pg.evaluate("""() => window.__panel.shadowRoot.querySelector('.previz-btn.previz-atlas-menu').click()""")
        pg.evaluate("""() => [...window.__panel.shadowRoot.querySelectorAll('.previz-menu .previz-menu-item')]
                          .find((b) => b.textContent.startsWith('New Atlas world')).click()""")
        root = "window.__panel.shadowRoot"
        pg.wait_for_function(f"() => !!{root}.querySelector('.atlas-create')")
        st = pg.evaluate(f"""() => {{
          const d = {root}.querySelector('.atlas-create');
          return {{ chips: d.querySelectorAll('.atlas-pic').length, name: d.querySelector('.atlas-name').value,
                    aspectOff: d.querySelector('.atlas-aspect').disabled,
                    visible: d.getBoundingClientRect().width > 300 }};
        }}""")
        self.assertEqual((st["chips"], st["name"], st["aspectOff"], st["visible"]), (1, "room", True, True))
        prompt = pg.evaluate_handle(f"() => {root}.querySelector('.atlas-prompt')")
        prompt.as_element().fill("a cosy living room at dusk")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "new-atlas-world.png"))
        pg.evaluate(f"() => {root}.querySelector('.atlas-create .rd-go').click()")
        pg.wait_for_function(f"() => !{root}.querySelector('.atlas-create')", timeout=15000)
        calls = pg.evaluate("() => window.__atlasCalls")
        post = next(c for c in calls if c[1])
        self.assertEqual(post[0], "/imageviewer/atlas_create")
        self.assertEqual(post[1]["images"], [{"path": "D:/out/room.png"}])
        self.assertEqual(post[1]["prompt"], "a cosy living room at dusk")
        self.assertEqual(post[1]["name"], "cosy_living_room_dusk")
        self.assertTrue(any(c[0].startswith("/imageviewer/atlas_create?id=j1") for c in calls))
        self.assertEqual(self.errors, [])

    def test_the_3d_menu_opens_it_on_any_tab_with_a_prompt_only(self):
        pg = self.page()
        pg.evaluate(STUB)
        pg.evaluate("() => { window.__panel.setViewerToggleState(true); window.__panel.atlasCreateDialog(); }")
        root = "window.__panel.shadowRoot"
        st = pg.evaluate(f"""() => {{
          const d = {root}.querySelector('.atlas-create');
          return {{ go: d.querySelector('.rd-go').disabled, aspectOff: d.querySelector('.atlas-aspect').disabled }};
        }}""")
        self.assertEqual(st, {"go": True, "aspectOff": False}, "nothing to make yet; the aspect ratio is offered")
        pg.evaluate(f"() => {{ const t = {root}.querySelector('.atlas-prompt'); t.value = 'a beach'; t.dispatchEvent(new Event('input')); }}")
        self.assertFalse(pg.evaluate(f"() => {root}.querySelector('.atlas-create .rd-go').disabled"))
        pg.keyboard.press("Escape")
        self.assertFalse(pg.evaluate(f"() => !!{root}.querySelector('.atlas-create')"))
        self.assertEqual(self.errors, [])


    def test_the_echo_engine_takes_one_picture_and_sends_its_own_choices(self):
        """SpAItial Echo, the second world generator: the same dialog, Engine: Echo."""
        pg = self.page()
        pg.evaluate(STUB)
        pg.evaluate("""async () => {
          const P = window.__panel;
          const { app } = await import('/scripts/app.js');
          app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
          P.setViewerToggleState(true);
          P.updateData({ unique_id: '51', tab_name: 'agentY', tabs: { tab: [
            { path: 'D:/out/a.png', filename: 'a.png', type: 'output' },
            { path: 'D:/out/b.png', filename: 'b.png', type: 'output' }] } }, null);
          P.startHistorySelection('all', 0);
          P.spaceOpen('3d');
        }""")
        root = "window.__panel.shadowRoot"
        pg.evaluate(f"""() => {{ {root}.querySelector('.previz-btn.previz-atlas-menu').click();
          [...{root}.querySelectorAll('.previz-menu .previz-menu-item')]
            .find((b) => b.textContent.startsWith('New Echo world')).click(); }}""")
        pg.wait_for_function(f"() => !!{root}.querySelector('.atlas-create.atlas-dlg .engine-echo')")
        pg.keyboard.press("Escape")
        # Two pictures in an Atlas dialog, then Engine: Echo - which takes one.
        pg.evaluate(f"""() => {{ window.__panel.atlasCreateDialog({{ engine: 'atlas', images: [
            {{ path: 'D:/out/a.png', name: 'a.png' }}, {{ path: 'D:/out/b.png', name: 'b.png' }}] }});
          const sel = {root}.querySelector('.atlas-create .atlas-engine');
          sel.value = 'echo'; sel.dispatchEvent(new Event('change')); }}""")
        st = pg.evaluate(f"""() => {{
          const d = {root}.querySelector('.atlas-create');
          const shown = (s) => getComputedStyle(d.querySelector(s)).display !== 'none';
          return {{ title: d.querySelector('.rd-title').textContent, engine: d.querySelector('.atlas-engine').value,
                    chips: d.querySelectorAll('.atlas-pic').length, go: d.querySelector('.rd-go').disabled,
                    warn: d.querySelector('.rd-hint').classList.contains('warn'),
                    aspect: shown('.atlas-aspect'), model: shown('.echo-model'), mesh: shown('.echo-mesh') }};
        }}""")
        self.assertEqual(st, {"title": "New Echo world", "engine": "echo", "chips": 2, "go": True, "warn": True,
                              "aspect": False, "model": True, "mesh": True}, "two pictures: Echo takes one")
        pg.evaluate(f"() => {root}.querySelectorAll('.atlas-create .atlas-pic-x')[1].click()")
        st = pg.evaluate(f"""() => {{ const d = {root}.querySelector('.atlas-create');
          return {{ go: d.querySelector('.rd-go').disabled, promptOff: d.querySelector('.atlas-prompt').disabled,
                    pano: d.querySelector('.echo-pano').disabled }}; }}""")
        self.assertEqual(st, {"go": False, "promptOff": True, "pano": False})
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "new-echo-world.png"))
        pg.evaluate(f"""() => {{ const d = {root}.querySelector('.atlas-create');
          const set = (s, v) => {{ const n = d.querySelector(s); n.value = v; n.dispatchEvent(new Event('change')); }};
          set('.echo-model', 'echo-hq'); set('.echo-pano', 'true'); set('.echo-mesh', 'mesh-simplified');
          d.querySelector('.rd-go').click(); }}""")
        pg.wait_for_function(f"() => !{root}.querySelector('.atlas-create')", timeout=15000)
        post = next(c for c in pg.evaluate("() => window.__atlasCalls") if c[1])
        self.assertEqual(post[1], {"engine": "echo", "name": "a", "prompt": "", "images": [{"path": "D:/out/a.png"}],
                                   "model": "echo-hq", "is_pano": "true", "mesh": "mesh-simplified"})
        # The engine is remembered: the next dialog opens on Echo.
        pg.evaluate("() => window.__panel.atlasCreateDialog()")
        self.assertEqual(pg.evaluate(f"() => {root}.querySelector('.atlas-create .atlas-engine').value"), "echo")
        self.assertEqual(self.errors, [])

    def test_pictures_dropped_from_explorer_come_into_the_new_world_dialog(self):
        pg = self.page()
        pg.evaluate(STUB)
        pg.evaluate(UPLOAD_STUB)
        pg.evaluate("() => { window.__panel.setViewerToggleState(true); window.__panel.atlasCreateDialog(); }")
        root = "window.__panel.shadowRoot"
        self.assertTrue(pg.evaluate(f"() => !!{root}.querySelector('.atlas-create .atlas-dropzone')"))
        pg.evaluate(DROP_FILES % (f"{root}.querySelector('.atlas-create .atlas-composer')", "['beach.png', 'notes.txt']"))
        pg.wait_for_function(f"() => {root}.querySelectorAll('.atlas-create .atlas-pic').length === 1")
        self.assertEqual(pg.evaluate("() => window.__uploads"), ["beach.png"], "only the picture is copied in")
        self.assertEqual(pg.evaluate(f"() => {root}.querySelector('.atlas-create .atlas-name').value"), "beach")
        self.assertEqual(self.errors, [])

    def test_the_new_world_dialog_leaves_the_history_usable_and_takes_a_thumbnail_dragged_in(self):
        pg = self.page()
        pg.evaluate(STUB)
        pg.evaluate("""async () => {
          const P = window.__panel;
          const { app } = await import('/scripts/app.js');
          app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
          P.setViewerToggleState(true);
          P.updateData({ unique_id: '50', tab_name: 'agentY', tabs: { tab: [
            { path: 'D:/out/room.png', filename: 'room.png', type: 'output' }] } }, null);
          P.spaceOpen('3d');
          if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
          P.atlasCreateDialog({ images: [] });
        }""")
        root = "window.__panel.shadowRoot"
        pg.wait_for_function(f"() => !!{root}.querySelector('.atlas-create .rd-box')")
        # Nothing covers the viewer: the History thumbnail is what is under the pointer, not a backdrop.
        hit = pg.evaluate(f"""() => {{
          const t = {root}.querySelector('#history-strip .history-thumb');
          if (!t) return 'no thumb';
          const r = t.getBoundingClientRect();
          const el = {root}.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return t.contains(el) ? 'thumb' : (el ? el.tagName + '.' + el.className : 'none');
        }}""")
        self.assertEqual(hit, "thumb")
        # The thumbnail dragged onto the dialog becomes one of its pictures.
        centre = """(el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"""
        a = pg.evaluate(f"() => ({centre})({root}.querySelector('#history-strip .history-thumb'))")
        b = pg.evaluate(f"() => ({centre})({root}.querySelector('.atlas-create .atlas-dropzone'))")
        pg.mouse.move(*a)
        pg.mouse.down()
        pg.mouse.move(a[0] + 10, a[1] + 10, steps=3)
        pg.mouse.move(*b, steps=10)
        pg.mouse.up()
        pg.wait_for_function(f"() => {root}.querySelectorAll('.atlas-create .atlas-pic').length === 1", timeout=5000)
        # The header moves the box.
        before = pg.evaluate(f"() => {root}.querySelector('.atlas-create-box').getBoundingClientRect().left")
        head = pg.evaluate(f"""() => {{ const r = {root}.querySelector('.atlas-create .rd-title').getBoundingClientRect();
                                         return [r.left + 5, r.top + r.height / 2]; }}""")
        pg.mouse.move(*head)
        pg.mouse.down()
        pg.mouse.move(head[0] - 200, head[1] + 40, steps=5)
        pg.mouse.up()
        after = pg.evaluate(f"() => {root}.querySelector('.atlas-create-box').getBoundingClientRect().left")
        self.assertAlmostEqual(after, before - 200, delta=3)
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "new-atlas-world-floating.png"))
        self.assertEqual(self.errors, [])

    def test_chisel_this_view_paints_a_mask_on_the_view_and_sends_it(self):
        pg = self.page()
        pg.evaluate(CHISEL_STUB)
        pg.evaluate(UPLOAD_STUB)
        pg.evaluate(FAKE_WORLD)
        root = "window.__panel.shadowRoot"
        pg.evaluate("() => window.__panel.atlasChiselDialog()")
        pg.wait_for_function(f"() => !!{root}.querySelector('.atlas-chisel')")
        go = f"{root}.querySelector('.atlas-chisel .rd-go')"
        self.assertEqual(pg.evaluate(f"() => [{go}.textContent, {go}.disabled]"), ["Paint the view", True])
        pg.evaluate(f"""() => [...{root}.querySelectorAll('.atlas-chisel .rd-btn')].find((b) => b.textContent === 'Use this view').click()""")
        self.assertEqual(pg.evaluate("() => window.__depthCalls"), 2, "depth on opening, and again with the view")
        pg.wait_for_function(f"() => {root}.querySelector('.atlas-stage-mask').width === 1280")
        box = pg.evaluate(f"""() => {{ const r = {root}.querySelector('.atlas-stage-mask').getBoundingClientRect();
                                       return [r.left, r.top, r.width, r.height]; }}""")
        x0, y0, w, h = box
        pg.mouse.move(x0 + w * 0.42, y0 + h * 0.70)
        pg.mouse.down()
        for i in range(12):
            pg.mouse.move(x0 + w * (0.42 + i * 0.012), y0 + h * (0.70 - (i % 3) * 0.02))
        pg.mouse.up()
        pg.evaluate_handle(f"() => {root}.querySelector('.atlas-chisel-prompt')").as_element().fill(
            "an old stone fountain on the lawn")
        self.assertEqual(pg.evaluate(f"() => {go}.textContent"), "Change the painted part")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "chisel-this-view.png"))
        pg.evaluate(f"() => {go}.click()")
        pg.wait_for_function(f"() => !{root}.querySelector('.atlas-chisel')", timeout=15000)
        ups = pg.evaluate("() => window.__uploads")
        self.assertEqual(len(ups), 2)
        self.assertTrue(ups[0].startswith("chisel_view_") and ups[1].startswith("chisel_mask_"), ups)
        mask = pg.evaluate("() => window.__maskStats")
        self.assertEqual((mask["w"], mask["h"]), (1280, 720))
        self.assertGreater(mask["white"], 0)
        self.assertGreater(mask["black"], mask["white"], "only the painted part is white")
        post = next(c for c in pg.evaluate("() => window.__atlasCalls") if c[1])
        self.assertEqual(post[0], "/imageviewer/atlas_chisel")
        b = post[1]
        self.assertEqual((b["world_path"], b["prompt"], b["image"]["path"].split("/")[-1][:12],
                          b["mask"]["path"].split("/")[-1][:12], b["camera"]["gated"], round(b["camera"]["aspect"], 4),
                          b["context"], b["seed"]),
                         ("D:/o/court/world.glb", "an old stone fountain on the lawn", "chisel_view_", "chisel_mask_",
                          True, round(16 / 9, 4), True, -1))
        self.assertEqual(len(b["camera"]["camera_world"]), 16)
        self.assertEqual((b["depth"]["w"], b["depth"]["h"], b["voxel_size"]), (1280, 720, 0))
        self.assertEqual(pg.evaluate("() => window.__shown"), [["D:/o/court/chisel/chisel_001.png", "court", "Atlas chisel"]])
        self.assertEqual(self.errors, [])

    def test_chisel_takes_a_picture_dropped_from_explorer_and_needs_a_world(self):
        pg = self.page()
        pg.evaluate(CHISEL_STUB)
        pg.evaluate(UPLOAD_STUB)
        root = "window.__panel.shadowRoot"
        pg.evaluate("() => { window.__panel.setViewerToggleState(true); window.__panel.atlasChiselDialog(); }")
        self.assertFalse(pg.evaluate(f"() => !!{root}.querySelector('.atlas-chisel')"), "no world, no dialog")
        pg.evaluate(FAKE_WORLD)
        pg.evaluate("() => window.__panel.atlasChiselDialog()")
        pg.evaluate(DROP_FILES % (f"{root}.querySelector('.atlas-stage')", "['render.png']"))
        pg.wait_for_function(f"() => {root}.querySelector('.atlas-stage').classList.contains('has-pic')")
        go = f"{root}.querySelector('.atlas-chisel .rd-go')"
        pg.evaluate_handle(f"() => {root}.querySelector('.atlas-chisel-prompt')").as_element().fill("at night")
        self.assertEqual(pg.evaluate(f"() => {go}.textContent"), "Repaint the picture")
        pg.evaluate(f"() => {go}.click()")
        pg.wait_for_function(f"() => !{root}.querySelector('.atlas-chisel')", timeout=15000)
        b = next(c for c in pg.evaluate("() => window.__atlasCalls") if c[1])[1]
        self.assertEqual(b["image"], {"path": "D:/in/edits/render.png"})
        self.assertNotIn("mask", b)
        self.assertIn("depth", b, "the geometry goes along with a picture too")
        self.assertEqual(pg.evaluate("() => window.__uploads"), ["render.png"])
        self.assertEqual(self.errors, [])

    def test_chisel_paints_on_the_scene_geometry_without_a_picture(self):
        pg = self.page()
        pg.evaluate(CHISEL_STUB)
        pg.evaluate(UPLOAD_STUB)
        pg.evaluate(FAKE_WORLD)
        root = "window.__panel.shadowRoot"
        pg.evaluate("() => window.__panel.atlasChiselDialog()")
        pg.wait_for_function(f"() => !!{root}.querySelector('.atlas-chisel')")
        stage = f"{root}.querySelector('.atlas-stage')"
        self.assertTrue(pg.evaluate(f"() => {stage}.classList.contains('has-depth')"), "the depth is shown")
        self.assertEqual(pg.evaluate(f"() => {root}.querySelector('.atlas-stage-depth').width"), 1280)
        go = f"{root}.querySelector('.atlas-chisel .rd-go')"
        pg.evaluate_handle(f"() => {root}.querySelector('.atlas-chisel-prompt')").as_element().fill(
            "a sunlit cloister courtyard with a stone fountain")
        geo = f"{root}.querySelector('.atlas-geo input[type=checkbox]')"
        pg.evaluate(f"() => {{ {geo}.click(); }}")
        self.assertEqual(pg.evaluate(f"() => [{go}.disabled, {stage}.classList.contains('has-depth')]"), [True, False],
                         "no geometry, no picture: nothing to build on")
        pg.evaluate(f"() => {{ {geo}.click(); }}")
        pg.evaluate(f"""() => {{ const v = {root}.querySelector('.atlas-voxel'); v.value = '0.1';
                                 v.dispatchEvent(new Event('input')); }}""")
        self.assertEqual(pg.evaluate(f"() => [{go}.textContent, {go}.disabled]"), ["Paint the view", False])
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "chisel-on-geometry.png"))
        pg.evaluate(f"() => {go}.click()")
        pg.wait_for_function(f"() => !{root}.querySelector('.atlas-chisel')", timeout=15000)
        b = next(c for c in pg.evaluate("() => window.__atlasCalls") if c[1])[1]
        self.assertNotIn("image", b)
        self.assertEqual((b["depth"]["w"], b["depth"]["h"], b["voxel_size"], round(b["camera"]["aspect"], 4)),
                         (1280, 720, 0.1, round(16 / 9, 4)))
        z = pg.evaluate("""(s) => { const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
                                     const f = new Float32Array(b.buffer); return [f[0], f[600 * 1280 + 100], f[530 * 1280 + 640]]; }""",
                        b["depth"]["data"])
        self.assertEqual(z[0], 0, "sky: nothing")
        self.assertAlmostEqual(z[2], 3.5, places=4)              # the bench: 7 scene units = 3.5 world-mesh units
        self.assertEqual(pg.evaluate("() => window.__uploads"), [], "nothing to upload")
        self.assertEqual(self.errors, [])


    def test_the_atlas_menu_has_every_atlas_tool_and_the_3d_bar_menu_has_it_as_a_submenu(self):
        pg = self.page()
        pg.evaluate("""async () => {
          const P = window.__panel;
          const { app } = await import('/scripts/app.js');
          app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
          P.setViewerToggleState(true);
          P.spaceOpen('3d');
          P.previzAtlasItem = () => ({ id: 'w', kind: 'model', src: { path: 'D:/o/court/world.glb' } });
        }""")
        root = "window.__panel.shadowRoot"
        labels = pg.evaluate(f"""() => {{ {root}.querySelector('.previz-btn.previz-atlas-menu').click();
          return [...{root}.querySelectorAll('.previz-menu .previz-menu-item')].map((b) => b.textContent.trim()
            + (b.classList.contains('off') ? ' (off)' : '')); }}""")
        # The menu bar's World menu: walking and notes first, then the Atlas tools under their heading.
        labels = labels[labels.index("Atlas (off)") + 1:]
        self.assertEqual(labels, ["New Atlas world\u2026", "New Echo world\u2026", "Render view with Atlas\u2026",
                                  "Chisel this view\u2026",
                                  "Auto-orient world", "\u2713 Show views", "Show as point cloud", "Camera from view",
                                  "Rebuild mesh", "Export Gaussian splat\u2026"])
        pg.keyboard.press("Escape")
        # The bar's 3D menu: one "Atlas" row, whose submenu is the same list.
        sub = pg.evaluate(f"""() => {{
          const b = [...{root}.querySelectorAll('.bar-group')].find((x) => /^3D/.test(x.title || ''));
          b.click();
          const row = [...{root}.querySelectorAll('.bar-menu .previz-menu-item.has-sub')].find((x) => x.textContent.trim() === 'Atlas');
          if (!row) return null;
          row.click();
          const menu = row.parentNode.querySelector('.previz-submenu');
          return {{ shown: getComputedStyle(menu).display !== 'none',
                    items: [...menu.querySelectorAll('.previz-menu-item')].map((x) => x.textContent.trim()) }};
        }}""")
        self.assertIsNotNone(sub)
        self.assertTrue(sub["shown"])
        self.assertEqual(sub["items"][0], "New Atlas world\u2026")
        self.assertIn("Export Gaussian splat\u2026", sub["items"])
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, "atlas-submenu.png"))
        # Old bar entries are gone: Atlas lives only in its submenu.
        top = pg.evaluate(f"() => [...{root}.querySelectorAll('.bar-menu > .previz-menu-item')].map((x) => x.textContent.trim())")
        self.assertNotIn("New Atlas world\u2026", top)
        self.assertEqual(self.errors, [])

    def test_auto_orient_stands_the_world_up_and_carries_the_camera_along(self):
        pg = self.page()
        out = pg.evaluate("""async () => {
          const P = window.__panel;
          const S = await import('/extensions/viewer/imageViewer_scene3d.js');
          const O = await import('/extensions/viewer/imageViewer_atlasOrient.js');
          // A 3D tab holding the world and its camera, and a mesh whose floor the first photo saw 30 degrees down.
          const scene = S.makeScene();
          const world = S.makeModelItem({ path: 'D:/o/court/world.glb' }, 'Atlas: court');
          world.id = 'w';
          const cam = S.makeCameraItem('Atlas camera');
          cam.position = [0, 0, 0]; cam.rotation = [0, 0, 0];      // the first picture's viewpoint, as agentY opens it
          scene.items.push(world, cam);
          const key = 'previz:court';
          P.allTabs[key] = [{ previz: true, filename: 'court', scene }];
          P.previzScene = (k) => (k === undefined || k === key || k === P.activeTab) ? scene : null;
          P.activeTab = key;
          P.previzChanged = async () => {};
          P.isPrevizTab = () => true;
          P.previzAtlasItem = () => world;
          const R = O.matrixXYZ([30, 0, 0]);                 // true -> mesh: the first camera pitched down 30
          const pts = [];
          for (let i = 0; i < 2000; i++) {
            const p = [Math.random() * 6 - 3, -1.6, Math.random() * 6 - 4];
            pts.push(...R.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]));
          }
          P._atlasMeshPoints = () => pts;
          const real = window.__fetchApi;
          window.__fetchApi = async (p, o) => p.startsWith('/imageviewer/atlas_world')
            ? new Response(JSON.stringify({ frames: 1, cameras: [{ right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], pos: [0, 0, 0] }] }),
                           { status: 200 })
            : real(p, o);
          window.__notes = [];
          const done = await P.previzAtlasOrient({ force: false }).catch((e) => 'threw ' + e);
          const again = await P.previzAtlasOrient({ force: false });     // same cameras: nothing to do
          return { done, again, rot: world.rotation, pos: world.position, camRot: cam.rotation, camPos: cam.position,
                   orient: world.atlasOrient, saved: JSON.parse(S.serializeScene(scene)).items[0].atlasOrient,
                   parsed: S.parseScene(S.serializeScene(scene)).items[0].atlasOrient };
        }""")
        self.assertIsInstance(out["done"], dict, out)
        self.assertAlmostEqual(out["done"]["tilt"], 30, delta=1.5)
        self.assertIsNone(out["again"], "oriented with as many cameras: left alone")
        self.assertAlmostEqual(out["rot"][0], -30, delta=1.5)
        self.assertAlmostEqual(out["pos"][1], 1.6, delta=0.05)
        # The camera (the first picture's viewpoint, at the mesh origin) turns with the world: it looks down
        # 30 degrees again and stands 1.6 m above the floor.
        self.assertAlmostEqual(out["camRot"][0], -30, delta=1.5)
        self.assertAlmostEqual(out["camPos"][1], 1.6, delta=0.05)
        self.assertEqual(out["orient"], {"frames": 1})
        self.assertEqual(out["parsed"], {"frames": 1}, "kept in the scene file")
        self.assertEqual(self.errors, [])


    def test_closing_a_3d_tab_goes_back_to_the_viewer_tab_in_2d(self):
        pg = self.page()
        out = pg.evaluate("""async () => {
          const P = window.__panel;
          const { app } = await import('/scripts/app.js');
          app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
          P.setViewerToggleState(true);
          // A picture, then an Atlas world's world.glb, land in the Viewer tab (the glb is on screen there).
          P.showInViewerTab([[{ path: 'D:/out/room.png', filename: 'room.png', type: 'output' }]]);
          P.showInViewerTab([[{ path: 'D:/out/3d_scenes/atlas/court/world.glb', filename: 'world.glb', type: 'output' }]]);
          const before = (P.allTabs.folder_history || [])[0];
          // The world's own 3D tab opens, and is closed again.
          P.previzNewTab();
          const tab = P.activeTab;
          P.closeTab(tab);
          const now = (P.allTabs[P.activeTab] || [])[0];
          return { before: before && before.filename, tab, active: P.activeTab, shown: now && now.filename,
                   model: !!P._modelMode };
        }""")
        self.assertEqual(out["before"], "world.glb")
        self.assertTrue(out["tab"].startswith("previz"), out)
        self.assertEqual((out["active"], out["shown"], out["model"]), ("folder_history", "room.png", False))

    def test_a_picture_opened_from_the_history_after_a_model_shows_in_2d(self):
        # The Viewer tab is made into a scene while it shows world.glb; opening a picture there must end it.
        pg = self.page()
        out = pg.evaluate("""async () => {
          const P = window.__panel;
          const { app } = await import('/scripts/app.js');
          app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
          P.setViewerToggleState(true);
          P.showInViewerTab([[{ path: 'D:/out/room.png', filename: 'room.png', type: 'output' }]]);
          P.showInViewerTab([[{ path: 'D:/out/3d_scenes/atlas/court/world.glb', filename: 'world.glb', type: 'output' }]]);
          await P.enterPreviz('folder_history');
          const had = P.isPrevizTab('folder_history');
          const stack = P.history.folder_history || P.history[Object.keys(P.history)[0]];
          const i = stack.findIndex((s) => ((Array.isArray(s) ? s[0] : s) || {}).filename === 'room.png');
          P.openHistorySnapshot('folder_history', i);
          const now = (P.allTabs[P.activeTab] || [])[0];
          return { had, i, active: P.activeTab, shown: now && now.filename, scene: P.isPrevizTab('folder_history'),
                   model: !!P._modelMode };
        }""")
        self.assertTrue(out["had"], out)
        self.assertGreaterEqual(out["i"], 0, out)
        self.assertEqual((out["active"], out["shown"], out["scene"], out["model"]),
                         ("folder_history", "room.png", False, False))

    def test_the_splat_export_says_twelve_views_and_runs_on_when_its_dialog_is_closed(self):
        pg = self.page()
        out = pg.evaluate("""async () => {
          const P = window.__panel;
          P.setViewerToggleState(true);
          P.previzAtlasItem = () => ({ id: 'w', kind: 'model', src: { path: 'D:/o/court/world.glb' } });
          const real = window.__fetchApi;
          window.__pushed = [];
          let polls = 0, release = null;
          const gate = new Promise((r) => { release = r; });
          window.__release = release;
          const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
          window.__fetchApi = async (p, o) => {
            if (p === '/imageviewer/atlas_splat') {
              const b = JSON.parse(o.body);
              return ok(b.dry_run ? { plan: { frame_count: 5, estimate: { usd: 1.2, credits: 1200 } } } : { id: 's1', state: 'running' });
            }
            if (p.startsWith('/imageviewer/atlas_splat?')) {
              polls += 1;
              if (polls < 2) return ok({ id: 's1', state: 'running', phase: 'World Labs is building the splat', elapsed: 7 });
              await gate;
              return ok({ id: 's1', state: 'done', ply: 'D:/o/court/splats/court.ply', spz: 'D:/o/court/splats/court.spz' });
            }
            if (p === '/imageviewer/push') { window.__pushed.push(JSON.parse(o.body)); return ok({ ok: true }); }
            return real(p, o);
          };
          P.atlasSplatDialog();
          const root = P.shadowRoot;
          const dlg = () => root.querySelector('.atlas-splat');
          for (let i = 0; i < 50 && !dlg().querySelector('.rd-go:not([disabled])'); i++) await new Promise((r) => setTimeout(r, 50));
          const price = dlg().querySelector('.atlas-price');
          const hint = [...dlg().querySelectorAll('.rd-hint')].map((x) => x.textContent).join(' ');
          const said = { price: price.textContent, warn: price.classList.contains('warn'), hint };
          dlg().querySelector('.rd-go').click();
          for (let i = 0; i < 50 && !P._atlasSplatRun?.elapsed; i++) await new Promise((r) => setTimeout(r, 50));
          // Closed while it runs: the dialog goes, the export does not.
          dlg().querySelector('.rd-x').click();
          const closed = { gone: !dlg(), busy: !!P._atlasSplatBusy };
          window.__release();
          for (let i = 0; i < 200 && P._atlasSplatBusy; i++) await new Promise((r) => setTimeout(r, 50));
          return { said, closed, busy: !!P._atlasSplatBusy, pushed: window.__pushed };
        }""")
        self.assertIn("at least 12", out["said"]["hint"])
        self.assertIn("Only 5 views", out["said"]["price"])
        self.assertTrue(out["said"]["warn"])
        self.assertEqual(out["closed"], {"gone": True, "busy": True})
        self.assertFalse(out["busy"])
        self.assertEqual([p["paths"] for p in out["pushed"]], [["D:/o/court/splats/court.ply"]])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
