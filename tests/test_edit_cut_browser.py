"""A cut changed by agentY lands in the open Edit panel, in a real browser.

POST /imageviewer/cut saves the cut and sends ComfyUI's `imageviewer.edit.changed` ({otio, edit, said}); here the
message is dispatched through the stubbed api, the way the route sends it, with the cut the route would
answer (a voice-over on A2 at 8 s).

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest discover -s tests -p test_edit_cut_browser.py
"""
import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import test_edit_takes_browser as tb  # noqa: E402

S1, S2, S3, sync_playwright = tb.S1, tb.S2, tb.S3, tb.sync_playwright

VO = "D:/out/vo.mp3"

# What the route answers after edit_cut added the voice-over: the cut as the panel holds it, V1 as it
# was, A2 new with the voice-over at 8 s.
CHANGED = """(over) => { const c = structuredClone(__panel._editTlSaved);
  for (const k of c.tracks) for (const x of k.clips) x.ref = [1, 0];
  c.tracks.push({ id: 'A2', kind: 'audio', name: 'A2', off: false,
                  clips: [{ file: 'D:/out/vo.mp3', name: 'vo', in: 0, length: 6, at: 8, volume: 1, color: '' }] });
  return Object.assign({ otio: 'D:/out/cut.otio', edit: c, file: 'cut.otio', said: ['added vo on A2 at 8.0s for 6.0s'] }, over || {}); }"""

STATE = """() => { const c = __panel._editTlCut;
  return { v1: c.clips.map(x => x.file), tracks: c.tracks.map(k => [k.id, k.clips.map(x => [x.file, x.at, x.length])]),
           dirty: __panel._editTlDirty(), note: __panel._editTlNote,
           rows: [...__panel._editTlUi.rows.querySelectorAll('.edit-track')].map(r => r.dataset.track) }; }"""


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class EditCutChangedBrowserTests(tb.EditTakesBrowserTests):
    def changed(self, pg, over=None):
        detail = pg.evaluate(CHANGED, over)
        pg.evaluate("(d) => { __api.dispatch('imageviewer.edit.changed', d); }", detail)
        pg.wait_for_timeout(300)

    def test_a_vo_added_by_agentY_shows_on_A2_saved_and_undo_takes_it_out(self):
        pg = self.page(saved=True)
        pg.evaluate("() => { __media['D:/out/vo.mp3'] = { duration: 6, audio: true, video: false }; }")
        self.changed(pg)
        st = pg.evaluate(STATE)
        self.assertEqual(st["v1"], [S1, S2, S3])
        self.assertIn(["A2", [[VO, 8, 6]]], st["tracks"])
        self.assertIn("A2", st["rows"], "the new track is drawn")
        self.assertFalse(st["dirty"], "the file has it: not an unsaved change")
        self.assertIn("agentY changed the cut: added vo on A2", st["note"])
        pg.evaluate("() => __panel.editTlUndo()")
        st = pg.evaluate(STATE)
        self.assertNotIn("A2", [t[0] for t in st["tracks"]])
        self.assertTrue(st["dirty"], "undone: the panel differs from the file again")
        self.assertEqual(self.errors, [])

    def test_unsaved_changes_are_one_undo_back_and_another_cut_is_left_alone(self):
        pg = self.page(saved=True)
        before = pg.evaluate(STATE)
        self.changed(pg, {"otio": "D:/out/other.otio"})
        self.assertEqual(pg.evaluate(STATE), before)
        self.changed(pg, {"edit": None})
        self.assertEqual(pg.evaluate(STATE), before)
        pg.evaluate("() => { const c = structuredClone(__panel._editTlCut); c.clips[0].color = '#ff0000'; __panel._editTlApply(c); }")
        self.assertTrue(pg.evaluate("() => __panel._editTlDirty()"))
        self.changed(pg)
        st = pg.evaluate(STATE)
        self.assertIn("one Ctrl+Z back", st["note"])
        self.assertFalse(st["dirty"])
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[0].color"), "#ff0000", "the user's version is back")
        self.assertFalse(pg.evaluate("() => 'ref' in __panel._editTlCut.clips[0]"), "held by file: the file was written anew")
        self.assertEqual(self.errors, [])


# The takes tests are run by their own module; only the ones above here.
for _name in [n for n in vars(tb.EditTakesBrowserTests) if n.startswith("test_")]:
    if _name not in vars(EditCutChangedBrowserTests):
        setattr(EditCutChangedBrowserTests, _name, None)

if __name__ == "__main__":
    unittest.main()
