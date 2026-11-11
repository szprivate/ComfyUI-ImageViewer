"""Mouth shapes from a sound file, for lip sync in the 3D space.

No speech model: the sound is read in this process (PyAV, which ComfyUI has) and
measured frame by frame with numpy - how loud it is against the voice's own range,
where its energy lies (low and round, the middle and wide, high and hissing), and the
short drops between loud parts where the lips close (m, b, p). What comes back are
five curves per scene frame, each 0..1:

    open    the jaw (loudness, less while hissing)
    round   lips rounded and pushed out (o, u: energy low in the voice)
    wide    lips stretched (e, i: energy in the middle)
    closed  lips pressed together (m, b, p: a short drop between two voiced stretches)
    hiss    teeth together, lips a little apart (s, sh, f: energy high)

imageViewer_rigLipsync.js turns them into the character's own blendshapes. The
arithmetic is the plain signal kind (RMS, an FFT, band energies, smoothing), written
for this file; it reads speech roughly, not phoneme by phoneme.
"""
from __future__ import annotations

import math

import numpy as np

RATE = 16000
BANDS = {"low": (150, 900), "mid": (900, 2600), "high": (2600, 4000), "hiss": (4000, 7800)}
MAX_SECONDS = 20 * 60


def read_mono(path, rate=RATE, start=0.0, seconds=None):
    """A sound file (or a film's sound) as mono float32 at `rate`, from `start` for `seconds`."""
    import av
    with av.open(path) as box:
        streams = [s for s in box.streams if s.type == "audio"]
        if not streams:
            raise ValueError("the file has no sound")
        stream = streams[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=rate)
        chunks, got = [], 0
        limit = int(rate * min(seconds if seconds else MAX_SECONDS, MAX_SECONDS))
        skip = int(rate * max(0.0, start))
        for frame in box.decode(stream):
            for out in resampler.resample(frame):
                a = out.to_ndarray().reshape(-1)
                if skip:
                    cut = min(skip, len(a))
                    a, skip = a[cut:], skip - cut
                if a.size:
                    chunks.append(a.astype(np.float32))
                    got += a.size
            if got >= limit:
                break
        for out in resampler.resample(None) or []:
            chunks.append(out.to_ndarray().reshape(-1).astype(np.float32))
    data = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
    return data[:limit]


def _clamp(x):
    return np.clip(x, 0.0, 1.0)


def features(samples, fps, rate=RATE):
    """Per scene frame: dB over a frame's length about its middle, and the band shares of 32 ms there."""
    n = max(1, int(math.ceil(len(samples) / rate * fps)))
    span = max(64, int(rate / fps))
    win = 512
    hann = np.hanning(win).astype(np.float32)
    freqs = np.fft.rfftfreq(win, 1.0 / rate)
    masks = {k: (freqs >= a) & (freqs < b) for k, (a, b) in BANDS.items()}
    pad = max(win, span)
    padded = np.concatenate([np.zeros(pad, np.float32), samples, np.zeros(pad, np.float32)])
    db = np.empty(n)
    share = {k: np.empty(n) for k in BANDS}
    for i in range(n):
        mid = int((i + 0.5) / fps * rate) + pad
        part = padded[mid - span // 2: mid + span // 2]
        rms = float(np.sqrt(np.mean(part * part)) + 1e-9)
        seg = padded[mid - win // 2: mid + win // 2]
        db[i] = 20 * math.log10(rms)
        spec = np.abs(np.fft.rfft(seg * hann)) ** 2
        total = sum(float(spec[m].sum()) for m in masks.values()) + 1e-12
        for k, m in masks.items():
            share[k][i] = float(spec[m].sum()) / total
    return db, share


def mouth(samples, fps, rate=RATE, *, lead=1, smooth=1.0, strength=1.0):
    """The five curves (lists, one value per scene frame). `lead` frames earlier: a mouth moves before it sounds."""
    if len(samples) == 0:
        return {"frames": 0, "open": [], "round": [], "wide": [], "closed": [], "hiss": []}
    db, share = features(samples, fps, rate)
    n = len(db)
    peak = float(np.percentile(db, 97))
    floor = max(float(np.percentile(db, 10)) + 6.0, peak - 40.0)
    if peak - floor < 6:
        floor = peak - 6
    loud = _clamp((db - floor) / (peak - floor))
    voiced = loud > 0.12
    hiss = _clamp((share["hiss"] + 0.5 * share["high"] - 0.35) / 0.35) * voiced
    open_ = loud ** 0.8 * (1.0 - 0.65 * hiss)
    low = share["low"] / (share["low"] + share["mid"] + 1e-9)
    round_ = _clamp((low - 0.62) / 0.25) * voiced * (1 - hiss)
    wide = _clamp((share["mid"] - 0.33) / 0.3) * voiced * (1 - hiss)
    # Lips shut: a short dip (at most ~0.15 s) well under the voiced stretches on both sides.
    closed = np.zeros(n)
    span = max(2, int(round(0.15 * fps)))
    for i in range(1, n - 1):
        if loud[i] > loud[i - 1] or loud[i] > loud[i + 1]:
            continue
        before = loud[max(0, i - span):i].max(initial=0)
        after = loud[i + 1:i + 1 + span].max(initial=0)
        if before > 0.35 and after > 0.35 and loud[i] < 0.45 * min(before, after):
            closed[i] = 1.0
    open_ = open_ * (1 - closed)
    curves = {"open": open_, "round": round_, "wide": wide, "closed": closed, "hiss": hiss}
    out = {"frames": n}
    for k, c in curves.items():
        c = _smooth(c, smooth) if k != "closed" else np.maximum(c, 0.6 * _smooth(c, smooth))
        if lead > 0:
            c = np.concatenate([c[lead:], np.repeat(c[-1:], lead)])
        out[k] = [round(float(v), 4) for v in _clamp(c * strength)]
    out["peak_db"] = round(peak, 2)
    out["floor_db"] = round(floor, 2)
    return out


def _smooth(c, sigma):
    """A Gaussian over frames (sigma in frames); none at 0."""
    if sigma <= 0 or len(c) < 3:
        return c
    r = max(1, int(math.ceil(3 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(c, r, mode="edge"), k, mode="valid")


def from_file(path, fps, *, start=0.0, seconds=None, lead=1, smooth=1.0, strength=1.0):
    return mouth(read_mono(path, start=start, seconds=seconds), fps, lead=lead, smooth=smooth, strength=strength)
