"""The Edit panel's sound effects, for the render: the same table and arithmetic as
``js/bEpicViewer_audioFxData.js`` (kept in step; ``tests/test_edit_audio_fx.py``).

An effect is ``{"type", "on", "p": {param: value}, "keys": {param: [{"t", "v", "i"}]}}``; a chain is a
list of them, in order. EQ, compressor and limiter are ffmpeg's own filters (highpass / lowshelf /
equalizer / highshelf / lowpass, acompressor, alimiter), run in this process through PyAV's filter
graph - no program is started. Reverb (a convolution with the generated impulse response, what afir
does), delay (a feedback echo, WebAudio's DelayNode loop), gain and pan (WebAudio's equal-power
StereoPanner) are worked out with numpy, so that their keyframes (mix, gain, pan) follow the preview
sample for sample.

Preview and render sound alike, not identically: WebAudio's DynamicsCompressorNode (the compressor,
and the limiter as one with ratio 20) has its own attack / release curves and an automatic make-up
gain, where ffmpeg's acompressor / alimiter have theirs.
"""

import math
from fractions import Fraction

RATE = 48000

AFX = {
    "eq": {"hp": (0, 0, 2000), "ls_f": (120, 20, 1000), "ls_g": (0, -24, 24), "pk_f": (1000, 100, 10000),
           "pk_g": (0, -24, 24), "pk_q": (1, 0.1, 10), "hs_f": (8000, 1000, 16000), "hs_g": (0, -24, 24),
           "lp": (0, 0, 20000)},
    "comp": {"thr": (-18, -60, 0), "ratio": (4, 1, 20), "att": (10, 0.1, 1000), "rel": (100, 1, 2000),
             "knee": (6, 0, 18), "makeup": (0, 0, 24)},
    "limit": {"ceil": (-1, -24, 0), "rel": (50, 1, 1000)},
    "reverb": {"preset": ("room", None, None), "mix": (0.25, 0, 1), "decay": (0.8, 0.1, 8), "pre": (10, 0, 200)},
    "delay": {"time": (250, 5, 2000), "fb": (0.35, 0, 0.9), "mix": (0.3, 0, 1)},
    "gain": {"gain": (0, -60, 24)},
    "pan": {"pan": (0, -1, 1)},
}
NAMES = {"eq": "EQ", "comp": "Compressor", "limit": "Limiter", "reverb": "Reverb", "delay": "Delay", "gain": "Gain",
         "pan": "Pan"}
KEYED = {"reverb": ("mix",), "delay": ("mix",), "gain": ("gain",), "pan": ("pan",)}
REVERB_PRESETS = {"room": {"decay": 0.8, "tone": 0.45}, "hall": {"decay": 2.4, "tone": 0.3},
                  "plate": {"decay": 1.6, "tone": 0.05}}
MAX_AFX = 12
_EASES = ("linear", "in", "out", "inout", "hold")


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f and abs(f) != float("inf") else default


def _r5(v):
    return round(v * 1e5) / 1e5


def new_afx(kind):
    return {"type": kind, "on": True, "p": {k: d[0] for k, d in AFX[kind].items()}, "keys": {}}


def clean_one(x):
    if not isinstance(x, dict) or x.get("type") not in AFX:
        return None
    out = new_afx(x["type"])
    out["on"] = x.get("on") is not False
    given = x.get("p") if isinstance(x.get("p"), dict) else {}
    for k, (default, lo, hi) in AFX[x["type"]].items():
        v = given.get(k)
        if k == "preset":
            out["p"][k] = v if v in REVERB_PRESETS else default
        elif v is not None and v != "" and _num(v, None) is not None:
            out["p"][k] = _r5(max(lo, min(hi, float(v))))
    keys = x.get("keys") if isinstance(x.get("keys"), dict) else {}
    for k in KEYED.get(x["type"], ()):
        lo, hi = AFX[x["type"]][k][1:]
        by = {}
        for key in keys.get(k) or []:
            if not isinstance(key, dict):
                continue
            t, v = _num(key.get("t"), None), _num(key.get("v"), None)
            if t is None or v is None or t < 0:
                continue
            t = round(t * 1e4) / 1e4
            item = {"t": t, "v": _r5(max(lo, min(hi, v)))}
            if key.get("i") in _EASES and key.get("i") != "linear":
                item["i"] = key["i"]
            by[t] = item
        if by:
            out["keys"][k] = sorted(by.values(), key=lambda q: q["t"])[:1000]
    return out


def clean_chain(given):
    """A chain held to what it may be (cleanAfx in the JS)."""
    out = [c for c in (clean_one(x) for x in (given if isinstance(given, list) else [])) if c]
    return out[:MAX_AFX]


def active(chain):
    return any(fx.get("on") is not False and fx.get("type") in AFX for fx in chain or [])


