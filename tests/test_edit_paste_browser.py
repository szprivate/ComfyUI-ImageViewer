"""Copy and Paste Attributes on sound clips (A2, A3, the bed A1) in the Edit panel, in a real browser.

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest discover -s tests -p "test_edit_paste_browser.py"
Real clicks and keys (Ctrl+C, Alt+V, the right-click menu) on the real viewer js, ComfyUI stubbed.
"""
import unittest

import test_edit_timeline_browser as base

# V1: a.mp4 (film with sound) 0..4, c.png still, b.mp4. A2: two clips; A3: one; the bed: two clips.
PREP = """() => { const P = __panel, cut = P._editTlCut;
  __media['D:/out/s1.wav'] = { duration: 20, audio: true };
  const snd = (name, at, extra = {}) => ({ file: 'D:/out/s1.wav', name, in: 0, length: 3, at, volume: 1, ...extra });
  P._editTlApply({ ...cut,
    clips: cut.clips.map((c, i) => i === 0 ? { ...c, volume: 0.4, afx: [{ type: 'gain', p: { gain: 6 } }] } : c),
    sound: [{ name: 'music', file: 'D:/out/music.wav', fadeIn: 1.5 }, { name: 'music2', file: 'D:/out/music.wav' }],
    afx: { A1: [{ type: 'gain', p: { gain: -3 } }] },
    tracks: [{ id: 'V2', kind: 'video', name: 'V2', off: false, clips: [] },
      { id: 'A2', kind: 'audio', name: 'A2', off: false, clips: [
        snd('dialogue', 0, { volume: 0.5, fadeOut: 0.75, afx: [{ type: 'gain', p: { gain: 4 } }] }), snd('other', 4)] },
      { id: 'A3', kind: 'audio', name: 'A3', off: false, clips: [snd('third', 1)] }] });
  P._editTlHistories[P._editTlTab] = { past: [], future: [] };
  P._editTlSel = null; P._editTlClipboard = null; P.editTlRefresh(); }"""
RECT = """(key) => { const r = __panel._editTlUi.rows; const b = r.querySelector(`[data-key="${key}"]`);
  if (!b) return null; b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect();
  return [q.left + 12, q.top + q.height / 2]; }"""
BED = """(i) => { const b = [...__panel._editTlUi.rows.querySelectorAll('.edit-snd')].filter(e => !e.dataset.key || !e.dataset.key.includes(':'))[i];
  if (!b) return null; b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect();
  return [q.left + 12, q.top + q.height / 2]; }"""
STATE = """() => { const c = __panel._editTlCut, t = (id, i) => c.tracks.find(k => k.id === id).clips[i];
  return { a2: [t('A2', 0).volume, t('A2', 0).afx || null], a2b: [t('A2', 1).volume, t('A2', 1).afx || null],
           a3: [t('A3', 0).volume, t('A3', 0).afx || null], v1: [c.clips[0].volume, c.clips[0].afx || null],
           bed: [c.sound[0].fadeIn || 0, c.sound[0].fadeOut || 0], bed2: [c.sound[1].fadeIn || 0, c.sound[1].fadeOut || 0], bedfx: c.afx.A1 || null,
           fades: [t('A2', 1).fadeIn || 0, t('A2', 1).fadeOut || 0],
           past: __panel._editTlHistories[__panel._editTlTab].past.length }; }"""
DLG = """() => { const d = __panel._editTlUi.body.querySelector('.edit-paste'); if (!d) return null;
  return Object.fromEntries([...d.querySelectorAll('input[data-attr]')].map(i => [i.dataset.attr, [!i.disabled, i.checked]])); }"""
MENU = """(l) => { const root = __panel.shadowRoot;
  const e = [...root.querySelectorAll('*')].find(n => n.children.length === 0 && (n.textContent || '').startsWith(l));
  if (!e) return null; const q = e.getBoundingClientRect(); return [q.left + 5, q.top + q.height / 2]; }"""
CLIP = "() => __panel._editTlClipboard"


class _Base(base.EditTimelineBrowserTests):
    pass


for _name in [n for n in dir(base.EditTimelineBrowserTests) if n.startswith("test")]:
    setattr(_Base, _name, None)


