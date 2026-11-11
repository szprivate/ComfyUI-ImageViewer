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
        # The Previz panel's button is there on any 3D tab, the 3D menu has the entry too.
        has_btn = pg.evaluate("""() => [...window.__panel.shadowRoot.querySelectorAll('.previz-btn')]
                                  .some((b) => b.textContent === 'New world')""")
        self.assertTrue(has_btn)
        pg.evaluate("""() => [...window.__panel.shadowRoot.querySelectorAll('.previz-btn')]
                          .find((b) => b.textContent === 'New world').click()""")
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
        # A file let go on the backdrop beside the box is swallowed, not opened by the browser.
        prevented = pg.evaluate(DROP_FILES % (f"{root}.querySelector('.atlas-create')", "['x.png']"))
        self.assertTrue(prevented)
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


if __name__ == "__main__":
    unittest.main()
