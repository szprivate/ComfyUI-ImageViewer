"""Rendering a cut: the film of a timeline, made by the viewer itself.

The Edit panel changes a cut; this turns it into a film without leaving the
viewer. Everything happens in this process, through PyAV (which ComfyUI itself
depends on): the shots are decoded, brought to one size and frame rate, joined -
a cut is a join, a dissolve a blend of as many frames as it is long - and
encoded, with the shots' own sound and the bed under the film mixed the same
way. No program is started.

What it does NOT draw is the texts: a title's look and movement belong to
whatever made the timeline (agentY draws them from its presets), and all the
file says of one is where it goes. A render from here leaves them out and says
how many.

Sizes: every shot is scaled to fit the film and padded, never stretched. Sound
is 48 kHz stereo, held in memory for the length of the film, which is why a film
may be at most ``MAX_SECONDS`` long here.
"""

import os
from fractions import Fraction

from . import timeline_io

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
    import av
    import numpy as np
    if is_still(path):
        from PIL import Image
        with Image.open(path) as im:
            im = im.convert("RGB")
            dw, dh, _l, _t = fit(im.width, im.height, w, h)
            still = _canvas(np.asarray(im.resize((dw, dh))), w, h, np)
        for _ in range(count):
            yield still
        return
    with av.open(path) as src:
        if not src.streams.video:
            raise RenderError(f"{os.path.basename(path)} has no picture")
        stream = src.streams.video[0]
        dw, dh, _l, _t = fit(stream.width, stream.height, w, h)
        if start > 0.5:
            try:
                src.seek(int((start - 0.5) * 1_000_000))
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
            while made < count and start + (made + 0.5) / fps < frame.time:
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


def film_pictures(clips, counts, w, h, fps):
    """Every frame of the film, in order: the clips joined, the dissolves blended."""
    import numpy as np
    held = []
    for clip, (n, d_in, d_out) in zip(clips, counts):
        keep = []
        for k, frame in enumerate(_clip_pictures(clip["file"], float(clip["in"]), n, w, h, fps)):
            if k < d_in:
                a = (k + 1) / (d_in + 1)
                yield (held[k].astype(np.float32) * (1 - a) + frame.astype(np.float32) * a + 0.5).astype(np.uint8)
            elif k >= n - d_out:
                keep.append(frame)
            else:
                yield frame
        held = keep


def _spans(overlays, fps):
    """The clips of the higher video tracks as ``(first frame, frames, clip)``,
    lowest first: a later one in this list covers an earlier one."""
    spans = [(int(round(float(o["at"]) * fps)), max(1, int(round(float(o["length"]) * fps))), o)
             for o in overlays or []]
    return sorted(spans, key=lambda s: (s[2].get("order", 0), s[0]))


def covered(base, overlays, total, w, h, fps):
    """*total* frames: those of *base* (the cut), with the clips of the higher
    video tracks laid over them where they are. Where neither has a picture the
    frame is black. A covered frame of the cut is still read, so the cut keeps
    its time under what covers it."""
    import numpy as np
    spans = _spans(overlays, fps)
    black = np.zeros((h, w, 3), dtype=np.uint8)
    running = {}                      # span -> (its generator, the frame it gives next)
    for n in range(total):
        frame = next(base, None)
        top = None
        for k, (first, count, _clip) in enumerate(spans):
            if first <= n < first + count:
                top = k
        if top is not None:
            first, count, clip = spans[top]
            gen, due = running.get(top, (None, -1))
            if gen is None or due != n:           # just uncovered, or new: read from this moment of it
                done = n - first
                gen = _clip_pictures(clip["file"], float(clip["in"]) + done / fps, count - done, w, h, fps)
            over = next(gen, None)
            running[top] = (gen, n + 1)
            if over is not None:
                frame = over
        yield black if frame is None else frame


# ── texts ────────────────────────────────────────────────────────────────────

