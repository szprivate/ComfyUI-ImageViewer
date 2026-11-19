"""The panel layout as a tree of splits (Sebastian 2026-11-19: "more panels side by side, or split panels horizontally
and vertically"): a panel dragged onto any edge of another panel, of the picture or of the whole area splits that
place; the splitters between them; the layout saved and read back; a layout of the old three rails read into it.

Needs Playwright and node; skipped without them. Run: python -m unittest tests.test_dock_split_browser
Serves tests/harness/dock.html (the REAL viewer js, ComfyUI stubbed) on a free port.
Screenshots with DOCK_SPLIT_SHOTS=<folder>.
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
SHOTS = os.environ.get("DOCK_SPLIT_SHOTS")

# The layout as a short string: V the picture, a panel by its id (hidden ones left out), a split as row(...) / col(...).
SHAPE = """()=>{const sh=(n)=>n.view?'V':n.id?(n.hidden?'':n.id):n.split+'('+n.children.map(sh).filter(Boolean).join(',')+')';
    const prune=(s)=>{let t=s;for(let i=0;i<9;i++)t=t.replace(/(row|col)\\(\\)/g,'').replace(/,,+/g,',').replace(/\\(,/g,'(').replace(/,\\)/g,')');return t};
    return prune(sh(__panel.dockLayout.root))}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class DockSplitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
        cls.server = subprocess.Popen(["node", os.path.join(ROOT, "tests", "harness", "server.mjs"), ROOT], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/dock.html", timeout=1).read()
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
        # A context of its own: the layout is kept in localStorage, which pages of one context share.
        ctx = self.browser.new_context(viewport={"width": 1500, "height": 950})
        self.addCleanup(ctx.close)
        pg = ctx.new_page()
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/dock.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('comfyui-image-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        pg.evaluate("()=>{const P=__panel;P.setPanelDocked('browser',true);P.setPanelDocked('history',true);}")
        pg.wait_for_timeout(200)
        return pg

    def shot(self, pg, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            pg.screenshot(path=os.path.join(SHOTS, name + ".png"))

    @staticmethod
    def rect(pg, sel):
        return pg.evaluate("""(s)=>{const e=s==='view'?__panel.dockViewEl:__panel.shadowRoot.querySelector(s);
            const r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}}""", sel)

    def header(self, pg, sel):
        r = self.rect(pg, sel + " > .panel-titlebar")
        # (clear of the switch at its left and the buttons at its right, also on the narrow History strip)
        return (r["l"] + min(60, r["w"] / 2), r["t"] + r["h"] / 2)

    @staticmethod
    def drag(pg, src, to, steps=12):
        pg.mouse.move(*src)
        pg.mouse.down()
        for i in range(1, steps + 1):
            pg.mouse.move(src[0] + (to[0] - src[0]) * i / steps, src[1] + (to[1] - src[1]) * i / steps)
        pg.wait_for_timeout(50)
        pg.mouse.up()
        pg.wait_for_timeout(200)

    def test_the_default_layout_is_the_rails_around_the_picture(self):
        pg = self.page()
        self.assertEqual(pg.evaluate(SHAPE), "col(row(col(history),V,col(params,browser)))")
        self.assertEqual(pg.evaluate("()=>[__panel._dockSideOf('history'), __panel._dockSideOf('params')]"), ["left", "right"])
        # the picture's place holds the viewport
        self.assertTrue(pg.evaluate("()=>__panel.dockViewEl.contains(__panel.viewport)"))
        self.assertEqual(self.errors, [])

    def test_a_panel_dropped_on_the_top_of_the_picture_goes_over_it(self):
        pg = self.page()
        v = self.rect(pg, "view")
        self.drag(pg, self.header(pg, "#browser-panel"), (v["l"] + v["w"] / 2, v["t"] + 20))
        self.assertEqual(pg.evaluate(SHAPE), "col(row(col(history),col(browser,V),col(params)))")
        b, v2 = self.rect(pg, "#browser-panel"), self.rect(pg, "view")
        self.assertLess(b["b"], v2["t"] + 1, "above the picture")
        self.assertAlmostEqual(b["w"], v2["w"], delta=8, msg="as wide as the picture")
        self.shot(pg, "1-files-over-the-picture")
        self.assertEqual(self.errors, [])

    def test_a_panel_dropped_on_the_side_of_another_puts_them_side_by_side(self):
        pg = self.page()
        p = self.rect(pg, "#params-panel")
        self.drag(pg, self.header(pg, "#browser-panel"), (p["l"] + 10, p["t"] + p["h"] / 2))
        self.assertEqual(pg.evaluate(SHAPE), "col(row(col(history),V,col(row(browser,params))))")
        b, p2 = self.rect(pg, "#browser-panel"), self.rect(pg, "#params-panel")
        self.assertLess(b["r"], p2["l"] + 1, "left of the parameters")
        self.assertAlmostEqual(b["t"], p2["t"], delta=2, msg="beside it, at one height")
        self.shot(pg, "2-side-by-side")
        # the splitter between them trades their width (the rail made wide enough for both to have room to give)
        pg.evaluate("()=>__panel.dockSetRailSize('right', 640)")
        b = self.rect(pg, "#browser-panel")
        sp = pg.evaluate("""()=>{const s=__panel.shadowRoot.querySelector('.stack-splitter.horizontal[data-after="browser"][data-before="params"]');
            const r=s.getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2]}""")
        before = b["w"]
        self.drag(pg, tuple(sp), (sp[0] - 60, sp[1]), steps=6)
        self.assertAlmostEqual(self.rect(pg, "#browser-panel")["w"], before - 60, delta=3)
        self.assertEqual(self.errors, [])

    def test_a_panel_dropped_on_the_edge_of_the_whole_area_spans_it(self):
        pg = self.page()
        m = self.rect(pg, "#dock-root")
        self.drag(pg, self.header(pg, "#history-panel"), (m["l"] + m["w"] / 2, m["b"] - 4))
        self.assertEqual(pg.evaluate(SHAPE), "col(row(V,col(params,browser)),history)")
        h = self.rect(pg, "#history-panel")
        self.assertAlmostEqual(h["w"], m["w"], delta=8, msg="as wide as everything")
        self.assertEqual(self.errors, [])

    def test_the_middle_of_a_panel_still_makes_a_tab(self):
        pg = self.page()
        p = self.rect(pg, "#params-panel")
        self.drag(pg, self.header(pg, "#history-panel"), (p["l"] + p["w"] / 2, p["t"] + p["h"] / 2))
        self.assertEqual(pg.evaluate("()=>[__panel.isPanelFront('history'), __panel.isPanelFront('params'), __panel.isPanelDocked('params')]"),
                         [True, False, True])
        self.assertEqual(self.errors, [])

    def test_the_layout_is_saved_and_read_back_and_an_old_one_is_read_into_it(self):
        pg = self.page()
        v = self.rect(pg, "view")
        self.drag(pg, self.header(pg, "#browser-panel"), (v["l"] + v["w"] / 2, v["b"] - 40))
        shape = pg.evaluate(SHAPE)
        self.assertEqual(shape, "col(row(col(history),col(V,browser),col(params)))")
        saved = pg.evaluate("()=>__panel.serializeDock()")
        self.assertEqual(saved["v"], 2)
        pg.evaluate("()=>__panel.applyDockData(__panel._defaultDockLayout())")
        self.assertNotEqual(pg.evaluate(SHAPE), shape)
        self.assertTrue(pg.evaluate("(d)=>__panel.applyDockData(d)", saved))
        self.assertEqual(pg.evaluate(SHAPE), shape)
        # A layout of the three rails, as 1.35 and before saved it.
        old = {"left": {"width": 200, "panels": [{"id": "params", "size": 1, "hidden": False}]},
               "right": {"width": 260, "panels": [{"id": "browser", "size": 1, "hidden": False}]},
               "bottom": {"height": 180, "panels": [{"id": "history", "size": 1, "hidden": False}]}}
        self.assertTrue(pg.evaluate("(d)=>__panel.applyDockData(d)", old))
        self.assertEqual(pg.evaluate(SHAPE), "col(row(col(params),V,col(browser)),row(history))")
        self.assertAlmostEqual(self.rect(pg, "#params-panel")["w"], 200, delta=2)  # the rail at its least: 200 + the card
        self.assertEqual(self.errors, [])

    def test_a_panel_put_back_where_it_shipped_finds_its_rail(self):
        pg = self.page()
        # every panel beside the picture in a split of their own: the rail is gone, and comes back for a panel
        v = self.rect(pg, "view")
        self.drag(pg, self.header(pg, "#history-panel"), (v["l"] + v["w"] / 2, v["t"] + 20))
        pg.evaluate("()=>__panel.dockPanelTo('history', 'left')")
        self.assertEqual(pg.evaluate("()=>__panel._dockSideOf('history')"), "left")
        self.assertEqual(self.errors, [])

    # ── spaces: a layout each ──

    TABS = """()=>{const P=__panel; for (const [k,v] of [['other',[{path:'D:/a.png',name:'a.png',external:true}]],['farm:',[]]]) {
        P.allTabs[k]=v; P.tabLabels[k]=k; P.tabOrder.push(k);} P._rebuildTabBar(null); P.switchTab('other');}"""

    def test_each_space_keeps_its_own_layout(self):
        pg = self.page()
        pg.evaluate(self.TABS)
        viewer = pg.evaluate(SHAPE)
        self.assertEqual(pg.evaluate("()=>__panel.dockSpace()"), "viewer")
        # The Farm seen for the first time starts from the layout as it is; a change there stays there.
        pg.evaluate("()=>__panel.switchTab('farm:')")
        self.assertEqual(pg.evaluate("()=>__panel.dockSpace()"), "farm")
        self.assertEqual(pg.evaluate(SHAPE), viewer)
        v = self.rect(pg, "view")
        self.drag(pg, self.header(pg, "#browser-panel"), (v["l"] + v["w"] / 2, v["t"] + 20))
        farm = pg.evaluate(SHAPE)
        self.assertNotEqual(farm, viewer)
        pg.evaluate("()=>__panel.switchTab('other')")
        self.assertEqual(pg.evaluate(SHAPE), viewer, "the Viewer's layout comes back with its tab")
        pg.evaluate("()=>__panel.switchTab('farm:')")
        self.assertEqual(pg.evaluate(SHAPE), farm)
        # Saved with both, read back with both - whichever space is up.
        saved = pg.evaluate("()=>__panel.serializeDock()")
        self.assertEqual((saved["space"], sorted(saved["spaces"])), ("farm", ["viewer"]))
        pg.evaluate("()=>__panel.switchTab('other')")
        pg.evaluate("(d)=>{__panel._dockSpaces={}; __panel.applyDockData(d)}", saved)
        self.assertEqual(pg.evaluate(SHAPE), viewer)
        pg.evaluate("()=>__panel.switchTab('farm:')")
        self.assertEqual(pg.evaluate(SHAPE), farm)
        # Reset: this space's panels back to how they shipped; the other space's stay.
        pg.evaluate("()=>__panel.dockSpaceReset()")
        self.assertEqual(pg.evaluate(SHAPE), "col(row(V,col(params)))")
        pg.evaluate("()=>__panel.switchTab('other')")
        self.assertEqual(pg.evaluate(SHAPE), viewer)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
