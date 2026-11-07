"""Opening a cut, from everywhere a user looks: the Edit bar's Open button, Ctrl+O, Open recent, the viewer's own
tab-bar button with no cut open, an .otio dropped from the desktop, and the agent's open message.

Run: python -m unittest tests.test_edit_open_browser   (Playwright with Edge or Chrome and node; skipped without)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_edit_timeline_browser as base  # noqa: E402

PICK = "__panel.container.querySelector(':scope > .rd-shade.pick-dlg .rd-box')"
OTIO = ("{ name: 'saved', fps: 24, clips: [{ ref: 0, file: 'D:/out/a.mp4', name: 'a', in: 0, length: 2, transition: 0 }],"
        " texts: [], sound: [], tracks: [], off: {} }")
PREP = f"() => {{ window.__otio = {{ 'D:/out/saved.otio': {OTIO}, 'D:/in/edits/dropped.otio': {OTIO} }}; }}"
MENU_ITEMS = "() => [...__panel.container.querySelectorAll('.previz-menu .previz-menu-item')].map((b) => [b.textContent, b.disabled])"


class _Base(base.EditTimelineBrowserTests):
    pass


for _name in [n for n in dir(base.EditTimelineBrowserTests) if n.startswith("test")]:
    setattr(_Base, _name, None)


class EditOpenBrowserTests(_Base):
    def bare(self):
        """The viewer with no cut tab and no Edit panel."""
        pg = self.browser.new_page(viewport={"width": 1600, "height": 950})
        self.addCleanup(pg.close)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.goto(f"http://127.0.0.1:{self.port}/edit.html")
        pg.wait_for_function("window.__ready===true", timeout=20000)
        pg.evaluate("()=>{const all=document.querySelectorAll('comfyui-image-viewer-panel'); if(all[1]) all[1].style.display='none'}")
        pg.evaluate("() => { try { localStorage.removeItem('imageviewer.edit.recent'); } catch (_) {} }")
        pg.evaluate(PREP)
        return pg

    def pick_first_and_open(self, pg):
        pg.wait_for_function("() => __panel.container.querySelector('.pick-row.file')", timeout=5000)
        pg.evaluate("() => { __panel.container.querySelector('.pick-row.file').click(); __panel.container.querySelector('.pick-dlg .rd-go').click(); }")

    def test_the_open_button_opens_the_picker_centred_over_the_timeline(self):
        pg = self.page()
        pg.evaluate(PREP)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.body.querySelector('.edit-open').title"), "Open cut\u2026 (Ctrl+O)")
        self.assertIn("lucide-folder-open", pg.evaluate("() => __panel._editTlUi.body.querySelector('.edit-open').innerHTML"))
        pg.evaluate("() => __panel._editTlUi.body.querySelector('.edit-open').click()")
        pg.wait_for_function(f"() => {PICK}", timeout=5000)
        self.assert_centred(pg, PICK)
        self.pick_first_and_open(pg)
        pg.wait_for_function("() => __panel.editTlFilePath() === 'D:/out/saved.otio'", timeout=5000)
        self.assertEqual(self.errors, [])

    def test_the_out_menu_keeps_open_cut(self):
        pg = self.page()
        pg.evaluate("() => __panel._editTlUi.out.click()")
        pg.wait_for_function("() => __panel.container.querySelector('.previz-menu .previz-menu-item')", timeout=5000)
        labels = [x[0] for x in pg.evaluate(MENU_ITEMS)]
        self.assertTrue(any(l.startswith("Open cut") for l in labels), labels)
        self.assertTrue(any(l.startswith("Open recent") for l in labels), labels)

    def test_ctrl_o_opens_the_dialog_but_not_while_typing(self):
        pg = self.page()
        pg.evaluate(PREP)
        self.focus_timeline(pg)
        pg.keyboard.press("Control+o")
        pg.wait_for_function(f"() => {PICK}", timeout=5000)
        pg.evaluate(f"() => {PICK}.querySelector('.rd-x').click()")
        pg.wait_for_function(f"() => !{PICK}", timeout=3000)
        # Typed into a field: nothing opens.
        pg.evaluate("() => { const i = document.createElement('input'); i.id = 'tmp-in'; __panel._editTlUi.body.append(i); i.focus(); }")
        pg.keyboard.press("Control+o")
        pg.wait_for_timeout(300)
        self.assertFalse(pg.evaluate(f"() => !!{PICK}"))
        keys = pg.evaluate("async () => (await import('/extensions/viewer/imageViewer_editKeys.js')).EDIT_KEYS.map((k) => k[0])")
        self.assertIn("Ctrl+O", keys)
        self.assertEqual(self.errors, [])

    def test_open_recent_lists_a_saved_cut_and_opens_it_and_greys_missing(self):
        pg = self.page()
        pg.evaluate("() => localStorage.removeItem('imageviewer.edit.recent')")
        pg.evaluate(PREP)
        # A save puts the cut on the list.
        pg.evaluate("async () => { __panel._editTlApply({ ...__panel._editTlCut, name: 'x' }); await __panel._editTlSave(); }")
        self.assertEqual(pg.evaluate("() => __panel.editTlRecent()"), ["D:/out/cut.otio"])
        pg.evaluate("() => { window.__gone = ['D:/out/gone.otio']; localStorage.setItem('imageviewer.edit.recent', JSON.stringify(['D:/out/saved.otio', 'D:/out/gone.otio', 'D:/out/cut.otio'])); }")
        pg.evaluate("() => __panel._editTlUi.body.querySelector('.edit-open-recent').click()")
        pg.wait_for_function("() => __panel.container.querySelector('.previz-menu .previz-menu-item')", timeout=5000)
        items = dict(pg.evaluate(MENU_ITEMS))
        self.assertIn("saved.otio", items)
        self.assertTrue(items["gone.otio (missing)"], "a missing file is greyed")
        self.assertFalse(items["saved.otio"])
        pg.evaluate("() => [...__panel.container.querySelectorAll('.previz-menu .previz-menu-item')].find((b) => b.textContent === 'saved.otio').click()")
        pg.wait_for_function("() => __panel.editTlFilePath() === 'D:/out/saved.otio'", timeout=5000)
        self.assertEqual(pg.evaluate("() => __panel.editTlRecent()[0]"), "D:/out/saved.otio")
        self.assertEqual(self.errors, [])

    def test_the_viewers_top_bar_has_no_open_cut_button(self):
        # Open cut... is on the Edit panel's bar only; the menu still opens a cut with no cut tab up.
        pg = self.bare()
        self.assertFalse(pg.evaluate("() => !!__panel.shadowRoot.getElementById('open-cut-btn')"))
        self.assertEqual(pg.evaluate("() => __panel._editTlTabs().length"), 0)
        pg.evaluate("() => __panel.editTlOpenMenu(__panel.undockBtn)")
        pg.wait_for_function("() => __panel.container.querySelector('.previz-menu .previz-menu-item')", timeout=5000)
        self.assertTrue(pg.evaluate(MENU_ITEMS)[0][0].startswith("Open cut"))
        pg.evaluate("() => __panel.container.querySelector('.previz-menu .previz-menu-item').click()")
        self.pick_first_and_open(pg)
        pg.wait_for_function("() => __panel.editTlFilePath() === 'D:/out/saved.otio'", timeout=5000)
        self.assertEqual(pg.evaluate("() => __panel._editTlTabs().length"), 1)
        self.assertEqual(self.errors, [])

    def test_the_picker_starts_beside_the_last_opened_cut(self):
        pg = self.bare()
        pg.evaluate("() => { localStorage.setItem('imageviewer.edit.recent', JSON.stringify(['D:/elsewhere/old.otio'])); window.__requests.length = 0; }")
        pg.evaluate("() => __panel.editTlOpenDialog()")
        pg.wait_for_function("() => __panel.container.querySelector('.pick-row.file')", timeout=5000)
        self.assertTrue(pg.evaluate("() => __requests.some((r) => r.startsWith('/imageviewer/browse?D:/elsewhere'))"),
                        pg.evaluate("() => __requests"))

    def test_the_agent_opens_a_cut_and_a_dropped_otio_is_opened(self):
        pg = self.bare()
        # (The harness's extension makes a viewer panel of its own, the second; the message goes to that one.)
        pg.evaluate("() => __api.dispatch('imageviewer.edit.open', { path: 'D:/out/saved.otio' })")
        pg.wait_for_function("() => document.querySelectorAll('comfyui-image-viewer-panel')[1].editTlFilePath() === 'D:/out/saved.otio'", timeout=5000)
        # A dropped .otio is uploaded (the stub keeps it as D:/in/edits/<name>) and opened as a cut.
        n = pg.evaluate("async () => { const f = new File(['{}'], 'dropped.otio'); return await __panel.editTlOpenDropped([f]); }")
        self.assertEqual(n, 1)
        self.assertEqual(pg.evaluate("() => __panel.editTlFilePath()"), "D:/in/edits/dropped.otio")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
