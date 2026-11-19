"""What an iPhone writes into its films and photos, read straight from the file.

Written from the published QuickTime / ISO base media file format and HEIF layouts (boxes, sample tables,
metadata keys, item properties); no code of any other reader. Only numpy, Pillow and PyAV (ComfyUI's own HEVC
decoder) are used.

A film (.mov / .mp4) gives:
  - the movie's metadata keys (``com.apple.quicktime.make`` / ``model`` / ``software`` /
    ``camera.lens_model`` / ``camera.focal_length.35mm_equivalent`` / ``location.ISO6709`` ...),
  - every track: what it is (handler, sample type, size, rate, rotation),
  - the timed metadata tracks (``mebx``): every key and what its samples say,
  - a Cinematic film's DEPTH: a second, HEVC-coded track that is not marked as video (sample type ``dish``,
    a "video map"), low resolution, read sample by sample and decoded here.
A photo (.heic / .heif) gives its EXIF, its picture (tiles put together, turned as it is shown) and a Portrait
photo's depth (an auxiliary picture) with the depth's own XMP.

The stock Camera app records no motion samples (gyro / accelerometer) and no LiDAR depth; where a timed
metadata key looks like motion it is still listed.
"""

import math
import os
import re
import struct

import numpy as np

MAX_MOOV = 64 << 20         # a movie box beyond this is not read
MAX_ITEM = 64 << 20         # one HEIF item
MAX_TIMED_SAMPLES = 4000    # timed metadata samples read per track
VIDEO_EXTS = (".mov", ".mp4", ".m4v", ".qt")
PHOTO_EXTS = (".heic", ".heif", ".hif")
DEPTH_SAMPLE_TYPES = ("dish",)          # a Cinematic film's disparity track
HEVC_TYPES = ("hvc1", "hev1", "dish")
CONTAINERS = {"moov", "trak", "mdia", "minf", "stbl", "udta", "edts", "dinf", "iprp", "ipco", "mvex", "tref"}


class PhoneError(Exception):
    pass


# ── boxes ────────────────────────────────────────────────────────────────────

def iter_boxes(buf, start=0, end=None):
    """(type, payload start, payload end) of every box in buf[start:end]."""
    end = len(buf) if end is None else end
    i = start
    while i + 8 <= end:
        size, = struct.unpack_from(">I", buf, i)
        typ = bytes(buf[i + 4:i + 8]).decode("latin-1")
        head = 8
        if size == 1:
            if i + 16 > end:
                return
            size, = struct.unpack_from(">Q", buf, i + 8)
            head = 16
        elif size == 0:
            size = end - i
        if size < head or i + size > end:
            return
        yield typ, i + head, i + size
        i += size


def child(buf, s, e, typ, skip=0):
    for t, a, b in iter_boxes(buf, s + skip, e):
        if t == typ:
            return a, b
    return None


def children(buf, s, e, typ, skip=0):
    return [(a, b) for t, a, b in iter_boxes(buf, s + skip, e) if t == typ]


def _file_boxes(fh, size):
    """(type, payload start, payload end) of the top-level boxes of an open file, by seeking."""
    i = 0
    while i + 8 <= size:
        fh.seek(i)
        head = fh.read(16)
        if len(head) < 8:
            return
        n, = struct.unpack_from(">I", head, 0)
        typ = head[4:8].decode("latin-1")
        h = 8
        if n == 1:
            n, = struct.unpack_from(">Q", head, 8)
            h = 16
        elif n == 0:
            n = size - i
        if n < h:
            return
        yield typ, i + h, min(i + n, size)
        i += n


def _read_at(fh, off, n):
    fh.seek(off)
    return fh.read(n)


# ── values ───────────────────────────────────────────────────────────────────

