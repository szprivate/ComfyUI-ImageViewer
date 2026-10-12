"""One set of rules for everything the viewer writes out.

The viewer grew its exports one feature at a time, and each brought its own
answers: where the file goes, what it is called, what "mov" means, how good
"high" is. This module is the one place those are decided, for every feature
that exports - a previz shot, a cut, an annotation, a frame, a scene.

Two rules:

**What a format is** (:data:`VIDEO`, :func:`video_settings`). A container means
the same codec wherever it is offered, and where a container can hold more than
one the choice is the user's, with one default: MOV is ProRes unless H.264 is
asked for (H.264 is what MP4 is for). Quality has three names, and each encoder
is given its own number for them here rather than wherever it happens to be
called.

**Where a file goes and what it is called** (:func:`target`). With a sequence
and shot in hand - a context node on the canvas - it follows the bEpic layout,
``<Seq>/<Shot>/<kind>/v###/<shot>_v###_<name>.<ext>``, the same one the path
nodes build. Without, ``bepic/<kind>/<name>_v###.<ext>``. Both under ComfyUI's
output folder, both versioned: an export never writes over an earlier one, it is
the next version.
"""

import os
import re

# ── formats ──────────────────────────────────────────────────────────────────

QUALITIES = ("high", "medium", "low")

# container -> the codecs it is offered with, the first being the default.
VIDEO = {
    "mp4": ("h264",),
    "mov": ("prores", "h264"),
    "webm": ("vp9",),
}

CODEC_LABEL = {"h264": "H.264", "prores": "ProRes 422", "vp9": "VP9"}
CONTAINER_LABEL = {"mp4": "MP4", "mov": "MOV", "webm": "WebM"}

# What each quality name means to each encoder.
#   crf      - libx264 / libvpx-vp9 through PyAV (lower is better)
#   imageio  - imageio's 0-10 scale for libx264 (higher is better)
#   profile  - prores_ks: 3 = 422 HQ, 2 = 422, 1 = 422 LT
_H264 = {"high": {"crf": 16, "imageio": 9}, "medium": {"crf": 20, "imageio": 7},
         "low": {"crf": 26, "imageio": 5}}
_VP9 = {"high": {"crf": 24}, "medium": {"crf": 32}, "low": {"crf": 40}}
_PRORES = {"high": {"profile": 3, "name": "422 HQ"}, "medium": {"profile": 2, "name": "422"},
           "low": {"profile": 1, "name": "422 LT"}}


def codecs_for(container):
    return VIDEO.get(str(container or "").lower(), ())


def video_settings(container="mp4", codec=None, quality="high"):
    """How a video is encoded: ``{"container", "codec", "encoder", "pix_fmt",
    "options", "imageio_quality", "audio", "label"}``.

    An unknown container is ``ValueError``; an unknown or unsuitable codec falls
    back to the container's default, and an unknown quality to ``high`` - a
    setting remembered from an older version must not stop an export.
    """
    container = str(container or "mp4").lower()
    offered = codecs_for(container)
    if not offered:
        raise ValueError(f"unknown video format: {container}")
    codec = str(codec or "").lower()
    if codec not in offered:
        codec = offered[0]
    quality = quality if quality in QUALITIES else "high"
    if codec == "prores":
        q = _PRORES[quality]
        return {"container": container, "codec": codec, "quality": quality,
                "encoder": "prores_ks", "pix_fmt": "yuv422p10le",
                "options": {"profile": str(q["profile"])}, "imageio_quality": None,
                "audio": "pcm_s16le",
                "label": f"{CONTAINER_LABEL[container]} (ProRes {q['name']})"}
    if codec == "vp9":
        q = _VP9[quality]
        return {"container": container, "codec": codec, "quality": quality,
                "encoder": "libvpx-vp9", "pix_fmt": "yuv420p",
                "options": {"crf": str(q["crf"]), "b:v": "0"}, "imageio_quality": None,
                "audio": "libopus", "label": f"{CONTAINER_LABEL[container]} (VP9)"}
    q = _H264[quality]
    return {"container": container, "codec": "h264", "quality": quality,
            "encoder": "libx264", "pix_fmt": "yuv420p",
            "options": {"crf": str(q["crf"]), "preset": "medium"},
            "imageio_quality": q["imageio"], "audio": "aac",
            "label": f"{CONTAINER_LABEL[container]} (H.264)"}


