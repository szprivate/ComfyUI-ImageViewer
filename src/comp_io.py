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
    if not isinstance(data, dict) or data.get("comp") != M.COMP_VERSION:
        raise ValueError('the file is not a comp (it needs "comp": 1)')
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
        return {"kind": "sequence", "first": min(nums), "last": max(nums)}
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
                return {"kind": "video", "first": 0, "last": max(0, n - 1), "fps": fps,
                        "width": s.codec_context.width, "height": s.codec_context.height}
        except Exception as e:  # noqa: BLE001
            return {"kind": "missing", "error": str(e)}
    return {"kind": "still", "first": 0, "last": 0}


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

    def __init__(self, comp_path=None, allow=None):
        self.comp_path = comp_path
        self.allow = allow
        self.infos = {}
        self.videos = {}
        self.stills = {}
        self.notes = []

    def info(self, node):
        path = resolve_file(node.get("file"), self.comp_path)
        if path not in self.infos:
            if path and self.allow and not self.allow(path):
                self.infos[path] = {"kind": "refused"}
                self.notes.append(f"{os.path.basename(path)}: not in the folders the viewer may read")
            else:
                self.infos[path] = source_info(path)
                if self.infos[path]["kind"] == "missing" and path:
                    self.notes.append(f"{os.path.basename(path)}: not found")
        return path, self.infos[path]

    def __call__(self, node, frame):
        path, info = self.info(node)
        kind = info.get("kind")
        if kind not in ("still", "sequence", "video"):
            return None
        cs = node.get("colorspace") or "auto"
        n = M.source_frame(node, info, frame)
        if kind == "video":
            v = self.videos.get(path) or self.videos.setdefault(path, _Video(path))
            u8 = v.frame(n)
            return M.decode8(u8, linear=cs == "linear") if u8 is not None else None
        file = frame_path(path, n) if kind == "sequence" else path
        key = (file, cs)
        if key in self.stills:
            return self.stills[key]
        if not os.path.isfile(file):
            return None
        rgb, alpha = _read_float(file)
        linear = cs == "linear" or (cs == "auto" and os.path.splitext(file)[1].lower() in LINEAR_EXTS)
        img = M.from_float(rgb, alpha, linear=linear)
        if kind == "still":
            self.stills[key] = img
        return img

    def close(self):
        for v in self.videos.values():
            v.close()
        self.videos.clear()


def render_frames(comp, frames=None, sources=None, scale=1.0):
    """Yield ``(frame, picture)`` for the comp's Output at each frame (all of them by default)."""
    comp, _ = M.normalize(comp)
    if not comp["output"]:
        raise ValueError("the comp has no Output node")
    frames = list(range(comp["format"]["frames"])) if frames is None else list(frames)
    try:
        for f in frames:
            yield f, M.render_node(comp, comp["output"], f, sources, scale)
    finally:
        if sources is not None:
            sources.close()


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

STILL_EXTS = ("png", "exr", "tif", "jpg")
VIDEO_FORMATS = ("mp4", "mov", "webm")


def write_still(img, path, ext):
    """One picture to a file: PNG / TIFF 8-bit sRGB with alpha, JPEG over black, EXR linear half float."""
    ext = ext.lower()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    if ext == "exr":
        try:
            import OpenImageIO as oiio
        except ImportError:
            raise ValueError("EXR needs OpenImageIO, which this ComfyUI does not have - render PNG or a film") from None
        rgb, a = M.to_straight(img, srgb=False)
        px = np.ascontiguousarray(np.dstack([rgb, a]), dtype=np.float32)
        spec = oiio.ImageSpec(px.shape[1], px.shape[0], 4, oiio.HALF)
        spec.channelnames = ("R", "G", "B", "A")
        spec.alpha_channel = 3
        spec.attribute("compression", "zip")
        out = oiio.ImageOutput.create(tmp + ".exr")
        if not out or not out.open(tmp + ".exr", spec):
            raise ValueError("the EXR could not be written")
        out.write_image(px)
        out.close()
        os.replace(tmp + ".exr", path)
        return path
    from PIL import Image
    if ext == "jpg":
        u8 = (np.clip(M.linear_to_srgb(np.clip(img[..., :3], 0, None)), 0, 1) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(u8, "RGB").save(tmp, format="JPEG", quality=95)
    else:
        rgb, a = M.to_straight(img, srgb=True)
        u8 = (np.clip(np.dstack([rgb, a]), 0, 1) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(u8, "RGBA").save(tmp, format="PNG" if ext == "png" else "TIFF",
                                         **({"compress_level": 4} if ext == "png" else {"compression": "tiff_deflate"}))
    os.replace(tmp, path)
    return path


class VideoWriter:
    """A film, frame by frame, by the export rule's encoder settings (``export_rules.video_settings``).
    Written beside the target and moved over at ``close``."""

    def __init__(self, path, how, fps, width, height):
        import av
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
        rgb = np.clip(M.linear_to_srgb(np.clip(img[: self.h, : self.w, :3], 0, None)), 0, 1)
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
