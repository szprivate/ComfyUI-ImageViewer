"""Lights in the 3D space, in a real browser with real three.js.

The REAL viewer js against stubbed ComfyUI scripts (tests/harness/tabs.html), three.js served from
vendor/three: Create > Light makes each type as the plain three.js light it is (PointLight, SpotLight,
DirectionalLight, RectAreaLight, HemisphereLight), the Channel Box shows that type's rows, ComfyUI's
studio lights step aside while the scene has a light (View > Default lights overrides), a light lights
a render (measured in its pixels), shadows switch the shadow map and the meshes' casting on, and a
light's glyph is on the Display menu's Lights layer and never in a render.

Needs Playwright with an installed browser and node; skipped without them.
Run: python -m unittest tests.test_view3d_lights_browser
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
# A folder to write screenshots of the lights into (LIGHTS_SHOTS).
SHOTS = os.environ.get("LIGHTS_SHOTS") or None

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  await P.previzAddPrimitive('box');
  const v = P._modelView();
  v.setPaneLayout('single');
  return true;
}"""

# The mean brightness (0..255) of a small render through the free view, on black.
MEAN = """async () => {
  const v = window.__panel._modelView();
  v.camera.position.set(4, 3, 4); v.camera.lookAt(0, 0.5, 0); v.controls.target.set(0, 0.5, 0); v.controls.update();
  v.beginRender({ camera: '', background: 'color', color: '#000000', shading: 'clay' });
  const url = v.renderFrame(null, 160, 90);
  v.endRender();
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = 160; c.height = 90;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, 160, 90).data;
  let s = 0, red = 0, blue = 0;
  for (let i = 0; i < d.length; i += 4) { s += (d[i] + d[i + 1] + d[i + 2]) / 3; red += d[i]; blue += d[i + 2]; }
  const n = d.length / 4;
  return { mean: s / n, red: red / n, blue: blue / n };
}"""

