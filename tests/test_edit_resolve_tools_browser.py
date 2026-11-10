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


    # ── the mixer ──

    def test_the_mixer_faders_pan_mute_solo_and_meters(self):
        pg = self.page()
        pg.evaluate("() => { const P = __panel; if (!P.isPanelDocked('editMixer')) P.editTlPanelToggle('editMixer'); P.editTlRefresh(); }")
        pg.wait_for_function("() => !!__panel.editMixerPanel.querySelector('.mix-body')", timeout=5000)
        # A place of its own: under the picture, right of the timeline (and a layout from before is moved there once).
        self.assertEqual(pg.evaluate("() => { const b = __panel.dockLayout.bottom.panels.map(p => p.id); return [__panel._dockSideOf('editMixer'), b.indexOf('editMixer') === b.indexOf('editTimeline') + 1]; }"), ["bottom", True])
        # Its title bar (the dock's drag handle) survives every redraw of the strips.
        title = "() => { const b = __panel.editMixerPanel.querySelector(':scope > .panel-titlebar'); return b ? b.querySelector('.pt-name').textContent : null; }"
        self.assertEqual(pg.evaluate(title), "Mixer")
        moved = pg.evaluate("""() => { const P = __panel, L = P.dockLayout;
            const [m] = L.bottom.panels.splice(L.bottom.panels.findIndex(p => p.id === 'editMixer'), 1); L.right.panels.push(m);
            localStorage.removeItem('imageviewer.viewer.mixerBottom'); P.applyDockLayout();
            const again = (L.right.panels.push(L.bottom.panels.splice(L.bottom.panels.findIndex(p => p.id === 'editMixer'), 1)[0]), P.applyDockLayout(), P._dockSideOf('editMixer'));
            P.dockPanelTo('editMixer', 'bottom'); return again; }""")
        self.assertEqual(moved, "right", "moved once; after that where the user puts it")
        strips = pg.evaluate("() => [...__panel.editMixerPanel.querySelectorAll('.mix-strip')].map(s => [s.dataset.track, !!s.querySelector('.mix-fader')])")
        self.assertEqual(strips, [["V1", False], ["A1", True], ["A2", True], ["master", True]])
        self.assertTrue(pg.evaluate("() => __panel._editMixOn()"))
        CHAIN = "(id) => (id === 'A1' ? (__panel._editTlCut.afx || {}).A1 : __panel._editTlCut.tracks.find(t => t.id === id).afx) || []"
        SET = """([id, field, v]) => { const f = __panel.editMixerPanel.querySelector(`.mix-strip[data-track="${id}"] [data-field="${field}"]`);
            f.dispatchEvent(new PointerEvent('pointerdown')); f.value = String(v); f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); }"""
        n = self.undo_len(pg)
        pg.evaluate(SET, ["A2", "gain", -6])
        self.assertEqual([[f["type"], f["p"]] for f in pg.evaluate(CHAIN, "A2")], [["gain", {"gain": -6}]])
        self.assertEqual(self.undo_len(pg), n + 1, "one undo step")
        self.assertEqual(pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"A2\"] .mix-db').textContent"), "-6.0 dB")
        pg.evaluate(SET, ["A2", "pan", -0.5])
        self.assertEqual([f["type"] for f in pg.evaluate(CHAIN, "A2")], ["gain", "pan"])
        pg.evaluate(SET, ["A1", "gain", 3])
        self.assertEqual([[f["type"], f["p"]] for f in pg.evaluate(CHAIN, "A1")], [["gain", {"gain": 3}]])
        # Back at 0 dB (a double-click) the effect goes again.
        pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"A2\"] [data-field=gain]').dispatchEvent(new MouseEvent('dblclick'))")
        self.assertEqual([f["type"] for f in pg.evaluate(CHAIN, "A2")], ["pan"])
        # The Inspector's keys and the fader are the same thing: keyed, a move is a key at the playhead.
        pg.evaluate("""() => { const P = __panel, k = P._editTlCut.tracks.find(t => t.id === 'A2');
            const next = JSON.parse(JSON.stringify(P._editTlCut)); next.tracks.find(t => t.id === 'A2').afx =
              [...(k.afx || []), { type: 'gain', on: true, p: { gain: 0 }, keys: { gain: [{ t: 0, v: 0 }, { t: 8, v: -16 }] } }];
            P._editTlApply(next); P.setFrame(96); P.editTlRefresh(); }""")
        self.assertTrue(pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"A2\"]').classList.contains('keyed')"))
        self.assertEqual(pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"A2\"] [data-field=gain]').value"), "-8")
        pg.evaluate(SET, ["A2", "gain", -20])
        self.assertEqual(pg.evaluate(CHAIN, "A2")[-1]["keys"]["gain"], [{"t": 0, "v": 0}, {"t": 4, "v": -20}, {"t": 8, "v": -16}])
        # M is the track's switch, S its solo.
        pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"A2\"] .mix-btn').click()")
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').off"))
        pg.evaluate("() => [...__panel.editMixerPanel.querySelectorAll('.mix-strip[data-track=\"A1\"] .mix-btn')][1].click()")
        self.assertEqual(pg.evaluate("() => __panel._editTlView.solo"), {"A1": True})
        self.assertTrue(pg.evaluate("() => [...__panel.editMixerPanel.querySelectorAll('.mix-strip[data-track=\"A1\"] .mix-btn')][1].classList.contains('on')"))
        # A locked track's fader does not move.
        pg.evaluate("() => { const P = __panel, next = JSON.parse(JSON.stringify(P._editTlCut)); next.lock = { ...(next.lock || {}), A1: true }; P._editTlApply(next); P.editTlRefresh(); }")
        self.assertTrue(pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"A1\"] [data-field=gain]').disabled"))
        # The master: a fader, a pan and M (no S), on the cut's master chain and switch; one undo step each.
        MCHAIN = "() => (__panel._editTlCut.afx || {}).master || []"
        n = self.undo_len(pg)
        pg.evaluate(SET, ["master", "gain", -9])
        self.assertEqual([[f["type"], f["p"]] for f in pg.evaluate(MCHAIN)], [["gain", {"gain": -9}]])
        self.assertEqual(self.undo_len(pg), n + 1)
        pg.evaluate(SET, ["master", "pan", 0.25])
        self.assertEqual([f["type"] for f in pg.evaluate(MCHAIN)], ["gain", "pan"])
        self.assertEqual(pg.evaluate("() => [...__panel.editMixerPanel.querySelectorAll('.mix-strip[data-track=\"master\"] .mix-btn')].map(b => b.textContent)"), ["M"])
        # Through to the speakers: an element with no effects of its own is routed to the master, whose chain is wired.
        got = pg.evaluate("""() => { const P = __panel, a = document.createElement('audio');
            const keep = P._editMixOn; P._editMixOn = () => false;
            const play = P._editPlayCut; P._editPlayCut = () => P._editTlCut;
            P._editAfxEnsure(a, null, '', 0);
            const m = window.__imageViewerAfxCtx.__master;
            const out = [!!a._epAfx, JSON.parse(m.sig).map(f => f.type), m.out.gain.value];
            P._editMixOn = keep; P._editPlayCut = play; return out; }""")
        self.assertEqual(got, [True, ["gain", "pan"], 1])
        pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"master\"] .mix-btn').click()")
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.off.master"))
        self.assertTrue(pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"master\"] .mix-btn').classList.contains('on')"))
        self.assertEqual(pg.evaluate("() => { const P = __panel, play = P._editPlayCut; P._editPlayCut = () => P._editTlCut; P._editAfxMasterSync(); P._editPlayCut = play; return window.__imageViewerAfxCtx.__master.out.gain.value; }"), 0)
        self.assertTrue(pg.evaluate("async () => (await import('/extensions/viewer/imageViewer_editTimelineData.js')).toSave(__panel._editTlCut).off.master"))
        pg.evaluate("() => __panel.editMixerPanel.querySelector('.mix-strip[data-track=\"master\"] .mix-btn').click()")
        # Meters: while the Mixer is up an element on a track goes through its bus, and the meters read its analyser.
        got = pg.evaluate("""async () => { const P = __panel, a = document.createElement('audio');
            P._editAfxEnsure(a, null, 'A2', 0);
            const ctx = window.__imageViewerAfxCtx, bus = ctx && ctx.__buses.A2;
            const meter = bus && bus.meter; if (!meter) return null;
            meter.getFloatTimeDomainData = (b) => { b.fill(0); b[3] = 0.5; };
            ctx.__master.meter.getFloatTimeDomainData = (b) => { b.fill(0); b[0] = 1.2; };
            P.isPlaying = true; P._editMixDraw(false); P.isPlaying = false;
            const box = (id) => P.editMixerPanel.querySelector(`.mix-meter[data-meter="${id}"]`);
            return [!!a._epAfx, box('A2').dataset.db, box('master').classList.contains('over'), box('A1').dataset.db]; }""")
        self.assertEqual(got, [True, "-6.0", True, "-60.0"])
        # Only on a cut's tab: the Mixer is one of the Edit panels.
        self.assertIn("editMixer", pg.evaluate("async () => (await import('/extensions/viewer/imageViewer_editTimeline.js')).EDIT_PANELS"))
        self.assertEqual(pg.evaluate(title), "Mixer", "still there after the faders and switches redrew the strips")
        self.assertEqual(self.errors, [])

    # ── match frame ──

    def test_match_frame_opens_the_source_in_the_viewer_tab_on_its_frame(self):
        # V1: a 0-96 (a film, in 0), c 96-168 (a still), b 168-264 (in 1).
        pg = self.page()
        self.fit(pg)
        pg.evaluate("""() => { const P = __panel; window.__opened = []; window.__sought = [];
            P._browserFramesFor = async (paths) => { window.__opened.push(...paths); return paths.map(p => [{ filename: p.split('/').pop(), kind: 'video', path: p, type: 'output' }]); };
            P._editTlMatchSeek = async (src) => { window.__sought.push(src); }; P.setFrame(200); }""")
        self.focus_timeline(pg)
        pg.evaluate("() => { __panel._editTlSel = null; __panel.setFrame(200); }")
        pg.keyboard.press("f")
        pg.wait_for_function("() => window.__sought.length === 1", timeout=5000)
        got = pg.evaluate("() => [window.__opened, window.__sought, __panel.activeTab, __panel.allTabs[__panel.activeTab][0].matchSrc]")
        # frame 200 of the film is 32.5 frames into b (in 1 s): 1 + 32.5 / 24 seconds of its file.
        self.assertEqual(got[0], ["D:/out/b.mp4"])
        self.assertAlmostEqual(got[1][0], 1 + 32.5 / 24, places=4)
        self.assertEqual(got[2], "folder_history")
        self.assertAlmostEqual(got[3], 1 + 32.5 / 24, places=4)
        # From the clip menu, on the shot under the playhead; a still opens without a seek.
        pg.evaluate("() => { const P = __panel; P.switchTab(Object.keys(P.allTabs).find(k => k.startsWith('edit:'))); P.setFrame(120); }")
        items = self.menu_has(pg, *self.x_at(pg, 5.0))
        self.assertIn("Match frame (F)", items)
        pg.locator(".previz-menu-item", has_text="Match frame").first.click()
        pg.wait_for_function("() => window.__opened.length === 2", timeout=5000)
        pg.wait_for_timeout(100)
        self.assertEqual(pg.evaluate("() => [window.__opened[1], window.__sought.length]"), ["D:/out/c.png", 1])
        self.assertEqual(self.errors, [])

    # ── the source viewer ──

    V1S = "() => { const c = __panel._editTlCut; return c.clips.map((x, i) => [x.name, Math.round(x.in * 24), Math.round(x.length * 24)]); }"

    def test_the_source_viewer_three_point_edits_and_match_frame_both_ways(self):
        # V1: a 0-96 (a film, in 0), c 96-168 (a still), b 168-264 (in 1).
        pg = self.page()
        pg.evaluate("() => { const P = __panel; try { localStorage.removeItem('imageviewer.viewer.editSource'); } catch (_) {} P._editSrc = undefined; P.editSrcViewerMode('dual'); P.editSrcToggle(true); P.editTlRefresh(); }")
        pg.wait_for_function("() => !!__panel.editSourcePanel.querySelector('.src-body.empty')", timeout=5000)
        # Loaded at 2 s of b, marked 1 s .. 2 s (its out frame counted in).
        pg.evaluate("async () => { const P = __panel; await P.editSrcLoad({ path: 'D:/out/b.mp4', name: 'src' }, 2); }")
        self.assertEqual(pg.evaluate("() => __panel.editSourcePanel.querySelector('.src-body').dataset.head"), "48")
        pg.evaluate("() => { const P = __panel; P.editSrcSeek(1); P.editSrcMark('in'); P.editSrcSeek(2 - 1 / 24); P.editSrcMark('out'); }")
        self.assertEqual(pg.evaluate("() => [__panel._editSrc.in, __panel._editSrc.out]"), [1, 2])
        self.assertIn("(24 fr)", pg.evaluate("() => __panel.editSourcePanel.querySelector('.src-tc').textContent"))
        # F10 on the timeline at 2 s: overwrite, one step, the playhead after it.
        n = self.undo_len(pg)
        self.focus_timeline(pg)
        pg.evaluate("() => { __panel._editTlSel = null; __panel.setFrame(48); }")
        pg.keyboard.press("F10")
        self.assertEqual(pg.evaluate(self.V1S), [["a", 0, 48], ["src", 24, 24], ["a", 72, 24], ["c", 0, 72], ["b", 24, 96]])
        self.assertEqual(self.undo_len(pg), n + 1)
        self.assertEqual(pg.evaluate("() => __panel.currentFrame"), 72)
        # Insert from the button: at the playhead (72), what follows moves on.
        pg.evaluate("() => __panel._editTlUi.srcEdits.querySelector('[data-edit=insert]').click()")
        self.assertEqual(pg.evaluate(self.V1S)[:4], [["a", 0, 48], ["src", 24, 24], ["src", 24, 24], ["a", 72, 24]])
        pg.evaluate("() => __panel.editTlUndo()")
        # A timeline range and one source point: the range's length (three points). Ripple overwrite: the shot replaced.
        pg.evaluate("() => { const P = __panel; P.editSrcMark(null); P.editSrcSeek(3); P.editSrcMark('in'); P.setFrame(200); }")
        pg.evaluate("() => __panel.editSrcEdit('ripple')")
        self.assertEqual(pg.evaluate(self.V1S)[-1], ["src", 72, 48], "no range: from the in to the source's end (5 s)")
        pg.evaluate("() => __panel.editTlUndo()")
        # Fit to fill: the source's 1 s .. 3 s retimed into a 1 s range.
        pg.evaluate("() => { const P = __panel; P.editSrcSeek(1); P.editSrcMark('in'); P.editSrcSeek(3 - 1 / 24); P.editSrcMark('out'); P._editTlSetRange({ start: 0, end: 23 }); }")
        self.assertTrue(pg.evaluate("() => __panel.editSrcEdit('fit')"))
        self.assertEqual(pg.evaluate("() => { const c = __panel._editTlCut.clips[0]; return [c.name, c.length, c.speed]; }"), ["src", 1, 2])
        pg.evaluate("() => { __panel.editTlUndo(); __panel._editTlSetRange(null); }")
        # Place on top: on V2 (free there).
        pg.evaluate("() => { __panel.setFrame(24); __panel.editSrcEdit('place'); }")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'V2').clips.map(c => [c.name, Math.round(c.at * 24), Math.round(c.length * 24)])"), [["src", 24, 48]])
        pg.evaluate("() => __panel.editTlUndo()")
        # Track patching in the headers, as Resolve's: the source's V1 box stands on V1; a click on V2's moves it there.
        self.assertEqual(pg.evaluate("() => [...__panel._editTlUi.heads.querySelectorAll('.edit-hpatch.on')].map(b => [b.dataset.patch, b.textContent])"),
                         [["V1", "V1"], ["A2", "A1"]])
        pg.evaluate("() => __panel._editTlUi.heads.querySelector('.edit-hpatch[data-patch=V2]').click()")
        self.assertEqual(pg.evaluate("() => [...__panel._editTlUi.heads.querySelectorAll('.edit-hpatch.on')].map(b => b.dataset.patch)"), ["V2", "A2"])
        pg.evaluate("() => { __panel.setFrame(24); __panel._editTlUi.srcEdits.querySelector('[data-edit=overwrite]').click(); }")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'V2').clips.map(c => [c.name, Math.round(c.at * 24)])"), [["src", 24]])
        pg.evaluate("() => { __panel.editTlUndo(); __panel.editSrcPatchTo('V1'); }")
        self.assertFalse(pg.evaluate("() => !!__panel.editSourcePanel.querySelector('.src-dest')"), "no destination menu any more")
        # The Source viewer stands left of the picture (dual); single: one viewer, Q switches source / timeline.
        box = pg.evaluate("""() => { const s = __panel.editSourcePanel.getBoundingClientRect(), v = __panel.viewport.getBoundingClientRect();
            return [Math.round(s.right) <= Math.round(v.left) + 2, s.width > 50, v.width > 50]; }""")
        self.assertEqual(box, [True, True, True])
        pg.evaluate("() => __panel.editSrcViewerMode('single')")
        self.assertEqual(pg.evaluate("() => [__panel.editSourcePanel.style.display, __panel.viewport.style.display]"), ["flex", "none"])
        self.focus_timeline(pg)
        pg.keyboard.press("q")
        self.assertEqual(pg.evaluate("() => [__panel.editSourcePanel.style.display, __panel.viewport.style.display]"), ["none", ""])
        pg.keyboard.press("q")
        self.assertEqual(pg.evaluate("() => __panel.viewport.style.display"), "none")
        pg.evaluate("() => __panel.editSrcViewerMode('dual')")
        self.assertEqual(pg.evaluate("() => [__panel.editSourcePanel.style.display, __panel.viewport.style.display]"), ["flex", ""])
        # Reverse match frame (Shift+F): the source's frame at 1.5 s is first shown by the clip F10 laid at 2 s (in 1): frame 48 + 12.
        pg.evaluate("() => { const P = __panel; P.editSrcSeek(1.5); P.setFrame(0); }")
        self.focus_timeline(pg)
        pg.keyboard.press("Shift+F")
        self.assertEqual(pg.evaluate("() => [__panel.currentFrame, __panel._editTlSel]"), [60, {"kind": "clip", "i": 1}])
        # Match frame (F) with the Source viewer up loads it there, on the frame.
        pg.evaluate("() => { __panel._editTlSel = null; __panel.setFrame(30); }")
        pg.keyboard.press("f")
        pg.wait_for_function("() => __panel._editSrc && __panel._editSrc.file === 'D:/out/a.mp4'", timeout=5000)
        self.assertEqual(pg.evaluate("() => [Math.round(__panel._editSrc.head * 24), __panel._editSrc.in, __panel.activeTab.startsWith('edit:')]"), [30, None, True])
        # A drop of a History thumbnail loads it.
        pg.evaluate("""() => { const body = __panel.editSourcePanel.querySelector('.src-body'), dt = new DataTransfer();
            dt.setData('application/x-imageviewer-history', JSON.stringify({ items: [{ path: 'D:/out/c.png', name: 'c' }] }));
            body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }""")
        pg.wait_for_function("() => __panel._editSrc && __panel._editSrc.file === 'D:/out/c.png'", timeout=5000)
        self.assertTrue(pg.evaluate("() => !!__panel.editSourcePanel.querySelector('img.src-media')"))
        self.assertEqual(self.errors, [])

    # ── compound clips ──

    def test_compound_clip_made_from_the_menu_plays_flat_saves_flat_and_comes_apart(self):
        # V1: a 0-96 (a film, in 0), c 96-168 (a still), b 168-264 (in 1).
        pg = self.page()
        self.fit(pg)
        pg.evaluate("() => { const P = __panel; P._editTlSel = { kind: 'clip', i: 2 }; P._editTlSetSelList([{ kind: 'clip', i: 1 }, { kind: 'clip', i: 2 }], { kind: 'clip', i: 2 }); P.editTlRefresh(); }")
        n = self.undo_len(pg)
        items = self.menu_has(pg, *self.x_at(pg, 9.0))
        self.assertIn("New compound clip of 2 clips", items)
        pg.locator(".previz-menu-item", has_text="New compound clip").first.click()
        pg.wait_for_function("() => __panel._editTlCut.clips.length === 2", timeout=5000)
        self.assertEqual(self.undo_len(pg), n + 1, "one undo step")
        got = pg.evaluate("""async () => { const D = await import('/extensions/viewer/imageViewer_editTimelineData.js'); const P = __panel;
            const cut = P._editTlCut, c = cut.clips[1];
            P._editPlayOn = true;
            const flat = P._editPlayCut();
            const pic = (t) => { const p = D.pictureAt(flat, t, P._editTlLive()); return p && p.clip ? p.clip.file : null; };
            const row = P._editTlUi.rows.querySelector('.edit-shot.compound');
            const saved = D.toSave(cut);
            return { compound: D.isCompound(c), len: Math.round(c.length * 24), shown: !!row,
                     badge: row ? row.querySelector('.edit-badge-compound').textContent : '',
                     played: flat ? flat.clips.map((x) => x.file) : null, at: [pic(5), pic(8.5)],
                     saved: [saved.clips.length, Object.keys(saved.compounds)] }; }""")
        self.assertTrue(got["compound"])
        self.assertEqual(got["len"], 168)
        self.assertTrue(got["shown"])
        self.assertIn("2", got["badge"])
        self.assertEqual(got["played"], ["D:/out/a.mp4", "D:/out/c.png", "D:/out/b.mp4"])
        self.assertEqual(got["at"], ["D:/out/c.png", "D:/out/b.mp4"])
        self.assertEqual(got["saved"], [3, ["C1"]])
        # The file read back (flat) is folded back into the compound.
        back = pg.evaluate("""async () => { const D = await import('/extensions/viewer/imageViewer_editTimelineData.js'); const P = __panel;
            P._editTlLoaded({ edit: JSON.parse(JSON.stringify(D.flattenCut(P._editTlCut))), file: 'x.otio' });
            return [P._editTlCut.clips.length, D.isCompound(P._editTlCut.clips[1]), P._editTlDirty()]; }""")
        self.assertEqual(back, [2, True, False])
        # Decompose in place: the two shots again, where they were.
        pg.evaluate("() => __panel.editTlRefresh()")
        items = self.menu_has(pg, *self.x_at(pg, 9.0))
        self.assertIn("Decompose in place", items)
        pg.locator(".previz-menu-item", has_text="Decompose in place").first.click()
        pg.wait_for_function("() => __panel._editTlCut.clips.length === 3", timeout=5000)
        self.assertEqual(pg.evaluate(self.V1S), [["a", 0, 96], ["c", 0, 72], ["b", 24, 96]])
        self.assertEqual(self.errors, [])

    def test_the_bar_is_one_row_with_the_rarer_buttons_in_menus(self):
        pg = self.page()
        pg.set_viewport_size({"width": 1600, "height": 900})
        pg.evaluate("() => { const P = __panel; P.editSrcToggle(true); if (!P.isPanelDocked('editMixer')) P.editTlPanelToggle('editMixer'); P.editTlRefresh(); }")
        ui = "() => { const bar = __panel._editTlUi.body.querySelector('.edit-bar'); return [bar.getBoundingClientRect().height, bar.scrollWidth <= bar.clientWidth + 1]; }"
        h, fits = pg.evaluate(ui)
        self.assertLess(h, 40, "one row")
        self.assertTrue(fits)
        self.assertEqual(pg.evaluate("() => [...__panel._editTlUi.srcEdits.querySelectorAll('.edit-srcedit')].map((b) => b.dataset.edit)"),
                         ["insert", "overwrite", "replace"])
        menu = "() => [...__panel.shadowRoot.querySelectorAll('.previz-menu-item')].map((b) => b.textContent.trim())"
        pg.evaluate("() => __panel._editTlUi.tools.click()")
        items = pg.evaluate(menu)
        for want in ("Split at the playhead (Ctrl+B, S)", "Auto edit\u2026", "Detect cuts", "Undo (Ctrl+Z)", "Redo (Ctrl+Shift+Z)"):
            self.assertIn(want, items)
        # The cut tools work from there: Split cuts the shot under the playhead, one undo step.
        n = len(pg.evaluate("() => __panel._editTlCut.clips"))
        pg.evaluate("() => __panel.setFrame(30)")
        pg.evaluate("() => __panel._editTlUi.tools.click()")
        pg.locator(".previz-menu-item", has_text="Split at the playhead").first.click()
        self.assertEqual(len(pg.evaluate("() => __panel._editTlCut.clips")), n + 1)
        pg.evaluate("() => __panel._editTlUi.body.querySelector('.edit-src-more').click()")
        items = pg.evaluate(menu)
        for want in ("Place on top (F12)", "Ripple overwrite (Shift+F10)", "Fit to fill (Shift+F11)", "Append at end (Shift+F12)"):
            self.assertIn(want, items)
        # One toggle in the menu: "Dual viewer", ticked while on; no separate "Single viewer" item.
        self.assertNotIn("Single viewer", " ".join(items))
        self.assertIn("\u2713 Dual viewer", items)
        pg.locator(".previz-menu-item", has_text="Dual viewer").first.click()
        self.assertEqual(pg.evaluate("() => __panel._editSrcViewer().mode"), "single")
        pg.evaluate("() => __panel.editSrcViewerMode('dual')")
        # Snapping to beats and audio scrubbing are ticks in the menus of their buttons.
        pg.evaluate("() => __panel._editTlUi.body.querySelector('.edit-snap-more').click()")
        pg.locator(".previz-menu-item", has_text="Snap to the beats").first.click()
        self.assertTrue(pg.evaluate("() => !!__panel._editTlView.snapBeats"))
        scrub = pg.evaluate("() => __panel._editAudio().scrub")
        pg.evaluate("() => __panel._editTlUi.body.querySelector('.edit-audio-more').click()")
        pg.locator(".previz-menu-item", has_text="Audio scrubbing").first.click()
        self.assertEqual(pg.evaluate("() => __panel._editAudio().scrub"), not scrub)
        pg.evaluate("() => localStorage.removeItem('imageviewer.viewer.editAudio')")
        self.assertEqual(self.errors, [])

    def test_history_clicks_and_drops_from_history_browser_and_canvas_load_the_source_viewer(self):
        pg = self.page()
        pg.evaluate("() => { const P = __panel; try { localStorage.removeItem('imageviewer.viewer.editSource'); } catch (_) {} P._editSrc = undefined; P.editSrcViewerMode('dual'); P.editSrcToggle(false); P.editTlRefresh(); }")
        src = "() => __panel._editSrc ? __panel._editSrc.file : null"
        tab = pg.evaluate("() => __panel.activeTab")
        # A plain click on a History thumbnail on the cut's tab: into the Source viewer (opened for it), the cut stays up.
        pg.evaluate("""() => { const P = __panel;
            P.pushHistorySnapshot('viewer', [{ filename: 'hist.png', type: 'output', subfolder: '', kind: 'image' }]);
            P._historyPanelSig = null; P.renderHistoryPanel();
            const t = P.historyStrip.querySelector('[data-idx="0"]'); t.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); }""")
        pg.wait_for_function("() => __panel._editSrc && __panel._editSrc.file === 'D:/out/hist.png'", timeout=5000)
        self.assertEqual(pg.evaluate("() => [__panel.activeTab, __panel._editSrcUp()]"), [tab, True])
        # Ctrl+click only adds to the selection.
        pg.evaluate("""() => { const P = __panel; P._editSrc = null;
            P.historyStrip.querySelector('[data-idx="0"]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, ctrlKey: true })); }""")
        pg.wait_for_timeout(200)
        self.assertIsNone(pg.evaluate(src))
        # A file browser row dropped on it (the same payload as a History thumbnail).
        drop = """([items]) => { const b = __panel.editSourcePanel.querySelector('.src-body'); const dt = new DataTransfer();
            dt.setData('application/x-imageviewer-history', JSON.stringify({ items }));
            b.dispatchEvent(new DragEvent('drop', { bubbles: true, composed: true, cancelable: true, dataTransfer: dt })); }"""
        pg.evaluate(drop, [[{"path": "D:/pics/browser.jpg", "filename": "browser.jpg", "kind": "image", "external": True}]])
        pg.wait_for_function("() => __panel._editSrc && __panel._editSrc.file === 'D:/pics/browser.jpg'", timeout=5000)
        # A node dragged off the canvas and let go over it: its media, the node put back, the cut untouched.
        before = pg.evaluate("() => JSON.stringify(__panel._editTlCut)")
        pg.evaluate("""async () => { const { app } = await import('/scripts/app.js');
            const cv = document.createElement('canvas'); Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', width: '10px', height: '10px' });
            document.body.append(cv); app.canvas.canvas = cv;
            const node = { id: 7, type: 'LoadImage', title: 'Load Image', pos: [10, 10], widgets: [{ name: 'image', value: 'house.png', type: 'combo' }], inputs: [], outputs: [] };
            window.__node = node; app.canvas.node_over = node; app.canvas.selected_nodes = {};
            __panel._editTlCanvasBound = false; __panel._editTlWatchCanvas(); }""")
        x, y = pg.evaluate("() => { const r = __panel.editSourcePanel.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        pg.evaluate("""([x, y]) => { const cv = document.querySelector('body > canvas');
            cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 3, clientY: 3 }));
            __node.pos = [300, 300];
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y })); }""", [x, y])
        pg.wait_for_function("() => __panel._editSrc && __panel._editSrc.file === 'D:/in/house.png'", timeout=5000)
        self.assertEqual(pg.evaluate("() => __node.pos"), [10, 10])
        self.assertEqual(pg.evaluate("() => JSON.stringify(__panel._editTlCut)"), before)
        self.assertEqual(self.errors, [])

    def test_the_viewer_switch_stays_at_the_right_in_every_layout_and_no_frame_on_the_timeline_viewer(self):
        pg = self.page()
        pg.evaluate("() => { const P = __panel; P.editSrcViewerMode('dual'); P.editSrcToggle(true); P.editTlRefresh(); }")
        where = """() => { const P = __panel, c = P._editSrcCtl, vp = P.viewport, home = c && c.parentNode;
            const r = c.getBoundingClientRect(), v = (home === vp ? vp : P.editSourcePanel).getBoundingClientRect();
            return [home === vp ? 'timeline' : home && home.classList.contains('src-head') ? 'source' : null,
                    Math.round(v.right - r.right) <= 40, [...c.children].filter(b => getComputedStyle(b).display !== 'none').map(b => b.classList[2])]; }"""
        # Dual: on the timeline viewer, the right one, at its top right.
        self.assertEqual(pg.evaluate(where), ["timeline", True, ["src-mode"]])
        # The layout switch is ONE toggle: the same button, lit (pressed) while dual, unlit while single.
        lit = "() => { const b = __panel._editSrcCtl.querySelector('.src-mode'); return [b.classList.contains('on'), b.getAttribute('aria-pressed'), b.dataset.icon]; }"
        self.assertEqual(pg.evaluate(lit), [True, "true", "dualViewer"])
        # Single showing the source: the timeline viewer is gone, so it is in the source's head, at its right (beside its close button).
        pg.evaluate("() => __panel._editSrcCtl.querySelector('.src-mode').click()")
        self.assertEqual(pg.evaluate("() => [__panel._editSrcViewer().mode, __panel._editSrcViewer().show]"), ["single", "source"])
        self.assertEqual(pg.evaluate(where), ["source", True, ["src-mode"]])
        self.assertEqual(pg.evaluate(lit), [False, "false", "dualViewer"])
        # No "Show the timeline in this viewer" button any more: Q swaps.
        self.assertIsNone(pg.evaluate("() => __panel._editSrcCtl.querySelector('.src-swap')"))
        pg.evaluate("() => __panel.editSrcSwap()")
        self.assertEqual(pg.evaluate("() => __panel._editSrcViewer().show"), "timeline")
        self.assertEqual(pg.evaluate(where), ["timeline", True, ["src-mode"]])
        pg.evaluate("() => __panel._editSrcCtl.querySelector('.src-mode').click()")
        self.assertEqual(pg.evaluate("() => __panel._editSrcViewer().mode"), "dual")
        # Off the cut's tab, or with the Source viewer put away, it is gone.
        pg.evaluate("() => __panel.editSrcToggle(false)")
        self.assertIsNone(pg.evaluate("() => __panel._editSrcCtl.parentNode"))
        # The empty picture layer draws nothing (Chrome framed it in light grey round the timeline viewer).
        self.assertEqual(pg.evaluate("() => { const i = __panel.imgBase; i.removeAttribute('src'); return getComputedStyle(i).visibility; }"), "hidden")
        self.assertEqual(self.errors, [])

    def test_both_monitors_have_a_bar_the_active_one_takes_the_keys_and_the_source_pans_and_zooms(self):
        pg = self.page()
        pg.evaluate("""async () => { const P = __panel; P.editSrcViewerMode('dual'); P.editSrcToggle(true);
            await P.editSrcLoad({ path: P._editTlCut.clips[0].file, name: 'a' }, 0); P.editTlRefresh(); }""")
        pg.wait_for_timeout(300)
        # The layout switch is larger than the head's small buttons.
        self.assertGreaterEqual(pg.evaluate("() => __panel._editSrcCtl.querySelector('.src-mode').getBoundingClientRect().width"), 30)
        # The timeline viewer has its own bar, on the same playhead as the Edit timeline.
        bar = "() => { const b = __panel._editMonBar; return b && b.isConnected && b.parentNode === __panel.viewport ? b.dataset.head : null; }"
        pg.evaluate("() => __panel.setFrame(30)")
        self.assertEqual(pg.evaluate(bar), "30")
        # Scrubbing it moves the one playhead.
        pg.evaluate("""() => { const s = __panel._editMonBar.querySelector('.tlm-scrub'), r = s.getBoundingClientRect();
            s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + 4 }));
            __panel.viewport.ownerDocument.defaultView.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }""")
        frames = pg.evaluate("() => { const P = __panel; return P._editTlCut ? Math.max(1, P.currentFrame) : 0; }")
        self.assertEqual(pg.evaluate(bar), str(frames))
        self.assertGreater(frames, 30)
        # Active monitor: a click on one makes it the active one, outlined in white.
        act = """() => { const P = __panel; return [P.editMonActive(), P.editSourcePanel.classList.contains('mon-active'),
            P.viewport.classList.contains('mon-active'),
            getComputedStyle(P.editSourcePanel.querySelector('.src-view'), '::after').borderTopColor]; }"""
        pg.evaluate("() => __panel.editSourcePanel.querySelector('.src-view').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))")
        self.assertEqual(pg.evaluate(act), ["source", True, False, "rgb(255, 255, 255)"])
        # ... and the playback keys go to it while the viewer is hovered, not to the timeline.
        f0 = pg.evaluate("() => __panel.currentFrame")
        pg.evaluate("""() => { const P = __panel; P.isHovered = true; document.body.focus();
            const k = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            k('ArrowRight'); k('ArrowRight'); }""")
        self.assertEqual(pg.evaluate("() => [__panel.currentFrame, __panel._editSrcState().head * __panel._editSrcFps()]"), [f0, 2])
        # A click on the timeline viewer: it is the active one, the keys are the cut's again (J K L, I O too).
        pg.evaluate("() => __panel.viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))")
        self.assertEqual(pg.evaluate(act)[:3], ["timeline", False, True])
        pg.evaluate("""() => { const k = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            k('ArrowRight'); k('i'); }""")
        self.assertEqual(pg.evaluate("() => [__panel.currentFrame, __panel.playbackRange && __panel.playbackRange.start]"), [f0 + 1, f0 + 1])
        self.assertEqual(pg.evaluate("() => __panel._editSrcState().head * __panel._editSrcFps()"), 2)
        # The source pans and zooms as the timeline viewer does: the wheel at the pointer, a drag, F fits.
        z = """() => { const m = __panel._editSrcEl; return [__panel._editSrcZoomState().zoom, m.style.transform]; }"""
        pg.evaluate("""() => { const v = __panel.editSourcePanel.querySelector('.src-view'), r = v.getBoundingClientRect();
            for (let i = 0; i < 5; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.left + 20, clientY: r.top + 20, bubbles: true, cancelable: true })); }""")
        zoom, tr = pg.evaluate(z)
        self.assertAlmostEqual(zoom, 1.5, places=5)
        self.assertIn("scale(1.5)", tr)
        pg.evaluate("""() => { const v = __panel.editSourcePanel.querySelector('.src-view'), w = v.ownerDocument.defaultView;
            v.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
            w.dispatchEvent(new MouseEvent('mousemove', { clientX: 130, clientY: 90, bubbles: true }));
            w.dispatchEvent(new MouseEvent('mouseup', { clientX: 130, clientY: 90, bubbles: true })); }""")
        x0 = pg.evaluate("() => [__panel._editSrcZoomState().x, __panel._editSrcZoomState().y]")
        pg.evaluate("() => __panel.editSourcePanel.querySelector('.src-view').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))")
        pg.evaluate("() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))")
        self.assertEqual(pg.evaluate(z), [1, ""])
        self.assertEqual(pg.evaluate("() => __panel.zoom"), 1)          # the timeline viewer's own zoom is left alone
        self.assertNotEqual(x0, [0, 0])
        # Single: one monitor, no outline; the bar stays with the timeline viewer while it shows.
        pg.evaluate("() => __panel.editSrcViewerMode('single')")
        self.assertEqual(pg.evaluate(act)[:3], ["source", False, False])
        self.assertIsNone(pg.evaluate(bar))
        pg.evaluate("() => __panel.editSrcSwap()")
        self.assertEqual(pg.evaluate(act)[:3], ["timeline", False, False])
        self.assertIsNotNone(pg.evaluate(bar))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