def _ease(p, how):
    x = max(0.0, min(1.0, p))
    if how == "in":
        return x * x
    if how == "out":
        return 1 - (1 - x) * (1 - x)
    if how == "inout":
        return x * x * (3 - 2 * x)
    if how == "hold":
        return 0.0
    return x


def param_at(fx, k, t):
    """A param of an effect at time *t* (afxParam in the JS)."""
    keys = (fx.get("keys") or {}).get(k)
    if not keys:
        return _num((fx.get("p") or {}).get(k))
    if t <= keys[0]["t"]:
        return keys[0]["v"]
    if t >= keys[-1]["t"]:
        return keys[-1]["v"]
    for a, b in zip(keys, keys[1:]):
        if a["t"] <= t < b["t"]:
            return a["v"] + (b["v"] - a["v"]) * _ease((t - a["t"]) / (b["t"] - a["t"]), a.get("i"))
    return keys[-1]["v"]


def _db2lin(db):
    return 10 ** (_num(db) / 20)


def ffmpeg_filters(fx):
    """The ffmpeg filters of an EQ / compressor / limiter (afxFfmpeg in the JS)."""
    if not fx or fx.get("on") is False:
        return []
    p = fx.get("p") or {}
    kind = fx.get("type")
    if kind == "eq":
        out = []
        if _num(p.get("hp")) > 0:
            out.append(f"highpass=f={_g(p['hp'])}:t=q:w={_g(_r5(math.sqrt(0.5)))}")
        if _num(p.get("ls_g")):
            out.append(f"lowshelf=f={_g(p['ls_f'])}:t=s:w=1:g={_g(p['ls_g'])}")
        if _num(p.get("pk_g")):
            out.append(f"equalizer=f={_g(p['pk_f'])}:t=q:w={_g(p.get('pk_q', 1))}:g={_g(p['pk_g'])}")
        if _num(p.get("hs_g")):
            out.append(f"highshelf=f={_g(p['hs_f'])}:t=s:w=1:g={_g(p['hs_g'])}")
        if _num(p.get("lp")) > 0:
            out.append(f"lowpass=f={_g(p['lp'])}:t=q:w={_g(_r5(math.sqrt(0.5)))}")
        return out
    if kind == "comp":
        return [f"acompressor=threshold={_g(_r5(_db2lin(p.get('thr'))))}:ratio={_g(p.get('ratio', 4))}"
                f":attack={_g(p.get('att'))}:release={_g(p.get('rel'))}"
                f":knee={_g(_r5(max(1.0, min(8.0, _db2lin(p.get('knee'))))))}"
                f":makeup={_g(_r5(max(1.0, min(64.0, _db2lin(p.get('makeup'))))))}"]
    if kind == "limit":
        return [f"alimiter=limit={_g(_r5(max(0.0625, min(1.0, _db2lin(p.get('ceil'))))))}:release={_g(p.get('rel'))}:level=false"]
    return []


def _g(v):
    """A number as JavaScript prints it (1 not 1.0), so the two sides' filter strings are the same text."""
    f = float(v)
    return str(int(f)) if f == int(f) else repr(f)


def _mulberry32(seed):
    a = seed & 0xFFFFFFFF

    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return nxt


def _imul(a, b):
    return (a * b) & 0xFFFFFFFF


def reverb_ir(preset, decay, pre, rate=RATE):
    """The reverb's impulse response (reverbIR in the JS): ``(2, n)`` float32 (made once per setting)."""
    return _reverb_ir(str(preset), float(_num(decay, 0.8)), float(_num(pre)), int(rate)).copy()


@__import__("functools").lru_cache(maxsize=16)
def _reverb_ir(preset, decay, pre, rate):
    import numpy as np
    tone = (REVERB_PRESETS.get(preset) or REVERB_PRESETS["room"])["tone"]
    d = max(0.1, min(8.0, _num(decay, 0.8)))
    lead = int(round(max(0.0, _num(pre)) / 1000 * rate))
    n = lead + int(round(d * rate))
    out = np.zeros((2, n), dtype=np.float32)
    for ch in range(2):
        r = _mulberry32(1234567 + ch * 7919 + int(round(d * 1000)))
        lp, energy = 0.0, 0.0
        vals = np.zeros(n, dtype=np.float64)
        for k in range(lead, n):
            w = r() * 2 - 1
            lp = lp * tone + w * (1 - tone)
            v = lp * math.exp(-6.907755 * (k - lead) / rate / d)
            vals[k] = float(np.float32(v))
            energy += v * v
        s = 1 / math.sqrt(energy) if energy > 0 else 0.0
        out[ch] = (vals * s).astype(np.float32)
    return out


def pan_gains(pan):
    """WebAudio's StereoPannerNode for stereo in (panGains in the JS)."""
    p = max(-1.0, min(1.0, _num(pan)))
    if p <= 0:
        x = (p + 1) * math.pi / 2
        return 1.0, math.cos(x), 0.0, math.sin(x)
    x = p * math.pi / 2
    return math.cos(x), 0.0, math.sin(x), 1.0


