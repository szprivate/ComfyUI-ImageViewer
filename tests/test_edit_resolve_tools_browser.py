"""The Edit panel's Resolve tools in a real browser: markers, ... (the harness and the cut of test_edit_timeline_browser).

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest tests.test_edit_resolve_tools_browser
"""
import unittest

import test_edit_timeline_browser as base
from test_edit_timeline_browser import WHERE

# The harness, the cut and the helpers of the timeline's browser tests, without their tests.
Base = type("Base", (unittest.TestCase,), {k: v for k, v in base.EditTimelineBrowserTests.__dict__.items()
                                           if not k.startswith("test") and k not in ("__dict__", "__weakref__")})


class EditResolveToolsBrowserTests(Base):
    def marker_at(self, pg, i, cls="edit-marker"):
        """The middle of a marker's flag - or, for a duration marker, a pixel inside its start."""
        return pg.evaluate("""([i, cls]) => { const e = [...__panel._editTlUi.body.querySelectorAll('.' + cls)][i], m = e.getBoundingClientRect();
            return [e.classList.contains('span') ? m.left + 1 : m.left + m.width / 2, m.top + m.height / 2]; }""", [i, cls])

    MARKERS = "() => __panel._editTlCut.markers.map(m => [Math.round(m.t * 24), m.name, m.color, Math.round(m.len * 24)])"
    CMARKERS = "() => (__panel._editTlCut.clips[2].markers || []).map(m => [Math.round(m.src * 24), m.name])"

    # ── markers ──

    def test_markers_by_key_on_the_ruler_and_on_a_clip_edit_move_step_delete(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.evaluate("() => __panel.setFrame(30)")
        pg.keyboard.press("m")
        self.assertEqual(pg.evaluate(self.MARKERS), [[30, "", "blue", 0]])
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.ruler.querySelectorAll('.edit-marker').length"), 1)
        self.assertEqual(self.undo_len(pg), 1)
        # M on it again opens it: name, colour, duration.
        pg.keyboard.press("m")
        pg.wait_for_selector(".edit-markerdlg", state="attached")
        self.assertEqual(self.undo_len(pg), 1, "nothing doubled")
        pg.evaluate("""() => { const d = __panel._editTlUi.body.querySelector('.edit-markerdlg'); const [name, color, dur] = d.querySelectorAll('.edit-markerin');
            name.value = 'music in'; color.value = 'green'; dur.value = '12'; d.querySelector('.edit-btn.primary').click(); }""")
        self.assertEqual(pg.evaluate(self.MARKERS), [[30, "music in", "green", 12]])
        # A clip marker: shot b (V1:2, from 7 s, 1 s into its file) selected, the playhead inside it.
        pg.mouse.click(*self.x_at(pg, 8.0))
        pg.evaluate("() => __panel.setFrame(10 * 24)")
        pg.keyboard.press("m")
        self.assertEqual(pg.evaluate(self.CMARKERS), [[4 * 24, ""]], "3 s into the shot is 4 s into b's file")
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelectorAll('.edit-cmarker').length"), 1)
        # Shift+Up / Down go from marker to marker.
        pg.evaluate("() => __panel.setFrame(0)")
        pg.keyboard.press("Shift+ArrowDown")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 30)
        pg.keyboard.press("Shift+ArrowDown")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 240)
        pg.keyboard.press("Shift+ArrowUp")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 30)
        # A drag of the timeline marker moves it (one step) and it snaps to the start of shot c (4 s).
        before = self.undo_len(pg)
        x, y = self.marker_at(pg, 0)
        tx, _ = self.x_at(pg, 4.0, dx=3)
        pg.mouse.move(x, y)
        pg.mouse.down()
        pg.mouse.move((x + tx) / 2, y, steps=3)
        pg.mouse.move(tx, y, steps=3)
        pg.mouse.up()
        self.assertEqual(pg.evaluate(self.MARKERS)[0][0], 96)
        self.assertEqual(self.undo_len(pg), before + 1)
        # A click selects it and puts the playhead there; Del takes it away.
        pg.mouse.click(*self.marker_at(pg, 0))
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 96)
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate(self.MARKERS), [])
        self.assertEqual(len(self.frames(pg)["v1"]), 3, "the clip under it stays")
        # Alt+M takes the clip marker at the playhead away.
        pg.keyboard.press("Shift+ArrowDown")
        pg.keyboard.press("Alt+m")
        self.assertEqual(pg.evaluate(self.CMARKERS), [])
        # Undo walks back.
        pg.keyboard.press("Control+z")
        self.assertEqual(len(pg.evaluate(self.CMARKERS)), 1)
        self.assertEqual(self.errors, [])

    def test_a_marker_survives_a_save_and_is_in_the_viewer_state(self):
        pg = self.page()
        self.focus_timeline(pg)
        pg.evaluate("() => __panel.setFrame(48)")
        pg.keyboard.press("m")
        state = pg.evaluate("() => __panel.agentViewerState()")
        self.assertEqual(state["edit"]["markers"], [{"t": 2, "color": "blue"}])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
