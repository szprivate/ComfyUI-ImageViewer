"""Comp outputs: Write nodes, multi-layer EXR, frame ranges with handles, timecode and metadata.

A Write node (``comp_model.NODE_TYPES["write"]``) passes its picture on unchanged; what it does happens here,
when a render asks for it: every Write in the graph (or the ones named) writes its own file pattern, type,
channels, colour and frames. Several Writes render in one pass over the frames, sharing the upstream work.

EXR is written by :func:`exr_bytes` from the published OpenEXR file layout (scanline, half or float, no / ZIPS /
ZIP compression, any number of named channels, string, timecode and rate attributes), so a multi-layer EXR needs
no extra library. Display-referred files (PNG, TIFF, JPEG) and films go through ``comp_io``'s writers, the Send to
Viewer node's.

Metadata travels down the B pipe (input 0): a Read gives its file's header, a Metadata node sets and removes keys,
a Write puts what arrives into its EXR headers with the comp's own keys (``imageviewer/*``).

No aiohttp or ComfyUI in here (the routes are in ``comp_routes.py``): the command-line render and the Python API
(``comp_api``) use it as it is.
"""
from __future__ import annotations

import fnmatch
import os
import re
import struct
import zlib
from fractions import Fraction

import numpy as np

from . import comp_io
from . import comp_model as M

FILM_TYPES = {"mov", "mp4", "webm"}
_EXT_TYPE = {".exr": "exr", ".png": "png", ".tif": "tiff", ".tiff": "tiff", ".jpg": "jpg", ".jpeg": "jpg",
             ".mov": "mov", ".mp4": "mp4", ".webm": "webm"}
_TC = re.compile(r"^\s*(\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})([:;.])(\d{1,3})\s*$")


class WriteError(ValueError):
    pass


# ── timecode ─────────────────────────────────────────────────────────────────

def parse_timecode(text, fps):
    """``HH:MM:SS:FF`` (``;`` before the frames = drop frame, read as plain counting) -> frames since 00:00:00:00,
    or None when it is no timecode."""
    m = _TC.match(str(text or ""))
    if not m:
        return None
    h, mi, s, _, f = m.groups()
    base = max(1, int(round(float(fps or 24))))
    return ((int(h) * 60 + int(mi)) * 60 + int(s)) * base + int(f)


def format_timecode(frames, fps):
    base = max(1, int(round(float(fps or 24))))
    n = int(frames) % (24 * 3600 * base)
    f = n % base
    s = n // base
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}:{f:02d}"


