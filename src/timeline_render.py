"""Rendering a cut: the film of a timeline, made by the viewer itself.

The Edit panel changes a cut; this turns it into a film without leaving the
viewer. Everything happens in this process, through PyAV (which ComfyUI itself
depends on): the shots are decoded, brought to one size and frame rate, joined -
a cut is a join, a dissolve a blend of as many frames as it is long - and
encoded, with the shots' own sound and the bed under the film mixed the same
way. No program is started.

Titles are clips of the video tracks whose picture is words: drawn by
title_render (Pillow) as the Edit tab draws them, on a transparent frame laid
over what is under them like any clip's picture (:func:`lay`). A title whose
font is not on this machine is drawn with a fallback, and the render says so
(``notes``).

Sizes: every shot is scaled to fit the film and padded, never stretched. Sound
is 48 kHz stereo, held in memory for the length of the film, which is why a film
may be at most ``MAX_SECONDS`` long here.
"""

import os
from fractions import Fraction

from . import audio_fx, timeline_io

MAX_SECONDS = 20 * 60
MAX_SIDE = 4096
RATE = 48000
FORMATS = ("mp4", "mov")
_STILLS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")


class RenderError(ValueError):
    """The cut cannot be rendered; the message is for the person at the panel."""


def is_still(path):
    return str(path or "").lower().endswith(_STILLS)


def _even(v):
    v = max(2, int(round(v)))
    return v - (v % 2)


def fit(src_w, src_h, w, h):
    """The size a ``src_w x src_h`` picture is drawn at inside ``w x h``, and where:
    ``(draw_w, draw_h, left, top)``. Scaled to fit, centred, never stretched."""
    if src_w <= 0 or src_h <= 0:
        return w, h, 0, 0
    scale = min(w / src_w, h / src_h)
    dw, dh = min(w, _even(src_w * scale)), min(h, _even(src_h * scale))
    return dw, dh, (w - dw) // 2, (h - dh) // 2


def frame_counts(clips, fps):
    """For each clip: ``(frames, frames dissolved in, frames dissolved out)``."""
    out = []
    for i, c in enumerate(clips):
        n = max(1, int(round(float(c["length"]) * fps)))
        d_in = int(round(float(c.get("transition") or 0) * fps)) if i else 0
        d_out = int(round(float(clips[i + 1].get("transition") or 0) * fps)) if i + 1 < len(clips) else 0
        # A dissolve cannot be longer than what is left of the clip beside the other one.
        d_in = max(0, min(d_in, n - 1))
        d_out = max(0, min(d_out, n - 1 - d_in))
        out.append((n, d_in, d_out))
    # The two sides of a join have to agree on its length.
    for i in range(1, len(out)):
        d = min(out[i][1], out[i - 1][2])
        out[i] = (out[i][0], d, out[i][2])
        out[i - 1] = (out[i - 1][0], out[i - 1][1], d)
    return out


def film_frames(counts):
    return sum(n for n, _i, _o in counts) - sum(d for _n, d, _o in counts)


# ── picture ──────────────────────────────────────────────────────────────────

def _canvas(arr, w, h, np):
    """*arr* (already at its drawn size) centred on a black ``w x h`` frame."""
    if arr.shape[0] == h and arr.shape[1] == w:
        return arr
    out = np.zeros((h, w, 3), dtype=np.uint8)
    top, left = (h - arr.shape[0]) // 2, (w - arr.shape[1]) // 2
    out[top:top + arr.shape[0], left:left + arr.shape[1]] = arr
    return out


def _clip_pictures(path, start, count, w, h, fps):
    """*count* frames of the film's size, from *start* seconds into *path*.

    A frame of the film shows whatever the source shows at that moment, so a
    source at another frame rate is neither sped up nor slowed down. A source
    that ends early holds its last picture.
    """
    return _pictures_at(path, [start + (k + 0.5) / fps for k in range(count)], w, h)


def _pictures_at(path, times, w, h):
    """The pictures of *path* at the source moments *times* (seconds, rising),
    each the source frame on screen at that moment, fitted into ``w x h``."""
    import av
    import numpy as np
    count = len(times)
    if is_still(path):
        from PIL import Image
        with Image.open(path) as im:
            im = im.convert("RGB")
            dw, dh, _l, _t = fit(im.width, im.height, w, h)
            still = _canvas(np.asarray(im.resize((dw, dh))), w, h, np)
        for _ in range(count):
            yield still
        return
    if not count:
        return
    with av.open(path) as src:
        if not src.streams.video:
            raise RenderError(f"{os.path.basename(path)} has no picture")
        stream = src.streams.video[0]
        dw, dh, _l, _t = fit(stream.width, stream.height, w, h)
        first = times[0]
        if first > 0.5:
            try:
                src.seek(int((first - 0.5) * 1_000_000))
            except Exception:  # noqa: BLE001 - a file that will not seek is read from its start
                pass
        made = 0
        shown = None            # the picture on screen now, ready to hand out
        waiting = None          # the decoded frame that picture came from

        def ready(frame):
            return _canvas(frame.to_ndarray(width=dw, height=dh, format="rgb24"), w, h, np)

        for frame in src.decode(stream):
            if frame.time is None:
                continue
            # Every film frame whose moment lies before this source frame still
            # shows the one before it.
            while made < count and times[made] + 1e-6 < frame.time:
                if shown is None:
                    shown = ready(waiting if waiting is not None else frame)
                yield shown
                made += 1
            if made >= count:
                return
            waiting, shown = frame, None
        if shown is None and waiting is not None:
            shown = ready(waiting)
        if shown is None:
            raise RenderError(f"{os.path.basename(path)} could not be read")
        while made < count:
            yield shown
            made += 1


#: The moment of a clip's source shown u seconds into it, at its speed and through
#: its loop - the Edit tab's ``srcLocal``. One function for the render and for a
#: marked range's source frames (timeline_io.source_map).
source_moment = timeline_io.source_moment


