"""The main view is a panel too (Sebastian 2026-11-19: "main views (3d viewer, comp viewer etc) should become panels as
well"): a title bar naming the tab it shows, a switch that picks the tab, dragged like a panel - beside a panel or the
whole area, onto a panel's middle to trade places - and a maximise button.

Needs Playwright and node; skipped without them. Run: python -m unittest tests.test_main_view_panel_browser
Serves tests/harness/dock.html. Screenshots with MAIN_VIEW_SHOTS=<folder>.
"""
import os
import unittest

import test_dock_split_browser as base

SHAPE = base.SHAPE
B = base.DockSplitTests.__dict__
SHOTS = os.environ.get("MAIN_VIEW_SHOTS")


@unittest.skipIf(base.sync_playwright is None or base.shutil.which("node") is None, "needs playwright and node")
class MainViewPanelTests(unittest.TestCase):
    setUpClass = B["setUpClass"]
    tearDownClass = B["tearDownClass"]
    page = B["page"]
    rect = B["rect"]
    header = B["header"]
    drag = B["drag"]

    def shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, name + ".png"))

    def bar(self, pg):
        r = self.rect(pg, "#dock-view > .panel-titlebar")
        return (r["l"] + r["w"] / 2, r["t"] + r["h"] / 2)

    def test_the_main_view_has_a_title_bar_that_names_and_switches_its_tab(self):
        pg = self.page()
        info = pg.evaluate("""()=>{const P=__panel, bar=P.dockViewEl.querySelector(':scope > .panel-titlebar');
            return {bar: !!bar, inBody: P.dockViewBody.contains(P.viewport), name: bar.querySelector('.pt-name').textContent,
                    label: P._dockViewLabel(P.activeTab), close: !!bar.querySelector('.pt-close'), tabs: P.tabOrder.length}}""")
        self.assertTrue(info["bar"])
        self.assertTrue(info["inBody"], "the picture is the panel's body")
        self.assertEqual(info["name"], info["label"] or "Main view")
        self.assertFalse(info["close"], "there is always a main view")
        # the bar sits above the picture
        b, vp = self.rect(pg, "#dock-view > .panel-titlebar"), self.rect(pg, "#viewport")
        self.assertLessEqual(b["b"], vp["t"] + 1)
        # the switch lists the open tabs; picking one shows it there
        pg.evaluate("""()=>{const P=__panel;
            for (const k of ['pic_a','pic_b']) { P.allTabs[k]=[{path:'D:/'+k+'.png',name:k+'.png',external:true}]; P.tabLabels[k]=k;
                P.tabOrder=[...(P.tabOrder||[]),k]; }
            P.switchTab('pic_a');}""")
        keys = pg.evaluate("()=>__panel.tabOrder.filter(k=>__panel.allTabs[k])")
        self.assertEqual(pg.evaluate("()=>__panel.dockViewEl.querySelector('.pt-name').textContent"), "pic_a")
        pg.click("comfyui-image-viewer-panel >> #view-switch-btn")
        items = pg.evaluate("()=>[...__panel.shadowRoot.querySelectorAll('.view-switch-menu .previz-menu-item')].map(e=>e.textContent.trim())")
        self.assertGreaterEqual(len(items), len(keys))
        self.assertTrue(any(i.startswith("✓") for i in items), items)
        self.shot(pg, "1-view-switch-menu")
        pg.evaluate("""()=>[...__panel.shadowRoot.querySelectorAll('.view-switch-menu .previz-menu-item')]
            .find(e=>e.textContent.trim()==='pic_b').click()""")
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate("()=>__panel.activeTab"), "pic_b")
        self.assertEqual(pg.evaluate("()=>__panel.dockViewEl.querySelector('.pt-name').textContent"), "pic_b")
        self.assertEqual(self.errors, [])

    def test_the_main_view_is_dragged_beside_a_panel(self):
        pg = self.page()
        p = self.rect(pg, "#params-panel")
        self.drag(pg, self.bar(pg), (p["l"] + p["w"] / 2, p["b"] - 12))
        self.assertEqual(pg.evaluate(SHAPE), "col(row(col(history),col(params,V,browser)))")
        self.assertTrue(pg.evaluate("()=>__panel.dockViewBody.contains(__panel.viewport)"))
        v = self.rect(pg, "view")
        self.assertGreater(v["w"], 200)
        self.assertGreater(v["h"], 120)
        self.shot(pg, "2-view-under-the-parameters")
        # and to the left edge of everything
        m = self.rect(pg, "#dock-root")
        self.drag(pg, self.bar(pg), (m["l"] + 4, m["t"] + m["h"] / 2))
        self.assertEqual(pg.evaluate(SHAPE), "row(V,col(row(col(history),col(params,browser))))")
        self.assertEqual(self.errors, [])

    def test_the_main_view_trades_places_with_a_panel(self):
        pg = self.page()
        h = self.rect(pg, "#history-panel")
        self.drag(pg, self.bar(pg), (h["l"] + h["w"] / 2, h["t"] + h["h"] / 2))
        self.assertEqual(pg.evaluate(SHAPE), "col(row(col(V),history,col(params,browser)))")
        self.shot(pg, "3-view-and-history-traded")
        # the layout is kept with the space
        saved = pg.evaluate("()=>JSON.stringify(__panel.serializeDock().root)")
        self.assertIn('"view":true', saved)
        self.assertEqual(self.errors, [])

    def test_the_main_view_fills_the_viewer_and_goes_back(self):
        pg = self.page()
        before = self.rect(pg, "view")
        pg.click("comfyui-image-viewer-panel >> #view-max-btn")
        pg.wait_for_timeout(100)
        big, c = self.rect(pg, "view"), self.rect(pg, ".panel-container")
        self.assertAlmostEqual(big["w"], c["w"], delta=2)
        self.assertGreater(big["w"], before["w"] + 100)
        self.shot(pg, "4-view-maximised")
        pg.click("comfyui-image-viewer-panel >> #view-max-btn")
        pg.wait_for_timeout(100)
        self.assertAlmostEqual(self.rect(pg, "view")["w"], before["w"], delta=2)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
