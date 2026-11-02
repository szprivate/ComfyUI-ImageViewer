"""Audio crossfades, fade handles and the tracks' Lock / Auto Track Selector in the Edit panel, in a real browser.

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest discover -s tests -p "test_edit_audio_xfade_browser.py"
It serves tests/harness/edit.html (the real viewer js, ComfyUI stubbed), as test_edit_timeline_browser does.
"""
import unittest

import test_edit_timeline_browser as base

WHERE = base.WHERE

# Two touching clips of the music on A2 (0..3 s and 3..6 s), with media either side of the cut.
A2_CUT = """() => { const P = __panel, cut = P._editTlCut;
  P._editTlApply({ ...cut, tracks: cut.tracks.map(k => k.id !== 'A2' ? k : { ...k, clips: [
    { file: 'D:/out/music.wav', name: 'm1', in: 2, length: 3, at: 0, volume: 1 },
    { file: 'D:/out/music.wav', name: 'm2', in: 9, length: 3, at: 3, volume: 1 }] }) });
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  P._editTlView.heights = { V2: 14, V1: 30, A1: 14, A2: 30 }; P.editTlRefresh();
  P._editTlUi.rows.querySelector('[data-track="A2"]').scrollIntoView({ block: 'center' }); }"""
XF = "() => { const k = __panel._editTlCut.tracks.find(t => t.id === 'A2'); return k.clips[1].xfade || null; }"
BAR = """() => { const b = __panel._editTlUi.rows.querySelector('[data-key="xf:A2:1"]'); if (!b) return null;
  const r = b.getBoundingClientRect(); return [r.left, r.right, r.top + r.height / 2]; }"""
FIELD = "(f) => { const e = __panel.editInspectorPanel.querySelector(`[data-field=\"${f}\"]`); return e ? e.value : null; }"


class _Base(base.EditTimelineBrowserTests):
    pass


# Only the class set-up of the timeline tests, none of their tests.
for _name in [n for n in dir(base.EditTimelineBrowserTests) if n.startswith("test")]:
    setattr(_Base, _name, None)