def _bcd(v):
    return (v // 10) << 4 | (v % 10)


def timecode_bits(text):
    """The SMPTE time-and-flags word an EXR ``timeCode`` attribute holds (BCD hours, minutes, seconds, frames)."""
    m = _TC.match(str(text or ""))
    if not m:
        return None
    h, mi, s, sep, f = (int(x) if x.isdigit() else x for x in m.groups())
    bits = _bcd(f % 100) | (0x40 if sep == ";" else 0) | _bcd(s) << 8 | _bcd(mi) << 16 | _bcd(h) << 24
    return bits & 0xFFFFFFFF


def timecode_from_bits(bits):
    b = int(bits)

    def un(v):
        return (v >> 4) * 10 + (v & 15)
    sep = ";" if b & 0x40 else ":"
    return f"{un(b >> 24 & 0x3F):02d}:{un(b >> 16 & 0x7F):02d}:{un(b >> 8 & 0x7F):02d}{sep}{un(b & 0x3F):02d}"


# ── EXR ──────────────────────────────────────────────────────────────────────

_COMPRESSION = {"none": 0, "zips": 2, "zip": 3}
_LINES = {0: 1, 2: 1, 3: 16}


def _attr(name, typ, data):
    return name.encode() + b"\0" + typ.encode() + b"\0" + struct.pack("<i", len(data)) + data


def _zip_block(raw: bytes) -> bytes:
    """OpenEXR's ZIP(S) step: bytes split into evens then odds, each a difference from the one before
    (+128, mod 256), then zlib. The raw bytes when that is not smaller (the format allows it)."""
    a = np.frombuffer(raw, np.uint8)
    t = np.concatenate([a[0::2], a[1::2]])
    d = t.astype(np.int16)
    d[1:] = (t[1:].astype(np.int16) - t[:-1].astype(np.int16) + 128 + 256) % 256
    z = zlib.compress(d.astype(np.uint8).tobytes(), 6)
    return z if len(z) < len(raw) else raw


def exr_channels(img, extras=None, which="rgba"):
    """``{exr name: [H, W] float32}`` of a premultiplied picture: R G B (A) and, for ``all``, every extra channel
    (``depth.z`` stays ``depth.z``: a layer of a multi-layer EXR)."""
    out = {"R": img[..., 0], "G": img[..., 1], "B": img[..., 2]}
    if which != "rgb":
        out["A"] = img[..., 3]
    if which == "all":
        for k, v in (extras or {}).items():
            if v is not None and v.shape == img.shape[:2]:
                out[k] = v
    return out


def exr_bytes(channels, *, depth="half", compression="zip", attrs=None):
    """A scanline OpenEXR file of ``channels`` (``{name: [H, W] float array}``, all one size), written from the
    published file layout. ``depth`` half | float; ``compression`` none | zips | zip; ``attrs`` extra header
    attributes: a str is a string attribute, an int an int, a float a float, ``("timecode", bits)`` a timeCode,
    ``("rational", n, d)`` a rational."""
    names = sorted(channels)        # the format wants them in name order
    if not names:
        raise WriteError("no channels to write")
    h, w = next(iter(channels.values())).shape[:2]
    pt, dt, size = (1, "<f2", 2) if depth != "float" else (2, "<f4", 4)
    comp = _COMPRESSION.get(compression, 3)
    per = _LINES[comp]
    chans = b"".join(n.encode() + b"\0" + struct.pack("<iB3xii", pt, 0, 1, 1) for n in names) + b"\0"
    box = struct.pack("<iiii", 0, 0, w - 1, h - 1)
    head = (struct.pack("<ii", 20000630, 2)
            + _attr("channels", "chlist", chans) + _attr("compression", "compression", bytes([comp]))
            + _attr("dataWindow", "box2i", box) + _attr("displayWindow", "box2i", box)
            + _attr("lineOrder", "lineOrder", b"\0") + _attr("pixelAspectRatio", "float", struct.pack("<f", 1.0))
            + _attr("screenWindowCenter", "v2f", struct.pack("<ff", 0, 0)) + _attr("screenWindowWidth", "float", struct.pack("<f", 1.0)))
    for k, v in sorted((attrs or {}).items()):
        if not k or k in ("channels", "compression", "dataWindow", "displayWindow", "lineOrder", "pixelAspectRatio",
                          "screenWindowCenter", "screenWindowWidth"):
            continue
        if isinstance(v, tuple) and v and v[0] == "timecode":
            head += _attr(k, "timecode", struct.pack("<II", int(v[1]) & 0xFFFFFFFF, 0))
        elif isinstance(v, tuple) and v and v[0] == "rational":
            head += _attr(k, "rational", struct.pack("<iI", int(v[1]), int(v[2])))
        elif isinstance(v, bool) or isinstance(v, int):
            head += _attr(k, "int", struct.pack("<i", int(v)))
        elif isinstance(v, float):
            head += _attr(k, "float", struct.pack("<f", v))
        else:
            data = str(v).encode("utf-8")[:65000]
            head += _attr(k, "string", data)
    head += b"\0"
    planes = np.stack([np.asarray(channels[n], dtype=np.float32) for n in names], axis=1).astype(dt)   # [H, C, W]
    blocks = []
    for y0 in range(0, h, per):
        raw = planes[y0:y0 + per].tobytes()
        data = raw if comp == 0 else _zip_block(raw)
        blocks.append(struct.pack("<ii", y0, len(data)) + data)
    nblocks = len(blocks)
    pos = len(head) + 8 * nblocks
    offsets = []
    for b in blocks:
        offsets.append(pos)
        pos += len(b)
    return head + struct.pack(f"<{nblocks}Q", *offsets) + b"".join(blocks)


def exr_header(path, limit=1 << 20):
    """The attributes of an EXR file's (first) header: ``{name: value}`` - strings, numbers, the channel names,
    ``timeCode`` as text, box and vector types as lists. Read from the file layout; {} when it is no EXR."""
    try:
        with open(path, "rb") as fh:
            data = fh.read(limit)
    except OSError:
        return {}
    if len(data) < 8 or struct.unpack("<i", data[:4])[0] != 20000630:
        return {}
    out, i = {}, 8
    try:
        while i < len(data) and data[i] != 0:
            j = data.index(b"\0", i)
            name = data[i:j].decode("latin-1")
            k = data.index(b"\0", j + 1)
            typ = data[j + 1:k].decode("latin-1")
            (n,) = struct.unpack("<i", data[k + 1:k + 5])
            v = data[k + 5:k + 5 + n]
            i = k + 5 + n
            if typ == "string":
                out[name] = v.decode("utf-8", "replace")
            elif typ == "int":
                out[name] = struct.unpack("<i", v)[0]
            elif typ == "float":
                out[name] = round(struct.unpack("<f", v)[0], 6)
            elif typ == "double":
                out[name] = struct.unpack("<d", v)[0]
            elif typ == "timecode":
                out[name] = timecode_from_bits(struct.unpack("<I", v[:4])[0])
            elif typ == "rational":
                a, b = struct.unpack("<iI", v)
                out[name] = f"{a}/{b}" if b else str(a)
            elif typ in ("box2i", "box2f"):
                out[name] = list(struct.unpack("<iiii" if typ == "box2i" else "<ffff", v))
            elif typ in ("v2f", "v2i"):
                out[name] = list(struct.unpack("<ff" if typ == "v2f" else "<ii", v))
            elif typ == "chlist":
                names, p = [], 0
                while p < len(v) and v[p] != 0:
                    q = v.index(b"\0", p)
                    names.append(v[p:q].decode("latin-1"))
                    p = q + 1 + 16
                out[name] = names
            elif typ == "compression":
                out[name] = {0: "none", 1: "rle", 2: "zips", 3: "zip", 4: "piz", 5: "pxr24", 6: "b44", 7: "b44a",
                             8: "dwaa", 9: "dwab"}.get(v[0], str(v[0]))
    except (ValueError, struct.error, IndexError):
        pass
    return out


# ── metadata ─────────────────────────────────────────────────────────────────

_SKIP_HEADER = {"channels", "compression", "dataWindow", "displayWindow", "lineOrder", "pixelAspectRatio",
                "screenWindowCenter", "screenWindowWidth", "chunkCount", "type", "version", "name", "tiles"}


def file_metadata(path):
    """What a footage file says about itself, as metadata keys: ``input/*`` and the header's own (``exr/*``)."""
    md = {}
    if not path or not os.path.isfile(path):
        return md
    md["input/filename"] = path
    try:
        md["input/mtime"] = int(os.path.getmtime(path))
        md["input/filesize"] = os.path.getsize(path)
    except OSError:
        pass
    ext = os.path.splitext(path)[1].lower()
    if ext == ".exr":
        for k, v in exr_header(path).items():
            if k == "timeCode":
                md["input/timecode"] = v
            elif k == "framesPerSecond":
                md["input/frame_rate"] = v
            if k not in _SKIP_HEADER:
                md[f"exr/{k}"] = v
        return md
    if ext in comp_io.VIDEO_EXTS:
        try:
            import av
            with av.open(path) as c:
                tags = dict(c.metadata or {})
                if c.streams.video:
                    tags.update({k: v for k, v in (c.streams.video[0].metadata or {}).items() if k not in tags})
                for k, v in tags.items():
                    md[f"input/{k.lower()}"] = str(v)
                if "timecode" in tags:
                    md["input/timecode"] = str(tags["timecode"])
        except Exception:  # noqa: BLE001 - no PyAV, or not a film it reads
            pass
        return md
    try:
        from PIL import Image
        with Image.open(path) as im:
            md["input/width"], md["input/height"] = im.size
            for k, v in (im.info or {}).items():
                if isinstance(v, (str, int, float)) and k not in ("dpi", "gamma"):
                    md[f"input/{str(k).lower()}"] = v
    except Exception:  # noqa: BLE001
        pass
    return md


def parse_sets(text):
    """A Metadata node's ``set``: ``key = value`` pairs separated by ``;`` or new lines -> [(key, value)]."""
    out = []
    for part in re.split(r"[;\n]", str(text or "")):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        if k:
            out.append((k, v.strip()))
    return out


def parse_removes(text):
    return [s.strip() for s in re.split(r"[,;\n]", str(text or "")) if s.strip()]


def metadata_at(comp, nid, frame, sources=None, depth=0):
    """The metadata of node ``nid``'s picture at ``frame``: the Read at the top of its B pipe (input 0) gives its
    file's, every Metadata node on the way down sets / removes keys. A time node changes the frame asked for."""
    n = M.node_by_id(comp, nid)
    if not n or depth > 256:
        return {}
    ins = n.get("inputs") or []
    t = n.get("type")
    if n.get("disable"):
        return metadata_at(comp, ins[0], frame, sources, depth + 1) if ins and ins[0] else {}
    if t == "read":
        if sources is None:
            return {}
        path, info = sources.info(n)
        md = {}
        kind = info.get("kind")
        if kind in ("still", "sequence", "video", "comp"):
            num = M.source_frame(n, info, frame)
            file = comp_io.frame_path(path, num) if kind == "sequence" else path
            md = file_metadata(file) if kind != "comp" else {"input/filename": path}
            if num is not None:
                md["input/frame"] = num
            if info.get("timecode") and "input/timecode" not in md:
                md["input/timecode"] = info["timecode"]
        return md
    if t == "retime":
        frame = int(round(M.retime_frame(n, frame)))
    md = dict(metadata_at(comp, ins[0], frame, sources, depth + 1)) if ins and ins[0] else {}
    if t == "metadata":
        for pat in parse_removes(n.get("remove")):
            for k in [k for k in md if fnmatch.fnmatchcase(k, pat)]:
                md.pop(k, None)
        for k, v in parse_sets(n.get("set")):
            md[k] = v.replace("[frame]", str(frame))
    return md


# ── Write nodes: what each one writes ────────────────────────────────────────

def write_nodes(comp):
    return [n for n in comp.get("nodes") or [] if n.get("type") == "write"]


def _version_of(comp_path):
    m = re.search(r"_v(\d{2,})(?=\.comp\.json$)", os.path.basename(comp_path or ""), re.I)
    return f"v{m.group(1)}" if m else ""


def _stem(comp_path):
    b = os.path.basename(comp_path or "comp.comp.json")
    return b[: -len(M.SUFFIX)] if b.lower().endswith(M.SUFFIX) else os.path.splitext(b)[0]


def safe_name(s):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f\s]+', "_", str(s or "")).strip("._") or "write"


