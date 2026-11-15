"""A still picture to stand for a video in the strips (history, file browser).

An <img> cannot show a clip, so every video tile needs a PNG. It comes from, in order:

1. the poster written beside the video (``clip.mp4`` + ``clip.png``): agentY's motion-graphics
   render writes one, and ComfyUI's video saver a companion PNG. It needs no decoder at all,
   which is the point: a Mac without imageio-ffmpeg or OpenCV used to get no tile for a Remotion
   render and the strip showed a broken image;
2. a frame decoded by the caller (imageio, then OpenCV);
3. PyAV, which ComfyUI itself depends on, in this process: no program is started (a route may
   not start one - the ComfyUI registry's rule, and the viewer's).

No ComfyUI in here, so it can be tested on its own.
"""
from __future__ import annotations

import os

POSTER_EXTS = (".png", ".jpg", ".jpeg", ".webp")
MAX_SIDE = 512


def sibling_poster(video):
    """The picture next to ``video`` that has its name (``clip.mp4`` -> ``clip.png``), or None."""
    stem = os.path.splitext(str(video or ""))[0]
    if not stem:
        return None
    for ext in POSTER_EXTS:
        for cand in (stem + ext, stem + ext.upper()):
            if os.path.isfile(cand):
                return cand
    return None


def _save_small(img, dst, max_side):
    img.thumbnail((max_side, max_side))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    img.save(dst, compress_level=4)
    return dst


def from_poster(video, dst, max_side=MAX_SIDE):
    poster = sibling_poster(video)
    if not poster:
        return None
    try:
        from PIL import Image
        with Image.open(poster) as im:
            im.load()
            return _save_small(im, dst, max_side)
    except Exception:
        return None


def from_array(arr, dst, max_side=MAX_SIDE):
    try:
        from PIL import Image
        return _save_small(Image.fromarray(arr), dst, max_side)
    except Exception:
        return None


def from_av(video, dst, max_side=MAX_SIDE):
    """The first frame PyAV decodes, or None (no PyAV, not a film it reads)."""
    try:
        import av
    except Exception:
        return None
    try:
        with av.open(str(video)) as box:
            stream = next((s for s in box.streams if s.type == "video"), None)
            if stream is None:
                return None
            for frame in box.decode(stream):
                return _save_small(frame.to_image(), dst, max_side)
    except Exception:
        return None
    return None


def make(video, dst, decode=None, max_side=MAX_SIDE):
    """Write a small PNG for ``video`` to ``dst``; returns ``dst`` or None.

    ``decode(video, index)`` is the caller's frame decoder (an [H,W,3] array or None)."""
    made = from_poster(video, dst, max_side)
    if made:
        return made
    if decode is not None:
        try:
            arr = decode(video, 0)
        except Exception:
            arr = None
        if arr is not None:
            made = from_array(arr, dst, max_side)
            if made:
                return made
    return from_av(video, dst, max_side)
