"""The viewer in a real browser, with real pointer input: the dock drag (issue #83) and the Motion tab (issue #84).

Needs Playwright with an installed Edge or Chrome (``channel``), and node for the stub server; skipped without them.
Run: python -m unittest tests.test_viewer_browser
It serves tests/harness/{dock,motion}.html - the REAL viewer js against stubbed ComfyUI scripts - on a free port, so
it never touches a running ComfyUI.
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
EXAMPLES = os.path.join(ROOT, "..", "agentY-core", "agenty_core", "motion_graphics", "examples")
MG_PANELS = "['motionLayers','motionProps','motionTimeline']"
TITLE_TAB = "motion:D:/out/title_card.mgscene.json"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
@unittest.skipUnless(os.path.isdir(EXAMPLES), "needs the agentY-core checkout beside this one (example scenes)")
class BrowserTests(unittest.TestCase):
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

    def page(self, name):
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/{name}.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        # the stub extension's setup() makes a second, floating viewer: keep it out of the way
        pg.evaluate("()=>{const all=document.querySelectorAll('bepic-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        return pg

    # ---- #83: the dock drag -----------------------------------------------------------------------------------

    @staticmethod
    def layout(pg):
        return pg.evaluate("""()=>{const L=__panel.dockLayout;return Object.fromEntries(['left','right','bottom'].map(s=>
            [s,L[s].panels.filter(p=>!p.hidden&&!p.behind).map(p=>p.id)]))}""")

    @staticmethod
    def header(pg, sel):
        return pg.evaluate("""(s)=>{const e=__panel.shadowRoot.querySelector(s+' > .panel-titlebar');
            const r=e.getBoundingClientRect();return [r.left+50,r.top+r.height/2]}""", sel)

    @staticmethod
    def drag(pg, src, to, steps=12, escape=False):
        pg.mouse.move(*src)
        pg.mouse.down()
        for i in range(1, steps + 1):
            pg.mouse.move(src[0] + (to[0] - src[0]) * i / steps, src[1] + (to[1] - src[1]) * i / steps)
        pg.wait_for_timeout(50)
        if escape:
            pg.keyboard.press("Escape")
        pg.mouse.up()
        pg.wait_for_timeout(200)

    def dock_page(self):
        pg = self.page("dock")
        pg.evaluate("()=>{const P=__panel;P.setPanelDocked('agentChat',true);P.setPanelDocked('browser',true);P.applyDockLayout();}")
        pg.wait_for_timeout(300)
        return pg

    def test_panel_moves_past_the_agent_panel(self):
        pg = self.dock_page()
        self.assertEqual(self.layout(pg)["right"], ["params", "browser", "agentChat"])
        self.drag(pg, self.header(pg, "#params-panel"), (300, 300))      # across the Files and agentY panels, to the left edge
        self.assertEqual(self.layout(pg)["left"], ["params"])
        self.drag(pg, self.header(pg, "#browser-panel"), (600, 720))     # the bottom edge
        self.assertEqual(self.layout(pg)["bottom"], ["browser"])

    def test_the_agent_panel_itself_can_be_dragged_anywhere(self):
        pg = self.dock_page()
        for to, side in (((600, 720), "bottom"), ((300, 300), "left"), ((1200, 400), "right")):
            self.drag(pg, self.header(pg, "#agent-chat-panel"), to)
            self.assertIn("agentChat", self.layout(pg)[side], side)

    def test_escape_cancels_one_drag_and_the_next_still_works(self):
        # The cancel flag was never cleared: after one Escape no drag could drop again until a reload.
        pg = self.dock_page()
        self.drag(pg, self.header(pg, "#params-panel"), (300, 300), escape=True)
        self.assertEqual(self.layout(pg)["right"], ["params", "browser", "agentChat"], "Escape cancels the drop")
        self.assertFalse(pg.evaluate("()=>__panel.container.classList.contains('dock-drag-on')"))
        self.drag(pg, self.header(pg, "#agent-chat-panel"), (300, 300))
        self.assertIn("agentChat", self.layout(pg)["left"])

    def test_a_lost_pointer_ends_the_drag(self):
        pg = self.dock_page()
        hx, hy = self.header(pg, "#params-panel")
        pg.mouse.move(hx, hy)
        pg.mouse.down()
        pg.mouse.move(hx - 100, hy + 100)
        pg.mouse.move(hx - 200, hy + 200)
        self.assertTrue(pg.evaluate("()=>__panel.dockOverlay.classList.contains('active')"))
        pg.evaluate("()=>{const b=__panel.shadowRoot.querySelector('#params-panel > .panel-titlebar');"
                    "b.dispatchEvent(new PointerEvent('lostpointercapture',{bubbles:true}))}")
        self.assertFalse(pg.evaluate("()=>__panel.dockOverlay.classList.contains('active')"))
        pg.mouse.up()

    # ---- #84: the Motion tab ---------------------------------------------------------------------------------

    def motion_page(self):
        pg = self.page("motion")
        pg.evaluate("()=>__panel.mgOpenFile('D:/out/title_card.mgscene.json')")
        pg.wait_for_function(f"()=>__panel._mg && __panel._mg.tabs['{TITLE_TAB}'] && __panel._mg.tabs['{TITLE_TAB}'].editor",
                             timeout=10000)
        pg.wait_for_timeout(300)
        return pg

    def test_a_scene_opens_as_a_tab_with_the_preview_in_the_main_canvas(self):
        pg = self.motion_page()
        info = pg.evaluate("""()=>{const P=__panel, sr=P.shadowRoot, vp=sr.getElementById('viewport');
            const host=vp.querySelector('.motion-view'), v=vp.getBoundingClientRect(), h=host.getBoundingClientRect();
            const ids=%s;
            return {tab:P.activeTab, stage:!!host.querySelector('.mg-stage'),
                covers: Math.abs(v.width-h.width)<2 && Math.abs(v.height-h.height)<2,
                docked:ids.map(i=>P.isPanelDocked(i)),
                parts:ids.map(i=>!!P._dockPanelEl(i).querySelector('.mg-part')),
                emptyPanels: sr.querySelectorAll('#motion-panel').length}}""" % MG_PANELS)
        self.assertEqual(info["tab"], TITLE_TAB)
        self.assertTrue(info["stage"] and info["covers"])
        self.assertEqual(info["docked"], [True, True, True])
        self.assertEqual(info["parts"], [True, True, True])
        self.assertEqual(info["emptyPanels"], 0)
        self.assertEqual(self.errors, [])

    def test_the_panels_follow_the_tab(self):
        pg = self.motion_page()
        pg.evaluate("""()=>{const P=__panel;P.allTabs.other=[{path:'D:/a.png',name:'a.png',external:true}];P.tabLabels.other='other';
            P.tabOrder.push('other');P._rebuildTabBar(null);P.switchTab('other')}""")
        self.assertEqual(pg.evaluate("()=>%s.map(i=>__panel.isPanelDocked(i))" % MG_PANELS), [False, False, False])
        self.assertEqual(pg.evaluate("()=>getComputedStyle(__panel.shadowRoot.querySelector('.motion-view')).display"), "none")
        pg.evaluate(f"()=>__panel.switchTab('{TITLE_TAB}')")
        self.assertEqual(pg.evaluate("()=>%s.map(i=>__panel.isPanelDocked(i))" % MG_PANELS), [True, True, True])

    def test_motion_panels_are_normal_dock_panels(self):
        pg = self.motion_page()
        self.assertIn("motionLayers", self.layout(pg)["left"])
        self.drag(pg, self.header(pg, "#motionLayers-panel"), (1300, 500))
        self.assertIn("motionLayers", self.layout(pg)["right"])
        # it still holds the editor's layer list, and the list still works
        self.assertTrue(pg.evaluate("()=>!!__panel._dockPanelEl('motionLayers').querySelector('.mg-lrow')"))
        pg.evaluate("()=>__panel._dockPanelEl('motionLayers').querySelector('.mg-lrow').click()")
        self.assertTrue(pg.evaluate("()=>__panel._mg.tabs[__panel.activeTab].editor.state.sel!=null"))

    def test_no_scene_shows_the_open_state_and_no_empty_panel(self):
        pg = self.page("motion")
        pg.evaluate("()=>__panel.mgBarOpen()")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.evaluate("()=>__panel.shadowRoot.querySelector('.mg-open-title')?.textContent"), "Open a motion scene")
        self.assertTrue(pg.evaluate("()=>!!__panel.shadowRoot.querySelector('.mg-open-btn')"))
        # the Open button asks for a file (the viewer's file picker over the allowed folders)
        pg.evaluate("()=>__panel.shadowRoot.querySelector('.mg-open-btn').click()")
        pg.wait_for_timeout(300)
        self.assertTrue(pg.evaluate("()=>!!__panel.container.querySelector('.pick-dlg')"))
        # opening a scene replaces the empty tab
        pg.evaluate("()=>__panel.mgOpenFile('D:/out/lower_third.mgscene.json')")
        pg.wait_for_function("()=>!__panel.allTabs['motion:'] && __panel.activeTab.endsWith('lower_third.mgscene.json')")

    def test_edit_in_motion_from_the_history_strip(self):
        pg = self.page("motion")
        pg.evaluate("""()=>{const P=__panel, key='agentY';
            const mp4={kind:'video',path:'D:/out/title_card.mp4',name:'title_card.mp4',external:true,fps:30};
            const other={kind:'video',path:'D:/out/unrelated.mp4',name:'unrelated.mp4',external:true,fps:30};
            P.allTabs[key]=[mp4,other]; P.tabLabels[key]='agentY'; P.tabOrder.push(key); P._rebuildTabBar(null);
            P.history[key]=[[mp4],[other]]; P._historyPanelSig=null; P.setPanelDocked('history',true); P.renderHistoryPanel();}""")
        pg.wait_for_timeout(500)
        thumbs = pg.locator(".history-thumb")
        self.assertEqual(thumbs.count(), 2)
        thumbs.nth(1).click(button="right")           # a film with no scene: no entry
        pg.wait_for_timeout(500)
        items = pg.evaluate("()=>[...__panel.shadowRoot.querySelectorAll('#thumb-ctx-menu .thumb-ctx-item')].map(e=>e.textContent)")
        self.assertFalse([i for i in items if "Edit in Motion" in i], items)
        pg.evaluate("()=>__panel.shadowRoot.querySelector('#thumb-ctx-menu')?.remove()")
        thumbs.nth(0).click(button="right")           # the rendered film of a scene
        pg.wait_for_function("()=>!!__panel.shadowRoot.querySelector('#thumb-ctx-menu .mg-edit-item')")
        pg.evaluate("()=>__panel.shadowRoot.querySelector('#thumb-ctx-menu .mg-edit-item').click()")
        pg.wait_for_function(f"()=>__panel.activeTab==='{TITLE_TAB}'", timeout=10000)

    def test_the_agent_open_message_opens_the_scene(self):
        pg = self.page("motion")
        pg.evaluate("()=>{const all=document.querySelectorAll('bepic-viewer-panel'); all[1].style.display=''}")
        pg.evaluate("()=>window.__api.dispatch('bepic.mg.open', {path:'D:/out/logo_reveal.mgscene.json'})")
        pg.wait_for_function("()=>{const g=document.querySelectorAll('bepic-viewer-panel')[1];"
                             " return g.activeTab==='motion:D:/out/logo_reveal.mgscene.json' && g._mgOn}", timeout=10000)


if __name__ == "__main__":
    unittest.main()