def _font(px):
    """A plain sans-serif at *px* pixels: Arial where the machine has it (what
    the viewer's preview draws with), else what Pillow can find."""
    from PIL import ImageFont
    for name in ("arial.ttf", "Arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default(size=px)


def draw_texts(picture, texts, n, fps):
    """*picture* (frame *n*) with the texts that stand at that moment drawn on it.

    Each as the Edit tab shows it: its middle at ``x`` / ``y`` of the picture,
    ``size`` percent of the picture's height, in its colour, with a dark edge so
    that it reads on any picture. The frame is returned as it came when no text
    stands on it.
    """
    moment = (n + 0.5) / fps
    now = [t for t in texts if t["start"] <= moment < t["start"] + t["length"] and str(t["text"]).strip()]
    if not now:
        return picture
    import numpy as np
    from PIL import Image, ImageDraw
    im = Image.fromarray(picture)
    draw = ImageDraw.Draw(im)
    h, w = picture.shape[0], picture.shape[1]
    for t in now:
        px = max(8, int(round(h * float(t["size"]) / 100.0)))
        font = _font(px)
        edge = max(1, px // 14)
        draw.multiline_text((w * float(t["x"]), h * float(t["y"])), str(t["text"]), font=font, anchor="mm",
                            align="center", fill=t["color"], stroke_width=edge, stroke_fill="#000000",
                            spacing=px * 0.2)
    return np.asarray(im)


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
        for frame in src.decode(stream):
            if frame.time is None:
                continue
            at = int(round((frame.time - start) * RATE))
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


def film_sound(cut, counts, fps, total_frames):
    """The film's sound as a ``(2, n)`` float array, or None when there is none.

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
        if cut.get("clip_sound", True) and not cut.get("v1_off") and volume > 0 and not is_still(clip["file"]):
            try:
                sound = _sound_of(clip["file"], float(clip["in"]), n / fps)
            except Exception:  # noqa: BLE001 - a shot whose sound will not decode is silent
                sound = None
            if sound is not None:
                sound = sound * volume
                fade_in, fade_out = int(round(d_in / fps * RATE)), int(round(d_out / fps * RATE))
                if fade_in:
                    sound[:, :fade_in] *= np.linspace(0.0, 1.0, fade_in, dtype=np.float32)
                if fade_out:
                    sound[:, -fade_out:] *= np.linspace(1.0, 0.0, fade_out, dtype=np.float32)
                a = int(round(start / fps * RATE))
                b = min(total, a + sound.shape[1])
                if b > a:
                    mix[:, a:b] += sound[:, :b - a]
                    heard = True
        at = start + n

    def lay(clip, replace):
        nonlocal heard
        a = int(round(float(clip["at"]) * RATE))
        want = int(round(float(clip["length"]) * RATE))
        b = min(total, a + want)
        if b <= a:
            return
        if replace:
            mix[:, a:b] = 0.0
        volume = float(clip.get("volume", 1.0))
        if volume <= 0 or is_still(clip["file"]):
            return
        try:
            sound = _sound_of(clip["file"], float(clip["in"]), want / RATE)
        except Exception:  # noqa: BLE001
            sound = None
        if sound is not None:
            mix[:, a:b] += sound[:, :b - a] * volume
            heard = True

    for _first, _count, clip in _spans(cut.get("overlays"), fps):
        lay(clip, True)
    for clip in cut.get("sounds") or []:
        lay(clip, False)
    bed = cut.get("bed")
    if bed and bed.get("file"):
        try:
            sound = _sound_of(bed["file"], float(bed.get("in") or 0), total / RATE)
        except Exception:  # noqa: BLE001
            sound = None
        if sound is not None:
            sound = sound * float(bed.get("gain", 1.0))
            fade = min(total, int(round(float(bed.get("fade_out", 1.0)) * RATE)))
            if fade:
                sound[:, -fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
            mix += sound[:, :total]
            heard = True
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
    video = timeline_io._track_of(doc, "video") or {}
    children = video.get("children") or []
    about = _note(doc)
    clips = []
    for c in edit["clips"]:
        note = _note(children[c["ref"]]) if 0 <= c["ref"] < len(children) else {}
        clips.append({"file": c["file"], "in": c["in"], "length": c["length"],
                      "transition": c["transition"], "name": c["name"],
                      "volume": float(note.get("volume", 1.0))})
    off = edit.get("off") or {}
    overlays, sounds = [], []
    for order, track in enumerate(edit.get("tracks") or []):
        if track.get("off"):
            continue
        for c in track.get("clips") or []:
            item = {"file": c["file"], "in": c["in"], "length": c["length"], "at": c["at"],
                    "volume": float(c.get("volume", 1.0)), "name": c["name"], "order": order,
                    "track": track.get("name") or track.get("id")}
            (sounds if track.get("kind") == "audio" else overlays).append(item)
    bed = None
    audio = timeline_io._track_of(doc, "audio") or {}
    beds = [k for k in audio.get("children") or [] if isinstance(k, dict)
            and str(k.get("OTIO_SCHEMA") or "").startswith("Clip")]
    if len(beds) == 1 and not off.get("A1"):
        note = _note(beds[0])
        start, _length = timeline_io._span(beds[0].get("source_range"))
        bed = {"file": timeline_io._file(beds[0].get("media_reference")), "in": start,
               "gain": float(note.get("gain", 1.0)), "fade_out": float(note.get("fade_out", 1.0))}
    texts = [] if off.get("T") else [
        {"text": t["text"], "start": float(t["start"]), "length": float(t["length"]), "size": t["size"],
         "x": t["x"], "y": t["y"], "color": t["color"]} for t in edit["texts"]]
    return {"name": edit["name"], "fps": float(edit["fps"] or 24.0), "clips": clips, "bed": bed,
            "draw": texts,
            "overlays": overlays, "sounds": sounds, "v1_off": bool(off.get("V1")),
            "texts": len(edit["texts"]), "clip_sound": bool(about.get("clip_sound", True)),
            "width": int(about.get("width") or 0), "height": int(about.get("height") or 0)}


def _size(cut):
    """The film's size: what the timeline says, else the first shot's own."""
    import av
    w, h = cut["width"], cut["height"]
    if not (w > 0 and h > 0):
        first = cut["clips"][0]["file"]
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


def check(cut, may_use=None):
    """Raise :class:`RenderError` for a cut that cannot be rendered."""
    if not cut["clips"]:
        raise RenderError("the cut has no clips")
    for i, c in enumerate(cut["clips"], 1):
        path = c["file"]
        if not path or not os.path.isfile(path):
            raise RenderError(f"clip {i}: {os.path.basename(path) or 'its file'} does not exist")
        if may_use is not None and not may_use(os.path.abspath(path)):
            raise RenderError(f"clip {i}: {os.path.basename(path)} is not a file the viewer may use")
    for c in list(cut.get("overlays") or []) + list(cut.get("sounds") or []):
        path = c["file"]
        what = f"{c.get('track') or 'a track'}: {os.path.basename(path) or 'a clip'}"
        if not path or not os.path.isfile(path):
            raise RenderError(f"{what} does not exist")
        if may_use is not None and not may_use(os.path.abspath(path)):
            raise RenderError(f"{what} is not a file the viewer may use")
    total = max([timeline_io.edit_length(cut)]
                + [float(c["at"]) + float(c["length"]) for c in cut.get("overlays") or []])
    if total > MAX_SECONDS:
        raise RenderError(f"a film of {total / 60:.0f} minutes is longer than this renders "
                          f"({MAX_SECONDS // 60} minutes)")
    bed = cut.get("bed")
    if bed and bed.get("file") and may_use is not None and not may_use(os.path.abspath(bed["file"])):
        cut["bed"] = None            # a bed that may not be read is left out, not a reason to refuse


def render(doc, out_path, fmt="mp4", may_use=None, codec=None, quality="high"):
    """Render the cut in *doc* to *out_path*.

    *fmt*, *codec* and *quality* are read through :mod:`export_rules`, the one
    table of what a format means: a MOV is ProRes unless H.264 is asked for.

    Returns ``{"path", "seconds", "frames", "width", "height", "fps", "sound",
    "texts_left_out"}``. Written beside the target first and moved over, so a
    render that fails leaves nothing half-written in its place.
    """
    import av
    import numpy as np
    fmt = fmt if fmt in FORMATS else "mp4"
    from . import export_rules
    how = export_rules.video_settings(fmt, codec, quality)
    packed = how["audio"] == "pcm_s16le"
    cut = read_cut(doc)
    check(cut, may_use)
    fps = cut["fps"] if cut["fps"] > 0 else 24.0
    w, h = _size(cut)
    counts = frame_counts(cut["clips"], fps)
    # As long as the cut, or as far as the last clip over it reaches.
    total = max([film_frames(counts)] + [first + count for first, count, _c in _spans(cut["overlays"], fps)])
    sound = film_sound(cut, counts, fps, total)
    base = iter(()) if cut["v1_off"] else film_pictures(cut["clips"], counts, w, h, fps)

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
            for picture in covered(base, cut["overlays"], total, w, h, fps):
                picture = draw_texts(picture, cut["draw"], made, fps)
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
    return {"path": out_path, "seconds": round(total / fps, 3), "frames": total, "width": w,
            "height": h, "fps": fps, "sound": sound is not None,
            # Texts are drawn now; the key stays for callers that read it.
            "texts_left_out": 0, "texts": len(cut["draw"]),
            "format": how["label"]}
