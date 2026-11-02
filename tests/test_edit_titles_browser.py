"""Titles in the Edit panel, in a real browser: a title is a clip - trimmed, bladed, selected with clips, moved
across tracks, switched off with D, pasted, keyed - and the Inspector's Title tab changes how the preview draws it;
Ctrl+B in its words is bold, not the blade.

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest discover -s tests -p test_edit_titles_browser.py
It serves tests/harness/edit.html (the real viewer js, ComfyUI stubbed) on a free port.
"""
import os
import shutil
import subprocess
import sys
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from test_edit_timeline_browser import SETUP, WHERE, _free_port, sync_playwright  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# A title "Hello" on V2 from 1 s to 3 s, over the shot a (0..4), selected, the playhead in it (frame 48 = 2 s).
TITLE = """() => { const P = __panel;
  P.setFrame(48);
  P.editFxApply({ type: 'text', text: 'Hello', seconds: 2, look: { size: 12, y: 0.5, sw: 0, color: '#ffffff' } }, 1, 'V2');
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  P.editTlRefresh(); P._editTlUi.body.focus(); return P._editTlSel; }"""
# What the preview drew: the title layers shown, each with how much ink and where.
LAYERS = """() => [...__panel.container.querySelectorAll('.edit-title-layer')].filter(c => c.style.display !== 'none').map(c => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0, x0 = 1e9, x1 = -1;
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) { const a = d[(y * c.width + x) * 4 + 3]; if (a > 128) { ink++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); } }
  return { key: c.dataset.key, ink, x0: x0 / c.width, x1: x1 / c.width, z: c.style.zIndex, op: c.style.opacity }; })"""
TITLES = "() => __panel._editTlCut.tracks.flatMap(k => k.clips.map((c, i) => c.title ? [k.id, i, c.title.text, Math.round(c.at*1000)/1000, Math.round(c.length*1000)/1000, !!c.disabled] : null).filter(Boolean))"
BLOCK = """(key) => { const b = __panel._editTlUi.rows.querySelector(`[data-key='${key}']`); const r = b.getBoundingClientRect();
  return [r.left, r.right, r.top + r.height / 2, b.classList.contains('edit-titleclip')]; }"""
