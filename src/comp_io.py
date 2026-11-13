"""Comp files and the pictures they read: ``*.comp.json`` on disk, the footage a Read names, and
rendering a comp's frames.

The arithmetic is :mod:`comp_model`; this module only reads and writes. No aiohttp or ComfyUI in here
(the routes are in ``comp_routes.py``), so it can be tested on its own.

A Read's ``file`` is a picture, a film, or a numbered sequence named with ``#`` (``shot.####.exr``,
one ``#`` per digit) or ``%04d``. A relative path is beside the comp file.
"""
from __future__ import annotations

import glob
import json
import os
import re
import tempfile

import numpy as np

from . import comp_model as M

MAX_BYTES = 8 * 1024 * 1024
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
LINEAR_EXTS = {".exr", ".hdr"}
_SEQ = re.compile(r"(#+|%0(\d+)d)")


def check_path(path) -> str:
    if not M.is_comp_path(path):
        raise ValueError(f"not a comp (the file name must end in {M.SUFFIX})")
    return os.path.abspath(path)


def read(path) -> dict:
    p = check_path(path)
    if os.path.getsize(p) > MAX_BYTES:
        raise ValueError("the comp file is too large")
    with open(p, "r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    return upgrade(data)


# What changed between versions of the file: each step takes a comp of that version to the next one. Version 1 is
# the first; a later viewer adds its steps here, so an old file always opens.
MIGRATIONS = {}


def upgrade(data):
    """A comp of any version this viewer knows, brought to ``COMP_VERSION``; a newer one is refused with a note."""
    if not isinstance(data, dict) or not isinstance(data.get("comp"), int) or isinstance(data.get("comp"), bool):
        raise ValueError('the file is not a comp (it needs "comp": 1)')
    v = data["comp"]
    if v > M.COMP_VERSION:
        raise ValueError(f"the comp was saved by a newer viewer (comp version {v}; this one reads up to "
                         f"{M.COMP_VERSION}): update the ComfyUI Image Viewer")
    while v < M.COMP_VERSION:
        step = MIGRATIONS.get(v)
        if step is None:
            raise ValueError(f"comp version {v} cannot be read any more")
        data = step(data)
        v = data["comp"]
    return data


def write(path, comp) -> str:
    """Write the comp atomically (temp file + rename); returns the path."""
    p = check_path(path)
    M.normalize(comp)   # raises when it is no comp
    text = json.dumps(comp, indent=1, ensure_ascii=False)
    if len(text) > MAX_BYTES:
        raise ValueError("the comp is too large")
    folder = os.path.dirname(p)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".comp_", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text + "\n")
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return p


# ── what a Read names ────────────────────────────────────────────────────────

def resolve_file(file, comp_path=None) -> str:
    """A Read's file as an absolute path (a relative one is beside the comp)."""
    f = str(file or "").strip().strip('"')
    if not f:
        return ""
    if not os.path.isabs(f) and comp_path:
        f = os.path.join(os.path.dirname(os.path.abspath(comp_path)), f)
    return os.path.abspath(f)


def is_sequence(path) -> bool:
    return bool(_SEQ.search(os.path.basename(path or "")))


def frame_path(pattern, n) -> str:
    """The file of frame ``n`` of a sequence pattern."""
    folder, name = os.path.split(pattern)
    m = _SEQ.search(name)
    if not m:
        return pattern
    digits = int(m.group(2)) if m.group(2) else len(m.group(1))
    return os.path.join(folder, name[:m.start()] + f"{int(n):0{digits}d}" + name[m.end():])