def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class LightTests(unittest.TestCase):
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

    def _page(self):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2 if SHOTS else 1)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("() => window.__panel && window.__panel.container", timeout=20000)
        pg.evaluate(SETUP)
        pg.wait_for_timeout(200)
        return pg

    def _settle(self, pg):
        # World items build asynchronously (an area light fetches its LTC tables first).
        pg.wait_for_function("""() => [...window.__panel._modelView()._entries.values()]
            .filter((e) => e.item.kind === 'light').every((e) => e.object)""", timeout=10000)
        pg.wait_for_timeout(150)

    def test_each_type_is_its_three_js_light(self):
        pg = self._page()
        try:
            V = "window.__panel._modelView()"
            studio_before = pg.evaluate(f"() => {V}.lights.every((l) => l.visible)")
            # Create > Light opens a submenu with every type.
            pg.evaluate("() => window.__panel.previzMenuBarOpen('create')")
            pg.wait_for_timeout(50)
            pg.locator("button.previz-menu-item", has_text="Light").first.hover()
            pg.wait_for_timeout(150)
            sub = pg.evaluate("() => [...window.__panel.container.querySelectorAll('.previz-submenu .previz-menu-item')].map((b) => b.textContent)")
            pg.keyboard.press("Escape")
            for t in ("point", "spot", "directional", "area", "dome"):
                pg.evaluate(f"() => window.__panel.previzAddLight('{t}')")
            self._settle(pg)
            got = pg.evaluate(f"""() => [...{V}._entries.values()].filter((e) => e.item.kind === 'light').map((e) => ({{
                type: e.item.light.type, cls: e.light && e.light.type, name: e.item.name,
                inScene: (() => {{ let o = e.light; while (o && o !== {V}.scene) o = o.parent; return o === {V}.scene; }})(),
                glyph: !!e.object.children.find((c) => c.userData.imageViewerLightGlyph),
                target: e.light && e.light.target ? e.light.target.parent === e.object : null }}))""")
            studio_after = pg.evaluate(f"() => {V}.lights.some((l) => l.visible)")
            pg.wait_for_timeout(100)
            if SHOTS:
                pg.evaluate(f"() => {{ const v = {V}; v.camera.position.set(9, 7, 11); v.controls.target.set(0, 1.5, 0); v.controls.update(); v.requestRender(); }}")
                pg.wait_for_timeout(300)
                os.makedirs(SHOTS, exist_ok=True)
                pg.screenshot(path=os.path.join(SHOTS, "lights-glyphs.png"))
            # The glyphs are sorted onto the Display menu's Lights layer before a frame.
            layer = pg.evaluate(f"""() => [...{V}._entries.values()].filter((e) => e.item.kind === 'light')
                .map((e) => e.object.children.find((c) => c.userData.imageViewerLightGlyph).layers.mask)""")
            kinds = pg.evaluate("async () => (await import('/extensions/viewer/imageViewer_view3dTools.js')).DISPLAY_KINDS.map((k) => k.key)")
        finally:
            pg.close()
        self.assertTrue(studio_before)
        # (the World submenu is built beside it)
        self.assertEqual(sub[:5], ["Point", "Spot", "Directional", "Area", "Sky dome"])
        self.assertEqual([g["cls"] for g in got],
                         ["PointLight", "SpotLight", "DirectionalLight", "RectAreaLight", "HemisphereLight"])
        self.assertTrue(all(g["inScene"] and g["glyph"] for g in got))
        self.assertTrue(got[1]["target"] and got[2]["target"])
        self.assertFalse(studio_after)
        self.assertEqual(set(layer), {1 << 8})
        self.assertEqual(kinds[-1], "lights")
        self.assertEqual(self.errors, [])

    def test_the_channel_box_shows_the_rows_of_the_lights_type(self):
        pg = self._page()
        try:
            P = "window.__panel"
            pg.evaluate(f"() => {P}.setPanelDocked('params', true)")
            pg.evaluate(f"() => {P}.previzAddLight('point')")
            self._settle(pg)
            pg.evaluate(f"() => {P}._previzRenderChannels()")
            rows = lambda: pg.evaluate(f"() => [...{P}._cbUI.rows.keys()].filter((k) => k.startsWith('world:'))")
            point_rows = rows()
            pg.evaluate(f"() => {P}.previzSetWorldField('light.type', 'spot')")
            self._settle(pg)
            pg.evaluate(f"() => {P}._previzRenderChannels()")
            spot_rows = rows()
            spot = pg.evaluate(f"""() => {{ const it = {P}.previzScene().items.find((i) => i.kind === 'light');
                const e = {P}._modelView()._entries.get(it.id); return {{ cls: e.light.type, intensity: it.light.intensity }}; }}""")
            pg.evaluate(f"() => {P}.previzSetWorldField('light.angle', 50)")
            self._settle(pg)
            angle = pg.evaluate(f"""() => {{ const it = {P}.previzScene().items.find((i) => i.kind === 'light');
                return {P}._modelView()._entries.get(it.id).light.angle * 180 / Math.PI; }}""")
            pg.evaluate(f"() => {P}.previzUndo()")
            self._settle(pg)
            undone = pg.evaluate(f"() => {P}.previzScene().items.find((i) => i.kind === 'light').light.angle")
        finally:
            pg.close()
        self.assertIn("world:light.distance", point_rows)
        self.assertNotIn("world:light.angle", point_rows)
        self.assertIn("world:light.angle", spot_rows)
        self.assertIn("world:light.penumbra", spot_rows)
        self.assertEqual(spot, {"cls": "SpotLight", "intensity": 300})
        self.assertAlmostEqual(angle, 50, places=3)
        self.assertEqual(undone, 30)
        self.assertEqual(self.errors, [])

    def test_a_light_lights_the_render_and_default_lights_step_aside(self):
        pg = self._page()
        try:
            P = "window.__panel"
            studio = pg.evaluate(MEAN)
            pg.evaluate(f"() => {P}.previzSetDefaultLights('off')")
            dark = pg.evaluate(MEAN)
            pg.evaluate(f"""() => {{ const it = {P}.previzAddLight('point'); }}""")
            pg.evaluate(f"""() => {{ const it = {P}.previzScene().items.find((i) => i.kind === 'light');
                it.position = [2, 3, 2]; it.light.color = '#ff2000'; it.light.intensity = 60; {P}.previzChanged({{ reload: true }}); }}""")
            self._settle(pg)
            red = pg.evaluate(MEAN)
            # Auto: the scene has a light, so the studio rig stays off; On brings it back over the light.
            pg.evaluate(f"() => {P}.previzSetDefaultLights('auto')")
            auto_on = pg.evaluate(f"() => {P}._modelView().lights.some((l) => l.visible)")
            pg.evaluate(f"() => {P}.previzSetDefaultLights('on')")
            on = pg.evaluate(f"() => {P}._modelView().lights.every((l) => l.visible)")
            saved = pg.evaluate(f"() => JSON.parse(JSON.stringify({P}.previzScene())).defaultLights")
            parsed = pg.evaluate("""async () => { const S = await import('/extensions/viewer/imageViewer_scene3d.js');
                return [S.parseScene(JSON.stringify({ items: [], defaultLights: 'off' })).defaultLights,
                        S.parseScene(JSON.stringify({ items: [], defaultLights: 'bogus' })).defaultLights === undefined]; }""")
            # An area light renders too (three's LTC tables loaded on demand).
            pg.evaluate(f"() => {P}.previzSetDefaultLights('off')")
            pg.evaluate(f"() => {P}.previzDeleteSelected ? {P}.previzDeleteSelected() : null")
            pg.evaluate(f"""() => {{ const it = {P}.previzAddLight('area'); }}""")
            pg.evaluate(f"""() => {{ const sc = {P}.previzScene(); for (const it of sc.items.filter((i) => i.kind === 'light' && i.light.type !== 'area')) it.visible = false;
                const a = sc.items.find((i) => i.kind === 'light' && i.light.type === 'area');
                a.position = [0, 2.5, 0]; a.rotation = [0, 0, 0]; a.light.intensity = 20; {P}.previzChanged({{ reload: true }}); }}""")
            self._settle(pg)
            area = pg.evaluate(MEAN)
        finally:
            pg.close()
        self.assertGreater(studio["mean"], dark["mean"] + 5)
        self.assertGreater(red["red"], dark["red"] + 5)
        self.assertGreater(red["red"], red["blue"] * 2)
        self.assertFalse(auto_on)
        self.assertTrue(on)
        self.assertEqual(saved, "on")
        self.assertEqual(parsed, ["off", True])
        self.assertGreater(area["mean"], dark["mean"] + 3)
        self.assertEqual(self.errors, [])

    def test_shadows_and_the_glyph_stays_out_of_renders(self):
        pg = self._page()
        try:
            P = "window.__panel"
            V = f"{P}._modelView()"
            pg.evaluate(f"() => {P}.previzAddLight('spot')")
            self._settle(pg)
            off = pg.evaluate(f"() => ({{ map: {V}.renderer.shadowMap.enabled, cast: [...{V}._entries.values()].find((e) => e.item.kind === 'primitive').root.getObjectByProperty('isMesh', true).castShadow }})")
            pg.evaluate(f"() => {P}.previzSetWorldField('light.shadows', true)")
            self._settle(pg)
            if SHOTS:
                # A floor to fall on, then the light selected again with its rows scrolled into view.
                pg.evaluate(f"""async () => {{ await {P}.previzAddPrimitive('plane'); const sc = {P}.previzScene();
                    const fl = sc.items[sc.items.length - 1]; fl.scale = [12, 1, 12]; fl.position = [0, -0.5, 0];
                    {P}.previzChanged({{ reload: true }});
                    {P}.previzSelect(sc.items.find((i) => i.kind === 'light').id); }}""")
                pg.wait_for_timeout(300)
                pg.evaluate(f"() => {P}.setPanelDocked('params', true)")
                pg.evaluate(f"() => {{ const r = {P}._cbUI && {P}._cbUI.rows.get('world:light.shadows'); if (r) r.row.scrollIntoView(); }}")
                pg.evaluate(f"() => {{ const v = {V}; v.camera.position.set(11, 8, 13); v.controls.target.set(1, 1, 1); v.controls.update(); v.requestRender(); }}")
                pg.wait_for_timeout(400)
                os.makedirs(SHOTS, exist_ok=True)
                pg.screenshot(path=os.path.join(SHOTS, "spot-shadow-channel-box.png"))
            on = pg.evaluate(f"""() => {{ const v = {V}; const box = [...v._entries.values()].find((e) => e.item.kind === 'primitive');
                const lt = [...v._entries.values()].find((e) => e.item.kind === 'light');
                return {{ map: v.renderer.shadowMap.enabled, type: v.renderer.shadowMap.type,
                         cast: box.root.getObjectByProperty('isMesh', true).castShadow, light: lt.light.castShadow,
                         radius: lt.light.shadow.radius }}; }}""")
            # A directional light fits its shadow box round the scene.
            pg.evaluate(f"() => {P}.previzSetWorldField('light.type', 'directional')")
            pg.evaluate(f"() => {P}.previzSetWorldField('light.shadows', true)")
            self._settle(pg)
            pg.evaluate(f"() => {V}.requestRender()")
            pg.wait_for_timeout(150)
            fit = pg.evaluate(f"""() => {{ const lt = [...{V}._entries.values()].find((e) => e.item.kind === 'light').light;
                const c = lt.shadow.camera; return {{ w: c.right - c.left, near: c.near, far: c.far, cast: lt.castShadow }}; }}""")
            glyph = pg.evaluate(f"""() => {{ const v = {V}; const lt = [...v._entries.values()].find((e) => e.item.kind === 'light');
                const g = lt.object.children.find((c) => c.userData.imageViewerLightGlyph);
                v.beginRender({{ camera: '' }}); v.renderFrame(null, 64, 36); const during = g.visible; v.endRender();
                return {{ during, after: g.visible }}; }}""")
        finally:
            pg.close()
        self.assertFalse(off["map"])
        self.assertFalse(off["cast"])
        self.assertTrue(on["map"] and on["cast"] and on["light"])
        self.assertEqual(on["radius"], 2)
        self.assertTrue(fit["cast"])
        self.assertGreater(fit["w"], 2)
        self.assertLess(fit["near"], fit["far"])
        self.assertEqual(glyph, {"during": False, "after": True})
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