def options(containers=None):
    """The table a format menu is built from, for the containers a feature offers."""
    out = []
    for container in (containers or VIDEO):
        offered = codecs_for(container)
        if not offered:
            continue
        out.append({"format": container, "label": CONTAINER_LABEL[container],
                    "codecs": [{"codec": c, "label": CODEC_LABEL[c]} for c in offered],
                    "default_codec": offered[0]})
    return {"video": out, "qualities": list(QUALITIES)}


# ── where a file goes ────────────────────────────────────────────────────────

# What is being exported -> the folder it belongs in.
KINDS = {
    "image": "images", "frame": "images", "annotation": "images",
    "video": "videos", "matte": "mattes",
    "scene": "scenes", "stage": "scenes",          # a previz scene, a USD stage
    "edit": "edits",                               # a cut: its timeline and its film
}
FALLBACK_ROOT = "bepic"
_VERSION = re.compile(r"v(\d{3,})$", re.I)


def slug(text, fallback="export"):
    """A name as it may appear in a file name."""
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", str(text or "")).strip("_")
    return s[:80] or fallback


def context_of(ctx):
    """``(sequence, shot)`` from what the page found on the canvas, or None.

    Both are cleaned to plain names: they become folders, and the page is not
    trusted to have kept them inside the output folder.
    """
    if not isinstance(ctx, dict):
        return None
    seq, shot = slug(ctx.get("sequence"), ""), slug(ctx.get("shot"), "")
    return (seq, shot) if shot else None


def _used_versions(folder, stem_of):
    """The versions that already have a file in *folder* (see :func:`target`)."""
    used = set()
    try:
        names = os.listdir(folder)
    except OSError:
        return used
    for name in names:
        v = stem_of(name)
        if v:
            used.add(v)
    return used


def target(kind, name, ext, output_dir, context=None, version=None):
    """Where an export goes: ``{"path", "version", "folder", "layout", "relative"}``.

    *version* names one outright (and may then write over it - that is what
    naming it means); without, it is the first that has no file of this name
    yet, in any format, so the film and the timeline of one export share a
    number.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown kind of export: {kind}")
    name = slug(name)
    ext = str(ext or "").lower().lstrip(".")
    if not re.fullmatch(r"[a-z0-9]{1,6}", ext):
        raise ValueError(f"unusable file extension: {ext!r}")
    ctx = context_of(context)
    if ctx:
        seq, shot = ctx
        base = os.path.join(output_dir, *([seq] if seq else []), shot, KINDS[kind])
        prefix = f"{shot.lower()}_v"
        pattern = re.compile(re.escape(prefix) + r"(\d{3,})_" + re.escape(name) + r"(?:[_.]|$)", re.I)
        used = set()
        try:
            for vdir in os.listdir(base):
                if _VERSION.match(vdir):
                    used |= _used_versions(os.path.join(base, vdir),
                                           lambda n: int(pattern.match(n).group(1)) if pattern.match(n) else 0)
        except OSError:
            pass
        v = int(version) if version else (max(used) + 1 if used else 1)
        folder = os.path.join(base, f"v{v:03d}")
        path = os.path.join(folder, f"{prefix}{v:03d}_{name}.{ext}")
        layout = "shot"
    else:
        folder = os.path.join(output_dir, FALLBACK_ROOT, KINDS[kind])
        pattern = re.compile(re.escape(name) + r"_v(\d{3,})(?:[_.]|$)", re.I)
        used = _used_versions(folder, lambda n: int(pattern.match(n).group(1)) if pattern.match(n) else 0)
        v = int(version) if version else (max(used) + 1 if used else 1)
        path = os.path.join(folder, f"{name}_v{v:03d}.{ext}")
        layout = "plain"
    path = os.path.abspath(path)
    root = os.path.abspath(output_dir)
    if os.path.commonpath([root, path]) != root:
        raise ValueError("the export would land outside the output folder")
    return {"path": path, "version": v, "folder": os.path.dirname(path), "layout": layout,
            "relative": os.path.relpath(path, root).replace("\\", "/"), "exists": os.path.exists(path)}
