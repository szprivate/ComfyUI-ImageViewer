"""The Comp space's Paint node and viewer tools in the REAL viewer: strokes painted on the picture with the
Paint node's own tool (brush, eraser, clone, frames), undone in one step; A / B wipe and difference, the pixel
sampler, the scopes, the out-of-range marks and the guides.

    python -m unittest tests.test_comp_paint_tools_browser     (Playwright and aiohttp; skipped without)
COMP_SHOTS=<folder> writes screenshots.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_comp_browser as base  # noqa: E402

SHOTS, sync_playwright, web = base.SHOTS, base.sync_playwright, base.web
B = base.CompBrowserTests

ED = "__panel.compEditor()"


@unittest.skipIf(sync_playwright is None or web is None, "needs playwright and aiohttp")
class CompPaintToolsBrowserTests(unittest.TestCase):
    setUpClass = classmethod(B.setUpClass.__func__)
    tearDownClass = classmethod(B.tearDownClass.__func__)
    page = B.page
    new_comp = B.new_comp
    pixel = B.pixel
    ED = ED

    def at(self, pg, fx, fy):
        """The screen point at a share of the picture's width / height."""
        b = pg.evaluate(f"() => {{ const r = {ED}.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
        return b[0] + b[2] * fx, b[1] + b[3] * fy

    def drag(self, pg, a, b, steps=8, mods=()):
        for m in mods:
            pg.keyboard.down(m)
        pg.mouse.move(*a)
        pg.mouse.down()
        pg.mouse.move(*b, steps=steps)
        pg.mouse.up()
        for m in mods:
            pg.keyboard.up(m)
        pg.wait_for_timeout(250)

    def strokes(self, pg):
        return pg.evaluate(f"() => ({ED}.comp().nodes.find((n) => n.type === 'paint').strokes || [])")

    def tool(self, pg, name):
        pg.locator(f".cp-ptools button[data-ptool={name}]").click()

    def test_strokes_are_painted_erased_cloned_and_kept_to_their_frames(self):
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate(f"""() => {{ const e = {ED}; e.select(['Constant1']);
            e.addNode('grade', {{ offset: 0.18 }}); e.addNode('paint'); }}""")
        pg.wait_for_timeout(500)
        self.assertEqual(pg.locator(".cp-ptools button").count(), 5)
        grey = self.pixel(pg, 0.5, 0.5)
        # The brush: a white stroke across the middle; one undo step takes it away.
        self.tool(pg, "color")
        self.drag(pg, self.at(pg, 0.2, 0.5), self.at(pg, 0.8, 0.5))
        s = self.strokes(pg)
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0]["tool"], "color")
        self.assertGreater(len(s[0]["pts"]), 2)
        self.assertGreater(self.pixel(pg, 0.5, 0.5)[0], 240)
        self.assertEqual(self.pixel(pg, 0.5, 0.2)[:3], grey[:3])
        self.assertEqual(pg.locator(".cp-prow").count(), 1)
        pg.evaluate(f"() => {ED}.undo()")
        pg.wait_for_timeout(300)
        self.assertEqual(self.strokes(pg), [])
        self.assertEqual(self.pixel(pg, 0.5, 0.5)[:3], grey[:3])
        pg.evaluate(f"() => {ED}.redo()")
        pg.wait_for_timeout(300)
        # The eraser: through the white and the grey to nothing (the comp's black behind).
        self.tool(pg, "erase")
        self.drag(pg, self.at(pg, 0.5, 0.3), self.at(pg, 0.5, 0.7))
        self.assertEqual(self.pixel(pg, 0.5, 0.5)[:3], [0, 0, 0])
        self.assertGreater(self.pixel(pg, 0.3, 0.5)[0], 240)
        # Clone: Alt+click on the white line sets the source; the stroke above copies it there.
        self.tool(pg, "clone")
        pg.keyboard.down("Alt")
        pg.mouse.click(*self.at(pg, 0.3, 0.5))
        pg.keyboard.up("Alt")
        self.drag(pg, self.at(pg, 0.3, 0.25), self.at(pg, 0.35, 0.25))
        s = self.strokes(pg)
        self.assertEqual(s[-1]["tool"], "clone")
        self.assertAlmostEqual(s[-1]["offset"][1], 0.25 * 1080, delta=6)
        self.assertGreater(self.pixel(pg, 0.32, 0.25)[0], 200)
        if SHOTS:
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-paint-node.png"))
        # A stroke for this frame only: there at frame 0, gone at frame 5.
        self.tool(pg, "color")
        pg.locator(".cp-pane.first .cp-pbrushrows .mg-prop", has_text="frames").locator("select").select_option("single")
        self.drag(pg, self.at(pg, 0.7, 0.8), self.at(pg, 0.9, 0.8))
        self.assertEqual(self.strokes(pg)[-1]["life"], "single")
        self.assertGreater(self.pixel(pg, 0.8, 0.8)[0], 200)
        pg.evaluate(f"() => {ED}.setFrame(5)")
        pg.wait_for_timeout(400)
        self.assertEqual(self.pixel(pg, 0.8, 0.8)[:3], grey[:3])
        self.assertIn("idle", pg.locator(".cp-prow").last.get_attribute("class"))
        # Picked with the Select tool and deleted with Del.
        pg.evaluate(f"() => {ED}.setFrame(0)")
        pg.wait_for_timeout(300)
        self.tool(pg, "select")
        pg.mouse.click(*self.at(pg, 0.8, 0.8))
        self.assertIn("sel", pg.locator(".cp-prow").last.get_attribute("class"))
        pg.keyboard.press("Delete")
        pg.wait_for_timeout(300)
        self.assertEqual(len(self.strokes(pg)), 3)
        self.assertEqual(self.errors, [])

    def menu(self, pg, label):
        pg.locator(".mg-btn.cp-vtools").click()
        pg.locator(".cp-pop div", has_text=label).first.click()
        pg.wait_for_timeout(350)

    def test_compare_sampler_scopes_out_of_range_and_guides(self):
        pg = self.page()
        self.new_comp(pg)
        pg.evaluate(f"""() => {{ const e = {ED}; e.select(['Constant1']);
            e.addNode('grade', {{ offset: 0.5 }}); e.addNode('grade', {{ multiply: 3 }}); }}""")
        pg.wait_for_timeout(400)
        # B: the first Grade (select it, 2 in the graph); compare is on as a wipe.
        pg.evaluate(f"() => {ED}.select(['Grade1'])")
        pg.locator(".cp-graph").focus()
        pg.keyboard.press("2")
        pg.wait_for_timeout(400)
        self.assertEqual(pg.locator(".cp-node .cp-btag").count(), 1)
        self.assertEqual(pg.evaluate(f"() => {ED}.state.zoom && __panel.compEditor().stage.querySelectorAll('.cp-wipe').length"), 1)
        left, right = self.pixel(pg, 0.25, 0.5), self.pixel(pg, 0.75, 0.5)
        self.assertEqual(left[:3], [255, 255, 255], "A: 1.5, shown as white")
        self.assertLess(right[0], 250, "B: 0.5")
        self.assertGreater(right[0], 150)
        # The wipe's handle moves it.
        h = pg.locator(".cp-over .cp-wipeh").bounding_box()
        cx, cy = h["x"] + h["width"] / 2, h["y"] + h["height"] / 2
        self.drag(pg, (cx, cy), self.at(pg, 0.85, 0.5))
        self.assertAlmostEqual(pg.evaluate(f"() => {ED}.stage && JSON.parse(localStorage.getItem('imageviewer.comp.viewTools')).wipe"), 0.85, delta=0.02)
        self.assertEqual(self.pixel(pg, 0.75, 0.5)[:3], [255, 255, 255])
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "comp-wipe.png"))
        # Difference: |1.5 - 0.5| = 1 everywhere.
        self.menu(pg, "Compare: Difference")
        self.assertEqual(self.pixel(pg, 0.5, 0.5)[:3], [255, 255, 255])
        self.assertIn("difference with", pg.locator(".cp-info").inner_text())
        self.menu(pg, "Compare: Off")
        # The sampler: the numbers under the pointer, in working space.
        self.menu(pg, "Pixel sampler")
        pg.mouse.move(*self.at(pg, 0.4, 0.4))
        pg.wait_for_timeout(200)
        text = pg.locator(".cp-sample").inner_text()
        self.assertIn("1.5000", text)
        # A box: Shift+drag, its mean.
        self.drag(pg, self.at(pg, 0.3, 0.3), self.at(pg, 0.6, 0.6), mods=("Shift",))
        text = pg.locator(".cp-sample").inner_text()
        self.assertIn("mean of", text)
        self.assertIn("1.5000", text)
        self.assertEqual(pg.locator(".cp-over .cp-sbox").count(), 1)
        # Out of range: 1.5 is over 1 - striped, and counted in the info line.
        self.menu(pg, "Out-of-range colours")
        self.assertIn("out of 0–1", pg.locator(".cp-info").inner_text())
        marks = [self.pixel(pg, 0.5 + i * 0.002, 0.5) for i in range(8)]
        self.assertTrue(any(p[:3] == [255, 40, 40] for p in marks), marks)
        # Scopes: each one draws something.
        for name in ("Histogram", "Waveform", "Vectorscope"):
            self.menu(pg, name)
            self.assertTrue(pg.locator(".cp-scope").is_visible())
            lit = pg.evaluate("""() => { const c = __panel.compEditor().stage.querySelector('.cp-scope canvas');
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 60) n++; return n; }""")
            self.assertGreater(lit, 0, name)
            self.assertIn(name, pg.locator(".cp-scope-title").inner_text())
        # Guides: the format box and the two safe areas.
        self.menu(pg, "Format box")
        self.menu(pg, "Action / title safe")
        self.menu(pg, "Centre")
        self.assertEqual(pg.locator(".cp-over rect.cp-gfmt").count(), 1)
        self.assertEqual(pg.locator(".cp-over rect.cp-gsafe").count(), 2)
        self.assertIn("1920×1080", pg.locator(".cp-over .cp-glabel").text_content())
        self.assertIn("on:", pg.locator(".mg-btn.cp-vtools").get_attribute("title"))
        if SHOTS:
            pg.wait_for_timeout(300)
            pg.screenshot(path=os.path.join(SHOTS, "comp-viewer-tools.png"))
        self.assertEqual(self.errors, [])


del B   # not a test class of this file

if __name__ == "__main__":
    unittest.main()
