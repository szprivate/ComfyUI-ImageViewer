"""Add clips takes sound files, in the Edit panel in a real browser: the picker offers them, and a sound
picked with films lands on a sound track at the playhead - not pushed on by the films' insert edit.

Needs Playwright with an installed Edge or Chrome, and node for the stub server; skipped without them.
Run: python -m unittest tests.test_edit_add_sound_browser
"""
import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import test_edit_takes_browser as tb  # noqa: E402

S1, S2, S3, sync_playwright = tb.S1, tb.S2, tb.S3, tb.sync_playwright
SONG, NEW = "D:/out/song.wav", "D:/out/shot_04_v001.mp4"

STATE = """() => { const c = __panel._editTlCut;
  return { v1: c.clips.map(x => [x.file, x.length]),
           tracks: c.tracks.map(k => [k.id, k.kind, k.clips.map(x => [x.file, x.at, x.length])]),
           note: __panel._editTlNote }; }"""


@unittest.skipIf(sync_playwright is None or shutil.which("node") is None, "needs playwright and node")
class EditAddSoundBrowserTests(tb.EditTakesBrowserTests):
    def media(self, pg):
        pg.evaluate("""() => { Object.assign(__media, { 'D:/out/song.wav': { duration: 3, audio: true, video: false },
                                                      'D:/out/shot_04_v001.mp4': { duration: 2, video: true, audio: true } }); }""")

    def test_add_clips_offers_sound_files(self):
        pg = self.page()
        exts = pg.evaluate("""async () => { let spec = null; const P = __panel;
            P._editTlPicker = async (s) => { spec = s; };
            await P._editTlAddFiles(); return spec.exts; }""")
        for e in (".wav", ".mp3", ".flac", ".mp4", ".png"):
            self.assertIn(e, exts)
        self.assertEqual(self.errors, [])

    def test_a_sound_picked_with_a_film_lands_at_the_playhead_on_a_sound_track(self):
        pg = self.page()
        self.media(pg)
        pg.evaluate("""async () => { const P = __panel; P._editTlSeek(3);
            await P._editTlAdd([{ path: 'D:/out/shot_04_v001.mp4', name: 'shot_04_v001.mp4' }, { path: 'D:/out/song.wav', name: 'song.wav' }],
                               P._editTlNowSeconds(), '', '', { insert: true, track: 'V1' }); }""")
        st = pg.evaluate(STATE)
        self.assertIn([NEW, 2], st["v1"], "the film is inserted on V1")
        sound = [k for k in st["tracks"] if k[1] == "audio"]
        self.assertEqual(len(sound), 1, "a sound track was made for it")
        self.assertEqual(sound[0][2], [[SONG, 3, 3]], "at the playhead, not after the inserted film")
        self.assertIn("1 sound(s) onto", st["note"])
        self.assertEqual(self.errors, [])

    def test_a_sound_alone_from_add_clips_goes_onto_a_sound_track(self):
        pg = self.page()
        self.media(pg)
        before = pg.evaluate(STATE)["v1"]
        pg.evaluate("""async () => { const P = __panel; P._editTlSeek(1);
            await P._editTlAdd([{ path: 'D:/out/song.wav', name: 'song.wav' }], P._editTlNowSeconds(), '', '', { insert: true, track: 'V1' }); }""")
        st = pg.evaluate(STATE)
        self.assertEqual(st["v1"], before, "V1 is left as it was")
        self.assertEqual([k[2] for k in st["tracks"] if k[1] == "audio"], [[[SONG, 1, 3]]])
        self.assertEqual(pg.evaluate("() => __panel._editTlSel"), {"kind": "tclip", "track": "A2", "i": 0})
        self.assertEqual(self.errors, [])


# The takes tests are run by their own module; only the ones above here.
for _name in [n for n in vars(tb.EditTakesBrowserTests) if n.startswith("test_")]:
    if _name not in vars(EditAddSoundBrowserTests):
        setattr(EditAddSoundBrowserTests, _name, None)

if __name__ == "__main__":
    unittest.main()