TBTN = "(k) => { __panel.editInspectorPanel.querySelector(`[data-title='${k}']`).click(); return __panel.editInspectorPanel.querySelector(`[data-title='${k}']`).classList.contains('on'); }"


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class EditTitlesBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port))
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
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('bepic-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        pg.evaluate(SETUP, 0)
        pg.wait_for_function("() => __panel._emPending === 0 && __panel._emDrawn > 0", timeout=15000)
        sel = pg.evaluate(TITLE)
        self.assertEqual(sel, {"kind": "tclip", "track": "V2", "i": 0})
        pg.wait_for_function("() => (" + LAYERS + ")().some(l => l.ink > 0)", timeout=5000)
        return pg

    def layers(self, pg):
        return pg.evaluate(LAYERS)

    def undo_len(self, pg):
        return pg.evaluate("() => __panel._editTlHistory().past.length")

    def test_a_title_is_a_clip_on_v2_drawn_over_the_picture_and_the_inspector_formats_it(self):
        pg = self.page()
        self.assertEqual(pg.evaluate(TITLES), [["V2", 0, "Hello", 1.0, 2.0, False]])
        left, right, y, is_title = pg.evaluate(BLOCK, "V2:0")
        self.assertTrue(is_title)
        # The picture under it is the shot: a title is no cover.
        self.assertEqual(pg.evaluate("() => __panel._ep.at.key"), "V1:0")
        first = self.layers(pg)
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]["key"], "V2:0")
        self.assertEqual(first[0]["z"], "4", "above the picture")
        # The Title tab is up; Bold makes more ink; align right moves the words right.
        self.assertTrue(pg.evaluate("() => !!__panel.editInspectorPanel.querySelector('.insp-tab.on') && __panel.editInspectorPanel.querySelector('.insp-tab.on').textContent === 'Title'"))
        n = self.undo_len(pg)
        self.assertTrue(pg.evaluate(TBTN, "bold"))
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].title.bold"))
        self.assertEqual(self.undo_len(pg), n + 1)
        bold = self.layers(pg)[0]
        self.assertGreater(bold["ink"], first[0]["ink"] * 1.1)
        pg.evaluate("(k) => __panel.editInspectorPanel.querySelector(`[data-title='${k}']`).click()", "align:right")
        right_al = self.layers(pg)[0]
        self.assertGreater(right_al["x0"], bold["x0"] + 0.05)
        # A colour, the font, the text box: they reach the title.
        pg.evaluate("""() => { const i = __panel.editInspectorPanel.querySelector("input[data-title='color']"); i.value = '#ff0000'; i.dispatchEvent(new Event('change')); }""")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].title.color"), "#ff0000")
        pg.evaluate("""() => { const s = __panel.editInspectorPanel.querySelector("select[data-title='font']"); s.value = 'Georgia'; s.dispatchEvent(new Event('change')); }""")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].title.font"), "Georgia")
        pg.evaluate("""() => { const i = __panel.editInspectorPanel.querySelector("input[data-title='w']"); i.value = '40'; i.dispatchEvent(new Event('change')); }""")
        self.assertAlmostEqual(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].title.w"), 0.4)
        # Ctrl+B in the words: bold off again, and no blade (still one title, no clip cut).
        clips = pg.evaluate("() => __panel._editTlCut.clips.length")
        area = "textarea.insp-title-text"
        pg.evaluate(f"() => {{ const a = __panel.editInspectorPanel.querySelector('{area}'); a.focus(); }}")
        pg.keyboard.press("Control+b")
        self.assertFalse(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].title.bold"))
        pg.wait_for_function("() => __panel.editInspectorPanel.querySelector('textarea.insp-title-text') === __panel.editInspectorPanel.getRootNode().activeElement || document.activeElement && document.activeElement.shadowRoot && document.activeElement.shadowRoot.activeElement && document.activeElement.shadowRoot.activeElement.classList.contains('insp-title-text')", timeout=3000)
        pg.keyboard.press("Control+i")
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].title.italic"))
        self.assertEqual(len(pg.evaluate(TITLES)), 1)
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips.length"), clips)
        # New words, typed and committed.
        pg.evaluate(f"() => {{ const a = __panel.editInspectorPanel.querySelector('{area}'); a.value = 'New words'; a.dispatchEvent(new Event('change')); }}")
        self.assertEqual(pg.evaluate(TITLES)[0][2], "New words")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].name"), "New words")
        # Saved as a title: no file.
        pg.evaluate("() => __panel._editTlSave()")
        pg.wait_for_function("() => (window.__saves || []).length > 0", timeout=5000)
        sent = pg.evaluate("() => window.__saves.at(-1).edit.tracks[0].clips.find(c => c.title)")
        self.assertNotIn("file", sent)
        self.assertEqual(sent["title"]["text"], "New words")
        self.assertEqual(self.errors, [])

    def test_a_title_is_trimmed_bladed_selected_with_a_clip_moved_up_switched_off_and_undone(self):
        pg = self.page()
        pps = pg.evaluate("() => __panel._editTlUi.area.getBoundingClientRect().width / __panel._editTlLay.total")
        left, right, y, _ = pg.evaluate(BLOCK, "V2:0")
        # Trim its out edge 1 s later.
        pg.mouse.move(right - 2, y)
        pg.mouse.down()
        pg.mouse.move(right - 2 + 0.5 * pps, y, steps=3)
        pg.mouse.move(right - 2 + pps, y, steps=3)
        pg.mouse.up()
        self.assertEqual(pg.evaluate(TITLES), [["V2", 0, "Hello", 1.0, 3.0, False]])
        # Ctrl+B at the playhead (2 s) with it selected: two titles.
        pg.mouse.click(left + 0.25 * pps, y)
        pg.evaluate("() => { __panel.setFrame(48); __panel._editTlUi.body.focus(); }")
        pg.keyboard.press("Control+b")
        got = pg.evaluate(TITLES)
        self.assertEqual([g[3:5] for g in got], [[1.0, 1.0], [2.0, 2.0]])
        self.assertEqual({g[2] for g in got}, {"Hello"})
        # The second half and the shot b, by Ctrl+click.
        x2 = pg.evaluate(BLOCK, "V2:1")
        pg.mouse.click(x2[0] + 0.3 * pps, x2[2])
        pg.keyboard.down("Control")
        bx, by = pg.evaluate(WHERE, [8.5, "V1"])
        pg.mouse.click(bx, by)
        pg.keyboard.up("Control")
        self.assertEqual(len(pg.evaluate("() => __panel._editTlSelAll()")), 2)
        n = self.undo_len(pg)
        # D switches both off, one step; the title's layer goes.
        pg.keyboard.press("d")
        self.assertEqual(pg.evaluate(TITLES)[1][5], True)
        self.assertEqual(self.undo_len(pg), n + 1)
        pg.evaluate("() => __panel.setFrame(72)")
        self.assertEqual(self.layers(pg), [])
        pg.keyboard.press("Control+z")
        self.assertEqual(pg.evaluate(TITLES)[1][5], False)
        self.assertEqual(len(pg.evaluate("() => __panel._editTlSelAll()")), 2, "undo keeps the selection")
        # The group dragged up one row and later by half a second: the title onto a new V3, b onto V2.
        x2 = pg.evaluate(BLOCK, "V2:1")
        rows = pg.evaluate("() => { const r = [...__panel._editTlUi.rows.querySelectorAll('.edit-track')]; const v2 = r.find(e => e.dataset.track === 'V2').getBoundingClientRect(); const v1 = r.find(e => e.dataset.track === 'V1').getBoundingClientRect(); return v1.top - v2.top; }")
        x0, y0 = x2[0] + 0.3 * pps, x2[2]
        pg.mouse.move(x0, y0)
        pg.mouse.down()
        pg.mouse.move(x0 + 0.25 * pps, y0 - rows / 2, steps=4)
        pg.mouse.move(x0 + 0.5 * pps, y0 - rows, steps=4)
        pg.mouse.up()
        got = pg.evaluate(TITLES)
        moved = [g for g in got if g[0] == "V3"]
        self.assertEqual(len(moved), 1, got)
        self.assertEqual(moved[0][3], 2.5)
        v2 = pg.evaluate("() => __panel._editTlCut.tracks.find(k => k.id === 'V2').clips.filter(c => !c.title).map(c => [c.file, c.at])")
        self.assertEqual(v2, [["D:/out/b.mp4", 7.5]])
        self.assertEqual(self.errors, [])

    def test_paste_attributes_gives_a_titles_look_to_another_title_and_keys_animate_its_size(self):
        pg = self.page()
        pg.evaluate(TBTN, "bold")
        pg.evaluate("(k) => __panel.editInspectorPanel.querySelector(`[data-title='${k}']`).click()", "align:left")
        # A second title at 5 s.
        pg.evaluate("""() => { const P = __panel; P.editFxApply({ type: 'text', text: 'Other', seconds: 1 }, 5, 'V2'); P._editTlUi.body.focus(); }""")
        # Copy the first, select the second, Alt+V: only the text look.
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'tclip', track: 'V2', i: 0 }; P._editTlMulti = null; P.editTlRefresh(); P._editTlUi.body.focus(); }")
        pg.keyboard.press("Control+c")
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'tclip', track: 'V2', i: 1 }; P._editTlMulti = null; P.editTlRefresh(); P._editTlUi.body.focus(); }")
        pg.keyboard.press("Alt+v")
        d = "__panel._editTlUi.dialog"
        pg.wait_for_function(f"() => {d} && {d}.classList.contains('edit-paste')", timeout=3000)
        boxes = pg.evaluate(f"() => Object.fromEntries([...{d}.querySelectorAll('input[data-attr]')].map(b => [b.dataset.attr, b.disabled]))")
        self.assertFalse(boxes["textlook"])
        self.assertTrue(boxes["speed"], "a title has no speed")
        pg.evaluate(f"() => {{ {d}.querySelector('.edit-paste-none').click(); {d}.querySelector('input[data-attr=textlook]').click(); {d}.querySelector('.edit-paste-go').click(); }}")
        other = pg.evaluate("() => __panel._editTlCut.tracks[0].clips[1].title")
        self.assertEqual((other["text"], other["bold"], other["align"], other["size"]), ("Other", True, "left", 12))
        # Keys: the Size row's diamond at 1.5 s, then a bigger size at 2.5 s: the preview grows between them.
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'tclip', track: 'V2', i: 0 }; P._editTlMulti = null; P._editInspTab = 'title'; P.setFrame(36); P.editTlRefresh(); }")
        row = "[...__panel.editInspectorPanel.querySelectorAll('.insp-row')].find(r => r.querySelector('.insp-label').textContent === 'Size')"
        pg.evaluate(f"() => {row}.querySelector('.insp-diamond').click()")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].fx.keys.tsize.length"), 1)
        pg.evaluate("() => __panel.setFrame(60)")
        pg.evaluate(f"() => {{ const i = {row}.querySelector('input.insp-num'); i.value = '24'; i.dispatchEvent(new Event('change')); }}")
        keys = pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].fx.keys.tsize")
        self.assertEqual([k["v"] for k in keys], [12, 24])
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks[0].clips[0].title.size"), 12, "the static number stays")
        big = self.layers(pg)[0]["ink"]
        pg.evaluate("() => __panel.setFrame(36)")
        small = self.layers(pg)[0]["ink"]
        self.assertGreater(big, small * 2)
        # Key marks on its block, as on any clip.
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelectorAll(\"[data-key='V2:0'] .edit-keymark\").length"), 2)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
