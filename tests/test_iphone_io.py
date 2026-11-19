"""The iPhone reader (iphone_io.py) and what the Matchmove makes of it: films and photos built here the way an
iPhone lays them out (a turned picture track, Apple's metadata keys, a Cinematic film's depth track of sample
type 'dish' that is not marked as video, timed metadata, a HEIC with tiles, a turn, EXIF and a depth picture).

    python -m unittest discover -s tests -p test_iphone_io.py

Needs PyAV and ffmpeg with libx264 / libx265 on the PATH (skipped without them).
"""
import importlib
import io
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import types
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("imageviewer_iphone_under_test")
_pkg.__path__ = [os.path.join(ROOT, "src")]
sys.modules.setdefault("imageviewer_iphone_under_test", _pkg)
I = importlib.import_module("imageviewer_iphone_under_test.iphone_io")
MM = importlib.import_module("imageviewer_iphone_under_test.matchmove")

try:
    import av  # noqa: F401
    HAVE_AV = True
except ImportError:
    HAVE_AV = False
FFMPEG = shutil.which("ffmpeg")


def ff(*args, stdin=None):
    subprocess.run([FFMPEG, "-v", "error", "-y", *args], input=stdin, check=True)


def box(typ, payload):
    return struct.pack(">I", 8 + len(payload)) + typ.encode("latin-1") + payload


def full(typ, ver, flags, payload):
    return box(typ, bytes([ver]) + flags.to_bytes(3, "big") + payload)


