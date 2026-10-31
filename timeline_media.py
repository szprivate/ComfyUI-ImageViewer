"""What the Edit panel draws inside its clips, and what its Auto edit measures.

Four readings of a media file, each done in this process through PyAV (a
ComfyUI dependency - no program is started, so the no-process rule holds) and
each cached on disk beside the viewer's thumbnails (ComfyUI's temp folder,
``bEpic_`` prefixed so Clear Cache collects them), keyed by the file's path,
mtime and size - a changed file is a new key, never a stale answer:

* :func:`probe` - how long a file is and what it holds (picture, sound). Only
  the container's header is read.
* :func:`peaks` - the sound as min / max per bucket at a few resolutions
  (``LEVELS`` buckets per second), quantised to signed bytes: the waveform of a
  sound clip, and of the lower part of a film clip that has sound.
* :func:`strip` - ``n`` small frames at evenly spaced moments, side by side on
  one JPEG (a sprite sheet): the filmstrip of a film clip. A still is one tile.
* :func:`beats` / :func:`shots` / :func:`detect_cuts` - where the beats of a piece of music fall and
  where a film cuts: the same arithmetic as agentY's ``read_beats`` /
  ``read_rhythm`` (agentY ``src/utils/edit_look.py``), ported so the viewer does
  not import agentY - the STFT is numpy's, ffmpeg's scene score is measured on
  small grey frames.

Every function here may take seconds on a long file or a slow share: callers run
them in worker threads, never on the event loop.
"""

import base64
import hashlib
import json
import os
import threading

import folder_paths

STILL_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff",
              ".exr", ".dpx", ".tga", ".hdr"}
SOUND_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}

# Waveform resolutions, buckets per second; a level that would hold more than
# MAX_BUCKETS is left out (a long file is drawn from the coarser ones).
LEVELS = (25, 100, 400)
MAX_BUCKETS = 1 << 17
PEAK_RATE = 16000
# Filmstrip sizes the panel may ask for; a request is rounded up to one of them.
STRIP_COUNTS = (1, 8, 16, 32, 64, 128, 256)
STRIP_HEIGHTS = (48, 96)
# Longer than this is not read for beats / cuts: the answer would arrive too late to be wanted.
MAX_ANALYSE_SECONDS = 20 * 60

_RATE = 22050
_HOP = 512
_FRAME_MIDDLE = _HOP + (_HOP * 4) // 2      # one hop on, plus half an analysis window
_PULSE = 0.3        # how strongly the onsets must repeat to count as a beat

_locks = {}
_locks_guard = threading.Lock()


class MediaError(ValueError):
    """The file cannot be read for this (no sound, no picture, unreadable)."""


def _ext(path):
    return os.path.splitext(str(path))[1].lower()


def is_still(path):
    return _ext(path) in STILL_EXTS


def _key(path):
    st = os.stat(path)
    raw = f"{os.path.normcase(os.path.abspath(path))}|{st.st_mtime_ns}|{st.st_size}"
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()[:20]


def cache_file(path, kind, ext):
    """Where the cached *kind* reading of *path* lies (the name changes with the file)."""
    tmp = folder_paths.get_temp_directory()
    os.makedirs(tmp, exist_ok=True)
    stem = "".join(c for c in os.path.splitext(os.path.basename(path))[0] if c.isalnum() or c in "-_")[:40] or "media"
    return os.path.join(tmp, f"bEpic_{kind}_{stem}_{_key(path)}.{ext}")


def etag(path, kind):
    """A validator for a reading of *path*: it changes exactly when the file does."""
    return '"' + hashlib.sha1(f"{kind}|{_key(path)}".encode()).hexdigest()[:24] + '"'


def _lock(name):
    """One lock per cache entry: two requests for the same reading make it once."""
    with _locks_guard:
        lk = _locks.get(name)
        if lk is None:
            if len(_locks) > 512:
                _locks.clear()
            lk = _locks[name] = threading.Lock()
        return lk


