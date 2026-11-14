"""The agent's terrain actions, in a real browser with real three.js.

agentY's animate_scene reaches the 3D space through previzSceneAgent (the same road as POST
/imageviewer/rig/agent). This drives the Terrain menu that way: a terrain with its settings,
a sculpted ridge and a flattened road, a painted rock layer, scatters with paint, erosion run
in the Erode box and applied with a scatter following the water, and the ground's height
asked for - each stroke one undo step, as by hand.

Needs Playwright with an installed browser and node; skipped without them.
Screenshots: AGENT_TERRAIN_SHOTS=<folder>.
Run: python -m unittest tests.test_agent_terrain_browser
"""
import json
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
SHOTS = os.environ.get("AGENT_TERRAIN_SHOTS") or None

SETUP = """async () => {
  const P = window.__panel;
  const { app } = await import('/scripts/app.js');
  app.graph.nodes = app.graph.nodes || []; app.graph.links = app.graph.links || {};
  P.setViewerToggleState(true);
  await P.spaceOpen('3d');
  P._modelView().setPaneLayout('single');
  return true;
}"""

ASK = """async ([action, args]) => {
  try { return { ok: await window.__panel.previzSceneAgent(action, args) }; }
  catch (e) { return { error: String(e && e.message || e) }; }
}"""

HEIGHTS = """() => { const P = window.__panel, v = P._modelView();
  const t = P.previzScene().items.find((i) => i.kind === 'terrain');
  const T = v._entries.get(t.id).terrain; return { n: T.seg + 1, h: Array.from(T.heights, (x) => x * T.height) }; }"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class AgentTerrainTests(unittest.TestCase):
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

    def _ask(self, pg, action, **args):
        out = pg.evaluate(ASK, [action, args])
        self.assertNotIn("error", out, f"{action}: {out.get('error')}")
        return out["ok"]

    def _shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.wait_for_timeout(400)
            pg.screenshot(path=os.path.join(SHOTS, name))

    def test_the_agent_builds_a_valley_sculpts_scatters_and_erodes_it(self):
        pg = self._page()
        try:
            P = "window.__panel"
            t = self._ask(pg, "terrain_add", name="Desert", size=[300, 300], height=30, seed=7, roughness=0.55,
                          layers=[{"name": "sand", "color": "#c9a66b"}, {"name": "rock", "color": "#8a5a3b"}])
            pg.evaluate(f"""() => {{ const v = {P}._modelView(); v.camera.position.set(220, 160, 220);
                v.controls.target.set(0, 0, 0); v.controls.update(); v.requestRender(); }}""")
            self._shot(pg, "1-terrain.png")
            flat0 = pg.evaluate(HEIGHTS)
            # A ridge raised along x = -80, a road flattened down the middle.
            ridge = self._ask(pg, "terrain_sculpt", strokes=[
                {"tool": "raise", "points": [[-80, -120], [-80, 120]], "radius": 25, "strength": 0.8, "passes": 3}])
            road = self._ask(pg, "terrain_sculpt", strokes=[
                {"tool": "flatten", "points": [[0, -140], [0, 140]], "radius": 8, "strength": 1, "to": 5, "passes": 4}])
            after = pg.evaluate(HEIGHTS)
            ground = self._ask(pg, "terrain_height", points=[[0, 0], [-80, 0], [500, 0]])
            painted = self._ask(pg, "terrain_paint", strokes=[{"layer": "rock", "points": [[-80, -120], [-80, 120]], "radius": 20}])
            rocks = self._ask(pg, "scatter_add", type="rock", name="Boulders", count=300)
            bush = self._ask(pg, "scatter_add", type="bush", name="Shrubs", count=800, color="#7d7a3a", max_slope=25)
            bush_paint = self._ask(pg, "scatter_paint", scatter="Shrubs", strokes=[{"points": [[60, -100], [60, 100]], "radius": 30}])
            self._shot(pg, "2-sculpted-scattered.png")
            eroded = self._ask(pg, "terrain_erode", steps=300, follow={"Boulders": "deposit"})
            self._shot(pg, "3-eroded.png")
            final = pg.evaluate(HEIGHTS)
            scene = pg.evaluate(f"""() => {{ const s = {P}.previzScene();
                const t = s.items.find((i) => i.kind === 'terrain');
                const sc = Object.fromEntries(s.items.filter((i) => i.kind === 'scatter').map((i) => [i.name, !!(i.scatter && i.scatter.paint)]));
                return {{ size: t.terrain.size, height: t.terrain.height, sculpt: !!t.terrain.sculpt, layers: !!t.terrain.layerPaint,
                          sand: t.terrain.layers[0].name, scatters: sc, eroding: {P}._modelView().terrainEroding() }}; }}""")
            labels = pg.evaluate(f"() => {P}._undoState().past.map((s) => s.label)")
            bad = pg.evaluate(ASK, ["terrain_sculpt", {"strokes": [{"tool": "melt", "points": [[0, 0]]}]}])
            none = pg.evaluate(ASK, ["scatter_set", {"scatter": "Nope", "count": 3}])
            # Undo takes the erosion back, then a clear takes the sculpting off.
            pg.evaluate(f"() => {P}.previzUndo()")
            cleared = self._ask(pg, "terrain_clear", what="sculpt")
            back = pg.evaluate(HEIGHTS)
        finally:
            pg.close()
        n = after["n"]
        at = lambda d, x, z: d["h"][round((z / 300 + 0.5) * (n - 1)) * n + round((x / 300 + 0.5) * (n - 1))]
        self.assertEqual(t["terrain"], "Desert")
        self.assertEqual(t["size"], [300, 300])
        self.assertEqual(ridge["strokes"], 1)
        self.assertGreater(at(after, -80, 0) - at(flat0, -80, 0), 3, "the ridge is raised")
        self.assertLess(abs(at(after, 0, 0) - 5), 0.6, "the road is flattened to 5 m")
        self.assertEqual(road["strokes"], 1)
        self.assertAlmostEqual(ground["points"][0]["y"], 5, delta=0.6)
        self.assertTrue(ground["points"][1]["inside"])
        self.assertFalse(ground["points"][2]["inside"])
        self.assertEqual(painted["strokes"], 1)
        self.assertEqual(rocks["type"], "rock")
        self.assertEqual(rocks["count"], 300)
        self.assertEqual(bush["scatter"], "Shrubs")
        self.assertTrue(bush_paint["painted"])
        self.assertTrue(eroded["applied"])
        self.assertEqual(eroded["steps"], 300)
        self.assertGreater(max(abs(a - b) for a, b in zip(final["h"], after["h"])), 0.2, "erosion changed the ground")
        self.assertEqual(scene, {"size": [300, 300], "height": 30, "sculpt": True, "layers": True, "sand": "sand",
                                 "scatters": {"Boulders": True, "Shrubs": True}, "eroding": False})
        for want in ("add Terrain", "sculpt Desert", "paint Desert layers", "paint Shrubs", "erode Desert"):
            self.assertIn(want, labels)
        self.assertEqual(labels.count("sculpt Desert"), 2, "one undo step per stroke")
        self.assertIn("tool is one of", bad["error"])
        self.assertIn("no scatter named Nope", none["error"])
        self.assertEqual(cleared["cleared"], "sculpt")
        self.assertLess(max(abs(a - b) for a, b in zip(back["h"], flat0["h"])), 1e-3)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
