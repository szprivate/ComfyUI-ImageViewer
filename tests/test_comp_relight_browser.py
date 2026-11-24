"""Relight and AI Normals in the REAL Comp space: a ball in front of a wall with its depth in depth.z, lit again
by the node's own key light, by a Light node through a Camera (relight mode, with a highlight), shown as its
normals, and lit from a normal map wired into "normals"; AI Normals is a node of the AI menu.

    python -m unittest tests.test_comp_relight_browser     (Playwright and aiohttp; skipped without)
    RELIGHT_SHOTS=<folder> saves screenshots there.
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_comp_browser as base  # noqa: E402

SHOTS = os.environ.get("RELIGHT_SHOTS")
W, H = 640, 360
K = 35 / 18          # the comp's default camera: focal 35 mm on a 36 mm film back, at (0, 0, 2) looking down -Z


def _scene():
    """A ball (radius 0.5 at the origin) in front of a wall 3.5 away, seen by the default camera: the plate,
    its depth (distance along the view, /4 in a 16-bit grey) and its true normals as a 0..1 normal map."""
    x = (np.arange(W) + 0.5) / W * 2 - 1
    y = 1 - (np.arange(H) + 0.5) / H * 2
    dx = np.tile(x / K, (H, 1))
    dy = np.tile((y / (K * W / H))[:, None], (1, W))
    a = dx * dx + dy * dy + 1
    b = -4.0
    c = 4 - 0.25
    disc = b * b - 4 * a * c
    ball = disc > 0
    t = np.where(ball, (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a), 3.5)
    px, py, pz = dx * t, dy * t, 2 - t
    n = np.stack([px, py, pz], axis=-1) / 0.5
    n[~ball] = (0, 0, 1)
    rgb = np.zeros((H, W, 3))
    rgb[...] = (0.55, 0.55, 0.6)
    rgb[ball] = (0.8, 0.35, 0.25)
    plate = (rgb * 255).astype(np.uint8)
    depth = np.clip(t / 4 * 65535 + 0.5, 0, 65535).astype(np.uint16)
    nmap = np.clip((n * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8)
    return plate, depth, nmap


@unittest.skipIf(base.sync_playwright is None or base.web is None, "needs playwright and aiohttp")
class RelightBrowserTests(unittest.TestCase):
    setUpClass = classmethod(base.CompBrowserTests.setUpClass.__func__)
    tearDownClass = classmethod(base.CompBrowserTests.tearDownClass.__func__)
    page = base.CompBrowserTests.page
    new_comp = base.CompBrowserTests.new_comp
    ED = base.CompBrowserTests.ED

    def shot(self, pg, name, loc=None):
        if not SHOTS:
            return
        os.makedirs(SHOTS, exist_ok=True)
        (loc or pg).screenshot(path=os.path.join(SHOTS, name))

    def test_a_ball_is_lit_again_from_its_depth_a_light_node_and_a_normal_map(self):
        from PIL import Image
        plate, depth, nmap = _scene()
        paths = {k: os.path.join(self.dirs["output"], f"rl_{k}.png") for k in ("plate", "depth", "normals")}
        Image.fromarray(plate, "RGB").save(paths["plate"])
        Image.fromarray(depth).save(paths["depth"])          # uint16 grey: "I;16"
        Image.fromarray(nmap, "RGB").save(paths["normals"])
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"() => {ED}.setFormat({{ width: {W}, height: {H} }})")
        # The plate, its depth put into depth.z (a LumaKeyer writing there as it is), Copy beside the colour,
        # then Relight into the Output with its own key light (from the upper left).
        pg.evaluate(f"""(p) => {{ const e = {ED}; const c = e.comp();
            const rp = e.addNode('read', {{ file: p.plate }}); const rd = e.addNode('read', {{ file: p.depth, colorspace: 'linear' }});
            const lk = e.addNode('lumakeyer', {{ write: 'depth.z', output: 'matte', low: 0, low_soft: 1, high: 10 }}); lk.inputs = [rd.id];
            const cp = e.addNode('copy', {{ a: 'B' }}); cp.inputs = [rp.id, lk.id];
            const rl = e.addNode('relight', {{ multiply: 4, key_intensity: 0.6 }}); rl.inputs = [cp.id, null, null, null];
            const out = c.nodes.find((n) => n.type === 'output'); out.inputs = [rl.id];
            e.refresh(); e.select([rl.id]); }}""", paths)
        pg.wait_for_timeout(2500)
        rows = lambda: pg.evaluate("""() => [...__panel.shadowRoot.querySelectorAll('.comp-params .mg-prop > label')].map((l) => l.textContent)""")
        r = rows()
        for want in ("mode", "result", "gain", "normals", "depth", "depth is", "multiply", "smooth", "key direction", "key intensity"):
            self.assertIn(want, r)
        for hidden in ("layer", "space", "encoding", "green", "shininess"):
            self.assertNotIn(hidden, r)
        px = lambda fx, fy: pg.evaluate(f"""([fx, fy]) => {{ const c = {ED}.canvas; return Array.from(c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data); }}""", [fx, fy])
        # The ball's upper left faces the key light, its lower right does not: the light is added on the left only.
        ul, lr = px(0.37, 0.3), px(0.63, 0.7)
        self.shot(pg, "relight-key-light.png")
        self.assertGreater(ul[1], lr[1] + 15, f"lit from the upper left: {ul} vs {lr}")
        # A point light to the lower right through a Camera, relight mode with a highlight: now the lower right
        # is the lit side and the upper left goes dark (this light alone lights it).
        pg.evaluate(f"""() => {{ const e = {ED};
            const rl = e.comp().nodes.find((n) => n.type === 'relight');
            const li = e.addNode('light3d', {{ light: 'point', translate: [1.6, -1.2, 2.2], intensity: 1.4, color: [1, 0.85, 0.7, 1] }});
            const cam = e.addNode('camera3d', {{}});
            rl.inputs = [rl.inputs[0], li.id, cam.id, null, null];
            Object.assign(rl, {{ mode: 'relight', specular: 0.6, shininess: 40 }});
            e.refresh(); e.select([rl.id]); }}""")
        pg.wait_for_timeout(2000)
        self.assertIn("shininess", rows())
        ul2, lr2 = px(0.37, 0.3), px(0.63, 0.7)
        self.assertGreater(lr2[0], ul2[0] + 40, f"lit from the lower right: {lr2} vs {ul2}")
        self.shot(pg, "relight-point-light.png")
        # The normals it lit with (shown through the display transform): the ball's left is turned left (little
        # red), its top up (much green).
        pg.evaluate(f"() => {{ const e = {ED}; e.comp().nodes.find((n) => n.type === 'relight').output = 'normals'; e.refresh(); }}")
        pg.wait_for_timeout(1500)
        left, top, wall = px(0.3, 0.5), px(0.5, 0.33), px(0.1, 0.1)
        self.assertLess(left[0], 150, f"left: {left}")
        self.assertGreater(top[1], 200, f"top: {top}")
        self.assertTrue(abs(wall[0] - wall[1]) < 30 and wall[2] > 200, f"the wall faces the camera: {wall}")
        self.shot(pg, "relight-normals-from-depth.png")
        # A normal map wired into "normals" (what AI Normals makes): the same light, the same sides.
        pg.evaluate(f"""(p) => {{ const e = {ED};
            const rl = e.comp().nodes.find((n) => n.type === 'relight');
            const rn = e.addNode('read', {{ file: p.normals, colorspace: 'linear' }});
            rl.inputs = [rl.inputs[0], rl.inputs[1], rl.inputs[2], rn.id, null];
            Object.assign(rl, {{ normals: 'normals input', output: 'result' }});
            e.refresh(); e.select([rl.id]); }}""", paths)
        pg.wait_for_timeout(2000)
        r = rows()
        for want in ("space", "encoding", "green"):
            self.assertIn(want, r)
        self.assertNotIn("smooth", r)
        ul3, lr3 = px(0.37, 0.3), px(0.63, 0.7)
        self.assertGreater(lr3[0], ul3[0] + 40, f"the map lights the same side: {lr3} vs {ul3}")
        self.assertLess(abs(lr3[0] - lr2[0]), 40, f"close to the depth's normals: {lr3} vs {lr2}")
        self.shot(pg, "relight-normal-map.png")
        self.shot(pg, "relight-parameters.png", pg.locator(".comp-params"))
        # AI Normals is an AI node; before it has run it passes its input.
        got = pg.evaluate(f"""() => {{ const e = {ED}; const a = e.addNode('ai_normals', {{}});
            return {{ type: a.type }}; }}""")
        self.assertEqual(got["type"], "ai_normals")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
