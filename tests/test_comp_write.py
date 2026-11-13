"""Comp outputs (src/comp_write.py, comp_io): the EXR writer (read back with OpenEXR when it is installed),
multi-layer EXR, timecode, metadata down the B pipe, Write nodes with frame ranges and handles, a precomp Read of
another *.comp.json, the missing-frame rule, and comp file version upgrades.

    python -m unittest discover -s tests -p test_comp_write.py
"""
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("_cwr")
_pkg.__path__ = [os.path.join(ROOT, "src")]
sys.modules.setdefault("_cwr", _pkg)
CW = importlib.import_module("_cwr.comp_write")
IO = importlib.import_module("_cwr.comp_io")
M = importlib.import_module("_cwr.comp_model")

try:
    import OpenEXR
except ImportError:
    OpenEXR = None


def comp(nodes, frames=4, w=24, h=16, out="Output1"):
    return {"comp": 1, "format": {"width": w, "height": h, "fps": 25, "frames": frames}, "output": out, "nodes": nodes}


def save_png(path, rgba):
    from PIL import Image
    Image.fromarray(rgba, "RGBA").save(path)


class ExrWriter(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def picture(self, h=37, w=21):
        rng = np.random.default_rng(4)
        return rng.random((h, w, 4)).astype(np.float32) * 3

    def test_every_compression_and_depth_reads_back(self):
        if OpenEXR is None:
            self.skipTest("needs OpenEXR to read back")
        img = self.picture()
        extras = {"depth.z": img[..., 0] * 10, "mask.a": img[..., 1]}
        for comp_ in ("none", "zips", "zip"):
            for depth in ("half", "float"):
                p = os.path.join(self.tmp, f"t_{comp_}_{depth}.exr")
                with open(p, "wb") as fh:
                    fh.write(CW.exr_bytes(CW.exr_channels(img, extras, "all"), depth=depth, compression=comp_,
                                          attrs={"note": "hello", "imageviewer/frame": 7,
                                                 "timeCode": ("timecode", CW.timecode_bits("01:02:03:04"))}))
                with OpenEXR.File(p, separate_channels=True) as f:
                    ch = f.channels()
                    self.assertEqual(sorted(ch), ["A", "B", "G", "R", "depth.z", "mask.a"])
                    tol = 1e-6 if depth == "float" else 4e-3 * 30
                    self.assertTrue(np.allclose(ch["R"].pixels, img[..., 0], atol=tol), (comp_, depth))
                    self.assertTrue(np.allclose(ch["depth.z"].pixels, img[..., 0] * 10, atol=tol * 10), (comp_, depth))
                    hd = f.header()
                    self.assertEqual(hd["note"], "hello")
                    self.assertEqual(hd["imageviewer/frame"], 7)
                # ... and our own header reader agrees
                own = CW.exr_header(p)
                self.assertEqual(own["timeCode"], "01:02:03:04")
                self.assertEqual(own["compression"], comp_)
                self.assertEqual(own["channels"], ["A", "B", "G", "R", "depth.z", "mask.a"])

    def test_rgb_leaves_alpha_out(self):
        chans = CW.exr_channels(self.picture(), {"x.r": np.zeros((37, 21), np.float32)}, "rgb")
        self.assertEqual(sorted(chans), ["B", "G", "R"])

    def test_timecode_round_trip(self):
        for tc in ("00:00:00:00", "10:59:59:23", "23:01:02;29"):
            self.assertEqual(CW.timecode_from_bits(CW.timecode_bits(tc)), tc)
        self.assertEqual(CW.parse_timecode("01:00:00:00", 24), 86400)
        self.assertEqual(CW.format_timecode(86400 + 25, 24), "01:00:01:01")
        self.assertIsNone(CW.parse_timecode("nope", 24))


class Writes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cpath = os.path.join(self.tmp, "shot_v003.comp.json")
        rgba = np.zeros((16, 24, 4), np.uint8)
        rgba[..., 1] = 200
        rgba[..., 3] = 255
        save_png(os.path.join(self.tmp, "plate.png"), rgba)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def nodes(self, **write):
        return [{"id": "Read1", "type": "read", "file": "plate.png", "inputs": []},
                {"id": "AddChannels1", "type": "addchannels", "channels": "depth.z", "value": 0.5, "inputs": ["Read1"]},
                {"id": "Metadata1", "type": "metadata", "set": "shot = sh010; take = [frame]", "remove": "input/m*",
                 "inputs": ["AddChannels1"]},
                dict({"id": "Write1", "type": "write", "name": "main", "inputs": ["Metadata1"]}, **write),
                {"id": "Output1", "type": "output", "inputs": ["Write1"]}]

    def test_the_default_path_tokens_and_numbers(self):
        c, _ = M.normalize(comp(self.nodes(handles=2)))
        [p] = CW.plan(c, self.cpath)
        self.assertEqual(p["pattern"], os.path.join(self.tmp, "shot_v003_main", "main.####.exr"))
        self.assertEqual(p["frames"], list(range(-2, 6)))
        self.assertEqual(p["numbers"][-2], 999)
        self.assertEqual(CW.files_of(p)[0], os.path.join(self.tmp, "shot_v003_main", "main.0999.exr"))
        c["nodes"][3]["file"] = "out/{comp}_{name}_{version}.%05d.exr"
        [p] = CW.plan(c, self.cpath, first=1, last=2, handles=0)
        self.assertEqual(p["pattern"], os.path.join(self.tmp, "out", "shot_v003_main_v003.%05d.exr"))
        self.assertEqual(CW.files_of(p), [os.path.join(self.tmp, "out", f"shot_v003_main_v003.{n:05d}.exr") for n in (1002, 1003)])
        with self.assertRaises(CW.WriteError):
            CW.plan(c, self.cpath, ["NoSuch"])

    def test_a_render_writes_a_multilayer_exr_with_metadata_and_timecode(self):
        c, _ = M.normalize(comp(self.nodes(channels="all", timecode="01:00:00:00")))
        src = IO.Sources(self.cpath)
        plans = CW.plan(c, self.cpath, first=0, last=1)
        got = CW.render(c, self.cpath, plans, src)
        self.assertEqual(got[0]["frames"], 2)
        files = got[0]["files"]
        self.assertEqual([os.path.basename(f) for f in files], ["main.1001.exr", "main.1002.exr"])
        hd = CW.exr_header(files[1])
        self.assertEqual(hd["channels"], ["A", "B", "G", "R", "depth.z"])
        self.assertEqual(hd["timeCode"], "01:00:00:01")
        self.assertEqual(hd["shot"], "sh010")
        self.assertEqual(hd["take"], "1")
        self.assertEqual(hd["imageviewer/node"], "main")
        self.assertTrue(hd["input/filename"].endswith("plate.png"))
        self.assertNotIn("input/mtime", hd)          # removed by the Metadata node's input/m*
        if OpenEXR is not None:
            with OpenEXR.File(files[0], separate_channels=True) as f:
                ch = f.channels()
                self.assertTrue(np.allclose(ch["depth.z"].pixels, 0.5, atol=1e-3))
                self.assertTrue(np.allclose(ch["A"].pixels, 1.0, atol=1e-3))

    def test_a_png_write_and_two_writes_in_one_pass(self):
        nodes = self.nodes(file_type="png", file="pngs/p.####.png")
        nodes.insert(4, {"id": "Write2", "type": "write", "inputs": ["Read1"], "first": 2, "last": 3})
        c, _ = M.normalize(comp(nodes))
        got = CW.render(c, self.cpath, CW.plan(c, self.cpath), IO.Sources(self.cpath))
        self.assertEqual(len(got), 2)
        self.assertEqual(len(got[0]["files"]), 4)
        self.assertTrue(all(os.path.isfile(f) for f in got[0]["files"]))
        self.assertEqual([os.path.basename(f) for f in got[1]["files"]], ["Write2.1003.exr", "Write2.1004.exr"])

    def test_a_write_passes_its_picture_on(self):
        c, _ = M.normalize(comp(self.nodes()))
        a = M.render_node(c, "Output1", 0, IO.Sources(self.cpath))
        b = M.render_node(c, "Read1", 0, IO.Sources(self.cpath))
        self.assertTrue(np.array_equal(a, b))

    def test_metadata_down_the_b_pipe(self):
        c, _ = M.normalize(comp(self.nodes()))
        md = CW.metadata_at(c, "Write1", 3, IO.Sources(self.cpath))
        self.assertEqual(md["shot"], "sh010")
        self.assertEqual(md["take"], "3")
        self.assertNotIn("input/mtime", md)
        self.assertIn("input/filename", md)


class Footage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def seq(self, nums):
        for n in nums:
            rgba = np.zeros((8, 8, 4), np.uint8)
            rgba[..., 0] = n          # the red says which file it was
            rgba[..., 3] = 255
            save_png(os.path.join(self.tmp, f"plate.{n:04d}.png"), rgba)

    def test_missing_frames_black_hold_or_error(self):
        self.seq([1, 2, 4])
        src = IO.Sources(os.path.join(self.tmp, "a.comp.json"))
        node = {"type": "read", "file": "plate.####.png", "offset": 0}
        red = lambda img: round(float(M.to_straight(img)[0][0, 0, 0]) * 255)  # noqa: E731
        self.assertIsNone(src(dict(node, missing="black"), 2))           # comp frame 2 = file 3: not there
        self.assertEqual(red(src(dict(node, missing="hold"), 2)), 2)
        with self.assertRaises(IO.MissingFrame):
            src(dict(node, missing="error"), 2)
        self.assertEqual(src.info(node)[1]["gaps"], 1)

    def test_a_precomp_read_renders_the_other_comp(self):
        inner = os.path.join(self.tmp, "inner.comp.json")
        IO.write(inner, comp([{"id": "Constant1", "type": "constant", "color": [0.25, 0.5, 1, 1], "inputs": []},
                              {"id": "Output1", "type": "output", "inputs": ["Constant1"]}], frames=3, w=10, h=6))
        outer = os.path.join(self.tmp, "outer.comp.json")
        c, _ = M.normalize(comp([{"id": "Read1", "type": "read", "file": "inner.comp.json", "fit": "none", "inputs": []},
                                 {"id": "Output1", "type": "output", "inputs": ["Read1"]}], w=10, h=6))
        src = IO.Sources(outer)
        info = src.info(c["nodes"][0])[1]
        self.assertEqual((info["kind"], info["first"], info["last"], info["width"]), ("comp", 0, 2, 10))
        img = M.render_node(c, "Output1", 1, src)
        self.assertTrue(np.allclose(img[3, 3], [0.25, 0.5, 1, 1]))

    def test_a_precomp_that_reads_itself_is_black_with_a_note(self):
        me = os.path.join(self.tmp, "me.comp.json")
        data = comp([{"id": "Read1", "type": "read", "file": "me.comp.json", "inputs": []},
                     {"id": "Output1", "type": "output", "inputs": ["Read1"]}])
        IO.write(me, data)
        src = IO.Sources(me)
        img = M.render_node(M.normalize(data)[0], "Output1", 0, src)
        self.assertEqual(float(img.max()), 0.0)
        self.assertTrue(any("loop" in n for n in src.notes), src.notes)

    def test_a_localised_copy_is_read_while_it_is_there(self):
        self.seq([1])
        os.makedirs(os.path.join(self.tmp, "local"))
        shutil.copy(os.path.join(self.tmp, "plate.0001.png"), os.path.join(self.tmp, "local", "plate.0001.png"))
        src = IO.Sources(os.path.join(self.tmp, "a.comp.json"))
        node = {"type": "read", "file": "plate.####.png", "local": os.path.join(self.tmp, "local", "plate.####.png")}
        self.assertTrue(src.path_of(node).startswith(os.path.join(self.tmp, "local")))
        self.assertEqual(src.path_of(dict(node, local=os.path.join(self.tmp, "gone", "x.png"))),
                         os.path.join(self.tmp, "plate.####.png"))

    def test_versions(self):
        p = os.path.join(self.tmp, "v.comp.json")
        with open(p, "w") as fh:
            json.dump({"comp": 99, "nodes": []}, fh)
        with self.assertRaisesRegex(ValueError, "newer viewer"):
            IO.read(p)
        with open(p, "w") as fh:
            json.dump({"comp": "1"}, fh)
        with self.assertRaisesRegex(ValueError, "not a comp"):
            IO.read(p)


if __name__ == "__main__":
    unittest.main()