def source_info(path) -> dict:
    """``{kind: still | sequence | video, first, last, width?, height?, fps?}`` or ``{kind: "missing"}``."""
    if not path:
        return {"kind": "missing"}
    if M.is_comp_path(path):
        if not os.path.isfile(path):
            return {"kind": "missing"}
        try:
            c, _ = M.normalize(read(path))
        except (ValueError, OSError) as e:
            return {"kind": "missing", "error": str(e)}
        size = M.format_at(c, c.get("output"))
        return {"kind": "comp", "first": 0, "last": c["format"]["frames"] - 1, "fps": c["format"]["fps"],
                "width": size["width"], "height": size["height"]}
    if is_sequence(path):
        folder, name = os.path.split(path)
        m = _SEQ.search(name)
        digits = int(m.group(2)) if m.group(2) else len(m.group(1))
        head, tail = name[:m.start()], name[m.end():]
        rx = re.compile(re.escape(head) + r"(\d{%d,})" % digits + re.escape(tail) + r"$")
        nums = []
        for f in glob.glob(os.path.join(glob.escape(folder), glob.escape(head) + "*" + glob.escape(tail))):
            mm = rx.match(os.path.basename(f))
            if mm:
                nums.append(int(mm.group(1)))
        if not nums:
            return {"kind": "missing"}
        nums.sort()
        info = {"kind": "sequence", "first": nums[0], "last": nums[-1],
                "gaps": nums[-1] - nums[0] + 1 - len(nums)}
        tc = _timecode_of(frame_path(path, nums[0]))
        if tc:
            info["timecode"] = tc
        return info
    if not os.path.isfile(path):
        return {"kind": "missing"}
    if os.path.splitext(path)[1].lower() in VIDEO_EXTS:
        try:
            import av
            with av.open(path) as c:
                s = c.streams.video[0]
                n = int(s.frames or 0)
                fps = float(s.average_rate or 24)
                if not n and s.duration and s.time_base:
                    n = int(round(float(s.duration * s.time_base) * fps))
                info = {"kind": "video", "first": 0, "last": max(0, n - 1), "fps": fps,
                        "width": s.codec_context.width, "height": s.codec_context.height}
                tc = (s.metadata or {}).get("timecode") or (c.metadata or {}).get("timecode")
                if tc:
                    info["timecode"] = str(tc)
                return info
        except Exception as e:  # noqa: BLE001
            return {"kind": "missing", "error": str(e)}
    info = {"kind": "still", "first": 0, "last": 0}
    tc = _timecode_of(path)
    if tc:
        info["timecode"] = tc
    size = _still_size(path)
    if size:
        info["width"], info["height"] = size
    return info


def _timecode_of(path):
    """An EXR's own timecode (its header's timeCode), else None."""
    if not str(path).lower().endswith(".exr"):
        return None
    from . import comp_write
    return comp_write.exr_header(path, 1 << 16).get("timeCode")


def sequence_numbers(path):
    """The frame numbers of a sequence pattern that are on disk, in order."""
    folder, name = os.path.split(path)
    m = _SEQ.search(name)
    if not m:
        return []
    digits = int(m.group(2)) if m.group(2) else len(m.group(1))
    head, tail = name[:m.start()], name[m.end():]
    rx = re.compile(re.escape(head) + r"(\d{%d,})" % digits + re.escape(tail) + r"$")
    nums = []
    for f in glob.glob(os.path.join(glob.escape(folder), glob.escape(head) + "*" + glob.escape(tail))):
        mm = rx.match(os.path.basename(f))
        if mm:
            nums.append(int(mm.group(1)))
    return sorted(nums)


class MissingFrame(ValueError):
    """A Read whose missing-frame rule is "error" met a frame that is not on disk."""


