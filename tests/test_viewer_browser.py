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
MG_PANELS = "['motionProps','motionTimeline']"
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
        self.assertEqual(info["docked"], [True, True])
        self.assertEqual(info["parts"], [True, True])
        self.assertEqual(info["emptyPanels"], 0)
        self.assertEqual(self.errors, [])

    def test_the_panels_follow_the_tab(self):
        pg = self.motion_page()
        pg.evaluate("""()=>{const P=__panel;P.allTabs.other=[{path:'D:/a.png',name:'a.png',external:true}];P.tabLabels.other='other';
            P.tabOrder.push('other');P._rebuildTabBar(null);P.switchTab('other')}""")
        self.assertEqual(pg.evaluate("()=>%s.map(i=>__panel.isPanelDocked(i))" % MG_PANELS), [False, False])
        self.assertEqual(pg.evaluate("()=>getComputedStyle(__panel.shadowRoot.querySelector('.motion-view')).display"), "none")
        pg.evaluate(f"()=>__panel.switchTab('{TITLE_TAB}')")
        self.assertEqual(pg.evaluate("()=>%s.map(i=>__panel.isPanelDocked(i))" % MG_PANELS), [True, True])

    def test_motion_panels_are_normal_dock_panels(self):
        pg = self.motion_page()
        self.assertIn("motionProps", self.layout(pg)["right"])
        self.drag(pg, self.header(pg, "#motionProps-panel"), (300, 300))
        self.assertIn("motionProps", self.layout(pg)["left"])
        # it still holds the editor's properties
        self.assertTrue(pg.evaluate("()=>!!__panel._dockPanelEl('motionProps').querySelector('.mg-part')"))

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


    # ---- the Motion timeline: layer list, scrubbing, the viewer's own transport ----------------------------------------

    @staticmethod
    def ed(pg, expr):
        return pg.evaluate("()=>{const e=__panel._mg.tabs[__panel.activeTab].editor; return (%s)}" % expr)

    @staticmethod
    def centre(pg, sel, nth=0):
        return pg.evaluate("""([s,n])=>{const e=__panel._dockPanelEl('motionTimeline').querySelectorAll(s)[n];
            const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]}""", [sel, nth])

    @staticmethod
    def frame_x(pg, f):
        """Screen x of frame f in the timeline (its ruler track), the ruler's y and the pixels per frame."""
        return pg.evaluate("""(f)=>{const p=__panel._dockPanelEl('motionTimeline');const t=p.querySelector('.mg-ruler .mg-ttrack');
            const r=t.getBoundingClientRect();const k=r.width/(__panel._mg.tabs[__panel.activeTab].editor.comp().duration);
            return [r.left+f*k, r.top+r.height/2, k]}""", f)

    def bar(self, pg):
        return pg.evaluate("""()=>({cur:__panel.currentFrame, curEl:__panel.container.querySelector('#cur-f').innerText,
            slider:+__panel.timeline.value, max:+__panel.timeline.max, total:+__panel.container.querySelector('#total-f').value,
            fps:+__panel.container.querySelector('#fps-in').value, playing:!!__panel.isPlaying,
            ed:__panel._mg.tabs[__panel.activeTab].editor.state.frame})""")

    def test_the_layer_list_is_the_timelines_left_column(self):
        pg = self.motion_page()
        self.assertFalse(pg.evaluate("()=>!!__panel._dockPanelEl('motionLayers') || !!__panel.shadowRoot.querySelector('#motionLayers-panel')"))
        ids = lambda: self.ed(pg, "e.getScene().layers.map(l=>l.id)")
        top_first = lambda: pg.evaluate("()=>[...__panel._dockPanelEl('motionTimeline').querySelectorAll('.mg-layer-row')].map(r=>r.dataset.layer)")
        self.assertEqual(top_first(), list(reversed(ids())))
        # select: click the label
        first = top_first()[0]
        pg.locator("#motionTimeline-panel .mg-layer-row .mg-tlabel").nth(1).click()
        self.assertEqual(self.ed(pg, "e.state.sel"), top_first()[1])
        # hide and lock: the eye and the lock of a row
        pg.locator("#motionTimeline-panel .mg-layer-row .mg-eye").nth(0).click()
        self.assertTrue(self.ed(pg, "!!e.getScene().layers.find(l=>l.id=='%s').hidden" % first))
        pg.locator("#motionTimeline-panel .mg-layer-row .mg-lock").nth(0).click()
        self.assertTrue(self.ed(pg, "!!e.getScene().layers.find(l=>l.id=='%s').locked" % first))
        pg.locator("#motionTimeline-panel .mg-layer-row .mg-eye").nth(0).click()
        self.assertFalse(self.ed(pg, "!!e.getScene().layers.find(l=>l.id=='%s').hidden" % first))
        # rename: double-click the name, type, Enter
        pg.locator("#motionTimeline-panel .mg-layer-row .mg-name").nth(0).dblclick()
        inp = pg.locator("#motionTimeline-panel input.mg-rename")
        self.assertEqual(inp.count(), 1)
        inp.fill("Hero title")
        inp.press("Enter")
        self.assertEqual(self.ed(pg, "e.getScene().layers.find(l=>l.id=='%s').name" % first), "Hero title")
        self.assertEqual(pg.locator("#motionTimeline-panel .mg-layer-row .mg-name").nth(0).inner_text(), "Hero title")
        # Escape leaves the name alone
        pg.locator("#motionTimeline-panel .mg-layer-row .mg-name").nth(0).dblclick()
        pg.locator("#motionTimeline-panel input.mg-rename").fill("nope")
        pg.keyboard.press("Escape")
        self.assertEqual(self.ed(pg, "e.getScene().layers.find(l=>l.id=='%s').name" % first), "Hero title")
        # reorder: drag the top row below the last one (real pointer)
        before = top_first()
        x, y0 = self.centre(pg, ".mg-layer-row .mg-name", 0)
        _, y1 = self.centre(pg, ".mg-layer-row .mg-name", len(before) - 1)
        pg.mouse.move(x, y0)
        pg.mouse.down()
        for i in range(1, 11):
            pg.mouse.move(x, y0 + (y1 + 8 - y0) * i / 10)
        pg.mouse.up()
        pg.wait_for_timeout(100)
        self.assertEqual(top_first(), before[1:] + before[:1])
        # undo takes it back (one edit)
        self.ed(pg, "e.undo()")
        self.assertEqual(top_first(), before)
        # add and delete from the timeline header
        n = len(before)
        pg.locator("#motionTimeline-panel .mg-ruler .mg-btn").nth(0).click()
        pg.locator("#motionTimeline-panel .mg-ctx div", has_text="Add Rectangle").click()
        self.assertEqual(len(top_first()), n + 1)
        self.assertEqual(self.ed(pg, "e.state.sel"), top_first()[0])
        pg.locator("#motionTimeline-panel .mg-ruler .mg-btn", has_text="\u2715").click()
        self.assertEqual(len(top_first()), n)
        # the context menu on a row
        pg.locator("#motionTimeline-panel .mg-layer-row .mg-tlabel").nth(1).click(button="right")
        pg.locator("#motionTimeline-panel .mg-ctx div", has_text="Duplicate").click()
        self.assertEqual(len(top_first()), n + 1)
        self.assertEqual(self.errors, [])

    def test_dragging_in_the_ruler_scrubs_without_losing_the_drag(self):
        pg = self.motion_page()
        x0, y, k = self.frame_x(pg, 0)
        # a click moves time to where it landed
        pg.mouse.click(x0 + 40 * k, y)
        self.assertEqual(self.bar(pg)["ed"], 40)
        self.assertEqual(self.bar(pg)["cur"], 40)
        # a drag keeps following the pointer across many moves (the old ruler handler lost it after the first)
        pg.mouse.move(x0 + 10 * k, y)
        pg.mouse.down()
        seen = []
        for f in range(10, 91, 10):
            pg.mouse.move(x0 + f * k, y)
            seen.append(self.bar(pg)["ed"])
        pg.mouse.up()
        self.assertEqual(seen, list(range(10, 91, 10)))
        b = self.bar(pg)
        self.assertEqual((b["ed"], b["cur"], b["slider"], b["curEl"]), (90, 90, 90, "90"))
        # the timeline itself is NOT rebuilt per move (the playhead moves in place)
        pg.evaluate("()=>{window.__tlin=__panel._dockPanelEl('motionTimeline').querySelector('.mg-tl-in')}")
        pg.mouse.move(x0 + 20 * k, y)
        pg.mouse.down()
        pg.mouse.move(x0 + 30 * k, y)
        pg.mouse.move(x0 + 50 * k, y)
        self.assertTrue(pg.evaluate("()=>__panel._dockPanelEl('motionTimeline').querySelector('.mg-tl-in')===window.__tlin"))
        pg.mouse.up()
        # past the end clamps
        pg.mouse.move(x0 + 20 * k, y)
        pg.mouse.down()
        pg.mouse.move(x0 + 100000, y)
        pg.mouse.up()
        self.assertEqual(self.bar(pg)["ed"], self.ed(pg, "e.comp().duration") - 1)
        self.assertEqual(self.errors, [])

    def test_the_playhead_itself_drags(self):
        pg = self.motion_page()
        x0, y, k = self.frame_x(pg, 0)
        pg.mouse.click(x0 + 30 * k, y)
        gx, gy = self.centre(pg, ".mg-ph-grip")
        self.assertAlmostEqual(gx, x0 + 30 * k, delta=2)
        pg.mouse.move(gx, gy)
        pg.mouse.down()
        for f in (35, 45, 60):
            pg.mouse.move(gx + (f - 30) * k, gy)
        pg.mouse.up()
        self.assertEqual(self.bar(pg)["ed"], 60)
        # no jump when the grip is taken off-centre
        gx, gy = self.centre(pg, ".mg-ph-grip")
        pg.mouse.move(gx + 4, gy)
        pg.mouse.down()
        pg.mouse.move(gx + 4 + 5 * k, gy)
        pg.mouse.up()
        self.assertEqual(self.bar(pg)["ed"], 65)

    def test_a_drag_on_the_track_background_moves_time_and_a_key_still_drags(self):
        pg = self.motion_page()
        x0, y, k = self.frame_x(pg, 0)
        # the second layer row's track (no key under the pointer at frame ~7)
        tx, ty = pg.evaluate("""()=>{const t=__panel._dockPanelEl('motionTimeline').querySelectorAll('.mg-layer-row .mg-ttrack')[1];
            const r=t.getBoundingClientRect();return [r.left, r.top+r.height/2]}""")
        pg.mouse.move(tx + 7 * k, ty)
        pg.mouse.down()
        pg.mouse.move(tx + 25 * k, ty)
        pg.mouse.move(tx + 55 * k, ty)
        pg.mouse.up()
        self.assertEqual(self.bar(pg)["ed"], 55)
        self.assertEqual(self.ed(pg, "e.state.sel"), self.ed(pg, "e.getScene().layers.slice().reverse()[1].id"))
        # a keyframe diamond is still its own drag, not a scrub
        dia = pg.locator("#motionTimeline-panel .mg-dia:not(.agg)")
        self.assertGreater(dia.count(), 0)
        box = dia.nth(0).bounding_box()
        bx, by = box["x"] + 5, box["y"] + 5
        pg.mouse.move(bx, by)
        pg.mouse.down()
        pg.mouse.move(bx + 3 * k, by)
        pg.mouse.move(bx + 6 * k, by)
        pg.mouse.up()
        self.assertTrue(self.ed(pg, "e.isDirty()"))
        self.assertEqual(self.errors, [])

    def test_the_viewers_bar_is_the_motion_transport(self):
        pg = self.motion_page()
        c = self.ed(pg, "e.comp()")
        b = self.bar(pg)
        self.assertEqual((b["max"], b["total"], b["fps"]), (c["duration"] - 1, c["duration"] - 1, c["fps"]))
        self.assertEqual(pg.evaluate("()=>__panel.fps"), c["fps"])
        # the editor has no transport of its own in the tab
        self.assertFalse(pg.evaluate("()=>!!__panel.shadowRoot.querySelector('.mg-transport')"))
        btn = lambda i: pg.locator("#" + i).first
        btn("s-next").click()
        btn("s-next").click()
        b = self.bar(pg)
        self.assertEqual((b["ed"], b["cur"]), (2, 2))
        btn("s-prev").click()
        self.assertEqual(self.bar(pg)["ed"], 1)
        btn("s-end").click()
        self.assertEqual(self.bar(pg)["ed"], c["duration"] - 1)
        btn("s-start").click()
        self.assertEqual(self.bar(pg)["ed"], 0)
        # scrub the viewer's own timeline slider: the scene's playhead follows (and the timeline panel's playhead too)
        box = pg.locator("#timeline").first.bounding_box()
        pg.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] / 2)
        mid = self.bar(pg)
        self.assertAlmostEqual(mid["ed"], c["duration"] / 2, delta=c["duration"] * 0.06)
        self.assertEqual(mid["ed"], mid["slider"])
        gx = self.centre(pg, ".mg-ph-grip")[0]
        x0, y, k = self.frame_x(pg, 0)
        self.assertAlmostEqual(gx, x0 + mid["ed"] * k, delta=2)
        # and the other way: the timeline's playhead moves the viewer's slider and counter
        pg.mouse.click(x0 + 12 * k, y)
        b = self.bar(pg)
        self.assertEqual((b["slider"], b["cur"], b["curEl"], b["ed"]), (12, 12, "12", 12))
        # play from the viewer's bar: the scene runs, the playhead follows, pause holds
        btn("s-start").click()
        btn("play").click()
        pg.wait_for_timeout(700)
        b = self.bar(pg)
        self.assertTrue(b["playing"])
        self.assertGreater(b["ed"], 5)
        self.assertEqual(b["ed"], b["cur"])
        btn("play").click()
        held = self.bar(pg)
        pg.wait_for_timeout(300)
        self.assertFalse(held["playing"])
        self.assertEqual(self.bar(pg)["ed"], held["ed"])
        # scrubbing the scene's timeline while playing stops playback
        btn("play").click()
        pg.wait_for_timeout(100)
        pg.mouse.click(x0 + 3 * k, y)
        self.assertFalse(self.bar(pg)["playing"])
        self.assertEqual(self.bar(pg)["ed"], 3)
        # the last-frame box changes the scene's length (one undoable edit); the fps box its frame rate
        pg.locator("#total-f").first.fill("59")
        pg.locator("#total-f").first.press("Enter")
        self.assertEqual(self.ed(pg, "e.comp().duration"), 60)
        self.assertEqual(self.bar(pg)["max"], 59)
        pg.locator("#fps-in").first.fill("24")
        pg.locator("#fps-in").first.press("Enter")
        self.assertEqual(self.ed(pg, "e.comp().fps"), 24)
        self.ed(pg, "e.undo()")
        self.assertEqual(self.ed(pg, "e.comp().fps"), c["fps"])
        self.assertEqual(self.bar(pg)["fps"], c["fps"])
        self.assertEqual(self.errors, [])

    def test_leaving_the_motion_tab_gives_the_bar_back(self):
        pg = self.motion_page()
        pg.evaluate("""()=>{const P=__panel;P.allTabs.other=[{path:'D:/a.png',name:'a.png',external:true}];P.tabLabels.other='other';
            P.tabOrder.push('other');P._rebuildTabBar(null);P.switchTab('other')}""")
        self.assertTrue(pg.evaluate("()=>__panel.container.querySelector('#total-f').readOnly"))
        self.assertEqual(pg.evaluate("()=>__panel.fps"), 25)
        pg.evaluate(f"()=>__panel.switchTab('{TITLE_TAB}')")
        self.assertEqual(self.bar(pg)["fps"], 30)
        self.assertFalse(pg.evaluate("()=>__panel.container.querySelector('#total-f').readOnly"))

    def test_time_keys_take_one_path(self):
        pg = self.motion_page()
        c = self.ed(pg, "e.comp()")
        # the pointer over the viewer, the focus in the timeline panel: one step per press, one toggle per Space
        pg.mouse.move(700, 300)
        pg.evaluate("()=>{__panel.isHovered=true; __panel._dockPanelEl('motionTimeline').querySelector('.mg-part').focus()}")
        pg.keyboard.press("ArrowRight")
        self.assertEqual(self.bar(pg)["ed"], 1)
        pg.keyboard.press("ArrowRight")
        pg.keyboard.press("ArrowLeft")
        self.assertEqual(self.bar(pg)["ed"], 1)
        pg.keyboard.press("Shift+ArrowRight")
        self.assertEqual(self.bar(pg)["ed"], 11)
        pg.keyboard.press("Home")
        self.assertEqual(self.bar(pg)["ed"], 0)
        pg.keyboard.press("End")
        self.assertEqual(self.bar(pg)["ed"], c["duration"] - 1)
        pg.keyboard.press("Home")
        pg.keyboard.press("Space")
        self.assertTrue(self.bar(pg)["playing"])
        pg.keyboard.press("Space")
        self.assertFalse(self.bar(pg)["playing"])
        # not hovered: the editor still answers, through the same transport, still once
        pg.evaluate("()=>{__panel.isHovered=false}")
        pg.keyboard.press("ArrowRight")
        self.assertEqual(self.bar(pg)["ed"], 1)
        pg.keyboard.press("Space")
        self.assertTrue(self.bar(pg)["playing"])
        pg.keyboard.press("Space")
        self.assertFalse(self.bar(pg)["playing"])
        self.assertEqual(self.errors, [])

    def test_a_saved_layout_that_names_the_old_layers_panel_loads(self):
        pg = self.motion_page()
        old = {"left": {"width": 120, "panels": [{"id": "history", "size": 1, "hidden": True, "tab": "g1", "behind": False},
                                                 {"id": "motionLayers", "size": 1, "hidden": False, "tab": "g1", "behind": True}]},
               "right": {"width": 300, "panels": [{"id": "params", "size": 1, "hidden": False},
                                                  {"id": "motionProps", "size": 2, "hidden": False}]},
               "bottom": {"height": 240, "panels": [{"id": "motionTimeline", "size": 1, "hidden": False}]}}
        self.assertTrue(pg.evaluate("(d)=>__panel.applyDockData(d)", old))
        pg.wait_for_timeout(200)
        ids = pg.evaluate("()=>Object.values(__panel.dockLayout).flatMap(r=>r.panels.map(p=>p.id))")
        self.assertNotIn("motionLayers", ids)
        self.assertEqual(len(ids), len(set(ids)))
        # the panel it shared a tab with is simply a panel now; nothing is left behind
        hist = pg.evaluate("()=>__panel.dockLayout.left.panels.find(p=>p.id==='history')")
        self.assertFalse(hist.get("tab"))
        self.assertFalse(hist.get("behind"))
        self.assertNotIn("motionLayers", str(pg.evaluate("()=>__panel.serializeDock()")))
        self.assertEqual(pg.evaluate("()=>__panel.shadowRoot.querySelectorAll('#motionLayers-panel').length"), 0)
        # Motion panels are still up and still hold the editor
        self.assertTrue(pg.evaluate("()=>__panel.isPanelDocked('motionTimeline') && __panel.isPanelDocked('motionProps')"))
        self.assertTrue(pg.evaluate("()=>!!__panel._dockPanelEl('motionTimeline').querySelector('.mg-layer-row')"))
        # the same layout again (as a layout switch would hand it in)
        self.assertTrue(pg.evaluate("(d)=>__panel.applyDockData(d)", old))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
