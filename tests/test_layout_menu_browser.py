"""The Panel Layout menu (js/imageViewer_mixinLayout.js): filled whether or not a layouts file is saved.

Run: python -m unittest tests.test_layout_menu_browser   (Playwright with Edge or Chrome and node; skipped without)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_edit_timeline_browser as base  # noqa: E402

OPTIONS = "() => [...__panel.shadowRoot.getElementById('layout-sel').options].map((o) => o.value)"


class _Base(base.EditTimelineBrowserTests):
    pass


for _name in [n for n in dir(base.EditTimelineBrowserTests) if n.startswith("test")]:
    setattr(_Base, _name, None)


class LayoutMenuBrowserTests(_Base):
    def page_with(self, files):
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.add_init_script("window.__userData = %s;" % __import__("json").dumps(files))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        return pg

    def test_the_menu_has_its_items_with_no_layouts_file(self):
        pg = self.page_with({})
        vals = pg.evaluate(OPTIONS)
        for v in ("__factory__", "__make_default__", "__dock__:right", "__dock__:", "__manage__", "__store__"):
            self.assertIn(v, vals)
        self.assertEqual(self.errors, [])

    def test_layouts_saved_under_the_old_name_are_listed(self):
        pg = self.page_with({"bEpicViewer_layouts.json": {"Review": {"width": "800px"}}})
        self.assertIn("custom:Review", pg.evaluate(OPTIONS))

    def test_the_new_name_wins_over_the_old(self):
        pg = self.page_with({"imageViewer_layouts.json": {"New": {}}, "bEpicViewer_layouts.json": {"Old": {}}})
        vals = pg.evaluate(OPTIONS)
        self.assertIn("custom:New", vals)
        self.assertNotIn("custom:Old", vals)


if __name__ == "__main__":
    unittest.main()