def _still_size(path):
    """(width, height) of a picture from its header (Pillow, else OpenImageIO for EXR and the like), or None."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return int(im.size[0]), int(im.size[1])
    except Exception:  # noqa: BLE001 - not a format Pillow reads
        pass
    try:
        import OpenImageIO as oiio
        inp = oiio.ImageInput.open(path)
        if inp:
            try:
                spec = inp.spec()
                return int(spec.width), int(spec.height)
            finally:
                inp.close()
    except Exception:  # noqa: BLE001
        pass
    return None


def _read_float(path):
    """(rgb [H, W, 3], alpha [H, W] or None) of a picture, floats as stored (8 bit / 255)."""
    alpha_index = -1
    try:
        import OpenImageIO as oiio
        buf = oiio.ImageBuf(path)
        if buf.has_error:
            raise RuntimeError(buf.geterror())
        arr = np.asarray(buf.get_pixels(oiio.FLOAT), dtype="float32")
        alpha_index = buf.spec().alpha_channel
    except ImportError:
        from PIL import Image
        with Image.open(path) as im:
            if im.mode.startswith("I"):
                arr = np.asarray(im).astype("float32") / 65535.0
            elif im.mode == "F":
                arr = np.asarray(im).astype("float32")
            else:
                has_alpha = "A" in im.getbands() or (im.mode == "P" and "transparency" in im.info)
                arr = np.asarray(im.convert("RGBA" if has_alpha else "RGB")).astype("float32") / 255.0
                alpha_index = 3 if has_alpha else -1
    if arr.ndim == 2:
        arr = arr[:, :, None]
    alpha = arr[:, :, alpha_index] if 0 <= alpha_index < arr.shape[2] else None
    colour = [c for c in range(arr.shape[2]) if c != alpha_index][:3]
    rgb = arr[:, :, colour] if len(colour) == 3 else np.repeat(arr[:, :, colour[:1]], 3, axis=2)
    return np.ascontiguousarray(rgb, dtype="float32"), alpha


class _Video:
    """Frames of one film, read forwards; a step back opens it again."""

    def __init__(self, path):
        import av
        self.path, self.av = path, av
        self.c = None
        self.i = -1
        self.last = None

    def frame(self, n):
        if self.c is None or n < self.i:
            if self.c is not None:
                self.c.close()
            self.c = self.av.open(self.path)
            self.it = self.c.decode(video=0)
            self.i = -1
            self.last = None
        while self.i < n:
            try:
                self.last = next(self.it).to_ndarray(format="rgba")
                self.i += 1
            except StopIteration:
                break
        return self.last

    def close(self):
        if self.c is not None:
            self.c.close()
            self.c = None


class Sources:
    """The pixels of a comp's Reads, per frame, cached while one render runs.

    ``allow(path)`` may refuse a file (the routes pass ``path_access.may_serve``)."""

    MAX_DEPTH = 8

    def __init__(self, comp_path=None, allow=None, _stack=()):
        self.comp_path = comp_path
        self.allow = allow
        self.infos = {}
        self.videos = {}
        self.stills = {}
        self.deeps = {}
        self.numbers = {}
        self.precomps = {}
        self.stack = tuple(_stack) + ((os.path.abspath(comp_path),) if comp_path else ())
        self.notes = []

    def note(self, s):
        if s not in self.notes:
            self.notes.append(s)

    def path_of(self, node):
        """The file a Read reads: its localised copy (``local``) while that is there, else its ``file``."""
        local = node.get("local")
        if local:
            lp = resolve_file(local, self.comp_path)
            probe = frame_path(lp, 0) if is_sequence(lp) else lp
            if os.path.isfile(probe) or (is_sequence(lp) and sequence_numbers(lp)):
                return lp
        return resolve_file(node.get("file"), self.comp_path)

    def info(self, node):
        path = self.path_of(node)
        if path not in self.infos:
            if path and self.allow and not self.allow(path):
                self.infos[path] = {"kind": "refused"}
                self.notes.append(f"{os.path.basename(path)}: not in the folders the viewer may read")
            else:
                self.infos[path] = source_info(path)
                if self.infos[path]["kind"] == "missing" and path:
                    self.note(f"{os.path.basename(path)}: not found")
        return path, self.infos[path]

    def _held(self, path, n):
        """The nearest frame number of a sequence that is on disk: the last one before n, else the first after."""
        nums = self.numbers.get(path)
        if nums is None:
            nums = self.numbers[path] = sequence_numbers(path)
        before = [k for k in nums if k <= n]
        if before:
            return before[-1]
        return nums[0] if nums else None

    def _precomp(self, node, path, n):
        """Another comp's Output at its frame n (a precomp): rendered here, with its own Reads."""
        if path in self.stack or len(self.stack) >= self.MAX_DEPTH:
            self.note(f"{os.path.basename(path)}: reads itself (a precomp loop), left black")
            return None
        got = self.precomps.get(path)
        if got is None:
            try:
                c, _ = M.normalize(read(path))
            except (ValueError, OSError) as e:
                self.note(f"{os.path.basename(path)}: {e}")
                return None
            got = self.precomps[path] = (c, Sources(path, self.allow, self.stack))
        c, src = got
        if not c["output"]:
            self.note(f"{os.path.basename(path)}: the comp has no Output")
            return None
        img = M.render_node(c, c["output"], n, src, 1.0, ocio=ocio_hook())
        for s in src.notes:
            self.note(f"{os.path.basename(path)} > {s}")
        return img

    def __call__(self, node, frame):
        path, info = self.info(node)
        kind = info.get("kind")
        if kind not in ("still", "sequence", "video", "comp"):
            return None
        cs = node.get("colorspace") or "auto"
        n = M.source_frame(node, info, frame)
        if kind == "comp":
            key = ("comp", path, n)
            if key not in self.stills:
                self.stills[key] = self._precomp(node, path, n)
                while len([k for k in self.stills if k[0] == "comp"]) > 16:
                    self.stills.pop(next(k for k in self.stills if k[0] == "comp"))
            return self.stills[key]
        ocs = cs not in M.COLORSPACES and _ocio_ok(cs)
        if kind == "video":
            v = self.videos.get(path) or self.videos.setdefault(path, _Video(path))
            u8 = v.frame(n)
            if u8 is None:
                return None
            if ocs:
                from . import comp_ocio
                raw = u8.astype(np.float32) / 255
                return M.from_float(comp_ocio.from_space(raw[..., :3], cs), raw[..., 3] if raw.shape[-1] > 3 else None, linear=True)
            return M.decode8(u8, linear=cs == "linear")
        file = frame_path(path, n) if kind == "sequence" else path
        if kind == "sequence" and not os.path.isfile(file):
            rule = node.get("missing") or "black"
            if rule == "error":
                raise MissingFrame(f"{os.path.basename(file)}: frame {n} is missing")
            if rule == "hold":
                k = self._held(path, n)
                file = frame_path(path, k) if k is not None else file
        key = (file, cs)
        if key in self.stills:
            return self.stills[key]
        if not os.path.isfile(file):
            return None
        rgb, alpha = _read_float(file)
        if ocs:
            from . import comp_ocio
            img = M.from_float(comp_ocio.from_space(rgb, cs), alpha, linear=True)
        else:
            linear = cs == "linear" or (cs == "auto" and os.path.splitext(file)[1].lower() in LINEAR_EXTS)
            img = M.from_float(rgb, alpha, linear=linear)
        if kind == "still":
            self.stills[key] = img
        return img

    def deep(self, node, frame):
        """A DeepRead's deep picture at comp frame ``frame`` (comp_deep's form, the file's own size) or None."""
        path, info = self.info(node)
        kind = info.get("kind")
        if kind not in ("still", "sequence"):
            return None
        n = M.source_frame(node, info, frame)
        file = frame_path(path, n) if kind == "sequence" else path
        if file in self.deeps:
            return self.deeps[file]
        if not os.path.isfile(file):
            return None
        from . import comp_deep
        try:
            d = comp_deep.read_deep(file)
        except (ValueError, OSError, RuntimeError) as e:
            self.notes.append(f"{os.path.basename(file)}: {e}")
            d = None
        if len(self.deeps) > 8:
            self.deeps.pop(next(iter(self.deeps)))
        self.deeps[file] = d
        return d

    def close(self):
        for v in self.videos.values():
            v.close()
        self.videos.clear()
        for _, src in self.precomps.values():
            src.close()
        self.precomps.clear()


