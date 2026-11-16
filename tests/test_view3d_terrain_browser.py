"""The Terrain menu and the scatter brush, in a real browser with real three.js.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three: the bar has a Terrain menu (New terrain, Scattering ▸ with the scatter types and the
brush), Create > World no longer holds terrain, scatters or the Lamp, and a stroke of the scatter
brush with the real mouse paints where a scatter grows - the scatter is rebuilt with every instance
on paint, the stroke is one undo step, and Clear takes the paint off again.

Needs Playwright with an installed browser and node; skipped without them.
Screenshots: TERRAIN_SHOTS=<folder>.
Run: python -m unittest tests.test_view3d_terrain_browser
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
SHOTS = os.environ.get("TERRAIN_SHOTS") or None

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  const v = P._modelView();
  v.setPaneLayout('single');
  return true;
}"""

# The scatter's instances as terrain u, v (0..1), read from its instanced meshes.
INSTANCES = """() => {
  const P = window.__panel, v = P._modelView();
  const it = P.previzScene().items.find((i) => i.kind === 'scatter');
  const e = v._entries.get(it.id), t = P.previzScene().items.find((i) => i.kind === 'terrain');
  const T = v._entries.get(t.id).terrain;
  const mesh = e.object && e.object.children.find((c) => c.isInstancedMesh);
  if (!mesh) return { n: 0, uv: [] };
  const THREE = v.libs.THREE, m = new THREE.Matrix4(), p = new THREE.Vector3();
  const uv = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m); p.setFromMatrixPosition(m);
    uv.push([p.x / T.size[0] + 0.5, p.z / T.size[1] + 0.5]);
  }
  return { n: mesh.count, uv };
}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class TerrainTests(unittest.TestCase):
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
        tries = [dict(channel="msedge"), dict(channel="chrome"), {}]
        if os.path.exists("/opt/pw-browsers/chromium"):
            tries.append(dict(executable_path="/opt/pw-browsers/chromium"))
        for opts in tries:
            try:
                cls.browser = cls.pw.chromium.launch(headless=True, **opts)
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

    def _page(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2 if SHOTS else 1)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_timeout(200)
        return pg

    def _built(self, pg):
        pg.wait_for_function("""() => { const v = window.__panel._modelView();
            const es = [...v._entries.values()].filter((e) => ['terrain', 'scatter'].includes(e.item.kind));
            return es.length && es.every((e) => e.object || e.error); }""", timeout=20000)
        pg.wait_for_timeout(200)

    def _menu(self, pg, name, sub=None):
        pg.evaluate(f"() => window.__panel.previzMenuBarOpen('{name}')")
        pg.wait_for_timeout(80)
        items = pg.evaluate("() => [...window.__panel.container.querySelectorAll('button.previz-menu-item')].filter((b) => !b.closest('.previz-submenu')).map((b) => b.textContent)")
        subs = []
        if sub:
            pg.locator("button.previz-menu-item", has_text=sub).first.hover()
            pg.wait_for_timeout(150)
            subs = pg.evaluate("() => [...window.__panel.container.querySelectorAll('.previz-submenu .previz-menu-item')].map((b) => b.textContent)")
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(50)
        return items, subs

    def test_the_terrain_menu_and_create_world(self):
        pg = self._page()
        try:
            terrain_items, scatter_before = self._menu(pg, "terrain", "Scattering")
            _, world = self._menu(pg, "create", "World")
            # New terrain from the menu, then a scatter from Scattering.
            pg.evaluate("() => window.__panel._previzTerrainMenuEntries()[0].run()")
            self._built(pg)
            _, scatter_after = self._menu(pg, "terrain", "Scattering")
            pg.evaluate("""() => window.__panel._previzTerrainMenuEntries().find((e) => e.label === 'Scattering').sub
                .find((e) => e.label === 'Grass').run()""")
            self._built(pg)
            kinds = pg.evaluate("() => window.__panel.previzScene().items.map((i) => i.kind)")
        finally:
            pg.close()
        self.assertEqual([t.strip() for t in terrain_items],
                         ["New terrain", "Sculpt", "Paint layer", "Erode…", "Clear sculpting", "Clear layer paint", "Scattering"])
        scatter_before = scatter_before[scatter_before.index("Pines"):]
        self.assertEqual(scatter_before[:8], ["Pines", "Trees", "Bushes", "Grass", "Rocks", "Columns", "Lamps", "Model…"])
        self.assertIn("Paint scatter", scatter_before)
        self.assertIn("Clear scatter paint", scatter_before)
        self.assertEqual([w.strip() for w in world][-3:],
                         ["Environment (sky, sun, fog)", "Depth mesh… (picture + depth map)", "Reference on camera…"])
        self.assertNotIn("Lamp", " ".join(world))
        self.assertEqual(kinds.count("terrain"), 1)
        self.assertEqual(kinds.count("scatter"), 1)
        self.assertEqual(self.errors, [])

    def test_the_brush_paints_where_a_scatter_grows(self):
        pg = self._page()
        try:
            P = "window.__panel"
            pg.evaluate(f"""() => {{ const P = {P}; P.previzAddWorldItem('terrain'); }}""")
            self._built(pg)
            pg.evaluate(f"() => {P}.previzAddWorldItem('scatter', 'grass')")
            self._built(pg)
            # Flatter, so slope never decides, and a fixed count.
            pg.evaluate(f"""() => {{ const P = {P}; const s = P.previzScene();
                const t = s.items.find((i) => i.kind === 'terrain'); t.terrain.height = 2;
                const g = s.items.find((i) => i.kind === 'scatter'); g.scatter.count = 20000; g.scatter.maxSlope = 90;
                return P.previzChanged({{ reload: true }}); }}""")
            self._built(pg)
            unpainted = pg.evaluate(INSTANCES)["n"]
            # Look straight down at the terrain.
            pg.evaluate(f"""() => {{ const v = {P}._modelView(); v.camera.position.set(0, 160, 0.01); v.camera.up.set(0, 1, 0);
                v.controls.target.set(0, 0, 0); v.controls.update(); v.requestRender(); }}""")
            pg.wait_for_timeout(200)
            started = pg.evaluate(f"() => {P}.previzScatterPaintStart()")
            bar = pg.evaluate(f"() => !!{P}._modelView().stage.querySelector('.model-spaint-bar')")
            pg.evaluate(f"() => {P}._modelView().scatterBrushSet({{ radius: 8, strength: 1, hardness: 0.8 }})")
            box = pg.evaluate(f"() => {{ const r = {P}._modelView().canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
            cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
            pg.mouse.move(cx - 150, cy)
            pg.mouse.down()
            for i in range(1, 21):
                pg.mouse.move(cx - 150 + i * 15, cy)
                pg.wait_for_timeout(15)
            pg.mouse.up()
            pg.wait_for_timeout(300)
            self._built(pg)
            pg.wait_for_function(f"() => !{P}._worldReloading", timeout=10000)
            pg.wait_for_timeout(300)
            if SHOTS:
                os.makedirs(SHOTS, exist_ok=True)
                pg.mouse.move(cx + 150, cy + 60)
                pg.wait_for_timeout(200)
                pg.screenshot(path=os.path.join(SHOTS, "scatter-paint.png"))
            painted = pg.evaluate(INSTANCES)
            # Every instance stands on paint.
            on_paint = pg.evaluate(f"""async (uv) => {{ const D = await import('/extensions/viewer/imageViewer_scatterPaint.js');
                const it = {P}.previzScene().items.find((i) => i.kind === 'scatter');
                const g = D.decodePaint(it.scatter.paint);
                return {{ share: D.paintedShare(g), off: uv.filter(([u, v]) => D.paintAt(g, u, v) <= 0).length }}; }}""", painted["uv"])
            # Esc stops; the stroke was one undo step.
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(100)
            stopped = pg.evaluate(f"() => !{P}._modelView().scatterPainting() && !{P}._modelView().stage.querySelector('.model-spaint-bar')")
            pg.evaluate(f"() => {P}.previzUndo()")
            self._built(pg)
            undone = pg.evaluate(f"() => {P}.previzScene().items.find((i) => i.kind === 'scatter').scatter.paint")
            pg.evaluate(f"() => {P}.previzRedo()")
            self._built(pg)
            redone = pg.evaluate(f"() => !!{P}.previzScene().items.find((i) => i.kind === 'scatter').scatter.paint")
            pg.evaluate(f"() => {P}.previzScatterPaintClear()")
            self._built(pg)
            cleared = pg.evaluate(INSTANCES)["n"]
            # Nothing of the brush is left in a render.
            leftovers = pg.evaluate(f"() => {{ let n = 0; {P}._modelView().scene.traverse((o) => {{ if (o.name === 'scatterpaint') n++; }}); return n; }}")
        finally:
            pg.close()
        self.assertTrue(started)
        self.assertTrue(bar)
        self.assertGreater(unpainted, 15000)
        self.assertGreater(painted["n"], 50)
        self.assertLess(painted["n"], unpainted / 4)
        self.assertEqual(on_paint["off"], 0)
        self.assertGreater(on_paint["share"], 0.005)
        self.assertTrue(stopped)
        self.assertIsNone(undone)
        self.assertTrue(redone)
        self.assertEqual(cleared, unpainted)
        self.assertEqual(leftovers, 0)
        self.assertEqual(self.errors, [])

    def _stroke(self, pg, dx=-150, steps=20, step=15, ctrl=False):
        box = pg.evaluate("() => { const r = window.__panel._modelView().canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        pg.mouse.move(cx + dx, cy)
        if ctrl:
            pg.keyboard.down("Control")
        pg.mouse.down()
        for i in range(1, steps + 1):
            pg.mouse.move(cx + dx + i * step, cy)
            pg.wait_for_timeout(15)
        pg.mouse.up()
        if ctrl:
            pg.keyboard.up("Control")
        pg.wait_for_timeout(300)

    def test_the_terrain_brushes_sculpt_and_paint_layers(self):
        pg = self._page()
        try:
            P = "window.__panel"
            pg.evaluate(f"() => {P}.previzAddWorldItem('terrain')")
            self._built(pg)
            pg.evaluate(f"() => {P}.previzAddWorldItem('scatter', 'rock')")
            self._built(pg)
            pg.evaluate(f"""() => {{ const v = {P}._modelView(); v.camera.position.set(0, 160, 0.01);
                v.controls.target.set(0, 0, 0); v.controls.update(); v.requestRender(); }}""")
            pg.wait_for_timeout(200)
            H = f"""() => {{ const v = {P}._modelView(); const t = {P}.previzScene().items.find((i) => i.kind === 'terrain');
                const T = v._entries.get(t.id).terrain; const n = T.seg + 1, m = Math.floor(n / 2);
                return {{ mid: T.heights[m * n + m] * T.height, edge: T.heights[m * n + 5] * T.height,
                          splat: Array.from(T.mesh.geometry.attributes.aSplat.array.slice((m * n + m) * 4, (m * n + m) * 4 + 4)) }}; }}"""
            before = pg.evaluate(H)
            # Terrain > Sculpt > Raise from the menu.
            pg.evaluate(f"""() => {P}._previzTerrainMenuEntries().find((e) => e.label === 'Sculpt').sub
                .find((e) => /Raise/.test(e.label)).run()""")
            bar = pg.evaluate(f"() => !!{P}._modelView().stage.querySelector('.model-terrain-bar')")
            pg.evaluate(f"() => {P}._modelView().terrainBrushSet({{ radius: 15, strength: 1, hardness: 0.6 }})")
            self._stroke(pg)
            self._stroke(pg)
            self._built(pg)
            raised = pg.evaluate(H)
            sculpt = pg.evaluate(f"() => !!{P}.previzScene().items.find((i) => i.kind === 'terrain').terrain.sculpt")
            # The rocks stand on the new ground: every instance within a metre of the terrain under it.
            floating = pg.evaluate(f"""() => {{ const v = {P}._modelView(); const s = {P}.previzScene();
                const it = s.items.find((i) => i.kind === 'scatter'), t = s.items.find((i) => i.kind === 'terrain');
                const e = v._entries.get(it.id), te = v._entries.get(t.id);
                const mesh = e.object.children.find((c) => c.isInstancedMesh);
                const THREE = v.libs.THREE, m = new THREE.Matrix4(), p = new THREE.Vector3();
                let bad = 0;
                for (let i = 0; i < mesh.count; i++) {{ mesh.getMatrixAt(i, m); p.setFromMatrixPosition(m);
                    const y = v._terrainHeightAt(te, p.x, p.z); if (y != null && Math.abs(p.y - y) > 1) bad++; }}
                return bad; }}""")
            # Paint the rock layer, then Ctrl+drag lowers with the Raise tool.
            pg.evaluate(f"() => {P}._modelView().terrainBrushSet({{ tool: 'layer', layer: 2 }})")
            self._stroke(pg)
            self._built(pg)
            painted = pg.evaluate(H)
            if SHOTS:
                os.makedirs(SHOTS, exist_ok=True)
                pg.evaluate(f"""() => {{ const v = {P}._modelView(); v.camera.position.set(90, 70, 90);
                    v.controls.target.set(0, 0, 0); v.controls.update(); v.requestRender(); }}""")
                pg.wait_for_timeout(400)
                pg.screenshot(path=os.path.join(SHOTS, "terrain-brushes.png"))
            undo_labels = pg.evaluate(f"() => {P}._undoState().past.map((s) => s.label)")
            pg.evaluate(f"() => {P}.previzUndo()")
            self._built(pg)
            undone = pg.evaluate(f"() => {P}.previzScene().items.find((i) => i.kind === 'terrain').terrain.layerPaint")
            still_on = pg.evaluate(f"() => {P}._modelView().terrainBrushing()")
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(100)
            stopped = pg.evaluate(f"() => !{P}._modelView().terrainBrushing() && !{P}._modelView().stage.querySelector('.model-terrain-bar')")
            pg.evaluate(f"() => {P}.previzTerrainClear('sculpt')")
            self._built(pg)
            cleared = pg.evaluate(H)
        finally:
            pg.close()
        self.assertTrue(bar)
        self.assertGreater(raised["mid"] - before["mid"], 1)
        self.assertAlmostEqual(raised["edge"], before["edge"], places=3)
        self.assertTrue(sculpt)
        self.assertEqual(floating, 0)
        self.assertGreater(painted["splat"][2], 0.9)
        self.assertEqual(undo_labels[-3:], ["sculpt Terrain", "sculpt Terrain", "paint Terrain layers"])
        self.assertIsNone(undone)
        self.assertTrue(still_on)
        self.assertTrue(stopped)
        self.assertAlmostEqual(cleared["mid"], before["mid"], places=3)
        self.assertEqual(self.errors, [])

    def test_erosion_runs_live_and_applies_as_sculpt(self):
        pg = self._page()
        try:
            P = "window.__panel"
            pg.evaluate(f"() => {P}.previzAddWorldItem('terrain')")
            self._built(pg)
            pg.evaluate(f"() => {P}.previzAddWorldItem('scatter', 'grass')")
            self._built(pg)
            pg.evaluate(f"""() => {{ const v = {P}._modelView(); v.camera.position.set(110, 90, 110);
                v.controls.target.set(0, 0, 0); v.controls.update(); v.requestRender(); }}""")
            H = f"""() => {{ const v = {P}._modelView(); const t = {P}.previzScene().items.find((i) => i.kind === 'terrain');
                const T = v._entries.get(t.id).terrain; return Array.from(T.heights, (h) => h * T.height); }}"""
            before = pg.evaluate(H)
            if SHOTS:
                os.makedirs(SHOTS, exist_ok=True)
                pg.wait_for_timeout(300)
                pg.screenshot(path=os.path.join(SHOTS, "erode-before.png"))
            entry = pg.evaluate(f"() => {P}._previzTerrainMenuEntries().find((e) => e.label === 'Erode…').disabled")
            pg.evaluate(f"() => {P}._previzTerrainMenuEntries().find((e) => e.label === 'Erode…').run()")
            box = pg.locator(".model-erode-box")
            box.locator("input[data-key=iterations]").fill("400")
            box.locator("input[data-key=iterations]").press("Enter")
            box.locator("select[data-scatter]").select_option("wetness")
            box.locator(".meb-run").click()
            pg.wait_for_function(f"() => {{ const s = {P}._modelView().terrainErodeState(); return s && s.done >= 400 && !s.running; }}",
                                 timeout=60000)
            state = pg.evaluate(f"() => {P}._modelView().terrainErodeState()")
            text = box.locator(".meb-text").text_content()
            eroded = pg.evaluate(H)
            if SHOTS:
                pg.wait_for_timeout(300)
                pg.screenshot(path=os.path.join(SHOTS, "erode-running.png"))
            # Reset puts the terrain back and keeps the box.
            box.locator(".meb-reset").click()
            reset = pg.evaluate(H)
            box.locator(".meb-run").click()
            pg.wait_for_function(f"() => {{ const s = {P}._modelView().terrainErodeState(); return s && s.done >= 400; }}", timeout=60000)
            again = pg.evaluate(H)
            box.locator(".meb-ok").click()
            self._built(pg)
            applied = pg.evaluate(H)
            scene = pg.evaluate(f"""() => {{ const s = {P}.previzScene(); const t = s.items.find((i) => i.kind === 'terrain');
                const sc = s.items.find((i) => i.kind === 'scatter');
                return {{ sculpt: !!t.terrain.sculpt, layers: !!t.terrain.layerPaint, paint: !!(sc.scatter && sc.scatter.paint),
                         box: !!{P}._modelView().stage.querySelector('.model-erode-box'),
                         eroding: {P}._modelView().terrainEroding() }}; }}""")
            if SHOTS:
                pg.wait_for_timeout(400)
                pg.screenshot(path=os.path.join(SHOTS, "erode-applied.png"))
            labels = pg.evaluate(f"() => {P}._undoState().past.map((s) => s.label)")
            pg.evaluate(f"() => {P}.previzUndo()")
            self._built(pg)
            undone = pg.evaluate(H)
            # Without the GPU it runs on the CPU, and Cancel puts the terrain back.
            pg.evaluate(f"() => {{ {P}._modelView()._teCpuOnly = true; {P}.previzTerrainErodeOpen(); }}")
            pg.evaluate(f"() => {P}.previzTerrainErodeSet({{ iterations: 3 }})")
            pg.evaluate(f"() => {P}.previzTerrainErodeRun(true)")
            pg.wait_for_function(f"() => {{ const s = {P}._modelView().terrainErodeState(); return s && s.done >= 3; }}", timeout=30000)
            cpu = pg.evaluate(f"() => {P}._modelView().terrainErodeState().gpu")
            pg.evaluate(f"() => {P}.previzTerrainErodeCancel()")
            cancelled = pg.evaluate(H)
            closed = pg.evaluate(f"() => !{P}._modelView().stage.querySelector('.model-erode-box')")
        finally:
            pg.close()
        diff = lambda a, b: max(abs(x - y) for x, y in zip(a, b))
        self.assertFalse(entry)
        self.assertTrue(state["gpu"], "the GPU erodes where WebGL2 has float targets")
        self.assertIn("400 / 400", text)
        self.assertGreater(diff(eroded, before), 0.5)
        self.assertLess(diff(reset, before), 1e-4)
        self.assertLess(diff(again, eroded), 1e-3)
        self.assertLess(diff(applied, eroded), 0.02)
        self.assertEqual(scene, {"sculpt": True, "layers": True, "paint": True, "box": False, "eroding": False})
        self.assertEqual(labels[-1], "erode Terrain")
        self.assertLess(diff(undone, before), 1e-4)
        self.assertFalse(cpu)
        self.assertLess(diff(cancelled, before), 1e-4)
        self.assertTrue(closed)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