def _param_line(fx, k, n, t0, rate):
    """Param *k* of *fx* for each of *n* samples from time *t0* (keys every 10 ms, straight between)."""
    import numpy as np
    if not (fx.get("keys") or {}).get(k):
        return None
    step = 0.01
    m = int(n / rate / step) + 2
    at = np.arange(m) * step
    vals = np.array([param_at(fx, k, t0 + float(t)) for t in at], dtype=np.float64)
    return np.interp(np.arange(n) / rate, at, vals)


def _ffmpeg_run(sound, filters, rate=RATE):
    """*sound* ``(2, n)`` through ffmpeg *filters* in a PyAV graph: the same length back."""
    import av
    import numpy as np
    if not filters:
        return sound
    g = av.filter.Graph()
    src = g.add_abuffer(sample_rate=rate, format="fltp", layout="stereo", time_base=Fraction(1, rate))
    prev = src
    for f in filters + [f"aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates={rate}"]:
        name, _, args = f.partition("=")
        node = g.add(name, args)
        prev.link_to(node)
        prev = node
    sink = g.add("abuffersink")
    prev.link_to(sink)
    g.configure()
    out = []

    def drain():
        while True:
            try:
                out.append(g.pull().to_ndarray())
            except (av.BlockingIOError, av.EOFError):
                return
    step = 4096
    for k in range(0, sound.shape[1], step):
        fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(sound[:, k:k + step], dtype=np.float32), format="fltp", layout="stereo")
        fr.sample_rate = rate
        fr.pts = k
        fr.time_base = Fraction(1, rate)
        g.push(fr)
        drain()
    g.push(None)
    drain()
    y = np.concatenate(out, axis=1) if out else np.zeros((2, 0), dtype=np.float32)
    n = sound.shape[1]
    if y.shape[1] < n:
        y = np.concatenate([y, np.zeros((2, n - y.shape[1]), dtype=np.float32)], axis=1)
    return y[:, :n].astype(np.float32)


def _convolve(x, ir):
    import numpy as np
    n = x.shape[1] + ir.shape[1] - 1
    size = 1 << (n - 1).bit_length()
    out = np.fft.irfft(np.fft.rfft(x, size, axis=1) * np.fft.rfft(ir, size, axis=1), size, axis=1)
    return out[:, :x.shape[1]].astype(np.float32)


def apply_chain(sound, chain, t0=0.0, rate=RATE):
    """*sound* ``(2, n)`` float32 through the effects of *chain* that are on. *t0*: the time (clip time
    for a clip's chain, film time for a track's) of its first sample, for the keys."""
    import numpy as np
    if sound is None or not active(chain):
        return sound
    x = np.asarray(sound, dtype=np.float32)
    n = x.shape[1]
    pending = []                       # ffmpeg filters run together, in order, before the next numpy effect

    def flush(y):
        nonlocal pending
        if pending:
            y = _ffmpeg_run(y, pending, rate)
            pending = []
        return y
    for fx in clean_chain(chain):
        if fx.get("on") is False:
            continue
        kind, p = fx["type"], fx["p"]
        if kind in ("eq", "comp", "limit"):
            pending.extend(ffmpeg_filters(fx))
            continue
        x = flush(x)
        if kind == "gain":
            line = _param_line(fx, "gain", n, t0, rate)
            g = 10 ** (line / 20) if line is not None else _db2lin(p["gain"])
            x = (x * g).astype(np.float32)
        elif kind == "pan":
            line = _param_line(fx, "pan", n, t0, rate)
            if line is None:
                lL, rL, lR, rR = pan_gains(p["pan"])
            else:
                q = np.clip(line, -1, 1)
                xl = np.where(q <= 0, (q + 1) * math.pi / 2, q * math.pi / 2)
                lL = np.where(q <= 0, 1.0, np.cos(xl))
                rL = np.where(q <= 0, np.cos(xl), 0.0)
                lR = np.where(q <= 0, 0.0, np.sin(xl))
                rR = np.where(q <= 0, np.sin(xl), 1.0)
            x = np.stack([x[0] * lL + x[1] * rL, x[0] * lR + x[1] * rR]).astype(np.float32)
        elif kind in ("reverb", "delay"):
            if kind == "reverb":
                wet = _convolve(x, reverb_ir(p["preset"], p["decay"], p["pre"], rate))
            else:
                d = max(1, int(round(_num(p["time"]) / 1000 * rate)))
                fb = _num(p["fb"])
                wet = np.zeros_like(x)
                # y[k] = x[k - d] + fb * y[k - d]: the delay line with its feedback loop, a block of d at a time.
                for a in range(d, n, d):
                    b = min(n, a + d)
                    wet[:, a:b] = x[:, a - d:b - d] + fb * wet[:, a - d:b - d]
            line = _param_line(fx, "mix", n, t0, rate)
            mix = line if line is not None else _num(p["mix"])
            x = (x * (1 - mix) + wet * mix).astype(np.float32)
    return flush(x)
