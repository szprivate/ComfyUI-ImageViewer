"""mg_scene_io: the Motion panel's scene file guard. Run: python -m unittest tests.test_mg_scene_io"""
import importlib.util
import json
import os
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "mg_scene_io", os.path.join(os.path.dirname(__file__), "..", "mg_scene_io.py"))
io = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(io)

SCENE = {"mgscene": 1, "comp": {"width": 1280, "height": 720, "fps": 30, "duration": 30}, "layers": []}


class SceneIoTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def test_only_scene_names(self):
        self.assertTrue(io.is_scene_path("a/b.mgscene.json"))
        self.assertTrue(io.is_scene_path("A.MGSCENE.JSON"))
        self.assertFalse(io.is_scene_path("a/b.json"))
        with self.assertRaises(ValueError):
            io.check_path("/etc/passwd")

    def test_write_then_read_round_trips(self):
        p = os.path.join(self.d, "sub", "x.mgscene.json")
        io.write(p, SCENE)
        self.assertEqual(io.read(p), SCENE)
        self.assertEqual([n for n in os.listdir(os.path.dirname(p)) if n.endswith(".tmp")], [])

    def test_refuses_things_that_are_not_scenes(self):
        p = os.path.join(self.d, "x.mgscene.json")
        for bad in (None, [], {"layers": []}, {"mgscene": 2, "comp": {}, "layers": []}, {"mgscene": 1, "comp": {}}):
            with self.assertRaises(ValueError):
                io.write(p, bad)
        self.assertFalse(os.path.exists(p))

    def test_read_rejects_non_objects(self):
        p = os.path.join(self.d, "x.mgscene.json")
        with open(p, "w") as fh:
            json.dump([1, 2], fh)
        with self.assertRaises(ValueError):
            io.read(p)


def _chunk(kind, data):
    import struct, zlib
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def _png(path, scene=None, source=None, zipped=True):
    """A 1x1 PNG with the chunks agentY-core's poster writer adds (iTXt mgscene, tEXt mgscene_path)."""
    import struct, zlib
    out = io.PNG_SIG + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    if scene is not None:
        text = json.dumps(scene).encode("utf-8")
        body = b"mgscene\0" + (b"\x01\0" if zipped else b"\0\0") + b"\0\0" + (zlib.compress(text) if zipped else text)
        out += _chunk(b"iTXt", body)
    if source:
        out += _chunk(b"tEXt", b"mgscene_path\0" + source.encode("latin-1"))
    out += _chunk(b"IDAT", zlib.compress(b"\0\x01\x02\x03")) + _chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(out)
    return path


class PosterPngTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.allow = lambda p: True

    def test_reads_compressed_and_plain_chunks(self):
        for zipped in (True, False):
            png = _png(os.path.join(self.d, "a.png"), SCENE, "/x/y.mgscene.json", zipped)
            self.assertEqual(io.read_png_scene(png), (SCENE, "/x/y.mgscene.json"))

    def test_plain_or_broken_png_has_no_scene(self):
        self.assertIsNone(io.read_png_scene(_png(os.path.join(self.d, "p.png"))))
        junk = os.path.join(self.d, "junk.png")
        with open(junk, "wb") as fh:
            fh.write(b"not a png at all")
        self.assertIsNone(io.read_png_scene(junk))
        self.assertIsNone(io.read_png_scene(os.path.join(self.d, "missing.png")))

    def test_reads_what_pillow_writes(self):
        try:
            from PIL import Image
            from PIL.PngImagePlugin import PngInfo
        except ImportError:
            self.skipTest("Pillow not installed")
        info = PngInfo()
        info.add_itxt("mgscene", json.dumps(SCENE), zip=True)
        info.add_text("mgscene_path", "C:/p/s.mgscene.json")
        png = os.path.join(self.d, "pil.png")
        Image.new("RGB", (8, 8)).save(png, pnginfo=info)
        self.assertEqual(io.read_png_scene(png), (SCENE, "C:/p/s.mgscene.json"))

    def test_source_scene_wins_when_it_still_matches(self):
        src = os.path.join(self.d, "real.mgscene.json")
        io.write(src, SCENE)
        png = _png(os.path.join(self.d, "elsewhere", "r.png") if os.makedirs(os.path.join(self.d, "elsewhere")) is None else "",
                   SCENE, src)
        got = io.resolve_png(png, self.allow)
        self.assertEqual(got, {"path": os.path.abspath(src), "scene": SCENE})

    def test_changed_missing_or_disallowed_source_falls_back_to_a_file_beside_the_png(self):
        src = os.path.join(self.d, "real.mgscene.json")
        png = _png(os.path.join(self.d, "r.png"), SCENE, src)
        want = {"path": os.path.join(self.d, "r.mgscene.json"), "scene": SCENE}
        self.assertEqual(io.resolve_png(png, self.allow), want)            # source missing
        io.write(src, dict(SCENE, layers=[{"id": "n"}]))
        self.assertEqual(io.resolve_png(png, self.allow), want)            # source edited since
        io.write(src, SCENE)
        self.assertEqual(io.resolve_png(png, lambda p: False), want)       # source outside allowed folders
        self.assertFalse(os.path.exists(want["path"]))                     # resolving never writes

    def test_no_scene_resolves_to_none(self):
        self.assertIsNone(io.resolve_png(_png(os.path.join(self.d, "p.png")), self.allow))


if __name__ == "__main__":
    unittest.main()