def file_type(node, path=""):
    ext = os.path.splitext(path or "")[1].lower()
    return _EXT_TYPE.get(ext) or (node.get("file_type") if node.get("file_type") in M.WRITE_FORMATS else "exr")


def resolve_pattern(node, comp_path):
    """A Write's file as an absolute path pattern (``#`` / ``%0Nd`` for the frame), its tokens filled in:
    ``{comp}`` the comp file's name, ``{name}`` the Write's, ``{version}`` the comp's v### (or empty).
    Empty: ``<comp folder>/<comp>_<name>/<name>.####.<type>``."""
    name = safe_name(node.get("name") or node.get("id"))
    stem = _stem(comp_path)
    folder = os.path.dirname(os.path.abspath(comp_path)) if comp_path else os.getcwd()
    f = str(node.get("file") or "").strip().strip('"')
    ft = file_type(node, f)
    if not f:
        f = os.path.join(f"{stem}_{name}", f"{name}." + ("#" * int(node.get("padding") or 4)) + f".{ft}") \
            if ft not in FILM_TYPES else f"{stem}_{name}.{ft}"
    f = f.replace("{comp}", stem).replace("{name}", name).replace("{version}", _version_of(comp_path))
    if not os.path.splitext(f)[1]:
        f += f".{ft}"
    if not os.path.isabs(f):
        f = os.path.join(folder, f)
    return os.path.normpath(f), file_type(node, f)


