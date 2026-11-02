"""Export to Resolve: the FCPXML and EDL generators (pure), and the package through the REAL routes.

The generator tests need nothing. The package tests make real clips with PyAV (ComfyUI's interpreter):
    D:/ai/comfyui/.venv/Scripts/python.exe -m unittest tests.test_resolve_export
"""
import asyncio
import hashlib
import importlib
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from fractions import Fraction
from urllib.parse import unquote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_edit_takes import _load, _tio, web  # noqa: E402

try:
    import av
    import numpy as np
except ImportError:
    av = None

if web is not None:
    from aiohttp.test_utils import TestClient, TestServer


def _rx():
    _tio()
    return importlib.import_module("bepic_takes_tio_under_test.resolve_export")


def T(text):
    """An FCPXML time as a fraction."""
    assert text.endswith("s"), text
    return Fraction(text[:-1])


def film(duration=20, fps=None, audio=True, **more):
    return {"video": True, "audio": audio, "still": False, "width": 1920, "height": 1080, "fps": fps or Fraction(24),
            "duration": Fraction(duration), "tc": Fraction(0), "codec": "h264", "pix_fmt": "yuv420p", **more}


STILL = {"video": True, "audio": False, "still": True, "width": 800, "height": 600}
SOUND = {"video": False, "audio": True, "still": False, "duration": Fraction(100), "channels": 2, "audio_rate": 48000}


def clip(path, length, at=None, start=0.0, **more):
    out = {"file": path, "name": os.path.basename(path), "in": start, "length": length, "transition": 0}
    if at is not None:
        out["at"] = at
    out.update(more)
    return out


