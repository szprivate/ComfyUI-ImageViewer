"""ZDefocus in the REAL Comp space: a plate with its depth in depth.z, the focus plane set by dragging the focal
point onto the picture (taken from the depth under it), the focal plane setup drawn at once without blurring, the
layer and filter shape setups, and the defocused result.

    python -m unittest tests.test_comp_zdefocus_browser     (Playwright and aiohttp; skipped without)
    ZDEFOCUS_SHOTS=<folder> saves screenshots there.
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_comp_browser as base  # noqa: E402

SHOTS = os.environ.get("ZDEFOCUS_SHOTS")


def _scene(w=640, h=360):
    """A far wall of small lights, a box half way and a ball near the camera; its depth 0 near .. 1 far."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    rgb = np.zeros((h, w, 3))
    rgb[...] = (0.10, 0.12, 0.18)
    rgb[((x // 20 + y // 20) % 2) == 0] = (0.16, 0.18, 0.26)
    lights = ((x % 48 - 24) ** 2 + (y % 40 - 20) ** 2) < 9
    rgb[lights] = (1.0, 0.85, 0.5)
    depth = np.ones((h, w))
    box = (x > 250) & (x < 420) & (y > 90) & (y < 270)
    rgb[box] = (0.75, 0.25, 0.2)
    rgb[box & (((x // 10 + y // 10) % 2) == 0)] = (0.95, 0.9, 0.85)
    depth[box] = 0.5
    ball = ((x - 140) ** 2 + (y - 250) ** 2) < 70 ** 2
    rgb[ball] = (0.2, 0.6, 0.3)
    rgb[ball & ((x // 8) % 2 == 0)] = (0.9, 0.95, 0.4)
    depth[ball] = 0.15
    return (np.clip(rgb, 0, 1) * 255).astype(np.uint8), (depth * 255).astype(np.uint8)


@unittest.skipIf(base.sync_playwright is None or base.web is None, "needs playwright and aiohttp")
class ZDefocusBrowserTests(unittest.TestCase):
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

    def test_the_focal_point_sets_the_focus_and_the_focal_plane_setup_is_instant(self):
        from PIL import Image
        rgb, depth = _scene()
        plate = os.path.join(self.dirs["output"], "zd_plate.png")
        dmap = os.path.join(self.dirs["output"], "zd_depth.png")
        Image.fromarray(rgb, "RGB").save(plate)
        Image.fromarray(np.repeat(depth[..., None], 3, axis=2), "RGB").save(dmap)
        pg = self.page()
        self.new_comp(pg)
        ED = self.ED
        pg.evaluate(f"() => {ED}.setFormat({{ width: 640, height: 360 }})")
        # Read the plate, Read the depth, put the depth into depth.z (a LumaKeyer writing there, 0..1 as it is),
        # Copy it beside the plate's colour, then ZDefocus into the Output.
        pg.evaluate(f"""([plate, dmap]) => {{ const e = {ED}; const c = e.comp();
            const rp = e.addNode('read', {{ file: plate }}); const rd = e.addNode('read', {{ file: dmap }});
            const lk = e.addNode('lumakeyer', {{ write: 'depth.z', output: 'matte', low: 0, low_soft: 1, high: 10 }}); lk.inputs = [rd.id];
            const cp = e.addNode('copy', {{ a: 'B' }}); cp.inputs = [rp.id, lk.id];
            const zd = e.addNode('zdefocus', {{ math: 'far = 1', size: 40, maximum: 16, focus: 0.9 }}); zd.inputs = [cp.id];
            const out = c.nodes.find((n) => n.type === 'output'); out.inputs = [zd.id];
            e.refresh(); e.select([zd.id]); }}""", [plate, dmap])
        pg.wait_for_timeout(2500)
        # The rows follow the settings: the bladed ones only with blades, layers only by hand.
        rows = lambda: pg.evaluate("""() => [...__panel.shadowRoot.querySelectorAll('.comp-params .mg-prop > label')].map((l) => l.textContent)""")
        r = rows()
        for want in ("depth channel", "math", "output mode", "focus plane (C)", "focal point", "depth of field", "size", "maximum", "filter type", "filter shape"):
            self.assertIn(want, r)
        for hidden in ("blades", "inner size", "depth layers", "bloom gain", "show image"):
            self.assertNotIn(hidden, r)
        # Drag the focal point onto the box: the focus plane becomes the box's depth.
        handle = pg.locator(".cp-handle[data-param=focal_point]")
        handle.wait_for(timeout=5000)
        box = handle.bounding_box()
        cv = pg.evaluate(f"""() => {{ const r = {ED}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}""")
        tx, ty = cv[0] + cv[2] * (335 / 640), cv[1] + cv[3] * (130 / 360)
        pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(tx, ty, steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(400)
        n = pg.evaluate(f"() => {ED}.comp().nodes.find((x) => x.type === 'zdefocus')")
        # The box's depth as the Read and the LumaKeyer give it: between the ball's and the wall's.
        self.assertTrue(0.05 < n["focus"] < 0.9, n["focus"])
        self.assertTrue(n["focal_point"] and abs(n["focal_point"][0] - 335) < 12, n.get("focal_point"))
        # The focal plane setup: drawn without blurring, so a change of focus shows at once.
        pg.evaluate(f"() => {{ const e = {ED}; const z = e.comp().nodes.find((x) => x.type === 'zdefocus'); z.output = 'focal plane setup'; z.dof = 0.05; e.refresh(); }}")
        pg.wait_for_timeout(1200)
        self.assertIn("show image", rows())
        px = lambda fx, fy: pg.evaluate(f"""([fx, fy]) => {{ const c = {ED}.canvas; return Array.from(c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data); }}""", [fx, fy])
        boxp, ball, wall = px(335 / 640, 130 / 360), px(140 / 640, 250 / 360), px(560 / 640, 40 / 360)
        self.assertTrue(boxp[1] > boxp[0] and boxp[1] > boxp[2], f"the box in focus: green {boxp}")
        self.assertTrue(ball[0] > ball[1] and ball[0] > ball[2], f"the ball in front: red {ball}")
        self.assertTrue(wall[2] > wall[0] and wall[2] > wall[1], f"the wall behind: blue {wall}")
        focus = n["focus"]
        times = []
        for f in (0.3, 0.7, focus):
            pg.evaluate(f"() => {{ const e = {ED}; e.comp().nodes.find((x) => x.type === 'zdefocus').focus = {f}; e.refresh(); }}")
            pg.wait_for_timeout(500)
            times.append(pg.evaluate(f"() => {ED}.lastRender().ms"))
        self.assertLess(max(times), 400, f"the setup is drawn at once: {times} ms")
        self.shot(pg, "zdefocus-focal-plane-setup.png")
        pg.evaluate(f"() => {{ const e = {ED}; e.comp().nodes.find((x) => x.type === 'zdefocus').output = 'layer setup'; e.refresh(); }}")
        pg.wait_for_timeout(800)
        self.shot(pg, "zdefocus-layer-setup.png")
        pg.evaluate(f"""() => {{ const e = {ED}; const z = e.comp().nodes.find((x) => x.type === 'zdefocus');
            Object.assign(z, {{ output: 'filter shape setup', filter: 'bladed', blades: 6, roundness: 0.3, maximum: 120 }}); e.refresh(); }}""")
        pg.wait_for_timeout(1200)
        self.assertIn("blades", rows())
        self.shot(pg, "zdefocus-filter-shape-setup.png")
        # The result: the box stays sharp, the wall's lights and the ball are defocused.
        pg.evaluate(f"""() => {{ const e = {ED}; const z = e.comp().nodes.find((x) => x.type === 'zdefocus');
            Object.assign(z, {{ output: 'result', filter: 'disc', maximum: 16, dof: 0.05, bloom: 'on', bloom_threshold: 0.8, bloom_gain: 3 }}); e.refresh(); }}""")
        pg.wait_for_function(f"() => {ED}.lastRender().ms > 0", timeout=20000)
        pg.wait_for_timeout(6000)
        self.shot(pg, "zdefocus-result.png")
        self.shot(pg, "zdefocus-parameters.png", pg.locator(".comp-params"))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