def clip_frames(clip, done, count, w, h, fps):
    """Frames *done* .. *done* + *count* of *clip*: each the source frame at its
    moment (:func:`source_moment` - so a retimed clip repeats or skips source
    frames, nearest frame, and a loop runs the source again). Read in runs that
    go forwards through the file; a ping-pong's way back is read forwards and
    handed out reversed."""
    times = [source_moment(clip, (done + k + 0.5) / fps) for k in range(count)]
    plain = float(clip.get("speed") or 1.0) == 1.0 and not clip.get("loop") and not clip.get("motion") \
        and not timeline_io._ramp(clip)
    if plain:
        yield from _pictures_at(clip["file"], times, w, h)
        return
    k = 0
    while k < count:
        j = k + 1
        rising = j < count and times[j] >= times[k]
        while j < count and (times[j] >= times[j - 1]) == rising and (rising or times[j] < times[j - 1]):
            j += 1
        run = times[k:j]
        if rising or len(run) == 1:
            yield from _pictures_at(clip["file"], run, w, h)
        else:
            yield from reversed(list(_pictures_at(clip["file"], list(reversed(run)), w, h)))
        k = j


# ── a clip's transform, cropping and opacity ─────────────────────────────────

def ease_share(p, how):
    """How far from one key to the next a share *p* is (imageViewer_editTimelineData.easeShare)."""
    x = max(0.0, min(1.0, p))
    if how == "hold":
        return 0.0
    if how == "in":
        return x * x
    if how == "out":
        return 1.0 - (1.0 - x) * (1.0 - x)
    if how == "inout":
        return x * x * (3.0 - 2.0 * x)
    return x


def key_value(keys, u):
    """The value of a param's *keys* at clip time *u* (keyValue in the JS, the same arithmetic)."""
    if not keys:
        return None
    if u <= keys[0]["t"]:
        return keys[0]["v"]
    if u >= keys[-1]["t"]:
        return keys[-1]["v"]
    k = 0
    while k + 1 < len(keys) and keys[k + 1]["t"] <= u:
        k += 1
    a, b = keys[k], keys[k + 1]
    f = ease_share((u - a["t"]) / max(1e-9, b["t"] - a["t"]), a.get("i"))
    return a["v"] + (b["v"] - a["v"]) * f


def animated(fx):
    """Has *fx* keys for any picture param (not just the volume)?"""
    keys = (fx or {}).get("keys") if isinstance(fx, dict) else None
    return bool(keys) and any(p != "vol" for p in keys)


def fx_at(fx, u):
    """*fx* with each keyed param at its value at clip time *u* (rawFx(clip, u) in the JS)."""
    fx = timeline_io.clean_fx(fx)
    keys = fx.pop("keys", None) or {}
    for p, items in keys.items():
        if p in timeline_io.FX:
            fx[p] = key_value(items, u)
    return fx


def volume_at(clip, u):
    """A clip's volume at clip time *u*: its keys, else its number (clipVolume in the JS, but for mute)."""
    keys = ((clip.get("fx") or {}).get("keys") or {}).get("vol") if isinstance(clip.get("fx"), dict) else None
    if keys:
        return max(0.0, min(1.0, key_value(timeline_io.clean_keys({"vol": keys}).get("vol"), u)))
    return float(clip.get("volume", 1.0))


def volume_curve(clip, n, rate):
    """The gain of *clip* for each of *n* samples at *rate*, a key's value every 10 ms
    and straight lines between (None for a clip with no volume keys: its number)."""
    import numpy as np
    keys = ((clip.get("fx") or {}).get("keys") or {}).get("vol") if isinstance(clip.get("fx"), dict) else None
    if not keys or n <= 0:
        return None
    step = 0.01
    m = int(n / rate / step) + 2
    at = np.arange(m) * step
    gains = np.array([volume_at(clip, float(t)) for t in at], dtype=np.float32)
    return np.interp(np.arange(n) / rate, at, gains).astype(np.float32)


def effective(fx, u=0.0):
    """*fx* at clip time *u* with every key present and the sections that are
    switched off back at neutral - or None for a clip that is drawn as it comes."""
    fx = fx_at(fx, u)
    out = {key: neutral for key, (neutral, _l, _h) in timeline_io.FX.items()}
    out.update({"fh": False, "fv": False})
    for key, value in fx.items():
        if key in ("toff", "coff", "ooff"):
            continue
        section = "ooff" if key == "op" else "coff" if key in ("cl", "cr", "ct", "cb") else "toff"
        if not fx.get(section):
            out[key] = value
    plain = all(out[key] == neutral for key, (neutral, _l, _h) in timeline_io.FX.items()) \
        and not out["fh"] and not out["fv"]
    return None if plain else out


_BOXES = {}


