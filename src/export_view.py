"""Exporting what is on screen: the frame being looked at, or the whole clip.

The viewer shows three kinds of thing that can be written out - a picture, a
sequence of pictures, a video - and this turns any of them into the two
deliverables the export dialog offers: one PNG, or one film.

A picture is exported *as it is shown*: through the colourspace picked in the
viewer, so an EXR comes out as the sRGB picture that was on screen, not as its
scene-linear numbers. (The file itself is already on disk; copying it is the
file browser's job, not an export.) Exposure is a way of looking, and is left
out.

Everything is done in this process - PIL for pictures, PyAV for films - so no
program is started.
"""

import os
from fractions import Fraction

from . import export_rules, media_resolve, timeline_io, timeline_render

MAX_FRAMES = 5000


class ExportError(ValueError):
    """Nothing could be exported; the message is for the person at the dialog."""


def is_video(path):
    return os.path.splitext(path)[1].lower() in media_resolve.VIDEO_EXTS


def is_picture(path):
    return os.path.splitext(path)[1].lower() in media_resolve.IMAGE_EXTS


def picture(path, colorspace=""):
    """*path* as the viewer shows it: uint8 ``[H, W, 3]`` or ``[H, W, 4]``."""
    import numpy as np
    from PIL import Image
    from . import color_io
    ext = os.path.splitext(path)[1].lower()
    plain = ext in media_resolve.BROWSER_IMAGE_EXTS and ext != ".svg"
    if plain and (ext in media_resolve._NO_COLOR_EXTS or color_io.is_identity(colorspace)):
        with Image.open(path) as im:
            im.seek(0)
            return np.asarray(im.convert("RGBA" if "A" in im.getbands() or "transparency" in im.info else "RGB"))
    try:
        rgb, alpha = media_resolve._read_float(path)
    except Exception as exc:  # noqa: BLE001
        raise ExportError(f"{os.path.basename(path)} could not be read: {exc}") from None
    color_io.to_srgb(rgb, colorspace or "", 0.0)
    u8 = media_resolve._to_u8(rgb)
    if alpha is not None:
        return np.dstack([u8, media_resolve._to_u8(np.array(alpha, dtype="float32"))])
    return u8


def write_png(arr, out_path):
    from PIL import Image
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".part"
    Image.fromarray(arr).save(tmp, "PNG", compress_level=4)
    os.replace(tmp, out_path)
    return {"path": out_path, "width": int(arr.shape[1]), "height": int(arr.shape[0]), "frames": 1}


def frame_of(path, index=0, colorspace=""):
    """The picture to export for "the current frame" of *path*."""
    if is_video(path):
        arr = media_resolve._decode_video_frame(path, max(0, int(index)))
        if arr is None:
            raise ExportError(f"frame {index} of {os.path.basename(path)} could not be decoded")
        return arr
    return picture(path, colorspace)


def _video_facts(path):
    import av
    with av.open(path) as src:
        if not src.streams.video:
            raise ExportError(f"{os.path.basename(path)} has no picture")
        stream = src.streams.video[0]
        fps = float(stream.average_rate or stream.guessed_rate or 24)
        if stream.duration and stream.time_base:
            seconds = float(stream.duration * stream.time_base)
        elif src.duration:
            seconds = src.duration / 1_000_000
        elif stream.frames:
            seconds = stream.frames / fps
        else:
            raise ExportError(f"the length of {os.path.basename(path)} could not be read")
    return fps, seconds


def write_video_clip(path, out_path, fmt, codec, quality, may_use):
    """A whole video, written again in the format asked for: a cut of one clip,
    so the picture, the sound and the encoder are the Edit panel's own."""
    fps, seconds = _video_facts(path)
    name = os.path.splitext(os.path.basename(path))[0]
    doc = timeline_io.rebuild(timeline_io.new_doc(name, fps),
                              {"clips": [{"file": path, "in": 0.0, "length": seconds, "transition": 0,
                                          "name": name}], "texts": []},
                              "", may_use)
    return timeline_render.render(doc, out_path, fmt, may_use, codec, quality)


def write_sequence(paths, out_path, fps, fmt, codec, quality, colorspace=""):
    """Pictures as a film, one frame each, encoded as they are read so a long
    sequence is never held in memory. The first picture sets the size; one of
    another size is scaled to fit and padded."""
    import av
    import numpy as np
    from PIL import Image
    if not paths:
        raise ExportError("there are no frames to export")
    if len(paths) > MAX_FRAMES:
        raise ExportError(f"{len(paths)} frames are more than this exports at once ({MAX_FRAMES})")
    how = export_rules.video_settings(fmt, codec, quality)
    fps = float(fps) if fps and float(fps) > 0 else 24.0
    first = picture(paths[0], colorspace)[:, :, :3]
    w, h = timeline_render._even(first.shape[1]), timeline_render._even(first.shape[0])
    if max(w, h) > timeline_render.MAX_SIDE:
        raise ExportError(f"frames of {w}x{h} are larger than this encodes ({timeline_render.MAX_SIDE} px)")

    def fitted(arr):
        arr = arr[:, :, :3]
        if arr.shape[1] == w and arr.shape[0] == h:
            return arr
        fw, fh, _left, _top = timeline_render.fit(arr.shape[1], arr.shape[0], w, h)
        if (fw, fh) != (arr.shape[1], arr.shape[0]):
            arr = np.asarray(Image.fromarray(arr).resize((fw, fh), Image.LANCZOS))
        return timeline_render._canvas(arr, w, h, np)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".part." + fmt
    container = {"mov": "mov", "webm": "webm"}.get(fmt, "mp4")
    made = 0
    try:
        with av.open(tmp, "w", format=container) as out:
            vs = out.add_stream(how["encoder"], rate=Fraction(fps).limit_denominator(1001),
                                options=dict(how["options"]))
            vs.pix_fmt = how["pix_fmt"]
            vs.width, vs.height = w, h
            for i, p in enumerate(paths):
                arr = fitted(first if i == 0 else picture(p, colorspace))
                frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(arr), format="rgb24")
                frame.pts = made
                for packet in vs.encode(frame):
                    out.mux(packet)
                made += 1
            for packet in vs.encode(None):
                out.mux(packet)
        os.replace(tmp, out_path)
    except ExportError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ExportError(f"the film could not be encoded: {exc}") from None
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    return {"path": out_path, "width": w, "height": h, "frames": made, "fps": fps,
            "seconds": round(made / fps, 3), "format": how["label"]}