def _write_atomic(dst, data, binary=False):
    tmp = dst + f".{threading.get_ident()}.tmp"
    with open(tmp, "wb" if binary else "w", **({} if binary else {"encoding": "utf-8"})) as fh:
        fh.write(data)
    os.replace(tmp, dst)


def _cached_json(path, kind, make):
    dst = cache_file(path, kind, "json")
    if os.path.isfile(dst):
        try:
            with open(dst, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            pass
    with _lock(dst):
        if os.path.isfile(dst):
            try:
                with open(dst, encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, ValueError):
                pass
        got = make()
        _write_atomic(dst, json.dumps(got, separators=(",", ":")))
        return got


# ── what a file is ───────────────────────────────────────────────────────────

def probe(path):
    """``{"duration", "video", "audio", "still", "width", "height", "fps"}``.

    A still has no length of its own (``duration`` 0). Reads the header only.
    """
    if is_still(path):
        w = h = 0
        try:
            from PIL import Image
            with Image.open(path) as im:
                w, h = im.size
        except Exception:  # noqa: BLE001 - a picture PIL cannot open is still a picture
            pass
        return {"duration": 0.0, "video": True, "audio": False, "still": True, "width": w, "height": h, "fps": 0.0}
    import av
    try:
        with av.open(path) as c:
            vs = c.streams.video[0] if c.streams.video else None
            aus = c.streams.audio[0] if c.streams.audio else None
            dur = 0.0
            for s in (vs, aus):
                if s is not None and s.duration and s.time_base:
                    dur = max(dur, float(s.duration * s.time_base))
            if not dur and c.duration:
                dur = float(c.duration) / 1_000_000
            fps = float(vs.average_rate) if vs is not None and vs.average_rate else 0.0
            return {"duration": round(dur, 4), "video": vs is not None, "audio": aus is not None, "still": False,
                    "width": int(vs.width) if vs is not None else 0, "height": int(vs.height) if vs is not None else 0,
                    "fps": round(fps, 4)}
    except Exception as exc:  # noqa: BLE001 - av raises its own kinds
        raise MediaError(f"{os.path.basename(path)} could not be read: {exc}") from None


# ── sound ────────────────────────────────────────────────────────────────────

def _mono(path, rate, limit=None):
    """The file's sound, mixed to one channel at *rate*, as float32 (None: it has none)."""
    import av
    import numpy as np
    try:
        c = av.open(path)
    except Exception as exc:  # noqa: BLE001
        raise MediaError(f"{os.path.basename(path)} could not be read: {exc}") from None
    with c:
        if not c.streams.audio:
            return None
        stream = c.streams.audio[0]
        stream.thread_type = "AUTO"
        res = av.AudioResampler(format="flt", layout="mono", rate=rate)
        parts, have = [], 0
        cap = int(limit * rate) if limit else 0

        def take(frames):
            nonlocal have
            for f in frames:
                a = f.to_ndarray().reshape(-1)
                parts.append(a.astype(np.float32, copy=False))
                have += a.size
        try:
            for frame in c.decode(stream):
                take(res.resample(frame))
                if cap and have >= cap:
                    break
            take(res.resample(None))
        except Exception as exc:  # noqa: BLE001 - a damaged tail keeps what was read
            if not parts:
                raise MediaError(f"the sound of {os.path.basename(path)} could not be read: {exc}") from None
    if not parts:
        return np.zeros(0, dtype=np.float32)
    out = np.concatenate(parts)
    return out[:cap] if cap else out


def _levels_of(samples, rate):
    import numpy as np
    levels = []
    for bps in LEVELS:
        per = rate / bps
        n = int(np.ceil(samples.size / per)) if samples.size else 0
        if n > MAX_BUCKETS:
            continue
        if n == 0:
            levels.append({"bps": bps, "n": 0, "data": ""})
            continue
        edges = np.minimum(samples.size, np.round(np.arange(n + 1) * per).astype(np.int64))
        starts = edges[:-1]
        lo = np.minimum.reduceat(samples, starts)
        hi = np.maximum.reduceat(samples, starts)
        both = np.empty(n * 2, dtype=np.int8)
        both[0::2] = np.clip(np.round(lo * 127), -127, 127).astype(np.int8)
        both[1::2] = np.clip(np.round(hi * 127), -127, 127).astype(np.int8)
        levels.append({"bps": bps, "n": int(n), "data": base64.b64encode(both.tobytes()).decode("ascii")})
    return levels


def peaks(path):
    """The waveform of *path*'s sound.

    ``{"audio": bool, "duration", "levels": [{"bps", "n", "data"}]}`` - ``data``
    is base64 of signed bytes, min and max of each bucket in turn (-127..127 is
    -1..1). A file with no sound answers ``audio: false`` and no levels.
    """
    def make():
        samples = _mono(path, PEAK_RATE)
        if samples is None:
            return {"audio": False, "duration": 0.0, "levels": []}
        return {"audio": True, "duration": round(samples.size / PEAK_RATE, 4), "rate": PEAK_RATE,
                "levels": _levels_of(samples, PEAK_RATE)}
    return _cached_json(path, "peaks", make)


# ── pictures ─────────────────────────────────────────────────────────────────

def strip_size(n, h):
    """A request rounded to the sizes kept: ``(count, height)``."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        n = 16
    try:
        h = int(h)
    except (TypeError, ValueError):
        h = STRIP_HEIGHTS[0]
    n = next((c for c in STRIP_COUNTS if c >= n), STRIP_COUNTS[-1])
    h = next((c for c in STRIP_HEIGHTS if c >= h), STRIP_HEIGHTS[-1])
    return n, h


def strip(path, n=16, height=48):
    """``(jpeg path, meta)``: *n* frames of *path* side by side, each *height* high.

    ``meta`` is ``{"n", "tw", "th", "duration", "times"}``: frame i was taken at
    ``times[i]`` - the middle of the i-th of n equal parts of the file. A still
    is one tile however many were asked for. A film with fewer frames than *n*
    gives one tile per frame.
    """
    n, height = strip_size(n, height)
    still = is_still(path)
    kind = f"strip{1 if still else n}h{height}"
    dst = cache_file(path, kind, "jpg")
    meta_path = dst[:-4] + ".json"

    def load():
        if os.path.isfile(dst) and os.path.isfile(meta_path):
            try:
                with open(meta_path, encoding="utf-8") as fh:
                    return dst, json.load(fh)
            except (OSError, ValueError):
                return None
        return None
    got = load()
    if got:
        return got
    with _lock(dst):
        got = load()
        if got:
            return got
        sheet, meta = _make_still_strip(path, height) if still else _make_film_strip(path, n, height)
        import io
        buf = io.BytesIO()
        sheet.save(buf, "JPEG", quality=78)
        _write_atomic(dst, buf.getvalue(), binary=True)
        _write_atomic(meta_path, json.dumps(meta, separators=(",", ":")))
        return dst, meta


def _tile_width(w, h, height):
    if not (w > 0 and h > 0):
        return int(round(height * 16 / 9))
    return max(8, min(height * 4, int(round(height * w / h))))


def _make_still_strip(path, height):
    from PIL import Image
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            tw = _tile_width(im.width, im.height, height)
            tile = im.resize((tw, height), Image.BILINEAR)
    except Exception as exc:  # noqa: BLE001
        raise MediaError(f"{os.path.basename(path)} could not be read: {exc}") from None
    return tile, {"n": 1, "tw": tw, "th": height, "duration": 0.0, "times": [0.0]}


def _make_film_strip(path, n, height):
    import av
    from PIL import Image
    try:
        c = av.open(path)
    except Exception as exc:  # noqa: BLE001
        raise MediaError(f"{os.path.basename(path)} could not be read: {exc}") from None
    with c:
        if not c.streams.video:
            raise MediaError(f"{os.path.basename(path)} has no picture")
        vs = c.streams.video[0]
        vs.thread_type = "AUTO"
        dur = float(vs.duration * vs.time_base) if vs.duration and vs.time_base else (
            float(c.duration) / 1_000_000 if c.duration else 0.0)
        fps = float(vs.average_rate) if vs.average_rate else 24.0
        if dur > 0:
            n = max(1, min(n, int(dur * fps) or 1))
        tw = _tile_width(vs.width, vs.height, height)
        times = [round(dur * (i + 0.5) / n, 4) for i in range(n)] if dur > 0 else [0.0]
        n = len(times)
        sheet = Image.new("RGB", (tw * n, height), (20, 20, 20))
        filled = [False] * n

        def put(i, frame):
            sheet.paste(frame.to_image(width=tw, height=height), (i * tw, 0))
            filled[i] = True

        if dur <= 30 or n * 2 >= dur * fps:
            # Short (the usual generated clip): one pass through it is cheaper than seeking.
            nxt, last = 0, None
            for frame in c.decode(vs):
                if frame.time is None:
                    continue
                while nxt < n and frame.time + 0.5 / fps >= times[nxt]:
                    put(nxt, frame)
                    nxt += 1
                last = frame
                if nxt >= n:
                    break
            while last is not None and nxt < n:
                put(nxt, last)
                nxt += 1
        else:
            for i, t in enumerate(times):
                try:
                    c.seek(int(t / vs.time_base), stream=vs, backward=True, any_frame=False)
                except Exception:  # noqa: BLE001 - a file that will not seek gets the frames it has
                    break
                for frame in c.decode(vs):
                    if frame.time is None:
                        continue
                    if frame.time + 0.5 / fps >= t:
                        put(i, frame)
                        break
        # A tile nothing landed on shows its neighbour, not a hole.
        for i in range(n):
            if not filled[i]:
                j = next((k for k in range(i - 1, -1, -1) if filled[k]), None)
                if j is not None:
                    sheet.paste(sheet.crop((j * tw, 0, (j + 1) * tw, height)), (i * tw, 0))
    return sheet, {"n": n, "tw": tw, "th": height, "duration": round(dur, 4), "times": times}


# ── beats (agentY edit_look.beats, ported) ───────────────────────────────────

def onset_strength(samples, rate=_RATE, hop=_HOP):
    """How much NEW energy arrives in each hop of *samples*.

    agentY's version is ``scipy.signal.stft`` (periodic Hann, ``spectrum``
    scaling, no padding); this is the same transform in numpy, a block of frames
    at a time so a long piece does not need hundreds of MB at once.
    """
    import numpy as np
    nper = hop * 4
    if len(samples) < nper:
        return np.zeros(0)
    x = samples.astype("float32")
    win = np.hanning(nper + 1)[:-1].astype("float32")
    scale = 1.0 / float(win.sum())
    count = 1 + (len(x) - nper) // hop
    mags = []
    for first in range(0, count, 1024):
        k = np.arange(first, min(count, first + 1024))
        idx = k[:, None] * hop + np.arange(nper)[None, :]
        spec = np.fft.rfft(x[idx] * win, axis=1) * scale
        mags.append(np.log1p(np.abs(spec) * 10.0))
    mag = np.concatenate(mags, axis=0).T            # (freq, time), as scipy gives it
    flux = np.maximum(0.0, mag[:, 1:] - mag[:, :-1]).sum(axis=0)
    if flux.size and flux.max() > 0:
        flux = flux / flux.max()
    return flux


def _peak(corr, at):
    if at <= 0 or at + 1 >= len(corr):
        return float(at)
    a, b, c = float(corr[at - 1]), float(corr[at]), float(corr[at + 1])
    bend = a - 2 * b + c
    return float(at) if bend >= 0 else at + 0.5 * (a - c) / bend


def tempo_and_beats(strength, rate=_RATE, hop=_HOP, low=60.0, high=180.0):
    """``(bpm, [beat times])``; ``(0, [])`` with no steady pulse. agentY's arithmetic, unchanged."""
    import numpy as np
    n = len(strength)
    per_second = rate / hop
    if n < int(per_second * 2):
        return 0.0, []
    x = strength - strength.mean()
    if not np.any(x):
        return 0.0, []
    # The autocorrelation through the FFT: np.correlate is quadratic, minutes on a long piece.
    size = 1 << int(np.ceil(np.log2(2 * n)))
    spec = np.fft.rfft(x, size)
    corr = np.fft.irfft(spec * np.conj(spec), size)[:n]
    lo, hi = int(per_second * 60.0 / high), int(per_second * 60.0 / low)
    hi = min(hi, n - 1)
    if hi <= lo:
        return 0.0, []
    lag = lo + int(np.argmax(corr[lo:hi + 1]))
    if corr[lag] < _PULSE * corr[0]:
        return 0.0, []
    while lag // 2 >= lo:
        half = max(range(max(lo, lag // 2 - 1), lag // 2 + 2), key=lambda k: float(corr[k]))
        if corr[half] < 0.8 * corr[lag]:
            break
        lag = half
    period = _peak(corr, lag)
    for several in (4, 8, 16):
        far = int(round(period * several))
        if far + 2 >= n // 2:
            break
        best = max(range(far - 2, far + 3), key=lambda k: float(corr[k]))
        if corr[best] < 0.5 * corr[lag]:
            break
        period = _peak(corr, best) / several
    bpm = 60.0 * per_second / period

    def energy(offset):
        idx = np.round(np.arange(offset, n - 1, period)).astype(int)
        return float(strength[idx].sum())
    offset = max((o * 0.5 for o in range(int(period * 2))), key=energy)
    late = _FRAME_MIDDLE / rate
    times = [round(float(v) / per_second + late, 3) for v in np.arange(offset, n - 1, period)]
    return round(bpm, 1), times


def beats(path, limit=2000):
    """``{"bpm", "beats": [seconds], "duration"}`` for a sound or a film with sound."""
    def make():
        samples = _mono(path, _RATE, MAX_ANALYSE_SECONDS)
        if samples is None:
            raise MediaError(f"{os.path.basename(path)} has no sound")
        bpm, times = tempo_and_beats(onset_strength(samples))
        out = {"bpm": bpm, "beats": times[:limit], "duration": round(len(samples) / _RATE, 3)}
        if not bpm:
            out["note"] = "no steady pulse was found - there are no beats to cut on"
        return out
    return _cached_json(path, "beats", make)


# ── a film's cuts (agentY edit_look.shots_of, ported) ────────────────────────

def lengths_from_cuts(cuts, total, shortest=0.2):
    """Shot lengths from the moments a film cuts at (agentY's, unchanged)."""
    marks, last = [], 0.0
    for t in sorted(float(c) for c in cuts):
        if 0 < t < total and t - last >= shortest:
            marks.append(t)
            last = t
    edges = [0.0] + marks + [float(total)]
    return [round(b - a, 3) for a, b in zip(edges, edges[1:]) if b - a > 0]


def _long_span(fps):
    """How many frames apart the slow-change difference compares: half a second."""
    return max(4, int(round(fps * 0.5)))


def scan(path):
    """One pass through a film's pictures (64x36 grey): what cut detection needs.

    ``{"times", "mafd", "scores", "span", "long", "duration", "fps"}``, one
    entry per frame: its moment; its mean absolute difference from the frame
    before (0-255; 0 for the first); ffmpeg's scene score, min(mafd, |mafd -
    previous mafd|) / 100; and ``long``, its difference from the frame ``span``
    frames before - what a dissolve or a fade shows in, where no two
    neighbouring frames differ much.
    """
    import av
    import numpy as np
    from collections import deque
    try:
        c = av.open(path)
    except Exception as exc:  # noqa: BLE001
        raise MediaError(f"{os.path.basename(path)} could not be read: {exc}") from None
    times, mafds, scores, longs = [], [], [], []
    dur = 0.0
    with c:
        if not c.streams.video:
            raise MediaError(f"{os.path.basename(path)} has no picture")
        vs = c.streams.video[0]
        vs.thread_type = "AUTO"
        fps = float(vs.average_rate) if vs.average_rate else 24.0
        span = _long_span(fps)
        ring = deque(maxlen=span)
        prev_mafd = None
        for frame in c.decode(vs):
            if frame.time is None:
                continue
            if frame.time > MAX_ANALYSE_SECONDS:
                break
            g = frame.to_ndarray(width=64, height=36, format="gray").astype(np.float32)
            t = round(float(frame.time), 4)
            dur = max(dur, t)
            times.append(t)
            if ring:
                mafd = float(np.abs(g - ring[-1]).mean())
                diff = abs(mafd - prev_mafd) if prev_mafd is not None else 0.0
                mafds.append(round(mafd, 3))
                scores.append(round(min(1.0, min(mafd, diff) / 100.0), 4))
                prev_mafd = mafd
            else:
                mafds.append(0.0)
                scores.append(0.0)
            longs.append(round(float(np.abs(g - ring[0]).mean()), 3) if len(ring) == span else 0.0)
            ring.append(g)
        if vs.duration and vs.time_base:
            dur = max(dur, float(vs.duration * vs.time_base))
        else:
            dur += 1.0 / fps
    return {"times": times, "mafd": mafds, "scores": scores, "long": longs, "span": span,
            "duration": round(dur, 4), "fps": round(fps, 4)}


def _scanned(path):
    return _cached_json(path, "scan", lambda: scan(path))


def _hard_cuts(raw):
    """Frames that begin a new shot: ``[(frame, score, ratio)]``.

    A frame whose scene score is the peak of its moment, which stands out from
    the scores around it (``ratio``: its score over their median - the
    threshold adapts, so a shaky or noisy shot is measured against its own
    level), and whose change is a spike: the frames after it change far less.
    That last is what keeps the first frame of a dissolve from passing for a cut.
    """
    import numpy as np
    scores = np.asarray(raw["scores"], dtype=np.float32)
    mafd = np.asarray(raw["mafd"], dtype=np.float32)
    n = len(scores)
    out = []
    for i in range(1, n):
        s = float(scores[i])
        if s < 0.04 or s < float(scores[max(1, i - 2):i + 3].max()):
            continue
        after = mafd[i + 1:i + 4]
        if after.size and float(mafd[i]) < 2.5 * float(np.median(after)) + 1e-6:
            continue                                     # a step up, not a spike
        around = np.concatenate([scores[max(1, i - 12):max(1, i - 1)], scores[i + 2:i + 13]])
        level = float(np.median(around)) if around.size else 0.0
        out.append((i, round(s, 4), round(s / (level + 0.01), 2)))
    return out


def _dissolves(raw, hard):
    """Dissolves and fades: ``[(first frame, last frame, strength)]``.

    A blend from one shot into the next over frames a..b shows in the
    half-second difference ``long`` as a hump, from a to b + span, standing well
    above the level that motion keeps it at; a hard cut makes a hump too, so
    one with a cut in it is not a dissolve. The blend is where the hump's
    middle, less half a span, says.
    """
    import numpy as np
    longs = np.asarray(raw["long"], dtype=np.float32)
    span, fps = int(raw["span"]), float(raw["fps"]) or 24.0
    n = len(longs)
    if n <= span * 2:
        return []
    window = max(span * 4, int(fps * 2))
    base = np.array([float(np.median(longs[max(span, i - window):i + window + 1])) for i in range(n)])
    high = (longs > np.maximum(12.0, 2.5 * base)) & (np.arange(n) >= span)
    cuts = [h[0] for h in hard if h[2] >= 2.5 and h[1] >= 0.08]
    out = []
    i = 0
    while i < n:
        if not high[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and high[j + 1]:
            j += 1
        nxt = j + 1
        # The whole hump, not only its top: out to where it meets the level again.
        while i - 1 >= span and longs[i - 1] > 1.2 * base[i - 1] + 2.0:
            i -= 1
        while j + 1 < n and longs[j + 1] > 1.2 * base[j + 1] + 2.0:
            j += 1
        width = j - i + 1
        clean = not any(i - span - 1 <= k <= j + 1 for k in cuts)
        if clean and width >= span:
            w = longs[i:j + 1] - base[i:j + 1]
            centre = float((np.arange(i, j + 1) * w).sum() / max(1e-6, w.sum()))
            mid = centre - span / 2.0
            half = max(1.0, (width - span) / 2.0)
            first, last = max(1, int(round(mid - half))), min(n - 1, int(round(mid + half)))
            out.append((first, last, float(longs[i:j + 1].max())))
        i = max(nxt, j + 1)
    return out


def detect_cuts(path):
    """Scene cut detection: where a film that is already an edit cuts, for the panel to split it.

    ``{"cuts": [{"t", "frame", "score", "ratio", "kind"}], "fps", "duration"}``.
    A hard cut (``kind`` "cut") is at the moment of the first frame of the new
    shot; its ``score`` is ffmpeg's scene score and ``ratio`` how far it stands
    above the scores around it. A dissolve or fade (``kind`` "dissolve") is at
    its middle frame, with ``start`` / ``end`` its first and last blended
    moments. The panel keeps the cuts whose score reaches the sensitivity the
    user picks and whose ratio is 2.5 or more.
    """
    raw = _scanned(path)
    times = raw["times"]
    hard = _hard_cuts(raw)
    out = [{"t": times[i], "frame": i, "score": s, "ratio": r, "kind": "cut"} for i, s, r in hard]
    for a, b, strength in _dissolves(raw, hard):
        mid = int(round((a + b) / 2))
        # A dissolve is a softer cut: shown from a middling sensitivity on, by how strong it is.
        out.append({"t": times[mid], "frame": mid, "score": round(min(1.0, strength / 200.0), 4), "ratio": 10.0,
                    "kind": "dissolve", "start": times[a], "end": times[b]})
    out.sort(key=lambda c: c["t"])
    return {"cuts": out, "fps": raw["fps"], "duration": raw["duration"]}


def shots(path, sensitivity=0.3):
    """Where *path* cuts: ``{"shots": [lengths], "cuts": [times], "duration", "average"}``."""
    try:
        sensitivity = max(0.01, min(1.0, float(sensitivity)))
    except (TypeError, ValueError):
        sensitivity = 0.3

    raw = _scanned(path)
    cuts = [t for t, s in zip(raw["times"], raw["scores"]) if s > sensitivity]
    lengths = lengths_from_cuts(cuts, float(raw["duration"]))
    marks, at = [], 0.0
    for s in lengths[:-1]:
        at += s
        marks.append(round(at, 3))
    return {"shots": lengths, "cuts": marks, "duration": raw["duration"],
            "average": round(sum(lengths) / len(lengths), 3) if lengths else 0.0}


# ── material brought in ──────────────────────────────────────────────────────

def upload_name(name):
    """A dropped file's name, made safe to write: its base name, no odd characters."""
    base = os.path.basename(str(name or "").replace("\\", "/"))
    stem, ext = os.path.splitext(base)
    stem = "".join(ch if (ch.isalnum() or ch in "-_. ()") else "_" for ch in stem).strip(" .") or "clip"
    return stem[:120] + ext.lower()


def place_upload(folder, name, size):
    """``(path, exists)``: where an upload of *name* goes in *folder*. A file of the
    same name and size there is taken to be the same file and used again."""
    os.makedirs(folder, exist_ok=True)
    stem, ext = os.path.splitext(name)
    cand = os.path.join(folder, name)
    k = 1
    while os.path.exists(cand):
        try:
            if os.path.getsize(cand) == size:
                return cand, True
        except OSError:
            pass
        cand = os.path.join(folder, f"{stem}_{k}{ext}")
        k += 1
    return cand, False