def picture_box(path, w, h):
    """Where *path*'s picture lies in a ``w x h`` frame once fitted into it:
    ``(left, top, width, height)``. The rest of the frame is not picture."""
    key = (path, w, h)
    if key not in _BOXES:
        if len(_BOXES) > 256:
            _BOXES.clear()
        if is_still(path):
            from PIL import Image
            with Image.open(path) as im:
                sw, sh = im.size
        else:
            import av
            with av.open(path) as src:
                sw, sh = src.streams.video[0].width, src.streams.video[0].height
        dw, dh, _l, _t = fit(sw, sh, w, h)
        _BOXES[key] = ((w - dw) // 2, (h - dh) // 2, dw, dh)
    return _BOXES[key]


def lay(under, frame, fx, box):
    """*frame* (a clip's picture, fitted into the film's frame) drawn over *under*
    with *fx* - as the Edit tab draws it: cropped, then scaled and turned about
    its anchor point, then moved, at its opacity. *under* None is black. What of
    the frame is not the clip's picture (*box*) lets what is under show; a frame
    with an alpha channel of its own (a title) lets it show where that is clear."""
    import numpy as np
    from PIL import Image
    h, w = frame.shape[0], frame.shape[1]
    left, top, dw, dh = box
    alpha = np.zeros((h, w), dtype=np.uint8)
    a0, b0 = left + int(round(fx["cl"] * dw)), top + int(round(fx["ct"] * dh))
    a1, b1 = left + dw - int(round(fx["cr"] * dw)), top + dh - int(round(fx["cb"] * dh))
    if a1 > a0 and b1 > b0:
        alpha[b0:b1, a0:a1] = 255
    if frame.shape[2] == 4:
        alpha = (alpha.astype(np.uint16) * frame[:, :, 3] // 255).astype(np.uint8)
        frame = frame[:, :, :3]
    rgba = np.dstack([frame, alpha])
    sx = fx["zx"] * (-1.0 if fx["fh"] else 1.0)
    sy = fx["zy"] * (-1.0 if fx["fv"] else 1.0)
    turned = fx["rot"] % 360.0 != 0.0
    if sx != 1.0 or sy != 1.0 or turned or fx["x"] or fx["y"]:
        import math
        cx, cy = w / 2.0, h / 2.0
        ax, ay = fx["ax"] * w, -fx["ay"] * h                 # the anchor point, from the middle (y up)
        qx, qy = cx + fx["x"] * w + ax, cy - fx["y"] * h + ay    # where the anchor point lands
        cos, sin = math.cos(math.radians(fx["rot"])), math.sin(math.radians(fx["rot"]))
        # Output to source: undo the move, the turn (clockwise on screen), the scale.
        m = (cos / sx, sin / sx, -sin / sy, cos / sy)
        coeffs = (m[0], m[1], cx + ax - m[0] * qx - m[1] * qy,
                  m[2], m[3], cy + ay - m[2] * qx - m[3] * qy)
        rgba = np.asarray(Image.fromarray(rgba, "RGBA").transform((w, h), Image.AFFINE, coeffs,
                                                                  resample=Image.BILINEAR))
    weight = rgba[:, :, 3:4].astype(np.float32) * (fx["op"] / 255.0)
    below = np.zeros((h, w, 3), dtype=np.float32) if under is None else under.astype(np.float32)
    return (below * (1.0 - weight) + rgba[:, :, :3].astype(np.float32) * weight + 0.5).astype(np.uint8)


def film_pictures(clips, counts, w, h, fps):
    """Every frame of the film, in order: the clips joined, the dissolves blended.
    A gap of V1 (a ``blank`` clip) is None for each of its frames: nothing of the
    cut there - black, or what a higher track shows (:func:`covered`)."""
    import numpy as np
    held = []
    for clip, (n, d_in, d_out) in zip(clips, counts):
        if clip.get("blank"):
            # No dissolve into or out of a gap: the clips beside it cut.
            for _ in range(n):
                yield None
            held = []
            continue
        keep = []
        moving = animated(clip.get("fx"))
        fx = effective(clip.get("fx"))
        box = picture_box(clip["file"], w, h) if (fx or moving) else None
        for k, frame in enumerate(clip_frames(clip, 0, n, w, h, fps)):
            if moving:
                # Keyed: at the middle of frame k of the clip (the Edit tab draws frame f at (f + 0.5) / fps).
                fx = effective(clip.get("fx"), (k + 0.5) / fps)
            if fx:
                frame = lay(None, frame, fx, box)
            if k < d_in:
                yield transition_frame(clip.get("tfx"), held[k], frame, (k + 1) / (d_in + 1))
            elif k >= n - d_out:
                keep.append(frame)
            else:
                yield frame
        held = keep


def transition_frame(tfx, out, inn, a):
    """A frame of a V1 transition `a` (0..1) of the way through: the shot going out
    (`out`) and the one coming in (`inn`), as the Edit tab shows it
    (imageViewer_editTimelineData.js transitionLook): a cross dissolve, a dip to a
    colour (the first half to it, the second from it), or a wipe (the shot coming
    in uncovered by a straight edge)."""
    import numpy as np
    x = timeline_io.clean_tfx(tfx)
    if x and x["type"] == "wipe":
        h, w = inn.shape[:2]
        res = out.copy()
        if x["dir"] in ("right", "left"):
            n = int(round(a * w))
            if x["dir"] == "right":
                res[:, :n] = inn[:, :n]
            elif n:
                res[:, w - n:] = inn[:, w - n:]
        else:
            n = int(round(a * h))
            if x["dir"] == "down":
                res[:n] = inn[:n]
            elif n:
                res[h - n:] = inn[h - n:]
        return res
    fo, fi = out.astype(np.float32), inn.astype(np.float32)
    if x and x["type"] == "dip":
        rgb = [int(x["color"][i:i + 2], 16) for i in (1, 3, 5)]
        c = np.empty_like(fi)
        c[...] = (rgb + [255])[:fi.shape[-1]]
        mixed = fo * (1 - 2 * a) + c * (2 * a) if a < 0.5 else c * (2 - 2 * a) + fi * (2 * a - 1)
        return (mixed + 0.5).astype(np.uint8)
    return (fo * (1 - a) + fi * a + 0.5).astype(np.uint8)


def _spans(overlays, fps):
    """The clips of the higher video tracks as ``(first frame, frames, clip)``,
    lowest first: a later one in this list covers an earlier one."""
    spans = [(int(round(float(o["at"]) * fps)), max(1, int(round(float(o["length"]) * fps))), o)
             for o in overlays or []]
    return sorted(spans, key=lambda s: (s[2].get("order", 0), s[0]))


_NEUTRAL = None


def _neutral():
    """The effect of a clip drawn as it comes, every key present (a title is laid with it: never a cover)."""
    global _NEUTRAL
    if _NEUTRAL is None:
        _NEUTRAL = {key: neutral for key, (neutral, _l, _h) in timeline_io.FX.items()}
        _NEUTRAL.update({"fh": False, "fv": False})
    return dict(_NEUTRAL)


def title_frames(clip, done, count, w, h, fps, notes=None):
    """Frames *done* .. *done* + *count* of a title clip: its words on a transparent
    ``w x h`` frame (RGBA), drawn once - or, with keys on its numbers (size,
    tracking, line spacing, outline), at each frame's middle in clip time."""
    from . import title_render
    keys = ((clip.get("fx") or {}).get("keys") or {}) if isinstance(clip.get("fx"), dict) else {}
    keyed = any(k in keys for k in title_render.TITLE_KEYS)
    made = {}
    for k in range(count):
        look = title_render.title_at(clip["title"], keys, (done + k + 0.5) / fps) if keyed \
            else title_render.clean_title(clip["title"])
        sig = repr(sorted(look.items()))
        if sig not in made:
            if len(made) > 8:
                made.clear()
            made[sig], note = title_render.render(look, w, h)
            if note and notes is not None and note not in notes:
                notes.append(note)
                import logging
                logging.getLogger(__name__).warning("ImageViewer render: %s", note)
        yield made[sig]


def _frames_of(clip, done, count, w, h, fps, notes=None):
    if clip.get("title") is not None:
        return title_frames(clip, done, count, w, h, fps, notes)
    return clip_frames(clip, done, count, w, h, fps)


def covered(base, overlays, total, w, h, fps, notes=None):
    """*total* frames: those of *base* (the cut), with the clips of the higher
    video tracks laid over them where they are, lowest first. A clip as it comes
    covers the whole frame; one that was scaled, moved, turned, cropped or made
    translucent (its ``fx``) is drawn over what is under it. Where nothing has a
    picture the frame is black. A covered frame of the cut is still read, so the
    cut keeps its time under what covers it."""
    import numpy as np
    def look(clip, u=None):
        fx = effective(clip.get("fx")) if u is None else effective(clip.get("fx"), u)
        # A title is never a cover: what is under it is drawn, and it is laid over that.
        return fx or _neutral() if clip.get("title") is not None else fx
    spans = [(first, count, clip, look(clip)) for first, count, clip in _spans(overlays, fps)]
    # Down from the top, the first clip that is drawn as it comes hides the rest.
    black = np.zeros((h, w, 3), dtype=np.uint8)
    running = {}                      # span -> (its generator, the frame it gives next)
    for n in range(total):
        frame = next(base, None)
        on = [k for k, (first, count, _c, _fx) in enumerate(spans) if first <= n < first + count]
        # A keyed clip: its look at this frame's middle, clip time (as pictureAt / clipFx(clip, u) in the JS).
        now = {k: (look(spans[k][2], (n - spans[k][0] + 0.5) / fps) if animated(spans[k][2].get("fx"))
                   else spans[k][3]) for k in on}
        solid = max((i for i, k in enumerate(on) if now[k] is None), default=-1)
        for k in on[max(0, solid):]:
            first, count, clip, _fx = spans[k]
            fx = now[k]
            gen, due = running.get(k, (None, -1))
            if gen is None or due != n:           # just uncovered, or new: read from this moment of it
                done = n - first
                gen = _frames_of(clip, done, count - done, w, h, fps, notes)
            over = next(gen, None)
            running[k] = (gen, n + 1)
            if over is None:
                continue
            box = (0, 0, w, h) if clip.get("title") is not None else picture_box(clip["file"], w, h) if fx else None
            frame = over if fx is None else lay(frame, over, fx, box)
        yield black if frame is None else frame


# ── sound ────────────────────────────────────────────────────────────────────

def _sound_of(path, start, seconds):
    """*seconds* of *path*'s sound from *start*, as a ``(2, n)`` float array, or
    None when the file has none."""
    import av
    import numpy as np
    want = int(round(seconds * RATE))
    with av.open(path) as src:
        if not src.streams.audio:
            return None
        stream = src.streams.audio[0]
        if start > 1.0:
            try:
                src.seek(int((start - 1.0) * 1_000_000))
            except Exception:  # noqa: BLE001
                pass
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=RATE)
        out = np.zeros((2, want), dtype=np.float32)
        at = None
        for frame in src.decode(stream):
            # A frame without a time (some containers and decoders give none)
            # follows on from the one before: dropping it made the film silent.
            if frame.time is not None:
                at = int(round((frame.time - start) * RATE))
            elif at is None:
                at = int(round(-start * RATE))
            if at >= want:
                break
            for piece in resampler.resample(frame):
                data = piece.to_ndarray()
                if data.ndim == 1:
                    data = np.stack([data, data])
                n = data.shape[1]
                a, b = max(0, at), min(want, at + n)
                if b > a:
                    out[:, a:b] = data[:2, a - at:b - at]
                at += n
    return out


# A retimed clip's sound is played at its speed like tape - faster is higher,
# slower is lower, as the Edit tab plays it - and left out (silent) beyond
# these speeds, where it would be noise. A loop's sound loops with it.
SOUND_SPEEDS = (0.25, 4.0)


def clip_sound(clip, seconds):
    """*seconds* of *clip*'s sound as a ``(2, n)`` array (None for none): from its
    in point, at its speed, through its loop (:func:`source_moment`)."""
    import numpy as np
    if clip.get("motion") or timeline_io._ramp(clip):
        return None                     # frozen, reversed or ramped: silent, as the Edit tab plays it
    speed = float(clip.get("speed") or 1.0)
    span = float(clip.get("span") or 0)
    loop = clip.get("loop") if span > 0 else ""
    if speed == 1.0 and not loop:
        return _sound_of(clip["file"], float(clip["in"]), seconds)
    if not SOUND_SPEEDS[0] <= speed <= SOUND_SPEEDS[1]:
        return None
    need = span if loop else seconds * speed
    src = _sound_of(clip["file"], float(clip["in"]), need + 2.0 / RATE)
    if src is None or not src.shape[1]:
        return None
    want = int(round(seconds * RATE))
    q = np.arange(want, dtype=np.float64) / RATE * speed
    if loop == "loop":
        q = q % span
    elif loop == "pingpong":
        p = q % (2 * span)
        q = np.where(p < span, p, 2 * span - p)
    pos = np.clip(q * RATE, 0, src.shape[1] - 1)
    grid = np.arange(src.shape[1], dtype=np.float64)
    return np.stack([np.interp(pos, grid, src[c]) for c in range(2)]).astype(np.float32)


def handled_sound(clip, seconds, pre=0.0, post=0.0):
    """*clip*'s sound from *pre* seconds before its start to *post* after its end (a crossfade's
    handles), as a ``(2, n)`` array; silence where its file has nothing (before its start)."""
    import numpy as np
    if not pre and not post:
        return clip_sound(clip, seconds)
    speed = float(clip.get("speed") or 1.0)
    have = min(pre, float(clip["in"]) / speed) if speed > 0 else 0.0
    sound = clip_sound(dict(clip, **{"in": float(clip["in"]) - have * speed}), have + seconds + post)
    if sound is None:
        return None
    lead = int(round(pre * RATE)) - int(round(have * RATE))
    if lead > 0:
        sound = np.concatenate([np.zeros((2, lead), dtype=np.float32), sound], axis=1)
    return sound


def gain_line(clip, u, length):
    """The clip's volume at each clip time in *u* (its keys, held at the ends - the handles of a
    crossfade sound at the level of the clip's first and last moment), or its number."""
    import numpy as np
    keys = ((clip.get("fx") or {}).get("keys") or {}).get("vol") if isinstance(clip.get("fx"), dict) else None
    if not keys:
        return np.float32(float(clip.get("volume", 1.0)))
    step = 0.01
    m = int(max(0.0, length) / step) + 2
    at = np.arange(m) * step
    gains = np.array([volume_at(clip, float(t)) for t in at], dtype=np.float32)
    return np.interp(np.clip(u, 0.0, max(0.0, length)), at, gains).astype(np.float32)


def env_curve(env, u):
    """:func:`timeline_io.env_gain` for every clip time in the array *u* (the same arithmetic, vectorised)."""
    import numpy as np
    u = np.asarray(u, dtype=np.float64)
    length = float(env["len"])
    xin, xout = env.get("xin"), env.get("xout")

    def curve(name, p):
        p = np.clip(p, 0.0, 1.0)
        if name == "0":
            return p
        if name == "-3":
            return p ** 1.5
        return np.sin(p * np.pi / 2)
    lo = -xin["b"] if xin else 0.0
    hi = length + xout["a"] if xout else length
    g = np.ones_like(u)
    if xin:
        span = xin["b"] + xin["a"]
        if span > 0:
            g = np.where(u < xin["a"], g * curve(xin["curve"], (u + xin["b"]) / span), g)
    elif env.get("fi", 0) > 0:
        g = np.where(u < env["fi"], g * np.maximum(0.0, u) / env["fi"], g)
    if xout:
        span, s = xout["b"] + xout["a"], length - xout["b"]
        if span > 0:
            g = np.where(u > s, g * curve(xout["curve"], 1 - (u - s) / span), g)
    elif env.get("fo", 0) > 0:
        g = np.where(u > length - env["fo"], g * np.maximum(0.0, length - u) / env["fo"], g)
    g = np.where((u < lo - 1e-9) | (u > hi + 1e-9), 0.0, g)
    return np.clip(g, 0.0, 1.0).astype(np.float32)


def _unheard(notes, clip, exc):
    """Say that *clip*'s sound could not be read, once per file, in *notes* (a list, or None)."""
    if notes is None:
        return
    name = os.path.basename(str(clip.get("file") or "")) or "a clip"
    said = f"{name}: {str(exc).strip() or type(exc).__name__}"[:240]
    if not any(n.startswith(name + ":") for n in notes):
        notes.append(said)


def film_sound(cut, counts, fps, total_frames, only=None, fx=True, notes=None):
    """The film's sound as a ``(2, n)`` float array, or None when there is none.

    Sound effects (audio_fx): a clip's first, then its volume and fades, then its track's (a sound
    track's, the bed's), then the mix. *only*: just one part - "V1" (the cut's films, silent where a
    higher track covers them), "A1" (the bed) or a sound track's id - which the Resolve export bakes;
    *fx* False leaves the effects out (the dry sound). *notes*: a list that is told of each file whose
    sound could not be read - left silent, but never without saying so.

    Each clip's own sound sits where its picture is, fading in and out over its
    dissolves (which is a crossfade with its neighbour). A clip on a higher video
    track takes the place of what it covers, sound as well as picture - which is
    what the Edit tab plays. The bed and the clips of the sound tracks lie under
    all of it.
    """
    import numpy as np
    total = int(round(total_frames / fps * RATE))
    mix = np.zeros((2, total), dtype=np.float32)
    heard = False
    at = 0
    for clip, (n, d_in, d_out) in zip(cut["clips"], counts):
        start = at - d_in
        volume = float(clip.get("volume", 1.0))
        keyed = not clip.get("blank") and volume_curve(clip, 1, RATE) is not None
        # A gap has no sound; a clip whose sound was split off (`mute`) is heard
        # from its sound clip, on a sound track, at that clip's own place.
        if only in (None, "V1") and cut.get("clip_sound", True) and not cut.get("v1_off") and (volume > 0 or keyed) \
                and not clip.get("blank") and not clip.get("mute") and not is_still(clip["file"]):
            env = clip.get("env")
            # A crossfade's handles: the sound before the clip's start (coming in) and after its end (going out).
            pre = env["xin"]["b"] if env and env.get("xin") else 0.0
            post = env["xout"]["a"] if env and env.get("xout") else 0.0
            try:
                sound = handled_sound(clip, n / fps, pre, post)
            except Exception as exc:  # noqa: BLE001 - a shot whose sound will not decode is silent, and said
                _unheard(notes, clip, exc)
                sound = None
            if sound is not None and fx and clip.get("afx"):
                sound = audio_fx.apply_chain(sound, clip["afx"], -pre)       # the clip's effects, in its own time
            if sound is not None:
                # Volume keys (a key's value every 10 ms), fades and crossfades: a gain per sample, in the clip's own time.
                u = np.arange(sound.shape[1], dtype=np.float64) / RATE - pre
                sound = sound * gain_line(clip, u, n / fps)
                if env:
                    sound = sound * env_curve(env, u)
                fade_in, fade_out = int(round(d_in / fps * RATE)), int(round(d_out / fps * RATE))
                p0, p1 = int(round(pre * RATE)), int(round(post * RATE))
                if fade_in:
                    sound[:, p0:p0 + fade_in] *= np.linspace(0.0, 1.0, fade_in, dtype=np.float32)
                if fade_out:
                    end = sound.shape[1] - p1
                    sound[:, max(0, end - fade_out):end] *= np.linspace(1.0, 0.0, min(fade_out, end), dtype=np.float32)
                a = int(round(start / fps * RATE)) - p0
                lo = max(0, -a)
                b = min(total, a + sound.shape[1])
                if b > a + lo:
                    mix[:, a + lo:b] += sound[:, lo:b - a]
                    heard = True
        at = start + n

    def lay(clip, replace, into=None, quiet=False):
        nonlocal heard
        into = mix if into is None else into
        a = int(round(float(clip["at"]) * RATE))
        want = int(round(float(clip["length"]) * RATE))
        b = min(total, a + want)
        if b <= a:
            return
        if replace:
            mix[:, a:b] = 0.0
        if quiet:
            return
        volume = float(clip.get("volume", 1.0))
        curve = volume_curve(clip, want, RATE)
        if (volume <= 0 and curve is None) or clip.get("mute") or is_still(clip["file"]):
            return
        env = clip.get("env")
        pre = env["xin"]["b"] if env and env.get("xin") else 0.0
        post = env["xout"]["a"] if env and env.get("xout") else 0.0
        try:
            sound = handled_sound(clip, want / RATE, pre, post)
        except Exception as exc:  # noqa: BLE001
            _unheard(notes, clip, exc)
            sound = None
        if sound is not None and fx and clip.get("afx"):
            sound = audio_fx.apply_chain(sound, clip["afx"], -pre)
        if sound is not None:
            u = np.arange(sound.shape[1], dtype=np.float64) / RATE - pre
            sound = sound * gain_line(clip, u, float(clip["length"]))
            if env:
                sound = sound * env_curve(env, u)
            s0 = a - int(round(pre * RATE))
            lo = max(0, -s0)
            s1 = min(total, s0 + sound.shape[1])
            if s1 > s0 + lo:
                into[:, s0 + lo:s1] += sound[:, lo:s1 - s0]
                heard = True

    for _first, _count, clip in _spans(cut.get("overlays"), fps):
        if clip.get("title") is None and only in (None, "V1"):      # words cover no sound
            lay(clip, True, quiet=only == "V1")
    # The sound tracks, each on a bus of its own when it has effects (they work on the track's sum).
    chains = cut.get("track_afx") or {}
    buses = {}
    for clip in cut.get("sounds") or []:
        tid = clip.get("track_id")
        if only is not None and only != tid:
            continue
        if fx and audio_fx.active(chains.get(tid)):
            if tid not in buses:
                buses[tid] = np.zeros((2, total), dtype=np.float32)
            lay(clip, False, buses[tid])
        else:
            lay(clip, False)
    for tid, bus in buses.items():
        mix += audio_fx.apply_chain(bus, chains[tid], 0.0)
    bed = cut.get("bed") if only in (None, "A1") else None
    if bed and bed.get("file"):
        try:
            sound = _sound_of(bed["file"], float(bed.get("in") or 0), total / RATE)
        except Exception as exc:  # noqa: BLE001
            _unheard(notes, bed, exc)
            sound = None
        if sound is not None:
            sound = sound * float(bed.get("gain", 1.0))
            # Its fades, over the whole film (the bed lies under all of it).
            env = {"len": total / RATE, "fi": float(bed.get("fade_in", 0.0)), "fo": float(bed.get("fade_out", 1.0)),
                   "xin": None, "xout": None}
            sound = sound * env_curve(env, np.arange(sound.shape[1], dtype=np.float64) / RATE)
            if fx and audio_fx.active(chains.get("A1")):
                sound = audio_fx.apply_chain(np.ascontiguousarray(sound[:, :total]), chains["A1"], 0.0)
            mix += sound[:, :total]
            heard = True
    # The master (the whole mix only - a part rendered on its own for the Resolve bake is before it):
    # switched off the film is silent; its chain (the Mixer's master fader and pan) works on the sum.
    if only is None and cut.get("master_off"):
        return None
    if only is None and heard and fx and audio_fx.active(cut.get("master_afx")):
        mix = audio_fx.apply_chain(mix, cut["master_afx"], 0.0)
    return np.clip(mix, -1.0, 1.0) if heard else None


# ── the cut, as this module reads it ─────────────────────────────────────────

def _note(obj):
    meta = obj.get("metadata") if isinstance(obj, dict) else None
    note = meta.get("agentY") if isinstance(meta, dict) else None
    return note if isinstance(note, dict) else {}


def read_cut(doc):
    """The cut in an OTIO document, with what a render needs beyond the panel's
    view of it: the film's size, each clip's volume, the bed."""
    edit = timeline_io.editable(doc)
    envs = timeline_io.audio_envs(edit)
    video = timeline_io._track_of(doc, "video") or {}
    children = video.get("children") or []
    about = _note(doc)
    clips = []
    cut_in = False                          # the clip before was switched off: this one comes in with a cut
    listed = edit["clips"]
    for idx, c in enumerate(listed):
        note = _note(children[c["ref"]]) if 0 <= c["ref"] < len(children) else {}
        gapped = float(c.get("gap") or 0) > 0
        if gapped:
            # Empty time on V1 before the clip: a "blank" clip of that length, no file.
            clips.append({"blank": True, "file": "", "in": 0.0, "length": float(c["gap"]), "transition": 0.0,
                          "name": "gap"})
        if c.get("disabled"):
            # Switched off: a gap where it is (as the Edit tab plays it, pictureAt). Its dissolves become
            # cuts - the clip going out plays to where it began to dissolve, the one coming in from its start.
            t1 = 0.0 if (gapped or cut_in) else float(c.get("transition") or 0)
            after = listed[idx + 1] if idx + 1 < len(listed) else None
            t2 = float(after.get("transition") or 0) if after and not float(after.get("gap") or 0) > 0 else 0.0
            length = float(c["length"]) - t1 - t2
            if length > 1e-6:
                clips.append({"blank": True, "file": "", "in": 0.0, "length": length, "transition": 0.0,
                              "name": "off: " + str(c.get("name") or "")})
            cut_in = True
            continue
        clips.append({"file": c["file"], "in": c["in"], "length": c["length"],
                      "transition": 0.0 if gapped or cut_in else c["transition"], "name": c["name"],
                      "speed": c.get("speed", 1.0), "loop": c.get("loop", ""), "span": c.get("span", 0.0), "motion": c.get("motion", ""),
                      "volume": float(note.get("volume", 1.0)), "fx": c.get("fx") or {},
                      "mute": bool(c.get("mute")), "env": envs.get(("V1", idx)), "afx": c.get("afx") or [],
                      "tfx": timeline_io.clean_tfx(c.get("tfx"))})
        cut_in = False
    off = edit.get("off") or {}
    overlays, sounds = [], []
    for order, track in enumerate(edit.get("tracks") or []):
        if track.get("off"):
            continue
        for ci, c in enumerate(track.get("clips") or []):
            if c.get("disabled"):
                continue                    # switched off: not seen, not heard
            if c.get("title") is not None and track.get("kind") == "audio":
                continue
            item = {"file": c["file"], "in": c["in"], "length": c["length"], "at": c["at"],
                    "speed": c.get("speed", 1.0), "loop": c.get("loop", ""), "span": c.get("span", 0.0), "motion": c.get("motion", ""),
                    "volume": float(c.get("volume", 1.0)), "name": c["name"], "order": order,
                    "fx": c.get("fx") or {}, "mute": bool(c.get("mute")),
                    "track": track.get("name") or track.get("id"), "env": envs.get((track.get("id"), ci)),
                    "track_id": track.get("id"), "afx": c.get("afx") or []}
            if c.get("title") is not None:
                item.update(title=c["title"], file="", speed=1.0, loop="", span=0.0, motion="", volume=0.0)
            (sounds if track.get("kind") == "audio" else overlays).append(item)
    bed = None
    audio = timeline_io._track_of(doc, "audio") or {}
    beds = [k for k in audio.get("children") or [] if isinstance(k, dict)
            and str(k.get("OTIO_SCHEMA") or "").startswith("Clip")]
    if len(beds) == 1 and not off.get("A1"):
        note = _note(beds[0])
        start, _length = timeline_io._span(beds[0].get("source_range"))
        bed = {"file": timeline_io._file(beds[0].get("media_reference")), "in": start,
               "gain": float(note.get("gain", 1.0)), "fade_out": float(note.get("fade_out", 1.0)),
               "fade_in": timeline_io.bed_fades(beds[0])["fadeIn"]}
    # Texts of older cuts are titles by now (timeline_io.editable, texts_to_titles).
    titles = sum(1 for o in overlays if o.get("title") is not None)
    return {"name": edit["name"], "fps": float(edit["fps"] or 24.0), "clips": clips, "bed": bed,
            "overlays": overlays, "sounds": sounds, "v1_off": bool(off.get("V1")),
            "track_afx": {**{t.get("id"): t.get("afx") or [] for t in edit.get("tracks") or [] if t.get("kind") == "audio"},
                          "A1": (edit.get("afx") or {}).get("A1") or []},
            # The Mixer's master: on the whole mix (after every track), and its switch.
            "master_afx": (edit.get("afx") or {}).get("master") or [], "master_off": bool(off.get("master")),
            "texts": titles, "clip_sound": bool(about.get("clip_sound", True)),
            "width": int(about.get("width") or 0), "height": int(about.get("height") or 0)}


def _size(cut):
    """The film's size: what the timeline says, else the first shot's own."""
    import av
    w, h = cut["width"], cut["height"]
    if not (w > 0 and h > 0):
        first = next(c["file"] for c in cut["clips"] if not c.get("blank"))
        if is_still(first):
            from PIL import Image
            with Image.open(first) as im:
                w, h = im.size
        else:
            with av.open(first) as src:
                w, h = src.streams.video[0].width, src.streams.video[0].height
    if max(w, h) > MAX_SIDE:
        raise RenderError(f"a film of {w}x{h} is larger than this renders ({MAX_SIDE} px)")
    return _even(w), _even(h)


def film_total(cut, counts, fps):
    """The frames of the film: as long as the cut, or as far as the last clip over it - or the last
    sound of a sound track - reaches. Past its last picture the film is black (:func:`covered`)."""
    over = [first + count for first, count, _c in _spans(cut["overlays"], fps)]
    heard = [int(round((float(c["at"]) + float(c["length"])) * fps)) for c in cut.get("sounds") or []]
    return max([film_frames(counts)] + over + heard)


def check(cut, may_use=None):
    """Raise :class:`RenderError` for a cut that cannot be rendered."""
    if not [c for c in cut["clips"] if not c.get("blank")]:
        raise RenderError("the cut has no clips")
    for i, c in enumerate([c for c in cut["clips"] if not c.get("blank")], 1):
        path = c["file"]
        if not path or not os.path.isfile(path):
            raise RenderError(f"clip {i}: {os.path.basename(path) or 'its file'} does not exist")
        if may_use is not None and not may_use(os.path.abspath(path)):
            raise RenderError(f"clip {i}: {os.path.basename(path)} is not a file the viewer may use")
    for c in list(cut.get("overlays") or []) + list(cut.get("sounds") or []):
        if c.get("title") is not None:
            continue                         # words: no file
        path = c["file"]
        what = f"{c.get('track') or 'a track'}: {os.path.basename(path) or 'a clip'}"
        if not path or not os.path.isfile(path):
            raise RenderError(f"{what} does not exist")
        if may_use is not None and not may_use(os.path.abspath(path)):
            raise RenderError(f"{what} is not a file the viewer may use")
    total = max([timeline_io.edit_length(cut)]
                + [float(c["at"]) + float(c["length"]) for c in (cut.get("overlays") or []) + (cut.get("sounds") or [])])
    if total > MAX_SECONDS:
        raise RenderError(f"a film of {total / 60:.0f} minutes is longer than this renders "
                          f"({MAX_SECONDS // 60} minutes)")
    bed = cut.get("bed")
    if bed and bed.get("file") and may_use is not None and not may_use(os.path.abspath(bed["file"])):
        cut["bed"] = None            # a bed that may not be read is left out, not a reason to refuse


def render(doc, out_path, fmt="mp4", may_use=None, codec=None, quality="high", frames=None):
    """Render the cut in *doc* to *out_path*.

    *fmt*, *codec* and *quality* are read through :mod:`export_rules`, the one
    table of what a format means: a MOV is ProRes unless H.264 is asked for.

    Returns ``{"path", "seconds", "frames", "width", "height", "fps", "sound",
    "texts_left_out", "notes", "unheard"}`` - ``unheard``: the files whose sound
    could not be read (silent in the film). Written beside the target first and moved over, so a
    render that fails leaves nothing half-written in its place.

    *frames* ``(first, last)`` renders only those frames of the film, both
    included - the Edit panel's in and out ("export in-out only").
    """
    import av
    import numpy as np
    fmt = fmt if fmt in FORMATS else "mp4"
    from . import export_rules
    how = export_rules.video_settings(fmt, codec, quality)
    packed = how["audio"] == "pcm_s16le"
    cut = read_cut(doc)
    check(cut, may_use)
    notes = []                              # what the render has to say: a title's font not on this machine
    fps = cut["fps"] if cut["fps"] > 0 else 24.0
    w, h = _size(cut)
    counts = frame_counts(cut["clips"], fps)
    # As long as the cut, or as far as the last clip over it reaches.
    total = film_total(cut, counts, fps)
    unheard = []                            # files whose sound would not decode: the film is silent there
    sound = film_sound(cut, counts, fps, total, notes=unheard)
    base = iter(()) if cut["v1_off"] else film_pictures(cut["clips"], counts, w, h, fps)
    lo, hi = 0, total
    if frames:
        try:
            lo = max(0, min(total - 1, int(frames[0])))
            hi = max(lo + 1, min(total, int(frames[1]) + 1))
        except (TypeError, ValueError, IndexError):
            raise RenderError("the range to render is not two frames") from None
        if sound is not None:
            sound = sound[:, int(round(lo / fps * RATE)):int(round(hi / fps * RATE))]

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    tmp = out_path + ".part." + fmt
    rate = Fraction(fps).limit_denominator(1001)
    try:
        with av.open(tmp, "w", format="mov" if fmt == "mov" else "mp4") as out:
            vs = out.add_stream(how["encoder"], rate=rate, options=dict(how["options"]))
            vs.pix_fmt = how["pix_fmt"]
            vs.width, vs.height = w, h
            snd = None
            if sound is not None:
                snd = out.add_stream(how["audio"], rate=RATE)
                snd.layout = "stereo"
            step = 1024
            sent = 0

            def push_sound(until):
                nonlocal sent
                while snd is not None and sent < until:
                    piece = sound[:, sent:sent + step]
                    if packed:
                        s16 = (piece.T * 32767.0).astype(np.int16).reshape(1, -1)
                        af = av.AudioFrame.from_ndarray(np.ascontiguousarray(s16), format="s16", layout="stereo")
                    else:
                        af = av.AudioFrame.from_ndarray(np.ascontiguousarray(piece), format="fltp", layout="stereo")
                    af.sample_rate = RATE
                    af.pts = sent
                    for packet in snd.encode(af):
                        out.mux(packet)
                    sent += piece.shape[1]

            made = 0
            for n, picture in enumerate(covered(base, cut["overlays"], hi, w, h, fps, notes)):
                if n < lo:
                    continue
                frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(picture), format="rgb24")
                frame.pts = made
                for packet in vs.encode(frame):
                    out.mux(packet)
                made += 1
                # Sound is handed over alongside the picture it belongs to.
                push_sound(min(sound.shape[1], int(made / fps * RATE)) if sound is not None else 0)
            for packet in vs.encode(None):
                out.mux(packet)
            if snd is not None:
                push_sound(sound.shape[1])
                for packet in snd.encode(None):
                    out.mux(packet)
        os.replace(tmp, out_path)
    except RenderError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise RenderError(f"the film could not be rendered: {exc}") from None
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    return {"path": out_path, "seconds": round((hi - lo) / fps, 3), "frames": hi - lo, "width": w,
            "height": h, "fps": fps, "sound": sound is not None,
            # Titles are drawn; the key stays for callers that read it.
            "texts_left_out": 0, "texts": cut["texts"], "notes": notes, "unheard": unheard,
            "format": how["label"]}


