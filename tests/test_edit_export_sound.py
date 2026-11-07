"""The Edit panel's film export keeps its sound, and says so when some of it could not be read; the
playback copy of a film a browser cannot play (a ProRes MOV export) keeps its length and its sound.

Needs PyAV (ComfyUI's interpreter) and node:
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_edit_export_sound
"""
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

try:
    import av
    import numpy as np
except ImportError:  # pragma: no cover
    av = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NODE = shutil.which("node")
FPS = 24
RATE = 48000


def _modules(tmp):
    name = "imageviewer_export_sound_under_test"
    if "folder_paths" not in sys.modules:
        fp = types.ModuleType("folder_paths")
        fp.get_temp_directory = fp.get_output_directory = fp.get_input_directory = lambda: tmp
        sys.modules["folder_paths"] = fp
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [ROOT]
        sys.modules[name] = pkg
    get = lambda m: importlib.import_module(name + "." + m)  # noqa: E731
    return get("timeline_io"), get("timeline_render"), get("media_resolve")


def write_film(path, seconds, freq=None, codec="libx264", pix="yuv420p", fmt="mp4"):
    """A small film, with a tone of *freq* Hz (none: silent)."""
    with av.open(path, "w", format=fmt) as out:
        vs = out.add_stream(codec, rate=FPS)
        vs.width, vs.height, vs.pix_fmt = 64, 48, pix
        aus = None
        if freq:
            aus = out.add_stream("aac" if fmt == "mp4" else "pcm_s16le", rate=RATE)
            aus.layout = "stereo"
        n = int(seconds * FPS)
        for i in range(n):
            f = av.VideoFrame.from_ndarray(np.full((48, 64, 3), (i * 5) % 255, dtype=np.uint8), format="rgb24")
            f.pts = i
            for p in vs.encode(f):
                out.mux(p)
        for p in vs.encode(None):
            out.mux(p)
        if aus is not None:
            t = np.arange(int(seconds * RATE)) / RATE
            tone = (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
            for k in range(0, tone.size, 1024):
                piece = np.ascontiguousarray(np.stack([tone[k:k + 1024]] * 2))
                if fmt != "mp4":
                    piece = np.ascontiguousarray((piece.T * 32767).astype(np.int16).reshape(1, -1))
                    af = av.AudioFrame.from_ndarray(piece, format="s16", layout="stereo")
                else:
                    af = av.AudioFrame.from_ndarray(piece, format="fltp", layout="stereo")
                af.sample_rate, af.pts = RATE, k
                for p in aus.encode(af):
                    out.mux(p)
            for p in aus.encode(None):
                out.mux(p)


def write_wav(path, seconds, freq):
    with av.open(path, "w", format="wav") as out:
        st = out.add_stream("pcm_s16le", rate=RATE)
        st.layout = "mono"
        t = np.arange(int(seconds * RATE)) / RATE
        pcm = (0.5 * np.sin(2 * np.pi * freq * t) * 32767).astype(np.int16).reshape(1, -1)
        af = av.AudioFrame.from_ndarray(pcm, format="s16", layout="mono")
        af.sample_rate, af.pts = RATE, 0
        for p in st.encode(af):
            out.mux(p)
        for p in st.encode(None):
            out.mux(p)


def sound_of(path):
    chunks = []
    with av.open(path) as src:
        if not src.streams.audio:
            return None
        res = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        for frame in src.decode(src.streams.audio[0]):
            for piece in res.resample(frame):
                chunks.append(piece.to_ndarray().reshape(-1))
    return np.concatenate(chunks)


def tone_level(x, freq, t0, t1):
    seg = x[int(t0 * RATE):int(t1 * RATE)]
    t = np.arange(seg.size) / RATE
    return float(2 * np.hypot(np.mean(seg * np.sin(2 * np.pi * freq * t)), np.mean(seg * np.cos(2 * np.pi * freq * t))))


def panel_cut(film, silent, sound):
    """The cut the Edit panel makes from Add clips: two films inserted on V1 and a sound file onto a
    sound track - built and saved by the panel's own code (imageViewer_editTimelineData.js)."""
    url = "file:///" + os.path.join(ROOT, "js", "imageViewer_editTimelineData.js").replace("\\", "/")
    code = (f"import * as D from {json.dumps(url)}; const [film, silent, snd] = JSON.parse(process.argv[1]);"
            " let cut = D.emptyCut('t', 24);"
            " cut = D.insertEdit(cut, [{ file: silent, name: 's', length: 2 }, { file: film, name: 'f', length: 2 }], 0, 'V1', D.editMask(cut)).cut;"
            " cut = D.addTrack(cut, 'audio');"
            " cut = D.placeClip(cut, cut.tracks[0].id, { file: snd, name: 'song', length: 1 }, 0.5);"
            " process.stdout.write(JSON.stringify(D.toSave(cut)));")
    out = subprocess.run([NODE, "--input-type=module", "-e", code, json.dumps([film, silent, sound])],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@unittest.skipIf(av is None or NODE is None, "needs PyAV and node")
class ExportSound(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.tio, cls.tr, cls.mr = _modules(cls.tmp)
        cls.film, cls.silent = os.path.join(cls.tmp, "film.mp4"), os.path.join(cls.tmp, "silent.mp4")
        cls.song = os.path.join(cls.tmp, "song.wav")
        write_film(cls.film, 2.0, 440)
        write_film(cls.silent, 2.0)
        write_wav(cls.song, 1.0, 660)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, edit, name, fmt="mp4"):
        side = os.path.join(self.tmp, name + ".otio")
        self.tio.save(side, edit, "", lambda p: True, True)
        out = os.path.join(self.tmp, name + "." + fmt)
        got = self.tr.render(self.tio._load(side), out, fmt)
        return got, out

    def test_a_cut_made_in_the_panel_exports_with_its_sound(self):
        for fmt in ("mp4", "mov"):
            with self.subTest(fmt=fmt):
                got, out = self.render(panel_cut(self.film, self.silent, self.song), "cut_" + fmt, fmt)
                self.assertTrue(got["sound"])
                self.assertEqual(got["unheard"], [])
                x = sound_of(out)
                self.assertIsNotNone(x, "the film has a sound stream")
                self.assertGreater(tone_level(x, 660, 0.6, 1.4), 0.3, "the sound file on the sound track")
                self.assertLess(tone_level(x, 440, 0.6, 1.4), 0.05, "the first film is silent")
                self.assertGreater(tone_level(x, 440, 2.2, 3.8), 0.3, "the second film's own sound")

    def test_sound_that_will_not_decode_is_named_not_dropped_quietly(self):
        broken = os.path.join(self.tmp, "broken.wav")
        with open(broken, "wb") as fh:
            fh.write(b"RIFF\x00\x00\x00\x00WAVEnot really a sound")
        edit = panel_cut(self.film, self.silent, broken)
        got, out = self.render(edit, "broken")
        self.assertEqual(len(got["unheard"]), 1)
        self.assertTrue(got["unheard"][0].startswith("broken.wav:"), got["unheard"])
        self.assertTrue(got["sound"], "the rest of the sound is still there")
        self.assertGreater(tone_level(sound_of(out), 440, 2.2, 3.8), 0.3)

    def test_the_playback_copy_of_a_prores_mov_keeps_its_length_and_sound(self):
        mov = os.path.join(self.tmp, "prores.mov")
        write_film(mov, 2.0, 440, codec="prores_ks", pix="yuv422p10le", fmt="mov")
        dst = os.path.join(self.tmp, "proxy.mp4")
        self.mr._write_video_proxy(mov, dst)
        with av.open(dst) as src:
            v = src.streams.video[0]
            self.assertAlmostEqual(float(v.duration * v.time_base), 2.0, delta=0.1,
                                   msg="the frames are spread over the film, not squeezed into its first")
            self.assertTrue(src.streams.audio)
        self.assertGreater(tone_level(sound_of(dst), 440, 0.5, 1.5), 0.3)


if __name__ == "__main__":
    unittest.main()