def _int_or(v, d):
    return int(v) if M._is_num(v) else d


def write_frames(node, comp, first=None, last=None, handles=None):
    """The comp frames a Write writes: its own first..last (or the comp's), the render's if given, widened by the
    handles. Frames before 0 or past the comp's end are written too (a Read holds its first / last frame there)."""
    n_frames = comp["format"]["frames"]
    f0 = _int_or(first, _int_or(node.get("first"), 0))
    f1 = _int_or(last, _int_or(node.get("last"), n_frames - 1))
    if f1 < f0:
        f0, f1 = f1, f0
    h = max(0, _int_or(handles, _int_or(node.get("handles"), 0)))
    return list(range(f0 - h, f1 + h + 1))


def frame_file(pattern, number, padding=4):
    """The file of one frame: the pattern's ``#`` / ``%0Nd`` run, else ``.<number>`` before the type."""
    if comp_io.is_sequence(pattern):
        return comp_io.frame_path(pattern, number)
    stem, ext = os.path.splitext(pattern)
    return f"{stem}.{int(number):0{int(padding)}d}{ext}"


def plan(comp, comp_path, ids=None, first=None, last=None, handles=None):
    """What a render of the Write nodes does: one entry per Write (all of them, or the ids named, in graph order;
    switched-off ones left out) -> ``{id, name, pattern, type, film, frames, numbers: {frame: file number}}``."""
    want = None if ids in (None, "all") else set(ids)
    out = []
    for n in write_nodes(comp):
        if n.get("disable") or (want is not None and n["id"] not in want):
            continue
        pattern, ft = resolve_pattern(n, comp_path)
        frames = write_frames(n, comp, first, last, handles)
        start = _int_or(n.get("first_number"), 1001)
        out.append({"id": n["id"], "name": n.get("name") or n["id"], "pattern": pattern, "type": ft, "film": ft in FILM_TYPES,
                    "frames": frames, "first_number": start, "padding": max(1, min(9, _int_or(n.get("padding"), 4))),
                    "numbers": {f: start + f for f in frames}})
    if want is not None:
        missing = want - {p["id"] for p in out}
        bad = [i for i in missing if not any(n["id"] == i for n in write_nodes(comp))]
        if bad:
            raise WriteError(f"no Write node {', '.join(sorted(bad))}")
    return out


