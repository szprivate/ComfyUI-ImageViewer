"""Small fixes to the 3D space's modeling and canvas, with the real mouse and keys, in a real browser.

Sebastian 2026-11-20: selected edges drawn thicker; the selection box a little outside the object
and gone while a mesh is edited; Fill Hole; Backspace deletes (a Mac's delete key) in the view and
the Outliner; a bevel leaves no triangles on the faces beside it; a right-click menu in the view
with everything there is for the selection; the Animate menu not lit when it is not open.

Needs Playwright with an installed browser and node; skipped without them.
MODELING_SHOTS=<folder> saves screenshots.
Run: python -m unittest tests.test_view3d_modeling_polish_browser
"""
import os
import unittest

from tests import test_view3d_modeling_browser as base

SCREEN, STATS = base.SCREEN, base.STATS


class ModelingPolishTests(base.ModelingTests):
    # Only the tests below; the base class's own run from their own module.
    for _name in [n for n in dir(base.ModelingTests) if n.startswith("test_")]:
        locals()[_name] = None
    del _name

    def test_selected_edges_are_thick_and_the_box_steps_aside(self):
        pg, ids = self._page()
        box = ids["box"]
        try:
            # The Select tool boxes the selection: a little outside the object.
            pg.evaluate("() => window.__panel._modelView().setGizmoMode('select')")
            pg.wait_for_timeout(100)
            boxed = pg.evaluate(f"""() => {{ const v = window.__panel._modelView();
                const b = v._alsoBoxes.get('{box}'); const a = b.geometry.attributes.position.array;
                let m = 0; for (let i = 0; i < a.length; i += 3) m = Math.max(m, a[i + 1]);
                return {{ visible: b.visible, top: m }}; }}""")
            self._hover_view(pg)
            pg.keyboard.press("Tab")
            pg.keyboard.press("2")
            pg.wait_for_timeout(100)
            hidden = pg.evaluate(f"() => window.__panel._modelView()._alsoBoxes.get('{box}').visible")
            e = pg.evaluate(SCREEN, [0.5, 0.5, 0.5])
            self._click(pg, e)
            thick = pg.evaluate("""() => { const me = window.__panel._modelView()._me;
                return me.thick ? { edges: me.thick.userData.edges.length, w: me.thick.material.uniforms.uWidth.value } : null; }""")
            # The drawn width: count the lit pixels across the selected edge's middle.
            mid = pg.evaluate(SCREEN, [0.5, 0.5, 0.5])
            png = pg.screenshot(clip={"x": mid["x"] - 12, "y": mid["y"] - 1, "width": 24, "height": 1})
            self._shot(pg, "mesh_thick_edge.png")
            pg.keyboard.press("Tab")
            pg.wait_for_timeout(100)
            back = pg.evaluate(f"() => window.__panel._modelView()._alsoBoxes.get('{box}').visible")
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertTrue(boxed["visible"])
        self.assertGreater(boxed["top"], 1.01)           # the box's top is 1; the line is drawn outside it
        self.assertFalse(hidden)
        self.assertEqual(thick["edges"], 1)
        self.assertGreaterEqual(thick["w"], 3)
        self.assertTrue(back)
        self.assertTrue(len(png) > 0)

    def test_fill_hole_and_backspace(self):
        pg, ids = self._page()
        box = ids["box"]
        try:
            self._hover_view(pg)
            pg.keyboard.press("Tab")
            pg.keyboard.press("3")
            top = pg.evaluate(SCREEN, [0, 1, 0])
            self._click(pg, top)
            self._hover_view(pg)
            pg.keyboard.press("Backspace")                  # a Mac's delete key
            pg.wait_for_timeout(150)
            holed = pg.evaluate(STATS, box)
            label = pg.evaluate("""() => [...window.__panel._modelView().stage.querySelectorAll('.model-mesh-bar button')]
                .map((b) => b.textContent).filter((t) => /Fill/.test(t))""")
            pg.keyboard.press("Alt+f")
            pg.wait_for_timeout(150)
            filled = pg.evaluate(STATS, box)
            pg.keyboard.press("Tab")
            pg.wait_for_timeout(100)
            # Backspace over the view deletes the selected object.
            pg.evaluate(f"() => window.__panel.previzSelect('{box}')")
            self._hover_view(pg)
            pg.keyboard.press("Backspace")
            pg.wait_for_timeout(150)
            gone = pg.evaluate(f"() => !window.__panel.previzScene().items.some((i) => i.id === '{box}')")
            # ... and over the Outliner.
            pg.evaluate(f"() => window.__panel.previzSelect('{ids['shape']}')")
            row = pg.evaluate(f"""() => {{ const r = window.__panel.container.querySelector('[data-select-id="{ids['shape']}"]')
                || window.__panel.shadowRoot.querySelector('[data-select-id="{ids['shape']}"]');
                if (!r) return null; const b = r.getBoundingClientRect(); return {{ x: b.left + b.width / 2, y: b.top + b.height / 2 }}; }}""")
            if row:
                pg.mouse.move(row["x"], row["y"])
                pg.wait_for_timeout(60)
                pg.keyboard.press("Backspace")
                pg.wait_for_timeout(150)
            shape_gone = pg.evaluate(f"() => !window.__panel.previzScene().items.some((i) => i.id === '{ids['shape']}')")
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(holed["faces"], 5)
        self.assertEqual(label, ["Fill Hole"])
        self.assertEqual(filled["faces"], 6)
        self.assertTrue(gone)
        self.assertIsNotNone(row)
        self.assertTrue(shape_gone)

    def test_a_right_click_in_the_view_opens_a_menu_for_what_is_under_it(self):
        pg, ids = self._page()
        box = ids["box"]
        menu_labels = """() => { const m = window.__panel._previzAddMenu; return m ? [...m.querySelectorAll(':scope > .previz-menu-item, :scope > .previz-menu-subwrap > .previz-menu-item')].map((b) => b.textContent) : null; }"""
        try:
            pg.evaluate("() => window.__panel.previzSelect(null)")
            # On the sphere: it is selected, the menu is about it.
            sph = pg.evaluate(SCREEN, [-3, 0.5, 0])
            pg.mouse.click(sph["x"], sph["y"], button="right")
            pg.wait_for_timeout(150)
            on_sphere = pg.evaluate(menu_labels)
            selected = pg.evaluate("() => window.__panel.previzSelectedIds()")
            self._shot(pg, "view_context_menu.png")
            pg.keyboard.press("Escape")
            # A right drag pans: no menu.
            pg.mouse.move(sph["x"], sph["y"])
            pg.mouse.down(button="right")
            pg.mouse.move(sph["x"] + 60, sph["y"] + 20, steps=6)
            pg.mouse.up(button="right")
            pg.wait_for_timeout(100)
            after_drag = pg.evaluate(menu_labels)
            # Editing a mesh: the mesh's tools.
            pg.evaluate(f"() => window.__panel._modelView().meshEditBegin('{box}', 'edge')")
            pg.wait_for_timeout(100)
            c = pg.evaluate(SCREEN, [0, 0.5, 0.5])
            pg.mouse.click(c["x"], c["y"], button="right")
            pg.wait_for_timeout(150)
            editing = pg.evaluate(menu_labels)
            self._shot(pg, "view_context_menu_mesh.png")
            pg.keyboard.press("Escape")
            # The Mesh menu's submenus open (they are made when the menu opens).
            subs = pg.evaluate("""() => { const P = window.__panel; P.previzMenuBarOpen('mesh');
                const n = P._previzAddMenu.querySelectorAll('.previz-submenu .previz-menu-item').length; P._previzCloseAddMenu(); return n; }""")
            # The Animate button is not lit when its menu is shut.
            colours = pg.evaluate("""() => { const q = (c) => getComputedStyle(window.__panel._modelView().root.querySelector(c)).color;
                return [q('.previz-anim'), q('.previz-rig')]; }""")
        finally:
            pg.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(selected, [ids["shape"]])
        for want in ("Rename", "Duplicate", "Delete", "Convert to editable mesh", "Centre Pivot", "Animate", "Constrain"):
            self.assertIn(want, on_sphere)
        self.assertIsNone(after_drag)
        for want in ("Done editing", "Extrude", "Bevel", "Fill hole", "Delete"):
            self.assertIn(want, editing)
        self.assertGreater(subs, 5)
        self.assertEqual(colours[0], colours[1])


if __name__ == "__main__":
    unittest.main()
