"""c2pa_read: a file's C2PA manifest, read (not verified) from PNG, JPEG, MP4 / MOV and WebP; and what the
Dependencies tab makes of it (deps_provenance.generator_of). Run: python -m unittest tests.test_c2pa_read"""
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import c2pa_fixture as cf  # noqa: E402
from c2pa_fixture import _write  # noqa: E402

pkg = types.ModuleType("ivc2pa")
pkg.__path__ = [os.path.join(HERE, "..", "src")]
sys.modules["ivc2pa"] = pkg
cr = importlib.import_module("ivc2pa.c2pa_read")
dp = importlib.import_module("ivc2pa.deps_provenance")


class C2paReadTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def p(self, name):
        return os.path.join(self.dir, name)

    def test_every_container_gives_the_active_manifest(self):
        st = cf.store(cf.SEEDANCE, generator="c2pa-rs", manifests=2)
        cf.png(self.p("a.png"), st)
        cf.jpeg(self.p("a.jpg"), st, seg=97)          # several APP11 segments
        cf.mp4(self.p("a.mp4"), st)
        cf.mp4(self.p("b.mov"), st, at_end=False)
        cf.webp(self.p("a.webp"), st)
        for name in ("a.png", "a.jpg", "a.mp4", "b.mov", "a.webp"):
            got = cr.read(self.p(name))
            self.assertEqual(got["agents"], ["BytePlus_ModelArk 1.0.0"], name)
            self.assertEqual(got["params"]["model_name"], "dreamina-seedance-2-5", name)
            self.assertEqual(got["source_type"], "trainedAlgorithmicMedia", name)
            self.assertTrue(got["ai"], name)
            self.assertEqual(got["when"], "2026-10-21T21:42:54Z", name)
            self.assertEqual(got["generator"], "c2pa-rs", name)
            self.assertEqual(cr.model_of(got), "dreamina-seedance-2-5", name)

    def test_files_without_one_or_broken_ones_say_nothing(self):
        _write(self.p("x.png"), b"\x89PNG\r\n\x1a\n" + b"\x00" * 30)
        _write(self.p("x.mp4"), cf.box(b"ftyp", b"isom") + b"\xff\xff\xff\xff junk")
        _write(self.p("x.txt"), b"hello")
        st = cf.store(cf.SEEDANCE)
        cf.png(self.p("cut.png"), st[: len(st) // 2])          # a store cut short
        for name in ("x.png", "x.mp4", "x.txt", "cut.png", "nope.png"):
            self.assertEqual(cr.read(self.p(name)), {}, name)

    def test_indefinite_cbor(self):
        self.assertEqual(cr.cbor(b"\xbf\x61a\x9f\x01\x02\xff\xff"), {"a": [1, 2]})
        self.assertEqual(cr.cbor(b"\x7f\x62ab\x61c\xff"), "abc")


class GeneratorOfTests(unittest.TestCase):
    def setUp(self):
        self.dir = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_a_manual_magnific_download_by_its_name_and_credentials(self):
        f = os.path.join(self.dir, "magnific_8awndlcIrU.mov")
        cf.mp4(f, cf.store(cf.SEEDANCE))
        g = dp.generator_of(f)
        self.assertEqual((g["service"], g["model"], g["provider"], g["source"]),
                         ("magnific", "dreamina-seedance-2-5", "BytePlus", "c2pa"))
        self.assertEqual(g["tags"], ["magnific", "dreamina-seedance-2-5"])
        self.assertEqual(dp.generator_models(g)[0]["name"], "dreamina-seedance-2-5")

    def test_another_signed_file_names_its_model_only(self):
        f = os.path.join(self.dir, "render.png")
        cf.png(f, cf.store(cf.SEEDANCE))
        g = dp.generator_of(f)
        self.assertEqual((g["service"], g["tags"]), ("", ["dreamina-seedance-2-5"]))

    def test_the_sidecar_agentY_wrote_wins_and_carries_the_prompt(self):
        f = os.path.join(self.dir, "magnific_abc.mp4")
        cf.mp4(f, cf.store(cf.SEEDANCE))
        sc = dp.sidecar_path(f)
        sc.parent.mkdir(parents=True, exist_ok=True)
        sc.write_text(json.dumps({"generator": {"service": "magnific", "model": "pro-2.0", "provider": "bytedance",
                                                "prompt": "a fox in snow", "web_url": "https://x"}}))
        g = dp.generator_of(f)
        self.assertEqual((g["model"], g["prompt"], g["source"]), ("pro-2.0", "a fox in snow", "sidecar"))

    def test_a_name_alone_and_nothing_at_all(self):
        f = os.path.join(self.dir, "magnific_upscale.png")
        _write(f, b"\x89PNG\r\n\x1a\n")
        self.assertEqual(dp.generator_of(f)["tags"], ["magnific"])
        g = os.path.join(self.dir, "plain.png")
        _write(g, b"\x89PNG\r\n\x1a\n")
        self.assertEqual(dp.generator_of(g), {})


if __name__ == "__main__":
    unittest.main()