def render_sound(doc, out_path, only=None, frames=None, fx=True):
    """The sound of the cut in *doc* - or of one part of it (*only*: "V1", "A1", a sound track's id;
    :func:`film_sound`) - with its effects (*fx*), as a 48 kHz stereo 16-bit WAV at *out_path*, as long
    as the film (or its *frames* ``(first, last)``). What the Resolve export bakes a part's effects into.
    Written beside the target and moved over. Returns the seconds written."""
    import av
    import numpy as np
    cut = read_cut(doc)
    fps = cut["fps"] if cut["fps"] > 0 else 24.0
    counts = frame_counts(cut["clips"], fps)
    total = film_total(cut, counts, fps)
    sound = film_sound(cut, counts, fps, total, only=only, fx=fx)
    n = int(round(total / fps * RATE))
    if sound is None:
        sound = np.zeros((2, n), dtype=np.float32)
    if frames:
        lo = max(0, min(total - 1, int(frames[0])))
        hi = max(lo + 1, min(total, int(frames[1]) + 1))
        sound = sound[:, int(round(lo / fps * RATE)):int(round(hi / fps * RATE))]
    tmp = out_path + ".part.wav"
    try:
        with av.open(tmp, "w", format="wav") as out:
            st = out.add_stream("pcm_s16le", rate=RATE)
            st.layout = "stereo"
            pcm = (np.clip(sound, -1, 1).T * 32767.0).astype(np.int16)
            for k in range(0, pcm.shape[0], 4096):
                af = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm[k:k + 4096].reshape(1, -1)), format="s16", layout="stereo")
                af.sample_rate = RATE
                af.pts = k
                for packet in st.encode(af):
                    out.mux(packet)
            for packet in st.encode(None):
                out.mux(packet)
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return sound.shape[1] / RATE