class EditAudioXfadeBrowserTests(_Base):

    def xpage(self):
        pg = self.page()
        pg.evaluate(A2_CUT)
        self.settle(pg)
        return pg

    def test_a_crossfade_at_a_sound_cut_drag_inspector_undo_delete_save_reopen(self):
        pg = self.xpage()
        pg.evaluate("() => __panel.setFrame(72)")                   # the playhead on the cut at 3 s
        self.focus_timeline(pg)
        pg.evaluate("() => { __panel._editTlSel = null; __panel.setFrame(72); }")
        pg.keyboard.press("Shift+T")
        self.assertEqual(pg.evaluate(XF), {"len": 1, "curve": "+3", "align": "centre"})
        self.assertEqual(pg.evaluate("() => __panel._editTlSel"), {"kind": "xfade", "track": "A2", "i": 1})
        bar = pg.evaluate(BAR)
        self.assertIsNotNone(bar, "its bar is drawn over the cut")
        # Nothing moved: the clips are where they were.
        self.assertEqual(self.cut(pg)["tracks"]["A2"], [["D:/out/music.wav", 0, 3], ["D:/out/music.wav", 3, 3]])
        # The Inspector has it.
        self.assertEqual(float(pg.evaluate(FIELD, "xfadeLen")), 1.0)
        self.assertEqual(pg.evaluate(FIELD, "xfadeCurve"), "+3")
        # Its right edge dragged half a second on: a centred crossfade grows on both sides - 2 s.
        x1, _ = pg.evaluate(WHERE, [3.5, "A2"])
        x2, _ = pg.evaluate(WHERE, [4.0, "A2"])
        pg.mouse.move(bar[1] - 2, bar[2])
        pg.mouse.down()
        pg.mouse.move(bar[1] - 2 + (x2 - x1) / 2, bar[2], steps=4)
        pg.mouse.move(bar[1] - 2 + (x2 - x1), bar[2], steps=4)
        pg.mouse.up()
        self.assertAlmostEqual(pg.evaluate(XF)["len"], 2.0, delta=0.05)
        # The curve from the Inspector, one step each; undo takes the steps back.
        pg.evaluate("() => { const s = __panel.editInspectorPanel.querySelector('[data-field=\"xfadeCurve\"]'); s.value = '-3'; s.dispatchEvent(new Event('change')); }")
        self.assertEqual(pg.evaluate(XF)["curve"], "-3")
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate(XF)["curve"], "+3")
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate(XF)["len"], 1)
        # Del takes it away; undo brings it back.
        pg.evaluate("() => { __panel._editTlSel = { kind: 'xfade', track: 'A2', i: 1 }; __panel.editTlRefresh(); }")
        self.focus_timeline(pg)
        pg.evaluate("() => { __panel._editTlSel = { kind: 'xfade', track: 'A2', i: 1 }; __panel.editTlRefresh(); }")
        pg.keyboard.press("Delete")
        self.assertIsNone(pg.evaluate(XF))
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate(XF)["len"], 1)
        # Saved: the file is sent it; opened again, it is there.
        pg.evaluate("() => __panel._editTlSave()")
        pg.wait_for_function("() => (window.__saves || []).length > 0", timeout=5000)
        sent = pg.evaluate("() => window.__saves.at(-1).edit")
        a2 = [k for k in sent["tracks"] if k["id"] == "A2"][0]
        self.assertEqual(a2["clips"][1]["xfade"], {"len": 1, "curve": "+3", "align": "centre"})
        pg.evaluate("""async (edit) => { window.__otio = { 'D:/out/again.otio': { name: 'again', fps: 24, texts: [], sound: [], ...edit,
            clips: edit.clips.map((c, i) => ({ ...c, ref: i, file: c.file || ['D:/out/a.mp4', 'D:/out/c.png', 'D:/out/b.mp4'][i] })),
            tracks: edit.tracks.map(k => ({ ...k, clips: k.clips.map((c, i) => ({ ...c, ref: [2, i], file: c.file || 'D:/out/music.wav' })) })) } };
            await __panel.editTlOpenPath('D:/out/again.otio'); }""", sent)
        pg.wait_for_function("() => (__panel._editTlFile || '').includes('again') || (__panel.editTlFilePath() || '').includes('again')", timeout=5000)
        self.assertEqual(pg.evaluate(XF), {"len": 1, "curve": "+3", "align": "centre"})
        self.assertEqual(self.errors, [])

    def test_a_fade_handle_dragged_in_is_a_fade_and_undo_takes_it_back(self):
        pg = self.xpage()
        h = pg.evaluate("""() => { const b = __panel._editTlUi.rows.querySelector('[data-key="A2:0"]');
            const e = b.querySelector('.edit-fadeh.in'); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }""")
        x1, _ = pg.evaluate(WHERE, [0, "A2"])
        x2, _ = pg.evaluate(WHERE, [1, "A2"])
        pg.mouse.move(*h)
        pg.mouse.down()
        pg.mouse.move(h[0] + (x2 - x1) / 2, h[1], steps=3)
        pg.mouse.move(h[0] + (x2 - x1), h[1], steps=3)
        pg.mouse.up()
        fade = pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').clips[0].fadeIn")
        self.assertAlmostEqual(fade, 1.0, delta=0.05)
        self.assertEqual(pg.evaluate("() => __panel._editTlUi.rows.querySelector('[data-key=\"A2:0\"]').dataset.fadeIn"), str(fade))
        self.assertTrue(pg.evaluate("() => !!__panel._editTlUi.rows.querySelector('[data-key=\"A2:0\"] .edit-fadecurve')"))
        # The Inspector's Audio tab shows it.
        pg.evaluate("() => { __panel._editTlSel = { kind: 'tclip', track: 'A2', i: 0 }; __panel._editInspTab = 'audio'; __panel.editTlRefresh(); }")
        self.assertAlmostEqual(float(pg.evaluate(FIELD, "fadeIn")), fade, places=2)
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertIsNone(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').clips[0].fadeIn || null"))
        self.assertEqual(self.errors, [])

    def test_a_locked_track_ignores_a_click_a_delete_a_drag_and_the_blade(self):
        pg = self.xpage()
        lock = "() => __panel._editTlUi.heads.querySelectorAll('.edit-headrow .edit-hlock')"
        # The padlock of A2's header (the rows are V2, V1, A1, A2 from the top).
        pg.evaluate("""() => { const rows = [...__panel._editTlUi.heads.querySelectorAll('.edit-headrow')];
            const a2 = rows.find(r => r.querySelector('.edit-hname') && r.querySelector('.edit-hname').textContent === 'A2');
            a2.querySelector('.edit-hlock').click(); }""")
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').lock === true"))
        self.assertTrue(pg.evaluate("() => __panel._editTlUi.rows.querySelector('[data-track=\"A2\"]').classList.contains('locked')"))
        before = self.cut(pg)
        # A click selects nothing there.
        pg.evaluate("() => { __panel._editTlSel = null; __panel.editTlRefresh(); }")
        x, y = pg.evaluate(WHERE, [1.5, "A2"])
        pg.mouse.click(x, y)
        self.assertIsNone(pg.evaluate("() => __panel._editTlSel"))
        # A drag moves nothing.
        pg.mouse.move(x, y)
        pg.mouse.down()
        pg.mouse.move(x + 80, y, steps=5)
        pg.mouse.up()
        self.assertEqual(self.cut(pg), before)
        # Delete of a selection made before it was locked: left alone.
        pg.evaluate("() => { __panel._editTlSel = { kind: 'tclip', track: 'A2', i: 0 }; __panel.editTlDelete(false); }")
        self.assertEqual(self.cut(pg)["tracks"]["A2"], before["tracks"]["A2"])
        # The blade at the playhead (1.5 s): V1 is cut, A2 not.
        pg.evaluate("() => { __panel._editTlSel = null; __panel.setFrame(36); __panel.editTlSplitAtPlayhead(); }")
        after = self.cut(pg)
        self.assertEqual(after["tracks"]["A2"], before["tracks"]["A2"])
        self.assertEqual(len(after["v1"]), len(before["v1"]) + 1)
        # Dropping a clip onto it: refused (the drag is held back).
        n = len(pg.evaluate("() => __panel._editTlHistory().past"))
        pg.evaluate("() => __panel._editTlApply(__D_move(__panel._editTlCut))".replace(
            "__D_move(__panel._editTlCut)", "({ ...__panel._editTlCut, tracks: __panel._editTlCut.tracks.map(k => k.id !== 'A2' ? k : { ...k, clips: [] }) })"))
        self.assertEqual(self.cut(pg)["tracks"]["A2"], before["tracks"]["A2"])
        self.assertEqual(len(pg.evaluate("() => __panel._editTlHistory().past")), n)
        # Unlocked, and undoable: the lock is a step of its own.
        pg.evaluate(f"() => {{ const b = [...({lock})()].find(e => e.classList.contains('on')); b.click(); }}")
        self.assertFalse(pg.evaluate("() => !!__panel._editTlCut.tracks.find(t => t.id === 'A2').lock"))
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').lock === true"))
        self.assertEqual(self.errors, [])

    def test_auto_select_off_a_v1_ripple_delete_leaves_a2_in_place(self):
        pg = self.xpage()
        # On (the default): a ripple delete of V1's first shot (4 s) moves what begins after it on A2 up by 4 s - A2's
        # clips at 0 and 3 began before its end and stay, so a third one at 10 s shows it (it lands at 6).
        pg.evaluate("""() => { const P = __panel, cut = P._editTlCut;
            P._editTlApply({ ...cut, tracks: cut.tracks.map(k => k.id !== 'A2' ? k : { ...k, clips: [...k.clips,
              { file: 'D:/out/music.wav', name: 'm3', in: 0, length: 2, at: 10, volume: 1 }] }) }); }""")
        pg.evaluate("() => { __panel._editTlSel = { kind: 'clip', i: 0 }; __panel.editTlDelete(true); }")
        self.assertEqual(self.cut(pg)["tracks"]["A2"][2], ["D:/out/music.wav", 6, 2])
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(self.cut(pg)["tracks"]["A2"][2], ["D:/out/music.wav", 10, 2])
        # Off: it stays where it is.
        pg.evaluate("""() => { const rows = [...__panel._editTlUi.heads.querySelectorAll('.edit-headrow')];
            const a2 = rows.find(r => r.querySelector('.edit-hname') && r.querySelector('.edit-hname').textContent === 'A2');
            a2.querySelector('.edit-hauto').click(); }""")
        self.assertTrue(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').auto === false"))
        pg.evaluate("() => { __panel._editTlSel = { kind: 'clip', i: 0 }; __panel.editTlDelete(true); }")
        c = self.cut(pg)
        self.assertEqual(c["tracks"]["A2"][2], ["D:/out/music.wav", 10, 2])
        self.assertEqual(len(c["v1"]), 2)
        self.assertEqual(self.errors, [])

    VOLKEYS = "() => ((__panel._editTlCut.tracks.find(t => t.id === 'A2').clips[0].fx || {}).keys || {}).vol || []"

    def test_the_volume_line_drag_add_move_delete_points_are_the_inspector_keys(self):
        pg = self.xpage()
        pg.evaluate("() => { __panel._editTlView.heights.A2 = 60; __panel.editTlRefresh(); __panel._editTlUi.rows.querySelector('[data-track=\"A2\"]').scrollIntoView({ block: 'center' }); }")
        box = pg.evaluate("() => { const r = __panel._editTlUi.rows.querySelector('[data-key=\"A2:0\"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
        self.assertTrue(pg.evaluate("() => !!__panel._editTlUi.rows.querySelector('[data-key=\"A2:0\"] .edit-volline')"))
        x = box[0] + box[2] * 0.3
        y = box[1] + 1                                         # volume 1: 0 dB, the top of the clip
        # Dragged down to about -12 dB (a fifth of the height: -60 dB is the bottom).
        pg.mouse.move(x, y)
        pg.mouse.down()
        pg.mouse.move(x, y + box[3] * 0.1, steps=3)
        pg.mouse.move(x, y + box[3] * 0.2, steps=3)
        pg.mouse.up()
        vol = pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').clips[0].volume")
        self.assertAlmostEqual(vol, 10 ** (-12 / 20), delta=0.03)
        self.assertEqual(pg.evaluate(self.VOLKEYS), [])
        # Alt+click on the line at 1 s of the clip: a key there, at the line's level.
        x1 = pg.evaluate(WHERE, [1.0, "A2"])[0]
        yl = box[1] + box[3] * 0.2
        pg.keyboard.down("Alt")
        pg.mouse.click(x1, yl)
        pg.keyboard.up("Alt")
        keys = pg.evaluate(self.VOLKEYS)
        self.assertEqual(len(keys), 1)
        self.assertAlmostEqual(keys[0]["t"], 1.0, delta=1 / 24 + 1e-6)
        self.assertAlmostEqual(keys[0]["v"], vol, delta=0.02)
        # The Inspector sees the same key: its diamond is filled with the playhead on it.
        pg.evaluate("(t) => { __panel._editTlSel = { kind: 'tclip', track: 'A2', i: 0 }; __panel._editInspTab = 'audio'; __panel.setFrame(Math.round(t * 24)); __panel.editTlRefresh(); }", keys[0]["t"])
        self.assertEqual(pg.evaluate("() => [...__panel.editInspectorPanel.querySelectorAll('.insp-row')].find(r => r.dataset.keys === 'vol').querySelector('.insp-diamond').dataset.state"), "on")
        # Dragged half a second later and up to 0 dB (the point takes the press, though the playhead is on it).
        pt = pg.evaluate("() => { const r = __panel._editTlUi.rows.querySelector('[data-key=\"A2:0\"] .edit-volpt').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        x15 = pg.evaluate(WHERE, [1.5, "A2"])[0]
        pg.mouse.move(*pt)
        pg.mouse.down()
        pg.mouse.move(pt[0] + (x15 - x1) / 2, pt[1] - 10, steps=3)
        pg.mouse.move(pt[0] + (x15 - x1), box[1] - 20, steps=3)
        pg.mouse.up()
        keys = pg.evaluate(self.VOLKEYS)
        self.assertAlmostEqual(keys[0]["t"], 1.5, delta=1 / 24 + 1e-6)
        self.assertAlmostEqual(keys[0]["v"], 1.0, delta=1e-6)
        # Selected, Del takes it away; undo brings it back.
        self.focus_timeline(pg)
        pg.evaluate("(t) => { __panel._editTlVolSel = { sel: { kind: 'tclip', track: 'A2', i: 0 }, t }; }", keys[0]["t"])
        pg.keyboard.press("Delete")
        self.assertEqual(pg.evaluate(self.VOLKEYS), [])
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(len(pg.evaluate(self.VOLKEYS)), 1)
        self.assertEqual(self.errors, [])

    # ── sound effects ──

    DRAG_AFX = """async ([type, x, y]) => { const P = __panel;
      if (!P.isPanelDocked('editEffects')) P.editTlPanelToggle('editEffects');
      for (let k = 0; k < 50 && !P.editEffectsPanel.querySelector('.fx-cat'); k++) await new Promise(r => setTimeout(r, 20));
      [...P.editEffectsPanel.querySelectorAll('.fx-cat')].find(b => b.dataset.cat === 'audiofx').click();
      const item = P.editEffectsPanel.querySelector(`.fx-item[data-afx="${type}"]`);
      const dt = new DataTransfer();
      item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, composed: true, dataTransfer: dt }));
      const root = P._editTlUi.body.getRootNode(); const t = root.elementFromPoint(x, y);
      const ev = (k) => new DragEvent(k, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt });
      t.dispatchEvent(ev('dragenter')); t.dispatchEvent(ev('dragover'));
      const lit = [...P._editTlUi.body.querySelectorAll('.afx-target')].map(n => n.dataset.key || n.dataset.track || n.className);
      t.dispatchEvent(ev('drop'));
      return lit; }"""

    def test_an_effect_dragged_onto_a_clip_and_onto_a_track_badges_inspector_bypass_reorder(self):
        pg = self.xpage()
        # Onto the first clip of A2: that clip only.
        x, y = pg.evaluate(WHERE, [1.0, "A2"])
        lit = pg.evaluate(self.DRAG_AFX, ["eq", x, y])
        self.assertEqual(lit, ["A2:0"], "the clip it would go on is lit")
        afx = pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').clips.map(c => (c.afx || []).map(f => f.type))")
        self.assertEqual(afx, [["eq"], []])
        self.assertTrue(pg.evaluate("() => !!__panel._editTlUi.rows.querySelector('[data-key=\"A2:0\"] .edit-badge-afx')"))
        # The Inspector shows its params; one set there, then a compressor added from its menu.
        self.assertIsNotNone(pg.evaluate(FIELD, "afx0.pk_g"))
        pg.evaluate("() => { const i = __panel.editInspectorPanel.querySelector('[data-field=\"afx0.pk_g\"]'); i.value = '6'; i.dispatchEvent(new Event('change')); }")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').clips[0].afx[0].p.pk_g"), 6)
        pg.evaluate("() => { const s = __panel.editInspectorPanel.querySelector('[data-field=\"afxAdd\"]'); s.value = 'comp'; s.dispatchEvent(new Event('change')); }")
        chain = "() => __panel._editTlCut.tracks.find(t => t.id === 'A2').clips[0].afx.map(f => [f.type, f.on])"
        self.assertEqual(pg.evaluate(chain), [["eq", True], ["comp", True]])
        # Bypass the EQ (its section's switch), then move the compressor first; one undo each.
        pg.evaluate("() => [...__panel.editInspectorPanel.querySelectorAll('.insp-section')].find(s => s.dataset.afxIndex === '0').querySelector('.insp-switch').click()")
        self.assertEqual(pg.evaluate(chain), [["eq", False], ["comp", True]])
        pg.evaluate("() => [...[...__panel.editInspectorPanel.querySelectorAll('.insp-section')].find(s => s.dataset.afxIndex === '1').querySelectorAll('button')].find(b => b.textContent === '▲').click()")
        self.assertEqual(pg.evaluate(chain), [["comp", True], ["eq", False]])
        pg.evaluate("() => __panel.editTlUndo()")
        self.assertEqual(pg.evaluate(chain), [["eq", False], ["comp", True]])
        # Onto the track's empty lane (after its clips, at 8 s): the whole track - a badge in its header.
        x, y = pg.evaluate(WHERE, [8.0, "A2"])
        lit = pg.evaluate(self.DRAG_AFX, ["reverb", x, y])
        self.assertEqual(lit, ["A2"])
        self.assertEqual(pg.evaluate("() => (__panel._editTlCut.tracks.find(t => t.id === 'A2').afx || []).map(f => f.type)"), ["reverb"])
        badge = "() => [...__panel._editTlUi.heads.querySelectorAll('.edit-headrow')].find(r => r.dataset.track === 'A2').querySelector('.edit-afxbadge')"
        self.assertEqual(pg.evaluate(badge + ".textContent"), "REV")
        pg.evaluate(badge + ".click()")
        self.assertEqual(pg.evaluate("() => __panel._editTlSel"), {"kind": "track", "track": "A2"})
        self.assertIsNotNone(pg.evaluate(FIELD, "afx0.mix"))
        # Keyed: the mix gets a key at the playhead from its diamond.
        pg.evaluate("() => { __panel.setFrame(48); __panel.editTlRefresh(); __panel.editInspectorPanel.querySelector('[data-field=\"afx0.mix.key\"]').click(); }")
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').afx[0].keys.mix.map(k => k.t)"), [2])
        # The preview: an element playing the clip goes through a WebAudio graph - the clip's EQ and compressor, its
        # gain (the volume it had), the track's bus with the reverb; its keyed mix set from the film's time.
        got = pg.evaluate("""() => { const P = __panel, a = document.createElement('audio');
            P._editAfxEnsure(a, P._editTlCut.tracks.find(t => t.id === 'A2').clips[0], 'A2', 0); P._epVol(a, 0.5);
            P._ep = P._ep || {}; const was = P._ep.bed; P._ep.bed = [a]; P._editAfxTick(1); P._ep.bed = was;
            const ctx = window.__bepicAfxCtx; const bus = ctx && ctx.__buses.A2;
            return [!!a._epAfx, a._epAfx && Math.round(a._epAfx.gain.gain.value * 100) / 100, a.volume, !!bus, bus ? bus.keyed.length : -1]; }""")
        self.assertEqual(got, [True, 0.5, 1, True, 1])
        # Saved with the cut.
        pg.evaluate("() => __panel._editTlSave()")
        pg.wait_for_function("() => (window.__saves || []).length > 0", timeout=5000)
        sent = pg.evaluate("() => window.__saves.at(-1).edit.tracks.find(t => t.id === 'A2')")
        self.assertEqual([f["type"] for f in sent["afx"]], ["reverb"])
        self.assertEqual([f["type"] for f in sent["clips"][0]["afx"]], ["eq", "comp"])
        # A locked track takes no drop.
        pg.evaluate("() => __panel._editTlApply(__panel._editTlCut.tracks ? (() => { const c = __panel._editTlCut; return { ...c, tracks: c.tracks.map(k => k.id === 'A2' ? { ...k, lock: true } : k) }; })() : null)")
        x, y = pg.evaluate(WHERE, [8.0, "A2"])
        lit = pg.evaluate(self.DRAG_AFX, ["delay", x, y])
        self.assertEqual(lit, [])
        self.assertEqual(pg.evaluate("() => __panel._editTlCut.tracks.find(t => t.id === 'A2').afx.length"), 1)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