class Generator(unittest.TestCase):
    def setUp(self):
        self.rx, self.tio = _rx(), _tio()
        self.uris = lambda m: {self.tio.norm_path(p): self.rx.file_uri("D:/pkg/media/" + os.path.basename(p)) for p in m["files"]}

    def doc(self, edit, fps=24):
        return self.tio.rebuild(self.tio.new_doc("cut", fps), edit, "", lambda p: True)

    def make(self, edit, probes, fps=24, frames=None):
        with tempfile.TemporaryDirectory() as tmp:
            # rebuild() checks new files exist: real empty ones, renamed back in the probes.
            real = {}

            def here(c):
                path = os.path.join(tmp, os.path.basename(c["file"])).replace("\\", "/")
                open(path, "wb").close()
                real[c["file"]] = path
                c["file"] = path
            for c in edit["clips"]:
                here(c)
            for t in edit.get("tracks") or []:
                for c in t["clips"]:
                    here(c)
            doc = self.doc(edit, fps)
            probes = {real.get(k, k): v for k, v in probes.items()}
            model = self.rx.build_model(doc, probes, frames)
            xml = self.rx.fcpxml(model, probes, self.uris(model))
            return model, ET.fromstring(xml), xml, probes

    def check_whole(self, model, root, rate):
        """Everything lands on the frame grid; the spine has no hole; every reference exists."""
        ids = {e.get("id") for e in root.find("resources")}
        for e in root.iter():
            for key in ("ref", "format"):
                if e.get(key):
                    self.assertIn(e.get(key), ids, e.tag)
        spine = root.find(".//spine")
        at = Fraction(0)
        for e in spine:
            offset, dur = T(e.get("offset")), T(e.get("duration"))
            for value in (offset, dur):
                self.assertEqual((value * rate).denominator, 1, f"{e.tag} is off the frame grid: {value}")
            if e.tag == "transition":
                continue
            self.assertEqual(offset, at, "V1 has a hole or an overlap")
            at += dur
        self.assertEqual(at, T(root.find(".//sequence").get("duration")))
        self.assertEqual(at, Fraction(model["total"]) / rate)

    def test_plain_cuts_are_frame_exact(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2), clip("b.mp4", 3, start=1)], "texts": []},
                                    {"a.mp4": film(), "b.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        a, b = root.findall(".//spine/asset-clip")
        self.assertEqual((T(a.get("offset")), T(a.get("duration"))), (0, 2))
        self.assertEqual((T(b.get("offset")), T(b.get("start")), T(b.get("duration"))), (2, 1, 3))
        self.assertEqual(root.get("version"), "1.9")
        self.assertEqual(root.find(".//format").get("frameDuration"), "100/2400s")

    def test_ntsc_rates_are_exact_fractions_and_do_not_drift(self):
        for fps, want, dur in ((23.976, Fraction(24000, 1001), "1001/24000s"), (29.97, Fraction(30000, 1001), "1001/30000s"),
                               (59.94, Fraction(60000, 1001), "1001/60000s")):
            self.assertEqual(self.rx.rate_of(fps), want)
            clips = [clip(f"c{i}.mp4", 1.0 + i * 0.137, start=0.5) for i in range(40)]
            probes = {c["file"]: film(fps=want) for c in clips}
            m, root, _x, _p = self.make({"clips": clips, "texts": []}, probes, fps)
            self.check_whole(m, root, want)
            self.assertEqual(root.find(".//format").get("frameDuration"), dur)
            self.assertEqual(sum(p["dur"] for p in m["spine"]), m["total"])

    def test_gaps_on_v1_keep_every_place(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2), clip("b.mp4", 1, gap=1.5)], "texts": []},
                                    {"a.mp4": film(), "b.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        tags = [e.tag for e in root.find(".//spine")]
        self.assertEqual(tags, ["asset-clip", "gap", "asset-clip"])
        self.assertEqual(T(root.find(".//spine/gap").get("duration")), Fraction(3, 2))
        self.assertEqual(T(root.findall(".//spine/asset-clip")[1].get("offset")), Fraction(7, 2))

    def test_a_dissolve_is_a_transition_and_the_film_keeps_its_length(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 4), clip("b.mp4", 4, transition=1)], "texts": []},
                                    {"a.mp4": film(), "b.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        self.assertEqual(m["total"], 7 * 24)
        tr = root.find(".//spine/transition")
        self.assertEqual((T(tr.get("offset")), T(tr.get("duration"))), (3, 1))
        self.assertEqual(tr.get("name"), "Cross Dissolve")
        self.assertEqual([e.tag for e in root.find(".//spine")], ["asset-clip", "transition", "asset-clip"])

    def test_an_odd_dissolve_still_adds_up(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2), clip("b.mp4", 2, transition=25 / 24), clip("c.mp4", 2, transition=13 / 24)], "texts": []},
                                    {"a.mp4": film(), "b.mp4": film(), "c.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        self.assertEqual(m["total"], 6 * 24 - 25 - 13)

    def test_tracks_are_lanes_at_their_place_with_a_retimed_parent(self):
        edit = {"clips": [clip("a.mp4", 4, speed=2.0)], "texts": [],
                "tracks": [{"id": "V2", "kind": "video", "name": "V2", "clips": [clip("o.mp4", 1, at=1.0)]},
                           {"id": "A2", "kind": "audio", "name": "A2", "clips": [clip("s.wav", 1, at=2.0)]},
                           {"id": "V3", "kind": "video", "name": "V3", "off": True, "clips": [clip("p.mp4", 1, at=0.5)]}]}
        m, root, _x, _p = self.make(edit, {"a.mp4": film(), "o.mp4": film(), "s.wav": SOUND, "p.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        parent = root.find(".//spine/asset-clip")
        over = {e.get("name"): e for e in parent.findall("asset-clip")}
        start = T(parent.get("start"))
        self.assertEqual(over["o.mp4"].get("lane"), "1")
        self.assertEqual(over["p.mp4"].get("lane"), "2")
        self.assertEqual(over["p.mp4"].get("enabled"), "0")
        self.assertEqual(over["s.wav"].get("lane"), "-2", "A1 is the bed: the next sound track is one below")
        # A child's offset is on its parent's own timeline: its start plus the time into it.
        self.assertEqual(T(over["o.mp4"].get("offset")), start + 1)
        self.assertEqual(T(over["s.wav"].get("offset")), start + 2)

    def test_detached_sound_is_its_own_clip_and_the_picture_is_muted(self):
        edit = {"clips": [clip("a.mp4", 4, mute=True, link="L1", unlinked=True)], "texts": [],
                "tracks": [{"id": "A2", "kind": "audio", "name": "A2", "clips": [clip("a.mp4", 4, at=0.5, link="L1", unlinked=True)]}]}
        m, root, _x, _p = self.make(edit, {"a.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        picture = root.find(".//spine/asset-clip")
        self.assertEqual(picture.get("srcEnable"), "video")
        sound = picture.find("asset-clip")
        self.assertEqual(sound.get("srcEnable"), "audio")
        self.assertEqual(sound.get("lane"), "-2")
        self.assertEqual(sound.get("ref"), picture.get("ref"), "one file, one asset")
        self.assertEqual(len(root.findall(".//resources/asset")), 1)
        self.assertTrue(any("Linked" in line for line in m["left_out"]))

    def test_a_retime_is_a_time_map_from_the_new_time_to_the_source(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2, start=1, speed=2.0)], "texts": []}, {"a.mp4": film()})
        el = root.find(".//spine/asset-clip")
        pts = el.findall("timeMap/timept")
        self.assertEqual(T(el.get("start")), Fraction(1, 2))
        self.assertEqual([T(p.get("time")) for p in pts], [0, Fraction(5, 2)])
        self.assertEqual([T(p.get("value")) for p in pts], [0, 5], "ends at source 1 + 2 s x 2")
        self.assertEqual(el[0].tag, "timeMap", "first, as the DTD orders it")

    def test_a_loop_is_the_clip_repeated_and_a_pingpong_comes_back(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 5, start=1, loop="loop", span=2.0)], "texts": []}, {"a.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        els = root.findall(".//spine/asset-clip")
        self.assertEqual([T(e.get("duration")) for e in els], [2, 2, 1])
        self.assertEqual([T(e.get("start")) for e in els], [1, 1, 1])
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 5, start=1, loop="pingpong", span=2.0)], "texts": []}, {"a.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        back = root.findall(".//spine/asset-clip")[1]
        pts = back.findall("timeMap/timept")
        self.assertEqual([T(p.get("value")) for p in pts], [3, 1], "from the turn's end back to the in point")

    def test_a_still_is_a_video_element_of_its_length(self):
        m, root, _x, _p = self.make({"clips": [clip("a.png", 3)], "texts": []}, {"a.png": STILL})
        self.check_whole(m, root, Fraction(24))
        el = root.find(".//spine/video")
        self.assertEqual(T(el.get("duration")), 3)
        asset = root.find(".//resources/asset")
        self.assertEqual(asset.get("duration"), "0s")
        fmt = [f for f in root.findall(".//resources/format") if f.get("id") == asset.get("format")][0]
        self.assertEqual(fmt.get("name"), "FFVideoFormatRateUndefined")

    def test_fx_and_volume_in_the_order_and_units_of_the_dtd(self):
        fx = {"zx": 2.0, "zy": 2.0, "x": 0.25, "y": 0.5, "rot": 90.0, "cl": 0.1, "ct": 0.2, "op": 0.5}
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2, fx=fx, volume=0.5)], "texts": []}, {"a.mp4": film()})
        el = root.find(".//spine/asset-clip")
        self.assertEqual([c.tag for c in el], ["adjust-crop", "adjust-transform", "adjust-blend", "adjust-volume"])
        tr = el.find("adjust-transform")
        self.assertEqual(tr.get("scale"), "2 2")
        x, y = map(float, tr.get("position").split())
        self.assertAlmostEqual(x, 0.25 * 16 / 9 * 100, 3)     # percent of the frame's HEIGHT, both axes
        self.assertAlmostEqual(y, 50.0, 3)
        self.assertEqual(float(tr.get("rotation")), -90.0, "clockwise here, counter-clockwise there")
        rect = el.find("adjust-crop/trim-rect")
        self.assertAlmostEqual(float(rect.get("left")), 0.1 * 16 / 9 * 100, 3)
        self.assertAlmostEqual(float(rect.get("top")), 20.0, 3)
        self.assertEqual(el.find("adjust-blend").get("amount"), "0.5")
        self.assertEqual(el.find("adjust-volume").get("amount"), "-6.02dB")

    def test_a_disabled_clip_is_there_with_enabled_0(self):
        """The panel's D (Clip Enable): the clip stays in its place, switched off - on V1 and on a track."""
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2), clip("b.mp4", 2, disabled=True)], "texts": [],
                                     "tracks": [{"id": "V2", "kind": "video", "name": "V2", "off": False,
                                                 "clips": [clip("c.mp4", 1, at=0.5, disabled=True)]}]},
                                    {"a.mp4": film(), "b.mp4": film(), "c.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        spine = root.findall(".//spine/asset-clip")
        self.assertEqual([e.get("enabled") for e in spine], [None, "0"])
        lane = [e for e in root.iter("asset-clip") if e.get("lane") == "1"]
        self.assertEqual([e.get("enabled") for e in lane], ["0"])

    def test_keyframes_are_keyframe_animations_at_their_frames_with_their_eases(self):
        keys = {"op": [{"t": 0.5, "v": 0, "i": "in"}, {"t": 1.5, "v": 1, "i": "hold"}, {"t": 2.5, "v": 0.5}],
                "x": [{"t": 0, "v": 0}, {"t": 1, "v": 0.25, "i": "inout"}],
                "rot": [{"t": 0, "v": 0}, {"t": 2, "v": 90, "i": "out"}],
                "cl": [{"t": 0, "v": 0}, {"t": 1, "v": 0.1}],
                "vol": [{"t": 0, "v": 1}, {"t": 2, "v": 0.5}]}
        m, root, xml, _p = self.make({"clips": [clip("a.mp4", 3, start=1, fx={"keys": keys})], "texts": []}, {"a.mp4": film()})
        el = root.find(".//spine/asset-clip")
        self.assertEqual([c.tag for c in el], ["adjust-crop", "adjust-transform", "adjust-blend", "adjust-volume"])
        start = T(el.get("start"))
        self.assertEqual(start, 1)
        def frames(adjust, name):
            anim = adjust.find(f"param[@name='{name}']/keyframeAnimation")
            self.assertIsNotNone(anim, name)
            return [((T(k.get("time")) - start) * 24, k.get("value"), k.get("interp")) for k in anim.findall("keyframe")]
        blend = frames(el.find("adjust-blend"), "amount")
        # On the clip's own timeline (from its start), on whole frames; ease in = easeIn; a hold: a step of two keys.
        self.assertEqual([f for f, _v, _i in blend], [0, 12, 36, 59, 60])
        self.assertEqual(blend[1][2], "easeIn")
        self.assertEqual((blend[3][1], blend[4][1]), ("1", "0.5"), "the hold keeps its value until the frame before the next key")
        self.assertEqual(blend[2][1], "1")
        pos = frames(el.find("adjust-transform"), "position")
        self.assertEqual(pos[1][2], "ease")
        self.assertAlmostEqual(float(pos[-1][1].split()[0]), 0.25 * 16 / 9 * 100, 3)
        rot = frames(el.find("adjust-transform"), "rotation")
        self.assertEqual((rot[0][2], rot[-1][2], float(rot[-1][1])), (None, "easeOut", -90.0))
        left = frames(el.find("adjust-crop/trim-rect"), "left")
        self.assertAlmostEqual(float(left[-1][1]), 0.1 * 16 / 9 * 100, 3)
        vol = frames(el.find("adjust-volume"), "amount")
        self.assertEqual((vol[0][1], vol[-1][1]), ("0.00dB", "-6.02dB"))
        for f, _v, _i in blend + pos + vol:
            self.assertEqual(f.denominator, 1, "on the frame grid")
        # A clip with no keys is as before; the EDL does not carry them (the README says so).
        self.assertIn("keyframeAnimation", xml)

    def test_a_switched_off_section_is_not_written(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2, fx={"zx": 2.0, "toff": True})], "texts": []}, {"a.mp4": film()})
        self.assertIsNone(root.find(".//adjust-transform"))

    def test_texts_are_markers_at_their_moment_and_say_so(self):
        edit = {"clips": [clip("a.mp4", 2), clip("b.mp4", 2)], "texts": [{"text": "Hello <&> \"you\"\nline two", "start": 3.0, "length": 1.0}]}
        m, root, xml, _p = self.make(edit, {"a.mp4": film(), "b.mp4": film()})
        second = root.findall(".//spine/asset-clip")[1]
        mark = second.find("marker")
        self.assertEqual(T(mark.get("start")), 1, "a second into the second clip")
        self.assertEqual(mark.get("value"), 'Hello <&> "you"')
        self.assertIn("line two", mark.get("note"))
        self.assertIn("&lt;&amp;&gt;", xml)
        self.assertTrue(any(line.startswith("Texts come as markers") for line in m["left_out"]))

    def test_special_characters_stay_well_formed_and_urls_are_encoded(self):
        name = 'Müller & "Söhne" <take> #2.mp4'.replace('"', "'").replace("<", "(").replace(">", ")")
        m, root, _x, _p = self.make({"clips": [dict(clip(name, 2), name='A & B <c> "d"\x01')], "texts": []}, {name: film()})
        self.assertEqual(root.find(".//spine/asset-clip").get("name"), 'A & B <c> "d"')
        self.assertEqual(self.rx.file_uri("D:/a b/ü#1&.mp4"), "file:///D:/a%20b/%C3%BC%231%26.mp4")
        self.assertEqual(self.rx.file_uri("W:\\x y\\z.mp4"), "file:///W:/x%20y/z.mp4")
        self.assertEqual(self.rx.file_uri("//srv/sh are/z.mp4"), "file://srv/sh%20are/z.mp4")
        self.assertEqual(unquote(urlsplit(self.rx.file_uri("D:/a b/ü#1&.mp4")).path), "/D:/a b/ü#1&.mp4")

    def test_in_out_only_cuts_the_timeline(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2), clip("b.mp4", 2), clip("c.mp4", 2)], "texts": []},
                                    {"a.mp4": film(), "b.mp4": film(), "c.mp4": film()}, frames=[60, 83])
        self.check_whole(m, root, Fraction(24))
        self.assertEqual(m["total"], 24)
        self.assertEqual(len(m["files"]), 1, "only what the range uses is copied")
        self.assertEqual(T(root.find(".//spine/asset-clip").get("start")), Fraction(12, 24))

    def test_a_missing_file_leaves_a_gap_and_is_named(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mp4", 2), clip("b.mp4", 2), clip("c.mp4", 2, transition=0.5)], "texts": []},
                                    {"a.mp4": film(), "c.mp4": film()})
        self.check_whole(m, root, Fraction(24))
        self.assertEqual([e.tag for e in root.find(".//spine")], ["asset-clip", "gap", "asset-clip"])
        self.assertTrue(any("b.mp4" in line for line in m["left_out"]))

    def test_an_embedded_timecode_is_in_the_in_point_and_the_asset(self):
        m, root, _x, _p = self.make({"clips": [clip("a.mov", 2, start=1)], "texts": []}, {"a.mov": film(tc=Fraction(3600))})
        self.assertEqual(T(root.find(".//spine/asset-clip").get("start")), 3601)
        self.assertEqual(T(root.find(".//resources/asset").get("start")), 3600)
        self.assertEqual(self.rx._tc_start("01:00:00:12", Fraction(24)), Fraction(3600) + Fraction(1, 2))

    # ── EDL ──

    LINE = re.compile(r"^(\d{3,})  (\S+)\s+V\s+(C|D \d{3})\s+(\S+) (\S+) (\S+) (\S+)$")

    def events(self, text):
        return [self.LINE.match(line).groups() for line in text.splitlines() if self.LINE.match(line)]

    def test_edl_lines_add_up_with_gaps_and_a_dissolve(self):
        m, _r, _x, _p = self.make({"clips": [clip("a.mp4", 2), clip("b.mp4", 2, gap=1), clip("c.mp4", 2, transition=0.5, start=1)], "texts": []},
                                  {"a.mp4": film(), "b.mp4": film(), "c.mp4": film()})
        text = self.rx.edl(m)
        self.assertTrue(text.startswith("TITLE: "))
        self.assertIn("FCM: NON-DROP FRAME", text)
        ev = self.events(text)
        self.assertEqual(ev[0], ("001", "AX", "C", "00:00:00:00", "00:00:02:00", "01:00:00:00", "01:00:02:00"))
        self.assertEqual(ev[1][1], "BL")
        self.assertEqual(ev[1][5:], ("01:00:02:00", "01:00:03:00"))
        # The dissolve's two lines: the outgoing one has no length, the incoming one starts where the dissolve does.
        self.assertEqual(ev[3][0], ev[4][0])
        self.assertEqual(ev[3][2], "C")
        self.assertEqual(ev[3][3], ev[3][4])
        self.assertEqual(ev[3][5], ev[3][6])
        self.assertEqual(ev[2][6], "01:00:04:12", "the shot before ends where the dissolve begins")
        self.assertEqual(ev[4][2], "D 012")
        self.assertEqual(ev[4][3], "00:00:01:00")
        self.assertEqual(ev[4][5], "01:00:04:12")
        self.assertEqual(ev[-1][6], "01:00:06:12")
        self.assertEqual(ev[-1][6], self.rx.timecode(3600 * 24 + m["total"], Fraction(24)))
        self.assertIn("* TO CLIP NAME: c.mp4", text)

    def test_edl_at_2997_counts_at_the_nominal_30_and_a_retime_is_an_m2(self):
        rate = Fraction(30000, 1001)
        self.assertEqual(self.rx.timecode(1800, rate), "00:01:00:00", "non-drop: 1800 frames read as a minute")
        m, _r, _x, _p = self.make({"clips": [clip("a.mp4", 2, speed=2.0)], "texts": []}, {"a.mp4": film(fps=rate)}, 29.97)
        text = self.rx.edl(m)
        self.assertEqual(self.events(text)[0][6], "01:00:02:00")
        self.assertRegex(text, r"M2\s+AX\s+0059\.9")

    def test_edl_names_cannot_break_a_line(self):
        m, _r, _x, _p = self.make({"clips": [dict(clip("a.mp4", 1), name="x\ny\r\nTITLE: z")], "texts": []}, {"a.mp4": film()})
        lines = self.rx.edl(m).splitlines()
        self.assertEqual(sum(line.startswith("TITLE:") for line in lines), 1)

    # ── names and flags ──

    def test_same_named_files_get_their_own_names_and_a_file_is_one_copy(self):
        names = self.rx.media_names(["D:/a/x.mp4", "D:/b/x.mp4", "D:/e/X.MP4", "d:\\a\\x.mp4", "D:/c/../../evil.mp4", "D:/c/CON.mp4"])
        self.assertEqual(sorted(names.values()), sorted(["x.mp4", "x_2.mp4", "X_3.MP4", "evil.mp4", "cut_CON.mp4"]))
        self.assertEqual(len(names), 5, "one file twice is one entry")
        self.assertTrue(all("/" not in n and "\\" not in n and ".." not in n for n in names.values()))

    def test_package_names_cannot_leave_their_folder(self):
        for raw in ("../../evil", "..\\..\\evil", "a/b", "C:\\x", "", "...", "CON"):
            name = self.rx.package_name(raw)
            self.assertNotRegex(name, r'[\\/:]')
            self.assertFalse(name.startswith("."), name)
            self.assertTrue(name)

    def test_what_the_free_version_may_not_read_is_flagged_per_file(self):
        note = self.rx.free_version_note
        self.assertEqual(note("a.mp4", film()), "")
        self.assertEqual(note("a.mov", film(codec="prores", pix_fmt="yuv422p10le")), "")
        self.assertIn("10-bit 4:2:2", note("a.mp4", film(pix_fmt="yuv422p10le")))
        self.assertIn("4:2:2", note("a.mp4", film(codec="hevc", pix_fmt="yuv422p10le")))
        self.assertEqual(note("a.mp4", film(codec="hevc", pix_fmt="yuv420p10le")), "")
        self.assertIn("vp9", note("a.webm", film(codec="vp9")))
        self.assertIn("UHD", note("a.mp4", film(width=4096, height=2304)))
        self.assertEqual(note("a.png", STILL), "")
        self.assertIn(".webp", note("a.webp", STILL))
        self.assertIn("could not be read", note("a.mp4", {"unread": "x"}))