class EditPasteBrowserTests(_Base):
    def pg2(self):
        pg = self.page()
        pg.evaluate(PREP)
        self.settle(pg)
        return pg

    def click(self, pg, key=None, bed=None, button="left"):
        xy = pg.evaluate(BED, bed) if bed is not None else pg.evaluate(RECT, key)
        self.assertIsNotNone(xy, f"no clip {key if key else bed}")
        pg.mouse.click(xy[0], xy[1], button=button)
        if bed is not None:
            # The bed's clips all span the film, one over the other: the click took the top one, so name ours.
            pg.evaluate("(i) => { __panel._editTlSel = { kind: 'sound', i }; __panel.editTlRefresh(); }", bed)

    def copy_via_key(self, pg, **kw):
        self.click(pg, **kw)
        pg.keyboard.press("Control+c")

    def open_via_key(self, pg, **kw):
        self.click(pg, **kw)
        pg.keyboard.press("Alt+v")
        pg.wait_for_timeout(100)
        return pg.evaluate(DLG)

    def apply(self, pg, *boxes):
        for b in boxes:
            pg.set_checked(f".edit-paste input[data-attr={b}]", True)
        pg.click(".edit-paste-go")
        pg.wait_for_timeout(100)

    def test_a2_to_a2_via_alt_v(self):
        pg = self.pg2()
        self.copy_via_key(pg, key="A2:0")
        self.assertIsNotNone(pg.evaluate(CLIP), "Ctrl+C on an A2 clip copies it")
        d = self.open_via_key(pg, key="A2:1")
        self.assertIsNotNone(d, "Alt+V opens the dialog on an A2 clip")
        self.assertTrue(d["volume"][0] and d["afx"][0], d)
        self.assertFalse(d["opacity"][0] or d["zoom"][0], "video attributes are off for sound")
        self.apply(pg, "afx", "fades")
        s = pg.evaluate(STATE)
        self.assertEqual(s["a2b"][0], 0.5)
        self.assertEqual(s["a2b"][1][0]["p"]["gain"], 4)
        self.assertEqual(s["fades"], [0, 0.75], "the fades came along")
        self.assertEqual(s["past"], 1, "one undo step")
        self.assertEqual(self.errors, [])

    def test_a2_to_a3_via_context_menu(self):
        pg = self.pg2()
        self.click(pg, key="A2:0", button="right")
        m = pg.evaluate(MENU, "Copy")
        self.assertIsNotNone(m, "the sound clip's menu has Copy")
        pg.mouse.click(m[0], m[1])
        self.assertIsNotNone(pg.evaluate(CLIP))
        self.click(pg, key="A3:0", button="right")
        m = pg.evaluate(MENU, "Paste Attributes")
        self.assertIsNotNone(m, "the sound clip's menu has Paste Attributes")
        pg.mouse.click(m[0], m[1])
        pg.wait_for_timeout(100)
        d = pg.evaluate(DLG)
        self.assertIsNotNone(d)
        self.assertTrue(d["volume"][0])
        self.apply(pg)
        s = pg.evaluate(STATE)
        self.assertEqual(s["a3"][0], 0.5)
        self.assertEqual(s["past"], 1)

    def test_film_with_sound_to_sound_clip_offers_audio(self):
        pg = self.pg2()
        self.copy_via_key(pg, key="V1:0")
        self.assertIsNotNone(pg.evaluate(CLIP))
        d = self.open_via_key(pg, key="A2:1")
        self.assertIsNotNone(d)
        self.assertTrue(d["volume"][0] and d["afx"][0], d)
        self.assertFalse(d["zoom"][0] or d["opacity"][0])
        self.apply(pg, "afx")
        s = pg.evaluate(STATE)
        self.assertEqual(s["a2b"][0], 0.4)
        self.assertEqual(s["a2b"][1][0]["p"]["gain"], 6)

    def test_sound_clip_to_film(self):
        pg = self.pg2()
        self.copy_via_key(pg, key="A2:0")
        d = self.open_via_key(pg, key="V1:0")
        self.assertIsNotNone(d)
        self.assertTrue(d["volume"][0] and d["afx"][0], d)
        self.assertFalse(d["zoom"][0], "a sound source has no picture attributes")
        self.apply(pg, "afx")
        s = pg.evaluate(STATE)
        self.assertEqual(s["v1"][0], 0.5)
        self.assertEqual(s["v1"][1][0]["p"]["gain"], 4)
        self.assertEqual(s["past"], 1)

    def test_bed_copy_and_paste(self):
        pg = self.pg2()
        self.copy_via_key(pg, bed=0)
        self.assertIsNotNone(pg.evaluate(CLIP), "Ctrl+C on the bed copies it")
        d = self.open_via_key(pg, bed=1)
        self.assertIsNotNone(d, "Alt+V on a bed clip opens the dialog")
        self.assertTrue(d["fades"][0] and d["afx"][0], d)
        self.assertFalse(d["volume"][0], "the bed has no volume of its own")
        self.assertFalse(d["zoom"][0])
        self.apply(pg, "fades")
        s = pg.evaluate(STATE)
        self.assertEqual(s["bed2"], [1.5, 0])
        self.assertEqual(s["past"], 1)
        # the bed onto an A2 clip: its fades and effects (volume is off: the bed has none)
        d = self.open_via_key(pg, key="A2:1")
        self.assertIsNotNone(d)
        self.assertFalse(d["volume"][0])
        self.apply(pg, "fades", "afx")
        s = pg.evaluate(STATE)
        self.assertEqual(s["fades"], [1.5, 0])
        self.assertEqual(s["a2b"][1][0]["p"]["gain"], -3)

    def test_a2_to_the_bed_via_context_menu(self):
        pg = self.pg2()
        self.click(pg, key="A2:0", button="right")
        m = pg.evaluate(MENU, "Copy")
        pg.mouse.click(m[0], m[1])
        self.click(pg, bed=1, button="right")
        m = pg.evaluate(MENU, "Paste Attributes")
        self.assertIsNotNone(m, "the bed's menu has Paste Attributes")
        pg.mouse.click(m[0], m[1])
        pg.wait_for_timeout(100)
        d = pg.evaluate(DLG)
        self.assertIsNotNone(d)
        self.assertFalse(d["volume"][0], "the bed takes no volume")
        self.apply(pg, "afx")
        self.assertEqual(s_fx := pg.evaluate(STATE)["bedfx"][0]["p"]["gain"], 4)

    def test_locked_track_is_skipped(self):
        pg = self.pg2()
        self.copy_via_key(pg, key="A2:0")
        pg.evaluate("() => { const P = __panel; P._editTlApply({ ...P._editTlCut, tracks: P._editTlCut.tracks.map(k => k.id === 'A3' ? { ...k, lock: true } : k) }); }")
        pg.evaluate("() => { __panel._editTlSel = { kind: 'tclip', track: 'A3', i: 0 }; }")
        pg.keyboard.press("Alt+v")
        pg.wait_for_timeout(100)
        self.assertIsNone(pg.evaluate(DLG), "a locked track is no target")


if __name__ == "__main__":
    unittest.main()