def files_of(p):
    """Every file one planned Write makes (a film is one file)."""
    if p["film"]:
        return [p["pattern"]]
    return [frame_file(p["pattern"], p["numbers"][f], p["padding"]) for f in p["frames"]]


# ── writing ──────────────────────────────────────────────────────────────────

def _comp_attrs(node, comp, comp_path, frame, md, fps):
    attrs = {}
    if node.get("metadata", "on") != "off":
        for k, v in md.items():
            if k.startswith("exr/"):
                k = k[4:]
            if k in _SKIP_HEADER or k in ("timeCode", "framesPerSecond"):
                continue
            attrs[k] = v if isinstance(v, (int, float, str)) else str(v)
        attrs["imageviewer/comp"] = os.path.abspath(comp_path) if comp_path else ""
        attrs["imageviewer/node"] = node.get("name") or node["id"]
        attrs["imageviewer/frame"] = int(frame)
    tc = tc_at(node, md, frame, fps)
    if tc:
        attrs["timeCode"] = ("timecode", timecode_bits(tc))
    fr = Fraction(fps).limit_denominator(1001)
    attrs["framesPerSecond"] = ("rational", fr.numerator, fr.denominator)
    return attrs


def tc_at(node, md, frame, fps):
    """A Write's timecode at ``frame``: its own start (comp frame 0) plus the frame, else the footage's (which is
    already that frame's)."""
    own = str(node.get("timecode") or "").strip()
    if own:
        base = parse_timecode(own, fps)
        return format_timecode(base + int(frame), fps) if base is not None else None
    tc = md.get("input/timecode")
    return tc if tc and parse_timecode(tc, fps) is not None else None


def _to_space(img, spec_cs, hook):
    if not spec_cs or hook is None:
        return img
    fn = hook({"src": "", "dst": spec_cs})
    if fn is None:
        raise WriteError(f"the OCIO config has no colourspace {spec_cs!r}")
    return M.ocio_image(img, fn, True)


def write_exr(path, img, extras, node, attrs):
    chans = exr_channels(_conform_x(img), extras, node.get("channels") or "rgba")
    data = exr_bytes(chans, depth="float" if node.get("depth") == "float" else "half",
                     compression=node.get("compression") or "zip", attrs=attrs)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    stem, dot = os.path.splitext(path)
    tmp = f"{stem}.part{dot}"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    return path


