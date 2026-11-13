"""Comp's deep pictures in numpy: the twin of js/imageViewer_compDeep.js (read its header for the rules), plus
reading and writing deep OpenEXR files.

A deep picture is ``{"w", "h", "n": uint32 [w*h] (samples a pixel), "s": float32 [total, 6] (r g b a z zback)}``,
pixel after pixel top-left first, each pixel's samples front first (at one depth in the order they came in).
Loadable on its own (numpy only; OpenEXR is imported when a file is read or written)."""
import numpy as np

SAMPLE = 6


def empty(w, h):
    return {"w": w, "h": h, "n": np.zeros(w * h, np.uint32), "s": np.zeros((0, SAMPLE), np.float32)}


def offsets(d):
    o = np.zeros(d["w"] * d["h"] + 1, np.int64)
    np.cumsum(d["n"], out=o[1:])
    return o


def _pixels(d):
    """The pixel each sample belongs to."""
    return np.repeat(np.arange(d["w"] * d["h"]), d["n"].astype(np.int64))


def _ranks(d):
    """Each sample's place among its pixel's samples (0 = front)."""
    o = offsets(d)
    pix = _pixels(d)
    return np.arange(len(pix)) - o[pix], pix


def _build(w, h, pix, s):
    """Samples already in pixel order (front first within a pixel) -> a deep picture."""
    return {"w": w, "h": h, "n": np.bincount(pix, minlength=w * h).astype(np.uint32) if len(pix) else np.zeros(w * h, np.uint32),
            "s": np.ascontiguousarray(s, np.float32).reshape(-1, SAMPLE)}


def sort_samples(d):
    """Each pixel's samples front first, stable (a file's may come in any order)."""
    pix = _pixels(d)
    if not len(pix):
        return d
    o = np.lexsort((np.arange(len(pix)), d["s"][:, 4], pix))
    return {"w": d["w"], "h": d["h"], "n": d["n"], "s": d["s"][o]}


def deep_from_image(img, depth, z):
    h, w = img.shape[:2]
    flat = img.reshape(-1, 4)
    m = np.any(flat != 0, axis=1)
    if depth is not None:
        dd = depth.reshape(-1)
        zz = np.where(dd > 0, dd, np.float32(z)).astype(np.float32)
    else:
        zz = np.full(w * h, z, np.float32)
    s = np.zeros((int(m.sum()), SAMPLE), np.float32)
    s[:, :4] = flat[m]
    s[:, 4] = zz[m]
    s[:, 5] = zz[m]
    return {"w": w, "h": h, "n": m.astype(np.uint32), "s": s}


def deep_merge(lst):
    d0 = lst[0]
    pix = np.concatenate([_pixels(d) for d in lst])
    s = np.concatenate([d["s"] for d in lst]) if lst else np.zeros((0, SAMPLE), np.float32)
    if not len(pix):
        return empty(d0["w"], d0["h"])
    o = np.lexsort((np.arange(len(pix)), s[:, 4], pix))
    return _build(d0["w"], d0["h"], pix[o], s[o])


def _dense(d):
    """[ranks, pixels] arrays of a deep picture's samples: z (inf where none) and the sample itself."""
    P = d["w"] * d["h"]
    mx = int(d["n"].max()) if P else 0
    r, pix = _ranks(d)
    z = np.full((mx, P), np.inf)
    s = np.zeros((mx, P, SAMPLE))
    if len(pix):
        z[r, pix] = d["s"][:, 4]
        s[r, pix] = d["s"]
    return z, s, mx


def deep_holdout(src, hold):
    hz, hs, mx = _dense(hold)
    pix = _pixels(src)
    sz = src["s"][:, 4].astype(np.float64)
    t = np.ones(len(pix))
    for r in range(mx):
        m = hz[r, pix] < sz
        t = np.where(m, t * (1 - hs[r, pix, 3]), t)
    out = src["s"].astype(np.float64).copy()
    out[:, :4] = out[:, :4] * t[:, None]
    return {"w": src["w"], "h": src["h"], "n": src["n"].copy(), "s": out.astype(np.float32)}


def deep_crop(d, znear, zfar, outside):
    z = d["s"][:, 4]
    keep = (z >= znear) & ((zfar <= 0) | (z <= zfar))
    if outside:
        keep = ~keep
    return _build(d["w"], d["h"], _pixels(d)[keep], d["s"][keep])


