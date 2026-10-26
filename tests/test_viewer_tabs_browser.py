"""The Agent code reader and the Dataset view as tabs of the main canvas, in a real browser with real input.

Needs Playwright with an installed Edge or Chrome (``channel``), and node for the stub server; skipped without them.
Run: python -m unittest tests.test_viewer_tabs_browser
It serves tests/harness/tabs.html - the REAL viewer js against stubbed ComfyUI scripts - on a free port, so it never
touches a running ComfyUI. The /bepic/code, /bepic/text, /bepic/browse and /bepic/lora/* routes are stubbed in the page.
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
CODE_TAB = "code:D:/x/tool.py"
NOTES_TAB = "code:D:/x/notes.json"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class ViewTabTests(unittest.TestCase):
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
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        self.dialogs = []
        pg.on("dialog", lambda d: (self.dialogs.append(d.message), d.accept()))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        # the stub extension's setup() makes a second, floating viewer: it is the one the agent's messages reach
        pg.evaluate("()=>{const all=document.querySelectorAll('bepic-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        return pg

    def agent_page(self):
        """The page with the viewer that receives the agent's messages (the one setup() made) on screen."""
        pg = self.browser.new_page(viewport={"width": 1500, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        self.dialogs = []
        pg.on("dialog", lambda d: (self.dialogs.append(d.message), d.accept()))
        pg.goto(f"http://127.0.0.1:{self.port}/tabs.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{document.querySelectorAll('bepic-viewer-panel')[0].style.display='none'; const g=document.querySelectorAll('bepic-viewer-panel')[1]; g.style.display=''; window.__g=g; try{window.bEpicViewerApi.show()}catch(e){}}")
        return pg

    @staticmethod
    def covers(pg, panel="__panel"):
        return pg.evaluate("""(p)=>{const P=eval(p), sr=P.shadowRoot, vp=sr.getElementById('viewport');
            const host=vp.querySelector('.view-tabs'); if(!host) return {made:false};
            const v=vp.getBoundingClientRect(), h=host.getBoundingClientRect();
            return {made:true, shown:getComputedStyle(host).display!=='none',
                    covers: v.width>200 && Math.abs(v.width-h.width)<2 && Math.abs(v.height-h.height)<2}}""", panel)

    @staticmethod
    def docks(pg, panel="__panel"):
        return pg.evaluate("""(p)=>{const P=eval(p), L=P.dockLayout;
            return {ids:Object.values(L).flatMap(r=>r.panels.map(x=>x.id)),
                    stray:['agent-code-panel','lora-panel'].filter(i=>P.shadowRoot.getElementById(i)).length}}""", panel)

    @staticmethod
    def bar_menu(pg, label):
        """The lower bar's ComfyUI group button, then one of its menu entries - both with the real mouse."""
        pg.locator("#bar-group-comfy:visible").click()
        pg.locator(".previz-menu-item:visible", has_text=label).first.click()

    # ---- Agent code -----------------------------------------------------------------------------------------------

    def open_browser(self, pg):
        pg.evaluate("()=>__panel.setPanelDocked('browser', true)")
        pg.wait_for_function("()=>__panel._browserFiles && __panel._browserFiles.length===3", timeout=10000)
        pg.wait_for_timeout(200)

    def test_a_text_file_opens_by_double_click_as_a_tab_in_the_main_canvas(self):
        pg = self.page()
        self.open_browser(pg)
        pg.get_by_text("tool.py", exact=True).first.click()      # one click only previews: no tab
        pg.wait_for_timeout(300)
        self.assertEqual(pg.evaluate("()=>__panel.tabOrder.length"), 0)
        pg.get_by_text("tool.py", exact=True).first.dblclick()
        pg.wait_for_function(f"()=>__panel.activeTab==='{CODE_TAB}'", timeout=10000)
        pg.wait_for_function("()=>!!__panel.shadowRoot.querySelector('.view-tab-code .ac-view .ac-line')")
        info = self.covers(pg)
        self.assertTrue(info["made"] and info["shown"] and info["covers"], info)
        self.assertIn("return 42", pg.evaluate("()=>__panel.shadowRoot.querySelector('.view-tab-code .ac-view').textContent"))
        # the tab is in the tab bar, titled by the file; there is no code panel any more
        label = pg.evaluate("()=>__panel.tabLabels[__panel.activeTab]")
        self.assertIn("tool.py", label)
        docks = self.docks(pg)
        self.assertNotIn("agentCode", docks["ids"])
        self.assertEqual(docks["stray"], 0)
        self.assertEqual(self.errors, [])

    def test_several_code_tabs_at_once_and_the_picture_comes_back(self):
        pg = self.page()
        self.open_browser(pg)
        pg.get_by_text("tool.py", exact=True).first.dblclick()
        pg.wait_for_function(f"()=>__panel.activeTab==='{CODE_TAB}'")
        pg.get_by_text("notes.json", exact=True).first.dblclick()
        pg.wait_for_function(f"()=>__panel.activeTab==='{NOTES_TAB}'")
        pg.wait_for_function("()=>__panel.shadowRoot.querySelector('.view-tab-code[style*=block] .ac-view')?.textContent.includes('hello')")
        self.assertEqual(pg.evaluate("()=>__panel.tabOrder"), [CODE_TAB, NOTES_TAB])
        # the first tab still holds its own text
        pg.get_by_role("tab") if False else None
        pg.evaluate(f"()=>__panel.switchTab('{CODE_TAB}')")
        self.assertIn("return 42", pg.evaluate(
            "()=>[...__panel.shadowRoot.querySelectorAll('.view-tab-code')].find(e=>e.style.display==='block').textContent"))
        # a media tab gives the main canvas back
        pg.evaluate("""()=>{const P=__panel;P.allTabs.pic=[{path:'D:/a.png',name:'a.png',external:true}];P.tabLabels.pic='pic';
            P.tabOrder.push('pic');P._rebuildTabBar(null);P.switchTab('pic')}""")
        self.assertFalse(self.covers(pg)["shown"])
        pg.evaluate(f"()=>__panel.switchTab('{NOTES_TAB}')")
        self.assertTrue(self.covers(pg)["shown"])
        # closing a code tab does not ask (it is read-only) and takes its page with it
        pg.evaluate(f"()=>__panel.closeTab('{NOTES_TAB}')")
        self.assertNotIn(NOTES_TAB, pg.evaluate("()=>__panel.tabOrder"))
        self.assertEqual(pg.evaluate("()=>__panel.shadowRoot.querySelectorAll('.view-tab-code').length"), 1)
        self.assertEqual(self.errors, [])

    def test_the_bar_entry_opens_the_feed_and_new_code_follows(self):
        pg = self.agent_page()
        g = "__g"
        pg.evaluate("()=>window.__api.dispatch('bepic.code.update', {id:'n1', title:'first', language:'python', code:'print(1)\\n', source:'run_script', ts:Date.now()/1000})")
        pg.wait_for_timeout(200)
        # nothing is open: the bar button says there is something new
        self.assertTrue(pg.evaluate("()=>__g.shadowRoot.getElementById('bar-group-comfy').classList.contains('has-code')"))
        self.assertEqual(pg.evaluate("()=>__g.tabOrder.length"), 0)
        # the ComfyUI group menu: Agent code
        self.bar_menu(pg, "Agent code")
        pg.wait_for_function("()=>__g.activeTab==='code:'", timeout=10000)
        self.assertFalse(pg.evaluate("()=>__g.shadowRoot.getElementById('bar-group-comfy').classList.contains('has-code')"))
        pg.wait_for_function("()=>__g.shadowRoot.querySelectorAll('.view-tab-code .ac-row').length>=2")   # the pushed one + the history
        info = self.covers(pg, g)
        self.assertTrue(info["shown"] and info["covers"], info)
        # code that arrives while the tab is in front is the one shown
        pg.evaluate("()=>window.__api.dispatch('bepic.code.update', {id:'n2', title:'second', language:'python', code:'print(2)\\n', source:'run_script', ts:Date.now()/1000+5})")
        pg.wait_for_function("()=>__g.shadowRoot.querySelector('.view-tab-code .ac-title')?.textContent==='second'")
        # ...and while another tab is in front it only lights the dot
        pg.evaluate("""()=>{const P=__g;P.allTabs.pic=[{path:'D:/a.png',name:'a.png',external:true}];P.tabLabels.pic='pic';
            P.tabOrder.push('pic');P._rebuildTabBar(null);P.switchTab('pic')}""")
        pg.evaluate("()=>window.__api.dispatch('bepic.code.update', {id:'n3', title:'third', language:'python', code:'print(3)\\n', source:'run_script', ts:Date.now()/1000+9})")
        pg.wait_for_timeout(200)
        self.assertTrue(pg.evaluate("()=>__g.shadowRoot.getElementById('bar-group-comfy').classList.contains('has-code')"))
        self.assertEqual(self.errors, [])

    # ---- Dataset ---------------------------------------------------------------------------------------------------

    def open_dataset(self, pg, name="demo_cat"):
        pg.evaluate("(n)=>window.__api.dispatch('bepic.lora.open', {path:'D:/out/agent/lora_datasets/'+n+'/manifest.json'})", name)
        pg.wait_for_function(f"()=>__g.activeTab==='dataset:{name}'", timeout=10000)
        pg.wait_for_function("()=>__g.shadowRoot.querySelectorAll('.view-tab-dataset[style*=block] .lr-card').length===4", timeout=10000)

    def test_an_agent_push_opens_the_dataset_as_a_tab(self):
        pg = self.agent_page()
        self.open_dataset(pg)
        info = self.covers(pg, "__g")
        self.assertTrue(info["shown"] and info["covers"], info)
        docks = self.docks(pg, "__g")
        self.assertNotIn("loraDataset", docks["ids"])
        self.assertEqual(docks["stray"], 0)
        self.assertIn("demo_cat", pg.evaluate("()=>__g.tabLabels[__g.activeTab]"))
        # pushed again: the same tab is focused, not a second one
        pg.evaluate("()=>window.__api.dispatch('bepic.lora.open', {path:'D:/out/agent/lora_datasets/demo_cat/manifest.json'})")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.evaluate("()=>__g.tabOrder"), ["dataset:demo_cat"])
        # a second dataset is a second tab
        self.open_dataset(pg, "demo_dog")
        self.assertEqual(pg.evaluate("()=>__g.tabOrder"), ["dataset:demo_cat", "dataset:demo_dog"])
        self.assertEqual(self.errors, [])

    def test_the_dataset_bar_entry_opens_a_tab_that_lists_the_datasets(self):
        pg = self.agent_page()
        self.bar_menu(pg, "Dataset")
        pg.wait_for_function("()=>__g.activeTab==='dataset:'", timeout=10000)
        pg.wait_for_function("()=>__g.shadowRoot.querySelectorAll('.view-tab-dataset .lr-sel option, .view-tab-dataset select option').length>=2", timeout=10000)

    def test_edit_a_caption_save_and_approve_follows_the_new_run(self):
        pg = self.agent_page()
        self.open_dataset(pg)
        card = pg.locator(".view-tab-dataset .lr-cap").first
        card.click()
        pg.keyboard.press("Control+A")
        pg.keyboard.type("ohwx a very good cat")
        pg.wait_for_timeout(200)
        self.assertTrue(pg.evaluate("()=>__g._vtState().tabs['dataset:demo_cat'].editor.dirty"))
        pg.get_by_role("button", name="Save", exact=True).click()
        pg.wait_for_function("()=>window.__posts.some(p=>p.path==='/bepic/lora/dataset_save')")
        saved = pg.evaluate("()=>window.__posts.find(p=>p.path==='/bepic/lora/dataset_save').body")
        self.assertEqual(saved["manifest"]["items"][0]["caption"], "ohwx a very good cat")
        self.assertFalse(pg.evaluate("()=>__g._vtState().tabs['dataset:demo_cat'].editor.dirty"))
        # approve & train: the stub starts a NEW run; the Training page follows it and names it
        pg.get_by_role("button", name="Approve & train").click()
        pg.wait_for_function("()=>window.__posts.some(p=>p.path==='/bepic/lora/review' && p.body.action==='approve')")
        pg.wait_for_function("()=>__g._vtState().tabs['dataset:demo_cat'].editor.state.run==='demo_cat_v2'", timeout=10000)
        self.assertEqual(pg.evaluate("()=>__g._vtState().tabs['dataset:demo_cat'].editor.state.tab"), "training")
        label = pg.evaluate("()=>[...__g.shadowRoot.querySelectorAll('.view-tab-dataset option')].map(o=>o.textContent).find(t=>t.includes('demo_cat_v2'))")
        self.assertIn("v2", label)
        self.assertEqual(self.errors, [])

    def test_closing_a_dataset_with_unsaved_edits_asks_once(self):
        pg = self.agent_page()
        self.open_dataset(pg)
        pg.locator(".view-tab-dataset .lr-cap").first.click()
        pg.keyboard.type(" extra")
        pg.wait_for_timeout(100)
        self.assertTrue(pg.evaluate("()=>__g._vtState().tabs['dataset:demo_cat'].editor.dirty"))
        pg.evaluate("()=>__g.closeTab('dataset:demo_cat')")
        self.assertIn("dataset:demo_cat", pg.evaluate("()=>__g.tabOrder"))
        pg.evaluate("()=>__g.closeTab('dataset:demo_cat')")
        self.assertEqual(pg.evaluate("()=>__g.tabOrder"), [])
        self.assertFalse(self.covers(pg, "__g")["shown"])
        # nothing dirty: it closes at once
        self.open_dataset(pg, "demo_dog")
        pg.evaluate("()=>__g.closeTab('dataset:demo_dog')")
        self.assertEqual(pg.evaluate("()=>__g.tabOrder"), [])

    # ---- saved layouts ---------------------------------------------------------------------------------------------

    def test_a_saved_layout_that_names_the_old_panels_loads_cleanly(self):
        pg = self.page()
        old = {"left": {"width": 120, "panels": [{"id": "history", "size": 1, "hidden": True, "tab": "g1", "behind": False},
                                                 {"id": "agentCode", "size": 1, "hidden": False, "tab": "g1", "behind": True}]},
               "right": {"width": 300, "panels": [{"id": "params", "size": 1, "hidden": False},
                                                  {"id": "loraDataset", "size": 3, "hidden": False},
                                                  {"id": "motionProps", "size": 2, "hidden": True}]},
               "bottom": {"height": 240, "panels": [{"id": "motionTimeline", "size": 1, "hidden": True}]}}
        for _ in range(2):      # and again, as a layout switch would hand it in
            self.assertTrue(pg.evaluate("(d)=>__panel.applyDockData(d)", old))
            pg.wait_for_timeout(200)
            ids = pg.evaluate("()=>Object.values(__panel.dockLayout).flatMap(r=>r.panels.map(p=>p.id))")
            self.assertNotIn("agentCode", ids)
            self.assertNotIn("loraDataset", ids)
            self.assertEqual(len(ids), len(set(ids)))
            hist = pg.evaluate("()=>__panel.dockLayout.left.panels.find(p=>p.id==='history')")
            self.assertFalse(hist.get("tab"))
            self.assertFalse(hist.get("behind"))
            ser = str(pg.evaluate("()=>__panel.serializeDock()"))
            self.assertNotIn("agentCode", ser)
            self.assertNotIn("loraDataset", ser)
            # no slot is left empty: every panel the layout holds has its element
            self.assertEqual(pg.evaluate("""()=>Object.values(__panel.dockLayout).flatMap(r=>r.panels)
                .filter(p=>!__panel._dockPanelEl(p.id)).length"""), 0)
            self.assertEqual(pg.evaluate("()=>__panel.shadowRoot.querySelectorAll('#agent-code-panel, #lora-panel').length"), 0)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
