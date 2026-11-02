"""The History strip on a cut's tab, in a real browser: it shows a media tab's history to drag onto the timeline.

A cut's tab ("edit:...") has no history of its own, and its strip used to be empty - so the renders could not
be dragged from the History into the Edit panel. It now borrows the history of the media tab looked at last,
named in a "History of" dropdown at its top that picks another. A click there only selects (agentY reads it);
a double-click opens the snapshot in its tab.

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest tests.test_history_on_cut_tab_browser
It serves tests/harness/edit.html (the REAL viewer js against stubbed ComfyUI scripts, the Edit routes answered
in the page) with the harness server making up the thumbnails (HARNESS_MEDIA=1).
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

# Two media tabs with history (renders: three films; stills: two pictures), then a cut with one shot, opened from
# "renders" - the tab looked at last.
SETUP = """async () => {
  const P = __panel;
  if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
  Object.assign(__media, { 'D:/out/a.mp4': { duration: 4, audio: false, video: true },
    'D:/out/r0.mp4': { duration: 2, video: true }, 'D:/out/r1.mp4': { duration: 3, video: true },
    'D:/out/r2.mp4': { duration: 2.5, video: true }, 'D:/out/s0.png': { duration: 0, still: true, video: true },
    'D:/out/s1.png': { duration: 0, still: true, video: true } });
  const tab = (key, label, frames) => {
    P.history[key] = frames.map((f) => [f]);
    P.allTabs[key] = [JSON.parse(JSON.stringify(frames[0]))];
    P.tabLabels[key] = label;
    if (!P.tabOrder.includes(key)) P.tabOrder.push(key);
  };
  tab('folder_stills', 'stills', [0, 1].map((i) => ({ path: `D:/out/s${i}.png`, filename: `s${i}.png`, type: 'output', kind: 'image', external: true })));
  tab('folder_renders', 'renders', [0, 1, 2].map((i) => ({ path: `D:/out/r${i}.mp4`, filename: `r${i}.mp4`, type: 'output', kind: 'video', external: true, label: `render ${i}` })));
  P._rebuildTabBar(null);
  P.switchTab('folder_stills');
  P.switchTab('folder_renders');
  P.editTlNew();
  const cut = { ...P._editTlCut, clips: [{ file: 'D:/out/a.mp4', name: 'a', in: 0, length: 4, transition: 0, color: '', volume: 1 }],
                tracks: [{ id: 'V2', kind: 'video', name: 'V2', off: false, clips: [] }] };
  P._editTlApply(cut);
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  return P._editTlTab;
}"""

STRIP = """() => { const P = __panel, bar = P.historyPanel.querySelector('.history-source');
  const sel = bar && bar.querySelector('select');
  return { active: P.activeTab, key: P.historyKey(), borrowed: P.historyBorrows(),
           bar: !!bar && bar.style.display !== 'none', label: bar ? bar.innerText.split('\\n')[0].trim() : '',
           value: sel ? sel.value : '', options: sel ? [...sel.options].map((o) => o.textContent) : [],
           tiles: [...P.historyStrip.querySelectorAll('.history-thumb')].map((t) => Number(t.dataset.idx)),
           picked: [...P.historyStrip.querySelectorAll('.history-thumb.multi')].map((t) => Number(t.dataset.idx)),
           open: [...P.historyStrip.querySelectorAll('.history-thumb.selected')].map((t) => Number(t.dataset.idx)) }; }"""

# The screen x of a moment of the film, and the y of a track's row.
WHERE = """([t, track]) => { const ui = __panel._editTlUi, a = ui.area.getBoundingClientRect();
  const row = [...ui.rows.querySelectorAll('.edit-track')].find(r => r.dataset.track === track).getBoundingClientRect();
  return [a.left + a.width * t / __panel._editTlLay.total, row.top + row.height / 2]; }"""

# Drag the strip's tile `idx` and let go over the timeline at (x, y): the events a browser sends, with one
# DataTransfer the thumbnail fills (its own dragstart handler) and the timeline reads.
DRAG = """([idx, x, y]) => { const P = __panel;
  const tile = P.historyStrip.querySelector(`.history-thumb[data-idx="${idx}"]`);
  const dt = new DataTransfer();
  const ev = (type, cx, cy) => new DragEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt });
  tile.dispatchEvent(ev('dragstart', 0, 0));
  const target = P._editTlUi.body.getRootNode().elementFromPoint(x, y);
  target.dispatchEvent(ev('dragenter', x, y));
  target.dispatchEvent(ev('dragover', x, y));
  target.dispatchEvent(ev('drop', x, y));
  tile.dispatchEvent(ev('dragend', x, y));
  return JSON.parse(dt.getData('application/x-bepic-history') || 'null'); }"""

V2 = "() => __panel._editTlCut.tracks.find((k) => k.id === 'V2').clips.map((c) => [c.file, Math.round(c.at * 1000) / 1000])"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class HistoryOnCutTabTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), HARNESS_MEDIA="1")
        cls.server = subprocess.Popen(["node", os.path.join(ROOT, "tests", "harness", "server.mjs"), ROOT], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/edit.html", timeout=1).read()
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
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        self.thumbs = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.on("request", lambda r: self.thumbs.append(r.url) if "/bepic/thumb" in r.url else None)
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('bepic-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        self.cut_key = pg.evaluate(SETUP)
        pg.wait_for_function("() => __panel._editTlLay && __panel._editTlLay.total > 0", timeout=10000)
        return pg

    def strip(self, pg):
        return pg.evaluate(STRIP)

    def test_the_cut_tab_shows_the_history_of_the_tab_it_came_from(self):
        pg = self.page()
        s = self.strip(pg)
        self.assertTrue(s["active"].startswith("edit:"), s)
        self.assertTrue(s["borrowed"])
        self.assertEqual(s["key"], "folder_renders", "the tab looked at last")
        self.assertEqual(s["tiles"], [0, 1, 2])
        self.assertTrue(s["bar"])
        self.assertEqual(s["label"], "History of")
        self.assertEqual(s["value"], "folder_renders")
        self.assertEqual(sorted(s["options"]), ["renders", "stills"])
        self.assertEqual(s["open"], [], "nothing in a borrowed strip is open")
        # Back on a media tab, the strip is its own again and the bar goes.
        pg.evaluate("() => __panel.switchTab('folder_stills')")
        s = self.strip(pg)
        self.assertFalse(s["bar"])
        self.assertEqual((s["key"], s["tiles"]), ("folder_stills", [0, 1]))
        # ...and that is the tab the cut borrows from now.
        pg.evaluate("(k) => __panel.switchTab(k)", self.cut_key)
        self.assertEqual(self.strip(pg)["key"], "folder_stills")
        self.assertEqual(self.errors, [])

    def test_no_thumbnail_is_asked_for_twice_across_the_switch(self):
        pg = self.page()
        # The tiles the renders tab loaded are drawn again from the browser's cache when the cut borrows them.
        pg.evaluate("() => __panel.switchTab('folder_renders')")
        pg.wait_for_function("() => [...__panel.historyStrip.querySelectorAll('.history-thumb img')].every((i) => i.complete && i.naturalWidth > 0)",
                             timeout=10000)
        before = list(self.thumbs)
        pg.evaluate("(k) => __panel.switchTab(k)", self.cut_key)
        pg.wait_for_timeout(300)
        self.assertEqual(self.thumbs[len(before):], [], "a borrowed strip asks for no thumbnail again")
        shown = pg.evaluate("() => [...__panel.historyStrip.querySelectorAll('.history-thumb img')].map((i) => !!i.getAttribute('src'))")
        self.assertEqual(shown, [True, True, True], "no tile is drawn empty")
        twice = sorted({u for u in self.thumbs if self.thumbs.count(u) > 1})
        self.assertEqual(twice, [])
        self.assertEqual(self.errors, [])

    def test_a_thumbnail_dragged_onto_the_timeline_becomes_a_clip(self):
        pg = self.page()
        x, y = pg.evaluate(WHERE, [1.0, "V2"])
        payload = pg.evaluate(DRAG, [1, x, y])
        self.assertEqual([i["path"] for i in payload["items"]], ["D:/out/r1.mp4"])
        pg.wait_for_function("() => __panel._editTlCut.tracks.find((k) => k.id === 'V2').clips.length === 1", timeout=5000)
        self.assertEqual(pg.evaluate(V2), [["D:/out/r1.mp4", 1.0]])
        self.assertTrue(self.strip(pg)["active"].startswith("edit:"), "the drop leaves the cut on screen")
        # Two selected (click, Ctrl+click) are dragged as one.
        pg.evaluate("""() => { const t = (i) => __panel.historyStrip.querySelector(`.history-thumb[data-idx="${i}"]`);
            t(0).dispatchEvent(new MouseEvent('click', { bubbles: true }));
            t(2).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); }""")
        self.assertEqual(self.strip(pg)["picked"], [0, 2])
        x, y = pg.evaluate(WHERE, [3.5, "V2"])
        payload = pg.evaluate(DRAG, [2, x, y])
        self.assertEqual([i["path"] for i in payload["items"]], ["D:/out/r0.mp4", "D:/out/r2.mp4"])
        pg.wait_for_function("() => __panel._editTlCut.tracks.find((k) => k.id === 'V2').clips.length === 3", timeout=5000)
        self.assertEqual(self.errors, [])

    def test_a_click_selects_without_leaving_the_cut_and_a_double_click_opens_it(self):
        pg = self.page()
        tile = "(i) => __panel.historyStrip.querySelector(`.history-thumb[data-idx=\"${i}\"]`)"
        pg.evaluate(f"(i) => ({tile})(i).dispatchEvent(new MouseEvent('click', {{ bubbles: true }}))", 1)
        s = self.strip(pg)
        self.assertTrue(s["active"].startswith("edit:"), "a click leaves the cut on screen")
        self.assertEqual(s["picked"], [1])
        self.assertFalse(pg.evaluate("() => __panel.isViewingHistory"))
        # agentY reads it as the selection, naming the tab the strip shows.
        sel = pg.evaluate("() => __panel.agentHistorySelection()")
        self.assertEqual((sel["tab"], sel["tab_label"], sel["mode"]), ("folder_renders", "renders", "multi"))
        self.assertEqual([i["path"] for i in sel["items"]], ["D:/out/r1.mp4"])
        # Shift+click: a range.
        pg.evaluate(f"(i) => ({tile})(i).dispatchEvent(new MouseEvent('click', {{ bubbles: true, shiftKey: true }}))", 2)
        self.assertEqual(self.strip(pg)["picked"], [1, 2])
        self.assertEqual(len(pg.evaluate("() => __panel.agentHistorySelection()")["items"]), 2)
        # Arrow keys and Shift+Delete leave a borrowed strip alone (they are the Edit panel's there).
        self.assertFalse(pg.evaluate("() => __panel.hasDeletableHistory()"))
        pg.evaluate("() => __panel.navigateHistory(1)")
        self.assertTrue(self.strip(pg)["active"].startswith("edit:"))
        # A double-click opens the snapshot in its own tab.
        pg.evaluate(f"(i) => ({tile})(i).dispatchEvent(new MouseEvent('dblclick', {{ bubbles: true }}))", 2)
        st = pg.evaluate("() => ({ active: __panel.activeTab, viewing: __panel.isViewingHistory, idx: __panel.currentHistoryIndex, "
                         "shown: __panel.allTabs['folder_renders'][0].path, cutTab: __panel.allTabs[__panel._editTlTab] })")
        self.assertEqual((st["active"], st["viewing"], st["idx"], st["shown"]), ("folder_renders", True, 2, "D:/out/r2.mp4"))
        self.assertEqual(st["cutTab"], [], "the cut's tab keeps no frames of the media tab")
        self.assertEqual(self.errors, [])

    def test_the_dropdown_switches_the_tab_shown_and_the_filters_apply(self):
        pg = self.page()
        pg.evaluate("""() => { const sel = __panel.historyPanel.querySelector('.history-source select');
            sel.value = 'folder_stills'; sel.dispatchEvent(new Event('change')); }""")
        s = self.strip(pg)
        self.assertEqual((s["key"], s["value"], s["tiles"]), ("folder_stills", "folder_stills", [0, 1]))
        self.assertTrue(s["active"].startswith("edit:"))
        # A drag from it lands the still.
        x, y = pg.evaluate(WHERE, [2.0, "V2"])
        pg.evaluate(DRAG, [0, x, y])
        pg.wait_for_function("() => __panel._editTlCut.tracks.find((k) => k.id === 'V2').clips.length === 1", timeout=5000)
        self.assertEqual(pg.evaluate(V2), [["D:/out/s0.png", 2.0]])
        # Colour tag filter on the shown history.
        pg.evaluate("() => { __panel.setHistorySource('folder_renders'); __panel.setHistoryTag('folder_renders', [1], 'red'); __panel.setHistoryTagFilter('red'); }")
        s = self.strip(pg)
        self.assertEqual((s["key"], s["tiles"]), ("folder_renders", [1]))
        self.assertEqual(pg.evaluate("() => __panel.historyVisibleIndices()"), [1])
        self.assertIn("1 red", pg.evaluate("() => __panel.historyClearBtn.title"))
        pg.evaluate("() => __panel.setHistoryTagFilter('none')")
        self.assertEqual(self.strip(pg)["tiles"], [0, 2])
        # agentY's #tags: the filter reads the same index whatever tab the strip shows.
        pg.evaluate("""async () => { const P = __panel;
            const T = await import('/extensions/viewer/bEpicViewer_historyAgentTags.js');
            P._agentTagIndex = T.buildAgentTagIndex([{ tag: 'hero', path: 'D:/out/r2.mp4' }], null);
            P.setHistoryTagFilter(T.agentFilterValue('hero')); }""")
        self.assertEqual(self.strip(pg)["tiles"], [2])
        self.assertEqual(self.errors, [])

    def test_a_new_render_in_the_borrowed_tab_lands_in_the_strip(self):
        pg = self.page()
        pg.evaluate("""() => { __panel.history['folder_renders'].unshift([{ path: 'D:/out/r3.mp4', filename: 'r3.mp4', type: 'output', kind: 'video', external: true }]);
            __panel.renderHistoryPanel(); }""")
        self.assertEqual(self.strip(pg)["tiles"], [0, 1, 2, 3])
        # A node's output pushed to a tab that has none yet: the dropdown offers it.
        pg.evaluate("() => { __panel.allTabs['42'] = []; __panel.tabOrder.push('42'); __panel.tabLabels['42'] = 'node 42'; "
                    "__panel.updateNodeImages('42', [{ filename: 'n.png', subfolder: '', type: 'output' }]); }")
        s = self.strip(pg)
        self.assertIn("node 42", s["options"])
        self.assertTrue(s["active"].startswith("edit:"), "a render elsewhere leaves the cut on screen")
        self.assertEqual(self.errors, [])

    def test_popped_out_the_strip_borrows_switches_and_drags(self):
        pg = self.page()
        with pg.context.expect_page() as pop:
            pg.evaluate("() => window.__panel.toggleUndock()")
        win = pop.value
        win.wait_for_load_state()
        pg.wait_for_function("() => __panel.historyPanel.ownerDocument !== document && __panel._editTlUi.body.ownerDocument !== document",
                             timeout=10000)
        pg.evaluate("() => { __panel._historyPanelSig = null; __panel.renderHistoryPanel(); }")
        s = self.strip(pg)
        self.assertTrue(s["bar"])
        self.assertEqual((s["key"], s["tiles"]), ("folder_renders", [0, 1, 2]))
        self.assertTrue(pg.evaluate("() => __panel.historyPanel.querySelector('.history-source').ownerDocument !== document"))
        # The dropdown, used in the popped-out window.
        win.select_option(".history-source select", "folder_stills")
        self.assertEqual(self.strip(pg)["tiles"], [0, 1])
        # A real click in that window selects and keeps the cut.
        win.click(".history-thumb[data-idx='1']")
        s = self.strip(pg)
        self.assertEqual(s["picked"], [1])
        self.assertTrue(s["active"].startswith("edit:"))
        x, y = pg.evaluate(WHERE, [1.0, "V2"])
        pg.evaluate(DRAG, [1, x, y])
        pg.wait_for_function("() => __panel._editTlCut.tracks.find((k) => k.id === 'V2').clips.length === 1", timeout=5000)
        self.assertEqual(pg.evaluate(V2), [["D:/out/s1.png", 1.0]])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
