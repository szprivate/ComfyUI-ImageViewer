"""A sound that runs on past the last picture makes the film that much longer: the Edit tab plays
it and the export renders it to its end, the picture black after the last frame of the cut.

Needs PyAV (ComfyUI's interpreter) and node:
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_edit_export_sound_tail
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from tests.test_edit_export_sound import (NODE, ROOT, FPS, _modules, av, sound_of, tone_level,
                                          write_film, write_wav)

if av is not None:
    import numpy as np


def cut_with_long_sound(film, sound, sound_len, at=0.5, off=False, disabled=False):
    """A 2 s film on V1 and *sound* on a sound track from *at*, *sound_len* long - made by the panel's code."""
    url = "file:///" + os.path.join(ROOT, "js", "bEpicViewer_editTimelineData.js").replace("\\", "/")
    code = (f"import * as D from {json.dumps(url)}; const [film, snd, len, at, off, dis] = JSON.parse(process.argv[1]);"
            " let cut = D.emptyCut('t', 24);"
            " cut = D.insertEdit(cut, [{ file: film, name: 'f', length: 2 }], 0, 'V1', D.editMask(cut)).cut;"
            " cut = D.addTrack(cut, 'audio');"
            " cut = D.placeClip(cut, cut.tracks[0].id, { file: snd, name: 'song', length: len }, at);"
            " if (off) cut.tracks[0].off = true;"
            " if (dis) cut.tracks[0].clips[0].disabled = true;"
            " process.stdout.write(JSON.stringify({ save: D.toSave(cut), length: D.filmLength(cut), frames: D.filmFrames(cut) }));")
    out = subprocess.run([NODE, "--input-type=module", "-e", code,
                          json.dumps([film, sound, sound_len, at, off, disabled])],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@unittest.skipIf(av is None or NODE is None, "needs PyAV and node")
class SoundTail(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.tio, cls.tr, _mr = _modules(cls.tmp)
        cls.film = os.path.join(cls.tmp, "silent.mp4")
        cls.song = os.path.join(cls.tmp, "song.wav")
        write_film(cls.film, 2.0)
        write_wav(cls.song, 4.0, 660)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, edit, name):
        side = os.path.join(self.tmp, name + ".otio")
        self.tio.save(side, edit, "", lambda p: True, True)
        out = os.path.join(self.tmp, name + ".mp4")
        return self.tr.render(self.tio._load(side), out, "mp4"), out, self.tio.editable(self.tio._load(side))

    def test_the_panel_counts_the_sound_in_the_films_length(self):
        made = cut_with_long_sound(self.film, self.song, 4.0)
        self.assertAlmostEqual(made["length"], 4.5, places=3)
        self.assertEqual(made["frames"], int(4.5 * FPS))

    def test_the_export_runs_to_the_end_of_the_sound_black_past_the_picture(self):
        made = cut_with_long_sound(self.film, self.song, 4.0)
        got, out, edit = self.render(made["save"], "tail")
        self.assertAlmostEqual(self.tio.edit_length(edit), 4.5, places=3)
        self.assertEqual(got["frames"], int(4.5 * FPS))
        self.assertTrue(got["sound"])
        x = sound_of(out)
        self.assertGreater(tone_level(x, 660, 3.6, 4.4), 0.3, "the sound is heard after the last picture")
        with av.open(out) as src:
            frames = [f.to_ndarray(format="rgb24") for f in src.decode(video=0)]
        self.assertEqual(len(frames), int(4.5 * FPS))
        self.assertGreater(frames[24].mean(), 5, "the film's own picture")
        self.assertLess(frames[-1].mean(), 3, "black after the cut's last frame")

    def test_a_switched_off_or_disabled_sound_does_not_lengthen_the_film(self):
        for off, disabled in ((True, False), (False, True)):
            with self.subTest(off=off, disabled=disabled):
                made = cut_with_long_sound(self.film, self.song, 4.0, off=off, disabled=disabled)
                self.assertAlmostEqual(made["length"], 2.0, places=3)
                got, _out, edit = self.render(made["save"], f"quiet_{off}_{disabled}")
                self.assertAlmostEqual(self.tio.edit_length(edit), 2.0, places=3)
                self.assertEqual(got["frames"], 2 * FPS)

    def test_a_sound_inside_the_film_changes_nothing(self):
        made = cut_with_long_sound(self.film, self.song, 1.0)
        self.assertAlmostEqual(made["length"], 2.0, places=3)
        got, _out, _edit = self.render(made["save"], "inside")
        self.assertEqual(got["frames"], 2 * FPS)


if __name__ == "__main__":
    unittest.main()