def _ocio_ok(cs):
    try:
        from . import comp_ocio
        return comp_ocio.resolve({"src": cs, "dst": ""}) is not None
    except Exception:  # noqa: BLE001 - no OCIO: the old rule (sRGB unless linear)
        return False


def ocio_hook():
    """The OCIO nodes' transforms, exact (None without PyOpenColorIO: they pass their picture through)."""
    try:
        from . import comp_ocio
        return comp_ocio.hook if comp_ocio.available() else None
    except Exception:  # noqa: BLE001
        return None


def display_encoder(display=None, view=None):
    """How a render's 8-bit pictures are encoded: the comp's plain sRGB (None), or an OCIO display and view
    from the working space - a function of straight [..., 3] colours giving display values 0..1."""
    if not display:
        return None
    from . import comp_ocio
    spec = {"src": "", "display": display, "view": view or "*"}
    if comp_ocio.processor(spec) is None:
        raise ValueError(f"the OCIO config has no display {display!r} / view {view!r}")
    return lambda rgb: comp_ocio.apply_rgb(rgb, spec)


def render_frames(comp, frames=None, sources=None, scale=1.0, view=None, close=True):
    """Yield ``(frame, picture)`` for the comp's Output at each frame (all of them by default), in ``view``
    (None: the comp's first, if it has views)."""
    comp, _ = M.normalize(comp)
    if not comp["output"]:
        raise ValueError("the comp has no Output node")
    frames = list(range(comp["format"]["frames"])) if frames is None else list(frames)
    hook = ocio_hook()
    deep = getattr(sources, "deep", None)
    try:
        for f in frames:
            yield f, M.render_node(comp, comp["output"], f, sources, scale, ocio=hook, view=view, deep_source=deep)
    finally:
        if sources is not None and close:
            sources.close()