def deep_flatten(d):
    """(img [h, w, 4], depth [h, w]): front to back with "over"; depth the front sample with alpha (0: none)."""
    w, h = d["w"], d["h"]
    z, s, mx = _dense(d)
    P = w * h
    acc = np.zeros((P, 4))
    t = np.ones(P)
    front = np.zeros(P)
    for r in range(mx):
        v = z[r] < np.inf
        c = s[r]
        acc += np.where(v[:, None], t[:, None] * c[:, :4], 0)
        hit = v & (front == 0) & (c[:, 3] > 0)
        front[hit] = c[hit, 4]
        t = np.where(v, t * (1 - c[:, 3]), t)
    return acc.reshape(h, w, 4).astype(np.float32), front.reshape(h, w).astype(np.float32)


def deep_place(src, cw, ch, scale):
    W = max(1, int(np.floor(cw * scale + 0.5)))
    H = max(1, int(np.floor(ch * scale + 0.5)))
    y = np.arange(H)
    x = np.arange(W)
    sy = np.floor((y + 0.5) / scale).astype(np.int64) - (ch - src["h"])
    sx = np.floor((x + 0.5) / scale).astype(np.int64)
    SY, SX = np.meshgrid(sy, sx, indexing="ij")
    ok = (SX >= 0) & (SY >= 0) & (SX < src["w"]) & (SY < src["h"])
    si = np.where(ok, SY * src["w"] + SX, 0).ravel()
    okr = ok.ravel()
    cnt = np.where(okr, src["n"][si], 0).astype(np.int64)
    o = offsets(src)
    starts = o[si]
    tot = int(cnt.sum())
    if tot:
        before = np.cumsum(cnt) - cnt
        idx = np.repeat(starts - before, cnt) + np.arange(tot)
        s = src["s"][idx]
    else:
        s = np.zeros((0, SAMPLE), np.float32)
    return {"w": W, "h": H, "n": cnt.astype(np.uint32), "s": np.ascontiguousarray(s, np.float32)}


def encode(d) -> bytes:
    """As the page's decodeDeep reads it: counts (uint32) then the samples (float32), little endian."""
    return d["n"].astype("<u4").tobytes() + np.ascontiguousarray(d["s"], "<f4").tobytes()


# ── files ────────────────────────────────────────────────────────────────────

_NAMES = {"R": 0, "G": 1, "B": 2, "A": 3, "Z": 4, "ZBack": 5}


def read_deep(path):
    """A deep OpenEXR file's first deep part, sorted front first; its plain R G B A Z ZBack channels (a missing A is
    1, a missing ZBack is Z). ValueError when the file has no deep part."""
    import OpenEXR
    with OpenEXR.File(path, separate_channels=True) as f:
        part = next((p for p in f.parts if str(p.header.get("type", "")).endswith("deepscanline")
                     or str(p.header.get("type", "")).endswith("deeptile")), None)
        if part is None:
            raise ValueError("not a deep EXR")
        chans = {}
        for name, c in part.channels.items():
            base = name.rsplit(".", 1)[-1]
            if base in _NAMES and (base not in chans or "." not in name):
                chans[base] = c.pixels
        if "Z" not in chans:
            raise ValueError("a deep EXR without Z")
        zpx = chans["Z"]
        h, w = zpx.shape
        counts = np.array([0 if v is None else len(v) for v in zpx.ravel()], np.uint32)
        tot = int(counts.sum())
        s = np.zeros((tot, SAMPLE), np.float32)

        def flat(px):
            parts = [np.asarray(v, np.float32) for v in px.ravel() if v is not None and len(v)]
            return np.concatenate(parts) if parts else np.zeros(0, np.float32)
        for name, k in _NAMES.items():
            if name in chans:
                s[:, k] = flat(chans[name])
        if "A" not in chans:
            s[:, 3] = 1
        if "ZBack" not in chans:
            s[:, 5] = s[:, 4]
    return sort_samples({"w": w, "h": h, "n": counts, "s": s})


def write_deep(path, d):
    """A deep scanline OpenEXR (ZIPS) of R G B A Z ZBack."""
    import OpenEXR
    w, h = d["w"], d["h"]
    o = offsets(d)
    arrs = {k: np.empty((h, w), dtype=object) for k in _NAMES}
    for i in range(w * h):
        y, x = divmod(i, w)
        a, b = o[i], o[i + 1]
        for k, c in _NAMES.items():
            arrs[k][y, x] = np.ascontiguousarray(d["s"][a:b, c], np.float32)
    hdr = {"type": OpenEXR.deepscanline, "compression": OpenEXR.ZIPS_COMPRESSION}
    with OpenEXR.File(hdr, arrs) as f:
        f.write(path)
    return path