def make_cinematic(folder, w=320, h=240, dw=160, dh=120, frames=12, rotate=True, depth=None, pic=None, fps=30):
    """A film like an iPhone's: an H.264 picture (turned for portrait with *rotate*; *pic* a film of its own, else
    a test pattern), Apple's keys and a second track of HEVC grey pictures re-marked as a depth map (sample type
    'dish', handler 'meta'). *depth* [frames, dh, dw] 0..1."""
    if pic is None:
        pic = os.path.join(folder, "pic.mp4")
        ff("-f", "lavfi", "-i", f"testsrc=size={w}x{h}:rate={fps}", "-frames:v", str(frames), "-c:v", "libx264",
           "-pix_fmt", "yuv420p", pic)
    if depth is None:
        depth = np.stack([np.tile(np.linspace(0.2, 0.9, dw, dtype=np.float32), (dh, 1))] * frames)
    raw = (np.clip(depth, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes()
    dep = os.path.join(folder, "dep.mp4")
    ff("-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{dw}x{dh}", "-r", str(fps), "-i", "-", "-c:v", "libx265",
       "-pix_fmt", "gray", "-x265-params", "log-level=error:keyint=4:lossless=1", dep, stdin=raw)
    out = os.path.join(folder, "IMG_0001.MOV")
    ff(*(["-display_rotation", "-90"] if rotate else []), "-i", pic, "-i", dep, "-map", "0:v", "-map", "1:v",
       "-c", "copy", "-tag:v:1", "hvc1", "-movflags", "use_metadata_tags",
       "-metadata", "com.apple.quicktime.make=Apple", "-metadata", "com.apple.quicktime.model=iPhone 14",
       "-metadata", "com.apple.quicktime.camera.lens_model=iPhone 14 back dual wide camera 5.7mm f/1.5",
       "-metadata", "com.apple.quicktime.camera.focal_length.35mm_equivalent=26",
       "-metadata", "com.apple.quicktime.software=17.1", out)
    with open(out, "rb") as fh:
        data = bytearray(fh.read())
    mv = memoryview(data)
    moov = next((a, b) for t, a, b in I.iter_boxes(mv) if t == "moov")
    traks = I.children(mv, *moov, "trak")
    a, b = traks[1]
    md = I.child(mv, a, b, "mdia")
    hd = I.child(mv, *md, "hdlr")
    data[hd[0] + 8:hd[0] + 12] = b"meta"
    st = I.child(mv, *I.child(mv, *I.child(mv, *md, "minf"), "stbl"), "stsd")
    data[st[0] + 12:st[0] + 16] = b"dish"
    with open(out, "wb") as fh:
        fh.write(data)
    return out


def hevc_item(folder, name, img, gray=False):
    """One picture coded as a single HEVC frame: (hvcC payload, the sample's length-prefixed NAL units)."""
    h, w = img.shape[:2]
    path = os.path.join(folder, name + ".mp4")
    fmt = "gray" if gray else "rgb24"
    ff("-f", "rawvideo", "-pix_fmt", fmt, "-s", f"{w}x{h}", "-i", "-", "-frames:v", "1", "-c:v", "libx265",
       "-pix_fmt", "gray" if gray else "yuv420p", "-x265-params", "log-level=error:lossless=1", path,
       stdin=img.astype(np.uint8).tobytes())
    info = I.read_film(path, timed=False)
    tr = info["_tracks"][0]
    cfg = I._hevc_config(info["_buf"], tr)
    off, size, _t, _s = tr["samples"][0]
    with open(path, "rb") as fh:
        fh.seek(off)
        return cfg, fh.read(size)


def make_heic(folder, pic, depth, exif, rot=1, aux="urn:com:apple:photo:2018:aux:depth"):
    """A HEIC laid out as an iPhone's: the picture as a 2 x 1 grid of HEVC tiles turned by *rot* quarter turns
    (anticlockwise), an Exif item, and a grey depth picture as an auxiliary item with an XMP packet."""
    h, w = pic.shape[:2]
    tw = w // 2
    t1 = hevc_item(folder, "t1", pic[:, :tw])
    t2 = hevc_item(folder, "t2", pic[:, tw:])
    dp = hevc_item(folder, "dp", (depth * 255).astype(np.uint8), gray=True)
    xmp = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
           b'<rdf:Description xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/" apdi:NativeFormat="1751411059" '
           b'apdi:Accuracy="relative" apdi:Filtered="1"/></rdf:RDF></x:xmpmeta>')
    grid = bytes([0, 0, 0, 1]) + struct.pack(">HH", w, h)
    # items: 1 grid (primary), 2 + 3 tiles, 4 exif, 5 depth, 6 xmp of the depth
    blobs = {2: t1[1], 3: t2[1], 4: struct.pack(">I", 0) + exif, 5: dp[1], 6: xmp}

    def infe(iid, typ, name="", extra=b""):
        return full("infe", 2, 0, struct.pack(">HH", iid, 0) + typ.encode() + name.encode() + b"\x00" + extra)
    iinf = full("iinf", 0, 0, struct.pack(">H", 6) + infe(1, "grid") + infe(2, "hvc1") + infe(3, "hvc1")
                + infe(4, "Exif") + infe(5, "hvc1") + infe(6, "mime", "", b"application/rdf+xml\x00"))

    def ref(typ, fr, to):
        return box(typ, struct.pack(">HH", fr, len(to)) + b"".join(struct.pack(">H", t) for t in to))
    iref = full("iref", 0, 0, ref("dimg", 1, [2, 3]) + ref("cdsc", 4, [1]) + ref("auxl", 5, [1]) + ref("cdsc", 6, [5]))
    props = [box("hvcC", t1[0]), full("ispe", 0, 0, struct.pack(">II", tw, h)),
             full("ispe", 0, 0, struct.pack(">II", w, h)), box("irot", bytes([rot])),
             box("hvcC", dp[0]), full("ispe", 0, 0, struct.pack(">II", depth.shape[1], depth.shape[0])),
             full("auxC", 0, 0, aux.encode() + b"\x00")]
    ipco = box("ipco", b"".join(props))

    def assoc(iid, idx):
        return struct.pack(">HB", iid, len(idx)) + bytes(idx)
    ipma = full("ipma", 0, 0, struct.pack(">I", 4) + assoc(1, [3, 0x80 | 4]) + assoc(2, [0x80 | 1, 2])
                + assoc(3, [0x80 | 1, 2]) + assoc(5, [0x80 | 5, 6, 7]))
    iprp = box("iprp", ipco + ipma)
    pitm = full("pitm", 0, 0, struct.pack(">H", 1))
    hdlr = full("hdlr", 0, 0, b"\x00" * 4 + b"pict" + b"\x00" * 12 + b"\x00")
    idat = box("idat", grid)
    ftyp = box("ftyp", b"heic" + b"\x00\x00\x00\x00" + b"mif1heic")

    def build(base):
        entries, o = [], base
        for iid in sorted(blobs):
            entries.append(struct.pack(">HHHIHII", iid, 0, 0, 0, 1, o, len(blobs[iid])))
            o += len(blobs[iid])
        grid_loc = struct.pack(">HHHIHII", 1, 1, 0, 0, 1, 0, len(grid))      # construction method 1: in idat
        iloc = full("iloc", 1, 0, bytes([0x44, 0x40]) + struct.pack(">H", 1 + len(entries)) + grid_loc + b"".join(entries))
        return full("meta", 0, 0, hdlr + pitm + iloc + iinf + iref + iprp + idat)
    meta = build(0)
    base = len(ftyp) + len(meta) + 8
    meta = build(base)
    mdat = box("mdat", b"".join(blobs[k] for k in sorted(blobs)))
    path = os.path.join(folder, "IMG_0002.HEIC")
    with open(path, "wb") as fh:
        fh.write(ftyp + meta + mdat)
    return path


def apple_exif():
    from PIL import Image
    ex = Image.Exif()
    ex[0x010F] = "Apple"
    ex[0x0110] = "iPhone 14"
    sub = ex.get_ifd(0x8769)
    sub[0x920A] = 5.7
    sub[0xA405] = 26
    sub[0xA434] = "iPhone 14 back dual wide camera 5.7mm f/1.5"
    return ex.tobytes()[6:] if ex.tobytes().startswith(b"Exif") else ex.tobytes()


@unittest.skipUnless(HAVE_AV and FFMPEG, "needs PyAV and ffmpeg")
class FilmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.film = make_cinematic(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_the_keys_tracks_and_turn_of_an_iphone_film(self):
        info = I.read_film(self.film)
        self.assertEqual(info["keys"]["com.apple.quicktime.model"], "iPhone 14")
        self.assertEqual(info["picture"]["rotation"], 90)
        self.assertEqual(info["picture"]["frames"], 12)
        self.assertTrue(info["cinematic"])
        self.assertEqual(info["depth"]["type"], "dish")
        self.assertEqual([info["depth"]["width"], info["depth"]["height"]], [160, 120])
        roles = [t["role"] for t in info["tracks"]]
        self.assertEqual(roles, ["picture", "depth"])

    def test_the_camera_facts_come_from_the_lens_key_and_the_35mm_key(self):
        f = MM.camera_facts(self.film, None, 320, 240)
        self.assertEqual(f["make"], "Apple")
        self.assertAlmostEqual(f["focal_mm"], 5.7)
        self.assertEqual(f["focal35"], 26)
        # shown upright (turned), so the sensor is the portrait one the 35 mm key gives: taller than wide
        self.assertLess(f["sensor_mm"][0], f["sensor_mm"][1])
        diag = math.hypot(*f["sensor_mm"])
        self.assertAlmostEqual(diag, MM.FULL_FRAME_DIAGONAL * 5.7 / 26, places=2)
        self.assertTrue(f["phone"]["cinematic"])
        self.assertTrue(any("Cinematic" in n for n in f["notes"]))

    def test_the_depth_track_is_decoded(self):
        got = I.depth_samples(self.film, [0.0, 0.2])
        self.assertEqual(sorted(got), [0.0, 0.2])
        t, img = got[0.2]
        self.assertEqual(img.shape, (120, 160))
        self.assertAlmostEqual(t, 6 / 30, places=3)
        self.assertAlmostEqual(float(img[:, 0].mean()), 0.2, delta=0.02)
        self.assertAlmostEqual(float(img[:, -1].mean()), 0.9, delta=0.02)

    def test_a_film_without_a_depth_track_says_so(self):
        tmp = tempfile.mkdtemp()
        try:
            p = os.path.join(tmp, "plain.mov")
            ff("-f", "lavfi", "-i", "testsrc=size=64x48:rate=30", "-frames:v", "3", "-c:v", "libx264", p)
            self.assertIsNone(I.read_film(p)["depth"])
            with self.assertRaises(I.PhoneError):
                I.depth_samples(p, [0])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(HAVE_AV and FFMPEG, "needs PyAV and ffmpeg")
class PhoneDepthTests(unittest.TestCase):
    """The film's own depth placed into a solve: a camera looking level over a floor 1 unit below it."""

    def test_the_phone_depth_lands_on_the_floor(self):
        MT = importlib.import_module("imageviewer_iphone_under_test.matchmove_matte")
        w, h, dw, dh, f = 320, 240, 160, 120, 300.0
        yy = (np.arange(dh) + 0.5) * h / dh
        ry = (yy - h / 2) / f
        disp = np.where(ry > 0.02, 0.4 * ry, 0.0)                  # disparity = 0.4 / z on the floor, 0 above
        depth = np.stack([np.repeat(disp[:, None], dw, axis=1)] * 6).astype(np.float32)
        tmp = tempfile.mkdtemp()
        try:
            film = make_cinematic(tmp, w, h, dw, dh, frames=6, rotate=False, depth=depth)
            cams = {0: {"R": np.eye(3).tolist(), "t": [0, 0, 0]}, 3: {"R": np.eye(3).tolist(), "t": [0, 0, 0]}}
            tracks = []
            for u in (40, 120, 200, 280):
                for v in (150, 180, 220):
                    z = 1.0 / ((v - h / 2) / f)
                    tracks.append([u, v, (u - w / 2) / f * z, 1.0, z])
            res = MT.phone_depth_points(film, [0, 3], cams, {0: tracks, 3: tracks}, fps=30, size=(w, h),
                                        focal=f)
            self.assertEqual(res["reading"], "disparity")
            pts = np.asarray(res["points"])
            self.assertGreater(len(pts), 200)
            self.assertLess(float(np.median(np.abs(pts[:, 1] - 1.0))), 0.05)
            self.assertAlmostEqual(res["frames"][0]["scale"], 0.4, delta=0.05)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TimedMetadataTests(unittest.TestCase):
    def test_a_mebx_entry_and_its_samples(self):
        def key(lid, name, dtype):
            return box(struct.pack(">I", lid).decode("latin-1"),
                       box("keyd", b"mdta" + name.encode()) + box("dtyp", struct.pack(">II", 0, dtype)))
        keys = box("keys", key(1, "com.apple.quicktime.video-orientation", 66)
                   + key(2, "com.apple.quicktime.motion.gyro", 23))
        entry = bytes(6) + struct.pack(">H", 1) + keys
        mv = memoryview(entry)
        k = I.mebx_keys(mv, 0, len(entry))
        self.assertEqual(k[1], ("com.apple.quicktime.video-orientation", 66))
        sample = (box("\x00\x00\x00\x01", struct.pack(">h", 6))
                  + box("\x00\x00\x00\x02", struct.pack(">3f", 0.5, -0.25, 1.0)))
        got = I.mebx_sample(memoryview(sample), k)
        self.assertEqual(got["com.apple.quicktime.video-orientation"], 6)
        self.assertEqual(got["com.apple.quicktime.motion.gyro"], [0.5, -0.25, 1.0])
        s = I._summary([6, 6, 1, 1, 6])
        self.assertEqual(s["changes"], 2)
        self.assertEqual(s["distinct"], [6, 1])

    def test_the_lens_name_says_focal_and_camera(self):
        self.assertEqual(I.lens_facts("iPhone 14 Pro back triple camera 6.86mm f/1.78"),
                         {"focal_mm": 6.86, "fnumber": 1.78, "side": "back"})
        self.assertEqual(I.lens_facts("iPhone 14 back dual wide camera 1.54mm f/2.4")["camera"], "wide")
        self.assertEqual(I.lens_facts("iPhone 14 front camera 2.69mm f/1.9")["side"], "front")


@unittest.skipUnless(HAVE_AV and FFMPEG, "needs PyAV and ffmpeg")
class PhotoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        yy, xx = np.mgrid[0:64, 0:128]
        cls.pic = np.dstack([xx * 2, yy * 4, np.full_like(xx, 128)]).astype(np.uint8)
        cls.depth = np.tile(np.linspace(0.1, 0.8, 32, dtype=np.float32), (16, 1))
        cls.heic = make_heic(cls.tmp, cls.pic, cls.depth, apple_exif())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_the_photo_and_its_depth_are_read_turned(self):
        info = I.read_photo(self.heic, pictures=True)
        self.assertEqual((info["width"], info["height"]), (64, 128))      # a quarter turn: shown portrait
        img = info["_picture"]
        self.assertEqual(img.shape, (128, 64, 3))
        want = np.rot90(self.pic, 1)
        self.assertLess(np.abs(img.astype(int) - want.astype(int)).mean(), 6)
        self.assertEqual(info["depth"]["type"], "urn:com:apple:photo:2018:aux:depth")
        self.assertEqual(info["depth"]["xmp"]["apdi:Accuracy"], "relative")
        d = info["_depth"]
        self.assertEqual(d.shape, (16, 32))                                # the depth has no turn of its own
        self.assertAlmostEqual(float(d[:, 0].mean()), 0.1, delta=0.02)

    def test_the_photo_matches_an_independent_reader(self):
        try:
            import pillow_heif
        except ImportError:
            self.skipTest("pillow-heif is not installed")
        hf = pillow_heif.open_heif(self.heic)
        ours = I.read_photo(self.heic, pictures=True)["_picture"]
        theirs = np.asarray(hf.to_pillow().convert("RGB"))
        self.assertEqual(theirs.shape, ours.shape)
        self.assertLess(np.abs(theirs.astype(int) - ours.astype(int)).mean(), 3)

    def test_camera_facts_of_a_heic(self):
        f = MM.camera_facts(self.heic)
        self.assertEqual(f["model"], "iPhone 14")
        self.assertAlmostEqual(f["focal_mm"], 5.7)
        self.assertEqual(f["lens"], "iPhone 14 back dual wide camera 5.7mm f/1.5")
        self.assertTrue(f["sensor_mm"][1] > f["sensor_mm"][0])            # portrait
        self.assertEqual(f["phone"]["depth"]["type"], "urn:com:apple:photo:2018:aux:depth")
        self.assertEqual(I.depth_meaning(f["phone"]["depth"]), "disparity")


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from test_edit_takes import _load, web  # noqa: E402
except Exception:  # noqa: BLE001
    web = None


@unittest.skipUnless(HAVE_AV and FFMPEG and web is not None, "needs PyAV, ffmpeg and aiohttp")
class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.app, cls.dirs, cls.pkg = _load(cls.tmp, [])
        cls.film = make_cinematic(cls.dirs["input"])
        yy, xx = np.mgrid[0:64, 0:128]
        pic = np.dstack([xx * 2, yy * 4, np.full_like(xx, 128)]).astype(np.uint8)
        cls.heic = make_heic(cls.dirs["input"], pic, np.full((16, 32), 0.5, np.float32), apple_exif())

    @classmethod
    def tearDownClass(cls):
        for k in [k for k in sys.modules if k == cls.pkg or k.startswith(cls.pkg + ".")]:
            sys.modules.pop(k, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_c(self, fn):
        import asyncio
        from aiohttp.test_utils import TestClient, TestServer

        async def go():
            app = web.Application(client_max_size=1 << 28)
            for r in self.app.router.routes():
                app.router.add_route(r.method, r.resource.canonical, r.handler)
            async with TestClient(TestServer(app)) as client:
                return await fn(client)
        return asyncio.run(go())

    def test_a_portrait_cinematic_film_as_a_plate(self):
        from PIL import Image

        async def go(c):
            r = await c.get("/imageviewer/mm_plate", params={"path": self.film})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertEqual((d["width"], d["height"], d["turn"]), (240, 320, 90))
            self.assertEqual(d["camera"]["model"], "iPhone 14")
            self.assertTrue(d["camera"]["phone"]["depth"])
            r = await c.get("/imageviewer/mm_frame", params={"path": self.film, "frame": 1, "size": 400})
            im = Image.open(io.BytesIO(await r.read()))
            self.assertEqual(im.size, (240, 320))                           # upright
            r = await c.get("/imageviewer/mm_phone_depth_view", params={"path": self.film, "frame": 2})
            self.assertEqual(r.status, 200)
            dv = Image.open(io.BytesIO(await r.read()))
            self.assertEqual(dv.size, (240, 320))
            r = await c.get("/imageviewer/mm_phone", params={"path": self.film})
            d = await r.json()
            self.assertEqual(d["depth"]["type"], "dish")
            r = await c.post("/imageviewer/mm_phone_export", json={"path": self.film, "every": 4})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertEqual(d["frames"], 3)
            self.assertEqual((d["width"], d["height"]), (120, 160))
        self.run_c(go)

    def test_a_heic_as_a_plate(self):
        async def go(c):
            r = await c.get("/imageviewer/mm_plate", params={"path": self.heic})
            d = await r.json()
            self.assertEqual(r.status, 200, d)
            self.assertTrue(d["path"].endswith(".png"))
            self.assertEqual((d["width"], d["height"]), (64, 128))
            self.assertEqual(d["camera"]["model"], "iPhone 14")
            self.assertAlmostEqual(d["camera"]["focal_mm"], 5.7)
            self.assertTrue(os.path.isfile(d["camera"]["phone"]["depth_file"]))
        self.run_c(go)


if __name__ == "__main__":
    unittest.main()