# QuickTime's well-known data types (the 'data' atom's type / a timed key's 'dtyp')
def decode_value(t, raw):
    raw = bytes(raw)
    try:
        if t in (1, 4):                      # UTF-8, UTF-8 sort
            return raw.decode("utf-8", "replace").rstrip("\x00")
        if t in (2, 5):
            return raw.decode("utf-16-be", "replace").rstrip("\x00")
        if t == 23 and len(raw) >= 4:
            return _clean_float(struct.unpack(">f", raw[:4])[0]) if len(raw) == 4 else [
                _clean_float(v) for v in struct.unpack(f">{len(raw) // 4}f", raw[:len(raw) // 4 * 4])]
        if t == 24 and len(raw) >= 8:
            return _clean_float(struct.unpack(">d", raw[:8])[0]) if len(raw) == 8 else [
                _clean_float(v) for v in struct.unpack(f">{len(raw) // 8}d", raw[:len(raw) // 8 * 8])]
        if t in (21, 65, 66, 67, 74):        # signed big-endian integers
            return int.from_bytes(raw, "big", signed=True) if raw else None
        if t in (22, 75, 76, 77, 78):        # unsigned
            return int.from_bytes(raw, "big", signed=False) if raw else None
        if t == 70 and len(raw) == 8:        # a point (2 x float32)
            return [_clean_float(v) for v in struct.unpack(">2f", raw)]
        if t == 71 and len(raw) == 8:        # a dimensions (2 x float32)
            return [_clean_float(v) for v in struct.unpack(">2f", raw)]
        if t == 72 and len(raw) == 16:       # a rect (4 x float32)
            return [_clean_float(v) for v in struct.unpack(">4f", raw)]
        if t == 79 and len(raw) == 36:       # a 3x3 float32 matrix
            return [_clean_float(v) for v in struct.unpack(">9f", raw)]
        if t == 80 and len(raw) == 72:
            return [_clean_float(v) for v in struct.unpack(">9d", raw)]
    except (struct.error, ValueError):
        pass
    if raw and all(32 <= c < 127 or c in (9, 10, 13) for c in raw.rstrip(b"\x00")):
        return raw.rstrip(b"\x00").decode("ascii")
    return {"bytes": len(raw)}


def _clean_float(v):
    return round(v, 6) if math.isfinite(v) else None


def _num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


# ── the movie's metadata ─────────────────────────────────────────────────────

def read_meta_keys(buf, s, e):
    """A QuickTime 'meta' box ('hdlr' mdta, 'keys', 'ilst') as {key: value}. The box may or may not have a
    full-box header (QuickTime's has none, ISO's has four bytes); both are tried."""
    for skip in (0, 4):
        keys = child(buf, s, e, "keys", skip)
        ilst = child(buf, s, e, "ilst", skip)
        if keys and ilst:
            break
    else:
        return {}
    ks, ke = keys
    names = []
    if ke - ks >= 8:
        n, = struct.unpack_from(">I", buf, ks + 4)
        i = ks + 8
        for _ in range(n):
            if i + 8 > ke:
                break
            size, = struct.unpack_from(">I", buf, i)
            if size < 8:
                break
            names.append(bytes(buf[i + 8:i + size]).decode("utf-8", "replace"))
            i += size
    out = {}
    for t, a, b in iter_boxes(buf, *ilst):
        idx = struct.unpack(">I", t.encode("latin-1"))[0]
        if not 1 <= idx <= len(names):
            continue
        d = child(buf, a, b, "data")
        if not d or d[1] - d[0] < 8:
            continue
        typ, = struct.unpack_from(">I", buf, d[0])
        out[names[idx - 1]] = decode_value(typ & 0xFFFFFF, buf[d[0] + 8:d[1]])
    return out


def read_udta(buf, s, e):
    """The older user-data atoms (©mak, ©mod, ©xyz, ©swr ...) as {name: text}."""
    out = {}
    for t, a, b in iter_boxes(buf, s, e):
        if t.startswith("\xa9") and b - a >= 4:
            n, _lang = struct.unpack_from(">HH", buf, a)
            if 0 < n <= b - a - 4:
                out[t.replace("\xa9", "©")] = bytes(buf[a + 4:a + 4 + n]).decode("utf-8", "replace").rstrip("\x00")
    return out


# ── tracks ───────────────────────────────────────────────────────────────────

def _matrix_rotation(m):
    """The turn (0, 90, 180, 270, clockwise as shown) of a track header's matrix."""
    a, b, c, d = m[0], m[1], m[3], m[4]
    if abs(a) < 1e-6 and abs(d) < 1e-6:
        return 90 if b > 0 else 270
    if a < 0 and d < 0:
        return 180
    return 0


def _fixed16(v):
    return v / 65536.0


def read_track(buf, s, e):
    """One 'trak' box: {id, handler, type, width, height, rotation, timescale, duration, samples (offset, size,
    time, sync), entry (start, end of the sample entry), meta (track-level keys)}."""
    tr = {"handler": "", "type": "", "samples": []}
    tk = child(buf, s, e, "tkhd")
    if tk:
        a, b = tk
        ver = buf[a]
        o = a + 4
        if ver == 1:
            tr["id"], = struct.unpack_from(">I", buf, o + 16)
            o += 8 + 8 + 4 + 4 + 8
        else:
            tr["id"], = struct.unpack_from(">I", buf, o + 8)
            o += 4 + 4 + 4 + 4 + 4
        o += 8 + 2 + 2 + 2 + 2          # reserved, layer, alternate group, volume, reserved
        if o + 36 + 8 <= b:
            m = struct.unpack_from(">9i", buf, o)
            tr["rotation"] = _matrix_rotation([_fixed16(v) for v in m])
            w, h = struct.unpack_from(">II", buf, o + 36)
            tr["width"], tr["height"] = round(_fixed16(w)), round(_fixed16(h))
    md = child(buf, s, e, "mdia")
    if not md:
        return tr
    mh = child(buf, *md, "mdhd")
    if mh:
        a, _b = mh
        if buf[a] == 1:
            tr["timescale"], tr["duration"] = struct.unpack_from(">IQ", buf, a + 4 + 16)
        else:
            tr["timescale"], tr["duration"] = struct.unpack_from(">II", buf, a + 4 + 8)
    hd = child(buf, *md, "hdlr")
    if hd:
        tr["handler"] = bytes(buf[hd[0] + 8:hd[0] + 12]).decode("latin-1")
        tr["handler_name"] = bytes(buf[hd[0] + 24:hd[1]]).decode("utf-8", "replace").strip("\x00 ").lstrip("\x0c")
    mi = child(buf, *md, "minf")
    st = child(buf, *mi, "stbl") if mi else None
    if not st:
        return tr
    sd = child(buf, *st, "stsd")
    if sd and sd[1] - sd[0] >= 16:
        a = sd[0] + 8                 # version/flags + entry count
        size, = struct.unpack_from(">I", buf, a)
        tr["type"] = bytes(buf[a + 4:a + 8]).decode("latin-1")
        tr["entry"] = (a + 8, min(a + size, sd[1]))
        if tr["type"] in HEVC_TYPES or tr["handler"] == "vide":
            # a visual sample entry: 6 reserved + 2 index + 16 pre-defined, then width, height
            if a + 8 + 28 <= sd[1]:
                w, h = struct.unpack_from(">HH", buf, a + 8 + 24)
                tr.setdefault("coded", [w, h])
    tr["samples"] = sample_table(buf, *st)
    if tr.get("timescale") and tr["samples"]:
        tr["rate"] = round(len(tr["samples"]) / max(1e-9, tr["duration"] / tr["timescale"]), 4) if tr.get("duration") else None
    meta = child(buf, s, e, "meta")
    if meta:
        tr["meta"] = read_meta_keys(buf, *meta)
    return tr


def sample_table(buf, s, e):
    """[(offset, size, time in timescale units, is sync)] from stsz / stz2, stsc, stco / co64, stts, stss."""
    sizes = []
    z = child(buf, s, e, "stsz")
    if z:
        a, b = z
        one, n = struct.unpack_from(">II", buf, a + 4)
        if one:
            sizes = [one] * n
        else:
            n = min(n, (b - a - 12) // 4)
            sizes = list(struct.unpack_from(f">{n}I", buf, a + 12))
    if not sizes:
        return []
    chunks = []
    c = child(buf, s, e, "stco")
    if c:
        n, = struct.unpack_from(">I", buf, c[0] + 4)
        n = min(n, (c[1] - c[0] - 8) // 4)
        chunks = list(struct.unpack_from(f">{n}I", buf, c[0] + 8))
    else:
        c = child(buf, s, e, "co64")
        if c:
            n, = struct.unpack_from(">I", buf, c[0] + 4)
            n = min(n, (c[1] - c[0] - 8) // 8)
            chunks = list(struct.unpack_from(f">{n}Q", buf, c[0] + 8))
    runs = []
    sc = child(buf, s, e, "stsc")
    if sc:
        n, = struct.unpack_from(">I", buf, sc[0] + 4)
        n = min(n, (sc[1] - sc[0] - 8) // 12)
        runs = [struct.unpack_from(">III", buf, sc[0] + 8 + 12 * k) for k in range(n)]
    if not chunks or not runs:
        return []
    offsets = []
    k = 0
    for ci, off in enumerate(chunks, start=1):
        while k + 1 < len(runs) and runs[k + 1][0] <= ci:
            k += 1
        per = runs[k][1]
        for _ in range(per):
            if len(offsets) >= len(sizes):
                break
            offsets.append(off)
            off += sizes[len(offsets) - 1]
    times = []
    tt = child(buf, s, e, "stts")
    t = 0
    if tt:
        n, = struct.unpack_from(">I", buf, tt[0] + 4)
        for j in range(min(n, (tt[1] - tt[0] - 8) // 8)):
            cnt, d = struct.unpack_from(">II", buf, tt[0] + 8 + 8 * j)
            for _ in range(cnt):
                if len(times) >= len(sizes):
                    break
                times.append(t)
                t += d
    while len(times) < len(sizes):
        times.append(t)
    sync = None
    ss = child(buf, s, e, "stss")
    if ss:
        n, = struct.unpack_from(">I", buf, ss[0] + 4)
        n = min(n, (ss[1] - ss[0] - 8) // 4)
        sync = set(struct.unpack_from(f">{n}I", buf, ss[0] + 8))
    return [(offsets[i], sizes[i], times[i], sync is None or (i + 1) in sync) for i in range(len(offsets))]


# ── timed metadata ───────────────────────────────────────────────────────────

def mebx_keys(buf, s, e):
    """A 'mebx' sample entry's keys: {local id: (key name, well-known type or None)}."""
    out = {}
    ks = child(buf, s, e, "keys", 8)         # after the 8-byte sample entry header (reserved + index)
    if not ks:
        ks = child(buf, s, e, "keys")
    if not ks:
        return out
    for t, a, b in iter_boxes(buf, *ks):
        lid = struct.unpack(">I", t.encode("latin-1"))[0]
        name, dtype = None, None
        kd = child(buf, a, b, "keyd")
        if kd and kd[1] - kd[0] >= 4:
            name = bytes(buf[kd[0] + 4:kd[1]]).decode("utf-8", "replace")
        dt = child(buf, a, b, "dtyp")
        if dt and dt[1] - dt[0] >= 8:
            ns, = struct.unpack_from(">I", buf, dt[0])
            if ns == 0:
                dtype, = struct.unpack_from(">I", buf, dt[0] + 4)
        if name:
            out[lid] = (name, dtype)
    return out


def mebx_sample(data, keys):
    """One timed metadata sample: {key name: value}."""
    out = {}
    for t, a, b in iter_boxes(data):
        lid = struct.unpack(">I", t.encode("latin-1"))[0]
        if lid not in keys:
            continue
        name, dtype = keys[lid]
        out[name] = decode_value(dtype, data[a:b]) if dtype is not None else decode_value(-1, data[a:b])
    return out


MOTION_WORDS = re.compile(r"gyro|accel|motion|attitude|quaternion|rotation-rate|gravity|imu", re.I)


def _summary(vals):
    """What a key's samples say: {samples, first, last, distinct (up to 8 seen), changes}."""
    seen, changes = [], 0
    for i, v in enumerate(vals):
        if i and repr(v) != repr(vals[i - 1]):
            changes += 1
        if len(seen) < 8 and all(repr(x) != repr(v) for x in seen):
            seen.append(v)
    return {"samples": len(vals), "first": vals[0] if vals else None, "last": vals[-1] if vals else None,
            "distinct": seen, "changes": changes}


# ── a film ───────────────────────────────────────────────────────────────────

def _load_moov(path):
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        for typ, a, b in _file_boxes(fh, size):
            if typ == "moov":
                if b - a > MAX_MOOV:
                    raise PhoneError("the movie box is too big to read")
                return memoryview(bytearray(_read_at(fh, a, b - a))), size
    raise PhoneError("not a QuickTime / MP4 film (no movie box)")


_CACHE = {}


def read_film(path, timed=True):
    """Everything the film says: {keys, udta, tracks [{id, handler, type, width, height, rotation, rate, samples:
    count, role}], timed {key: summary}, motion [keys], cinematic, depth {track, width, height, samples, rate},
    picture {track, width, height, rotation}}."""
    st = os.stat(path)
    ck = (os.path.abspath(path), st.st_size, st.st_mtime_ns, bool(timed))
    if ck in _CACHE:
        return _CACHE[ck]
    buf, _size = _load_moov(path)
    n = len(buf)
    out = {"keys": {}, "udta": {}, "tracks": [], "timed": {}, "motion": [], "cinematic": False, "depth": None,
           "picture": None}
    meta = child(buf, 0, n, "meta")
    if meta:
        out["keys"] = read_meta_keys(buf, *meta)
    ud = child(buf, 0, n, "udta")
    if ud:
        out["udta"] = read_udta(buf, *ud)
        um = child(buf, *ud, "meta")
        if um:
            for k, v in read_meta_keys(buf, *um).items():
                out["keys"].setdefault(k, v)
    tracks = []
    for a, b in children(buf, 0, n, "trak"):
        tr = read_track(buf, a, b)
        tr["_buf"] = (a, b)
        tracks.append(tr)
    pic = None
    for tr in tracks:
        if tr["handler"] == "vide" and tr["type"] not in DEPTH_SAMPLE_TYPES:
            if pic is None or (tr.get("width", 0) * tr.get("height", 0)) > (pic.get("width", 0) * pic.get("height", 0)):
                pic = tr
    if pic is not None:
        out["picture"] = {"track": pic.get("id"), "width": pic.get("width"), "height": pic.get("height"),
                          "rotation": pic.get("rotation", 0), "rate": pic.get("rate"), "type": pic["type"],
                          "frames": len(pic["samples"])}
    with open(path, "rb") as fh:
        for tr in tracks:
            role = "other"
            if tr is pic:
                role = "picture"
            elif tr["type"] in DEPTH_SAMPLE_TYPES or (tr["type"] in HEVC_TYPES and tr["handler"] != "vide"):
                role = "depth"
            elif tr["handler"] == "soun":
                role = "sound"
            elif tr["type"] == "mebx" or tr["handler"] == "meta":
                role = "timed metadata"
            elif tr["handler"] == "vide":
                role = "video"
            tr["role"] = role
            if role == "depth" and out["depth"] is None:
                wh = _hevc_size(buf, tr) or tr.get("coded") or [tr.get("width"), tr.get("height")]
                out["depth"] = {"track": tr.get("id"), "type": tr["type"], "width": wh[0], "height": wh[1],
                                "samples": len(tr["samples"]), "rate": tr.get("rate"),
                                "rotation": tr.get("rotation", 0)}
                out["cinematic"] = True
            if role == "timed metadata" and timed and tr["type"] == "mebx" and tr.get("entry"):
                keys = mebx_keys(buf, *tr["entry"])
                if not keys:
                    continue
                vals = {}
                samples = tr["samples"]
                step = max(1, len(samples) // MAX_TIMED_SAMPLES)
                for off, size, _t, _sync in samples[::step]:
                    if size > 1 << 20:
                        continue
                    for k, v in mebx_sample(memoryview(_read_at(fh, off, size)), keys).items():
                        vals.setdefault(k, []).append(v)
                for k, v in vals.items():
                    out["timed"][k] = _summary(v)
                    out["timed"][k]["track"] = tr.get("id")
                    if MOTION_WORDS.search(k):
                        out["motion"].append(k)
                for _lid, (k, _t) in keys.items():
                    if "cinematic" in k.lower() or "disparity" in k.lower() or "focus" in k.lower():
                        out["cinematic"] = out["cinematic"] or "cinematic" in k.lower()
            if tr.get("meta"):
                for k in tr["meta"]:
                    if "cinematic" in k.lower():
                        out["cinematic"] = True
    for k in out["keys"]:
        if "cinematic" in k.lower():
            out["cinematic"] = True
    out["tracks"] = [{k: v for k, v in tr.items() if k not in ("samples", "_buf", "entry")} | {"samples": len(tr["samples"])}
                     for tr in tracks]
    out["_tracks"] = tracks
    out["_buf"] = buf
    if len(_CACHE) > 8:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[ck] = out
    return out


def public(info):
    """A read_film / read_photo answer without its private parts (for JSON)."""
    return {k: v for k, v in info.items() if not k.startswith("_")}


# ── HEVC ─────────────────────────────────────────────────────────────────────

def hvcc_parameter_sets(cfg):
    """An 'hvcC' box's payload -> (NAL length size, [parameter set NAL units])."""
    cfg = bytes(cfg)
    if len(cfg) < 23:
        raise PhoneError("a short HEVC configuration")
    nal_len = (cfg[21] & 3) + 1
    arrays = cfg[22]
    i, nals = 23, []
    for _ in range(arrays):
        if i + 3 > len(cfg):
            break
        cnt, = struct.unpack_from(">H", cfg, i + 1)
        i += 3
        for _ in range(cnt):
            if i + 2 > len(cfg):
                break
            ln, = struct.unpack_from(">H", cfg, i)
            nals.append(cfg[i + 2:i + 2 + ln])
            i += 2 + ln
    return nal_len, nals


def to_annexb(sample, nal_len):
    """Length-prefixed NAL units -> a start-code stream."""
    sample = bytes(sample)
    out, i = bytearray(), 0
    while i + nal_len <= len(sample):
        ln = int.from_bytes(sample[i:i + nal_len], "big")
        i += nal_len
        if ln <= 0 or i + ln > len(sample):
            break
        out += b"\x00\x00\x00\x01" + sample[i:i + ln]
        i += ln
    return bytes(out)


def _find_box(buf, s, e, typ):
    """A box of that type anywhere in buf[s:e] (a sample entry's own fields come before its boxes, and how
    many there are depends on the entry's kind, so the boxes are searched for)."""
    tb = typ.encode("latin-1")
    raw = bytes(buf[s:e])
    i = raw.find(tb)
    while i >= 4:
        size, = struct.unpack_from(">I", raw, i - 4)
        if 8 <= size <= len(raw) - (i - 4):
            return s + i + 4, s + i - 4 + size
        i = raw.find(tb, i + 1)
    return None


def _hevc_config(buf, tr):
    if not tr.get("entry"):
        return None
    got = _find_box(buf, *tr["entry"], "hvcC")
    return bytes(buf[got[0]:got[1]]) if got else None


def _hevc_size(buf, tr):
    """(width, height) of a track's HEVC pictures from its SPS, or None."""
    cfg = _hevc_config(buf, tr)
    if not cfg:
        return None
    try:
        _n, nals = hvcc_parameter_sets(cfg)
    except PhoneError:
        return None
    for nal in nals:
        if len(nal) > 2 and (nal[0] >> 1) & 0x3F == 33:
            wh = _sps_size(nal)
            if wh:
                return wh
    return None


class _Bits:
    def __init__(self, data):
        # emulation prevention bytes out
        out, z = bytearray(), 0
        for b in data:
            if z >= 2 and b == 3:
                z = 0
                continue
            out.append(b)
            z = z + 1 if b == 0 else 0
        self.d, self.i = bytes(out), 0

    def u(self, n):
        v = 0
        for _ in range(n):
            byte = self.d[self.i >> 3] if (self.i >> 3) < len(self.d) else 0
            v = (v << 1) | ((byte >> (7 - (self.i & 7))) & 1)
            self.i += 1
        return v

    def ue(self):
        z = 0
        while self.u(1) == 0 and z < 32:
            z += 1
        return (1 << z) - 1 + self.u(z)


def _sps_size(nal):
    """The picture size an HEVC SPS states (less its conformance window)."""
    try:
        b = _Bits(nal[2:])
        b.u(4)
        max_sub = b.u(3)
        b.u(1)
        # profile_tier_level
        b.u(2 + 1 + 5 + 32 + 4 + 43 + 1 + 8)
        sub_p, sub_l = [], []
        for _ in range(max_sub):
            sub_p.append(b.u(1))
            sub_l.append(b.u(1))
        if max_sub > 0:
            for _ in range(max_sub, 8):
                b.u(2)
        for k in range(max_sub):
            if sub_p[k]:
                b.u(88)
            if sub_l[k]:
                b.u(8)
        b.ue()
        chroma = b.ue()
        if chroma == 3:
            b.u(1)
        w, h = b.ue(), b.ue()
        if b.u(1):
            l, r, t, bo = b.ue(), b.ue(), b.ue(), b.ue()
            sx = 2 if chroma in (1, 2) else 1
            sy = 2 if chroma == 1 else 1
            w -= (l + r) * sx
            h -= (t + bo) * sy
        if 0 < w < 20000 and 0 < h < 20000:
            return [w, h]
    except (IndexError, ValueError):
        pass
    return None


def _decoder(cfg):
    import av
    nal_len, nals = hvcc_parameter_sets(cfg)
    ctx = av.CodecContext.create("hevc", "r")
    head = b"".join(b"\x00\x00\x00\x01" + n for n in nals)
    return ctx, nal_len, head


def _plane(frame):
    """A decoded frame's luma as float32 0..1."""
    fmt = frame.format.name
    if fmt.startswith(("gray", "yuv")):
        bits = 16 if ("16" in fmt or "10" in fmt or "12" in fmt) else 8
        if fmt.startswith("gray"):
            a = frame.to_ndarray()
        else:
            a = frame.to_ndarray(format="gray16le" if bits == 16 else "gray")
        a = a.astype(np.float32)
        if bits == 16:
            depth = 10 if "10" in fmt else 12 if "12" in fmt else 16
            if a.max() > (1 << depth):     # PyAV gave it scaled to 16 bits
                depth = 16
            return a / float((1 << depth) - 1)
        return a / 255.0
    return frame.to_ndarray(format="gray").astype(np.float32) / 255.0


def depth_samples(path, wanted_times):
    """The Cinematic depth track's pictures nearest to *wanted_times* (seconds): {time: (sample time, float32 [H,
    W] 0..1)}. Each is decoded from the sync sample before it."""
    info = read_film(path, timed=False)
    if not info.get("depth"):
        raise PhoneError("this film has no depth track (only Cinematic mode films have one, and only the "
                         "unmodified original keeps it)")
    tr = next(t for t in info["_tracks"] if t.get("id") == info["depth"]["track"])
    cfg = _hevc_config(info["_buf"], tr)
    if not cfg:
        raise PhoneError(f"the depth track ({tr['type']}) has no HEVC configuration this reader knows")
    samples = tr["samples"]
    if not samples:
        raise PhoneError("the depth track has no samples")
    ts = float(tr.get("timescale") or 600)
    times = np.asarray([s[2] / ts for s in samples])
    out = {}
    with open(path, "rb") as fh:
        for want in sorted(set(float(t) for t in wanted_times)):
            j = int(np.argmin(np.abs(times - want)))
            k = j
            while k > 0 and not samples[k][3]:
                k -= 1
            ctx, nal_len, head = _decoder(cfg)
            import av
            got = None
            for q in range(k, j + 1):
                off, size, _t, _s = samples[q]
                data = to_annexb(_read_at(fh, off, size), nal_len)
                if q == k:
                    data = head + data
                for fr in ctx.decode(av.Packet(data)):
                    got = fr
            for fr in ctx.decode(None):
                got = fr
            if got is not None:
                out[want] = (float(times[j]), _plane(got))
    return out


def depth_from_disparity(disp, lo=1.0 / 255):
    """A disparity picture (bright = near) as a depth (larger = farther) up to one scale: 1 / disparity, no depth
    (inf) where it is 0."""
    d = np.asarray(disp, np.float32)
    out = np.full(d.shape, np.inf, np.float32)
    ok = d > lo
    out[ok] = 1.0 / d[ok]
    return out


# ── a photo ──────────────────────────────────────────────────────────────────

def _items(buf, s, e):
    """A HEIF 'meta' box -> {primary, items {id: {type, name, props [...], data [(offset, len)], method}},
    refs [(type, from, [to])]}."""
    out = {"primary": None, "items": {}, "refs": []}
    pm = child(buf, s, e, "pitm", 4)
    if pm:
        out["primary"] = struct.unpack_from(">H" if buf[pm[0]] == 0 else ">I", buf, pm[0] + 4)[0]
    inf = child(buf, s, e, "iinf", 4)
    if inf:
        ver = buf[inf[0]]
        start = inf[0] + 4 + (2 if ver == 0 else 4)
        for t, a, b in iter_boxes(buf, start, inf[1]):
            if t != "infe":
                continue
            v = buf[a]
            if v < 2:
                continue
            if v == 2:
                iid, = struct.unpack_from(">H", buf, a + 4)
                o = a + 8
            else:
                iid, = struct.unpack_from(">I", buf, a + 4)
                o = a + 10
            typ = bytes(buf[o:o + 4]).decode("latin-1")
            rest = bytes(buf[o + 4:b]).split(b"\x00")
            it = {"type": typ, "name": rest[0].decode("utf-8", "replace") if rest else "", "props": [], "data": []}
            if typ == "mime" and len(rest) > 1:
                it["content_type"] = rest[1].decode("utf-8", "replace")
            out["items"][iid] = it
    ref = child(buf, s, e, "iref", 4)
    if ref:
        ver = buf[ref[0]]
        w = 2 if ver == 0 else 4
        f = ">H" if w == 2 else ">I"
        for t, a, b in iter_boxes(buf, ref[0] + 4, ref[1]):
            fr, = struct.unpack_from(f, buf, a)
            cnt, = struct.unpack_from(">H", buf, a + w)
            to = [struct.unpack_from(f, buf, a + w + 2 + w * k)[0] for k in range(cnt) if a + w + 2 + w * (k + 1) <= b]
            out["refs"].append((t, fr, to))
    pr = child(buf, s, e, "iprp", 4) or child(buf, s, e, "iprp")
    if pr:
        co = child(buf, *pr, "ipco")
        props = [(t, a, b) for t, a, b in iter_boxes(buf, *co)] if co else []
        for a, b in children(buf, *pr, "ipma"):
            ver, flags = buf[a], int.from_bytes(bytes(buf[a + 1:a + 4]), "big")
            cnt, = struct.unpack_from(">I", buf, a + 4)
            o = a + 8
            for _ in range(cnt):
                if ver < 1:
                    iid, = struct.unpack_from(">H", buf, o)
                    o += 2
                else:
                    iid, = struct.unpack_from(">I", buf, o)
                    o += 4
                na = buf[o]
                o += 1
                for _ in range(na):
                    if flags & 1:
                        v, = struct.unpack_from(">H", buf, o)
                        idx = v & 0x7FFF
                        o += 2
                    else:
                        idx = buf[o] & 0x7F
                        o += 1
                    if 1 <= idx <= len(props) and iid in out["items"]:
                        out["items"][iid]["props"].append(props[idx - 1])
    lo = child(buf, s, e, "iloc", 4)
    if lo:
        a = lo[0]
        ver = buf[a]
        o = a + 4
        b1, b2 = buf[o], buf[o + 1]
        off_s, len_s, base_s = b1 >> 4, b1 & 15, b2 >> 4
        idx_s = (b2 & 15) if ver in (1, 2) else 0
        o += 2
        if ver < 2:
            cnt, = struct.unpack_from(">H", buf, o)
            o += 2
        else:
            cnt, = struct.unpack_from(">I", buf, o)
            o += 4

        def rd(n):
            nonlocal o
            v = int.from_bytes(bytes(buf[o:o + n]), "big") if n else 0
            o += n
            return v
        for _ in range(cnt):
            iid = rd(2 if ver < 2 else 4)
            method = 0
            if ver in (1, 2):
                method = rd(2) & 15
            rd(2)                                  # data reference index
            base = rd(base_s)
            ext = rd(2)
            parts = []
            for _ in range(ext):
                if idx_s:
                    rd(idx_s)
                eo, el = rd(off_s), rd(len_s)
                parts.append((base + eo, el))
            if iid in out["items"]:
                out["items"][iid]["data"] = parts
                out["items"][iid]["method"] = method
    idat = child(buf, s, e, "idat", 4)
    out["idat"] = bytes(buf[idat[0]:idat[1]]) if idat else b""
    return out


def _item_bytes(fh, it, idat):
    total = sum(n for _o, n in it["data"])
    if total > MAX_ITEM:
        raise PhoneError("an item is too big")
    if it.get("method") == 1:
        return b"".join(idat[o:o + n] for o, n in it["data"])
    return b"".join(_read_at(fh, o, n) for o, n in it["data"])


def _prop(buf, it, typ):
    for t, a, b in it["props"]:
        if t == typ:
            return a, b
    return None


def _decode_hvc_item(fh, buf, meta, iid):
    it = meta["items"][iid]
    cfg = _prop(buf, it, "hvcC")
    if not cfg:
        raise PhoneError(f"item {iid} has no HEVC configuration")
    import av
    ctx, nal_len, head = _decoder(bytes(buf[cfg[0]:cfg[1]]))
    frames = list(ctx.decode(av.Packet(head + to_annexb(_item_bytes(fh, it, meta["idat"]), nal_len))))
    frames += list(ctx.decode(None))
    if not frames:
        raise PhoneError(f"item {iid} could not be decoded")
    return frames[0]


def _decode_image(fh, buf, meta, iid, gray=False):
    """An item ('hvc1' or a 'grid' of them) as an array: [H, W, 3] uint8, or [H, W] float32 0..1 with *gray*."""
    it = meta["items"][iid]
    if it["type"] == "grid":
        data = _item_bytes(fh, it, meta["idat"])
        flags = data[1]
        rows, cols = data[2] + 1, data[3] + 1
        if flags & 1:
            W, H = struct.unpack_from(">II", data, 4)
        else:
            W, H = struct.unpack_from(">HH", data, 4)
        tiles = next((to for t, fr, to in meta["refs"] if t == "dimg" and fr == iid), [])
        if len(tiles) < rows * cols:
            raise PhoneError("the picture's tiles are missing")
        parts = [_decode_image(fh, buf, meta, t, gray) for t in tiles[:rows * cols]]
        th, tw = parts[0].shape[:2]
        big = np.zeros((rows * th, cols * tw) + parts[0].shape[2:], parts[0].dtype)
        for k, p in enumerate(parts):
            r, c = divmod(k, cols)
            big[r * th:r * th + p.shape[0], c * tw:c * tw + p.shape[1]] = p
        img = big[:H, :W]
    elif it["type"] in ("hvc1", "hev1"):
        fr = _decode_hvc_item(fh, buf, meta, iid)
        img = _plane(fr) if gray else fr.to_ndarray(format="rgb24")
    else:
        raise PhoneError(f"a picture of kind '{it['type']}' is not read")
    return _turn(img, buf, it)


def _turn(img, buf, it):
    """An item's clean aperture, rotation and mirror applied, in the order HEIF lists them."""
    for t, a, b in it["props"]:
        if t == "irot":
            k = buf[a] & 3                 # anticlockwise quarter turns
            img = np.rot90(img, k)
        elif t == "imir":
            img = img[:, ::-1] if (buf[a] & 1) == 0 else img[::-1]   # 0: about the vertical axis
    return np.ascontiguousarray(img)


def _aux_type(buf, it):
    p = _prop(buf, it, "auxC")
    if not p:
        return ""
    return bytes(buf[p[0] + 4:p[1]]).split(b"\x00")[0].decode("utf-8", "replace")


def _xmp_fields(text):
    """The simple attributes and elements of an XMP packet: {prefix:name: value}."""
    out = {}
    for m in re.finditer(r'([A-Za-z][\w-]*:[A-Za-z][\w-]*)="([^"]*)"', text):
        if not m.group(1).startswith("xmlns:"):
            out[m.group(1)] = m.group(2)
    for m in re.finditer(r"<([A-Za-z][\w-]*:[A-Za-z][\w-]*)>([^<]{1,200})</\1>", text):
        out.setdefault(m.group(1), m.group(2).strip())
    for k, v in list(out.items()):
        n = _num(v)
        if n is not None and re.fullmatch(r"-?[\d.eE+-]+", v.strip() or "x"):
            out[k] = n
    return out


def _load_meta(path):
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        brand = None
        for typ, a, b in _file_boxes(fh, size):
            if typ == "ftyp":
                brand = _read_at(fh, a, 4).decode("latin-1")
            if typ == "meta":
                if b - a > MAX_MOOV:
                    raise PhoneError("the photo's meta box is too big")
                return memoryview(bytearray(_read_at(fh, a, b - a))), brand
    raise PhoneError("not a HEIF photo (no meta box)")


DEPTH_AUX = ("depth", "auxid:2", "disparity")


def read_photo(path, pictures=False):
    """A HEIC: {brand, width, height, exif (bytes, private), depth {item, type, width, height, xmp}, mattes [aux
    types], items}. With *pictures*: also ``_picture`` ([H, W, 3] uint8) and ``_depth`` (float32 0..1, as stored -
    Apple writes disparity / depth as it says in the depth's XMP)."""
    buf, brand = _load_meta(path)
    meta = _items(buf, 0, len(buf))
    if not meta["items"]:
        raise PhoneError("the photo lists no items")
    prim = meta["primary"]
    out = {"brand": brand, "primary": prim, "items": len(meta["items"]), "depth": None, "aux": []}
    it = meta["items"].get(prim)
    if it:
        sp = _prop(buf, it, "ispe")
        if sp:
            out["width"], out["height"] = struct.unpack_from(">II", buf, sp[0] + 4)
        for t, a, _b in it["props"]:
            if t == "irot" and buf[a] & 1:
                out["width"], out["height"] = out.get("height"), out.get("width")
    aux_of = {}
    for t, fr, to in meta["refs"]:
        if t == "auxl" and prim in to:
            aux_of[fr] = _aux_type(buf, meta["items"][fr]) if fr in meta["items"] else ""
    desc = {}
    for t, fr, to in meta["refs"]:
        if t == "cdsc":
            for x in to:
                desc.setdefault(x, []).append(fr)
    with open(path, "rb") as fh:
        for iid in desc.get(prim, []) + [i for i, v in meta["items"].items() if v["type"] == "Exif"]:
            v = meta["items"].get(iid)
            if v and v["type"] == "Exif" and "_exif" not in out:
                raw = _item_bytes(fh, v, meta["idat"])
                if len(raw) > 4:
                    skip, = struct.unpack_from(">I", raw, 0)
                    out["_exif"] = raw[4 + skip:]
        for iid, typ in aux_of.items():
            out["aux"].append(typ)
            if out["depth"] is None and any(w in typ.lower() for w in DEPTH_AUX):
                v = meta["items"][iid]
                sp = _prop(buf, v, "ispe")
                d = {"item": iid, "type": typ}
                if sp:
                    d["width"], d["height"] = struct.unpack_from(">II", buf, sp[0] + 4)
                for x in desc.get(iid, []):
                    m = meta["items"].get(x)
                    if m and m["type"] == "mime" and "xml" in m.get("content_type", ""):
                        d["xmp"] = _xmp_fields(_item_bytes(fh, m, meta["idat"]).decode("utf-8", "replace"))
                out["depth"] = d
        if pictures:
            out["_picture"] = _decode_image(fh, buf, meta, prim)
            if out["depth"]:
                out["_depth"] = _decode_image(fh, buf, meta, out["depth"]["item"], gray=True)
    return out


def depth_meaning(depth_info):
    """'disparity' (bright = near) or 'depth' (bright = far) from the depth's aux type / XMP; Apple's portrait
    depth is disparity unless it says otherwise."""
    x = depth_info.get("xmp") or {}
    txt = " ".join(f"{k}={v}" for k, v in x.items()).lower() + " " + str(depth_info.get("type", "")).lower()
    if "disparity" in txt:
        return "disparity"
    if re.search(r"(depth|format)\w*=\s*depth", txt):
        return "depth"
    return "disparity"


# ── camera facts ─────────────────────────────────────────────────────────────

LENS_RE = re.compile(r"(?P<mm>\d+(?:\.\d+)?)\s*mm(?:\s*f/?\s*(?P<f>\d+(?:\.\d+)?))?", re.I)


def lens_facts(text):
    """'iPhone 14 back dual wide camera 5.7mm f/1.5' -> {focal_mm 5.7, fnumber 1.5, side back, camera wide}."""
    out = {}
    t = str(text or "")
    m = LENS_RE.search(t)
    if m:
        out["focal_mm"] = float(m.group("mm"))
        if m.group("f"):
            out["fnumber"] = float(m.group("f"))
    low = t.lower()
    if "front" in low:
        out["side"] = "front"
    elif "back" in low or "rear" in low:
        out["side"] = "back"
    for k in ("ultra wide", "telephoto", "wide"):
        if k in low:
            out["camera"] = k
            break
    return out


K = "com.apple.quicktime."


def film_facts(path):
    """Camera facts for ``matchmove.camera_facts`` from a film's metadata (the iPhone's own keys and the older
    user data), plus ``phone`` - what else it holds (depth, timed keys, tracks)."""
    try:
        info = read_film(path)
    except (PhoneError, OSError, struct.error, ValueError, IndexError) as e:
        return {"_error": str(e)}
    keys = info["keys"]
    ud = info["udta"]
    out = {}

    def first(*names):
        for n in names:
            v = keys.get(n)
            if v not in (None, "", []):
                return v
        return None
    make = first(K + "make") or ud.get("©mak")
    model = first(K + "model") or ud.get("©mod")
    lens = first(K + "camera.lens_model", K + "lens_model")
    if make:
        out["make"] = str(make)
    if model:
        out["model"] = str(model)
    if lens:
        out["lens"] = str(lens)
        lf = lens_facts(lens)
        if lf.get("focal_mm"):
            out["focal_mm"] = lf["focal_mm"]
    f35 = _num(first(K + "camera.focal_length.35mm_equivalent", K + "focal_length.35mm_equivalent"))
    if f35 and 1 <= f35 <= 2000:
        out["focal35"] = f35
    fl = _num(first(K + "camera.focal_length", K + "focal_length"))
    if fl and 0.5 <= fl <= 2000:
        out.setdefault("focal_mm", fl)
    pic = info.get("picture") or {}
    dep = info.get("depth")
    out["phone"] = {
        "software": first(K + "software") or ud.get("©swr"),
        "created": first(K + "creationdate") or ud.get("©day"),
        "location": first(K + "location.ISO6709") or ud.get("©xyz"),
        "rotation": pic.get("rotation", 0),
        "rate": pic.get("rate"),
        "lens": lens_facts(lens) if lens else {},
        "cinematic": info["cinematic"],
        "depth": dep,
        "motion": info["motion"],
        "timed": sorted(info["timed"]),
        "tracks": [{k: t.get(k) for k in ("id", "role", "handler", "type", "width", "height", "samples", "rate")}
                   for t in info["tracks"]],
        "apple": bool(str(make or "").lower().startswith("apple") or "iphone" in str(model or "").lower()),
    }
    return out


def photo_facts(path):
    """Camera facts from a HEIC's EXIF (through Pillow's EXIF reader) and what else it holds."""
    try:
        info = read_photo(path)
    except (PhoneError, OSError, struct.error, ValueError, IndexError) as e:
        return {"_error": str(e)}
    out = {}
    raw = info.get("_exif")
    if raw:
        from . import matchmove as MM
        out.update(MM.exif_dict_facts(raw, info.get("width"), info.get("height")))
    if out.get("lens") and not out.get("focal_mm"):
        lf = lens_facts(out["lens"])
        if lf.get("focal_mm"):
            out["focal_mm"] = lf["focal_mm"]
    out["phone"] = {"depth": info.get("depth"), "aux": info.get("aux"), "width": info.get("width"),
                    "height": info.get("height"), "brand": info.get("brand")}
    return out


def is_film(path):
    return os.path.splitext(str(path))[1].lower() in VIDEO_EXTS


def is_photo(path):
    return os.path.splitext(str(path))[1].lower() in PHOTO_EXTS
