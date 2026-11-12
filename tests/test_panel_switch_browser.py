"""The panels as containers (Sebastian 2026-11-12): the button left of a panel's name opens a menu that switches
what that place shows, in place; and the panels' look (rounded outlines, a taller title bar).

Needs Playwright and node; skipped without them. Run: python -m unittest tests.test_panel_switch_browser
Serves tests/harness/dock.html (the REAL viewer js, ComfyUI stubbed) on a free port.
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

LAYOUT = """()=>{const L=__panel.dockLayout;return Object.fromEntries(['left','right','bottom'].map(s=>
    [s,L[s].panels.filter(p=>!p.hidden&&!p.behind).map(p=>p.id)]))}"""
MENU = """()=>{const m=__panel._previzAddMenu; if(!m) return null;
    return [...m.querySelectorAll('.previz-menu-head, .previz-menu-item')].map(e=>
        e.classList.contains('previz-menu-head') ? '# '+e.textContent : e.textContent.trim())}"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class PanelSwitchTests(unittest.TestCase):
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
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, []))
        pg.goto(f"http://127.0.0.1:{self.port}/dock.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('comfyui-image-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        pg.evaluate("()=>{const P=__panel;P.setPanelDocked('history',true);P.setPanelDocked('browser',true);"
                    "P.setPanelDocked('agentChat',false);P.applyDockLayout();}")
        pg.wait_for_timeout(300)
        return pg

    @staticmethod
    def viewer(pg):
        return pg.locator("comfyui-image-viewer-panel").first      # the harness's setup() makes a second one

    def open_switch(self, pg, panel_id):
        self.viewer(pg).locator(f"#{panel_id}-switch-btn").click()     # Playwright pierces the open shadow root
        pg.wait_for_timeout(100)
        return pg.evaluate(MENU)

    def pick(self, pg, label):
        self.viewer(pg).locator(".previz-menu .previz-menu-item", has_text=label).first.click()
        pg.wait_for_timeout(200)

    def test_the_title_bar_is_taller_and_the_panels_are_rounded(self):
        pg = self.page()
        info = pg.evaluate("""()=>{const sr=__panel.shadowRoot, el=sr.getElementById('params-panel');
            const bar=el.querySelector(':scope > .panel-titlebar'), cs=getComputedStyle(el);
            const first=bar.firstElementChild;
            return {h: bar.getBoundingClientRect().height, radius: parseFloat(cs.borderTopLeftRadius),
                    border: cs.borderTopStyle, first: first.className, tag: first.tagName}}""")
        self.assertGreaterEqual(info["h"], 24)
        self.assertGreater(info["radius"], 3)
        self.assertEqual(info["border"], "solid")
        self.assertEqual((info["tag"], info["first"]), ("BUTTON", "pt-switch"), "the switch stands left of the name")

    def test_the_title_bar_wears_a_slight_accent_of_the_space(self):
        pg = self.page()
        js = """()=>{const sr=__panel.shadowRoot, el=sr.getElementById('params-panel');
            const bar=el.querySelector(':scope > .panel-titlebar');
            const rgb=(c)=>{const x=document.createElement('canvas').getContext('2d');x.fillStyle=c;x.fillRect(0,0,1,1);
                return [...x.getImageData(0,0,1,1).data].slice(0,3)};
            return {bar: rgb(getComputedStyle(bar).backgroundColor), panel: rgb(getComputedStyle(el).backgroundColor)}}"""
        pg.evaluate("()=>__panel.switchTab('folder_history')")       # the Viewer tab: blue
        c = pg.evaluate(js)
        self.assertNotEqual(c["bar"], c["panel"], "the top row is not the panel's own ground")
        r, g, b = c["bar"]
        self.assertGreater(b, r + 10, "the Viewer space's blue is mixed in")
        self.assertLess(max(c["bar"]) - max(c["panel"]), 40, "only slightly")

    def test_the_menu_lists_the_panels_with_this_one_ticked(self):
        pg = self.page()
        items = self.open_switch(pg, "params")
        self.assertEqual(items[0], "# Viewer")
        self.assertIn("\u2713  Parameters", pg.evaluate(
            "()=>[...__panel._previzAddMenu.querySelectorAll('.previz-menu-item')].map(e=>e.textContent)"))
        for name in ("History", "Files"):
            self.assertIn(name, items)
        self.assertFalse(any(i.startswith("# 3D") for i in items), "3D panels only on a 3D tab")
        self.assertTrue(pg.evaluate("()=>__panel.shadowRoot.getElementById('params-switch-btn').classList.contains('open')"))
        # a press on the button again closes it
        self.viewer(pg).locator("#params-switch-btn").click()
        pg.wait_for_timeout(100)
        self.assertIsNone(pg.evaluate(MENU))

    def test_a_hidden_panel_takes_the_place_and_the_other_goes(self):
        pg = self.page()
        pg.evaluate("()=>__panel.setPanelDocked('browser',false)")
        before = pg.evaluate(LAYOUT)
        self.assertEqual(before["right"], ["params"])
        self.open_switch(pg, "params")
        self.pick(pg, "Files")
        after = pg.evaluate(LAYOUT)
        self.assertEqual(after["right"], ["browser"])
        self.assertFalse(pg.evaluate("()=>__panel.isPanelDocked('params')"))
        # and back: Parameters comes up where Files is now
        self.open_switch(pg, "browser")
        self.pick(pg, "Parameters")
        self.assertEqual(pg.evaluate(LAYOUT)["right"], ["params"])

    def test_a_panel_open_elsewhere_trades_places(self):
        pg = self.page()
        before = pg.evaluate(LAYOUT)
        self.assertEqual(before["left"], ["history"])
        i = before["right"].index("browser")
        self.open_switch(pg, "browser")
        self.pick(pg, "History")
        after = pg.evaluate(LAYOUT)
        self.assertEqual(after["left"], ["browser"])
        self.assertEqual(after["right"][i], "history")
        # the rail it came into is wide enough for it
        w = pg.evaluate("()=>__panel.shadowRoot.getElementById('browser-panel').getBoundingClientRect().width")
        self.assertGreaterEqual(w, 170)

    def test_switching_to_a_tab_mate_brings_it_to_the_front(self):
        pg = self.page()
        pg.evaluate("()=>{const P=__panel; P.previzNewTab();}")
        pg.wait_for_timeout(600)
        pg.evaluate("()=>{const P=__panel; P.setPanelDocked('curves',true);}")
        pg.wait_for_timeout(200)
        items = self.open_switch(pg, "curves")
        self.assertIn("# 3D", items)
        self.assertIn("Channel Box", items, "Parameters is the Channel Box on a 3D tab")
        self.pick(pg, "Dope Sheet")
        L = pg.evaluate(LAYOUT)
        self.assertIn("dopeSheet", L["bottom"])
        self.assertNotIn("curves", L["bottom"])
        state = pg.evaluate("""()=>{const L=__panel.dockLayout.bottom.panels;
            const c=L.find(p=>p.id==='curves'), d=L.find(p=>p.id==='dopeSheet'); return [c.tab===d.tab, !!c.behind, !!d.behind]}""")
        self.assertEqual(state, [True, True, False], "still tabs of one place, the Dope Sheet in front")


if __name__ == "__main__":
    unittest.main()