def _conform_x(img):
    return np.asarray(img, dtype=np.float32)


def _still_options(node, ft):
    d = str(node.get("depth") or "half")
    if ft == "png":
        return {"bit_depth": "16" if d in ("16", "half", "float") else "8"}
    if ft == "tiff":
        return {"bit_depth": "32 float" if d == "float" else "8" if d == "8" else "16"}
    if ft == "jpg":
        return {"quality": 95}
    return {}


def _rgb_only(img):
    out = img.copy()
    out[..., 3] = 1.0
    return out


def render(comp, comp_path, plans, sources=None, *, progress=None, cancelled=None, ocio=None, log=None):
    """Render planned Writes (``plan``): one pass over the union of their frames, each frame's graph work shared.
    ``progress(done, total)``; ``cancelled()`` -> True stops it (InterruptedError). Returns
    ``[{id, name, files, film, frames}]`` (what was written)."""
    comp, _ = M.normalize(comp)
    hook = comp_io.ocio_hook() if ocio is None else ocio
    fps = comp["format"]["fps"]
    frames = sorted({f for p in plans for f in p["frames"]})
    total = sum(len(p["frames"]) for p in plans)
    done = 0
    films, results = {}, {p["id"]: {"id": p["id"], "name": p["name"], "files": [], "film": p["film"], "frames": 0,
                                    "pattern": p["pattern"], "type": p["type"]} for p in plans}
    nodes = {p["id"]: M.node_by_id(comp, p["id"]) for p in plans}
    encs = {}
    try:
        for p in plans:
            n = nodes[p["id"]]
            if p["type"] != "exr":
                encs[p["id"]] = comp_io.display_encoder(n.get("display") or None, n.get("view") or None)
            if p["film"]:
                size = M.format_at(comp, p["id"])
                how = _film_settings(p["type"])
                films[p["id"]] = comp_io.VideoWriter(p["pattern"], how, fps, size["width"], size["height"], encs[p["id"]])
        for f in frames:
            memo = {}
            for p in plans:
                if f not in p["numbers"]:
                    continue
                if cancelled and cancelled():
                    raise InterruptedError
                n = nodes[p["id"]]
                img, ex = M.render_node(comp, p["id"], f, sources, 1.0, memo=memo, ocio=hook, channels=True)
                if (n.get("channels") or "rgba") == "rgb" and p["type"] != "exr":
                    img = _rgb_only(img)
                if p["film"]:
                    films[p["id"]].add(img)
                    results[p["id"]]["files"] = [p["pattern"]]
                else:
                    path = frame_file(p["pattern"], p["numbers"][f], p["padding"])
                    if p["type"] == "exr":
                        md = metadata_at(comp, p["id"], f, sources) if n.get("metadata", "on") != "off" or not n.get("timecode") else {}
                        img = _to_space(img, n.get("colorspace"), hook)
                        write_exr(path, img, ex, n, _comp_attrs(n, comp, comp_path, f, md, fps))
                    else:
                        comp_io.write_still(img, path, p["type"], encs[p["id"]], _still_options(n, p["type"]))
                    results[p["id"]]["files"].append(path)
                results[p["id"]]["frames"] += 1
                done += 1
                if progress:
                    progress(done, total)
        for k, w in list(films.items()):
            w.close(True)
            films.pop(k)
    finally:
        for w in films.values():
            w.close(False)
    return [results[p["id"]] for p in plans]


def _film_settings(ft):
    """The export rule's film settings when it is there (ComfyUI), else plain ones PyAV has."""
    try:
        from . import export_rules
        return export_rules.video_settings(ft, None, "high")
    except Exception:  # noqa: BLE001 - outside ComfyUI (command line)
        if ft == "webm":
            return {"container": "webm", "encoder": "libvpx-vp9", "pix_fmt": "yuv420p", "options": {"crf": "20", "b": "0"}, "label": "VP9"}
        if ft == "mov":
            return {"container": "mov", "encoder": "prores_ks", "pix_fmt": "yuv422p10le", "options": {"profile": "2"}, "label": "ProRes 422"}
        return {"container": "mp4", "encoder": "libx264", "pix_fmt": "yuv420p", "options": {"crf": "16"}, "label": "H.264"}
