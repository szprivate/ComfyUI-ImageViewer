"""The Edit panel's Resolve tools in a real browser: markers, the in-out range, swap, select forward, ... (the harness and the cut of test_edit_timeline_browser).

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


    # ── the in-out range, swap, select forward ──

    def range_on(self, pg, a, b):
        """In at frame a, out at frame b (the last frame inside), nothing selected."""
        pg.evaluate("([a, b]) => { __panel._editTlSel = null; __panel._editTlMulti = null; __panel._editTlSetRange({ start: a, end: b }); __panel.editTlRefresh(); }", [a, b])

    def test_lift_and_extract_the_in_out_range_on_the_auto_selected_tracks(self):
        # V1: a 0-96, c 96-168, b 168-264 (frames); V2: t 48-144.
        pg = self.page()
        self.on_v2(pg, ("t", 2, 4))
        self.focus_timeline(pg)
        self.range_on(pg, 72, 119)
        before = self.undo_len(pg)
        pg.keyboard.press("Delete")
        got = self.frames(pg)
        self.assertEqual(got["v1"], [["a", 0, 72], ["c", 120, 168], ["b", 168, 264]], "a gap where the range was")
        self.assertEqual([x[1:] for x in got["tracks"]["V2"]], [[48, 72], [120, 144]])
        self.assertEqual(self.undo_len(pg), before + 1, "one step")
        pg.keyboard.press("Control+z")
        self.assertEqual(self.frames(pg)["v1"], [["a", 0, 96], ["c", 96, 168], ["b", 168, 264]])
        # Extract: the hole closes.
        self.range_on(pg, 72, 119)
        pg.keyboard.press("Shift+Delete")
        got = self.frames(pg)
        self.assertEqual(got["v1"], [["a", 0, 72], ["c", 72, 120], ["b", 120, 216]])
        self.assertEqual([x[1:] for x in got["tracks"]["V2"]], [[48, 72], [72, 96]])
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 72, "the playhead at the in")
        # V2's Auto Track Selector off: it keeps its clip whole; the ruler's menu has both.
        pg.keyboard.press("Control+z")
        pg.evaluate("() => { const P = __panel, c = P._editTlCut; c.tracks[0].auto = false; P._editTlApply({ ...c }); }")
        self.range_on(pg, 72, 119)
        labels = pg.evaluate("() => __panel._editTlRangeMenuRows().map(r => r.label + (r.disabled ? ' (off)' : ''))")
        self.assertEqual(labels, ["Lift in–out (Del)", "Extract in–out (Shift+Del)"])
        pg.evaluate("() => __panel._editTlRangeMenuRows()[1].run()")
        got = self.frames(pg)
        self.assertEqual(got["v1"][2], ["b", 120, 216])
        self.assertEqual([x[1:] for x in got["tracks"]["V2"]], [[48, 144]])
        # Without a range and without a selection Del does nothing.
        pg.evaluate("() => { __panel._editTlSetRange(null); __panel._editTlSel = null; }")
        n = self.undo_len(pg)
        pg.keyboard.press("Delete")
        self.assertEqual(self.undo_len(pg), n)
        self.assertEqual(self.errors, [])

    def test_swap_clips_and_select_forward(self):
        pg = self.page()
        self.on_v2(pg, ("t", 6, 1))
        self.focus_timeline(pg)
        pg.mouse.click(*self.x_at(pg, 2.0))
        pg.keyboard.press("Control+Shift+Period")
        self.assertEqual([v[0] for v in self.frames(pg)["v1"]], ["c", "a", "b"])
        self.assertEqual(pg.evaluate(self.SEL), ["V1:1"], "the selection goes with the clip")
        pg.keyboard.press("Control+Shift+Comma")
        self.assertEqual(self.frames(pg)["v1"], [["a", 0, 96], ["c", 96, 168], ["b", 168, 264]])
        # Y from 5 s: c (under the playhead) and b on V1; Alt+Y adds V2's clip; Shift+Y the ones before.
        pg.evaluate("() => { __panel._editTlSel = null; __panel._editTlMulti = null; __panel.setFrame(120); __panel.editTlRefresh(); }")
        pg.keyboard.press("y")
        self.assertEqual(pg.evaluate(self.SEL), ["V1:1", "V1:2"])
        pg.keyboard.press("Alt+y")
        self.assertEqual(pg.evaluate(self.SEL), ["V1:1", "V1:2", "V2:0"])
        pg.keyboard.press("Shift+y")
        self.assertEqual(pg.evaluate(self.SEL), ["V1:0", "V1:1"], "on the selected clip's track")
        self.assertEqual(self.errors, [])


    # ── dynamic trim ──

    def test_dynamic_trim_moves_the_edit_point_with_j_k_l_as_one_step(self):
        # V1: a 0-96, c 96-168, b 168-264 (frames).
        pg = self.page()
        self.focus_timeline(pg)
        pg.keyboard.press("t")
        pg.evaluate("() => __panel.setFrame(0)")
        for _ in range(3):                    # on to the out of a, the clip before the first cut
            if pg.evaluate("() => __panel.currentFrame") == 96:
                break
            pg.keyboard.press("Shift+s")
        self.assertEqual(pg.evaluate("() => __panel._editTlEditSel.act"), "trim-out")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 96)
        before = self.undo_len(pg)
        pg.keyboard.press("w")
        self.assertTrue(pg.evaluate("() => __panel._editTlUi.dynamic.classList.contains('on')"))
        pg.keyboard.press("j")
        self.assertTrue(pg.evaluate("() => !!__panel._editTlDyn"))
        pg.keyboard.press("j")
        self.assertEqual(pg.evaluate("() => __panel._editTlDyn.rate"), 2, "J again runs faster")
        pg.wait_for_function("() => __panel._editTlCut.clips[0].length < 3.5")
        pg.keyboard.press("k")
        self.assertFalse(pg.evaluate("() => !!__panel._editTlDyn"))
        got = self.frames(pg)["v1"]
        self.assertLess(got[0][2], 84)
        self.assertEqual(got[1][1], got[0][2], "a ripple: c follows a's out")
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), got[0][2], "the playhead stays on the edit")
        self.assertEqual(self.undo_len(pg), before + 1, "the whole run is one step")
        pg.keyboard.press("Control+z")
        self.assertEqual(self.frames(pg)["v1"], [["a", 0, 96], ["c", 96, 168], ["b", 168, 264]])
        # Selection mode, clip c selected, no edit point: J slides it (a gives, b takes).
        pg.keyboard.press("a")
        pg.mouse.click(*self.x_at(pg, 5.5))
        pg.evaluate("() => { __panel._editTlEditSel = null; }")
        pg.keyboard.press("j")
        self.assertEqual(pg.evaluate("() => __panel._editTlDyn && __panel._editTlDyn.what"), "slide")
        pg.wait_for_function("() => __panel._editTlCut.clips[0].length < 3.9")
        pg.keyboard.press("k")
        got = self.frames(pg)["v1"]
        self.assertEqual(got[1][2] - got[1][1], 72, "c keeps its length")
        self.assertEqual(got[2][2], 264, "the film keeps its length")
        # W off: J / K / L are the shuttle again.
        pg.keyboard.press("w")
        pg.keyboard.press("l")
        self.assertFalse(pg.evaluate("() => !!__panel._editTlDyn"))
        pg.keyboard.press("k")
        self.assertEqual(self.errors, [])


    # ── transitions: dip to a colour, wipes ──

    def test_dip_and_wipe_from_the_menu_and_the_inspector_and_how_they_play(self):
        # V1: a 0-96, c 96-168, b 168-264 (frames); a second's dissolve into c: c then starts at 72, the dissolve is 72-96.
        pg = self.page()
        pg.evaluate("""async () => { const D = await import('/extensions/viewer/imageViewer_editTimelineData.js'); const P = __panel;
            P._editTlApply(D.setTransition(P._editTlCut, 1, 1)); P._editTlSel = { kind: 'mix', i: 1 }; P.editTlRefresh(); }""")
        mix = "() => { const b = __panel._editTlUi.rows.querySelector('.edit-mix'); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"
        items = self.menu_has(pg, *pg.evaluate(mix))
        self.assertIn("\u2713 Cross Dissolve", items)
        pg.locator(".previz-menu-item", has_text="Dip to White").first.click()
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[1].tfx"), {"type": "dip", "color": "#ffffff"})
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelector('.edit-mix').dataset.look"), "dip")
        # Played: the first half, the shot going out fades over white; the second, the one coming in from it.
        look = """(f) => { __panel.setFrame(f); const P = __panel, ep = P._ep, main = ep.still ? P.imgBase : P.videoBase, under = ep.underEl;
            const host = main.parentNode; return [Number(main.style.opacity || 1), under ? Number(under.style.opacity) : null, host.style.backgroundColor]; }"""
        inn, out, ground = pg.evaluate(look, 76)
        self.assertEqual(inn, 0)
        self.assertGreater(out, 0.3)
        self.assertEqual(ground, "rgb(255, 255, 255)")
        inn, out, ground = pg.evaluate(look, 92)
        self.assertGreater(inn, 0.3)
        self.assertEqual(out, 0)
        self.assertEqual(pg.evaluate(look, 130)[2], "", "the ground back to what it was after it")
        # The Inspector: the type and the wipe's direction.
        pg.evaluate("() => { __panel._editTlSel = { kind: 'mix', i: 1 }; __panel.editTlRefresh(); }")
        pg.evaluate("""() => { const s = __panel.editInspectorPanel.querySelector("[data-field='ttype']"); s.value = 'wipe'; s.dispatchEvent(new Event('change')); }""")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[1].tfx"), {"type": "wipe", "dir": "right"})
        pg.evaluate("""() => { const s = __panel.editInspectorPanel.querySelector("[data-field='tdir']"); s.value = 'down'; s.dispatchEvent(new Event('change')); }""")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[1].tfx"), {"type": "wipe", "dir": "down"})
        mask = "(f) => { __panel.setFrame(f); const P = __panel; return [P.imgBase, P.videoBase].map(e => e.style.maskImage || e.style.webkitMaskImage || '').join(''); }"
        got = pg.evaluate(mask, 84)
        self.assertIn("52.08%", got)
        self.assertNotIn("to ", got, "top to bottom: the gradient's own way (the browser drops 'to bottom')")
        self.assertEqual(pg.evaluate(mask, 130), "", "no mask after it")
        # Saved: the look goes to the file.
        pg.evaluate("() => __panel._editTlSave()")
        pg.wait_for_function("() => (window.__saves || []).length > 0", timeout=5000)
        self.assertEqual(pg.evaluate("() => window.__saves.at(-1).edit.clips.map(c => c.tfx)"), [None, {"type": "wipe", "dir": "down"}, None])
        self.assertEqual(self.errors, [])


    # ── freeze frame, reverse ──

    def test_reverse_and_freeze_from_the_menu_and_the_inspector_and_how_they_play(self):
        # V1: a 0-96 (a film, in 0), c 96-168, b 168-264 (frames).
        pg = self.page()
        self.fit(pg)
        items = self.menu_has(pg, *self.x_at(pg, 1.0))
        self.assertIn("Reverse clip", items)
        self.assertIn("Freeze frame", items)
        pg.locator(".previz-menu-item", has_text="Reverse clip").first.click()
        c = pg.evaluate("() => { const c = __panel._editTlCut.clips[0]; return [c.motion, c.in, c.length]; }")
        self.assertEqual(c, ["reverse", 4, 4])
        self.assertEqual(self.undo_len(pg), 1)
        self.assertIn("\u25c0\u25c0", pg.evaluate("() => __panel._editTlUi.rows.querySelector('.edit-shot.reversed .edit-badge-time').textContent"))
        # Played backwards: frame 24 shows the source just before 3 s, frame by frame (stepped), silent.
        at = pg.evaluate("() => { __panel.setFrame(24); const ep = __panel._ep; return [ep.at.local, ep.at.rev, ep.stepped]; }")
        self.assertEqual(at, [2.9792, True, True], "the middle of frame 24: 4 s less 24.5 / 24")
        # The Inspector: freeze at the playhead (frame 24 of the reversed clip: 3 s, the frame's middle).
        pg.evaluate("() => { __panel._editTlSel = { kind: 'clip', i: 0 }; __panel.editTlRefresh(); }")
        pg.evaluate("""() => { const P = __panel; P._editInspTab = 'timing'; P.editTlRefresh(); }""")
        pg.evaluate("""() => { const s = __panel.editInspectorPanel.querySelector("[data-field='motion']"); s.value = 'freeze'; s.dispatchEvent(new Event('change')); }""")
        c = pg.evaluate("() => { const c = __panel._editTlCut.clips[0]; return [c.motion, Math.round(c.in * 48), c.length]; }")
        self.assertEqual(c, ["freeze", 143, 4], "held at 3 s less half a frame")
        self.assertEqual(pg.evaluate("() => { __panel.setFrame(80); return __panel._ep.at.local; }"), pg.evaluate("() => __panel._editTlCut.clips[0].in"))
        items = self.menu_has(pg, *self.x_at(pg, 1.0))
        self.assertIn("\u2713 Freeze frame", items)
        pg.keyboard.press("Escape")
        # Saved: the motion goes to the file; undone, the clip plays forwards from 0 again.
        pg.evaluate("() => __panel._editTlSave()")
        pg.wait_for_function("() => (window.__saves || []).length > 0", timeout=5000)
        self.assertEqual(pg.evaluate("() => window.__saves.at(-1).edit.clips.map(c => c.motion)"), ["freeze", "", ""])
        self.assertEqual(self.errors, [])


    # ── speed ramps ──

    def test_a_speed_ramp_from_the_speed_rows_diamond_plays_stepped(self):
        # V1: a 0-96 (a film, in 0), c 96-168, b 168-264 (frames).
        pg = self.page()
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 0 }; P._editInspTab = 'timing'; P.setFrame(0); P.editTlRefresh(); }")
        row = "() => __panel.editInspectorPanel.querySelector(\"[data-keys='spd']\")"
        self.assertTrue(pg.evaluate(row + " !== null"), "the Speed row has its keyframe controls")
        pg.evaluate("() => __panel.editInspectorPanel.querySelector(\"[data-keys='spd'] .insp-diamond\").click()")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.clips[0].fx.keys.spd"), [{"t": 0, "v": 1}])
        # At frame 48 a speed of 300 %: a second key, the clip keeps its length.
        pg.evaluate("() => { __panel.setFrame(48); __panel.editTlRefresh(); }")
        pg.evaluate("""() => { const f = __panel.editInspectorPanel.querySelector("[data-field='speed']"); f.value = '300'; f.dispatchEvent(new Event('change')); }""")
        got = pg.evaluate("() => { const c = __panel._editTlCut.clips[0]; return [c.fx.keys.spd, c.length]; }")
        self.assertEqual(got, [[{"t": 0, "v": 1}, {"t": 2, "v": 3}], 4])
        self.assertIn("ramp", pg.evaluate("() => __panel._editTlUi.rows.querySelector('.edit-shot .edit-badge-time').textContent"))
        # Played frame by frame: frame 72 (3.02 s into the clip) shows 2 + 2 + 3 x 1.02 seconds of source.
        at = pg.evaluate("""async () => { const D = await import('/extensions/viewer/imageViewer_editTimelineData.js');
            __panel.setFrame(72); const ep = __panel._ep; return [ep.at.local, D.srcLocal(__panel._editTlCut.clips[0], 72.5 / 24), ep.stepped]; }""")
        self.assertEqual(at[0], at[1])
        self.assertTrue(at[2])
        self.assertAlmostEqual(at[0], 4 + 3 * 1.0208, places=3)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