# ── cameras from files ───────────────────────────────────────────────────────

CAMERA_EXTS = (".chan",)


def parse_camera_text(text, limit=100000):
    """A camera text file: one line a frame, ``frame tx ty tz rx ry rz [vertical fov]`` (degrees; # comments).
    ``[{"f", "t": [x, y, z], "r": [x, y, z], "vfov"?}]`` sorted by frame; ValueError when no line reads."""
    out = []
    for line in str(text).splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.replace(",", " ").split()
        if len(parts) < 7:
            continue
        try:
            nums = [float(x) for x in parts[:8]]
        except ValueError:
            continue
        if not all(np.isfinite(nums)):
            continue
        k = {"f": int(round(nums[0])), "t": nums[1:4], "r": nums[4:7]}
        if len(nums) > 7 and 0 < nums[7] < 180:
            k["vfov"] = nums[7]
        out.append(k)
        if len(out) >= limit:
            break
    if not out:
        raise ValueError("no camera lines (frame tx ty tz rx ry rz [vertical fov]) in the file")
    return sorted(out, key=lambda k: k["f"])


# ── a source for the page's preview ──────────────────────────────────────────

def shrink(img, k):
    """A picture k times smaller each way (a k x k box average; the edge's leftover pixels go)."""
    k = int(k)
    if k <= 1:
        return img
    h, w = img.shape[0] // k * k, img.shape[1] // k * k
    if not h or not w:
        return img
    return img[:h, :w].reshape(h // k, k, w // k, k, 4).mean(axis=(1, 3), dtype=np.float32)


def as_f16(img) -> bytes:
    """A picture as the page reads it: float16 little-endian, premultiplied linear RGBA, rows top first."""
    return np.ascontiguousarray(img, dtype="<f2").tobytes()


# ── writing a render ─────────────────────────────────────────────────────────

# The formats and options are the Send to Viewer node's (``file_writer``): one menu, one writer.
try:
    from . import file_writer as FW
except Exception:  # pragma: no cover - comp_io loaded by path, outside the package
    FW = None
VIDEO_FORMATS = ("mp4", "mov", "webm")
ALIASES = {"tif": "tiff", "jpeg": "jpg"}
FLOAT_DEPTHS = ("16 float", "32 float")


def still_formats():
    """The still formats a render can write here: the node's menu (what this install can write)."""
    if FW is None:
        return ["png", "exr", "jpg"]
    out = [e for e in FW.FILE_FORMATS if e not in FW.VIDEO_EXTS]
    if "exr" not in out:      # without OpenImageIO a plain half EXR is still written (comp_nuke.exr_bytes)
        out.insert(1, "exr")
    return out


def formats():
    """The render dialog's menu and option tables: the node's (``file_writer.formats``), with the stills this
    install can write here."""
    base = FW.formats() if FW is not None else {"bit_depths": {}, "compressions": {}, "codecs": {"mov": ["prores", "h264"]},
                                                 "quality_formats": ["jpg"], "quality_default": 90,
                                                 "compress_level_formats": ["png"], "compress_level_default": 6,
                                                 "first_frame_default": 1001, "padding_default": 4}
    return dict(base, stills=still_formats(), videos=list(VIDEO_FORMATS), floats=["exr", "hdr"],
                float_depths=list(FLOAT_DEPTHS))


def is_float(ext, options=None):
    """True when *ext* (with these options) keeps linear float values: EXR, HDR, a float TIFF."""
    ext = ALIASES.get(ext, ext)
    if ext in ("exr", "hdr"):
        return True
    depth = FW._option(options, "bit_depth", FW.BIT_DEPTHS, ext) if FW else None
    return depth in FLOAT_DEPTHS


def _encode(rgb, enc):
    """Straight linear colours to display values 0..1: plain sRGB, or an OCIO display (``display_encoder``)."""
    if enc is None:
        return np.clip(M.linear_to_srgb(np.clip(rgb, 0, None)), 0, 1)
    return np.clip(enc(rgb), 0, 1)


def still_pixels(img, ext, enc=None, options=None):
    """The [H, W, C] float32 a premultiplied linear picture is written as, in *ext*:
    a float file (EXR, HDR, float TIFF) the working space's values, premultiplied, as compositors keep them
    (HDR without alpha); JPEG / BMP the picture over black, display-encoded; the rest straight display values
    with alpha (sRGB, or ``enc``'s display) - what a ComfyUI IMAGE is."""
    ext = ALIASES.get(ext, ext)
    if is_float(ext, options):
        px = np.asarray(img, dtype=np.float32)
        return px[..., :3] if ext == "hdr" else px
    if ext in ("jpg", "bmp"):
        return _encode(img[..., :3], enc).astype(np.float32)
    rgb, a = M.to_straight(img, srgb=False)
    return np.dstack([_encode(rgb, enc), np.clip(a, 0, 1)]).astype(np.float32)


def write_still(img, path, ext, enc=None, options=None):
    """One picture to a file through the Send to Viewer node's writer (``file_writer._write_image``), with its
    per-format options (bit_depth, compression, quality, compress_level). Written beside and moved over."""
    ext = ALIASES.get(ext.lower(), ext.lower())
    options = dict(options or {})
    if FW is not None and ext in FW.QUALITY_FORMATS and options.get("quality") in (None, ""):
        options["quality"] = FW.QUALITY_DEFAULT
    px = np.ascontiguousarray(still_pixels(img, ext, enc, options))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    stem, dot = os.path.splitext(path)
    tmp = f"{stem}.part{dot}"
    try:
        import OpenImageIO  # noqa: F401
        has_oiio = True
    except ImportError:
        has_oiio = False
    if not has_oiio and is_float(ext, options):
        if ext != "exr":
            raise ValueError(f"a float {ext.upper()} needs OpenImageIO, which this ComfyUI does not have")
        from . import comp_nuke   # a plain half EXR, written from the file layout
        with open(tmp, "wb") as fh:
            fh.write(comp_nuke.exr_bytes(px))
    elif FW is None:
        from PIL import Image
        u8 = (np.clip(px, 0, 1) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(u8, "RGBA" if u8.shape[-1] == 4 else "RGB").save(tmp)
    else:
        FW._write_image(px, tmp, ext, options=options)
    os.replace(tmp, path)
    return path


def film_quality(q):
    """The node's quality (1..100) as the export rule's high / medium / low; a word stays as it is."""
    if q in (None, ""):
        return "high"
    if isinstance(q, str) and not q.strip().lstrip("-").isdigit():
        return q
    q = int(q)
    return "high" if q >= 85 else "medium" if q >= 65 else "low"


class VideoWriter:
    """A film, frame by frame, by the export rule's encoder settings (``export_rules.video_settings``).
    Written beside the target and moved over at ``close``."""

    def __init__(self, path, how, fps, width, height, enc=None):
        import av
        self.enc = enc
        from fractions import Fraction
        self.path, self.tmp = path, path + ".part." + how["container"]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.even = how["pix_fmt"].startswith("yuv420")
        self.w, self.h = (width // 2 * 2, height // 2 * 2) if self.even else (width, height)
        self.out = av.open(self.tmp, "w", format="mov" if how["container"] == "mov" else how["container"])
        self.vs = self.out.add_stream(how["encoder"], rate=Fraction(fps).limit_denominator(1001), options=dict(how["options"]))
        self.vs.pix_fmt = how["pix_fmt"]
        self.vs.width, self.vs.height = self.w, self.h
        self.av, self.n = av, 0

    def add(self, img):
        # A film has no alpha: the premultiplied picture is the picture over black.
        rgb = _encode(img[: self.h, : self.w, :3], self.enc)
        u8 = np.ascontiguousarray((rgb * 255 + 0.5).astype(np.uint8))
        frame = self.av.VideoFrame.from_ndarray(u8, format="rgb24")
        frame.pts = self.n
        for packet in self.vs.encode(frame):
            self.out.mux(packet)
        self.n += 1

    def close(self, keep=True):
        try:
            if keep:
                for packet in self.vs.encode(None):
                    self.out.mux(packet)
            self.out.close()
            if keep:
                os.replace(self.tmp, self.path)
        finally:
            if os.path.exists(self.tmp):
                try:
                    os.remove(self.tmp)
                except OSError:
                    pass