def _real_clip(path, frames=24, fps=24, color=128, sound=True):
    with av.open(path, "w") as out:
        v = out.add_stream("libx264", rate=fps)
        v.width, v.height, v.pix_fmt = 64, 48, "yuv420p"
        a = out.add_stream("aac", rate=48000, layout="stereo") if sound else None
        for i in range(frames):
            arr = np.full((48, 64, 3), (color + i) % 255, dtype=np.uint8)
            for packet in v.encode(av.VideoFrame.from_ndarray(arr, format="rgb24")):
                out.mux(packet)
        for packet in v.encode():
            out.mux(packet)
        if a:
            samples = np.zeros((2, 48000 * frames // fps), dtype=np.float32)
            frame = av.AudioFrame.from_ndarray(samples, format="fltp", layout="stereo")
            frame.sample_rate = 48000
            for packet in a.encode(frame):
                out.mux(packet)
            for packet in a.encode():
                out.mux(packet)


def _digest(path):
    with open(path, "rb") as fh:
        return hashlib.sha1(fh.read()).hexdigest()


@unittest.skipIf(web is None or av is None, "needs aiohttp and PyAV")
class Package(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, [])
        cls.tio = importlib.import_module(cls.pkg + ".timeline_io")
        cls.rx = importlib.import_module(cls.pkg + ".resolve_export")
        cls.outside = tempfile.mkdtemp()
        out = cls.dirs["output"]
        for sub in ("one", "two", "with space #1"):
            os.makedirs(os.path.join(out, sub))
        cls.a = os.path.join(out, "one", "shot.mp4").replace("\\", "/")
        cls.b = os.path.join(out, "two", "shot.mp4").replace("\\", "/")
        cls.c = os.path.join(out, "with space #1", "Müller & co.mp4").replace("\\", "/")
        _real_clip(cls.a, 48, color=30)
        _real_clip(cls.b, 48, color=120)
        _real_clip(cls.c, 48, color=200, sound=False)

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.outside, ignore_errors=True)

    def setUp(self):
        self.folder = tempfile.mkdtemp(dir=self.dirs["output"])
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)
        self.otio = os.path.join(self.folder, "my cut.otio")

    def save(self, *clips, **more):
        edit = {"clips": [{"file": p, "name": os.path.basename(p), "in": 0.25, "length": 1.0, "transition": 0} for p in clips], "texts": [], **more}
        self.tio.save(self.otio, edit, "", lambda p: True, "my cut")
        return {"path": self.otio, "external": 1}

    def calls(self, *requests):
        """Each ``(path, body, kwargs)`` in one client; returns ``[(status, text)]``."""
        async def go():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            out = []
            async with TestClient(TestServer(app)) as c:
                for path, body, kw in requests:
                    r = await c.post(path, json=body, **kw)
                    out.append((r.status, await r.text()))
            return out
        return asyncio.run(go())

    def post(self, path, body, **kw):
        return self.calls((path, body, kw))[0]

    def run_job(self, body):
        status, text = self.post("/bepic/timeline_export_resolve", body)
        self.assertEqual(status, 200, text)
        job = self.rx.job_of(json.loads(text)["id"])
        for _ in range(600):
            if job.status != "running":
                break
            asyncio.run(asyncio.sleep(0.02))
        return job

    def test_the_package_has_everything_and_the_originals_are_unchanged(self):
        before = {p: (_digest(p), os.stat(p).st_mtime_ns) for p in (self.a, self.b, self.c)}
        source = self.save(self.a, self.b, self.c, self.a)
        status, text = self.post("/bepic/timeline_export_resolve_plan", {"source": source})
        self.assertEqual(status, 200, text)
        plan = json.loads(text)
        self.assertEqual(plan["name"], "my cut_resolve")
        self.assertEqual(os.path.normcase(plan["folder"]), os.path.normcase(os.path.abspath(self.folder)))
        self.assertEqual(plan["size"], sum(os.path.getsize(p) for p in (self.a, self.b, self.c)))
        self.assertGreater(plan["free"], 0)
        self.assertEqual(len(plan["files"]), 3, "a file used twice is copied once")
        self.assertFalse(os.path.exists(plan["path"]), "a plan writes nothing")

        job = self.run_job({"source": source})
        self.assertEqual(job.status, "done", job.error)
        root = job.result["path"]
        self.assertEqual(sorted(os.listdir(root)), sorted(["README.txt", "media", "my cut_resolve.edl", "my cut_resolve.fcpxml", "my cut_resolve.otio"]))
        self.assertEqual(sorted(os.listdir(os.path.join(root, "media"))), sorted(["Müller & co.mp4", "shot.mp4", "shot_2.mp4"]))
        for p, (digest, mtime) in before.items():
            self.assertEqual((_digest(p), os.stat(p).st_mtime_ns), (digest, mtime), "the original is untouched")
        # Every URL resolves to a file of the package with the original's bytes, whatever its name holds.
        tree = ET.parse(os.path.join(root, "my cut_resolve.fcpxml")).getroot()
        srcs = [e.get("src") for e in tree.iter("media-rep")]
        self.assertEqual(len(srcs), 3)
        got = set()
        for src in srcs:
            self.assertTrue(src.startswith("file:///"))
            self.assertNotIn(" ", src)
            path = unquote(urlsplit(src).path).lstrip("/")
            self.assertTrue(os.path.isfile(path), path)
            self.assertEqual(os.path.normcase(os.path.dirname(os.path.abspath(path))), os.path.normcase(os.path.join(root, "media")))
            got.add(_digest(path))
        self.assertEqual(got, {d for d, _m in before.values()})
        # Probed for real: the in point on the 24 fps grid, the sum of durations the film.
        asset = {e.get("id"): e for e in tree.iter("asset")}
        clips = tree.findall(".//spine/asset-clip")
        self.assertEqual(T(clips[0].get("start")), Fraction(1, 4))
        self.assertEqual(sum(T(c.get("duration")) for c in clips), 4)
        self.assertEqual(asset[clips[0].get("ref")].get("hasAudio"), "1")
        self.assertIsNone(asset[clips[2].get("ref")].get("hasAudio"))
        self.assertEqual(T(asset[clips[0].get("ref")].get("duration")), 2)
        # The OTIO points into the package, absolutely for this machine and relatively in its note.
        with open(os.path.join(root, "my cut_resolve.otio"), encoding="utf-8") as fh:
            doc = json.load(fh)
        for item in self.tio._every_clip(doc):
            path = self.tio._file(item["media_reference"])
            self.assertTrue(os.path.isfile(path), path)
            rel = item["metadata"]["bepic"]["package_media"]
            self.assertTrue(os.path.isfile(os.path.join(root, rel)), rel)
        self.assertEqual(len(self.tio.read_editable(os.path.join(root, "my cut_resolve.otio"))["clips"]), 4)
        with open(os.path.join(root, "README.txt"), encoding="utf-8") as fh:
            readme = fh.read()
        self.assertIn("File > Import > Timeline", readme)
        self.assertIn("NOT TESTED INSIDE RESOLVE", readme)
        self.assertNotIn(".partial", "".join(os.listdir(self.folder)))
        # The next one is the next version, and the name there is refused.
        again = json.loads(self.post("/bepic/timeline_export_resolve_plan", {"source": source})[1])
        self.assertEqual(again["name"], "my cut_resolve_v002")
        status, text = self.post("/bepic/timeline_export_resolve", {"source": source, "name": "my cut_resolve"})
        self.assertEqual(status, 409, text)

    def test_cancel_cleans_up_and_keeps_the_originals(self):
        source = self.save(self.a, self.b, self.c)
        before = _digest(self.a)
        real = self.rx.Job._copy
        rx = self.rx

        def slow(job, src, target):
            job._cancel.set()
            return real(job, src, target)
        rx.Job._copy = slow
        try:
            job = self.run_job({"source": source, "name": "gone"})
        finally:
            rx.Job._copy = real
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(os.listdir(self.folder), ["my cut.otio"], "nothing left behind")
        self.assertEqual(_digest(self.a), before)

    def test_the_cancel_route_reaches_a_running_job(self):
        source = self.save(self.a)
        import threading
        hold = threading.Event()
        real = self.rx.Job._copy
        rx = self.rx

        def held(job, src, target):
            hold.wait(10)
            return real(job, src, target)
        rx.Job._copy = held
        try:
            status, text = self.post("/bepic/timeline_export_resolve", {"source": source, "name": "held"})
            self.assertEqual(status, 200, text)
            jid = json.loads(text)["id"]
            (s1, t1), (s2, t2) = self.calls(("/bepic/timeline_export_resolve_status", {"id": jid}, {}),
                                            ("/bepic/timeline_export_resolve_cancel", {"id": jid}, {}))
            self.assertEqual((s1, s2), (200, 200))
            self.assertEqual(json.loads(t1)["status"], "running", "the request came back while the copy runs")
            hold.set()
            job = rx.job_of(jid)
            job_thread_wait = 0
            while job.status == "running" and job_thread_wait < 500:
                job_thread_wait += 1
                asyncio.run(asyncio.sleep(0.02))
            self.assertEqual(job.status, "cancelled")
        finally:
            hold.set()
            rx.Job._copy = real
        self.assertFalse(os.path.exists(os.path.join(self.folder, "held")))

    def test_a_full_disk_is_refused_first_and_said_when_it_comes_late(self):
        source = self.save(self.a)
        real = self.rx._free_space
        self.rx._free_space = lambda folder: 10
        try:
            status, text = self.post("/bepic/timeline_export_resolve", {"source": source})
        finally:
            self.rx._free_space = real
        self.assertEqual(status, 507, text)
        self.assertIn("Not enough free space", text)
        self.assertEqual(os.listdir(self.folder), ["my cut.otio"])
        # The disk fills during the copy: said so, nothing behind.
        copy = self.rx.Job._copy

        def full(job, src, target):
            raise OSError(28, "No space left on device")
        self.rx.Job._copy = full
        try:
            job = self.run_job({"source": source, "name": "full"})
        finally:
            self.rx.Job._copy = copy
        self.assertEqual(job.status, "failed")
        self.assertIn("disk is full", job.error)
        self.assertEqual(os.listdir(self.folder), ["my cut.otio"])

    def test_a_missing_source_is_listed_asked_and_then_reported(self):
        gone = os.path.join(self.folder, "gone.mp4").replace("\\", "/")
        shutil.copy(self.a, gone)
        source = self.save(self.a, gone)
        os.remove(gone)
        plan = json.loads(self.post("/bepic/timeline_export_resolve_plan", {"source": source})[1])
        self.assertEqual(plan["missing"], [gone])
        status, text = self.post("/bepic/timeline_export_resolve", {"source": source})
        self.assertEqual(status, 422)
        self.assertIn("gone.mp4", text)
        job = self.run_job({"source": source, "continue_missing": True})
        self.assertEqual(job.status, "done", job.error)
        self.assertEqual(job.result["missing"], [gone])
        self.assertTrue(any("gone.mp4" in line for line in job.result["left_out"]))
        tags = [e.tag for e in ET.parse(job.result["fcpxml"]).getroot().find(".//spine")]
        self.assertEqual(tags, ["asset-clip", "gap"])

    def test_outside_the_roots_is_403_for_the_cut_the_folder_and_a_source(self):
        source = self.save(self.a)
        status, _ = self.post("/bepic/timeline_export_resolve", {"source": source, "folder": self.outside})
        self.assertEqual(status, 403)
        self.assertEqual(os.listdir(self.outside), [])
        status, _ = self.post("/bepic/timeline_export_resolve_plan", {"source": {"path": os.path.join(self.outside, "x.otio"), "external": 1}})
        self.assertEqual(status, 403)
        # A timeline naming a file outside: never copied, whatever the .otio says.
        secret = os.path.join(self.outside, "secret.mp4")
        shutil.copy(self.a, secret)
        doc = self.tio._load(self.otio)
        self.tio._track_of(doc, "video")["children"][0]["media_reference"]["target_url"] = self.tio._url(secret)
        self.tio._write_doc(self.otio, doc)
        plan = json.loads(self.post("/bepic/timeline_export_resolve_plan", {"source": source})[1])
        self.assertEqual(len(plan["refused"]), 1)
        status, text = self.post("/bepic/timeline_export_resolve", {"source": source})
        self.assertEqual(status, 403, text)
        self.assertEqual(os.listdir(self.folder), ["my cut.otio"])

    def test_a_timeline_naming_a_file_that_is_no_media_is_refused(self):
        """The copy hands bytes out: the serve rule, not just the folder rule."""
        source = self.save(self.a)
        secret = os.path.join(self.folder, "keys.env")
        with open(secret, "w", encoding="utf-8") as fh:
            fh.write("TOKEN=1")
        doc = self.tio._load(self.otio)
        self.tio._track_of(doc, "video")["children"][0]["media_reference"]["target_url"] = self.tio._url(secret)
        self.tio._write_doc(self.otio, doc)
        status, text = self.post("/bepic/timeline_export_resolve", {"source": source})
        self.assertEqual(status, 403, text)

    def test_traversal_in_the_name_stays_in_the_folder(self):
        source = self.save(self.a)
        job = self.run_job({"source": source, "name": "../../evil"})
        self.assertEqual(job.status, "done", job.error)
        self.assertEqual(os.path.normcase(os.path.dirname(job.result["path"])), os.path.normcase(os.path.abspath(self.folder)))

    def test_every_route_refuses_another_site_and_anything_but_json(self):
        source = self.save(self.a)
        for route in ("_plan", "", "_status", "_cancel"):
            status, _ = self.post("/bepic/timeline_export_resolve" + route, {"source": source, "id": "x"}, headers={"Origin": "http://evil.example"})
            self.assertEqual(status, 403, route)

        async def form():
            app = web.Application()
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as c:
                r = await c.post("/bepic/timeline_export_resolve", data="x=1", headers={"Content-Type": "text/plain"})
                return r.status
        self.assertEqual(asyncio.run(form()), 403)
        self.assertEqual(os.listdir(self.folder), ["my cut.otio"])

    def test_an_unknown_job_is_404(self):
        self.assertEqual(self.post("/bepic/timeline_export_resolve_status", {"id": "nope"})[0], 404)

    def test_real_probe_reads_codec_and_rate(self):
        info = self.rx.probe(self.a)
        self.assertEqual((info["codec"], info["pix_fmt"], info["fps"]), ("h264", "yuv420p", Fraction(24)))
        self.assertEqual(info["duration"], 2)
        self.assertTrue(info["audio"])
        self.assertIsNone(self.rx.probe(os.path.join(self.folder, "nope.mp4")))
        self.assertEqual(self.rx.free_version_note(self.a, info), "")


if __name__ == "__main__":
    unittest.main()
