"""A sound file resolves to an audio frame: a loader node's file, an AYON container's, and what the browser opens.

Run: python -m unittest tests.test_media_resolve_audio
"""
import importlib.util
import os
import sys
import tempfile
import types
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# ComfyUI's folder_paths, for loading the resolver outside ComfyUI.
if "folder_paths" not in sys.modules:
    _fp = types.ModuleType("folder_paths")
    _fp.get_input_directory = _fp.get_output_directory = _fp.get_temp_directory = tempfile.gettempdir
    _fp.base_path = tempfile.gettempdir()
    sys.modules["folder_paths"] = _fp
_spec = importlib.util.spec_from_file_location("imageviewer_media_resolve", os.path.join(ROOT, "media_resolve.py"))
mr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mr)
_spec = importlib.util.spec_from_file_location("imageviewer_path_access", os.path.join(ROOT, "path_access.py"))
pa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pa)


class AudioResolveTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.wav = os.path.join(self.dir, "voice.wav")
        with open(self.wav, "wb") as f:
            f.write(b"RIFF0000WAVE")

    def test_a_sound_file_is_an_audio_tab(self):
        tabs = mr.resolve(self.wav)
        self.assertEqual(len(tabs), 1)
        self.assertEqual(tabs[0]["kind"], "audio")
        fr = tabs[0]["frames"][0]
        self.assertEqual((fr["kind"], fr["path"], fr["name"], fr["external"]), ("audio", self.wav, "voice.wav", True))

    def test_a_container_of_sounds(self):
        tabs, missing = mr.resolve_files([self.wav], label="take")
        self.assertEqual(missing, [])
        self.assertEqual([(t["kind"], t["label"]) for t in tabs], [("audio", "take")])

    def test_every_sound_the_viewer_plays_is_served(self):
        for ext in mr.AUDIO_EXTS:
            self.assertTrue(pa.is_media("x" + ext), ext)


if __name__ == "__main__":
    unittest.main()
